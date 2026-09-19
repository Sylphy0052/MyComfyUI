"""ComfyUI Workflow(API形式JSON)の構造検証とパラメータ注入。

ComfyUIのNode IDとclass_typeの知識はこのモジュールへ閉じ込める。上位層(routers、
schemas、Executor)はrole名も含め、変数名だけを扱う。

Workflowテンプレートは人間がComfyUI GUIで作りAPI形式で書き出したものを同梱する。
実行できるのは同梱テンプレートだけで、行うのは許可された変数の差し替えに限る。
利用者由来のJSONをそのまま実行する経路は持たない。
"""

import copy
import hashlib
import json
import random
from collections.abc import Mapping
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"

#: seedの上限。ComfyUIのKSamplerが受け付ける符号なし64bitの範囲に合わせる。
MAX_SEED = 2**64 - 1

#: seedの自動採番を指示する値。
AUTO_SEED = -1


class WorkflowError(ValueError):
    """テンプレートの構造、または注入する値が期待と合わない。"""


@dataclass(frozen=True)
class NodeRef:
    """Workflow内の1ノードへの参照。

    node_idだけでなくclass_typeも持ち、テンプレートを差し替えたときに誤ったノードへ
    値を書き込むことを防ぐ。
    """

    node_id: str
    class_type: str
    required_inputs: tuple[str, ...]


@dataclass(frozen=True)
class LinkRef:
    """あるノードの入力が、どのノードから来ているべきかの期待値。"""

    source_role: str
    input_key: str
    expected_role: str


@dataclass(frozen=True)
class VariableRef:
    """差し替えを許す1変数と、その書き込み先。"""

    role: str
    input_key: str
    value_type: str
    required: bool = False


@dataclass(frozen=True)
class ModelSlot:
    """モデルファイル名を受け取る変数と、在庫確認に使うノード定義。"""

    variable: str
    node_class: str
    option_field: str


@dataclass(frozen=True)
class WorkflowBinding:
    """WorkflowテンプレートとMyComfyUIの変数の対応関係。"""

    name: str
    nodes: Mapping[str, NodeRef]
    links: tuple[LinkRef, ...]
    variables: Mapping[str, VariableRef]
    model_slots: tuple[ModelSlot, ...]
    prompt_variable: str


ANIMA_TXT2IMG = WorkflowBinding(
    name="anima_txt2img",
    nodes={
        "unet_loader": NodeRef("60", "UNETLoader", ("unet_name", "weight_dtype")),
        "clip_loader": NodeRef("61", "CLIPLoader", ("clip_name", "type")),
        "vae_loader": NodeRef("62", "VAELoader", ("vae_name",)),
        "positive_prompt": NodeRef("6", "CLIPTextEncode", ("text",)),
        "negative_prompt": NodeRef("7", "CLIPTextEncode", ("text",)),
        "latent": NodeRef("5", "EmptyLatentImage", ("width", "height", "batch_size")),
        "ksampler": NodeRef(
            "3",
            "KSampler",
            ("seed", "steps", "cfg", "sampler_name", "scheduler", "denoise"),
        ),
        "vae_decode": NodeRef("8", "VAEDecode", ()),
        "save_image": NodeRef("9", "SaveImage", ("filename_prefix",)),
    },
    links=(
        LinkRef("ksampler", "model", "unet_loader"),
        LinkRef("ksampler", "positive", "positive_prompt"),
        LinkRef("ksampler", "negative", "negative_prompt"),
        LinkRef("ksampler", "latent_image", "latent"),
        # Anima系のtext encoderはCLIPではなくQwen3のため、CLIPSetLastLayerを挟まず
        # CLIPLoaderへ直結する。間に挟むと条件付けが壊れる。
        LinkRef("positive_prompt", "clip", "clip_loader"),
        LinkRef("negative_prompt", "clip", "clip_loader"),
        LinkRef("vae_decode", "samples", "ksampler"),
        LinkRef("vae_decode", "vae", "vae_loader"),
        LinkRef("save_image", "images", "vae_decode"),
    ),
    variables={
        "positive_prompt": VariableRef("positive_prompt", "text", "str", required=True),
        "negative_prompt": VariableRef("negative_prompt", "text", "str"),
        "width": VariableRef("latent", "width", "positive_int"),
        "height": VariableRef("latent", "height", "positive_int"),
        "seed": VariableRef("ksampler", "seed", "seed"),
        "steps": VariableRef("ksampler", "steps", "positive_int"),
        "cfg": VariableRef("ksampler", "cfg", "positive_float"),
        "sampler_name": VariableRef("ksampler", "sampler_name", "str"),
        "scheduler": VariableRef("ksampler", "scheduler", "str"),
        "unet_name": VariableRef("unet_loader", "unet_name", "str", required=True),
        "clip_name": VariableRef("clip_loader", "clip_name", "str", required=True),
        "vae_name": VariableRef("vae_loader", "vae_name", "str", required=True),
        "filename_prefix": VariableRef("save_image", "filename_prefix", "str"),
    },
    model_slots=(
        ModelSlot("unet_name", "UNETLoader", "unet_name"),
        ModelSlot("clip_name", "CLIPLoader", "clip_name"),
        ModelSlot("vae_name", "VAELoader", "vae_name"),
    ),
    prompt_variable="positive_prompt",
)

#: 実行を許可するテンプレート。利用者入力から任意のJSONを実行させないためのallowlist。
ALLOWED_TEMPLATES: dict[str, WorkflowBinding] = {ANIMA_TXT2IMG.name: ANIMA_TXT2IMG}


@dataclass(frozen=True)
class PreparedWorkflow:
    """投入直前のWorkflowと、Manifestへ残す解決済みの値。"""

    template_name: str
    template_sha256: str
    workflow: dict[str, Any]
    seed: int
    resolved_prompt: str
    model: dict[str, str]
    parameters: dict[str, Any]


@lru_cache
def _load_template(name: str) -> tuple[str, str]:
    """テンプレートの本文とSHA-256を返す。内容は起動中に変わらない前提で保持する。"""
    binding = ALLOWED_TEMPLATES.get(name)
    if binding is None:
        raise WorkflowError(f"許可されていないWorkflowテンプレートです: {name}")
    path = TEMPLATES_DIR / f"{name}.json"
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise WorkflowError(f"Workflowテンプレートを読み込めません: {name}") from error
    return raw.decode("utf-8"), hashlib.sha256(raw).hexdigest()


def template_digest(name: str) -> str:
    """テンプレートのSHA-256を返す。Recipeの参照が指す版の照合に使う。"""
    return _load_template(name)[1]


def _validate_structure(workflow: dict[str, Any], binding: WorkflowBinding) -> None:
    """テンプレートがbindingの期待どおりの構造かを確かめる。

    ノードの取り違えと結線の食い違いは「動くが指定が効かない」出力を生むため、
    投入前にここで弾く。
    """
    for role, node in binding.nodes.items():
        entry = workflow.get(node.node_id)
        if not isinstance(entry, dict):
            raise WorkflowError(f"ノード{node.node_id}({role})がありません。")
        if entry.get("class_type") != node.class_type:
            raise WorkflowError(
                f"ノード{node.node_id}のclass_typeが期待と違います: "
                f"{entry.get('class_type')!r} (期待: {node.class_type})"
            )
        inputs = entry.get("inputs")
        if not isinstance(inputs, dict):
            raise WorkflowError(f"ノード{node.node_id}にinputsがありません。")
        missing = [key for key in node.required_inputs if key not in inputs]
        if missing:
            raise WorkflowError(
                f"ノード{node.node_id}の入力が不足しています: {', '.join(missing)}"
            )

    for link in binding.links:
        source = binding.nodes[link.source_role]
        expected = binding.nodes[link.expected_role]
        value = workflow[source.node_id]["inputs"].get(link.input_key)
        if not isinstance(value, list) or not value:
            raise WorkflowError(
                f"ノード{source.node_id}の{link.input_key}が接続されていません。"
            )
        if value[0] != expected.node_id:
            raise WorkflowError(
                f"ノード{source.node_id}の{link.input_key}の接続元が違います: "
                f"{value[0]!r} (期待: {expected.node_id})"
            )

    unknown = set(workflow) - {node.node_id for node in binding.nodes.values()}
    if unknown:
        raise WorkflowError(
            f"テンプレートに未知のノードがあります: {', '.join(sorted(unknown))}"
        )


def _coerce(name: str, value: Any, value_type: str) -> Any:
    """変数の値を検証する。boolはintとして受け取らない。"""
    if value_type == "str":
        if not isinstance(value, str):
            raise WorkflowError(f"{name}は文字列で指定します。")
        return value
    if value_type == "seed":
        if isinstance(value, bool) or not isinstance(value, int):
            raise WorkflowError(f"{name}は整数で指定します。")
        if value != AUTO_SEED and not 0 <= value <= MAX_SEED:
            raise WorkflowError(f"{name}は{AUTO_SEED}、または0以上{MAX_SEED}以下です。")
        return value
    if value_type == "positive_int":
        if isinstance(value, bool) or not isinstance(value, int):
            raise WorkflowError(f"{name}は整数で指定します。")
        if value <= 0:
            raise WorkflowError(f"{name}は1以上で指定します。")
        return value
    if value_type == "positive_float":
        if isinstance(value, bool) or not isinstance(value, int | float):
            raise WorkflowError(f"{name}は数値で指定します。")
        if value <= 0:
            raise WorkflowError(f"{name}は0より大きい値で指定します。")
        return float(value)
    raise WorkflowError(f"未知の値の種別です: {value_type}")


def resolve_seed(value: int | None) -> int:
    """`-1`または未指定なら採番する。実際に使った値だけをManifestへ残す。"""
    if value is None or value == AUTO_SEED:
        return random.randrange(0, MAX_SEED + 1)
    return value


def build_workflow(template_name: str, values: Mapping[str, Any]) -> PreparedWorkflow:
    """テンプレートへ許可された変数だけを注入し、投入用のWorkflowを組み立てる。

    `values`はRecipeの`defaults`と要求の`inputs`をマージ済みの値を受け取る。未知の
    変数と必須変数の不足はここで拒否する。
    """
    binding = ALLOWED_TEMPLATES.get(template_name)
    if binding is None:
        raise WorkflowError(
            f"許可されていないWorkflowテンプレートです: {template_name}"
        )

    unknown = set(values) - set(binding.variables)
    if unknown:
        raise WorkflowError(
            f"このWorkflowで指定できない変数です: {', '.join(sorted(unknown))}"
        )
    missing = [
        name
        for name, variable in binding.variables.items()
        if variable.required and name not in values
    ]
    if missing:
        raise WorkflowError(f"必須の変数が不足しています: {', '.join(sorted(missing))}")

    raw, digest = _load_template(template_name)
    workflow = json.loads(raw)
    _validate_structure(workflow, binding)

    resolved: dict[str, Any] = {}
    for name, value in values.items():
        variable = binding.variables[name]
        resolved[name] = _coerce(name, value, variable.value_type)
    if "seed" in binding.variables:
        resolved["seed"] = resolve_seed(resolved.get("seed"))

    workflow = copy.deepcopy(workflow)
    for name, value in resolved.items():
        variable = binding.variables[name]
        node_id = binding.nodes[variable.role].node_id
        workflow[node_id]["inputs"][variable.input_key] = value

    model = {
        slot.variable: resolved[slot.variable]
        for slot in binding.model_slots
        if slot.variable in resolved
    }
    parameters = {
        name: value
        for name, value in resolved.items()
        if name not in model and name != binding.prompt_variable
    }
    return PreparedWorkflow(
        template_name=template_name,
        template_sha256=digest,
        workflow=workflow,
        seed=int(resolved.get("seed", 0)),
        resolved_prompt=str(resolved[binding.prompt_variable]),
        model=model,
        parameters=parameters,
    )


def model_slots(template_name: str) -> tuple[ModelSlot, ...]:
    """在庫確認に使うモデル変数の定義を返す。"""
    binding = ALLOWED_TEMPLATES.get(template_name)
    if binding is None:
        raise WorkflowError(
            f"許可されていないWorkflowテンプレートです: {template_name}"
        )
    return binding.model_slots
