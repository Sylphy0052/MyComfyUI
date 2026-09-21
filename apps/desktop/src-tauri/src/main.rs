// リリースビルドでコンソールの窓を出さない。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod shell_ui;
mod sidecar;

use tauri::{Manager, RunEvent};

use sidecar::SidecarState;

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .register_uri_scheme_protocol(shell_ui::SCHEME, shell_ui::serve)
        .setup(|app| {
            app.manage(SidecarState::default());
            let handle = app.handle().clone();
            shell_ui::open_starting(&handle)?;
            // setup の中で待ち合わせるとウィンドウの生成が止まるため、起動は別タスクへ回す。
            tauri::async_runtime::spawn(async move {
                match sidecar::start(&handle).await {
                    Ok(base_url) => {
                        if let Err(error) = shell_ui::open_main(&handle, &base_url) {
                            shell_ui::open_error(
                                &handle,
                                &sidecar::StartupFailure {
                                    title: "画面を表示できません".to_string(),
                                    detail: error.to_string(),
                                },
                            );
                        }
                    }
                    Err(failure) => shell_ui::open_error(&handle, &failure),
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri アプリを初期化できない");

    app.run(|handle, event| {
        // 終了の合図は ExitRequested が先に来る。どちらで来ても止められるようにしておく。
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            sidecar::stop(handle);
        }
    });
}
