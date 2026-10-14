//! Connections saved by other tools (DBeaver, pgAdmin 4, MySQL Workbench, .pgpass), found in their
//! usual places or read from a file the user picks.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::error::{msg, AppResult};
use crate::ssh::{SshAuth, SshConfig};
use crate::store::{DbKind, SslMode};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub name: String,
    pub kind: DbKind,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: String,
    pub ssl: SslMode,
    pub ssh: Option<SshConfig>,
    pub password: Option<String>,
    pub ssh_secret: Option<String>,
    /// Folder or server group in the other tool
    pub group: Option<String>,
    /// "dev" | "staging" | "production"
    pub environment: Option<String>,
    /// Palette color key, when the other tool has one
    pub color: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub tool: String,
    pub path: String,
    pub connections: Vec<Candidate>,
    pub error: Option<String>,
    /// e.g. why passwords aren't included
    pub note: Option<String>,
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

fn appdata() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(PathBuf::from)
}

/// Looks in every place the supported tools keep their connections.
pub fn discover(with_passwords: bool) -> Vec<Found> {
    let mut out = Vec::new();
    let mut add = |tool: &str, path: PathBuf, read: &dyn Fn(&Path) -> AppResult<Found>| {
        if path.is_file() {
            out.push(read(&path).unwrap_or_else(|e| Found { tool: tool.into(), path: path.display().to_string(), connections: Vec::new(), error: Some(e.to_string()), note: None }));
        }
    };

    for dir in dbeaver_workspaces() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for project in entries.flatten() {
            let cfg = project.path().join(".dbeaver");
            let Ok(files) = std::fs::read_dir(&cfg) else { continue };
            for f in files.flatten() {
                let name = f.file_name().to_string_lossy().to_string();
                if name.starts_with("data-sources") && name.ends_with(".json") {
                    add("DBeaver", f.path(), &|p| dbeaver(p, with_passwords));
                }
            }
        }
    }
    let pgadmin = if cfg!(windows) { appdata().map(|a| a.join("pgAdmin").join("pgadmin4.db")) } else { home().map(|h| h.join(".pgadmin").join("pgadmin4.db")) };
    if let Some(p) = pgadmin {
        add("pgAdmin 4", p, &pgadmin_db);
    }
    let workbench = if cfg!(windows) {
        appdata().map(|a| a.join("MySQL").join("Workbench"))
    } else if cfg!(target_os = "macos") {
        home().map(|h| h.join("Library/Application Support/MySQL/Workbench"))
    } else {
        home().map(|h| h.join(".mysql/workbench"))
    };
    if let Some(p) = workbench {
        add("MySQL Workbench", p.join("connections.xml"), &workbench_xml);
    }
    if cfg!(target_os = "macos") {
        if let Some(h) = home() {
            for (tool, dir) in [
                ("Sequel Ace", "Library/Containers/com.sequel-ace.sequel-ace/Data/Library/Application Support/Sequel Ace/Data"),
                ("Sequel Ace", "Library/Application Support/Sequel Ace/Data"),
                ("Sequel Pro", "Library/Application Support/Sequel Pro/Data"),
            ] {
                add(tool, h.join(dir).join("Favorites.plist"), &|p| sequel_favorites(p, tool));
            }
        }
    }
    if let Some(p) = pgpass_path() {
        add("pgpass", p, &|p| pgpass(p, with_passwords));
    }
    out
}

/// A file picked by the user: detected from its name and content.
pub fn read_file(path: &str, with_passwords: bool) -> AppResult<Found> {
    let p = Path::new(path);
    let name = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    if name.ends_with(".db") {
        return pgadmin_db(p);
    }
    if name.ends_with(".plist") || std::fs::read(p).is_ok_and(|b| b.starts_with(b"bplist")) {
        return sequel_favorites(p, "Sequel Ace");
    }
    if name.ends_with(".xml") {
        return workbench_xml(p);
    }
    let text = std::fs::read_to_string(p)?;
    if text.trim_start().starts_with('{') {
        let v: Value = serde_json::from_str(&text)?;
        if v.get("Servers").is_some() {
            return pgadmin_json(p, &v);
        }
        if v.get("connections").is_some() {
            return dbeaver(p, with_passwords);
        }
        return Err(msg("This JSON file isn't a DBeaver data-sources.json or a pgAdmin servers.json export."));
    }
    if text.lines().any(|l| !l.trim().is_empty() && !l.starts_with('#') && l.split(':').count() >= 5) {
        return pgpass(p, with_passwords);
    }
    Err(msg("Unknown file. Supported: DBeaver data-sources.json, pgAdmin servers.json or pgadmin4.db, MySQL Workbench connections.xml, Sequel Ace / Sequel Pro favorites (.plist), .pgpass"))
}

fn found(tool: &str, path: &Path, connections: Vec<Candidate>, note: Option<String>) -> Found {
    Found { tool: tool.into(), path: path.display().to_string(), connections, error: None, note }
}

fn kind_port(kind: DbKind) -> u16 {
    if kind == DbKind::Postgres { 5432 } else { 3306 }
}

// ---- DBeaver

fn dbeaver_workspaces() -> Vec<PathBuf> {
    let base = if cfg!(windows) {
        appdata().map(|a| a.join("DBeaverData"))
    } else if cfg!(target_os = "macos") {
        home().map(|h| h.join("Library/DBeaverData"))
    } else {
        home().map(|h| h.join(".local/share/DBeaverData"))
    };
    base.map(|b| vec![b.join("workspace6")]).unwrap_or_default()
}

/// DBeaver encrypts saved credentials with a fixed, publicly known key (unless a master password is set).
fn dbeaver_credentials(dir: &Path) -> Option<Value> {
    use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    const KEY: [u8; 16] = [0xba, 0xbb, 0x4a, 0x9f, 0x77, 0x4a, 0xb8, 0x53, 0xc9, 0x6c, 0x2d, 0x65, 0x3d, 0xfe, 0x54, 0x4a];
    let data = std::fs::read(dir.join("credentials-config.json")).ok()?;
    if data.len() < 32 {
        return None;
    }
    let (iv, body) = data.split_at(16);
    let plain = cbc::Decryptor::<aes::Aes128>::new(&KEY.into(), iv.into()).decrypt_padded_vec_mut::<Pkcs7>(body).ok()?;
    serde_json::from_slice(&plain).ok()
}

fn dbeaver(path: &Path, with_passwords: bool) -> AppResult<Found> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    let creds = path.parent().and_then(dbeaver_credentials);
    let s = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_str().map(str::to_owned).or_else(|| x.as_u64().map(|n| n.to_string()))).unwrap_or_default();
    let mut out = Vec::new();
    let mut skipped = 0;
    for (id, c) in v.get("connections").and_then(Value::as_object).into_iter().flatten() {
        let provider = s(c, "provider").to_lowercase();
        let driver = s(c, "driver").to_lowercase();
        let kind = if provider.contains("postgre") || driver.contains("postgre") {
            DbKind::Postgres
        } else if provider.contains("mysql") || driver.contains("mysql") || driver.contains("maria") {
            DbKind::Mysql
        } else {
            skipped += 1;
            continue;
        };
        let cfg = c.get("configuration").cloned().unwrap_or(Value::Null);
        let (mut host, mut port, mut database) = (s(&cfg, "host"), s(&cfg, "port").parse().unwrap_or(0), s(&cfg, "database"));
        if host.is_empty() {
            if let Some((h, p, d)) = parse_jdbc(&s(&cfg, "url")) {
                (host, port, database) = (h, p.unwrap_or(0), d);
            }
        }
        let cred = creds.as_ref().and_then(|x| x.get(id));
        let conn_cred = cred.and_then(|x| x.get("#connection"));
        let user = conn_cred.map(|x| s(x, "user")).filter(|u| !u.is_empty()).unwrap_or_else(|| s(&cfg, "user"));
        let password = conn_cred.map(|x| s(x, "password")).filter(|p| with_passwords && !p.is_empty());

        let handlers = cfg.get("handlers").cloned().unwrap_or(Value::Null);
        let mut ssh = None;
        let mut ssh_secret = None;
        if let Some(t) = handlers.get("ssh_tunnel").filter(|t| t.get("enabled").and_then(Value::as_bool) == Some(true)) {
            let props = t.get("properties").cloned().unwrap_or(Value::Null);
            let ssh_cred = cred.and_then(|x| x.get("network/ssh_tunnel"));
            let key = s(&props, "authType").eq_ignore_ascii_case("PUBLIC_KEY");
            ssh = Some(SshConfig {
                enabled: true,
                host: s(&props, "host"),
                port: s(&props, "port").parse().unwrap_or(22),
                user: ssh_cred.map(|x| s(x, "user")).filter(|u| !u.is_empty()).unwrap_or_else(|| s(&props, "user")),
                auth: if key { SshAuth::Key } else { SshAuth::Password },
                key_path: s(&props, "keyPath"),
            });
            ssh_secret = ssh_cred.map(|x| s(x, "password")).filter(|p| with_passwords && !p.is_empty());
        }
        let ssl = ["postgre_ssl", "mysql_ssl", "ssl"]
            .iter()
            .find_map(|k| handlers.get(*k).filter(|h| h.get("enabled").and_then(Value::as_bool) == Some(true)))
            .map(|h| {
                let mode = h.get("properties").map(|p| s(p, "sslMode").to_lowercase()).unwrap_or_default();
                if mode.contains("disable") { SslMode::Disable } else if mode.contains("prefer") || mode.contains("allow") { SslMode::Prefer } else { SslMode::Require }
            })
            .unwrap_or_default();
        let environment = match s(&cfg, "type").as_str() {
            "prod" => Some("production".into()),
            "test" => Some("staging".into()),
            "dev" => Some("dev".into()),
            _ => None,
        };
        out.push(Candidate {
            name: s(c, "name"),
            kind,
            host: if host.is_empty() { "localhost".into() } else { host },
            port: if port == 0 { kind_port(kind) } else { port },
            user,
            database,
            ssl,
            ssh,
            password,
            ssh_secret,
            group: c.get("folder").and_then(Value::as_str).map(str::to_owned),
            environment,
            color: None,
        });
    }
    let mut notes = Vec::new();
    if skipped > 0 {
        notes.push(format!("{skipped} connection(s) to other database types skipped."));
    }
    if creds.is_none() && path.parent().is_some_and(|d| d.join("credentials-config.json").exists()) {
        notes.push("Saved passwords are protected by a DBeaver master password and can't be read.".into());
    }
    Ok(found("DBeaver", path, out, (!notes.is_empty()).then(|| notes.join(" "))))
}

/// jdbc:postgresql://host:port/db?... -> (host, port, db)
fn parse_jdbc(url: &str) -> Option<(String, Option<u16>, String)> {
    let rest = url.split("://").nth(1)?;
    let (hostport, path) = rest.split_once('/').unwrap_or((rest, ""));
    let db = path.split(['?', ';']).next().unwrap_or("").to_owned();
    let hostport = hostport.rsplit('@').next().unwrap_or(hostport);
    match hostport.rsplit_once(':') {
        Some((h, p)) if !h.contains(']') || h.ends_with(']') => Some((h.trim_matches(['[', ']']).to_owned(), p.parse().ok(), db)),
        _ => Some((hostport.to_owned(), None, db)),
    }
}

// ---- pgAdmin 4

fn pgadmin_db(path: &Path) -> AppResult<Found> {
    use rusqlite::{Connection, OpenFlags};
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(|e| msg(e.to_string()))?;
    let cols: Vec<String> = db
        .prepare("select name from pragma_table_info('server')")
        .and_then(|mut st| st.query_map([], |r| r.get::<_, String>(0))?.collect())
        .map_err(|e| msg(e.to_string()))?;
    let has = |c: &str| cols.iter().any(|x| x == c);
    let col = |c: &str, fallback: &str| if has(c) { format!("s.{c}") } else { fallback.to_owned() };
    let sql = format!(
        "select s.name, coalesce(s.host, ''), coalesce(s.port, 5432), coalesce(s.maintenance_db, ''), coalesce(s.username, ''), g.name,
                coalesce({}, 0), coalesce({}, ''), coalesce({}, 22), coalesce({}, ''), coalesce({}, 0), coalesce({}, ''), coalesce({}, ''), coalesce({}, '')
           from server s left join servergroup g on g.id = s.servergroup_id order by g.name, s.name",
        col("use_ssh_tunnel", "0"),
        col("tunnel_host", "''"),
        col("tunnel_port", "22"),
        col("tunnel_username", "''"),
        col("tunnel_authentication", "0"),
        col("tunnel_identity_file", "''"),
        col("connection_params", "''"),
        col("ssl_mode", "''"),
    );
    let mut st = db.prepare(&sql).map_err(|e| msg(e.to_string()))?;
    let rows = st
        .query_map([], |r| {
            let ssh_on = int(r.get(6)?).unwrap_or(0);
            let params: String = r.get(12)?;
            let mut mode: String = r.get(13)?;
            if let Ok(v) = serde_json::from_str::<Value>(&params) {
                if let Some(m) = v.get("sslmode").and_then(Value::as_str) {
                    mode = m.to_owned();
                }
            }
            let port = int(r.get(2)?).unwrap_or(5432);
            let tport = int(r.get(8)?).unwrap_or(22);
            let key_auth = int(r.get(10)?).unwrap_or(0);
            Ok(Candidate {
                name: r.get(0)?,
                kind: DbKind::Postgres,
                host: r.get(1)?,
                port: port as u16,
                user: r.get(4)?,
                database: r.get(3)?,
                ssl: pg_ssl(&mode),
                ssh: (ssh_on != 0).then(|| -> rusqlite::Result<SshConfig> {
                    Ok(SshConfig {
                        enabled: true,
                        host: r.get(7)?,
                        port: tport as u16,
                        user: r.get(9)?,
                        auth: if key_auth != 0 { SshAuth::Key } else { SshAuth::Password },
                        key_path: r.get(11)?,
                    })
                })
                .transpose()?,
                password: None,
                ssh_secret: None,
                group: r.get::<_, Option<String>>(5)?.filter(|g| g != "Servers"),
                environment: None,
                color: None,
            })
        })
        .map_err(|e| msg(e.to_string()))?;
    let mut list = Vec::new();
    let mut bad = 0;
    for r in rows {
        match r {
            // a server set up through a pg_service entry has no host
            Ok(c) if !c.host.is_empty() => list.push(c),
            Ok(_) => {}
            Err(_) => bad += 1,
        }
    }
    let mut note = "pgAdmin keeps passwords encrypted; you'll enter them on first connect.".to_owned();
    if bad > 0 {
        note.push_str(&format!(" {bad} server(s) couldn't be read."));
    }
    Ok(found("pgAdmin 4", path, with_pgpass(list), Some(note)))
}

/// pgAdmin stores some numbers as text.
fn int(v: rusqlite::types::Value) -> Option<i64> {
    match v {
        rusqlite::types::Value::Integer(i) => Some(i),
        rusqlite::types::Value::Text(t) => t.trim().parse().ok(),
        rusqlite::types::Value::Real(f) => Some(f as i64),
        _ => None,
    }
}

fn pgadmin_json(path: &Path, v: &Value) -> AppResult<Found> {
    let s = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_str().map(str::to_owned).or_else(|| x.as_u64().map(|n| n.to_string()))).unwrap_or_default();
    let mut out = Vec::new();
    for c in v.get("Servers").and_then(Value::as_object).into_iter().flat_map(|m| m.values()) {
        let ssh = (c.get("UseSSHTunnel").and_then(Value::as_u64).unwrap_or(0) != 0).then(|| SshConfig {
            enabled: true,
            host: s(c, "TunnelHost"),
            port: s(c, "TunnelPort").parse().unwrap_or(22),
            user: s(c, "TunnelUsername"),
            auth: if c.get("TunnelAuthentication").and_then(Value::as_u64).unwrap_or(0) != 0 { SshAuth::Key } else { SshAuth::Password },
            key_path: s(c, "TunnelIdentityFile"),
        });
        let mode = c.get("ConnectionParameters").map(|p| s(p, "sslmode")).filter(|m| !m.is_empty()).unwrap_or_else(|| s(c, "SSLMode"));
        out.push(Candidate {
            name: s(c, "Name"),
            kind: DbKind::Postgres,
            host: s(c, "Host"),
            port: s(c, "Port").parse().unwrap_or(5432),
            user: s(c, "Username"),
            database: s(c, "MaintenanceDB"),
            ssl: pg_ssl(&mode),
            ssh,
            password: None,
            ssh_secret: None,
            group: Some(s(c, "Group")).filter(|g| !g.is_empty() && g != "Servers"),
            environment: None,
            color: None,
        });
    }
    Ok(found("pgAdmin 4", path, with_pgpass(out), None))
}

fn pg_ssl(mode: &str) -> SslMode {
    match mode.to_lowercase().as_str() {
        "disable" => SslMode::Disable,
        "require" | "verify-ca" | "verify-full" => SslMode::Require,
        _ => SslMode::Prefer,
    }
}

// ---- MySQL Workbench

fn workbench_xml(path: &Path) -> AppResult<Found> {
    let text = std::fs::read_to_string(path)?;
    let mut out = Vec::new();
    for part in text.split("struct-name=\"db.mgmt.Connection\" id=").skip(1) {
        let get = |key: &str| -> String {
            let tag = format!("key=\"{key}\">");
            part.find(&tag).map(|i| &part[i + tag.len()..]).and_then(|r| r.find('<').map(|j| unescape(&r[..j]))).unwrap_or_default()
        };
        let driver = get("driver");
        let ssh = driver.ends_with("_sshtun").then(|| {
            let target = get("sshHost");
            let (h, p) = target.rsplit_once(':').map(|(h, p)| (h.to_owned(), p.parse().unwrap_or(22))).unwrap_or((target, 22));
            let key = get("sshKeyFile");
            SshConfig { enabled: true, host: h, port: p, user: get("sshUserName"), auth: if key.is_empty() { SshAuth::Password } else { SshAuth::Key }, key_path: key }
        });
        let host = get("hostName");
        out.push(Candidate {
            name: get("name"),
            kind: DbKind::Mysql,
            host: if host.is_empty() { "localhost".into() } else { host },
            port: get("port").parse().unwrap_or(3306),
            user: get("userName"),
            database: get("schema"),
            ssl: match get("useSSL").as_str() {
                "0" => SslMode::Disable,
                "2" | "3" | "4" => SslMode::Require,
                _ => SslMode::Prefer,
            },
            ssh,
            password: None,
            ssh_secret: None,
            group: None,
            environment: None,
            color: None,
        });
    }
    Ok(found("MySQL Workbench", path, out, Some("Workbench keeps passwords in the system vault; you'll enter them on first connect.".into())))
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

// ---- Sequel Ace / Sequel Pro

/// Favorites.plist (binary or XML), or a file from File → Export Favorites. Groups nest under
/// "Children"; passwords stay in the macOS keychain.
fn sequel_favorites(path: &Path, tool: &str) -> AppResult<Found> {
    let root = plist::Value::from_file(path).map_err(|e| msg(format!("Couldn't read {}: {e}", path.display())))?;
    let mut out = Vec::new();
    collect_favorites(&root, None, &mut out);
    Ok(found(tool, path, out, Some(format!("{tool} keeps passwords in the macOS keychain; you'll enter them on first connect."))))
}

fn collect_favorites(v: &plist::Value, group: Option<&str>, out: &mut Vec<Candidate>) {
    match v {
        plist::Value::Array(items) => items.iter().for_each(|x| collect_favorites(x, group, out)),
        plist::Value::Dictionary(d) => {
            let text = |k: &str| match d.get(k) {
                Some(plist::Value::String(s)) => s.trim().to_owned(),
                Some(plist::Value::Integer(i)) => i.as_signed().map(|n| n.to_string()).unwrap_or_default(),
                _ => String::new(),
            };
            let num = |k: &str| text(k).parse::<i64>().ok();
            if d.contains_key("host") || (d.contains_key("type") && d.contains_key("user")) {
                // 0 = TCP/IP, 1 = socket, 2 = SSH tunnel
                let kind = num("type").unwrap_or(0);
                let host = text("host");
                let ssh = (kind == 2).then(|| {
                    let key = text("sshKeyLocation");
                    let use_key = num("sshKeyLocationEnabled").unwrap_or(0) != 0 && !key.is_empty();
                    SshConfig {
                        enabled: true,
                        host: text("sshHost"),
                        port: num("sshPort").filter(|p| *p > 0).unwrap_or(22) as u16,
                        user: text("sshUser"),
                        auth: if use_key { SshAuth::Key } else { SshAuth::Password },
                        key_path: if use_key { key } else { String::new() },
                    }
                });
                let color = match num("colorIndex") {
                    Some(0) => Some("red"),
                    Some(1) => Some("orange"),
                    Some(2) => Some("amber"),
                    Some(3) => Some("green"),
                    Some(4) => Some("blue"),
                    Some(5) => Some("purple"),
                    _ => None,
                };
                out.push(Candidate {
                    name: text("name"),
                    kind: DbKind::Mysql,
                    host: if host.is_empty() { "localhost".into() } else { host },
                    port: num("port").filter(|p| *p > 0).unwrap_or(3306) as u16,
                    user: text("user"),
                    database: text("database"),
                    ssl: if num("useSSL").unwrap_or(0) != 0 { SslMode::Require } else { SslMode::Prefer },
                    ssh,
                    password: None,
                    ssh_secret: None,
                    group: group.map(str::to_owned),
                    environment: None,
                    color: color.map(str::to_owned),
                });
                return;
            }
            // a group: its own name for the children, except the invisible root
            let name = text("Name");
            let child_group = if name.is_empty() || name.eq_ignore_ascii_case("favorites") { group.map(str::to_owned) } else { Some(name) };
            for (_, x) in d.iter() {
                collect_favorites(x, child_group.as_deref(), out);
            }
        }
        _ => {}
    }
}

// ---- .pgpass

fn pgpass_path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("PGPASSFILE") {
        return Some(PathBuf::from(p));
    }
    if cfg!(windows) {
        appdata().map(|a| a.join("postgresql").join("pgpass.conf"))
    } else {
        home().map(|h| h.join(".pgpass"))
    }
}

/// host:port:database:user:password, with \: and \\ escapes.
fn pgpass_entries(text: &str) -> Vec<[String; 5]> {
    let mut out = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() || line.starts_with('#') {
            continue;
        }
        let mut fields = vec![String::new()];
        let mut chars = line.chars();
        while let Some(c) = chars.next() {
            match c {
                '\\' => {
                    if let Some(n) = chars.next() {
                        fields.last_mut().unwrap().push(n);
                    }
                }
                ':' if fields.len() < 5 => fields.push(String::new()),
                c => fields.last_mut().unwrap().push(c),
            }
        }
        if let Ok(f) = <[String; 5]>::try_from(fields) {
            out.push(f);
        }
    }
    out
}

fn pgpass(path: &Path, with_passwords: bool) -> AppResult<Found> {
    let text = std::fs::read_to_string(path)?;
    let list = pgpass_entries(&text)
        .into_iter()
        .filter(|[h, ..]| h != "*")
        .map(|[host, port, db, user, pw]| Candidate {
            name: format!("{user}@{host}"),
            kind: DbKind::Postgres,
            host,
            port: port.parse().unwrap_or(5432),
            user,
            database: if db == "*" { String::new() } else { db },
            ssl: SslMode::Prefer,
            ssh: None,
            password: with_passwords.then_some(pw),
            ssh_secret: None,
            group: None,
            environment: None,
            color: None,
        })
        .collect();
    Ok(found("pgpass", path, list, None))
}

/// Fills in passwords from .pgpass for PostgreSQL servers that match an entry.
fn with_pgpass(mut list: Vec<Candidate>) -> Vec<Candidate> {
    let Some(text) = pgpass_path().and_then(|p| std::fs::read_to_string(p).ok()) else { return list };
    let entries = pgpass_entries(&text);
    let m = |pat: &str, v: &str| pat == "*" || pat == v;
    for c in &mut list {
        let port = c.port.to_string();
        let db = if c.database.is_empty() { "postgres" } else { c.database.as_str() };
        c.password = entries.iter().find(|[h, p, d, u, _]| m(h, &c.host) && m(p, &port) && m(d, db) && m(u, &c.user)).map(|e| e[4].clone());
    }
    list
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jdbc_urls() {
        assert_eq!(parse_jdbc("jdbc:postgresql://db.example.com:5433/shop?ssl=true"), Some(("db.example.com".into(), Some(5433), "shop".into())));
        assert_eq!(parse_jdbc("jdbc:mysql://localhost/app"), Some(("localhost".into(), None, "app".into())));
    }

    #[test]
    fn sequel_ace_plist() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Favorites Root</key><dict><key>Name</key><string>FAVORITES</string><key>Children</key><array>
  <dict><key>name</key><string>Local</string><key>host</key><string>127.0.0.1</string><key>user</key><string>root</string><key>port</key><string></string><key>type</key><integer>0</integer><key>colorIndex</key><integer>3</integer></dict>
  <dict><key>Name</key><string>Clients</string><key>Children</key><array>
    <dict><key>name</key><string>Acme prod</string><key>host</key><string>10.0.0.5</string><key>user</key><string>app</string><key>database</key><string>shop</string><key>port</key><string>3307</string><key>type</key><integer>2</integer>
      <key>sshHost</key><string>bastion.acme.io</string><key>sshUser</key><string>deploy</string><key>sshPort</key><string>2222</string><key>sshKeyLocationEnabled</key><integer>1</integer><key>sshKeyLocation</key><string>~/.ssh/id_ed25519</string><key>useSSL</key><integer>1</integer><key>colorIndex</key><integer>0</integer></dict>
  </array></dict>
</array></dict></dict></plist>"#;
        let dir = std::env::temp_dir().join("dbc_sequel_test");
        std::fs::create_dir_all(&dir).unwrap();
        let xml_path = dir.join("Favorites.plist");
        std::fs::write(&xml_path, xml).unwrap();
        // the app writes binary plists; check both
        let bin_path = dir.join("binary.plist");
        plist::Value::from_file(&xml_path).unwrap().to_file_binary(&bin_path).unwrap();
        for p in [&xml_path, &bin_path] {
            let f = read_file(p.to_str().unwrap(), true).unwrap();
            assert_eq!(f.connections.len(), 2);
            let a = &f.connections[0];
            assert_eq!((a.host.as_str(), a.port, a.user.as_str(), a.color.as_deref()), ("127.0.0.1", 3306, "root", Some("green")));
            assert!(a.group.is_none());
            let b = &f.connections[1];
            assert_eq!((b.port, b.database.as_str(), b.group.as_deref(), b.ssl), (3307, "shop", Some("Clients"), SslMode::Require));
            let ssh = b.ssh.as_ref().unwrap();
            assert_eq!((ssh.host.as_str(), ssh.port, ssh.user.as_str(), ssh.auth, ssh.key_path.as_str()), ("bastion.acme.io", 2222, "deploy", SshAuth::Key, "~/.ssh/id_ed25519"));
        }
    }

    #[test]
    fn pgpass_lines() {
        let e = pgpass_entries("# c\nlocalhost:5432:*:me:p\\:w\\\\d\nbad line\n");
        assert_eq!(e.len(), 1);
        assert_eq!(e[0][4], "p:w\\d");
        assert_eq!(e[0][2], "*");
    }
}
