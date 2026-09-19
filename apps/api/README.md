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

SQLite は `<data_root>/db/mycomfyui.sqlite3` へ作成する。接続時に WAL、外部キー、busy timeout を有効にする。
設定値に API キーなどの秘密情報を置かない。データベース、ログ、API 応答にも保存しない。

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
|Job の取得|`GET /api/v1/generation-jobs/{job_id}`|
|Manifest の取得|`GET /api/v1/generation-manifests/{manifest_id}`|
|Artifact の作成・取得|`POST /api/v1/artifacts` / `GET /api/v1/artifacts/{artifact_id}`|
|ApprovalLog の作成・取得|`POST /api/v1/approval-logs` / `GET /api/v1/approval-logs/{approval_log_id}`|

### Job と Manifest の作成

`GenerationJob.manifest_id` と `GenerationManifest.job_id` は相互に参照するため、両者を分けて作成できない。
`POST /api/v1/generation-jobs` は Job、実行時 Workflow JSON の Artifact、Manifest の ID を先行採番し、
同一トランザクションで Job、Workflow Artifact、Manifest の順に書き込む。相互参照はコミット時まで遅延検証する。

```bash
curl -X POST http://127.0.0.1:8000/api/v1/generation-jobs \
  -H 'Content-Type: application/json' \
  -d '{
    "kind": "image",
    "scene_ref": {"path": "scenes/01.md"},
    "shot_ref": {"path": "scenes/01-a.md"},
    "recipe_id": "<recipe-id>",
    "queue_sequence": 1,
    "manifest": {
      "engine": "comfyui",
      "engine_version": "0.3.0",
      "model": {"name": "sdxl", "sha256": "<64桁のhex>"},
      "seed": 42,
      "resolved_prompt": "a cat",
      "parameters": {"steps": 20},
      "input_refs": [],
      "workflow_artifact": {
        "relative_path": "artifacts/<job-id>/workflow.json",
        "sha256": "<64桁のhex>",
        "byte_size": 128,
        "media_type": "application/json"
      }
    }
  }'
```

応答の `manifest_id` で `GET /api/v1/generation-manifests/{manifest_id}` を呼ぶと Manifest を取得できる。
Job の初期状態は `queued` とする。状態遷移 API は後続 Issue で実装する。

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

## 対象外

ComfyUI へのジョブ投入、GPU キュー、状態変更、再実行、Web UI、WebSocket、認証、削除 API、
Artifact 実ファイルと Workflow JSON の保存処理は本 API の対象外とする。
