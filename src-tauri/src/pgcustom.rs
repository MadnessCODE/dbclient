//! pg_dump custom format (-Fc), read as the SQL script `pg_restore -f -` would print,
//! so the regular importer (parallel COPY, progress, errors) handles it.
//! Layout: header, table of contents, then one data block per table (chunked, compressed).

use std::collections::{HashMap, VecDeque};
use std::io::{self, Read, Seek, SeekFrom};
use std::sync::{Arc, Mutex};

pub const MAGIC: &[u8] = b"PGDMP";
/// Archive versions 1.12 (PostgreSQL 9.0) .. 1.16 (PostgreSQL 17/18)
const MIN_MINOR: u8 = 12;
const MAX_MINOR: u8 = 16;

const BLK_DATA: u8 = 1;
const BLK_BLOBS: u8 = 3;
const OFFSET_SET: u8 = 2;
const OFFSET_NO_DATA: u8 = 3;

/// Output is produced in pieces of about this size.
const PIECE: usize = 256 * 1024;
/// Large object bytes per lo_put statement.
const LO_PIECE: usize = 64 * 1024;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Compression {
    None,
    Gzip,
    Lz4,
    Zstd,
}

impl Compression {
    pub fn label(self) -> &'static str {
        match self {
            Compression::None => "uncompressed",
            Compression::Gzip => "gzip",
            Compression::Lz4 => "lz4",
            Compression::Zstd => "zstd",
        }
    }
}

#[derive(Debug)]
pub struct Header {
    pub compression: Compression,
    pub server_version: String,
    pub dump_version: String,
    minor: u8,
    int_size: usize,
    off_size: usize,
}

#[derive(Debug)]
struct Entry {
    dump_id: i64,
    tag: String,
    desc: String,
    defn: String,
    drop_stmt: String,
    copy_stmt: String,
    namespace: String,
    tablespace: Option<String>,
    tableam: Option<String>,
    owner: String,
    deps: Vec<i64>,
    has_data: bool,
    offset: Option<u64>,
}

/// Header and table of contents of an archive.
pub struct Archive {
    pub header: Header,
    entries: Vec<Entry>,
    /// File position where the data blocks start
    data_start: u64,
}

impl Archive {
    /// Number of tables with data.
    pub fn tables(&self) -> usize {
        self.entries.iter().filter(|e| e.desc == "TABLE DATA").count()
    }
}

fn err(msg: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.into())
}

fn byte(r: &mut impl Read) -> io::Result<u8> {
    let mut b = [0u8; 1];
    r.read_exact(&mut b)?;
    Ok(b[0])
}

fn int(r: &mut impl Read, h: &Header) -> io::Result<i64> {
    let sign = byte(r)?;
    let mut v: u64 = 0;
    for i in 0..h.int_size {
        v |= (byte(r)? as u64) << (8 * i);
    }
    Ok(if sign == 0 { v as i64 } else { -(v as i64) })
}

fn string(r: &mut impl Read, h: &Header) -> io::Result<Option<String>> {
    let len = int(r, h)?;
    if len < 0 {
        return Ok(None);
    }
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf)?;
    Ok(Some(String::from_utf8(buf).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())))
}

fn text(r: &mut impl Read, h: &Header) -> io::Result<String> {
    Ok(string(r, h)?.unwrap_or_default())
}

fn read_header(r: &mut impl Read) -> io::Result<Header> {
    let mut magic = [0u8; 5];
    r.read_exact(&mut magic)?;
    if magic != MAGIC {
        return Err(err("not a pg_dump archive"));
    }
    let (major, minor, _rev) = (byte(r)?, byte(r)?, byte(r)?);
    if major != 1 || minor < MIN_MINOR {
        return Err(err(format!("it is from pg_dump older than PostgreSQL 9.0 (archive {major}.{minor})")));
    }
    if minor > MAX_MINOR {
        return Err(err(format!("it was made by a newer pg_dump than this app can read (archive {major}.{minor}); update DB Client")));
    }
    let int_size = byte(r)? as usize;
    let off_size = byte(r)? as usize;
    if !(1..=8).contains(&int_size) || !(1..=8).contains(&off_size) {
        return Err(err("damaged archive header"));
    }
    match byte(r)? {
        1 => {}
        3 => return Err(err("it is in tar format (-Ft); only the custom format (-Fc) is supported")),
        5 => return Err(err("it is the toc.dat of a directory format dump (-Fd); only the custom format (-Fc) is supported")),
        f => return Err(err(format!("its format ({f}) is unknown"))),
    }
    let mut h = Header { compression: Compression::None, server_version: String::new(), dump_version: String::new(), minor, int_size, off_size };
    h.compression = if minor >= 15 {
        match byte(r)? {
            0 => Compression::None,
            1 => Compression::Gzip,
            2 => Compression::Lz4,
            3 => Compression::Zstd,
            c => return Err(err(format!("unknown compression method {c}"))),
        }
    } else if int(r, &h)? == 0 {
        Compression::None
    } else {
        Compression::Gzip
    };
    for _ in 0..7 {
        int(r, &h)?; // creation time
    }
    text(r, &h)?; // database name
    h.server_version = text(r, &h)?;
    h.dump_version = text(r, &h)?;
    Ok(h)
}

fn read_entry(r: &mut impl Read, h: &Header) -> io::Result<Entry> {
    let dump_id = int(r, h)?;
    let had_dumper = int(r, h)? != 0;
    text(r, h)?; // table oid
    text(r, h)?; // oid
    let tag = text(r, h)?;
    let desc = text(r, h)?;
    int(r, h)?; // section
    let defn = text(r, h)?;
    let drop_stmt = text(r, h)?;
    let copy_stmt = text(r, h)?;
    let namespace = text(r, h)?;
    let tablespace = string(r, h)?;
    let tableam = if h.minor >= 14 { string(r, h)? } else { None };
    if h.minor >= 16 {
        int(r, h)?; // relkind
    }
    let owner = text(r, h)?;
    text(r, h)?; // "with oids", always false now
    let mut deps = Vec::new();
    while let Some(d) = string(r, h)? {
        deps.extend(d.parse::<i64>().ok());
    }
    let flag = byte(r)?;
    let mut pos: u64 = 0;
    for i in 0..h.off_size {
        pos |= (byte(r)? as u64) << (8 * i);
    }
    Ok(Entry {
        dump_id,
        tag,
        desc,
        defn,
        drop_stmt,
        copy_stmt,
        namespace,
        tablespace,
        tableam,
        owner,
        deps,
        has_data: had_dumper && flag != OFFSET_NO_DATA,
        offset: (flag == OFFSET_SET).then_some(pos),
    })
}

/// Reads the header and the table of contents.
pub fn read_archive<R: Read + Seek>(r: &mut R) -> io::Result<Archive> {
    let header = read_header(r)?;
    let count = int(r, &header)?;
    if !(0..10_000_000).contains(&count) {
        return Err(err("damaged table of contents"));
    }
    let mut entries = Vec::with_capacity(count as usize);
    for _ in 0..count {
        entries.push(read_entry(r, &header)?);
    }
    let data_start = r.stream_position()?;
    Ok(Archive { header, entries, data_start })
}

/// Identifier quoted the way pg_dump does it (only when needed).
fn ident(s: &str) -> String {
    let plain = s.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c == '_')
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        && !KEYWORDS.contains(&s);
    if plain { s.to_owned() } else { format!("\"{}\"", s.replace('"', "\"\"")) }
}

/// Keywords pg_dump quotes (everything but the unreserved ones).
const KEYWORDS: &[&str] = &[
    "all", "analyse", "analyze", "and", "any", "array", "as", "asc", "asymmetric", "authorization", "between", "bigint", "binary", "bit", "boolean", "both", "case", "cast",
    "char", "character", "check", "coalesce", "collate", "collation", "column", "concurrently", "constraint", "create", "cross", "current_catalog", "current_date",
    "current_role", "current_schema", "current_time", "current_timestamp", "current_user", "dec", "decimal", "default", "deferrable", "desc", "distinct", "do", "else",
    "end", "except", "exists", "extract", "false", "fetch", "float", "for", "foreign", "freeze", "from", "full", "grant", "greatest", "group", "grouping", "having", "ilike",
    "in", "initially", "inner", "inout", "int", "integer", "intersect", "interval", "into", "is", "isnull", "join", "json", "json_array", "json_arrayagg", "json_exists",
    "json_object", "json_objectagg", "json_query", "json_scalar", "json_serialize", "json_table", "json_value", "lateral", "leading", "least", "left", "like", "limit",
    "localtime", "localtimestamp", "merge_action", "national", "natural", "nchar", "none", "normalize", "not", "notnull", "null", "nullif", "numeric", "offset", "on",
    "only", "or", "order", "out", "outer", "overlaps", "overlay", "placing", "position", "precision", "primary", "real", "references", "returning", "right", "row",
    "select", "session_user", "setof", "similar", "smallint", "some", "substring", "symmetric", "system_user", "table", "tablesample", "then", "time", "timestamp", "to",
    "trailing", "treat", "trim", "true", "union", "unique", "user", "using", "values", "varchar", "variadic", "verbose", "when", "where", "window", "with", "xmlattributes",
    "xmlconcat", "xmlelement", "xmlexists", "xmlforest", "xmlnamespaces", "xmlparse", "xmlpi", "xmlroot", "xmlserialize", "xmltable",
];

/// What `ALTER ... OWNER TO` names for this entry, like pg_restore's _getObjectDescription.
fn object_name(e: &Entry) -> Option<String> {
    let qualified = |name: &str| if e.namespace.is_empty() { name.to_owned() } else { format!("{}.{name}", ident(&e.namespace)) };
    Some(match e.desc.as_str() {
        "COLLATION" | "CONVERSION" | "DOMAIN" | "FOREIGN TABLE" | "MATERIALIZED VIEW" | "SEQUENCE" | "STATISTICS" | "TABLE" | "TEXT SEARCH DICTIONARY"
        | "TEXT SEARCH CONFIGURATION" | "TYPE" | "VIEW" | "PROPERTY GRAPH" => format!("{} {}", e.desc, qualified(&ident(&e.tag))),
        "DATABASE" | "PUBLICATION" | "SCHEMA" | "SUBSCRIPTION" | "EVENT TRIGGER" | "FOREIGN DATA WRAPPER" | "SERVER" => format!("{} {}", e.desc, ident(&e.tag)),
        "PROCEDURAL LANGUAGE" => format!("LANGUAGE {}", ident(&e.tag)),
        "BLOB" => format!("LARGE OBJECT {}", e.tag),
        // the signature comes from the DROP statement: "DROP FUNCTION s.f(x integer);"
        "AGGREGATE" | "FUNCTION" | "OPERATOR" | "OPERATOR CLASS" | "OPERATOR FAMILY" | "PROCEDURE" => {
            e.drop_stmt.strip_prefix("DROP ")?.trim_end_matches(['\n', ';']).to_owned()
        }
        _ => return None,
    })
}

/// Entries pg_restore leaves out without --create, plus planner statistics (PostgreSQL 18+ only).
fn skipped(e: &Entry) -> bool {
    matches!(e.desc.as_str(), "DATABASE" | "DATABASE PROPERTIES" | "STATISTICS DATA")
        || (matches!(e.desc.as_str(), "COMMENT" | "ACL" | "SECURITY LABEL") && e.tag.starts_with("DATABASE "))
}

/// State shared by the script and the chunk reader of the current data stream.
struct Src<R> {
    r: R,
    /// Bytes left in the current chunk; `done` once the stream's zero-length chunk was read
    left: usize,
    done: bool,
}

type Shared<R> = Arc<Mutex<Src<R>>>;

/// One data stream: length-prefixed chunks ending with an empty one.
struct Chunks<R> {
    src: Shared<R>,
    int_size: usize,
}

impl<R: Read> Read for Chunks<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let mut s = self.src.lock().unwrap();
        if s.done || buf.is_empty() {
            return Ok(0);
        }
        while s.left == 0 {
            let sign = byte(&mut s.r)?;
            let mut v: u64 = 0;
            for i in 0..self.int_size {
                v |= (byte(&mut s.r)? as u64) << (8 * i);
            }
            if sign != 0 || v == 0 {
                s.done = true;
                return Ok(0);
            }
            s.left = v as usize;
        }
        let want = buf.len().min(s.left);
        let n = s.r.read(&mut buf[..want])?;
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        s.left -= n;
        Ok(n)
    }
}

enum Data {
    Copy(Box<dyn Read + Send>),
    /// Large objects; `cur` is the object being written and how far
    Blobs { cur: Option<(i64, u64, Box<dyn Read + Send>)> },
}

/// The archive as an SQL script.
pub struct Script<R> {
    src: Shared<R>,
    header: Header,
    entries: VecDeque<Entry>,
    data_start: u64,
    out: Vec<u8>,
    pos: usize,
    data: Option<Data>,
    tablespace: Option<String>,
    tableam: Option<String>,
    /// OIDs of each BLOB METADATA entry, by dump id
    blob_groups: HashMap<i64, Vec<String>>,
    started: bool,
}

impl<R: Read + Seek + Send + 'static> Script<R> {
    pub fn new(mut r: R) -> io::Result<Self> {
        r.seek(SeekFrom::Start(0))?;
        let a = read_archive(&mut r)?;
        Ok(Script {
            src: Arc::new(Mutex::new(Src { r, left: 0, done: true })),
            header: a.header,
            entries: a.entries.into(),
            data_start: a.data_start,
            out: Vec::with_capacity(PIECE + 1024),
            pos: 0,
            data: None,
            tablespace: None,
            tableam: None,
            blob_groups: HashMap::new(),
            started: false,
        })
    }

    fn header_int(&self) -> io::Result<i64> {
        let mut s = self.src.lock().unwrap();
        int(&mut s.r, &self.header)
    }

    /// A fresh compressed stream starting at the current position.
    fn stream(&self) -> io::Result<Box<dyn Read + Send>> {
        {
            let mut s = self.src.lock().unwrap();
            s.left = 0;
            s.done = false;
        }
        let chunks = Chunks { src: self.src.clone(), int_size: self.header.int_size };
        Ok(match self.header.compression {
            Compression::None => Box::new(chunks),
            Compression::Gzip => Box::new(flate2::read::ZlibDecoder::new(chunks)),
            Compression::Lz4 => Box::new(lz4_flex::frame::FrameDecoder::new(chunks)),
            Compression::Zstd => Box::new(zstd::stream::read::Decoder::new(chunks)?),
        })
    }

    /// Skips what the decoder left unread up to the stream's end marker.
    fn finish_stream(&self) -> io::Result<()> {
        let mut rest = Chunks { src: self.src.clone(), int_size: self.header.int_size };
        io::copy(&mut rest, &mut io::sink())?;
        Ok(())
    }

    fn skip_block(&self, kind: u8) -> io::Result<()> {
        let skip = |me: &Self| -> io::Result<()> {
            {
                let mut s = me.src.lock().unwrap();
                s.left = 0;
                s.done = false;
            }
            me.finish_stream()
        };
        if kind == BLK_BLOBS {
            while self.header_int()? != 0 {
                skip(self)?;
            }
            Ok(())
        } else {
            skip(self)
        }
    }

    /// Positions at the data block of an entry; returns its kind, None when it isn't in the file.
    fn find_block(&self, e: &Entry) -> io::Result<Option<u8>> {
        if let Some(pos) = e.offset {
            self.src.lock().unwrap().r.seek(SeekFrom::Start(pos))?;
        }
        // without offsets (dump written to a pipe) blocks follow the TOC order: scan forward, then once from the start
        let mut wrapped = false;
        loop {
            let kind = {
                let mut s = self.src.lock().unwrap();
                let mut b = [0u8; 1];
                if s.r.read(&mut b)? == 0 {
                    None
                } else {
                    Some(b[0])
                }
            };
            let Some(kind) = kind else {
                if wrapped || e.offset.is_some() {
                    return Ok(None);
                }
                wrapped = true;
                self.src.lock().unwrap().r.seek(SeekFrom::Start(self.data_start))?;
                continue;
            };
            let id = self.header_int()?;
            if id == e.dump_id {
                return Ok(Some(kind));
            }
            if e.offset.is_some() {
                return Err(err(format!("data of {} is not where the archive says", e.tag)));
            }
            self.skip_block(kind)?;
        }
    }

    fn push(&mut self, s: &str) {
        self.out.extend_from_slice(s.as_bytes());
    }

    fn preamble(&mut self) {
        let h = format!(
            "--\n-- PostgreSQL database dump (converted from a pg_dump custom format archive)\n--\n\n-- Dumped from database version {}\n-- Dumped by pg_dump version {}\n\n",
            self.header.server_version, self.header.dump_version
        );
        self.push(&h);
        self.push(
            "SET statement_timeout = 0;\nSET lock_timeout = 0;\nSET idle_in_transaction_session_timeout = 0;\nSET check_function_bodies = false;\nSET xmloption = content;\nSET client_min_messages = warning;\nSET row_security = off;\n\n",
        );
    }

    /// Definition of an entry; starts its data when it has some.
    fn entry(&mut self, e: Entry) -> io::Result<()> {
        if skipped(&e) {
            return Ok(());
        }
        let schema = if e.namespace.is_empty() { "-" } else { &e.namespace };
        let kind = if e.has_data { "Data for Name" } else { "Name" };
        let comment = format!("--\n-- {kind}: {}; Type: {}; Schema: {schema}; Owner: {}\n--\n\n", e.tag, e.desc, e.owner);
        self.push(&comment);

        if let Some(ts) = &e.tablespace
            && self.tablespace.as_ref() != Some(ts)
        {
            let v = if ts.is_empty() { "''".to_owned() } else { ident(ts) };
            self.push(&format!("SET default_tablespace = {v};\n\n"));
            self.tablespace = Some(ts.clone());
        }
        if let Some(am) = e.tableam.as_ref().filter(|a| !a.is_empty())
            && self.tableam.as_ref() != Some(am)
        {
            self.push(&format!("SET default_table_access_method = {};\n\n", ident(am)));
            self.tableam = Some(am.clone());
        }

        if e.desc == "BLOB METADATA" {
            // archive 1.16+: one entry lists the OIDs of a group of large objects
            let oids: Vec<String> = e.defn.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_owned).collect();
            for oid in &oids {
                self.push(&format!("SELECT pg_catalog.lo_create('{oid}');\n"));
            }
            self.push("\n");
            if !e.owner.is_empty() {
                let owner = ident(&e.owner);
                for oid in &oids {
                    self.push(&format!("ALTER LARGE OBJECT {oid} OWNER TO {owner};\n"));
                }
                self.push("\n");
            }
            self.blob_groups.insert(e.dump_id, oids);
            return Ok(());
        }
        if e.desc == "ACL"
            && let Some(oids) = e.deps.first().and_then(|d| self.blob_groups.get(d))
            && let Some(first) = oids.first()
        {
            // grants of a large object group are written for its first object only
            let from = format!("LARGE OBJECT {first}");
            let all: String = oids.iter().map(|oid| e.defn.replace(&from, &format!("LARGE OBJECT {oid}"))).collect();
            self.push(&all);
            self.push("\n");
            return Ok(());
        }

        if !e.defn.is_empty() {
            let defn = if e.defn.ends_with('\n') { e.defn.clone() } else { format!("{}\n", e.defn) };
            self.push(&defn);
            self.push("\n");
        }
        if !e.owner.is_empty() && !e.drop_stmt.is_empty() {
            let owner = ident(&e.owner);
            if let Some(name) = object_name(&e) {
                self.push(&format!("ALTER {name} OWNER TO {owner};\n\n"));
            }
        }

        if e.has_data {
            match self.find_block(&e)? {
                Some(BLK_DATA) => {
                    // the data ends with its own "\." (or is INSERTs, with --inserts)
                    self.push(&e.copy_stmt);
                    self.data = Some(Data::Copy(self.stream()?));
                }
                Some(BLK_BLOBS) => self.data = Some(Data::Blobs { cur: None }),
                Some(k) => return Err(err(format!("unknown data block type {k}"))),
                None => self.push(&format!("-- data of {} is missing from the archive\n\n", e.tag)),
            }
        }
        Ok(())
    }

    /// Next piece of the current data stream; false once it has ended.
    fn data_piece(&mut self) -> io::Result<bool> {
        match self.data.as_mut() {
            Some(Data::Copy(r)) => {
                let start = self.out.len();
                self.out.resize(start + PIECE, 0);
                let n = read_some(r.as_mut(), &mut self.out[start..])?;
                self.out.truncate(start + n);
                if n > 0 {
                    return Ok(true);
                }
                self.data = None;
                self.finish_stream()?;
                Ok(false)
            }
            Some(Data::Blobs { cur }) => {
                if cur.is_none() {
                    let oid = self.header_int()?;
                    if oid == 0 {
                        self.data = None;
                        return Ok(false);
                    }
                    let r = self.stream()?;
                    if let Some(Data::Blobs { cur }) = self.data.as_mut() {
                        *cur = Some((oid, 0, r));
                    }
                    return Ok(true);
                }
                let (oid, offset, r) = cur.as_mut().unwrap();
                let mut buf = vec![0u8; LO_PIECE];
                let n = read_some(r.as_mut(), &mut buf)?;
                if n == 0 {
                    *cur = None;
                    self.finish_stream()?;
                    return Ok(true);
                }
                let line = format!("SELECT pg_catalog.lo_put('{oid}', {offset}, pg_catalog.decode('{}', 'hex'));\n", hex(&buf[..n]));
                *offset += n as u64;
                self.push(&line);
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Fills `out` with the next part of the script; false at the end.
    fn fill(&mut self) -> io::Result<bool> {
        self.out.clear();
        self.pos = 0;
        if !self.started {
            self.started = true;
            self.preamble();
            return Ok(true);
        }
        while self.out.len() < PIECE {
            if self.data.is_some() {
                self.data_piece()?;
                continue;
            }
            match self.entries.pop_front() {
                Some(e) => self.entry(e)?,
                None => break,
            }
        }
        Ok(!self.out.is_empty())
    }
}

fn read_some(r: &mut dyn Read, buf: &mut [u8]) -> io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..])? {
            0 => break,
            k => n += k,
        }
    }
    Ok(n)
}

fn hex(b: &[u8]) -> String {
    const D: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for &x in b {
        s.push(D[(x >> 4) as usize] as char);
        s.push(D[(x & 15) as usize] as char);
    }
    s
}

impl<R: Read + Seek + Send + 'static> Read for Script<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.out.len() && !self.fill()? {
            return Ok(0);
        }
        let n = buf.len().min(self.out.len() - self.pos);
        buf[..n].copy_from_slice(&self.out[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting() {
        assert_eq!(ident("users"), "users");
        assert_eq!(ident("User"), "\"User\"");
        assert_eq!(ident("user"), "\"user\"");
        assert_eq!(ident("Weird Name_id_seq"), "\"Weird Name_id_seq\"");
        assert_eq!(ident("a\"b"), "\"a\"\"b\"");
    }
}

#[cfg(test)]
mod samples {
    use super::*;

    fn normalize(s: &str) -> Vec<String> {
        let fixed = ["SET statement_timeout", "SET lock_timeout", "SET idle_in_transaction", "SET transaction_timeout", "SET check_function_bodies", "SET xmloption", "SET client_min_messages", "SET row_security"];
        let blob = ["lo_open(", "lowrite(", "lo_close(", "lo_put(", "BEGIN;", "COMMIT;"];
        s.lines()
            .filter(|l| !l.is_empty() && !l.starts_with("--") && !l.starts_with("\\restrict") && !l.starts_with("\\unrestrict"))
            .filter(|l| !fixed.iter().any(|f| l.starts_with(f)) && !blob.iter().any(|b| l.contains(b)))
            .map(|l| l.replace("standard_conforming_strings = 'on'", "standard_conforming_strings = on"))
            .collect()
    }

    /// PGCUSTOM_DIR holds pgNN-<compression>.dump files and pgNN-ref.sql from `pg_restore -f`.
    #[test]
    #[ignore]
    fn matches_pg_restore() {
        let dir = std::env::var("PGCUSTOM_DIR").expect("PGCUSTOM_DIR");
        let mut checked = 0;
        for f in std::fs::read_dir(&dir).unwrap() {
            let path = f.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if !name.ends_with(".dump") {
                continue;
            }
            let reference = std::fs::read_to_string(path.with_file_name(format!("{}-ref.sql", &name[..4]))).unwrap();
            let mut out = String::new();
            Script::new(std::io::BufReader::new(std::fs::File::open(&path).unwrap())).unwrap().read_to_string(&mut out).unwrap();
            let (a, b) = (normalize(&out), normalize(&reference));
            let first = a.iter().zip(&b).position(|(x, y)| x != y);
            assert!(first.is_none() && a.len() == b.len(), "{name}: differs at {first:?} (ours {} lines, ref {}):\n ours: {:?}\n  ref: {:?}", a.len(), b.len(), first.map(|i| &a[i]), first.map(|i| &b[i]));
            let puts = out.matches("lo_put(").count();
            println!("{name}: ok, {} lines, {puts} lo_put", a.len());
            checked += 1;
        }
        assert!(checked > 0);
    }
}
