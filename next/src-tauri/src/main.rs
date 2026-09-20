#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    path::PathBuf,
    process::{Command, Stdio},
};
use tauri::Manager;

const PORT: &str = "4321";

fn runtime_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Could not locate PaneForge resources: {error}"))?
        .join("runtime");
    if !root.join("scripts/start.mjs").is_file() || !root.join("dist/index.html").is_file() {
        return Err(
            "PaneForge Next is incomplete: its bundled supervisor or frontend is missing"
                .to_string(),
        );
    }
    Ok(root)
}

fn node_path(root: &std::path::Path) -> PathBuf {
    root.join("node")
        .join(if cfg!(windows) { "node.exe" } else { "node" })
}

fn runtime_revision(root: &std::path::Path) -> String {
    fs::read_to_string(root.join("runtime-revision.txt"))
        .ok()
        .map(|revision| revision.trim().to_string())
        .filter(|revision| !revision.is_empty())
        .unwrap_or_else(|| "unversioned".to_string())
}

fn start_supervisor(app: &tauri::AppHandle) -> Result<(), String> {
    let root = runtime_root(app)?;
    let node = node_path(&root);
    if !node.is_file() {
        return Err(
            "PaneForge Next is incomplete: its bundled Node runtime is missing".to_string(),
        );
    }
    let data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate PaneForge data storage: {error}"))?
        .join("supervisor");
    fs::create_dir_all(&data)
        .map_err(|error| format!("Could not create PaneForge data storage: {error}"))?;
    Command::new(node)
        .arg(root.join("scripts/start.mjs"))
        .current_dir(&root)
        .env("PANEFORGE_PORT", PORT)
        .env("PANEFORGE_DATA_DIR", data)
        .env("PANEFORGE_DIST_DIR", root.join("dist"))
        .env("PANEFORGE_REVISION", runtime_revision(&root))
        .env("PANEFORGE_NOTIFICATIONS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            format!("PaneForge Next could not start its bundled supervisor: {error}")
        })?;
    Ok(())
}

fn is_workspace_origin(webview: &tauri::Webview) -> Result<(), String> {
    let url = webview
        .url()
        .map_err(|error| format!("Could not validate the voice window: {error}"))?;
    if url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port_or_known_default() == Some(4321)
    {
        Ok(())
    } else {
        Err("Microphone permission can only be requested from the PaneForge workspace".to_string())
    }
}

#[cfg(target_os = "macos")]
fn microphone_authorization_status() -> &'static str {
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
    let audio =
        unsafe { AVMediaTypeAudio }.expect("AVFoundation provides an audio media type on macOS");
    match unsafe { AVCaptureDevice::authorizationStatusForMediaType(audio) } {
        AVAuthorizationStatus::Authorized => "granted",
        AVAuthorizationStatus::Denied => "denied",
        AVAuthorizationStatus::Restricted => "restricted",
        AVAuthorizationStatus::NotDetermined => "not-determined",
        _ => "restricted",
    }
}

#[cfg(target_os = "macos")]
fn request_native_microphone_permission(app: tauri::AppHandle) -> Result<&'static str, String> {
    use objc2_av_foundation::{AVCaptureDevice, AVMediaTypeAudio};
    use std::sync::mpsc;
    match microphone_authorization_status() {
        "granted" | "denied" | "restricted" => return Ok(microphone_authorization_status()),
        "not-determined" => {}
        _ => return Ok("restricted"),
    }
    let (sender, receiver) = mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let audio = unsafe { AVMediaTypeAudio }
            .expect("AVFoundation provides an audio media type on macOS");
        let completion = block2::RcBlock::new(move |_| {
            let _ = sender.send(());
        });
        unsafe {
            AVCaptureDevice::requestAccessForMediaType_completionHandler(audio, &completion);
        }
    })
    .map_err(|error| format!("Could not request microphone permission: {error}"))?;
    receiver
        .recv_timeout(std::time::Duration::from_secs(60))
        .map_err(|_| "Timed out waiting for the macOS microphone decision".to_string())?;
    Ok(microphone_authorization_status())
}

#[tauri::command]
async fn request_microphone_permission(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<String, String> {
    is_workspace_origin(&webview)?;
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || request_native_microphone_permission(app))
            .await
            .map_err(|error| format!("Microphone permission request ended unexpectedly: {error}"))?
            .map(str::to_owned)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Native microphone permission is only available in macOS PaneForge Next".to_string())
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![request_microphone_permission])
        .setup(|app| {
            start_supervisor(&app.handle())
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error).into())
        })
        .run(tauri::generate_context!())
        .expect("PaneForge Next could not start");
}
