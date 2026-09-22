# WebUI ギャップ分析

## この文書の位置付け

[webui-use-cases.md](./webui-use-cases.md) で定義したあるべき使い方に対し、現在の実装がどこまで届いているかを実測で突き合わせた結果である。

改善の方針は **画面をリッチに使いやすくすることを優先** する。データモデルの拡張やエンジンの追加より、既にある機能を使える形で画面に出すことを先に行う。

調査対象は次のとおり。

- `apps/web/src`（`App.tsx` + `components/*.tsx` 30 ファイル、計 10,906 行）
- `apps/api`（7 ルーター、HTTP 113 エンドポイント + WebSocket 1）
- `~/workspace/github/novel-writer` 側のプロンプト資産

## 全体の結論

**バックエンドはほぼ揃っている。ギャップの大半は UI 層にある。**

API 側は画像・動画・音声・音楽・合成の 5 媒体すべてが実装済みで、i2i / inpaint / upscale / ControlNet / 動画参照画像 / 開始フレーム、名前付き入力セット（LookProfile）、複数対象への一括展開（GenerationBatch）、パラメータスイープ（GenerationExperiment）、Job の親子と lineage、Replay / Regenerate、WD14 Tagger によるタグ抽出まで動く。

一方 UI は、それらを**機能ごとに並べて全部見せている**。その結果が次の実測値である。

- 生成 View に常時見えている操作要素は約 **58 個**、折りたたみを開くと **70 個超**。
- 一方 Workflow View の操作要素は **1 個**（select ひとつ）だけ。
- 画面の状態は **一切永続化されていない**（`localStorage` / `sessionStorage` / URL いずれも使用箇所 0 件）。リロードで選択中の Project も入力も消える。

つまり、機能が足りないのではなく、**機能の出し方が使い方に合っていない**。これはユースケース文書で立てた「モードA の機能がモードB の画面から見えていることが問題」という見立てと一致する。

## 現状の実測サマリ

### 画面構造

| View | 常時見えている操作要素（概算） | 備考 |
|---|---|---|
| `generate` | 約 58（展開時 70 超） | `App.tsx:688-931`。SceneBrowser / 生成タブ 5 種 / CandidateGallery / JobQueue / AgentPanel が同居 |
| `projects` | 約 21（モーダル 5 種を含めると 65 超） | `ProjectWorkspace.tsx`（756 行）にツールバー・一覧・詳細・一括生成・同期・移行が集約 |
| `assets` | 約 30 | `AssetBrowser.tsx`（773 行）。絞込み select 5 個 + タグ + 一括操作 + 詳細ペイン |
| `workflows` | **1** | `WorkflowRegistry.tsx:160`。残り 3 節はすべて読み取り専用 |

- View は `App.tsx:41` の 4 つ。`Project` / `生成` / `資産ブラウザ` / `Workflow` という**機能軸**の分類で、利用モードの軸ではない。
- 生成タブは `App.tsx:42` の 5 つ（画像/動画/音楽/音声/合成）。画像だけサブタブ 3 つ（生成/派生/スイープ）を持つ（`App.tsx:43`）。
- 生成タブ・サブタブは `hidden` 属性で隠すだけでアンマウントされない（`App.tsx:740,773,792,809,848,863,879,895`）。一方 View 切替は条件レンダリングでアンマウントされる（`App.tsx:680,688,933,959`）。**同じ「切り替え」なのに挙動が違う。**

### 状態管理

- `localStorage` / `sessionStorage` / `indexedDB` / `cookie` の使用箇所は `apps/web/src` 全体で **0 件**。
- URL に状態を載せていない（ルーターへの依存なし。`window.location` は `App.tsx:323-324` の WebSocket URL 組み立てのみ）。
- リロードすると View は必ず `generate`、生成タブは `image`、サブタブは `generate`、`projectId` は `null` に戻る（`App.tsx:104-110`）。
- `GenerationForm.tsx:161-166` — Recipe を変更すると `setValues(initialValues(...))` が走り、**入力済みのプロンプトが Recipe 既定値で上書きされる**。

### 入力画像

- 入力画像を選ぶ UI は **8 箇所**（画像は 7 箇所）。`GenerationForm.tsx:340`（タグ抽出）、`ImageDerivationPanel.tsx:350`（派生元）、`:402`（mask）、`VideoPanel.tsx:606`（ref2v 参照）、`:658`（i2v 開始フレーム）、`:700`（ガイド音声）、`ExternalImageImportPanel.tsx:109`（外部取込）、`ProjectLocalOverridesEditor.tsx:269`（人物参照画像）。
- **画像ピッカーの共通コンポーネントは存在しない。** 7 箇所すべてが個別の `<input type="file">` とハンドラで実装されている。登録関数も `ImageDerivationPanel.tsx:275` の `registerInput`、`VideoPanel` の `addReferenceFile`、`ProjectLocalOverridesEditor.tsx:172` の `uploadReference` とそれぞれ別。
- API 側も保管の入口が 4 系統に分かれている（入力 cache / Artifact / 外部インポート Artifact / Project の `local_overrides` JSON）。Job 投入時の指定だけは `sources.py:15` の `artifact_id / relative_path / sha256` に統一済み。

### プロンプト

- プロンプト系の入力欄は **13 箇所以上**に散在。うち 3 箇所は **JSON textarea の中でプロンプトを編集する形**（`ProjectGenerationDefaultsEditor.tsx:177`、`LookProfileManager.tsx:208`、`ProjectOperations.tsx:294`）。
- `PromptAssist` を使っているのは `GenerationForm.tsx:392` と `ImageDerivationPanel.tsx:380` の **2 箇所のみ**。動画・音声・音楽・合成・スイープには無い。
- `PromptAssist.tsx:36` — 結果は `onApply` で **全文置換**される。API 側の `ImagePromptAssistRead`（`schemas.py:1542`）も positive / negative の全文を返す。
- **プロンプトを差分で編集する仕組みは UI・API ともに無い。** 差分を扱う UI は `ExecutionPreview.tsx:109`（Workflow 変数の差分）、`CanonWarning.tsx:77`（Canon 差分）、`CandidateGallery.tsx:361`（A/B メタデータ比較）の 3 つだが、いずれも**表示のみ**。
- API 側 `ProposalRequest`（`adapters/agent/base.py:57`）に画像を渡すフィールドが無く、3 provider（claude_code / codex / qwen）いずれも画像を送らない。**画像を見せて直す経路は存在しない。**

### 工程・進捗

- **順序・次アクション・ウィザード・ステッパーに相当する UI は無い。** View / タブ / サブタブはすべて並列の切替。
- API 側にもパイプラインの状態機械は無い。あるのは Job 単体の状態（`models.py:288`）、単一キューの `queue_sequence`（`models.py:311`）、Scene/Shot の `production_status`（`models.py:111,140`）のみ。
- `ProjectWorkspace.tsx:485-501` の「制作進捗」5 行は、`SceneBrowser.tsx:326` の select から**使用者が手で設定した値**の集計である。生成の実績と連動しない。さらに `source_type === "local"` のときしか表示されない（`ProjectWorkspace.tsx:483`）。

### Preset

「名前を付けて保存して再利用する」概念が 4 つに分かれている。

- `Recipe`（`models.py:232`）— エンジン・Workflow・input_schema・defaults。作成と参照のみで更新・削除は無い（改訂は `supersedes_recipe_id` で新レコード）。
- `LookProfile`（`models.py:254`）— 名前付き入力セット。Job へ最大 10 件重ね掛け。CRUD 完備。
- `ProjectTemplate`（`models.py:93`）— Project 設定の雛形。
- `ProjectGenerationDefaults`（`schemas.py:146`）— 媒体別の既定 Recipe / inputs、Project→Scene→Shot 継承。

**良かった生成物やフォームの現在値から Preset を作る導線は無い。** UI 上で新規作成できるのは LookProfile だけで、それも `GenerationForm.tsx:442` の折りたたみ「ルックとバリエーション」の中の、さらに `LookProfileManager.tsx:160` の折りたたみの中という**二重の入れ子**にある。

### キャラクター

- API 側 `ProjectCharacterProfile`（`schemas.py:323`）が持つのは `id / name / tags / reference_images` のみ。**衣装・外見・声の専用フィールドは無い。**
- UI 上の置き場は `SceneBrowser.tsx:162` → `ProjectLocalOverridesEditor.tsx:247` で、生成 View の Scene 一覧の中に入れ子で存在する。
- novel-writer 側には `works/*/Visuals/Prompts/` に衣装別・表情別のプロンプト資産が 800 ファイル規模で蓄積されているが、**取り込む経路は無い。**

## ギャップ一覧

severity は「あるべき使い方がどの程度成立しないか」で判定する。**高** = そのユースケースが成立しない、**中** = 成立するが手数・迷いが大きい、**低** = 使い勝手の劣化にとどまる。

### 構造（モード分離）

| ID | ギャップ | 根拠 | 対応 UC | severity |
|---|---|---|---|---|
| G-01 | モードA / モードB の分離が無い。View 4 つは機能軸の分類 | `App.tsx:41,45-50` | 全体 | 高 |
| G-02 | 生成 View に操作要素が約 58 個同時露出。作品制作の使用者に対して過剰 | 実測値、`App.tsx:688-931` | モードB 全般 | 高 |
| G-03 | 工程・順序・次アクションを示す UI が無い | 該当なし（UI・API とも） | UC-B1〜B7 | 高 |
| G-04 | Workflow View は操作要素 1 個。画面が空疎で、他 View の過密と不均衡 | `WorkflowRegistry.tsx:160` | UC-A7 | 低 |

### 状態の保持と復元

| ID | ギャップ | 根拠 | 対応 UC | severity |
|---|---|---|---|---|
| G-05 | 画面状態が一切永続化されない。リロードで Project 選択も入力も消える | `apps/web/src` 全体で storage 系 0 件、`App.tsx:104-110` | UC-B9 | 高 |
| G-06 | View 切替でアンマウントされ入力が消える。一方タブ切替は `hidden` で保持され、挙動が不統一 | `App.tsx:680,688,933,959` と `:740,773,792,809` | 横断「入力を失わせない」 | 高 |
| G-07 | Recipe を変えるとプロンプトが既定値で上書きされる | `GenerationForm.tsx:161-166` | 横断「入力を失わせない」 | 中 |
| G-08 | URL に状態が載らない。ブックマーク・ブラウザの戻るが効かない | ルーター依存なし | UC-B9 | 中 |
| G-09 | 資産ブラウザから「この画像から派生生成」を押すと生成 View が再マウントされ、直前の入力が初期化される | `App.tsx:945-949` | UC-M2 | 中 |

### 画像管理

| ID | ギャップ | 根拠 | 対応 UC | severity |
|---|---|---|---|---|
| G-10 | 画像ピッカーの共通コンポーネントが無い。7 箇所が個別実装 | `GenerationForm.tsx:340`, `ImageDerivationPanel.tsx:350,402`, `VideoPanel.tsx:606,658`, `ExternalImageImportPanel.tsx:109`, `ProjectLocalOverridesEditor.tsx:269` | UC-M2 | 高 |
| G-11 | 3 系統（生成物 / 登録素材 / アップロード）を 1 箇所で等しく選べない。箇所ごとに選べる系統が違う | 同上 | UC-M2 | 高 |
| G-12 | アップロード時に役割（外見参照 / ポーズ / 背景 / 衣装）やキャラクターを指定する導線が無い | `ProjectLocalOverridesEditor.tsx:269` は人物参照のみ | UC-M1 | 中 |
| G-13 | 「ポーズを変える」「衣装を変える」という操作概念が無い。露出しているのは i2i / inpaint / denoise / mask / controlnet という技術語 | `ImageDerivationPanel.tsx:337-432` | UC-B4 | 高 |
| G-14 | 画像の保管入口が API 側で 4 系統に分かれ、横断で探す手段が無い | 入力 cache / Artifact / 外部インポート / `local_overrides` | UC-M3 | 中 |

### プロンプト

| ID | ギャップ | 根拠 | 対応 UC | severity |
|---|---|---|---|---|
| G-15 | プロンプトを差分で編集する仕組みが無い。提案は常に全文置換 | `PromptAssist.tsx:36`、`schemas.py:1542` | UC-A2 | 高 |
| G-16 | 画像を入力にしてプロンプトを直す経路が無い。`ProposalRequest` に画像フィールドが無く、3 provider とも画像を送らない | `adapters/agent/base.py:57-77` | UC-A3 | 高 |
| G-17 | novel-writer のプロンプト資産（作法 288 行 + reference 556 行、プロンプト 800 ファイル規模）を参照する仕組みが無い | 取り込み経路なし | UC-A1, UC-A2 | 高 |
| G-18 | タグの実在・使用頻度を生成前に検証しない。novel-writer 側には `tagcheck.py` があるが取り込まれていない | 該当実装なし | UC-A1 | 中 |
| G-19 | `PromptAssist` が画像の生成・派生の 2 箇所にしか無い。動画・音声・音楽・合成には無い | `GenerationForm.tsx:392`, `ImageDerivationPanel.tsx:380` のみ | UC-B2, UC-B5, UC-B6 | 中 |
| G-20 | プロンプト入力欄が 13 箇所以上に散在し、うち 3 箇所は JSON textarea の中 | `ProjectGenerationDefaultsEditor.tsx:177`, `LookProfileManager.tsx:208`, `ProjectOperations.tsx:294` | UC-A1 | 中 |
| G-21 | タグ型と自然文型の 2 系統をエンジンに応じて扱い分ける概念が無い | 該当実装なし | UC-A1 | 中 |

### Preset

| ID | ギャップ | 根拠 | 対応 UC | severity |
|---|---|---|---|---|
| G-22 | 「名前を付けて再利用する」概念が Recipe / LookProfile / ProjectTemplate / GenerationDefaults の 4 つに分散 | `models.py:232,254,93`、`schemas.py:146` | UC-A9 | 高 |
| G-23 | 良かった生成物やフォームの現在値から Preset 化する導線が無い | 該当実装なし | UC-A9 | 高 |
| G-24 | LookProfile の作成が二重の折りたたみの中にあり到達しにくい | `GenerationForm.tsx:442` → `LookProfileManager.tsx:160` | UC-A9 | 中 |
| G-25 | 「モードB で何を選ばせるか」を Preset に定義する概念が無い | 該当実装なし | UC-A9, UC-B1 | 高 |

### キャラクター

| ID | ギャップ | 根拠 | 対応 UC | severity |
|---|---|---|---|---|
| G-26 | キャラクター定義が `id / name / tags / reference_images` のみ。衣装・外見・声の専用フィールドが無い | `schemas.py:323-348` | UC-A8, UC-B4 | 中 |
| G-27 | キャラクター定義の置き場が生成 View の Scene 一覧の中に入れ子で、独立した画面が無い | `SceneBrowser.tsx:162` → `ProjectLocalOverridesEditor.tsx:247` | UC-A8 | 中 |
| G-28 | 動画用の参照画像セット（役割ごとの複数枚）という概念が無い。`VideoPanel` は枚数だけを扱う | `VideoPanel.tsx:606-655` | UC-B3 | 高 |

### 進捗・案内

| ID | ギャップ | 根拠 | 対応 UC | severity |
|---|---|---|---|---|
| G-29 | 制作進捗が手動設定のラベル集計で、生成実績と連動しない | `ProjectWorkspace.tsx:485-501`、`SceneBrowser.tsx:326` | UC-B9 | 中 |
| G-30 | 制作進捗が `source_type === "local"` のときしか表示されない | `ProjectWorkspace.tsx:483` | UC-B9 | 低 |
| G-31 | 「何が足りなくて次に進めないか」を示す表示が無い。前提条件の文言が個別パネルに散在するのみ | `GenerationForm.tsx:472`, `GenerationSweepPanel.tsx:207` ほか | UC-B3, UC-B7 | 中 |

### 操作性

| ID | ギャップ | 根拠 | 対応 UC | severity |
|---|---|---|---|---|
| G-32 | キーボード操作が候補ギャラリーとタブ移動に限られる。生成・採用・次へをキーボードで回せない | `CandidateGallery.tsx:360`、`App.tsx:614-640` | 横断「キーボードで回せる」 | 中 |
| G-33 | 候補 1 件あたり 7 個のボタンが並ぶ | `CandidateGallery.tsx:435-441` | UC-B1 | 低 |
| G-34 | 取り消し（undo）の仕組みが無い。採否変更・削除・上書きが戻せない | 該当実装なし | 横断「取り消せる」 | 中 |

## 改善の優先順位

**画面をリッチに使いやすくすることを優先する**方針に沿って並べる。上から順に着手する想定。

ここでは方針とその理由を示すに留める。着手できる単位への分割、受入基準、依存関係、対応する Issue は [webui-roadmap.md](./webui-roadmap.md) を正とする。

### P0 ── 体感が最も変わり、他の改善の土台になるもの

**1. 画面状態の永続化と復元（G-05, G-06, G-08, G-09）**

選択中の Project / Scene / Shot / View / タブと、各フォームの入力を永続化する。URL にも主要な選択を載せる。View 切替でアンマウントしない、あるいはアンマウントしても入力を復元する。

これを先にやる理由は、**他のすべての改善の効果がここに乗るから**である。作業の再開（UC-B9）が成立しないまま他を直しても、毎回ゼロから組み直す体験は変わらない。変更範囲は `App.tsx` の状態管理と各フォームの初期化に限られ、API 変更は不要。

**2. モードの分離と露出の削減（G-01, G-02）**

トップレベルを機能軸（Project / 生成 / 資産 / Workflow）からモード軸へ組み替える。モードB の画面に出すのはキャラクター・場面・Preset・実行・採否・次へに限り、パラメータ類はモードA へ移す。

現在 58 個ある生成 View の露出要素のうち、モードB に残すのは 15 個以下を目標とする。既存コンポーネントは大半がそのまま使えるため、作業の中心は**配置と出し分け**である。

**3. 画像ピッカーの共通化（G-10, G-11）**

3 系統（生成物 / 登録素材 / アップロード）を 1 つの選択 UI に統合し、現在 7 箇所に散っている個別実装を置き換える。複数枚が必要な箇所では役割ごとの枠を持てるようにする。

API 側は Job 投入時の指定が既に `artifact_id / relative_path / sha256` に統一されているため、**UI だけで完結する**。後続の「ポーズ・衣装を変える」「参照画像セット」はこの部品の上に載る。

**4. 工程 UI の導入（G-03, G-31）**

背景 → キャラクター参照 → 音声・BGM → 動画 → 仕上げ、という順序を画面に出す。現在どの工程にいて、何が揃っていて、次に何をするかを常時表示する。

API 側にパイプラインの状態機械が無いため、初期段階は**フロント側で工程の定義と進行を保持**し、各工程は既存の生成エンドポイントを順に呼ぶ形で実装する。工程の定義をサーバへ移すかは、使ってみてから判断する。

### P1 ── 作業の質を上げるもの

**5. プロンプトの差分編集（G-15, G-19, G-20）**

提案を全文置換ではなく差分として返し、差分の単位で採否を選べるようにする。API 側の応答形式の変更（`ImagePromptAssistRead` に差分を加える）と、差分表示 UI の追加が要る。`PromptAssist` を動画・音声・音楽へも展開する。

**6. 画像を見せて直す（G-16）**

`ProposalRequest` に画像を渡せるようにし、provider 側の呼び出しで画像を添付する。claude_code / codex は CLI 経由のためファイルパスで渡せる見込み、qwen は OpenAI 互換 API の画像入力に依存する。対応可否を provider ごとに確認してから着手する。

**7. ポーズ・衣装の変更を操作語彙にする（G-13）**

`ImageDerivationPanel` の技術語（i2i / denoise / mask / controlnet）をモードA に残し、モードB には「ポーズを変える」「衣装を変える」「表情を変える」という操作として出す。変換方式と強さは novel-writer 側で検証済みの値を既定に埋める。

**8. Preset の統合と昇格導線（G-22, G-23, G-24, G-25）**

4 つに分散した概念を、使用者から見て 1 つの「Preset」として扱えるようにする。良かった生成物やフォームの現在値から 1 アクションで Preset を作れるようにし、Preset に「モードB で何を選ばせるか」を定義できるようにする。

内部のモデルを統合するかどうかは別途判断する。まずは**UI 上で 1 つに見せる**ことを優先する。

**9. 参照画像セット（G-28）**

動画生成に必要な参照画像を、役割ごとの枠として定義し、キャラクター単位で蓄積・再利用する。novel-writer 側に 7 枚構成（表情 2 種・角度・バストアップ・全身・ポーズ・背景）の検証結果があるため、これを既定の枠とする。

**10. 進捗の自動化（G-29, G-30）**

制作進捗を手動ラベルから、生成実績（採用済み Artifact の有無）を根拠にした自動判定へ変える。外部同期 Project でも表示する。

### P2 ── 継続的に効いてくるもの

**11. novel-writer のプロンプト資産の取り込み（G-17, G-18, G-21）**

作法・実測知見・既存プロンプトをエージェントが参照できる形で取り込む。タグの実在検証を生成前チェックに組み込む。タグ型と自然文型の 2 系統をエンジンに応じて扱い分ける。

資産は `works/*/Visuals/Prompts/` と `~/.claude/skills/anima-prompt/` に分散しており、**正本を書き換えずに参照する**境界の設計が先に要る。

**12. キャラクター定義の拡充と独立（G-26, G-27）**

`ProjectCharacterProfile` に衣装・外見・声を持たせ、専用画面へ切り出す。API のスキーマ変更を伴う。

**13. 操作性の底上げ（G-32, G-33, G-34）**

実行・採用・不採用・次へをキーボードで回せるようにする。候補 1 件あたりのボタンを減らす。採否変更と削除に undo を入れる。

**14. Workflow View の再構成（G-04）**

操作要素 1 個の画面を、モードA の一部として再配置する。

## 対象外とすること

- API のデータモデルの大規模な作り替え。現状のモデルで UI の改善は大半が可能であり、モデル変更は UI 改善で必要性が確認できた範囲に限る。
- 生成エンジンの追加。5 媒体はすべて実装済みで、不足は確認されていない。
- novel-writer 側への書き込み。参照に限るという境界を維持する。
