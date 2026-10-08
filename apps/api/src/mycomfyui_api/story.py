"""WebUI v2のキャラクター・衣装・シーンのAPI (#529)。

旧UIの`ProjectScene`・`ProjectShot`とProject設定の`characters`には触れない。
旧シーンのAPIが`/scenes`を使っているため、v2のシーンは`/story-scenes`に置く。
"""

import mimetypes
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette import status

from mycomfyui_api import schemas, storage, story_links
from mycomfyui_api.db import get_session
from mycomfyui_api.errors import ApiError
from mycomfyui_api.models import (
    Artifact,
    GenerationJob,
    MediaRoleTag,
    Project,
    StoryCharacter,
    StoryCostume,
    StoryCostumeImage,
    StoryScene,
    StorySceneAdoption,
    StorySceneCast,
    StorySceneDialogue,
)

router = APIRouter(prefix="/api/v1/projects", tags=["story"])
SessionDep = Annotated[AsyncSession, Depends(get_session)]

ARTIFACT_KEY_PREFIX = "artifact:"
INPUT_KEY_PREFIX = "input:"

#: 名前の一意制約に当たったときのSQLiteのメッセージ。これ以外の`IntegrityError`は、
#: 検証の後に別のリクエストが参照先を消したときのFK違反として扱う。
_NAME_VIOLATIONS = (
    "UNIQUE constraint failed: story_character.project_id, story_character.name",
    "UNIQUE constraint failed: story_costume.character_id, story_costume.name",
)


def _not_found(resource: str, resource_id: str) -> ApiError:
    return ApiError(
        "REFERENCE_NOT_FOUND",
        f"{resource}がありません。",
        status_code=status.HTTP_404_NOT_FOUND,
        details={"resource": resource, "id": resource_id},
    )


def _unprocessable(code: str, message: str, details: dict[str, Any]) -> ApiError:
    return ApiError(
        code,
        message,
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        details=details,
    )


async def _require_project(session: AsyncSession, project_id: str) -> Project:
    project = await session.get(Project, project_id)
    if project is None:
        raise _not_found("Project", project_id)
    return project


async def _require_writable_project(session: AsyncSession, project_id: str) -> Project:
    project = await _require_project(session, project_id)
    if project.lifecycle == "trashed":
        raise ApiError(
            "PROJECT_TRASHED",
            "ゴミ箱のProjectは復元してから更新してください。",
            status_code=status.HTTP_409_CONFLICT,
            details={"project_id": project_id},
        )
    return project


async def _commit(session: AsyncSession) -> None:
    try:
        await session.commit()
    except IntegrityError as error:
        await session.rollback()
        if any(violation in str(error.orig) for violation in _NAME_VIOLATIONS):
            raise ApiError(
                "STORY_CONFLICT",
                "同じ名前が既に存在します。",
                status_code=status.HTTP_409_CONFLICT,
            ) from error
        raise ApiError(
            "STORY_REFERENCE_CHANGED",
            "参照先が変更されました。再読み込みしてからやり直してください。",
            status_code=status.HTTP_409_CONFLICT,
        ) from error


async def _validate_media_key(
    session: AsyncSession, key: str, *, kind: str, field: str
) -> None:
    """参照先の生成物・入力cacheが存在し、種別が合うことを確かめる。"""
    details = {"field": field, "media_key": key}
    if key.startswith(ARTIFACT_KEY_PREFIX):
        artifact = await session.get(Artifact, key.removeprefix(ARTIFACT_KEY_PREFIX))
        if artifact is None or artifact.deleted_at is not None:
            raise _unprocessable(
                "MEDIA_NOT_FOUND", "参照先の生成物がありません。", details
            )
        if artifact.kind != kind:
            raise _unprocessable(
                "MEDIA_KIND_MISMATCH",
                f"{kind}ではない生成物は指定できません。",
                {**details, "kind": artifact.kind},
            )
        return
    if key.startswith(INPUT_KEY_PREFIX):
        relative_path = key.removeprefix(INPUT_KEY_PREFIX)
        try:
            schemas.input_cache_relative_path(relative_path)
            path = storage.resolve_input(relative_path)
            if kind == "image":
                with path.open("rb") as handle:
                    header = handle.read(32)
                if storage.detect_image_media_type(header) is None:
                    raise ValueError("画像ではありません。")
            elif kind == "audio":
                media_type = mimetypes.guess_type(relative_path)[0] or ""
                if not media_type.startswith("audio/"):
                    raise ValueError("音声ではありません。")
        except (ValueError, storage.StorageError, OSError) as error:
            raise _unprocessable(
                "MEDIA_NOT_FOUND", "参照先の素材を読み出せません。", details
            ) from error
        return
    raise _unprocessable(
        "MEDIA_KEY_INVALID",
        "参照は artifact:<id> か input:<relative_path> の形で指定してください。",
        details,
    )


def _reject_null(payload: Any, fields: set[str]) -> None:
    for field in payload.model_fields_set & fields:
        if getattr(payload, field) is None:
            raise _unprocessable(
                "STORY_FIELD_REQUIRED",
                f"{field}をnullにできません。",
                {"field": field},
            )


# --- キャラクター・衣装 ---


async def _costume_reads(
    session: AsyncSession, costumes: list[StoryCostume]
) -> list[schemas.StoryCostumeRead]:
    images: dict[str, list[str]] = {costume.id: [] for costume in costumes}
    if costumes:
        rows = await session.scalars(
            select(StoryCostumeImage)
            .where(StoryCostumeImage.costume_id.in_(list(images)))
            .order_by(StoryCostumeImage.costume_id, StoryCostumeImage.position)
        )
        for row in rows:
            images[row.costume_id].append(row.media_key)
    return [
        schemas.StoryCostumeRead(
            id=costume.id,
            character_id=costume.character_id,
            name=costume.name,
            tags=list(costume.tags),
            negative_tags=list(costume.negative_tags),
            description=costume.description,
            reference_images=images[costume.id],
            created_at=costume.created_at,
            updated_at=costume.updated_at,
        )
        for costume in costumes
    ]


async def _character_reads(
    session: AsyncSession, characters: list[StoryCharacter]
) -> list[schemas.StoryCharacterRead]:
    costumes: dict[str, list[StoryCostume]] = {c.id: [] for c in characters}
    if characters:
        rows = await session.scalars(
            select(StoryCostume)
            .where(StoryCostume.character_id.in_(list(costumes)))
            .order_by(StoryCostume.created_at, StoryCostume.id)
        )
        for row in rows:
            costumes[row.character_id].append(row)
    all_costumes = [row for rows in costumes.values() for row in rows]
    costume_reads = {c.id: c for c in await _costume_reads(session, all_costumes)}
    return [
        schemas.StoryCharacterRead(
            id=character.id,
            project_id=character.project_id,
            name=character.name,
            fixed_tags=list(character.fixed_tags),
            negative_tags=list(character.negative_tags),
            profile=character.profile,
            portrait_media_key=character.portrait_media_key,
            voice_media_key=character.voice_media_key,
            voice_transcript=character.voice_transcript,
            costumes=[costume_reads[c.id] for c in costumes[character.id]],
            created_at=character.created_at,
            updated_at=character.updated_at,
        )
        for character in characters
    ]


async def _get_character(
    session: AsyncSession, project_id: str, character_id: str
) -> StoryCharacter:
    character = await session.get(StoryCharacter, character_id)
    if character is None or character.project_id != project_id:
        raise _not_found("Character", character_id)
    return character


async def _get_costume(
    session: AsyncSession, character: StoryCharacter, costume_id: str
) -> StoryCostume:
    costume = await session.get(StoryCostume, costume_id)
    if costume is None or costume.character_id != character.id:
        raise _not_found("Costume", costume_id)
    return costume


async def _validate_character_media(
    session: AsyncSession, payload: Any, fields: set[str]
) -> None:
    kinds = {
        "portrait_media_key": "image",
        "voice_media_key": "audio",
    }
    for field, kind in kinds.items():
        key = getattr(payload, field, None)
        if field in fields and key is not None:
            await _validate_media_key(session, key, kind=kind, field=field)


@router.get("/{project_id}/characters", response_model=list[schemas.StoryCharacterRead])
async def list_characters(project_id: schemas.AiMediaId, session: SessionDep):
    await _require_project(session, project_id)
    rows = await session.scalars(
        select(StoryCharacter)
        .where(StoryCharacter.project_id == project_id)
        .order_by(StoryCharacter.created_at, StoryCharacter.id)
    )
    return await _character_reads(session, list(rows))


@router.post(
    "/{project_id}/characters",
    response_model=schemas.StoryCharacterRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_character(
    project_id: schemas.AiMediaId,
    payload: schemas.StoryCharacterCreate,
    session: SessionDep,
):
    await _require_writable_project(session, project_id)
    await _validate_character_media(session, payload, payload.model_fields_set)
    now = schemas.now_iso()
    character = StoryCharacter(
        id=schemas.new_id(),
        project_id=project_id,
        name=payload.name,
        fixed_tags=list(payload.fixed_tags),
        negative_tags=list(payload.negative_tags),
        profile=payload.profile,
        portrait_media_key=payload.portrait_media_key,
        voice_media_key=payload.voice_media_key,
        voice_transcript=payload.voice_transcript,
        created_at=now,
        updated_at=now,
    )
    session.add(character)
    await _commit(session)
    return (await _character_reads(session, [character]))[0]


@router.get(
    "/{project_id}/characters/{character_id}",
    response_model=schemas.StoryCharacterRead,
)
async def get_character(
    project_id: schemas.AiMediaId,
    character_id: schemas.ResourceId,
    session: SessionDep,
):
    await _require_project(session, project_id)
    character = await _get_character(session, project_id, character_id)
    return (await _character_reads(session, [character]))[0]


@router.patch(
    "/{project_id}/characters/{character_id}",
    response_model=schemas.StoryCharacterRead,
)
async def update_character(
    project_id: schemas.AiMediaId,
    character_id: schemas.ResourceId,
    payload: schemas.StoryCharacterUpdate,
    session: SessionDep,
):
    await _require_writable_project(session, project_id)
    character = await _get_character(session, project_id, character_id)
    _reject_null(payload, {"name", "fixed_tags", "negative_tags", "profile"})
    await _validate_character_media(session, payload, payload.model_fields_set)
    for field in payload.model_fields_set:
        value = getattr(payload, field)
        setattr(character, field, list(value) if isinstance(value, list) else value)
    character.updated_at = schemas.now_iso()
    await _commit(session)
    return (await _character_reads(session, [character]))[0]


@router.delete(
    "/{project_id}/characters/{character_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_character(
    project_id: schemas.AiMediaId,
    character_id: schemas.ResourceId,
    session: SessionDep,
):
    await _require_writable_project(session, project_id)
    character = await _get_character(session, project_id, character_id)
    scene_ids = set(
        await session.scalars(
            select(StorySceneCast.scene_id).where(
                StorySceneCast.character_id == character_id
            )
        )
    ) | set(
        await session.scalars(
            select(StorySceneDialogue.scene_id).where(
                StorySceneDialogue.speaker_character_id == character_id
            )
        )
    )
    if scene_ids:
        raise ApiError(
            "STORY_CHARACTER_IN_USE",
            "シーンの登場キャラまたは台詞の話者に使われているため削除できません。",
            status_code=status.HTTP_409_CONFLICT,
            details={"scene_ids": sorted(scene_ids)},
        )
    costume_ids = list(
        await session.scalars(
            select(StoryCostume.id).where(StoryCostume.character_id == character_id)
        )
    )
    await session.execute(
        delete(StoryCostumeImage).where(StoryCostumeImage.costume_id.in_(costume_ids))
    )
    await session.execute(
        delete(StoryCostume).where(StoryCostume.character_id == character_id)
    )
    await session.delete(character)
    await _commit(session)


@router.post(
    "/{project_id}/characters/{character_id}/costumes",
    response_model=schemas.StoryCostumeRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_costume(
    project_id: schemas.AiMediaId,
    character_id: schemas.ResourceId,
    payload: schemas.StoryCostumeCreate,
    session: SessionDep,
):
    await _require_writable_project(session, project_id)
    character = await _get_character(session, project_id, character_id)
    for key in payload.reference_images:
        await _validate_media_key(session, key, kind="image", field="reference_images")
    now = schemas.now_iso()
    costume = StoryCostume(
        id=schemas.new_id(),
        character_id=character.id,
        name=payload.name,
        tags=list(payload.tags),
        negative_tags=list(payload.negative_tags),
        description=payload.description,
        created_at=now,
        updated_at=now,
    )
    session.add(costume)
    await session.flush()
    _add_costume_images(session, costume.id, payload.reference_images, now)
    await _commit(session)
    return (await _costume_reads(session, [costume]))[0]


def _add_costume_images(
    session: AsyncSession, costume_id: str, keys: list[str], now: str
) -> None:
    for position, key in enumerate(keys):
        session.add(
            StoryCostumeImage(
                id=schemas.new_id(),
                costume_id=costume_id,
                position=position,
                media_key=key,
                created_at=now,
            )
        )


@router.get(
    "/{project_id}/characters/{character_id}/costumes/{costume_id}",
    response_model=schemas.StoryCostumeRead,
)
async def get_costume(
    project_id: schemas.AiMediaId,
    character_id: schemas.ResourceId,
    costume_id: schemas.ResourceId,
    session: SessionDep,
):
    await _require_project(session, project_id)
    character = await _get_character(session, project_id, character_id)
    costume = await _get_costume(session, character, costume_id)
    return (await _costume_reads(session, [costume]))[0]


@router.patch(
    "/{project_id}/characters/{character_id}/costumes/{costume_id}",
    response_model=schemas.StoryCostumeRead,
)
async def update_costume(
    project_id: schemas.AiMediaId,
    character_id: schemas.ResourceId,
    costume_id: schemas.ResourceId,
    payload: schemas.StoryCostumeUpdate,
    session: SessionDep,
):
    await _require_writable_project(session, project_id)
    character = await _get_character(session, project_id, character_id)
    costume = await _get_costume(session, character, costume_id)
    _reject_null(
        payload,
        {"name", "tags", "negative_tags", "description", "reference_images"},
    )
    now = schemas.now_iso()
    fields = payload.model_fields_set
    if "reference_images" in fields:
        keys = list(payload.reference_images or [])
        for key in keys:
            await _validate_media_key(
                session, key, kind="image", field="reference_images"
            )
        # 並び順の一意制約に当たらないよう、置き換え前の行を先に消す。
        await session.execute(
            delete(StoryCostumeImage).where(StoryCostumeImage.costume_id == costume.id)
        )
        _add_costume_images(session, costume.id, keys, now)
    for field in fields - {"reference_images"}:
        value = getattr(payload, field)
        setattr(costume, field, list(value) if isinstance(value, list) else value)
    costume.updated_at = now
    await _commit(session)
    return (await _costume_reads(session, [costume]))[0]


@router.delete(
    "/{project_id}/characters/{character_id}/costumes/{costume_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_costume(
    project_id: schemas.AiMediaId,
    character_id: schemas.ResourceId,
    costume_id: schemas.ResourceId,
    session: SessionDep,
):
    await _require_writable_project(session, project_id)
    character = await _get_character(session, project_id, character_id)
    costume = await _get_costume(session, character, costume_id)
    scene_ids = list(
        await session.scalars(
            select(StorySceneCast.scene_id)
            .where(StorySceneCast.costume_id == costume_id)
            .distinct()
        )
    )
    if scene_ids:
        raise ApiError(
            "STORY_COSTUME_IN_USE",
            "シーンの登場キャラの衣装に使われているため削除できません。",
            status_code=status.HTTP_409_CONFLICT,
            details={"scene_ids": sorted(scene_ids)},
        )
    await session.execute(
        delete(StoryCostumeImage).where(StoryCostumeImage.costume_id == costume_id)
    )
    await session.delete(costume)
    await _commit(session)


# --- シーン ---


async def _scene_reads(
    session: AsyncSession, scenes: list[StoryScene]
) -> list[schemas.StorySceneRead]:
    ids = [scene.id for scene in scenes]
    cast: dict[str, list[schemas.StorySceneCastEntry]] = {i: [] for i in ids}
    dialogues: dict[str, list[schemas.StorySceneDialogueEntry]] = {i: [] for i in ids}
    if ids:
        cast_rows = await session.scalars(
            select(StorySceneCast)
            .where(StorySceneCast.scene_id.in_(ids))
            .order_by(StorySceneCast.scene_id, StorySceneCast.position)
        )
        for row in cast_rows:
            cast[row.scene_id].append(
                schemas.StorySceneCastEntry(
                    character_id=row.character_id,
                    costume_id=row.costume_id,
                    pose_text=row.pose_text,
                    pose_tags=list(row.pose_tags),
                    expression_text=row.expression_text,
                    expression_tags=list(row.expression_tags),
                )
            )
        dialogue_rows = await session.scalars(
            select(StorySceneDialogue)
            .where(StorySceneDialogue.scene_id.in_(ids))
            .order_by(StorySceneDialogue.scene_id, StorySceneDialogue.position)
        )
        for row in dialogue_rows:
            dialogues[row.scene_id].append(
                schemas.StorySceneDialogueEntry(
                    id=row.id,
                    speaker_character_id=row.speaker_character_id,
                    text=row.text,
                    direction=row.direction,
                )
            )
    return [
        schemas.StorySceneRead(
            id=scene.id,
            project_id=scene.project_id,
            parent_scene_id=scene.parent_scene_id,
            name=scene.name,
            sequence=scene.sequence,
            summary=scene.summary,
            background_text=scene.background_text,
            background_tags=list(scene.background_tags),
            time_of_day=scene.time_of_day,
            bgm_mood=scene.bgm_mood,
            video_motion=scene.video_motion,
            cast=cast[scene.id],
            dialogues=dialogues[scene.id],
            created_at=scene.created_at,
            updated_at=scene.updated_at,
        )
        for scene in scenes
    ]


async def _get_scene(
    session: AsyncSession, project_id: str, scene_id: str
) -> StoryScene:
    scene = await session.get(StoryScene, scene_id)
    if scene is None or scene.project_id != project_id:
        raise _not_found("Scene", scene_id)
    return scene


async def _validate_cast_and_dialogues(
    session: AsyncSession,
    project_id: str,
    cast: list[schemas.StorySceneCastEntry],
    dialogues: list[schemas.StorySceneDialogueEntry],
) -> None:
    """登場キャラ・話者がこのProjectのキャラで、衣装がそのキャラのものだけであることを確かめる。"""
    character_ids = {entry.character_id for entry in cast} | {
        entry.speaker_character_id for entry in dialogues
    }
    known = set(
        await session.scalars(
            select(StoryCharacter.id).where(
                StoryCharacter.project_id == project_id,
                StoryCharacter.id.in_(character_ids),
            )
        )
    )
    missing = sorted(character_ids - known)
    if missing:
        raise _unprocessable(
            "STORY_CHARACTER_NOT_IN_PROJECT",
            "このProjectに無いキャラクターは指定できません。",
            {"character_ids": missing},
        )
    costume_ids = {e.costume_id for e in cast if e.costume_id is not None}
    owners = {
        row.id: row.character_id
        for row in await session.scalars(
            select(StoryCostume).where(StoryCostume.id.in_(costume_ids))
        )
    }
    for entry in cast:
        if entry.costume_id is None:
            continue
        if owners.get(entry.costume_id) != entry.character_id:
            raise _unprocessable(
                "STORY_COSTUME_CHARACTER_MISMATCH",
                "登場キャラの衣装には、そのキャラクターの衣装だけを指定できます。",
                {"character_id": entry.character_id, "costume_id": entry.costume_id},
            )


async def _replace_cast(
    session: AsyncSession, scene_id: str, cast: list[schemas.StorySceneCastEntry]
) -> None:
    await session.execute(
        delete(StorySceneCast).where(StorySceneCast.scene_id == scene_id)
    )
    for position, entry in enumerate(cast):
        session.add(
            StorySceneCast(
                id=schemas.new_id(),
                scene_id=scene_id,
                position=position,
                character_id=entry.character_id,
                costume_id=entry.costume_id,
                pose_text=entry.pose_text,
                pose_tags=list(entry.pose_tags),
                expression_text=entry.expression_text,
                expression_tags=list(entry.expression_tags),
            )
        )


async def _replace_dialogues(
    session: AsyncSession,
    scene_id: str,
    dialogues: list[schemas.StorySceneDialogueEntry],
) -> None:
    """台詞を渡した配列へ置き換える。`id`を持つ行は同じ台詞として更新する。

    IDを保つのは、台詞ごとの音声の採用(`story_scene_adoption`)が台詞IDを指すため。
    配列から外れた台詞は消し、その採用も外す。`id`を省いた行は新しい台詞になる。
    このシーンに無い`id`は、他シーンの台詞を取り込めてしまうため拒否する。
    """
    existing = {
        row.id: row
        for row in await session.scalars(
            select(StorySceneDialogue).where(StorySceneDialogue.scene_id == scene_id)
        )
    }
    kept_ids = [entry.id for entry in dialogues if entry.id is not None]
    if len(set(kept_ids)) != len(kept_ids):
        raise _unprocessable(
            "STORY_DIALOGUE_DUPLICATED",
            "同じ台詞のidを複数の行に指定できません。",
            {},
        )
    unknown = sorted(set(kept_ids) - existing.keys())
    if unknown:
        raise _unprocessable(
            "STORY_DIALOGUE_NOT_IN_SCENE",
            "このシーンに無い台詞のidは指定できません。",
            {"dialogue_ids": unknown},
        )
    removed = [row for row_id, row in existing.items() if row_id not in kept_ids]
    if removed:
        await story_links.release_adoptions(
            session, StorySceneAdoption.dialogue_id.in_([row.id for row in removed])
        )
        for row in removed:
            await session.delete(row)
    # (scene_id, position)の一意制約を、並べ替えの途中で踏まないよう、残す行を
    # いったん負の位置へ逃がしてから確定する。
    kept_rows = [existing[row_id] for row_id in kept_ids]
    for index, row in enumerate(kept_rows):
        row.position = -(index + 1)
    await session.flush()
    for position, entry in enumerate(dialogues):
        if entry.id is None:
            session.add(
                StorySceneDialogue(
                    id=schemas.new_id(),
                    scene_id=scene_id,
                    position=position,
                    speaker_character_id=entry.speaker_character_id,
                    text=entry.text,
                    direction=entry.direction,
                )
            )
            continue
        row = existing[entry.id]
        row.position = position
        row.speaker_character_id = entry.speaker_character_id
        row.text = entry.text
        row.direction = entry.direction
    await session.flush()


@router.get("/{project_id}/story-scenes", response_model=list[schemas.StorySceneRead])
async def list_story_scenes(project_id: schemas.AiMediaId, session: SessionDep):
    await _require_project(session, project_id)
    rows = await session.scalars(
        select(StoryScene)
        .where(StoryScene.project_id == project_id)
        .order_by(StoryScene.sequence, StoryScene.id)
    )
    return await _scene_reads(session, list(rows))


@router.post(
    "/{project_id}/story-scenes",
    response_model=schemas.StorySceneRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_story_scene(
    project_id: schemas.AiMediaId,
    payload: schemas.StorySceneCreate,
    session: SessionDep,
):
    await _require_writable_project(session, project_id)
    await _validate_cast_and_dialogues(
        session, project_id, payload.cast, payload.dialogues
    )
    sequence = (
        int(
            await session.scalar(
                select(func.coalesce(func.max(StoryScene.sequence), 0)).where(
                    StoryScene.project_id == project_id
                )
            )
            or 0
        )
        + 1
    )
    now = schemas.now_iso()
    scene = StoryScene(
        id=schemas.new_id(),
        project_id=project_id,
        parent_scene_id=None,
        name=payload.name,
        sequence=sequence,
        summary=payload.summary,
        background_text=payload.background_text,
        background_tags=list(payload.background_tags),
        time_of_day=payload.time_of_day,
        bgm_mood=payload.bgm_mood,
        video_motion=payload.video_motion,
        created_at=now,
        updated_at=now,
    )
    session.add(scene)
    await session.flush()
    await _replace_cast(session, scene.id, payload.cast)
    await _replace_dialogues(session, scene.id, payload.dialogues)
    await _commit(session)
    return (await _scene_reads(session, [scene]))[0]


@router.post(
    "/{project_id}/story-scenes/reorder",
    response_model=list[schemas.StorySceneRead],
)
async def reorder_story_scenes(
    project_id: schemas.AiMediaId,
    payload: schemas.StructureReorder,
    session: SessionDep,
):
    """シーンの並び順を置き換える。現在のシーンIDを過不足なく並べて渡す。"""
    await _require_writable_project(session, project_id)
    rows = list(
        await session.scalars(
            select(StoryScene).where(StoryScene.project_id == project_id)
        )
    )
    ids = payload.ids
    if len(ids) != len(set(ids)) or set(ids) != {row.id for row in rows}:
        raise _unprocessable(
            "INVALID_STRUCTURE_ORDER",
            "並び順には現在のIDを重複なくすべて指定してください。",
            {},
        )
    index = {row.id: row for row in rows}
    now = schemas.now_iso()
    for sequence, scene_id in enumerate(ids, start=1):
        index[scene_id].sequence = sequence
        index[scene_id].updated_at = now
    await _commit(session)
    return await _scene_reads(session, [index[scene_id] for scene_id in ids])


@router.get(
    "/{project_id}/story-scenes/{scene_id}", response_model=schemas.StorySceneRead
)
async def get_story_scene(
    project_id: schemas.AiMediaId,
    scene_id: schemas.ResourceId,
    session: SessionDep,
):
    await _require_project(session, project_id)
    scene = await _get_scene(session, project_id, scene_id)
    return (await _scene_reads(session, [scene]))[0]


@router.patch(
    "/{project_id}/story-scenes/{scene_id}", response_model=schemas.StorySceneRead
)
async def update_story_scene(
    project_id: schemas.AiMediaId,
    scene_id: schemas.ResourceId,
    payload: schemas.StorySceneUpdate,
    session: SessionDep,
):
    await _require_writable_project(session, project_id)
    scene = await _get_scene(session, project_id, scene_id)
    _reject_null(
        payload,
        {
            "name",
            "summary",
            "background_text",
            "background_tags",
            "bgm_mood",
            "video_motion",
            "cast",
            "dialogues",
        },
    )
    fields = payload.model_fields_set
    if "cast" in fields or "dialogues" in fields:
        current = (await _scene_reads(session, [scene]))[0]
        cast = payload.cast if "cast" in fields else current.cast
        dialogues = payload.dialogues if "dialogues" in fields else current.dialogues
        await _validate_cast_and_dialogues(session, project_id, cast, dialogues)
        if "cast" in fields:
            await _replace_cast(session, scene.id, cast)
        if "dialogues" in fields:
            await _replace_dialogues(session, scene.id, dialogues)
    for field in fields - {"cast", "dialogues"}:
        value = getattr(payload, field)
        setattr(scene, field, list(value) if isinstance(value, list) else value)
    scene.updated_at = schemas.now_iso()
    await _commit(session)
    return (await _scene_reads(session, [scene]))[0]


@router.delete(
    "/{project_id}/story-scenes/{scene_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_story_scene(
    project_id: schemas.AiMediaId,
    scene_id: schemas.ResourceId,
    session: SessionDep,
):
    """シーンの定義を消す。このシーンに紐づいた生成物は消さず、紐づけだけ外す。"""
    await _require_writable_project(session, project_id)
    scene = await _get_scene(session, project_id, scene_id)
    # 採用を外し、採用で`accepted`になっていた生成物の採否を戻す。
    await story_links.release_adoptions(
        session, StorySceneAdoption.scene_id == scene_id
    )
    await session.execute(
        delete(StorySceneCast).where(StorySceneCast.scene_id == scene_id)
    )
    await session.execute(
        delete(StorySceneDialogue).where(StorySceneDialogue.scene_id == scene_id)
    )
    await session.execute(
        update(StoryScene)
        .where(StoryScene.parent_scene_id == scene_id)
        .values(parent_scene_id=None)
    )
    await detach_assignments(session, scene_id=scene_id)
    await session.delete(scene)
    await _commit(session)


async def detach_assignments(
    session: AsyncSession,
    *,
    project_id: str | None = None,
    scene_id: str | None = None,
) -> tuple[int, int, int]:
    """生成物・Job・素材タグの整理先を外す。外した件数を(Artifact, Job, 素材タグ)で返す。

    `project_id`ならそのProject全体、`scene_id`ならそのSceneだけを外す。ファイルも
    生成物の記録も消さない。
    """
    if (project_id is None) == (scene_id is None):
        raise ValueError("project_idかscene_idのどちらか一方を指定してください。")
    if project_id is not None:
        artifact_match = Artifact.assigned_project_id == project_id
        job_match = GenerationJob.assigned_project_id == project_id
        tag_match = MediaRoleTag.assigned_project_id == project_id
        cleared: dict[str, Any] = {
            "assigned_project_id": None,
            "assigned_scene_id": None,
        }
    else:
        artifact_match = Artifact.assigned_scene_id == scene_id
        job_match = GenerationJob.assigned_scene_id == scene_id
        tag_match = MediaRoleTag.assigned_scene_id == scene_id
        cleared = {"assigned_scene_id": None}
    artifacts = await session.execute(
        update(Artifact).where(artifact_match).values(**cleared, assigned_shot_id=None)
    )
    jobs = await session.execute(
        update(GenerationJob).where(job_match).values(**cleared, assigned_shot_id=None)
    )
    tags = await session.execute(
        update(MediaRoleTag).where(tag_match).values(**cleared)
    )
    return artifacts.rowcount, jobs.rowcount, tags.rowcount
