use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::process::CommandExt;


// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

fn expand_tilde(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        home().join(rest)
    } else {
        PathBuf::from(p)
    }
}

/// Start the child in its own session with no controlling terminal, so an interactive
/// shell (or a misbehaving server) can never grab the terminal and stop this app.
fn detach(cmd: &mut Command) {
    #[cfg(unix)]
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
}

/// Runs a command, returning stdout if it exits within `timeout`.
fn output_with_timeout(cmd: &mut Command, timeout: Duration) -> Option<Vec<u8>> {
    detach(cmd);
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    let out = rx.recv_timeout(timeout).ok();
    let _ = child.kill();
    let _ = child.wait();
    out
}

/// The environment a login shell sees (PATH from .zshrc, exported API keys, ...).
/// AI apps started from the terminal see this too, so health checks run with it.
fn shell_env() -> &'static HashMap<String, String> {
    static ENV: OnceLock<HashMap<String, String>> = OnceLock::new();
    ENV.get_or_init(|| {
        let mut env: HashMap<String, String> = std::env::vars().collect();
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let script = "printf '__ENV_START__'; env -0; printf '__ENV_END__'";
        if let Some(out) = output_with_timeout(Command::new(&shell).args(["-ilc", script]), Duration::from_secs(6)) {
            let text = String::from_utf8_lossy(&out).to_string();
            if let (Some(a), Some(b)) = (text.find("__ENV_START__"), text.rfind("__ENV_END__")) {
                for pair in text[a + "__ENV_START__".len()..b].split('\0') {
                    if let Some((k, v)) = pair.split_once('=') {
                        if !k.is_empty() && !k.contains('\n') {
                            env.insert(k.to_string(), v.to_string());
                        }
                    }
                }
            }
        }
        // Common install locations, in case the shell profile misses them.
        let h = home();
        let mut dirs: Vec<String> = env.get("PATH").map(|p| p.split(':').map(String::from).collect()).unwrap_or_default();
        for extra in [
            "/opt/homebrew/bin".to_string(),
            "/usr/local/bin".to_string(),
            h.join(".local/bin").display().to_string(),
            h.join(".cargo/bin").display().to_string(),
            h.join(".bun/bin").display().to_string(),
            h.join(".volta/bin").display().to_string(),
            "/usr/bin".into(),
            "/bin".into(),
            "/usr/sbin".into(),
            "/sbin".into(),
        ] {
            dirs.push(extra);
        }
        let mut seen = std::collections::HashSet::new();
        dirs.retain(|d| !d.is_empty() && seen.insert(d.clone()));
        env.insert("PATH".into(), dirs.join(":"));
        env
    })
}

fn is_executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        p.metadata().map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

fn resolve_command(cmd: &str, cwd: &Path) -> Option<PathBuf> {
    if cmd.contains('/') {
        let mut p = expand_tilde(cmd);
        if p.is_relative() {
            p = cwd.join(p);
        }
        return is_executable(&p).then_some(p);
    }
    let path = shell_env().get("PATH").cloned().unwrap_or_default();
    path.split(':').map(|d| Path::new(d).join(cmd)).find(|p| is_executable(p))
}

/// Replaces ${VAR} / ${VAR:-default} with values from the shell environment.
fn expand_vars(s: &str, extra: &HashMap<String, String>, unresolved: &mut Vec<String>) -> String {
    let env = shell_env();
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let inner = &after[..end];
        let (name, default) = match inner.split_once(":-") {
            Some((n, d)) => (n, Some(d)),
            None => (inner, None),
        };
        let value = extra.get(name).or_else(|| env.get(name)).cloned().or_else(|| default.map(String::from));
        match value {
            Some(v) => out.push_str(&v),
            None => {
                if !unresolved.iter().any(|u| u == name) {
                    unresolved.push(name.to_string());
                }
                out.push_str(&rest[start..start + 3 + end]);
            }
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

// ---------------------------------------------------------------------------
// Reading the machine (read-only)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct ClientInfo {
    id: &'static str,
    installed: bool,
}

fn any_exists(paths: &[PathBuf]) -> bool {
    paths.iter().any(|p| p.exists())
}

fn app(name: &str) -> Vec<PathBuf> {
    vec![PathBuf::from("/Applications").join(name), home().join("Applications").join(name)]
}

/// Which AI apps exist on this machine. Read-only: only checks that paths exist.
#[tauri::command]
fn detect_clients() -> Vec<ClientInfo> {
    let h = home();
    let mut claude_desktop = app("Claude.app");
    claude_desktop.push(h.join("Library/Application Support/Claude/claude_desktop_config.json"));
    let mut cursor = app("Cursor.app");
    cursor.push(h.join(".cursor"));
    vec![
        ClientInfo { id: "claude-desktop", installed: any_exists(&claude_desktop) },
        ClientInfo { id: "claude-code", installed: any_exists(&[h.join(".claude.json"), h.join(".claude")]) },
        ClientInfo { id: "cursor", installed: any_exists(&cursor) },
        ClientInfo { id: "codex", installed: any_exists(&[h.join(".codex")]) },
        ClientInfo { id: "gemini", installed: any_exists(&[h.join(".gemini")]) },
        ClientInfo { id: "chatgpt", installed: any_exists(&app("ChatGPT.app")) },
        ClientInfo { id: "cherry-studio", installed: any_exists(&app("Cherry Studio.app")) },
    ]
}

#[tauri::command]
fn home_dir() -> String {
    home().display().to_string()
}

/// Reads text files under the home folder (config files, SKILL.md, ...). Missing or huge files give null.
#[tauri::command]
fn read_texts(paths: Vec<String>) -> Vec<Option<String>> {
    let h = home();
    paths
        .iter()
        .map(|p| {
            let pb = expand_tilde(p);
            if !pb.starts_with(&h) {
                return None;
            }
            let meta = std::fs::metadata(&pb).ok()?;
            if !meta.is_file() || meta.len() > 8 * 1024 * 1024 {
                return None;
            }
            std::fs::read_to_string(&pb).ok()
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirEntryInfo {
    name: String,
    is_dir: bool,
    is_symlink: bool,
    target: Option<String>,
}

#[tauri::command]
fn list_dir(path: String) -> Vec<DirEntryInfo> {
    let pb = expand_tilde(&path);
    if !pb.starts_with(home()) {
        return vec![];
    }
    let Ok(rd) = std::fs::read_dir(&pb) else { return vec![] };
    let mut out: Vec<DirEntryInfo> = rd
        .flatten()
        .map(|e| {
            let p = e.path();
            let is_symlink = std::fs::symlink_metadata(&p).map(|m| m.file_type().is_symlink()).unwrap_or(false);
            DirEntryInfo {
                name: e.file_name().to_string_lossy().to_string(),
                is_dir: p.is_dir(),
                is_symlink,
                target: if is_symlink { std::fs::canonicalize(&p).ok().map(|t| t.display().to_string()) } else { None },
            }
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

// ---------------------------------------------------------------------------
// Running tools (allow-listed)
// ---------------------------------------------------------------------------

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct CaptureResult {
    found: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

fn allowed_invocation(program: &str, args: &[String]) -> bool {
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    let version = matches!(a.as_slice(), ["--version"] | ["-v"] | ["version"] | ["-V"]);
    match program {
        "node" | "npm" | "npx" | "uv" | "uvx" | "python3" | "git" | "bun" | "codex" | "gemini" => version,
        "docker" => version || matches!(a.as_slice(), ["info", "--format", _]),
        "claude" => {
            version
                || matches!(a.as_slice(), ["plugin", "enable" | "disable" | "install", _])
                || matches!(a.as_slice(), ["plugin", "marketplace", "add", _])
                || matches!(a.as_slice(), ["mcp", "add-json", _, _, "-s", "user" | "local"])
                || matches!(a.as_slice(), ["mcp", "remove", _, "-s", "user" | "local"])
        }
        _ => false,
    }
}

fn capture_blocking(program: String, args: Vec<String>, timeout_ms: u64, cwd: Option<String>) -> CaptureResult {
    let mut r = CaptureResult::default();
    // only folders inside the home folder (project directories)
    let dir = cwd.map(PathBuf::from).filter(|d| d.is_dir() && d.starts_with(home())).unwrap_or_else(home);
    let Some(bin) = resolve_command(&program, &dir) else { return r };
    r.found = true;
    let mut command = Command::new(bin);
    detach(&mut command);
    let mut child = match command
        .args(&args)
        .envs(shell_env())
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            r.stderr = e.to_string();
            return r;
        }
    };
    let out = pipe_reader(child.stdout.take());
    let err = pipe_reader(child.stderr.take());
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                r.code = status.code();
                break;
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(40)),
            _ => {
                r.timed_out = true;
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
        }
    }
    std::thread::sleep(Duration::from_millis(30));
    r.stdout = String::from_utf8_lossy(&out.lock().unwrap()).trim().to_string();
    r.stderr = String::from_utf8_lossy(&err.lock().unwrap()).trim().to_string();
    r
}

fn pipe_reader<R: Read + Send + 'static>(pipe: Option<R>) -> Arc<Mutex<Vec<u8>>> {
    let buf = Arc::new(Mutex::new(Vec::new()));
    if let Some(mut p) = pipe {
        let b = buf.clone();
        std::thread::spawn(move || {
            let mut chunk = [0u8; 4096];
            loop {
                match p.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut g = b.lock().unwrap();
                        g.extend_from_slice(&chunk[..n]);
                        if g.len() > 32 * 1024 {
                            let cut = g.len() - 32 * 1024;
                            g.drain(..cut);
                        }
                    }
                }
            }
        });
    }
    buf
}

/// Version checks and `claude plugin enable/disable`. Anything else is refused.
#[tauri::command]
async fn run_capture(program: String, args: Vec<String>, timeout_ms: u64, cwd: Option<String>) -> CaptureResult {
    if !allowed_invocation(&program, &args) {
        return CaptureResult { stderr: "not allowed".into(), ..Default::default() };
    }
    tauri::async_runtime::spawn_blocking(move || capture_blocking(program, args, timeout_ms, cwd)).await.unwrap_or_default()
}

/// Moves a skill folder (or link) to the Trash. Only direct children of the skill folders are allowed.
#[tauri::command]
fn trash_skill(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let h = home();
    let allowed = [h.join(".claude/skills"), h.join(".agents/skills"), h.join(".codex/skills")];
    if !allowed.iter().any(|a| p.parent() == Some(a.as_path())) {
        return Err("trash-denied".into());
    }
    trash::delete(&p).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Installing (every write is backed up first)
// ---------------------------------------------------------------------------

fn app_data_dir() -> PathBuf {
    home().join("Library/Application Support/ai.cradler.desktop")
}

fn stamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_default()
}

fn writable_configs() -> Vec<PathBuf> {
    let h = home();
    vec![
        h.join("Library/Application Support/Claude/claude_desktop_config.json"),
        h.join(".cursor/mcp.json"),
        h.join(".gemini/settings.json"),
        h.join(".codex/config.toml"),
    ]
}

fn backup(p: &Path) -> Result<Option<String>, String> {
    if !p.exists() {
        return Ok(None);
    }
    let dir = app_data_dir().join("backups").join(stamp());
    std::fs::create_dir_all(&dir).map_err(|e| format!("backup-failed|{e}"))?;
    let rel = p.strip_prefix(home()).unwrap_or(p).display().to_string().replace('/', "__");
    let dest = dir.join(rel);
    std::fs::copy(p, &dest).map_err(|e| format!("backup-failed|{e}"))?;
    Ok(Some(dest.display().to_string()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteResult {
    backup: Option<String>,
}

/// Writes an app's MCP config: backup → temp file → atomic rename.
#[tauri::command]
fn write_config(path: String, content: String) -> Result<WriteResult, String> {
    let p = PathBuf::from(&path);
    let project_mcp = p.file_name().map(|n| n == ".mcp.json").unwrap_or(false) && p.starts_with(home()) && p.is_file();
    if !writable_configs().contains(&p) && !project_mcp {
        return Err("write-denied".into());
    }
    let backup = backup(&p)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_file_name(format!(".{}.kit-{}", p.file_name().unwrap_or_default().to_string_lossy(), stamp()));
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| format!("write-failed|{e}"))?;
    if let Ok(meta) = std::fs::metadata(&p) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    std::fs::rename(&tmp, &p).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("write-failed|{e}")
    })?;
    Ok(WriteResult { backup })
}

/// Saves an edited file inside a skill folder (only files that already exist; account-synced skills excluded).
#[tauri::command]
fn write_skill_file(path: String, content: String) -> Result<WriteResult, String> {
    let p = PathBuf::from(&path);
    let h = home();
    let roots = [h.join(".claude/skills"), h.join(".agents/skills"), h.join(".codex/skills")];
    let canon = std::fs::canonicalize(&p).map_err(|_| "skill-write-denied".to_string())?;
    let inside = |q: &Path| roots.iter().any(|r| q.starts_with(r) && q != r);
    if !p.is_file() || !inside(&p) || !inside(&canon) || canon.components().any(|c| c.as_os_str() == "synced") {
        return Err("skill-write-denied".into());
    }
    let backup = backup(&canon)?;
    let tmp = canon.with_file_name(format!(".{}.kit-{}", canon.file_name().unwrap_or_default().to_string_lossy(), stamp()));
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| format!("write-failed|{e}"))?;
    if let Ok(meta) = std::fs::metadata(&canon) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    std::fs::rename(&tmp, &canon).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("write-failed|{e}")
    })?;
    Ok(WriteResult { backup })
}

/// Copies ~/.claude.json aside before changing it through the Claude Code CLI.
#[tauri::command]
fn backup_claude_json() -> Result<Option<String>, String> {
    backup(&home().join(".claude.json"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillInstallReq {
    owner: String,
    repo: String,
    git_ref: String,
    dir: String,
    files: Vec<String>,
    targets: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillInstallResult {
    target: String,
    ok: bool,
    replaced: bool,
    message: Option<String>,
}

fn encode_path(p: &str) -> String {
    p.split('/')
        .map(|seg| {
            seg.bytes()
                .map(|b| match b {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
                    _ => format!("%{b:02X}"),
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn safe_rel(p: &str) -> bool {
    !p.is_empty() && !p.starts_with('/') && !p.contains('\\') && p.split('/').all(|s| !s.is_empty() && s != "..")
}

fn install_skill_blocking(req: SkillInstallReq) -> Result<Vec<SkillInstallResult>, String> {
    let ok_name = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-._/".contains(c)) && !s.contains("..");
    if !ok_name(&req.owner) || !ok_name(&req.repo) || !ok_name(&req.git_ref) || (!req.dir.is_empty() && !safe_rel(&req.dir)) {
        return Err("skill-bad-source".into());
    }
    if req.files.is_empty() || req.files.len() > 500 || !req.files.iter().all(|f| safe_rel(f)) {
        return Err("skill-bad-files".into());
    }
    let h = home();
    let roots = [h.join(".claude/skills"), h.join(".codex/skills"), h.join(".agents/skills")];
    for t in &req.targets {
        let tp = PathBuf::from(t);
        if !roots.iter().any(|r| tp.parent() == Some(r.as_path())) {
            return Err("skill-bad-target".into());
        }
    }

    // Download once, write to every target.
    let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(10)).timeout(Duration::from_secs(60)).build();
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    let mut total = 0usize;
    for f in &req.files {
        let path = if req.dir.is_empty() { f.clone() } else { format!("{}/{}", req.dir, f) };
        let url = format!("https://raw.githubusercontent.com/{}/{}/{}/{}", req.owner, req.repo, req.git_ref, encode_path(&path));
        let resp = agent.get(&url).call().map_err(|e| format!("download-failed|{f}|{e}"))?;
        let mut buf = Vec::new();
        resp.into_reader().take(20 * 1024 * 1024).read_to_end(&mut buf).map_err(|e| format!("download-failed|{f}|{e}"))?;
        total += buf.len();
        if total > 60 * 1024 * 1024 {
            return Err("skill-too-large".into());
        }
        files.push((f.clone(), buf));
    }

    let mut out = Vec::new();
    for t in &req.targets {
        let target = PathBuf::from(t);
        let root = target.parent().unwrap().to_path_buf();
        let name = target.file_name().unwrap_or_default().to_string_lossy().to_string();
        let result = (|| -> Result<bool, String> {
            std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
            let tmp = root.join(format!(".{name}.installing-{}", stamp()));
            for (rel, bytes) in &files {
                let dest = tmp.join(rel);
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                std::fs::write(&dest, bytes).map_err(|e| e.to_string())?;
            }
            let replaced = std::fs::symlink_metadata(&target).is_ok();
            if replaced {
                // the old version goes to the Trash, so it can be restored
                if let Err(e) = trash::delete(&target) {
                    let _ = std::fs::remove_dir_all(&tmp);
                    return Err(format!("trash-failed|{e}"));
                }
            }
            std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
            Ok(replaced)
        })();
        out.push(match result {
            Ok(replaced) => SkillInstallResult { target: t.clone(), ok: true, replaced, message: None },
            Err(e) => SkillInstallResult { target: t.clone(), ok: false, replaced: false, message: Some(e) },
        });
    }
    Ok(out)
}

#[tauri::command]
async fn install_skill(req: SkillInstallReq) -> Result<Vec<SkillInstallResult>, String> {
    tauri::async_runtime::spawn_blocking(move || install_skill_blocking(req))
        .await
        .map_err(|e| e.to_string())?
}

/// Downloads a Claude Desktop extension (.mcpb) to Downloads and opens it with Claude.
#[tauri::command]
async fn open_extension(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let host_ok = ["https://github.com/", "https://objects.githubusercontent.com/", "https://release-assets.githubusercontent.com/"]
            .iter()
            .any(|p| url.starts_with(p));
        let name = url.rsplit('/').next().unwrap_or("extension.mcpb").to_string();
        if !host_ok || !(name.ends_with(".mcpb") || name.ends_with(".dxt")) || name.contains("..") {
            return Err("extension-denied".into());
        }
        let resp = ureq::get(&url).call().map_err(|e| format!("download-failed||{e}"))?;
        let mut buf = Vec::new();
        resp.into_reader().take(200 * 1024 * 1024).read_to_end(&mut buf).map_err(|e| e.to_string())?;
        let dest = home().join("Downloads").join(&name);
        std::fs::write(&dest, buf).map_err(|e| e.to_string())?;
        Command::new("open").args(["-a", "Claude"]).arg(&dest).status().map_err(|e| e.to_string())?;
        Ok(dest.display().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Downloads the current LTS Node.js installer from nodejs.org and opens it (macOS Installer UI).
#[tauri::command]
async fn install_node() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<String, String> {
        let index: Value = ureq::get("https://nodejs.org/dist/index.json")
            .call()
            .map_err(|e| format!("download-failed||{e}"))?
            .into_string()
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .ok_or_else(|| "download-failed||index.json".to_string())?;
        let version = index
            .as_array()
            .and_then(|list| list.iter().find(|v| v["lts"].is_string()))
            .and_then(|v| v["version"].as_str())
            .ok_or_else(|| "download-failed||no LTS".to_string())?
            .to_string();
        if !version.starts_with('v') || version.contains('/') {
            return Err("download-failed||bad version".into());
        }
        let name = format!("node-{version}.pkg");
        let resp = ureq::get(&format!("https://nodejs.org/dist/{version}/{name}")).call().map_err(|e| format!("download-failed|{name}|{e}"))?;
        let mut buf = Vec::new();
        resp.into_reader().take(300 * 1024 * 1024).read_to_end(&mut buf).map_err(|e| format!("download-failed|{name}|{e}"))?;
        let dest = home().join("Downloads").join(&name);
        std::fs::write(&dest, buf).map_err(|e| format!("write-failed|{e}"))?;
        Command::new("open").arg(&dest).status().map_err(|e| e.to_string())?;
        Ok(version)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Runs uv's official installer script (installs into ~/.local/bin, no admin needed).
#[tauri::command]
async fn install_uv() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<String, String> {
        let script = ureq::get("https://astral.sh/uv/install.sh")
            .call()
            .map_err(|e| format!("download-failed|install.sh|{e}"))?
            .into_string()
            .map_err(|e| format!("download-failed|install.sh|{e}"))?;
        let path = std::env::temp_dir().join(format!("uv-install-{}.sh", stamp()));
        std::fs::write(&path, script).map_err(|e| format!("write-failed|{e}"))?;
        let r = capture_sh(&path, 180_000);
        let _ = std::fs::remove_file(&path);
        if r.code == Some(0) {
            Ok(r.stdout.lines().last().unwrap_or_default().to_string())
        } else {
            Err(format!("install-failed|{}", r.stderr.lines().last().unwrap_or("uv")))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn capture_sh(script: &Path, timeout_ms: u64) -> CaptureResult {
    let mut r = CaptureResult { found: true, ..Default::default() };
    let mut cmd = Command::new("/bin/sh");
    detach(&mut cmd);
    let Ok(mut child) = cmd.arg(script).envs(shell_env()).current_dir(home()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() else {
        return r;
    };
    let out = pipe_reader(child.stdout.take());
    let err = pipe_reader(child.stderr.take());
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                r.code = status.code();
                break;
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                r.timed_out = true;
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
        }
    }
    std::thread::sleep(Duration::from_millis(50));
    r.stdout = String::from_utf8_lossy(&out.lock().unwrap()).trim().to_string();
    r.stderr = String::from_utf8_lossy(&err.lock().unwrap()).trim().to_string();
    r
}

fn app_running(name: &str) -> bool {
    Command::new("osascript")
        .args(["-e", &format!("application \"{name}\" is running")])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false)
}

/// Quits and reopens an AI app so it reloads its MCP config.
#[tauri::command]
async fn restart_app(name: String) -> Result<(), String> {
    if !["Claude", "Cursor", "Cherry Studio", "ChatGPT"].contains(&name.as_str()) {
        return Err("restart-denied".into());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        if app_running(&name) {
            let _ = Command::new("osascript").args(["-e", &format!("quit app \"{name}\"")]).status();
            let until = Instant::now() + Duration::from_secs(10);
            while app_running(&name) {
                if Instant::now() > until {
                    return Err(format!("restart-timeout|{name}"));
                }
                std::thread::sleep(Duration::from_millis(300));
            }
        }
        Command::new("open").args(["-a", &name]).status().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// MCP health checks
// ---------------------------------------------------------------------------

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct ProbeResult {
    ok: bool,
    /// not-found | spawn-failed | exited | timeout | init-error | http-status | network | invalid-response
    error: Option<String>,
    message: Option<String>,
    exit_code: Option<i32>,
    stderr: String,
    stdout_noise: Vec<String>,
    server_name: Option<String>,
    server_version: Option<String>,
    tools: Vec<String>,
    http_status: Option<u16>,
    auth_header: bool,
    unresolved_vars: Vec<String>,
    elapsed_ms: u64,
    resolved_command: Option<String>,
}

fn init_request(id: i64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "kit-health-check", "version": "0.1.0" }
        }
    })
}

fn tail(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut start = s.len() - max;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    s[start..].to_string()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StdioProbeReq {
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    cwd: Option<String>,
    timeout_ms: u64,
}

fn send_line(stdin: &mut ChildStdin, v: &Value) -> bool {
    let mut s = v.to_string();
    s.push('\n');
    stdin.write_all(s.as_bytes()).and_then(|_| stdin.flush()).is_ok()
}

fn kill_tree(pid: u32, child: &mut Child) {
    #[cfg(unix)]
    {
        let _ = Command::new("/bin/kill").args(["-KILL", &format!("-{pid}")]).stderr(Stdio::null()).status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Starts the server exactly like an AI app would, sends `initialize` and `tools/list`, then stops it.
fn probe_stdio_blocking(req: StdioProbeReq) -> ProbeResult {
    let start = Instant::now();
    let mut r = ProbeResult::default();
    let mut unresolved = Vec::new();
    let env: HashMap<String, String> =
        req.env.iter().map(|(k, v)| (k.clone(), expand_vars(v, &HashMap::new(), &mut unresolved))).collect();
    let args: Vec<String> = req.args.iter().map(|a| expand_vars(a, &env, &mut unresolved)).collect();
    let command = expand_vars(&req.command, &env, &mut unresolved);
    r.unresolved_vars = unresolved;

    let cwd = req.cwd.as_deref().map(expand_tilde).filter(|p| p.is_dir()).unwrap_or_else(home);
    let Some(bin) = resolve_command(&command, &cwd) else {
        r.error = Some("not-found".into());
        r.elapsed_ms = start.elapsed().as_millis() as u64;
        return r;
    };
    r.resolved_command = Some(bin.display().to_string());

    let mut cmd = Command::new(&bin);
    cmd.args(&args)
        .env_clear()
        .envs(shell_env())
        .envs(&env)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    detach(&mut cmd); // also makes it a process-group leader, so kill_tree can stop its children

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            r.error = Some("spawn-failed".into());
            r.message = Some(e.to_string());
            r.elapsed_ms = start.elapsed().as_millis() as u64;
            return r;
        }
    };
    let pid = child.id();
    let mut stdin = child.stdin.take().expect("stdin");
    let stdout = child.stdout.take().expect("stdout");
    let err_buf = pipe_reader(child.stderr.take());
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(l) = line else { break };
            if tx.send(l).is_err() {
                break;
            }
        }
    });

    send_line(&mut stdin, &init_request(1));
    let deadline = start + Duration::from_millis(req.timeout_ms);
    let mut initialized = false;
    loop {
        let now = Instant::now();
        if now >= deadline {
            if initialized {
                r.ok = true; // connected; tools/list just slow
            } else {
                r.error = Some("timeout".into());
            }
            break;
        }
        match rx.recv_timeout(deadline - now) {
            Ok(line) => {
                let t = line.trim();
                if t.is_empty() {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(t) else {
                    if r.stdout_noise.len() < 6 {
                        r.stdout_noise.push(tail(t, 300));
                    }
                    continue;
                };
                match v.get("id").and_then(Value::as_i64) {
                    Some(1) if !initialized => {
                        if let Some(err) = v.get("error") {
                            r.error = Some("init-error".into());
                            r.message = err.get("message").and_then(Value::as_str).map(String::from);
                            break;
                        }
                        let info = &v["result"]["serverInfo"];
                        r.server_name = info["name"].as_str().map(String::from);
                        r.server_version = info["version"].as_str().map(String::from);
                        initialized = true;
                        send_line(&mut stdin, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
                        send_line(&mut stdin, &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }));
                    }
                    Some(2) if initialized => {
                        if let Some(tools) = v["result"]["tools"].as_array() {
                            r.tools = tools.iter().filter_map(|t| t["name"].as_str().map(String::from)).collect();
                        }
                        r.ok = true;
                        break;
                    }
                    _ => {} // notifications / requests from the server
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // stdout closed: the process exited
                let wait_until = Instant::now() + Duration::from_millis(800);
                while Instant::now() < wait_until {
                    if let Ok(Some(status)) = child.try_wait() {
                        r.exit_code = status.code();
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(30));
                }
                if initialized {
                    r.ok = true;
                } else {
                    r.error = Some("exited".into());
                }
                break;
            }
        }
    }
    drop(stdin);
    kill_tree(pid, &mut child);
    std::thread::sleep(Duration::from_millis(120));
    r.stderr = tail(String::from_utf8_lossy(&err_buf.lock().unwrap()).trim(), 4000);
    r.elapsed_ms = start.elapsed().as_millis() as u64;
    r
}

#[tauri::command]
async fn probe_stdio(req: StdioProbeReq) -> ProbeResult {
    tauri::async_runtime::spawn_blocking(move || probe_stdio_blocking(req)).await.unwrap_or_default()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HttpProbeReq {
    url: String,
    headers: HashMap<String, String>,
    transport: String,
    timeout_ms: u64,
}

fn read_jsonrpc(resp: ureq::Response, id: i64) -> Option<Value> {
    let ct = resp.content_type().to_string();
    if ct.contains("event-stream") {
        let reader = BufReader::new(resp.into_reader().take(2_000_000));
        for line in reader.lines().take(500) {
            let l = line.ok()?;
            if let Some(d) = l.strip_prefix("data:") {
                if let Ok(v) = serde_json::from_str::<Value>(d.trim()) {
                    if v["id"].as_i64() == Some(id) {
                        return Some(v);
                    }
                }
            }
        }
        None
    } else {
        serde_json::from_str(&resp.into_string().ok()?).ok()
    }
}

fn status_error(r: &mut ProbeResult, code: u16, resp: ureq::Response) {
    r.error = Some("http-status".into());
    r.http_status = Some(code);
    r.auth_header = resp.header("www-authenticate").is_some();
    let mut body = String::new();
    let _ = resp.into_reader().take(600).read_to_string(&mut body);
    r.message = Some(body.trim().to_string());
}

/// Connects to a remote server: POST initialize (streamable HTTP) or open the event stream (SSE).
fn probe_http_blocking(req: HttpProbeReq) -> ProbeResult {
    let start = Instant::now();
    let mut r = ProbeResult::default();
    let mut unresolved = Vec::new();
    let url = expand_vars(&req.url, &HashMap::new(), &mut unresolved);
    let headers: Vec<(String, String)> =
        req.headers.iter().map(|(k, v)| (k.clone(), expand_vars(v, &HashMap::new(), &mut unresolved))).collect();
    r.unresolved_vars = unresolved;
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(8))
        .timeout(Duration::from_millis(req.timeout_ms))
        .build();
    let with_headers = |mut rq: ureq::Request, extra: &[(&str, &str)]| {
        for (k, v) in extra {
            rq = rq.set(k, v);
        }
        for (k, v) in &headers {
            rq = rq.set(k, v);
        }
        rq
    };

    if req.transport == "sse" {
        match with_headers(agent.get(&url), &[("Accept", "text/event-stream")]).call() {
            Ok(resp) => {
                if resp.content_type().contains("event-stream") {
                    r.ok = true;
                } else {
                    r.error = Some("invalid-response".into());
                    r.message = Some(format!("not-event-stream|{}", resp.content_type()));
                }
            }
            Err(ureq::Error::Status(code, resp)) => status_error(&mut r, code, resp),
            Err(ureq::Error::Transport(t)) => {
                r.error = Some("network".into());
                r.message = Some(t.to_string());
            }
        }
        r.elapsed_ms = start.elapsed().as_millis() as u64;
        return r;
    }

    let base = [("Content-Type", "application/json"), ("Accept", "application/json, text/event-stream")];
    match with_headers(agent.post(&url), &base).send_string(&init_request(1).to_string()) {
        Ok(resp) => {
            let session = resp.header("mcp-session-id").map(String::from);
            match read_jsonrpc(resp, 1) {
                Some(v) if v.get("result").is_some() => {
                    let info = &v["result"]["serverInfo"];
                    r.server_name = info["name"].as_str().map(String::from);
                    r.server_version = info["version"].as_str().map(String::from);
                    r.ok = true;
                    let protocol = v["result"]["protocolVersion"].as_str().unwrap_or("2025-06-18").to_string();
                    let mut extra: Vec<(&str, &str)> = base.to_vec();
                    extra.push(("MCP-Protocol-Version", protocol.as_str()));
                    if let Some(s) = session.as_deref() {
                        extra.push(("Mcp-Session-Id", s));
                    }
                    let note = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string();
                    let _ = with_headers(agent.post(&url), &extra).send_string(&note);
                    let list = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }).to_string();
                    if let Ok(resp) = with_headers(agent.post(&url), &extra).send_string(&list) {
                        if let Some(v) = read_jsonrpc(resp, 2) {
                            if let Some(tools) = v["result"]["tools"].as_array() {
                                r.tools = tools.iter().filter_map(|t| t["name"].as_str().map(String::from)).collect();
                            }
                        }
                    }
                }
                Some(v) => {
                    r.error = Some("init-error".into());
                    r.message = v["error"]["message"].as_str().map(String::from);
                }
                None => {
                    r.error = Some("invalid-response".into());
                    r.message = Some("not-mcp".into());
                }
            }
        }
        Err(ureq::Error::Status(code, resp)) => status_error(&mut r, code, resp),
        Err(ureq::Error::Transport(t)) => {
            r.error = Some("network".into());
            r.message = Some(t.to_string());
        }
    }
    r.elapsed_ms = start.elapsed().as_millis() as u64;
    r
}

#[tauri::command]
async fn probe_http(req: HttpProbeReq) -> ProbeResult {
    tauri::async_runtime::spawn_blocking(move || probe_http_blocking(req)).await.unwrap_or_default()
}

// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Warm the shell environment in the background; the first health check needs it.
    std::thread::spawn(|| {
        let _ = shell_env();
    });
    tauri::Builder::default()
        .setup(|app| {
            // Come to the front on launch like a normal Mac app.
            if let Some(w) = tauri::Manager::get_webview_window(app, "main") {
                let _ = w.set_focus();
            }
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            detect_clients,
            home_dir,
            read_texts,
            list_dir,
            run_capture,
            trash_skill,
            probe_stdio,
            probe_http,
            write_config,
            write_skill_file,
            backup_claude_json,
            install_skill,
            open_extension,
            restart_app,
            install_node,
            install_uv
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real download into a throwaway HOME. Run with:
    /// CRADLER_DESKTOP_SKILL_SPEC=/path/spec.json CRADLER_DESKTOP_TEST_HOME=/tmp/x cargo test install_skill_real -- --ignored
    #[test]
    #[ignore]
    fn install_skill_real() {
        let spec: Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("CRADLER_DESKTOP_SKILL_SPEC").unwrap()).unwrap()).unwrap();
        let fake_home = std::env::var("CRADLER_DESKTOP_TEST_HOME").unwrap();
        unsafe { std::env::set_var("HOME", &fake_home) };
        let folder = spec["folder"].as_str().unwrap();
        let targets = vec![
            format!("{fake_home}/.claude/skills/{folder}"),
            format!("{fake_home}/.codex/skills/{folder}"),
        ];
        let req = SkillInstallReq {
            owner: spec["owner"].as_str().unwrap().into(),
            repo: spec["repo"].as_str().unwrap().into(),
            git_ref: spec["gitRef"].as_str().unwrap().into(),
            dir: spec["dir"].as_str().unwrap().into(),
            files: spec["files"].as_array().unwrap().iter().map(|f| f.as_str().unwrap().to_string()).collect(),
            targets: targets.clone(),
        };
        let first = install_skill_blocking(req).expect("install");
        assert!(first.iter().all(|r| r.ok && !r.replaced), "{:?}", first.iter().map(|r| &r.message).collect::<Vec<_>>());
        for t in &targets {
            assert!(Path::new(t).join("SKILL.md").is_file(), "missing SKILL.md in {t}");
        }
        // installing again replaces (old copy goes to the Trash)
        let req2 = SkillInstallReq {
            owner: spec["owner"].as_str().unwrap().into(),
            repo: spec["repo"].as_str().unwrap().into(),
            git_ref: spec["gitRef"].as_str().unwrap().into(),
            dir: spec["dir"].as_str().unwrap().into(),
            files: spec["files"].as_array().unwrap().iter().map(|f| f.as_str().unwrap().to_string()).collect(),
            targets: vec![targets[0].clone()],
        };
        let second = install_skill_blocking(req2).expect("reinstall");
        assert!(second[0].ok && second[0].replaced);
        // refuses targets outside the skill folders
        let bad = SkillInstallReq {
            owner: "a".into(), repo: "b".into(), git_ref: "main".into(), dir: String::new(),
            files: vec!["SKILL.md".into()], targets: vec![format!("{fake_home}/Desktop/x")],
        };
        assert!(install_skill_blocking(bad).is_err());
        // write_config only accepts known config files and backs them up
        assert!(write_config(format!("{fake_home}/.zshrc"), "x".into()).is_err());
        let cursor = format!("{fake_home}/.cursor/mcp.json");
        assert!(write_config(cursor.clone(), "{\"mcpServers\":{}}\n".into()).unwrap().backup.is_none());
        let w = write_config(cursor.clone(), "{\"mcpServers\":{\"a\":{}}}\n".into()).unwrap();
        assert!(w.backup.as_deref().map(|b| std::fs::read_to_string(b).unwrap() == "{\"mcpServers\":{}}\n").unwrap_or(false));
    }

    /// CRADLER_DESKTOP_TEST_HOME=/tmp/x cargo test write_skill_file_rules -- --ignored
    #[test]
    #[ignore]
    fn write_skill_file_rules() {
        let fake_home = std::env::var("CRADLER_DESKTOP_TEST_HOME").unwrap();
        unsafe { std::env::set_var("HOME", &fake_home) };
        let skill = format!("{fake_home}/.claude/skills/demo");
        let synced = format!("{fake_home}/.claude/skills/synced/b/demo2");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::create_dir_all(&synced).unwrap();
        std::fs::write(format!("{skill}/SKILL.md"), "old").unwrap();
        std::fs::write(format!("{synced}/SKILL.md"), "old").unwrap();
        std::fs::write(format!("{fake_home}/notes.md"), "old").unwrap();

        let w = write_skill_file(format!("{skill}/SKILL.md"), "new".into()).expect("edit existing skill file");
        assert_eq!(std::fs::read_to_string(format!("{skill}/SKILL.md")).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(w.backup.unwrap()).unwrap(), "old");

        assert!(write_skill_file(format!("{skill}/new-file.md"), "x".into()).is_err(), "no new files");
        assert!(write_skill_file(format!("{synced}/SKILL.md"), "x".into()).is_err(), "synced is read-only");
        assert!(write_skill_file(format!("{fake_home}/notes.md"), "x".into()).is_err(), "outside skills");
        assert!(write_skill_file(format!("{skill}/../demo/SKILL.md"), "x".into()).is_ok(), "same file via ..");
        // a project .mcp.json that exists can be written; one that doesn't cannot
        std::fs::create_dir_all(format!("{fake_home}/proj")).unwrap();
        std::fs::write(format!("{fake_home}/proj/.mcp.json"), "{}").unwrap();
        assert!(write_config(format!("{fake_home}/proj/.mcp.json"), "{\"mcpServers\":{}}".into()).is_ok());
        assert!(write_config(format!("{fake_home}/other/.mcp.json"), "{}".into()).is_err());
    }
}
