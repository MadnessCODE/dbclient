//! Saved connections: settings in connections.json, passwords in the system keychain (never on disk).

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::{msg, AppResult};
use crate::ssh::SshConfig;

const KEYRING_SERVICE: &str = "com.dbclient.app";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DbKind {
    Postgres,
    Mysql,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SslMode {
    Disable,
    #[default]
    Prefer,
    Require,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub kind: DbKind,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: String,
    #[serde(default)]
    pub ssl: SslMode,
    #[serde(default)]
    pub save_password: bool,
    #[serde(default)]
    pub ssh: Option<SshConfig>,
    /// Palette color key, e.g. "red"
    #[serde(default)]
    pub color: Option<String>,
    /// "dev" | "staging" | "production"
    #[serde(default)]
    pub environment: Option<String>,
    /// Owning project; None = no project
    #[serde(default)]
    pub project_id: Option<String>,
}

impl ConnectionConfig {
    pub fn uses_ssh(&self) -> bool {
        self.ssh.as_ref().is_some_and(|s| s.enabled)
    }
}

/// Sent by the frontend when saving or testing. `password: None` keeps the saved one.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInput {
    #[serde(flatten)]
    pub config: ConnectionConfig,
    pub password: Option<String>,
    /// SSH password or key passphrase; None keeps the saved one
    #[serde(default)]
    pub ssh_secret: Option<String>,
}

pub struct ConnectionStore {
    path: PathBuf,
    items: Mutex<Vec<ConnectionConfig>>,
}

impl ConnectionStore {
    pub fn load(path: PathBuf) -> AppResult<Self> {
        let items = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        Ok(Self { path, items: Mutex::new(items) })
    }

    pub fn list(&self) -> Vec<ConnectionConfig> {
        self.items.lock().unwrap().clone()
    }

    pub fn get(&self, id: &str) -> AppResult<ConnectionConfig> {
        self.items
            .lock()
            .unwrap()
            .iter()
            .find(|c| c.id == id)
            .cloned()
            .ok_or_else(|| msg(format!("Connection {id} not found")))
    }

    pub fn save(&self, input: ConnectionInput) -> AppResult<ConnectionConfig> {
        let mut config = input.config;
        if config.id.is_empty() {
            config.id = uuid::Uuid::new_v4().to_string();
        }

        let ssh_key = ssh_entry_id(&config.id);
        if config.save_password {
            if let Some(pw) = &input.password {
                password_entry(&config.id)?.set_password(pw)?;
            }
            match &input.ssh_secret {
                Some(s) if config.uses_ssh() && !s.is_empty() => password_entry(&ssh_key)?.set_password(s)?,
                Some(_) => delete_password(&ssh_key),
                None if !config.uses_ssh() => delete_password(&ssh_key),
                None => {}
            }
        } else {
            delete_password(&config.id);
            delete_password(&ssh_key);
        }

        let mut items = self.items.lock().unwrap();
        match items.iter_mut().find(|c| c.id == config.id) {
            Some(existing) => *existing = config.clone(),
            None => items.push(config.clone()),
        }
        self.persist(&items)?;
        Ok(config)
    }

    /// Moves connections to a project (None = no project) and returns them.
    pub fn set_project(&self, ids: &[String], project_id: Option<String>) -> AppResult<Vec<ConnectionConfig>> {
        let mut items = self.items.lock().unwrap();
        let mut changed = Vec::new();
        for c in items.iter_mut().filter(|c| ids.contains(&c.id)) {
            c.project_id = project_id.clone();
            changed.push(c.clone());
        }
        self.persist(&items)?;
        Ok(changed)
    }

    /// Used when a project is deleted: its connections are kept, without a project.
    pub fn clear_project(&self, project_id: &str) -> AppResult<()> {
        let mut items = self.items.lock().unwrap();
        for c in items.iter_mut().filter(|c| c.project_id.as_deref() == Some(project_id)) {
            c.project_id = None;
        }
        self.persist(&items)
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        let mut items = self.items.lock().unwrap();
        items.retain(|c| c.id != id);
        self.persist(&items)?;
        delete_password(id);
        delete_password(&ssh_entry_id(id));
        Ok(())
    }

    fn persist(&self, items: &[ConnectionConfig]) -> AppResult<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(items)?)?;
        std::fs::rename(tmp, &self.path)?;
        Ok(())
    }
}

fn password_entry(id: &str) -> AppResult<keyring::Entry> {
    Ok(keyring::Entry::new(KEYRING_SERVICE, id)?)
}

pub fn saved_password(id: &str) -> AppResult<Option<String>> {
    match password_entry(id)?.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn ssh_entry_id(id: &str) -> String {
    format!("{id}:ssh")
}

pub fn saved_ssh_secret(id: &str) -> AppResult<Option<String>> {
    saved_password(&ssh_entry_id(id))
}

fn delete_password(id: &str) {
    if let Ok(entry) = password_entry(id) {
        let _ = entry.delete_credential();
    }
}
