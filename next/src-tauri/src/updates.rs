//! Native-only signed updates. Browser state never receives the stop capability.
use super::*;
use serde_json::{json, Value};
use std::{fs::OpenOptions, path::Path};
use tauri_plugin_updater::UpdaterExt;

fn config<'a>(
    endpoint: Option<&'a str>,
    key: Option<&'a str>,
) -> Result<Option<(tauri::Url, &'a str)>, String> {
    match (
        endpoint.filter(|s| !s.is_empty()),
        key.filter(|s| !s.is_empty()),
    ) {
        (None, None) => Ok(None),
        (Some(url), Some(key)) if url.starts_with("https://") => Ok(Some((
            url.parse()
                .map_err(|error| format!("Invalid update feed: {error}"))?,
            key,
        ))),
        _ => Err("Native updates require an HTTPS feed and a signing public key".into()),
    }
}

fn save(data: &Path, state: &Value) -> Result<(), String> {
    let temp = data.join("native-update-state.tmp");
    fs::write(&temp, serde_json::to_vec(state).map_err(|e| e.to_string())?)
        .and_then(|_| fs::rename(temp, data.join("native-update-state.json")))
        .map_err(|e| format!("Could not persist native update status: {e}"))
}

fn stop_response(response: &str, revision: &str) -> Result<Option<u32>, String> {
    let (headers, body) = response
        .split_once("\r\n\r\n")
        .ok_or("Incomplete stop response")?;
    let status = headers
        .lines()
        .next()
        .unwrap_or("")
        .split_whitespace()
        .nth(1);
    if status == Some("409") {
        return Ok(None);
    }
    if status != Some("200") {
        return Err("Supervisor refused native update shutdown".into());
    }
    let reply: Value = serde_json::from_str(body).map_err(|e| e.to_string())?;
    let pid = reply["supervisorPid"]
        .as_u64()
        .filter(|pid| *pid > 1 && *pid <= u32::MAX as u64);
    if reply["stopping"] != true || reply["revision"].as_str() != Some(revision) || pid.is_none() {
        return Err("Invalid supervisor shutdown identity".into());
    }
    Ok(pid.map(|pid| pid as u32))
}

fn stop_idle(data: &Path, revision: &str) -> Result<Option<u32>, String> {
    let actual = probe_supervisor()?.ok_or("Supervisor is unavailable for safe shutdown")?;
    require_matching_supervisor(actual, revision, data)?;
    let token =
        fs::read_to_string(data.join(".native-control-token")).map_err(|e| e.to_string())?;
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Native supervisor capability is invalid".into());
    }
    let address = format!("127.0.0.1:{PORT}")
        .parse()
        .map_err(|_| "Invalid supervisor address")?;
    let mut stream =
        TcpStream::connect_timeout(&address, Duration::from_secs(2)).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| e.to_string())?;
    write!(stream,"POST /api/native-update/stop HTTP/1.0\r\nHost: 127.0.0.1:{PORT}\r\nAuthorization: Bearer {token}\r\nx-paneforge-revision: {revision}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").map_err(|e| e.to_string())?;
    let mut response = String::new();
    stream
        .take(65536)
        .read_to_string(&mut response)
        .map_err(|e| e.to_string())?;
    stop_response(&response, revision)
}

fn await_exit(node: &Path, pid: u32) -> Result<(), String> {
    // This helper exits before installation, releasing the bundled Windows Node binary.
    let status = Command::new(node).args(["-e", "const pid=Number(process.argv[1]),end=Date.now()+12000;const check=()=>{try{process.kill(pid,0)}catch(e){process.exit(e.code==='ESRCH'?0:2)}if(Date.now()>=end)process.exit(3);setTimeout(check,100)};check()", &pid.to_string()])
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("Old supervisor exit was not verified; installation was cancelled".into())
    }
}

pub(super) fn start(app: tauri::AppHandle) {
    thread::spawn(move || {
        if let Err(error) = run(&app) {
            eprintln!("Native updater: {error}");
        }
    });
}

fn run(app: &tauri::AppHandle) -> Result<(), String> {
    let data = supervisor_data(app)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(data.join("native-updater.lock"))
        .map_err(|e| e.to_string())?;
    if lock.try_lock().is_err() {
        return Ok(());
    }
    let root = runtime_root(app)?;
    let revision = runtime_revision(&root);
    let version = app.package_info().version.to_string();
    let prior: Value = fs::read(data.join("native-update-state.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null);
    let mut state = json!({"automatic":false,"ownerPid":std::process::id(),"version":version,"revision":revision,"phase":"disabled","lastAttempt":prior["lastAttempt"]});
    if state["lastAttempt"]["phase"] == "installing" {
        // setup already verified this exact revision and data profile before starting us.
        state["lastAttempt"]["phase"] = if state["lastAttempt"]["version"] == version {
            json!("healthy")
        } else {
            json!("unverified")
        };
    }
    let configuration = config(
        option_env!("PANEFORGE_UPDATE_ENDPOINT"),
        option_env!("PANEFORGE_UPDATE_PUBLIC_KEY"),
    );
    if let Err(ref error) = configuration {
        state["phase"] = json!("failed");
        state["error"] = json!(error);
    }
    save(&data, &state)?;
    let Some((endpoint, key)) = configuration? else {
        return Ok(());
    };
    let updater = (|| {
        app.updater_builder()
            .pubkey(key)
            .endpoints(vec![endpoint])
            .map_err(|error| error.to_string())?
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| error.to_string())
    })();
    let updater = match updater {
        Ok(updater) => updater,
        Err(error) => {
            state["phase"] = json!("failed");
            state["error"] = json!(error);
            save(&data, &state)?;
            return Err(error);
        }
    };
    state["automatic"] = json!(true);
    loop {
        state["phase"] = json!("checking");
        state["error"] = Value::Null;
        save(&data, &state)?;
        let result: Result<(), String> = (|| {
            let Some(update) =
                tauri::async_runtime::block_on(updater.check()).map_err(|e| e.to_string())?
            else {
                state["phase"] = json!("current");
                return save(&data, &state);
            };
            state["phase"] = json!("downloading");
            state["availableVersion"] = json!(update.version);
            save(&data, &state)?;
            let bytes = tauri::async_runtime::block_on(update.download(|_, _| {}, || {}))
                .map_err(|e| e.to_string())?;
            // Signature verification completed before any request to stop work.
            state["phase"] = json!("waiting-for-idle");
            save(&data, &state)?;
            let pid = loop {
                if let Some(pid) = stop_idle(&data, &revision)? {
                    break pid;
                }
                thread::sleep(Duration::from_secs(60));
            };
            if let Err(error) = await_exit(&node_path(&root), pid) {
                return Err(format!("{error}; recovery: {:?}", start_supervisor(app)));
            }
            state["phase"] = json!("installing");
            state["lastAttempt"] =
                json!({"version":update.version,"fromVersion":version,"phase":"installing"});
            if let Err(error) = save(&data, &state) {
                return Err(format!("{error}; recovery: {:?}", start_supervisor(app)));
            }
            if let Err(error) = update.install(bytes) {
                state["lastAttempt"]["phase"] = json!("failed");
                return Err(format!(
                    "Installer failed: {error}; recovery: {:?}",
                    start_supervisor(app)
                ));
            }
            app.restart();
        })();
        if let Err(error) = result {
            state["phase"] = json!("failed");
            state["error"] = json!(error);
            save(&data, &state)?;
        }
        thread::sleep(Duration::from_secs(1800));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persisted_status_replaces_existing_receipt() {
        let dir =
            std::env::temp_dir().join(format!("paneforge-update-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        save(&dir, &json!({"phase":"downloading"})).unwrap();
        save(&dir, &json!({"phase":"installing"})).unwrap();
        let stored: Value =
            serde_json::from_slice(&fs::read(dir.join("native-update-state.json")).unwrap())
                .unwrap();
        assert_eq!(stored["phase"], "installing");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn waits_for_real_child_exit() {
        let mut child = Command::new("node")
            .args(["-e", "setTimeout(()=>{},150)"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        let reaper = thread::spawn(move || child.wait().unwrap());
        await_exit(Path::new("node"), pid).unwrap();
        assert!(reaper.join().unwrap().success());
    }

    #[test]
    fn configuration_fails_closed() {
        assert_eq!(config(None, None).unwrap(), None);
        assert!(config(Some("http://example.com"), Some("key")).is_err());
        assert!(config(Some("https://[invalid"), Some("key")).is_err());
        assert!(config(Some("https://example.com"), None).is_err());
        assert!(config(Some("https://example.com"), Some("key"))
            .unwrap()
            .is_some());
    }
    #[test]
    fn shutdown_requires_exact_identity() {
        assert_eq!(
            stop_response("HTTP/1.0 409 Conflict\r\n\r\n{}", "a").unwrap(),
            None
        );
        let reply =
            "HTTP/1.0 200 OK\r\n\r\n{\"stopping\":true,\"revision\":\"a\",\"supervisorPid\":123}";
        assert_eq!(stop_response(reply, "a").unwrap(), Some(123));
        assert!(stop_response(reply, "b").is_err());
        assert!(stop_response("HTTP/1.0 200 OK\r\n\r\n{}", "a").is_err());
        assert!(stop_response("HTTP/1.0 403 Forbidden\r\n\r\n{}", "a").is_err());
    }
}
