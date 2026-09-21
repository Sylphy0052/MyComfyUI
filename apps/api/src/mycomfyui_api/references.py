"""ai-media参照APIの中継Endpoint。

読取りだけを提供する。`novel-writer`側のデータを変更する経路は持たない。応答は上流の
契約(`contracts/ai-media/v1/openapi.yaml`)の本文をそのまま返し、MyComfyUI側で形を
変えない。上流が未稼働の間は同梱fixtureが同じ形で応答する。
"""

import logging
from collections.abc import Awaitable, Callable
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Path, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette import status

from mycomfyui_api.adapters.aimedia.client import (
    AiMediaNotFound,
    AiMediaUnavailable,
    ReferenceSource,
)
from mycomfyui_api.db import get_session
from mycomfyui_api.errors import ApiError
from mycomfyui_api.models import Project, ProjectScene, ProjectShot
from mycomfyui_api.schemas import CANON_ID_PATTERN, REFERENCE_ID_PATTERN
from mycomfyui_api.structure import (
    get_local_scene,
    get_local_shot,
    scene_envelope,
    scene_summary,
    shot_envelope,
    shot_summary,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1")

#: 参照IDの書式は`schemas`を正本とする。上流URLのパスセグメントへ埋め込む値のため、
#: `.`や`..`が混ざらないよう、要求を受け取る時点で弾く。
ReferenceId = Annotated[str, Path(pattern=REFERENCE_ID_PATTERN)]

CanonId = Annotated[str, Path(pattern=CANON_ID_PATTERN)]


def get_reference_source(request: Request) -> ReferenceSource:
    return request.app.state.reference_source


ReferenceSourceDep = Annotated[ReferenceSource, Depends(get_reference_source)]
SessionDep = Annotated[AsyncSession, Depends(get_session)]


async def _relay(call: Callable[[], Awaitable[dict[str, Any]]]) -> dict[str, Any]:
    """参照Adapterの例外を共通Envelopeへ変換する。

    上流の不調(503)と、指定した資源が無いこと(404)を画面が区別できるようにする。
    """
    try:
        return await call()
    except AiMediaNotFound as error:
        raise ApiError(
            "REFERENCE_NOT_FOUND",
            str(error),
            status_code=status.HTTP_404_NOT_FOUND,
        ) from error
    except AiMediaUnavailable as error:
        logger.warning("ai-media参照APIを利用できません。", exc_info=error)
        raise ApiError(
            "REFERENCE_UNAVAILABLE",
            "ai-media参照APIを利用できませんでした。",
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        ) from error


async def _external_or_cached(
    project: Project,
    call: Callable[[], Awaitable[dict[str, Any]]],
    cached: Callable[[dict[str, Any]], dict[str, Any] | None],
) -> dict[str, Any]:
    """参照元が停止中なら、最後に同期したスナップショットを返す。"""
    try:
        return await call()
    except AiMediaNotFound as error:
        raise ApiError(
            "REFERENCE_NOT_FOUND",
            str(error),
            status_code=status.HTTP_404_NOT_FOUND,
        ) from error
    except AiMediaUnavailable as error:
        snapshot = project.source_snapshot or {}
        fallback = cached(snapshot)
        if fallback is not None:
            logger.info("外部参照を同期済みキャッシュから返します: %s", project.id)
            return fallback
        logger.warning("ai-media参照APIを利用できません。", exc_info=error)
        raise ApiError(
            "REFERENCE_UNAVAILABLE",
            "ai-media参照APIを利用できませんでした。",
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        ) from error


def _cached_dict(snapshot: dict[str, Any], key: str) -> dict[str, Any] | None:
    value = snapshot.get(key)
    return value if isinstance(value, dict) else None


async def _require_project(session: AsyncSession, project_id: str) -> Project:
    project = await session.get(Project, project_id)
    if project is None or project.lifecycle == "trashed":
        raise ApiError(
            "PROJECT_NOT_FOUND",
            "Projectがありません。",
            status_code=status.HTTP_404_NOT_FOUND,
            details={"project_id": project_id},
        )
    return project


def _external_id(project: Project) -> str:
    if project.source_type != "external" or project.external_id is None:
        raise ApiError(
            "PROJECT_HAS_NO_EXTERNAL_SOURCE",
            "ローカルProjectには外部参照データがありません。",
            status_code=status.HTTP_404_NOT_FOUND,
            details={"project_id": project.id},
        )
    return project.external_id


@router.get("/projects/{project_id}/scenes")
async def list_scenes(
    project_id: ReferenceId, source: ReferenceSourceDep, session: SessionDep
) -> dict[str, Any]:
    project = await _require_project(session, project_id)
    if project.source_type == "local":
        scenes = await session.scalars(
            select(ProjectScene)
            .where(
                ProjectScene.project_id == project_id,
                ProjectScene.deleted_at.is_(None),
            )
            .order_by(ProjectScene.sequence, ProjectScene.id)
        )
        return {"items": [await scene_summary(session, scene) for scene in scenes]}
    return await _external_or_cached(
        project,
        lambda: source.list_scenes(_external_id(project)),
        lambda snapshot: _cached_dict(snapshot, "scenes"),
    )


@router.get("/projects/{project_id}/scenes/{scene_id}")
async def get_scene(
    project_id: ReferenceId,
    scene_id: ReferenceId,
    source: ReferenceSourceDep,
    session: SessionDep,
) -> dict[str, Any]:
    project = await _require_project(session, project_id)
    if project.source_type == "local":
        return await scene_envelope(
            session, await get_local_scene(session, project_id, scene_id)
        )
    return await _external_or_cached(
        project,
        lambda: source.get_scene(_external_id(project), scene_id),
        lambda snapshot: (
            _cached_dict(snapshot, "scene_envelopes") or {}
        ).get(scene_id),
    )


@router.get("/projects/{project_id}/scenes/{scene_id}/shots")
async def list_shots(
    project_id: ReferenceId,
    scene_id: ReferenceId,
    source: ReferenceSourceDep,
    session: SessionDep,
) -> dict[str, Any]:
    project = await _require_project(session, project_id)
    if project.source_type == "local":
        await get_local_scene(session, project_id, scene_id)
        shots = await session.scalars(
            select(ProjectShot)
            .where(
                ProjectShot.project_id == project_id,
                ProjectShot.scene_id == scene_id,
                ProjectShot.deleted_at.is_(None),
            )
            .order_by(ProjectShot.sequence, ProjectShot.id)
        )
        return {"items": [shot_summary(shot) for shot in shots]}
    return await _external_or_cached(
        project,
        lambda: source.list_shots(_external_id(project), scene_id),
        lambda snapshot: (_cached_dict(snapshot, "shots") or {}).get(scene_id),
    )


@router.get("/projects/{project_id}/scenes/{scene_id}/shots/{shot_id}")
async def get_shot(
    project_id: ReferenceId,
    scene_id: ReferenceId,
    shot_id: ReferenceId,
    source: ReferenceSourceDep,
    session: SessionDep,
) -> dict[str, Any]:
    project = await _require_project(session, project_id)
    if project.source_type == "local":
        return shot_envelope(
            await get_local_shot(session, project_id, scene_id, shot_id)
        )
    return await _external_or_cached(
        project,
        lambda: source.get_shot(_external_id(project), scene_id, shot_id),
        lambda snapshot: (_cached_dict(snapshot, "shot_envelopes") or {}).get(
            shot_id
        ),
    )


#: Canon descriptorの種別。正本は`contracts/ai-media/v1/schema/reference-api.schema.json`。
CANON_KINDS = ("voice", "character", "location", "story", "preset", "media", "other")

CanonKind = Annotated[str | None, Query(pattern=f"^({'|'.join(CANON_KINDS)})$")]


@router.get("/projects/{project_id}/canon")
async def list_canon(
    project_id: ReferenceId,
    source: ReferenceSourceDep,
    session: SessionDep,
    kind: CanonKind = None,
) -> dict[str, Any]:
    """Canon descriptorを一覧する。`kind`を指定すると種別で絞り込む。

    上流の契約に`kind`クエリは無いため、絞り込みはMyComfyUI側で行う。参照APIには
    Voice Canon専用のEndpointが無く、画面は`CanonList`から絞り込む形になる。
    """
    project = await _require_project(session, project_id)
    if project.source_type == "local":
        return {"items": []}
    payload = await _external_or_cached(
        project,
        lambda: source.list_canon(_external_id(project)),
        lambda snapshot: _cached_dict(snapshot, "canon"),
    )
    if kind is None:
        return payload
    items = payload.get("items")
    if not isinstance(items, list):
        return payload
    return {
        **payload,
        "items": [
            item
            for item in items
            if isinstance(item, dict) and item.get("kind") == kind
        ],
    }


@router.get("/projects/{project_id}/canon/{canon_id}")
async def get_canon(
    project_id: ReferenceId,
    canon_id: CanonId,
    source: ReferenceSourceDep,
    session: SessionDep,
) -> dict[str, Any]:
    project = await _require_project(session, project_id)
    return await _external_or_cached(
        project,
        lambda: source.get_canon(_external_id(project), canon_id),
        lambda snapshot: next(
            (
                item
                for item in ((_cached_dict(snapshot, "canon") or {}).get("items") or [])
                if isinstance(item, dict) and item.get("canon_id") == canon_id
            ),
            None,
        ),
    )
