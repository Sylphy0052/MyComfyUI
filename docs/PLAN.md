# MyComfyUI計画

## 結論

個人向けの統合制作環境として、まずローカルで動くWeb UIを作る。Windowsアプリは同じUIとローカルAPIをTauriで包む第2段階とし、初期からデスクトップ専用UIを作らない。

初期版は「Scene/Shotから画像を生成し、Artifactと生成履歴を管理する」ことに絞る。音声、動画、音楽は計画から外さず、画像生成の実行境界と履歴管理が安定してから順に追加する。

新しい生成基盤を一から作らない。`~/workspace/github/novel-writer/tools/ai-media`にあるScene/Shot/Artifact/Voice Canon、ComfyUI、既存の画像・動画・音声・BGM環境をMyComfyUIから操作・可視化する。`novel-writer`の作品正本は参照専用とし、MyComfyUIが無断で書き換えない。`ai-media`を共有ライブラリとして直接取り込まず、JSON Schema、ID、参照、provenanceの契約だけを共有し、実装はローカルAPI境界で分離する。

## 既存資産と統合方針

|領域|既存資産|MyComfyUIで担うこと|
|---|---|---|
|作品・制作単位|`ai-media`のProject、Scene、Shot、Canon|作品・Scene・Shotを選び、制作状況を一覧化する|
|画像|ComfyUIのAnima、既存`agentic-imagegen`|プリセット選択、生成投入、候補比較、採否と出自の表示|
|動画|ComfyUI同梱のMiniMax H3|R2V/I2V、参照画像、タイムライン、ジョブ状態、結果確認|
|音声|Qwen3-TTS、VoxCPM2、CosyVoice3、Whisper|Voice Canonの選択、かな読み、生成、ASR検証、比較|
|音楽|ComfyUIのACE-Step、ffmpeg|SceneのBGM生成と最終動画への合成|
|口パク|MuseTalkの設計枠|必要なShotだけ後続で有効化する|
|再現性|Generation Manifest、入力hash、seed、実行パラメータ|生成物の出自、比較、再実行を画面で追跡する|

`ai-media`のorchestratorは現在、Schema検証とJSON Schema出力まで実装済みである。Image、Video、Voice、Music、ComposeのAdapterと生成コマンドは未実装である。MyComfyUIは`ai-media`の内部実装を直接呼ばず、Scene/Shot/Canonを参照専用のローカルAPIから取得する。生成Adapter、ジョブ、Artifact、履歴はMyComfyUIのApplication APIが管理する。

## 初期版の対象

- `ai-media`のProject、Scene、Shot、Canonを参照専用で表示する。
- ComfyUIへ画像生成ジョブを投入し、待機、実行中、成功、失敗、キャンセルの状態を管理する。
- Artifact、入力、プロンプト、モデル、seed、実行パラメータ、Workflowを生成履歴として保存する。
- Canon更新警告、再実行方式、親子Jobのlineageを画面で確認できるようにする。
- GPUを高負荷で使う生成ジョブは直列実行し、エンジンごとの仮想環境とプロセスを分離する。
- エージェントは提案だけを行う。ジョブ投入、ファイル操作、Git操作、外部送信は許可リストと明示承認を必須にする。

ffmpegは後続の動画・音声合成に備えて実行境界だけを初期版で定義し、メディア統合機能は後続段階で実装する。

## 対象範囲

- 画像:SD1.5、SDXL、Illustrious、Animaをプリセットとして扱う。既存の人物・背景・ポーズ参照をShotへ関連付ける。
- 動画:MiniMax H3をComfyUI APIへ投入する。動画の尺、参照画像、開始フレーム、音声ガイドを管理する。
- 音声:PrimaryをQwen3-TTS VoiceClone、SecondaryをVoxCPM2 Cloneとする。CosyVoice3は選択可能な比較用Backendとして保持する。
- 音楽:ACE-StepでBGMを生成し、ffmpegで動画・音声と合成する。
- エージェント:Codex、Claude Code、ローカルLLM(Qwen)の選択、指示、結果、変更対象、承認を記録する。
- 資産:入力素材、生成物、プロンプト、ワークフロー、Canon参照、実行履歴、採否、派生関係を扱う。

初期対象外は、複数ユーザーの権限管理、クラウド同期、モデル学習、スマートフォンUIである。

## 制作フローとして守る制約

1. Canonは複製せず、IDと参照先で結ぶ。人物設定、参照音源、既存画像の正本を生成リクエストへコピーしない。参照時点は`source locator`、取得可能な不変`revision`、`path`、SHA-256で固定する。
2. SceneとShotは制作の最小単位とし、生成結果はGeneration Manifestで解決済み入力、モデル、seed、最終プロンプト、実行パラメータ、実行時間を記録する。
3. H3動画の尺は17k+5フレームのグリッドで決め、音声は動画尺に合わせて無音をパディングする。セリフはかな読みを持たせ、Whisperで読み間違いを検証できるようにする。
4. 生成エンジンのPython環境は統合しない。ComfyUI、Qwen3-TTS、VoxCPM2、CosyVoice3は既存どおり別venv・別プロセスで起動する。これらはGPUを持つRemote PCで動かし、Application APIからはHTTPとWebSocketだけで接続する。配置と待受方式は[ADR 0002](adr/0002-remote-gpu-host.md)に従う。
5. 大きな生成物はGitへ原則コミットしない。Gitではソース、Schema、ワークフロー、設定例、メタデータを管理し、生成物はローカル資産ストアとメタデータで対応付ける。
6. APIキーとエージェント認証情報はOSの資格情報ストアまたはローカル環境変数に保存し、リポジトリと実行履歴へ保存しない。

## データと再実行

MyComfyUIのSQLiteには次の最小データを保存する。

|データ|責務|
|---|---|
|`GenerationJob`|Scene/Shot、Recipe、状態、キュー順、親Job、開始・終了時刻、キャンセル要求、失敗理由を管理する|
|`Artifact`|生成物の種別、保存先、SHA-256、採否、作成元Job、派生元Artifactを管理する|
|`GenerationManifest`|解決済み入力、Canon参照、モデル識別子、seed、プロンプト、パラメータ、Workflowスナップショットを固定する|
|`Recipe`|生成エンジン、プロファイル、Workflow、変数として受け取る入力の組合せを再利用可能にする|
|`ApprovalLog`|提案、実行対象、許可された操作、判断、実行者、時刻を記録する|

ComfyUIのWorkflow JSONは実行時の内容をMyComfyUI側へスナップショット保存する。Canon本文は複製せず、Generation Manifestに参照情報だけを残す。`revision`は将来も取得可能なGitコミットなどの不変識別子でなければならない。

再実行は次の2種類を区別する。

- Exact Replay:当時のCanon、Workflow、モデル、seed、解決済み入力で再実行する。必要なrevisionやモデルを取得できない場合は実行不能として理由を表示し、現在値へ暗黙に置き換えない。
- Regenerate with Current Canon:最新Canonを解決し、元Jobを親とする派生Jobとして新規生成する。過去のArtifactとGeneration Manifestは変更しない。

現在のCanonと記録済みSHA-256が異なる場合、Artifact一覧と再実行画面に警告を表示する。親子Jobと派生Artifactはlineageとして追跡できるようにする。

## アーキテクチャ方針

```text
Web UI
  ├─ 制作画面・資産ブラウザ・実行履歴・エージェント画面
  └─ ローカルAPI
       ├─ ai-media参照API(Scene/Shot/Canon、read-only)
       ├─ 契約(JSON Schema/ID/参照/provenance)
       ├─ 実行Adapter
       │    ├─ ComfyUI API(Anima/MiniMax H3/ACE-Step)
       │    ├─ agentic-imagegen CLI
       │    ├─ Qwen3-TTS/VoxCPM2/CosyVoice3
       │    ├─ Whisper
       │    └─ ffmpeg
       ├─ 資産・実行履歴ストア
       ├─ GPUジョブキュー
       └─ エージェントAdapter(Codex/Claude Code/Qwen)
```

- UIは生成エンジン固有のノード名やモデルファイル名へ直接依存しない。プロファイルとAdapterで分離する。
- `ai-media`とMyComfyUIはJSON Schemaと参照契約だけを共有し、DB Schema、Python依存、リリース周期を結合しない。
- Web UI、Application API、SQLite、Artifactストアは手元PCで動かし、GPUを使う生成BackendはLAN上のRemote PCへ置く。生成物は共有フォルダではなくHTTPで受け取る。
- Remote PCではComfyUIを常駐させ、画像・動画・音楽の生成を1プロセスへ集約する。TTSとWhisperは常駐させず、要求時に起動して終了後にVRAMを返す。VRAM実測値からComfyUIとの同時常駐に耐えないため。
- ComfyUI、Qwen3-TTS、VoxCPM2、CosyVoice3は別venv・別プロセスのままAdapter越しに扱う。GPU高負荷ジョブは共通キューで直列実行する。
- MyComfyUI自身のプロジェクトと`novel-writer`の作品を明確に区別する。前者は新規制作・試行を管理し、後者はCanonを参照する場合だけ接続する。

## 技術スタック

|領域|採用技術|
|---|---|
|Web UI|React 19、TypeScript、Vite、Node.js 24 LTS、npm|
|Application API|Python 3.12、FastAPI、Uvicorn、Pydantic 2、uv|
|永続化|SQLite、SQLAlchemy 2、aiosqlite、Alembic|
|画面との契約|REST/OpenAPIを状態の正本とし、WebSocketを進捗通知に使う|
|Windowsアプリ|Phase 6でTauri 2を追加し、Application APIをPython sidecarとして起動する|

Web版とTauri版は同じHTTP/WebSocket契約を使う。UI、Application API、生成Backendのプロセスと依存環境を分け、SQLiteはApplication APIだけが読み書きする。採用理由、開発時の起動構成、リポジトリ構成、バージョン方針、不採用案は[ADR 0001](adr/0001-application-stack-and-boundaries.md)に記録する。

## ai-media参照契約

Phase 0の代表Sceneは`hirohito-arc02-ep005-sc01`とする。3件のShotに画像、ref2v、台詞あり・なし、複数話者、BGM、複数repositoryのCanon参照が含まれ、参照APIの境界を1件で確認できる。

MyComfyUIは`ai-media`の[参照API契約v1](contracts/ai-media-read-api-v1.md)を利用する。Scene/Shot本文は既存JSON Schemaのまま受け取り、本文、Schema、Canon参照を`source_locator`、40桁のGit revision、repository相対path、SHA-256で固定する。Canon Endpointは本文を返さずdescriptorだけを返し、MyComfyUIはCanon本文をSQLiteやArtifact領域へ複製しない。

参照APIの`novel-writer`側実装は[novel-writer#17](https://github.com/Sylphy0052/novel-writer/issues/17)で追跡する。

## 画面構成

- ダッシュボード:プロジェクト、Scene、Shot、最近の生成、実行中・失敗ジョブを確認する。
- 制作:Sceneのタイムライン、Shot、台詞、かな読み、尺、参照画像、画像・動画・音声・BGMの実行要求を編集する。
- 生成:画像・動画・音声・音楽のプリセット、入力、キュー、キャンセル、失敗理由、ログ、結果比較を提供する。
- 資産:生成物と入力素材をプレビューし、採用・却下・タグ・派生関係・Canon更新警告・再現情報を管理する。
- ワークフロー:ComfyUIワークフローを登録し、変数、対応モデル、入力・出力、実行スナップショットを管理する。
- エージェント:実行エージェント、作業ディレクトリ、入力コンテキスト、許可する操作、出力、承認結果を明示する。
- 設定:ComfyUI、各Backend、モデル、保存先、エージェント、資格情報の参照先を設定する。

## エージェント自動化

|段階|例|実行条件|
|---|---|---|
|提案|プロンプト、Shot構成、参照画像一覧、ワークフロー、台本の作成|即時実行可|
|準備|ワークフロー登録案、バッチ生成計画、資産分類|内容確認後に反映|
|実行|生成ジョブ投入、ファイル移動、Git操作、外部送信|対象と差分を表示し、明示承認後に実行|

CodexとClaude CodeのCLI/API利用形態、Qwenのローカル推論サーバーは実装開始時に確定する。どのエージェントも入力、ツール実行、出力、変更対象、承認結果を履歴へ残す。

## 段階的な実装計画

### Phase 0:既存基盤の接続確認

- `ai-media`のProject、Scene、Shot、Canonを参照専用で取得するローカルAPIと、共有するJSON Schema・参照契約を定義する。
- `novel-writer`の代表Sceneを一つ選び、Canon、Shot、画像、H3動画、音声、BGM、最終動画の入出力を棚卸しする。
- ComfyUI API、`agentic-imagegen`、Qwen3-TTS、VoxCPM2、CosyVoice3、Whisper、ffmpegの起動・終了・失敗取得の契約を定義する。
- MyComfyUI側の資産保存先と、`novel-writer`を参照専用にする境界を決める。
- `GenerationJob`、`Artifact`、`GenerationManifest`、`Recipe`、`ApprovalLog`の最小Schemaを確定する。

### Phase 1:生成Adapterと画像UI

- MyComfyUIのImage AdapterとComfyUI実行Adapterを実装する。
- プロジェクト、Scene、Shotの選択、Animaを含む画像プリセット、ジョブ投入、進捗、結果比較を実装する。
- GPUジョブの直列キュー、キャンセル、失敗理由の表示を実装する。
- Workflow JSONとGeneration Manifestを保存し、Canon更新警告、Exact Replay、Regenerate with Current Canon、lineage表示を実装する。

### Phase 2:音声

- Qwen3-TTS、VoxCPM2、WhisperのAdapterと実行履歴を実装する。
- かな読み、音声尺、無音パディング、ASR検証をUIで扱えるようにする。

### Phase 3:動画・音楽・合成

- MiniMax H3、ACE-Step、ffmpegのAdapterと実行履歴を実装する。
- H3のフレームグリッド、参照画像上限、開始フレーム、音声ガイドをUIで検証する。
- Sceneから画像、動画、音声、BGM、最終動画までをたどれるようにする。

### Phase 4:資産・ワークフロー管理

- 生成物・入力素材のプレビュー、採否、タグ、派生関係、再生成を実装する。
- ComfyUIワークフローの登録、変数化、バージョン、実行前確認、実行スナップショットを実装する。

### Phase 5:エージェントと自動化

- Codex、Claude Code、Qwenの選択と接続設定を実装する。
- Shot構成、プロンプト、ワークフロー、バッチ生成計画、資産整理を承認付きで実行できるようにする。
- MuseTalkはH3動画と外部音声の合成で不足するShotが確認されてから追加する。

### Phase 6:Windowsアプリ化

- Web UIとローカルAPIを維持したままTauriでWindowsアプリを提供する。
- ローカルプロセス起動、保存先選択、通知、更新をデスクトップ機能として追加する。

## 初期版の成功条件

- `novel-writer`の既存Canonを変更せず、一つのSceneとShot群をMyComfyUIで読める。
- Animaを含む画像生成ジョブを投入し、キュー、進捗、キャンセル、失敗理由、結果比較を確認できる。
- 生成物から入力、Canon参照、モデル、seed、Workflow、プロンプト、実行パラメータを確認できる。
- Canon更新を検出し、Exact ReplayとRegenerate with Current Canonを区別して再実行できる。
- 親子Job、派生Artifact、承認履歴を追跡できる。
- エージェントから提案を取得できるが、明示承認なしに生成やファイル操作を実行しない。

## 最終的な成功条件

- MiniMax H3動画、Qwen3-TTSまたはVoxCPM2音声、ACE-Step BGMを実行・取込できる。
- 音声の尺・かな読み・ASR検証、H3の参照画像とフレームグリッドの制約を実行前に確認できる。
- Codex、Claude Code、Qwenから一つを選び、提案を取得できる。
- 生成実行、ファイル操作、Git操作、外部送信を伴う自動化は、明示承認なしに実行しない。

## 次に決めること

1. MyComfyUIで新規作成するプロジェクトの資産保存先と、既存作品を参照する接続設定を決める。
