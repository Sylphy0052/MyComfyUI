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
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from mycomfyui_api import schemas
from mycomfyui_api.adapters.comfyui import workflow as workflow_module
from mycomfyui_api.adapters.comfyui.executor import ENGINE_COMFYUI
from mycomfyui_api.models import Recipe

logger = logging.getLogger(__name__)

DEFAULT_RECIPE_NAME = "Anima 標準(txt2img)"
DEFAULT_TEMPLATE_NAME = "anima_txt2img"

#: 画面へ出す入力欄の定義。`label`と`control`はUIの表示用で、検証には使わない。
DEFAULT_INPUT_SCHEMA: dict[str, Any] = {
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
    "steps": {"type": "integer", "label": "ステップ数", "control": "number"},
    "cfg": {"type": "number", "label": "CFG", "control": "number"},
    "seed": {
        "type": "integer",
        "label": "seed",
        "control": "number",
        "help": "-1で自動採番する。",
    },
}

#: モデルファイル名と出力名は利用者に選ばせず、ここで固定する。
DEFAULT_VALUES: dict[str, Any] = {
    "unet_name": "chosenMixAnima_v10.safetensors",
    "clip_name": "qwen_3_06b_base.safetensors",
    "vae_name": "qwen_image_vae.safetensors",
    "filename_prefix": "mycomfyui",
    "negative_prompt": "",
    "width": 832,
    "height": 1216,
    "steps": 30,
    "cfg": 4.0,
    "seed": workflow_module.AUTO_SEED,
}


async def ensure_default_recipes(session: AsyncSession) -> Recipe | None:
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
        if isinstance(reference, dict) and reference.get("sha256") == digest:
            return None

    # `existing`は作成日時の降順のため、先頭が直近の版になる。後継はそこへ結ぶ。
    recipe = Recipe(
        id=schemas.new_id(),
        name=DEFAULT_RECIPE_NAME,
        kind="image",
        engine=ENGINE_COMFYUI,
        workflow_template_ref={"name": DEFAULT_TEMPLATE_NAME, "sha256": digest},
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
