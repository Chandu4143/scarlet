//! Tauri commands exposed to the web UI (apps/web/src/lib/desktop.ts).

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_opener::OpenerExt;

use crate::engine::EngineStatus;
use crate::host::login::LoginStatus;
use crate::host::HostStatus;
use crate::AppState;

#[tauri::command]
pub async fn engine_status(state: State<'_, AppState>) -> Result<EngineStatus, String> {
    Ok(state.engine.status())
}

#[tauri::command]
pub async fn host_status(state: State<'_, AppState>) -> Result<HostStatus, String> {
    Ok(state.host.status().await)
}

#[tauri::command]
pub async fn host_refresh_agents(state: State<'_, AppState>) -> Result<HostStatus, String> {
    Ok(state.host.refresh_agents().await)
}

#[tauri::command]
pub async fn agent_install(state: State<'_, AppState>, agent: String) -> Result<crate::host::install::InstallResult, String> {
    let result = crate::host::install::install(&agent, &state.paths.home).await?;
    if matches!(result, crate::host::install::InstallResult::Installed) {
        state.host.refresh_agents().await;
    }
    Ok(result)
}

/// One-click subscription sign-in for an agent CLI ("claude" or "codex"). The CLI
/// opens the browser; progress arrives on `agent-login://status`.
#[tauri::command]
pub async fn agent_login_start(state: State<'_, AppState>, agent: String) -> Result<LoginStatus, String> {
    state.login.start(&agent).await.map_err(|e| format!("{e:#}"))
}

/// Paste the code from the browser when the automatic hand-off didn't complete (Claude).
#[tauri::command]
pub async fn agent_login_code(state: State<'_, AppState>, agent: String, code: String) -> Result<(), String> {
    if code.trim().is_empty() {
        return Err("empty code".into());
    }
    state.login.submit_code(&agent, &code).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_login_cancel(state: State<'_, AppState>, agent: String) -> Result<(), String> {
    state.login.cancel(&agent).await;
    Ok(())
}

#[tauri::command]
pub fn agent_login_status(state: State<'_, AppState>, agent: String) -> Option<LoginStatus> {
    state.login.status(&agent)
}

/// Open an https link in the system browser (sign-in page fallback).
#[tauri::command]
pub async fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !is_https(&url) {
        return Err("only https links can be opened".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Open Scarlet's data folder or its log folder in Finder / Explorer (Settings, and the page for a Scarlet that can't start).
#[tauri::command]
pub async fn open_path(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<(), String> {
    if !is_own_folder(&path, &state.paths) {
        return Err("only Scarlet's data and log folders can be opened".into());
    }
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

fn is_https(url: &str) -> bool {
    url.starts_with("https://")
}

/// The window opens two folders and nothing else: the data folder and the log folder, by the names Scarlet gave it.
/// Whatever else it sends is refused: the system would open a file in its app, run an app or a script, or follow a link.
fn is_own_folder(path: &str, paths: &crate::config::Paths) -> bool {
    [&paths.data_dir, &paths.log_dir].iter().any(|folder| folder.to_string_lossy() == path)
}

/// The address to download, when it is a file of the engine at `base` and nothing else.
fn engine_file(base: &str, url: &str) -> Result<url::Url, String> {
    let engine = url::Url::parse(base).map_err(|_| "Invalid engine address")?;
    let source = url::Url::parse(url).map_err(|_| "Invalid export address")?;
    if source.origin() != engine.origin() || !source.username().is_empty() || source.password().is_some() || !source.path().starts_with("/api/") {
        return Err("Only files from the Scarlet engine can be saved".into());
    }
    Ok(source)
}

/// The renderer receives a ticket for a user-selected file, never permission to write an arbitrary path.
/// A ticket an export has taken is also saved to disk, so the export can finish after a restart.
#[derive(Default)]
pub struct ExportDestinations {
    file: std::sync::OnceLock<PathBuf>,
    paths: std::sync::Mutex<HashMap<u64, ExportDestination>>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct ExportDestination {
    path: PathBuf,
    /// The partial file a save in progress is writing beside the destination.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    temp: Option<PathBuf>,
    /// The Scarlet writing that file: its process id, then its program and start time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    saver: Option<(u32, String)>,
    #[serde(skip)]
    kept: bool,
}

const EXPORT_ALREADY_SAVING: &str = "Export is already saving in another Scarlet window.";

impl ExportDestination {
    fn saving(&self) -> bool {
        self.saver.as_ref().is_some_and(|(pid, scarlet)| crate::host::spawn::still_runs(*pid, scarlet))
    }

    fn clear_partial(&mut self) {
        self.saver = None;
        if let Some(temp) = self.temp.take() {
            // Only ever a temporary file this app created next to the chosen destination.
            let ours = temp.parent() == self.path.parent()
                && temp.file_name().is_some_and(|name| name.to_string_lossy().starts_with(".tmp"));
            if ours && fs::remove_file(&temp).is_ok() { log::info!("removed a partial export at {}", temp.display()); }
        }
    }
}

impl ExportDestinations {
    /// Restore the destinations of exports that were in progress at the last quit, and remove what a killed save left behind.
    pub fn load(&self, file: PathBuf) {
        let stored = self.file.get_or_init(|| file);
        let loaded = (|| -> io::Result<()> {
            let mut paths = self.paths.lock().map_err(|_| io::Error::other("export destinations unavailable"))?;
            let _lock = Self::lock(stored)?;
            let mut saved = match Self::read(stored) {
                Ok(saved) => saved,
                Err(e) if e.kind() == io::ErrorKind::InvalidData => {
                    log::warn!("export destinations in {} unreadable ({e}); an export under way at the last quit is forgotten", stored.display());
                    HashMap::new()
                }
                Err(e) => return Err(e),
            };
            for destination in saved.values_mut() {
                if !destination.saving() {
                    destination.clear_partial();
                }
            }
            Self::persist(stored, &saved)?;
            *paths = saved;
            Ok(())
        })();
        if let Err(e) = loaded {
            log::warn!("export destinations in {} could not be read or recovered ({e})", stored.display());
        }
    }

    fn start_save(&self, ticket: u64, temp: &Path, saver: (u32, String)) -> Result<bool, String> {
        self.change(|paths| match paths.get_mut(&ticket) {
            Some(destination) if !destination.kept => (Ok(false), false),
            Some(destination) if destination.saving() => (Err(EXPORT_ALREADY_SAVING.to_owned()), false),
            Some(destination) => {
                destination.clear_partial();
                (destination.temp, destination.saver) = (Some(temp.to_path_buf()), Some(saver));
                (Ok(true), true)
            }
            None => (Err("Export destination expired".to_owned()), false),
        })?
    }

    fn finish_save(&self, ticket: u64, temp: &Path, kept: bool, saved: bool) -> Result<(), String> {
        self.change(|paths| {
            let Some(destination) = paths.get_mut(&ticket) else { return ((), false) };
            if kept && destination.temp.as_deref() != Some(temp) { return ((), false) }
            if kept && !saved {
                (destination.temp, destination.saver) = (None, None);
                return ((), true);
            }
            paths.remove(&ticket);
            ((), kept)
        })
    }

    // Lock a separate file that stays put while the destinations record is atomically replaced.
    fn lock(file: &Path) -> io::Result<File> {
        let dir = file.parent().ok_or_else(|| io::Error::other("no folder"))?;
        fs::create_dir_all(dir)?;
        let lock = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(file.with_extension("lock"))?;
        lock.lock()?;
        Ok(lock)
    }

    fn read(file: &Path) -> io::Result<HashMap<u64, ExportDestination>> {
        let raw = match fs::read(file) {
            Ok(raw) => raw,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(HashMap::new()),
            Err(e) => return Err(e),
        };
        let mut saved: HashMap<u64, ExportDestination> = serde_json::from_slice(&raw)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        for destination in saved.values_mut() { destination.kept = true; }
        Ok(saved)
    }

    fn persist(file: &Path, paths: &HashMap<u64, ExportDestination>) -> io::Result<()> {
        let kept: HashMap<_, _> = paths.iter().filter(|(_, d)| d.kept).collect();
        let dir = file.parent().ok_or_else(|| io::Error::other("no folder"))?;
        let mut temp = tempfile::NamedTempFile::new_in(dir)?;
        serde_json::to_writer(&mut temp, &kept)?;
        temp.as_file().sync_all()?;
        temp.persist(file)?;
        Ok(())
    }

    fn change<T>(&self, change: impl FnOnce(&mut HashMap<u64, ExportDestination>) -> (T, bool)) -> Result<T, String> {
        let mut paths = self.paths.lock().map_err(|_| "Export unavailable")?;
        let Some(file) = self.file.get() else { return Ok(change(&mut paths).0) };
        let changed = (|| -> io::Result<T> {
            let _lock = Self::lock(file)?;
            let mut current = Self::read(file)?;
            // Only uncommitted picker selections belong exclusively to this instance.
            current.extend(paths.iter().filter(|(_, d)| !d.kept).map(|(ticket, d)| (*ticket, d.clone())));
            let (value, durable) = change(&mut current);
            if durable { Self::persist(file, &current)?; }
            *paths = current;
            Ok(value)
        })();
        changed.map_err(|e| {
            log::warn!("could not access export destinations: {e}");
            "Export destinations could not be saved or read.".to_string()
        })
    }
}

pub(crate) async fn pick_destination(app: &AppHandle, title: &str, file_name: &str) -> Result<Option<std::path::PathBuf>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<FilePath>>();
    let mut picker = app.dialog().file().set_title(title).set_file_name(file_name);
    if file_name.ends_with(".mp4") {
        picker = picker.add_filter("MP4 video", &["mp4"]);
    } else if file_name.ends_with(".zip") {
        picker = picker.add_filter("Zip archive", &["zip"]);
    } else if file_name.ends_with(".otio") {
        picker = picker.add_filter("OpenTimelineIO timeline", &["otio"]);
    }
    picker.save_file(move |p| { let _ = tx.send(p); });
    rx.await.map_err(|e| e.to_string())?.map(|picked| picked.into_path().map_err(|e| e.to_string())).transpose()
}

#[derive(serde::Serialize)]
pub struct ExportChoice { ticket: u64, path: String }

#[tauri::command]
pub async fn choose_video_export(app: AppHandle, destinations: State<'_, ExportDestinations>, file_name: String) -> Result<Option<ExportChoice>, String> {
    use std::hash::{BuildHasher, Hasher};
    let Some(path) = pick_destination(&app, "Export", &file_name).await? else { return Ok(None) };
    // Random, so a ticket recorded before a restart never names a later choice. 53 bits survive JavaScript.
    let ticket = std::collections::hash_map::RandomState::new().build_hasher().finish() >> 11;
    let shown = path.to_string_lossy().into_owned();
    destinations.change(|paths| { paths.insert(ticket, ExportDestination { path, temp: None, saver: None, kept: false }); ((), false) })?;
    Ok(Some(ExportChoice { ticket, path: shown }))
}

/// An export has taken this destination. Remember it until the export is saved or discarded.
#[tauri::command]
pub fn keep_video_export(destinations: State<'_, ExportDestinations>, ticket: u64) -> Result<(), String> {
    destinations.change(|paths| match paths.get_mut(&ticket) {
        Some(destination) => { destination.kept = true; (Ok(()), true) }
        None => (Err("Export destination expired".to_string()), false),
    })?
}

#[tauri::command]
pub fn discard_video_export(destinations: State<'_, ExportDestinations>, ticket: u64) -> Result<(), String> {
    destinations.change(|paths| { let kept = paths.remove(&ticket).is_some_and(|d| d.kept); ((), kept) })
}

async fn save_engine_file(app: &AppHandle, state: &AppState, url: &str, path: &Path, temp: tempfile::NamedTempFile) -> Result<String, String> {
    use tokio::io::AsyncWriteExt;
    let (file, temp_path) = temp.into_parts();
    let mut file = tokio::io::BufWriter::with_capacity(1024 * 1024, tokio::fs::File::from_std(file));

    // The isolated native demo has no engine. Its only downloadable assets are the sample video and OTIO JSON.
    let mut demo_content = false;
    if crate::is_demo(app) {
        if url.split('#').next() == Some("/sample.mp4") {
            file.write_all(include_bytes!("../../../web/public/sample.mp4")).await.map_err(|e| e.to_string())?;
            demo_content = true;
        } else if let Some(encoded) = url.strip_prefix("data:application/json;charset=utf-8,") {
            let raw = format!("json={}", encoded.replace('+', "%2B"));
            let json = url::form_urlencoded::parse(raw.as_bytes()).next().ok_or("Empty timeline")?.1;
            serde_json::from_str::<serde_json::Value>(&json).map_err(|_| "Invalid timeline")?;
            file.write_all(json.as_bytes()).await.map_err(|e| e.to_string())?;
            demo_content = true;
        }
    }
    if !demo_content {
        let base = state.engine.status().url.ok_or("Not connected to the engine")?;
        let source = engine_file(&base, url)?;
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().map_err(|e| e.to_string())?;
        let mut res = client.get(source).header("x-scarlet-download", "1").send().await.map_err(|e| e.without_url().to_string())?;
        if !res.status().is_success() { return Err(format!("The engine could not deliver the file ({})", res.status())); }
        while let Some(chunk) = res.chunk().await.map_err(|e| e.without_url().to_string())? {
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    // On the disk before it takes the chosen name: after a power cut the file there is whole or isn't there, and an
    // export that isn't there is still owed and saved again at the next launch.
    file.get_ref().sync_all().await.map_err(|e| e.to_string())?;
    drop(file);
    temp_path.persist(path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn finish_video_export(app: AppHandle, state: State<'_, AppState>, destinations: State<'_, ExportDestinations>, ticket: u64, url: String) -> Result<String, String> {
    let path = destinations.change(|paths| (paths.get(&ticket).map(|d| d.path.clone()), false))?.ok_or("Export destination expired")?;
    let parent = path.parent().ok_or("Unsupported save destination")?;
    let temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| format!("Could not write to the chosen folder ({})", e.kind()))?;
    let partial = temp.path().to_path_buf();
    // Process inspection can start PowerShell on Windows. Claim the ticket before writing any bytes.
    let saver = tauri::async_runtime::spawn_blocking(crate::host::spawn::this_scarlet).await.map_err(|e| e.to_string())?;
    let kept = destinations.start_save(ticket, &partial, saver)?;
    let saved = save_engine_file(&app, &state, &url, &path, temp).await;
    // Never where it went: the editor typed the file's name.
    match &saved {
        Ok(_) => log::info!("export saved"),
        Err(e) => log::warn!("export could not be saved: {}", e.replace(&*path.to_string_lossy(), "…")),
    }
    // A save cut short by quitting is retried at the next launch. A returned failure leaves the ticket available for retry.
    // The chosen file is already complete on success. A ledger error is logged separately from that outcome.
    let _ = destinations.finish_save(ticket, &partial, kept, saved.is_ok());
    saved
}

/// One file of the folder an editor takes to another app: its text, or a copy of a file in Scarlet's library.
#[derive(serde::Deserialize)]
#[serde(untagged)]
pub enum HandoffFile {
    Text { path: String, text: String },
    Copy { path: String, source: String },
}

/// A path inside the folder: relative, with no step out of it.
fn inside_folder(path: &str) -> Result<std::path::PathBuf, String> {
    let mut out = std::path::PathBuf::new();
    for part in path.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.contains(['\\', ':']) {
            return Err("The export named a file outside its folder".into());
        }
        out.push(part);
    }
    if out.as_os_str().is_empty() { return Err("The export named a file outside its folder".into()) }
    Ok(out)
}

/// Write the hand-off folder at `dest`: built beside it under a hidden name and renamed into place once whole, so the
/// chosen name never holds half a folder. Copies come only from Scarlet's library. On an APFS volume a copy is a clone.
pub(crate) fn write_handoff_folder(dest: &std::path::Path, files: &[HandoffFile], library: &std::path::Path, demo: bool) -> Result<(), String> {
    if dest.symlink_metadata().is_ok() {
        return Err("Something with that name is already there. Export again and choose another name.".into());
    }
    let parent = dest.parent().ok_or("Unsupported save destination")?;
    let library = library.canonicalize().map_err(|e| format!("Scarlet's library is unavailable ({})", e.kind()))?;
    let stem = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let staging = tempfile::Builder::new().prefix(&format!(".{stem}.scarlet-")).tempdir_in(parent)
        .map_err(|e| format!("Could not write to the chosen folder ({})", e.kind()))?;
    for file in files {
        let path = match file { HandoffFile::Text { path, .. } | HandoffFile::Copy { path, .. } => path };
        let target = staging.path().join(inside_folder(path)?);
        if let Some(dir) = target.parent() { std::fs::create_dir_all(dir).map_err(|e| format!("Could not write the folder ({})", e.kind()))?; }
        match file {
            HandoffFile::Text { text, .. } => std::fs::write(&target, text).map_err(|e| format!("Could not write the folder ({})", e.kind()))?,
            HandoffFile::Copy { source, .. } if demo && source == "/sample.mp4" => {
                std::fs::write(&target, include_bytes!("../../../web/public/sample.mp4")).map_err(|e| format!("Could not copy the footage ({})", e.kind()))?
            }
            HandoffFile::Copy { source, .. } => {
                let from = std::path::Path::new(source).canonicalize().map_err(|e| format!("Could not copy the footage ({})", e.kind()))?;
                if !from.starts_with(&library) { return Err("The export named a file outside Scarlet's library".into()) }
                std::fs::copy(&from, &target).map_err(|e| format!("Could not copy the footage ({})", e.kind()))?;
            }
        }
    }
    let staged = staging.keep();
    std::fs::rename(&staged, dest).map_err(|e| {
        let _ = std::fs::remove_dir_all(&staged);
        format!("Could not save the folder ({})", e.kind())
    })
}

/// Save the folder for finishing the edit in another app where the editor chose, then forget the destination.
#[tauri::command]
pub async fn finish_folder_export(app: AppHandle, state: State<'_, AppState>, destinations: State<'_, ExportDestinations>, ticket: u64, files: Vec<HandoffFile>) -> Result<String, String> {
    let path = destinations.change(|paths| (paths.get(&ticket).map(|d| d.path.clone()), false))?.ok_or("Export destination expired")?;
    let (dest, library, demo) = (path.clone(), state.paths.data_dir.clone(), crate::is_demo(&app));
    let saved = tauri::async_runtime::spawn_blocking(move || write_handoff_folder(&dest, &files, &library, demo)).await.map_err(|e| e.to_string())?;
    // Never where it went: the editor typed the folder's name.
    match &saved {
        Ok(()) => log::info!("export folder saved"),
        Err(e) => log::warn!("export folder could not be saved: {e}"),
    }
    destinations.change(|paths| { let kept = paths.remove(&ticket).is_some_and(|d| d.kept); ((), kept) })?;
    saved.map(|()| path.to_string_lossy().into_owned())
}

/// Show a saved file in Finder / Explorer.
#[tauri::command]
pub async fn reveal_path(app: AppHandle, path: String) -> Result<(), String> {
    app.opener().reveal_item_in_dir(path).map_err(|e| e.to_string())
}

/// The filters Add files offers. A drop takes any file, and the engine reads whatever ffmpeg can. The Mac's panel
/// folds every filter into one list of allowed types, where "*" is a type no file has, so any filter there greys out
/// footage a drop takes (.MTS, .MXF, .aiff, …). On a Mac the picker offers every file, as a drop does. Elsewhere Media,
/// the filter it opens on, names the camera, broadcast, audio and still formats the engine reads, and All files the rest.
fn media_filters(mac: bool) -> &'static [(&'static str, &'static [&'static str])] {
    if mac {
        return &[];
    }
    &[
        ("Media", &[
            "mp4", "mov", "m4v", "mkv", "webm", "avi", "mts", "m2ts", "ts", "mxf", "3gp", "3g2", "wmv", "asf", "mpg", "mpeg", "flv", "ogv",
            "wav", "mp3", "aac", "m4a", "flac", "aif", "aiff", "caf", "ogg", "opus", "wma", "ac3", "eac3", "amr",
            "png", "jpg", "jpeg", "webp", "gif", "heic", "heif", "avif", "bmp", "tif", "tiff",
        ]),
        ("All files", &["*"]),
    ]
}

/// Native multi-select for media import. Returns absolute paths; the UI then
/// asks the engine to import them by path.
#[tauri::command]
pub async fn pick_files(app: AppHandle) -> Result<Vec<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<Vec<FilePath>>>();
    let mut picker = app.dialog().file().set_title("Add files");
    for (name, extensions) in media_filters(cfg!(target_os = "macos")) {
        picker = picker.add_filter(*name, extensions);
    }
    picker.pick_files(move |paths| {
        let _ = tx.send(paths);
    });
    let paths = rx.await.map_err(|e| e.to_string())?.unwrap_or_default();
    Ok(paths
        .into_iter()
        .filter_map(|p| match p {
            FilePath::Path(p) => Some(p.to_string_lossy().to_string()),
            FilePath::Url(u) => u.to_file_path().ok().map(|p| p.to_string_lossy().to_string()),
        })
        .collect())
}

#[derive(serde::Deserialize)]
#[serde(untagged)]
pub enum UiLogMessage {
    Line(String),
    Batch(Vec<String>),
}

/// A renderer flush crosses the native bridge once. Keep each line a separate log record.
#[tauri::command]
pub fn desktop_log(level: Option<String>, message: UiLogMessage) {
    let write = |message: &str| match level.as_deref() {
        Some("error") => log::error!("[ui] {message}"),
        Some("warn") => log::warn!("[ui] {message}"),
        Some("debug") => log::debug!("[ui] {message}"),
        _ => log::info!("[ui] {message}"),
    };
    match message {
        UiLogMessage::Line(line) => write(&line),
        UiLogMessage::Batch(lines) => lines.iter().for_each(|line| write(line)),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopInfo {
    /// Where this copy gets its updates, when it gets any.
    pub updates: Option<crate::updates::Source>,
    pub custom_openai_models: Vec<String>,
    pub custom_claude_models: Vec<String>,
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub config_file: String,
    pub data_dir: String,
    pub work_dir: String,
    pub log_dir: String,
}

#[tauri::command]
pub fn desktop_info(app: AppHandle, state: State<'_, AppState>) -> DesktopInfo {
    DesktopInfo {
        updates: tauri::Manager::try_state::<crate::updates::Source>(&app).map(|source| *source),
        custom_openai_models: state.paths.custom_openai_models(),
        custom_claude_models: state.paths.custom_claude_models(),
        version: env!("CARGO_PKG_VERSION").into(),
        platform: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        config_file: state.paths.config_file.to_string_lossy().to_string(),
        data_dir: state.paths.data_dir.to_string_lossy().to_string(),
        work_dir: state.paths.work_dir.to_string_lossy().to_string(),
        log_dir: state.paths.log_dir.to_string_lossy().to_string(),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn writes_a_handoff_folder_from_the_library_only() {
        use super::{write_handoff_folder, HandoffFile};
        let library = tempfile::tempdir().unwrap();
        std::fs::write(library.path().join("cam.mov"), b"footage").unwrap();
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("Interview");
        let files = vec![
            HandoffFile::Text { path: "Interview.fcpxml".into(), text: "<fcpxml/>".into() },
            HandoffFile::Copy { path: "Media/cam.mov".into(), source: library.path().join("cam.mov").to_string_lossy().into_owned() },
        ];
        write_handoff_folder(&dest, &files, library.path(), false).unwrap();
        assert_eq!(std::fs::read(dest.join("Media/cam.mov")).unwrap(), b"footage");
        assert_eq!(std::fs::read_to_string(dest.join("Interview.fcpxml")).unwrap(), "<fcpxml/>");
        // Never over something already there, never from outside the library, never outside the folder.
        assert!(write_handoff_folder(&dest, &files, library.path(), false).is_err());
        let outside = out.path().join("secret.txt");
        std::fs::write(&outside, b"no").unwrap();
        let stray = vec![HandoffFile::Copy { path: "Media/x".into(), source: outside.to_string_lossy().into_owned() }];
        assert!(write_handoff_folder(&out.path().join("Two"), &stray, library.path(), false).is_err());
        let escape = vec![HandoffFile::Text { path: "../escape.txt".into(), text: "x".into() }];
        assert!(write_handoff_folder(&out.path().join("Three"), &escape, library.path(), false).is_err());
        assert!(!out.path().join("escape.txt").exists());
        // A failed export leaves nothing behind: no folder, no hidden staging folder.
        let names: Vec<_> = std::fs::read_dir(out.path()).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        assert_eq!({ let mut n = names; n.sort(); n }, vec!["Interview".to_string(), "secret.txt".to_string()]);
    }

    use super::*;

    #[test]
    fn two_instances_keep_both_exports_and_do_not_restore_a_discarded_ticket() {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("export-destinations.json");
        let first = ExportDestinations::default();
        let second = ExportDestinations::default();
        first.load(record.clone());
        second.load(record.clone());

        let keep = |app: &ExportDestinations, ticket| {
            app.change(|paths| {
                paths.insert(ticket, ExportDestination {
                    path: dir.path().join(format!("Cut{ticket}.mp4")),
                    temp: None, saver: None, kept: true,
                });
                ((), true)
            }).unwrap();
        };
        let together = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            scope.spawn(|| { together.wait(); keep(&first, 1); });
            together.wait();
            keep(&second, 2);
        });
        let reopened = ExportDestinations::default();
        reopened.load(record.clone());
        for ticket in [1, 2] {
            assert!(reopened.paths.lock().unwrap().contains_key(&ticket));
        }
        reopened.change(|paths| { paths.remove(&1); ((), true) }).unwrap();
        keep(&first, 3);
        let reopened_again = ExportDestinations::default();
        reopened_again.load(record);
        let kept = reopened_again.paths.lock().unwrap();
        assert!(!kept.contains_key(&1));
        assert!(kept.contains_key(&2) && kept.contains_key(&3));
    }

    #[test]
    fn a_second_instance_cannot_take_over_an_active_save() {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("export-destinations.json");
        let first = ExportDestinations::default();
        let second = ExportDestinations::default();
        first.load(record.clone());
        second.load(record);
        first.change(|paths| {
            paths.insert(1, ExportDestination {
                path: dir.path().join("Cut.mp4"), temp: None, saver: None, kept: true,
            });
            ((), true)
        }).unwrap();

        let a = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
        let b = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
        let saver = crate::host::spawn::this_scarlet();
        assert!(first.start_save(1, a.path(), saver.clone()).unwrap());
        assert_eq!(second.start_save(1, b.path(), saver.clone()).unwrap_err(), EXPORT_ALREADY_SAVING);
        second.finish_save(1, b.path(), true, true).unwrap();
        assert!(a.path().exists());
        first.finish_save(1, a.path(), true, false).unwrap();
        assert!(second.start_save(1, b.path(), saver).unwrap());
        second.finish_save(1, b.path(), true, true).unwrap();
        assert_eq!(first.change(|paths| (paths.contains_key(&1), false)), Ok(false));
    }

    #[test]
    fn keeps_an_exports_destination_across_a_restart_and_removes_a_killed_saves_partial_file() {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("export-destinations.json");
        let chosen = dir.path().join("Cut.mp4");
        let partial = dir.path().join(".tmpAbC123");
        let unrelated = dir.path().join("notes.txt");
        std::fs::write(&partial, "partial").unwrap();
        std::fs::write(&unrelated, "keep").unwrap();

        let first = ExportDestinations::default();
        first.load(record.clone());
        first.change(|paths| {
            paths.insert(1, ExportDestination { path: chosen.clone(), temp: Some(partial.clone()), saver: None, kept: true });
            paths.insert(2, ExportDestination { path: dir.path().join("Other.mp4"), temp: Some(unrelated.clone()), saver: None, kept: true });
            paths.insert(3, ExportDestination { path: dir.path().join("Unused.mp4"), temp: None, saver: None, kept: false });
            ((), true)
        }).unwrap();

        let next = ExportDestinations::default();
        next.load(record.clone());
        let paths = next.paths.lock().unwrap();
        assert_eq!(paths.get(&1).map(|d| d.path.clone()), Some(chosen));
        assert!(paths.get(&1).unwrap().temp.is_none());
        assert!(paths.contains_key(&2));
        assert!(!paths.contains_key(&3), "a destination no export took is forgotten");
        assert!(!partial.exists());
        assert!(unrelated.exists(), "only this app's temporary files are removed");
    }

    #[test]
    fn saves_only_files_of_the_running_engine() {
        let engine = "http://127.0.0.1:51234";
        let ok = engine_file(engine, "http://127.0.0.1:51234/api/projects/prj_1/export/final.mp4?token=t").unwrap();
        assert_eq!(ok.path(), "/api/projects/prj_1/export/final.mp4");
        // Another port, host or scheme is another origin, however alike it looks.
        for other in [
            "http://127.0.0.1:51235/api/x",
            "http://localhost:51234/api/x",
            "https://127.0.0.1:51234/api/x",
            "http://127.0.0.1.example.com:51234/api/x",
            "http://127.0.0.1:51234@example.com/api/x",
            "file:///api/x",
        ] {
            assert_eq!(engine_file(engine, other).unwrap_err(), "Only files from the Scarlet engine can be saved", "{other}");
        }
        // The engine's own address with credentials in it, or a path outside its API. A dot segment is resolved
        // before the check, so it can't climb out of /api/.
        for inside in ["http://user@127.0.0.1:51234/api/x", "http://user:pw@127.0.0.1:51234/api/x", "http://127.0.0.1:51234/", "http://127.0.0.1:51234/apix", "http://127.0.0.1:51234/api/../secret"] {
            assert_eq!(engine_file(engine, inside).unwrap_err(), "Only files from the Scarlet engine can be saved", "{inside}");
        }
        assert_eq!(engine_file(engine, "/api/x").unwrap_err(), "Invalid export address");
        assert_eq!(engine_file("not an address", "http://127.0.0.1:51234/api/x").unwrap_err(), "Invalid engine address");
    }

    #[test]
    fn opens_only_https_links() {
        assert!(is_https("https://claude.ai/oauth/authorize?code=true"));
        for other in ["http://example.com", "file:///etc/passwd", "javascript:alert(1)", " https://example.com", "HTTPS://example.com", "", "scarlet://open", "https:/example.com"] {
            assert!(!is_https(other), "{other:?}");
        }
    }

    #[test]
    fn opens_only_scarlets_own_data_and_log_folders() {
        let root = std::path::Path::new("/Users/me/Library/Application Support/com.forwardfuture.scarlet");
        let paths = crate::config::Paths {
            config_file: root.join("desktop.json"),
            data_dir: root.join("data"),
            work_dir: root.join("work"),
            log_dir: "/Users/me/Library/Logs/com.forwardfuture.scarlet".into(),
            resource_dir: None,
            home: "/Users/me".into(),
        };
        let named = |path: &std::path::Path| path.to_string_lossy().into_owned();
        // The two folders the window opens, by the names Scarlet gave it: Settings shows both, and the page for a
        // Scarlet that can't start offers the logs.
        for folder in [&paths.data_dir, &paths.log_dir] {
            assert!(is_own_folder(&named(folder), &paths), "{}", folder.display());
        }
        // Nothing else: a file inside one, a folder above or beside them, another way to spell one, an app, a
        // script, a link.
        let data = named(&paths.data_dir);
        for other in [
            format!("{data}/scarlet.db"), named(root), named(&paths.work_dir), named(&paths.config_file), named(&paths.home),
            format!("{data}/"), format!("{data}/../data"), format!(" {data}"),
            "/Applications/Calculator.app".into(), "/Users/me/Downloads/run.command".into(),
            format!("file://{data}"), "https://example.com".into(), String::new(), " ".into(),
        ] {
            assert!(!is_own_folder(&other, &paths), "{other:?}");
        }
    }

    #[test]
    fn starts_with_no_exports_when_its_record_is_missing_or_damaged() {
        crate::util::test_log::capture();
        let dir = tempfile::tempdir().unwrap();
        // First launch: no record, nothing to say.
        let missing = dir.path().join("first-launch").join("export-destinations.json");
        let fresh = ExportDestinations::default();
        fresh.load(missing.clone());
        assert!(fresh.paths.lock().unwrap().is_empty());
        assert!(crate::util::test_log::find(&["export destinations in", "first-launch"]).is_none());
        // The record is written from then on, in a folder made for it.
        assert_eq!(std::fs::read_to_string(&missing).unwrap(), "{}");

        // Cut off mid-write by a crash: the exports it listed are forgotten, and the log says so.
        let damaged = dir.path().join("damaged-export-destinations.json");
        std::fs::write(&damaged, "{\"1\":{\"path\":\"/Users/me/Cut.mp").unwrap();
        let next = ExportDestinations::default();
        next.load(damaged.clone());
        assert!(next.paths.lock().unwrap().is_empty());
        let (level, _) = crate::util::test_log::find(&["export destinations in", "damaged-export-destinations.json", "unreadable"]).expect("the damaged record was not logged");
        assert_eq!(level, log::Level::Warn);
        // It is usable again at once: a destination an export takes is recorded over the damage.
        next.change(|paths| {
            paths.insert(7, ExportDestination { path: dir.path().join("Cut.mp4"), temp: None, saver: None, kept: true });
            ((), true)
        }).unwrap();
        let again = ExportDestinations::default();
        again.load(damaged);
        assert!(again.paths.lock().unwrap().contains_key(&7));
    }

    #[test]
    fn never_removes_a_recorded_partial_file_that_is_not_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let record = dir.path().join("export-destinations.json");
        // A record that was tampered with names a file in another folder, and one beside the destination that
        // this app would never have named.
        let other_folder = elsewhere.path().join(".tmpAbC123");
        let other_name = dir.path().join("Cut-final.mp4");
        std::fs::write(&other_folder, "theirs").unwrap();
        std::fs::write(&other_name, "theirs").unwrap();
        let saved = serde_json::json!({
            "1": { "path": dir.path().join("Cut.mp4"), "temp": other_folder },
            "2": { "path": dir.path().join("Cut.mp4"), "temp": other_name },
        });
        std::fs::write(&record, saved.to_string()).unwrap();
        let loaded = ExportDestinations::default();
        loaded.load(record);
        assert!(other_folder.exists() && other_name.exists());
        assert_eq!(loaded.paths.lock().unwrap().len(), 2);
    }

    #[test]
    fn leaves_the_partial_file_of_a_save_another_open_scarlet_has_under_way() {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("export-destinations.json");
        let (saving, killed) = (dir.path().join(".tmpSaving"), dir.path().join(".tmpKilled"));
        std::fs::write(&saving, "partial").unwrap();
        std::fs::write(&killed, "partial").unwrap();
        // The installed app and a development preview share this record. One save is under way in a Scarlet that
        // is still open, which this process stands in for. The other was cut short when its Scarlet was killed,
        // and its process id has since gone to a process started at another time.
        let (pid, open) = crate::host::spawn::this_scarlet();
        let gone = format!("{}\nMon Jan  1 00:00:00 2001", open.lines().next().unwrap());
        let saved = serde_json::json!({
            "1": { "path": dir.path().join("Cut.mp4"), "temp": saving, "saver": [pid, open] },
            "2": { "path": dir.path().join("Other.mp4"), "temp": killed, "saver": [pid, gone] },
        });
        std::fs::write(&record, saved.to_string()).unwrap();

        let second = ExportDestinations::default();
        second.load(record.clone());
        assert!(saving.exists(), "the partial file of a save still under way was removed");
        assert!(!killed.exists());
        // Both destinations are taken up: the window lets go of an export whose destination has expired.
        assert_eq!(second.paths.lock().unwrap().len(), 2);
        // The record still says who is writing the partial file, for the launch after this one.
        let kept: serde_json::Value = serde_json::from_slice(&std::fs::read(&record).unwrap()).unwrap();
        assert_eq!((&kept["1"]["temp"], &kept["1"]["saver"]), (&saved["1"]["temp"], &saved["1"]["saver"]));
        assert!(kept["2"].get("temp").is_none() && kept["2"].get("saver").is_none());
    }

    /// Whether a file can be chosen under these filters as the Mac's panel reads them: every filter's extensions merged
    /// into one list of allowed types, compared without case, with "*" one more extension, not any. Given one filter,
    /// it is also whether the Windows panel shows the file under that filter.
    fn panel_takes(filters: &[(&str, &[&str])], name: &str) -> bool {
        let ext = std::path::Path::new(name).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        filters.is_empty() || filters.iter().any(|(_, extensions)| extensions.iter().any(|allowed| allowed.to_lowercase() == ext))
    }

    #[test]
    fn add_files_takes_every_file_a_drop_takes() {
        // Camera and broadcast footage, audio and stills the engine reads, and that a drop on the window takes.
        let footage = ["A001.MTS", "clip.m2ts", "camera.MXF", "phone.3gp", "stream.ts", "old.wmv", "voice.aif", "voice.aiff", "surround.eac3", "photo.heic", "photo.avif", "interview.mp4"];
        for name in footage.iter().chain(&["README"]) {
            assert!(panel_takes(media_filters(true), name), "Add files greys out {name} on a Mac");
        }
        // Elsewhere the panel lists each filter on its own and opens on the first, Media, which takes the same footage.
        // All files is there for the rest.
        let others = media_filters(false);
        for name in footage {
            assert!(panel_takes(&others[..1], name), "Media hides {name}");
        }
        assert!(others.iter().any(|(name, extensions)| *name == "All files" && *extensions == ["*"]));
    }
}
