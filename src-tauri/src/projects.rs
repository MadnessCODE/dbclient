//! Projects group connections (name, color, icon); stored in projects.json.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    /// Palette color key, e.g. "blue"
    #[serde(default)]
    pub color: Option<String>,
    /// {"type":"lucide","name":"Rocket"} | {"type":"emoji","value":"🚀"} | {"type":"image","dataUrl":"data:..."}
    #[serde(default)]
    pub icon: serde_json::Value,
}

pub struct ProjectStore {
    path: PathBuf,
    items: Mutex<Vec<Project>>,
}

impl ProjectStore {
    pub fn load(path: PathBuf) -> AppResult<Self> {
        let items = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        Ok(Self { path, items: Mutex::new(items) })
    }

    pub fn list(&self) -> Vec<Project> {
        self.items.lock().unwrap().clone()
    }

    pub fn save(&self, mut project: Project) -> AppResult<Project> {
        if project.id.is_empty() {
            project.id = uuid::Uuid::new_v4().to_string();
        }
        let mut items = self.items.lock().unwrap();
        match items.iter_mut().find(|p| p.id == project.id) {
            Some(existing) => *existing = project.clone(),
            None => items.push(project.clone()),
        }
        self.persist(&items)?;
        Ok(project)
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        let mut items = self.items.lock().unwrap();
        items.retain(|p| p.id != id);
        self.persist(&items)
    }

    fn persist(&self, items: &[Project]) -> AppResult<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(items)?)?;
        std::fs::rename(tmp, &self.path)?;
        Ok(())
    }
}
