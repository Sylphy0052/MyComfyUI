"""ComfyUI JobのRecipe検証とWorkflow組み立て。

`routers`から呼ばれ、実行スナップショットとManifestへ残す値を返す。ComfyUIの
テンプレート名とノードの知識はここから先(`workflow`モジュール)に閉じる。

画像・動画・音楽はどれもComfyUIの同じプロセスで動くため、engineは`comfyui`のまま
Recipeの`kind`とテンプレート名で区別する。動画と音楽に固有の投入前検証もここで行い、
違反はJobを作らずに`PreparationError`とする。
"""

from dataclasses import dataclass, field
from typing import Any

from mycomfyui_api import sources
from mycomfyui_api.adapters.comfyui import workflow as workflow_module
from mycomfyui_api.execution import (
    PreparationContext,
    PreparationError,
    PreparedExecution,
)
from mycomfyui_api.models import Recipe

#: フレーム数のグリッド。`17k+5`に合わない値はComfyUI側で切り上げられ、指定した尺と
#: 実際の尺がずれる(`ai-media/検証_minimax/動画構成案.md`)。
FRAME_GRID_STEP = 17
FRAME_GRID_BASE = 5

#: 学習範囲のフレーム数。24fpsで5.2〜15.1秒に当たる
#: (`ai-media/検証_minimax/プロンプト作法.md`)。
MIN_FRAMES = 124
MAX_FRAMES = 362

#: 参照画像の枚数。上限は`ai-media`の`ShotReference`定義に合わせる。
MIN_REFERENCE_IMAGES = 1
MAX_REFERENCE_IMAGES = workflow_module.MAX_REFERENCE_IMAGES

#: 音声の扱い。`native`はH3が映像と同時に生成し、`external_voice`は生成済みの音声を
#: ガイドとしてアンカーし、`silent`は音声を付けない。
AUDIO_MODE_NATIVE = "native"
AUDIO_MODE_EXTERNAL_VOICE = "external_voice"
AUDIO_MODE_SILENT = "silent"
AUDIO_MODES = (AUDIO_MODE_NATIVE, AUDIO_MODE_EXTERNAL_VOICE, AUDIO_MODE_SILENT)

#: テンプレート変数ではないが動画Jobが受け取れる入力。
VIDEO_EXTRA_INPUTS = frozenset({"references", "audio_mode"})

#: 参照画像を受け取るテンプレート。
REF2V_TEMPLATE = "minimax_h3_ref2v"
#: 開始フレームを受け取るテンプレート。
I2V_TEMPLATE = "minimax_h3_i2v"

KIND_VIDEO = "video"
KIND_MUSIC = "music"
KIND_IMAGE = "image"

IMG2IMG_TEMPLATE = "anima_img2img"
INPAINT_TEMPLATE = "anima_inpaint"
CONTROLNET_TEMPLATE = "sd15_controlnet"
UPSCALE_TEMPLATE = "image_upscale"
#: img2imgではなくtxt2imgに元画像を参照として注入する派生(Issue #159)。
REF_SIGLIP_TEMPLATE = "anima_ref_siglip"
REF_INCONTEXT_TEMPLATE = "anima_ref_incontext"
DERIVATION_TEMPLATES = frozenset(
    {
        IMG2IMG_TEMPLATE,
        INPAINT_TEMPLATE,
        CONTROLNET_TEMPLATE,
        UPSCALE_TEMPLATE,
        REF_SIGLIP_TEMPLATE,
        REF_INCONTEXT_TEMPLATE,
    }
)


@dataclass(frozen=True)
class _MediaPlan:
    """テンプレートへ渡す値と、投入直前に差し替える素材の対応。"""

    values: dict[str, Any]
    drop_roles: frozenset[str] = frozenset()
    uploads: list[dict[str, Any]] = field(default_factory=list)
    input_refs: list[dict[str, Any]] = field(default_factory=list)
    parameters: dict[str, Any] = field(default_factory=dict)
    #: テンプレート変数ではないが、入力として受け取って確定した値。
    resolved_extras: dict[str, Any] = field(default_factory=dict)
    parent_job_id: str | None = None
    parent_artifact_id: str | None = None


async def _image_plan(
    template_name: str, values: dict[str, Any], context: PreparationContext
) -> _MediaPlan:
    """画像派生の主入力とmaskを解決し、Artifact lineageを固定する。"""
    if template_name not in DERIVATION_TEMPLATES:
        return _MediaPlan(values=dict(values))
    remaining = dict(values)
    slots = workflow_module.upload_slots(template_name)
    uploads: list[dict[str, Any]] = []
    input_refs: list[dict[str, Any]] = []

    async def take(variable: str, raw: Any, label: str) -> sources.InputSource:
        source = await sources.resolve(
            raw,
            label=label,
            lookup=context.artifact_lookup,
            artifact_kinds=("image",),
        )
        node_id, input_key = slots[variable]
        remaining[variable] = source.file_name
        uploads.append(
            {
                "variable": variable,
                "node_id": node_id,
                "input_key": input_key,
                "source": source.kind,
                "relative_path": source.relative_path,
                "sha256": source.sha256,
                "file_name": source.file_name,
                "artifact_id": source.artifact_id,
            }
        )
        input_refs.append(sources.reference(source, label))
        return source

    raw_source = remaining.pop("source_image", None)
    if raw_source is None:
        raise PreparationError("source_imageに派生元画像を指定します。")
    primary = await take("source_image", raw_source, "派生元画像")

    if template_name == INPAINT_TEMPLATE:
        raw_mask = remaining.pop("mask_image", None)
        if raw_mask is None:
            raise PreparationError("inpaintにはmask_imageが必要です。")
        await take("mask_image", raw_mask, "inpaint mask")
    if template_name == CONTROLNET_TEMPLATE:
        start = remaining.get("control_start")
        end = remaining.get("control_end")
        if isinstance(start, int | float) and isinstance(end, int | float) and start > end:
            raise PreparationError("control_startはcontrol_end以下で指定します。")
        canny_low = remaining.get("canny_low")
        canny_high = remaining.get("canny_high")
        if (
            isinstance(canny_low, int | float)
            and isinstance(canny_high, int | float)
            and canny_low > canny_high
        ):
            raise PreparationError("canny_lowはcanny_high以下で指定します。")
        width = remaining.get("width")
        height = remaining.get("height")
        batch_size = remaining.get("batch_size")
        if all(
            isinstance(value, int) and not isinstance(value, bool)
            for value in (width, height, batch_size)
        ) and width * height * batch_size > 100_000_000:
            raise PreparationError("幅×高さ×batch_sizeは1億pixel以下にしてください。")

    return _MediaPlan(
        values=remaining,
        uploads=uploads,
        input_refs=input_refs,
        parent_job_id=primary.job_id,
        parent_artifact_id=primary.artifact_id,
    )


def resolve_template_name(recipe: Recipe) -> str:
    """Recipeが指すWorkflowテンプレートを許可済み一覧から解決する。

    利用者入力から任意のJSONを実行させないため、参照できるのは同梱テンプレートだけ
    とする。`sha256`を持つ参照は、指している版が同梱物と一致することまで確かめる。
    """
    reference = recipe.workflow_template_ref
    if not isinstance(reference, dict):
        raise PreparationError("Recipeのworkflow_template_refが不正です。")
    name = reference.get("name")
    if not isinstance(name, str) or name not in workflow_module.ALLOWED_TEMPLATES:
        raise PreparationError(
            "許可されていないWorkflowテンプレートです。",
            {"name": name, "allowed": sorted(workflow_module.ALLOWED_TEMPLATES)},
        )
    expected = reference.get("sha256")
    if isinstance(
        expected, str
    ) and expected.lower() != workflow_module.template_digest(name):
        raise PreparationError(
            "Workflowテンプレートの内容が参照と一致しません。", {"name": name}
        )
    return name


def accepted_input_names(recipe: Recipe, template_name: str) -> frozenset[str]:
    """Recipeが受け取れる入力の全体。テンプレート変数と種別ごとの追加分を束ねる。"""
    names = workflow_module.variable_names(template_name)
    if recipe.kind == KIND_VIDEO:
        return names | VIDEO_EXTRA_INPUTS
    return names


def submittable_input_names(recipe: Recipe, template_name: str) -> frozenset[str]:
    """Jobの投入時にinputsへ入れてよい変数名。`input_schema`があればそれで絞る。

    `validate_against_input_schema`と同じ規則で、テンプレート変数のうちRecipeが
    受け付けるものだけを返す。
    """
    names = accepted_input_names(recipe, template_name)
    schema = recipe.input_schema
    if not isinstance(schema, dict) or not schema:
        return names
    return names & frozenset(schema)


def validate_against_input_schema(
    recipe: Recipe,
    template_name: str,
    inputs: dict[str, Any],
    values: dict[str, Any],
) -> None:
    """Recipeの`input_schema`で、受け取る変数と必須項目を絞る。

    テンプレート側のallowlistより狭い範囲しか許さないRecipeを作れるようにする。
    `input_schema`は変数名をキーとし、値が`{"required": true}`を持つ項目を必須とする。
    空のときはテンプレート側の定義だけで判定する。
    """
    schema = recipe.input_schema
    if not isinstance(schema, dict) or not schema:
        return
    known = accepted_input_names(recipe, template_name)
    undefined = set(schema) - known
    if undefined:
        raise PreparationError(
            "Recipeのinput_schemaがWorkflowに無い変数を指しています。",
            {"template": template_name, "unknown": sorted(undefined)},
        )
    rejected = set(inputs) - set(schema)
    if rejected:
        raise PreparationError(
            "このRecipeで指定できない変数です。",
            {"rejected": sorted(rejected), "allowed": sorted(schema)},
        )
    malformed = sorted(
        name for name, spec in schema.items() if not isinstance(spec, dict | str)
    )
    if malformed:
        # 必須指定は`{"required": true}`で書く。`true`のような書き間違いを黙って
        # 読み飛ばすと、必須チェックが効かないまま動いてしまう。
        raise PreparationError(
            "Recipeのinput_schemaの項目は、型名の文字列かobjectで書きます。",
            {"malformed": malformed},
        )
    missing = [
        name
        for name, spec in schema.items()
        if isinstance(spec, dict)
        and spec.get("required") is True
        and name not in values
    ]
    if missing:
        raise PreparationError(
            "Recipeが必須とする変数が不足しています。", {"missing": sorted(missing)}
        )


def validate_frame_count(value: Any) -> int:
    """フレーム数が17k+5グリッドと学習範囲に収まっているかを確かめる。"""
    if isinstance(value, bool) or not isinstance(value, int):
        raise PreparationError("lengthは整数で指定します。")
    if (value - FRAME_GRID_BASE) % FRAME_GRID_STEP != 0:
        raise PreparationError(
            "lengthは17k+5のフレーム数で指定します。"
            "合わない値はComfyUI側で切り上げられ、指定した尺とずれます。",
            {"length": value, "nearest": nearest_frame_count(value)},
        )
    if not MIN_FRAMES <= value <= MAX_FRAMES:
        raise PreparationError(
            f"lengthは{MIN_FRAMES}以上{MAX_FRAMES}以下で指定します。",
            {"length": value, "min": MIN_FRAMES, "max": MAX_FRAMES},
        )
    return value


def nearest_frame_count(value: int) -> int:
    """17k+5グリッド上で、指定値以上かつ学習範囲に収まる最小のフレーム数を返す。"""
    steps = max((value - FRAME_GRID_BASE + FRAME_GRID_STEP - 1) // FRAME_GRID_STEP, 0)
    candidate = FRAME_GRID_BASE + steps * FRAME_GRID_STEP
    return min(max(candidate, MIN_FRAMES), MAX_FRAMES)


async def _video_plan(
    template_name: str, values: dict[str, Any], context: PreparationContext
) -> _MediaPlan:
    """動画Jobの投入前検証と、参照画像・ガイド音声の受け渡しを決める。"""
    remaining = dict(values)
    length = validate_frame_count(remaining.get("length"))

    audio_mode = remaining.pop("audio_mode", AUDIO_MODE_NATIVE)
    if audio_mode not in AUDIO_MODES:
        raise PreparationError(
            "audio_modeが不正です。",
            {"audio_mode": audio_mode, "allowed": list(AUDIO_MODES)},
        )

    drop_roles: set[str] = set()
    reference_count = 0
    uploads: list[dict[str, Any]] = []
    input_refs: list[dict[str, Any]] = []
    slots = workflow_module.upload_slots(template_name)

    async def take(variable: str, raw: Any, label: str, kinds: tuple[str, ...]) -> None:
        source = await sources.resolve(
            raw,
            label=label,
            lookup=context.artifact_lookup,
            artifact_kinds=kinds,
        )
        node_id, input_key = slots[variable]
        remaining[variable] = source.file_name
        uploads.append(
            {
                "variable": variable,
                "node_id": node_id,
                "input_key": input_key,
                "source": source.kind,
                "relative_path": source.relative_path,
                "sha256": source.sha256,
                "file_name": source.file_name,
                "artifact_id": source.artifact_id,
            }
        )
        input_refs.append(sources.reference(source, label))

    if template_name == REF2V_TEMPLATE:
        references = remaining.pop("references", None)
        if not isinstance(references, list) or not references:
            raise PreparationError("参照画像を1枚以上指定します。")
        if not MIN_REFERENCE_IMAGES <= len(references) <= MAX_REFERENCE_IMAGES:
            raise PreparationError(
                f"参照画像は{MIN_REFERENCE_IMAGES}枚以上{MAX_REFERENCE_IMAGES}枚"
                "以下で指定します。",
                {"count": len(references), "max": MAX_REFERENCE_IMAGES},
            )
        for index, raw in enumerate(references):
            await take(
                f"reference_{index}", raw, f"参照画像{index + 1}枚目", ("image",)
            )
        reference_count = len(references)
        drop_roles.update(
            f"reference_{index}"
            for index in range(len(references), MAX_REFERENCE_IMAGES)
        )
    else:
        first_frame = remaining.pop("first_frame", None)
        if first_frame is None:
            raise PreparationError("first_frameに開始フレームの画像を指定します。")
        await take("first_frame", first_frame, "開始フレーム", ("image",))

    guide_audio = remaining.pop("guide_audio", None)
    guide_frame_idx = remaining.pop("guide_frame_idx", 0)
    if audio_mode == AUDIO_MODE_EXTERNAL_VOICE:
        if guide_audio is None:
            raise PreparationError(
                "audio_modeがexternal_voiceのときはguide_audioが必要です。"
            )
        if (
            isinstance(guide_frame_idx, bool)
            or not isinstance(guide_frame_idx, int)
            or not 0 <= guide_frame_idx < length
        ):
            raise PreparationError(
                "guide_frame_idxは0以上、length未満で指定します。",
                {"guide_frame_idx": guide_frame_idx, "length": length},
            )
        await take("guide_audio", guide_audio, "ガイド音声", ("audio",))
        remaining["guide_frame_idx"] = guide_frame_idx
    else:
        if guide_audio is not None:
            raise PreparationError(
                "guide_audioはaudio_modeがexternal_voiceのときだけ指定できます。"
            )
        drop_roles.update({"guide_audio", "add_guide"})
        if audio_mode == AUDIO_MODE_SILENT:
            drop_roles.add("audio_decode")

    return _MediaPlan(
        values=remaining,
        drop_roles=frozenset(drop_roles),
        uploads=uploads,
        input_refs=input_refs,
        parameters={
            "audio_mode": audio_mode,
            # 参照画像の枚数だけを数える。開始フレームとガイド音声はここに含めない。
            "reference_count": reference_count,
        },
        resolved_extras={"audio_mode": audio_mode},
    )


def _music_plan(values: dict[str, Any]) -> _MediaPlan:
    """音楽Jobの投入前検証。尺だけを見る。"""
    seconds = values.get("seconds")
    if isinstance(seconds, bool) or not isinstance(seconds, int | float):
        raise PreparationError("secondsは数値で指定します。")
    if seconds <= 0:
        raise PreparationError("secondsは0より大きい値で指定します。")
    return _MediaPlan(values=dict(values), parameters={"duration_sec": float(seconds)})


async def _media_plan(
    recipe: Recipe,
    template_name: str,
    values: dict[str, Any],
    context: PreparationContext,
) -> _MediaPlan:
    if recipe.kind == KIND_IMAGE:
        return await _image_plan(template_name, values, context)
    if recipe.kind == KIND_VIDEO:
        return await _video_plan(template_name, values, context)
    if recipe.kind == KIND_MUSIC:
        return _music_plan(values)
    return _MediaPlan(values=dict(values))


async def prepare(
    recipe: Recipe, inputs: dict[str, Any], context: PreparationContext
) -> PreparedExecution:
    """Recipeの既定値と要求の`inputs`をマージし、投入用Workflowを組み立てる。

    `context`はScene/Shot本文とArtifactの参照元を持つ。画像Jobでは使わないが、動画Job
    は参照画像とガイド音声をArtifactから解決するため受け取る。
    """
    template_name = resolve_template_name(recipe)
    defaults = recipe.defaults if isinstance(recipe.defaults, dict) else {}
    values: dict[str, Any] = {**defaults, **inputs}
    validate_against_input_schema(recipe, template_name, inputs, values)
    plan = await _media_plan(recipe, template_name, values, context)
    try:
        prepared = workflow_module.build_workflow(
            template_name, plan.values, drop_roles=plan.drop_roles
        )
    except workflow_module.WorkflowError as error:
        raise PreparationError(str(error), {"template": template_name}) from error
    return PreparedExecution(
        snapshot=prepared.workflow,
        seed=prepared.seed,
        resolved_prompt=prepared.resolved_prompt,
        model=dict(prepared.model),
        parameters={
            **prepared.parameters,
            **plan.parameters,
            "workflow_template": prepared.template_name,
            "workflow_template_sha256": prepared.template_sha256,
            # 投入直前にComfyUIのinputへアップロードし、返ったファイル名へ差し替える
            # 素材。スナップショットには取り込み前のファイル名が入っている。
            "input_uploads": plan.uploads,
        },
        input_refs=plan.input_refs,
        parent_job_id=plan.parent_job_id,
        parent_artifact_id=plan.parent_artifact_id,
        resolved_inputs={**prepared.resolved_values, **plan.resolved_extras},
    )
