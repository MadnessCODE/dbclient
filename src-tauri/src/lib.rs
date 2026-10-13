mod db;
mod dump;
mod error;
mod import;
mod projects;
mod schema;
mod ssh;
mod store;
mod structure;
mod table_import;
mod xlsx;

// Tests against local dev databases; not part of the repository.
#[cfg(all(test, feature = "dev-tests"))]
mod dev_tests;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::{Manager, State};

use db::{DbPool, QueryOutput, RunningQueries, ServerInfo};
use error::{msg, AppResult};
use projects::{Project, ProjectStore};
use schema::SchemaTree;
use structure::TableStructure;
use ssh::{KnownHosts, SshTunnel};
use store::{saved_password, saved_ssh_secret, ConnectionConfig, ConnectionInput, ConnectionStore};

/// An open connection: the pool and, over SSH, the tunnel that must outlive it.
struct Live {
    pool: DbPool,
    tunnel: Option<SshTunnel>,
}

impl Live {
    async fn close(self) {
        self.pool.close().await;
        if let Some(t) = self.tunnel {
            t.close().await;
        }
    }
}

#[derive(Default)]
struct Pools(Mutex<HashMap<String, Live>>);

impl Pools {
    fn get(&self, id: &str) -> AppResult<DbPool> {
        self.0.lock().unwrap().get(id).map(|l| l.pool.clone()).ok_or_else(|| msg("Not connected"))
    }
}

/// Opens the SSH tunnel (if enabled), then the pool through it.
async fn open_live(cfg: &ConnectionConfig, password: Option<&str>, ssh_secret: Option<&str>, known: Arc<KnownHosts>) -> AppResult<Live> {
    let tunnel = match &cfg.ssh {
        Some(s) if s.enabled => Some(ssh::open(s, ssh_secret, &cfg.host, cfg.port, known).await?),
        _ => None,
    };
    let pool = match DbPool::connect(cfg, password, tunnel.as_ref().map(|t| t.local_port)).await {
        Ok(p) => p,
        // A broken SSH channel explains more than "connection reset"
        Err(e) => return Err(tunnel.as_ref().and_then(|t| t.last_error()).map(msg).unwrap_or(e)),
    };
    Ok(Live { pool, tunnel })
}

#[tauri::command]
fn list_projects(projects: State<'_, ProjectStore>) -> Vec<Project> {
    projects.list()
}

#[tauri::command]
fn save_project(projects: State<'_, ProjectStore>, project: Project) -> AppResult<Project> {
    projects.save(project)
}

/// Deletes a project; its connections are kept, without a project.
#[tauri::command]
fn delete_project(projects: State<'_, ProjectStore>, store: State<'_, ConnectionStore>, id: String) -> AppResult<()> {
    store.clear_project(&id)?;
    projects.delete(&id)
}

#[tauri::command]
fn move_connections(store: State<'_, ConnectionStore>, ids: Vec<String>, project_id: Option<String>) -> AppResult<Vec<ConnectionConfig>> {
    store.set_project(&ids, project_id)
}

#[tauri::command]
fn list_connections(store: State<'_, ConnectionStore>) -> Vec<ConnectionConfig> {
    store.list()
}

#[tauri::command]
fn save_connection(store: State<'_, ConnectionStore>, input: ConnectionInput) -> AppResult<ConnectionConfig> {
    store.save(input)
}

#[tauri::command]
async fn delete_connection(
    store: State<'_, ConnectionStore>,
    pools: State<'_, Pools>,
    id: String,
) -> AppResult<()> {
    let live = pools.0.lock().unwrap().remove(&id);
    if let Some(live) = live {
        live.close().await;
    }
    store.delete(&id)
}

/// Tests connection settings that may not be saved yet.
#[tauri::command]
async fn test_connection(known: State<'_, Arc<KnownHosts>>, input: ConnectionInput) -> AppResult<ServerInfo> {
    let saved = !input.config.id.is_empty();
    let password = match input.password.clone() {
        Some(pw) => Some(pw),
        None if saved => saved_password(&input.config.id)?,
        None => None,
    };
    let ssh_secret = match input.ssh_secret.clone() {
        Some(s) => Some(s),
        None if saved => saved_ssh_secret(&input.config.id)?,
        None => None,
    };
    let live = open_live(&input.config, password.as_deref(), ssh_secret.as_deref(), known.inner().clone()).await?;
    let info = db::server_info(&live.pool, &input.config).await;
    live.close().await;
    info
}

/// `password` is sent only when it isn't saved.
#[tauri::command]
async fn connect(
    store: State<'_, ConnectionStore>,
    pools: State<'_, Pools>,
    known: State<'_, Arc<KnownHosts>>,
    id: String,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> AppResult<ServerInfo> {
    let cfg = store.get(&id)?;
    let password = match password {
        Some(pw) => Some(pw),
        None => saved_password(&id)?,
    };
    let ssh_secret = match ssh_secret {
        Some(s) => Some(s),
        None if cfg.uses_ssh() => saved_ssh_secret(&id)?,
        None => None,
    };
    let live = open_live(&cfg, password.as_deref(), ssh_secret.as_deref(), known.inner().clone()).await?;
    let info = match db::server_info(&live.pool, &cfg).await {
        Ok(info) => info,
        Err(e) => {
            live.close().await;
            return Err(e);
        }
    };
    let old = pools.0.lock().unwrap().insert(id, live);
    if let Some(old) = old {
        old.close().await;
    }
    Ok(info)
}

#[tauri::command]
async fn disconnect(pools: State<'_, Pools>, id: String) -> AppResult<()> {
    let live = pools.0.lock().unwrap().remove(&id);
    if let Some(live) = live {
        live.close().await;
    }
    Ok(())
}

/// Known SSH hosts (host:port -> SHA256 key fingerprint).
#[tauri::command]
fn list_known_hosts(known: State<'_, Arc<KnownHosts>>) -> Vec<(String, String)> {
    known.list()
}

#[tauri::command]
fn forget_known_host(known: State<'_, Arc<KnownHosts>>, host: String) {
    known.forget(&host);
}

#[tauri::command]
async fn get_schema(pools: State<'_, Pools>, id: String) -> AppResult<SchemaTree> {
    schema::load(&pools.get(&id)?).await
}

#[tauri::command]
async fn get_table_structure(pools: State<'_, Pools>, id: String, schema: String, table: String) -> AppResult<TableStructure> {
    structure::load(&pools.get(&id)?, &schema, &table).await
}

#[tauri::command]
async fn list_collations(pools: State<'_, Pools>, id: String) -> AppResult<Vec<String>> {
    let pool = pools.get(&id)?;
    let sql = match pool {
        DbPool::Pg(_) => "select collname from pg_collation where collencoding in (-1, pg_char_to_encoding(current_setting('server_encoding'))) order by 1",
        DbPool::My(_) => "select collation_name from information_schema.collations order by 1",
    };
    Ok(pool.text_rows(sql).await?.into_iter().filter_map(|r| r.into_iter().next().flatten()).collect())
}

#[tauri::command]
async fn run_query(
    pools: State<'_, Pools>,
    running: State<'_, RunningQueries>,
    conn_id: String,
    query_id: String,
    sql: String,
    max_rows: usize,
) -> AppResult<QueryOutput> {
    let pool = pools.get(&conn_id)?;
    db::run_query(&pool, &running, &query_id, sql, max_rows.max(1)).await
}

#[tauri::command]
async fn execute_batch(pools: State<'_, Pools>, conn_id: String, statements: Vec<String>) -> AppResult<Vec<u64>> {
    db::execute_batch(&pools.get(&conn_id)?, &statements).await
}

#[tauri::command]
async fn cancel_query(running: State<'_, RunningQueries>, query_id: String) -> AppResult<bool> {
    running.cancel(&query_id).await
}

#[tauri::command]
async fn explain_query(pools: State<'_, Pools>, conn_id: String, sql: String) -> AppResult<String> {
    db::explain(&pools.get(&conn_id)?, &sql).await
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> AppResult<()> {
    Ok(std::fs::write(path, contents)?)
}

#[tauri::command]
async fn export_xlsx(path: String, columns: Vec<xlsx::XlsxColumn>, rows: Vec<Vec<db::Cell>>, options: xlsx::XlsxOptions) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || xlsx::write(&path, &columns, &rows, &options))
        .await
        .map_err(|e| msg(e.to_string()))?
}

#[tauri::command]
async fn import_dump(
    app: tauri::AppHandle,
    pools: State<'_, Pools>,
    imports: State<'_, import::Imports>,
    conn_id: String,
    job_id: String,
    options: import::ImportOptions,
) -> AppResult<import::ImportSummary> {
    use tauri::Emitter;
    let pool = pools.get(&conn_id)?;
    let emit: import::OnProgress = Arc::new(move |p| {
        let _ = app.emit("import-progress", p);
    });
    import::run(emit, &imports, &pool, job_id, options).await
}

#[tauri::command]
async fn preview_table_file(options: table_import::SourceOptions) -> AppResult<table_import::SourcePreview> {
    tauri::async_runtime::spawn_blocking(move || table_import::preview(&options)).await.map_err(|e| msg(e.to_string()))?
}

#[tauri::command]
async fn import_table_file(
    app: tauri::AppHandle,
    pools: State<'_, Pools>,
    imports: State<'_, import::Imports>,
    conn_id: String,
    job_id: String,
    options: table_import::TableImportOptions,
) -> AppResult<import::ImportSummary> {
    use tauri::Emitter;
    let pool = pools.get(&conn_id)?;
    let emit: import::OnProgress = Arc::new(move |p| {
        let _ = app.emit("import-progress", p);
    });
    table_import::run(emit, &imports, &pool, job_id, options).await
}

#[tauri::command]
fn cancel_import(imports: State<'_, import::Imports>, job_id: String) -> bool {
    imports.cancel(&job_id)
}

#[tauri::command]
fn inspect_dump(path: String) -> AppResult<import::DumpInfo> {
    Ok(import::inspect(&path)?)
}

#[tauri::command]
fn read_text_file(path: String) -> AppResult<String> {
    Ok(std::fs::read_to_string(path)?)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let path = app.path().app_config_dir()?.join("connections.json");
            app.manage(ConnectionStore::load(path)?);
            app.manage(ProjectStore::load(app.path().app_config_dir()?.join("projects.json"))?);
            let known = app.path().app_config_dir()?.join("known_hosts.json");
            app.manage(Arc::new(KnownHosts::load(known)));
            Ok(())
        })
        .manage(Pools::default())
        .manage(RunningQueries::default())
        .manage(import::Imports::default())
        .invoke_handler(tauri::generate_handler![
            list_connections,
            list_projects,
            save_project,
            delete_project,
            move_connections,
            save_connection,
            delete_connection,
            test_connection,
            connect,
            disconnect,
            list_known_hosts,
            forget_known_host,
            get_schema,
            get_table_structure,
            list_collations,
            run_query,
            execute_batch,
            cancel_query,
            explain_query,
            write_text_file,
            export_xlsx,
            import_dump,
            cancel_import,
            preview_table_file,
            import_table_file,
            inspect_dump,
            read_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
