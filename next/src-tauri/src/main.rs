#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    ffi::OsString,
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::Duration,
};
use tauri::Manager;
mod updates;

const DEFAULT_PORT: u16 = 4321;
struct WorkspacePort(u16);
const HEALTH_ATTEMPTS: usize = 80;
const HEALTH_RETRY: Duration = Duration::from_millis(100);

#[derive(Debug, PartialEq)]
struct SupervisorIdentity {
    revision: String,
    data_dir: String,
}

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

fn supervisor_path_from(
    node: &std::path::Path,
    current: Option<OsString>,
    home: Option<PathBuf>,
) -> Result<OsString, String> {
    let mut entries = vec![node
        .parent()
        .ok_or_else(|| "Bundled Node runtime has no parent directory".to_string())?
        .to_path_buf()];
    if let Some(current) = current {
        entries.extend(std::env::split_paths(&current));
    }
    entries.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    if let Some(home) = home {
        entries.extend([
            home.join(".local/bin"),
            home.join(".npm-global/bin"),
            home.join("Library/pnpm"),
        ]);
    }
    std::env::join_paths(entries)
        .map_err(|_| "Could not prepare PaneForge supervisor PATH".to_string())
}

fn supervisor_path(node: &std::path::Path) -> Result<OsString, String> {
    supervisor_path_from(
        node,
        std::env::var_os("PATH"),
        std::env::var_os("HOME").map(PathBuf::from),
    )
}

fn runtime_revision(root: &std::path::Path) -> String {
    fs::read_to_string(root.join("runtime-revision.txt"))
        .ok()
        .map(|revision| revision.trim().to_string())
        .filter(|revision| !revision.is_empty())
        .unwrap_or_else(|| "unversioned".to_string())
}

fn health_identity(response: &str) -> Result<SupervisorIdentity, String> {
    let (status, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| "PaneForge supervisor returned an incomplete health response".to_string())?;
    if !status.starts_with("HTTP/1.1 200") && !status.starts_with("HTTP/1.0 200") {
        let response_status: String = status.lines().next().unwrap_or_default()
            .chars().filter(|c| !c.is_control()).take(120).collect();
        return Err(format!(
            "The selected loopback port is occupied by a process that is not a ready PaneForge supervisor ({response_status})"
        ));
    }
    let health: serde_json::Value = serde_json::from_str(body).map_err(|_| {
        "The selected loopback port returned an invalid PaneForge health response".to_string()
    })?;
    if health.get("product").and_then(serde_json::Value::as_str) != Some("paneforge-next") {
        return Err(
            "The selected loopback port is occupied by a different application".to_string(),
        );
    }
    let revision = health
        .get("revision")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "PaneForge health response has no revision".to_string())?;
    let data_dir = health
        .get("dataDir")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "PaneForge health response has no data profile".to_string())?;
    Ok(SupervisorIdentity {
        revision: revision.to_string(),
        data_dir: data_dir.to_string(),
    })
}

fn probe_supervisor_at(address: SocketAddr) -> Result<Option<SupervisorIdentity>, String> {
    let mut stream = match TcpStream::connect_timeout(&address, Duration::from_millis(150)) {
        Ok(stream) => stream,
        Err(_) => return Ok(None),
    };
    stream
        .set_read_timeout(Some(Duration::from_millis(300)))
        .map_err(|error| format!("Could not read PaneForge health: {error}"))?;
    // This bounded probe reads until close, without an HTTP chunk decoder.
    // HTTP/1.0 makes Node use that framing even when Content-Length is absent.
    stream
        .write_all(
            format!("GET /api/health HTTP/1.0\r\nHost: {address}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .map_err(|_| {
            "The selected loopback port closed before its supervisor identity could be read"
                .to_string()
        })?;
    let mut response = String::new();
    stream.read_to_string(&mut response).map_err(|_| {
        "The selected loopback port did not provide a complete supervisor health response"
            .to_string()
    })?;
    health_identity(&response).map(Some)
}

fn probe_supervisor(port: u16) -> Result<Option<SupervisorIdentity>, String> {
    let address: SocketAddr = format!("127.0.0.1:{port}")
        .parse()
        .map_err(|_| "PaneForge has an invalid loopback address".to_string())?;
    probe_supervisor_at(address)
}

fn require_matching_supervisor(
    actual: SupervisorIdentity,
    revision: &str,
    data: &std::path::Path,
) -> Result<(), String> {
    let expected_data = data.to_string_lossy();
    if actual.revision == revision && actual.data_dir == expected_data {
        return Ok(());
    }
    Err(format!(
        "The selected loopback port is occupied by a different PaneForge supervisor (revision {}, data profile {}). It was left running.",
        actual.revision, actual.data_dir
    ))
}

fn wait_for_supervisor(revision: &str, data: &std::path::Path, port: u16) -> Result<(), String> {
    for _ in 0..HEALTH_ATTEMPTS {
        match probe_supervisor(port)? {
            Some(actual) => return require_matching_supervisor(actual, revision, data),
            None => thread::sleep(HEALTH_RETRY),
        }
    }
    Err("PaneForge supervisor did not become healthy on its selected loopback port within 8 seconds; it was left running for a later retry.".to_string())
}

fn supervisor_data(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate PaneForge data storage: {error}"))?
        .join("supervisor"))
}

fn saved_supervisor_port(data: &std::path::Path) -> Result<Option<u16>, String> {
    match fs::read_to_string(data.join("native-supervisor-port")) {
        Ok(value) => value
            .trim()
            .parse::<u16>()
            .ok()
            .filter(|port| *port >= 1024)
            .map(Some)
            .ok_or_else(|| {
                "Saved supervisor port is invalid; profile was left untouched".to_string()
            }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read saved supervisor port: {error}")),
    }
}

// A recorded endpoint is authoritative: if it is busy but cannot prove its identity,
// fail closed instead of starting a second executor over the same profile.
fn select_supervisor_port(
    data: &std::path::Path,
    revision: &str,
    preferred: u16,
) -> Result<(u16, bool), String> {
    if let Some(port) = saved_supervisor_port(data)? {
        return match probe_supervisor(port)? {
            Some(actual) => {
                require_matching_supervisor(actual, revision, data)?;
                Ok((port, true))
            }
            None => Ok((port, false)),
        };
    }
    if let Ok(Some(actual)) = probe_supervisor(preferred) {
        if actual.data_dir == data.to_string_lossy() {
            require_matching_supervisor(actual, revision, data)?;
            return Ok((preferred, true));
        }
    }
    // Reserve an available endpoint while choosing it. The supervisor binds next;
    // a bind race fails startup and can never attach the window to another app.
    let listener = TcpListener::bind(("127.0.0.1", preferred))
        .or_else(|_| TcpListener::bind(("127.0.0.1", 0)))
        .map_err(|error| format!("Could not allocate a loopback port: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    Ok((port, false))
}

fn start_supervisor(app: &tauri::AppHandle) -> Result<u16, String> {
    let root = runtime_root(app)?;
    let node = node_path(&root);
    if !node.is_file() {
        return Err(
            "PaneForge Next is incomplete: its bundled Node runtime is missing".to_string(),
        );
    }
    let data = supervisor_data(app)?;
    fs::create_dir_all(&data)
        .map_err(|error| format!("Could not create PaneForge data storage: {error}"))?;
    let launch_lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(data.join("native-supervisor-launch.lock"))
        .map_err(|error| error.to_string())?;
    launch_lock.try_lock().map_err(|_| {
        "Another Next launch is already checking this profile; retry when it finishes".to_string()
    })?;
    let revision = runtime_revision(&root);
    let (port, reuse) = select_supervisor_port(&data, &revision, DEFAULT_PORT)?;
    fs::write(data.join("native-supervisor-port"), port.to_string())
        .map_err(|error| error.to_string())?;
    if reuse {
        return Ok(port);
    }
    let path = supervisor_path(&node)?;
    let mut child = Command::new(&node)
        .arg(root.join("scripts/start.mjs"))
        .current_dir(&root)
        .env("PANEFORGE_PORT", port.to_string())
        .env("PANEFORGE_DATA_DIR", &data)
        .env("PANEFORGE_DIST_DIR", root.join("dist"))
        .env("PANEFORGE_REVISION", &revision)
        .env("PANEFORGE_NOTIFICATIONS", "1")
        .env("PANEFORGE_NATIVE_CONTROL", "1")
        .env("PATH", path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            format!("PaneForge Next could not start its bundled supervisor: {error}")
        })?;
    // Reap an owned supervisor when it exits, including idle update shutdown.
    thread::spawn(move || {
        let _ = child.wait();
    });
    wait_for_supervisor(&revision, &data, port)?;
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct PortProfile(PathBuf);
    impl PortProfile {
        fn new() -> Self {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path =
                std::env::temp_dir().join(format!("next-port-{}-{nonce}", std::process::id()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for PortProfile {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn foreign_listener_keeps_its_port_while_next_selects_another() {
        let profile = PortProfile::new();
        let foreign = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = foreign.local_addr().unwrap().port();
        let (selected, reuse) = select_supervisor_port(&profile.0, "test", port).unwrap();
        assert_ne!(selected, port);
        assert!(!reuse);
        assert!(TcpListener::bind(("127.0.0.1", port)).is_err());
    }

    #[test]
    fn recorded_unresponsive_endpoint_fails_closed() {
        let profile = PortProfile::new();
        let foreign = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = foreign.local_addr().unwrap().port();
        fs::write(profile.0.join("native-supervisor-port"), port.to_string()).unwrap();
        assert!(select_supervisor_port(&profile.0, "test", 0).is_err());
    }

    #[test]
    fn invalid_saved_endpoint_is_not_replaced() {
        let profile = PortProfile::new();
        for value in ["0", "22", "65536", "invalid"] {
            fs::write(profile.0.join("native-supervisor-port"), value).unwrap();
            assert!(select_supervisor_port(&profile.0, "test", 0).is_err());
            assert_eq!(
                fs::read_to_string(profile.0.join("native-supervisor-port")).unwrap(),
                value
            );
        }
    }

    #[test]
    fn saved_endpoint_reuses_only_exact_profile_and_revision() {
        for saved in [false, true] {
            for matching in [false, true] {
                let profile = PortProfile::new();
                let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
                let port = listener.local_addr().unwrap().port();
                if saved {
                    fs::write(profile.0.join("native-supervisor-port"), port.to_string()).unwrap();
                }
                let body = serde_json::json!({"product":"paneforge-next", "revision": if matching { "test" } else { "old" }, "dataDir": profile.0.to_string_lossy()}).to_string();
                let responder = thread::spawn(move || {
                    let (mut stream, _) = listener.accept().unwrap();
                    let mut request = [0; 1024];
                    stream.read(&mut request).unwrap();
                    write!(stream, "HTTP/1.0 200 OK\r\n\r\n{body}").unwrap();
                });
                let result = select_supervisor_port(&profile.0, "test", port);
                responder.join().unwrap();
                if matching {
                    assert_eq!(result.unwrap(), (port, true));
                } else {
                    assert!(result.unwrap_err().contains("left running"));
                }
            }
        }
    }

    #[test]
    fn accepts_matching_health_identity() {
        let identity = health_identity("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"product\":\"paneforge-next\",\"revision\":\"abc\",\"dataDir\":\"/tmp/pane\"}").unwrap();
        assert_eq!(
            identity,
            SupervisorIdentity {
                revision: "abc".to_string(),
                data_dir: "/tmp/pane".to_string()
            }
        );
    }

    #[test]
    fn rejects_unrelated_health_identity() {
        let error = health_identity("HTTP/1.1 200 OK\r\n\r\n{\"product\":\"other\",\"revision\":\"abc\",\"dataDir\":\"/tmp/pane\"}").unwrap_err();
        assert!(error.contains("different application"));
    }

    #[test]
    fn failed_health_reports_status_without_response_body() {
        let error = health_identity("HTTP/1.1 403 Forbidden\r\nsecret: private\r\n\r\nprivate response").unwrap_err();
        assert!(error.contains("HTTP/1.1 403 Forbidden"));
        assert!(!error.contains("private"));
    }

    #[test]
    fn reuses_only_matching_revision_and_data_profile() {
        let data = std::path::Path::new("/tmp/pane");
        let matching = SupervisorIdentity {
            revision: "abc".to_string(),
            data_dir: "/tmp/pane".to_string(),
        };
        assert!(require_matching_supervisor(matching, "abc", data).is_ok());
        let mismatched = SupervisorIdentity {
            revision: "other".to_string(),
            data_dir: "/tmp/pane".to_string(),
        };
        assert!(require_matching_supervisor(mismatched, "abc", data)
            .unwrap_err()
            .contains("left running"));
    }

    #[test]
    fn finder_like_path_keeps_bundled_node_and_codex_locations() {
        let path = supervisor_path_from(
            std::path::Path::new("/bundle/runtime/node/node"),
            Some(OsString::from("/usr/bin:/bin")),
            Some(PathBuf::from("/Users/tester")),
        )
        .unwrap();
        let entries: Vec<_> = std::env::split_paths(&path).collect();
        assert_eq!(entries[0], PathBuf::from("/bundle/runtime/node"));
        assert!(entries.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(entries.contains(&PathBuf::from("/Users/tester/.local/bin")));
        assert!(entries.contains(&PathBuf::from("/Users/tester/.npm-global/bin")));
        assert!(entries.contains(&PathBuf::from("/Users/tester/Library/pnpm")));
    }

    #[test]
    fn probes_loopback_health_over_a_socket() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let responder = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 512];
            let _ = stream.read(&mut request).unwrap();
            stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n{\"product\":\"paneforge-next\",\"revision\":\"abc\",\"dataDir\":\"/tmp/pane\"}").unwrap();
        });
        let identity = probe_supervisor_at(address).unwrap().unwrap();
        responder.join().unwrap();
        assert_eq!(identity.revision, "abc");
    }

    #[test]
    fn probes_real_node_health_without_chunk_framing() {
        use std::io::BufRead;
        // Match the supervisor's writeHead/end response, leaving the real Node
        // HTTP server to choose its wire framing. A hand-written response hid
        // the HTTP/1.1 chunking failure in the original socket-only test.
        let script = r#"
            const http = require('node:http');
            const server = http.createServer((req, res) => {
                res.writeHead(200, {'content-type': 'application/json', 'cache-control': 'no-store'});
                res.end(JSON.stringify({product:'paneforge-next', revision:'node-proof', dataDir:'/tmp/pane'}));
            });
            server.listen(0, '127.0.0.1', () => console.log(server.address().port));
            setTimeout(() => { server.closeAllConnections(); server.close(); }, 5000);
        "#;
        struct Fixture(std::process::Child);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let mut fixture = Fixture(
            Command::new("node")
                .args(["-e", script])
                .stdout(Stdio::piped())
                .spawn()
                .expect("Node is required to verify the bundled supervisor protocol"),
        );
        let mut port = String::new();
        std::io::BufReader::new(fixture.0.stdout.take().unwrap())
            .read_line(&mut port)
            .unwrap();
        let address = format!("127.0.0.1:{}", port.trim()).parse().unwrap();
        let identity = probe_supervisor_at(address).unwrap().unwrap();
        assert_eq!(identity.revision, "node-proof");
        assert_eq!(identity.data_dir, "/tmp/pane");
    }
}

fn is_workspace_origin(webview: &tauri::Webview) -> Result<(), String> {
    let url = webview
        .url()
        .map_err(|error| format!("Could not validate the voice window: {error}"))?;
    if url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port_or_known_default() == Some(webview.state::<WorkspacePort>().0)
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![request_microphone_permission])
        .setup(|app| {
            let port = start_supervisor(&app.handle())
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?;
            app.manage(WorkspacePort(port));
            let mut window = app.config().app.windows[0].clone();
            window.url = tauri::WebviewUrl::External(format!("http://127.0.0.1:{port}").parse()?);
            tauri::WebviewWindowBuilder::from_config(app, &window)?.build()?;
            updates::start(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("PaneForge Next could not start");
}
