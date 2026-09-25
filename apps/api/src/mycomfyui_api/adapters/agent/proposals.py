"""提案の種別ごとの入出力定義。

出力の形はここだけで決める。Providerへ渡すJSON Schemaも、受け取った応答の検証も同じ
定義から作り、Providerが形を守らなかった応答をそのまま履歴へ残さない。

入力コンテキストは参照APIの表示用フィールドだけを許可リストで組み立てる。拒否したい
項目を並べるのではなく、渡す項目を列挙する。上流の契約に項目が増えても、既定で
Providerへ流れないようにするためである。
"""

import json
import logging
import re
from collections.abc import Collection, Iterable, Mapping
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from mycomfyui_api.adapters import tag_preflight
from mycomfyui_api.adapters.agent.base import (
    AgentInvalidResponse,
    AgentProposalKind,
    ProposalKind,
    ProposalRequest,
)

logger = logging.getLogger(__name__)

#: 利用者の指示文の上限。提案の入力に収まる長さへ抑える。
MAX_INSTRUCTION_LENGTH = 2000

#: 参照候補の提示に渡す既存Artifactの上限。
MAX_CONTEXT_ARTIFACTS = 20

#: バッチ生成計画の提示に渡すShotの上限。
MAX_CONTEXT_SHOTS = 20

#: 準備段階の提案が持てる適用stepの上限。1回の承認で長時間GPUキューを占有させない。
MAX_PLAN_STEPS = 20

#: 1件のArtifactへ1回の計画で足せる、または外せるタグの上限。
MAX_PLAN_TAGS = 10

#: Recipe案が指定できる入力の件数上限。
MAX_PLAN_DEFAULTS = 20

#: 資産整理案が指定できる移動先ディレクトリの長さ上限。
MAX_PLAN_DESTINATION_LENGTH = 500

#: prompt案の1ブロックが持てるタグの上限。
MAX_PROMPT_TAGS = 30

#: prompt案のタグ1件の長さ上限。重み括弧を付けても収まる長さにする。
MAX_PROMPT_TAG_LENGTH = 100

#: prompt案の自然文の長さ上限。混在形式では2〜3文・50語程度までしか効かない。
MAX_NATURAL_TEXT_LENGTH = 2000

#: 連結したpositive promptの長さ上限。API契約の`positive_prompt`と同じ値にする。
#: ブロックごとの上限を全て使うとこの値を超えるため、連結後に改めて当てる。
MAX_POSITIVE_PROMPT_LENGTH = 4000

#: BGM条件案のmoodとgenreそれぞれの長さ上限。連結してpositive promptの上限に収める。
MAX_MUSIC_TAGS_LENGTH = 1000

#: prompt案が書けるnegative promptの長さ上限。
MAX_NEGATIVE_PROMPT_LENGTH = 3000

#: 提案の説明の長さ上限。各出力型の`rationale`に合わせる。
MAX_RATIONALE_LENGTH = 2000

#: 基準値を足したあとのnegative promptの長さ上限。API契約の`negative_prompt`と同じ
#: 値にする。短いタグを並べると区切りの分だけ膨らむため、連結後に改めて当てる。
MAX_MERGED_NEGATIVE_LENGTH = 4000

#: バッチ生成計画全体の`positive_prompt`合計の上限。1件あたりの上限
#: (`MAX_POSITIVE_PROMPT_LENGTH`)を`MAX_PLAN_STEPS`件ぶん掛けると際限なく膨らみ、
#: Proposal履歴としてDBへ載るサイズが大きくなりすぎる。件数によらず合計へ上限を課す。
MAX_BATCH_POSITIVE_PROMPT_TOTAL = 20000

#: タグ行を組み立てるブロックの順序。Qwen-Image(Anima)公式の並びに合わせる。
#: Providerが書いた順序ではなくこの順で連結し、並びを実装側で固定する。
TAG_BLOCK_FIELDS = (
    "quality_tags",
    "subject_tags",
    "character_tags",
    "artist_tags",
    "general_tags",
)

#: negative promptの基準値。Qwen-Image(Anima)公式のbaselineをそのまま使う。
#: Providerにはショット固有の追加分だけを書かせ、この基準値は実装側で足す。
DEFAULT_NEGATIVE_PROMPT = (
    "worst quality, low quality, score_1, score_2, score_3, artist name, "
    "blurry, jpeg artifacts, chromatic aberration"
)

#: prompt案のタグ1件。カンマはタグの区切りに使うため値へ含めない。
PromptTag = Annotated[str, StringConstraints(max_length=MAX_PROMPT_TAG_LENGTH)]

#: `quality_tags`へ必ず1つ入れるrating値。`PROMPT_DIRECTIVE`の指示文だけに頼ると、
#: Providerやモデルを替えたときに抜け落ちても気付けない。ここで検査し、無ければ
#: 安全側の既定値(`safe`)を実装側で補う。
RATING_TAGS = frozenset({"safe", "sensitive", "nsfw", "explicit"})
#: ratingが落ちていたときに実装側で補うタグと、その日本語訳。
FALLBACK_RATING_TAG = "safe"
FALLBACK_RATING_GLOSS = "全年齢向け"


class ProposalOutput(BaseModel):
    """提案出力の基底。未知の項目を受け付けない。"""

    model_config = ConfigDict(extra="forbid")


class PromptBody(ProposalOutput):
    """prompt案のタグと自然文。

    タグはブロックごとの配列で受け取り、並び順は`TAG_BLOCK_FIELDS`の順で実装側が
    組み立てる。Providerが書いた順序に依存させないためである。自然文は位置関係や
    光の当たり方など、タグでは結び付けられない関係を担う。
    """

    #: 品質、meta、year、ratingのタグ。
    quality_tags: list[PromptTag] = Field(
        default_factory=list, max_length=MAX_PROMPT_TAGS
    )
    #: 人数を示すタグ。
    subject_tags: list[PromptTag] = Field(
        default_factory=list, max_length=MAX_PROMPT_TAGS
    )
    #: キャラクター名と作品名のタグ。
    character_tags: list[PromptTag] = Field(
        default_factory=list, max_length=MAX_PROMPT_TAGS
    )
    #: 絵師のタグ。
    artist_tags: list[PromptTag] = Field(
        default_factory=list, max_length=MAX_PROMPT_TAGS
    )
    #: 外見、ポーズ、カメラ、背景、光のタグ。
    general_tags: list[PromptTag] = Field(
        default_factory=list, max_length=MAX_PROMPT_TAGS
    )
    #: タグでは表せない関係を書く自然文。
    natural_text: str = Field(default="", max_length=MAX_NATURAL_TEXT_LENGTH)
    #: そのショット固有の避けたい要素だけ。基準値は`DEFAULT_NEGATIVE_PROMPT`が持つ。
    negative_prompt: str = Field(default="", max_length=MAX_NEGATIVE_PROMPT_LENGTH)


class TagGloss(ProposalOutput):
    """prompt案のタグ1つと、その日本語訳。利用者がタグの意味を確かめるのに使う。"""

    tag: PromptTag
    ja: str = Field(max_length=100)


TagChangeKind = Literal["added", "removed"]
NaturalTextChangeKind = Literal["unchanged", "added", "removed", "modified"]
TagBlockField = Literal[
    "quality_tags", "subject_tags", "character_tags", "artist_tags", "general_tags"
]
#: 変更1件の理由の長さの上限。
MAX_CHANGE_REASON_LENGTH = 500


class TagChange(ProposalOutput):
    """現在のpromptを直したときに足した、または消したタグ1つと、その理由。"""

    tag: PromptTag
    change: TagChangeKind
    #: タグが属する(消したときは属していた)ブロック。消すタグの検証に使う。
    field: TagBlockField
    reason: str = Field(default="", max_length=MAX_CHANGE_REASON_LENGTH)


class NaturalTextChange(ProposalOutput):
    """現在のpromptを直したときの自然文の変更と、その理由。自然文は1段落として扱う。"""

    change: NaturalTextChangeKind = "unchanged"
    reason: str = Field(default="", max_length=MAX_CHANGE_REASON_LENGTH)


class ImagePromptOutput(PromptBody):
    """画像生成のprompt案。承認後の生成Job投入に使う。"""

    rationale: str = Field(default="", max_length=2000)
    #: タグ配列の全タグの日本語訳。生成には使わず、表示だけに使う。
    tag_glosses: list[TagGloss] = Field(
        default_factory=list, max_length=MAX_PROMPT_TAGS * len(TAG_BLOCK_FIELDS)
    )
    #: 現在のpromptを直したときに、足したタグと消したタグ。消したタグに無いタグは
    #: `revise_current_prompt`が残す。
    tag_changes: list[TagChange] = Field(
        default_factory=list, max_length=MAX_PROMPT_TAGS * len(TAG_BLOCK_FIELDS) * 2
    )
    natural_text_change: NaturalTextChange = Field(default_factory=NaturalTextChange)


class VideoPromptOutput(ProposalOutput):
    """動画生成のprompt案。動画のWorkflowはnegativeを持たないため返さない。"""

    prompt: str = Field(min_length=1, max_length=MAX_POSITIVE_PROMPT_LENGTH)
    rationale: str = Field(default="", max_length=2000)


class MusicPromptOutput(ProposalOutput):
    """BGM生成の条件案。音楽画面のmood欄とgenre欄へそのまま入れる。"""

    mood: str = Field(min_length=1, max_length=MAX_MUSIC_TAGS_LENGTH)
    genre: str = Field(default="", max_length=MAX_MUSIC_TAGS_LENGTH)
    rationale: str = Field(default="", max_length=2000)


class ShotBreakdownItem(ProposalOutput):
    summary: str = Field(min_length=1, max_length=1000)
    camera: str = Field(default="", max_length=500)
    characters: list[str] = Field(default_factory=list, max_length=20)
    duration_sec: float = Field(default=0.0, ge=0, le=600)


class ShotBreakdownOutput(ProposalOutput):
    """Shot構成案。Shotの書き込みは行わないため、表示だけに使う。"""

    shots: list[ShotBreakdownItem] = Field(min_length=1, max_length=30)
    rationale: str = Field(default="", max_length=2000)


class ReferenceCandidateItem(ProposalOutput):
    artifact_id: str = Field(default="", max_length=36)
    label: str = Field(default="", max_length=200)
    reason: str = Field(default="", max_length=1000)


class ReferenceCandidatesOutput(ProposalOutput):
    """参照画像候補。採否の記録は既存のArtifact採否操作で行う。"""

    candidates: list[ReferenceCandidateItem] = Field(min_length=1, max_length=20)
    rationale: str = Field(default="", max_length=2000)


class RecipeDraftOutput(ProposalOutput):
    """Recipe案。Recipeの登録は本Issueの範囲外のため、表示だけに使う。"""

    name: str = Field(min_length=1, max_length=200)
    summary: str = Field(default="", max_length=2000)
    inputs: dict[str, Any] = Field(default_factory=dict)
    rationale: str = Field(default="", max_length=2000)


class WorkflowRegistrationDraftOutput(ProposalOutput):
    """Workflow登録案。

    適用先はWorkflowの登録簿ではなくRecipeの登録とする。登録簿は起動時に実装から
    組み立て直す派生データであり、行を足しても実行できるWorkflowは増えない。案に
    沿うRecipeを既存のWorkflow版に対して登録し、実行できるテンプレートの許可リストは
    変えない。
    """

    name: str = Field(min_length=1, max_length=200)
    summary: str = Field(default="", max_length=2000)
    #: 基準Recipeが宣言した入力だけを指定する。宣言に無い項目は適用前に落とす。
    defaults: dict[str, Any] = Field(default_factory=dict)
    rationale: str = Field(default="", max_length=2000)


class BatchGenerationItem(PromptBody):
    """バッチ生成計画の1件。prompt案の書き方は`image_prompt`と同じにする。"""

    #: 対象Shot。入力へ載せたScene配下の一覧にあるものだけを使う。
    shot_id: str = Field(default="", max_length=200)


class BatchGenerationPlanOutput(ProposalOutput):
    """バッチ生成計画。承認後に各Shotの生成Jobを投入する。"""

    items: list[BatchGenerationItem] = Field(min_length=1, max_length=MAX_PLAN_STEPS)
    rationale: str = Field(default="", max_length=2000)


class AssetOrganizationItem(ProposalOutput):
    #: 対象Artifact。入力へ載せた一覧にあるものだけを使う。
    artifact_id: str = Field(default="", max_length=36)
    #: タグの値は保存前にApplication API側の検証を通す。
    add_tags: list[str] = Field(default_factory=list, max_length=MAX_PLAN_TAGS)
    remove_tags: list[str] = Field(default_factory=list, max_length=MAX_PLAN_TAGS)
    #: 移動先ディレクトリ。Artifact store(`artifacts/`)基準の相対パスとし、空文字は
    #: 移動しないことを表す。範囲の検証は適用時に行い、範囲外の指定は履歴へ残す。
    destination_dir: str = Field(default="", max_length=MAX_PLAN_DESTINATION_LENGTH)
    reason: str = Field(default="", max_length=1000)


class AssetOrganizationPlanOutput(ProposalOutput):
    """資産整理案。適用先はタグの更新と、Artifact store内でのファイル移動とする。"""

    items: list[AssetOrganizationItem] = Field(min_length=1, max_length=MAX_PLAN_STEPS)
    rationale: str = Field(default="", max_length=2000)


OUTPUT_MODELS: dict[ProposalKind, type[ProposalOutput]] = {
    "image_prompt": ImagePromptOutput,
    "shot_breakdown": ShotBreakdownOutput,
    "reference_candidates": ReferenceCandidatesOutput,
    "recipe_draft": RecipeDraftOutput,
    "workflow_registration_draft": WorkflowRegistrationDraftOutput,
    "batch_generation_plan": BatchGenerationPlanOutput,
    "asset_organization_plan": AssetOrganizationPlanOutput,
    "video_prompt": VideoPromptOutput,
    "music_prompt": MusicPromptOutput,
}

#: prompt案の書き方。prompt案を持つ種別で同じ規約を使う。
#: 出典はQwen-Image(Anima)の作法。詳細は`docs/design/qwen-image-prompt-spec.md`。
PROMPT_DIRECTIVE = (
    "promptはタグと自然文で組み立てる。タグはブロックごとの配列で返し、"
    "1つの配列へ他ブロックの語を混ぜない。連結の順序は実装側が決めるため、"
    "配列をまたぐ並び順は考えなくてよい。\n"
    "- quality_tags: masterpiece、best qualityなどの品質、meta、year、rating。"
    "ratingはsafe、sensitive、nsfw、explicitのうち1つを必ず入れる。"
    "`rating:`のような接頭辞を付けず値だけを書く。"
    "指示から判断できなければsafeにする\n"
    "- subject_tags: 1girl、2girls、soloなどの人数\n"
    "- character_tags: キャラクター名と作品名\n"
    "- artist_tags: 絵師。`@`を前に付ける\n"
    "- general_tags: 外見、ポーズ、カメラ、背景、光。この順に並べる。"
    "from belowやfrom sideなどのアングルは前の方へ置く\n"
    "タグは英語の小文字とスペースで書き、値へカンマを含めない。"
    "矛盾するタグを同居させず、同じ部位へ同義のタグを3つ以上置かない。\n"
    "natural_textには、タグでは結び付けられない関係を書く。"
    "誰がどこにいて何に触れているか、視線の向き、光源の向きと光が当たる面を、"
    "代名詞を使わず主語を名詞にして2文以上で書く。"
    "利用者の指示が日本語でも、natural_textは英語で書く。\n"
    "subject_tagsが2人以上を示すときは、髪色・髪型・眼鏡など見分けに使う属性を"
    "general_tagsへ入れず、natural_text側でキャラクターごとに書く。"
    "タグへ残してよいのは全員に共通する属性だけとする。\n"
    "negative_promptには、このショット固有の避けたい要素だけを英語で書く。"
    "品質系の基準値は実装側が足すため書かない。"
    "避けたい要素が無ければ空文字にする。区切りだけの値を返さない。"
)

#: 書き方をエンジンに応じて切り替えるprompt案の種別。
PROMPT_STYLE_KINDS = frozenset({"image_prompt", "batch_generation_plan"})

#: タグだけを解釈するモデル(SD1.5など)へ出すときに足す指示。`PROMPT_DIRECTIVE`のうち
#: 自然文とAnima固有の書き方を打ち消す。自然文は`apply_prompt_style`でも落とす。
TAGS_STYLE_DIRECTIVE = (
    "## 対象モデルの書き方\n"
    "対象のモデルはタグだけを解釈する。natural_textは空文字にし、位置関係、視線、光も"
    "general_tagsのタグで表す。人数が2人以上でも、見分けに使う属性はgeneral_tagsへ"
    "入れる。`@`付きの絵師タグと`score_`で始まる品質タグは使わない。"
)

#: 種別ごとの指示。Providerへ渡すsystem promptの本文へ埋め込む。
KIND_DIRECTIVES: dict[ProposalKind, str] = {
    "image_prompt": (
        "与えたShotまたは利用者説明に沿う画像生成promptを1件提案する。\n"
        + PROMPT_DIRECTIVE
        + "\ntag_glossesには、タグ配列に入れた全てのタグについて、tagにタグをそのまま、"
        "jaにその意味を短い日本語で書く。jaへタグの英語をそのまま写さない。"
        '例: {"tag": "school uniform", "ja": "制服"}、'
        '{"tag": "holding umbrella", "ja": "傘を持つ"}。\n'
        "rationaleは日本語で書く。"
        "tag_changesとnatural_text_changeは現在のpromptを直すときだけ使う。"
        "それ以外はtag_changesを空配列、natural_text_changeのchangeをunchangedにする。"
    ),
    "shot_breakdown": (
        "与えたSceneをShotへ分割する案を出す。各Shotの内容、カメラ、登場人物、"
        "尺の目安を示す。"
    ),
    "reference_candidates": (
        "与えた既存Artifactの一覧から、参照画像として使える候補を選ぶ。"
        "artifact_idは一覧にあるものだけを使う。"
    ),
    "recipe_draft": (
        "与えたShotとRecipeの情報から、次に用意するとよいRecipeの案を出す。"
    ),
    "workflow_registration_draft": (
        "与えた既存Recipeが指すWorkflow版に対して、次に用意するとよいRecipeの案を"
        "1件出す。defaultsには基準Recipeが宣言した入力だけを指定する。"
        "新しいWorkflowテンプレートの追加は提案しない。"
    ),
    "batch_generation_plan": (
        "与えたScene配下のShot一覧から、続けて画像を生成するShotと、その"
        "promptの案を出す。shot_idは一覧にあるものだけを使う。\n" + PROMPT_DIRECTIVE
    ),
    "asset_organization_plan": (
        "与えた既存Artifactの一覧から、付けるとよいタグと外すとよいタグの案を出す。"
        "artifact_idは一覧にあるものだけを使う。"
        "置き場所を変えたい場合はdestination_dirへ移動先を指定する。指定は"
        "Artifact store(`artifacts/`)基準の相対ディレクトリとし、絶対パスと`..`は"
        "使わない。移動しない場合は空文字にする。"
    ),
    "video_prompt": (
        "利用者説明に沿う動画生成promptを1件提案する。\n"
        "promptには、被写体、動作とその速さ、カメラワーク(固定、パン、ドリー、"
        "追従など)、場面、光と色調を、英語の自然文で2〜4文にまとめて書く。"
        "タグを並べず、時間の流れに沿って何が起きるかを書く。"
        "数秒の動画になるため、起きる出来事は1つに絞る。"
        "利用者の指示が日本語でも、promptは英語で書く。"
    ),
    "music_prompt": (
        "利用者説明に沿うBGMの条件を1件提案する。\n"
        "moodには雰囲気、テンポ(bpmの目安)、主に使う楽器を、genreには音楽の"
        "ジャンルを書く。どちらも英語の小文字のタグをカンマ区切りで並べる。"
        "歌の有無は利用者が別の欄で選ぶため、vocals、instrumentalなど歌に関する"
        "タグは入れない。歌詞は書かない。"
    ),
}

SYSTEM_PROMPT = (
    "あなたは映像制作の提案だけを行う。ファイル操作、コマンド実行、外部送信、"
    "生成ジョブの投入は一切行わない。与えられた情報だけを根拠に、"
    "指定されたJSON Schemaに適合するJSONを1件返す。"
    "推測で事実を作らず、情報が足りない項目は空文字か空配列にする。"
)


def json_schema(kind: ProposalKind) -> dict[str, Any]:
    """Providerへ渡す出力JSON Schema。"""
    return OUTPUT_MODELS[kind].model_json_schema()


def strict_json_schema(kind: ProposalKind) -> dict[str, Any]:
    """OpenAI互換のstrict JSON Schemaを要求するProvider向けの出力Schema。

    strictな検証では`properties`にある項目を全て`required`へ含めないと要求ごと
    拒否される(Codex CLIで400、実測で確認)。`json_schema`はPydanticの`default`を
    持つ項目を`required`から外すため、ここで全項目を`required`へ足す。応答の検証は
    `validate_output`を通すため、Providerが`default`と同じ値を明示的に返しても扱いは
    変わらない。
    """
    return _require_all_properties(json_schema(kind))


def _require_all_properties(node: Any) -> Any:
    """dict/listを再帰的に辿り、object nodeの`required`を`properties`全体へ揃える。

    `$defs`配下のitem型定義にも同じ変換をかけるため、`properties`という名前に
    決め打ちせず全nodeを見て回る。
    """
    if isinstance(node, dict):
        result = {key: _require_all_properties(value) for key, value in node.items()}
        properties = result.get("properties")
        if isinstance(properties, dict):
            result["required"] = list(properties.keys())
        return result
    if isinstance(node, list):
        return [_require_all_properties(item) for item in node]
    return node


def _normalize_tag(value: Any) -> str:
    """タグ1件を連結できる形へ整える。

    カンマはタグの区切りに使うため、値へ混ざっていれば空白へ置き換える。Providerが
    1つの要素へ複数のタグを詰めても、区切りが壊れないようにする。
    """
    if not isinstance(value, str):
        # str以外はPydanticが先に弾く。ここへ来た値は落とし、連結を壊さない。
        return ""
    return " ".join(value.replace(",", " ").split())


#: 重み付きタグの書式。`(tag:1.2)`のように括弧と数値で囲んだ形だけを重みとみなす。
#: コロンを単純に区切りとして扱うと、`:d`や`:3`のような表情タグを壊す。
WEIGHTED_TAG_PATTERN = re.compile(r"^\((?P<tag>.+):\s*[0-9.]+\)$")


def _dedupe_key(value: str) -> str:
    """重複判定に使うキー。重み括弧を外し、大文字小文字を無視する。

    `(blurry:1.2)`と`blurry`を別物として残すと、基準値と提案の追加分が二重に並ぶ。
    """
    stripped = value.strip()
    weighted = WEIGHTED_TAG_PATTERN.match(stripped)
    if weighted is not None:
        stripped = weighted.group("tag")
    elif stripped.startswith("(") and stripped.endswith(")"):
        # 重みを持たない強調括弧。中身が同じなら同じタグとして扱う。`(happy) (sad)`の
        # ように括弧が2組並ぶ値は、外側だけ剥がすと壊れるためそのまま比べる。
        inner = stripped[1:-1]
        if "(" not in inner and ")" not in inner:
            stripped = inner
    return stripped.strip().casefold()


def _is_weighted(value: str) -> bool:
    """`(tag:1.2)`のように重みを持つ書き方かどうか。"""
    return WEIGHTED_TAG_PATTERN.match(value.strip()) is not None


def _dedupe(values: Iterable[str]) -> list[str]:
    """順序を保ったまま重複と空文字を落とす。

    同じタグが重み付きと重みなしで並んだときは重み付きを残す。先に現れた方を無条件に
    採ると、Providerが指定した重みが黙って消える。
    """
    order: list[str] = []
    chosen: dict[str, str] = {}
    for value in values:
        key = _dedupe_key(value)
        if not value or not key:
            continue
        if key not in chosen:
            chosen[key] = value
            order.append(key)
        elif _is_weighted(value) and not _is_weighted(chosen[key]):
            chosen[key] = value
    return [chosen[key] for key in order]


def compose_tag_line(body: Mapping[str, Any]) -> str:
    """prompt案のタグ配列を`TAG_BLOCK_FIELDS`の順で1行へ連結する。

    Providerが返した配列の順序ではなくこの順を使う。並びを実装側で固定するためで
    ある。
    """
    tags: list[str] = []
    for field_name in TAG_BLOCK_FIELDS:
        values = body.get(field_name)
        if not isinstance(values, list):
            continue
        tags.extend(_normalize_tag(value) for value in values)
    return ", ".join(_dedupe(tags))


def compose_positive_prompt(tag_line: str, natural_text: str) -> str:
    """タグ行と自然文を1つのpositive promptへ組み立てる。

    公式が示す書き方に合わせ、タグ行のあとへ自然文を置く。片方だけのときは区切りを
    入れない。
    """
    parts = [part.strip() for part in (tag_line, natural_text) if part.strip()]
    return "\n\n".join(parts)


def merge_negative_prompt(baseline: str, extra: str) -> str:
    """negative promptの基準値へ、ショット固有の追加分を重複なく足す。"""
    values = [_normalize_tag(value) for value in f"{baseline},{extra}".split(",")]
    return ", ".join(_dedupe(values))


def _ensure_rating_tag(quality_tags: list[Any]) -> list[Any]:
    """`quality_tags`にratingが1つも無ければ`safe`を補う。

    `PROMPT_DIRECTIVE`はratingを必ず入れるよう指示するが、指示文だけでは
    Providerが守る保証がない。落ちていても提案自体は拒否せず、安全側の値を
    実装側で足して先へ進める。判定は`_dedupe_key`と同じ基準にそろえ、
    `(nsfw:1.3)`のような重み付きの書き方も見落とさないようにする。
    """
    has_rating = any(
        isinstance(tag, str) and _dedupe_key(_normalize_tag(tag)) in RATING_TAGS
        for tag in quality_tags
    )
    if has_rating:
        return quality_tags
    logger.warning("prompt案にratingタグが無かったためsafeを補いました。")
    return [*quality_tags, FALLBACK_RATING_TAG]


def _gloss_fallback_rating(body: dict[str, Any]) -> None:
    """実装側で補ったratingタグの訳を`tag_glosses`へ足す。

    `tag_glosses`はProviderが書いた分だけのため、補ったタグには訳が無く、
    表示するタグ訳とpromptが食い違う。Providerが`tag_glosses`を返していない
    (空を含む) ときは訳の一覧自体を出さないため、足さない。
    """
    glosses = body.get("tag_glosses")
    if not isinstance(glosses, list) or not glosses:
        return
    if any(
        isinstance(gloss, dict) and gloss.get("tag") == FALLBACK_RATING_TAG
        for gloss in glosses
    ):
        return
    glosses.append({"tag": FALLBACK_RATING_TAG, "ja": FALLBACK_RATING_GLOSS})


#: 日本語の訳とみなす文字。仮名と漢字を1字も含まない訳は、タグの英語を写したものとして扱う。
JAPANESE_CHARACTER = re.compile(r"[\u3040-\u30ff\u3400-\u9fff]")


def _drop_untranslated_glosses(body: dict[str, Any]) -> None:
    """`ja`が日本語になっていないタグ訳を捨てる。

    小さいモデルは`ja`へタグの英語をそのまま写すことがある (#355)。写しを訳として
    出すと、利用者はタグの意味を確かめられないまま訳があると受け取るため、表示しない。
    """
    glosses = body.get("tag_glosses")
    if not isinstance(glosses, list):
        return
    kept = [
        gloss
        for gloss in glosses
        if isinstance(gloss, dict)
        and JAPANESE_CHARACTER.search(str(gloss.get("ja") or ""))
    ]
    if len(kept) < len(glosses):
        logger.warning(
            "日本語になっていないタグ訳を%d件除きました。", len(glosses) - len(kept)
        )
    body["tag_glosses"] = kept


def _warn_untranslated_rationale(body: dict[str, Any]) -> None:
    """`rationale`が日本語になっていなければwarningを残す。表示する内容は変えない。

    英語でも変更の理由は伝わるため捨てない。指示では日本語で書かせている (#355)
    ので、モデルが英語で返すようになったことに運用側で気付けるようにする。
    """
    rationale = str(body.get("rationale") or "")
    if rationale.strip() and not JAPANESE_CHARACTER.search(rationale):
        logger.warning("prompt案の説明が日本語になっていません。")


def _attach_prompt_text(body: dict[str, Any]) -> None:
    """タグ行と連結済みpositive promptを派生項目として足す。

    Providerにはタグ配列と自然文だけを返させ、生成Jobへ渡す文字列はここで作る。
    """
    quality_tags = body.get("quality_tags")
    if isinstance(quality_tags, list):
        ensured = _ensure_rating_tag(quality_tags)
        if ensured is not quality_tags:
            _gloss_fallback_rating(body)
        body["quality_tags"] = ensured
    tag_line = compose_tag_line(body)
    natural_text = str(body.get("natural_text") or "").strip()
    positive_prompt = compose_positive_prompt(tag_line, natural_text)
    if not positive_prompt:
        raise AgentInvalidResponse("prompt案にタグと自然文のどちらもありません。")
    if len(positive_prompt) > MAX_POSITIVE_PROMPT_LENGTH:
        # ブロックごとの上限を全て使うとAPI契約の長さを超える。連結後に改めて当てる。
        raise AgentInvalidResponse(
            f"prompt案が長すぎます。{MAX_POSITIVE_PROMPT_LENGTH}文字以内にしてください。"
        )
    merged_negative = merge_negative_prompt(
        DEFAULT_NEGATIVE_PROMPT, str(body.get("negative_prompt") or "")
    )
    if len(merged_negative) > MAX_MERGED_NEGATIVE_LENGTH:
        # 短いタグを並べると区切りの分だけ膨らむ。基準値を足した長さで判定する。
        raise AgentInvalidResponse(
            "negative promptが長すぎます。基準値と合わせて"
            f"{MAX_MERGED_NEGATIVE_LENGTH}文字以内にしてください。"
        )
    body["tag_line"] = tag_line
    body["natural_text"] = natural_text
    body["positive_prompt"] = positive_prompt


def _try_attach_prompt_text(body: dict[str, Any]) -> bool:
    """1件分のprompt案を組み立てる。使えない案なら`False`を返して落とす。

    バッチ計画では、1件が空でも残りの案は使える。全体を捨てずに済ませる。
    """
    try:
        _attach_prompt_text(body)
    except AgentInvalidResponse:
        return False
    return True


def _record_dropped_items(data: dict[str, Any], dropped: int, reason: str) -> None:
    """落とした案があったことを`rationale`へ残す。

    `items`が黙って減ると、計画から外れたShotを利用者が計画外と読み違える。
    形が不足していた場合と、許可範囲外のIDを指していた場合の両方から呼ぶため、
    理由は呼び出し元が渡す。
    """
    if dropped <= 0:
        return
    logger.warning("提案のstepを除外しました。件数=%s 理由=%s", dropped, reason)
    note = f"{dropped}件は{reason}ため計画から外した。"
    rationale = data.get("rationale") or ""
    # 注記は必ず残す。末尾から切ると、説明が上限まで書かれているときに注記だけ消える。
    room = MAX_RATIONALE_LENGTH - len(note) - 1
    body = rationale[:room].rstrip() if room > 0 else ""
    data["rationale"] = f"{body}\n{note}" if body else note


def validate_output(kind: ProposalKind, payload: Any) -> dict[str, Any]:
    """Providerの応答を期待する形へ検証する。

    Providerが形を守る保証はない。履歴へ残す前にここで弾き、壊れた提案を
    承認対象にしない。prompt案は検証のあとタグ行とpositive promptを組み立て、
    後続がProviderの書いた並び順に触らないようにする。
    """
    if not isinstance(payload, dict):
        raise AgentInvalidResponse("提案がJSON objectではありません。")
    model = OUTPUT_MODELS[kind]
    try:
        validated = model.model_validate(payload)
    except Exception as error:
        raise AgentInvalidResponse(f"提案の形が期待と異なります: {error}") from error
    data = validated.model_dump()
    if kind == "image_prompt":
        # 補ったratingの訳は日本語のため除かれない。先に除くと、全訳が写しだったときに
        # 訳の一覧が空になり、補ったratingの訳も足されなくなる。
        _attach_prompt_text(data)
        _drop_untranslated_glosses(data)
        _warn_untranslated_rationale(data)
    elif kind == "batch_generation_plan":
        original = data.get("items", [])
        items = [
            item
            for item in original
            if isinstance(item, dict) and _try_attach_prompt_text(item)
        ]
        if not items:
            raise AgentInvalidResponse("バッチ生成計画に使えるprompt案がありません。")
        total_length = sum(len(item.get("positive_prompt", "")) for item in items)
        if total_length > MAX_BATCH_POSITIVE_PROMPT_TOTAL:
            raise AgentInvalidResponse(
                "バッチ生成計画のprompt合計が長すぎます。"
                f"{MAX_BATCH_POSITIVE_PROMPT_TOTAL}文字以内にしてください。"
            )
        data["items"] = items
        _record_dropped_items(data, len(original) - len(items), "形が不足していた")
    return data


def apply_prompt_style(
    kind: ProposalKind, output: dict[str, Any], style: str | None
) -> dict[str, Any]:
    """タグだけを解釈するモデル向けなら、自然文を落としてpositive promptを組み直す。

    指示だけでは自然文が混ざることがある。タグとして解釈されると意図しない要素が出るため、
    実装側で空にする。内容を表すタグが無い案は、ratingを補うとpositiveが空にならず
    通ってしまうため別に判定する。組み直せない案は、単発なら失敗とし、バッチ計画なら落とす。
    """
    if style != "tags" or kind not in PROMPT_STYLE_KINDS:
        return output
    data = dict(output)
    if kind == "image_prompt":
        if not _has_content_tags(data):
            raise AgentInvalidResponse("prompt案に内容を表すタグがありません。")
        data["natural_text"] = ""
        _attach_prompt_text(data)
        return data
    original = data.get("items", [])
    items: list[dict[str, Any]] = []
    for item in original:
        if not isinstance(item, dict) or not _has_content_tags(item):
            continue
        body = {**item, "natural_text": ""}
        if _try_attach_prompt_text(body):
            items.append(body)
    if not items:
        raise AgentInvalidResponse("バッチ生成計画に使えるprompt案がありません。")
    data["items"] = items
    _record_dropped_items(
        data, len(original) - len(items), "内容を表すタグが無かった"
    )
    return data


#: 現在のpromptのうち、タグとして読む単語数の上限。これより長い区切りは文とみなす。
MAX_CURRENT_TAG_WORDS = 6
#: 人数を示すタグ。現在のpromptから残すとき`subject_tags`へ戻す。
SUBJECT_TAG_PATTERN = re.compile(r"^(?:\d+\+?(?:girl|boy|other)s?|solo|multiple \w+)$")
#: 品質、meta、yearのタグ。現在のpromptから残すとき`quality_tags`へ戻す。
QUALITY_TAG_PATTERN = re.compile(
    r"^(?:masterpiece|(?:best|high|good|normal|low|worst) quality|absurdres|highres"
    r"|score_\d+(?:_up)?|(?:year )?\d{4}|newest|recent)$"
)
#: 現在のpromptに無ければ足さないブロック。内容の指示から導けない固有名と品質である。
REVISION_LOCKED_FIELDS = ("quality_tags", "character_tags", "artist_tags")


def _current_tags(current_positive_prompt: str) -> tuple[list[str], list[str]]:
    """現在のpromptのタグ行から、タグと文の一部とみなした区切りを取り出す。

    タグ行と自然文は空行で区切って組み立てる(`compose_positive_prompt`)。先頭の段落
    だけを読み、単語数が多い区切りと`.`で終わる区切りは文の一部とみなして分ける。
    """
    tag_line = current_positive_prompt.strip().split("\n\n", 1)[0]
    tags: list[str] = []
    sentences: list[str] = []
    for tag in (_normalize_tag(value) for value in tag_line.split(",")):
        if not tag:
            continue
        if len(tag.split()) <= MAX_CURRENT_TAG_WORDS and not tag.endswith("."):
            tags.append(tag)
        else:
            sentences.append(tag)
    return _dedupe(tags), _dedupe(sentences)


def _current_natural_text(current_positive_prompt: str) -> str:
    """現在のpromptの自然文。タグ行より後ろの段落をまとめて1つの自然文とみなす。"""
    parts = current_positive_prompt.strip().split("\n\n", 1)
    return parts[1].strip() if len(parts) > 1 else ""


def _mentioned(key: str, instruction: str) -> bool:
    """タグが利用者の指示に綴りどおり書かれているか。語の途中の一致は数えない。"""
    pattern = rf"(?<![a-z0-9_]){re.escape(key)}(?![a-z0-9_])"
    return re.search(pattern, instruction.casefold()) is not None


def _restored_field(tag: str) -> str:
    """現在のpromptから残すタグを入れるブロック。分からなければ`general_tags`。"""
    key = _dedupe_key(tag)
    if key in RATING_TAGS or QUALITY_TAG_PATTERN.match(key):
        return "quality_tags"
    if key.startswith("@"):
        return "artist_tags"
    if SUBJECT_TAG_PATTERN.match(key):
        return "subject_tags"
    return "general_tags"


def _is_character(key: str, character_tags: Collection[str]) -> bool:
    """タグ辞書でキャラクターと分かるタグか。辞書が無ければ常に偽。"""
    return tag_preflight.normalize_tag(key) in character_tags


def _locked_removal_field(
    key: str, declared_field: Any, character_tags: Collection[str]
) -> str | None:
    """消すタグが`REVISION_LOCKED_FIELDS`に属するなら、そのブロックを返す。

    申告を誤っても素通りしないよう、書き方で品質か絵師と分かるタグと、タグ辞書で
    キャラクターと分かるタグは申告によらず対象にする。それ以外はモデルが申告した
    ブロックを使う。辞書に無いキャラクターを別のブロックと申告された場合は見分けられ
    ない。括弧書き (`saber (fate)`) は一般のタグにも使うため、キャラクターの目印に
    しない。ratingは別に扱うため対象外とする。
    """
    if not key or key in RATING_TAGS:
        return None
    inferred = _restored_field(key)
    if inferred in REVISION_LOCKED_FIELDS:
        return inferred
    if _is_character(key, character_tags):
        return "character_tags"
    if declared_field in REVISION_LOCKED_FIELDS:
        return str(declared_field)
    return None


def revise_current_prompt(
    output: dict[str, Any],
    current_positive_prompt: str,
    instruction: str,
    character_tags: Collection[str] = frozenset(),
) -> dict[str, Any]:
    """現在のpromptを直した案を、指示と関係の無いタグが変わらないよう整える (#356)。

    小さいモデルは直すつもりでも作り直し、指示に無いrating、キャラクター、絵師を足したり、
    関係の無いタグを落としたりする。指示文だけでは防げないため実装側で次を保つ。

    - `tag_changes`で消したと挙げずに落とした現在のタグは戻す
    - 品質、キャラクター、絵師のタグは、現在のpromptか指示に綴りが無ければ足さない
    - 同じく、指示に綴りが無ければ`tag_changes`で消したと挙げても戻す (#382)
    - キャラクターは申告したブロックによらず、`character_tags`(タグ辞書のキャラクター
      のタグ名)に載るタグも対象にする (#388)
    - `natural_text_change`で消したと挙げずに自然文を空にしたら、現在の自然文を戻す
    - ratingは指示に綴りが無ければ現在のpromptの値を使い、無ければ`safe`にする

    戻した結果がブロックの件数上限(`MAX_PROMPT_TAGS`)を超えたときは拒否する。文の
    一部とみなして戻さなかった区切りは、案から消えていればwarningへ残す。
    """
    current, current_sentences = _current_tags(current_positive_prompt)
    current_keys = {_dedupe_key(tag) for tag in current}
    data = dict(output)
    for name in TAG_BLOCK_FIELDS:
        data[name] = [
            tag
            for tag in (_normalize_tag(value) for value in data.get(name) or [])
            if tag
        ]

    requested = [
        tag
        for tag in data["quality_tags"]
        if _dedupe_key(tag) in RATING_TAGS and _mentioned(_dedupe_key(tag), instruction)
    ]
    current_ratings = [tag for tag in current if _dedupe_key(tag) in RATING_TAGS]
    rating = (requested or current_ratings or [FALLBACK_RATING_TAG])[0]
    data["quality_tags"] = [
        tag for tag in data["quality_tags"] if _dedupe_key(tag) not in RATING_TAGS
    ]

    added: list[str] = []
    for name in TAG_BLOCK_FIELDS:
        kept = []
        for tag in data[name]:
            key = _dedupe_key(tag)
            locked = name in REVISION_LOCKED_FIELDS or _is_character(
                key, character_tags
            )
            if not locked or key in current_keys or _mentioned(key, instruction):
                kept.append(tag)
            else:
                added.append(tag)
        data[name] = kept

    # `indoors`を`indoor`と書くような単複の揺れは、消したものとして扱う。消すタグの
    # うち品質、キャラクター、絵師は、指示に綴りが無ければ消したものとして扱わない。
    removed_keys: set[str] = set()
    locked_removals: dict[str, str] = {}
    for change in data.get("tag_changes") or []:
        if not isinstance(change, dict) or change.get("change") != "removed":
            continue
        key = _dedupe_key(_normalize_tag(change.get("tag")))
        locked_field = _locked_removal_field(key, change.get("field"), character_tags)
        if locked_field and not _mentioned(key, instruction):
            locked_removals[key.removesuffix("s")] = locked_field
        else:
            removed_keys.add(key.removesuffix("s"))
    output_keys = {_dedupe_key(tag) for name in TAG_BLOCK_FIELDS for tag in data[name]}
    restored: list[tuple[str, str]] = []
    for tag in current:
        key = _dedupe_key(tag)
        if (
            key in RATING_TAGS
            or key in output_keys
            or key.removesuffix("s") in removed_keys
        ):
            continue
        field = locked_removals.get(key.removesuffix("s"), _restored_field(tag))
        data[field].append(tag)
        restored.append((tag, field))
    data["quality_tags"].append(rating)
    unrestored = [
        sentence
        for sentence in current_sentences
        if _dedupe_key(sentence) not in output_keys
        and _dedupe_key(sentence).removesuffix("s") not in removed_keys
    ]
    unremoved = [
        tag
        for tag, _ in restored
        if _dedupe_key(tag).removesuffix("s") in locked_removals
    ]
    dropped = [tag for tag, _ in restored if tag not in unremoved]

    # 自然文は綴りで指示との関係を判定できない。理由を添えずに消したときだけ戻す。
    # 上限を超える自然文は案へ入れられないため戻さず、warningで知らせる。
    current_natural_text = _current_natural_text(current_positive_prompt)
    natural_text_change = data.get("natural_text_change")
    dropped_natural_text = bool(
        current_natural_text
        and not str(data.get("natural_text") or "").strip()
        and not (
            isinstance(natural_text_change, dict)
            and natural_text_change.get("change") == "removed"
        )
    )
    restored_natural_text = (
        dropped_natural_text and len(current_natural_text) <= MAX_NATURAL_TEXT_LENGTH
    )
    if restored_natural_text:
        data["natural_text"] = current_natural_text

    if added or restored or unrestored or dropped_natural_text:
        logger.warning(
            "レビュー案を整えました。足さなかったタグ: %s / 戻したタグ: %s"
            " / 指示に綴りが無く消さなかったタグ: %s"
            " / 文とみなして戻さなかった区切り: %s / 自然文を戻した: %s",
            ", ".join(added) or "なし",
            ", ".join(dropped) or "なし",
            ", ".join(unremoved) or "なし",
            ", ".join(unrestored) or "なし",
            "はい"
            if restored_natural_text
            else "上限を超えるため戻せず"
            if dropped_natural_text
            else "いいえ",
        )
    # 上限を超えたブロックはすべて報告する。1つずつ直して再実行させないため (#378)。
    over_limit = [
        f"{name}が{len(data[name])}件 (うち現在のpromptから戻したタグ: "
        f"{sum(1 for _, field in restored if field == name)}件)"
        for name in TAG_BLOCK_FIELDS
        if len(data[name]) > MAX_PROMPT_TAGS
    ]
    if over_limit:
        raise AgentInvalidResponse(
            f"レビュー案のタグが多すぎます。上限の{MAX_PROMPT_TAGS}件を超えるブロック: "
            f"{'、'.join(over_limit)}。"
        )
    final_keys = {_dedupe_key(tag) for name in TAG_BLOCK_FIELDS for tag in data[name]}
    glosses = [
        gloss
        for gloss in data.get("tag_glosses") or []
        if isinstance(gloss, dict)
        and _dedupe_key(_normalize_tag(gloss.get("tag"))) in final_keys
    ]
    if _dedupe_key(rating) == FALLBACK_RATING_TAG and not any(
        gloss.get("tag") == FALLBACK_RATING_TAG for gloss in glosses
    ):
        glosses.append({"tag": FALLBACK_RATING_TAG, "ja": FALLBACK_RATING_GLOSS})
    data["tag_glosses"] = glosses
    _attach_prompt_text(data)
    return data


def _tag_line_items(tag_line: str) -> list[str]:
    """タグ行をカンマで区切り、空でない区切りを重複なく返す。"""
    return _dedupe(
        tag for tag in (_normalize_tag(value) for value in tag_line.split(",")) if tag
    )


def describe_prompt_changes(
    output: dict[str, Any], current_positive_prompt: str
) -> dict[str, Any]:
    """`tag_changes`と`natural_text_change`を、案と現在のpromptの実際の差分で組み直す。

    モデルの申告は、戻したタグや書き方の整形と食い違う。変更の有無は最終的な案との
    差分で決め、理由だけをモデルの出力からタグのキーで引く。理由が無い変更は空文字に
    する。現在のpromptが無ければ直した案ではないため、変更なしとして返す。
    """
    data = dict(output)
    if not current_positive_prompt.strip():
        data["tag_changes"] = []
        data["natural_text_change"] = {"change": "unchanged", "reason": ""}
        return data

    reasons: dict[tuple[str, str], str] = {}
    for change in data.get("tag_changes") or []:
        if isinstance(change, dict):
            key = _dedupe_key(_normalize_tag(change.get("tag"))).removesuffix("s")
            reason = str(change.get("reason") or "").strip()
            reasons.setdefault((str(change.get("change")), key), reason)

    def tag_change(tag: str, kind: str) -> dict[str, str]:
        key = _dedupe_key(tag).removesuffix("s")
        return {"tag": tag, "change": kind, "reason": reasons.get((kind, key), "")}

    before = _tag_line_items(current_positive_prompt.strip().split("\n\n", 1)[0])
    after = _tag_line_items(str(data.get("tag_line") or ""))
    before_keys = {_dedupe_key(tag) for tag in before}
    after_keys = {_dedupe_key(tag) for tag in after}
    data["tag_changes"] = [
        tag_change(tag, "added") for tag in after if _dedupe_key(tag) not in before_keys
    ] + [
        tag_change(tag, "removed")
        for tag in before
        if _dedupe_key(tag) not in after_keys
    ]

    current_text = " ".join(_current_natural_text(current_positive_prompt).split())
    proposed_text = " ".join(str(data.get("natural_text") or "").split())
    if current_text == proposed_text:
        kind = "unchanged"
    elif not current_text:
        kind = "added"
    elif not proposed_text:
        kind = "removed"
    else:
        kind = "modified"
    declared = data.get("natural_text_change")
    reason = (
        str(declared.get("reason") or "").strip()
        if kind != "unchanged" and isinstance(declared, dict)
        else ""
    )
    data["natural_text_change"] = {"change": kind, "reason": reason}
    return data


#: 画面の内容を表すタグ配列。品質と絵師のタグだけでは何を描くかが決まらない。
CONTENT_TAG_FIELDS = tuple(
    name for name in TAG_BLOCK_FIELDS if name not in {"quality_tags", "artist_tags"}
)


def _has_content_tags(body: Mapping[str, Any]) -> bool:
    """`CONTENT_TAG_FIELDS`に空でないタグが1つでもあるか。"""
    return any(
        isinstance(tag, str) and _normalize_tag(tag)
        for name in CONTENT_TAG_FIELDS
        if isinstance(body.get(name), list)
        for tag in body[name]
    )


#: 画像を添付したときに本文へ足す説明。画像そのものは本文と別の経路でProviderへ渡す。
IMAGE_DIRECTIVE = (
    "## 添付画像\n"
    "添付した画像は、対象の情報にある現在のpromptで生成した結果か、利用者が持ち込んだ"
    "画像である。画像を見て利用者の指示と食い違う箇所を特定し、現在のpromptを土台に"
    "その箇所だけを直したpromptを返す。直した理由はrationaleに書く。"
)


#: 現在のpromptを渡して直させるときに本文へ足す説明。小さいモデルは作り直すつもりで
#: 全ブロックを埋め、指示に無いキャラクター、絵師、ratingを足したり、指示と関係の無い
#: タグを落としたりする (#356)。
REVISION_DIRECTIVE = (
    "## 現在のpromptを直すとき\n"
    "対象の情報のcurrent_positive_promptが、直す元のpromptである。そのタグを1つずつ"
    "該当するブロックの配列へ写し、利用者の指示に関わるタグだけを足すか消すか置き換える。"
    "指示に関わらないタグは1つも消さない。current_positive_promptに無いキャラクター、"
    "作品、絵師、meta、year、ratingのタグは足さず、そのブロックは空配列のままにする。"
    "指示に関わらない外見、表情、ポーズ、アングルのタグも足さない。"
    "ratingはcurrent_positive_promptにある値をそのまま使い、無ければsafeにする。"
    "tag_changesには、足したタグ(置き換えた先を含む)をchange=added、"
    "current_positive_promptから消したタグ(置き換えた元を含む)をchange=removedとして"
    "1件ずつ書く。tagはタグをそのまま、fieldはそのタグが属する(消したタグは属していた)"
    "ブロック名、reasonには利用者の指示のどこに対応する変更かを日本語で書く。"
    "current_positive_promptの2段落目が現在の自然文である。natural_text_changeのchangeには、"
    "自然文を変えなければunchanged、新しく書けばadded、消せばremoved、書き換えれば"
    "modifiedを入れ、reasonに理由を日本語で書く。指示に関わらない自然文は"
    "そのままnatural_textへ写す。"
    "rationaleには実際に変えたタグだけを書き、変えていない点を変えたと書かない。"
)


def build_prompt(request: ProposalRequest) -> str:
    """Providerへ渡す本文。コマンド行ではなく標準入力へ流す。"""
    sections = [KIND_DIRECTIVES[request.kind], ""]
    if (
        request.kind in PROMPT_STYLE_KINDS
        and request.context.get("prompt_style") == "tags"
    ):
        sections.extend([TAGS_STYLE_DIRECTIVE, ""])
    if request.guidance:
        sections.extend([request.guidance, ""])
    sections.extend(
        [
            "## 利用者の指示",
            request.instruction.strip() or "(指示なし)",
            "",
            "## 対象の情報",
            json.dumps(request.context, ensure_ascii=False, indent=2),
        ]
    )
    if request.kind == "image_prompt" and request.context.get(
        "current_positive_prompt"
    ):
        sections.extend(["", REVISION_DIRECTIVE])
    if request.images:
        sections.extend(["", IMAGE_DIRECTIVE])
    return "\n".join(sections)


def restrict_reference_candidates(
    kind: AgentProposalKind, output: dict[str, Any], allowed_ids: set[str]
) -> dict[str, Any]:
    """参照候補のArtifact IDを、渡した一覧にあるものだけへ制限する。

    IDはProviderの出力であり、一覧から選ぶという指示を守る保証はない。範囲外のIDを
    そのまま履歴へ残すと、後からこの値を使う画面や機能が存在しないArtifactを指せる。
    範囲外は空にし、候補の説明だけを残す。
    """
    if kind != "reference_candidates":
        return output
    candidates = output.get("candidates")
    if not isinstance(candidates, list):
        return output
    restricted = [
        {
            **candidate,
            "artifact_id": (
                candidate.get("artifact_id")
                if candidate.get("artifact_id") in allowed_ids
                else ""
            ),
        }
        for candidate in candidates
    ]
    return {**output, "candidates": restricted}


def restrict_output(
    kind: AgentProposalKind,
    output: dict[str, Any],
    *,
    artifact_ids: set[str],
    shot_ids: set[str],
    recipe_input_names: set[str],
) -> dict[str, Any]:
    """提案の出力を、入力コンテキストへ載せた範囲だけへ制限する。

    IDも入力名もProviderの出力であり、一覧から選ぶという指示を守る保証はない。範囲外
    のまま履歴へ残すと、適用時に入力へ載せていない対象を触れてしまう。参照候補は値を
    空にし、適用先を持つ準備段階の計画は該当stepごと落とす。空のIDを適用対象として
    残さないためである。
    """
    if kind == "reference_candidates":
        return restrict_reference_candidates(kind, output, artifact_ids)
    if kind == "batch_generation_plan":
        return _restrict_items(output, "shot_id", shot_ids)
    if kind == "asset_organization_plan":
        return _restrict_items(output, "artifact_id", artifact_ids)
    if kind == "workflow_registration_draft":
        return _restrict_defaults(output, recipe_input_names)
    return output


def _restrict_items(
    output: dict[str, Any], key: str, allowed: set[str]
) -> dict[str, Any]:
    """計画のstepを、指定のIDが許可された範囲にあるものだけへ絞る。

    落としたstepは`_record_dropped_items`で`rationale`へ注記する。何も記録せずに
    黙って`items`が減ると、計画から外れた対象を利用者が計画外と読み違える。
    """
    items = output.get("items")
    if not isinstance(items, list):
        return output
    kept = [
        item for item in items if isinstance(item, dict) and item.get(key) in allowed
    ]
    result = {**output, "items": kept}
    _record_dropped_items(
        result, len(items) - len(kept), "許可されていない対象を指していた"
    )
    return result


def _restrict_defaults(
    output: dict[str, Any], allowed_names: set[str]
) -> dict[str, Any]:
    """Recipe案の`defaults`を、基準Recipeが宣言した入力だけへ絞る。

    宣言に無い項目を通すと、基準Recipeの`input_schema`が許さない値をRecipeの既定値
    として登録できてしまう。値も表示できる型だけへ限り、入れ子のJSONは落とす。
    """
    defaults = output.get("defaults")
    if not isinstance(defaults, dict):
        return output
    kept: dict[str, Any] = {}
    for name, value in defaults.items():
        if name not in allowed_names or not isinstance(value, (str, int, float, bool)):
            continue
        if isinstance(value, str) and len(value) > 4000:
            continue
        kept[name] = value
        if len(kept) >= MAX_PLAN_DEFAULTS:
            break
    return {**output, "defaults": kept}


def _canon_refs(refs: Any) -> list[dict[str, Any]]:
    """Canon参照の位置情報だけを渡す。Canon本文は渡さない。"""
    entries: list[dict[str, Any]] = []
    if not isinstance(refs, list):
        return entries
    for ref in refs:
        if not isinstance(ref, dict):
            continue
        entries.append(
            {
                "path": ref.get("path"),
                "anchor": ref.get("anchor"),
                "note": ref.get("note"),
            }
        )
    return entries


def _named_entries(values: Any, keys: tuple[str, ...]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    if not isinstance(values, list):
        return entries
    for value in values:
        if not isinstance(value, dict):
            continue
        entry = {key: value.get(key) for key in keys}
        if "canon_refs" in value:
            entry["canon_refs"] = _canon_refs(value.get("canon_refs"))
        entries.append(entry)
    return entries


def scene_context(scene: Any) -> dict[str, Any]:
    """Scene envelopeの`data`から、提案へ渡す項目だけを取り出す。"""
    if not isinstance(scene, dict):
        return {}
    location = scene.get("location")
    return {
        "id": scene.get("id"),
        "sequence": scene.get("sequence"),
        "summary": scene.get("summary"),
        "goal": scene.get("goal"),
        "time_of_day": scene.get("time_of_day"),
        "season": scene.get("season"),
        "location": (
            {
                "display_name": location.get("display_name"),
                "canon_refs": _canon_refs(location.get("canon_refs")),
            }
            if isinstance(location, dict)
            else None
        ),
        "characters": _named_entries(scene.get("characters"), ("id", "display_name")),
    }


def shot_context(shot: Any) -> dict[str, Any]:
    """Shot envelopeの`data`から、提案へ渡す項目だけを取り出す。"""
    if not isinstance(shot, dict):
        return {}
    camera = shot.get("camera")
    return {
        "id": shot.get("id"),
        "sequence": shot.get("sequence"),
        "summary": shot.get("summary"),
        "duration_sec": shot.get("duration_sec"),
        "camera": (
            {
                key: camera.get(key)
                for key in ("framing", "angle", "movement", "composition")
            }
            if isinstance(camera, dict)
            else None
        ),
        "characters": _named_entries(
            shot.get("characters"),
            ("character_id", "role", "action", "expression", "gaze"),
        ),
        "dialogue": _named_entries(shot.get("dialogue"), ("character_id", "text")),
        "canon_refs": _canon_refs(shot.get("canon_refs")),
    }


def recipe_context(recipe: Any) -> dict[str, Any]:
    """Recipeから提案へ渡す項目だけを取り出す。

    モデルファイル名や保存先のようなローカル固有の値は渡さない。画面に出る入力欄の
    名前と説明だけで提案できる。
    """
    if recipe is None:
        return {}
    input_schema = getattr(recipe, "input_schema", None)
    fields: list[dict[str, Any]] = []
    if isinstance(input_schema, dict):
        for name, definition in input_schema.items():
            if not isinstance(definition, dict):
                continue
            fields.append(
                {
                    "name": name,
                    "type": definition.get("type"),
                    "label": definition.get("label"),
                    "required": bool(definition.get("required")),
                }
            )
    return {
        "id": getattr(recipe, "id", None),
        "name": getattr(recipe, "name", None),
        "kind": getattr(recipe, "kind", None),
        "inputs": fields,
    }


def artifact_context(
    artifacts: Any, tags: dict[str, list[str]] | None = None
) -> list[dict[str, Any]]:
    """参照候補と資産整理の提示に渡す既存Artifactの一覧。実ファイルの中身は渡さない。

    `tags`を渡すと現在のタグも載せる。資産整理案は既に付いているタグを見ないと、
    付け直しと外す対象を選べないためである。
    """
    entries: list[dict[str, Any]] = []
    if not isinstance(artifacts, list):
        return entries
    for artifact in artifacts[:MAX_CONTEXT_ARTIFACTS]:
        artifact_id = getattr(artifact, "id", None)
        entry: dict[str, Any] = {
            "artifact_id": artifact_id,
            "kind": getattr(artifact, "kind", None),
            "decision": getattr(artifact, "decision", None),
            "created_at": getattr(artifact, "created_at", None),
        }
        if tags is not None:
            entry["tags"] = tags.get(str(artifact_id), [])
        entries.append(entry)
    return entries


def shot_list_context(items: Any) -> list[dict[str, Any]]:
    """バッチ生成計画に渡すScene配下のShot一覧。

    渡すのは一覧表示に出る項目だけとする。Shot本文は対象のShotを個別に取得したとき
    だけ渡し、Scene配下の全文を流さない。
    """
    entries: list[dict[str, Any]] = []
    if not isinstance(items, list):
        return entries
    for item in items[:MAX_CONTEXT_SHOTS]:
        if not isinstance(item, dict):
            continue
        entries.append(
            {
                "id": item.get("id"),
                "sequence": item.get("sequence"),
                "summary": item.get("summary"),
                "duration_sec": item.get("duration_sec"),
            }
        )
    return entries
