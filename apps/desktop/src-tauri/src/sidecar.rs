//! Application API を sidecar として起動し、待ち受け先を確定させ、終了時に止める。
//!
//! 起動エントリの引数と標準出力の書式は `docs/operations/api-sidecar.md` に置く。
//! 待ち受け先を画面へ渡す条件は `docs/operations/web-api-base-url.md` に合わせる。

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::oneshot;
use tokio::time::{sleep, timeout};
use url::{Host, Url};

use crate::managed_sidecar::{self, ManagedChild};

/// 実行ファイル名のみ。`tauri-plugin-shell` は dev 時に `target/debug/` 直下、
/// バンドル時はバンドル直下からこの名前 (+ triple) を探すため、
/// `tauri.conf.json` の `bundle.externalBin` にあるディレクトリ部分 (`binaries/`) は含めない。
const SIDECAR_NAME: &str = "mycomfyui-api";
/// 起動エントリが待ち受け先を知らせる行の接頭辞。
const LISTENING_PREFIX: &str = "MYCOMFYUI_API_LISTENING";
/// 待ち受け先の行が出るまでの上限。PyInstaller の展開と migration の分を見込む。
const LISTENING_TIMEOUT: Duration = Duration::from_secs(60);
/// health が 200 を返すまでの上限。
const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
const HEALTH_INTERVAL: Duration = Duration::from_millis(250);
/// 失敗したときに画面へ出すログの行数。
const LOG_LINES: usize = 30;
const STARTING: u8 = 0;
const READY: u8 = 1;
const TERMINATED: u8 = 2;
const STOPPING: u8 = 3;

/// 起動できなかった理由。画面へそのまま出す。
pub struct StartupFailure {
    pub title: String,
    pub detail: String,
}

/// sidecar のハンドルと直近のログ。`AppHandle` の管理下へ置く。
#[derive(Default)]
pub struct SidecarState {
    child: Mutex<Option<ManagedChild>>,
    log: Arc<Mutex<VecDeque<String>>>,
    lifecycle: Arc<AtomicU8>,
    transition: Arc<Mutex<()>>,
}

impl SidecarState {
    /// 直近のログを古い順に並べて返す。
    fn recent_log(&self) -> String {
        recent(&self.log)
    }
}

/// WebView の origin。Windows では http と https のどちらの報告もあるため両方を許す。
/// 開発時は Vite の dev server が origin になるため、その分だけ debug build で足す。
fn allowed_origins() -> Vec<String> {
    let mut origins = vec![
        "http://tauri.localhost".to_string(),
        "https://tauri.localhost".to_string(),
        "tauri://localhost".to_string(),
    ];
    if cfg!(debug_assertions) {
        origins.push("http://127.0.0.1:5173".to_string());
        origins.push("http://localhost:5173".to_string());
    }
    origins
}

/// DB と資産の保存先。Web 版の既定 (`platformdirs.user_data_path("MyComfyUI")`) と同じ場所を指す。
/// 保存先の選択 UI は Issue #66 で足すため、ここでは既定値だけを決める。
fn data_root() -> Result<PathBuf, StartupFailure> {
    dirs::data_local_dir()
        .map(|dir| dir.join("MyComfyUI"))
        .ok_or_else(|| StartupFailure {
            title: "保存先を決められません".to_string(),
            detail: "利用者データのディレクトリを解決できませんでした。".to_string(),
        })
}

/// sidecar を起動し、health の確認後に Web UI を表示する。
pub async fn start(app: &AppHandle) -> Result<(), StartupFailure> {
    let state = app.state::<SidecarState>();
    let mut events = {
        // spawnからchild登録までをstopと直列化し、起動中の終了操作でも取りこぼさない。
        let _transition = state
            .transition
            .lock()
            .expect("画面遷移のロックを取得できない");
        if state.lifecycle.load(Ordering::SeqCst) == STOPPING {
            return Err(StartupFailure {
                title: "Application API を起動できません".to_string(),
                detail: "アプリの終了処理が始まっています。".to_string(),
            });
        }
        state.lifecycle.store(STARTING, Ordering::SeqCst);
        state
            .log
            .lock()
            .expect("ログのロックを取得できない")
            .clear();
        let data_root = data_root()?;

        let mut args = vec![
            "--host".to_string(),
            "127.0.0.1".to_string(),
            "--port".to_string(),
            "0".to_string(),
            "--data-root".to_string(),
            data_root.to_string_lossy().into_owned(),
        ];
        for origin in allowed_origins() {
            args.push("--allow-origin".to_string());
            args.push(origin);
        }

        let command = app
            .shell()
            .sidecar(SIDECAR_NAME)
            .map_err(|error| StartupFailure {
                title: "Application API を起動できません".to_string(),
                detail: format!(
                    "sidecar の実行ファイルを用意できませんでした。\n{error}\n\
                     docs/operations/desktop-shell.md の手順で {SIDECAR_NAME} を置いてください。"
                ),
            })?
            .args(args);

        let (events, child) = managed_sidecar::spawn(command).map_err(|error| StartupFailure {
            title: "Application API を起動できません".to_string(),
            detail: format!("sidecar のプロセスを開始できませんでした。\n{error}"),
        })?;
        state
            .child
            .lock()
            .expect("sidecar のロックを取得できない")
            .replace(child);
        events
    };

    let (listening_tx, listening_rx) = oneshot::channel::<String>();
    let log = Arc::clone(&state.log);
    let lifecycle = Arc::clone(&state.lifecycle);
    let transition = Arc::clone(&state.transition);
    let handle = app.clone();
    // イベントの購読はアプリが終わるまで続ける。待ち受け先の通知だけを一度返し、
    // そのあとは異常終了を拾うために読み続ける。
    tauri::async_runtime::spawn(async move {
        let mut listening_tx = Some(listening_tx);
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes).trim_end().to_string();
                    if let Some(rest) = line.strip_prefix(LISTENING_PREFIX) {
                        if let Some(sender) = listening_tx.take() {
                            let _ = sender.send(rest.trim().to_string());
                        }
                    }
                    push_log(&log, line);
                }
                CommandEvent::Stderr(bytes) => {
                    push_log(&log, String::from_utf8_lossy(&bytes).trim_end().to_string());
                }
                CommandEvent::Error(message) => {
                    push_log(&log, message);
                }
                CommandEvent::Terminated(payload) => {
                    push_log(
                        &log,
                        format!(
                            "sidecar が終了しました。code={:?} signal={:?}",
                            payload.code, payload.signal
                        ),
                    );
                    // 起動完了の画面遷移と直列化し、エラー画面を後続のcloseで消さない。
                    let _transition = transition.lock().expect("画面遷移のロックを取得できない");
                    // 起動後に落ちた場合だけここで知らせる。起動前の失敗は待ち側が拾う。
                    if lifecycle.swap(TERMINATED, Ordering::SeqCst) == READY {
                        let detail =
                            format!("{}\n\n{}", exit_code_hint(payload.code), recent(&log));
                        crate::shell_ui::open_error(
                            &handle,
                            &StartupFailure {
                                title: "Application API が停止しました".to_string(),
                                detail,
                            },
                        );
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    let result = async {
        let raw = match timeout(LISTENING_TIMEOUT, listening_rx).await {
            Ok(Ok(raw)) => raw,
            Ok(Err(_)) => {
                return Err(failure_from_log(
                    "Application API が起動しませんでした",
                    "待ち受け先を知らせる前に sidecar が終了しました。",
                    &state,
                ))
            }
            Err(_) => {
                return Err(failure_from_log(
                    "Application API が起動しませんでした",
                    &format!(
                        "{}秒のあいだに待ち受け先が確定しませんでした。",
                        LISTENING_TIMEOUT.as_secs()
                    ),
                    &state,
                ))
            }
        };

        let base_url = validate(&raw).map_err(|reason| {
            failure_from_log(
                "Application API の待ち受け先が不正です",
                &format!("{reason} 受け取った値: {raw}"),
                &state,
            )
        })?;

        if !wait_for_health(&base_url).await {
            return Err(failure_from_log(
                "Application API が応答しません",
                &format!(
                    "{} の health が{}秒のあいだ200を返しませんでした。",
                    base_url,
                    HEALTH_TIMEOUT.as_secs()
                ),
                &state,
            ));
        }

        let _transition = state
            .transition
            .lock()
            .expect("画面遷移のロックを取得できない");
        if state.lifecycle.load(Ordering::SeqCst) != STARTING {
            return Err(failure_from_log(
                "Application API が起動しませんでした",
                "health の確認直後に sidecar が終了しました。",
                &state,
            ));
        }
        crate::shell_ui::open_main(app, &base_url).map_err(|error| StartupFailure {
            title: "画面を表示できません".to_string(),
            detail: error.to_string(),
        })?;
        state.lifecycle.store(READY, Ordering::SeqCst);
        Ok(())
    }
    .await;

    if result.is_err() {
        stop(app);
    }
    result
}

/// 自分が起動した sidecar だけを止める。port やプロセス名で探して落とさないため、
/// 利用者が別途起動した Application API や Backend には触らない。
pub fn stop(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    let _transition = state
        .transition
        .lock()
        .expect("画面遷移のロックを取得できない");
    state.lifecycle.store(STOPPING, Ordering::SeqCst);
    let child = state
        .child
        .lock()
        .expect("sidecar のロックを取得できない")
        .take();
    if let Some(child) = child {
        // 既に終了している場合は失敗する。終了処理の途中で落とさない。
        let _ = child.kill();
    }
}

fn push_log(log: &Arc<Mutex<VecDeque<String>>>, line: String) {
    if line.is_empty() {
        return;
    }
    let mut log = log.lock().expect("ログのロックを取得できない");
    if log.len() == LOG_LINES {
        log.pop_front();
    }
    log.push_back(line);
}

fn recent(log: &Arc<Mutex<VecDeque<String>>>) -> String {
    let log = log.lock().expect("ログのロックを取得できない");
    log.iter().cloned().collect::<Vec<_>>().join("\n")
}

fn failure_from_log(title: &str, reason: &str, state: &SidecarState) -> StartupFailure {
    StartupFailure {
        title: title.to_string(),
        detail: format!("{reason}\n\n{}", state.recent_log()),
    }
}

/// 終了コードの意味は `docs/operations/api-sidecar.md` に合わせる。
fn exit_code_hint(code: Option<i32>) -> String {
    match code {
        Some(20) => "設定の値が不正です。渡した保存先とportを確かめてください。".to_string(),
        Some(21) => {
            "指定したhostとportにbindできません。portの使用状況を確かめてください。".to_string()
        }
        Some(3) => {
            "Application API の起動処理が失敗しました。migration の失敗を含みます。".to_string()
        }
        Some(code) => format!("sidecar が終了コード {code} で終了しました。"),
        None => "sidecar が終了コードを返さずに終了しました。".to_string(),
    }
}

/// `apps/web/src/api/base-url.ts` と同じ条件で受け入れる。
/// 認証を持たない API のため、loopback 以外へ画面の通信先を向けない。
fn validate(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|error| format!("URLとして読めません ({error})。"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("scheme が {} です。", url.scheme()));
    }
    let host = url
        .host()
        .ok_or_else(|| "host がありません。".to_string())?;
    let loopback = match &host {
        Host::Domain(name) => name.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(address) => address.is_loopback(),
        Host::Ipv6(address) => address.is_loopback(),
    };
    if !loopback {
        return Err(format!("host {host} が loopback ではありません。"));
    }
    Ok(url)
}

async fn wait_for_health(base_url: &Url) -> bool {
    timeout(HEALTH_TIMEOUT, async {
        loop {
            if health_ok(base_url).await {
                return;
            }
            sleep(HEALTH_INTERVAL).await;
        }
    })
    .await
    .is_ok()
}

/// loopback の平文HTTPだけを相手にするため、状態行だけを見る。
/// TLSもリダイレクトも要らないので、HTTPクライアントの依存を足さない。
async fn health_ok(base_url: &Url) -> bool {
    let Some(host) = base_url.host_str() else {
        return false;
    };
    let port = base_url.port_or_known_default().unwrap_or(80);
    let Ok(mut stream) = TcpStream::connect((host, port)).await else {
        return false;
    };
    let request =
        format!("GET /api/v1/health HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).await.is_err() {
        return false;
    }
    let mut status = String::new();
    let mut reader = BufReader::new(stream);
    if reader.read_line(&mut status).await.is_err() {
        return false;
    }
    status.starts_with("HTTP/1.1 200")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_のhttpだけを受け入れる() {
        assert!(validate("http://127.0.0.1:53421").is_ok());
        assert!(validate("http://localhost:53421").is_ok());
        assert!(validate("http://[::1]:53421").is_ok());
        assert!(validate("https://127.0.0.1:53421").is_ok());
    }

    #[test]
    fn loopback以外と対象外のschemeを弾く() {
        assert!(validate("http://example.com").is_err());
        assert!(validate("http://192.168.0.2:8000").is_err());
        assert!(validate("file:///tmp/x").is_err());
        assert!(validate("javascript:alert(1)").is_err());
        assert!(validate("ここはURLではない").is_err());
    }

    #[test]
    fn 許可originにloopback以外を混ぜない() {
        for origin in allowed_origins() {
            assert!(
                origin.contains("localhost") || origin.contains("127.0.0.1"),
                "loopback以外のoriginを許可している: {origin}"
            );
        }
    }

    #[test]
    fn ログは上限で古い行から捨てる() {
        let log = Arc::new(Mutex::new(VecDeque::new()));
        for index in 0..(LOG_LINES + 5) {
            push_log(&log, format!("line {index}"));
        }
        let kept = recent(&log);
        assert_eq!(kept.lines().count(), LOG_LINES);
        assert!(kept.starts_with("line 5"));
    }
}
