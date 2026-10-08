"""WebUI v2のシーンごとの採用API (#530)。

シーンの枠(`scene_image` / `voice` / `bgm` / `video` / `compose`)ごとに、採用する
生成物を1つ決める。`voice`だけ台詞1行ごとに別の枠になる。採用すると生成物の採否は
`accepted`になり、外れた(置き換えられた)生成物は他の枠で採用されていなければ
`undecided`へ戻る。`rejected`は不採用の印として利用者が付けたまま残す。
既存の採否API(`PATCH /artifacts/{id}/decision`)は変えない。
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette import status

from mycomfyui_api import schemas, story_links
from mycomfyui_api.db import get_session
from mycomfyui_api.models import (
    Artifact,
    GenerationJob,
    StorySceneAdoption,
    StorySceneDialogue,
)
from mycomfyui_api.story import (
    _commit,
    _get_scene,
    _not_found,
    _require_project,
    _require_writable_project,
    _unprocessable,
)

router = APIRouter(prefix="/api/v1/projects", tags=["story"])
SessionDep = Annotated[AsyncSession, Depends(get_session)]

#: 枠ごとの生成物の種別。
_SLOT_KIND: dict[str, str] = {
    "scene_image": "image",
    "voice": "audio",
    "bgm": "audio",
    "video": "video",
    "compose": "video",
}


async def _check_slot_accepts(
    session: AsyncSession, slot: str, artifact: Artifact
) -> None:
    """生成物の種別が枠に合うことを確かめる。合わなければ422。

    音声の声とBGMはJobのRecipeで見分ける。Jobを持たない取込の音声は見分けられない
    ため、どちらの枠にも採用できる。動画も同様で、Jobを持たない動画は`video`枠にだけ
    採用でき、`compose`枠は合成Jobの出力に限る。
    """
    expected = _SLOT_KIND[slot]
    if artifact.kind != expected:
        raise _unprocessable(
            "STORY_ADOPTION_KIND_MISMATCH",
            f"{slot}枠には{expected}の生成物だけ採用できます。",
            {"slot": slot, "kind": artifact.kind, "expected": expected},
        )
    if expected == "audio":
        audio_class = (await story_links.audio_classes(session, [artifact])).get(
            artifact.id
        )
        wanted = "voice" if slot == "voice" else "bgm"
        if audio_class is not None and audio_class != wanted:
            raise _unprocessable(
                "STORY_ADOPTION_KIND_MISMATCH",
                f"{slot}枠には{wanted}の音声だけ採用できます。",
                {"slot": slot, "audio_class": audio_class, "expected": wanted},
            )
    elif expected == "video":
        job_kind = (
            await session.scalar(
                select(GenerationJob.kind).where(GenerationJob.id == artifact.job_id)
            )
            if artifact.job_id is not None
            else None
        )
        if (slot == "compose" and job_kind != "compose") or (
            slot == "video" and job_kind == "compose"
        ):
            raise _unprocessable(
                "STORY_ADOPTION_KIND_MISMATCH",
                "compose枠には合成Jobの動画だけ、video枠には合成以外の動画だけ"
                "採用できます。",
                {"slot": slot, "job_kind": job_kind},
            )


async def _find_adoption(
    session: AsyncSession, scene_id: str, slot: str, dialogue_id: str | None
) -> StorySceneAdoption | None:
    query = select(StorySceneAdoption).where(
        StorySceneAdoption.scene_id == scene_id, StorySceneAdoption.slot == slot
    )
    if dialogue_id is None:
        query = query.where(StorySceneAdoption.dialogue_id.is_(None))
    else:
        query = query.where(StorySceneAdoption.dialogue_id == dialogue_id)
    return await session.scalar(query)


async def _require_dialogue_for_slot(
    session: AsyncSession, scene_id: str, slot: str, dialogue_id: str | None
) -> None:
    """`voice`枠は台詞(このシーンのもの)の指定が必須で、他の枠は指定できない。"""
    if slot != "voice":
        if dialogue_id is not None:
            raise _unprocessable(
                "STORY_ADOPTION_DIALOGUE_NOT_ALLOWED",
                "dialogue_idを指定できるのはvoice枠だけです。",
                {"slot": slot},
            )
        return
    if dialogue_id is None:
        raise _unprocessable(
            "STORY_ADOPTION_DIALOGUE_REQUIRED",
            "voice枠には台詞のdialogue_idが必要です。",
            {"slot": slot},
        )
    owner = await session.scalar(
        select(StorySceneDialogue.scene_id).where(StorySceneDialogue.id == dialogue_id)
    )
    if owner != scene_id:
        raise _unprocessable(
            "STORY_DIALOGUE_NOT_IN_SCENE",
            "このシーンに無い台詞は指定できません。",
            {"dialogue_id": dialogue_id},
        )


@router.get(
    "/{project_id}/story-scenes/{scene_id}/adoptions",
    response_model=list[schemas.StorySceneAdoptionRead],
)
async def list_story_scene_adoptions(
    project_id: schemas.AiMediaId,
    scene_id: schemas.ResourceId,
    session: SessionDep,
):
    """シーンの採用を一覧する。枠ごとに1件(`voice`は台詞ごとに1件)。"""
    await _require_project(session, project_id)
    await _get_scene(session, project_id, scene_id)
    rows = await session.scalars(
        select(StorySceneAdoption)
        .where(StorySceneAdoption.scene_id == scene_id)
        .order_by(StorySceneAdoption.created_at, StorySceneAdoption.id)
    )
    return list(rows)


@router.put(
    "/{project_id}/story-scenes/{scene_id}/adoptions/{slot}",
    response_model=schemas.StorySceneAdoptionRead,
)
async def adopt_story_scene_artifact(
    project_id: schemas.AiMediaId,
    scene_id: schemas.ResourceId,
    slot: schemas.StoryAdoptionSlot,
    payload: schemas.StorySceneAdoptionPut,
    session: SessionDep,
):
    """枠へ生成物を採用する。その枠の前の採用は置き換わり、前の生成物は外れる。

    同じ生成物を再度指定しても何も変わらない。採用した生成物の採否は`accepted`になる。
    """
    await _require_writable_project(session, project_id)
    await _get_scene(session, project_id, scene_id)
    await _require_dialogue_for_slot(session, scene_id, slot, payload.dialogue_id)
    artifact = await session.get(Artifact, payload.artifact_id)
    if artifact is None:
        raise _not_found("Artifact", payload.artifact_id)
    if artifact.deleted_at is not None or artifact.availability != "complete":
        raise _unprocessable(
            "STORY_ADOPTION_ARTIFACT_UNAVAILABLE",
            "ゴミ箱にある、または未完了の生成物は採用できません。",
            {"artifact_id": artifact.id, "availability": artifact.availability},
        )
    await _check_slot_accepts(session, slot, artifact)

    now = schemas.now_iso()
    adoption = await _find_adoption(session, scene_id, slot, payload.dialogue_id)
    replaced: set[str] = set()
    if adoption is None:
        adoption = StorySceneAdoption(
            id=schemas.new_id(),
            scene_id=scene_id,
            slot=slot,
            dialogue_id=payload.dialogue_id,
            artifact_id=artifact.id,
            created_at=now,
            updated_at=now,
        )
        session.add(adoption)
    elif adoption.artifact_id != artifact.id:
        replaced.add(adoption.artifact_id)
        adoption.artifact_id = artifact.id
        adoption.updated_at = now
    await session.flush()
    if artifact.decision != "accepted":
        artifact.decision = "accepted"
        artifact.decision_at = now
    await story_links.revert_adoption_decisions(session, replaced)
    await _commit(session)
    return adoption


@router.delete(
    "/{project_id}/story-scenes/{scene_id}/adoptions/{slot}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def release_story_scene_adoption(
    project_id: schemas.AiMediaId,
    scene_id: schemas.ResourceId,
    slot: schemas.StoryAdoptionSlot,
    session: SessionDep,
    dialogue_id: Annotated[schemas.ResourceId | None, Query()] = None,
):
    """枠の採用を外す。外れた生成物は他の枠で採用されていなければ`undecided`へ戻る。

    採用が無い枠でも204を返す。
    """
    await _require_writable_project(session, project_id)
    await _get_scene(session, project_id, scene_id)
    await _require_dialogue_for_slot(session, scene_id, slot, dialogue_id)
    adoption = await _find_adoption(session, scene_id, slot, dialogue_id)
    if adoption is not None:
        await story_links.release_adoptions(
            session, StorySceneAdoption.id == adoption.id
        )
    await _commit(session)
