//! Table Doctor's query analysis: the slowest statements that touch a table (pg_stat_statements /
//! performance_schema), index suggestions read from their plans, and hypopg "what if" checks.
//! Statements are only explained (never with ANALYZE), inside a rolled-back transaction with
//! short lock and statement timeouts.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;
use sqlx::AssertSqlSafe;

use crate::db::{has_params, my_cell, mysql_conn, pg_column, pg_generic_column, Cell, DbPool};
use crate::doctor::{finding, index_name, int, lit, qi, text, Finding, Severity};
use crate::error::{msg, AppResult};

/// Statements listed per table.
const TOP: i64 = 20;
/// Statements explained for index suggestions.
const EXPLAINED: usize = 10;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableQueries {
    /// Why statement statistics can't be read, with the steps to enable them
    pub unavailable: Option<Unavailable>,
    pub queries: Vec<SlowQuery>,
    pub suggestions: Vec<Suggestion>,
    /// hypopg is installed: "what if" checks are possible
    pub hypopg: bool,
    /// hypopg is not installed, but its package is on the server
    pub hypopg_available: bool,
    pub notes: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct Unavailable {
    pub title: String,
    pub steps: Vec<String>,
    /// SQL that does what can be done from a connection, run through the usual fix confirmation
    pub enable: Option<Enable>,
}

#[derive(Debug, Serialize)]
pub struct Enable {
    pub label: String,
    pub sql: String,
    pub note: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlowQuery {
    /// queryid (PostgreSQL) or digest (MySQL)
    pub id: String,
    /// Normalized text: literals replaced by $1 / ?
    pub query: String,
    /// MySQL: a real statement with values, when the server kept one
    pub sample: Option<String>,
    pub calls: i64,
    pub total_ms: f64,
    pub mean_ms: f64,
    pub rows: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub finding: Finding,
    pub columns: Vec<String>,
    /// Statements whose plan would use it
    pub query_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhatIf {
    pub index: String,
    pub results: Vec<WhatIfResult>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhatIfResult {
    pub query_id: String,
    pub query: String,
    pub before_cost: Option<f64>,
    pub after_cost: Option<f64>,
    /// How the table is read, before and after ("Seq Scan", "Index Scan using …")
    pub before_scan: Option<String>,
    pub after_scan: Option<String>,
    pub uses_index: bool,
    pub error: Option<String>,
}

pub async fn table_queries(pool: &DbPool, schema: &str, table: &str) -> AppResult<TableQueries> {
    match pool {
        DbPool::Pg(_) => pg_queries(pool, schema, table).await,
        DbPool::My(_) => my_queries(pool, schema, table).await,
    }
}

// ---------- shared ----------

/// How a filter uses a column.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Use {
    Eq,
    Range,
}

/// Index columns for a filter: equality columns first, then one range column.
fn index_columns(uses: &[(String, Use)]) -> Vec<String> {
    let mut cols: Vec<String> = Vec::new();
    for (c, u) in uses {
        if *u == Use::Eq && !cols.contains(c) {
            cols.push(c.clone());
        }
    }
    if let Some((c, _)) = uses.iter().find(|(c, u)| *u == Use::Range && !cols.contains(c)) {
        cols.push(c.clone());
    }
    cols.truncate(3);
    cols
}

/// An existing index already starts with these columns (equality ones in any order).
fn covered(existing: &[Vec<String>], cols: &[String]) -> bool {
    existing.iter().any(|ix| {
        ix.len() >= cols.len() && {
            let n = cols.len();
            let mut a: Vec<&String> = ix[..n].iter().collect();
            let mut b: Vec<&String> = cols.iter().collect();
            // the last (maybe range) column must match in place; the rest in any order
            a[..n - 1].sort();
            b[..n - 1].sort();
            a == b
        }
    })
}

/// Operator next to a column reference in an expression like `((status)::text = 'x')`.
fn use_at(expr: &str, start: usize, end: usize) -> Option<Use> {
    let after = expr[end..].trim_start_matches([')', '"', '`', ' ']);
    // skip casts: ::text, ::character varying
    let after = match after.strip_prefix("::") {
        Some(rest) => rest.trim_start_matches(|c: char| c.is_alphanumeric() || c == '_' || c == ' ').trim_start_matches(')').trim_start(),
        None => after,
    };
    let op = |s: &str| -> Option<Use> {
        let l = s.to_ascii_lowercase();
        if l.starts_with("<>") || l.starts_with("!=") {
            None
        } else if l.starts_with('=') || l.starts_with("in ") || l.starts_with("in(") || l.starts_with("= any") {
            Some(Use::Eq)
        } else if l.starts_with("<") || l.starts_with(">") || l.starts_with("between") || l.starts_with("~~") || l.starts_with("like") {
            Some(Use::Range)
        } else {
            None
        }
    };
    op(after).or_else(|| {
        // value on the left: ($1 = status)
        let before = expr[..start].trim_end_matches(['(', '"', '`', ' ']);
        if before.ends_with("<>") || before.ends_with("!=") {
            None
        } else if before.ends_with('=') {
            Some(Use::Eq)
        } else if before.ends_with('<') || before.ends_with('>') || before.ends_with("<=") || before.ends_with(">=") {
            Some(Use::Range)
        } else {
            None
        }
    })
}

/// Columns of `columns` used in a filter expression, with how they are compared. `qualifier`
/// restricts matches to `qualifier.column` (or bare column) references.
fn filter_uses(expr: &str, columns: &[String], qualifiers: &[String]) -> Vec<(String, Use)> {
    let lower = expr.to_lowercase();
    // OR conditions rarely use a single index
    if lower.contains(" or ") {
        return Vec::new();
    }
    let mut out: Vec<(usize, String, Use)> = Vec::new();
    for col in columns {
        let c = col.to_lowercase();
        for quoted in [false, true] {
            let needle = if quoted { format!("\"{c}\"") } else { c.clone() };
            let needle_bt = format!("`{c}`");
            for n in [needle.as_str(), needle_bt.as_str()] {
                let mut from = 0;
                while let Some(pos) = lower[from..].find(n) {
                    let start = from + pos;
                    let end = start + n.len();
                    from = end;
                    let prev = lower[..start].chars().last();
                    let next = lower[end..].chars().next();
                    if prev.is_some_and(|ch| ch.is_alphanumeric() || ch == '_') || next.is_some_and(|ch| ch.is_alphanumeric() || ch == '_') {
                        continue;
                    }
                    // `other`.col belongs to another table
                    if prev == Some('.') {
                        let q = lower[..start - 1].trim_end_matches(['"', '`']);
                        let word: String = q.chars().rev().take_while(|ch| ch.is_alphanumeric() || *ch == '_').collect::<Vec<_>>().into_iter().rev().collect();
                        if !qualifiers.iter().any(|x| x.to_lowercase() == word) {
                            continue;
                        }
                    }
                    if let Some(u) = use_at(&lower, start, end) {
                        out.push((start, col.clone(), u));
                    }
                }
            }
        }
    }
    out.sort_by_key(|(p, _, _)| *p);
    out.into_iter().map(|(_, c, u)| (c, u)).collect()
}

/// Groups suggestions with the same columns and turns them into findings.
fn suggestions(
    mysql: bool,
    schema: &str,
    table: &str,
    rows: i64,
    // (columns, from an ORDER BY … LIMIT, statement)
    found: Vec<(Vec<String>, bool, &SlowQuery)>,
    existing: &[Vec<String>],
    partitioned: bool,
) -> Vec<Suggestion> {
    let mut by_cols: Vec<(Vec<String>, bool, Vec<&SlowQuery>)> = Vec::new();
    for (cols, sort, q) in found {
        if cols.is_empty() || covered(existing, &cols) {
            continue;
        }
        match by_cols.iter_mut().find(|(c, _, _)| *c == cols) {
            Some((_, all_sort, qs)) => {
                *all_sort &= sort;
                if !qs.iter().any(|x| x.id == q.id) {
                    qs.push(q)
                }
            }
            None => by_cols.push((cols, sort, vec![q])),
        }
    }
    let full = format!("{}.{}", qi(mysql, schema), qi(mysql, table));
    by_cols
        .into_iter()
        .map(|(cols, sort, qs)| {
            let total: f64 = qs.iter().map(|q| q.total_ms).sum();
            let calls: i64 = qs.iter().map(|q| q.calls).sum();
            let mean = if calls > 0 { total / calls as f64 } else { 0.0 };
            let sev = if total >= 60_000.0 || mean >= 100.0 { Severity::Warning } else { Severity::Info };
            let name = index_name(table, &cols, if mysql { 64 } else { 63 });
            let col_sql = cols.iter().map(|c| qi(mysql, c)).collect::<Vec<_>>().join(", ");
            let (sql, note) = if mysql {
                (format!("ALTER TABLE {full} ADD INDEX {} ({col_sql}), ALGORITHM=INPLACE, LOCK=NONE;", qi(true, &name)), "Online index build: reads and writes continue.")
            } else if partitioned {
                (format!("CREATE INDEX {} ON {full} ({col_sql});", qi(false, &name)), "Blocks writes to the table while the index is built.")
            } else {
                (
                    format!("CREATE INDEX CONCURRENTLY {} ON {full} ({col_sql});", qi(false, &name)),
                    "Builds without blocking writes; takes longer than a plain CREATE INDEX. If it fails it leaves an invalid index to drop.",
                )
            };
            let f = finding(
                format!("suggest-index:{}", cols.join(",")),
                sev,
                format!("Index on ({}) would help {} slow quer{}", cols.join(", "), qs.len(), if qs.len() == 1 { "y" } else { "ies" }),
                if sort {
                    format!(
                        "To return the first rows ordered by {}, the database reads and sorts the whole table. An index in this order lets it read just those rows.",
                        cols.join(", ")
                    )
                } else {
                    format!(
                        "The plan{} read{} the whole table and filter{} on {}. An index on these columns lets the database jump to the matching rows instead.",
                        if qs.len() == 1 { "" } else { "s" },
                        if qs.len() == 1 { "s" } else { "" },
                        if qs.len() == 1 { "s" } else { "" },
                        cols.join(", ")
                    )
                },
            )
            .ev("Columns", cols.join(", "))
            .ev("Queries", format!("{} · {} calls", qs.len(), crate::doctor::fmt_count(calls)))
            .ev("Total time", fmt_ms(total))
            .ev("Mean time", fmt_ms(mean))
            .ev("Table rows", crate::doctor::fmt_count(rows))
            .fix("Create index", sql, Some(note), true);
            Suggestion { finding: f, columns: cols, query_ids: qs.iter().map(|q| q.id.clone()).collect() }
        })
        .collect()
}

pub fn fmt_ms(ms: f64) -> String {
    if ms >= 60_000.0 {
        format!("{:.1} min", ms / 60_000.0)
    } else if ms >= 1000.0 {
        format!("{:.1} s", ms / 1000.0)
    } else {
        format!("{ms:.1} ms")
    }
}

fn float(c: &Cell) -> f64 {
    c.as_deref().and_then(|s| s.parse().ok()).unwrap_or(0.0)
}

/// Regex for the table name in statement text: unqualified or qualified with `schema`, quoted
/// or not, and not a column or a table of another schema.
fn name_pattern(schema: &str, table: &str, quote: char) -> String {
    let esc = |s: &str| s.chars().map(|c| if c.is_alphanumeric() || c == '_' { c.to_string() } else { format!("\\{c}") }).collect::<String>();
    let q = quote;
    format!("(^|[^a-zA-Z0-9_.{q}])({q}?{}{q}?\\.)?{q}?{}{q}?([^a-zA-Z0-9_{q}]|$)", esc(schema), esc(table))
}

// ---------- PostgreSQL ----------

async fn pg_queries(pool: &DbPool, schema: &str, table: &str) -> AppResult<TableQueries> {
    let DbPool::Pg(p) = pool else { unreachable!() };
    let g = pool
        .text_rows(
            "select current_setting('server_version_num')::int,
                    exists (select 1 from pg_extension where extname = 'pg_stat_statements'),
                    exists (select 1 from pg_available_extensions where name = 'pg_stat_statements'),
                    current_setting('shared_preload_libraries'),
                    exists (select 1 from pg_extension where extname = 'hypopg'),
                    pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER') or (select rolsuper from pg_roles where rolname = current_user),
                    exists (select 1 from pg_available_extensions where name = 'hypopg'),
                    (select rolsuper from pg_roles where rolname = current_user),
                    (select pending_restart from pg_settings where name = 'shared_preload_libraries')",
        )
        .await?;
    let g = g.first().ok_or_else(|| msg("Server returned no rows"))?;
    let ver = int(&g[0]).unwrap_or(0);
    let installed = text(&g[1]) == "true";
    let available = text(&g[2]) == "true";
    let preloaded = text(&g[3]).split(',').any(|l| l.trim() == "pg_stat_statements");
    let hypopg = text(&g[4]) == "true";
    let all_stats = text(&g[5]) == "true";
    let hypopg_available = !hypopg && text(&g[6]) == "true";
    let superuser = text(&g[7]) == "true";
    let pending_restart = text(&g[8]) == "true";

    if !installed || !preloaded {
        let mut steps = Vec::new();
        if !available {
            steps.push("Install the contrib package on the server (it ships with most PostgreSQL packages, e.g. postgresql-contrib).".into());
        }
        if !preloaded {
            steps.push("Add it to postgresql.conf: shared_preload_libraries = 'pg_stat_statements' (or ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements';), then restart PostgreSQL.".into());
        }
        if !installed {
            steps.push("In this database run: CREATE EXTENSION pg_stat_statements;".into());
        }
        steps.push("Use the application for a while, then open Table Doctor again.".into());
        let admin = if superuser { "" } else { " It needs a superuser: run it with such an account, or send it to your DBA." };
        let enable = if !available {
            None
        } else if !preloaded && pending_restart {
            steps.insert(0, "The setting is saved: restart PostgreSQL to load pg_stat_statements, then come back.".into());
            None
        } else if !preloaded {
            // keep the libraries that are already preloaded
            let mut libs: Vec<String> = text(&g[3]).split(',').map(|l| l.trim().to_owned()).filter(|l| !l.is_empty()).collect();
            libs.push("pg_stat_statements".into());
            Some(Enable {
                label: "Enable".into(),
                sql: format!("ALTER SYSTEM SET shared_preload_libraries = {};", lit(&libs.join(", "), false)),
                note: format!("Saves the setting in postgresql.auto.conf; it takes effect after PostgreSQL restarts. Then come back here to create the extension.{admin}"),
            })
        } else {
            Some(Enable {
                label: "Enable".into(),
                sql: "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;".into(),
                note: format!("Creates the extension in this database; statements are recorded from now on.{admin}"),
            })
        };
        return Ok(TableQueries {
            unavailable: Some(Unavailable { title: "Query statistics are off: pg_stat_statements is not enabled".into(), steps, enable }),
            queries: Vec::new(),
            suggestions: Vec::new(),
            hypopg,
            hypopg_available,
            notes: Vec::new(),
        });
    }

    let (total, mean) = if ver >= 130000 { ("total_exec_time", "mean_exec_time") } else { ("total_time", "mean_time") };
    let pattern = lit(&name_pattern(schema, table, '"'), false);
    let rows = pool
        .text_rows(&format!(
            "select queryid::text, query, calls, {total}, {mean}, rows
               from pg_stat_statements
              where dbid = (select oid from pg_database where datname = current_database())
                and query ~* {pattern}
                and query ~* '^\\s*(select|with|insert|update|delete|merge|table)\\M'
              order by {total} desc
              limit {TOP}"
        ))
        .await?;
    let queries: Vec<SlowQuery> = rows
        .iter()
        .map(|r| SlowQuery {
            id: text(&r[0]),
            query: text(&r[1]),
            sample: None,
            calls: int(&r[2]).unwrap_or(0),
            total_ms: float(&r[3]),
            mean_ms: float(&r[4]),
            rows: int(&r[5]).unwrap_or(0),
        })
        .collect();
    let mut notes = Vec::new();
    if !all_stats {
        notes.push("Only your own statements are listed in full: other users' statements need the pg_read_all_stats role.".into());
    }
    notes.push("Statements are matched by the table name in their text.".into());

    // table facts for suggestions
    let (s, t) = (lit(schema, false), lit(table, false));
    let facts = pool
        .text_rows(&format!(
            "select c.reltuples::bigint, c.relkind,
                    array_to_string(array(select a.attname from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped order by a.attnum), chr(31))
               from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = {s} and c.relname = {t}"
        ))
        .await?;
    let Some(f) = facts.first() else { return Err(msg(format!("Table {schema}.{table} not found"))) };
    let reltuples = int(&f[0]).unwrap_or(0);
    let partitioned = text(&f[1]) == "p";
    let columns: Vec<String> = text(&f[2]).split('\u{1f}').filter(|c| !c.is_empty()).map(str::to_owned).collect();
    let existing: Vec<Vec<String>> = pool
        .text_rows(&format!(
            "select array_to_string(array(select a.attname from unnest(x.indkey) with ordinality k(n, o)
                                           join pg_attribute a on a.attrelid = x.indrelid and a.attnum = k.n
                                          where o <= x.indnatts order by o), chr(31))
               from pg_index x join pg_class c on c.oid = x.indrelid join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = {s} and c.relname = {t} and x.indisvalid and x.indpred is null"
        ))
        .await?
        .iter()
        .map(|r| text(&r[0]).split('\u{1f}').filter(|c| !c.is_empty()).map(str::to_owned).collect())
        .collect();

    // columns with a handful of values: an index on them alone doesn't narrow a filter
    let low: Vec<String> = pool
        .text_rows(&format!("select attname, n_distinct from pg_stats where schemaname = {s} and tablename = {t} and not inherited"))
        .await?
        .iter()
        .filter(|r| {
            let nd = float(&r[1]);
            let distinct = if nd < 0.0 { -nd * reltuples as f64 } else { nd };
            distinct > 0.0 && distinct <= 20.0
        })
        .map(|r| text(&r[0]))
        .collect();

    let mut found = Vec::new();
    if reltuples >= 1000 {
        let mut conn = p.acquire().await?;
        sqlx::raw_sql("BEGIN; SET LOCAL lock_timeout = '1s'; SET LOCAL statement_timeout = '5s'").execute(&mut *conn).await?;
        for q in queries.iter().take(EXPLAINED) {
            let Ok(plan) = pg_plan(&mut conn, &q.query, ver).await else { continue };
            for (cols, sort) in pg_plan_suggestions(&plan, schema, table, &columns) {
                if sort || !cols.iter().all(|c| low.contains(c)) {
                    found.push((cols, sort, q));
                }
            }
        }
        if sqlx::raw_sql("ROLLBACK").execute(&mut *conn).await.is_err() {
            drop(conn.detach());
        }
        if ver < 160000 && queries.iter().take(EXPLAINED).any(|q| has_params(&q.query)) {
            notes.push("Statements with parameters can be explained for index suggestions on PostgreSQL 16 and newer.".into());
        }
    }
    let suggestions = suggestions(false, schema, table, reltuples, found, &existing, partitioned);
    Ok(TableQueries { unavailable: None, queries, suggestions, hypopg, hypopg_available, notes })
}

/// JSON plan of a statement from pg_stat_statements: never executed (no ANALYZE).
async fn pg_plan(conn: &mut sqlx::PgConnection, query: &str, ver: i64) -> AppResult<Value> {
    let q = query.trim().trim_end_matches(';');
    let json = if has_params(q) {
        if ver < 160000 {
            return Err(msg("parameters need PostgreSQL 16"));
        }
        pg_generic_column(conn, &format!("EXPLAIN (GENERIC_PLAN, FORMAT JSON) {q}")).await?.concat()
    } else {
        pg_column(conn, &format!("EXPLAIN (FORMAT JSON) {q}")).await?.concat()
    };
    let v: Value = serde_json::from_str(&json).map_err(|e| msg(e.to_string()))?;
    v.get(0).and_then(|x| x.get("Plan")).cloned().ok_or_else(|| msg("no plan"))
}

fn walk<'a>(node: &'a Value, out: &mut Vec<(&'a Value, Vec<&'a Value>)>, parents: &mut Vec<&'a Value>) {
    out.push((node, parents.clone()));
    if let Some(children) = node.get("Plans").and_then(Value::as_array) {
        parents.push(node);
        for c in children {
            walk(c, out, parents);
        }
        parents.pop();
    }
}

/// Index columns for sequential scans of the table in a plan: filter columns, or the sort key
/// of a Sort under a Limit when there is no filter.
fn pg_plan_suggestions(plan: &Value, schema: &str, table: &str, columns: &[String]) -> Vec<(Vec<String>, bool)> {
    let mut nodes = Vec::new();
    walk(plan, &mut nodes, &mut Vec::new());
    let mut out = Vec::new();
    for (n, parents) in &nodes {
        let s = |k: &str| n.get(k).and_then(Value::as_str);
        if s("Node Type") != Some("Seq Scan") || s("Relation Name") != Some(table) || s("Schema").is_some_and(|x| x != schema) {
            continue;
        }
        let alias = s("Alias").unwrap_or(table).to_owned();
        let qualifiers = vec![alias, table.to_owned()];
        let mut uses = s("Filter").map(|f| filter_uses(f, columns, &qualifiers)).unwrap_or_default();
        if uses.is_empty() {
            // ORDER BY … LIMIT: an index in sort order avoids reading everything
            let limited = parents.iter().any(|p| p.get("Node Type").and_then(Value::as_str) == Some("Limit"));
            let sort = parents.iter().rev().find(|p| p.get("Node Type").and_then(Value::as_str) == Some("Sort"));
            if let (true, Some(sort)) = (limited, sort)
                && let Some(keys) = sort.get("Sort Key").and_then(Value::as_array)
            {
                let mut cols = Vec::new();
                for k in keys.iter().filter_map(Value::as_str) {
                    // "o.created_at DESC" -> created_at
                    let name = k.split_whitespace().next().unwrap_or("").rsplit('.').next().unwrap_or("").trim_matches(['"', '(', ')']);
                    match columns.iter().find(|c| c.as_str() == name) {
                        Some(c) => cols.push(c.clone()),
                        None => break,
                    }
                }
                if !cols.is_empty() {
                    out.push((cols, true));
                }
            }
            continue;
        }
        uses.dedup();
        out.push((index_columns(&uses), false));
    }
    out
}

/// Plans the table's slow statements with and without a hypothetical index (hypopg); nothing is
/// created and nothing runs.
pub async fn what_if(pool: &DbPool, schema: &str, table: &str, columns: &[String], query_ids: &[String]) -> AppResult<WhatIf> {
    let DbPool::Pg(p) = pool else { return Err(msg("What if checks need PostgreSQL with hypopg")) };
    if columns.is_empty() || query_ids.is_empty() {
        return Err(msg("Nothing to check"));
    }
    let ids: Vec<String> = query_ids.iter().filter(|i| i.chars().all(|c| c.is_ascii_digit() || c == '-')).cloned().collect();
    let mut conn = p.acquire().await?;
    let ver: i64 = sqlx::query_scalar::<_, i32>("select current_setting('server_version_num')::int").fetch_one(&mut *conn).await? as i64;
    let texts = sqlx::raw_sql(AssertSqlSafe(format!(
        "select queryid::text, query from pg_stat_statements where queryid::text in ({})",
        ids.iter().map(|i| lit(i, false)).collect::<Vec<_>>().join(", ")
    )))
    .fetch_all(&mut *conn)
    .await?;
    let texts: Vec<(String, String)> = texts.iter().map(|r| (text(&crate::db::pg_cell(r, 0)), text(&crate::db::pg_cell(r, 1)))).collect();
    let def = format!("CREATE INDEX ON {}.{} ({})", qi(false, schema), qi(false, table), columns.iter().map(|c| qi(false, c)).collect::<Vec<_>>().join(", "));

    sqlx::raw_sql("BEGIN; SET LOCAL lock_timeout = '1s'; SET LOCAL statement_timeout = '5s'").execute(&mut *conn).await?;
    let mut befores = Vec::new();
    for (_, q) in &texts {
        befores.push(pg_plan(&mut conn, q, ver).await);
    }
    let created = sqlx::query(AssertSqlSafe(format!("select indexname from hypopg_create_index({})", lit(&def, false)))).fetch_one(&mut *conn).await;
    let mut afters = Vec::new();
    if created.is_ok() {
        for (_, q) in &texts {
            afters.push(pg_plan(&mut conn, q, ver).await);
        }
    }
    let reset = sqlx::raw_sql("SELECT hypopg_reset(); ROLLBACK").execute(&mut *conn).await;
    if reset.is_err() {
        // never hand a session with a hypothetical index back to the pool
        drop(conn.detach());
    }
    created.map_err(|e| msg(format!("hypopg could not create the index: {e}")))?;

    let results = texts
        .iter()
        .zip(befores)
        .zip(afters)
        .map(|(((id, q), before), after)| {
            let cost = |p: &Value| p.get("Total Cost").and_then(Value::as_f64);
            let error = before.as_ref().err().or(after.as_ref().err()).map(|e| e.to_string());
            let (b, a) = (before.ok(), after.ok());
            WhatIfResult {
                query_id: id.clone(),
                query: q.clone(),
                before_cost: b.as_ref().and_then(cost),
                after_cost: a.as_ref().and_then(cost),
                before_scan: b.as_ref().and_then(|p| scan_of(p, table)),
                after_scan: a.as_ref().and_then(|p| scan_of(p, table)),
                uses_index: a.as_ref().is_some_and(uses_hypothetical),
                error,
            }
        })
        .collect();
    Ok(WhatIf { index: def, results })
}

/// "Seq Scan" / "Index Scan using …" for the table in a plan.
fn scan_of(plan: &Value, table: &str) -> Option<String> {
    let mut nodes = Vec::new();
    walk(plan, &mut nodes, &mut Vec::new());
    nodes.iter().find(|(n, _)| n.get("Relation Name").and_then(Value::as_str) == Some(table)).map(|(n, _)| {
        let op = n.get("Node Type").and_then(Value::as_str).unwrap_or("?");
        // a Bitmap Heap Scan names its index on the Bitmap Index Scan below it
        let mut below = Vec::new();
        walk(n, &mut below, &mut Vec::new());
        let index = below.iter().find_map(|(x, _)| x.get("Index Name").and_then(Value::as_str));
        match index {
            // hypopg names look like <13495>btree_orders_status
            Some(ix) if ix.starts_with('<') => format!("{op} using the new index"),
            Some(ix) => format!("{op} using {ix}"),
            None => op.to_owned(),
        }
    })
}

fn uses_hypothetical(plan: &Value) -> bool {
    let mut nodes = Vec::new();
    walk(plan, &mut nodes, &mut Vec::new());
    nodes.iter().any(|(n, _)| n.get("Index Name").and_then(Value::as_str).is_some_and(|i| i.starts_with('<')))
}

// ---------- MySQL ----------

async fn my_queries(pool: &DbPool, schema: &str, table: &str) -> AppResult<TableQueries> {
    let DbPool::My(p) = pool else { unreachable!() };
    let off = |title: &str, steps: Vec<String>, enable: Option<Enable>| TableQueries {
        unavailable: Some(Unavailable { title: title.into(), steps, enable }),
        queries: Vec::new(),
        suggestions: Vec::new(),
        hypopg: false,
        hypopg_available: false,
        notes: Vec::new(),
    };
    let ps_on = pool.text_rows("select @@performance_schema").await.ok().and_then(|r| r.first().map(|r| text(&r[0]) == "1")).unwrap_or(false);
    if !ps_on {
        return Ok(off(
            "Query statistics are off: performance_schema is disabled",
            vec![
                "Set performance_schema = ON in the server configuration (my.cnf / my.ini) and restart MySQL.".into(),
                "Use the application for a while, then open Table Doctor again.".into(),
            ],
            None,
        ));
    }
    // digests are only collected with this consumer on
    let digests = pool
        .text_rows("select enabled from performance_schema.setup_consumers where name = 'statements_digest'")
        .await
        .ok()
        .and_then(|r| r.first().map(|r| text(&r[0])));
    if digests.as_deref() == Some("NO") {
        return Ok(off(
            "Query statistics are off: statement digests are not collected",
            vec![
                "Turn on the statements_digest consumer (below). It lasts until the server restarts; to keep it, add performance-schema-consumer-statements-digest = ON to my.cnf.".into(),
                "Use the application for a while, then open Table Doctor again.".into(),
            ],
            Some(Enable {
                label: "Enable".into(),
                sql: "UPDATE performance_schema.setup_consumers SET ENABLED = 'YES' WHERE NAME = 'statements_digest';".into(),
                note: "Starts collecting statement digests now; needs UPDATE on performance_schema.".into(),
            }),
        ));
    }
    let (s, t) = (lit(schema, true), lit(table, true));
    let pattern = lit(&name_pattern(schema, table, '`'), true);
    let sample_col = match pool.text_rows("select query_sample_text from performance_schema.events_statements_summary_by_digest limit 0").await {
        Ok(_) => "query_sample_text",
        Err(_) => "null",
    };
    let rows = match pool
        .text_rows(&format!(
            "select digest, digest_text, {sample_col}, count_star, sum_timer_wait / 1000000000, avg_timer_wait / 1000000000, sum_rows_sent + sum_rows_affected
               from performance_schema.events_statements_summary_by_digest
              where schema_name = {s} and digest_text regexp {pattern}
                and digest_text regexp '^(SELECT|WITH|INSERT|UPDATE|DELETE|REPLACE|TABLE) '
              order by sum_timer_wait desc
              limit {TOP}"
        ))
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            // the grant names this account exactly as the server sees it
            let me = pool.text_rows("select current_user()").await.ok().and_then(|r| r.first().map(|r| text(&r[0]))).unwrap_or_default();
            let account = match me.rsplit_once('@') {
                Some((u, h)) => format!("{}@{}", lit(u, true), lit(h, true)),
                None => "'user'@'host'".into(),
            };
            return Ok(off(
                "Query statistics can't be read",
                vec![format!("The server said: {e}"), "This account needs read access to performance_schema (below).".into()],
                Some(Enable {
                    label: "Grant access".into(),
                    sql: format!("GRANT SELECT ON performance_schema.* TO {account};"),
                    note: "Needs an account that may grant privileges (e.g. root). Run it there, or send it to your DBA.".into(),
                }),
            ));
        }
    };
    let queries: Vec<SlowQuery> = rows
        .iter()
        .map(|r| SlowQuery {
            id: text(&r[0]),
            query: text(&r[1]),
            sample: r[2].clone().filter(|x| !x.is_empty()),
            calls: int(&r[3]).unwrap_or(0),
            total_ms: float(&r[4]),
            mean_ms: float(&r[5]),
            rows: int(&r[6]).unwrap_or(0),
        })
        .collect();
    let mut notes = vec!["Statements are matched by the table name in their text; statistics reset when the server restarts.".to_string()];

    let facts = pool.text_rows(&format!("select table_rows from information_schema.tables where table_schema = {s} and table_name = {t}")).await?;
    let rows_est = facts.first().and_then(|r| int(&r[0])).unwrap_or(0);
    let columns: Vec<String> = pool
        .text_rows(&format!("select column_name from information_schema.columns where table_schema = {s} and table_name = {t} order by ordinal_position"))
        .await?
        .iter()
        .map(|r| text(&r[0]))
        .collect();
    let mut existing: HashMap<String, Vec<String>> = HashMap::new();
    for r in pool
        .text_rows(&format!(
            "select index_name, column_name from information_schema.statistics
              where table_schema = {s} and table_name = {t} and column_name is not null order by index_name, seq_in_index"
        ))
        .await?
    {
        existing.entry(text(&r[0])).or_default().push(text(&r[1]));
    }
    let existing: Vec<Vec<String>> = existing.into_values().collect();

    let mut found = Vec::new();
    if rows_est >= 1000 {
        let mut conn = mysql_conn(p, Some(schema)).await?;
        let mut skipped = 0;
        for q in queries.iter().take(EXPLAINED) {
            // the digest has ? placeholders; only a real sample can be explained
            let Some(sample) = q.sample.as_deref() else {
                skipped += 1;
                continue;
            };
            let json = sqlx::query(AssertSqlSafe(format!("EXPLAIN FORMAT=JSON {}", sample.trim().trim_end_matches(';'))))
                .fetch_all(&mut *conn)
                .await
                .ok()
                .map(|rows| rows.iter().filter_map(|r| my_cell(r, 0)).collect::<String>());
            let Some(plan) = json.and_then(|j| serde_json::from_str::<Value>(&j).ok()) else {
                skipped += 1;
                continue;
            };
            for cols in my_plan_suggestions(&plan, table, &columns) {
                found.push((cols, false, q));
            }
        }
        if skipped > 0 {
            notes.push(format!("{skipped} statement(s) had no usable sample to explain (performance_schema keeps one per digest)."));
        }
    }
    let suggestions = suggestions(true, schema, table, rows_est, found, &existing, false);
    Ok(TableQueries { unavailable: None, queries, suggestions, hypopg: false, hypopg_available: false, notes })
}

/// Index columns for full scans of the table in a MySQL JSON plan.
fn my_plan_suggestions(plan: &Value, table: &str, columns: &[String]) -> Vec<Vec<String>> {
    fn tables<'a>(v: &'a Value, out: &mut Vec<&'a Value>) {
        match v {
            Value::Object(m) => {
                if let Some(t) = m.get("table") {
                    out.push(t);
                }
                for (k, x) in m {
                    if k != "table" {
                        tables(x, out);
                    }
                }
                if let Some(t) = m.get("table") {
                    tables(t, &mut Vec::new());
                }
            }
            Value::Array(a) => a.iter().for_each(|x| tables(x, out)),
            _ => {}
        }
    }
    let mut ts = Vec::new();
    tables(plan, &mut ts);
    let mut out = Vec::new();
    for t in ts {
        let s = |k: &str| t.get(k).and_then(Value::as_str);
        let Some(alias) = s("table_name") else { continue };
        if s("access_type") != Some("ALL") {
            continue;
        }
        let Some(cond) = s("attached_condition") else { continue };
        // an alias: it is this table when all the columns it reads are this table's
        let used: Vec<&str> = t.get("used_columns").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        let ours = alias.eq_ignore_ascii_case(table) || (!used.is_empty() && used.iter().all(|u| columns.iter().any(|c| c == u)));
        if !ours {
            continue;
        }
        let uses = filter_uses(cond, columns, &[alias.to_owned(), table.to_owned()]);
        if !uses.is_empty() {
            out.push(index_columns(&uses));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_columns() {
        let cols = vec!["status".to_string(), "created_at".to_string(), "customer_id".to_string()];
        let u = filter_uses("((status = 'paid'::text) AND (created_at > $1))", &cols, &["orders".into()]);
        assert_eq!(index_columns(&u), vec!["status".to_string(), "created_at".to_string()]);
        let u = filter_uses("((o.status)::text = ($1)::text)", &cols, &["o".into()]);
        assert_eq!(index_columns(&u), vec!["status".to_string()]);
        // another table's column with the same name
        assert!(filter_uses("(c.status = 'x')", &cols, &["o".into()]).is_empty());
        assert!(filter_uses("((status = 'a') OR (status = 'b'))", &cols, &[]).is_empty());
        let u = filter_uses("(`demo`.`o`.`customer_id` = 42)", &cols, &["o".into()]);
        assert_eq!(index_columns(&u), vec!["customer_id".to_string()]);
    }

    #[test]
    fn coverage() {
        let ex = vec![vec!["status".to_string(), "created_at".to_string()]];
        assert!(covered(&ex, &["status".into()]));
        assert!(covered(&ex, &["status".into(), "created_at".into()]));
        assert!(!covered(&ex, &["created_at".into()]));
    }

    #[test]
    fn table_pattern() {
        let re = name_pattern("public", "orders", '"');
        assert!(re.contains("orders"));
        assert!(has_params("select * from t where a = $1"));
        assert!(!has_params("select '$' from t"));
    }
}
