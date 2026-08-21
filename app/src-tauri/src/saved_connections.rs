//! Saved AD connections: non-secret records on disk, passwords in the shared
//! secret vault (see the shared secret vault design: the Rust host keeps no secrets.
//!
//! The record holds a `secretRef` - the vault name the sidecar resolves at
//! connect time - never the password itself. Nothing here calls an OS
//! credential store; the `keyring` use that remains is migration-only and is
//! removed after one release.
//!
//! - Profiles: `{appDataDir}/saved-connections.json` (no secrets)
//! - Passwords: OS credential store via `keyring`
//!   (macOS Keychain / Windows Credential Manager / Linux Secret Service)

use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const SERVICE: &str = "app.psopenad.desktop";
const STORE_FILE: &str = "saved-connections.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnection {
    pub id: String,
    pub label: String,
    pub domain_key: String,
    pub server: String,
    pub username: String,
    #[serde(default)]
    pub channel: Option<String>,
    #[serde(default)]
    pub force_step: Option<String>,
    #[serde(default)]
    pub dc_fqdn: Option<String>,
    #[serde(default)]
    pub realm: Option<String>,
    #[serde(default)]
    pub saved_at: Option<String>,
    /// Vault reference, e.g. `ad/connection/<id>`. Never the password.
    #[serde(default)]
    pub secret_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnectionView {
    #[serde(flatten)]
    pub profile: SavedConnection,
    /// True when a vault reference exists. Whether the secret still resolves
    /// is the sidecar's business, not the frontend's.
    pub has_password: bool,
    /// Set while a legacy keychain item is still waiting to be migrated.
    pub needs_migration: bool,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct StoreFile {
    connections: Vec<SavedConnection>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveConnectionRequest {
    pub id: Option<String>,
    pub label: String,
    pub domain_key: String,
    pub server: String,
    pub username: String,
    pub password: String,
    pub channel: Option<String>,
    pub force_step: Option<String>,
    pub dc_fqdn: Option<String>,
    pub realm: Option<String>,
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create app data dir: {e}"))?;
    Ok(dir.join(STORE_FILE))
}

fn read_store(app: &AppHandle) -> Result<StoreFile, String> {
    let path = store_path(app)?;
    if !path.exists() {
        return Ok(StoreFile::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read saved connections: {e}"))?;
    if raw.trim().is_empty() {
        return Ok(StoreFile::default());
    }
    serde_json::from_str(&raw).map_err(|e| format!("parse saved connections: {e}"))
}

fn write_store(app: &AppHandle, store: &StoreFile) -> Result<(), String> {
    let path = store_path(app)?;
    let raw =
        serde_json::to_string_pretty(store).map_err(|e| format!("serialize connections: {e}"))?;
    fs::write(&path, raw).map_err(|e| format!("write saved connections: {e}"))
}

fn credential_entry(id: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, &format!("connection:{id}"))
        .map_err(|e| format!("keychain entry: {e}"))
}

#[allow(dead_code)]
fn get_password(id: &str) -> Result<String, String> {
    credential_entry(id)?
        .get_password()
        .map_err(|e| format!("read password from keychain: {e}"))
}

fn delete_password(id: &str) -> Result<(), String> {
    match credential_entry(id)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("delete keychain password: {e}")),
    }
}

fn now_iso() -> String {
    // Prefer a simple UTC-ish stamp without extra deps.
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

pub fn list_saved(app: &AppHandle) -> Result<Vec<SavedConnectionView>, String> {
    let store = read_store(app)?;
    Ok(store
        .connections
        .into_iter()
        .map(|profile| {
            // Deliberately NO keychain probe here. Reading an item prompts, and
            // this runs every time the connect dialog opens. Migration is the
            // only thing allowed to touch the keychain, and it runs once.
            let has_password = profile.secret_ref.is_some();
            SavedConnectionView {
                profile,
                has_password,
                needs_migration: false,
            }
        })
        .collect())
}

pub fn save_connection(app: &AppHandle, req: SaveConnectionRequest) -> Result<SavedConnectionView, String> {
    if req.server.trim().is_empty() {
        return Err("server is required".into());
    }
    if req.username.trim().is_empty() {
        return Err("username is required".into());
    }
    if req.password.is_empty() {
        return Err("password is required to save credentials".into());
    }

    let domain_key = if req.domain_key.trim().is_empty() {
        req.server.trim().to_string()
    } else {
        req.domain_key.trim().to_string()
    };
    let id = req
        .id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(domain_key.as_str())
        .to_string();

    let profile = SavedConnection {
        id: id.clone(),
        label: if req.label.trim().is_empty() {
            domain_key.clone()
        } else {
            req.label.trim().to_string()
        },
        domain_key,
        server: req.server.trim().to_string(),
        username: req.username.trim().to_string(),
        channel: req.channel,
        force_step: req.force_step,
        dc_fqdn: req.dc_fqdn,
        realm: req.realm,
        saved_at: Some(now_iso()),
        // Filled in by the caller once the sidecar has stored the secret.
        secret_ref: None,
    };


    let mut store = read_store(app)?;
    if let Some(existing) = store.connections.iter_mut().find(|c| c.id == id) {
        *existing = profile.clone();
    } else {
        store.connections.push(profile.clone());
    }
    write_store(app, &store)?;

    Ok(SavedConnectionView {
        profile,
        has_password: true,
        needs_migration: false,
    })
}

/// Record the vault reference once the sidecar has stored the secret. Split
/// from `save_connection` because only the command layer can reach the sidecar.
pub fn set_secret_ref(app: &AppHandle, id: &str, secret_ref: &str) -> Result<(), String> {
    let mut store = read_store(app)?;
    let found = store.connections.iter_mut().find(|c| c.id == id);
    match found {
        Some(c) => {
            c.secret_ref = Some(secret_ref.to_string());
            write_store(app, &store)
        }
        None => Err(format!("no saved connection with id '{id}'")),
    }
}

/// Outcome of the one-time keychain sweep.
pub struct PendingMigrations {
    /// Readable legacy passwords, as (id, username, password).
    pub ready: Vec<(String, String, String)>,
    /// Connections whose keychain item exists but could not be read - almost
    /// always because the access prompt was denied. These must be reported,
    /// not skipped: silently ignoring them means the prompt returns on every
    /// launch forever and the operator never learns why.
    pub unreadable: Vec<String>,
}

/// Legacy keychain passwords still awaiting migration. Reading one deletes it,
/// so this is safe to call repeatedly: an already-migrated connection has a
/// secret_ref and is skipped entirely.
pub fn take_pending_migrations(app: &AppHandle) -> Result<PendingMigrations, String> {
    let store = read_store(app)?;
    let mut ready = Vec::new();
    let mut unreadable = Vec::new();

    for c in store.connections.iter().filter(|c| c.secret_ref.is_none()) {
        match get_password(&c.id) {
            Ok(password) => {
                // Delete straight away: an item left behind is a prompt next
                // launch, which is the whole reason for this migration.
                let _ = delete_password(&c.id);
                ready.push((c.id.clone(), c.username.clone(), password));
            }
            Err(e) => {
                // No entry at all is fine - nothing to migrate. Anything else
                // means we were refused, and the operator has to know.
                if !e.contains("NoEntry") && !e.to_lowercase().contains("no entry") {
                    unreadable.push(c.id.clone());
                }
            }
        }
    }
    Ok(PendingMigrations { ready, unreadable })
}

pub fn delete_connection(app: &AppHandle, id: &str) -> Result<(), String> {
    let mut store = read_store(app)?;
    let before = store.connections.len();
    store.connections.retain(|c| c.id != id);
    if store.connections.len() == before {
        // Still try to clear orphaned keychain entry
        let _ = delete_password(id);
        return Err(format!("no saved connection '{id}'"));
    }
    write_store(app, &store)?;
    let _ = delete_password(id);
    Ok(())
}

pub fn load_for_connect(app: &AppHandle, id: &str) -> Result<SavedConnection, String> {
    let store = read_store(app)?;
    store
        .connections
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| format!("no saved connection with id '{id}'"))
}
