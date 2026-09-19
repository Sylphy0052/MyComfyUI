# 生成履歴と資産保存の設計

## 目的

画像生成MVPで生成要求、出力、実行時点の入力、再利用可能なRecipe、承認を追跡する。SQLiteはApplication APIだけが書き込み、Canon本文は保存しない。[MyComfyUI計画](../PLAN.md)と[ai-media参照契約](../contracts/ai-media-read-api-v1.md)の不変参照を前提とする。

## 共通規則

- IDはUUIDv7文字列とし、作成後に変更しない。
- 時刻はUTCのRFC 3339文字列で記録する。
- 外部ファイル参照は保存先ルートからの相対パスに限定し、絶対パスと親ディレクトリ参照を保存しない。
- SHA-256は小文字16進数64文字で保存する。ファイル内容が変われば別のArtifactとして記録する。
- Canon、Scene、Shot、入力素材の外部参照は`source_locator`、不変`revision`、repository相対`path`、`sha256`の組で固定する。Canon本文をSQLite、Manifest、Artifact領域へ複製しない。
- `created_at`と作成時の値は更新しない。訂正、再実行、採否変更は後述の許可された可変項目または新規レコードで表す。

## 最小データSchema

### GenerationJob

|項目|必須|内容|更新可否|
|---|---|---|---|
|`id`|必須|Job ID|不可|
|`kind`|必須|`image`、将来の`video`、`voice`、`music`、`compose`|不可|
|`state`|必須|現在の実行状態|状態遷移規則に従う|
|`scene_ref`、`shot_ref`|必須|対象Scene/Shotの不変参照|不可|
|`recipe_id`|必須|使用したRecipe ID|不可|
|`manifest_id`|必須|実行時スナップショットのManifest ID|不可|
|`parent_job_id`|任意|派生元Job ID|不可|
|`queue_sequence`|必須|GPUキュー投入順|不可|
|`cancel_requested_at`|任意|取消要求時刻|取消要求時のみ設定|
|`started_at`、`finished_at`|任意|開始・終了時刻|それぞれ1回だけ設定|
|`failure_code`、`failure_message`|任意|失敗理由|`failed`時のみ1回設定|

`parent_job_id`は同じProject内の既存Jobを指す。循環参照は禁止する。Jobを削除せず、表示対象から外す場合も履歴は保持する。

### Artifact

|項目|必須|内容|更新可否|
|---|---|---|---|
|`id`|必須|Artifact ID|不可|
|`job_id`|必須|作成元Job ID|不可|
|`kind`|必須|`image`、`video`、`audio`、`workflow`、`log`など|不可|
|`relative_path`|必須|Artifact store内の相対パス|不可|
|`sha256`、`byte_size`、`media_type`|必須|内容識別と表示用メタデータ|不可|
|`parent_artifact_id`|任意|派生元Artifact ID|不可|
|`created_at`|必須|保存完了時刻|不可|
|`decision`、`decision_at`|必須|`undecided`、`accepted`、`rejected`と判断時刻|判断時のみ更新可|

`job_id`は成功したJobを指す。`parent_artifact_id`は同一Project内の既存Artifactを指し、循環参照は禁止する。保存済みファイルを置換しない。再出力は別Artifactとして記録する。

### GenerationManifest

|項目|必須|内容|更新可否|
|---|---|---|---|
|`id`|必須|Manifest ID|不可|
|`job_id`|必須|対象Job ID|不可|
|`engine`、`engine_version`|必須|実行Backendとバージョン|不可|
|`model`|必須|モデル識別子、版、SHA-256|不可|
|`seed`、`resolved_prompt`、`parameters`|必須|解決済みseed、最終prompt、実行パラメータ|不可|
|`input_refs`|必須|入力素材、Scene、Shot、Canonの不変参照|不可|
|`workflow_artifact_id`|必須|実行時Workflow JSONのArtifact ID|不可|
|`created_at`|必須|スナップショット確定時刻|不可|

ManifestはJobごとに1件とする。`parameters`はJSON object、`input_refs`は不変参照の配列として保存する。Workflow JSONはArtifact storeへ書き出し、そのSHA-256とArtifact IDで参照する。ManifestとArtifactの内容は変更しない。

### Recipe

|項目|必須|内容|更新可否|
|---|---|---|---|
|`id`|必須|Recipe ID|不可|
|`name`、`kind`|必須|利用者向け名称と生成種別|不可|
|`engine`|必須|対象Backend|不可|
|`workflow_template_ref`|必須|登録済みWorkflow templateの不変参照|不可|
|`input_schema`、`defaults`|必須|受け取る変数と既定値|不可|
|`supersedes_recipe_id`|任意|置換したRecipe ID|不可|
|`created_at`|必須|作成時刻|不可|

Recipeの変更は更新ではなく新規Recipeで表し、必要なら`supersedes_recipe_id`で後継を結ぶ。Jobは実行時に使用したRecipe IDを保持する。

### ApprovalLog

|項目|必須|内容|更新可否|
|---|---|---|---|
|`id`|必須|承認記録ID|不可|
|`subject_type`、`subject_id`|必須|提案、Job、ファイル操作などの対象|不可|
|`requested_operation`|必須|実行予定の操作と対象のJSON|不可|
|`decision`|必須|`approved`、`rejected`、`expired`|不可|
|`actor_type`、`actor_id`|必須|提案者または承認者の種別と識別子|不可|
|`decided_at`|必須|判断時刻|不可|
|`expires_at`|任意|承認の有効期限|不可|

ApprovalLogは追記専用とする。承認済みの記録を編集・再利用せず、操作対象または差分が変わった場合は新しい承認を要求する。

## 参照整合性

- `GenerationJob.manifest_id`と`GenerationManifest.job_id`は1対1で一致する。
- `Artifact.job_id`、`GenerationManifest.workflow_artifact_id`、各親IDは削除連鎖を行わない外部キーとする。
- JobとArtifactの親子関係はProjectをまたがない。
- 外部参照の`revision`と`sha256`の検証に失敗した場合、記録済み値を更新せず、検証失敗としてJobを失敗させるか再実行不能として扱う。
