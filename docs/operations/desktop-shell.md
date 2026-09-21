# デスクトップシェルを動かす

`apps/desktop`はTauri 2のシェルである。`apps/web`のbuild成果物を表示し、Application APIをsidecarとして起動する。業務ロジックとDBアクセスはPython側に残し、Rust側はウィンドウとsidecarのlifecycleだけを持つ([ADR 0001](../adr/0001-application-stack-and-boundaries.md))。

## 前提

- Rust toolchain(stable)。`rustup`で入れる。
- Node.js 24 LTS。ルートで`npm ci`を済ませておく。
- Windows: Microsoft C++ Build Toolsの「Desktop development with C++」。WebView2はWindows 10 1803以降に同梱されている。
- Linux(開発用): `libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev pkg-config libdbus-1-dev`。`libdbus-1-dev`はTauriの前提一覧には無いが、`libdbus-sys`のビルドで要る。

Linuxはビルドと動作確認のためだけに使う。配布対象はWindowsである。

## sidecarを置く

Tauriはexternal binaryを`apps/desktop/src-tauri/binaries/`から読む。名前は`mycomfyui-api-<target triple>`で、Windowsでは`.exe`が付く。target tripleは`rustc -vV`の`host`行で分かる。

配布用の実行ファイルは[api-sidecar.md](./api-sidecar.md)のPyInstallerの手順で作り、上の名前へ変えて置く。

```bash
# 例: Windowsで固めた出力を置く
copy dist\mycomfyui-api.exe apps\desktop\src-tauri\binaries\mycomfyui-api-x86_64-pc-windows-msvc.exe
```

開発中は固め直さずに済ませられる。依存を同期してから`tools/make-sidecar-shim.sh`を実行すると、仮想環境のPythonへ直接委譲する実行ファイルを置く。引数と標準出力は固めた実行ファイルと同じになる。Pythonを直接起動するため、シェルの終了時に子プロセスを残さない。

```bash
uv sync --locked --project apps/api
bash tools/make-sidecar-shim.sh
```

shimはbashを使うためWindowsでは動かない。Windowsで動かすときはPyInstallerの出力を置く。

## 起動する

```bash
npm run desktop:dev     # Viteのdev serverを立てたうえでシェルを起動する
npm run desktop:build   # apps/webをbuildしてから配布物を作る
```

`desktop:dev`はViteの`http://127.0.0.1:5173`を読み込む。画面はTauriが注入したbase URLを使うため、Viteのproxyは通らずsidecarへ直接つながる。

## 起動の流れ

1. 「起動しています」の画面を出す。
2. sidecarを`--host 127.0.0.1 --port 0`で起動する。環境変数に別のhostがあってもloopbackだけで待ち受ける。`--allow-origin`にはWebViewのoriginを渡す。開発時はViteのoriginも渡す。
3. 標準出力の`MYCOMFYUI_API_LISTENING <url>`を待つ(上限60秒)。
4. 受け取ったURLがhttp/httpsかつloopbackであることを確かめる。条件は[web-api-base-url.md](./web-api-base-url.md)と同じにしてある。
5. `GET <url>/api/v1/health`が200を返すまで待つ(上限30秒)。
6. Web UIのwindowを作る。bundleの読み込み前に`window.__MYCOMFYUI_API_BASE_URL__`へURLを書き、起動中のwindowは非表示にする。

どこかで失敗したら、起動済みのsidecarを止めてから同じwindowをエラー表示へ差し替える。終了コードの意味と、sidecarの標準出力・標準エラーの末尾30行を出す。終了コードの一覧は[api-sidecar.md](./api-sidecar.md)にある。

起動後にsidecarが落ちた場合は、非表示にした起動中のwindowを再表示して同じエラー画面を出す。

## 保存先

`data_root`は`%LOCALAPPDATA%\MyComfyUI`(Linuxでは`~/.local/share/MyComfyUI`)を渡す。Web版がAPIの既定値として使う場所と同じで、Web版とデスクトップ版が同じDBを見る。Tauriの`app_data_dir()`(`%APPDATA%\<identifier>`)は使わない。保存先を選ぶUIはIssue #66で足す。

## 終了

アプリを終了すると、自分が起動したsidecarだけを止める。portやプロセス名で探して落とす処理は持たないため、利用者が別途起動したApplication APIやBackendは止まらない。

停止は強制終了である。WindowsではsidecarをJob Objectへ所属させ、PyInstallerのonefileが起動した子プロセスを含むプロセスツリーを止める。Linuxでは直接起動したsidecarを止める。実行中の生成Jobがあっても確認しない。終了時の実行中Jobの扱いはIssue #67で決める。

## 権限

`apps/desktop/src-tauri/capabilities/default.json`は`core:default`だけを画面へ渡す。sidecarの起動と停止はRust側だけで行うため、shell pluginの実行権限は画面へ渡さない。画面から任意のコマンドを起動する経路は作らない。

## 確認する

引数と待ち受け先の受け渡しだけなら、GUIを立てずに確かめられる。`tools/check-desktop-sidecar-contract.sh`がシェルと同じ引数でsidecarを起動し、`MYCOMFYUI_API_LISTENING`の行、loopbackであること、healthの200、許可originだけにCORSのheaderが出ること、`data_root`へDBができること、停止後に応答しないことを見る。

```bash
bash tools/make-sidecar-shim.sh
bash tools/check-desktop-sidecar-contract.sh
```

シェルを含めた確認は次のとおり。

1. 正常起動。`npm run desktop:dev`で起動し、起動中の画面のあとにWeb UIが出ること、一覧と生成が動くことを確認する。
2. 起動失敗。`binaries/`のsidecarを一時的に退避してから起動し、エラー画面に理由が出ることを確認する。
3. 異常終了。起動後にsidecarのプロセスを外から落とし、エラー画面が出ることを確認する。
4. 停止範囲。別途`npm run api:dev`で8000番のAPIを起動した状態でシェルを起動・終了し、8000番のAPIが残っていることを確認する。
5. 二重起動。シェルを2つ起動し、それぞれ別のportを掴むことを確認する。
