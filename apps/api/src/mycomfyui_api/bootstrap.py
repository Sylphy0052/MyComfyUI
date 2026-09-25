"""起動時に用意する既定データ。

UIがRecipeを選ぶだけで画像生成を始められるよう、同梱Workflowテンプレートに対応する
Recipeを初回起動時に登録する。Recipeは作成後に書き換えない設計のため、テンプレートの
内容が変わったときは既存Recipeを更新せず、後継Recipeを追加する。

`input_schema`にはUIへ見せる変数だけを並べる。モデルファイル名は`defaults`へ固定し、
通常操作では指定も表示もしない。

存在確認と登録の間にロックは取らない。Application APIはGPUジョブを直列実行する
JobQueueWorkerを内包しており、もともと複数プロセス・複数workerでの起動に対応しない。
同時起動しない前提を崩さない限り、重複登録は起きない。
"""

import logging
from collections.abc import Mapping
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from mycomfyui_api import schemas
from mycomfyui_api.adapters.agent import proposals as agent_proposals
from mycomfyui_api.adapters.comfyui import prepare as comfyui_prepare
from mycomfyui_api.adapters.comfyui import workflow as workflow_module
from mycomfyui_api.adapters.comfyui.executor import ENGINE_COMFYUI
from mycomfyui_api.adapters.compose import plan as compose_plan
from mycomfyui_api.adapters.voice import plan as voice_plan
from mycomfyui_api.adapters.voice.base import (
    ENGINE_COSYVOICE3,
    ENGINE_QWEN3_TTS,
    ENGINE_VOXCPM2,
)
from mycomfyui_api.models import Recipe, WorkflowVersion
from mycomfyui_api.workflows import VOICE_TEMPLATE_NAME

logger = logging.getLogger(__name__)

DEFAULT_RECIPE_NAME = "Anima 標準(txt2img)"
DEFAULT_TEMPLATE_NAME = "anima_txt2img"

#: 画面へ出す入力欄の定義。`label`と`control`はUIの表示用で、検証には使わない。
DEFAULT_INPUT_SCHEMA: dict[str, Any] = {
    "unet_name": {
        "type": "string",
        "label": "生成モデル",
        "control": "model",
    },
    "clip_name": {
        "type": "string",
        "label": "テキストエンコーダ",
        "control": "model",
    },
    "vae_name": {
        "type": "string",
        "label": "VAE",
        "control": "model",
    },
    "positive_prompt": {
        "type": "string",
        "required": True,
        "label": "プロンプト",
        "control": "textarea",
    },
    "negative_prompt": {
        "type": "string",
        "label": "除外したい要素",
        "control": "textarea",
    },
    "width": {"type": "integer", "label": "幅", "control": "number"},
    "height": {"type": "integer", "label": "高さ", "control": "number"},
    "batch_size": {
        "type": "integer",
        "label": "バッチサイズ",
        "control": "number",
        "help": "1回のJobで生成する枚数。",
    },
    "steps": {"type": "integer", "label": "ステップ数", "control": "number"},
    "cfg": {"type": "number", "label": "CFG", "control": "number"},
    "seed": {
        "type": "integer",
        "label": "seed",
        "control": "number",
        "help": "-1で自動採番する。",
    },
    # hires fix (Issue #318)。画面はhires_enabledがオンのときだけ残りを出す。
    "hires_enabled": {
        "type": "boolean",
        "label": "hires fix",
        "control": "checkbox",
        "help": "生成した画像を拡大し、2段目のサンプリングで描き込み直す。",
    },
    "hires_scale": {"type": "number", "label": "拡大倍率", "control": "number"},
    "hires_upscale_method": {
        "type": "string",
        "label": "拡大方式",
        "control": "select",
        "options": list(workflow_module.LATENT_UPSCALE_METHODS),
    },
    "hires_steps": {
        "type": "integer",
        "label": "hires steps",
        "control": "number",
        "help": "0で1段目のステップ数と同じにする。",
    },
    "hires_denoise": {"type": "number", "label": "denoise", "control": "number"},
}

#: モデルファイル名は既定値として保持し、画面ではComfyUI在庫から選択する。
DEFAULT_VALUES: dict[str, Any] = {
    "unet_name": "chosenMixAnima_v10.safetensors",
    "clip_name": "qwen_3_06b_base.safetensors",
    "vae_name": "qwen_image_vae.safetensors",
    "filename_prefix": "mycomfyui",
    #: Qwen-Image(Anima)公式のbaseline。prompt案の追加分はここへ足して使う。
    "negative_prompt": agent_proposals.DEFAULT_NEGATIVE_PROMPT,
    "width": 832,
    "height": 1216,
    "batch_size": 1,
    "steps": 30,
    "cfg": 4.0,
    "seed": workflow_module.AUTO_SEED,
    "hires_enabled": False,
    "hires_scale": 2.0,
    "hires_upscale_method": "nearest-exact",
    "hires_steps": 0,
    "hires_denoise": 0.5,
}


async def ensure_default_recipes(
    session: AsyncSession, versions: Mapping[str, WorkflowVersion]
) -> Recipe | None:
    """既定Recipeが無ければ作る。テンプレートが更新されていれば後継を作る。

    作成したRecipeを返す。何も作らなかった場合はNoneを返す。
    """
    digest = workflow_module.template_digest(DEFAULT_TEMPLATE_NAME)
    result = await session.execute(
        select(Recipe)
        .where(Recipe.name == DEFAULT_RECIPE_NAME)
        .order_by(Recipe.created_at.desc(), Recipe.id.asc())
    )
    existing = result.scalars().all()
    for recipe in existing:
        reference = recipe.workflow_template_ref
        if (
            isinstance(reference, dict)
            and reference.get("sha256") == digest
            and recipe.input_schema == DEFAULT_INPUT_SCHEMA
        ):
            return None

    # `existing`は作成日時の降順のため、先頭が直近の版になる。後継はそこへ結ぶ。
    recipe = Recipe(
        id=schemas.new_id(),
        name=DEFAULT_RECIPE_NAME,
        kind="image",
        engine=ENGINE_COMFYUI,
        workflow_template_ref={"name": DEFAULT_TEMPLATE_NAME, "sha256": digest},
        workflow_version_id=_version_id(versions, DEFAULT_TEMPLATE_NAME),
        input_schema=dict(DEFAULT_INPUT_SCHEMA),
        defaults=dict(DEFAULT_VALUES),
        # テンプレート更新時は既存Recipeを書き換えず、後継として並べる。
        supersedes_recipe_id=existing[0].id if existing else None,
        created_at=schemas.now_iso(),
    )
    session.add(recipe)
    await session.commit()
    logger.info("既定Recipeを登録しました。recipe_id=%s", recipe.id)
    return recipe


#: 画面へ出す入力欄の定義。参照音声の取り込みとVoice Canonの選択は画面が組み立てる。
VOICE_INPUT_SCHEMA: dict[str, Any] = {
    "dialogue": {
        "type": "array",
        "required": False,
        "label": "台詞",
        "control": "dialogue",
        "help": "未所属で生成するときに読む台詞を指定する。",
    },
    "duration_sec": {
        "type": "number",
        "required": False,
        "label": "目標尺（秒）",
        "control": "number",
    },
    "voices": {
        "type": "object",
        "required": True,
        "label": "Voice Canonと参照音声",
        "control": "voices",
        "help": (
            "台詞のvoice_idごとに、Voice Canonと取り込んだ参照音声を指定する。"
            "未所属で生成するときはVoice Canonを指定しない。"
        ),
    },
    "profile": {"type": "string", "label": "プロファイル", "control": "text"},
    "language": {"type": "string", "label": "言語", "control": "text"},
    "seed": {
        "type": "integer",
        "label": "seed",
        "control": "number",
        "help": "-1で自動採番する。同じseedなら波形が再現する。",
    },
    "verify_with_asr": {
        "type": "boolean",
        "label": "ASRで読みを検証する",
        "control": "checkbox",
    },
    "pad_to_duration": {
        "type": "boolean",
        "label": "Shotの尺へ無音パディングする",
        "control": "checkbox",
    },
}

VOICE_DEFAULTS: dict[str, Any] = {
    "profile": "default",
    "language": "ja",
    "seed": voice_plan.AUTO_SEED,
    "verify_with_asr": True,
    "pad_to_duration": True,
}

#: 既定で登録する音声Recipe。採否の根拠は`ai-media/検証_tts/05_tts比較/REPORT.md`。
VOICE_RECIPES: tuple[tuple[str, str], ...] = (
    ("音声 Qwen3-TTS (Primary)", ENGINE_QWEN3_TTS),
    ("音声 VoxCPM2 (Secondary)", ENGINE_VOXCPM2),
    ("音声 CosyVoice3 (比較用)", ENGINE_COSYVOICE3),
)


async def ensure_voice_recipes(
    session: AsyncSession, versions: Mapping[str, WorkflowVersion]
) -> list[Recipe]:
    """音声Backendごとの既定Recipeを登録する。

    スナップショットの形が変わったときは既存Recipeを書き換えず、後継Recipeを追加
    する。判定にはWorkflowテンプレートのSHA-256ではなくスナップショットの版を使う。
    音声Backendにはテンプレートファイルが無いためである。
    """
    created: list[Recipe] = []
    for name, engine in VOICE_RECIPES:
        result = await session.execute(
            select(Recipe)
            .where(Recipe.name == name)
            .order_by(Recipe.created_at.desc(), Recipe.id.asc())
        )
        existing = result.scalars().all()
        if any(
            isinstance(recipe.workflow_template_ref, dict)
            and recipe.workflow_template_ref.get("version")
            == voice_plan.SNAPSHOT_VERSION
            for recipe in existing
        ):
            continue
        recipe = Recipe(
            id=schemas.new_id(),
            name=name,
            kind="voice",
            engine=engine,
            workflow_template_ref={
                "name": VOICE_TEMPLATE_NAME,
                "version": voice_plan.SNAPSHOT_VERSION,
            },
            workflow_version_id=_version_id(versions, VOICE_TEMPLATE_NAME),
            input_schema=dict(VOICE_INPUT_SCHEMA),
            defaults=dict(VOICE_DEFAULTS),
            supersedes_recipe_id=existing[0].id if existing else None,
            created_at=schemas.now_iso(),
        )
        session.add(recipe)
        created.append(recipe)
    if created:
        await session.commit()
        logger.info("音声Recipeを%d件登録しました。", len(created))
    return created


#: 動画・音楽のモデルファイル名。出典は`ai-media/config/local-tools.yaml`。
H3_MODELS: dict[str, str] = {
    "clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    "video_vae_name": "minimax_h3_video_vae_fp16.safetensors",
    "audio_vae_name": "minimax_h3_audio_vae_fp32.safetensors",
}
H3_REF2V_UNET = "minimax_h3_ref2va_pruned_int8_convrot.safetensors"
H3_I2V_UNET = "minimax_h3_fl2va_pruned_int8_convrot.safetensors"
ACE_STEP_CHECKPOINT = "ace_step_v1_3.5b.safetensors"

IMAGE_IMG2IMG_RECIPE_NAME = "Anima img2img"
IMAGE_INPAINT_RECIPE_NAME = "Anima inpaint"
IMAGE_UPSCALE_RECIPE_NAME = "画像アップスケール"
IMAGE_CONTROLNET_RECIPE_NAME = "SD1.5 参照画像制御(ControlNet)"
# apps/web/src/derivation/changeOperations.ts の CHANGE_TEMPLATE_RECIPE_LABELS と名称を揃える。
IMAGE_REF_SIGLIP_RECIPE_NAME = "Anima 参照 ポーズ・表情"
IMAGE_REF_INCONTEXT_RECIPE_NAME = "Anima 参照 衣装"

_IMAGE_MODEL_SCHEMA: dict[str, Any] = {
    name: dict(DEFAULT_INPUT_SCHEMA[name])
    for name in ("unet_name", "clip_name", "vae_name")
}
_IMAGE_DERIVATION_SCHEMA: dict[str, Any] = {
    **_IMAGE_MODEL_SCHEMA,
    "source_image": {
        "type": "object",
        "required": True,
        "label": "派生元画像",
        "control": "artifact",
    },
    "positive_prompt": dict(DEFAULT_INPUT_SCHEMA["positive_prompt"]),
    "negative_prompt": dict(DEFAULT_INPUT_SCHEMA["negative_prompt"]),
    "steps": dict(DEFAULT_INPUT_SCHEMA["steps"]),
    "cfg": dict(DEFAULT_INPUT_SCHEMA["cfg"]),
    "denoise": {
        "type": "number",
        "label": "denoise",
        "control": "number",
        "help": "0で元画像を維持し、1に近いほど大きく変更する。",
    },
    "seed": dict(DEFAULT_INPUT_SCHEMA["seed"]),
}

IMAGE_IMG2IMG_SCHEMA = dict(_IMAGE_DERIVATION_SCHEMA)
_IMAGE_DERIVATION_DEFAULTS: dict[str, Any] = {
    name: DEFAULT_VALUES[name]
    for name in (
        "unet_name",
        "clip_name",
        "vae_name",
        "filename_prefix",
        "negative_prompt",
        "steps",
        "cfg",
        "seed",
    )
}
IMAGE_IMG2IMG_DEFAULTS: dict[str, Any] = {
    **_IMAGE_DERIVATION_DEFAULTS,
    "denoise": 0.65,
}

IMAGE_INPAINT_SCHEMA: dict[str, Any] = {
    **_IMAGE_DERIVATION_SCHEMA,
    "mask_image": {
        "type": "object",
        "required": True,
        "label": "mask画像",
        "control": "artifact",
        "help": "赤channelを修正範囲として使う。",
    },
    "grow_mask_by": {
        "type": "integer",
        "label": "mask拡張(px)",
        "control": "number",
    },
}
IMAGE_INPAINT_DEFAULTS: dict[str, Any] = {
    **_IMAGE_DERIVATION_DEFAULTS,
    "denoise": 1.0,
    "grow_mask_by": 6,
}

IMAGE_UPSCALE_SCHEMA: dict[str, Any] = {
    "source_image": {
        "type": "object",
        "required": True,
        "label": "派生元画像",
        "control": "artifact",
    },
    "upscale_model_name": {
        "type": "string",
        "label": "アップスケールモデル",
        "control": "model",
    },
}
IMAGE_UPSCALE_DEFAULTS: dict[str, Any] = {
    "upscale_model_name": "4x-UltraSharp.pth",
    "filename_prefix": "mycomfyui",
}

IMAGE_CONTROLNET_SCHEMA: dict[str, Any] = {
    "checkpoint_name": {
        "type": "string",
        "label": "Checkpoint",
        "control": "model",
    },
    "source_image": {
        "type": "object",
        "required": True,
        "label": "制御画像",
        "control": "artifact",
    },
    "control_net_name": {
        "type": "string",
        "label": "ControlNetモデル",
        "control": "model",
    },
    "positive_prompt": dict(DEFAULT_INPUT_SCHEMA["positive_prompt"]),
    "negative_prompt": dict(DEFAULT_INPUT_SCHEMA["negative_prompt"]),
    "width": dict(DEFAULT_INPUT_SCHEMA["width"]),
    "height": dict(DEFAULT_INPUT_SCHEMA["height"]),
    "batch_size": dict(DEFAULT_INPUT_SCHEMA["batch_size"]),
    "steps": dict(DEFAULT_INPUT_SCHEMA["steps"]),
    "cfg": dict(DEFAULT_INPUT_SCHEMA["cfg"]),
    "denoise": {
        "type": "number",
        "label": "denoise",
        "control": "number",
    },
    "seed": dict(DEFAULT_INPUT_SCHEMA["seed"]),
    "control_strength": {
        "type": "number",
        "label": "制御強度",
        "control": "number",
    },
    "control_start": {
        "type": "number",
        "label": "制御開始",
        "control": "number",
    },
    "control_end": {
        "type": "number",
        "label": "制御終了",
        "control": "number",
    },
    "canny_low": {
        "type": "number",
        "label": "Canny下限",
        "control": "number",
    },
    "canny_high": {
        "type": "number",
        "label": "Canny上限",
        "control": "number",
    },
}
IMAGE_CONTROLNET_DEFAULTS: dict[str, Any] = {
    "checkpoint_name": "v1-5-pruned-emaonly.safetensors",
    "filename_prefix": "mycomfyui",
    "negative_prompt": "",
    "width": 512,
    "height": 768,
    "batch_size": 1,
    "steps": 30,
    "cfg": 7.0,
    "seed": workflow_module.AUTO_SEED,
    "denoise": 1.0,
    "control_net_name": "control_v11p_sd15_canny_fp16.safetensors",
    "control_strength": 0.8,
    "control_start": 0.0,
    "control_end": 1.0,
    "canny_low": 0.4,
    "canny_high": 0.8,
}

#: img2imgではなくtxt2imgに元画像を参照として注入する派生(Issue #159)の共通入力欄。
#: denoise/mask/controlnetの語を持たず、代わりに参照の強さを「参照強度」として出す。
_IMAGE_REF_SCHEMA: dict[str, Any] = {
    **_IMAGE_MODEL_SCHEMA,
    "source_image": {
        "type": "object",
        "required": True,
        "label": "元画像",
        "control": "artifact",
    },
    "positive_prompt": dict(DEFAULT_INPUT_SCHEMA["positive_prompt"]),
    "negative_prompt": dict(DEFAULT_INPUT_SCHEMA["negative_prompt"]),
    "reference_strength": {
        "type": "number",
        "label": "参照強度",
        "control": "number",
        "help": "元画像をどれだけ強く反映するか。0〜2の範囲。",
    },
    "width": dict(DEFAULT_INPUT_SCHEMA["width"]),
    "height": dict(DEFAULT_INPUT_SCHEMA["height"]),
    "steps": dict(DEFAULT_INPUT_SCHEMA["steps"]),
    "cfg": dict(DEFAULT_INPUT_SCHEMA["cfg"]),
    "seed": dict(DEFAULT_INPUT_SCHEMA["seed"]),
}
_IMAGE_REF_DEFAULTS: dict[str, Any] = {
    "unet_name": DEFAULT_VALUES["unet_name"],
    "clip_name": DEFAULT_VALUES["clip_name"],
    "vae_name": DEFAULT_VALUES["vae_name"],
    "filename_prefix": DEFAULT_VALUES["filename_prefix"],
    "negative_prompt": DEFAULT_VALUES["negative_prompt"],
    "width": 896,
    "height": 1344,
    "steps": 30,
    "cfg": 4.5,
    "sampler_name": "euler_ancestral",
    "scheduler": "normal",
    "seed": workflow_module.AUTO_SEED,
}

#: SigLIP2 Character Reference(`AnimaIPAdapterLoader`)。ポーズ・表情を変えるときの既定
#: 強度は検証値(`novel-writer/検証_reference/029_final_synthesis/README.md:20-25`)に
#: 合わせて0.5とする。
IMAGE_REF_SIGLIP_SCHEMA: dict[str, Any] = {
    **_IMAGE_REF_SCHEMA,
    "ip_adapter_name": {
        "type": "string",
        "label": "IPAdapterモデル",
        "control": "model",
    },
}
IMAGE_REF_SIGLIP_DEFAULTS: dict[str, Any] = {
    **_IMAGE_REF_DEFAULTS,
    "ip_adapter_name": "ip_adapter-Character_Reference-10.safetensors",
    "reference_strength": 0.5,
}

#: Anima In-Context Character(`LoraLoaderModelOnly`+`AnimaRefEncode`+
#: `AnimaInContextApply`)。衣装だけを変えるときの既定強度は検証値に合わせて1.0とする。
IMAGE_REF_INCONTEXT_SCHEMA: dict[str, Any] = {
    **_IMAGE_REF_SCHEMA,
    "lora_name": {
        "type": "string",
        "label": "LoRAモデル",
        "control": "model",
    },
}
IMAGE_REF_INCONTEXT_DEFAULTS: dict[str, Any] = {
    **_IMAGE_REF_DEFAULTS,
    "lora_name": "anima-incontext-character.safetensors",
    "reference_strength": 1.0,
}

#: H3の共通の入力欄。参照画像と開始フレームだけがテンプレートごとに変わる。
_H3_COMMON_SCHEMA: dict[str, Any] = {
    "clip_name": {
        "type": "string",
        "label": "テキストエンコーダ",
        "control": "model",
    },
    "video_vae_name": {
        "type": "string",
        "label": "Video VAE",
        "control": "model",
    },
    "audio_vae_name": {
        "type": "string",
        "label": "Audio VAE",
        "control": "model",
    },
    "positive_prompt": {
        "type": "string",
        "required": True,
        "label": "プロンプト",
        "control": "textarea",
    },
    "length": {
        "type": "integer",
        "label": "フレーム数",
        "control": "number",
        "help": (
            f"{comfyui_prepare.FRAME_GRID_STEP}k+{comfyui_prepare.FRAME_GRID_BASE}の値"
            f"だけを受け付ける({comfyui_prepare.MIN_FRAMES}〜"
            f"{comfyui_prepare.MAX_FRAMES})。24fpsでの秒数から逆算する。"
        ),
    },
    "width": {"type": "integer", "label": "幅", "control": "number"},
    "height": {"type": "integer", "label": "高さ", "control": "number"},
    "audio_mode": {
        "type": "string",
        "label": "音声の扱い",
        "control": "select",
        "options": list(comfyui_prepare.AUDIO_MODES),
        "help": (
            "nativeはH3が音声も生成する。external_voiceは生成済みの音声をガイドとして"
            "アンカーする。silentは音声を付けない。"
        ),
    },
    "guide_audio": {
        "type": "object",
        "label": "ガイド音声",
        "control": "artifact",
        "help": "audio_modeがexternal_voiceのときだけ指定する。",
    },
    "guide_frame_idx": {
        "type": "integer",
        "label": "ガイド音声の開始フレーム",
        "control": "number",
    },
    "steps": {"type": "integer", "label": "ステップ数", "control": "number"},
    "seed": {
        "type": "integer",
        "label": "seed",
        "control": "number",
        "help": "-1で自動採番する。",
    },
}

_H3_COMMON_DEFAULTS: dict[str, Any] = {
    **H3_MODELS,
    "sampler_name": "res_multistep",
    "scheduler": "simple",
    "denoise": 1.0,
    "fps": 24.0,
    "filename_prefix": "mycomfyui",
    "length": 124,
    "steps": 20,
    "audio_mode": comfyui_prepare.AUDIO_MODE_NATIVE,
    "guide_frame_idx": 0,
    "seed": workflow_module.AUTO_SEED,
}

VIDEO_REF2V_RECIPE_NAME = "動画 MiniMax H3 (参照画像)"
VIDEO_I2V_RECIPE_NAME = "動画 MiniMax H3 (開始フレーム)"
MUSIC_RECIPE_NAME = "音楽 ACE-Step (BGM)"
COMPOSE_RECIPE_NAME = "合成 ffmpeg (動画+台詞+BGM)"

VIDEO_REF2V_INPUT_SCHEMA: dict[str, Any] = {
    "unet_name": {
        "type": "string",
        "label": "生成モデル",
        "control": "model",
    },
    "references": {
        "type": "array",
        "required": True,
        "label": "参照画像",
        "control": "artifacts",
        "help": (
            f"{comfyui_prepare.MIN_REFERENCE_IMAGES}〜"
            f"{comfyui_prepare.MAX_REFERENCE_IMAGES}枚を選ぶ。"
        ),
    },
    **_H3_COMMON_SCHEMA,
}

VIDEO_REF2V_DEFAULTS: dict[str, Any] = {
    **_H3_COMMON_DEFAULTS,
    "unet_name": H3_REF2V_UNET,
    "ref_image_size": "match",
    "width": 864,
    "height": 480,
}

VIDEO_I2V_INPUT_SCHEMA: dict[str, Any] = {
    "unet_name": {
        "type": "string",
        "label": "生成モデル",
        "control": "model",
    },
    "first_frame": {
        "type": "object",
        "required": True,
        "label": "開始フレーム",
        "control": "artifact",
    },
    **_H3_COMMON_SCHEMA,
}

VIDEO_I2V_DEFAULTS: dict[str, Any] = {
    **_H3_COMMON_DEFAULTS,
    "unet_name": H3_I2V_UNET,
    "width": 512,
    "height": 768,
}

MUSIC_INPUT_SCHEMA: dict[str, Any] = {
    "ckpt_name": {
        "type": "string",
        "label": "生成モデル",
        "control": "model",
    },
    "positive_prompt": {
        "type": "string",
        "required": True,
        "label": "曲の指定(タグ)",
        "control": "textarea",
        "help": "mood、genre、楽器、テンポをカンマ区切りで並べる。",
    },
    "negative_prompt": {
        "type": "string",
        "label": "避けたい要素",
        "control": "textarea",
    },
    "lyrics": {"type": "string", "label": "歌詞", "control": "textarea"},
    "seconds": {"type": "number", "label": "尺(秒)", "control": "number"},
    "steps": {"type": "integer", "label": "ステップ数", "control": "number"},
    "cfg": {"type": "number", "label": "CFG", "control": "number"},
    "seed": {
        "type": "integer",
        "label": "seed",
        "control": "number",
        "help": "-1で自動採番する。",
    },
}

MUSIC_DEFAULTS: dict[str, Any] = {
    "ckpt_name": ACE_STEP_CHECKPOINT,
    "negative_prompt": "vocals, singing, voice, noise, distorted",
    "lyrics": "",
    "seconds": 14.0,
    "steps": 50,
    "cfg": 5.0,
    "sampler_name": "euler",
    "scheduler": "simple",
    "denoise": 1.0,
    "filename_prefix": "mycomfyui",
    "seed": workflow_module.AUTO_SEED,
}

COMPOSE_INPUT_SCHEMA: dict[str, Any] = {
    "video": {
        "type": "object",
        "required": True,
        "label": "動画",
        "control": "artifact",
    },
    "voices": {
        "type": "array",
        "label": "台詞音声",
        "control": "audio_tracks",
        "help": "Artifactごとに開始位置(秒)と音量を指定する。",
    },
    "bgm": {
        "type": "object",
        "label": "BGM",
        "control": "audio_track",
        "help": (
            f"音量の既定値は台詞の約3分の1({compose_plan.DEFAULT_BGM_VOLUME})とする。"
        ),
    },
}

COMPOSE_DEFAULTS: dict[str, Any] = {"voices": []}

#: 同梱テンプレートを使う既定Recipe。テンプレートのSHA-256で版を判定する。
TEMPLATE_RECIPES: tuple[tuple[str, str, str, dict[str, Any], dict[str, Any]], ...] = (
    (
        IMAGE_IMG2IMG_RECIPE_NAME,
        "image",
        "anima_img2img",
        IMAGE_IMG2IMG_SCHEMA,
        IMAGE_IMG2IMG_DEFAULTS,
    ),
    (
        IMAGE_INPAINT_RECIPE_NAME,
        "image",
        "anima_inpaint",
        IMAGE_INPAINT_SCHEMA,
        IMAGE_INPAINT_DEFAULTS,
    ),
    (
        IMAGE_UPSCALE_RECIPE_NAME,
        "image",
        "image_upscale",
        IMAGE_UPSCALE_SCHEMA,
        IMAGE_UPSCALE_DEFAULTS,
    ),
    (
        IMAGE_CONTROLNET_RECIPE_NAME,
        "image",
        "sd15_controlnet",
        IMAGE_CONTROLNET_SCHEMA,
        IMAGE_CONTROLNET_DEFAULTS,
    ),
    (
        IMAGE_REF_SIGLIP_RECIPE_NAME,
        "image",
        "anima_ref_siglip",
        IMAGE_REF_SIGLIP_SCHEMA,
        IMAGE_REF_SIGLIP_DEFAULTS,
    ),
    (
        IMAGE_REF_INCONTEXT_RECIPE_NAME,
        "image",
        "anima_ref_incontext",
        IMAGE_REF_INCONTEXT_SCHEMA,
        IMAGE_REF_INCONTEXT_DEFAULTS,
    ),
    (
        VIDEO_REF2V_RECIPE_NAME,
        "video",
        "minimax_h3_ref2v",
        VIDEO_REF2V_INPUT_SCHEMA,
        VIDEO_REF2V_DEFAULTS,
    ),
    (
        VIDEO_I2V_RECIPE_NAME,
        "video",
        "minimax_h3_i2v",
        VIDEO_I2V_INPUT_SCHEMA,
        VIDEO_I2V_DEFAULTS,
    ),
    (
        MUSIC_RECIPE_NAME,
        "music",
        "ace_step_bgm",
        MUSIC_INPUT_SCHEMA,
        MUSIC_DEFAULTS,
    ),
)


async def _existing_recipes(session: AsyncSession, name: str) -> list[Recipe]:
    """同じ名前のRecipeを新しい順に返す。後継を結ぶ先の判定に使う。"""
    result = await session.execute(
        select(Recipe)
        .where(Recipe.name == name)
        .order_by(Recipe.created_at.desc(), Recipe.id.asc())
    )
    return list(result.scalars().all())


async def ensure_media_recipes(
    session: AsyncSession, versions: Mapping[str, WorkflowVersion]
) -> list[Recipe]:
    """動画・音楽・合成の既定Recipeを登録する。

    テンプレートやスナップショットの形が変わったときは既存Recipeを書き換えず、後継
    Recipeを追加する。判定はComfyUI系がテンプレートのSHA-256、合成がスナップショット
    の版による。テンプレートファイルを持たないためである。
    """
    created: list[Recipe] = []
    for name, kind, template_name, schema, defaults in TEMPLATE_RECIPES:
        digest = workflow_module.template_digest(template_name)
        existing = await _existing_recipes(session, name)
        if any(
            isinstance(recipe.workflow_template_ref, dict)
            and recipe.workflow_template_ref.get("sha256") == digest
            and recipe.input_schema == schema
            for recipe in existing
        ):
            continue
        created.append(
            _new_recipe(
                name=name,
                kind=kind,
                engine=ENGINE_COMFYUI,
                template_ref={"name": template_name, "sha256": digest},
                workflow_version_id=_version_id(versions, template_name),
                schema=schema,
                defaults=defaults,
                existing=existing,
            )
        )

    existing = await _existing_recipes(session, COMPOSE_RECIPE_NAME)
    if not any(
        isinstance(recipe.workflow_template_ref, dict)
        and recipe.workflow_template_ref.get("version") == compose_plan.SNAPSHOT_VERSION
        for recipe in existing
    ):
        created.append(
            _new_recipe(
                name=COMPOSE_RECIPE_NAME,
                kind="compose",
                engine=compose_plan.ENGINE_FFMPEG,
                template_ref={
                    "name": compose_plan.COMPOSE_TEMPLATE_NAME,
                    "version": compose_plan.SNAPSHOT_VERSION,
                },
                workflow_version_id=_version_id(
                    versions, compose_plan.COMPOSE_TEMPLATE_NAME
                ),
                schema=COMPOSE_INPUT_SCHEMA,
                defaults=COMPOSE_DEFAULTS,
                existing=existing,
            )
        )

    if created:
        for recipe in created:
            session.add(recipe)
        await session.commit()
        logger.info("動画・音楽・合成のRecipeを%d件登録しました。", len(created))
    return created


def _version_id(
    versions: Mapping[str, WorkflowVersion], workflow_name: str
) -> str | None:
    """登録済みWorkflow版のIDを引く。未登録なら`workflow_template_ref`だけで残す。"""
    version = versions.get(workflow_name)
    return None if version is None else version.id


def _new_recipe(
    *,
    name: str,
    kind: str,
    engine: str,
    template_ref: dict[str, Any],
    workflow_version_id: str | None,
    schema: dict[str, Any],
    defaults: dict[str, Any],
    existing: list[Recipe],
) -> Recipe:
    # `existing`は作成日時の降順のため、先頭が直近の版になる。後継はそこへ結ぶ。
    return Recipe(
        id=schemas.new_id(),
        name=name,
        kind=kind,
        engine=engine,
        workflow_template_ref=template_ref,
        workflow_version_id=workflow_version_id,
        input_schema=dict(schema),
        defaults=dict(defaults),
        supersedes_recipe_id=existing[0].id if existing else None,
        created_at=schemas.now_iso(),
    )
