# ai-media参照API契約v1

## 結論

MyComfyUIは`ai-media`を参照専用HTTP APIとして利用する。Project、Scene、Shot、Canonの取得は`GET`だけで行い、作品正本を変更するEndpointは公開しない。

SceneとShotの本文は既存の`ai-media` JSON Schemaに従う。APIは本文を書き換えず、応答Envelopeの`provenance`で本文ファイル、Schema、Canon参照を不変なGit revisionとSHA-256へ解決する。MyComfyUIが履歴へ保存するのはこの参照情報であり、Canon本文ではない。

機械可読な契約は次に置く。

- [OpenAPI 3.1](../../contracts/ai-media/v1/openapi.yaml)
- [応答JSON Schema](../../contracts/ai-media/v1/schema/reference-api.schema.json)
- [選定revisionの上流Schema snapshot](../../contracts/ai-media/v1/schema/upstream/)

## 代表Scene

Phase 0の代表Sceneには`hirohito-arc02-ep005-sc01`を採用する。2026-09-19時点で`ai-media`に登録されている唯一のSceneであり、初期版から後続Phaseまでに必要な入力の差異を1件で確認できるためである。

|項目|内容|
|---|---|
|Project|`hirohito`|
|Scene|`hirohito-arc02-ep005-sc01`|
|構成|3 Shot、合計20秒|
|人物|朝比奈ひまりを画面内、日向湊をoffscreenとして扱う|
|画像|3 Shotすべてに`comfyui-anima`の生成指定がある|
|動画|MiniMax H3のref2v。参照画像はShotごとに7枚、5枚、5枚|
|音声|台詞あり、台詞なし、複数話者の3種類を含む|
|音楽|Scene単位のACE-Step BGM指定を含む|
|Canon|本文、本文メタデータ、SeriesBible、人物preset、Voice Canon、参照画像を横断する|

このSceneには生成済みArtifactとの正式な関連付けがまだない。選定理由は入出力Schemaと参照解決の網羅性であり、End-to-End生成実績ではない。

### 選定時点

|対象|値|
|---|---|
|`novel-writer` source locator|`ssh://git@github.com/Sylphy0052/novel-writer.git`|
|`novel-writer` revision|`caa010bd579fe1c78319c14a508f3b0a245f6f86`|
|Scene path|`tools/ai-media/projects/hirohito/scenes/hirohito-arc02-ep005-sc01.yaml`|
|Scene SHA-256|`28886b762e292d8d91bb9be7b88365c33362658a3728b2404b915e54e8014264`|
|`agentic-imagegen` source locator|`ssh://git@github.com/Sylphy0052/agentic-imagegen.git`|
|`agentic-imagegen` revision|`4e64c8d15b26e7c58cedea7cdb6238cf2b29850b`|

選定時点の作業ツリーでは`tools/ai-media`に未コミット変更がなく、Scene、3件のShot、Voice Canon、参照元本文は上記`novel-writer` revisionから取得できる。APIは作業ツリーではなくGit objectを読むため、選定後のローカル変更を同じrevisionの内容として返さない。

## Endpoint

Base pathは`/v1`とする。すべてのProject配下Endpointは任意の`revision` queryを受け付ける。省略時はサーバーが設定した`ai-media` sourceの`HEAD`をリクエスト開始時に解決し、応答には40桁のcommit hashを返す。

|Method|Path|用途|
|---|---|---|
|`GET`|`/v1/projects`|Project一覧|
|`GET`|`/v1/projects/{project_id}`|Project詳細|
|`GET`|`/v1/projects/{project_id}/scenes`|Scene一覧|
|`GET`|`/v1/projects/{project_id}/scenes/{scene_id}`|Scene本文とprovenance|
|`GET`|`/v1/projects/{project_id}/scenes/{scene_id}/shots`|Sceneに属するShot一覧|
|`GET`|`/v1/projects/{project_id}/scenes/{scene_id}/shots/{shot_id}`|Shot本文とprovenance|
|`GET`|`/v1/projects/{project_id}/canon`|解決済みCanon descriptor一覧|
|`GET`|`/v1/projects/{project_id}/canon/{canon_id}`|Canon descriptor|
|`GET`|`/v1/schemas/{schema_name}`|`scene`、`shot`、`voice`のJSON Schema|

書込み用の`POST`、`PUT`、`PATCH`、`DELETE`は定義しない。該当Methodへの要求は`405 Method Not Allowed`にする。API processへ作品正本の書込み権限を与えないことも運用条件とする。

## 応答構造

SceneとShotは次のEnvelopeで返す。

```json
{
  "kind": "scene",
  "data": {},
  "provenance": {
    "resource": {
      "source_locator": "ssh://git@github.com/Sylphy0052/novel-writer.git",
      "revision": "caa010bd579fe1c78319c14a508f3b0a245f6f86",
      "path": "tools/ai-media/projects/hirohito/scenes/hirohito-arc02-ep005-sc01.yaml",
      "sha256": "28886b762e292d8d91bb9be7b88365c33362658a3728b2404b915e54e8014264"
    },
    "schema": {
      "name": "scene",
      "reference": {
        "source_locator": "ssh://git@github.com/Sylphy0052/novel-writer.git",
        "revision": "caa010bd579fe1c78319c14a508f3b0a245f6f86",
        "path": "tools/ai-media/schema/scene.schema.json",
        "sha256": "58a72dd842908b5d3bdc08b2b1d23fb1605cac6cf547b3968d1f3e3f0e2e8b88"
      }
    },
    "references": []
  }
}
```

`data`は指定revisionのYAMLをparseした結果である。Sceneは`scene.schema.json`、Shotは`shot.schema.json`で検証してから返す。既存SchemaをAPI用に再定義せず、選定revisionのbyte-identical snapshotをoffline検証用にvendorする。上流Schemaとの差異はSHA-256で検出する。

### 不変参照

すべての参照は次の4項目を必須とする。

- `source_locator`:取得元Git repositoryを一意に示すURI
- `revision`:取得可能な40桁のcommit hash
- `path`:repository rootからの相対path
- `sha256`:指定revisionにあるfile contentのSHA-256

`anchor`と`note`は表示や参照箇所の特定に使えるが、同一性の判定には使わない。相対pathは絶対pathと`..`を拒否する。`source_locator`はサーバー設定の許可リストからだけ解決し、リクエスト値を任意のrepository cloneやfile accessに使わない。

Scene/Shot本文内の参照は`provenance.references`へ展開する。各要素は元の場所をJSON Pointerで示し、解決前のpathと不変参照を併記する。複数repositoryに同じ相対pathが存在しても、探索順で暗黙に選ばない。

### Canon

Canon EndpointはCanon本文を返さず、`canon_id`、種別、表示名、不変参照だけを返す。`canon_id`は`[source_locator,revision,path,anchor]`をこの順のJSON配列として空白なしのUTF-8へserializeし、そのSHA-256を小文字16進数64桁で表す。`anchor`が無い場合はJSONの`null`とする。

MyComfyUIはCanon descriptorを画面表示とGeneration Manifestの参照に使う。Canon本文、Voice Canon YAML、人物preset、SeriesBibleをSQLiteやArtifact領域へ複製しない。生成時に解決済みの値が必要な場合は生成Adapterが参照API側でcompileされた入力を受け取る契約を別Issueで定義する。

現行Voice Canonの`source_audio`には作成者環境の絶対pathが入っている。参照APIはこの絶対pathを応答へ公開せず、許可されたrepository内の相対pathと不変参照へ正規化できない場合は`REFERENCE_NOT_IMMUTABLE`を返す。

## Revisionと取得規則

1. リクエスト開始時に対象sourceごとのrevisionを1回だけ解決する。
2. Scene、Shot、Schema、Canonは作業ツリーではなく`git show <revision>:<path>`相当で読む。
3. SHA-256はGit blobを復号したfile contentに対して計算する。
4. 外部参照先も同じリクエスト中は同じrevisionへ固定する。
5. 指定revisionがローカルに無くてもAPIから自動fetchしない。
6. branch名、tag、短縮hash、`HEAD`という文字列をprovenanceへ保存しない。

MyComfyUIは応答を受け取るたびにJSON SchemaとSHA-256を検証する。Generation Manifestには応答時の不変参照を保存する。再実行時にrevisionを取得できない場合、現在の`HEAD`へ置き換えずExact Replayを実行不能にする。

## Schema version

API contractはURLのmajor versionで管理する。v1内では次を守る。

- 必須fieldの削除、意味変更、型変更、enum値の削除をしない。
- 任意fieldと新しいEndpointは追加できる。
- Scene/Shot Schemaは応答の`provenance.schema`でrevisionとSHA-256を固定する。
- MyComfyUIが未対応のSchema hashを受け取った場合は表示を継続せず、`SCHEMA_UNSUPPORTED`として扱う。

選定時点のSchemaは次のとおりである。

|Schema|Path|SHA-256|
|---|---|---|
|Scene|`tools/ai-media/schema/scene.schema.json`|`58a72dd842908b5d3bdc08b2b1d23fb1605cac6cf547b3968d1f3e3f0e2e8b88`|
|Shot|`tools/ai-media/schema/shot.schema.json`|`1d146c7455be2295dcc1453757cce6f98d77e572cc65c671af4c9f5e809e712e`|
|Voice Canon|`tools/ai-media/schema/voice.schema.json`|`d8cf0eba871c054c349ad33b336c47b06da4e9a65d9fce9431d5ce91b699f718`|

## エラー

エラーはADR 0001の共通Envelopeで返す。

```json
{
  "code": "REVISION_UNAVAILABLE",
  "message": "指定されたrevisionを取得できません。",
  "details": {
    "source_locator": "ssh://git@github.com/Sylphy0052/novel-writer.git",
    "revision": "0000000000000000000000000000000000000000"
  },
  "request_id": "01K5..."
}
```

|HTTP|Code|条件|
|---|---|---|
|`404`|`PROJECT_NOT_FOUND`、`SCENE_NOT_FOUND`、`SHOT_NOT_FOUND`、`CANON_NOT_FOUND`|IDに対応するresourceが指定revisionにない|
|`409`|`REVISION_UNAVAILABLE`|sourceは設定済みだがcommit objectを取得できない|
|`409`|`REFERENCE_BROKEN`|本文に宣言された参照先が指定revisionにない|
|`409`|`REFERENCE_NOT_IMMUTABLE`|絶対path、未追跡fileなどを不変参照へ変換できない|
|`409`|`CONTENT_HASH_MISMATCH`|Canonに記録済みのhashと指定revisionのcontentが一致しない|
|`422`|`SCHEMA_MISMATCH`|YAMLは取得できたが対応Schemaに適合しない|
|`503`|`SOURCE_UNAVAILABLE`|設定されたrepository自体を読めない|

`details`には対象ID、JSON Pointer、source locator、revision、pathのうち診断に必要な値を含める。ローカルの絶対path、秘密情報、file contentは含めない。

## 現行実装との差分

`novel-writer`側には次の追加が必要である。

- HTTP参照APIとProject projection
- Git objectからScene、Shot、Schemaを読む処理
- 相対pathごとのsource明示と、不変参照への展開
- Canon descriptorの列挙と決定的ID生成
- Voice Canonの絶対pathを公開しない正規化
- 本契約のエラー分類

現行`Repositories.resolve()`は`novel-writer`、`agentic-imagegen`、project directoryの順に同じ相対pathを探索する。この挙動は参照元を一意に証明できないため、参照APIでは使用しない。

上流実装は[novel-writer#17](https://github.com/Sylphy0052/novel-writer/issues/17)で管理する。
