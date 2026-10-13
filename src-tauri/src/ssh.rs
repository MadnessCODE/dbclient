//! SSH tunnel: a local port on 127.0.0.1 forwarded to the database (like `ssh -L`).
//! The server key is remembered on first connect (known_hosts.json) and a changed key is rejected.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, Handle};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use crate::error::{msg, AppResult};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SshAuth {
    #[default]
    Password,
    Key,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub auth: SshAuth,
    /// Private key path (auth = key)
    #[serde(default)]
    pub key_path: String,
}


pub struct KnownHosts {
    path: PathBuf,
    map: Mutex<HashMap<String, String>>,
}

impl KnownHosts {
    pub fn load(path: PathBuf) -> Self {
        let map = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        Self { path, map: Mutex::new(map) }
    }

    /// Ok(true) = known and matching, or new (then remembered); Err = the key changed.
    fn check(&self, host: &str, fingerprint: &str) -> Result<(), String> {
        let mut map = self.map.lock().unwrap();
        match map.get(host) {
            Some(known) if known == fingerprint => Ok(()),
            Some(known) => Err(format!(
                "SSH host key for {host} has CHANGED (expected {known}, got {fingerprint}). \
                 This could be a man-in-the-middle attack. If the server was reinstalled, forget the old key in the connection dialog (SSH Tunnel tab)."
            )),
            None => {
                map.insert(host.to_string(), fingerprint.to_string());
                if let Some(dir) = self.path.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let _ = std::fs::write(&self.path, serde_json::to_string_pretty(&*map).unwrap_or_default());
                Ok(())
            }
        }
    }

    pub fn forget(&self, host: &str) {
        let mut map = self.map.lock().unwrap();
        map.remove(host);
        let _ = std::fs::write(&self.path, serde_json::to_string_pretty(&*map).unwrap_or_default());
    }

    pub fn list(&self) -> Vec<(String, String)> {
        let mut v: Vec<_> = self.map.lock().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        v.sort();
        v
    }
}

struct Client {
    host_id: String,
    known: Arc<KnownHosts>,
    /// Why the key was rejected, for a clear error message
    rejected: Arc<Mutex<Option<String>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let fingerprint = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.fingerprint(HashAlg::Sha256).to_string(),
            PublicKeyOrCertificate::Certificate(cert) => cert.public_key().fingerprint(HashAlg::Sha256).to_string(),
        };
        match self.known.check(&self.host_id, &fingerprint) {
            Ok(()) => Ok(true),
            Err(reason) => {
                *self.rejected.lock().unwrap() = Some(reason);
                Ok(false)
            }
        }
    }
}


pub struct SshTunnel {
    pub local_port: u16,
    task: JoinHandle<()>,
    handle: Arc<Handle<Client>>,
    last_error: Arc<Mutex<Option<String>>>,
}

impl SshTunnel {
    /// Last channel error (e.g. the server forbids forwarding).
    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().unwrap().clone()
    }

    pub async fn close(self) {
        self.task.abort();
        let _ = self.handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Opens the SSH session and a local port to `target_host:target_port` as seen from the SSH server.
pub async fn open(
    cfg: &SshConfig,
    secret: Option<&str>,
    target_host: &str,
    target_port: u16,
    known: Arc<KnownHosts>,
) -> AppResult<SshTunnel> {
    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(30)),
        ..Default::default()
    });
    let rejected = Arc::new(Mutex::new(None));
    let handler = Client { host_id: format!("{}:{}", cfg.host, cfg.port), known, rejected: rejected.clone() };

    let connect = client::connect(config, (cfg.host.as_str(), cfg.port), handler);
    let mut handle = match tokio::time::timeout(Duration::from_secs(15), connect).await {
        Err(_) => return Err(msg(format!("SSH: timed out connecting to {}:{}", cfg.host, cfg.port))),
        Ok(Err(e)) => {
            let reason = rejected.lock().unwrap().take();
            return Err(msg(reason.unwrap_or_else(|| format!("SSH: could not connect to {}:{} ({e})", cfg.host, cfg.port))));
        }
        Ok(Ok(h)) => h,
    };

    let auth = match cfg.auth {
        SshAuth::Password => {
            let pw = secret.ok_or_else(|| msg("SSH password is required"))?;
            handle.authenticate_password(cfg.user.clone(), pw).await
        }
        SshAuth::Key => {
            let path = expand_home(&cfg.key_path);
            let key = russh::keys::load_secret_key(&path, secret.filter(|s| !s.is_empty()))
                .map_err(|e| msg(format!("SSH key {}: {e}", path.display())))?;
            let hash = handle.best_supported_rsa_hash().await.ok().flatten().flatten();
            handle.authenticate_publickey(cfg.user.clone(), PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await
        }
    }
    .map_err(|e| msg(format!("SSH authentication error: {e}")))?;
    if !auth.success() {
        return Err(msg(format!("SSH authentication failed for {}@{}", cfg.user, cfg.host)));
    }

    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let local_port = listener.local_addr()?.port();
    let handle = Arc::new(handle);
    let target_host = target_host.to_string();
    let h = handle.clone();
    let last_error = Arc::new(Mutex::new(None));
    let errors = last_error.clone();
    let task = tokio::spawn(async move {
        while let Ok((mut socket, peer)) = listener.accept().await {
            let h = h.clone();
            let target_host = target_host.clone();
            let errors = errors.clone();
            tokio::spawn(async move {
                let channel = match h.channel_open_direct_tcpip(target_host.clone(), target_port as u32, "127.0.0.1", peer.port() as u32).await {
                    Ok(c) => c,
                    Err(e) => {
                        *errors.lock().unwrap() = Some(channel_error(&e, &target_host, target_port));
                        return;
                    }
                };
                let mut stream = channel.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
            });
        }
    });

    Ok(SshTunnel { local_port, task, handle, last_error })
}

/// Explains why the channel to the database couldn't be opened.
fn channel_error(e: &russh::Error, host: &str, port: u16) -> String {
    use russh::ChannelOpenFailure as F;
    match e {
        russh::Error::ChannelOpenFailure(F::ConnectFailed) => format!(
            "The SSH server could not reach the database at {host}:{port}. The database host is resolved from the SSH server, \
             so use the address the database has there (often localhost, or a hostname/IP on that server's network)."
        ),
        russh::Error::ChannelOpenFailure(F::AdministrativelyProhibited) => format!(
            "The SSH server does not allow port forwarding to {host}:{port} (AllowTcpForwarding / PermitOpen in sshd_config)."
        ),
        other => format!("SSH tunnel to {host}:{port} failed: {other}"),
    }
}

fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}
