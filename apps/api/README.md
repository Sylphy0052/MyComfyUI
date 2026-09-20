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
|`MYCOMFYUI_VOICE_RUNNER_BASE_URL`|`http://127.0.0.1:8770`|voice-runner のエンドポイント。別 PC で動かす場合もこの値だけを変える|
|`MYCOMFYUI_VOICE_RUNNER_TIMEOUT_SECONDS`|`300`|音声 1 台詞あたりの実行上限(秒)|
|`MYCOMFYUI_VOICE_MAX_AUDIO_BYTES`|`33554432`|取り込む参照音声と受け取る生成音声の上限バイト数|
|`MYCOMFYUI_VOICE_STUB`|`false`|voice-runner の代わりに内蔵 stub で実行する。Backend なしで経路を確かめるときに使う|
|`MYCOMFYUI_VOICE_STUB_FAILURE`|`false`|stub の生成を必ず失敗させる。失敗記録の経路を確かめるときに使う|

開発環境の保護設定が `.env*` への読み書きを拒否するため、`MYCOMFYUI_COMFYUI_BASE_URL`、
`MYCOMFYUI_COMFYUI_TIMEOUT_SECONDS`、`MYCOMFYUI_AIMEDIA_BASE_URL`、`MYCOMFYUI_VOICE_*` を
`.env.example` へ反映できていない。手元で次を追記してから `.env` へコピーする。既定値のままで
よい項目は書かなくても動く。

```dotenv
MYCOMFYUI_COMFYUI_BASE_URL=http://127.0.0.1:8188
MYCOMFYUI_COMFYUI_TIMEOUT_SECONDS=600
# 未設定なら同梱 fixture を参照する
MYCOMFYUI_AIMEDIA_BASE_URL=
# 別 PC の voice-runner を使う場合はここだけを差し替える
MYCOMFYUI_VOICE_RUNNER_BASE_URL=http://127.0.0.1:8770
MYCOMFYUI_VOICE_RUNNER_TIMEOUT_SECONDS=300
# Backend を立てずに経路だけ確かめる場合は true
MYCOMFYUI_VOICE_STUB=false
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
|音声 Job の読み検証結果|`GET /api/v1/generation-jobs/{job_id}/voice-verifications`|
|voice-runner の疎通確認|`GET /api/v1/backends/voice/health`|
|参照音声の取り込み|`POST /api/v1/voice-references`|
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
差し替えた fixture は参照のたびに読み直すため、書き換えた内容は API を再起動しなくても反映される。

上流が応答しない場合は `REFERENCE_UNAVAILABLE`(503)、対象が無い場合は
`REFERENCE_NOT_FOUND`(404)を共通 Envelope で返す。

### 既定 Recipe

起動時に、同梱 Workflow テンプレート `anima_txt2img` に対応する Recipe を登録する。
すでに同じテンプレート版の Recipe があれば作らない。テンプレートの内容が変わった場合は
既存 Recipe を書き換えず、`supersedes_recipe_id` で後継 Recipe を追加する。

`input_schema` には画面へ出す変数だけを置き、モデルファイル名と出力名は `defaults` に固定する。
これにより、UI からモデルファイルや ComfyUI のノードを指定できない。

音声側も同じ仕組みで、`kind: "voice"` の Recipe を engine ごとに 1 件ずつ登録する
(`qwen3-tts-clone` / `voxcpm2-prompt` / `cosyvoice3`)。model ID と sample rate は voice-runner
側の設定が正本のため Recipe には持たせず、`defaults` には `profile` と検証の既定値だけを置く。

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

### 音声 Adapter (voice-runner)

音声生成は `tools/voice-runner` が提供する HTTP サービス経由で実行する。Application API は
TTS/ASR のライブラリを持たず、`POST /v1/speech`、`POST /v1/transcribe`、`GET /v1/health` だけを
呼ぶ。Backend を同じ PC で動かすか別 PC で動かすかの違いは
`MYCOMFYUI_VOICE_RUNNER_BASE_URL` の値だけで、Application API 側の分岐は無い。

engine は Recipe の `engine` で決まる。`qwen3-tts-clone`(Primary)、`voxcpm2-prompt`(Secondary)、
`cosyvoice3`(比較用)の 3 種とし、実行中に別 engine へ自動で切り替えない。engine ごとの
Python 環境は voice-runner 側で分けて持ち、Application API の venv へは混ぜない。

Job の単位は Shot 1 件とする。Shot 内の台詞ごとに音声を 1 件ずつ生成し、まとめて 1 Job で扱う。
台詞単位で Job を分けないのは、モデルのロードが 29〜67 秒かかるのに対し生成そのものは
平均 1.77 秒で、1 回のプロセス起動でまとめて生成するほうが速いためである。

実行時の手順は次のとおり。

1. `GET /v1/health` で疎通と engine の利用可否を確認し、`engine_version` を Manifest へ 1 回だけ記録する。
   モデル ID、モデルの版、sample rate も実測値のため、未記録のときだけ同時に埋める。
2. `artifacts/<job-id>/workflow.json` に保存した実行スナップショットを読み、記録済みの SHA-256 と突き合わせる。
3. 参照音声を `inputs/` から読み、実ファイルの SHA-256 が Manifest の記録と一致することを確かめる。
4. 台詞ごとに `POST /v1/speech` を呼ぶ。`seed` は Job 全体で 1 つとし、生成直前に voice-runner 側で固定する。
5. `pad_to_duration` が真なら、生成音声の末尾へ無音を足して Shot の尺へそろえる。尺を超える場合は切り詰めない。
6. `verify_with_asr` が真なら、パディング前の音声を `POST /v1/transcribe` で書き起こし、読みを突き合わせる。
7. 音声 Artifact と検証結果を同一トランザクションで記録する。

取消要求は台詞と台詞の間で受け取る。生成途中の Shot は音声として成立しないため、書き出し済みの
ファイルを消してから `cancelled` とする。

#### 読み検証 (ASR)

`GET /api/v1/generation-jobs/{job_id}/voice-verifications` が台詞ごとの検証結果を返す。
比較は表記のままでは行わない。ASR は同音の別表記(朝比奈 → 朝日菜)を返すため、表記で比べると
読めているものが不一致になる。期待側は `reading` があればそれを、無ければ `text` を使い、両方を
カタカナへ正規化してから `difflib` で差分率を取る。句読点と記号は変換の前に落とす。

|`status`|意味|
|---|---|
|`verified`|ASR まで実行し、`match` に一致可否が入っている|
|`skipped`|`verify_with_asr` が偽で、検証していない|
|`asr_failed`|ASR を実行できなかった。生成は成立しているため Job は `succeeded` のまま|
|`kana_unavailable`|カタカナ正規化を実行できなかった(形態素解析器の欠落など)|

読みの不一致は Job の失敗にしない。音声は生成できているため `succeeded` とし、不一致は記録して
利用者の判断に委ねる。`reading` の指定が無い台詞で不一致になった場合は、Shot 側へ `reading` を
追記する候補として UI が区別して表示する。

#### Voice Canon 本文の扱い

参照 API の Canon Endpoint は Canon 本文を返さず、`canon_id`、種別、表示名、不変参照だけを返す
(`docs/contracts/ai-media-read-api-v1.md`)。そのため、参照音声のパスと書き起こしを
Voice Canon の YAML から読むことはできない。Voice Canon の YAML を SQLite や Artifact 領域へ
複製することも禁止されている。

この制約のもと、次のように分担する。

- 参照音声そのものと書き起こしは、利用者が `POST /api/v1/voice-references` と `inputs.voices` で渡す。
- どの Voice Canon で生成したかは `canon_id` で示す。指定は必須とする。Application API は参照 API
  から descriptor を引き、その不変参照を `canon` の `input_ref` として `declared_by: "input"` で
  記録する。指定した `canon_id` と不変参照から算出した ID が食い違う場合は Job を作らない。
  `canon_id` を省略できるようにすると、参照音声だけを渡した Job が Canon 参照を残さずに履歴へ
  入り、どの声で生成したかを後から説明できなくなる。
- 実行時に、取り込んだ参照音声の実ファイル SHA-256 が Manifest の記録と一致することを確かめる。
  違えば `VOICE_REFERENCE_MISMATCH` として失敗させる。

つまり参照音声の内容の正しさは利用者が保証し、Application API は「どの Voice Canon を指したか」と
「どの音声ファイルを使ったか」を履歴として固定する。上流が Voice Canon 本文を返すようになれば、
書き起こしと `source_sha256` を参照 API から取る実装へ寄せられる。契約側の変更が要るため、
本 Issue の範囲では入力として受け取る。

#### 参照音声の取り込み

`POST /api/v1/voice-references` は wav を base64 で受け取り、`inputs/<sha256>/<file-name>` へ保存して
相対パスと SHA-256 を返す。同じ内容が既にあれば書き直さない。`multipart/form-data` を使わないのは、
依存を増やさないためである。

受け付けるのは PCM の wav だけとし、`MYCOMFYUI_VOICE_MAX_AUDIO_BYTES` を超える入力は拒否する。
ファイル名は区切り文字と親ディレクトリ参照を取り除いてから使う。

#### 疎通確認と stub

`GET /api/v1/backends/voice/health` は voice-runner の接続先、到達可否、engine ごとの利用可否を返す。
接続できない場合も 200 で返し、`reachable` を偽にして `reason` に理由を入れる。画面で Backend の
状態を出すための Endpoint であり、ここで 5xx を返すと画面全体が落ちるためである。

`MYCOMFYUI_VOICE_STUB=true` にすると、voice-runner の代わりに内蔵 stub が応答する。stub は
seed と本文から決まる正弦波の wav を返し、ASR では既知の誤認識(女子 → 温座子、放課後 → 降下後)を
混ぜた書き起こしを返す。GPU の無い環境で、投入から読み検証までの経路と不一致の表示を確かめるために使う。
`MYCOMFYUI_VOICE_STUB_FAILURE=true` を足すと生成だけを必ず失敗させ、`EXECUTION_FAILED` の
記録を確かめられる。疎通には効かせない。疎通まで落とすと Job が投入前の確認で止まり、生成の
失敗を扱う経路まで届かないためである。voice-runner へ接続できない場合は、接続先を実在しない
URL へ向ければ再現できる。

#### 失敗理由

|事象|`failure_stage`|`failure_code`|`retryable`|
|---|---|---|---|
|voice-runner へ接続できない、engine が使えない|`backend_start`|`BACKEND_UNAVAILABLE`|true|
|Manifest、スナップショット、参照音声を解決できない|`backend_start`|`INPUT_UNRESOLVED`|false|
|参照音声の内容が記録した SHA-256 と違う|`backend_start`|`VOICE_REFERENCE_MISMATCH`|false|
|Backend が生成に失敗した|`execution`|`EXECUTION_FAILED`|false|
|音声のやり取りが上限バイト数を超えた|`execution`|`VOICE_PAYLOAD_TOO_LARGE`|false|
|生成音声を wav として扱えない|`execution`|`AUDIO_DECODE_FAILED`|false|
|生成物を保存・記録できない|`execution`|`ARTIFACT_WRITE_FAILED`|false|
|実行中に voice-runner へ接続できなくなった|`response_disconnect`|`BACKEND_DISCONNECTED`|true|
|制限時間内に完了しない|`timeout`|`EXECUTION_TIMEOUT`|true|

### 保存先

|内容|`data_root` からの相対先|
|---|---|
|実行時 Workflow JSON|`artifacts/<job-id>/workflow.json`|
|生成画像|`artifacts/<job-id>/<ComfyUI の出力ファイル名>`|
|音声の実行スナップショット|`artifacts/<job-id>/workflow.json`|
|生成音声|`artifacts/<job-id>/voice_<台詞の連番>.wav`|
|取り込んだ参照音声|`inputs/<sha256>/<ファイル名>`|

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

要求本文の大きさは、参照音声の base64 を基準に上限を決める
(`MYCOMFYUI_VOICE_MAX_AUDIO_BYTES` から逆算した値に余裕を足したもの)。超えた要求は本文を
読み切る前に 413 で断る。`Content-Length` を申告する要求は共通 Envelope
(`VALIDATION_ERROR`) で返し、申告しない要求 (chunked) は受信バイト数で打ち切るため
`{"detail": ...}` の形になる。

要求 header の `X-Request-ID` は `[A-Za-z0-9._-]` の 1〜64 文字だけ引き継ぐ。
書式を満たさない値は破棄し、サーバ側で採番する。

## 対象外

動画・音楽生成、img2img、LoRA、hires fix、ControlNet、IPAdapter、
再実行(Exact Replay / Regenerate with Current Canon)、Web UI、進捗の UI への中継、認証、削除 API は
本 API の対象外とする。複数 GPU への分散、優先度付きスケジューリング、クラウドキューも対象外とする。
