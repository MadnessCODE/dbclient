//! Table Doctor: health of one table from catalog and statistics views (read-only), as metrics,
//! per-index usage and findings with an optional fix. A 0-100 score sums the findings by severity.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::db::{Cell, DbPool};
use crate::error::{msg, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Critical,
    Warning,
    Info,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableHealth {
    pub score: u8,
    pub stats: TableStats,
    pub indexes: Vec<IndexUsage>,
    pub findings: Vec<Finding>,
    /// What could not be checked, and why
    pub notes: Vec<String>,
    pub columns: Vec<ColumnInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
}

/// One table of a schema-wide scan (Database Doctor, tree badges).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableReport {
    pub table: String,
    pub rows: Option<i64>,
    /// Table, indexes and TOAST
    pub bytes: i64,
    pub findings: Vec<Finding>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaHealth {
    pub tables: Vec<TableReport>,
    pub notes: Vec<String>,
}

/// Value distribution of one column (Table Doctor's column analysis).
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnStats {
    /// "pg_stats" or "sample"
    pub source: String,
    /// No statistics yet (PostgreSQL: the table needs ANALYZE)
    pub missing: bool,
    /// Rows the numbers describe: the table estimate, or the sample size
    pub rows: Option<i64>,
    pub null_pct: Option<f64>,
    /// Distinct non-null values (PostgreSQL: planner estimate)
    pub distinct: Option<i64>,
    /// Most common values and their share of all rows, in percent
    pub common: Vec<ValueShare>,
    /// Equal-height histogram bounds (PostgreSQL)
    pub histogram: Vec<String>,
    /// Indexes whose first column this is
    pub indexes: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ValueShare {
    pub value: Option<String>,
    pub pct: f64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStats {
    /// Planner estimate
    pub rows: Option<i64>,
    /// Heap (PostgreSQL) or data_length (MySQL)
    pub table_bytes: Option<i64>,
    pub index_bytes: Option<i64>,
    pub toast_bytes: Option<i64>,
    /// Space split of `table_bytes`: live rows, dead rows, free space (PostgreSQL: estimates)
    pub live_bytes: Option<i64>,
    pub dead_bytes: Option<i64>,
    pub free_bytes: Option<i64>,
    pub live_rows: Option<i64>,
    pub dead_rows: Option<i64>,
    pub dead_pct: Option<f64>,
    /// PostgreSQL: sequential / index scans; MySQL: rows read by full scans / through indexes
    pub seq_scans: Option<i64>,
    pub index_scans: Option<i64>,
    pub seq_scan_pct: Option<f64>,
    pub analyzed_secs_ago: Option<i64>,
    pub vacuumed_secs_ago: Option<i64>,
    pub modified_since_analyze: Option<i64>,
    pub engine: Option<String>,
    /// How long index usage has been counted (since the stats reset / server start)
    pub usage_secs: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexUsage {
    pub name: String,
    pub columns: Vec<String>,
    pub bytes: Option<i64>,
    /// None when usage statistics are unavailable
    pub scans: Option<i64>,
    pub primary: bool,
    pub unique: bool,
    pub valid: bool,
    pub definition: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub id: String,
    pub severity: Severity,
    pub title: String,
    pub detail: String,
    pub evidence: Vec<Evidence>,
    pub fix: Option<Fix>,
}

#[derive(Debug, Serialize)]
pub struct Evidence {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fix {
    /// Button label, e.g. "Drop index"
    pub label: String,
    pub sql: String,
    /// Locks, duration, side effects
    pub note: Option<String>,
    /// Can take a while on a big table
    pub long: bool,
}

pub(crate) fn finding(id: impl Into<String>, severity: Severity, title: impl Into<String>, detail: impl Into<String>) -> Finding {
    Finding { id: id.into(), severity, title: title.into(), detail: detail.into(), evidence: Vec::new(), fix: None }
}

impl Finding {
    pub(crate) fn ev(mut self, label: &str, value: impl Into<String>) -> Self {
        self.evidence.push(Evidence { label: label.into(), value: value.into() });
        self
    }

    pub(crate) fn fix(mut self, label: &str, sql: String, note: Option<&str>, long: bool) -> Self {
        self.fix = Some(Fix { label: label.into(), sql, note: note.map(str::to_owned), long });
        self
    }
}

pub fn score(findings: &[Finding]) -> u8 {
    let penalty: u32 = findings
        .iter()
        .map(|f| match f.severity {
            Severity::Critical => 25,
            Severity::Warning => 10,
            Severity::Info => 2,
        })
        .sum();
    100u32.saturating_sub(penalty) as u8
}

async fn scan(pool: &DbPool, schema: &str, only: Option<&str>) -> AppResult<Scan> {
    let (mut tables, notes) = match pool {
        DbPool::Pg(_) => pg_scan(pool, schema, only).await?,
        DbPool::My(_) => my_scan(pool, schema, only).await?,
    };
    for (_, p) in &mut tables {
        p.findings.sort_by_key(|f| f.severity);
    }
    Ok((tables, notes))
}

pub async fn analyze(pool: &DbPool, schema: &str, table: &str) -> AppResult<TableHealth> {
    let (tables, mut notes) = scan(pool, schema, Some(table)).await?;
    let (_, p) = tables.into_iter().next().ok_or_else(|| msg(format!("Table {schema}.{table} not found")))?;
    notes.extend(p.notes);
    Ok(TableHealth { score: score(&p.findings), stats: p.stats, indexes: p.indexes, findings: p.findings, notes, columns: p.columns })
}

/// Every table of a schema with one batch of catalog queries.
pub async fn analyze_schema(pool: &DbPool, schema: &str) -> AppResult<SchemaHealth> {
    let (tables, notes) = scan(pool, schema, None).await?;
    let tables = tables
        .into_iter()
        .map(|(table, p)| TableReport {
            table,
            rows: p.stats.rows,
            bytes: p.stats.table_bytes.unwrap_or(0) + p.stats.index_bytes.unwrap_or(0) + p.stats.toast_bytes.unwrap_or(0),
            findings: p.findings,
        })
        .collect();
    Ok(SchemaHealth { tables, notes })
}

/// Rows read for a MySQL column sample: enough for stable shares, bounded on big tables.
const SAMPLE_ROWS: i64 = 100_000;

pub async fn column_stats(pool: &DbPool, schema: &str, table: &str, column: &str) -> AppResult<ColumnStats> {
    let mysql = matches!(pool, DbPool::My(_));
    let (s, t, c) = (lit(schema, mysql), lit(table, mysql), lit(column, mysql));
    let mut out = ColumnStats::default();
    if !mysql {
        out.source = "pg_stats".into();
        out.indexes = pool
            .text_rows(&format!(
                "select i.relname from pg_index x
                   join pg_class i on i.oid = x.indexrelid
                   join pg_class t on t.oid = x.indrelid
                   join pg_namespace n on n.oid = t.relnamespace
                   join pg_attribute a on a.attrelid = t.oid and a.attnum = x.indkey[0]
                  where n.nspname = {s} and t.relname = {t} and a.attname = {c}
                  order by 1"
            ))
            .await?
            .iter()
            .map(|r| text(&r[0]))
            .collect();
        let rows = pool
            .text_rows(&format!(
                "select c.reltuples::bigint, p.null_frac, p.n_distinct, p.most_common_vals::text, p.most_common_freqs::text, p.histogram_bounds::text
                   from pg_class c
                   join pg_namespace n on n.oid = c.relnamespace
                   left join pg_stats p on p.schemaname = n.nspname and p.tablename = c.relname and p.attname = {c} and not p.inherited
                  where n.nspname = {s} and c.relname = {t}"
            ))
            .await?;
        let r = rows.first().ok_or_else(|| msg(format!("Table {schema}.{table} not found")))?;
        let total = int(&r[0]).filter(|n| *n >= 0);
        out.rows = total;
        let Some(null_frac) = r[1].as_deref().and_then(|v| v.parse::<f64>().ok()) else {
            out.missing = true;
            return Ok(out);
        };
        out.null_pct = Some(null_frac * 100.0);
        // negative n_distinct is a fraction of the rows (grows with the table)
        let nd = r[2].as_deref().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
        out.distinct = Some(if nd >= 0.0 { nd as i64 } else { (-nd * total.unwrap_or(0) as f64 * (1.0 - null_frac)).round() as i64 });
        let vals = pg_array(&text(&r[3]));
        let freqs: Vec<f64> = pg_array(&text(&r[4])).iter().filter_map(|f| f.as_deref()?.parse().ok()).collect();
        out.common = vals.into_iter().zip(freqs).take(20).map(|(value, f)| ValueShare { value, pct: f * 100.0 }).collect();
        out.histogram = pg_array(&text(&r[5])).into_iter().map(|v| v.unwrap_or_default()).collect();
        return Ok(out);
    }

    out.source = "sample".into();
    out.indexes = pool
        .text_rows(&format!(
            "select index_name from information_schema.statistics
              where table_schema = {s} and table_name = {t} and column_name = {c} and seq_in_index = 1 order by 1"
        ))
        .await?
        .iter()
        .map(|r| text(&r[0]))
        .collect();
    let (col, from) = (qi(true, column), format!("{}.{}", qi(true, schema), qi(true, table)));
    let sample = format!("(select {col} as v from {from} limit {SAMPLE_ROWS}) s");
    let head = pool.text_rows(&format!("select count(*), count(v), count(distinct v) from {sample}")).await?;
    let head = head.first().ok_or_else(|| msg("Server returned no rows"))?;
    let n = int(&head[0]).unwrap_or(0);
    out.rows = Some(n);
    if n == 0 {
        out.missing = true;
        return Ok(out);
    }
    out.null_pct = Some((n - int(&head[1]).unwrap_or(0)) as f64 * 100.0 / n as f64);
    out.distinct = int(&head[2]);
    out.common = pool
        .text_rows(&format!("select v, count(*) from {sample} where v is not null group by v order by 2 desc limit 10"))
        .await?
        .iter()
        .map(|r| ValueShare { value: r[0].clone(), pct: int(&r[1]).unwrap_or(0) as f64 * 100.0 / n as f64 })
        .collect();
    Ok(out)
}

/// Elements of a PostgreSQL array literal ({a,"b c",NULL}).
fn pg_array(s: &str) -> Vec<Option<String>> {
    let inner = s.trim().strip_prefix('{').and_then(|s| s.strip_suffix('}')).unwrap_or("");
    let mut out = Vec::new();
    let mut chars = inner.chars().peekable();
    while chars.peek().is_some() {
        let mut item = String::new();
        let quoted = chars.peek() == Some(&'"');
        if quoted {
            chars.next();
            while let Some(ch) = chars.next() {
                match ch {
                    '\\' => item.extend(chars.next()),
                    '"' => break,
                    _ => item.push(ch),
                }
            }
            while chars.peek().is_some_and(|c| *c != ',') {
                chars.next();
            }
        } else {
            while let Some(&ch) = chars.peek() {
                if ch == ',' {
                    break;
                }
                item.push(ch);
                chars.next();
            }
        }
        chars.next(); // the comma
        out.push(if !quoted && item == "NULL" { None } else { Some(item) });
    }
    out
}

// ---------- helpers ----------

pub(crate) fn lit(s: &str, mysql: bool) -> String {
    let s = s.replace('\'', "''");
    format!("'{}'", if mysql { s.replace('\\', "\\\\") } else { s })
}

pub(crate) fn qi(mysql: bool, name: &str) -> String {
    if mysql { format!("`{}`", name.replace('`', "``")) } else { format!("\"{}\"", name.replace('"', "\"\"")) }
}

pub(crate) fn text(c: &Cell) -> String {
    c.clone().unwrap_or_default()
}

pub(crate) fn int(c: &Cell) -> Option<i64> {
    let s = c.as_deref()?.trim();
    s.parse::<i64>().ok().or_else(|| s.parse::<f64>().ok().map(|f| f as i64))
}

fn flag(c: &Cell) -> bool {
    matches!(c.as_deref(), Some("t" | "true" | "1" | "YES"))
}

fn pct(part: i64, whole: i64) -> Option<f64> {
    (whole > 0).then(|| part as f64 * 100.0 / whole as f64)
}

pub fn fmt_bytes(n: i64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut u = 0;
    while v.abs() >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 { format!("{n} B") } else { format!("{v:.1} {}", UNITS[u]) }
}

pub fn fmt_count(n: i64) -> String {
    let s = n.unsigned_abs().to_string();
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    if n < 0 { format!("-{out}") } else { out }
}

pub fn fmt_age(secs: i64) -> String {
    let (n, unit) = match secs {
        s if s < 3600 => ((s / 60).max(1), "minute"),
        s if s < 86_400 => (s / 3600, "hour"),
        s => (s / 86_400, "day"),
    };
    format!("{n} {unit}{} ago", if n == 1 { "" } else { "s" })
}

fn fmt_pct(p: f64) -> String {
    if p < 10.0 { format!("{p:.1}%") } else { format!("{p:.0}%") }
}

/// Name for a new index: <table>_<cols>_idx, cut to the identifier limit.
pub(crate) fn index_name(table: &str, cols: &[String], max: usize) -> String {
    let mut name = format!("{table}_{}_idx", cols.join("_"));
    if name.len() > max {
        let mut cut = max - 4;
        while !name.is_char_boundary(cut) {
            cut -= 1;
        }
        name.truncate(cut);
        name.push_str("_idx");
    }
    name
}

const MONEY_WORDS: [&str; 14] =
    ["price", "amount", "cost", "total", "balance", "fee", "salary", "money", "payment", "tax", "discount", "revenue", "paid", "wage"];

fn money_like(column: &str) -> bool {
    let c = column.to_lowercase();
    MONEY_WORDS.iter().any(|w| c.contains(w))
}

const DAY: i64 = 86_400;
const MB: i64 = 1024 * 1024;

/// Index columns compared for duplicates / prefix coverage.
struct IndexKey {
    name: String,
    method: String,
    /// Key columns (expressions as text), without INCLUDE columns
    cols: Vec<String>,
    /// Opclass/collation/order per key column (PostgreSQL); empty for MySQL
    ops: Vec<String>,
    predicate: String,
    has_include: bool,
    /// Primary, unique or backing a constraint: never suggested for removal
    keep: bool,
    scans: i64,
}

/// (redundant index, covering index, exact duplicate)
fn overlaps(keys: &[IndexKey]) -> Vec<(usize, usize, bool)> {
    let mut out = Vec::new();
    let mut flagged = HashSet::new();
    // exact duplicates first, then indexes whose columns lead a longer index
    for dup_pass in [true, false] {
        for (a, ka) in keys.iter().enumerate() {
            if ka.keep || ka.cols.is_empty() || flagged.contains(&a) {
                continue;
            }
            for (b, kb) in keys.iter().enumerate() {
                if a == b || ka.method != kb.method || ka.predicate != kb.predicate || flagged.contains(&b) {
                    continue;
                }
                let n = ka.cols.len();
                if kb.cols.len() < n || kb.cols[..n] != ka.cols[..] || kb.ops.get(..n.min(kb.ops.len())) != ka.ops.get(..n.min(ka.ops.len())) {
                    continue;
                }
                let same = kb.cols.len() == n && ka.has_include == kb.has_include;
                if same != dup_pass {
                    continue;
                }
                if same {
                    // of two plain duplicates, report the less used one (then the later name)
                    if !kb.keep && (kb.scans, &ka.name) < (ka.scans, &kb.name) {
                        continue;
                    }
                } else if ka.has_include || !ka.method.eq_ignore_ascii_case("btree") {
                    // only a plain B-tree prefix is fully covered by a longer index
                    continue;
                }
                out.push((a, b, same));
                flagged.insert(a);
                break;
            }
        }
    }
    out
}

// ---------- PostgreSQL ----------

struct Parts {
    stats: TableStats,
    indexes: Vec<IndexUsage>,
    findings: Vec<Finding>,
    /// Notes about this table only
    notes: Vec<String>,
    columns: Vec<ColumnInfo>,
}

/// Tables of a scan, and notes that apply to all of them.
type Scan = (Vec<(String, Parts)>, Vec<String>);

fn rows_of<'a>(m: &HashMap<String, Vec<&'a [Cell]>>, key: &str) -> Vec<&'a [Cell]> {
    m.get(key).cloned().unwrap_or_default()
}

/// Rows grouped by their first column, which is dropped.
fn by_first(rows: &[Vec<Cell>]) -> HashMap<String, Vec<&[Cell]>> {
    let mut m: HashMap<String, Vec<&[Cell]>> = HashMap::new();
    for r in rows {
        m.entry(text(&r[0])).or_default().push(&r[1..]);
    }
    m
}

fn int2vec(c: &Cell) -> Vec<i64> {
    text(c).trim_matches(|ch| ch == '{' || ch == '}').split([' ', ',']).filter_map(|s| s.parse().ok()).collect()
}

/// Findings for one table of a PostgreSQL scan: its row of the table query and its index,
/// foreign key and column rows (without the leading oid).
fn pg_table(schema: &str, r: &[Cell], idx_rows: &[&[Cell]], fk_rows: &[&[Cell]], col_rows: &[&[Cell]], usage_secs: Option<i64>, block: i64) -> Parts {
    let table = text(&r[1]);
    let table = table.as_str();
    let partitioned = text(&r[2]) == "p";
    let reltuples = int(&r[3]).unwrap_or(-1);
    let heap = int(&r[4]).unwrap_or(0);
    let live = int(&r[7]);
    let dead = int(&r[8]);
    let seq = int(&r[9]);
    let seq_read = int(&r[10]).unwrap_or(0);
    let idx = int(&r[11]);
    let modified = int(&r[12]);
    let vacuumed = int(&r[13]);
    let analyzed = int(&r[14]);
    let reloptions = text(&r[15]);
    let width = int(&r[16]);

    let rows_est = if reltuples >= 0 { reltuples } else { live.unwrap_or(0) };
    let total_tup = live.unwrap_or(0) + dead.unwrap_or(0);
    let dead_pct = dead.and_then(|d| pct(d, total_tup));
    let scans_total = seq.unwrap_or(0) + idx.unwrap_or(0);
    let seq_pct = seq.and_then(|q| pct(q, scans_total));

    // space split: tuple size from pg_stats widths + header and line pointer (estimate)
    let (live_b, dead_b, free_b) = match width {
        Some(w) if heap > 0 && total_tup > 0 => {
            let tup = w + 28;
            // page headers are never free space
            let usable = heap - heap / block * 24;
            let l = (live.unwrap_or(0) * tup).min(usable);
            let d = (dead.unwrap_or(0) * tup).min(usable - l);
            (Some(l), Some(d), Some((usable - l - d).max(0)))
        }
        _ => (None, None, None),
    };

    let mut stats = TableStats {
        rows: Some(rows_est),
        table_bytes: Some(heap),
        index_bytes: int(&r[6]),
        toast_bytes: int(&r[5]),
        live_bytes: live_b,
        dead_bytes: dead_b,
        free_bytes: free_b,
        live_rows: live,
        dead_rows: dead,
        dead_pct,
        seq_scans: seq,
        index_scans: idx,
        seq_scan_pct: seq_pct,
        analyzed_secs_ago: analyzed,
        vacuumed_secs_ago: vacuumed,
        modified_since_analyze: modified,
        engine: None,
        usage_secs,
    };
    if partitioned {
        stats.table_bytes = None;
    }

    let mut notes = Vec::new();
    let mut findings = Vec::new();
    let full = format!("{}.{}", qi(false, schema), qi(false, table));
    let conc = if partitioned { "" } else { " CONCURRENTLY" };
    if partitioned {
        notes.push("Partitioned table: sizes, row counts and vacuum statistics are kept per partition, so they are not shown here.".into());
    }


    let mut indexes = Vec::new();
    let mut keys = Vec::new();
    // per index: key column numbers if it can support a foreign key (valid, not partial)
    let mut fk_support: Vec<Vec<i64>> = Vec::new();
    for r in idx_rows {
        let name = text(&r[0]);
        let primary = flag(&r[1]);
        let unique = flag(&r[2]);
        let valid = flag(&r[3]);
        let n = int(&r[8]).unwrap_or(0) as usize;
        let natts = int(&r[9]).unwrap_or(0) as usize;
        let predicate = text(&r[10]);
        let cols: Vec<String> = text(&r[13]).split('\u{1f}').filter(|c| !c.is_empty()).map(str::to_owned).collect();
        let attnums = int2vec(&r[7]);
        let scans = int(&r[5]);
        fk_support.push(if valid && predicate.is_empty() { attnums.iter().take(n).copied().collect() } else { Vec::new() });
        let ops: Vec<String> = {
            let cls: Vec<String> = text(&r[14]).split(' ').map(str::to_owned).collect();
            let opt = int2vec(&r[15]);
            let coll = int2vec(&r[16]);
            (0..n)
                .map(|i| format!("{}/{}/{}", cls.get(i).map_or("", |c| c.as_str()), opt.get(i).unwrap_or(&0), coll.get(i).unwrap_or(&0)))
                .collect()
        };
        keys.push(IndexKey {
            name: name.clone(),
            method: text(&r[11]),
            cols: cols.clone(),
            ops,
            predicate,
            has_include: natts > n,
            keep: primary || unique || flag(&r[12]),
            scans: scans.unwrap_or(0),
        });
        indexes.push(IndexUsage { name, columns: cols, bytes: int(&r[4]), scans, primary, unique, valid, definition: text(&r[6]) });
    }

    let usage_note = match usage_secs {
        Some(s) => format!("Usage has been counted for {} (since the statistics reset).", fmt_age(s).trim_end_matches(" ago")),
        None => "Usage is counted since the statistics were last reset.".into(),
    };
    let young_stats = usage_secs.is_some_and(|s| s < 7 * DAY);
    // foreign keys: an index whose leading columns are the FK columns supports it
    let fk_sets: Vec<HashSet<i64>> = fk_rows.iter().map(|r| int2vec(&r[1]).into_iter().collect()).collect();
    let supports = |ix: &Vec<i64>, fk: &HashSet<i64>| ix.len() >= fk.len() && ix[..fk.len()].iter().copied().collect::<HashSet<_>>() == *fk;
    // never suggested for removal: deletes in the referenced table need them even if rarely
    let fk_backing: HashSet<usize> = (0..indexes.len()).filter(|&i| fk_sets.iter().any(|fk| supports(&fk_support[i], fk))).collect();
    let over = overlaps(&keys);
    // neither the redundant index nor the one covering it counts as unused
    let covered: HashSet<usize> = over.iter().flat_map(|o| [o.0, o.1]).collect();

    for (i, ix) in indexes.iter().enumerate() {
        let qname = format!("{}.{}", qi(false, schema), qi(false, &ix.name));
        if !ix.valid {
            findings.push(
                finding(format!("invalid-index:{}", ix.name), Severity::Warning, format!("Invalid index {}", ix.name),
                    "This index is marked invalid, usually left behind by a failed CREATE INDEX CONCURRENTLY. Queries never use it, but every write still updates it.")
                    .ev("Size", fmt_bytes(ix.bytes.unwrap_or(0)))
                    .fix("Drop index", format!("DROP INDEX{conc} {qname};"), Some("Recreate it afterwards if it is still needed."), false),
            );
            continue;
        }
        if ix.scans == Some(0) && !keys[i].keep && !covered.contains(&i) && !fk_backing.contains(&i) {
            let bytes = ix.bytes.unwrap_or(0);
            let sev = if young_stats || bytes < MB { Severity::Info } else { Severity::Warning };
            findings.push(
                finding(format!("unused-index:{}", ix.name), sev, format!("Unused index {}", ix.name),
                    format!("No query has used this index, but every INSERT, UPDATE and DELETE still has to maintain it. {usage_note} Scans on read replicas are not counted here — check them before dropping."))
                    .ev("Index scans", "0")
                    .ev("Size", fmt_bytes(bytes))
                    .ev("Columns", ix.columns.join(", "))
                    .fix("Drop index", format!("DROP INDEX{conc} {qname};"), Some("Runs without blocking writes. Keep the definition in case it is needed again."), false),
            );
        }
    }

    for &(a, b, same) in &over {
        let (ia, ib) = (&indexes[a], &indexes[b]);
        let qname = format!("{}.{}", qi(false, schema), qi(false, &ia.name));
        let f = if same {
            finding(format!("duplicate-index:{}", ia.name), Severity::Warning, format!("Duplicate index {}", ia.name),
                format!("{} indexes exactly the same columns as {}. One of them is enough; the other only slows down writes and takes space.", ia.name, ib.name))
        } else {
            finding(format!("redundant-index:{}", ia.name), Severity::Warning, format!("Redundant index {}", ia.name),
                format!("The columns of {} are the leading columns of {}, which can serve the same queries.", ia.name, ib.name))
        };
        findings.push(
            f.ev("Index", format!("{} ({})", ia.name, ia.columns.join(", ")))
                .ev("Covered by", format!("{} ({})", ib.name, ib.columns.join(", ")))
                .ev("Size", fmt_bytes(ia.bytes.unwrap_or(0)))
                .fix("Drop index", format!("DROP INDEX{conc} {qname};"), Some("Runs without blocking writes."), false),
        );
    }

    if !indexes.iter().any(|i| i.primary) {
        let uniq = indexes.iter().find(|i| i.unique && i.valid).map(|i| i.name.clone());
        let mut f = finding("no-primary-key", Severity::Warning, "No primary key",
            "Rows can't be identified reliably: logical replication can't send UPDATE/DELETE for this table, duplicates are possible and many tools (including the grid editor) can't edit rows safely.")
            .ev("Rows", fmt_count(rows_est));
        if let Some(u) = uniq {
            f = f.ev("Unique index", u);
        }
        findings.push(f);
    }

    for (r, fk) in fk_rows.iter().zip(&fk_sets) {
        if fk_support.iter().any(|ix| supports(ix, fk)) {
            continue;
        }
        let cols: Vec<String> = text(&r[3]).split('\u{1f}').map(str::to_owned).collect();
        let name = index_name(table, &cols, 63);
        let col_sql = cols.iter().map(|c| qi(false, c)).collect::<Vec<_>>().join(", ");
        let sev = if rows_est >= 10_000 { Severity::Warning } else { Severity::Info };
        findings.push(
            finding(format!("fk-no-index:{}", text(&r[0])), sev, format!("Foreign key {} has no index", text(&r[0])),
                format!("Deleting or updating a row in {} makes PostgreSQL look for referencing rows here with a full table scan, and joins on ({}) can't use an index.", text(&r[2]), cols.join(", ")))
                .ev("Columns", cols.join(", "))
                .ev("References", text(&r[2]))
                .ev("Rows", fmt_count(rows_est))
                .fix("Create index", format!("CREATE INDEX{conc} {} ON {full} ({col_sql});", qi(false, &name)), Some(if partitioned { "Blocks writes to the table while the index is built." } else { "Builds without blocking writes; takes longer than a plain CREATE INDEX. If it fails it leaves an invalid index to drop." }), true),
        );
    }

    // dead rows
    if let (Some(d), Some(p)) = (dead, dead_pct)
        && !partitioned
    {
        let sev = if p >= 20.0 && d >= 10_000 {
            Some(Severity::Critical)
        } else if p >= 10.0 && d >= 1_000 {
            Some(Severity::Warning)
        } else {
            None
        };
        if let Some(sev) = sev {
            findings.push(
                finding("dead-rows", sev, format!("{} of rows are dead", fmt_pct(p)),
                    "Updated and deleted rows stay in the table until VACUUM cleans them up. Scans read them anyway, so the table is slower and bigger than it needs to be.")
                    .ev("Dead rows", fmt_count(d))
                    .ev("Live rows", fmt_count(live.unwrap_or(0)))
                    .ev("Last vacuum", vacuumed.map(fmt_age).unwrap_or_else(|| "never".into()))
                    .fix("Vacuum", format!("VACUUM (ANALYZE) {full};"), Some("Doesn't block reads or writes; can take a while on a big table."), true),
            );
        }
    }

    // big tables with default autovacuum thresholds (20% of the table) vacuum too rarely
    if !partitioned && rows_est >= 1_000_000 && !reloptions.contains("autovacuum_vacuum_scale_factor") {
        let lagging = dead_pct.is_some_and(|p| p >= 5.0);
        findings.push(
            finding("autovacuum-thresholds", if lagging { Severity::Warning } else { Severity::Info }, "Autovacuum waits too long on this table",
                format!("With the default settings autovacuum starts only after about 20% of the rows ({}) have changed. Lower per-table thresholds keep dead rows and stale statistics in check.", fmt_count(rows_est / 5)))
                .ev("Rows", fmt_count(rows_est))
                .ev("Dead rows", dead_pct.map(fmt_pct).unwrap_or_else(|| "n/a".into()))
                .fix("Tune autovacuum", format!("ALTER TABLE {full} SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);"), Some("Only changes table settings; takes a brief lock."), false),
        );
    }

    // free space (bloat), from the estimate above
    if let (Some(f), false) = (free_b, partitioned)
        && heap >= 64 * MB
        && f * 100 / heap >= 40
    {
        findings.push(
            finding("bloat", Severity::Warning, format!("About {} of the table is empty space", fmt_pct(f as f64 * 100.0 / heap as f64)),
                "The table file is much bigger than its rows need (estimated from column statistics). Plain VACUUM makes the space reusable but doesn't shrink the file; VACUUM FULL rewrites the table compactly.")
                .ev("Table size", fmt_bytes(heap))
                .ev("Estimated free", fmt_bytes(f))
                .fix("Rewrite table", format!("VACUUM (FULL, ANALYZE) {full};"), Some("Locks the table completely (no reads or writes) until done and needs free disk space for a full copy. Consider pg_repack on busy tables."), true),
        );
    }

    // sequential scans on a large table
    if let (Some(q), Some(p)) = (seq, seq_pct)
        && rows_est >= 10_000
        && q >= 100
        && p >= 50.0
    {
        let avg = seq_read / q.max(1);
        findings.push(
            finding("seq-scans", if p >= 90.0 && rows_est >= 100_000 { Severity::Critical } else { Severity::Warning }, format!("{} of scans read the whole table", fmt_pct(p)),
                "Most queries on this table read every row instead of using an index. Look for frequent queries filtering or joining on columns without an index.")
                .ev("Sequential scans", fmt_count(q))
                .ev("Index scans", fmt_count(idx.unwrap_or(0)))
                .ev("Rows read per scan", fmt_count(avg)),
        );
    }

    // planner statistics
    if !partitioned {
        let mods = modified.unwrap_or(0);
        if analyzed.is_none() && rows_est > 0 {
            findings.push(
                finding("never-analyzed", Severity::Warning, "Table has never been analyzed",
                    "The query planner has no statistics for this table and has to guess row counts, which leads to bad plans.")
                    .ev("Rows", fmt_count(rows_est))
                    .fix("Analyze", format!("ANALYZE {full};"), Some("Reads a sample of the table; doesn't block reads or writes."), true),
            );
        } else if rows_est > 0 && mods >= 1_000 && mods * 100 / rows_est.max(1) >= 20 {
            findings.push(
                finding("stale-stats", Severity::Warning, "Planner statistics are out of date",
                    "Many rows changed since the last ANALYZE, so the planner works with old numbers.")
                    .ev("Changed since analyze", fmt_count(mods))
                    .ev("Rows", fmt_count(rows_est))
                    .ev("Last analyze", analyzed.map(fmt_age).unwrap_or_else(|| "never".into()))
                    .fix("Analyze", format!("ANALYZE {full};"), Some("Reads a sample of the table; doesn't block reads or writes."), true),
            );
        }
    }

    // float columns that look like money
    let floats = col_rows.iter().filter(|r| matches!(text(&r[1]).as_str(), "real" | "double precision"));
    for r in floats.filter(|r| money_like(&text(&r[0]))) {
        let c = text(&r[0]);
        findings.push(
            finding(format!("float-money:{c}"), Severity::Info, format!("{c} stores money as a float"),
                "Floating point can't represent most decimal fractions exactly (0.1 + 0.2 ≠ 0.3), so sums and comparisons of amounts drift. numeric keeps exact decimals.")
                .ev("Column", format!("{c} {}", text(&r[1])))
                .fix("Change type", format!("ALTER TABLE {full} ALTER COLUMN {} TYPE numeric(18, 4);", qi(false, &c)), Some("Rewrites the whole table and locks it (no reads or writes) until done. Check the precision first."), true),
        );
    }

    let columns = col_rows.iter().map(|r| ColumnInfo { name: text(&r[0]), data_type: text(&r[1]) }).collect();
    Parts { stats, indexes, findings, notes, columns }
}

async fn pg_scan(pool: &DbPool, schema: &str, only: Option<&str>) -> AppResult<Scan> {
    let s = lit(schema, false);
    // one table (views of it too), or every table of the schema
    let (filter, kinds) = match only {
        Some(t) => (format!(" and c.relname = {}", lit(t, false)), "'r', 'p', 'm'"),
        None => (String::new(), "'r', 'p'"),
    };
    let rels = format!("select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = {s}{filter} and c.relkind in ({kinds})");
    let g = pool
        .text_rows(
            "select current_setting('server_version_num')::int, current_setting('block_size')::int,
                    (select extract(epoch from now() - stats_reset)::bigint from pg_stat_database where datname = current_database())",
        )
        .await?;
    let g = g.first().ok_or_else(|| msg("Server returned no rows"))?;
    let nkey = if int(&g[0]).unwrap_or(0) >= 110000 { "x.indnkeyatts" } else { "x.indnatts" };
    let block = int(&g[1]).unwrap_or(8192);
    let usage_secs = int(&g[2]);

    let tables = pool
        .text_rows(&format!(
            "select c.oid, c.relname, c.relkind, c.reltuples::bigint, pg_relation_size(c.oid), pg_table_size(c.oid) - pg_relation_size(c.oid),
                    pg_indexes_size(c.oid), s.n_live_tup, s.n_dead_tup, s.seq_scan, s.seq_tup_read, s.idx_scan, s.n_mod_since_analyze,
                    extract(epoch from now() - greatest(s.last_vacuum, s.last_autovacuum))::bigint,
                    extract(epoch from now() - greatest(s.last_analyze, s.last_autoanalyze))::bigint,
                    coalesce(array_to_string(c.reloptions, ','), ''), w.width
               from pg_class c
               left join pg_stat_user_tables s on s.relid = c.oid
               left join (select tablename, sum(avg_width)::bigint as width from pg_stats where schemaname = {s} group by tablename) w
                      on w.tablename = c.relname
              where c.oid in ({rels})
              order by c.relname"
        ))
        .await?;
    let idx_rows = pool
        .text_rows(&format!(
            "select x.indrelid, i.relname, x.indisprimary, x.indisunique, x.indisvalid, pg_relation_size(i.oid), s.idx_scan,
                    pg_get_indexdef(x.indexrelid), x.indkey::text, {nkey}, x.indnatts, coalesce(pg_get_expr(x.indpred, x.indrelid), ''),
                    am.amname,
                    exists (select 1 from pg_constraint k where k.conindid = x.indexrelid and k.conrelid = x.indrelid and k.contype in ('p', 'u', 'x')),
                    array_to_string(array(select pg_get_indexdef(x.indexrelid, g, true) from generate_series(1, {nkey}) g order by g), chr(31)),
                    x.indclass::text, x.indoption::text, x.indcollation::text
               from pg_index x
               join pg_class i on i.oid = x.indexrelid
               join pg_am am on am.oid = i.relam
               left join pg_stat_user_indexes s on s.indexrelid = x.indexrelid
              where x.indrelid in ({rels})
              order by i.relname"
        ))
        .await?;
    let fk_rows = pool
        .text_rows(&format!(
            "select k.conrelid, k.conname, k.conkey::text, k.confrelid::regclass::text,
                    array_to_string(array(select a.attname from unnest(k.conkey) with ordinality u(n, o)
                                          join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.n order by u.o), chr(31))
               from pg_constraint k where k.contype = 'f' and k.conrelid in ({rels}) order by k.conname"
        ))
        .await?;
    let col_rows = pool
        .text_rows(&format!(
            "select a.attrelid, a.attname, format_type(a.atttypid, a.atttypmod) from pg_attribute a
              where a.attrelid in ({rels}) and a.attnum > 0 and not a.attisdropped
              order by a.attrelid, a.attnum"
        ))
        .await?;
    let (idx, fks, cols) = (by_first(&idx_rows), by_first(&fk_rows), by_first(&col_rows));
    let tables = tables
        .iter()
        .map(|r| {
            let oid = text(&r[0]);
            (text(&r[1]), pg_table(schema, r, &rows_of(&idx, &oid), &rows_of(&fks, &oid), &rows_of(&cols, &oid), usage_secs, block))
        })
        .collect();
    Ok((tables, Vec::new()))
}

// ---------- MySQL / MariaDB ----------

/// performance_schema reads of one table: (index or None for full scans, count_star, count_read)
type IndexReads = Vec<(Option<String>, i64, i64)>;

/// What a MySQL scan knows for the whole schema.
struct MyCtx {
    /// Seconds since the persistent statistics were updated, per table
    analyzed: HashMap<String, i64>,
    /// (table, index) -> bytes
    index_sizes: HashMap<(String, String), i64>,
    usage: Option<HashMap<String, IndexReads>>,
    uptime: Option<i64>,
}

/// Findings for one table of a MySQL scan: its information_schema.tables row and its index,
/// foreign key and column rows (without the leading table name).
fn my_table(schema: &str, r: &[Cell], idx_rows: &[&[Cell]], fk_rows: &[&[Cell]], col_rows: &[&[Cell]], ctx: &MyCtx) -> Parts {
    let table = text(&r[0]);
    let table = table.as_str();
    let r = &r[1..];
    let full = format!("{}.{}", qi(true, schema), qi(true, table));
    let notes = Vec::new();
    let mut findings = Vec::new();
    let engine = text(&r[0]);
    let rows_est = int(&r[1]).unwrap_or(0);
    let data = int(&r[2]).unwrap_or(0);
    let index_len = int(&r[3]).unwrap_or(0);
    let free = int(&r[4]).unwrap_or(0);
    let updated = int(&r[7]);
    let innodb = engine.eq_ignore_ascii_case("InnoDB");
    let analyzed = if innodb { ctx.analyzed.get(table).copied() } else { None };
    let uptime = ctx.uptime;
    let mut usage: Option<HashMap<String, i64>> = None;
    let (mut full_reads, mut index_reads) = (None, None);
    if let Some(rows) = ctx.usage.as_ref().map(|u| u.get(table).map(Vec::as_slice).unwrap_or_default()) {
        let mut m = HashMap::new();
        let (mut f, mut i) = (0, 0);
        for (name, star, read) in rows {
            match name {
                None => f += read,
                Some(name) => {
                    m.insert(name.clone(), *star);
                    i += read;
                }
            }
        }
        usage = Some(m);
        full_reads = Some(f);
        index_reads = Some(i);
    }

    let seq_pct = match (full_reads, index_reads) {
        (Some(f), Some(i)) => pct(f, f + i),
        _ => None,
    };
    let stats = TableStats {
        rows: Some(rows_est),
        table_bytes: Some(data + free),
        index_bytes: Some(index_len),
        toast_bytes: None,
        live_bytes: Some(data),
        dead_bytes: None,
        free_bytes: Some(free),
        live_rows: Some(rows_est),
        dead_rows: None,
        dead_pct: None,
        seq_scans: full_reads,
        index_scans: index_reads,
        seq_scan_pct: seq_pct,
        analyzed_secs_ago: analyzed,
        vacuumed_secs_ago: None,
        modified_since_analyze: None,
        engine: Some(engine.clone()),
        usage_secs: uptime,
    };

    let mut indexes: Vec<IndexUsage> = Vec::new();
    let mut keys: Vec<IndexKey> = Vec::new();
    for r in idx_rows {
        let name = text(&r[0]);
        let col = match int(&r[3]) {
            Some(n) => format!("{}({n})", text(&r[2])),
            None => text(&r[2]),
        };
        if let Some(ix) = indexes.last_mut().filter(|i| i.name == name) {
            ix.columns.push(col.clone());
            keys.last_mut().unwrap().cols.push(col);
            continue;
        }
        let primary = name == "PRIMARY";
        let unique = text(&r[1]) == "0";
        let scans = usage.as_ref().map(|u| u.get(&name).copied().unwrap_or(0));
        keys.push(IndexKey {
            name: name.clone(),
            method: text(&r[4]),
            cols: vec![col.clone()],
            ops: Vec::new(),
            predicate: String::new(),
            has_include: false,
            keep: primary || unique,
            scans: scans.unwrap_or(0),
        });
        indexes.push(IndexUsage {
            name: name.clone(),
            columns: vec![col],
            bytes: ctx.index_sizes.get(&(table.to_owned(), name.clone())).copied(),
            scans,
            primary,
            unique,
            valid: true,
            definition: String::new(),
        });
    }
    for ix in &mut indexes {
        // "name(10)" is a prefix index on name
        let col_sql = |c: &String| match c.split_once('(') {
            _ if c == "(expression)" => c.clone(),
            Some((n, len)) => format!("{}({len}", qi(true, n)),
            None => qi(true, c),
        };
        let cols = ix.columns.iter().map(col_sql).collect::<Vec<_>>().join(", ");
        ix.definition = if ix.primary {
            format!("PRIMARY KEY ({cols})")
        } else {
            format!("{}INDEX {} ({cols})", if ix.unique { "UNIQUE " } else { "" }, qi(true, &ix.name))
        };
    }

    // foreign keys: supporting index and matching column types
    let mut fks: Vec<(String, String)> = Vec::new();
    let mut fk_cols: HashMap<String, Vec<String>> = HashMap::new();
    for r in fk_rows {
        let name = text(&r[0]);
        fk_cols.entry(name.clone()).or_default().push(text(&r[1]));
        if !fks.iter().any(|(n, _)| *n == name) {
            fks.push((name, format!("{}.{}", text(&r[2]), text(&r[3]))));
        }
    }
    let supports = |k: &IndexKey, cols: &Vec<String>| k.cols.len() >= cols.len() && k.cols[..cols.len()].iter().collect::<HashSet<_>>() == cols.iter().collect();
    let fk_backing: HashSet<usize> = (0..keys.len()).filter(|&i| fk_cols.values().any(|c| supports(&keys[i], c))).collect();

    let young = uptime.is_some_and(|u| u < 7 * DAY);
    let drop_sql = |name: &str| format!("ALTER TABLE {full} DROP INDEX {};", qi(true, name));
    let over = overlaps(&keys);
    // neither the redundant index nor the one covering it counts as unused
    let covered: HashSet<usize> = over.iter().flat_map(|o| [o.0, o.1]).collect();
    if usage.is_some() {
        for (i, (ix, k)) in indexes.iter().zip(&keys).enumerate() {
            if ix.scans == Some(0) && !k.keep && !covered.contains(&i) && !fk_backing.contains(&i) {
                let since = uptime.map(|u| format!(" Usage has been counted for {} (since the server started).", fmt_age(u).trim_end_matches(" ago"))).unwrap_or_default();
                findings.push(
                    finding(format!("unused-index:{}", ix.name), if young { Severity::Info } else { Severity::Warning }, format!("Unused index {}", ix.name),
                        format!("No query has used this index, but every INSERT, UPDATE and DELETE still maintains it.{since} Replicas are not counted here — check them before dropping."))
                        .ev("Reads through index", "0")
                        .ev("Size", ix.bytes.map(fmt_bytes).unwrap_or_else(|| "unknown".into()))
                        .ev("Columns", ix.columns.join(", "))
                        .fix("Drop index", drop_sql(&ix.name), Some("Quick metadata change in InnoDB. Keep the definition in case it is needed again."), false),
                );
            }
        }
    }
    for &(a, b, same) in &over {
        let (ia, ib) = (&indexes[a], &indexes[b]);
        let f = if same {
            finding(format!("duplicate-index:{}", ia.name), Severity::Warning, format!("Duplicate index {}", ia.name),
                format!("{} indexes exactly the same columns as {}. One of them is enough; the other only slows down writes and takes space.", ia.name, ib.name))
        } else {
            finding(format!("redundant-index:{}", ia.name), Severity::Warning, format!("Redundant index {}", ia.name),
                format!("The columns of {} are the leading columns of {}, which can serve the same queries.", ia.name, ib.name))
        };
        findings.push(
            f.ev("Index", format!("{} ({})", ia.name, ia.columns.join(", ")))
                .ev("Covered by", format!("{} ({})", ib.name, ib.columns.join(", ")))
                .fix("Drop index", drop_sql(&ia.name), Some("Quick metadata change in InnoDB. A foreign key may need this index; MySQL refuses the drop then."), false),
        );
    }

    if !indexes.iter().any(|i| i.primary) {
        findings.push(
            finding("no-primary-key", Severity::Warning, "No primary key",
                "InnoDB clusters rows by a hidden row id instead, which is shared server-wide and can become a bottleneck. Row-based replication has to scan the whole table for every changed row, and rows can't be edited safely.")
                .ev("Rows", fmt_count(rows_est)),
        );
    }

    if engine.eq_ignore_ascii_case("MyISAM") {
        findings.push(
            finding("myisam", Severity::Warning, "Table uses the MyISAM engine",
                "MyISAM locks the whole table for every write, has no transactions or foreign keys and can lose data in a crash. InnoDB is the default for good reasons.")
                .ev("Engine", engine.clone())
                .ev("Size", fmt_bytes(data + index_len))
                .fix("Convert to InnoDB", format!("ALTER TABLE {full} ENGINE=InnoDB;"), Some("Rebuilds the table; writes are blocked until done."), true),
        );
    }

    for (name, target) in &fks {
        let cols = &fk_cols[name];
        if keys.iter().any(|k| supports(k, cols)) {
            continue;
        }
        let idx_name = index_name(table, cols, 64);
        let col_sql = cols.iter().map(|c| qi(true, c)).collect::<Vec<_>>().join(", ");
        findings.push(
            finding(format!("fk-no-index:{name}"), Severity::Warning, format!("Foreign key {name} has no index"),
                format!("Deleting or updating rows in {target} has to search this table without an index, and joins on ({}) can't use one.", cols.join(", ")))
                .ev("Columns", cols.join(", "))
                .ev("References", target.clone())
                .fix("Create index", format!("ALTER TABLE {full} ADD INDEX {} ({col_sql}), ALGORITHM=INPLACE, LOCK=NONE;", qi(true, &idx_name)), Some("Online index build: reads and writes continue."), true),
        );
    }
    for r in fk_rows {
        let (ctype, cset, ccoll) = (text(&r[5]), text(&r[6]), text(&r[7]));
        let (rtype, rset, rcoll) = (text(&r[8]), text(&r[9]), text(&r[10]));
        if r[8].is_none() || (ctype == rtype && cset == rset && ccoll == rcoll) {
            continue;
        }
        let col = text(&r[1]);
        let refcol = format!("{}.{}.{}", text(&r[2]), text(&r[3]), text(&r[4]));
        let side = |ty: &str, set: &str, coll: &str| if set.is_empty() { ty.to_owned() } else { format!("{ty} {set} / {coll}") };
        findings.push(
            finding(format!("fk-mismatch:{}:{col}", text(&r[0])), Severity::Warning, format!("{col} doesn't match the column it references"),
                "Joining columns with different types, character sets or collations forces a conversion on every row, so the index on the other side can't be used.")
                .ev("This column", format!("{col}: {}", side(&ctype, &cset, &ccoll)))
                .ev("References", format!("{refcol}: {}", side(&rtype, &rset, &rcoll))),
        );
    }

    // fragmentation
    let total = data + index_len + free;
    if innodb && free >= 16 * MB && free * 100 / total.max(1) >= 25 {
        let p = free as f64 * 100.0 / total as f64;
        findings.push(
            finding("fragmentation", if p >= 50.0 { Severity::Critical } else { Severity::Warning }, format!("{} of the table is free space", fmt_pct(p)),
                "Deleted and moved rows left unused pages in the tablespace. OPTIMIZE TABLE rebuilds the table compactly.")
                .ev("Free space", fmt_bytes(free))
                .ev("Data + indexes", fmt_bytes(data + index_len))
                .fix("Optimize", format!("OPTIMIZE TABLE {full};"), Some("Rebuilds the table online in InnoDB (short locks at start and end); needs free disk space for a copy."), true),
        );
    }

    // full scans
    if let (Some(f), Some(p)) = (full_reads, seq_pct)
        && rows_est >= 10_000
        && f >= 100_000
        && p >= 50.0
    {
        findings.push(
            finding("seq-scans", if p >= 90.0 && rows_est >= 100_000 { Severity::Critical } else { Severity::Warning }, format!("{} of rows are read by full table scans", fmt_pct(p)),
                "Most reads on this table go through every row instead of an index. Look for frequent queries filtering or joining on columns without an index.")
                .ev("Rows read by full scans", fmt_count(f))
                .ev("Rows read through indexes", fmt_count(index_reads.unwrap_or(0))),
        );
    }

    // statistics older than the last change
    if let Some(a) = analyzed
        && a >= 30 * DAY
        && updated.is_none_or(|u| u < a)
    {
        findings.push(
            finding("stale-stats", Severity::Info, "Index statistics are old",
                "The optimizer's statistics were last refreshed a long time ago; the data may have changed since.")
                .ev("Last analyze", fmt_age(a))
                .fix("Analyze", format!("ANALYZE TABLE {full};"), Some("Quick; reads a sample of index pages."), false),
        );
    }
    if innodb && text(&r[6]).to_lowercase().contains("stats_auto_recalc=0") {
        findings.push(
            finding("stats-auto-recalc", Severity::Info, "Automatic statistics are turned off",
                "STATS_AUTO_RECALC=0: statistics are refreshed only by a manual ANALYZE TABLE.")
                .fix("Analyze", format!("ANALYZE TABLE {full};"), Some("Quick; reads a sample of index pages."), false),
        );
    }

    let floats = col_rows.iter().filter(|r| matches!(text(&r[2]).as_str(), "float" | "double" | "real"));
    for r in floats.filter(|r| money_like(&text(&r[0]))) {
        let c = text(&r[0]);
        findings.push(
            finding(format!("float-money:{c}"), Severity::Info, format!("{c} stores money as a float"),
                "Floating point can't represent most decimal fractions exactly, so sums and comparisons of amounts drift. DECIMAL keeps exact values; change it in the structure editor.")
                .ev("Column", format!("{c} {}", text(&r[1]))),
        );
    }

    let columns = col_rows.iter().map(|r| ColumnInfo { name: text(&r[0]), data_type: text(&r[1]) }).collect();
    Parts { stats, indexes, findings, notes, columns }
}

async fn my_scan(pool: &DbPool, schema: &str, only: Option<&str>) -> AppResult<Scan> {
    let s = lit(schema, true);
    let filter = |col: &str| only.map(|t| format!(" and {col} = {}", lit(t, true))).unwrap_or_default();
    let mut notes = Vec::new();

    let version = pool.text_rows("select version()").await?.first().map(|r| text(&r[0])).unwrap_or_default();
    let mariadb = version.to_lowercase().contains("mariadb");
    // MySQL 8 caches information_schema sizes for a day by default
    let fresh = if !mariadb && !version.starts_with("5.") { "set session information_schema_stats_expiry = 0; " } else { "" };

    let tables = pool
        .text_rows(&format!(
            "{fresh}select table_name, engine, table_rows, data_length, index_length, data_free, table_collation,
                    coalesce(create_options, ''), timestampdiff(second, update_time, now()), table_type
               from information_schema.tables where table_schema = {s}{} order by table_name",
            filter("table_name")
        ))
        .await?;
    if let Some(t) = only {
        match tables.first() {
            None => return Err(msg(format!("Table {schema}.{t} not found"))),
            Some(r) if text(&r[9]) != "BASE TABLE" => return Err(msg(format!("{schema}.{t} is a view"))),
            _ => {}
        }
    }
    let tables: Vec<_> = tables.into_iter().filter(|r| text(&r[9]) == "BASE TABLE").collect();

    // persistent InnoDB statistics: needs read access to the mysql schema
    let analyzed = match pool
        .text_rows(&format!(
            "select table_name, timestampdiff(second, last_update, now()) from mysql.innodb_table_stats where database_name = {s}{}",
            filter("table_name")
        ))
        .await
    {
        Ok(rows) => rows.iter().filter_map(|r| Some((text(&r[0]), int(&r[1])?))).collect(),
        Err(_) => {
            notes.push("No access to mysql.innodb_table_stats: the age of the statistics and index sizes are unknown.".into());
            HashMap::new()
        }
    };
    let index_sizes = pool
        .text_rows(&format!(
            "select table_name, index_name, stat_value * @@innodb_page_size from mysql.innodb_index_stats
              where database_name = {s}{} and stat_name = 'size'",
            filter("table_name")
        ))
        .await
        .map(|rows| rows.iter().filter_map(|r| Some(((text(&r[0]), text(&r[1])), int(&r[2])?))).collect())
        .unwrap_or_default();

    // index usage from performance_schema (since server start)
    let ps_on = pool.text_rows("select @@performance_schema").await.ok().and_then(|r| r.first().map(|r| flag(&r[0]))).unwrap_or(false);
    let (mut usage, mut uptime) = (None, None);
    if ps_on {
        match pool
            .text_rows(&format!(
                "select object_name, index_name, count_star, count_read from performance_schema.table_io_waits_summary_by_index_usage
                  where object_schema = {s}{}",
                filter("object_name")
            ))
            .await
        {
            Ok(rows) if !rows.is_empty() => {
                let mut m: HashMap<String, IndexReads> = HashMap::new();
                for r in &rows {
                    m.entry(text(&r[0])).or_default().push((r[1].clone(), int(&r[2]).unwrap_or(0), int(&r[3]).unwrap_or(0)));
                }
                usage = Some(m);
            }
            Ok(_) => notes.push("performance_schema has no I/O statistics here yet: index usage is unknown.".into()),
            Err(_) => notes.push("No access to performance_schema: index usage is unknown.".into()),
        }
        uptime = pool
            .text_rows("select variable_value from performance_schema.global_status where variable_name = 'Uptime'")
            .await
            .ok()
            .and_then(|r| r.first().and_then(|r| int(&r[0])));
    } else {
        notes.push("performance_schema is off on this server: index usage and full-scan statistics are unknown.".into());
    }
    let ctx = MyCtx { analyzed, index_sizes, usage, uptime };

    let idx_rows = pool
        .text_rows(&format!(
            "select table_name, index_name, non_unique, coalesce(column_name, '(expression)'), sub_part, index_type
               from information_schema.statistics where table_schema = {s}{}
              order by table_name, index_name = 'PRIMARY' desc, index_name, seq_in_index",
            filter("table_name")
        ))
        .await?;
    let fk_rows = pool
        .text_rows(&format!(
            "select k.table_name, k.constraint_name, k.column_name, k.referenced_table_schema, k.referenced_table_name, k.referenced_column_name,
                    c.column_type, c.character_set_name, c.collation_name, rc.column_type, rc.character_set_name, rc.collation_name
               from information_schema.key_column_usage k
               join information_schema.columns c on c.table_schema = k.table_schema and c.table_name = k.table_name and c.column_name = k.column_name
               left join information_schema.columns rc on rc.table_schema = k.referenced_table_schema
                    and rc.table_name = k.referenced_table_name and rc.column_name = k.referenced_column_name
              where k.table_schema = {s}{} and k.referenced_table_name is not null
              order by k.table_name, k.constraint_name, k.ordinal_position",
            filter("k.table_name")
        ))
        .await?;
    let col_rows = pool
        .text_rows(&format!(
            "select table_name, column_name, column_type, data_type from information_schema.columns
              where table_schema = {s}{} order by table_name, ordinal_position",
            filter("table_name")
        ))
        .await?;
    let (idx, fks, cols) = (by_first(&idx_rows), by_first(&fk_rows), by_first(&col_rows));
    let tables = tables
        .iter()
        .map(|r| {
            let name = text(&r[0]);
            (name.clone(), my_table(schema, r, &rows_of(&idx, &name), &rows_of(&fks, &name), &rows_of(&cols, &name), &ctx))
        })
        .collect();
    Ok((tables, notes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(name: &str, cols: &[&str], keep: bool, scans: i64) -> IndexKey {
        IndexKey {
            name: name.into(),
            method: "btree".into(),
            cols: cols.iter().map(|s| s.to_string()).collect(),
            ops: Vec::new(),
            predicate: String::new(),
            has_include: false,
            keep,
            scans,
        }
    }

    #[test]
    fn duplicates_and_prefixes() {
        let keys = vec![
            key("pk", &["id"], true, 100),
            key("a", &["user_id"], false, 5),
            key("a_b", &["user_id", "created_at"], false, 10),
            key("dup1", &["email"], false, 3),
            key("dup2", &["email"], false, 9),
            key("u_email", &["email", "x"], true, 0),
        ];
        let found: Vec<(&str, &str, bool)> = overlaps(&keys).into_iter().map(|(a, b, s)| (keys[a].name.as_str(), keys[b].name.as_str(), s)).collect();
        assert!(found.contains(&("a", "a_b", false)));
        // the less used duplicate is reported, only once
        assert!(found.contains(&("dup1", "dup2", true)) || found.contains(&("dup1", "u_email", false)));
        assert!(!found.iter().any(|f| f.0 == "dup2" && f.1 == "dup1"));
        assert!(!found.iter().any(|f| f.0 == "pk" || f.0 == "u_email"));
    }

    #[test]
    fn array_literals() {
        assert_eq!(pg_array(r#"{a,"b c",NULL,"NULL","q\"x"}"#), vec![Some("a".into()), Some("b c".into()), None, Some("NULL".into()), Some("q\"x".into())]);
        assert!(pg_array("").is_empty());
        assert_eq!(pg_array("{1,2}").len(), 2);
    }

    #[test]
    fn scoring_and_format() {
        let f = vec![finding("x", Severity::Critical, "", ""), finding("y", Severity::Warning, "", "")];
        assert_eq!(score(&f), 65);
        assert_eq!(fmt_bytes(1536), "1.5 KB");
        assert_eq!(fmt_count(1234567), "1,234,567");
        assert_eq!(fmt_age(3 * DAY + 5), "3 days ago");
        assert_eq!(index_name("orders", &["customer_id".into()], 63), "orders_customer_id_idx");
        assert!(index_name(&"t".repeat(70), &["c".into()], 63).len() <= 63);
    }
}
