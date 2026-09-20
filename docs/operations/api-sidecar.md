# Application APIをsidecarとして起動する

デスクトップ版では、Application APIをTauriのexternal binary(sidecar)として起動する。Web版と同じ実行経路を使い、API側にデスクトップ専用の分岐は置かない。違いは起動時に渡す引数と環境変数だけである。

## 起動エントリ

`mycomfyui_api.__main__`が起動エントリである。次の3つはいずれも同じ経路を通る。

```bash
# 開発時。uvicornのreloaderを使う従来のコマンド。
npm run api:dev

# 起動エントリ経由。sidecarと同じ引数を手元で試せる。
npm run api:serve -- --port 0 --allow-origin http://tauri.localhost

# 固めた実行ファイル。Tauriが起動するのはこの形。
./mycomfyui-api --port 0 --data-root /path/to/data --allow-origin http://tauri.localhost
```

`npm run api:dev`は従来どおり`uvicorn mycomfyui_api.main:app --reload`を呼ぶ。起動エントリを追加しても、開発時の起動方法は変わらない。

## 引数と環境変数

引数は`MYCOMFYUI_`接頭辞の環境変数へ移してから読む。設定の読み取り口を2つに増やさないため、引数で渡した値も必ず環境変数を経由する。渡さなかった項目は環境変数と既定値をそのまま使う。

- `--host` / `MYCOMFYUI_API_HOST`: bindするhost。既定は`127.0.0.1`。APIは認証を持たないため、loopback以外へ広げると同一LANの別端末から操作できてしまう。既定値は変えない。
- `--port` / `MYCOMFYUI_API_PORT`: bindするport。既定は`8000`。`0`を渡すとOSが空きportを選ぶ。
- `--data-root` / `MYCOMFYUI_DATA_ROOT`: DBと資産の保存先。空のディレクトリを渡すと起動時にDBを作る。
- `--allow-origin` / `MYCOMFYUI_ALLOWED_ORIGINS`: ブラウザからの呼び出しを許すorigin。引数は複数回指定でき、環境変数はカンマ区切りで並べる。
- `--log-level`: uvicornのログレベル。既定は`info`。

## 待ち受け先の伝え方

`--port 0`を渡すと、割り当てられたportはbindするまで分からない。起動エントリはbindを済ませてから、標準出力へ次の1行を流す。

```
MYCOMFYUI_API_LISTENING http://127.0.0.1:53421
```

sidecarを起動する側はこの行を読んでAPIの接続先を決める。書式を変えると読む側が壊れるため、変更するときは読む側も一緒に直す。

socketはこの行を出す前に確保してある。行が出た時点でportは確定しており、あとは`GET /api/v1/health`が200を返すまで待てばよい。

portが使用中の場合はbindに失敗させる。`SO_REUSEADDR`は設定しない。Windowsでは既にlistenしているsocketと同じportへのbindまで許すため、認証を持たないAPIの待ち受けを別プロセスに横取りされうる。

## 起動に失敗したときの終了コード

起動できない理由は終了コードで分ける。標準エラーには原因の要約を出し、tracebackのままでは落とさない。

- `20`: 設定の値が不正である。範囲外のportや空のhostを渡した場合。
- `21`: 指定したhostとportにbindできない。portが使用中、権限が足りない、hostを解決できない場合。
- `3`: uvicornの起動処理が失敗した。migrationの失敗はここに含まれる。

`MYCOMFYUI_API_LISTENING`の行が出ないまま終了したときは、終了コードと標準エラーを見る。

## 起動時のmigration

起動時にAlembicのmigrationをheadまで適用してから、DBのengineを作る。空の`data_root`を渡してもDBが無いまま動き出すことはない。適用済みなら何もしない。

`alembic upgrade head`をCLIから打つ運用はリポジトリの`alembic.ini`に依存する。固めた実行ファイルには`alembic.ini`もリポジトリも無いため、`mycomfyui_api.migrator`がAlembicのConfigをコード側で組み、migrationの置き場だけを渡す。接続先は`migrations/env.py`が`Settings`から解決する。

migrationの置き場は次の順で決まる。

- 固めた実行ファイル: 展開先(`sys._MEIPASS`)の`migrations`
- ソースから起動: `apps/api/migrations`

## CORS

`--allow-origin`で渡したoriginにだけCORSのheaderを返す。何も渡さなければheaderを一切返さない。開発時はViteのproxyが`/api`を同一originへ寄せるため、設定は要らない。

認証を持たないAPIのため、cookieと認証headerの送出(`allow_credentials`)は許さない。Tauri側のWebViewのoriginは実装時に確定するため、ここでは固定値を書かない。

APIは現時点でWebSocketのendpointを持たない。進捗はUI側の定期取得で受けている。[ADR 0001](../adr/0001-application-stack-and-boundaries.md)は進捗通知にWebSocketを使うと書いており、実装と食い違う。どちらへ寄せるかはIssue #67で決める。WebSocketを追加するときは、同じ許可originの設定でOriginを検証する。

## 単一実行ファイルへ固める

PyInstallerで固める。選定の理由は次のとおり。

- Tauriのsidecarは実行ファイル1つを置く形が前提で、onefileの出力をそのまま使える。
- Pythonとpipだけで動く。候補に挙げたNuitkaはC++コンパイラを要求するため、ビルド環境を1つ増やす。
- `fugashi`と`unidic-lite`のように辞書データを持つ依存を`--collect-all`で同梱できる。

`pyinstaller`は実行環境の依存には入れず、固めるときだけ`--with`で足す。

```bash
uv run --project apps/api --with pyinstaller pyinstaller \
  --noconfirm --onefile --name mycomfyui-api \
  --paths "$PWD/apps/api/src" \
  --add-data "$PWD/apps/api/migrations:migrations" \
  --collect-all mycomfyui_api \
  --collect-all alembic \
  --collect-all uvicorn \
  --collect-all fugashi \
  --collect-all unidic_lite \
  --collect-all aiosqlite \
  --collect-all sqlalchemy \
  --collect-all websockets \
  --collect-all httpx \
  --collect-all pydantic \
  --collect-all pydantic_settings \
  --collect-all fastapi \
  --collect-all starlette \
  --collect-all platformdirs \
  --distpath dist \
  "$PWD/apps/api/src/mycomfyui_api/__main__.py"
```

`--collect-all`の一覧は削らない。SQLAlchemyはDBAPIをURLのdriver名から動的に読むため、`aiosqlite`を外すと解析で拾われず、起動時に`ModuleNotFoundError: No module named 'aiosqlite'`で落ちる。migrationは先に適用されるため、DBファイルだけができた状態で止まる。

`--add-data`と`--paths`と入口のファイルは絶対パスで渡す。相対パスは`--specpath`からの相対として解かれるため、`--specpath`を移すと見つからなくなる。

WSL2(Ubuntu, Python 3.12)での実測は約81MBで、ビルドに1分ほどかかる。

Windows向けの実行ファイルはWindows上で作る。PyInstallerはクロスビルドを行わない。区切り文字も`--add-data "...;migrations"`とセミコロンに変わる。

Tauriのsidecarは`<name>-<target triple>`の名前で置く。Windows向けなら`mycomfyui-api-x86_64-pc-windows-msvc.exe`である。

## 受入の確認

`tools/check-sidecar.sh`が起動、DB作成、CORSの挙動、起動に失敗したときの終了コードをまとめて確かめる。一時ディレクトリを`data_root`にして起動し、確認が終わったら落とす。

```bash
bash tools/check-sidecar.sh
```
