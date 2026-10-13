//! Parallel SQL dump import.
//!
//! A reader thread streams the file (also .gz) into statements. The dispatcher then:
//! - batches INSERTs and COPY blocks into jobs for N connections;
//! - records SET/USE so every connection applies them before its next job;
//! - lets CREATE/DROP TABLE wait only for jobs on the same table;
//! - runs CREATE INDEX / PRIMARY KEY in parallel across tables, after that table's data;
//! - runs everything else alone, in file order, after all jobs finish.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sqlx::mysql::{MySql, MySqlPoolOptions};
use sqlx::pool::PoolConnection;
use sqlx::postgres::{PgPoolOptions, Postgres};
use sqlx::AssertSqlSafe;
use tokio::sync::{mpsc, watch};

use crate::db::DbPool;
use crate::dump::{classify, copy_table, strip_definer, Kind, Piece, Splitter};
use crate::error::{msg, AppResult};

/// INSERT text per job (one transaction).
const BATCH_BYTES: usize = 4 * 1024 * 1024;
const BATCH_STMTS: usize = 1000;
/// Errors kept for display; the rest are only counted.
const MAX_ERRORS: usize = 500;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOptions {
    pub path: String,
    pub workers: usize,
    /// Disable foreign key / unique checks while importing.
    pub fast: bool,
    /// Skip failing statements instead of stopping.
    pub continue_on_error: bool,
    /// MySQL target database (when the dump has no USE).
    pub database: Option<String>,
    pub create_database: bool,
    /// MySQL: strip DEFINER=... from views, triggers and routines.
    #[serde(default)]
    pub strip_definer: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportError {
    pub line: u64,
    pub message: String,
    pub sql: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    pub job_id: String,
    /// Uncompressed SQL bytes already executed
    pub done_bytes: u64,
    /// Estimated total (for .gz, from the compression ratio so far)
    pub total_bytes: u64,
    /// "bytes", or "rows" for Excel
    pub unit: &'static str,
    pub statements: u64,
    pub rows: u64,
    pub error_count: u64,
    pub table: String,
    pub elapsed_ms: u64,
    pub active_workers: usize,
    /// Per connection; the first is the main one (DDL and ordered statements).
    pub workers: Vec<WorkerView>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerView {
    pub busy: bool,
    /// "insert", "copy", "index" or "sql" (main connection)
    pub task: String,
    pub table: String,
    pub jobs: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub statements: u64,
    pub rows: u64,
    pub bytes: u64,
    pub elapsed_ms: u64,
    pub cancelled: bool,
    /// Stopped at an error (continue_on_error off)
    pub failed: bool,
    pub error_count: u64,
    pub errors: Vec<ImportError>,
    pub notes: Vec<String>,
}

/// Running imports, so they can be cancelled.
#[derive(Default)]
pub struct Imports(pub(crate) Mutex<HashMap<String, Arc<AtomicBool>>>);

impl Imports {
    pub fn cancel(&self, job_id: &str) -> bool {
        match self.0.lock().unwrap().get(job_id) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }
}


pub(crate) struct Shared {
    pub(crate) cancel: Arc<AtomicBool>,
    /// Error with continue_on_error off: nothing else runs.
    pub(crate) failed: AtomicBool,
    pub(crate) continue_on_error: bool,
    pub(crate) bytes: AtomicU64,
    /// Uncompressed bytes read and executed
    pub(crate) raw_read: AtomicU64,
    pub(crate) raw_done: AtomicU64,
    pub(crate) statements: AtomicU64,
    pub(crate) rows: AtomicU64,
    pub(crate) error_count: AtomicU64,
    pub(crate) errors: Mutex<Vec<ImportError>>,
    pub(crate) table: Mutex<String>,
    pub(crate) active: AtomicUsize,
    pub(crate) workers: Mutex<Vec<WorkerView>>,
    /// Session statements (SET, USE) in order; each connection applies the ones it hasn't yet.
    pub(crate) session: RwLock<Vec<String>>,
    /// Jobs in flight by key ("d:table" for data, "i:table" for indexes).
    pub(crate) inflight: Mutex<HashMap<String, usize>>,
    pub(crate) total: AtomicUsize,
    pub(crate) changed: watch::Sender<u64>,
}

impl Shared {
    pub(crate) fn stopped(&self) -> bool {
        self.cancel.load(Ordering::Relaxed) || self.failed.load(Ordering::Relaxed)
    }

    pub(crate) fn error(&self, line: u64, err: sqlx::Error, sql: &str) {
        // Same message format as the rest of the app (no sqlx prefix)
        let err = crate::error::AppError::from(err);
        self.error_count.fetch_add(1, Ordering::Relaxed);
        let mut errors = self.errors.lock().unwrap();
        if errors.len() < MAX_ERRORS {
            let sql: String = sql.chars().take(300).collect();
            errors.push(ImportError { line, message: err.to_string(), sql });
        }
        if !self.continue_on_error {
            self.failed.store(true, Ordering::Relaxed);
        }
    }

    fn start(&self, key: &str) {
        *self.inflight.lock().unwrap().entry(key.to_owned()).or_default() += 1;
        self.total.fetch_add(1, Ordering::SeqCst);
    }

    fn done(&self, key: &str) {
        {
            let mut map = self.inflight.lock().unwrap();
            if let Some(n) = map.get_mut(key) {
                *n -= 1;
                if *n == 0 {
                    map.remove(key);
                }
            }
        }
        self.total.fetch_sub(1, Ordering::SeqCst);
        self.changed.send_modify(|v| *v += 1);
    }

    async fn wait(&self, keys: &[String]) {
        let mut rx = self.changed.subscribe();
        let _ = rx
            .wait_for(|_| {
                let map = self.inflight.lock().unwrap();
                keys.iter().all(|k| !map.contains_key(k))
            })
            .await;
    }

    async fn wait_all(&self) {
        let mut rx = self.changed.subscribe();
        let _ = rx.wait_for(|_| self.total.load(Ordering::SeqCst) == 0).await;
    }
}


pub(crate) enum Conn {
    Pg(PoolConnection<Postgres>),
    My(PoolConnection<MySql>),
}

impl Conn {
    pub(crate) async fn exec(&mut self, sql: &str) -> Result<(), sqlx::Error> {
        let q = sqlx::raw_sql(AssertSqlSafe(sql.to_owned()));
        match self {
            Conn::Pg(c) => q.execute(&mut **c).await.map(|_| ()),
            Conn::My(c) => q.execute(&mut **c).await.map(|_| ()),
        }
    }

    /// Several INSERTs in one transaction: implicit for a Postgres multi-statement query,
    /// explicit (with ROLLBACK on error) for MySQL.
    pub(crate) async fn exec_batch(&mut self, sql: &str) -> Result<(), sqlx::Error> {
        match self {
            Conn::Pg(_) => self.exec(sql).await,
            Conn::My(_) => {
                let r = self.exec(&format!("START TRANSACTION;\n{sql};\nCOMMIT")).await;
                if r.is_err() {
                    let _ = self.exec("ROLLBACK").await;
                }
                r
            }
        }
    }

    pub(crate) async fn copy(&mut self, header: &str, data: &[u8]) -> Result<u64, sqlx::Error> {
        let Conn::Pg(c) = self else { return Err(sqlx::Error::Protocol("COPY is PostgreSQL only".into())) };
        let mut copy = c.copy_in_raw(header).await?;
        if let Err(e) = copy.send(data).await {
            let _ = copy.abort("send failed").await;
            return Err(e);
        }
        copy.finish().await
    }
}

/// Applies session statements this connection hasn't seen yet (up to `upto`).
async fn sync_session(conn: &mut Conn, shared: &Shared, applied: &mut usize, upto: usize) {
    while *applied < upto {
        let sql = shared.session.read().unwrap()[*applied].clone();
        // errors were already reported when the statement first ran
        let _ = conn.exec(&sql).await;
        *applied += 1;
    }
}


enum Job {
    Insert { table: String, stmts: Vec<(String, u64)>, rows: u64, session: usize },
    Copy { table: String, header: String, data: Vec<u8>, rows: u64, line: u64, session: usize },
    Index { table: String, sql: String, line: u64, session: usize },
}

impl Job {
    fn bytes(&self) -> u64 {
        match self {
            Job::Insert { stmts, .. } => stmts.iter().map(|(s, _)| s.len() as u64 + 2).sum(),
            Job::Copy { header, data, .. } => (header.len() + data.len()) as u64,
            Job::Index { sql, .. } => sql.len() as u64,
        }
    }
}

impl Job {
    fn key(&self) -> String {
        match self {
            Job::Insert { table, .. } | Job::Copy { table, .. } => format!("d:{table}"),
            Job::Index { table, .. } => format!("i:{table}"),
        }
    }
    fn session(&self) -> usize {
        match self {
            Job::Insert { session, .. } | Job::Copy { session, .. } | Job::Index { session, .. } => *session,
        }
    }
}

impl Shared {
    pub(crate) fn set_worker(&self, i: usize, task: Option<(&str, &str)>) {
        let mut w = self.workers.lock().unwrap();
        let v = &mut w[i];
        match task {
            Some((task, table)) => {
                v.busy = true;
                v.task = task.to_owned();
                v.table = table.to_owned();
            }
            None => {
                v.busy = false;
                v.jobs += 1;
            }
        }
    }
}

async fn worker(idx: usize, mut conn: Conn, rx: Arc<tokio::sync::Mutex<mpsc::Receiver<Job>>>, shared: Arc<Shared>) {
    let mut applied = 0;
    loop {
        let job = { rx.lock().await.recv().await };
        let Some(job) = job else { break };
        let key = job.key();
        let bytes = job.bytes();
        if !shared.stopped() {
            shared.active.fetch_add(1, Ordering::Relaxed);
            let (task, table) = match &job {
                Job::Insert { table, .. } => ("insert", table),
                Job::Copy { table, .. } => ("copy", table),
                Job::Index { table, .. } => ("index", table),
            };
            shared.set_worker(idx, Some((task, table)));
            sync_session(&mut conn, &shared, &mut applied, job.session()).await;
            run_job(&mut conn, &shared, job).await;
            shared.set_worker(idx, None);
            shared.active.fetch_sub(1, Ordering::Relaxed);
        }
        shared.raw_done.fetch_add(bytes, Ordering::Relaxed);
        shared.done(&key);
    }
}

async fn run_job(conn: &mut Conn, shared: &Shared, job: Job) {
    match job {
        Job::Insert { stmts, rows, .. } => {
            let joined = stmts.iter().map(|(s, _)| s.as_str()).collect::<Vec<_>>().join(";\n");
            match conn.exec_batch(&joined).await {
                Ok(()) => {
                    shared.statements.fetch_add(stmts.len() as u64, Ordering::Relaxed);
                    shared.rows.fetch_add(rows, Ordering::Relaxed);
                }
                Err(e) if stmts.len() == 1 => shared.error(stmts[0].1, e, &stmts[0].0),
                Err(_) => {
                    // The batch was rolled back: retry one by one to find the bad statement
                    // (and skip it if allowed)
                    for (sql, line) in &stmts {
                        if shared.stopped() {
                            break;
                        }
                        match conn.exec(sql).await {
                            Ok(()) => {
                                shared.statements.fetch_add(1, Ordering::Relaxed);
                                shared.rows.fetch_add(tuple_count(sql), Ordering::Relaxed);
                            }
                            Err(e) => shared.error(*line, e, sql),
                        }
                    }
                }
            }
        }
        Job::Copy { header, data, rows, line, .. } => match conn.copy(&header, &data).await {
            Ok(n) => {
                shared.statements.fetch_add(1, Ordering::Relaxed);
                shared.rows.fetch_add(if n > 0 { n } else { rows }, Ordering::Relaxed);
            }
            Err(e) => shared.error(line, e, &header),
        },
        Job::Index { sql, line, .. } => match conn.exec(&sql).await {
            Ok(()) => {
                shared.statements.fetch_add(1, Ordering::Relaxed);
            }
            Err(e) => shared.error(line, e, &sql),
        },
    }
}

/// Approximate row count of INSERT ... VALUES (...),(...)
fn tuple_count(sql: &str) -> u64 {
    sql.matches("),(").count() as u64 + 1
}


/// Counts bytes read from disk (compressed or not) for progress.
struct Counting<R> {
    inner: R,
    shared: Arc<Shared>,
}

impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.shared.bytes.fetch_add(n as u64, Ordering::Relaxed);
        Ok(n)
    }
}

fn open_reader(path: &str, shared: Arc<Shared>) -> std::io::Result<Box<dyn BufRead + Send>> {
    let mut file = std::fs::File::open(path)?;
    let mut magic = [0u8; 2];
    let gz = file.read(&mut magic)? == 2 && magic == [0x1f, 0x8b];
    use std::io::Seek;
    file.seek(std::io::SeekFrom::Start(0))?;
    let counted = Counting { inner: file, shared };
    Ok(if gz {
        Box::new(BufReader::with_capacity(1 << 20, flate2::read::MultiGzDecoder::new(BufReader::with_capacity(1 << 20, counted))))
    } else {
        Box::new(BufReader::with_capacity(1 << 20, counted))
    })
}

/// Reads the file on a blocking thread and sends pieces to the dispatcher.
fn read_pieces(path: String, mysql: bool, shared: Arc<Shared>, tx: mpsc::Sender<Piece>) -> std::io::Result<()> {
    let mut reader = open_reader(&path, shared.clone())?;
    let mut splitter = Splitter::new(mysql);
    let mut line = Vec::with_capacity(1 << 16);
    let mut closed = false;
    let mut send = |p: Piece| {
        if !closed && tx.blocking_send(p).is_err() {
            closed = true;
        }
    };
    loop {
        if shared.stopped() {
            return Ok(());
        }
        line.clear();
        if reader.read_until(b'\n', &mut line)? == 0 {
            break;
        }
        shared.raw_read.fetch_add(line.len() as u64, Ordering::Relaxed);
        splitter.line(&line, &mut send);
    }
    splitter.end(&mut send);
    Ok(())
}


/// Dedicated connections (workers + main) so the UI's own queries don't wait.
pub(crate) async fn open_conns(pool: &DbPool, workers: usize, fast: bool, database: Option<&str>, create_database: bool) -> AppResult<(Vec<Conn>, Vec<String>)> {
    let mut notes = Vec::new();
    let mut conns = Vec::new();
    match pool {
        DbPool::Pg(p) => {
            let opts = (*p.connect_options()).clone();
            let ip = PgPoolOptions::new().max_connections(workers as u32 + 1).acquire_timeout(Duration::from_secs(30)).connect_with(opts).await?;
            for _ in 0..=workers {
                let mut c = Conn::Pg(ip.acquire().await?);
                if fast {
                    let _ = c.exec("SET synchronous_commit = off").await;
                    if c.exec("SET session_replication_role = replica").await.is_err() && conns.is_empty() {
                        notes.push("Foreign key checks stay on: disabling them in PostgreSQL needs superuser.".to_owned());
                    }
                }
                conns.push(c);
            }
        }
        DbPool::My(p) => {
            let mut opts = (*p.connect_options()).clone();
            if let Some(db) = database.filter(|d| !d.is_empty()) {
                if create_database {
                    let q = format!("CREATE DATABASE IF NOT EXISTS `{}`", db.replace('`', "``"));
                    sqlx::raw_sql(AssertSqlSafe(q)).execute(p).await?;
                }
                opts = opts.database(db);
            }
            let ip = MySqlPoolOptions::new().max_connections(workers as u32 + 1).acquire_timeout(Duration::from_secs(30)).connect_with(opts).await?;
            for _ in 0..=workers {
                let mut c = Conn::My(ip.acquire().await?);
                if fast {
                    let _ = c.exec("SET SESSION foreign_key_checks = 0, unique_checks = 0").await;
                }
                conns.push(c);
            }
        }
    }
    Ok((conns, notes))
}

impl Shared {
    pub(crate) fn new(cancel: Arc<AtomicBool>, continue_on_error: bool, workers: usize) -> Arc<Self> {
        Arc::new(Shared {
            cancel,
            failed: AtomicBool::new(false),
            continue_on_error,
            bytes: AtomicU64::new(0),
            raw_read: AtomicU64::new(0),
            raw_done: AtomicU64::new(0),
            statements: AtomicU64::new(0),
            rows: AtomicU64::new(0),
            error_count: AtomicU64::new(0),
            errors: Mutex::new(Vec::new()),
            table: Mutex::new(String::new()),
            active: AtomicUsize::new(0),
            workers: Mutex::new(vec![WorkerView::default(); workers + 1]),
            session: RwLock::new(Vec::new()),
            inflight: Mutex::new(HashMap::new()),
            total: AtomicUsize::new(0),
            changed: watch::channel(0).0,
        })
    }

    pub(crate) fn summary(&self, started: Instant, notes: Vec<String>) -> ImportSummary {
        ImportSummary {
            statements: self.statements.load(Ordering::Relaxed),
            rows: self.rows.load(Ordering::Relaxed),
            bytes: self.bytes.load(Ordering::Relaxed),
            elapsed_ms: started.elapsed().as_millis() as u64,
            cancelled: self.cancel.load(Ordering::Relaxed),
            failed: self.failed.load(Ordering::Relaxed),
            error_count: self.error_count.load(Ordering::Relaxed),
            errors: std::mem::take(&mut *self.errors.lock().unwrap()),
            notes,
        }
    }
}


/// Progress callback (the app emits "import-progress" events).
pub type OnProgress = Arc<dyn Fn(ImportProgress) + Send + Sync>;

pub async fn run(on_progress: OnProgress, imports: &Imports, pool: &DbPool, job_id: String, o: ImportOptions) -> AppResult<ImportSummary> {
    let started = Instant::now();
    let total_bytes = std::fs::metadata(&o.path)?.len();
    let workers = o.workers.clamp(1, 16);
    let mysql = matches!(pool, DbPool::My(_));

    let (mut conns, notes) = open_conns(pool, workers, o.fast, o.database.as_deref(), o.create_database).await?;

    let cancel = Arc::new(AtomicBool::new(false));
    imports.0.lock().unwrap().insert(job_id.clone(), cancel.clone());
    let shared = Shared::new(cancel, o.continue_on_error, workers);

    let ticker = {
        let shared = shared.clone();
        let on_progress = on_progress.clone();
        let job_id = job_id.clone();
        tokio::spawn(async move {
            loop {
                on_progress(progress(&shared, &job_id, total_bytes, started));
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        })
    };

    let mut control = conns.remove(0);
    let (job_tx, job_rx) = mpsc::channel::<Job>(workers * 2);
    let job_rx = Arc::new(tokio::sync::Mutex::new(job_rx));
    let handles: Vec<_> = conns.into_iter().enumerate().map(|(i, c)| tokio::spawn(worker(i + 1, c, job_rx.clone(), shared.clone()))).collect();

    // Small buffer so reading stays close to the database (COPY pieces are up to 8 MB)
    let (piece_tx, mut piece_rx) = mpsc::channel::<Piece>(8);
    let reader = {
        let shared = shared.clone();
        let path = o.path.clone();
        tokio::task::spawn_blocking(move || read_pieces(path, mysql, shared, piece_tx))
    };

    let strip = mysql && o.strip_definer;
    let result = dispatch(&mut control, &shared, &job_tx, &mut piece_rx, strip).await;
    drop(job_tx);
    drop(piece_rx);
    shared.wait_all().await;
    for h in handles {
        let _ = h.await;
    }
    let read_result = reader.await.map_err(|e| msg(e.to_string()))?;
    ticker.abort();
    imports.0.lock().unwrap().remove(&job_id);
    on_progress(progress(&shared, &job_id, total_bytes, started));
    read_result.map_err(|e| msg(format!("Could not read the file: {e}")))?;
    result?;

    Ok(shared.summary(started, notes))
}

fn progress(shared: &Shared, job_id: &str, file_bytes: u64, started: Instant) -> ImportProgress {
    // The uncompressed size of a .gz is unknown: estimate from the ratio so far
    let read = shared.bytes.load(Ordering::Relaxed).max(1);
    let raw_read = shared.raw_read.load(Ordering::Relaxed);
    let total = if raw_read > 0 { (file_bytes as f64 * raw_read as f64 / read as f64) as u64 } else { file_bytes };
    let done = shared.raw_done.load(Ordering::Relaxed).min(total);
    ImportProgress {
        job_id: job_id.to_owned(),
        done_bytes: done,
        total_bytes: total,
        unit: "bytes",
        statements: shared.statements.load(Ordering::Relaxed),
        rows: shared.rows.load(Ordering::Relaxed),
        error_count: shared.error_count.load(Ordering::Relaxed),
        table: shared.table.lock().unwrap().clone(),
        elapsed_ms: started.elapsed().as_millis() as u64,
        active_workers: shared.active.load(Ordering::Relaxed),
        workers: shared.workers.lock().unwrap().clone(),
    }
}

/// Walks the dump in order, deciding what runs in parallel and what waits.
async fn dispatch(control: &mut Conn, shared: &Arc<Shared>, jobs: &mpsc::Sender<Job>, pieces: &mut mpsc::Receiver<Piece>, strip: bool) -> AppResult<()> {
    let mut batch: Option<(String, Vec<(String, u64)>, usize, u64)> = None; // table, statements, bytes, rows
    let mut control_applied = 0;

    async fn send(shared: &Shared, jobs: &mpsc::Sender<Job>, job: Job) {
        shared.start(&job.key());
        if let Err(e) = jobs.send(job).await {
            shared.done(&e.0.key());
        }
    }
    async fn flush(shared: &Shared, jobs: &mpsc::Sender<Job>, batch: &mut Option<(String, Vec<(String, u64)>, usize, u64)>) {
        if let Some((table, stmts, _, rows)) = batch.take() {
            let session = shared.session.read().unwrap().len();
            send(shared, jobs, Job::Insert { table, stmts, rows, session }).await;
        }
    }

    while let Some(piece) = pieces.recv().await {
        if shared.stopped() {
            break;
        }
        match piece {
            Piece::Copy { header, data, rows, line } => {
                flush(shared, jobs, &mut batch).await;
                let table = copy_table(&header);
                *shared.table.lock().unwrap() = table.clone();
                let session = shared.session.read().unwrap().len();
                send(shared, jobs, Job::Copy { table, header, data, rows, line, session }).await;
            }
            Piece::Stmt { sql, line } => match classify(&sql) {
                Kind::Data(table) => {
                    if batch.as_ref().is_some_and(|b| b.0 != table) {
                        flush(shared, jobs, &mut batch).await;
                    }
                    let b = batch.get_or_insert_with(|| {
                        *shared.table.lock().unwrap() = table.clone();
                        (table, Vec::new(), 0, 0)
                    });
                    b.2 += sql.len();
                    b.3 += tuple_count(&sql);
                    b.1.push((sql, line));
                    if b.2 >= BATCH_BYTES || b.1.len() >= BATCH_STMTS {
                        flush(shared, jobs, &mut batch).await;
                    }
                }
                Kind::Session => {
                    flush(shared, jobs, &mut batch).await;
                    run_control(control, shared, &mut control_applied, &sql, line).await;
                    shared.session.write().unwrap().push(sql);
                    control_applied += 1;
                }
                Kind::Skip => {
                    shared.raw_done.fetch_add(sql.len() as u64, Ordering::Relaxed);
                }
                Kind::TableDdl(table) => {
                    flush(shared, jobs, &mut batch).await;
                    shared.wait(&[format!("d:{table}"), format!("i:{table}")]).await;
                    run_control(control, shared, &mut control_applied, &sql, line).await;
                }
                Kind::Index(table) => {
                    flush(shared, jobs, &mut batch).await;
                    shared.wait(&[format!("d:{table}")]).await;
                    let session = shared.session.read().unwrap().len();
                    send(shared, jobs, Job::Index { table, sql, line, session }).await;
                }
                Kind::Other => {
                    flush(shared, jobs, &mut batch).await;
                    shared.wait_all().await;
                    let sql = if strip { strip_definer(&sql).unwrap_or(sql) } else { sql };
                    run_control(control, shared, &mut control_applied, &sql, line).await;
                }
            },
        }
    }
    if !shared.stopped() {
        flush(shared, jobs, &mut batch).await;
    }
    Ok(())
}

async fn run_control(control: &mut Conn, shared: &Shared, applied: &mut usize, sql: &str, line: u64) {
    if shared.stopped() {
        return;
    }
    let upto = shared.session.read().unwrap().len();
    sync_session(control, shared, applied, upto).await;
    shared.set_worker(0, Some(("sql", &statement_label(sql))));
    let r = control.exec(sql).await;
    shared.set_worker(0, None);
    shared.raw_done.fetch_add(sql.len() as u64, Ordering::Relaxed);
    match r {
        Ok(()) => {
            shared.statements.fetch_add(1, Ordering::Relaxed);
        }
        Err(e) => shared.error(line, e, sql),
    }
}

/// Short label for display, e.g. "CREATE TABLE orders".
fn statement_label(sql: &str) -> String {
    let t = crate::dump::tokens(sql, 8);
    let words: Vec<&str> = t.iter().map(|x| x.raw.as_str()).filter(|w| w.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '.' || c == '$')).take(4).collect();
    words.join(" ")
}


#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpInfo {
    pub size: u64,
    pub gzip: bool,
    /// False for images, archives and other binary files
    pub text: bool,
    /// "mysql" or "postgres" when the content gives it away
    pub dialect: Option<String>,
    /// What the file is when it isn't SQL, e.g. "PNG image"
    pub detected: Option<String>,
}

/// Sniffs the start of the file (unpacking .gz) to tell what it is.
pub fn inspect(path: &str) -> std::io::Result<DumpInfo> {
    let size = std::fs::metadata(path)?.len();
    let mut file = std::fs::File::open(path)?;
    let mut head = vec![0u8; 64 * 1024];
    let n = read_full(&mut file, &mut head)?;
    head.truncate(n);
    let gzip = head.starts_with(&[0x1f, 0x8b]);
    if gzip {
        let mut dec = flate2::read::MultiGzDecoder::new(std::fs::File::open(path)?);
        let mut buf = vec![0u8; 64 * 1024];
        let n = read_full(&mut dec, &mut buf).unwrap_or(0);
        buf.truncate(n);
        head = buf;
    }
    let detected = magic(&head).map(str::to_owned);
    let text = detected.is_none() && !head.contains(&0) && {
        let s = String::from_utf8_lossy(&head);
        let bad = s.chars().filter(|&c| c == '\u{FFFD}').count();
        // the last char may be cut at the buffer boundary
        bad <= 1 + head.len() / 1000
    };
    let dialect = text.then(|| dialect(&String::from_utf8_lossy(&head))).flatten().map(str::to_owned);
    Ok(DumpInfo { size, gzip, text, dialect, detected })
}

fn read_full(r: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..])? {
            0 => break,
            k => n += k,
        }
    }
    Ok(n)
}

fn magic(b: &[u8]) -> Option<&'static str> {
    let known: &[(&[u8], &str)] = &[
        (b"PGDMP", "pg_dump custom/directory format"),
        (b"\x89PNG", "PNG image"),
        (b"\xff\xd8\xff", "JPEG image"),
        (b"GIF8", "GIF image"),
        (b"%PDF", "PDF document"),
        (b"PK\x03\x04", "ZIP archive (or Excel/Word file)"),
        (b"7z\xbc\xaf", "7-Zip archive"),
        (b"BZh", "bzip2 archive"),
        (b"\xfd7zXZ\x00", "xz archive"),
        (b"\x28\xb5\x2f\xfd", "zstd archive"),
        (b"SQLite format 3", "SQLite database"),
    ];
    known.iter().find(|(m, _)| b.starts_with(m)).map(|(_, d)| *d)
}

fn dialect(s: &str) -> Option<&'static str> {
    let my = ["-- MySQL dump", "-- MariaDB dump", "/*!40", "/*!50", "ENGINE=", "LOCK TABLES `"].iter().filter(|p| s.contains(*p)).count();
    let pg = ["PostgreSQL database dump", "pg_catalog.", "FROM stdin;", "SET search_path", "\\restrict", "OWNER TO"].iter().filter(|p| s.contains(*p)).count();
    match (my, pg) {
        (0, 0) => None,
        (m, p) if m > p => Some("mysql"),
        (m, p) if p > m => Some("postgres"),
        _ => None,
    }
}
