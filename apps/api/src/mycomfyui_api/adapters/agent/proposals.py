"""提案の種別ごとの入出力定義。

出力の形はここだけで決める。Providerへ渡すJSON Schemaも、受け取った応答の検証も同じ
定義から作り、Providerが形を守らなかった応答をそのまま履歴へ残さない。

入力コンテキストは参照APIの表示用フィールドだけを許可リストで組み立てる。拒否したい
項目を並べるのではなく、渡す項目を列挙する。上流の契約に項目が増えても、既定で
Providerへ流れないようにするためである。
"""

import json
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from mycomfyui_api.adapters.agent.base import (
    AgentInvalidResponse,
    AgentProposalKind,
    ProposalRequest,
)

#: 利用者の指示文の上限。提案の入力に収まる長さへ抑える。
MAX_INSTRUCTION_LENGTH = 2000

#: 参照候補の提示に渡す既存Artifactの上限。
MAX_CONTEXT_ARTIFACTS = 20


class ProposalOutput(BaseModel):
    """提案出力の基底。未知の項目を受け付けない。"""

    model_config = ConfigDict(extra="forbid")


class ImagePromptOutput(ProposalOutput):
    """画像生成のprompt案。承認後の生成Job投入に使う。"""

    positive_prompt: str = Field(min_length=1, max_length=4000)
    negative_prompt: str = Field(default="", max_length=4000)
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


OUTPUT_MODELS: dict[AgentProposalKind, type[ProposalOutput]] = {
    "image_prompt": ImagePromptOutput,
    "shot_breakdown": ShotBreakdownOutput,
    "reference_candidates": ReferenceCandidatesOutput,
    "recipe_draft": RecipeDraftOutput,
}

#: 種別ごとの指示。Providerへ渡すsystem promptの本文へ埋め込む。
KIND_DIRECTIVES: dict[AgentProposalKind, str] = {
    "image_prompt": (
        "与えたShotの内容に沿う画像生成promptを1件提案する。"
        "positive_promptは英語の語句列、negative_promptは避けたい要素とする。"
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


def validate_output(kind: AgentProposalKind, payload: Any) -> dict[str, Any]:
    """Providerの応答を期待する形へ検証する。

    Providerが形を守る保証はない。履歴へ残す前にここで弾き、壊れた提案を
    承認対象にしない。
    """
    if not isinstance(payload, dict):
        raise AgentInvalidResponse("提案がJSON objectではありません。")
    model = OUTPUT_MODELS[kind]
    try:
        validated = model.model_validate(payload)
    except Exception as error:
        raise AgentInvalidResponse(f"提案の形が期待と異なります: {error}") from error
    return validated.model_dump()


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


def artifact_context(artifacts: Any) -> list[dict[str, Any]]:
    """参照候補の提示に渡す既存Artifactの一覧。実ファイルの中身は渡さない。"""
    entries: list[dict[str, Any]] = []
    if not isinstance(artifacts, list):
        return entries
    for artifact in artifacts[:MAX_CONTEXT_ARTIFACTS]:
        entries.append(
            {
                "artifact_id": getattr(artifact, "id", None),
                "kind": getattr(artifact, "kind", None),
                "decision": getattr(artifact, "decision", None),
                "created_at": getattr(artifact, "created_at", None),
            }
        )
    return entries
