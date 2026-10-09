"""novel-writerのsnapshotと旧キャラ設定から、v2のキャラ・衣装・シーンを作る取り込み (#630)。

キャラとシーンの正本はMyComfyUIで、novel-writerからは取り込むだけにする。再取り込みでは、
まだ無い分だけを足し、既にある行 (`source_ref`が一致する行、またはキャラは同名の行) と
その配下の衣装には触れない。v2でキャラやシーンを削除すると`source_ref`も行と一緒に消える
ため、次の取り込みでは「まだ無い分」として作り直される (仕様)。preview (件数だけ) と実行は
同じ計画 (`_build_plan`) から作る。

対応:
- キャラ: snapshotの`canon.items`のうち`kind=character`。同名の`local_overrides.characters`が
  あればその内容を使う。canonに無い旧キャラも取り込む。
- 衣装: 旧キャラの`outfits`。取り込むのは新しく作るキャラの分だけ。
- シーン: snapshotの`scenes.items`。`local_overrides.scene_details`があれば背景・時間帯・
  登場キャラを入れる。canonの`location`は背景に使わない。
"""

import asyncio
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import ValidationError
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
from mycomfyui_api.story import INPUT_KEY_PREFIX

router = APIRouter(prefix="/api/v1/projects", tags=["story"])
SessionDep = Annotated[AsyncSession, Depends(get_session)]

_TAG_SEPARATORS = re.compile(r"[,、，。\n]")
#: 画像の種別判定に読む先頭のバイト数。story.pyの登録経路と同じ。
_IMAGE_HEADER_BYTES = 32
#: 422のdetailsに載せる検証エラーの最大件数。
_MAX_REPORTED_ERRORS = 20

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
class _CharacterSource:
    """取り込み元の1キャラ。canonだけ・旧キャラだけ・両方のどれもありうる。"""

    name: str
    source_ref: str
    legacy: schemas.ProjectCharacterProfile | None


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
    duplicated_characters: int = 0
    duplicated_costumes: int = 0
    duplicated_scenes: int = 0
    images_imported: int = 0
    images_not_imported: int = 0

    @property
    def created_costumes(self) -> int:
        return sum(len(character.costumes) for character in self.characters)

    def result(self) -> schemas.StoryImportResult:
        return schemas.StoryImportResult(
            characters=schemas.StoryImportCounts(
                created=len(self.characters),
                skipped=self.skipped_characters,
                duplicated=self.duplicated_characters,
            ),
            costumes=schemas.StoryImportCounts(
                created=self.created_costumes,
                skipped=self.skipped_costumes,
                duplicated=self.duplicated_costumes,
            ),
            scenes=schemas.StoryImportCounts(
                created=len(self.scenes),
                skipped=self.skipped_scenes,
                duplicated=self.duplicated_scenes,
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


def _is_control(character: str) -> bool:
    return ord(character) < 0x20 or ord(character) == 0x7F


def _clean_name(value: Any, fallback: str) -> str:
    """v2の名前に使える形へ整える。制御文字を除き、上限で切る。空になれば`fallback`。"""
    text = "".join(c for c in str(value) if not _is_control(c)).strip()
    text = text[: schemas.STORY_NAME_MAX_LENGTH].strip()
    return text or fallback[: schemas.STORY_NAME_MAX_LENGTH]


def _name_key(name: str) -> str:
    """名前の照合キー。既存行との照合 (大文字小文字を区別しない) と同じ基準にする。"""
    return name.casefold()


def _clean_tags(values: list[str]) -> list[str]:
    """v2のタグに使える形へ整える。空と制御文字を含むものを除き、重複を落とす。"""
    tags: list[str] = []
    for value in values:
        tag = str(value).strip()[: schemas.STORY_TAG_MAX_LENGTH].strip()
        if not tag or any(_is_control(c) for c in tag):
            continue
        if tag not in tags:
            tags.append(tag)
    return tags[: schemas.STORY_TAGS_MAX]


def _split_tags(text: str | None) -> list[str]:
    """読点・句点・カンマ区切りの文章をタグへ分ける。"""
    if not text:
        return []
    return _clean_tags(_TAG_SEPARATORS.split(text))


def _profile_text(legacy: schemas.ProjectCharacterProfile | None) -> str:
    """旧キャラのプロフィールと外見・声質の文章を、v2の`profile`1本へまとめる。"""
    if legacy is None:
        return ""
    lines: list[str] = []
    if legacy.appearance:
        lines.append(f"外見: {legacy.appearance}")
    personal = legacy.profile
    if personal is not None:
        for attribute, label in _PROFILE_LABELS:
            value = getattr(personal, attribute)
            if value:
                lines.append(f"{label}: {value}")
        lines.extend(f"{item.key}: {item.value}" for item in personal.extra)
    if legacy.voice:
        lines.append(f"声質: {legacy.voice}")
    return "\n".join(lines)[: schemas.STORY_TEXT_MAX_LENGTH]


def _image_key(relative_path: str) -> str | None:
    """旧参照画像を`input:<path>`にできるか。入力cacheに画像のファイルが無ければNone。

    旧`ProjectReferenceImage.relative_path`はdata_root基準の`inputs/<sha256>/<name>`で、
    v2の`input:<relative_path>`が指す場所と同じ。実ファイルが無い、または画像でないと
    表示できないため、story.pyの登録経路と同じ判定で確かめてから入れる。ファイルを読む
    ので、呼び出し側はスレッドに出す。
    """
    try:
        relative = schemas.input_cache_relative_path(relative_path)
        path = storage.resolve_input(relative)
        with path.open("rb") as handle:
            header = handle.read(_IMAGE_HEADER_BYTES)
    except (ValueError, storage.StorageError, OSError):
        return None
    if storage.detect_image_media_type(header) is None:
        return None
    return f"{INPUT_KEY_PREFIX}{relative}"


async def _attach_image(costume: _CostumePlan, relative_path: str, plan: _Plan) -> None:
    key = await asyncio.to_thread(_image_key, relative_path)
    if key is None:
        plan.images_not_imported += 1
    elif key not in costume.image_keys:
        costume.image_keys.append(key)
        plan.images_imported += 1


async def _plan_costumes(
    legacy: schemas.ProjectCharacterProfile, plan: _Plan
) -> list[_CostumePlan]:
    costumes: list[_CostumePlan] = []
    by_outfit_id: dict[str, _CostumePlan] = {}
    for outfit in legacy.outfits:
        name = _clean_name(outfit.name, outfit.id)
        if any(_name_key(c.name) == _name_key(name) for c in costumes):
            plan.duplicated_costumes += 1
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
            await _attach_image(costume, outfit.image.relative_path, plan)
    # 旧キャラの参照画像は、既定の衣装 (無ければ先頭の衣装) の参照画像へ入れる。
    holder = by_outfit_id.get(legacy.default_outfit_id or "") or (
        costumes[0] if costumes else None
    )
    for image in legacy.reference_images:
        if holder is None:
            plan.images_not_imported += 1
            continue
        await _attach_image(holder, image.relative_path, plan)
    return costumes


def _parse_overrides(project: Project) -> schemas.ProjectLocalOverrides:
    try:
        return schemas.ProjectLocalOverrides.model_validate(
            project.local_overrides or {}
        )
    except ValidationError as error:
        errors = [
            {"loc": list(item["loc"]), "msg": item["msg"]}
            for item in error.errors()[:_MAX_REPORTED_ERRORS]
        ]
        raise ApiError(
            "STORY_IMPORT_SOURCE_INVALID",
            "旧キャラ設定を読み込めません。旧キャラ設定を直してから再実行してください。",
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            details={"project_id": project.id, "errors": errors},
        ) from error


def _collect_character_sources(
    canon_characters: list[dict[str, Any]],
    overrides: schemas.ProjectLocalOverrides,
    plan: _Plan,
) -> tuple[list[_CharacterSource], dict[str, str]]:
    """canonと旧キャラを名前でつなぎ、取り込み元のキャラ一覧を作る。

    canonの並びを先に、canonに無い旧キャラを後ろに置く。同名 (大文字小文字を区別しない)
    が重なったときは先のものを採り、落とした分を`plan.duplicated_characters`に数える。
    返す辞書は、落とした旧キャラのidから採った旧キャラのidへの対応。
    """
    legacy_by_key: dict[str, schemas.ProjectCharacterProfile] = {}
    aliases: dict[str, str] = {}
    for legacy in overrides.characters:
        key = _name_key(_clean_name(legacy.name, legacy.id))
        kept = legacy_by_key.setdefault(key, legacy)
        if kept is not legacy:
            aliases[legacy.id] = kept.id
            plan.duplicated_characters += 1

    sources: list[_CharacterSource] = []
    used_keys: set[str] = set()
    for item in canon_characters:
        canon_id = str(item.get("canon_id") or "").strip()
        raw_name = str(item.get("display_name") or "").strip()
        if not canon_id or not raw_name:
            continue
        name = _clean_name(raw_name, canon_id)
        key = _name_key(name)
        if key in used_keys:
            plan.duplicated_characters += 1
            continue
        used_keys.add(key)
        sources.append(_CharacterSource(name, canon_id, legacy_by_key.get(key)))
    for key, legacy in legacy_by_key.items():
        if key not in used_keys:
            used_keys.add(key)
            sources.append(
                _CharacterSource(_clean_name(legacy.name, legacy.id), legacy.id, legacy)
            )
    return sources, aliases


async def _plan_characters(
    session: AsyncSession,
    project_id: str,
    sources: list[_CharacterSource],
    aliases: dict[str, str],
    plan: _Plan,
) -> dict[str, str]:
    """まだ無いキャラと衣装の計画を作る。返す辞書は旧キャラidからv2のキャラidへの対応。"""
    existing = list(
        await session.scalars(
            select(StoryCharacter).where(StoryCharacter.project_id == project_id)
        )
    )
    by_ref = {row.source_ref: row for row in existing if row.source_ref}
    by_name = {_name_key(row.name): row for row in existing}
    legacy_to_v2: dict[str, str] = {}
    for source in sources:
        legacy = source.legacy
        current = by_ref.get(source.source_ref) or by_name.get(_name_key(source.name))
        if current is not None:
            plan.skipped_characters += 1
            if legacy is not None:
                plan.skipped_costumes += len(legacy.outfits)
                legacy_to_v2[legacy.id] = current.id
            continue
        character = _CharacterPlan(
            id=schemas.new_id(),
            source_ref=source.source_ref,
            name=source.name,
            fixed_tags=_clean_tags(legacy.tags) if legacy else [],
            negative_tags=_split_tags(legacy.negative_prompt) if legacy else [],
            profile=_profile_text(legacy),
        )
        if legacy is not None:
            character.costumes = await _plan_costumes(legacy, plan)
            legacy_to_v2[legacy.id] = character.id
        plan.characters.append(character)
    for dropped, kept in aliases.items():
        if kept in legacy_to_v2:
            legacy_to_v2[dropped] = legacy_to_v2[kept]
    return legacy_to_v2


async def _plan_scenes(
    session: AsyncSession,
    project_id: str,
    scene_items: list[dict[str, Any]],
    overrides: schemas.ProjectLocalOverrides,
    legacy_to_v2: dict[str, str],
    plan: _Plan,
) -> None:
    """まだ無いシーンの計画を作る。並びはsnapshotの順で、既存の最大の`sequence`の次から振る。"""
    existing_refs = set(
        await session.scalars(
            select(StoryScene.source_ref).where(
                StoryScene.project_id == project_id,
                StoryScene.source_ref.is_not(None),
            )
        )
    )
    last_sequence = await session.scalar(
        select(func.coalesce(func.max(StoryScene.sequence), 0)).where(
            StoryScene.project_id == project_id
        )
    )
    next_sequence = int(last_sequence or 0) + 1
    seen: set[str] = set()
    for item in scene_items:
        scene_id = str(item.get("id") or "").strip()
        if not scene_id:
            continue
        if scene_id in seen:
            plan.duplicated_scenes += 1
            continue
        seen.add(scene_id)
        if scene_id in existing_refs:
            plan.skipped_scenes += 1
            continue
        detail = overrides.scene_details.get(scene_id) or schemas.SceneDetail()
        cast: list[str] = []
        for legacy_id in detail.characters or []:
            v2_id = legacy_to_v2.get(legacy_id)
            if v2_id is not None and v2_id not in cast:
                cast.append(v2_id)
        time_of_day = (detail.time_of_day or "").strip().casefold()
        plan.scenes.append(
            _ScenePlan(
                id=schemas.new_id(),
                source_ref=scene_id,
                name=_clean_name(scene_id, f"scene-{next_sequence}"),
                sequence=next_sequence,
                summary=str(item.get("summary") or "")[: schemas.STORY_TEXT_MAX_LENGTH],
                background_text=(detail.location or "")[
                    : schemas.STORY_TEXT_MAX_LENGTH
                ],
                background_tags=_clean_tags(list(detail.tags or [])),
                time_of_day=_TIME_OF_DAY.get(time_of_day),
                cast_character_ids=cast[: schemas.STORY_CAST_MAX],
            )
        )
        next_sequence += 1


async def _build_plan(session: AsyncSession, project: Project) -> _Plan:
    snapshot = project.source_snapshot or {}
    overrides = _parse_overrides(project)
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
    sources, aliases = _collect_character_sources(canon_characters, overrides, plan)
    legacy_to_v2 = await _plan_characters(session, project.id, sources, aliases, plan)
    await _plan_scenes(session, project.id, scene_items, overrides, legacy_to_v2, plan)
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


def _stamp(base: datetime, index: int) -> str:
    """作成日時。昇順が取り込み順になるよう、1件ごとに1マイクロ秒ずつずらす。"""
    return (base + timedelta(microseconds=index)).isoformat()


async def _apply_plan(session: AsyncSession, project_id: str, plan: _Plan) -> None:
    """計画の行を追加する。一意制約違反はflushで出るため、呼び出し側でまとめて受ける。"""
    base = datetime.now().astimezone()
    for index, character in enumerate(plan.characters):
        now = _stamp(base, index)
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
            now = _stamp(base, costume_index)
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
            for position, key in enumerate(costume.image_keys):
                session.add(
                    StoryCostumeImage(
                        id=schemas.new_id(),
                        costume_id=costume.id,
                        position=position,
                        media_key=key,
                        created_at=now,
                    )
                )
    await session.flush()
    for index, scene in enumerate(plan.scenes):
        now = _stamp(base, index)
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
    await session.flush()


@router.post(
    "/{project_id}/story-import/preview", response_model=schemas.StoryImportResult
)
async def preview_story_import(project_id: schemas.AiMediaId, session: SessionDep):
    """取り込みで作る件数と、既にあるためスキップする件数を返す。DBは変えない。

    DBを変えないので、ゴミ箱のProjectでも通す。復元してから取り込むかを、件数を見て決められる。
    """
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
    try:
        await _apply_plan(session, project_id, plan)
        await session.commit()
    except IntegrityError as error:
        await session.rollback()
        raise ApiError(
            "STORY_IMPORT_CONFLICT",
            "取り込み中にキャラクターかシーンが変更されました。やり直してください。",
            status_code=status.HTTP_409_CONFLICT,
        ) from error
    return plan.result()
