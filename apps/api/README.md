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
|`MYCOMFYUI_AIMEDIA_BASE_URL`|未設定|ai-media 参照 API の接続先。未設定の間は同梱 fixture を返す|
|`MYCOMFYUI_AIMEDIA_FIXTURE_PATH`|未設定|参照 fixture の差し替え先。Canon が更新された状態を手元で再現するときに使う|

開発環境の保護設定が `.env*` への読み書きを拒否するため、`MYCOMFYUI_COMFYUI_BASE_URL`、
`MYCOMFYUI_COMFYUI_TIMEOUT_SECONDS`、`MYCOMFYUI_AIMEDIA_BASE_URL` を `.env.example` へ
反映できていない。手元で次を追記してから `.env` へコピーする。既定値のままでよい項目は
書かなくても動く。

```dotenv
MYCOMFYUI_COMFYUI_BASE_URL=http://127.0.0.1:8188
MYCOMFYUI_COMFYUI_TIMEOUT_SECONDS=600
# 未設定なら同梱 fixture を参照する
MYCOMFYUI_AIMEDIA_BASE_URL=
```

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
|Recipe の一覧|`GET /api/v1/recipes`(`kind`、`engine`、`latest` で絞り込む)|
|Job と Manifest の作成|`POST /api/v1/generation-jobs`|
|Job の取得・一覧|`GET /api/v1/generation-jobs/{job_id}` / `GET /api/v1/generation-jobs`|
|Job の Artifact 一覧|`GET /api/v1/generation-jobs/{job_id}/artifacts`|
|Job の取消要求|`POST /api/v1/generation-jobs/{job_id}/cancel`|
|Canon 更新警告と再現可否|`GET /api/v1/generation-jobs/{job_id}/canon-status`|
|Exact Replay|`POST /api/v1/generation-jobs/{job_id}/replay`|
|Regenerate with Current Canon|`POST /api/v1/generation-jobs/{job_id}/regenerate`|
|親子 Job と派生 Artifact|`GET /api/v1/generation-jobs/{job_id}/lineage`|
|Manifest の取得|`GET /api/v1/generation-manifests/{manifest_id}`|
|Artifact の一覧|`GET /api/v1/artifacts`(`scene_id`、`shot_id`、`job_id`、`kind`、`decision`、`availability` で絞り込む)|
|Artifact の作成・取得|`POST /api/v1/artifacts` / `GET /api/v1/artifacts/{artifact_id}`|
|Artifact の実ファイル配信|`GET /api/v1/artifacts/{artifact_id}/content`|
|Artifact の採否記録|`PATCH /api/v1/artifacts/{artifact_id}/decision`|
|ApprovalLog の作成・取得|`POST /api/v1/approval-logs` / `GET /api/v1/approval-logs/{approval_log_id}`|
|ai-media 参照(読取専用)|`GET /api/v1/projects` 以下|

### ai-media 参照

`contracts/ai-media/v1/openapi.yaml` の契約に従い、Project、Scene、Shot を読取り専用で中継する。
応答本文は上流の形のまま返し、MyComfyUI 側で作り替えない。更新系は提供しない。

|操作|Endpoint|
|---|---|
|Project 一覧・取得|`GET /api/v1/projects` / `GET /api/v1/projects/{project_id}`|
|Scene 一覧・取得|`GET /api/v1/projects/{project_id}/scenes` / `.../scenes/{scene_id}`|
|Shot 一覧・取得|`GET /api/v1/projects/{project_id}/scenes/{scene_id}/shots` / `.../shots/{shot_id}`|
|Canon descriptor 一覧・取得|`GET /api/v1/projects/{project_id}/canon` / `.../canon/{canon_id}`|

Canon Endpoint は Canon 本文を返さず、`canon_id`、種別、表示名、不変参照だけを返す。
`canon_id` は `[source_locator, revision, path, anchor]` を RFC 8785 の JSON Canonicalization
Scheme で serialize した SHA-256 とする。

上流実装(novel-writer#17)が未完のため、`MYCOMFYUI_AIMEDIA_BASE_URL` が未設定のときは
同梱 fixture を返す。fixture は代表 Scene `hirohito-arc02-ep005-sc01`、3 件の Shot、
3 件の Canon descriptor を含む。上流が動いたら接続先を設定するだけで実データへ切り替わる。
UI と API の契約は変えない。

`MYCOMFYUI_AIMEDIA_FIXTURE_PATH` を設定すると、同梱 fixture の代わりに指定したファイルを読む。
Canon が更新された状態や参照が失われた状態を手元で再現し、更新警告と再実行の判定を確かめるために使う。
読み込んだ内容はそのまま履歴へ記録されるため、自分で用意した信頼できるファイルだけを指定する。

上流が応答しない場合は `REFERENCE_UNAVAILABLE`(503)、対象が無い場合は
`REFERENCE_NOT_FOUND`(404)を共通 Envelope で返す。

### 既定 Recipe

起動時に、同梱 Workflow テンプレート `anima_txt2img` に対応する Recipe を登録する。
すでに同じテンプレート版の Recipe があれば作らない。テンプレートの内容が変わった場合は
既存 Recipe を書き換えず、`supersedes_recipe_id` で後継 Recipe を追加する。

`input_schema` には画面へ出す変数だけを置き、モデルファイル名と出力名は `defaults` に固定する。
これにより、UI からモデルファイルや ComfyUI のノードを指定できない。

### Artifact の配信と採否

`GET /api/v1/artifacts/{artifact_id}/content` は `data_root` 配下で解決した実ファイルを
`media_type` で返す。保存先の絶対パスは応答に含めない。実ファイルが無い場合は
`ARTIFACT_FILE_MISSING`(404)を返す。

`PATCH /api/v1/artifacts/{artifact_id}/decision` は `accepted` / `rejected` / `undecided` を
受け取る。`undecided` へ戻すと `decision_at` も消す。採否を記録できるのは `image`、`video`、
`audio` だけとし、Workflow スナップショットやログには記録しない。

### OpenAPI スナップショット

REST 契約の正本は FastAPI が生成する OpenAPI とする。変更したら次を実行し、
`contracts/openapi/openapi.json` の差分を commit する。

```bash
npm run contracts
```

`npm run contracts` は OpenAPI の書き出しと Web UI の TypeScript 型生成をまとめて実行する。

### Job と Manifest の作成

呼び出し元は Manifest の中身も ComfyUI の Workflow も組み立てない。Recipe と `inputs` だけを渡す。

Scene、Shot、Canon の不変参照も Application API が参照 API から解決して Manifest へ固定する。
呼び出し元が渡すのは ID だけとする。

```bash
curl -X POST http://127.0.0.1:8000/api/v1/generation-jobs \
  -H 'Content-Type: application/json' \
  -d '{
    "kind": "image",
    "project_id": "hirohito",
    "scene_id": "hirohito-arc02-ep005-sc01",
    "shot_id": "hirohito-arc02-ep005-sc01-sh01",
    "recipe_id": "<recipe-id>",
    "inputs": {"positive_prompt": "masterpiece, 1girl, library", "seed": 12345}
  }'
```

`input_refs` には利用者素材の cache 参照だけを渡せる。Scene、Shot、Canon の参照を呼び出し元から
渡すことはできない。記録済みの参照を外から差し替えられないようにするためである。

`queue_sequence` は省略できる。省略すると現在の最大値の次を Application API が採番する。
キューは全 Job で 1 本のため、呼び出し側ごとに採番すると順番が重複する。順番を明示したい
場合だけ値を渡す。

API は次の順で処理する。

1. Recipe を取得し、`engine` と `kind` が要求と一致するか確かめる。
2. Recipe の `defaults` と要求の `inputs` をマージし、許可された変数だけかを検証する。
   Recipe の `input_schema` が空でなければ、そのキーが受け取れる変数の全体になる。
   値が `{"required": true}` を持つ項目は、`defaults` か `inputs` のどちらかで埋まっている必要がある。
   `input_schema` が空のときは Workflow テンプレート側の定義だけで判定する。
3. `workflow_template_ref` が同梱テンプレートを指すか確かめる。`sha256` があれば内容まで照合する。
4. テンプレートへ変数を注入し、実行用 Workflow JSON を組み立てる。`seed` は `-1` または未指定なら採番する。
5. 参照 API から Scene と Shot を取得し、本文の不変参照と `provenance.references` の Canon 参照を
   `input_refs` へ固定する。取得できない場合は Job を作らない(`REFERENCE_NOT_FOUND` / `REFERENCE_UNAVAILABLE`)。
6. `artifacts/<job-id>/workflow.json` へ書き出し、SHA-256 とバイト数を算出する。
7. Job、Workflow Artifact、Manifest の ID を先行採番し、同一トランザクションでこの順に書き込む。

`GenerationJob.manifest_id` と `GenerationManifest.job_id` は相互に参照するため、両者を分けて作成できない。
相互参照はコミット時まで遅延検証する。Job の作成に失敗した場合、書き出し済みの Workflow JSON は削除する。

応答の `manifest_id` で `GET /api/v1/generation-manifests/{manifest_id}` を呼ぶと Manifest を取得できる。
Job の初期状態は `queued` とする。`engine_version` だけは実行 Backend の実測値のため、
Adapter が実行を開始した直後に 1 回だけ設定する。それまでは `null` になる。

### Canon 更新警告と再実行

`GET /api/v1/generation-jobs/{job_id}/canon-status` は、Manifest に記録した参照と現在の参照 API の
値を突き合わせる。記録側は読むだけで更新しない。判定は参照ごとに次の 4 種とする。

|`change`|意味|
|---|---|
|`unchanged`|`revision` と `sha256` が記録時と一致する|
|`updated`|同じ参照先だが `revision` か `sha256` が違う|
|`missing`|現在の参照に同じ参照先が無い|
|`added`|記録に無い参照が現在側に増えている|

`replayable` は Exact Replay を実行できるかを表し、`updated` と `missing` が 1 件でもあれば `False` になる。
参照 API を引けなかった場合は `status` を `unavailable` とし、`reason` に理由を入れる。一致と混同させない
ため、この場合も `replayable` は `False` とする。

`POST /api/v1/generation-jobs/{job_id}/replay` は当時の実行条件で新しい Job を作る(Exact Replay)。

- 元 Manifest の `engine`、モデル、`seed`、解決済みプロンプト、パラメータ、`input_refs` を複製する。
- Workflow は記録済みスナップショットを SHA-256 で照合してから、同じ内容を新しい Job のディレクトリへ
  書き出す。組み立て直さない。
- 記録時と同じ内容を取得できない入力があれば `REPLAY_NOT_REPRODUCIBLE`(422)を返し、Job を作らない。
  現在の値へ暗黙に置き換えない。
- 参照 API で解決しない入力 cache 参照(`kind: "cached_input"`)は、`inputs/` 配下の実ファイルを読み、
  記録済みの SHA-256 と突き合わせる。取得できないか内容が違えば同じく実行しない。
  モデルファイルの在庫確認だけは実行時の Adapter に任せ、不足は `MODEL_NOT_FOUND` として Job の失敗理由に残る。
- 新 Manifest の `replay_of_manifest_id` に元 Manifest を記録する。`engine_version` は実行時の実測値を入れる。

`POST /api/v1/generation-jobs/{job_id}/regenerate` は現在の Canon で再生成する派生 Job を作る。
Scene、Shot、Canon だけを解決し直し、Recipe、Workflow、モデル、`seed`、パラメータは元 Manifest を複製する。

どちらも `parent_job_id` に元 Job を設定し、Workflow Artifact の `parent_artifact_id` に元 Artifact を
設定する。元の Job、Manifest、Artifact は更新しない。参照を解決する前に作られた Job には Project ID が
無いため、`REFERENCE_IDS_MISSING`(422)として再実行できない。

`GET /api/v1/generation-jobs/{job_id}/lineage` は親子 Job と、それらに属する Artifact を返す。
探索は深さ 50、子孫 200 件で打ち切り、打ち切った場合は `truncated` を `true` にする。

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

`GET /api/v1/generation-jobs` はキュー状態確認用の一覧を返す。クエリパラメータ `state`、
`scene_id`、`shot_id` で絞り込み、`limit`(既定 100、最大 200)と `offset` で件数を区切る。
`scene_id` と `shot_id` は `scene_ref` / `shot_ref` の `id` と突き合わせる。

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
