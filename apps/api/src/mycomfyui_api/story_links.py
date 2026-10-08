"""生成物とWebUI v2のキャラクター・衣装・シーンの紐づけ、採用の共通処理 (#530)。

旧UIの`assigned_*`(ProjectScene・ProjectShot)とは別の列で持つ。Issueと設計文書の
`outfit_id`は、#529の命名に揃えて`costume`と呼ぶ。
"""

from collections.abc import Sequence
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette import status

from mycomfyui_api import schemas
from mycomfyui_api.errors import ApiError
from mycomfyui_api.models import (
    Artifact,
    GenerationJob,
    Project,
    Recipe,
    StoryCharacter,
    StoryCostume,
    StoryScene,
    StorySceneAdoption,
)

#: BGMを作るWorkflowテンプレート名。音声とBGMの判定はこの定数と
#: `audio_class_of_recipe`だけで行う。
BGM_TEMPLATE_NAMES = frozenset({"ace_step_bgm"})

#: IN句に渡すIDの上限。SQLiteのbind parameter上限に当たらない大きさで分ける。
_LOOKUP_CHUNK = 500

#: 生成物の紐づけ列。Jobから生成物へ同じ名前で引き継ぐ。
LINK_FIELDS = ("story_character_id", "story_costume_id", "story_scene_id")


def audio_class_of_recipe(
    recipe_kind: str, template_ref: Any
) -> schemas.ArtifactAudioClass | None:
    """Recipeから、そのJobが作る音声の種類を決める。音声とBGMの判定はここだけで行う。

    BGMはテンプレート名(`ace_step_bgm`)か、Recipeの種別`music`で判定する。台詞の
    音声は種別`voice`である。どちらでもないRecipeは音声を作らないためNoneを返す。
    """
    name = template_ref.get("name") if isinstance(template_ref, dict) else None
    if name in BGM_TEMPLATE_NAMES or recipe_kind == "music":
        return "bgm"
    if recipe_kind == "voice":
        return "voice"
    return None


async def audio_classes(
    session: AsyncSession, artifacts: Sequence[Artifact]
) -> dict[str, schemas.ArtifactAudioClass | None]:
    """音声Artifactごとに音声の種類を引く。Jobを持たない音声はNoneになる。"""
    ids = [a.id for a in artifacts if a.kind == "audio" and a.job_id is not None]
    classes: dict[str, schemas.ArtifactAudioClass | None] = {}
    for start in range(0, len(ids), _LOOKUP_CHUNK):
        rows = await session.execute(
            select(Artifact.id, Recipe.kind, Recipe.workflow_template_ref)
            .join(GenerationJob, GenerationJob.id == Artifact.job_id)
            .join(Recipe, Recipe.id == GenerationJob.recipe_id)
            .where(Artifact.id.in_(ids[start : start + _LOOKUP_CHUNK]))
        )
        for artifact_id, recipe_kind, template_ref in rows:
            classes[artifact_id] = audio_class_of_recipe(recipe_kind, template_ref)
    return classes


async def recipe_ids_of_audio_class(
    session: AsyncSession, audio_class: schemas.ArtifactAudioClass
) -> list[str]:
    """指定した種類の音声を作るRecipeのIDを返す。一覧の絞り込みに使う。"""
    rows = await session.execute(
        select(Recipe.id, Recipe.kind, Recipe.workflow_template_ref)
    )
    return [
        recipe_id
        for recipe_id, kind, template_ref in rows
        if audio_class_of_recipe(kind, template_ref) == audio_class
    ]


def job_story_links(job: GenerationJob | None) -> dict[str, str | None]:
    """Jobの紐づけを、Jobから生まれた生成物へ引き継ぐ値として返す。"""
    return {field: getattr(job, field, None) for field in LINK_FIELDS}


def _unprocessable(code: str, message: str, details: dict[str, Any]) -> ApiError:
    return ApiError(
        code,
        message,
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        details=details,
    )


async def validate_story_links(
    session: AsyncSession,
    *,
    character_id: str | None,
    costume_id: str | None,
    scene_id: str | None,
    project_id: str | None = None,
) -> None:
    """紐づけ先が存在し、互いに矛盾しないことを確かめる。

    衣装はキャラクターのものに限る。キャラクターとシーンは同じProjectに属し、
    `project_id`を渡したときはそのProjectとも一致させる。ゴミ箱のProjectへは紐づけない。
    """
    character = None
    if character_id is not None:
        character = await session.get(StoryCharacter, character_id)
        if character is None:
            raise _unprocessable(
                "STORY_CHARACTER_NOT_FOUND",
                "紐づけ先のキャラクターがありません。",
                {"story_character_id": character_id},
            )
    if costume_id is not None:
        costume = await session.get(StoryCostume, costume_id)
        if costume is None:
            raise _unprocessable(
                "STORY_COSTUME_NOT_FOUND",
                "紐づけ先の衣装がありません。",
                {"story_costume_id": costume_id},
            )
        if character_id is None:
            raise _unprocessable(
                "STORY_COSTUME_REQUIRES_CHARACTER",
                "衣装を紐づけるにはキャラクターも指定してください。",
                {"story_costume_id": costume_id},
            )
        if costume.character_id != character_id:
            raise _unprocessable(
                "STORY_COSTUME_CHARACTER_MISMATCH",
                "衣装は紐づけるキャラクターのものだけを指定できます。",
                {
                    "story_character_id": character_id,
                    "story_costume_id": costume_id,
                },
            )
    scene = None
    if scene_id is not None:
        scene = await session.get(StoryScene, scene_id)
        if scene is None:
            raise _unprocessable(
                "STORY_SCENE_NOT_FOUND",
                "紐づけ先のシーンがありません。",
                {"story_scene_id": scene_id},
            )
    project_ids = {
        owner
        for owner in (
            project_id,
            character.project_id if character else None,
            scene.project_id if scene else None,
        )
        if owner is not None
    }
    if len(project_ids) > 1:
        raise _unprocessable(
            "STORY_LINK_PROJECT_MISMATCH",
            "キャラクター・シーン・生成先Projectが同じProjectではありません。",
            {
                "project_id": project_id,
                "story_character_id": character_id,
                "story_scene_id": scene_id,
            },
        )
    for owner in project_ids:
        project = await session.get(Project, owner)
        if project is not None and project.lifecycle == "trashed":
            raise ApiError(
                "PROJECT_TRASHED",
                "ゴミ箱のProjectは復元してから更新してください。",
                status_code=status.HTTP_409_CONFLICT,
                details={"project_id": owner},
            )


async def revert_adoption_decisions(
    session: AsyncSession, artifact_ids: set[str]
) -> None:
    """採用から外れた生成物のうち、他の枠でも採用されていないものを`undecided`へ戻す。

    採用で`accepted`になったものだけを戻す。利用者が付けた`rejected`は変えない。
    """
    if not artifact_ids:
        return
    ids = sorted(artifact_ids)
    still = set(
        await session.scalars(
            select(StorySceneAdoption.artifact_id).where(
                StorySceneAdoption.artifact_id.in_(ids)
            )
        )
    )
    for artifact in await session.scalars(
        select(Artifact).where(Artifact.id.in_([i for i in ids if i not in still]))
    ):
        if artifact.decision == "accepted":
            artifact.decision = "undecided"
            artifact.decision_at = None


async def release_adoptions(session: AsyncSession, *conditions: Any) -> int:
    """条件に合う採用を外し、外れた生成物の採否を戻す。外した件数を返す。"""
    rows = list(
        await session.scalars(select(StorySceneAdoption).where(*conditions))
    )
    if not rows:
        return 0
    artifact_ids = {row.artifact_id for row in rows}
    for row in rows:
        await session.delete(row)
    await session.flush()
    await revert_adoption_decisions(session, artifact_ids)
    return len(rows)
