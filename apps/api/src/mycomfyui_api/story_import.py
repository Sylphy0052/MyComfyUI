"""novel-writerのsnapshotと旧キャラ設定から、v2のキャラ・衣装・シーンを作る取り込み (#630)。

キャラとシーンの正本はMyComfyUIで、novel-writerからは取り込むだけにする。再取り込みでは、
まだ無い分だけを足し、既にある行 (`source_ref`が一致する行、またはキャラは同名の行) と
その配下の衣装には触れない。preview (件数だけ) と実行は同じ計画 (`_build_plan`) から作る。

対応:
- キャラ: snapshotの`canon.items`のうち`kind=character`。同名の`local_overrides.characters`が
  あればその内容を使う。canonに無い旧キャラも取り込む。
- 衣装: 旧キャラの`outfits`。取り込むのは新しく作るキャラの分だけ。
- シーン: snapshotの`scenes.items`。`local_overrides.scene_details`があれば背景・時間帯・
  登場キャラを入れる。canonの`location`は背景に使わない。
"""

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette import status

from mycomfyui_api import schemas, storage
from mycomfyui_api.db import get_session
from mycomfyui_api.errors import ApiError
from mycomfyui_api.models import (
    Project,
    StoryCharacter,
    StoryCostume,
    StoryCostumeImage,
    StoryScene,
    StorySceneCast,
)

router = APIRouter(prefix="/api/v1/projects", tags=["story"])
SessionDep = Annotated[AsyncSession, Depends(get_session)]

INPUT_KEY_PREFIX = "input:"
MAX_NAME_LENGTH = 120
MAX_TAG_LENGTH = 128
MAX_TAGS = 100
MAX_TEXT_LENGTH = 4_000
_TAG_SEPARATORS = re.compile(r"[,、，。\n]")

#: 旧`scene_details.time_of_day`の値からv2の時間帯への対応。無い値は未設定にする。
_TIME_OF_DAY = {
    "朝": "morning",
    "morning": "morning",
    "昼": "day",
    "day": "day",
    "夕方": "sunset",
    "夕": "sunset",
    "sunset": "sunset",
    "夜": "night",
    "night": "night",
}

_PROFILE_LABELS = (
    ("personality", "性格"),
    ("age", "年齢"),
    ("first_person", "一人称"),
    ("speech_style", "口調"),
    ("background", "背景"),
)


@dataclass
class _CostumePlan:
    id: str
    name: str
    tags: list[str]
    description: str
    image_keys: list[str] = field(default_factory=list)


@dataclass
class _CharacterPlan:
    id: str
    source_ref: str
    name: str
    fixed_tags: list[str]
    negative_tags: list[str]
    profile: str
    costumes: list[_CostumePlan] = field(default_factory=list)


@dataclass
class _ScenePlan:
    id: str
    source_ref: str
    name: str
    sequence: int
    summary: str
    background_text: str
    background_tags: list[str]
    time_of_day: str | None
    cast_character_ids: list[str]


@dataclass
class _Plan:
    characters: list[_CharacterPlan] = field(default_factory=list)
    scenes: list[_ScenePlan] = field(default_factory=list)
    skipped_characters: int = 0
    skipped_costumes: int = 0
    skipped_scenes: int = 0
    images_imported: int = 0
    images_not_imported: int = 0

    @property
    def created_costumes(self) -> int:
        return sum(len(character.costumes) for character in self.characters)

    def result(self) -> schemas.StoryImportResult:
        return schemas.StoryImportResult(
            characters=schemas.StoryImportCounts(
                created=len(self.characters), skipped=self.skipped_characters
            ),
            costumes=schemas.StoryImportCounts(
                created=self.created_costumes, skipped=self.skipped_costumes
            ),
            scenes=schemas.StoryImportCounts(
                created=len(self.scenes), skipped=self.skipped_scenes
            ),
            reference_images=schemas.StoryImportImageCounts(
                imported=self.images_imported, not_imported=self.images_not_imported
            ),
        )


def _snapshot_items(snapshot: Any, section: str) -> list[dict[str, Any]]:
    block = snapshot.get(section) if isinstance(snapshot, dict) else None
    items = block.get("items") if isinstance(block, dict) else None
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict)]


def _clean_tags(values: list[str]) -> list[str]:
    """v2のタグに使える形へ整える。空と制御文字を含むものを除き、重複を落とす。"""
    tags: list[str] = []
    for value in values:
        tag = str(value).strip()[:MAX_TAG_LENGTH].strip()
        if not tag or any(ord(c) < 0x20 or ord(c) == 0x7F for c in tag):
            continue
        if tag not in tags:
            tags.append(tag)
    return tags[:MAX_TAGS]


def _split_tags(text: str | None) -> list[str]:
    """読点・句点・カンマ区切りの文章をタグへ分ける。"""
    if not text:
        return []
    return _clean_tags(_TAG_SEPARATORS.split(text))


def _profile_text(
    override: schemas.ProjectCharacterProfile | None,
) -> str:
    """旧キャラのプロフィールと外見・声質の文章を、v2の`profile`1本へまとめる。"""
    if override is None:
        return ""
    lines: list[str] = []
    if override.appearance:
        lines.append(f"外見: {override.appearance}")
    personal = override.profile
    if personal is not None:
        for attribute, label in _PROFILE_LABELS:
            value = getattr(personal, attribute)
            if value:
                lines.append(f"{label}: {value}")
        lines.extend(f"{item.key}: {item.value}" for item in personal.extra)
    if override.voice:
        lines.append(f"声質: {override.voice}")
    return "\n".join(lines)[:MAX_TEXT_LENGTH]


def _image_key(relative_path: str) -> str | None:
    """旧参照画像を`input:<path>`にできるか。ファイルが入力cacheに無ければNone。

    旧`ProjectReferenceImage.relative_path`はdata_root基準の`inputs/<sha256>/<name>`で、
    v2の`input:<relative_path>`が指す場所と同じ。実ファイルが無いと表示できないため、
    存在を確かめてから入れる。
    """
    try:
        schemas.input_cache_relative_path(relative_path)
        storage.resolve_input(relative_path)
    except (ValueError, storage.StorageError, OSError):
        return None
    return f"{INPUT_KEY_PREFIX}{relative_path}"


def _plan_costumes(
    override: schemas.ProjectCharacterProfile, plan: _Plan
) -> list[_CostumePlan]:
    costumes: list[_CostumePlan] = []
    by_outfit_id: dict[str, _CostumePlan] = {}
    for outfit in override.outfits:
        name = outfit.name.strip()[:MAX_NAME_LENGTH]
        if not name or any(c.name.casefold() == name.casefold() for c in costumes):
            continue
        category = "、".join(outfit.tags)
        costume = _CostumePlan(
            id=schemas.new_id(),
            name=name,
            tags=_split_tags(outfit.prompt),
            description=f"分類: {category}" if category else "",
        )
        costumes.append(costume)
        by_outfit_id[outfit.id] = costume
        if outfit.image is not None:
            _attach_image(costume, outfit.image.relative_path, plan)
    # 旧キャラの参照画像は、既定の衣装 (無ければ先頭の衣装) の参照画像へ入れる。
    holder = by_outfit_id.get(override.default_outfit_id or "") or (
        costumes[0] if costumes else None
    )
    for image in override.reference_images:
        if holder is None:
            plan.images_not_imported += 1
            continue
        _attach_image(holder, image.relative_path, plan)
    return costumes


def _attach_image(costume: _CostumePlan, relative_path: str, plan: _Plan) -> None:
    key = _image_key(relative_path)
    if key is None:
        plan.images_not_imported += 1
    elif key not in costume.image_keys:
        costume.image_keys.append(key)
        plan.images_imported += 1


async def _build_plan(session: AsyncSession, project: Project) -> _Plan:
    snapshot = project.source_snapshot or {}
    overrides = schemas.ProjectLocalOverrides.model_validate(
        project.local_overrides or {}
    )
    canon_characters = [
        item
        for item in _snapshot_items(snapshot, "canon")
        if item.get("kind") == "character"
    ]
    scene_items = _snapshot_items(snapshot, "scenes")
    if not canon_characters and not overrides.characters and not scene_items:
        raise ApiError(
            "STORY_IMPORT_SOURCE_EMPTY",
            "取り込めるsnapshotも旧キャラ設定もありません。"
            "snapshotを同期するか、旧キャラ設定を登録してから取り込んでください。",
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            details={"project_id": project.id},
        )

    plan = _Plan()
    existing = list(
        await session.scalars(
            select(StoryCharacter).where(StoryCharacter.project_id == project.id)
        )
    )
    by_ref = {row.source_ref: row for row in existing if row.source_ref}
    by_name = {row.name.casefold(): row for row in existing}

    # 取り込み元の(名前, source_ref)の並びを作る。canonを先に、canonに無い旧キャラを後ろへ。
    overrides_by_name = {c.name.strip(): c for c in overrides.characters}
    sources: list[tuple[str, str, schemas.ProjectCharacterProfile | None]] = []
    matched: set[str] = set()
    for item in canon_characters:
        name = str(item.get("display_name") or "").strip()
        canon_id = str(item.get("canon_id") or "").strip()
        if not name or not canon_id:
            continue
        override = overrides_by_name.get(name)
        if override is not None:
            matched.add(override.id)
        sources.append((name, canon_id, override))
    sources.extend(
        (c.name.strip(), c.id, c) for c in overrides.characters if c.id not in matched
    )

    # 旧キャラidからv2のキャラidへの対応。シーンの登場キャラを紐づけるのに使う。
    legacy_to_v2: dict[str, str] = {}
    seen_refs: set[str] = set()
    seen_names: set[str] = set()
    for name, source_ref, override in sources:
        name = name[:MAX_NAME_LENGTH]
        if source_ref in seen_refs or name.casefold() in seen_names:
            continue
        seen_refs.add(source_ref)
        seen_names.add(name.casefold())
        current = by_ref.get(source_ref) or by_name.get(name.casefold())
        if current is not None:
            plan.skipped_characters += 1
            if override is not None:
                plan.skipped_costumes += len(override.outfits)
                legacy_to_v2[override.id] = current.id
            continue
        character = _CharacterPlan(
            id=schemas.new_id(),
            source_ref=source_ref,
            name=name,
            fixed_tags=_clean_tags(override.tags) if override else [],
            negative_tags=_split_tags(override.negative_prompt) if override else [],
            profile=_profile_text(override),
        )
        if override is not None:
            character.costumes = _plan_costumes(override, plan)
            legacy_to_v2[override.id] = character.id
        plan.characters.append(character)

    existing_scenes = {
        row.source_ref
        for row in await session.scalars(
            select(StoryScene).where(
                StoryScene.project_id == project.id,
                StoryScene.source_ref.is_not(None),
            )
        )
    }
    next_sequence = (
        int(
            await session.scalar(
                select(func.coalesce(func.max(StoryScene.sequence), 0)).where(
                    StoryScene.project_id == project.id
                )
            )
            or 0
        )
        + 1
    )
    seen_scenes: set[str] = set()
    for item in scene_items:
        scene_id = str(item.get("id") or "").strip()
        if not scene_id or scene_id in seen_scenes:
            continue
        seen_scenes.add(scene_id)
        if scene_id in existing_scenes:
            plan.skipped_scenes += 1
            continue
        detail = overrides.scene_details.get(scene_id)
        cast: list[str] = []
        for legacy_id in (detail.characters if detail else None) or []:
            v2_id = legacy_to_v2.get(legacy_id)
            if v2_id is not None and v2_id not in cast:
                cast.append(v2_id)
        plan.scenes.append(
            _ScenePlan(
                id=schemas.new_id(),
                source_ref=scene_id,
                name=scene_id[:MAX_NAME_LENGTH],
                sequence=next_sequence,
                summary=str(item.get("summary") or "")[:MAX_TEXT_LENGTH],
                background_text=((detail.location if detail else None) or "")[
                    :MAX_TEXT_LENGTH
                ],
                background_tags=_clean_tags(list(detail.tags or [])) if detail else [],
                time_of_day=_TIME_OF_DAY.get((detail.time_of_day or "").strip())
                if detail
                else None,
                cast_character_ids=cast,
            )
        )
        next_sequence += 1
    return plan


async def _load_project(session: AsyncSession, project_id: str) -> Project:
    project = await session.get(Project, project_id)
    if project is None:
        raise ApiError(
            "REFERENCE_NOT_FOUND",
            "Projectがありません。",
            status_code=status.HTTP_404_NOT_FOUND,
            details={"resource": "Project", "id": project_id},
        )
    return project


@router.post(
    "/{project_id}/story-import/preview", response_model=schemas.StoryImportResult
)
async def preview_story_import(project_id: schemas.AiMediaId, session: SessionDep):
    """取り込みで作る件数と、既にあるためスキップする件数を返す。DBは変えない。"""
    project = await _load_project(session, project_id)
    return (await _build_plan(session, project)).result()


@router.post("/{project_id}/story-import", response_model=schemas.StoryImportResult)
async def run_story_import(project_id: schemas.AiMediaId, session: SessionDep):
    """まだ無いキャラ・衣装・シーンを1トランザクションで作る。既にある行は変えない。"""
    project = await _load_project(session, project_id)
    if project.lifecycle == "trashed":
        raise ApiError(
            "PROJECT_TRASHED",
            "ゴミ箱のProjectは復元してから更新してください。",
            status_code=status.HTTP_409_CONFLICT,
            details={"project_id": project_id},
        )
    plan = await _build_plan(session, project)
    # created_atの昇順が取り込み順になるよう、1件ごとに1マイクロ秒ずつずらす。
    base = datetime.now().astimezone()

    def stamp(index: int) -> str:
        return (base + timedelta(microseconds=index)).isoformat()

    for index, character in enumerate(plan.characters):
        now = stamp(index)
        session.add(
            StoryCharacter(
                id=character.id,
                project_id=project_id,
                name=character.name,
                fixed_tags=character.fixed_tags,
                negative_tags=character.negative_tags,
                profile=character.profile,
                source_ref=character.source_ref,
                created_at=now,
                updated_at=now,
            )
        )
    await session.flush()
    costume_index = 0
    for character in plan.characters:
        for costume in character.costumes:
            now = stamp(costume_index)
            costume_index += 1
            session.add(
                StoryCostume(
                    id=costume.id,
                    character_id=character.id,
                    name=costume.name,
                    tags=costume.tags,
                    negative_tags=[],
                    description=costume.description,
                    created_at=now,
                    updated_at=now,
                )
            )
    await session.flush()
    for character in plan.characters:
        for costume in character.costumes:
            for position, key in enumerate(costume.image_keys):
                session.add(
                    StoryCostumeImage(
                        id=schemas.new_id(),
                        costume_id=costume.id,
                        position=position,
                        media_key=key,
                        created_at=base.isoformat(),
                    )
                )
    for index, scene in enumerate(plan.scenes):
        now = stamp(index)
        session.add(
            StoryScene(
                id=scene.id,
                project_id=project_id,
                parent_scene_id=None,
                name=scene.name,
                sequence=scene.sequence,
                summary=scene.summary,
                background_text=scene.background_text,
                background_tags=scene.background_tags,
                time_of_day=scene.time_of_day,
                bgm_mood="",
                video_motion="",
                source_ref=scene.source_ref,
                created_at=now,
                updated_at=now,
            )
        )
    await session.flush()
    for scene in plan.scenes:
        for position, character_id in enumerate(scene.cast_character_ids):
            session.add(
                StorySceneCast(
                    id=schemas.new_id(),
                    scene_id=scene.id,
                    position=position,
                    character_id=character_id,
                    costume_id=None,
                    pose_text="",
                    pose_tags=[],
                    expression_text="",
                    expression_tags=[],
                )
            )
    try:
        await session.commit()
    except IntegrityError as error:
        await session.rollback()
        raise ApiError(
            "STORY_IMPORT_CONFLICT",
            "取り込み中にキャラクターかシーンが変更されました。やり直してください。",
            status_code=status.HTTP_409_CONFLICT,
        ) from error
    return plan.result()
