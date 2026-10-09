"""旧Shot・旧Sceneに紐づいた生成物を、取り込んだv2のシーンへ付け替える (#632)。

`Artifact.assigned_*`はFKの無い文字列で、旧UIのProject・Scene・Shotのidを持つ。#630で取り込んだ
`StoryScene`は`source_ref`にsnapshotのScene idを持つので、それで引いて`story_scene_id`を埋める。
preview (件数だけ) と実行は同じ計画 (`_build_plan`) から作る。

対応:
- `assigned_scene_id`があれば、同じProjectで`source_ref`が一致する`StoryScene`を探す。
- `assigned_scene_id`が無く`assigned_shot_id`だけがあれば、snapshotの`shots[<scene id>].items`から
  親のシーンを引いて同じように探す。
- `assigned_project_id`が空の生成物は、対象Projectのsnapshotがそのscene・shotを持つときだけ扱う。
  他のProjectのsnapshotも同じscene・shotを持つときは、どのProjectか決められないので変えない。
  付け替えるときは`assigned_project_id`もあわせて埋める。
- 既に`story_scene_id`がある生成物と、ゴミ箱 (`deleted_at`あり) の生成物は変えない。ゴミ箱の
  生成物は、復元してからもう一度実行すれば付く。
- キャラ・衣装 (`story_character_id`、`story_costume_id`) は埋めない。
"""

import logging
from dataclasses import dataclass, field
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from starlette import status

from mycomfyui_api import schemas
from mycomfyui_api.db import get_session
from mycomfyui_api.errors import ApiError
from mycomfyui_api.models import Artifact, Project, StoryScene

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/projects", tags=["story"])
SessionDep = Annotated[AsyncSession, Depends(get_session)]

#: `IN`句に渡すidの最大数。SQLiteのhost parameter上限の手前で分ける。
_IN_CHUNK = 500


@dataclass
class _Plan:
    #: 付け替え先ごとの (対象のartifact id, Projectも埋めるか)。
    links: dict[str, list[tuple[str, bool]]] = field(default_factory=dict)
    scene_not_imported: int = 0
    shot_unknown: int = 0
    project_ambiguous: int = 0
    already_linked: int = 0
    trashed: int = 0

    @property
    def linked(self) -> int:
        return sum(len(entries) for entries in self.links.values())

    @property
    def project_filled(self) -> int:
        return sum(1 for entries in self.links.values() for _, fill in entries if fill)

    def result(self) -> schemas.LegacyLinkResult:
        return schemas.LegacyLinkResult(
            linked=self.linked,
            project_filled=self.project_filled,
            unmatched=schemas.LegacyLinkUnmatched(
                scene_not_imported=self.scene_not_imported,
                shot_unknown=self.shot_unknown,
                project_ambiguous=self.project_ambiguous,
            ),
            skipped=schemas.LegacyLinkSkipped(
                already_linked=self.already_linked, trashed=self.trashed
            ),
        )


def _clean(value: str | None) -> str | None:
    text = (value or "").strip()
    return text or None


def _scene_ids(snapshot: Any) -> set[str]:
    block = snapshot.get("scenes") if isinstance(snapshot, dict) else None
    items = block.get("items") if isinstance(block, dict) else None
    if not isinstance(items, list):
        return set()
    return {
        str(item["id"]).strip()
        for item in items
        if isinstance(item, dict) and str(item.get("id") or "").strip()
    }


def _shot_parents(snapshot: Any) -> dict[str, str]:
    """snapshotの`shots[<scene id>].items`から、Shot idと親のScene idの対応を作る。

    同じShot idが複数のシーンにあるとき (通常は無い) は、先に見つかった方を採る。
    """
    shots = snapshot.get("shots") if isinstance(snapshot, dict) else None
    if not isinstance(shots, dict):
        return {}
    parents: dict[str, str] = {}
    for scene_id, block in shots.items():
        items = block.get("items") if isinstance(block, dict) else None
        if not isinstance(items, list):
            continue
        for item in items:
            shot_id = (
                str(item.get("id") or "").strip() if isinstance(item, dict) else ""
            )
            if shot_id:
                parents.setdefault(shot_id, str(scene_id))
    return parents


async def _other_claims(
    session: AsyncSession, project_id: str
) -> tuple[set[str], set[str]]:
    """他のProjectのsnapshotが持つScene idとShot id。Project無しの生成物の曖昧さ判定に使う。"""
    rows = await session.execute(
        select(Project.source_snapshot).where(Project.id != project_id)
    )
    scene_ids: set[str] = set()
    shot_ids: set[str] = set()
    for (snapshot,) in rows:
        scene_ids |= _scene_ids(snapshot)
        shot_ids |= set(_shot_parents(snapshot))
    return scene_ids, shot_ids


async def _build_plan(session: AsyncSession, project: Project) -> _Plan:
    snapshot = project.source_snapshot or {}
    snapshot_scenes = _scene_ids(snapshot)
    shot_parents = _shot_parents(snapshot)
    scene_by_ref = {
        ref: scene_id
        for scene_id, ref in await session.execute(
            select(StoryScene.id, StoryScene.source_ref).where(
                StoryScene.project_id == project.id,
                StoryScene.source_ref.is_not(None),
            )
        )
    }
    other_scenes, other_shots = await _other_claims(session, project.id)
    rows = await session.execute(
        select(
            Artifact.id,
            Artifact.assigned_project_id,
            Artifact.assigned_scene_id,
            Artifact.assigned_shot_id,
            Artifact.story_scene_id,
            Artifact.deleted_at,
        )
        .where(
            or_(
                Artifact.assigned_project_id == project.id,
                Artifact.assigned_project_id.is_(None),
                Artifact.assigned_project_id == "",
            ),
            or_(
                Artifact.assigned_scene_id.is_not(None),
                Artifact.assigned_shot_id.is_not(None),
            ),
        )
        .order_by(Artifact.created_at, Artifact.id)
    )
    plan = _Plan()
    for artifact_id, owner, scene_ref, shot_ref, linked_scene, deleted_at in rows:
        owner = _clean(owner)
        scene_ref = _clean(scene_ref)
        shot_ref = _clean(shot_ref)
        if scene_ref is None and shot_ref is None:
            continue
        # Project無しの生成物は、このProjectのsnapshotが持つscene・shotのときだけ扱う。
        # 他のProjectの分は、そのProjectで実行したときに扱う。
        if owner is None:
            known = (
                scene_ref in snapshot_scenes
                if scene_ref is not None
                else shot_ref in shot_parents
            )
            if not known:
                continue
        if deleted_at is not None:
            plan.trashed += 1
            continue
        if linked_scene is not None:
            plan.already_linked += 1
            continue
        if owner is None and (
            (scene_ref is not None and scene_ref in other_scenes)
            or (scene_ref is None and shot_ref in other_shots)
        ):
            plan.project_ambiguous += 1
            continue
        if scene_ref is None:
            scene_ref = shot_parents.get(shot_ref or "")
            if scene_ref is None:
                plan.shot_unknown += 1
                continue
        target = scene_by_ref.get(scene_ref)
        if target is None:
            plan.scene_not_imported += 1
            continue
        plan.links.setdefault(target, []).append((artifact_id, owner is None))
    return plan


def _chunks(values: list[str]) -> list[list[str]]:
    return [values[i : i + _IN_CHUNK] for i in range(0, len(values), _IN_CHUNK)]


async def _apply_plan(
    session: AsyncSession, project_id: str, plan: _Plan
) -> tuple[int, int]:
    """計画どおりに更新し、実際に更新した (linked, project_filled) を返す。

    条件に`story_scene_id IS NULL`を入れ、計画後に別経路で付いた生成物を上書きしない。
    """
    linked = 0
    filled = 0
    for scene_id, entries in plan.links.items():
        for fill in (False, True):
            ids = [artifact_id for artifact_id, f in entries if f is fill]
            for chunk in _chunks(ids):
                values: dict[str, Any] = {"story_scene_id": scene_id}
                conditions = [
                    Artifact.id.in_(chunk),
                    Artifact.story_scene_id.is_(None),
                    Artifact.deleted_at.is_(None),
                ]
                if fill:
                    values["assigned_project_id"] = project_id
                    conditions.append(
                        or_(
                            Artifact.assigned_project_id.is_(None),
                            Artifact.assigned_project_id == "",
                        )
                    )
                else:
                    conditions.append(Artifact.assigned_project_id == project_id)
                outcome = await session.execute(
                    update(Artifact).where(*conditions).values(**values)
                )
                linked += outcome.rowcount or 0
                if fill:
                    filled += outcome.rowcount or 0
    return linked, filled


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
    "/{project_id}/legacy-links/preview", response_model=schemas.LegacyLinkResult
)
async def preview_legacy_links(project_id: schemas.AiMediaId, session: SessionDep):
    """付け替える件数と、対応するシーンが無く変えない件数 (理由ごと) を返す。DBは変えない。

    DBを変えないので、ゴミ箱のProjectでも通す。
    """
    project = await _load_project(session, project_id)
    return (await _build_plan(session, project)).result()


@router.post("/{project_id}/legacy-links", response_model=schemas.LegacyLinkResult)
async def run_legacy_links(project_id: schemas.AiMediaId, session: SessionDep):
    """旧生成物の`story_scene_id`を1トランザクションで埋める。既に付いた生成物は変えない。"""
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
        linked, filled = await _apply_plan(session, project_id, plan)
        await session.commit()
    except Exception:
        await session.rollback()
        logger.exception("legacy-linksの更新に失敗しました: %s", project_id)
        raise
    # 計画後に別経路で付いた分があれば、実際に更新した件数を返す。
    return plan.result().model_copy(
        update={"linked": linked, "project_filled": filled}
    )
