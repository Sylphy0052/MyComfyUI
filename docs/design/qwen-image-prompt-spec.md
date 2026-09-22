# Qwen-Image (Anima) プロンプト規約 調査メモ

MyComfyUI の画像生成プロンプトを改善するにあたり、先行して運用実績のある `novel-writer` リポジトリ (`~/workspace/github/novel-writer`) のプロンプト規約を調査してまとめたもの。目的は次の 2 点を MyComfyUI 側へ持ち込むための下地づくりである。

- タグの並び順を規約として固定する
- タグだけでなく自然文も組み立てる

1 節から 10 節までは調査結果と現状のギャップ整理、11 節はそれを受けて決めた方針を記録する。実装そのものは含まない。

出典はすべて `novel-writer` リポジトリ内の相対パスで示す。

## 1. 前提となるモデル特性

Anima は SDXL 系の checkpoint ではなく、Cosmos Predict2 の DiT を流用し、テキストエンコーダに Qwen3-0.6B、VAE に Qwen-Image VAE を使う構成である (`.claude/skills/anima-prompt/reference/official-source.md:44-51`)。

ここから、プロンプト設計上は次の性質が効いてくる。

- プロンプトの最大トークン長は 512 (diffusers の `max_sequence_length` 既定値)。
- 自然文の解釈が CLIP 系より強い。「存在しないタグでも自然文として書けば意図が通る」(`official-source.md:49`)。
- タグのみ、自然文のみ、その混在の 3 形式すべてで学習されている。公式も 3 形式を等しく認めている (`.claude/skills/anima-prompt/SKILL.md:18-25`)。

## 2. タグの順序

### 2.1 ブロック順 (公式)

公式が示す並びは次のとおり (`official-source.md:57-63`)。

```
[quality / meta / year / safety] [1girl / 1boy / 1other] [character] [series] [artist] [general tags]
```

skill 側の実務版も同じ骨格を採る (`SKILL.md:90-111`)。

カテゴリを記載順に展開すると次の 9 つになる。

1. quality — 品質語 (`masterpiece`, `best quality`, `score_7` など)
2. meta — `highres`, `absurdres`, `anime screenshot`, `official art` など。quality と同じ先頭ブロックに置く
3. year — `year 2025` もしくは `newest` / `recent` / `mid` / `early` / `old`
4. safety (rating) — `safe` / `sensitive` / `nsfw` / `explicit`
5. count — `1girl` / `1boy` / `1other` / `2girls`
6. character — キャラクター名。Danbooru の romanization に従う
7. series — 作品名
8. artist — `@artist name` の形式で前置きの `@` を付ける
9. general tags — 外見、服装、表情、ポーズ、背景、光など

### 2.2 順序に関する規約の強さ

- 固定なのは**ブロックの順序のみ**。ブロック内部の並びは自由と明言されている (`SKILL.md:90-111`)。
- 例外として general tags の内部だけは「何を描くか → どう描くか」の方向、すなわち外見 → ポーズ → カメラ → 背景 → 光の順が推奨される (`SKILL.md:110-111`)。
- アングルタグ (`from below`, `from side` など) は**前方へ置く**。後方に置くと効きが落ちるという実測がある (`reference/tuning.md:195-196`)。

順序違反の既知の失敗として明記されているのは、このアングルタグの 1 件のみである。他のブロック内並び替えについては失敗例の記載がない。

### 2.3 より細かい 12 ブロック分類

テンプレート側では、実装向けにさらに粒度の細かい分類が定義されている (`reference/templates.md:11-24`)。

prefix / subject count / identity / appearance / clothing / expression-pose / style / scene tags / interaction / spatial / camera / lighting の 12 ブロックで、このうち末尾 4 つ (interaction は条件付き、spatial、camera、lighting) は**タグではなく自然文側に回す**規約になっている。

MyComfyUI で順序を実装するなら、この 12 ブロック分類のほうがそのまま構造体へ落としやすい。

## 3. タグと自然文の使い分け

### 3.1 原則

> タグは語彙を、自然文は関係を担う。どちらが要るかで書き方を選ぶ。 (`SKILL.md:18-25`)

### 3.2 形式の選択

| 形式 | 使う場面 |
| --- | --- |
| 自然文のみ | 複数キャラを描き分ける場合はこれ一択 (実測 4/4)。最低 2 文 |
| 混在 | 1 人 + 位置や光の指定。タグ行 → 自然文の順に書く |
| タグのみ | 単体の立ち絵など。構図は最も安定するが、位置や個数は指定できない |

(`SKILL.md:55-59`)

### 3.3 どちらで書くかの振り分け

自然文が要る領域 (`SKILL.md:41-46`)。

- 複数キャラの属性の結び付け (誰が眼鏡をかけているのか)
- 位置関係
- 誰が何に触れ、どこから光が当たるか

タグが要る領域。

- 画風、絵師
- 品質 / rating / year
- 既知の Danbooru 語彙
- 重み付けで強制したい要素

例外として、相互干渉 (見つめ合う、手をつなぐ) は正準タグがあればタグ側のほうが強い (`tuning.md:287-305`)。

### 3.4 重要な実測: 識別属性はタグ行から外す

複数キャラの識別属性 (髪色、髪型、眼鏡) をタグ行に残したまま自然文を足しても、0/4 で属性が混ざる (`tuning.md:360-367`)。

したがって**識別属性はタグ行から完全に外して自然文へ移す**必要がある。共通属性 (`school uniform` など) だけをタグ行に残す。

これは「タグ順序を守りつつ自然文を足す」という素朴な実装が失敗する箇所であり、MyComfyUI 側でも最も注意すべき点である。

### 3.5 自然文の書き方

(`SKILL.md:168-179`)

- 人称代名詞 (he / she / it) を避け、主語を名詞で書く
- 誰がどこにいて、何に対してどう位置しているか
- 手や視線の向き
- 光源の向きと、光が当たる面
- 前景と後景

### 3.6 タグ行と自然文の連結書式

公式の例示 (`official-source.md:116-122`)。

```
masterpiece, best quality, @big chungus. An anime girl with medium-length blonde hair is ...
```

改行で分けてもよく、1 文目の先頭へ続けてもよい。

## 4. negative prompt

### 4.1 公式 baseline

(`official-source.md:124-136`)

```
positive 接頭: masterpiece, best quality, score_7, safe,
negative:      worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration
```

### 4.2 モデル別の差分

| モデル | negative の固有分 |
| --- | --- |
| Anima Base v1.0 | 共通のみ |
| Anima Aesthetic 1.x | `score_*` を入れない |
| Anima Turbo 1.x | negative が効かない (CFG 1) |
| Hassaku (Anima) v1.3 | 共通のみ |
| WAI-ANIMA v1.0 | `artist name, lowres, censor` |

(`tuning.md:256-266`)

### 4.3 症状別に足す候補 (公式外)

| 症状 | 足すもの |
| --- | --- |
| 非アニメ寄りの絵になる | `deviantart` |
| 同じ顔・同じ人物が増える | `duplicate` / `twins` |
| ロゴや署名が出る | `watermark` / `patreon logo` |

(`tuning.md:274-285`)

### 4.4 運用上の注意

- **隣接色を negative へ置くと、狙いの色の成分まで削れる** (実測 3 例)。例として `(blue serafuku:2)` を negative へ置いたところ、水色を生む成分まで消えた (`tuning.md:74-93`)。
- **0 件タグは negative へ置いても何も削らない** (`tuning.md:87-93`)。
- Spec の実例でも negative は 1 行程度の短さを推奨している (`.claude/skills/anima-imagegen/reference/generate.md:18-32`)。

## 5. 長さの目安

- 公式の上限は 512 トークン (`official-source.md:50`)。
- 非公式の知見として、200 トークン以下が素直、300 超で後方のタグが効かないという報告がある (`SKILL.md:127-129`)。ただし「200 / 300 トークンの目安は公式の記載ではない」ため、目安として使ってよいが公式として伝えない、という注意書きがある (`tuning.md:377-385`)。
- 混在形式での自然文は 2〜3 文、50 語程度まで。超過分は効かない (実測、`SKILL.md:151-159`)。
- 自然文のみの形式は上限未実測。3〜5 文から始める。
- `novel-writer` の Anima 検証プロジェクトでは、独自の運用目標として positive 150〜220 語を置いている (`検証_reference/README.md:179`)。

## 6. 禁止事項

(`SKILL.md:113-129`, `tuning.md:22`, `official-source.md:172-178`)

- 矛盾するタグを同居させない。`extreme close-up` と `full body` の同居は中間妥協の絵になる
- 同じ概念を 3 回以上言い換えない。その領域へ注意が集中し、他の要素が描き込み不足になる
- 同じ部位に同義タグを 3 つ以上置かない。`low twintails` + `double bun` + `hair bobbles` は競合して位置が決まらない
- 絵師は 1 人から始める。複数混在は画風が混ざるが不安定
- キャラクター名だけに頼らない。名前と髪・瞳・服を対で書く
- 画面全体へ滲むタグに注意する。`motion blur` などは局所に留まらない
- 画中の文字は 1 単語まで。長い文字列は崩れる
- **JSON や XML をそのままプロンプトとして渡さない**。公式が保証する形式ではなく、Qwen3 が中の英語を読んでいるだけの可能性がある。LLM に組ませる場合は中間表現として JSON を使い、**Anima へ渡す直前にタグ + 自然文へ展開する** (`official-source.md:172-178`)

最後の項目は、LLM にプロンプトを生成させる MyComfyUI の構成と直接関係する。構造化出力 (JSON) を受け取ること自体は問題ないが、それを文字列化してそのまま渡してはいけない、という規約である。

## 7. プロンプト生成の手順

`anima-prompt` skill が踏むステップ (`SKILL.md:37-199`)。

1. **書き方を選ぶ** — 自然文のみ / 混在 / タグのみを先に確定する。複数キャラなら自然文一択
2. **中間表現へ分解する** — 要求を quality / count / character / artist / appearance / outfit / expression-pose-camera / environment-lighting / interaction / relation の枠へ割り当てる。枠を飛ばして直接文字列を書かない
3. **タグ行を組む** — 公式順序に従って構築する。表記規約 (小文字 + スペース区切り、`1girl` は詰める、`(` `)` はエスケープ、英語のみ、artist は `@` 前置、Danbooru romanization) を適用する
4. **自然文を書く** — 下限 2 文。役割の確認と代名詞回避などの文法規約を適用する
5. **タグの実在を確認する** — `scripts/tagcheck.py` が Danbooru API へ問い合わせ、タグの実在と件数を確認する
6. **効かない場合の調整** — `reference/tuning.md` の「症状から引く」表 (`tuning.md:9-29`) で、1 軸だけ動かして再検証する

上位の `anima-imagegen` skill は、環境確認 → 情報収集 → モデル決定 → プロンプト → Spec → 生成 → 確認 → 修正 → 再生成というループを回し、プロンプト作成部分だけを `anima-prompt` へ委譲する構成になっている (`.claude/skills/anima-imagegen/SKILL.md:12-19, 48`)。

## 8. テンプレート実物

### 8.1 立ち絵 (1 人)

`reference/templates.md:28-40`

```text
masterpiece, best quality, safe,
1girl, solo,
long silver hair, blue eyes, fair skin,
white oversized hoodie, black pleated skirt,
neutral expression,
standing, full body, front view,
simple light gray background

A young woman is standing alone in the center of the frame, facing directly toward the viewer.
Her entire body is visible from head to toe, with both arms and both feet fully inside the image.
The background is plain light gray with no furniture, text, objects, or other characters.
```

### 8.2 1 人の場面

`reference/templates.md:50-62`

```text
masterpiece, best quality, safe,
1girl,
long silver hair, blue eyes,
school uniform,
classroom, sunset

A teenage girl is sitting alone at a desk near the windows on the left side of an empty classroom.
She is resting one elbow on the desk and looking outside, while her other hand loosely holds a closed notebook.
The camera is positioned several meters in front of her at eye level in a medium-wide shot.
Warm orange sunset light enters from the windows behind her, illuminating the edge of her hair
while the interior of the classroom remains slightly dark.
```

### 8.3 2 人の会話 (自然文主体)

`reference/templates.md:70-85`

```text
masterpiece, best quality, safe,
2girls,
classroom, school uniform

The image depicts exactly two girls.

On the left side is Aoi. She has long black hair, blue eyes, and wears a dark navy school uniform.
She is standing beside a classroom window and looking toward Rin.

On the right side is Rin. She has short blonde hair, green eyes, and wears a white cardigan
over her school uniform. She is sitting at a desk and looking up at Aoi.

Aoi is handing a closed notebook to Rin.
Their bodies do not overlap. No other people are visible in the classroom.
```

タグ行には共通属性 (`2girls`, `classroom`, `school uniform`) だけが残り、識別属性 (髪色、髪型、眼鏡、服の色) はすべて自然文へ移っている点が要点である。

### 8.4 自然文のみ

`SKILL.md:183-193`

```text
masterpiece, explicit, @artist name

Two girls stand between tall library shelves in the late afternoon.
The girl on the left has short aqua hair and wears round glasses, reaching for a
book on the upper shelf. The girl on the right, with long black hair in a ponytail,
holds three closed books against her chest and looks up at her.
Warm light from a side window falls across both of their shoulders.
```

### 8.5 Spec (yaml) の実物

`.claude/skills/anima-imagegen/reference/generate.md:18-45`

```yaml
version: "1"
task: txt2img

presets:
  style: anima-base

prompt:
  positive: >
    masterpiece, explicit, 1girl, solo, aqua hair, blue hair, school uniform, library,
    A girl stands between two tall bookshelves and reaches for a book on the upper shelf.
    Afternoon light from a side window falls across her shoulder.
  negative: >
    green hair

generation:
  width: 832
  height: 1216
  seed: -1

model:
  unet: hassakuAnima_v13_int8.safetensors
  clip: qwen_3_06b_base.safetensors
  vae: qwen_image_vae.safetensors

output:
  prefix: anima_library
```

## 9. MyComfyUI 側の現状

「Qwen」という語がこのリポジトリでは 2 つの意味で使われている点にまず注意が要る。

- **Qwen-Image 系ワークフロー** — ComfyUI 上の画像生成テンプレート (`anima_txt2img` など) が、CLIP の代わりに Qwen3 をテキストエンコーダとして使う構成 (`qwen_3_06b_base.safetensors` / `qwen_image_vae.safetensors`)
- **Qwen LLM (推論サーバー)** — `adapters/agent/qwen.py` の `QwenProvider` が OpenAI 互換 API 経由でローカル Qwen へプロンプト提案やタグ整理を依頼する

プロンプト文字列を組み立てているのは後者の周辺である。

### 9.1 組み立て箇所

- `apps/api/src/mycomfyui_api/adapters/comfyui/workflow.py:123-175` — `ANIMA_TXT2IMG` ほかで `positive_prompt` / `negative_prompt` を `CLIPTextEncode` ノードの `text` へそのまま流し込む (`workflow.py:154-155`)。ここに整形ロジックはない
- `apps/api/src/mycomfyui_api/adapters/agent/proposals.py:246-258` — `build_prompt(request)` が LLM へ渡すユーザープロンプト本文を組み立てる
- `apps/api/src/mycomfyui_api/adapters/agent/qwen.py:133-154` — `_body()` が `proposals.SYSTEM_PROMPT` と `build_prompt(request)` を Qwen 推論サーバーへ送る
- `apps/api/src/mycomfyui_api/adapters/image_tagger.py:41-84` — `QwenTagRefiner.refine()` が WD14 Tagger の出力タグ列を Qwen へ渡して整理・拡張させる

### 9.2 現状のタグ順序

リポジトリ内で並び順を明示している唯一の箇所は `image_tagger.py:52-56` のシステムプロンプトである。

```
"You organize tags for image generation. "
'Return only a JSON object with an English string array named "tags". '
"Keep the given tags that describe the image, merge duplicates, and "
"order them from subject to appearance, setting, composition, "
"lighting, and style. Do not invent content the tags do not imply."
```

subject → appearance → setting → composition → lighting → style の順である。

これは novel-writer の公式ブロック順とは別系統で、quality / meta / year / rating / count / character / series / artist というプレフィックス側のブロックが存在しない。また style が末尾に来ており、公式順 (artist は general tags より前) と逆になっている。

### 9.3 現状の自然文の扱い

`image_prompt` 種別の指示は次のとおり (`proposals.py:155-158`)。

```
"与えたShotまたは利用者説明に沿う画像生成promptを1件提案する。"
"positive_promptは英語の語句列、negative_promptは避けたい要素とする。"
```

「英語の語句列」とだけ指示しており、自然文を書かせる指示はない。順序の規定もない。

スキーマ上は `ImagePromptOutput.positive_prompt: str` (`proposals.py:53`) の単なる自由文字列で、タグ配列として構造化されてはいない。

### 9.4 現状の system prompt

提案全般で共通 (`proposals.py:188-193`)。

```
"あなたは映像制作の提案だけを行う。ファイル操作、コマンド実行、外部送信、"
"生成ジョブの投入は一切行わない。与えられた情報だけを根拠に、"
"指定されたJSON Schemaに適合するJSONを1件返す。"
"推測で事実を作らず、情報が足りない項目は空文字か空配列にする。"
```

応答形式は `response_format.json_schema` で固定されている (`qwen.py:146-154`, `proposals.py:201-227` の `strict_json_schema`)。

### 9.5 現状の negative prompt

- ワークフロー既定値は空文字 (`apps/api/src/mycomfyui_api/bootstrap.py:93`)。ACE-STEP 音楽生成テンプレートのみ既定値を持つ (`bootstrap.py:592`)
- `ImagePromptOutput.negative_prompt` は `proposals.py:54` で `default=""`、`max_length=4000`
- API 契約側 `ImagePromptAssistRead.negative_prompt` は `schemas.py:1546` で必須だが最小長の制約はない
- LLM への指示は「避けたい要素とする」のみで、書式の指定はない

### 9.6 保存フィールド

- `positive_prompt` / `negative_prompt` — 生成 Job 入力 (Recipe 入力スキーマ、`bootstrap.py:58-69` ほか)
- `resolved_prompt` — 解決済み実行内容 (`schemas.py:1028` の `GenerationPreviewRead`、`schemas.py:1189` の `GenerationManifestRead`)
- `ImagePromptAssistRead.positive_prompt` / `negative_prompt` / `rationale` — 提案 API の応答型 (`schemas.py:1541-1548`、`contracts/openapi/openapi.json:2984-3013`)
- `ImagePromptOutput.positive_prompt` / `negative_prompt` / `rationale` — Provider 内部の検証モデル (`proposals.py:50-55`)

### 9.7 プロンプト設計の既存ドキュメント

専用のドキュメントは存在しない。仕様は `proposals.py` と `image_tagger.py` のコード内コメントおよびシステムプロンプト文字列に分散している。

## 10. ギャップ整理

novel-writer の規約を基準に見たときの、MyComfyUI 側の差分。

| 論点 | novel-writer | MyComfyUI 現状 | 差分 |
| --- | --- | --- | --- |
| タグのブロック順 | 公式 9 ブロック順を固定 | subject → appearance → setting → composition → lighting → style のみ | prefix 系ブロック (quality / meta / year / rating / count / character / series / artist) が欠落。artist の位置も逆 |
| 自然文 | 形式を 3 つから選び、関係の記述を自然文が担う | 「英語の語句列」とだけ指示 | 自然文を書かせる指示が存在しない |
| 複数キャラ | 自然文一択。識別属性はタグ行から外す | 規定なし | 複数キャラで属性が混ざる状態を防ぐ仕組みがない |
| negative | 公式 baseline + モデル別差分 + 症状別候補 | 既定値は空文字、指示は 1 行 | baseline が存在しない |
| 長さ | 512 トークン上限。混在時の自然文は 2〜3 文 50 語 | `max_length=4000` 文字のみ | トークン基準の制約がない |
| 禁止事項 | 矛盾・重複・JSON 直渡しなどを明文化 | 「推測で事実を作らない」のみ | プロンプト固有の禁止事項がない |
| タグ実在確認 | Danbooru API で件数を確認 | なし | 0 件タグの混入を検出できない |
| 中間表現 | 枠へ分解してから文字列化 | 直接文字列を生成 | 構造を経由しないため順序を機械的に保証できない |


## 11. 決定事項

本節は 2026-09-22 に決定した方針を記録する。実装はまだ行っていない。

### 11.1 タグ順序はブロック配列で受け取り、サーバー側で連結する

LLM にはブロックごとの配列を返させ、**並び順はサーバーのコードが決める**。LLM が書いた文字列の順序に依存しない。

根拠は 2 つある。

- 順序違反が構造上起こりえなくなる。文字列を直接書かせる案では順序遵守が LLM 依存になり、検証もできない
- novel-writer の禁止事項「JSON は中間表現として使い、Anima へ渡す直前にタグ + 自然文へ展開する」(6 節) と一致する

代償として `ImagePromptOutput` (`proposals.py:50-55`) の strict JSON schema を大きく変更する。`extra="forbid"` のため、フィールド追加は API 契約 (`schemas.py:1541-1548`, `contracts/openapi/openapi.json`) の更新を伴う。

ブロックは公式の 9 カテゴリ (2.1 節) を、実装しやすい粒度へまとめた次の 5 つとする。

| フィールド | 対応する公式カテゴリ | 内容 |
| --- | --- | --- |
| `quality_tags` | quality / meta / year / safety | `masterpiece`, `best quality`, `safe` など |
| `subject_tags` | count | `1girl`, `2girls`, `solo` など |
| `character_tags` | character / series | キャラクター名と作品名 |
| `artist_tags` | artist | `@artist name` |
| `general_tags` | general tags | 外見 → ポーズ → カメラ → 背景 → 光の順 |

`general_tags` の内部順序だけは LLM への指示で担保する (2.2 節の推奨順)。アングルタグを前方へ置く規約もここへ含める。

連結は上表の順にカンマ区切りで結合してタグ行を作る。

### 11.2 タグ行と自然文は別フィールドで保持する

`tag_line` (連結済みタグ行) と `natural_text` (自然文) を別々に持ち、ComfyUI へ渡す直前に `positive_prompt` へ連結する。

- 連結書式は 3.6 節に従い、タグ行と自然文を空行で区切る
- 既存の `positive_prompt` には連結済みの文字列を入れ、後方互換を保つ
- 分離して持つことで、タグ行だけの差し替えや自然文だけの再生成ができる

実装では、`tag_line` と `positive_prompt` を Provider に書かせず、`validate_output()` が検証後に組み立てる派生項目として持たせる。Provider の出力型はブロック配列と `natural_text` だけを持ち、`PromptBody` として `ImagePromptOutput` と `BatchGenerationItem` が共有する。タグもブロックの連結時に重複を落とす。

### 11.3 negative は テンプレート既定値 + LLM の追加分

- 公式 baseline (4.1 節) を `bootstrap.py` の `DEFAULT_VALUES["negative_prompt"]` へ置く。現在は空文字 (`bootstrap.py:93`)
- LLM が返す `negative_prompt` は**そのショット固有の追加分だけ**とする。baseline を書かせない
- 生成 Job 投入時に既定値と追加分をマージする。重複タグは除去する

baseline を LLM に毎回書かせる案は、毎回揺れることと、4.4 節の「隣接色を negative へ置くと狙いの色まで削れる」事故を招きやすいことから採らない。

マージは生成 Job の投入操作を組み立てる箇所で行う。提案から投入する Job は `inputs.negative_prompt` を明示的に渡すため、Recipe の既定値が効かないからである。この結果、SD1.5 ControlNet の Recipe に対しても Anima 公式の baseline が乗る。baseline の中身は品質と画質の除外語が中心で SD1.5 でも無害なため、Recipe ごとの出し分けは行わない。`score_*` のように SD1.5 で意味を持たない語が混ざる点は許容する。

### 11.4 識別属性のタグ行除外ルールを入れる

3.4 節の実測 (識別属性をタグ行に残すと複数キャラで 0/4 混ざる) に対応する。

- `subject_tags` が複数人を示す場合 (`2girls` など)、髪色・髪型・眼鏡といった**識別属性を `general_tags` へ入れず、`natural_text` 側でキャラクターごとに書く**
- タグ行に残してよいのは共通属性 (`school uniform`, `classroom` など) だけ
- 実現方法は `KIND_DIRECTIVES` の指示文への明文化とする。サーバー側での機械的な検出は行わない

### 11.5 `batch_generation_plan` にも同じ規約を適用する

prompt 案を出す種別は `image_prompt` と `batch_generation_plan` の 2 つある (`proposals.py:142-186`)。片方だけに規約を入れると生成物の質が経路で分かれるため、両方へ同じブロック構造と指示を適用する。

### 11.6 今回は見送るもの

| 項目 | 見送る理由 |
| --- | --- |
| モデル別 negative 差分 (4.2 節) | `unet_name` が UI で選択可能なため、モデル名から negative 差分を引くマッピングが別途要る。baseline 導入の効果を先に見る |
| タグ実在確認 (Danbooru API) | 外部ネットワーク依存が増える。0 件タグの混入は baseline と指示文の整備より優先度が低い |

どちらも後続の Issue として切り出す。
