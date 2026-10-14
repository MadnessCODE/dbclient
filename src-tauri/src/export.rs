//! Database export into one SQL file (optionally .sql.gz) that our import, psql and mysql can load.
//!
//! Structure comes from the catalog (PostgreSQL) or SHOW CREATE (MySQL). Table data is read by
//! several connections at once, from the same snapshot, big tables split by primary key ranges.
//! Every piece is written (and compressed) to its own temporary file and appended to the output
//! in order, so a .gz file is a valid sequence of gzip members.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use flate2::write::GzEncoder;
use flate2::Compression;
use futures_util::TryStreamExt;
use serde::Deserialize;
use sqlx::mysql::{MySqlPoolOptions, MySqlRow};
use sqlx::pool::PoolConnection;
use sqlx::postgres::{PgPoolOptions, PgRow};
use sqlx::{AssertSqlSafe, MySql, Postgres, Row, ValueRef};

use crate::db::{my_cell, pg_cell, Cell, DbPool};
use crate::error::{msg, AppResult};
use crate::import::{ImportError, ImportProgress, ImportSummary, Imports, OnProgress, WorkerView};

/// Tables with more estimated rows are split into ranges of about this many rows.
const CHUNK_ROWS: i64 = 250_000;
/// MySQL INSERT statements are cut at about this size.
const INSERT_BYTES: usize = 1 << 20;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    /// PostgreSQL schemas, or the MySQL database (one)
    pub schemas: Vec<String>,
    pub path: String,
    pub structure: bool,
    pub data: bool,
    /// DROP ... IF EXISTS before each CREATE
    pub drop_existing: bool,
    pub workers: usize,
    pub gzip: bool,
    /// MySQL with several connections: a short global read lock so all of them see the same data
    pub consistent: bool,
}

enum Conn {
    Pg(PoolConnection<Postgres>),
    My(PoolConnection<MySql>),
}

impl Conn {
    async fn exec(&mut self, sql: &str) -> Result<(), sqlx::Error> {
        let q = sqlx::raw_sql(AssertSqlSafe(sql.to_owned()));
        match self {
            Conn::Pg(c) => q.execute(&mut **c).await.map(|_| ()),
            Conn::My(c) => q.execute(&mut **c).await.map(|_| ()),
        }
    }

    async fn rows(&mut self, sql: &str) -> Result<Vec<Vec<Cell>>, sqlx::Error> {
        let q = sqlx::raw_sql(AssertSqlSafe(sql.to_owned()));
        Ok(match self {
            Conn::Pg(c) => q.fetch_all(&mut **c).await?.iter().map(|r: &PgRow| (0..r.len()).map(|i| pg_cell(r, i)).collect()).collect(),
            Conn::My(c) => q.fetch_all(&mut **c).await?.iter().map(|r: &MySqlRow| (0..r.len()).map(|i| my_cell(r, i)).collect()).collect(),
        })
    }
}

/// One piece of table data.
struct Chunk {
    table: String,
    /// PostgreSQL: COPY ... TO STDOUT; MySQL: SELECT
    query: String,
    /// Written before the data (PostgreSQL: COPY ... FROM stdin;)
    header: String,
    /// MySQL: INSERT prefix and how to write each column
    insert: Option<(String, Vec<Lit>)>,
}

#[derive(Clone, Copy)]
enum Lit {
    Raw,
    Hex,
    Str,
}

struct Plan {
    pre: String,
    post: String,
    chunks: Vec<Chunk>,
    est_rows: u64,
    notes: Vec<String>,
}

struct State {
    cancel: Arc<AtomicBool>,
    failed: AtomicBool,
    rows: AtomicU64,
    tables_done: AtomicU64,
    bytes: AtomicU64,
    active: AtomicUsize,
    workers: Mutex<Vec<WorkerView>>,
    table: Mutex<String>,
    error: Mutex<Option<String>>,
}

impl State {
    fn stopped(&self) -> bool {
        self.cancel.load(Ordering::Relaxed) || self.failed.load(Ordering::Relaxed)
    }
    fn fail(&self, e: String) {
        if !self.failed.swap(true, Ordering::Relaxed) {
            *self.error.lock().unwrap() = Some(e);
        }
    }
}

/// A part file, plain or gzip.
enum Part {
    Plain(BufWriter<File>),
    Gz(GzEncoder<BufWriter<File>>),
}

impl Part {
    fn create(path: &Path, gzip: bool) -> std::io::Result<Self> {
        let f = BufWriter::with_capacity(1 << 20, File::create(path)?);
        Ok(if gzip { Part::Gz(GzEncoder::new(f, Compression::default())) } else { Part::Plain(f) })
    }
    fn finish(self) -> std::io::Result<()> {
        match self {
            Part::Plain(mut w) => w.flush(),
            Part::Gz(g) => g.finish()?.flush(),
        }
    }
}

impl Write for Part {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        match self {
            Part::Plain(w) => w.write(b),
            Part::Gz(w) => w.write(b),
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Part::Plain(w) => w.flush(),
            Part::Gz(w) => w.flush(),
        }
    }
}

pub async fn run(on_progress: OnProgress, imports: &Imports, pool: &DbPool, job_id: String, o: ExportOptions) -> AppResult<ImportSummary> {
    let started = Instant::now();
    let workers = o.workers.clamp(1, 16);
    if o.schemas.is_empty() {
        return Err(msg("Nothing to export"));
    }

    let cancel = Arc::new(AtomicBool::new(false));
    imports.0.lock().unwrap().insert(job_id.clone(), cancel.clone());
    let state = Arc::new(State {
        cancel,
        failed: AtomicBool::new(false),
        rows: AtomicU64::new(0),
        tables_done: AtomicU64::new(0),
        bytes: AtomicU64::new(0),
        active: AtomicUsize::new(0),
        workers: Mutex::new((0..workers).map(|_| WorkerView { busy: false, task: "copy".into(), table: String::new(), jobs: 0 }).collect()),
        table: Mutex::new("Reading the structure…".into()),
        error: Mutex::new(None),
    });
    let est = Arc::new(AtomicU64::new(0));
    let ticker = {
        let (state, est, on_progress, job_id) = (state.clone(), est.clone(), on_progress.clone(), job_id.clone());
        tokio::spawn(async move {
            loop {
                on_progress(progress(&state, &job_id, est.load(Ordering::Relaxed), started));
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        })
    };

    let result = export(pool, &o, workers, &state, &est).await;
    ticker.abort();
    imports.0.lock().unwrap().remove(&job_id);
    on_progress(progress(&state, &job_id, est.load(Ordering::Relaxed), started));

    let cancelled = state.cancel.load(Ordering::Relaxed);
    let (notes, error) = match result {
        Ok(notes) => (notes, state.error.lock().unwrap().take()),
        Err(e) => (Vec::new(), Some(e.to_string())),
    };
    if cancelled || error.is_some() {
        let _ = std::fs::remove_file(&o.path);
    }
    if let (Some(e), false) = (&error, state.failed.load(Ordering::Relaxed)) {
        return Err(msg(e.clone()));
    }
    Ok(ImportSummary {
        statements: state.tables_done.load(Ordering::Relaxed),
        rows: state.rows.load(Ordering::Relaxed),
        bytes: std::fs::metadata(&o.path).map(|m| m.len()).unwrap_or(0),
        elapsed_ms: started.elapsed().as_millis() as u64,
        cancelled,
        failed: error.is_some(),
        error_count: error.is_some() as u64,
        errors: error.into_iter().map(|message| ImportError { line: 0, message, sql: String::new() }).collect(),
        notes,
    })
}

fn progress(s: &State, job_id: &str, est: u64, started: Instant) -> ImportProgress {
    let rows = s.rows.load(Ordering::Relaxed);
    ImportProgress {
        job_id: job_id.to_owned(),
        done_bytes: rows,
        total_bytes: est.max(rows),
        unit: "rows",
        statements: s.tables_done.load(Ordering::Relaxed),
        rows,
        error_count: s.failed.load(Ordering::Relaxed) as u64,
        table: s.table.lock().unwrap().clone(),
        elapsed_ms: started.elapsed().as_millis() as u64,
        active_workers: s.active.load(Ordering::Relaxed),
        auto_limit: None,
        workers: s.workers.lock().unwrap().clone(),
    }
}

/// MySQL connections use the exported database, so SHOW CREATE leaves names unqualified
/// and the dump loads into a database with another name.
async fn open(pool: &DbPool, n: usize, database: &str) -> AppResult<Vec<Conn>> {
    let mut conns = Vec::new();
    match pool {
        DbPool::Pg(p) => {
            let ip = PgPoolOptions::new().max_connections(n as u32).acquire_timeout(Duration::from_secs(30)).connect_with((*p.connect_options()).clone()).await?;
            for _ in 0..n {
                conns.push(Conn::Pg(ip.acquire().await?));
            }
        }
        DbPool::My(p) => {
            let opts = (*p.connect_options()).clone().database(database);
            let ip = MySqlPoolOptions::new().max_connections(n as u32).acquire_timeout(Duration::from_secs(30)).connect_with(opts).await?;
            for _ in 0..n {
                conns.push(Conn::My(ip.acquire().await?));
            }
        }
    }
    Ok(conns)
}

async fn export(pool: &DbPool, o: &ExportOptions, workers: usize, state: &Arc<State>, est: &AtomicU64) -> AppResult<Vec<String>> {
    let mysql = matches!(pool, DbPool::My(_));
    // the main connection reads the catalog and holds the snapshot the workers share
    let mut conns = open(pool, workers + 1, &o.schemas[0]).await?;
    let mut main = conns.remove(0);
    let mut notes = Vec::new();

    if mysql {
        let locked = workers > 1 && o.consistent && o.data && main.exec("FLUSH TABLES WITH READ LOCK").await.is_ok();
        if workers > 1 && o.consistent && o.data && !locked {
            notes.push("Couldn't take the global read lock (needs the RELOAD privilege): each table is consistent on its own.".into());
        }
        for c in conns.iter_mut().chain(std::iter::once(&mut main)) {
            c.exec("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ").await?;
            c.exec("START TRANSACTION WITH CONSISTENT SNAPSHOT").await?;
            c.exec("SET time_zone = '+00:00'").await?;
        }
        if locked {
            main.exec("UNLOCK TABLES").await?;
        }
    } else {
        main.exec("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY").await?;
        let snap = main.rows("select pg_export_snapshot()").await?;
        let snap = snap.first().and_then(|r| r[0].clone()).ok_or_else(|| msg("No snapshot"))?;
        for c in conns.iter_mut() {
            c.exec("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY").await?;
            c.exec(&format!("SET TRANSACTION SNAPSHOT '{snap}'")).await?;
        }
    }

    let mut plan = if mysql { my_plan(&mut main, o, workers).await? } else { pg_plan(&mut main, o, workers).await? };
    notes.append(&mut plan.notes);
    est.store(plan.est_rows, Ordering::Relaxed);
    *state.table.lock().unwrap() = String::new();

    // output: pre-data, the data pieces in order, post-data
    let out_path = PathBuf::from(&o.path);
    let parts_dir = PathBuf::from(format!("{}.parts", o.path));
    std::fs::create_dir_all(&parts_dir)?;
    let mut out = BufWriter::with_capacity(1 << 20, File::create(&out_path)?);
    let gzip = o.gzip;
    let write_part = |name: &str, text: &str| -> std::io::Result<PathBuf> {
        let p = parts_dir.join(name);
        let mut w = Part::create(&p, gzip)?;
        w.write_all(text.as_bytes())?;
        w.finish()?;
        Ok(p)
    };
    append(&mut out, &write_part("pre", &plan.pre)?)?;

    let chunks = Arc::new(std::mem::take(&mut plan.chunks));
    let next = Arc::new(AtomicUsize::new(0));
    let (done_tx, mut done_rx) = tokio::sync::mpsc::unbounded_channel::<usize>();
    let mut handles = Vec::new();
    for (i, conn) in conns.into_iter().enumerate() {
        let (chunks, next, state, done_tx, dir) = (chunks.clone(), next.clone(), state.clone(), done_tx.clone(), parts_dir.clone());
        handles.push(tokio::spawn(async move {
            let mut conn = conn;
            loop {
                let k = next.fetch_add(1, Ordering::Relaxed);
                if k >= chunks.len() || state.stopped() {
                    break;
                }
                let ch = &chunks[k];
                set_worker(&state, i, true, &ch.table);
                let r = dump_chunk(&mut conn, ch, &dir.join(format!("{k}")), gzip, &state).await;
                set_worker(&state, i, false, "");
                match r {
                    Ok(()) => {
                        let _ = done_tx.send(k);
                    }
                    Err(e) => {
                        state.fail(format!("{}: {e}", ch.table));
                        break;
                    }
                }
            }
        }));
    }
    drop(done_tx);

    // append pieces in order as they finish, so the temporary files stay few
    let mut ready = HashSet::new();
    let mut written = 0usize;
    let mut tables_seen: HashMap<&str, usize> = HashMap::new();
    for c in chunks.iter() {
        *tables_seen.entry(c.table.as_str()).or_default() += 1;
    }
    while written < chunks.len() {
        let Some(k) = done_rx.recv().await else { break };
        ready.insert(k);
        while ready.remove(&written) {
            let p = parts_dir.join(format!("{written}"));
            append(&mut out, &p)?;
            let left = tables_seen.get_mut(chunks[written].table.as_str()).unwrap();
            *left -= 1;
            if *left == 0 {
                state.tables_done.fetch_add(1, Ordering::Relaxed);
            }
            written += 1;
        }
    }
    for h in handles {
        let _ = h.await;
    }
    let _ = main.exec(if mysql { "COMMIT" } else { "COMMIT" }).await;
    if !state.stopped() {
        *state.table.lock().unwrap() = "Writing indexes and constraints…".into();
        append(&mut out, &write_part("post", &plan.post)?)?;
    }
    out.flush()?;
    drop(out);
    let _ = std::fs::remove_dir_all(&parts_dir);
    state.bytes.store(std::fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0), Ordering::Relaxed);
    Ok(notes)
}

fn append(out: &mut BufWriter<File>, part: &Path) -> std::io::Result<()> {
    let mut f = File::open(part)?;
    std::io::copy(&mut f, out)?;
    drop(f);
    std::fs::remove_file(part)
}

fn set_worker(s: &State, i: usize, busy: bool, table: &str) {
    let mut w = s.workers.lock().unwrap();
    if let Some(v) = w.get_mut(i) {
        v.busy = busy;
        if busy {
            v.table = table.to_owned();
            v.jobs += 1;
        }
    }
    if busy {
        s.active.fetch_add(1, Ordering::Relaxed);
        *s.table.lock().unwrap() = table.to_owned();
    } else {
        s.active.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Compression and disk writes run on a blocking thread, so a busy export doesn't hold up the
/// async runtime (progress events, other queries).
fn part_writer(path: PathBuf, gzip: bool) -> (tokio::sync::mpsc::Sender<Vec<u8>>, tokio::task::JoinHandle<std::io::Result<()>>) {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(8);
    let handle = tokio::task::spawn_blocking(move || {
        let mut w = Part::create(&path, gzip)?;
        while let Some(b) = rx.blocking_recv() {
            w.write_all(&b)?;
        }
        w.finish()
    });
    (tx, handle)
}

const SEND_BYTES: usize = 256 * 1024;

async fn dump_chunk(conn: &mut Conn, ch: &Chunk, path: &Path, gzip: bool, state: &State) -> AppResult<()> {
    let (tx, writer) = part_writer(path.to_path_buf(), gzip);
    let send = |b: Vec<u8>| {
        let tx = tx.clone();
        async move { tx.send(b).await.map_err(|_| msg("Writing the file failed")) }
    };
    send(ch.header.clone().into_bytes()).await?;
    match conn {
        Conn::Pg(c) => {
            let mut stream = c.copy_out_raw(&ch.query).await?;
            let mut buf = Vec::with_capacity(SEND_BYTES * 2);
            while let Some(b) = stream.try_next().await? {
                state.rows.fetch_add(memchr_count(&b) as u64, Ordering::Relaxed);
                buf.extend_from_slice(&b);
                if buf.len() >= SEND_BYTES {
                    send(std::mem::replace(&mut buf, Vec::with_capacity(SEND_BYTES * 2))).await?;
                    if state.stopped() {
                        break;
                    }
                }
            }
            drop(stream);
            buf.extend_from_slice(b"\\.\n\n");
            send(buf).await?;
        }
        Conn::My(c) => {
            let (prefix, lits) = ch.insert.as_ref().ok_or_else(|| msg("No INSERT"))?;
            let q = sqlx::raw_sql(AssertSqlSafe(ch.query.clone()));
            let mut stream = q.fetch(&mut **c);
            let mut stmt = String::new();
            while let Some(row) = stream.try_next().await? {
                stmt.push_str(if stmt.is_empty() { prefix } else { ",\n" });
                stmt.push('(');
                for (i, lit) in lits.iter().enumerate() {
                    if i > 0 {
                        stmt.push(',');
                    }
                    my_value(&row, i, *lit, &mut stmt);
                }
                stmt.push(')');
                state.rows.fetch_add(1, Ordering::Relaxed);
                if stmt.len() >= INSERT_BYTES {
                    stmt.push_str(";\n");
                    send(std::mem::take(&mut stmt).into_bytes()).await?;
                    if state.stopped() {
                        break;
                    }
                }
            }
            if !stmt.is_empty() {
                stmt.push_str(";\n");
            }
            stmt.push('\n');
            send(stmt.into_bytes()).await?;
        }
    }
    drop(tx);
    writer.await.map_err(|e| msg(e.to_string()))??;
    Ok(())
}

fn memchr_count(b: &[u8]) -> usize {
    b.iter().filter(|&&c| c == b'\n').count()
}

fn my_value(row: &MySqlRow, i: usize, lit: Lit, out: &mut String) {
    let Ok(raw) = row.try_get_raw(i) else { return out.push_str("NULL") };
    if raw.is_null() {
        return out.push_str("NULL");
    }
    let bytes: Vec<u8> = row.try_get_unchecked(i).unwrap_or_default();
    match lit {
        Lit::Raw => out.push_str(&String::from_utf8_lossy(&bytes)),
        Lit::Hex => {
            if bytes.is_empty() {
                return out.push_str("''");
            }
            out.push_str("0x");
            for b in &bytes {
                out.push_str(&format!("{b:02X}"));
            }
        }
        Lit::Str => {
            out.push('\'');
            for ch in String::from_utf8_lossy(&bytes).chars() {
                match ch {
                    '\'' => out.push_str("\\'"),
                    '\\' => out.push_str("\\\\"),
                    '\0' => out.push_str("\\0"),
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\u{1a}' => out.push_str("\\Z"),
                    c => out.push(c),
                }
            }
            out.push('\'');
        }
    }
}

// ---- helpers

fn t(c: &Cell) -> String {
    c.clone().unwrap_or_default()
}

fn pg_lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn my_lit(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
}

fn my_ident(s: &str) -> String {
    format!("`{}`", s.replace('`', "``"))
}

fn in_list(schemas: &[String]) -> String {
    schemas.iter().map(|s| pg_lit(s)).collect::<Vec<_>>().join(", ")
}

/// Splits [min, max] into ranges for tables big enough to be worth it.
fn ranges(min: i64, max: i64, est: i64, workers: usize) -> Vec<(i64, i64)> {
    let pieces = ((est / CHUNK_ROWS) as usize + 1).min(workers * 4).max(1);
    if pieces <= 1 || max <= min {
        return vec![(i64::MIN, i64::MAX)];
    }
    let step = ((max - min) / pieces as i64).max(1);
    let mut out = Vec::new();
    let mut lo = i64::MIN;
    let mut at = min + step;
    while at <= max {
        out.push((lo, at));
        lo = at;
        at = at.saturating_add(step);
    }
    out.push((lo, i64::MAX));
    out
}

fn range_where(col: &str, lo: i64, hi: i64) -> String {
    match (lo == i64::MIN, hi == i64::MAX) {
        (true, true) => String::new(),
        (true, false) => format!(" WHERE {col} < {hi}"),
        (false, true) => format!(" WHERE {col} >= {lo}"),
        (false, false) => format!(" WHERE {col} >= {lo} AND {col} < {hi}"),
    }
}

// ---- PostgreSQL

async fn pg_plan(c: &mut Conn, o: &ExportOptions, workers: usize) -> AppResult<Plan> {
    let ns = in_list(&o.schemas);
    let not_ext = |oid: &str| format!("not exists (select 1 from pg_depend e where e.objid = {oid} and e.deptype = 'e')");
    let ver: i64 = c.rows("select current_setting('server_version_num')::int").await?.first().and_then(|r| t(&r[0]).parse().ok()).unwrap_or(0);
    let info = c.rows("select current_database(), version()").await?;
    let (dbname, version) = info.first().map(|r| (t(&r[0]), t(&r[1]))).unwrap_or_default();

    let mut notes = Vec::new();
    let mut pre = String::new();
    let mut post = String::new();
    pre.push_str(&format!(
        "-- DB Client dump\n-- Database: {dbname} ({})\n-- Schemas: {}\n-- Not included: owners, grants, publications, large objects\n\n\
         SET statement_timeout = 0;\nSET lock_timeout = 0;\nSET client_encoding = 'UTF8';\nSET standard_conforming_strings = on;\n\
         SET check_function_bodies = false;\nSET client_min_messages = warning;\n\n",
        version.split(',').next().unwrap_or_default(),
        o.schemas.join(", ")
    ));

    if o.structure {
        for s in &o.schemas {
            if s != "public" {
                let q = c.rows(&format!("select quote_ident({})", pg_lit(s))).await?;
                pre.push_str(&format!("CREATE SCHEMA IF NOT EXISTS {};\n", t(&q[0][0])));
            }
        }
        for r in c.rows("select quote_ident(e.extname), quote_ident(n.nspname) from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname <> 'plpgsql' order by 1").await? {
            pre.push_str(&format!("CREATE EXTENSION IF NOT EXISTS {} WITH SCHEMA {};\n", t(&r[0]), t(&r[1])));
        }
        pre.push('\n');

        // types: enums, domains, composites
        let q = format!(
            "select format('%I.%I', n.nspname, t.typname), string_agg(quote_literal(e.enumlabel), ', ' order by e.enumsortorder)
               from pg_type t join pg_namespace n on n.oid = t.typnamespace join pg_enum e on e.enumtypid = t.oid
              where n.nspname in ({ns}) and {} group by 1 order by 1",
            not_ext("t.oid")
        );
        for r in c.rows(&q).await? {
            if o.drop_existing {
                pre.push_str(&format!("DROP TYPE IF EXISTS {} CASCADE;\n", t(&r[0])));
            }
            pre.push_str(&format!("CREATE TYPE {} AS ENUM ({});\n", t(&r[0]), t(&r[1])));
        }
        let q = format!(
            "select format('%I.%I', n.nspname, t.typname), format_type(t.typbasetype, t.typtypmod), t.typnotnull, t.typdefault,
                    (select string_agg(' CONSTRAINT ' || quote_ident(k.conname) || ' ' || pg_get_constraintdef(k.oid), '') from pg_constraint k where k.contypid = t.oid)
               from pg_type t join pg_namespace n on n.oid = t.typnamespace
              where t.typtype = 'd' and n.nspname in ({ns}) and {} order by 1",
            not_ext("t.oid")
        );
        for r in c.rows(&q).await? {
            if o.drop_existing {
                pre.push_str(&format!("DROP DOMAIN IF EXISTS {} CASCADE;\n", t(&r[0])));
            }
            let mut d = format!("CREATE DOMAIN {} AS {}", t(&r[0]), t(&r[1]));
            if let Some(def) = &r[3] {
                d.push_str(&format!(" DEFAULT {def}"));
            }
            if t(&r[2]) == "true" {
                d.push_str(" NOT NULL");
            }
            d.push_str(&t(&r[4]));
            pre.push_str(&d);
            pre.push_str(";\n");
        }
        let q = format!(
            "select format('%I.%I', n.nspname, t.typname), string_agg(quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod), ', ' order by a.attnum)
               from pg_type t join pg_namespace n on n.oid = t.typnamespace join pg_class cl on cl.oid = t.typrelid and cl.relkind = 'c'
               join pg_attribute a on a.attrelid = cl.oid and a.attnum > 0 and not a.attisdropped
              where n.nspname in ({ns}) and {} group by 1 order by 1",
            not_ext("t.oid")
        );
        for r in c.rows(&q).await? {
            if o.drop_existing {
                pre.push_str(&format!("DROP TYPE IF EXISTS {} CASCADE;\n", t(&r[0])));
            }
            pre.push_str(&format!("CREATE TYPE {} AS ({});\n", t(&r[0]), t(&r[1])));
        }
        let aggs = c.rows(&format!("select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.prokind = 'a' and n.nspname in ({ns}) and {}", not_ext("p.oid"))).await?;
        if t(&aggs[0][0]) != "0" {
            notes.push("Aggregate functions are not included.".into());
        }
        let ranges = c.rows(&format!("select count(*) from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typtype = 'r' and n.nspname in ({ns}) and {}", not_ext("t.oid"))).await?;
        if t(&ranges[0][0]) != "0" {
            notes.push("Range types are not included.".into());
        }

        // sequences that aren't identity columns
        let q = format!(
            "select format('%I.%I', n.nspname, cl.relname), format_type(s.seqtypid, null), s.seqincrement, s.seqmin, s.seqmax, s.seqstart, s.seqcache, s.seqcycle,
                    pg_sequence_last_value(cl.oid),
                    (select format('%I.%I.%I', tn.nspname, tc.relname, ta.attname) from pg_depend d join pg_class tc on tc.oid = d.refobjid
                       join pg_namespace tn on tn.oid = tc.relnamespace join pg_attribute ta on ta.attrelid = tc.oid and ta.attnum = d.refobjsubid
                      where d.objid = cl.oid and d.deptype = 'a' and d.refobjsubid > 0 limit 1)
               from pg_sequence s join pg_class cl on cl.oid = s.seqrelid join pg_namespace n on n.oid = cl.relnamespace
              where n.nspname in ({ns}) and not exists (select 1 from pg_depend d where d.objid = cl.oid and d.deptype = 'i') and {} order by 1",
            not_ext("cl.oid")
        );
        let seqs = c.rows(&q).await?;
        if !seqs.is_empty() {
            pre.push('\n');
        }
        for r in &seqs {
            if o.drop_existing {
                pre.push_str(&format!("DROP SEQUENCE IF EXISTS {} CASCADE;\n", t(&r[0])));
            }
            pre.push_str(&format!(
                "CREATE SEQUENCE IF NOT EXISTS {} AS {} INCREMENT BY {} MINVALUE {} MAXVALUE {} START WITH {} CACHE {}{};\n",
                t(&r[0]),
                t(&r[1]),
                t(&r[2]),
                t(&r[3]),
                t(&r[4]),
                t(&r[5]),
                t(&r[6]),
                if t(&r[7]) == "true" { " CYCLE" } else { "" }
            ));
        }

        // functions and procedures (bodies aren't checked, so order doesn't matter)
        let q = format!(
            "select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where p.prokind in ('f', 'p') and n.nspname in ({ns}) and {} order by n.nspname, p.proname",
            not_ext("p.oid")
        );
        let funcs = c.rows(&q).await?;
        if !funcs.is_empty() {
            pre.push('\n');
        }
        for r in funcs {
            pre.push_str(t(&r[0]).trim_end());
            pre.push_str(";\n\n");
        }

        // post-data: sequence values and ownership
        for r in &seqs {
            if let Some(v) = &r[8] {
                post.push_str(&format!("SELECT pg_catalog.setval({}, {v}, true);\n", pg_lit(&t(&r[0]))));
            }
            if let Some(owner) = &r[9] {
                post.push_str(&format!("ALTER SEQUENCE {} OWNED BY {owner};\n", t(&r[0])));
            }
        }
    }

    // tables
    let q = format!(
        "select c.oid, format('%I.%I', n.nspname, c.relname), c.relkind, c.relpersistence, case when c.relkind = 'p' then pg_get_partkeydef(c.oid) end,
                c.relispartition, case when c.relispartition then pg_get_expr(c.relpartbound, c.oid) end,
                (select string_agg(format('%I.%I', pn.nspname, pc.relname), ', ') from pg_inherits i join pg_class pc on pc.oid = i.inhparent
                   join pg_namespace pn on pn.oid = pc.relnamespace where i.inhrelid = c.oid),
                -- not analyzed yet: guess from the size
                case when c.reltuples > 0 then c.reltuples::bigint else pg_relation_size(c.oid) / 100 end, c.relrowsecurity, c.relname
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r', 'p') and n.nspname in ({ns}) and {} order by n.nspname, c.relname",
        not_ext("c.oid")
    );
    let tables = c.rows(&q).await?;
    let q = format!(
        "select a.attrelid, quote_ident(a.attname), format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid), a.attidentity, a.attgenerated,
                case when a.attcollation <> t.typcollation and a.attcollation <> 0
                     then (select format('%I.%I', cn.nspname, co.collname) from pg_collation co join pg_namespace cn on cn.oid = co.collnamespace where co.oid = a.attcollation) end,
                a.attislocal,
                case when a.attidentity <> '' then pg_sequence_last_value(pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname)::regclass) end,
                col_description(c.oid, a.attnum), t.typname
           from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace join pg_type t on t.oid = a.atttypid
           left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
          where c.relkind in ('r', 'p') and n.nspname in ({ns}) and a.attnum > 0 and not a.attisdropped
          order by a.attrelid, a.attnum"
    );
    let mut cols: BTreeMap<String, Vec<Vec<Cell>>> = BTreeMap::new();
    for r in c.rows(&q).await? {
        cols.entry(t(&r[0])).or_default().push(r);
    }
    // single integer primary keys, for splitting big tables
    let q = format!(
        "select k.conrelid, quote_ident(a.attname) from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
           join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
          where k.contype = 'p' and array_length(k.conkey, 1) = 1 and a.atttypid in ('int2'::regtype, 'int4'::regtype, 'int8'::regtype) and n.nspname in ({ns})"
    );
    let int_pk: HashMap<String, String> = c.rows(&q).await?.into_iter().map(|r| (t(&r[0]), t(&r[1]))).collect();

    let mut chunks = Vec::new();
    let mut est_rows = 0u64;
    let mut created: HashSet<String> = HashSet::new();
    let mut pending: Vec<&Vec<Cell>> = tables.iter().collect();
    let mut table_ddl = String::new();
    let mut identity_post = String::new();
    let mut comments = String::new();
    // partitions after their parents
    while !pending.is_empty() {
        let before = pending.len();
        let mut rest = Vec::new();
        for r in pending {
            let parent = t(&r[7]);
            if t(&r[5]) == "true" && !parent.is_empty() && tables.iter().any(|x| t(&x[1]) == parent) && !created.contains(&parent) {
                rest.push(r);
                continue;
            }
            created.insert(t(&r[1]));
            let (oid, name, kind) = (t(&r[0]), t(&r[1]), t(&r[2]));
            let cs = cols.get(&oid).cloned().unwrap_or_default();
            if o.structure {
                if o.drop_existing {
                    table_ddl.push_str(&format!("DROP TABLE IF EXISTS {name} CASCADE;\n"));
                }
                table_ddl.push_str(&pg_table_ddl(r, &cs));
                for col in &cs {
                    if let (Some(v), "a" | "d") = (&col[9], t(&col[5]).as_str()) {
                        identity_post.push_str(&format!("SELECT pg_catalog.setval(pg_get_serial_sequence({}, {}), {v}, true);\n", pg_lit(&name), pg_lit(&t(&col[1]))));
                    }
                    if let Some(note) = &col[10] {
                        comments.push_str(&format!("COMMENT ON COLUMN {name}.{} IS {};\n", t(&col[1]), pg_lit(note)));
                    }
                }
            }
            // a partitioned table holds no rows itself
            if o.data && kind == "r" {
                let names: Vec<String> = cs.iter().filter(|c| t(&c[6]).is_empty()).map(|c| t(&c[1])).collect();
                let list = names.join(", ");
                let est = t(&r[8]).parse::<i64>().unwrap_or(0);
                est_rows += est.max(0) as u64;
                let header = format!("COPY {name} ({list}) FROM stdin;\n");
                let inherited = !t(&r[7]).is_empty() || tables.iter().any(|x| t(&x[7]).split(", ").any(|p| p == name));
                let pk = int_pk.get(&oid).filter(|_| est > CHUNK_ROWS && workers > 1);
                let parts = match pk {
                    Some(pk) => {
                        let mm = c.rows(&format!("select min({pk}), max({pk}) from {name}")).await?;
                        let min = mm.first().and_then(|r| t(&r[0]).parse().ok());
                        let max = mm.first().and_then(|r| t(&r[1]).parse().ok());
                        match (min, max) {
                            (Some(a), Some(b)) => ranges(a, b, est, workers).into_iter().map(|(lo, hi)| range_where(pk, lo, hi)).collect(),
                            _ => vec![String::new()],
                        }
                    }
                    None => vec![String::new()],
                };
                for w in parts {
                    let query = if w.is_empty() && !inherited { format!("COPY {name} ({list}) TO STDOUT") } else { format!("COPY (SELECT {list} FROM ONLY {name}{w}) TO STDOUT") };
                    chunks.push(Chunk { table: name.clone(), query, header: header.clone(), insert: None });
                }
            }
            if o.structure && t(&r[9]) == "true" {
                post.push_str(&format!("ALTER TABLE {name} ENABLE ROW LEVEL SECURITY;\n"));
            }
        }
        if rest.len() == before {
            // parents outside the export: create the rest anyway
            for r in &rest {
                created.insert(t(&r[1]));
            }
        }
        pending = rest;
    }
    if o.structure {
        pre.push('\n');
        pre.push_str(&table_ddl);
    }

    if o.structure {
        let parent_filter = if ver >= 110000 { "and k.conparentid = 0" } else { "" };
        let q = format!(
            "select format('%I.%I', n.nspname, c.relname), quote_ident(k.conname), k.contype, pg_get_constraintdef(k.oid)
               from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
              where k.contype in ('p', 'u', 'x', 'c', 'f') and k.conislocal {parent_filter} and n.nspname in ({ns}) and c.relkind in ('r', 'p')
              order by case k.contype when 'p' then 0 when 'u' then 1 when 'x' then 2 when 'c' then 3 else 4 end, 1, 2"
        );
        let cons = c.rows(&q).await?;
        let mut fks = String::new();
        post.push('\n');
        for r in &cons {
            let line = format!("ALTER TABLE {} ADD CONSTRAINT {} {};\n", t(&r[0]), t(&r[1]), t(&r[3]));
            if t(&r[2]) == "f" {
                fks.push_str(&line);
            } else {
                post.push_str(&line);
            }
        }
        let q = format!(
            "select pg_get_indexdef(i.indexrelid), c.relkind
               from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
              where n.nspname in ({ns}) and c.relkind in ('r', 'p', 'm')
                and not exists (select 1 from pg_constraint k where k.conindid = i.indexrelid and k.contype in ('p', 'u', 'x'))
                and not exists (select 1 from pg_inherits h where h.inhrelid = i.indexrelid)
              order by 1"
        );
        let idx = c.rows(&q).await?;
        let mut mat_idx = String::new();
        for r in &idx {
            // "ON ONLY" would leave the partitions without the index
            let line = format!("{};\n", t(&r[0]).replacen(" ON ONLY ", " ON ", 1));
            if t(&r[1]) == "m" {
                mat_idx.push_str(&line);
            } else {
                post.push_str(&line);
            }
        }
        post.push_str(&fks);
        post.push_str(&identity_post);

        // views in dependency order
        let q = format!(
            "select c.oid, format('%I.%I', n.nspname, c.relname), c.relkind, pg_get_viewdef(c.oid, true), array_to_string(c.reloptions, ', '), obj_description(c.oid, 'pg_class')
               from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('v', 'm') and n.nspname in ({ns}) and {} order by 2",
            not_ext("c.oid")
        );
        let views = c.rows(&q).await?;
        let deps = c
            .rows("select distinct r.ev_class, d.refobjid from pg_depend d join pg_rewrite r on r.oid = d.objid where d.classid = 'pg_rewrite'::regclass and d.refclassid = 'pg_class'::regclass and d.refobjid <> r.ev_class")
            .await?;
        let mut needs: HashMap<String, Vec<String>> = HashMap::new();
        for d in deps {
            needs.entry(t(&d[0])).or_default().push(t(&d[1]));
        }
        let by_oid: HashMap<String, &Vec<Cell>> = views.iter().map(|v| (t(&v[0]), v)).collect();
        let mut done = HashSet::new();
        let mut order = Vec::new();
        fn visit<'a>(oid: &str, by: &HashMap<String, &'a Vec<Cell>>, needs: &HashMap<String, Vec<String>>, done: &mut HashSet<String>, order: &mut Vec<&'a Vec<Cell>>) {
            if !done.insert(oid.to_owned()) {
                return;
            }
            for d in needs.get(oid).into_iter().flatten() {
                if by.contains_key(d) {
                    visit(d, by, needs, done, order);
                }
            }
            order.push(by[oid]);
        }
        for v in &views {
            visit(&t(&v[0]), &by_oid, &needs, &mut done, &mut order);
        }
        if !order.is_empty() {
            post.push('\n');
        }
        for v in order {
            let (name, kind, def) = (t(&v[1]), t(&v[2]), t(&v[3]));
            let with = v[4].as_ref().filter(|s| !s.is_empty()).map(|s| format!(" WITH ({s})")).unwrap_or_default();
            let def = def.trim().trim_end_matches(';');
            if kind == "m" {
                if o.drop_existing {
                    post.push_str(&format!("DROP MATERIALIZED VIEW IF EXISTS {name} CASCADE;\n"));
                }
                post.push_str(&format!("CREATE MATERIALIZED VIEW {name}{with} AS\n{def}\nWITH {}DATA;\n", if o.data { "" } else { "NO " }));
                if let Some(cm) = &v[5] {
                    comments.push_str(&format!("COMMENT ON MATERIALIZED VIEW {name} IS {};\n", pg_lit(cm)));
                }
            } else {
                if o.drop_existing {
                    post.push_str(&format!("DROP VIEW IF EXISTS {name} CASCADE;\n"));
                }
                post.push_str(&format!("CREATE VIEW {name}{with} AS\n{def};\n"));
                if let Some(cm) = &v[5] {
                    comments.push_str(&format!("COMMENT ON VIEW {name} IS {};\n", pg_lit(cm)));
                }
            }
        }
        post.push_str(&mat_idx);

        let trig_filter = if ver >= 130000 { "and t.tgparentid = 0" } else { "" };
        let q = format!(
            "select pg_get_triggerdef(t.oid, true) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
              where not t.tgisinternal {trig_filter} and n.nspname in ({ns}) order by c.relname, t.tgname"
        );
        let trig = c.rows(&q).await?;
        if !trig.is_empty() {
            post.push('\n');
        }
        for r in trig {
            post.push_str(&format!("{};\n", t(&r[0])));
        }

        let q = format!(
            "select format('%I', p.policyname), format('%I.%I', p.schemaname, p.tablename), p.permissive, p.cmd, array_to_string(p.roles, ', '), p.qual, p.with_check
               from pg_policies p where p.schemaname in ({ns}) order by 2, 1"
        );
        for r in c.rows(&q).await? {
            let mut s = format!("CREATE POLICY {} ON {} AS {} FOR {} TO {}", t(&r[0]), t(&r[1]), t(&r[2]), t(&r[3]), t(&r[4]));
            if let Some(q) = &r[5] {
                s.push_str(&format!(" USING ({q})"));
            }
            if let Some(w) = &r[6] {
                s.push_str(&format!(" WITH CHECK ({w})"));
            }
            post.push_str(&s);
            post.push_str(";\n");
        }

        for r in &tables {
            if let Some(cm) = c.rows(&format!("select obj_description({}, 'pg_class')", t(&r[0]))).await?.first().and_then(|x| x[0].clone()) {
                comments.insert_str(0, &format!("COMMENT ON TABLE {} IS {};\n", t(&r[1]), pg_lit(&cm)));
            }
        }
        if !comments.is_empty() {
            post.push('\n');
            post.push_str(&comments);
        }
    }

    Ok(Plan { pre, post, chunks, est_rows, notes })
}

fn pg_table_ddl(r: &[Cell], cols: &[Vec<Cell>]) -> String {
    let (name, kind, persistence) = (t(&r[1]), t(&r[2]), t(&r[3]));
    let unlogged = if persistence == "u" { "UNLOGGED " } else { "" };
    if t(&r[5]) == "true" {
        if let (Some(parent), Some(bound)) = (r[7].as_ref(), r[6].as_ref()) {
            let by = r[4].as_ref().map(|k| format!(" PARTITION BY {k}")).unwrap_or_default();
            return format!("CREATE {unlogged}TABLE {name} PARTITION OF {parent} {bound}{by};\n");
        }
    }
    let inherits = r[7].as_ref().filter(|s| !s.is_empty());
    let mut lines = Vec::new();
    for c in cols {
        // inherited columns come from the parent
        if inherits.is_some() && t(&c[8]) != "true" {
            continue;
        }
        let mut l = format!("    {} {}", t(&c[1]), t(&c[2]));
        if let Some(coll) = &c[7] {
            l.push_str(&format!(" COLLATE {coll}"));
        }
        match (t(&c[6]).as_str(), t(&c[5]).as_str()) {
            ("s", _) => l.push_str(&format!(" GENERATED ALWAYS AS ({}) STORED", t(&c[4]))),
            ("v", _) => l.push_str(&format!(" GENERATED ALWAYS AS ({}) VIRTUAL", t(&c[4]))),
            (_, "a") => l.push_str(" GENERATED ALWAYS AS IDENTITY"),
            (_, "d") => l.push_str(" GENERATED BY DEFAULT AS IDENTITY"),
            _ => {
                if let Some(d) = &c[4] {
                    l.push_str(&format!(" DEFAULT {d}"));
                }
            }
        }
        if t(&c[3]) == "true" {
            l.push_str(" NOT NULL");
        }
        lines.push(l);
    }
    let mut s = format!("CREATE {unlogged}TABLE {name} (\n{}\n)", lines.join(",\n"));
    if let Some(p) = inherits {
        s.push_str(&format!(" INHERITS ({p})"));
    }
    if kind == "p" {
        if let Some(k) = &r[4] {
            s.push_str(&format!(" PARTITION BY {k}"));
        }
    }
    s.push_str(";\n\n");
    s
}

// ---- MySQL

async fn my_plan(c: &mut Conn, o: &ExportOptions, workers: usize) -> AppResult<Plan> {
    let db = &o.schemas[0];
    let dbl = my_lit(db);
    let dbi = my_ident(db);
    let info = c.rows("select version()").await?;
    let version = info.first().map(|r| t(&r[0])).unwrap_or_default();
    let mut notes = Vec::new();
    let mut pre = format!(
        "-- DB Client dump\n-- Database: {db} (MySQL {version})\n-- Not included: users, grants, events\n\n\
         /*!40101 SET NAMES utf8mb4 */;\nSET FOREIGN_KEY_CHECKS = 0;\nSET UNIQUE_CHECKS = 0;\nSET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';\nSET time_zone = '+00:00';\n\n"
    );
    let mut post = String::new();

    let tables = c.rows(&format!("select table_name, table_type, coalesce(table_rows, 0) from information_schema.tables where table_schema = {dbl} order by table_name")).await?;
    let cols = c
        .rows(&format!(
            "select table_name, column_name, data_type, extra from information_schema.columns where table_schema = {dbl} order by table_name, ordinal_position"
        ))
        .await?;
    let mut by_table: HashMap<String, Vec<&Vec<Cell>>> = HashMap::new();
    for r in &cols {
        by_table.entry(t(&r[0])).or_default().push(r);
    }
    let pks = c
        .rows(&format!(
            "select k.table_name, k.column_name, c.data_type from information_schema.key_column_usage k
               join information_schema.columns c on c.table_schema = k.table_schema and c.table_name = k.table_name and c.column_name = k.column_name
              where k.table_schema = {dbl} and k.constraint_name = 'PRIMARY'"
        ))
        .await?;
    let mut pk_cols: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for r in pks {
        pk_cols.entry(t(&r[0])).or_default().push((t(&r[1]), t(&r[2])));
    }

    let mut chunks = Vec::new();
    let mut est_rows = 0u64;
    let mut view_names = Vec::new();
    for r in &tables {
        let (name, kind) = (t(&r[0]), t(&r[1]));
        let qn = my_ident(&name);
        if kind == "VIEW" {
            view_names.push(name);
            continue;
        }
        if o.structure {
            let ddl = c.rows(&format!("SHOW CREATE TABLE {dbi}.{qn}")).await?;
            if o.drop_existing {
                pre.push_str(&format!("DROP TABLE IF EXISTS {qn};\n"));
            }
            pre.push_str(&t(&ddl[0][1]));
            pre.push_str(";\n\n");
        }
        if o.data {
            let cs: Vec<&&Vec<Cell>> = by_table.get(&name).map(|v| v.iter().filter(|c| !t(&c[3]).to_ascii_uppercase().contains("GENERATED")).collect()).unwrap_or_default();
            let list = cs.iter().map(|c| my_ident(&t(&c[1]))).collect::<Vec<_>>().join(", ");
            let lits: Vec<Lit> = cs.iter().map(|c| my_lit_kind(&t(&c[2]))).collect();
            let prefix = format!("INSERT INTO {qn} ({list}) VALUES\n");
            let est = t(&r[2]).parse::<i64>().unwrap_or(0);
            est_rows += est.max(0) as u64;
            let pk = pk_cols.get(&name).filter(|p| p.len() == 1 && p[0].1.contains("int") && est > CHUNK_ROWS && workers > 1).map(|p| my_ident(&p[0].0));
            let parts = match &pk {
                Some(pk) => {
                    let mm = c.rows(&format!("select min({pk}), max({pk}) from {dbi}.{qn}")).await?;
                    match (mm.first().and_then(|r| t(&r[0]).parse().ok()), mm.first().and_then(|r| t(&r[1]).parse().ok())) {
                        (Some(a), Some(b)) => ranges(a, b, est, workers).into_iter().map(|(lo, hi)| range_where(pk, lo, hi)).collect(),
                        _ => vec![String::new()],
                    }
                }
                None => vec![String::new()],
            };
            for w in parts {
                chunks.push(Chunk {
                    table: name.clone(),
                    query: format!("SELECT {list} FROM {dbi}.{qn}{w}"),
                    header: String::new(),
                    insert: Some((prefix.clone(), lits.clone())),
                });
            }
        }
    }

    if o.structure {
        // views that use other views come later
        let mut defs: Vec<(String, String)> = Vec::new();
        for v in &view_names {
            let ddl = c.rows(&format!("SHOW CREATE VIEW {dbi}.{}", my_ident(v))).await?;
            let sql = t(&ddl[0][1]);
            defs.push((v.clone(), crate::dump::strip_definer(&sql).unwrap_or(sql)));
        }
        let mut done: HashSet<String> = HashSet::new();
        while done.len() < defs.len() {
            let before = done.len();
            for (name, sql) in &defs {
                if done.contains(name) {
                    continue;
                }
                let waits = defs.iter().any(|(other, _)| other != name && !done.contains(other) && sql.contains(&my_ident(other)));
                if !waits || before == done.len() && defs.iter().filter(|(n, _)| !done.contains(n)).count() == 1 {
                    if o.drop_existing {
                        post.push_str(&format!("DROP VIEW IF EXISTS {};\n", my_ident(name)));
                    }
                    post.push_str(sql);
                    post.push_str(";\n\n");
                    done.insert(name.clone());
                }
            }
            if done.len() == before {
                // a cycle or a reference we can't see: write the rest as they are
                for (name, sql) in &defs {
                    if done.insert(name.clone()) {
                        post.push_str(sql);
                        post.push_str(";\n\n");
                    }
                }
            }
        }

        let routines = c.rows(&format!("select routine_name, routine_type from information_schema.routines where routine_schema = {dbl} order by routine_type, routine_name")).await?;
        let mut hidden = 0;
        for r in routines {
            let kind = t(&r[1]);
            let ddl = c.rows(&format!("SHOW CREATE {kind} {dbi}.{}", my_ident(&t(&r[0])))).await?;
            match ddl.first().and_then(|d| d.get(2).cloned().flatten()) {
                Some(sql) => {
                    if o.drop_existing {
                        post.push_str(&format!("DROP {kind} IF EXISTS {};\n", my_ident(&t(&r[0]))));
                    }
                    let sql = crate::dump::strip_definer(&sql).unwrap_or(sql);
                    post.push_str(&format!("DELIMITER ;;\n{sql};;\nDELIMITER ;\n\n"));
                }
                None => hidden += 1,
            }
        }
        if hidden > 0 {
            notes.push(format!("{hidden} routine(s) skipped: your account can't read their definition."));
        }
        let triggers = c.rows(&format!("select trigger_name from information_schema.triggers where trigger_schema = {dbl} order by event_object_table, action_order")).await?;
        for r in triggers {
            let ddl = c.rows(&format!("SHOW CREATE TRIGGER {dbi}.{}", my_ident(&t(&r[0])))).await?;
            if let Some(sql) = ddl.first().and_then(|d| d.get(2).cloned().flatten()) {
                if o.drop_existing {
                    post.push_str(&format!("DROP TRIGGER IF EXISTS {};\n", my_ident(&t(&r[0]))));
                }
                let sql = crate::dump::strip_definer(&sql).unwrap_or(sql);
                post.push_str(&format!("DELIMITER ;;\n{sql};;\nDELIMITER ;\n\n"));
            }
        }
        let events = c.rows(&format!("select count(*) from information_schema.events where event_schema = {dbl}")).await?;
        if t(&events[0][0]) != "0" {
            notes.push("Scheduled events are not included.".into());
        }
    }
    post.push_str("SET FOREIGN_KEY_CHECKS = 1;\nSET UNIQUE_CHECKS = 1;\n");
    Ok(Plan { pre, post, chunks, est_rows, notes })
}

fn my_lit_kind(data_type: &str) -> Lit {
    match data_type.to_ascii_lowercase().as_str() {
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" | "decimal" | "numeric" | "float" | "double" | "real" | "year" => Lit::Raw,
        "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob" | "bit" | "geometry" | "point" | "linestring" | "polygon" | "multipoint"
        | "multilinestring" | "multipolygon" | "geometrycollection" | "geomcollection" => Lit::Hex,
        _ => Lit::Str,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_cover_everything() {
        let r = ranges(1, 1_000_000, 1_000_000, 4);
        assert_eq!(r.first().unwrap().0, i64::MIN);
        assert_eq!(r.last().unwrap().1, i64::MAX);
        for w in r.windows(2) {
            assert_eq!(w[0].1, w[1].0);
        }
        assert_eq!(ranges(1, 10, 100, 4), vec![(i64::MIN, i64::MAX)]);
    }

    #[test]
    fn range_sql() {
        assert_eq!(range_where("id", i64::MIN, 10), " WHERE id < 10");
        assert_eq!(range_where("id", 10, 20), " WHERE id >= 10 AND id < 20");
        assert_eq!(range_where("id", i64::MIN, i64::MAX), "");
    }
}
