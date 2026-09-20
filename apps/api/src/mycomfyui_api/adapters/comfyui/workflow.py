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
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"

#: seedの上限。ComfyUIのKSamplerは符号なし64bitまで受け付けるが、seedは
#: SQLiteのINTEGER(符号付き64bit)へ保存し、JSONの数値としてWeb UIまで往復する。
#: JavaScriptの数値は2^53までしか誤差なく表せず、これを超えると画面に出るseedが実際に
#: 使った値とずれ、再実行で再現できなくなる。往復できる範囲へ揃える。
MAX_SEED = 2**53 - 1

#: seedの自動採番を指示する値。
AUTO_SEED = -1

#: 出力ファイル名の接頭辞に使える文字。拒否したい文字を列挙するのではなく、使える
#: 文字だけを許す。NUL文字や全角の区切り文字のような、想定していない表現を残さない。
FILE_PREFIX_ALLOWED_CHARS = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
)

#: 出力ファイル名の接頭辞の長さ上限。
FILE_PREFIX_MAX_LENGTH = 64

#: ComfyUIのinputへ置くファイル名の長さ上限。
INPUT_FILE_NAME_MAX_LENGTH = 200

#: アップロードした素材を差し込む変数の種別。
UPLOAD_VALUE_TYPES = ("image_name", "audio_name")


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
class OptionalNode:
    """投入前に取り除けるノード。

    参照画像の枚数や音声の扱いは要求ごとに変わる。テンプレートは最大構成で持ち、
    使わないノードを投入前に削る。削ったノードを参照している結線は、`fallback_role`
    があればそちらへ付け替え、無ければ結線ごと取り除く。
    """

    role: str
    fallback_role: str | None = None
    fallback_output: int = 0


@dataclass(frozen=True)
class WorkflowBinding:
    """WorkflowテンプレートとMyComfyUIの変数の対応関係。"""

    name: str
    nodes: Mapping[str, NodeRef]
    links: tuple[LinkRef, ...]
    variables: Mapping[str, VariableRef]
    model_slots: tuple[ModelSlot, ...]
    prompt_variable: str
    #: role名をキーにした、取り除けるノードの定義。
    optional_nodes: Mapping[str, OptionalNode] = field(default_factory=dict)


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
        "filename_prefix": VariableRef("save_image", "filename_prefix", "file_prefix"),
    },
    model_slots=(
        ModelSlot("unet_name", "UNETLoader", "unet_name"),
        ModelSlot("clip_name", "CLIPLoader", "clip_name"),
        ModelSlot("vae_name", "VAELoader", "vae_name"),
    ),
    prompt_variable="positive_prompt",
)


def _h3_common_nodes() -> dict[str, NodeRef]:
    """H3のサンプリング以降。R2VとI2Vで同じ構成を使う。"""
    return {
        "noise": NodeRef("6", "RandomNoise", ("noise_seed",)),
        "sampler": NodeRef("7", "KSamplerSelect", ("sampler_name",)),
        "scheduler": NodeRef("8", "BasicScheduler", ("scheduler", "steps", "denoise")),
        "guider": NodeRef("9", "BasicGuider", ()),
        "sampling": NodeRef("10", "SamplerCustomAdvanced", ()),
        "video_decode": NodeRef("11", "VAEDecode", ()),
        "audio_decode": NodeRef("12", "VAEDecodeAudio", ()),
        "create_video": NodeRef("13", "CreateVideo", ("fps",)),
        "save_video": NodeRef(
            "14", "SaveVideo", ("filename_prefix", "format", "codec")
        ),
        "guide_audio": NodeRef("40", "LoadAudio", ("audio",)),
        "add_guide": NodeRef("41", "MiniMaxH3AddGuide", ("frame_idx",)),
    }


def _h3_loader_nodes() -> dict[str, NodeRef]:
    return {
        "unet_loader": NodeRef("1", "UNETLoader", ("unet_name", "weight_dtype")),
        "clip_loader": NodeRef("2", "CLIPLoader", ("clip_name", "type")),
        "video_vae": NodeRef("3", "VAELoader", ("vae_name",)),
        "audio_vae": NodeRef("4", "VAELoader", ("vae_name",)),
    }


#: H3のサンプリング以降で共通の結線。
_H3_COMMON_LINKS: tuple[LinkRef, ...] = (
    LinkRef("scheduler", "model", "unet_loader"),
    LinkRef("guider", "model", "unet_loader"),
    # 既定はガイド音声ありの構成にしておき、使わないときに`add_guide`を取り除いて
    # 条件付けを`h3`へ戻す。
    LinkRef("guider", "conditioning", "add_guide"),
    LinkRef("sampling", "noise", "noise"),
    LinkRef("sampling", "guider", "guider"),
    LinkRef("sampling", "sampler", "sampler"),
    LinkRef("sampling", "sigmas", "scheduler"),
    LinkRef("sampling", "latent_image", "h3"),
    LinkRef("video_decode", "samples", "sampling"),
    LinkRef("video_decode", "vae", "video_vae"),
    LinkRef("audio_decode", "samples", "sampling"),
    LinkRef("audio_decode", "vae", "audio_vae"),
    LinkRef("create_video", "images", "video_decode"),
    LinkRef("create_video", "audio", "audio_decode"),
    LinkRef("save_video", "video", "create_video"),
    LinkRef("add_guide", "positive", "h3"),
    LinkRef("add_guide", "audio_vae", "audio_vae"),
    LinkRef("add_guide", "latent", "h3"),
    LinkRef("add_guide", "audio", "guide_audio"),
)

#: H3のサンプリング以降で共通の変数。
_H3_COMMON_VARIABLES: dict[str, VariableRef] = {
    "seed": VariableRef("noise", "noise_seed", "seed"),
    "steps": VariableRef("scheduler", "steps", "positive_int"),
    "denoise": VariableRef("scheduler", "denoise", "positive_float"),
    "sampler_name": VariableRef("sampler", "sampler_name", "str"),
    "scheduler": VariableRef("scheduler", "scheduler", "str"),
    "fps": VariableRef("create_video", "fps", "positive_float"),
    "filename_prefix": VariableRef("save_video", "filename_prefix", "file_prefix"),
    "unet_name": VariableRef("unet_loader", "unet_name", "str", required=True),
    "clip_name": VariableRef("clip_loader", "clip_name", "str", required=True),
    "video_vae_name": VariableRef("video_vae", "vae_name", "str", required=True),
    "audio_vae_name": VariableRef("audio_vae", "vae_name", "str", required=True),
    "guide_audio": VariableRef("guide_audio", "audio", "audio_name"),
    "guide_frame_idx": VariableRef("add_guide", "frame_idx", "non_negative_int"),
}

#: H3のモデルスロット。R2VとI2Vで同じ。
_H3_MODEL_SLOTS: tuple[ModelSlot, ...] = (
    ModelSlot("unet_name", "UNETLoader", "unet_name"),
    ModelSlot("clip_name", "CLIPLoader", "clip_name"),
    ModelSlot("video_vae_name", "VAELoader", "vae_name"),
    ModelSlot("audio_vae_name", "VAELoader", "vae_name"),
)

#: ガイド音声と無音の切り替えで取り除くノード。R2VとI2Vで同じ。
_H3_COMMON_OPTIONAL: dict[str, OptionalNode] = {
    # ガイド音声を使わないときは条件付けを`h3`の出力へ戻す。
    "add_guide": OptionalNode("add_guide", fallback_role="h3"),
    "guide_audio": OptionalNode("guide_audio"),
    # 無音にするときは音声の復号ごと外し、`CreateVideo`の音声入力を落とす。
    "audio_decode": OptionalNode("audio_decode"),
}

#: R2Vが持つ参照画像スロットの上限。テンプレートは最大構成で持ち、使わない分を削る。
MAX_REFERENCE_IMAGES = 9

#: 参照画像スロットの変数名。`reference_0`は必須で、残りは任意ノードとして削れる。
REFERENCE_VARIABLES: tuple[str, ...] = tuple(
    f"reference_{index}" for index in range(MAX_REFERENCE_IMAGES)
)


MINIMAX_H3_REF2V = WorkflowBinding(
    name="minimax_h3_ref2v",
    nodes={
        **_h3_loader_nodes(),
        **{
            f"reference_{index}": NodeRef(str(20 + index), "LoadImage", ("image",))
            for index in range(MAX_REFERENCE_IMAGES)
        },
        "h3": NodeRef(
            "5",
            "MiniMaxH3ReferenceToVideo",
            ("prompt", "width", "height", "length", "ref_image_size"),
        ),
        **_h3_common_nodes(),
    },
    links=(
        LinkRef("h3", "clip", "clip_loader"),
        LinkRef("h3", "vae", "video_vae"),
        LinkRef("h3", "audio_vae", "audio_vae"),
        *(
            LinkRef("h3", f"ref_images.ref_image_{index}", f"reference_{index}")
            for index in range(MAX_REFERENCE_IMAGES)
        ),
        *_H3_COMMON_LINKS,
    ),
    variables={
        "positive_prompt": VariableRef("h3", "prompt", "str", required=True),
        "width": VariableRef("h3", "width", "positive_int"),
        "height": VariableRef("h3", "height", "positive_int"),
        "length": VariableRef("h3", "length", "positive_int"),
        "ref_image_size": VariableRef("h3", "ref_image_size", "str"),
        **{
            f"reference_{index}": VariableRef(
                f"reference_{index}", "image", "image_name"
            )
            for index in range(MAX_REFERENCE_IMAGES)
        },
        **_H3_COMMON_VARIABLES,
    },
    model_slots=_H3_MODEL_SLOTS,
    prompt_variable="positive_prompt",
    optional_nodes={
        **{
            f"reference_{index}": OptionalNode(f"reference_{index}")
            for index in range(1, MAX_REFERENCE_IMAGES)
        },
        **_H3_COMMON_OPTIONAL,
    },
)


MINIMAX_H3_I2V = WorkflowBinding(
    name="minimax_h3_i2v",
    nodes={
        **_h3_loader_nodes(),
        "first_frame": NodeRef("20", "LoadImage", ("image",)),
        "h3": NodeRef(
            "5", "MiniMaxH3ImageToVideo", ("prompt", "width", "height", "length")
        ),
        **_h3_common_nodes(),
    },
    links=(
        LinkRef("h3", "clip", "clip_loader"),
        LinkRef("h3", "vae", "video_vae"),
        LinkRef("h3", "first_frame", "first_frame"),
        *_H3_COMMON_LINKS,
    ),
    variables={
        "positive_prompt": VariableRef("h3", "prompt", "str", required=True),
        "width": VariableRef("h3", "width", "positive_int"),
        "height": VariableRef("h3", "height", "positive_int"),
        "length": VariableRef("h3", "length", "positive_int"),
        "first_frame": VariableRef("first_frame", "image", "image_name"),
        **_H3_COMMON_VARIABLES,
    },
    model_slots=_H3_MODEL_SLOTS,
    prompt_variable="positive_prompt",
    optional_nodes=dict(_H3_COMMON_OPTIONAL),
)


ACE_STEP_BGM = WorkflowBinding(
    name="ace_step_bgm",
    nodes={
        "checkpoint": NodeRef("1", "CheckpointLoaderSimple", ("ckpt_name",)),
        "positive_tags": NodeRef(
            "2", "TextEncodeAceStepAudio", ("tags", "lyrics", "lyrics_strength")
        ),
        "negative_tags": NodeRef(
            "3", "TextEncodeAceStepAudio", ("tags", "lyrics", "lyrics_strength")
        ),
        "latent": NodeRef("4", "EmptyAceStepLatentAudio", ("seconds", "batch_size")),
        "ksampler": NodeRef(
            "5",
            "KSampler",
            ("seed", "steps", "cfg", "sampler_name", "scheduler", "denoise"),
        ),
        "decode": NodeRef("6", "VAEDecodeAudio", ()),
        "save_audio": NodeRef("7", "SaveAudio", ("filename_prefix",)),
    },
    links=(
        LinkRef("positive_tags", "clip", "checkpoint"),
        LinkRef("negative_tags", "clip", "checkpoint"),
        LinkRef("ksampler", "model", "checkpoint"),
        LinkRef("ksampler", "positive", "positive_tags"),
        LinkRef("ksampler", "negative", "negative_tags"),
        LinkRef("ksampler", "latent_image", "latent"),
        LinkRef("decode", "samples", "ksampler"),
        LinkRef("decode", "vae", "checkpoint"),
        LinkRef("save_audio", "audio", "decode"),
    ),
    variables={
        "positive_prompt": VariableRef("positive_tags", "tags", "str", required=True),
        "negative_prompt": VariableRef("negative_tags", "tags", "str"),
        "lyrics": VariableRef("positive_tags", "lyrics", "str"),
        "seconds": VariableRef("latent", "seconds", "positive_float"),
        "seed": VariableRef("ksampler", "seed", "seed"),
        "steps": VariableRef("ksampler", "steps", "positive_int"),
        "cfg": VariableRef("ksampler", "cfg", "positive_float"),
        "sampler_name": VariableRef("ksampler", "sampler_name", "str"),
        "scheduler": VariableRef("ksampler", "scheduler", "str"),
        "denoise": VariableRef("ksampler", "denoise", "positive_float"),
        "filename_prefix": VariableRef("save_audio", "filename_prefix", "file_prefix"),
        "ckpt_name": VariableRef("checkpoint", "ckpt_name", "str", required=True),
    },
    model_slots=(ModelSlot("ckpt_name", "CheckpointLoaderSimple", "ckpt_name"),),
    prompt_variable="positive_prompt",
)


#: 実行を許可するテンプレート。利用者入力から任意のJSONを実行させないためのallowlist。
ALLOWED_TEMPLATES: dict[str, WorkflowBinding] = {
    binding.name: binding
    for binding in (ANIMA_TXT2IMG, MINIMAX_H3_REF2V, MINIMAX_H3_I2V, ACE_STEP_BGM)
}


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
    #: 型変換まで済ませた変数ごとの確定値。投入前プレビューが既定値との差分を作る。
    resolved_values: dict[str, Any] = field(default_factory=dict)


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
    if value_type == "file_prefix":
        # SaveImageのfilename_prefixはComfyUI側でサブフォルダとして解釈される。
        # 出力先をComfyUIのoutput配下から動かせないよう、使える文字を限る。
        if not isinstance(value, str):
            raise WorkflowError(f"{name}は文字列で指定します。")
        if (
            not value
            or len(value) > FILE_PREFIX_MAX_LENGTH
            or set(value) - FILE_PREFIX_ALLOWED_CHARS
            or ".." in value
        ):
            raise WorkflowError(
                f"{name}は英数字、ドット、アンダースコア、ハイフンだけで"
                f"{FILE_PREFIX_MAX_LENGTH}文字以内で指定します。"
                "親ディレクトリ参照は使えません。"
            )
        return value
    if value_type in ("image_name", "audio_name"):
        # ComfyUIのinputディレクトリ上のファイル名。投入直前にアップロード結果で
        # 置き換わるが、テンプレートへ書き込む時点でも区切り文字を通さない。
        if not isinstance(value, str) or not value:
            raise WorkflowError(f"{name}は空でない文字列で指定します。")
        if len(value) > INPUT_FILE_NAME_MAX_LENGTH:
            raise WorkflowError(
                f"{name}は{INPUT_FILE_NAME_MAX_LENGTH}文字以内で指定します。"
            )
        if "/" in value or "\\" in value or value in (".", ".."):
            raise WorkflowError(f"{name}にディレクトリ区切りを含められません。")
        return value
    if value_type == "non_negative_int":
        if isinstance(value, bool) or not isinstance(value, int):
            raise WorkflowError(f"{name}は整数で指定します。")
        if value < 0:
            raise WorkflowError(f"{name}は0以上で指定します。")
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


def _apply_drops(
    workflow: dict[str, Any], binding: WorkflowBinding, drop_roles: frozenset[str]
) -> None:
    """使わない任意ノードを取り除き、参照していた結線を付け替えるか外す。

    構造検証は最大構成のテンプレートに対して先に済ませる。ここでは、その構成から
    削るだけとし、テンプレートに無いノードを足すことはしない。
    """
    for role in drop_roles:
        workflow.pop(binding.nodes[role].node_id, None)
    for link in binding.links:
        if link.expected_role not in drop_roles:
            continue
        source_id = binding.nodes[link.source_role].node_id
        entry = workflow.get(source_id)
        if not isinstance(entry, dict):
            # 送り元ごと削られている。付け替える相手がいない。
            continue
        optional = binding.optional_nodes[link.expected_role]
        fallback = optional.fallback_role
        if fallback is not None and fallback not in drop_roles:
            entry["inputs"][link.input_key] = [
                binding.nodes[fallback].node_id,
                optional.fallback_output,
            ]
        else:
            entry["inputs"].pop(link.input_key, None)


def build_workflow(
    template_name: str,
    values: Mapping[str, Any],
    *,
    drop_roles: frozenset[str] = frozenset(),
) -> PreparedWorkflow:
    """テンプレートへ許可された変数だけを注入し、投入用のWorkflowを組み立てる。

    `values`はRecipeの`defaults`と要求の`inputs`をマージ済みの値を受け取る。未知の
    変数と必須変数の不足はここで拒否する。`drop_roles`には、要求では使わない任意
    ノードのrole名を渡す。
    """
    binding = ALLOWED_TEMPLATES.get(template_name)
    if binding is None:
        raise WorkflowError(
            f"許可されていないWorkflowテンプレートです: {template_name}"
        )

    undroppable = sorted(drop_roles - set(binding.optional_nodes))
    if undroppable:
        raise WorkflowError(f"取り除けないノードです: {', '.join(undroppable)}")
    dropped_values = sorted(
        name
        for name, variable in binding.variables.items()
        if variable.role in drop_roles and name in values
    )
    if dropped_values:
        # 取り除いたノードへ値を書こうとしている。指定が黙って捨てられる状態のまま
        # 実行させない。
        raise WorkflowError(f"使わないノードへの指定です: {', '.join(dropped_values)}")

    unknown = set(values) - set(binding.variables)
    if unknown:
        raise WorkflowError(
            f"このWorkflowで指定できない変数です: {', '.join(sorted(unknown))}"
        )
    missing = [
        name
        for name, variable in binding.variables.items()
        if variable.required and variable.role not in drop_roles and name not in values
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
    _apply_drops(workflow, binding, drop_roles)
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
        resolved_values=dict(resolved),
    )


def _binding_of(template_name: str) -> WorkflowBinding:
    binding = ALLOWED_TEMPLATES.get(template_name)
    if binding is None:
        raise WorkflowError(
            f"許可されていないWorkflowテンプレートです: {template_name}"
        )
    return binding


def variable_names(template_name: str) -> frozenset[str]:
    """テンプレートが受け付ける変数名を返す。Recipeの`input_schema`の検証に使う。"""
    return frozenset(_binding_of(template_name).variables)


def template_defaults(template_name: str) -> dict[str, Any]:
    """テンプレートに書かれている変数ごとの既定値を返す。

    投入前プレビューが「Workflowの既定値から何が変わるか」を示すために使う。値の出所は
    テンプレートJSONのノード入力そのものとし、Recipeの`defaults`は混ぜない。書き込み先の
    ノードや入力が無い変数は、既定値を持たないものとして落とす。
    """
    binding = _binding_of(template_name)
    raw, _ = _load_template(template_name)
    workflow = json.loads(raw)
    defaults: dict[str, Any] = {}
    for name, variable in binding.variables.items():
        node = binding.nodes.get(variable.role)
        if node is None:
            continue
        entry = workflow.get(node.node_id)
        if not isinstance(entry, dict):
            continue
        inputs = entry.get("inputs")
        if not isinstance(inputs, dict) or variable.input_key not in inputs:
            continue
        value = inputs[variable.input_key]
        if isinstance(value, list):
            # 結線はノード参照の配列で表される。既定値ではないため載せない。
            continue
        defaults[name] = value
    return defaults


def optional_roles(template_name: str) -> frozenset[str]:
    """取り除ける任意ノードのrole名を返す。"""
    binding = _binding_of(template_name)
    return frozenset(binding.optional_nodes)


def upload_slots(template_name: str) -> dict[str, tuple[str, str]]:
    """アップロードした素材を差し込む変数と、その書き込み先を返す。

    実行直前に差し替えるのはAdapterの仕事だが、どのノードのどの入力を差し替えるかは
    テンプレートの知識のため、ここから引けるようにする。
    """
    binding = _binding_of(template_name)
    return {
        name: (binding.nodes[variable.role].node_id, variable.input_key)
        for name, variable in binding.variables.items()
        if variable.value_type in UPLOAD_VALUE_TYPES
    }


def template_option_values(node_class: str, field_name: str) -> tuple[str, ...]:
    """同梱テンプレートが宣言しているモデルファイル名を集める。

    在庫を持たないスタブBackendが、同梱Recipeで実行できる選択肢を返すために使う。
    """
    names: list[str] = []
    for name in ALLOWED_TEMPLATES:
        raw, _ = _load_template(name)
        for entry in json.loads(raw).values():
            if not isinstance(entry, dict) or entry.get("class_type") != node_class:
                continue
            value = entry.get("inputs", {}).get(field_name)
            if isinstance(value, str) and value not in names:
                names.append(value)
    return tuple(names)


def model_slots(template_name: str) -> tuple[ModelSlot, ...]:
    """在庫確認に使うモデル変数の定義を返す。"""
    return _binding_of(template_name).model_slots
