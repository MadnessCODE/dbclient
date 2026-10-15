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

fn finding(id: impl Into<String>, severity: Severity, title: impl Into<String>, detail: impl Into<String>) -> Finding {
    Finding { id: id.into(), severity, title: title.into(), detail: detail.into(), evidence: Vec::new(), fix: None }
}

impl Finding {
    fn ev(mut self, label: &str, value: impl Into<String>) -> Self {
        self.evidence.push(Evidence { label: label.into(), value: value.into() });
        self
    }

    fn fix(mut self, label: &str, sql: String, note: Option<&str>, long: bool) -> Self {
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

pub async fn analyze(pool: &DbPool, schema: &str, table: &str) -> AppResult<TableHealth> {
    let (stats, indexes, mut findings, notes) = match pool {
        DbPool::Pg(_) => pg(pool, schema, table).await?,
        DbPool::My(_) => my(pool, schema, table).await?,
    };
    findings.sort_by_key(|f| f.severity);
    Ok(TableHealth { score: score(&findings), stats, indexes, findings, notes })
}

// ---------- helpers ----------

fn lit(s: &str, mysql: bool) -> String {
    let s = s.replace('\'', "''");
    format!("'{}'", if mysql { s.replace('\\', "\\\\") } else { s })
}

fn qi(mysql: bool, name: &str) -> String {
    if mysql { format!("`{}`", name.replace('`', "``")) } else { format!("\"{}\"", name.replace('"', "\"\"")) }
}

fn text(c: &Cell) -> String {
    c.clone().unwrap_or_default()
}

fn int(c: &Cell) -> Option<i64> {
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
fn index_name(table: &str, cols: &[String], max: usize) -> String {
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

type Parts = (TableStats, Vec<IndexUsage>, Vec<Finding>, Vec<String>);

fn int2vec(c: &Cell) -> Vec<i64> {
    text(c).trim_matches(|ch| ch == '{' || ch == '}').split([' ', ',']).filter_map(|s| s.parse().ok()).collect()
}

async fn pg(pool: &DbPool, schema: &str, table: &str) -> AppResult<Parts> {
    let (s, t) = (lit(schema, false), lit(table, false));
    let ver = pool.text_rows("select current_setting('server_version_num')").await?;
    let ver = ver.first().and_then(|r| int(&r[0])).unwrap_or(0);
    let nkey = if ver >= 110000 { "x.indnkeyatts" } else { "x.indnatts" };

    let rows = pool
        .text_rows(&format!(
            "select c.oid, c.relkind, c.reltuples::bigint, pg_relation_size(c.oid), pg_table_size(c.oid) - pg_relation_size(c.oid),
                    pg_indexes_size(c.oid), s.n_live_tup, s.n_dead_tup, s.seq_scan, s.seq_tup_read, s.idx_scan, s.n_mod_since_analyze,
                    extract(epoch from now() - greatest(s.last_vacuum, s.last_autovacuum))::bigint,
                    extract(epoch from now() - greatest(s.last_analyze, s.last_autoanalyze))::bigint,
                    coalesce(array_to_string(c.reloptions, ','), ''),
                    (select extract(epoch from now() - stats_reset)::bigint from pg_stat_database where datname = current_database()),
                    (select sum(avg_width) from pg_stats p where p.schemaname = n.nspname and p.tablename = c.relname),
                    current_setting('block_size')::int
               from pg_class c
               join pg_namespace n on n.oid = c.relnamespace
               left join pg_stat_user_tables s on s.relid = c.oid
              where n.nspname = {s} and c.relname = {t} and c.relkind in ('r', 'p', 'm')"
        ))
        .await?;
    let r = rows.into_iter().next().ok_or_else(|| msg(format!("Table {schema}.{table} not found")))?;
    let oid = text(&r[0]);
    let relkind = text(&r[1]);
    let partitioned = relkind == "p";
    let reltuples = int(&r[2]).unwrap_or(-1);
    let heap = int(&r[3]).unwrap_or(0);
    let live = int(&r[6]);
    let dead = int(&r[7]);
    let seq = int(&r[8]);
    let seq_read = int(&r[9]).unwrap_or(0);
    let idx = int(&r[10]);
    let modified = int(&r[11]);
    let vacuumed = int(&r[12]);
    let analyzed = int(&r[13]);
    let reloptions = text(&r[14]);
    let usage_secs = int(&r[15]);
    let width = int(&r[16]);
    let block = int(&r[17]).unwrap_or(8192);

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
        index_bytes: int(&r[5]),
        toast_bytes: int(&r[4]),
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

    // indexes
    let idx_rows = pool
        .text_rows(&format!(
            "select i.relname, x.indisprimary, x.indisunique, x.indisvalid, pg_relation_size(i.oid), s.idx_scan,
                    pg_get_indexdef(x.indexrelid), x.indkey::text, {nkey}, x.indnatts, coalesce(pg_get_expr(x.indpred, x.indrelid), ''),
                    am.amname,
                    exists (select 1 from pg_constraint k where k.conindid = x.indexrelid and k.conrelid = x.indrelid and k.contype in ('p', 'u', 'x')),
                    array_to_string(array(select pg_get_indexdef(x.indexrelid, g, true) from generate_series(1, {nkey}) g order by g), chr(31)),
                    x.indclass::text, x.indoption::text, x.indcollation::text
               from pg_index x
               join pg_class i on i.oid = x.indexrelid
               join pg_am am on am.oid = i.relam
               left join pg_stat_user_indexes s on s.indexrelid = x.indexrelid
              where x.indrelid = {oid}
              order by i.relname"
        ))
        .await?;

    let mut indexes = Vec::new();
    let mut keys = Vec::new();
    // per index: key column numbers if it can support a foreign key (valid, not partial)
    let mut fk_support: Vec<Vec<i64>> = Vec::new();
    for r in &idx_rows {
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
    let fk_rows = pool
        .text_rows(&format!(
            "select k.conname, k.conkey::text, k.confrelid::regclass::text,
                    array_to_string(array(select a.attname from unnest(k.conkey) with ordinality u(n, o)
                                          join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.n order by u.o), chr(31))
               from pg_constraint k where k.contype = 'f' and k.conrelid = {oid} order by k.conname"
        ))
        .await?;
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
    let cols = pool
        .text_rows(&format!(
            "select a.attname, format_type(a.atttypid, a.atttypmod) from pg_attribute a
              where a.attrelid = {oid} and a.attnum > 0 and not a.attisdropped and a.atttypid in ('float4'::regtype, 'float8'::regtype)
              order by a.attnum"
        ))
        .await?;
    for r in cols.iter().filter(|r| money_like(&text(&r[0]))) {
        let c = text(&r[0]);
        findings.push(
            finding(format!("float-money:{c}"), Severity::Info, format!("{c} stores money as a float"),
                "Floating point can't represent most decimal fractions exactly (0.1 + 0.2 ≠ 0.3), so sums and comparisons of amounts drift. numeric keeps exact decimals.")
                .ev("Column", format!("{c} {}", text(&r[1])))
                .fix("Change type", format!("ALTER TABLE {full} ALTER COLUMN {} TYPE numeric(18, 4);", qi(false, &c)), Some("Rewrites the whole table and locks it (no reads or writes) until done. Check the precision first."), true),
        );
    }

    Ok((stats, indexes, findings, notes))
}

// ---------- MySQL / MariaDB ----------

async fn my(pool: &DbPool, schema: &str, table: &str) -> AppResult<Parts> {
    let (s, t) = (lit(schema, true), lit(table, true));
    let full = format!("{}.{}", qi(true, schema), qi(true, table));
    let mut notes = Vec::new();
    let mut findings = Vec::new();

    let version = pool.text_rows("select version()").await?.first().map(|r| text(&r[0])).unwrap_or_default();
    let mariadb = version.to_lowercase().contains("mariadb");
    // MySQL 8 caches information_schema sizes for a day by default
    let fresh = if !mariadb && !version.starts_with("5.") { "set session information_schema_stats_expiry = 0; " } else { "" };

    let rows = pool
        .text_rows(&format!(
            "{fresh}select engine, table_rows, data_length, index_length, data_free, table_collation,
                    coalesce(create_options, ''), timestampdiff(second, update_time, now()), table_type
               from information_schema.tables where table_schema = {s} and table_name = {t}"
        ))
        .await?;
    let r = rows.into_iter().next().ok_or_else(|| msg(format!("Table {schema}.{table} not found")))?;
    if text(&r[8]) != "BASE TABLE" {
        return Err(msg(format!("{schema}.{table} is a view")));
    }
    let engine = text(&r[0]);
    let rows_est = int(&r[1]).unwrap_or(0);
    let data = int(&r[2]).unwrap_or(0);
    let index_len = int(&r[3]).unwrap_or(0);
    let free = int(&r[4]).unwrap_or(0);
    let updated = int(&r[7]);
    let innodb = engine.eq_ignore_ascii_case("InnoDB");

    // persistent InnoDB statistics: needs read access to the mysql schema
    let (mut analyzed, mut index_sizes) = (None, HashMap::new());
    if innodb {
        match pool
            .text_rows(&format!(
                "select timestampdiff(second, last_update, now()) from mysql.innodb_table_stats where database_name = {s} and table_name = {t}"
            ))
            .await
        {
            Ok(rows) => analyzed = rows.first().and_then(|r| int(&r[0])),
            Err(_) => notes.push("No access to mysql.innodb_table_stats: the age of the statistics is unknown.".into()),
        }
        if let Ok(rows) = pool
            .text_rows(&format!(
                "select index_name, stat_value * @@innodb_page_size from mysql.innodb_index_stats
                  where database_name = {s} and table_name = {t} and stat_name = 'size'"
            ))
            .await
        {
            index_sizes = rows.iter().filter_map(|r| Some((text(&r[0]), int(&r[1])?))).collect();
        }
    }

    // index usage from performance_schema (since server start)
    let ps_on = pool.text_rows("select @@performance_schema").await.ok().and_then(|r| r.first().map(|r| flag(&r[0]))).unwrap_or(false);
    let mut usage: Option<HashMap<String, i64>> = None;
    let (mut full_reads, mut index_reads) = (None, None);
    let mut uptime = None;
    if ps_on {
        match pool
            .text_rows(&format!(
                "select index_name, count_star, count_read from performance_schema.table_io_waits_summary_by_index_usage
                  where object_schema = {s} and object_name = {t}"
            ))
            .await
        {
            Ok(rows) if !rows.is_empty() => {
                let mut m = HashMap::new();
                let (mut f, mut i) = (0, 0);
                for r in &rows {
                    match &r[0] {
                        None => f += int(&r[2]).unwrap_or(0),
                        Some(name) => {
                            m.insert(name.clone(), int(&r[1]).unwrap_or(0));
                            i += int(&r[2]).unwrap_or(0);
                        }
                    }
                }
                usage = Some(m);
                full_reads = Some(f);
                index_reads = Some(i);
            }
            Ok(_) => notes.push("performance_schema has no I/O statistics for this table yet: index usage is unknown.".into()),
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

    // indexes
    let idx_rows = pool
        .text_rows(&format!(
            "select index_name, non_unique, coalesce(column_name, '(expression)'), sub_part, index_type
               from information_schema.statistics where table_schema = {s} and table_name = {t}
              order by index_name = 'PRIMARY' desc, index_name, seq_in_index"
        ))
        .await?;
    let mut indexes: Vec<IndexUsage> = Vec::new();
    let mut keys: Vec<IndexKey> = Vec::new();
    for r in &idx_rows {
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
            bytes: index_sizes.get(&name).copied(),
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
    let fk_rows = pool
        .text_rows(&format!(
            "select k.constraint_name, k.column_name, k.referenced_table_schema, k.referenced_table_name, k.referenced_column_name,
                    c.column_type, c.character_set_name, c.collation_name, rc.column_type, rc.character_set_name, rc.collation_name
               from information_schema.key_column_usage k
               join information_schema.columns c on c.table_schema = k.table_schema and c.table_name = k.table_name and c.column_name = k.column_name
               left join information_schema.columns rc on rc.table_schema = k.referenced_table_schema
                    and rc.table_name = k.referenced_table_name and rc.column_name = k.referenced_column_name
              where k.table_schema = {s} and k.table_name = {t} and k.referenced_table_name is not null
              order by k.constraint_name, k.ordinal_position"
        ))
        .await?;
    let mut fks: Vec<(String, String, Vec<Cell>)> = Vec::new();
    let mut fk_cols: HashMap<String, Vec<String>> = HashMap::new();
    for r in &fk_rows {
        let name = text(&r[0]);
        fk_cols.entry(name.clone()).or_default().push(text(&r[1]));
        if !fks.iter().any(|(n, _, _)| *n == name) {
            fks.push((name, format!("{}.{}", text(&r[2]), text(&r[3])), r.clone()));
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

    for (name, target, _) in &fks {
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
    for r in &fk_rows {
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

    let cols = pool
        .text_rows(&format!(
            "select column_name, column_type from information_schema.columns
              where table_schema = {s} and table_name = {t} and data_type in ('float', 'double', 'real')
              order by ordinal_position"
        ))
        .await?;
    for r in cols.iter().filter(|r| money_like(&text(&r[0]))) {
        let c = text(&r[0]);
        findings.push(
            finding(format!("float-money:{c}"), Severity::Info, format!("{c} stores money as a float"),
                "Floating point can't represent most decimal fractions exactly, so sums and comparisons of amounts drift. DECIMAL keeps exact values; change it in the structure editor.")
                .ev("Column", format!("{c} {}", text(&r[1]))),
        );
    }

    Ok((stats, indexes, findings, notes))
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
