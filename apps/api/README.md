# MyComfyUI Application API

生成履歴と関連情報を SQLite へ保存し、ローカルの HTTP API として読み書きする。
データベースへ直接アクセスしてよいのはこの Application API だけとする(ADR 0001)。

## 前提

- Python 3.12
- [uv](https://docs.astral.sh/uv/)

## 設定

設定は環境変数から読む。接頭辞は `MYCOMFYUI_` とする。リポジトリ直下の `.env` も読み込む。

```bash
cp .env.example .env
```

|変数|既定値|意味|
|---|---|---|
|`MYCOMFYUI_DATA_ROOT`|OS 標準の利用者データ領域|生成履歴とデータベースの保存先|
|`MYCOMFYUI_COMFYUI_BASE_URL`|`http://127.0.0.1:8188`|ComfyUI のエンドポイント|
|`MYCOMFYUI_COMFYUI_TIMEOUT_SECONDS`|`600`|1 Job の実行上限(秒)|

SQLite は `<data_root>/db/mycomfyui.sqlite3` へ作成する。接続時に WAL、外部キー、busy timeout を有効にする。
設定値に API キーなどの秘密情報を置かない。データベース、ログ、API 応答にも保存しない。
ComfyUI 呼び出しのログへ残すのは操作名、結果、`prompt_id` だけとする。

## データベースの初期化

Schema は Alembic migration だけで作成する。`create_all` は使わない。

```bash
uv run --project apps/api alembic upgrade head
```

リポジトリ直下の `alembic.ini` が `apps/api/migrations` を参照する。

## 起動

```bash
uv run --project apps/api uvicorn mycomfyui_api.main:app --reload
```

OpenAPI は `/docs`、疎通確認は `GET /api/v1/health` で行う。

## Endpoint

prefix は `/api/v1` とする。作成は `POST`、単体取得は `GET /{resource_id}` とする。

|操作|Endpoint|
|---|---|
|Recipe の作成・取得|`POST /api/v1/recipes` / `GET /api/v1/recipes/{recipe_id}`|
|Job と Manifest の作成|`POST /api/v1/generation-jobs`|
|Job の取得・一覧|`GET /api/v1/generation-jobs/{job_id}` / `GET /api/v1/generation-jobs`|
|Job の Artifact 一覧|`GET /api/v1/generation-jobs/{job_id}/artifacts`|
|Job の取消要求|`POST /api/v1/generation-jobs/{job_id}/cancel`|
|Manifest の取得|`GET /api/v1/generation-manifests/{manifest_id}`|
|Artifact の作成・取得|`POST /api/v1/artifacts` / `GET /api/v1/artifacts/{artifact_id}`|
|ApprovalLog の作成・取得|`POST /api/v1/approval-logs` / `GET /api/v1/approval-logs/{approval_log_id}`|

### Job と Manifest の作成

呼び出し元は Manifest の中身も ComfyUI の Workflow も組み立てない。Recipe と `inputs` だけを渡す。

```bash
curl -X POST http://127.0.0.1:8000/api/v1/generation-jobs \
  -H 'Content-Type: application/json' \
  -d '{
    "kind": "image",
    "scene_ref": {"path": "scenes/01.md"},
    "shot_ref": {"path": "scenes/01-a.md"},
    "recipe_id": "<recipe-id>",
    "queue_sequence": 1,
    "inputs": {"positive_prompt": "masterpiece, 1girl, library", "seed": 12345},
    "input_refs": []
  }'
```

API は次の順で処理する。

1. Recipe を取得し、`engine` と `kind` が要求と一致するか確かめる。
2. Recipe の `defaults` と要求の `inputs` をマージし、許可された変数だけかを検証する。
   Recipe の `input_schema` が空でなければ、そのキーが受け取れる変数の全体になる。
   値が `{"required": true}` を持つ項目は、`defaults` か `inputs` のどちらかで埋まっている必要がある。
   `input_schema` が空のときは Workflow テンプレート側の定義だけで判定する。
3. `workflow_template_ref` が同梱テンプレートを指すか確かめる。`sha256` があれば内容まで照合する。
4. テンプレートへ変数を注入し、実行用 Workflow JSON を組み立てる。`seed` は `-1` または未指定なら採番する。
5. `artifacts/<job-id>/workflow.json` へ書き出し、SHA-256 とバイト数を算出する。
6. Job、Workflow Artifact、Manifest の ID を先行採番し、同一トランザクションでこの順に書き込む。

`GenerationJob.manifest_id` と `GenerationManifest.job_id` は相互に参照するため、両者を分けて作成できない。
相互参照はコミット時まで遅延検証する。Job の作成に失敗した場合、書き出し済みの Workflow JSON は削除する。

応答の `manifest_id` で `GET /api/v1/generation-manifests/{manifest_id}` を呼ぶと Manifest を取得できる。
Job の初期状態は `queued` とする。`engine_version` だけは実行 Backend の実測値のため、
Adapter が実行を開始した直後に 1 回だけ設定する。それまでは `null` になる。

### GPU 直列ジョブキュー

Application API プロセス内のバックグラウンドワーカーが `queue_sequence` 昇順で `queued` の Job を
1 件ずつ直列実行する。GPU 高負荷ジョブが同時に 2 件実行されることはない。

状態遷移は `docs/design/generation-records.md` の定義に従う。`queued → running →
succeeded/failed`、取消時は `queued → cancelled` または `running → cancelling →
(cancelled/succeeded/failed)` とする。`cancelling` は Backend が停止を確認できれば
`cancelled`、停止前に出力が完了すれば `succeeded`、停止処理自体が失敗すれば理由付きで
`failed` になる。Backend 実行本体は ComfyUI Adapter が担う。

プロセス再起動時、`running` / `cancelling` のまま残っている Job は起動時に `failed`
(`INTERRUPTED`、再試行可能)へ倒す。中断 Job を誤って成功扱いしない。

`GET /api/v1/generation-jobs` はキュー状態確認用の一覧を返す。クエリパラメータ `state` で絞り込める。

`POST /api/v1/generation-jobs/{job_id}/cancel` で取消を要求する。`queued` は即座に `cancelled`、
`running` は `cancelling` へ遷移しワーカーへ取消を伝える。終端状態(`succeeded`/`failed`/`cancelled`)への
要求は `JOB_NOT_CANCELLABLE`(422)を返す。

失敗した Job には `failure_code`、`failure_stage`(`backend_start` / `execution` /
`response_disconnect` / `timeout`)、`failure_message`、`retryable` を記録する。

### ComfyUI Adapter

Job の実行は ComfyUI Adapter が担う。上位層は ComfyUI のノード ID も class_type も持たない。
Workflow テンプレートはパッケージ同梱のものだけを実行でき、行うのは許可された変数の差し替えに限る。
利用者由来の JSON をそのまま実行する経路は持たない。

実行時の手順は次のとおり。

1. `/system_stats` で疎通と `engine_version` を確認し、Manifest へ 1 回だけ記録する。
2. `/object_info/{UNETLoader|CLIPLoader|VAELoader}` で、Manifest が指すモデルの在庫を確認する。
3. 保存済みの `artifacts/<job-id>/workflow.json` を読み、記録済みの SHA-256 と突き合わせてから `/prompt` へ投入する。
4. `/ws` で完了を監視する。WebSocket を使えない場合は `/history/{prompt_id}` のポーリングへ切り替える。
5. `/history/{prompt_id}` から出力画像の参照を取得し、`/view` でダウンロードする。
6. `artifacts/<job-id>/` へ保存し、SHA-256 とバイト数を付けて Artifact を作成する。

取消要求を受けたら `/interrupt` に `prompt_id` を付けて送り、`/queue` の `delete` で順番待ちからも外す。
停止後に出力が揃っていれば `succeeded`、無ければ `cancelled` とする。停止要求自体の失敗は `failed` とする。
停止後の状態を ComfyUI へ問い合わせられなかった場合は、停止できたのか通信できないだけなのかを
区別できないため `cancelled` へ丸めず、`BACKEND_DISCONNECTED` として記録する。
`/queue` の削除だけが失敗した場合は、中断自体は成功しているため停止処理の失敗として扱わない。

失敗理由は次のとおり対応付ける。

|事象|`failure_stage`|`failure_code`|`retryable`|
|---|---|---|---|
|ComfyUI へ接続できない|`backend_start`|`BACKEND_UNAVAILABLE`|true|
|モデルファイルが見つからない|`backend_start`|`MODEL_NOT_FOUND`|false|
|モデルの在庫を確認できない|`backend_start`|`MODEL_NOT_FOUND`|true|
|Manifest、Recipe、スナップショットを解決できない|`backend_start`|`INPUT_UNRESOLVED`|false|
|ComfyUI が Workflow を拒否した|`backend_start`|`WORKFLOW_REJECTED`|false|
|実行中にノードが失敗した|`execution`|`EXECUTION_FAILED`|false|
|出力画像を取得できない|`execution`|`OUTPUT_NOT_FOUND`|false|
|生成物を保存・記録できない|`execution`|`ARTIFACT_WRITE_FAILED`|false|
|監視接続が切れ、履歴も取得できない|`response_disconnect`|`BACKEND_DISCONNECTED`|true|
|制限時間内に完了しない|`timeout`|`EXECUTION_TIMEOUT`|true|
|停止要求が失敗した|`execution`|`INTERRUPT_FAILED`|false|

### 保存先

|内容|`data_root` からの相対先|
|---|---|
|実行時 Workflow JSON|`artifacts/<job-id>/workflow.json`|
|生成画像|`artifacts/<job-id>/<ComfyUI の出力ファイル名>`|

ファイル名は Backend 由来のため、区切り文字と親ディレクトリ参照を取り除いてから使う。
同名ファイルがある場合は連番を付けて別ファイルにする。保存済みの Artifact は置換しない。

保存はできたが DB へ記録できなかったファイルは削除する。記録の無いファイルは再実行で
連番違いが増えるだけで診断にも使えないため、ファイルと DB 記録がずれた状態を残さない。
ただし書き込み後 commit 前にプロセスが強制終了した場合は、孤立した Workflow JSON が残る。
起動時に回収する仕組みは持たない。

`filename_prefix` は ComfyUI 側でサブフォルダとして解釈されるため、英数字、ドット、アンダースコア、
ハイフンだけの 64 文字以内に限り、`..` を拒否する。拒否したい文字を列挙するのではなく使える文字を許す。
NUL 文字や全角の区切り文字のような、想定していない表現を残さないため。
モデルファイルの在庫は `/object_info` で確認し、選択肢を取得できなかった場合も失敗させる。
在庫を確認できないまま任意の文字列をモデルローダーへ渡さない。

### 更新しない項目

Manifest と Artifact の内容、Recipe、ApprovalLog を更新する Endpoint は公開しない。
Recipe の変更は新しい Recipe として作成し、必要なら `supersedes_recipe_id` で後継を結ぶ。

### `relative_path` の制約

`relative_path` は `data_root` 基準の相対パスに限定する。絶対パスと親ディレクトリ参照(`..`)は
`VALIDATION_ERROR` として拒否する。

## エラー

エラーは次の Envelope で返す。`request_id` は応答 header の `X-Request-ID` と一致する。
要求 header に `X-Request-ID` を付けるとその値を引き継ぐ。

```json
{
  "code": "RESOURCE_NOT_FOUND",
  "message": "Recipeが見つかりません。",
  "details": {"resource": "Recipe", "id": "..."},
  "request_id": "..."
}
```

|`code`|HTTP|条件|
|---|---|---|
|`RESOURCE_NOT_FOUND`|404|指定した ID のリソースが存在しない|
|`VALIDATION_ERROR`|422|入力値が schema に合わない、または参照先が存在しない|
|`JOB_NOT_CANCELLABLE`|422|終端状態(`succeeded`/`failed`/`cancelled`)の Job へ取消を要求した|
|`JOB_STATE_CONFLICT`|409|取消要求とワーカーの実行開始・完了が競合し、状態が既に変わっていた|
|`STORAGE_ERROR`|503|データベースへアクセスできない (lock、migration 未適用など)|
|`INTERNAL_ERROR`|500|上記以外の未処理の例外|

`STORAGE_ERROR` と `INTERNAL_ERROR` は原因を応答へ含めず、`logging` へ出力する。

要求 header の `X-Request-ID` は `[A-Za-z0-9._-]` の 1〜64 文字だけ引き継ぐ。
書式を満たさない値は破棄し、サーバ側で採番する。

## 対象外

動画・音声・音楽生成、img2img、LoRA、hires fix、ControlNet、IPAdapter、
再実行(Exact Replay / Regenerate with Current Canon)、Web UI、進捗の UI への中継、認証、削除 API は
本 API の対象外とする。複数 GPU への分散、優先度付きスケジューリング、クラウドキューも対象外とする。
