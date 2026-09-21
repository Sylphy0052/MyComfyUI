# ADR 0001:アプリケーション技術スタックと実行境界

- 状態:採用
- 決定日:2026-09-19
- 対象:Phase 0以降のMyComfyUIアプリケーション基盤

## 結論

MyComfyUIはReact 19、TypeScript、ViteによるSPAと、Python 3.12、FastAPIによるローカルApplication APIで構成する。永続化にはSQLite、SQLAlchemy 2、Alembicを使う。画面とAPIはREST/JSONとWebSocketだけで接続し、Pythonモジュール、DB、生成Backendへ画面から直接アクセスしない。

MyComfyUIはローカルWebアプリとして提供し、Windowsアプリは提供しない。Web UIとApplication APIは同一originで配信し、REST/WebSocketの契約を維持する。

## 背景

初期版ではScene/Shotから画像生成を実行し、ジョブ、Artifact、再現情報を管理する必要がある。将来は音声、動画、音楽、エージェント操作を追加する。一方、ComfyUIや音声BackendはPython依存とGPU要件が異なるため、一つの環境へ統合できない。

既存の`novel-writer/tools/ai-media`はPython 3.12、Pydantic 2、uvを使用している。MyComfyUIはその内部実装やDBを共有せず、Scene/Shot/Canonを参照専用APIとJSON Schemaで受け取る必要がある。

次の制約を満たす構成を選ぶ。

- Web UIとApplication APIの境界を維持する。
- 長時間ジョブの進捗を通知し、切断後に状態を復元できる。
- 生成Backendごとのvenvとプロセスを分離する。
- スキーマ変更を追跡し、既存の生成履歴を保全する。
- ローカル利用を前提とし、外部ネットワークへAPIを公開しない。

## 採用する技術

|領域|採用技術|方針|
|---|---|---|
|Web UI|React 19、TypeScript、Vite|クライアントサイドSPAとして実装する|
|JavaScript管理|Node.js 24 LTS、npm workspaces、`package-lock.json`|ルートからWeb UIの依存を管理する|
|Application API|Python 3.12、FastAPI、Uvicorn、Pydantic 2|HTTP/WebSocket、入力検証、プロセス調停を担当する|
|Python管理|uv、`uv.lock`|Application API専用venvを再現する|
|DB|SQLite、SQLAlchemy 2、aiosqlite|Application APIだけが読み書きする|
|Migration|Alembic|Schema変更を順序付きMigrationとして管理する|

Reactのルーター、UIコンポーネント、フォーム、クライアント状態管理は、必要になるIssueで既存依存との重複を確認して選ぶ。このADRではアプリケーション境界に影響する技術だけを固定する。

## API契約

### REST

- URLは`/api/v1`でバージョンを区切る。
- 参照、ジョブ投入、キャンセル、採否変更、再実行など、状態の取得と変更はREST/JSONで行う。
- FastAPIが生成するOpenAPIをREST契約の正本とし、`contracts/openapi/openapi.json`へスナップショットを保存する。
- Web UIのTypeScript型はOpenAPIスナップショットから生成し、手書きの重複型を正本にしない。
- エラーは`code`、`message`、`details`、`request_id`を持つ共通Envelopeで返す。画面表示用文言だけでエラー種別を判定しない。

### WebSocket

- 通知は`/api/v1/events`の単一WebSocketで配信する。
- ジョブ状態、進捗、ログ追加、Artifact作成などをEventとして通知する。
- Eventは`event_id`、`event_type`、`occurred_at`、`resource_type`、`resource_id`、`payload`を持つ。
- WebSocketは通知専用とし、ジョブ投入やキャンセルなどのCommandには使わない。
- RESTで得られる状態を正本とする。画面は初回接続時と再接続時にRESTから再取得し、受信漏れを補う。
- EventのJSON Schemaは`contracts/events/`で管理する。互換性を壊す変更は新しい`event_type`またはAPIバージョンで導入する。

これにより、WebSocket切断中もジョブは継続でき、画面は再接続後にSQLite上の確定状態へ復帰できる。

## DB方針

- SQLiteファイルはApplication APIだけが開く。Web UIと生成Backendは直接参照しない。
- SQLAlchemy 2のAsync APIとaiosqliteを使い、FastAPIの非同期Endpointから同じ呼出形式で扱う。
- SQLiteの書込みは並列化せず、Transactionを短く保つ。WAL、foreign key、busy timeoutを接続時に有効化する。
- 起動時の`create_all`をMigrationの代用にしない。Alembicの適用後にだけApplication APIを起動する。
- DB SchemaはMyComfyUI内部の実装詳細とし、`ai-media`との共有契約にしない。

aiosqliteはSQLite処理自体を非同期I/Oへ変えるものではない。イベントループからDB呼出しを分離するために使い、高負荷な集計やファイル処理は別Workerへ移す。

## プロセス境界

```text
Webブラウザ
  └─ REST/WebSocket
       └─ MyComfyUI Application API
            ├─ SQLite
            ├─ ai-media参照API
            ├─ ComfyUI API
            ├─ agentic-imagegen CLI
            ├─ 音声・動画Backend
            ├─ ffmpeg
            └─ エージェントCLI/API
```

- UIは外部コマンドを起動せず、ファイルパスやBackend固有APIを直接操作しない。
- Application APIがAdapterを通じてBackendの起動、health check、投入、状態取得、キャンセル、停止を調停する。
- ComfyUI、Qwen3-TTS、VoxCPM2、CosyVoice3などは既存どおり別venv・別プロセスに保つ。
- BackendのPython packageをApplication APIのvenvへ追加しない。
- GPU高負荷処理の排他と順序はApplication API配下の共通ジョブキューが管理する。
- API終了時は自分が起動した子プロセスだけを停止対象とし、利用者が別途起動したBackendを無断で停止しない。

## 開発時と配布時の構成

### 開発時

- Viteを`127.0.0.1:5173`、Application APIを`127.0.0.1:8000`で起動する。
- Viteは`/api`とWebSocketをApplication APIへproxyし、画面からは同一originとして扱う。
- ルートの`npm run dev`からWeb UIと`uv run --project apps/api uvicorn ... --reload`を並行起動できるようにする。
- 個別調査のため、Web UIとApplication APIはそれぞれ単独でも起動可能にする。

初回セットアップはルートで`npm ci`、`uv sync --project apps/api`を実行する。実際のscript名とPython module名は基盤作成Issueで確定し、READMEへ記載する。

### Web版配布時

Viteの静的buildをApplication APIから配信し、単一のloopback originで動作させる。APIは既定で`127.0.0.1`だけへbindし、外部公開用の`0.0.0.0`を既定値にしない。CORSとWebSocketのOriginは開発用Viteと配布UIのoriginだけを許可する。

## リポジトリ構成

```text
apps/
  api/
    pyproject.toml
    uv.lock
    src/mycomfyui_api/
  web/
    package.json
    src/
contracts/
  ai-media/
  events/
  openapi/
config/
  mycomfyui.example.toml
docs/
  adr/
workflows/
package.json
package-lock.json
.node-version
.python-version
var/                       # 開発用、Git管理外
```

- JavaScript workspaceはルートで管理し、`apps/web`だけを含める。
- Python lockfileはApplication APIに閉じ、生成Backendの環境と混ぜない。
- `contracts/`には外部境界のSchemaだけを置き、ORM modelを置かない。
- `var/`は開発用DB、ログ、Artifactに限定する。本番の保存先はOS標準のユーザーデータ領域を使い、詳細は資産保存Issueで決定する。

## 設定方針

設定は次の順で上書きする。後の値ほど優先度が高い。

1. アプリケーション既定値
2. ユーザー設定TOML
3. `MYCOMFYUI_`接頭辞の環境変数
4. 起動時CLI引数

追跡対象には`config/mycomfyui.example.toml`だけを置き、利用者固有の絶対パスや秘密情報を含む設定をcommitしない。APIキーと認証情報は環境変数またはOS資格情報ストアで参照する。画面へ返すruntime設定はAPI version、機能フラグ、利用可能Backendなどに限定し、秘密情報と不要なローカルパスを含めない。

## バージョン方針

- Node.jsはActive LTSまたはMaintenance LTSを使う。基盤作成時はNode.js 24 LTSを`.node-version`で固定する。
- npm packageは`package.json`で互換範囲を宣言し、`package-lock.json`で実際の解決結果を固定する。CIと通常セットアップは`npm ci`を使う。
- Pythonは既存`ai-media`と揃えた3.12系に固定し、`.python-version`と`requires-python >=3.12,<3.13`を一致させる。
- Python packageは互換範囲を`pyproject.toml`で宣言し、`uv.lock`で解決結果を固定する。通常セットアップは`uv sync --locked`を使う。
- React、FastAPI、Pydantic、SQLAlchemyなどのmajor更新は自動適用せず、Migrationと契約差分を確認するIssueで行う。

## 不採用とした選択肢

|選択肢|不採用理由|
|---|---|
|デスクトップアプリ|Windowsアプリは提供せず、ローカルWebアプリに統一する|
|Next.js|SSRとserver routeを必要とせず、ローカルApplication APIと責務が重複する|
|Application APIをRustで実装する|ComfyUIなどPython中心の既存環境とのAdapter実装が二重化し、初期版の速度を落とす|
|`ai-media`をPython packageとして直接importする|依存、DB Schema、リリース周期が結合し、参照専用境界を維持できない|
|全Backendを一つのvenvへ統合する|CUDA、PyTorch、Python versionの競合を招き、個別の再起動と障害分離ができない|
|Web UIからSQLiteを直接読む|書込み規則、Migration、監査、再実行の不変条件を迂回する|
|GraphQL|初期版の単一ローカルclientにはOpenAPI以上の柔軟性が不要で、契約と運用が増える|
|WebSocketだけでCommandと状態を扱う|切断時の再送、冪等性、状態復元が複雑になる|

## 影響

- Phase 0ではApplication APIとWeb UIの基盤、OpenAPI/Event Schemaの生成手順が必要になる。
- SQLiteの単一writer特性を前提にジョブ状態更新を設計する。複数ユーザーやremote server対応が必要になった場合は、認証とDBを別ADRで再検討する。
- 開発時にNode.jsとPythonの2プロセスが必要になるが、生成Backendの依存をApplication APIへ持ち込まずに済む。

## 参照

- [Node.js Releases](https://nodejs.org/en/about/previous-releases)
- [Vite Getting Started](https://vite.dev/guide/)
- [React 19](https://react.dev/blog/2024/12/05/react-19)
- [FastAPI WebSockets](https://fastapi.tiangolo.com/advanced/websockets/)
- [SQLAlchemy SQLite](https://docs.sqlalchemy.org/en/20/dialects/sqlite.html)
- [Alembic Tutorial](https://alembic.sqlalchemy.org/en/latest/tutorial.html)
- [uv Project Structure](https://docs.astral.sh/uv/concepts/projects/layout/)
