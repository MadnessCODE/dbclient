//! Streaming SQL dump reader: splits the text into statements and COPY blocks and classifies
//! statements so the importer knows what can run in parallel.
//!
//! Handles quotes ('', "", ``), backslash escapes (MySQL, Postgres E''), comments (--, #, /* */),
//! MySQL conditional comments /*!40101 ... */, DELIMITER, Postgres $tag$ blocks, psql meta
//! commands (\connect, \restrict) and COPY ... FROM stdin data up to "\.".

#[derive(Debug, PartialEq)]
pub enum Piece {
    Stmt { sql: String, line: u64 },
    /// Part of a COPY block's data; large blocks are split into several pieces.
    Copy { header: String, data: Vec<u8>, rows: u64, line: u64 },
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum State {
    Normal,
    Single { backslash: bool },
    Double { backslash: bool },
    Backtick,
    Block,
    Dollar,
}

/// COPY data per job; more jobs means more parallel COPYs.
const COPY_CHUNK: usize = 8 * 1024 * 1024;

pub struct Splitter {
    mysql: bool,
    state: State,
    delimiter: Vec<u8>,
    buf: Vec<u8>,
    has_content: bool,
    line: u64,
    stmt_line: u64,
    dollar_tag: Vec<u8>,
    copy: Option<CopyBlock>,
}

struct CopyBlock {
    header: String,
    data: Vec<u8>,
    rows: u64,
    line: u64,
}

impl Splitter {
    pub fn new(mysql: bool) -> Self {
        Self {
            mysql,
            state: State::Normal,
            delimiter: b";".to_vec(),
            buf: Vec::new(),
            has_content: false,
            line: 0,
            stmt_line: 0,
            dollar_tag: Vec::new(),
            copy: None,
        }
    }

    /// Feeds one line (ending in '\n', except maybe the last one).
    pub fn line(&mut self, line: &[u8], out: &mut impl FnMut(Piece)) {
        self.line += 1;

        if let Some(copy) = &mut self.copy {
            let trimmed = trim_end(line);
            if trimmed == b"\\." {
                let c = self.copy.take().unwrap();
                if c.rows > 0 {
                    out(Piece::Copy { header: c.header, data: c.data, rows: c.rows, line: c.line });
                }
                return;
            }
            if copy.data.is_empty() {
                copy.line = self.line;
            }
            copy.data.extend_from_slice(line);
            if !line.ends_with(b"\n") {
                copy.data.push(b'\n');
            }
            copy.rows += 1;
            if copy.data.len() >= COPY_CHUNK {
                let data = std::mem::take(&mut copy.data);
                let rows = std::mem::replace(&mut copy.rows, 0);
                out(Piece::Copy { header: copy.header.clone(), data, rows, line: copy.line });
            }
            return;
        }

        // Non-SQL commands only count at the start of a statement
        if self.state == State::Normal && !self.has_content {
            let t = trim_start(line);
            if self.mysql && starts_with_ci(t, b"DELIMITER ") {
                let d = trim_end(&t[10..]);
                if !d.is_empty() {
                    self.delimiter = d.to_vec();
                }
                self.buf.clear();
                return;
            }
            if !self.mysql && t.first() == Some(&b'\\') {
                return; // \connect, \restrict ...
            }
        }

        let mut seg = 0;
        let mut i = 0;
        let n = line.len();
        while i < n {
            let c = line[i];
            match self.state {
                State::Normal => {
                    if line[i..].starts_with(&self.delimiter) {
                        self.buf.extend_from_slice(&line[seg..i]);
                        i += self.delimiter.len();
                        seg = i;
                        self.finish(out);
                        if self.copy.is_some() {
                            // data starts on the next line
                            return;
                        }
                        continue;
                    }
                    match c {
                        b'\'' => {
                            let e = !self.mysql && i > 0 && matches!(line[i - 1], b'E' | b'e') && (i < 2 || !is_ident(line[i - 2]));
                            self.state = State::Single { backslash: self.mysql || e };
                            self.content();
                        }
                        b'"' => {
                            self.state = State::Double { backslash: self.mysql };
                            self.content();
                        }
                        b'`' if self.mysql => {
                            self.state = State::Backtick;
                            self.content();
                        }
                        b'-' if line.get(i + 1) == Some(&b'-') && (!self.mysql || line.get(i + 2).is_none_or(|b| b.is_ascii_whitespace())) => {
                            // rest of the line is a comment; before a statement it isn't kept at all
                            if !self.has_content {
                                seg = n;
                            }
                            break;
                        }
                        b'#' if self.mysql => {
                            if !self.has_content {
                                seg = n;
                            }
                            break;
                        }
                        b'/' if line.get(i + 1) == Some(&b'*') => {
                            // /*! ... */ is MySQL code, not a comment
                            if line.get(i + 2) == Some(&b'!') {
                                self.content();
                            }
                            self.state = State::Block;
                            i += 2;
                            continue;
                        }
                        b'$' if !self.mysql => {
                            if let Some(len) = dollar_tag(&line[i..]) {
                                self.dollar_tag = line[i..i + len].to_vec();
                                self.state = State::Dollar;
                                self.content();
                                i += len;
                                continue;
                            }
                            self.content();
                        }
                        c if !c.is_ascii_whitespace() => self.content(),
                        _ => {}
                    }
                    i += 1;
                }
                State::Single { backslash } | State::Double { backslash } => {
                    let q = if matches!(self.state, State::Single { .. }) { b'\'' } else { b'"' };
                    if backslash && c == b'\\' {
                        i += 2;
                    } else if c == q {
                        if line.get(i + 1) == Some(&q) {
                            i += 2;
                        } else {
                            self.state = State::Normal;
                            i += 1;
                        }
                    } else {
                        i += 1;
                    }
                }
                State::Backtick => {
                    if c == b'`' {
                        if line.get(i + 1) == Some(&b'`') {
                            i += 2;
                        } else {
                            self.state = State::Normal;
                            i += 1;
                        }
                    } else {
                        i += 1;
                    }
                }
                State::Block => {
                    if c == b'*' && line.get(i + 1) == Some(&b'/') {
                        self.state = State::Normal;
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
                State::Dollar => {
                    if c == b'$' && line[i..].starts_with(&self.dollar_tag) {
                        i += self.dollar_tag.len();
                        self.state = State::Normal;
                    } else {
                        i += 1;
                    }
                }
            }
        }
        if seg < n {
            self.buf.extend_from_slice(&line[seg.min(n)..]);
        }
    }

    /// End of input: flushes a last statement without ';'.
    pub fn end(&mut self, out: &mut impl FnMut(Piece)) {
        if let Some(c) = self.copy.take() {
            if c.rows > 0 {
                out(Piece::Copy { header: c.header, data: c.data, rows: c.rows, line: c.line });
            }
        }
        self.finish(out);
    }

    fn content(&mut self) {
        if !self.has_content {
            self.has_content = true;
            self.stmt_line = self.line;
        }
    }

    fn finish(&mut self, out: &mut impl FnMut(Piece)) {
        let raw = std::mem::take(&mut self.buf);
        let had = std::mem::replace(&mut self.has_content, false);
        if !had {
            return;
        }
        let sql = match String::from_utf8(raw) {
            Ok(s) => s,
            Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
        };
        let sql = sql.trim().to_owned();
        if sql.is_empty() {
            return;
        }
        if !self.mysql && is_copy_from_stdin(&sql) {
            self.copy = Some(CopyBlock { header: sql, data: Vec::new(), rows: 0, line: self.line + 1 });
            return;
        }
        out(Piece::Stmt { sql, line: self.stmt_line });
    }
}

fn is_ident(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Length of a leading "$$" or "$tag$".
fn dollar_tag(s: &[u8]) -> Option<usize> {
    let mut j = 1;
    while j < s.len() && is_ident(s[j]) {
        if j == 1 && s[j].is_ascii_digit() {
            return None; // $1 is a parameter
        }
        j += 1;
    }
    (s.get(j) == Some(&b'$')).then_some(j + 1)
}

fn trim_start(s: &[u8]) -> &[u8] {
    let i = s.iter().position(|b| !b.is_ascii_whitespace()).unwrap_or(s.len());
    &s[i..]
}

fn trim_end(s: &[u8]) -> &[u8] {
    let i = s.iter().rposition(|b| !b.is_ascii_whitespace()).map_or(0, |i| i + 1);
    &s[..i]
}

fn starts_with_ci(s: &[u8], prefix: &[u8]) -> bool {
    s.len() >= prefix.len() && s[..prefix.len()].eq_ignore_ascii_case(prefix)
}

fn is_copy_from_stdin(sql: &str) -> bool {
    // the column list of a wide table is long, so read the whole header (only for COPY)
    tokens(sql, 1).first().is_some_and(|w| w.up == "COPY") && tokens(sql, usize::MAX).windows(2).any(|w| w[0].up == "FROM" && w[1].up == "STDIN")
}


/// Statement kind, used to decide what may run in parallel.
#[derive(Debug, PartialEq)]
pub enum Kind {
    /// INSERT/REPLACE: batched into parallel jobs.
    Data(String),
    /// SET, USE, set_config: session state, applied on every connection.
    Session,
    /// LOCK/UNLOCK TABLES, BEGIN/COMMIT: meaningless across parallel connections.
    Skip,
    /// CREATE/DROP TABLE, (DISABLE|ENABLE) KEYS: waits only for jobs on that table.
    TableDdl(String),
    /// CREATE INDEX, PRIMARY KEY/UNIQUE constraints: parallel across tables.
    Index(String),
    /// Everything else: waits for all jobs, then runs alone.
    Other,
}

pub struct Tok {
    pub up: String,
    pub raw: String,
}

/// First `max` tokens, skipping comments but entering MySQL /*!NNNNN ... */.
pub fn tokens(sql: &str, max: usize) -> Vec<Tok> {
    let b = sql.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() && out.len() < max {
        let c = b[i];
        if c.is_ascii_whitespace() {
            i += 1;
        } else if c == b'-' && b.get(i + 1) == Some(&b'-') || c == b'#' {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
        } else if c == b'/' && b.get(i + 1) == Some(&b'*') {
            if b.get(i + 2) == Some(&b'!') {
                i += 3;
                while i < b.len() && b[i].is_ascii_digit() {
                    i += 1;
                }
            } else {
                i += 2;
                while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                    i += 1;
                }
                i += 2;
            }
        } else if c == b'*' && b.get(i + 1) == Some(&b'/') {
            i += 2; // end of /*! ... */
        } else if c == b'`' || c == b'"' {
            let mut j = i + 1;
            let mut s = String::new();
            while j < b.len() {
                if b[j] == c {
                    if b.get(j + 1) == Some(&c) {
                        s.push(c as char);
                        j += 2;
                        continue;
                    }
                    break;
                }
                let start = j;
                while j < b.len() && b[j] != c {
                    j += 1;
                }
                s.push_str(&sql[start..j]);
            }
            out.push(Tok { up: s.to_uppercase(), raw: s });
            i = j + 1;
        } else if is_ident(c) || c >= 0x80 || c == b'$' || c == b'@' {
            let start = i;
            while i < b.len() && (is_ident(b[i]) || b[i] >= 0x80 || b[i] == b'$' || b[i] == b'@') {
                i += 1;
            }
            let w = &sql[start..i];
            out.push(Tok { up: w.to_uppercase(), raw: w.to_owned() });
        } else {
            out.push(Tok { up: (c as char).to_string(), raw: (c as char).to_string() });
            i += 1;
        }
    }
    out
}

/// Possibly qualified table name at `i`, plus the position after it.
fn qualified(t: &[Tok], mut i: usize) -> Option<(String, usize)> {
    let mut name = t.get(i)?.raw.clone();
    i += 1;
    while t.get(i).is_some_and(|x| x.raw == ".") {
        name.push('.');
        name.push_str(&t.get(i + 1)?.raw);
        i += 2;
    }
    Some((name, i))
}

pub fn classify(sql: &str) -> Kind {
    let t = tokens(sql, 16);
    let up = |i: usize| t.get(i).map(|x| x.up.as_str()).unwrap_or("");
    let skip = |mut i: usize, words: &[&str]| {
        while words.contains(&up(i)) {
            i += 1;
        }
        i
    };
    match up(0) {
        "INSERT" | "REPLACE" => {
            let i = skip(1, &["LOW_PRIORITY", "DELAYED", "HIGH_PRIORITY", "IGNORE"]);
            if up(i) == "INTO" {
                if let Some((name, _)) = qualified(&t, i + 1) {
                    return Kind::Data(name);
                }
            }
            Kind::Other
        }
        "SET" | "USE" => Kind::Session,
        "SELECT" if up(1) == "PG_CATALOG" && up(3) == "SET_CONFIG" => Kind::Session,
        "LOCK" | "UNLOCK" if up(1) == "TABLES" || up(1) == "TABLE" => Kind::Skip,
        "BEGIN" | "COMMIT" | "ROLLBACK" if t.len() == 1 => Kind::Skip,
        "START" if up(1) == "TRANSACTION" => Kind::Skip,
        "CREATE" => {
            let i = skip(1, &["UNIQUE"]);
            if up(i) == "INDEX" {
                // CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] [name] ON [ONLY] table
                if let Some(on) = (i + 1..t.len()).find(|&j| t[j].up == "ON") {
                    let j = skip(on + 1, &["ONLY"]);
                    if let Some((name, _)) = qualified(&t, j) {
                        return Kind::Index(name);
                    }
                }
                return Kind::Other;
            }
            if up(1) == "TABLE" {
                let i = skip(2, &["IF", "NOT", "EXISTS"]);
                if let Some((name, _)) = qualified(&t, i) {
                    return Kind::TableDdl(name);
                }
            }
            Kind::Other
        }
        "DROP" if up(1) == "TABLE" => {
            let i = skip(2, &["IF", "EXISTS"]);
            match qualified(&t, i) {
                Some((name, j)) if up(j) != "," => Kind::TableDdl(name),
                _ => Kind::Other,
            }
        }
        "ALTER" if up(1) == "TABLE" => {
            let i = skip(2, &["ONLY", "IF", "EXISTS"]);
            let Some((name, j)) = qualified(&t, i) else { return Kind::Other };
            if matches!(up(j), "DISABLE" | "ENABLE") && up(j + 1) == "KEYS" {
                return Kind::TableDdl(name);
            }
            if up(j) == "ADD" && up(j + 1) == "CONSTRAINT" && (up(j + 3) == "PRIMARY" || up(j + 3) == "UNIQUE") {
                return Kind::Index(name);
            }
            Kind::Other
        }
        _ => Kind::Other,
    }
}

/// Removes `DEFINER=user@host` from MySQL views, triggers, routines and events. Dumps made by
/// another user otherwise fail on privileges (1227/1419); without it the current user owns the
/// object. None if there's nothing to remove.
pub fn strip_definer(sql: &str) -> Option<String> {
    let b = sql.as_bytes();
    let mut out = String::with_capacity(sql.len());
    let mut last = 0;
    let mut i = 0;
    let mut changed = false;
    while i + 7 <= b.len() {
        if !b[i..i + 7].eq_ignore_ascii_case(b"DEFINER") || (i > 0 && is_ident(b[i - 1])) {
            i += 1;
            continue;
        }
        let mut j = i + 7;
        while j < b.len() && b[j].is_ascii_whitespace() {
            j += 1;
        }
        if b.get(j) != Some(&b'=') {
            i += 7; // e.g. "SQL SECURITY DEFINER"
            continue;
        }
        j += 1;
        while j < b.len() && b[j].is_ascii_whitespace() {
            j += 1;
        }
        let Some(end) = account_end(b, j) else {
            i += 7;
            continue;
        };
        out.push_str(&sql[last..i]);
        last = end;
        i = end;
        changed = true;
    }
    changed.then(|| {
        out.push_str(&sql[last..]);
        out
    })
}

/// End of "user@host" (quoted or not) or CURRENT_USER[()].
fn account_end(b: &[u8], start: usize) -> Option<usize> {
    let part = |i: usize| -> Option<usize> {
        match *b.get(i)? {
            q @ (b'`' | b'\'' | b'"') => {
                let mut j = i + 1;
                while j < b.len() {
                    if b[j] == q {
                        if b.get(j + 1) == Some(&q) {
                            j += 2;
                            continue;
                        }
                        return Some(j + 1);
                    }
                    j += 1;
                }
                None
            }
            _ => {
                let mut j = i;
                while j < b.len() && (is_ident(b[j]) || matches!(b[j], b'$' | b'.' | b'%' | b'-')) {
                    j += 1;
                }
                (j > i).then_some(j)
            }
        }
    };
    let mut end = part(start)?;
    if b.get(end) == Some(&b'@') {
        end = part(end + 1)?;
    } else if b[start..end].eq_ignore_ascii_case(b"CURRENT_USER") && b[end..].starts_with(b"()") {
        end += 2;
    }
    Some(end)
}

/// `ALTER ... OWNER TO role` and `SET SESSION AUTHORIZATION`, which pg_restore --no-owner leaves out.
/// They fail when the dump's roles don't exist on this server.
pub fn is_owner_change(sql: &str) -> bool {
    let head = tokens(sql, 3);
    let up = |i: usize| head.get(i).map(|x| x.up.as_str()).unwrap_or("");
    if up(0) == "SET" && up(1) == "SESSION" && up(2) == "AUTHORIZATION" {
        return true;
    }
    if up(0) != "ALTER" {
        return false;
    }
    let t = tokens(sql, usize::MAX);
    let n = t.len();
    // not "ALTER TABLE t RENAME owner TO x"
    n >= 4 && t[n - 3].up == "OWNER" && t[n - 2].up == "TO" && !t.iter().any(|x| x.up == "RENAME")
}

/// pg_dump writes large object data as `lo_open` + `lowrite(0, ...)` + `lo_close(0)` inside
/// BEGIN/COMMIT. The importer runs in autocommit, where descriptor 0 is gone after `lo_open`, so
/// the writes become `lo_put` at the tracked offset.
#[derive(Default)]
pub struct LargeObjects {
    oid: Option<String>,
    offset: u64,
}

#[derive(Debug, PartialEq)]
pub enum Lo {
    /// Not a large object statement
    Keep,
    Skip,
    Run(String),
}

impl LargeObjects {
    pub fn rewrite(&mut self, sql: &str) -> Lo {
        let t = tokens(sql, 4);
        if t.len() < 4 || t[0].up != "SELECT" || t[1].up != "PG_CATALOG" || t[2].up != "." {
            return Lo::Keep;
        }
        let Some(args) = call_args(sql, &t[3].raw) else { return Lo::Keep };
        match t[3].up.as_str() {
            "LO_OPEN" => {
                let Some((oid, _)) = args.split_once(',') else { return Lo::Keep };
                let oid = oid.trim().trim_matches('\'');
                if oid.is_empty() || !oid.bytes().all(|b| b.is_ascii_digit()) {
                    return Lo::Keep;
                }
                self.oid = Some(oid.to_owned());
                self.offset = 0;
                Lo::Skip
            }
            "LOWRITE" => {
                let (Some(oid), Some((fd, data))) = (&self.oid, args.split_once(',')) else { return Lo::Keep };
                let data = data.trim();
                let Some(len) = (fd.trim() == "0").then(|| hex_bytea_len(data)).flatten() else { return Lo::Keep };
                let sql = format!("SELECT pg_catalog.lo_put('{oid}', {}, {data})", self.offset);
                self.offset += len;
                Lo::Run(sql)
            }
            "LO_CLOSE" if self.oid.is_some() && args.trim() == "0" => {
                self.oid = None;
                Lo::Skip
            }
            _ => Lo::Keep,
        }
    }
}

/// Text between the parentheses of `name(...)`, when the statement ends with the call.
fn call_args<'a>(sql: &'a str, name: &str) -> Option<&'a str> {
    let at = sql.find(name)? + name.len();
    let rest = sql[at..].trim_start().strip_prefix('(')?;
    rest.trim_end().strip_suffix(')')
}

/// Byte length of a hex bytea literal: '\x0a1b', or '\\x0a1b' / E'\\x0a1b' without standard_conforming_strings.
fn hex_bytea_len(lit: &str) -> Option<u64> {
    let hex = ["'\\x", "'\\\\x", "E'\\\\x"].iter().find_map(|p| lit.strip_prefix(p))?.strip_suffix('\'')?;
    (hex.len() % 2 == 0 && hex.bytes().all(|b| b.is_ascii_hexdigit())).then_some(hex.len() as u64 / 2)
}

/// Table of "COPY schema.table (columns) FROM stdin".
pub fn copy_table(header: &str) -> String {
    let t = tokens(header, 8);
    qualified(&t, 1).map(|(n, _)| n).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(mysql: bool, text: &str) -> Vec<Piece> {
        let mut s = Splitter::new(mysql);
        let mut out = Vec::new();
        for line in text.split_inclusive('\n') {
            s.line(line.as_bytes(), &mut |p| out.push(p));
        }
        s.end(&mut |p| out.push(p));
        out
    }

    fn stmts(p: &[Piece]) -> Vec<&str> {
        p.iter()
            .map(|p| match p {
                Piece::Stmt { sql, .. } => sql.as_str(),
                Piece::Copy { .. } => "<copy>",
            })
            .collect()
    }

    #[test]
    fn wide_copy() {
        let cols: Vec<String> = (0..60).map(|i| format!("c{i}")).collect();
        let text = format!("COPY public.wide ({}) FROM stdin;\n1\t2\n\\.\n\nSELECT 1;\n", cols.join(", "));
        assert_eq!(stmts(&split(false, &text)), ["<copy>", "SELECT 1"]);
    }

    #[test]
    fn owner_changes() {
        assert!(is_owner_change("ALTER SCHEMA public OWNER TO postgres"));
        assert!(is_owner_change("ALTER TABLE public.\"Weird Name\" OWNER TO \"My Role\""));
        assert!(is_owner_change("ALTER FUNCTION public.f(a integer, b text) OWNER TO postgres"));
        assert!(is_owner_change("ALTER LARGE OBJECT 424242 OWNER TO postgres"));
        assert!(is_owner_change("SET SESSION AUTHORIZATION 'postgres'"));
        assert!(!is_owner_change("ALTER TABLE t RENAME owner TO boss"));
        assert!(!is_owner_change("ALTER TABLE t ADD COLUMN owner text"));
        assert!(!is_owner_change("SET search_path = public"));
    }

    #[test]
    fn large_objects() {
        let text = r"BEGIN;
SELECT pg_catalog.lo_open('424242', 131072);
SELECT pg_catalog.lowrite(0, '\x0a0b0c');
SELECT pg_catalog.lowrite(0, E'\\xff');
SELECT pg_catalog.lowrite(0, '\\x0102');
SELECT pg_catalog.lo_close(0);
COMMIT;
SELECT pg_catalog.lowrite(0, '\x00');
";
        let mut lo = LargeObjects::default();
        let out: Vec<Lo> = stmts(&split(false, text)).iter().map(|s| lo.rewrite(s)).collect();
        assert_eq!(
            out,
            [
                Lo::Keep,
                Lo::Skip,
                Lo::Run(r"SELECT pg_catalog.lo_put('424242', 0, '\x0a0b0c')".into()),
                Lo::Run(r"SELECT pg_catalog.lo_put('424242', 3, E'\\xff')".into()),
                Lo::Run(r"SELECT pg_catalog.lo_put('424242', 4, '\\x0102')".into()),
                Lo::Skip,
                Lo::Keep,
                Lo::Keep, // no open object
            ]
        );
    }

    #[test]
    fn mysql_dump() {
        let text = "-- MySQL dump\n/*!40101 SET NAMES utf8mb4 */;\nDROP TABLE IF EXISTS `t`;\nCREATE TABLE `t` (\n  `a` int\n);\n\
                    INSERT INTO `t` VALUES (1,'a;b'),(2,'it\\'s'),(3,'x\\\\'),(4,'--no comment');\n\
                    DELIMITER ;;\n/*!50003 CREATE*/ /*!50003 TRIGGER tr BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.a = 1; END */;;\nDELIMITER ;\n# hash comment\nUNLOCK TABLES;\n";
        let p = split(true, text);
        let s = stmts(&p);
        assert_eq!(s.len(), 6, "{s:#?}");
        assert_eq!(s[0], "/*!40101 SET NAMES utf8mb4 */");
        assert!(s[3].starts_with("INSERT") && s[3].ends_with("'--no comment')"));
        assert!(s[4].contains("SET NEW.a = 1; END */"));
        assert_eq!(s[5], "UNLOCK TABLES");
        assert_eq!(classify(s[0]), Kind::Session);
        assert_eq!(classify(s[1]), Kind::TableDdl("t".into()));
        assert_eq!(classify(s[3]), Kind::Data("t".into()));
        assert_eq!(classify(s[4]), Kind::Other);
        assert_eq!(classify(s[5]), Kind::Skip);
        assert_eq!(classify("/*!40000 ALTER TABLE `t` DISABLE KEYS */"), Kind::TableDdl("t".into()));
    }

    #[test]
    fn pg_dump() {
        let text = "\\restrict abc\nSET client_encoding = 'UTF8';\nSELECT pg_catalog.set_config('search_path', '', false);\n\
                    CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $_$\nBEGIN\n  RETURN 1; -- ;\nEND;\n$_$;\n\
                    COPY public.t (a, b) FROM stdin;\n1\tx\\ty\n2\t\\N\n\\.\n\n\
                    CREATE INDEX idx_t_b ON public.t USING btree (b);\nALTER TABLE ONLY public.t\n    ADD CONSTRAINT t_pkey PRIMARY KEY (a);\n\
                    ALTER TABLE ONLY public.t ADD CONSTRAINT t_fk FOREIGN KEY (b) REFERENCES public.u(id);\nSELECT E'it\\'s;';\n";
        let p = split(false, text);
        let s = stmts(&p);
        assert_eq!(s.len(), 8, "{s:#?}");
        assert_eq!(classify(s[0]), Kind::Session);
        assert_eq!(classify(s[1]), Kind::Session);
        assert!(s[2].ends_with("$_$"));
        assert_eq!(s[3], "<copy>");
        match &p[3] {
            Piece::Copy { header, data, rows, .. } => {
                assert_eq!(header, "COPY public.t (a, b) FROM stdin");
                assert_eq!(*rows, 2);
                assert_eq!(data, b"1\tx\\ty\n2\t\\N\n");
                assert_eq!(copy_table(header), "public.t");
            }
            _ => unreachable!(),
        }
        assert_eq!(classify(s[4]), Kind::Index("public.t".into()));
        assert_eq!(classify(s[5]), Kind::Index("public.t".into()));
        assert_eq!(classify(s[6]), Kind::Other);
        assert_eq!(s[7], "SELECT E'it\\'s;'");
    }

    #[test]
    fn definer() {
        let v = "/*!50001 CREATE ALGORITHM=UNDEFINED */ /*!50013 DEFINER=`root`@`localhost` SQL SECURITY DEFINER */ /*!50001 VIEW `v` AS select 1 */";
        assert_eq!(strip_definer(v).unwrap(), "/*!50001 CREATE ALGORITHM=UNDEFINED */ /*!50013  SQL SECURITY DEFINER */ /*!50001 VIEW `v` AS select 1 */");
        assert_eq!(strip_definer("CREATE DEFINER = 'a b'@'%' PROCEDURE p() BEGIN END").unwrap(), "CREATE  PROCEDURE p() BEGIN END");
        assert_eq!(strip_definer("CREATE DEFINER=CURRENT_USER() TRIGGER t").unwrap(), "CREATE  TRIGGER t");
        assert_eq!(strip_definer("SELECT 'no definer here'"), None);
        assert_eq!(strip_definer("SQL SECURITY DEFINER"), None);
    }

    #[test]
    fn insert_variants() {
        assert_eq!(classify("INSERT IGNORE INTO db.`my tbl` (a) VALUES (1)"), Kind::Data("db.my tbl".into()));
        assert_eq!(classify("insert into public.\"Users\" values (1)"), Kind::Data("public.Users".into()));
        assert_eq!(classify("DROP TABLE a, b"), Kind::Other);
        assert_eq!(classify("CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ix ON ONLY s.t (a)"), Kind::Index("s.t".into()));
        assert_eq!(classify("BEGIN"), Kind::Skip);
        assert_eq!(classify("USE `shop`"), Kind::Session);
    }
}

#[cfg(test)]
mod scan {
    use super::*;
    use std::io::BufRead;

    /// Manual check on a real dump: DUMP=path MYSQL=1 cargo test --release scan_dump -- --ignored --nocapture
    #[test]
    #[ignore]
    fn scan_dump() {
        let path = std::env::var("DUMP").unwrap();
        let mysql = std::env::var("MYSQL").is_ok();
        let started = std::time::Instant::now();
        let mut r = std::io::BufReader::with_capacity(1 << 20, std::fs::File::open(&path).unwrap());
        let mut s = Splitter::new(mysql);
        let mut counts = std::collections::BTreeMap::<String, usize>::new();
        let mut copy_rows = 0;
        let mut line = Vec::new();
        let mut f = |p: Piece| match p {
            Piece::Stmt { sql, .. } => {
                let k = match classify(&sql) {
                    Kind::Data(_) => "data",
                    Kind::Session => "session",
                    Kind::Skip => "skip",
                    Kind::TableDdl(_) => "table_ddl",
                    Kind::Index(_) => "index",
                    Kind::Other => "other",
                };
                *counts.entry(k.into()).or_default() += 1;
            }
            Piece::Copy { rows, .. } => {
                copy_rows += rows;
                *counts.entry("copy_chunk".into()).or_default() += 1;
            }
        };
        loop {
            line.clear();
            if r.read_until(b'\n', &mut line).unwrap() == 0 {
                break;
            }
            s.line(&line, &mut f);
        }
        s.end(&mut f);
        println!("{counts:?} copy_rows={copy_rows} in {:?}", started.elapsed());
    }
}
