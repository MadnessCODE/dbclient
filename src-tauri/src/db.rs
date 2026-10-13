//! Database connections and query execution.
//!
//! User queries go through `raw_sql` (text protocol): every value arrives as text formatted
//! by the server, so bigint/numeric keep full precision, multi-statement scripts work and
//! types sqlx doesn't know still decode.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use futures_util::TryStreamExt;
use serde::Serialize;
use sqlx::mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlRow, MySqlSslMode};
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgRow, PgSslMode, PgValueFormat};
use sqlx::{AssertSqlSafe, Column, Either, Row, TypeInfo, ValueRef};

use crate::error::{msg, AppResult};
use crate::store::{ConnectionConfig, DbKind, SslMode};

/// One result cell; None is SQL NULL.
pub type Cell = Option<String>;

#[derive(Clone)]
pub enum DbPool {
    Pg(PgPool),
    My(MySqlPool),
}

impl DbPool {
    /// `via`: local port of an SSH tunnel, used instead of host:port.
    pub async fn connect(cfg: &ConnectionConfig, password: Option<&str>, via: Option<u16>) -> AppResult<Self> {
        let timeout = Duration::from_secs(10);
        let (host, port) = match via {
            Some(p) => ("127.0.0.1", p),
            None => (cfg.host.as_str(), cfg.port),
        };
        Ok(match cfg.kind {
            DbKind::Postgres => {
                let mut opts = PgConnectOptions::new_without_pgpass()
                    .host(host)
                    .port(port)
                    .username(&cfg.user)
                    .application_name("DB Client")
                    .ssl_mode(match cfg.ssl {
                        SslMode::Disable => PgSslMode::Disable,
                        SslMode::Prefer => PgSslMode::Prefer,
                        SslMode::Require => PgSslMode::Require,
                    });
                if let Some(pw) = password {
                    opts = opts.password(pw);
                }
                if !cfg.database.is_empty() {
                    opts = opts.database(&cfg.database);
                }
                let pool = PgPoolOptions::new()
                    .max_connections(5)
                    .acquire_timeout(timeout)
                    .connect_with(opts)
                    .await?;
                DbPool::Pg(pool)
            }
            DbKind::Mysql => {
                let mut opts = MySqlConnectOptions::new()
                    .host(host)
                    .port(port)
                    .username(&cfg.user)
                    .ssl_mode(match cfg.ssl {
                        SslMode::Disable => MySqlSslMode::Disabled,
                        SslMode::Prefer => MySqlSslMode::Preferred,
                        SslMode::Require => MySqlSslMode::Required,
                    });
                if let Some(pw) = password {
                    opts = opts.password(pw);
                }
                if !cfg.database.is_empty() {
                    opts = opts.database(&cfg.database);
                }
                let pool = MySqlPoolOptions::new()
                    .max_connections(5)
                    .acquire_timeout(timeout)
                    .connect_with(opts)
                    .await?;
                DbPool::My(pool)
            }
        })
    }

    pub async fn close(&self) {
        match self {
            DbPool::Pg(p) => p.close().await,
            DbPool::My(p) => p.close().await,
        }
    }

    /// Internal query (schema, server info) with every column as text.
    pub async fn text_rows(&self, sql: &str) -> AppResult<Vec<Vec<Cell>>> {
        let sql = AssertSqlSafe(sql.to_owned());
        Ok(match self {
            DbPool::Pg(p) => sqlx::raw_sql(sql)
                .fetch_all(p)
                .await?
                .iter()
                .map(|r| (0..r.len()).map(|i| pg_cell(r, i)).collect())
                .collect(),
            DbPool::My(p) => sqlx::raw_sql(sql)
                .fetch_all(p)
                .await?
                .iter()
                .map(|r| (0..r.len()).map(|i| my_cell(r, i)).collect())
                .collect(),
        })
    }
}


#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub database: String,
    pub user: String,
    /// Short form, e.g. "PostgreSQL 16.10"
    pub version: String,
    pub version_full: String,
    pub host: String,
    pub port: u16,
    pub ssl: bool,
}

pub async fn server_info(pool: &DbPool, cfg: &ConnectionConfig) -> AppResult<ServerInfo> {
    let (database, user, version, version_full, ssl) = match pool {
        DbPool::Pg(_) => {
            let rows = pool
                .text_rows(
                    "select current_database(), current_user, current_setting('server_version'), version(), \
                     coalesce((select ssl from pg_stat_ssl where pid = pg_backend_pid()), false)",
                )
                .await?;
            let r = first_row(rows)?;
            let short = r[2].clone().unwrap_or_default();
            let short = short.split_whitespace().next().unwrap_or_default().to_string();
            (r[0].clone(), r[1].clone(), format!("PostgreSQL {short}"), r[3].clone(), r[4].as_deref() == Some("true"))
        }
        DbPool::My(_) => {
            let r = first_row(
                pool.text_rows("select database(), current_user(), version(), @@version_comment").await?,
            )?;
            let cipher = pool.text_rows("show session status like 'Ssl_cipher'").await?;
            let ssl = cipher.first().and_then(|r| r.get(1).cloned().flatten()).is_some_and(|c| !c.is_empty());
            let ver = r[2].clone().unwrap_or_default();
            let flavor = if r[3].as_deref().unwrap_or("").to_lowercase().contains("mariadb")
                || ver.to_lowercase().contains("mariadb")
            {
                "MariaDB"
            } else {
                "MySQL"
            };
            let short = ver.split('-').next().unwrap_or_default();
            (r[0].clone(), r[1].clone(), format!("{flavor} {short}"), Some(ver), ssl)
        }
    };
    Ok(ServerInfo {
        database: database.unwrap_or_default(),
        user: user.unwrap_or_default(),
        version,
        version_full: version_full.unwrap_or_default(),
        host: cfg.host.clone(),
        port: cfg.port,
        ssl,
    })
}

fn first_row(rows: Vec<Vec<Cell>>) -> AppResult<Vec<Cell>> {
    rows.into_iter().next().ok_or_else(|| msg("Server returned no rows"))
}


fn pg_cell(row: &PgRow, i: usize) -> Cell {
    let value = row.try_get_raw(i).ok()?;
    if value.is_null() {
        return None;
    }
    let is_bool = value.type_info().name() == "BOOL";
    match value.format() {
        PgValueFormat::Text => {
            let text = value.as_str().ok()?;
            Some(match (is_bool, text) {
                (true, "t") => "true".into(),
                (true, "f") => "false".into(),
                _ => text.to_owned(),
            })
        }
        PgValueFormat::Binary => value.as_bytes().ok().map(hex),
    }
}

fn my_cell(row: &MySqlRow, i: usize) -> Cell {
    let value = row.try_get_raw(i).ok()?;
    if value.is_null() {
        return None;
    }
    let bytes: Vec<u8> = row.try_get_unchecked(i).ok()?;
    Some(match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(e) => hex(e.as_bytes()),
    })
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(2 + bytes.len() * 2);
    out.push_str("0x");
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Type name as people write it (bigint, varchar, timestamp...).
fn friendly_type(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    match lower.as_str() {
        "int8" => "bigint",
        "int4" => "integer",
        "int2" => "smallint",
        "float8" => "double",
        "float4" => "real",
        "bool" => "boolean",
        "bpchar" => "char",
        "" => "unknown",
        other => other,
    }
    .to_string()
}


#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    pub type_name: String,
    /// Source table/column (None for expressions such as count(*))
    pub origin: Option<ColumnRef>,
    /// Target of a single-column foreign key
    pub fk: Option<ColumnRef>,
    /// Postgres (table oid, attnum) from RowDescription, used to resolve `origin`
    #[serde(skip)]
    pg_rel: Option<(u32, i16)>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnRef {
    pub schema: String,
    pub table: String,
    pub column: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultSet {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<Cell>>,
    /// False for statements without a result set (UPDATE, DDL...).
    pub returns_rows: bool,
    pub rows_affected: u64,
    /// Stopped at max_rows; the rest wasn't fetched.
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryOutput {
    pub result_sets: Vec<ResultSet>,
    pub elapsed_ms: f64,
}

/// Running queries: query_id -> (pool, server session id), so they can be cancelled.
#[derive(Default)]
pub struct RunningQueries(Mutex<HashMap<String, (DbPool, i64)>>);

impl RunningQueries {
    fn insert(&self, query_id: &str, pool: DbPool, backend_id: i64) {
        self.0.lock().unwrap().insert(query_id.to_owned(), (pool, backend_id));
    }

    fn remove(&self, query_id: &str) {
        self.0.lock().unwrap().remove(query_id);
    }

    /// Cancels the query on the server through another pooled connection.
    pub async fn cancel(&self, query_id: &str) -> AppResult<bool> {
        let entry = self.0.lock().unwrap().get(query_id).cloned();
        let Some((pool, backend_id)) = entry else {
            return Ok(false);
        };
        cancel_backend(&pool, backend_id).await?;
        Ok(true)
    }
}

async fn cancel_backend(pool: &DbPool, backend_id: i64) -> AppResult<()> {
    match pool {
        DbPool::Pg(p) => {
            sqlx::query("select pg_cancel_backend($1)").bind(backend_id as i32).execute(p).await?;
        }
        DbPool::My(p) => {
            // backend_id comes from the server (connection_id()), not from user input.
            sqlx::raw_sql(AssertSqlSafe(format!("KILL QUERY {backend_id}"))).execute(p).await?;
        }
    }
    Ok(())
}

pub async fn run_query(
    pool: &DbPool,
    running: &RunningQueries,
    query_id: &str,
    sql: String,
    max_rows: usize,
) -> AppResult<QueryOutput> {
    let started = Instant::now();
    let result = match pool {
        DbPool::Pg(p) => {
            let mut conn = p.acquire().await?;
            let pid: i32 = sqlx::query_scalar("select pg_backend_pid()").fetch_one(&mut *conn).await?;
            running.insert(query_id, pool.clone(), pid as i64);
            let stream = sqlx::raw_sql(AssertSqlSafe(sql)).fetch_many(&mut *conn);
            let out = collect_results(stream, max_rows, pg_cell, pg_columns).await;
            if matches!(out, Ok((_, true))) {
                // Stopped reading mid-result: cancel on the server and drop the connection
                // instead of returning it to the pool.
                let _ = cancel_backend(pool, pid as i64).await;
                drop(conn.detach());
            }
            out
        }
        DbPool::My(p) => {
            let mut conn = p.acquire().await?;
            let cid: u64 = sqlx::query_scalar("select connection_id()").fetch_one(&mut *conn).await?;
            running.insert(query_id, pool.clone(), cid as i64);
            let stream = sqlx::raw_sql(AssertSqlSafe(sql)).fetch_many(&mut *conn);
            let out = collect_results(stream, max_rows, my_cell, my_columns).await;
            if matches!(out, Ok((_, true))) {
                let _ = cancel_backend(pool, cid as i64).await;
                drop(conn.detach());
            }
            out
        }
    };
    running.remove(query_id);
    let (mut result_sets, _) = result?;
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    // Column origins and FKs are optional extras; failing here must not fail the query.
    let _ = annotate_columns(pool, &mut result_sets).await;
    Ok(QueryOutput { result_sets, elapsed_ms })
}

fn pg_columns(row: &PgRow) -> Vec<ColumnMeta> {
    row.columns()
        .iter()
        .map(|c| ColumnMeta {
            name: c.name().to_string(),
            type_name: friendly_type(c.type_info().name()),
            origin: None,
            fk: None,
            pg_rel: match (c.relation_id(), c.relation_attribute_no()) {
                (Some(oid), Some(att)) if oid.0 != 0 && att > 0 => Some((oid.0, att)),
                _ => None,
            },
        })
        .collect()
}

fn my_columns(row: &MySqlRow) -> Vec<ColumnMeta> {
    row.columns()
        .iter()
        .map(|c| {
            let origin = c.origin().table_column().and_then(|tc| {
                let (schema, table) = tc.table.split_once('.')?;
                Some(ColumnRef { schema: schema.into(), table: table.into(), column: tc.name.to_string() })
            });
            ColumnMeta { name: c.name().to_string(), type_name: friendly_type(c.type_info().name()), origin, fk: None, pg_rel: None }
        })
        .collect()
}

/// Fills `origin` (Postgres) and `fk` for result columns with one catalog query.
async fn annotate_columns(pool: &DbPool, sets: &mut [ResultSet]) -> AppResult<()> {
    match pool {
        DbPool::Pg(_) => {
            let mut pairs: Vec<(u32, i16)> = sets.iter().flat_map(|s| s.columns.iter()).filter_map(|c| c.pg_rel).collect();
            pairs.sort_unstable();
            pairs.dedup();
            if pairs.is_empty() {
                return Ok(());
            }
            let list = pairs.iter().map(|(o, a)| format!("({o}::oid, {a}::int2)")).collect::<Vec<_>>().join(",");
            let sql = format!(
                "select a.attrelid::int8, a.attnum, n.nspname, c.relname, a.attname, fn.nspname, fc.relname, fa.attname
                   from pg_attribute a
                   join pg_class c on c.oid = a.attrelid
                   join pg_namespace n on n.oid = c.relnamespace
                   left join lateral (
                        select con.confrelid, con.confkey[1] as fatt from pg_constraint con
                         where con.contype = 'f' and con.conrelid = a.attrelid
                           and array_length(con.conkey, 1) = 1 and con.conkey[1] = a.attnum
                         limit 1) f on true
                   left join pg_class fc on fc.oid = f.confrelid
                   left join pg_namespace fn on fn.oid = fc.relnamespace
                   left join pg_attribute fa on fa.attrelid = f.confrelid and fa.attnum = f.fatt
                  where (a.attrelid, a.attnum) in ({list})"
            );
            let mut map = HashMap::new();
            for r in pool.text_rows(&sql).await? {
                let key = r[0].as_deref().and_then(|v| v.parse::<u32>().ok()).zip(r[1].as_deref().and_then(|v| v.parse::<i16>().ok()));
                if let Some(key) = key {
                    map.insert(key, (col_ref(&r[2], &r[3], &r[4]), col_ref(&r[5], &r[6], &r[7])));
                }
            }
            for c in sets.iter_mut().flat_map(|s| s.columns.iter_mut()) {
                if let Some((origin, fk)) = c.pg_rel.and_then(|k| map.get(&k)) {
                    c.origin = origin.clone();
                    c.fk = fk.clone();
                }
            }
        }
        DbPool::My(_) => {
            let mut keys: Vec<(String, String, String)> = sets
                .iter()
                .flat_map(|s| s.columns.iter())
                .filter_map(|c| c.origin.as_ref().map(|o| (o.schema.clone(), o.table.clone(), o.column.clone())))
                .collect();
            keys.sort();
            keys.dedup();
            if keys.is_empty() {
                return Ok(());
            }
            let lit = |s: &str| format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''"));
            let list = keys.iter().map(|(s, t, c)| format!("({},{},{})", lit(s), lit(t), lit(c))).collect::<Vec<_>>().join(",");
            // Single-column FKs only, so a link points to exactly one row
            let sql = format!(
                "select k.table_schema, k.table_name, k.column_name, k.referenced_table_schema, k.referenced_table_name, k.referenced_column_name
                   from information_schema.key_column_usage k
                  where k.referenced_table_name is not null
                    and (k.table_schema, k.table_name, k.column_name) in ({list})
                    and (select count(*) from information_schema.key_column_usage k2
                          where k2.constraint_schema = k.constraint_schema and k2.constraint_name = k.constraint_name
                            and k2.table_name = k.table_name) = 1"
            );
            let rows = pool.text_rows(&sql).await?;
            for c in sets.iter_mut().flat_map(|s| s.columns.iter_mut()) {
                let Some(o) = &c.origin else { continue };
                let hit = rows.iter().find(|r| {
                    r[0].as_deref() == Some(o.schema.as_str()) && r[1].as_deref() == Some(o.table.as_str()) && r[2].as_deref() == Some(o.column.as_str())
                });
                if let Some(r) = hit {
                    c.fk = col_ref(&r[3], &r[4], &r[5]);
                }
            }
        }
    }
    Ok(())
}

fn col_ref(schema: &Cell, table: &Cell, column: &Cell) -> Option<ColumnRef> {
    Some(ColumnRef { schema: schema.clone()?, table: table.clone()?, column: column.clone()? })
}

/// Collects the stream into result sets; the flag tells whether reading stopped at max_rows.
async fn collect_results<'s, R, Q, S>(
    mut stream: S,
    max_rows: usize,
    cell: fn(&R, usize) -> Cell,
    columns: fn(&R) -> Vec<ColumnMeta>,
) -> AppResult<(Vec<ResultSet>, bool)>
where
    R: Row,
    Q: QueryResultExt,
    S: futures_util::Stream<Item = Result<Either<Q, R>, sqlx::Error>> + Unpin + 's,
{
    let mut sets = Vec::new();
    let mut current = ResultSet::default();
    while let Some(item) = stream.try_next().await? {
        match item {
            Either::Right(row) => {
                if !current.returns_rows {
                    current.returns_rows = true;
                    current.columns = columns(&row);
                }
                if current.rows.len() >= max_rows {
                    current.truncated = true;
                    current.rows_affected = current.rows.len() as u64;
                    sets.push(current);
                    return Ok((sets, true));
                }
                current.rows.push((0..row.len()).map(|i| cell(&row, i)).collect());
            }
            Either::Left(done) => {
                current.rows_affected = done.affected();
                sets.push(std::mem::take(&mut current));
            }
        }
    }
    if current.returns_rows {
        sets.push(current);
    }
    Ok((sets, false))
}

pub trait QueryResultExt {
    fn affected(&self) -> u64;
}

impl QueryResultExt for sqlx::postgres::PgQueryResult {
    fn affected(&self) -> u64 {
        self.rows_affected()
    }
}

impl QueryResultExt for sqlx::mysql::MySqlQueryResult {
    fn affected(&self) -> u64 {
        self.rows_affected()
    }
}


pub async fn explain(pool: &DbPool, sql: &str) -> AppResult<String> {
    let sql = sql.trim().trim_end_matches(';');
    let (query, kind) = match pool {
        DbPool::Pg(_) => (format!("EXPLAIN (VERBOSE false, COSTS true) {sql}"), DbKind::Postgres),
        DbPool::My(_) => (format!("EXPLAIN FORMAT=TREE {sql}"), DbKind::Mysql),
    };
    let rows = pool.text_rows(&query).await?;
    let lines: Vec<String> = rows.into_iter().filter_map(|r| r.into_iter().next().flatten()).collect();
    Ok(match kind {
        DbKind::Postgres => lines.join("\n"),
        DbKind::Mysql => lines.join("\n\n"),
    })
}


/// Runs grid edits in one transaction (all or nothing); returns affected rows per statement.
pub async fn execute_batch(pool: &DbPool, statements: &[String]) -> AppResult<Vec<u64>> {
    let mut affected = Vec::with_capacity(statements.len());
    let fail = |i: usize, e: sqlx::Error, sql: &str| {
        let short: String = sql.chars().take(160).collect();
        msg(format!("Statement {} failed, nothing was saved: {}\n\n{}", i + 1, crate::error::AppError::from(e), short))
    };
    match pool {
        DbPool::Pg(p) => {
            let mut tx = p.begin().await?;
            for (i, sql) in statements.iter().enumerate() {
                let r = sqlx::raw_sql(AssertSqlSafe(sql.clone())).execute(&mut *tx).await.map_err(|e| fail(i, e, sql))?;
                affected.push(r.rows_affected());
            }
            tx.commit().await?;
        }
        DbPool::My(p) => {
            let mut tx = p.begin().await?;
            for (i, sql) in statements.iter().enumerate() {
                let r = sqlx::raw_sql(AssertSqlSafe(sql.clone())).execute(&mut *tx).await.map_err(|e| fail(i, e, sql))?;
                affected.push(r.rows_affected());
            }
            tx.commit().await?;
        }
    }
    Ok(affected)
}
