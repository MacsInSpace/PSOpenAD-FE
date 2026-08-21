mod saved_connections;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::collections::VecDeque;
use std::time::{Duration, Instant};
use tauri::Manager;

static REQUEST_ID: AtomicU64 = AtomicU64::new(1);

struct SidecarState {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
}

/// Most recent sidecar diagnostics, newest last. Capped so a long-running
/// session cannot grow it without bound - the sidecar logs every ladder rung
/// it tries, which adds up over a day of reconnects.
const LOG_CAPACITY: usize = 2000;

#[derive(Clone, Default)]
pub struct SidecarLog {
    lines: Arc<Mutex<VecDeque<String>>>,
}

impl SidecarLog {
    fn push(&self, line: String) {
        if let Ok(mut buf) = self.lines.lock() {
            if buf.len() >= LOG_CAPACITY {
                buf.pop_front();
            }
            buf.push_back(line);
        }
    }

    fn snapshot(&self) -> Vec<String> {
        self.lines
            .lock()
            .map(|b| b.iter().cloned().collect())
            .unwrap_or_default()
    }

    fn clear(&self) {
        if let Ok(mut buf) = self.lines.lock() {
            buf.clear();
        }
    }
}

pub struct AppState {
    sidecar: Mutex<Option<SidecarState>>,
    log: SidecarLog,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sidecar: Mutex::new(None),
            log: SidecarLog::default(),
        }
    }
}

fn repo_root(app: &tauri::AppHandle) -> PathBuf {
    // A packaged app carries sidecar/ and vendor/ under Contents/Resources
    // (bundle.resources in tauri.conf.json), laid out exactly as the repo is,
    // so the sidecar's own relative lookups keep working. Try that first: a
    // Finder-launched app's cwd is "/" and none of the relative candidates
    // below mean anything there.
    if let Ok(res) = app.path().resource_dir() {
        if res.join("sidecar/OpenADSidecar.ps1").exists() {
            return res.canonicalize().unwrap_or(res);
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        let candidates = [cwd.join("../.."), cwd.join(".."), cwd.clone()];
        for c in candidates {
            if c.join("sidecar/OpenADSidecar.ps1").exists() {
                return c.canonicalize().unwrap_or(c);
            }
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Where PowerShell 7 is, or None if it is not installed. Kept separate from
/// resolve_pwsh so the UI can ask the question at startup and explain the
/// answer, rather than the user meeting a bare spawn error on first connect.
fn find_pwsh() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("PWSH_PATH") {
        let p = PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    // An app launched from Finder or Explorer inherits a minimal PATH that
    // does not include where PowerShell installs itself, so `which` fails in
    // exactly the case that matters. Check the installer locations directly.
    const KNOWN: &[&str] = &[
        "/usr/local/bin/pwsh",
        "/opt/homebrew/bin/pwsh",
        "/usr/local/microsoft/powershell/7/pwsh",
        "/usr/bin/pwsh",
        "/snap/bin/pwsh",
        "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    ];
    for k in KNOWN {
        let p = PathBuf::from(k);
        if p.exists() {
            return Some(p);
        }
    }
    let finder = if cfg!(windows) { "where" } else { "which" };
    for name in ["pwsh", "pwsh.exe"] {
        if let Ok(output) = Command::new(finder).arg(name).output() {
            if output.status.success() {
                let first = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if !first.is_empty() {
                    return Some(PathBuf::from(first));
                }
            }
        }
    }
    None
}

#[derive(serde::Serialize)]
struct PwshStatus {
    found: bool,
    path: Option<String>,
    version: Option<String>,
}

/// Is PowerShell 7 installed? The one dependency the bundle cannot carry.
#[tauri::command]
fn pwsh_status() -> PwshStatus {
    match find_pwsh() {
        Some(p) => {
            let version = Command::new(&p)
                .args(["-NoProfile", "-NoLogo", "-Command", "$PSVersionTable.PSVersion.ToString()"])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|v| !v.is_empty());
            PwshStatus { found: true, path: Some(p.display().to_string()), version }
        }
        None => PwshStatus { found: false, path: None, version: None },
    }
}

fn resolve_pwsh() -> PathBuf {
    if let Some(p) = find_pwsh() {
        return p;
    }
    // Last resort so the spawn error names what was looked for.
    PathBuf::from("pwsh")
}

fn ensure_sidecar(state: &AppState, app: &tauri::AppHandle) -> Result<(), String> {
    let mut guard = state.sidecar.lock().map_err(|e| e.to_string())?;
    if let Some(ref mut s) = *guard {
        match s.child.try_wait() {
            Ok(None) => return Ok(()),
            Ok(Some(status)) => {
                *guard = None;
                eprintln!("[sidecar] previous process exited: {status}");
            }
            Err(e) => return Err(format!("sidecar wait error: {e}")),
        }
    }

    let root = repo_root(app);
    let script = root.join("sidecar/OpenADSidecar.ps1");
    if !script.exists() {
        return Err(format!("Sidecar script not found at {}", script.display()));
    }

    let pwsh = resolve_pwsh();
    let mut cmd = Command::new(&pwsh);
    cmd.arg("-NoProfile")
        .arg("-NoLogo")
        .arg("-File")
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .current_dir(&root)
        // Avoid hanging Authenticode / network checks during Import-Module on some hosts
        .env("DOTNET_SYSTEM_NET_HTTP_SOCKETSHTTPHANDLER_HTTP2SUPPORT", "0")
        .env("POWERSHELL_TELEMETRY_OPTOUT", "1");

    if let Ok(module_path) = std::env::var("PSOPENAD_MODULE_PATH") {
        cmd.arg("-ModulePath").arg(module_path);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start pwsh sidecar ({}): {e}", pwsh.display()))?;

    let stdin = child.stdin.take().ok_or("sidecar stdin missing")?;
    let stdout = child.stdout.take().ok_or("sidecar stdout missing")?;
    let stderr = child.stderr.take();

    if let Some(stderr) = stderr {
        // Keep printing to the terminal for `tauri dev`, but also retain the
        // lines so View -> Sidecar Log can show them without a terminal.
        let log = state.log.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                eprintln!("{line}");
                log.push(line);
            }
        });
    }

    let mut stdout = BufReader::new(stdout);
    // Wait for ready handshake so we don't block the UI forever on Import-Module
    let ready_timeout = Duration::from_secs(45);
    let started = Instant::now();
    let mut line = String::new();
    loop {
        if started.elapsed() > ready_timeout {
            let _ = child.kill();
            return Err(
                "PSOpenAD sidecar timed out while starting (Import-Module may be hung on GSSAPI/Kerberos). Try again, or set PSOPENAD_MODULE_PATH to a local build."
                    .into(),
            );
        }
        line.clear();
        match stdout.read_line(&mut line) {
            Ok(0) => {
                let _ = child.kill();
                return Err("PSOpenAD sidecar exited before ready".into());
            }
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
                    if v.get("event").and_then(|e| e.as_str()) == Some("ready") {
                        break;
                    }
                }
                eprintln!("[sidecar] unexpected before ready: {trimmed}");
            }
            Err(e) => {
                let _ = child.kill();
                return Err(format!("reading sidecar ready: {e}"));
            }
        }
    }

    *guard = Some(SidecarState {
        child,
        stdin,
        stdout,
    });
    Ok(())
}

fn call_sidecar(
    state: &AppState,
    app: &tauri::AppHandle,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    ensure_sidecar(state, app)?;

    let id = REQUEST_ID.fetch_add(1, Ordering::SeqCst).to_string();
    let request = json!({
        "id": id,
        "method": method,
        "params": params,
    });
    let line = serde_json::to_string(&request).map_err(|e| e.to_string())?;

    let mut guard = state.sidecar.lock().map_err(|e| e.to_string())?;
    let sidecar = guard.as_mut().ok_or("sidecar not started")?;

    writeln!(sidecar.stdin, "{line}").map_err(|e| format!("write to sidecar: {e}"))?;
    sidecar
        .stdin
        .flush()
        .map_err(|e| format!("flush sidecar: {e}"))?;

    let mut response_line = String::new();
    sidecar
        .stdout
        .read_line(&mut response_line)
        .map_err(|e| format!("read sidecar: {e}"))?;

    if response_line.trim().is_empty() {
        return Err("empty response from sidecar (process may have crashed)".into());
    }

    let response: SidecarResponse = serde_json::from_str(response_line.trim())
        .map_err(|e| format!("invalid sidecar JSON: {e}; body={}", response_line.trim()))?;

    if !response.ok {
        return Err(response
            .error
            .unwrap_or_else(|| "unknown sidecar error".into()));
    }

    Ok(response.result.unwrap_or(Value::Null))
}

async fn invoke_sidecar(
    state: Arc<AppState>,
    app: tauri::AppHandle,
    method: &'static str,
    params: Value,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || call_sidecar(&state, &app, method, params))
        .await
        .map_err(|e| format!("sidecar task failed: {e}"))?
}

#[derive(Debug, Deserialize)]
struct SidecarResponse {
    #[allow(dead_code)]
    id: Option<Value>,
    ok: bool,
    result: Option<Value>,
    error: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    pub server: String,
    pub username: String,
    pub password: String,
    pub domain_key: Option<String>,
    pub label: Option<String>,
    pub ldap_port: Option<u16>,
    pub ldaps_port: Option<u16>,
    pub force_step: Option<String>,
    pub channel: Option<String>,
    pub dc_fqdn: Option<String>,
    pub realm: Option<String>,
}

#[tauri::command]
async fn sidecar_ping(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    invoke_sidecar(Arc::clone(&state), app, "ping", json!({})).await
}

#[tauri::command]
async fn sidecar_ladder(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    invoke_sidecar(Arc::clone(&state), app, "ladder", json!({})).await
}

#[tauri::command]
async fn connect_domain(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    request: ConnectRequest,
) -> Result<Value, String> {
    let params = json!({
        "server": request.server,
        "username": request.username,
        "password": request.password,
        "domainKey": request.domain_key,
        "label": request.label,
        "ldapPort": request.ldap_port,
        "ldapsPort": request.ldaps_port,
        "forceStep": request.force_step,
        "channel": request.channel,
        "dcFqdn": request.dc_fqdn,
        "realm": request.realm,
    });
    invoke_sidecar(Arc::clone(&state), app, "connect", params).await
}

#[tauri::command]
async fn disconnect_domain(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    domain_key: String,
) -> Result<Value, String> {
    invoke_sidecar(
        Arc::clone(&state),
        app,
        "disconnect",
        json!({ "domainKey": domain_key }),
    )
    .await
}

#[tauri::command]
async fn list_sessions(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    invoke_sidecar(Arc::clone(&state), app, "listSessions", json!({})).await
}

#[tauri::command]
async fn get_children(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    domain_key: String,
    search_base: Option<String>,
) -> Result<Value, String> {
    invoke_sidecar(
        Arc::clone(&state),
        app,
        "getChildren",
        json!({
            "domainKey": domain_key,
            "searchBase": search_base,
        }),
    )
    .await
}

#[tauri::command]
async fn list_contents(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    domain_key: String,
    search_base: Option<String>,
    filter: Option<String>,
    limit: Option<u32>,
) -> Result<Value, String> {
    invoke_sidecar(
        Arc::clone(&state),
        app,
        "listContents",
        json!({
            "domainKey": domain_key,
            "searchBase": search_base,
            "filter": filter,
            "limit": limit,
        }),
    )
    .await
}

#[tauri::command]
async fn get_object(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    domain_key: String,
    identity: String,
) -> Result<Value, String> {
    invoke_sidecar(
        Arc::clone(&state),
        app,
        "getObject",
        json!({
            "domainKey": domain_key,
            "identity": identity,
        }),
    )
    .await
}

#[tauri::command]
async fn search_directory(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    domain_key: String,
    kind: String,
    query: Option<String>,
    search_base: Option<String>,
    limit: Option<u32>,
) -> Result<Value, String> {
    invoke_sidecar(
        Arc::clone(&state),
        app,
        "search",
        json!({
            "domainKey": domain_key,
            "kind": kind,
            "query": query,
            "searchBase": search_base,
            "limit": limit,
        }),
    )
    .await
}

#[tauri::command]
async fn get_group_members(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    domain_key: String,
    identity: String,
) -> Result<Value, String> {
    invoke_sidecar(
        Arc::clone(&state),
        app,
        "getGroupMembers",
        json!({
            "domainKey": domain_key,
            "identity": identity,
        }),
    )
    .await
}

#[tauri::command]
async fn get_root_dse(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    domain_key: String,
) -> Result<Value, String> {
    invoke_sidecar(
        Arc::clone(&state),
        app,
        "getRootDse",
        json!({ "domainKey": domain_key }),
    )
    .await
}

#[tauri::command]
async fn probe_password_channel(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    request: ConnectRequest,
) -> Result<Value, String> {
    let params = json!({
        "server": request.server,
        "username": request.username,
        "password": request.password,
        "dcFqdn": request.dc_fqdn,
        "realm": request.realm,
    });
    invoke_sidecar(Arc::clone(&state), app, "probePasswordChannel", params).await
}

#[tauri::command]
async fn set_account_password(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    domain_key: String,
    identity: String,
    password: String,
) -> Result<Value, String> {
    invoke_sidecar(
        Arc::clone(&state),
        app,
        "setPassword",
        json!({
            "domainKey": domain_key,
            "identity": identity,
            "password": password,
        }),
    )
    .await
}

/// Enable or disable an account by flipping ACCOUNT_DISABLE in
/// userAccountControl. A normal attribute write - unlike unicodePwd it needs
/// no confidential channel.
#[tauri::command]
async fn set_account_enabled(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    domain_key: String,
    identity: String,
    enabled: bool,
) -> Result<Value, String> {
    invoke_sidecar(
        Arc::clone(&state),
        app,
        "setAccountEnabled",
        json!({ "domainKey": domain_key, "identity": identity, "enabled": enabled }),
    )
    .await
}

#[tauri::command]
async fn move_object(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    domain_key: String,
    identity: String,
    target_path: String,
) -> Result<Value, String> {
    invoke_sidecar(
        Arc::clone(&state),
        app,
        "moveObject",
        json!({ "domainKey": domain_key, "identity": identity, "targetPath": target_path }),
    )
    .await
}

#[tauri::command]
async fn rename_object(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    domain_key: String,
    identity: String,
    new_name: String,
) -> Result<Value, String> {
    invoke_sidecar(
        Arc::clone(&state),
        app,
        "renameObject",
        json!({ "domainKey": domain_key, "identity": identity, "newName": new_name }),
    )
    .await
}

#[tauri::command]
async fn remove_object(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    domain_key: String,
    identity: String,
) -> Result<Value, String> {
    invoke_sidecar(
        Arc::clone(&state),
        app,
        "removeObject",
        json!({ "domainKey": domain_key, "identity": identity }),
    )
    .await
}

#[tauri::command]
async fn new_object(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    request: Value,
) -> Result<Value, String> {
    invoke_sidecar(Arc::clone(&state), app, "newObject", request).await
}

#[tauri::command]
async fn set_attributes(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    request: Value,
) -> Result<Value, String> {
    invoke_sidecar(Arc::clone(&state), app, "setAttributes", request).await
}

#[tauri::command]
async fn add_group_member(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    domain_key: String,
    group: String,
    members: Vec<String>,
) -> Result<Value, String> {
    invoke_sidecar(
        Arc::clone(&state),
        app,
        "addGroupMember",
        json!({ "domainKey": domain_key, "group": group, "members": members }),
    )
    .await
}

#[tauri::command]
async fn remove_group_member(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    domain_key: String,
    group: String,
    members: Vec<String>,
) -> Result<Value, String> {
    invoke_sidecar(
        Arc::clone(&state),
        app,
        "removeGroupMember",
        json!({ "domainKey": domain_key, "group": group, "members": members }),
    )
    .await
}

/// Sidecar diagnostics for View -> Sidecar Log. Newest last.
#[tauri::command]
fn get_sidecar_log(state: tauri::State<'_, Arc<AppState>>) -> Vec<String> {
    state.log.snapshot()
}

/// Whether the forest has the AD Recycle Bin optional feature switched on.
/// The Deleted Objects node is only offered when it does - without the feature
/// a deleted object is a stripped tombstone and cannot be restored.
#[tauri::command]
async fn get_recycle_bin_state(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    domain_key: String,
) -> Result<Value, String> {
    invoke_sidecar(
        Arc::clone(&state),
        app,
        "getRecycleBinState",
        json!({ "domainKey": domain_key }),
    )
    .await
}

/// Contents of the Deleted Objects container.
#[tauri::command]
async fn list_deleted_objects(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    domain_key: String,
    search_base: Option<String>,
    query: Option<String>,
    limit: Option<u32>,
) -> Result<Value, String> {
    invoke_sidecar(
        Arc::clone(&state),
        app,
        "listDeletedObjects",
        json!({
            "domainKey": domain_key,
            "searchBase": search_base,
            "query": query,
            "limit": limit,
        }),
    )
    .await
}

/// Restore one deleted object. target_path and new_name override where and
/// under what name it comes back, for when the original parent is itself
/// deleted or the name has since been reused.
#[tauri::command]
async fn restore_object(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    domain_key: String,
    identity: String,
    target_path: Option<String>,
    new_name: Option<String>,
) -> Result<Value, String> {
    invoke_sidecar(
        Arc::clone(&state),
        app,
        "restoreObject",
        json!({
            "domainKey": domain_key,
            "identity": identity,
            "targetPath": target_path,
            "newName": new_name,
        }),
    )
    .await
}

/// FSMO role holders, read-only. ADUC's Operations Masters dialog.
#[tauri::command]
async fn get_operations_masters(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    domain_key: String,
) -> Result<Value, String> {
    invoke_sidecar(
        Arc::clone(&state),
        app,
        "getOperationsMasters",
        json!({ "domainKey": domain_key }),
    )
    .await
}

#[tauri::command]
async fn get_service_accounts(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    domain_key: String,
    search_base: Option<String>,
) -> Result<Value, String> {
    invoke_sidecar(
        Arc::clone(&state),
        app,
        "getServiceAccounts",
        json!({ "domainKey": domain_key, "searchBase": search_base }),
    )
    .await
}

/// ADUC's Reset Account for a computer that has lost its trust relationship.
#[tauri::command]
async fn reset_computer_account(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    domain_key: String,
    identity: String,
) -> Result<Value, String> {
    invoke_sidecar(
        Arc::clone(&state),
        app,
        "resetComputerAccount",
        json!({ "domainKey": domain_key, "identity": identity }),
    )
    .await
}

/// ADUC's Copy: a new user from a template, carrying its container, group
/// memberships and role attributes.
#[tauri::command]
async fn copy_object(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    request: Value,
) -> Result<Value, String> {
    invoke_sidecar(Arc::clone(&state), app, "copyObject", request).await
}

/// Real group membership, including nesting and the primary group - which
/// reading memberOf never gives you.
#[tauri::command]
async fn get_group_membership(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    domain_key: String,
    identity: String,
    recursive: bool,
) -> Result<Value, String> {
    invoke_sidecar(
        Arc::clone(&state),
        app,
        "getGroupMembership",
        json!({ "domainKey": domain_key, "identity": identity, "recursive": recursive }),
    )
    .await
}

/// ADUC's Account tab: the userAccountControl checkbox block, plus lockout,
/// must-change-password and account expiry.
#[tauri::command]
async fn get_account_options(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    domain_key: String,
    identity: String,
) -> Result<Value, String> {
    invoke_sidecar(
        Arc::clone(&state),
        app,
        "getAccountOptions",
        json!({ "domainKey": domain_key, "identity": identity }),
    )
    .await
}

#[tauri::command]
async fn set_account_options(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    request: Value,
) -> Result<Value, String> {
    invoke_sidecar(Arc::clone(&state), app, "setAccountOptions", request).await
}

/// ADUC's "Protect object from accidental deletion" - a Deny ACE on the
/// object's DACL, not an attribute.
#[tauri::command]
async fn get_protection(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    domain_key: String,
    identity: String,
) -> Result<Value, String> {
    invoke_sidecar(
        Arc::clone(&state),
        app,
        "getProtection",
        json!({ "domainKey": domain_key, "identity": identity }),
    )
    .await
}

#[tauri::command]
async fn set_protection(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    domain_key: String,
    identity: String,
    protected: bool,
) -> Result<Value, String> {
    invoke_sidecar(
        Arc::clone(&state),
        app,
        "setProtection",
        json!({ "domainKey": domain_key, "identity": identity, "protected": protected }),
    )
    .await
}

/// Current sidecar verbosity, so the viewer can show what is actually set
/// rather than assuming its own defaults.
#[tauri::command]
async fn get_log_options(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    invoke_sidecar(Arc::clone(&state), app, "getLogOptions", json!({})).await
}

/// Toggle sidecar diagnostic verbosity at runtime, no restart needed.
#[tauri::command]
async fn set_log_options(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    verbose: bool,
    include_pwsh: bool,
) -> Result<Value, String> {
    invoke_sidecar(
        Arc::clone(&state),
        app,
        "setLogOptions",
        json!({ "verbose": verbose, "includePwsh": include_pwsh }),
    )
    .await
}

#[tauri::command]
fn clear_sidecar_log(state: tauri::State<'_, Arc<AppState>>) {
    state.log.clear();
}

#[tauri::command]
fn list_saved_connections(app: tauri::AppHandle) -> Result<Vec<saved_connections::SavedConnectionView>, String> {
    saved_connections::list_saved(&app)
}

#[tauri::command]
async fn save_connection(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    request: saved_connections::SaveConnectionRequest,
) -> Result<saved_connections::SavedConnectionView, String> {
    let password = request.password.clone();
    let username = request.username.clone();
    let label = request.label.clone();
    let mut view = saved_connections::save_connection(&app, request)?;
    let id = view.profile.id.clone();

    // The record is on disk without a secret until this succeeds. If the vault
    // write fails the connection is still listed but marked as having no
    // password, which is honest - better than a record claiming a secret that
    // was never stored.
    let stored = invoke_sidecar(
        Arc::clone(&state),
        app.clone(),
        "vaultSetConnectionSecret",
        json!({ "id": id, "username": username, "password": password, "label": label }),
    )
    .await?;

    let secret_ref = stored
        .get("secretName")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if secret_ref.is_empty() {
        return Err("the sidecar stored no secret name for this connection".into());
    }
    saved_connections::set_secret_ref(&app, &id, &secret_ref)?;
    view.profile.secret_ref = Some(secret_ref);
    Ok(view)
}

#[tauri::command]
async fn delete_saved_connection(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    // Remove the secret first; a leftover secret with no record is invisible
    // and would linger in the shared vault forever.
    let _ = invoke_sidecar(
        Arc::clone(&state),
        app.clone(),
        "vaultRemoveConnectionSecret",
        json!({ "id": id }),
    )
    .await;
    saved_connections::delete_connection(&app, &id)
}

/// One-release migration: move any password still in the OS keychain into the
/// vault, deleting the keychain item as it goes. Safe to call repeatedly - a
/// migrated connection has a secret_ref and is skipped.
#[tauri::command]
async fn migrate_saved_connection_secrets(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let pending = saved_connections::take_pending_migrations(&app)?;
    let mut migrated = 0usize;
    let mut failed: Vec<String> = Vec::new();

    for id in pending.unreadable {
        failed.push(format!(
            "{id}: the keychain refused access, so this password could not be moved.              Reconnect and save it again to store it in the vault."
        ));
    }

    for (id, username, password) in pending.ready {
        let res = invoke_sidecar(
            Arc::clone(&state),
            app.clone(),
            "vaultSetConnectionSecret",
            json!({ "id": id, "username": username, "password": password, "label": id }),
        )
        .await;
        match res {
            Ok(v) => {
                let name = v.get("secretName").and_then(|s| s.as_str()).unwrap_or("");
                if name.is_empty() {
                    failed.push(id);
                } else if let Err(e) = saved_connections::set_secret_ref(&app, &id, name) {
                    failed.push(format!("{id}: {e}"));
                } else {
                    migrated += 1;
                }
            }
            Err(e) => failed.push(format!("{id}: {e}")),
        }
    }
    Ok(json!({ "migrated": migrated, "failed": failed }))
}

#[tauri::command]
async fn connect_saved_connection(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: String,
) -> Result<Value, String> {
    let profile = saved_connections::load_for_connect(&app, &id)?;
    // No password crosses this boundary: the sidecar resolves the vault
    // reference itself at connect time.
    let request = ConnectRequest {
        server: profile.server,
        username: profile.username,
        password: String::new(),
        domain_key: Some(profile.domain_key),
        label: Some(profile.label),
        ldap_port: None,
        ldaps_port: None,
        force_step: profile.force_step,
        channel: profile.channel,
        dc_fqdn: profile.dc_fqdn,
        realm: profile.realm,
    };
    let mut params = serde_json::to_value(&request).map_err(|e| e.to_string())?;
    if let Some(obj) = params.as_object_mut() {
        obj.insert("savedConnectionId".into(), Value::String(id.clone()));
    }
    invoke_sidecar(Arc::clone(&state), app, "connect", params).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Arc::new(AppState::new()))
        .invoke_handler(tauri::generate_handler![
            sidecar_ping,
            sidecar_ladder,
            connect_domain,
            disconnect_domain,
            list_sessions,
            get_children,
            list_contents,
            get_object,
            search_directory,
            get_group_members,
            get_root_dse,
            probe_password_channel,
            set_account_password,
            list_saved_connections,
            save_connection,
            delete_saved_connection,
            connect_saved_connection,
            migrate_saved_connection_secrets,
            get_sidecar_log,
            clear_sidecar_log,
            set_log_options,
            get_log_options,
            copy_object,
            get_operations_masters,
            get_recycle_bin_state,
            pwsh_status,
            list_deleted_objects,
            restore_object,
            get_service_accounts,
            reset_computer_account,
            get_group_membership,
            get_account_options,
            set_account_options,
            get_protection,
            set_protection,
            set_account_enabled,
            move_object,
            rename_object,
            remove_object,
            new_object,
            set_attributes,
            add_group_member,
            remove_group_member,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
