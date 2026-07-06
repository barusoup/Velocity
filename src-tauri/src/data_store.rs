use std::collections::HashMap;
use std::path::PathBuf;
use serde::{Serialize, Deserialize};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

const SCHEMA_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct UserDataFile {
    schema_version: u32,
    data: HashMap<String, serde_json::Value>,
}

pub struct DataFileLock(pub Mutex<()>);

impl Default for DataFileLock {
    fn default() -> Self {
        Self(Mutex::new(()))
    }
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    Ok(root.join("data"))
}

fn data_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("user-data.json"))
}

async fn load_raw(app: &AppHandle) -> Result<UserDataFile, String> {
    let path = data_file(app)?;
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Failed to read user data: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse user data: {e}"))
}

async fn save_raw(app: &AppHandle, store: &UserDataFile) -> Result<(), String> {
    let dir = data_dir(app)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Failed to create data dir: {e}"))?;
    let path = data_file(app)?;
    let content = serde_json::to_string_pretty(store)
        .map_err(|e| format!("Failed to serialize user data: {e}"))?;
    tokio::fs::write(&path, content)
        .await
        .map_err(|e| format!("Failed to write user data: {e}"))?;
    Ok(())
}

pub async fn load_all(app: &AppHandle) -> Result<HashMap<String, String>, String> {
    let path = data_file(app)?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let store = load_raw(app).await?;
    Ok(store
        .data
        .into_iter()
        .map(|(k, v)| (k, serde_json::to_string(&v).unwrap_or_default()))
        .collect())
}

pub async fn write(app: &AppHandle, key: &str, data: &str) -> Result<(), String> {
    let mut store = load_raw(app).await.unwrap_or(UserDataFile {
        schema_version: SCHEMA_VERSION,
        data: HashMap::new(),
    });
    let value: serde_json::Value =
        serde_json::from_str(data).unwrap_or(serde_json::Value::String(data.to_string()));
    store.data.insert(key.to_string(), value);
    save_raw(app, &store).await
}

pub async fn delete(app: &AppHandle, key: &str) -> Result<(), String> {
    let mut store = load_raw(app).await.unwrap_or(UserDataFile {
        schema_version: SCHEMA_VERSION,
        data: HashMap::new(),
    });
    store.data.remove(key);
    save_raw(app, &store).await
}

pub async fn clear_all(app: &AppHandle) -> Result<(), String> {
    save_raw(
        app,
        &UserDataFile {
            schema_version: SCHEMA_VERSION,
            data: HashMap::new(),
        },
    )
    .await
}
