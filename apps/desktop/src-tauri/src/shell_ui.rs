//! 起動中とエラーを出すシェル側の画面と、Web UI を表示する主画面。
//!
//! 起動中の画面は Web UI の bundle を読み込まない。sidecar の待ち受け先が決まる前に
//! `apps/web` を開くと、同一 origin へ寄せる fallback が先に走ってしまう。

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

use crate::sidecar::StartupFailure;

/// 起動中とエラーの画面を出す custom URI scheme。Windows では `http://mycomfyui.localhost` になる。
pub const SCHEME: &str = "mycomfyui";
/// シェル側の画面のラベル。起動中とエラーで同じ window を使い回す。
pub const SHELL_WINDOW: &str = "shell";
/// Web UI を表示する window のラベル。
pub const MAIN_WINDOW: &str = "main";
/// `apps/web/src/api/base-url.ts` が読む global の名前。
const API_BASE_URL_GLOBAL: &str = "__MYCOMFYUI_API_BASE_URL__";

const PAGE: &str = include_str!("../ui/shell.html");

/// custom URI scheme の応答。埋め込んだ1枚の HTML だけを返す。
pub fn serve<R: tauri::Runtime>(
    _context: tauri::UriSchemeContext<'_, R>,
    _request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .header("Content-Type", "text/html; charset=utf-8")
        .body(PAGE.as_bytes().to_vec())
        .expect("シェル画面の応答を組み立てられない")
}

/// 起動中の画面を出す。
pub fn open_starting(app: &AppHandle) -> tauri::Result<()> {
    open_shell(app, shell_url("starting", None, None))
}

/// 起動できなかった理由を画面へ出す。起動中の画面が残っていれば差し替える。
pub fn open_error(app: &AppHandle, failure: &StartupFailure) {
    let url = shell_url("error", Some(&failure.title), Some(&failure.detail));
    if let Err(error) = open_shell(app, url) {
        // 画面を出せないときは、少なくとも理由を標準エラーへ残す。
        eprintln!("エラー画面を表示できません: {error}\n{}", failure.detail);
    }
}

/// Web UI を表示する。待ち受け先は bundle の読み込み前に global へ書く。
pub fn open_main(app: &AppHandle, base_url: &Url) -> tauri::Result<()> {
    // 末尾の `/` は落としてから渡す。画面側が `/api/v1` を足す。
    let base = base_url.as_str().trim_end_matches('/');
    let script = format!(
        "window.{API_BASE_URL_GLOBAL} = {};",
        serde_json::to_string(base).expect("待ち受け先をJSONへ変換できない")
    );
    let window = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
        .title("MyComfyUI")
        .inner_size(1280.0, 800.0)
        .initialization_script(script)
        .build()?;
    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
            // shellは再利用のため非表示で残すので、主画面を閉じたらアプリ全体を終了する。
            handle.exit(0);
        }
    });
    hide_shell(app);
    Ok(())
}

fn open_shell(app: &AppHandle, url: Url) -> tauri::Result<()> {
    // 起動中からエラーへ移るときは、既存の window を navigate で使い回す。
    // close() は破棄が非同期で、直後に同じラベルで build すると
    // `a webview with label already exists` になるため作り直さない。
    if let Some(window) = app.get_webview_window(SHELL_WINDOW) {
        window.navigate(navigation_url(url))?;
        return window.show();
    }
    WebviewWindowBuilder::new(app, SHELL_WINDOW, WebviewUrl::CustomProtocol(url))
        .title("MyComfyUI")
        .inner_size(640.0, 420.0)
        .resizable(false)
        .build()?;
    Ok(())
}

/// WebView2のnavigateは初回生成時と異なりcustom protocolを自動変換しない。
fn navigation_url(url: Url) -> Url {
    navigation_url_for_platform(url, cfg!(windows))
}

fn navigation_url_for_platform(url: Url, windows: bool) -> Url {
    if windows {
        let converted =
            url.as_str()
                .replacen(&format!("{SCHEME}://"), &format!("http://{SCHEME}."), 1);
        Url::parse(&converted).expect("Windows用のシェル画面URLを組み立てられない")
    } else {
        url
    }
}

fn hide_shell(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(SHELL_WINDOW) {
        let _ = window.hide();
    }
}

/// 画面の状態は query で渡す。読み込み前に `eval` しても届かないため、URL へ載せる。
fn shell_url(state: &str, title: Option<&str>, detail: Option<&str>) -> Url {
    let mut url = Url::parse(&format!("{SCHEME}://localhost/shell.html"))
        .expect("シェル画面のURLを組み立てられない");
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("state", state);
        if let Some(title) = title {
            query.append_pair("title", title);
        }
        if let Some(detail) = detail {
            query.append_pair("detail", detail);
        }
    }
    url
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 状態と理由をqueryへ載せる() {
        let url = shell_url("error", Some("題名"), Some("詳細\n2行目"));
        let pairs: Vec<(String, String)> = url
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        assert!(pairs.contains(&("state".to_string(), "error".to_string())));
        assert!(pairs.contains(&("title".to_string(), "題名".to_string())));
        assert!(pairs.contains(&("detail".to_string(), "詳細\n2行目".to_string())));
    }

    #[test]
    fn windowsの再遷移用urlへ変換する() {
        let url = shell_url("error", Some("題名"), Some("詳細"));
        let converted = navigation_url_for_platform(url, true);
        assert_eq!(converted.scheme(), "http");
        assert_eq!(converted.host_str(), Some("mycomfyui.localhost"));
        assert_eq!(converted.path(), "/shell.html");
        assert_eq!(
            converted
                .query_pairs()
                .find(|(key, _)| key == "state")
                .unwrap()
                .1,
            "error"
        );
    }
}
