"""提案の種別ごとの入出力定義。

出力の形はここだけで決める。Providerへ渡すJSON Schemaも、受け取った応答の検証も同じ
定義から作り、Providerが形を守らなかった応答をそのまま履歴へ残さない。

入力コンテキストは参照APIの表示用フィールドだけを許可リストで組み立てる。拒否したい
項目を並べるのではなく、渡す項目を列挙する。上流の契約に項目が増えても、既定で
Providerへ流れないようにするためである。
"""

import json
from collections.abc import Iterable, Mapping
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from mycomfyui_api.adapters.agent.base import (
    AgentInvalidResponse,
    AgentProposalKind,
    ProposalRequest,
)

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
MAX_PROMPT_TAGS = 40

#: prompt案のタグ1件の長さ上限。重み括弧を付けても収まる長さにする。
MAX_PROMPT_TAG_LENGTH = 200

#: prompt案の自然文の長さ上限。混在形式では2〜3文・50語程度までしか効かない。
MAX_NATURAL_TEXT_LENGTH = 2000

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
    negative_prompt: str = Field(default="", max_length=4000)


class ImagePromptOutput(PromptBody):
    """画像生成のprompt案。承認後の生成Job投入に使う。"""

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


OUTPUT_MODELS: dict[AgentProposalKind, type[ProposalOutput]] = {
    "image_prompt": ImagePromptOutput,
    "shot_breakdown": ShotBreakdownOutput,
    "reference_candidates": ReferenceCandidatesOutput,
    "recipe_draft": RecipeDraftOutput,
    "workflow_registration_draft": WorkflowRegistrationDraftOutput,
    "batch_generation_plan": BatchGenerationPlanOutput,
    "asset_organization_plan": AssetOrganizationPlanOutput,
}

#: prompt案の書き方。prompt案を持つ種別で同じ規約を使う。
#: 出典はQwen-Image(Anima)の作法。詳細は`docs/design/qwen-image-prompt-spec.md`。
PROMPT_DIRECTIVE = (
    "promptはタグと自然文で組み立てる。タグはブロックごとの配列で返し、"
    "1つの配列へ他ブロックの語を混ぜない。連結の順序は実装側が決めるため、"
    "配列をまたぐ並び順は考えなくてよい。\n"
    "- quality_tags: masterpiece、best qualityなどの品質、meta、year、rating\n"
    "- subject_tags: 1girl、2girls、soloなどの人数\n"
    "- character_tags: キャラクター名と作品名\n"
    "- artist_tags: 絵師。`@`を前に付ける\n"
    "- general_tags: 外見、ポーズ、カメラ、背景、光。この順に並べる。"
    "from belowやfrom sideなどのアングルは前の方へ置く\n"
    "タグは英語の小文字とスペースで書き、値へカンマを含めない。"
    "矛盾するタグを同居させず、同じ部位へ同義のタグを3つ以上置かない。\n"
    "natural_textには、タグでは結び付けられない関係を書く。"
    "誰がどこにいて何に触れているか、視線の向き、光源の向きと光が当たる面を、"
    "代名詞を使わず主語を名詞にして2文以上で書く。\n"
    "subject_tagsが2人以上を示すときは、髪色・髪型・眼鏡など見分けに使う属性を"
    "general_tagsへ入れず、natural_text側でキャラクターごとに書く。"
    "タグへ残してよいのは全員に共通する属性だけとする。\n"
    "negative_promptには、このショット固有の避けたい要素だけを書く。"
    "品質系の基準値は実装側が足すため書かない。"
)

#: 種別ごとの指示。Providerへ渡すsystem promptの本文へ埋め込む。
KIND_DIRECTIVES: dict[AgentProposalKind, str] = {
    "image_prompt": (
        "与えたShotまたは利用者説明に沿う画像生成promptを1件提案する。\n"
        + PROMPT_DIRECTIVE
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
}

SYSTEM_PROMPT = (
    "あなたは映像制作の提案だけを行う。ファイル操作、コマンド実行、外部送信、"
    "生成ジョブの投入は一切行わない。与えられた情報だけを根拠に、"
    "指定されたJSON Schemaに適合するJSONを1件返す。"
    "推測で事実を作らず、情報が足りない項目は空文字か空配列にする。"
)


def json_schema(kind: AgentProposalKind) -> dict[str, Any]:
    """Providerへ渡す出力JSON Schema。"""
    return OUTPUT_MODELS[kind].model_json_schema()


def strict_json_schema(kind: AgentProposalKind) -> dict[str, Any]:
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
        return ""
    return " ".join(value.replace(",", " ").split())


def _dedupe(values: Iterable[str]) -> list[str]:
    """順序を保ったまま重複と空文字を落とす。比較は大文字小文字を無視する。"""
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        key = value.casefold()
        if not value or key in seen:
            continue
        seen.add(key)
        result.append(value)
    return result


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


def _attach_prompt_text(body: dict[str, Any]) -> None:
    """タグ行と連結済みpositive promptを派生項目として足す。

    Providerにはタグ配列と自然文だけを返させ、生成Jobへ渡す文字列はここで作る。
    """
    tag_line = compose_tag_line(body)
    natural_text = str(body.get("natural_text") or "").strip()
    positive_prompt = compose_positive_prompt(tag_line, natural_text)
    if not positive_prompt:
        raise AgentInvalidResponse("prompt案にタグと自然文のどちらもありません。")
    body["tag_line"] = tag_line
    body["natural_text"] = natural_text
    body["positive_prompt"] = positive_prompt


def validate_output(kind: AgentProposalKind, payload: Any) -> dict[str, Any]:
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
        _attach_prompt_text(data)
    elif kind == "batch_generation_plan":
        for item in data.get("items", []):
            if isinstance(item, dict):
                _attach_prompt_text(item)
    return data


def build_prompt(request: ProposalRequest) -> str:
    """Providerへ渡す本文。コマンド行ではなく標準入力へ流す。"""
    return "\n".join(
        [
            KIND_DIRECTIVES[request.kind],
            "",
            "## 利用者の指示",
            request.instruction.strip() or "(指示なし)",
            "",
            "## 対象の情報",
            json.dumps(request.context, ensure_ascii=False, indent=2),
        ]
    )


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
    """計画のstepを、指定のIDが許可された範囲にあるものだけへ絞る。"""
    items = output.get("items")
    if not isinstance(items, list):
        return output
    kept = [
        item for item in items if isinstance(item, dict) and item.get(key) in allowed
    ]
    return {**output, "items": kept}


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
