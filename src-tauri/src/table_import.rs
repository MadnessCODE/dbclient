//! CSV / Excel / JSON import into a table.
//!
//! A reader thread splits the file into row batches that go to several connections in parallel:
//! COPY on Postgres when there's no conflict handling, multi-row INSERTs otherwise. The preview
//! also suggests column types for a new table.

use std::io::{BufRead, BufReader, Read};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use calamine::{open_workbook_auto, Data, Reader};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::db::{Cell, DbPool};
use crate::error::{msg, AppResult};
use crate::import::{open_conns, Conn, ImportProgress, ImportSummary, Imports, OnProgress, Shared};

/// Rows per batch (one transaction / one COPY).
const BATCH_ROWS: usize = 5000;
const BATCH_BYTES: usize = 4 * 1024 * 1024;
const PREVIEW_ROWS: usize = 50;
/// Rows sampled for type guessing; reading is cheap and more rows mean fewer surprises
const SAMPLE_ROWS: usize = 100_000;
/// JSON objects scanned for column names
const JSON_KEY_ROWS: usize = 2000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceOptions {
    pub path: String,
    /// "csv", "excel" or "json"
    pub format: String,
    /// Empty = detect
    #[serde(default)]
    pub delimiter: Option<String>,
    /// Empty = detect (UTF-8, else Windows-1250)
    #[serde(default)]
    pub encoding: Option<String>,
    pub header: bool,
    #[serde(default)]
    pub sheet: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePreview {
    pub delimiter: String,
    pub encoding: String,
    pub sheets: Vec<String>,
    pub sheet: Option<String>,
    pub columns: Vec<SourceColumn>,
    pub rows: Vec<Vec<Cell>>,
    /// Known up front only for Excel
    pub total_rows: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceColumn {
    pub name: String,
    pub guess: Guess,
}

/// Column type suggested from sampled values.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Guess {
    /// int, bigint, decimal, double, bool, date, datetime, json, text
    pub kind: String,
    pub max_len: usize,
    pub precision: u32,
    pub scale: u32,
    pub nullable: bool,
}


/// Counts bytes read from disk, for progress.
struct Counting<R> {
    inner: R,
    count: Arc<AtomicU64>,
}

impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.count.fetch_add(n as u64, Ordering::Relaxed);
        Ok(n)
    }
}

fn encoding_for(name: &str) -> &'static encoding_rs::Encoding {
    match name.to_ascii_lowercase().as_str() {
        "windows-1250" | "cp1250" => encoding_rs::WINDOWS_1250,
        "windows-1252" | "cp1252" | "latin1" => encoding_rs::WINDOWS_1252,
        "windows-1251" | "cp1251" => encoding_rs::WINDOWS_1251,
        "utf-16le" => encoding_rs::UTF_16LE,
        "utf-16be" => encoding_rs::UTF_16BE,
        _ => encoding_rs::UTF_8,
    }
}

/// UTF-8 if the head is valid UTF-8, else Windows-1250 (common for Excel CSV in Central Europe).
fn detect_encoding(head: &[u8]) -> &'static str {
    if head.starts_with(&[0xff, 0xfe]) {
        return "utf-16le";
    }
    if head.starts_with(&[0xfe, 0xff]) {
        return "utf-16be";
    }
    match std::str::from_utf8(head) {
        Ok(_) => "utf-8",
        // a char cut at the end of the sample is fine
        Err(e) if e.error_len().is_none() => "utf-8",
        Err(_) => "windows-1250",
    }
}

fn head_bytes(path: &str, n: usize) -> std::io::Result<Vec<u8>> {
    let mut f = std::fs::File::open(path)?;
    let mut buf = vec![0u8; n];
    let mut got = 0;
    while got < n {
        match f.read(&mut buf[got..])? {
            0 => break,
            k => got += k,
        }
    }
    buf.truncate(got);
    Ok(buf)
}

/// The delimiter that appears most consistently in the first lines (outside quotes).
fn detect_delimiter(sample: &str) -> u8 {
    let lines: Vec<&str> = sample.lines().filter(|l| !l.trim().is_empty()).take(30).collect();
    let mut best = (b',', 0usize, 0usize); // delimiter, lines with the same count, count per line
    for d in [b',', b';', b'\t', b'|'] {
        let counts: Vec<usize> = lines
            .iter()
            .map(|l| {
                let mut q = false;
                l.bytes()
                    .filter(|&b| {
                        if b == b'"' {
                            q = !q;
                        }
                        !q && b == d
                    })
                    .count()
            })
            .collect();
        let Some(&first) = counts.first() else { continue };
        if first == 0 {
            continue;
        }
        let same = counts.iter().filter(|&&c| c == first).count();
        if (same, first) > (best.1, best.2) {
            best = (d, same, first);
        }
    }
    best.0
}

/// Text source (CSV/JSON) decoded to UTF-8.
fn text_reader(path: &str, encoding: &str, count: Arc<AtomicU64>) -> std::io::Result<Box<dyn Read + Send>> {
    let file = Counting { inner: std::fs::File::open(path)?, count };
    let dec = encoding_rs_io::DecodeReaderBytesBuilder::new()
        .encoding(Some(encoding_for(encoding)))
        .bom_sniffing(true)
        .strip_bom(true)
        .build(BufReader::with_capacity(1 << 20, file));
    Ok(Box::new(dec))
}

/// Source settings after auto-detection.
struct Resolved {
    delimiter: u8,
    encoding: String,
}

fn resolve(o: &SourceOptions) -> std::io::Result<Resolved> {
    let head = if o.format == "excel" { Vec::new() } else { head_bytes(&o.path, 256 * 1024)? };
    let encoding = match o.encoding.as_deref().filter(|e| !e.is_empty()) {
        Some(e) => e.to_owned(),
        None => detect_encoding(&head).to_owned(),
    };
    let delimiter = match o.delimiter.as_deref().filter(|d| !d.is_empty()) {
        Some("\\t") | Some("tab") => b'\t',
        Some(d) => d.as_bytes()[0],
        None => {
            let (text, _, _) = encoding_for(&encoding).decode(&head);
            detect_delimiter(&text)
        }
    };
    Ok(Resolved { delimiter, encoding })
}

/// Calls `on_header` with column names, then `f(row, row_number)` until it returns false.
fn for_each_row(
    o: &SourceOptions,
    r: &Resolved,
    count: Arc<AtomicU64>,
    json_columns: Option<&[String]>,
    mut on_header: impl FnMut(Vec<String>),
    mut f: impl FnMut(Vec<Cell>, u64) -> bool,
) -> AppResult<()> {
    match o.format.as_str() {
        "excel" => {
            let mut wb = open_workbook_auto(&o.path).map_err(|e| msg(format!("Could not open the workbook: {e}")))?;
            let names = wb.sheet_names().to_vec();
            let sheet = o.sheet.clone().filter(|s| names.contains(s)).or_else(|| names.first().cloned()).ok_or_else(|| msg("The workbook has no sheets"))?;
            let range = wb.worksheet_range(&sheet).map_err(|e| msg(format!("Could not read sheet {sheet}: {e}")))?;
            let mut rows = range.rows();
            let width = range.width();
            if o.header {
                let h = rows.next().map(|r| r.iter().map(|c| excel_cell(c).unwrap_or_default()).collect()).unwrap_or_default();
                on_header(h);
            } else {
                on_header((1..=width).map(|i| format!("column_{i}")).collect());
            }
            for (i, row) in rows.enumerate() {
                if !f(row.iter().map(excel_cell).collect(), i as u64 + 1 + o.header as u64) {
                    break;
                }
            }
        }
        "json" => {
            let reader = BufReader::with_capacity(1 << 20, text_reader(&o.path, &r.encoding, count)?);
            json_rows(reader, json_columns, &mut on_header, &mut f)?;
        }
        _ => {
            let reader = text_reader(&o.path, &r.encoding, count)?;
            let mut csv = csv::ReaderBuilder::new().delimiter(r.delimiter).has_headers(false).flexible(true).buffer_capacity(1 << 20).from_reader(reader);
            let mut rec = csv::StringRecord::new();
            let mut n = 0u64;
            let mut first = true;
            while csv.read_record(&mut rec).map_err(|e| msg(format!("CSV error: {e}")))? {
                n += 1;
                if first {
                    first = false;
                    if o.header {
                        on_header(rec.iter().map(|s| s.trim().to_owned()).collect());
                        continue;
                    }
                    on_header((1..=rec.len()).map(|i| format!("column_{i}")).collect());
                }
                if !f(rec.iter().map(|s| Some(s.to_owned())).collect(), n) {
                    break;
                }
            }
            if first {
                on_header(Vec::new());
            }
        }
    }
    Ok(())
}

/// Streams a JSON array of objects or JSON Lines.
fn json_rows(
    mut reader: BufReader<Box<dyn Read + Send>>,
    columns: Option<&[String]>,
    on_header: &mut impl FnMut(Vec<String>),
    f: &mut impl FnMut(Vec<Cell>, u64) -> bool,
) -> AppResult<()> {
    // '[' means an array, anything else JSON Lines
    let first = loop {
        let buf = reader.fill_buf()?;
        if buf.is_empty() {
            break None;
        }
        match buf.iter().position(|b| !b.is_ascii_whitespace()) {
            Some(i) => {
                let c = buf[i];
                reader.consume(i);
                break Some(c);
            }
            None => {
                let n = buf.len();
                reader.consume(n);
            }
        }
    };

    // Columns are given (import) or collected in order of appearance (preview)
    let mut cols: Vec<String> = columns.map(|c| c.to_vec()).unwrap_or_default();
    let fixed = columns.is_some();
    let mut header_sent = fixed;
    if fixed {
        on_header(cols.clone());
    }
    let mut pending: Vec<Value> = Vec::new();
    let mut n = 0u64;
    let mut stop = false;
    let mut emit = |v: Value, cols: &mut Vec<String>, pending: &mut Vec<Value>, header_sent: &mut bool| -> bool {
        n += 1;
        if !fixed {
            if let Value::Object(m) = &v {
                for k in m.keys() {
                    if !cols.contains(k) {
                        cols.push(k.clone());
                    }
                }
            }
            // preview: collect columns from the first objects before sending the header
            if !*header_sent {
                pending.push(v);
                if pending.len() < JSON_KEY_ROWS {
                    return true;
                }
                *header_sent = true;
                on_header(cols.clone());
                for (i, p) in std::mem::take(pending).into_iter().enumerate() {
                    if !f(json_row(&p, cols), i as u64 + 1) {
                        return false;
                    }
                }
                return true;
            }
        }
        f(json_row(&v, cols), n)
    };

    match first {
        Some(b'[') => {
            use serde::de::{Deserializer, SeqAccess, Visitor};
            struct Seq<'a, F: FnMut(Value) -> bool>(&'a mut F);
            impl<'de, F: FnMut(Value) -> bool> Visitor<'de> for Seq<'_, F> {
                type Value = ();
                fn expecting(&self, fm: &mut std::fmt::Formatter) -> std::fmt::Result {
                    fm.write_str("a JSON array")
                }
                fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
                    while let Some(v) = seq.next_element::<Value>()? {
                        if !(self.0)(v) {
                            // preview: stop reading the array
                            return Ok(());
                        }
                    }
                    Ok(())
                }
            }
            let mut cb = |v: Value| {
                let go = emit(v, &mut cols, &mut pending, &mut header_sent);
                stop = !go;
                go
            };
            let mut de = serde_json::Deserializer::from_reader(reader);
            let r = de.deserialize_seq(Seq(&mut cb));
            if let Err(e) = r {
                if !stop {
                    return Err(msg(format!("JSON error: {e}")));
                }
            }
        }
        Some(_) => {
            let mut line = String::new();
            let mut line_no = 0u64;
            loop {
                line.clear();
                if reader.read_line(&mut line)? == 0 {
                    break;
                }
                line_no += 1;
                let t = line.trim();
                if t.is_empty() {
                    continue;
                }
                let v: Value = serde_json::from_str(t).map_err(|e| msg(format!("JSON error on line {line_no}: {e}")))?;
                if !emit(v, &mut cols, &mut pending, &mut header_sent) {
                    break;
                }
            }
        }
        None => {}
    }
    if !header_sent {
        on_header(cols.clone());
        for (i, p) in pending.into_iter().enumerate() {
            if !f(json_row(&p, &cols), i as u64 + 1) {
                break;
            }
        }
    }
    Ok(())
}

fn bool_value(s: String) -> String {
    match s.trim().to_ascii_lowercase().as_str() {
        "true" | "t" | "yes" | "y" | "da" => "1".into(),
        "false" | "f" | "no" | "n" | "ne" => "0".into(),
        _ => s,
    }
}

fn json_row(v: &Value, cols: &[String]) -> Vec<Cell> {
    match v {
        Value::Object(m) => cols.iter().map(|c| m.get(c).and_then(json_cell)).collect(),
        Value::Array(a) => (0..cols.len().max(a.len())).map(|i| a.get(i).and_then(json_cell)).collect(),
        other => vec![json_cell(other)],
    }
}

fn json_cell(v: &Value) -> Cell {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(n.to_string()),
        other => Some(other.to_string()),
    }
}

fn excel_cell(c: &Data) -> Cell {
    match c {
        Data::Empty | Data::Error(_) => None,
        Data::String(s) => Some(s.clone()),
        Data::Int(i) => Some(i.to_string()),
        Data::Float(f) => Some(fmt_float(*f)),
        Data::Bool(b) => Some(b.to_string()),
        Data::DateTime(d) => Some(if d.is_datetime() { excel_date(d.as_f64()) } else { fmt_float(d.as_f64()) }),
        Data::DateTimeIso(s) | Data::DurationIso(s) => Some(s.clone()),
    }
}

fn fmt_float(f: f64) -> String {
    if f.fract() == 0.0 && f.abs() < 1e15 { format!("{}", f as i64) } else { format!("{f}") }
}

/// Excel serial date (days since 1899-12-30) to "YYYY-MM-DD[ HH:MM:SS]".
fn excel_date(serial: f64) -> String {
    let days = serial.floor() as i64;
    let secs = ((serial - serial.floor()) * 86400.0).round() as i64;
    let (days, secs) = if secs >= 86400 { (days + 1, 0) } else { (days, secs) };
    // days since 1970-01-01, then Hinnant's civil-from-days
    let z = days - 25569 + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + (m <= 2) as i64;
    if secs == 0 {
        format!("{y:04}-{m:02}-{d:02}")
    } else {
        format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}", secs / 3600, secs / 60 % 60, secs % 60)
    }
}


fn guess(values: &[&Cell]) -> Guess {
    let mut g = Guess { kind: String::new(), ..Default::default() };
    let mut kinds = ["bool", "int", "bigint", "decimal", "double", "date", "datetime", "json"].map(|k| (k, true));
    let mut seen = 0;
    for v in values {
        let Some(s) = v.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
            g.nullable = true;
            continue;
        };
        seen += 1;
        g.max_len = g.max_len.max(s.chars().count());
        let lower = s.to_ascii_lowercase();
        let int_like = is_int(s);
        for (k, ok) in kinds.iter_mut() {
            if !*ok {
                continue;
            }
            *ok = match *k {
                "bool" => matches!(lower.as_str(), "true" | "false" | "t" | "f" | "yes" | "no"),
                "int" => int_like && s.parse::<i32>().is_ok(),
                "bigint" => int_like && s.parse::<i64>().is_ok(),
                "decimal" => match decimal_parts(s) {
                    Some((p, sc)) => {
                        g.precision = g.precision.max(p);
                        g.scale = g.scale.max(sc);
                        true
                    }
                    None => false,
                },
                "double" => s.parse::<f64>().is_ok_and(|f| f.is_finite()) && !s.starts_with('.') && !leading_zero(s),
                "date" => is_date(s),
                "datetime" => is_datetime(s),
                "json" => (s.starts_with('{') || s.starts_with('[')) && serde_json::from_str::<Value>(s).is_ok(),
                _ => false,
            };
        }
    }
    g.kind = if seen == 0 {
        "text".into()
    } else {
        kinds.iter().find(|(_, ok)| *ok).map(|(k, _)| (*k).to_owned()).unwrap_or_else(|| "text".into())
    };
    if g.kind == "decimal" {
        // both the integer part and the scale must fit
        g.precision = (g.precision.max(g.scale + 1)).min(38);
    }
    g
}

/// Integer without leading zeros (007 stays text: zip codes, codes...).
fn is_int(s: &str) -> bool {
    let d = s.strip_prefix('-').unwrap_or(s);
    !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()) && !leading_zero(s)
}

fn leading_zero(s: &str) -> bool {
    let d = s.strip_prefix('-').unwrap_or(s);
    d.len() > 1 && d.starts_with('0') && !d.starts_with("0.")
}

/// "123.45" -> (digits, scale). A decimal comma is not accepted.
fn decimal_parts(s: &str) -> Option<(u32, u32)> {
    if leading_zero(s) {
        return None;
    }
    let d = s.strip_prefix('-').unwrap_or(s);
    let (int, frac) = d.split_once('.').unwrap_or((d, ""));
    if int.is_empty() || !int.bytes().all(|b| b.is_ascii_digit()) || !frac.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(((int.len() + frac.len()) as u32, frac.len() as u32))
}

fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10 && b[4] == b'-' && b[7] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

fn is_datetime(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 16 || !is_date(&s[..10]) || !(b[10] == b' ' || b[10] == b'T') {
        return false;
    }
    let t = &s[11..];
    let tb = t.as_bytes();
    tb.len() >= 5 && tb[2] == b':' && tb[..2].iter().all(u8::is_ascii_digit) && tb[3..5].iter().all(u8::is_ascii_digit) && t[5..].bytes().all(|c| c.is_ascii_digit() || b":.+-Z ".contains(&c))
}


pub fn preview(o: &SourceOptions) -> AppResult<SourcePreview> {
    let r = resolve(o)?;
    let mut header = Vec::new();
    let mut rows: Vec<Vec<Cell>> = Vec::new();
    for_each_row(
        o,
        &r,
        Arc::new(AtomicU64::new(0)),
        None,
        |h| header = h,
        |row, _| {
            rows.push(row);
            rows.len() < SAMPLE_ROWS
        },
    )?;

    // CSV rows may differ in length; use the longest
    let width = rows.iter().map(Vec::len).max().unwrap_or(0).max(header.len());
    let mut names = header;
    for i in names.len()..width {
        names.push(format!("column_{}", i + 1));
    }
    for (i, n) in names.iter_mut().enumerate() {
        if n.trim().is_empty() {
            *n = format!("column_{}", i + 1);
        }
    }
    let columns = names
        .into_iter()
        .enumerate()
        .map(|(i, name)| {
            let vals: Vec<&Cell> = rows.iter().map(|r| r.get(i).unwrap_or(&None)).collect();
            SourceColumn { name, guess: guess(&vals) }
        })
        .collect();

    let (sheets, sheet, total_rows) = if o.format == "excel" {
        let mut wb = open_workbook_auto(&o.path).map_err(|e| msg(format!("Could not open the workbook: {e}")))?;
        let names = wb.sheet_names().to_vec();
        let sheet = o.sheet.clone().filter(|s| names.contains(s)).or_else(|| names.first().cloned());
        let total = sheet.as_ref().and_then(|s| wb.worksheet_range(s).ok()).map(|r| r.height() as u64 - o.header as u64);
        (names, sheet, total)
    } else {
        (Vec::new(), None, None)
    };

    rows.truncate(PREVIEW_ROWS);
    let delimiter = match r.delimiter {
        b'\t' => "\\t".to_owned(),
        d => (d as char).to_string(),
    };
    Ok(SourcePreview { delimiter, encoding: r.encoding, sheets, sheet, columns, rows, total_rows })
}


#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMap {
    /// Source column index
    pub source: usize,
    pub target: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableImportOptions {
    pub source: SourceOptions,
    /// Column names from the preview (define value order for JSON)
    pub source_columns: Vec<String>,
    pub schema: Option<String>,
    pub table: String,
    pub mapping: Vec<ColumnMap>,
    /// Run first, in order (CREATE TABLE, TRUNCATE...)
    #[serde(default)]
    pub before: Vec<String>,
    /// "error", "skip" or "update"
    pub on_conflict: String,
    #[serde(default)]
    pub key_columns: Vec<String>,
    pub empty_as_null: bool,
    /// Boolean target columns: true/yes/t -> 1, false/no/f -> 0 (MySQL rejects 'true' for TINYINT)
    #[serde(default)]
    pub bool_columns: Vec<String>,
    pub workers: usize,
    pub continue_on_error: bool,
    pub database: Option<String>,
}

struct Batch {
    rows: Vec<Vec<Cell>>,
    first_row: u64,
    /// Progress this batch represents (file bytes, or rows for Excel)
    weight: u64,
}

struct Target {
    mysql: bool,
    label: String,
    insert_prefix: String,
    insert_suffix: String,
    copy_header: Option<String>,
}

fn qi(mysql: bool, name: &str) -> String {
    if mysql { format!("`{}`", name.replace('`', "``")) } else { format!("\"{}\"", name.replace('"', "\"\"")) }
}

fn literal(mysql: bool, v: &Cell) -> String {
    match v {
        None => "NULL".into(),
        Some(s) if mysql => format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''")),
        Some(s) => format!("'{}'", s.replace('\'', "''")),
    }
}

impl Target {
    fn new(mysql: bool, o: &TableImportOptions) -> Self {
        let table = match o.schema.as_deref().filter(|s| !s.is_empty()) {
            Some(s) => format!("{}.{}", qi(mysql, s), qi(mysql, &o.table)),
            None => qi(mysql, &o.table),
        };
        let columns: Vec<String> = o.mapping.iter().map(|m| m.target.clone()).collect();
        let col_list = columns.iter().map(|c| qi(mysql, c)).collect::<Vec<_>>().join(", ");
        let rest: Vec<&String> = columns.iter().filter(|c| !o.key_columns.contains(c)).collect();
        let (verb, suffix) = match (o.on_conflict.as_str(), mysql) {
            ("skip", true) => ("INSERT IGNORE", String::new()),
            ("update", true) if !rest.is_empty() => (
                "INSERT",
                format!(" ON DUPLICATE KEY UPDATE {}", rest.iter().map(|c| format!("{0} = VALUES({0})", qi(true, c))).collect::<Vec<_>>().join(", ")),
            ),
            ("update", true) => ("INSERT IGNORE", String::new()),
            ("skip", false) => ("INSERT", " ON CONFLICT DO NOTHING".into()),
            ("update", false) if !rest.is_empty() && !o.key_columns.is_empty() => (
                "INSERT",
                format!(
                    " ON CONFLICT ({}) DO UPDATE SET {}",
                    o.key_columns.iter().map(|c| qi(false, c)).collect::<Vec<_>>().join(", "),
                    rest.iter().map(|c| format!("{0} = EXCLUDED.{0}", qi(false, c))).collect::<Vec<_>>().join(", ")
                ),
            ),
            ("update", false) => ("INSERT", " ON CONFLICT DO NOTHING".into()),
            _ => ("INSERT", String::new()),
        };
        let copy_header = (!mysql && o.on_conflict == "error").then(|| format!("COPY {table} ({col_list}) FROM STDIN WITH (FORMAT csv)"));
        Target {
            mysql,
            label: o.table.clone(),
            insert_prefix: format!("{verb} INTO {table} ({col_list}) VALUES "),
            insert_suffix: suffix,
            copy_header,
        }
    }

    fn insert_sql(&self, rows: &[Vec<Cell>]) -> String {
        let mut s = String::with_capacity(self.insert_prefix.len() + rows.len() * 64);
        s.push_str(&self.insert_prefix);
        for (i, r) in rows.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            s.push('(');
            for (j, v) in r.iter().enumerate() {
                if j > 0 {
                    s.push(',');
                }
                s.push_str(&literal(self.mysql, v));
            }
            s.push(')');
        }
        s.push_str(&self.insert_suffix);
        s
    }
}

/// Rows as CSV for COPY: NULL is an unquoted empty field, "" an empty string.
fn copy_csv(rows: &[Vec<Cell>]) -> Vec<u8> {
    let mut out = Vec::with_capacity(rows.len() * 64);
    for r in rows {
        for (j, v) in r.iter().enumerate() {
            if j > 0 {
                out.push(b',');
            }
            if let Some(s) = v {
                out.push(b'"');
                for b in s.bytes() {
                    if b == b'"' {
                        out.push(b'"');
                    }
                    out.push(b);
                }
                out.push(b'"');
            }
        }
        out.push(b'\n');
    }
    out
}

async fn write_batch(conn: &mut Conn, shared: &Shared, t: &Target, b: &Batch) {
    let ok = match &t.copy_header {
        Some(h) => conn.copy(h, &copy_csv(&b.rows)).await.map(|_| ()),
        None => {
            let sql = t.insert_sql(&b.rows);
            if t.mysql { conn.exec_batch(&sql).await } else { conn.exec(&sql).await }
        }
    };
    match ok {
        Ok(()) => {
            shared.statements.fetch_add(1, Ordering::Relaxed);
            shared.rows.fetch_add(b.rows.len() as u64, Ordering::Relaxed);
        }
        Err(e) if b.rows.len() == 1 => shared.error(b.first_row, e, &t.insert_sql(&b.rows)),
        Err(_) => {
            // The batch was rolled back: retry row by row to find the bad one
            for (i, row) in b.rows.iter().enumerate() {
                if shared.stopped() {
                    break;
                }
                let sql = t.insert_sql(std::slice::from_ref(row));
                match conn.exec(&sql).await {
                    Ok(()) => {
                        shared.rows.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(e) => shared.error(b.first_row + i as u64, e, &sql),
                }
            }
            shared.statements.fetch_add(1, Ordering::Relaxed);
        }
    }
}

pub async fn run(on_progress: OnProgress, imports: &Imports, pool: &DbPool, job_id: String, o: TableImportOptions) -> AppResult<ImportSummary> {
    let started = Instant::now();
    let workers = o.workers.clamp(1, 16);
    let mysql = matches!(pool, DbPool::My(_));
    if o.mapping.is_empty() {
        return Err(msg("Choose at least one column to import"));
    }
    let (mut conns, mut notes) = open_conns(pool, workers, false, o.database.as_deref(), false).await?;
    match o.on_conflict.as_str() {
        "skip" => notes.push("Rows whose key already existed were skipped; the row count includes them.".to_owned()),
        "update" => notes.push("Rows whose key already existed were updated with values from the file.".to_owned()),
        _ => {}
    }
    let mut control = conns.remove(0);

    // CREATE TABLE / TRUNCATE first; a failure here aborts the import
    for sql in &o.before {
        control.exec(sql).await.map_err(|e| msg(format!("{}\n\n{sql}", crate::error::AppError::from(e))))?;
    }

    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    imports.0.lock().unwrap().insert(job_id.clone(), cancel.clone());
    let shared = Shared::new(cancel, o.continue_on_error, workers);
    let target = Arc::new(Target::new(mysql, &o));
    *shared.table.lock().unwrap() = target.label.clone();

    let excel = o.source.format == "excel";
    let file_bytes = std::fs::metadata(&o.source.path)?.len();
    let total_rows = if excel { preview(&o.source).ok().and_then(|p| p.total_rows).unwrap_or(0) } else { 0 };
    let (unit, total) = if excel { ("rows", total_rows.max(1)) } else { ("bytes", file_bytes.max(1)) };

    let ticker = {
        let shared = shared.clone();
        let on_progress = on_progress.clone();
        let job_id = job_id.clone();
        tokio::spawn(async move {
            loop {
                on_progress(progress(&shared, &job_id, unit, total, started));
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        })
    };

    let (tx, rx) = mpsc::channel::<Batch>(workers * 2);
    let rx = Arc::new(tokio::sync::Mutex::new(rx));
    let task = if target.copy_header.is_some() { "copy" } else { "insert" };
    let handles: Vec<_> = conns
        .into_iter()
        .enumerate()
        .map(|(i, mut conn)| {
            let rx = rx.clone();
            let shared = shared.clone();
            let target = target.clone();
            tokio::spawn(async move {
                loop {
                    let b = { rx.lock().await.recv().await };
                    let Some(b) = b else { break };
                    if !shared.stopped() {
                        shared.active.fetch_add(1, Ordering::Relaxed);
                        shared.set_worker(i + 1, Some((task, &target.label)));
                        write_batch(&mut conn, &shared, &target, &b).await;
                        shared.set_worker(i + 1, None);
                        shared.active.fetch_sub(1, Ordering::Relaxed);
                    }
                    shared.raw_done.fetch_add(b.weight, Ordering::Relaxed);
                }
            })
        })
        .collect();

    let reader = {
        let shared = shared.clone();
        let src = o.source.clone();
        let src_cols = o.source_columns.clone();
        let picks: Vec<usize> = o.mapping.iter().map(|m| m.source).collect();
        let bools: Vec<bool> = o.mapping.iter().map(|m| o.bool_columns.contains(&m.target)).collect();
        let empty_as_null = o.empty_as_null;
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let r = resolve(&src)?;
            let count = Arc::new(AtomicU64::new(0));
            let mut batch: Vec<Vec<Cell>> = Vec::with_capacity(BATCH_ROWS);
            let mut bytes = 0usize;
            let mut first_row = 0u64;
            let mut last_count = 0u64;
            let send = |batch: &mut Vec<Vec<Cell>>, first_row: u64, last_count: &mut u64, count: &AtomicU64| -> bool {
                let now = count.load(Ordering::Relaxed);
                let weight = if excel { batch.len() as u64 } else { now - *last_count };
                *last_count = now;
                let b = Batch { rows: std::mem::take(batch), first_row, weight };
                tx.blocking_send(b).is_ok()
            };
            let json_cols = (src.format == "json").then_some(src_cols.as_slice());
            for_each_row(
                &src,
                &r,
                count.clone(),
                json_cols,
                |_| {},
                |row, n| {
                    if shared.stopped() {
                        return false;
                    }
                    if batch.is_empty() {
                        first_row = n;
                    }
                    let picked: Vec<Cell> = picks
                        .iter()
                        .zip(&bools)
                        .map(|(&i, &is_bool)| {
                            let v = row.get(i).cloned().flatten();
                            match v {
                                Some(s) if empty_as_null && s.is_empty() => None,
                                Some(s) if is_bool => Some(bool_value(s)),
                                other => other,
                            }
                        })
                        .collect();
                    bytes += picked.iter().map(|v| v.as_ref().map_or(4, String::len) + 3).sum::<usize>();
                    batch.push(picked);
                    if batch.len() >= BATCH_ROWS || bytes >= BATCH_BYTES {
                        bytes = 0;
                        return send(&mut batch, first_row, &mut last_count, &count);
                    }
                    true
                },
            )?;
            if !batch.is_empty() {
                send(&mut batch, first_row, &mut last_count, &count);
            } else if !excel {
                // count the rest (header, blank lines) so progress reaches 100%
                shared.raw_done.fetch_add(count.load(Ordering::Relaxed) - last_count, Ordering::Relaxed);
            }
            Ok(())
        })
    };

    let read_result = reader.await.map_err(|e| msg(e.to_string()))?;
    for h in handles {
        let _ = h.await;
    }
    ticker.abort();
    imports.0.lock().unwrap().remove(&job_id);
    on_progress(progress(&shared, &job_id, unit, total, started));
    read_result?;
    Ok(shared.summary(started, notes))
}

fn progress(shared: &Shared, job_id: &str, unit: &'static str, total: u64, started: Instant) -> ImportProgress {
    ImportProgress {
        job_id: job_id.to_owned(),
        done_bytes: shared.raw_done.load(Ordering::Relaxed).min(total),
        total_bytes: total,
        unit,
        statements: shared.statements.load(Ordering::Relaxed),
        rows: shared.rows.load(Ordering::Relaxed),
        error_count: shared.error_count.load(Ordering::Relaxed),
        table: shared.table.lock().unwrap().clone(),
        elapsed_ms: started.elapsed().as_millis() as u64,
        active_workers: shared.active.load(Ordering::Relaxed),
        workers: shared.workers.lock().unwrap().clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guesses() {
        let g = |v: &[&str]| {
            let cells: Vec<Cell> = v.iter().map(|s| if s.is_empty() { None } else { Some(s.to_string()) }).collect();
            let refs: Vec<&Cell> = cells.iter().collect();
            guess(&refs)
        };
        assert_eq!(g(&["1", "2", "-3"]).kind, "int");
        assert_eq!(g(&["1", "9999999999"]).kind, "bigint");
        let d = g(&["1.5", "123.25", ""]);
        assert_eq!((d.kind.as_str(), d.precision, d.scale, d.nullable), ("decimal", 5, 2, true));
        assert_eq!(g(&["007", "123"]).kind, "text");
        assert_eq!(g(&["1e5", "2.5"]).kind, "double");
        assert_eq!(g(&["true", "No"]).kind, "bool");
        assert_eq!(g(&["2024-02-29", "2024-03-01"]).kind, "date");
        assert_eq!(g(&["2024-02-29 13:45:00", "2024-03-01T08:00:00+02:00"]).kind, "datetime");
        assert_eq!(g(&["{\"a\":1}", "[1,2]"]).kind, "json");
        assert_eq!(g(&["12,5"]).kind, "text");
        assert_eq!(g(&["", ""]).kind, "text");
    }

    #[test]
    fn delimiters() {
        assert_eq!(detect_delimiter("a;b;c\n1;2;3\n"), b';');
        assert_eq!(detect_delimiter("a,b\n\"x,y\",2\n"), b',');
        assert_eq!(detect_delimiter("a\tb\tc\n1\t2\t3\n"), b'\t');
    }

    #[test]
    fn dates() {
        assert_eq!(excel_date(45351.0), "2024-02-29");
        assert_eq!(excel_date(45351.5), "2024-02-29 12:00:00");
        assert_eq!(excel_date(1.0), "1899-12-31");
    }

    #[test]
    fn csv_for_copy() {
        let rows = vec![vec![Some("a\"b".to_string()), None, Some(String::new())]];
        assert_eq!(copy_csv(&rows), b"\"a\"\"b\",,\"\"\n");
    }

    #[test]
    fn json_sources() {
        let dir = std::env::temp_dir();
        let arr = dir.join("dbclient_test.json");
        std::fs::write(&arr, r#"[{"id":1,"name":"Ana","tags":["a"]},{"id":2,"name":null,"extra":true}]"#).unwrap();
        let o = SourceOptions { path: arr.to_string_lossy().into(), format: "json".into(), delimiter: None, encoding: None, header: true, sheet: None };
        let p = preview(&o).unwrap();
        let names: Vec<&str> = p.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["id", "name", "tags", "extra"]);
        assert_eq!(p.rows[0], vec![Some("1".into()), Some("Ana".into()), Some("[\"a\"]".into()), None]);
        assert_eq!(p.columns[0].guess.kind, "int");

        let lines = dir.join("dbclient_test.jsonl");
        std::fs::write(&lines, "{\"a\":1}\n\n{\"a\":2,\"b\":\"x\"}\n").unwrap();
        let o = SourceOptions { path: lines.to_string_lossy().into(), ..o };
        let p = preview(&o).unwrap();
        assert_eq!(p.rows.len(), 2);
        assert_eq!(p.columns.len(), 2);
    }

    #[test]
    fn csv_cp1250() {
        let path = std::env::temp_dir().join("dbclient_test_1250.csv");
        // Windows-1250 encoded CSV
        let (bytes, _, _) = encoding_rs::WINDOWS_1250.encode("name;city\nĐorđe;Niš\n");
        std::fs::write(&path, &bytes).unwrap();
        let o = SourceOptions { path: path.to_string_lossy().into(), format: "csv".into(), delimiter: None, encoding: None, header: true, sheet: None };
        let p = preview(&o).unwrap();
        assert_eq!(p.encoding, "windows-1250");
        assert_eq!(p.delimiter, ";");
        assert_eq!(p.rows[0], vec![Some("Đorđe".into()), Some("Niš".into())]);
    }
}
