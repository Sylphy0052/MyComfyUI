"""親Jobの完了後に自動で投入する後続Job (#581)。

「プロンプトだけ」の動画生成は、画像Jobが成功したらその画像を開始フレームにしたi2v
Jobを投入する。ブラウザを閉じても2段目が走るよう、予約はDBの`generation_job_followup`
に持ち、workerのループが「親Jobが終端になったpendingの予約」を拾って処理する。
Job完了の瞬間だけに頼らないのは、cancel APIがqueuedのJobをworkerを通さずにcancelled
にすることと、プロセス再起動をまたいだ予約も同じ経路で拾いたいことによる。
"""

import logging
from collections.abc import Callable

from fastapi import APIRouter
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette import status

from mycomfyui_api import schemas
from mycomfyui_api.errors import ApiError
from mycomfyui_api.models import Artifact, GenerationJob, GenerationJobFollowup
from mycomfyui_api.adapters.aimedia.client import ReferenceSource
from mycomfyui_api.routers import (
    ReferenceSourceDep,
    SessionDep,
    _commit,
    _get_or_404,
    _resolve_generation_defaults,
    _resolve_references,
    _submit_generation_job,
    _validate_project_context,
    _validate_story_links_of,
    _validation_error,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1")

#: 親Jobの終端状態。ここへ入った予約だけをsweepで処理する。
TERMINAL_JOB_STATES = ("succeeded", "failed", "cancelled")

#: 1回のsweepで処理する予約の上限。
SWEEP_LIMIT = 20

#: 失敗理由として保存する文言の最大長。
MAX_FAILURE_MESSAGE_CHARS = 500

#: 後続のi2v Jobが開始フレームを受ける入力名。
FIRST_FRAME_INPUT = "first_frame"


def _failure_text(error: Exception) -> str:
    message = error.message if isinstance(error, ApiError) else str(error)
    return (message or error.__class__.__name__)[:MAX_FAILURE_MESSAGE_CHARS]


async def _finish_followup(
    session: AsyncSession,
    followup: GenerationJobFollowup,
    state: str,
    message: str | None,
) -> None:
    followup.state = state
    followup.failure_message = message
    followup.updated_at = schemas.now_iso()
    await session.commit()


async def _first_image_artifact_id(session: AsyncSession, job_id: str) -> str | None:
    return await session.scalar(
        select(Artifact.id)
        .where(
            Artifact.job_id == job_id,
            Artifact.kind == "image",
            Artifact.availability == "complete",
            Artifact.deleted_at.is_(None),
        )
        .order_by(Artifact.created_at, Artifact.id)
        .limit(1)
    )


async def _record_submit_failure(
    session_factory: async_sessionmaker[AsyncSession],
    followup_id: str,
    error: Exception,
) -> None:
    """投入の失敗を予約へ残す。投入のcommit後に失敗した場合は、作成済みのJobを紐づける。

    `state="submitted"`への更新はJob作成と同じcommitに乗る。そのため、読み直して
    `submitted`なら失敗はJob作成より後で起きており、Jobは存在する。
    """
    async with session_factory() as session:
        followup = await session.get(GenerationJobFollowup, followup_id)
        if followup is None:
            return
        if followup.state == "submitted":
            child_id = await session.scalar(
                select(GenerationJob.id)
                .where(GenerationJob.parent_job_id == followup.parent_job_id)
                .order_by(GenerationJob.queue_sequence.desc())
                .limit(1)
            )
            if child_id is not None:
                followup.child_job_id = child_id
                followup.updated_at = schemas.now_iso()
                await session.commit()
                return
        await _finish_followup(session, followup, "failed", _failure_text(error))


async def _dispatch_one(
    session_factory: async_sessionmaker[AsyncSession],
    source: ReferenceSource,
    followup_id: str,
) -> None:
    async with session_factory() as session:
        followup = await session.get(GenerationJobFollowup, followup_id)
        if followup is None or followup.state != "pending":
            return
        parent = await session.get(GenerationJob, followup.parent_job_id)
        if parent is None or parent.state not in TERMINAL_JOB_STATES:
            return
        if parent.state != "succeeded":
            await _finish_followup(
                session,
                followup,
                "skipped",
                f"1段目のJobが{parent.state}のため、2段目は投入しませんでした。",
            )
            return
        artifact_id = await _first_image_artifact_id(session, parent.id)
        if artifact_id is None:
            await _finish_followup(
                session, followup, "failed", "1段目のJobに画像の生成物がありません。"
            )
            return
        parent_id = parent.id
        body = dict(followup.payload)
        body["parent_job_id"] = parent_id
        body["inputs"] = {
            **(body.get("inputs") or {}),
            FIRST_FRAME_INPUT: {"artifact_id": artifact_id},
        }
        try:
            payload = schemas.GenerationJobCreate.model_validate(body)
            # 二重投入を避けるため、submittedへの更新をJob作成のcommitへ相乗りさせる。
            followup.state = "submitted"
            followup.updated_at = schemas.now_iso()
            job = await _submit_generation_job(session, source, payload)
            child_id = job.id
        except Exception as error:
            await session.rollback()
            logger.warning(
                "後続Jobの投入に失敗しました。followup=%s", followup_id, exc_info=True
            )
            await _record_submit_failure(session_factory, followup_id, error)
            return
        followup.child_job_id = child_id
        followup.updated_at = schemas.now_iso()
        await session.commit()


async def dispatch_pending_followups(
    session_factory: async_sessionmaker[AsyncSession],
    reference_source_getter: Callable[[], ReferenceSource | None],
) -> int:
    """親Jobが終端になったpendingの予約を処理し、処理した件数を返す。

    参照Adapterがまだ無い (起動途中) ときは投入できないため、次のtickへ回す。
    """
    async with session_factory() as session:
        rows = (
            (
                await session.execute(
                    select(GenerationJobFollowup.id)
                    .join(
                        GenerationJob,
                        GenerationJob.id == GenerationJobFollowup.parent_job_id,
                    )
                    .where(
                        GenerationJobFollowup.state == "pending",
                        GenerationJob.state.in_(TERMINAL_JOB_STATES),
                    )
                    .order_by(GenerationJobFollowup.created_at)
                    .limit(SWEEP_LIMIT)
                )
            )
            .scalars()
            .all()
        )
    if not rows:
        return 0
    source = reference_source_getter()
    if source is None:
        return 0
    for followup_id in rows:
        try:
            await _dispatch_one(session_factory, source, followup_id)
        except Exception:
            logger.exception(
                "後続Jobの処理で例外が発生しました。followup=%s", followup_id
            )
    return len(rows)


@router.post(
    "/prompt-only-video-jobs",
    response_model=schemas.PromptOnlyVideoJobRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_prompt_only_video_job(
    payload: schemas.PromptOnlyVideoJobCreate,
    session: SessionDep,
    source: ReferenceSourceDep,
):
    """画像Jobを投入し、成功後にそのまま開始フレームにするi2v Jobを予約する。

    2段目は画像Jobが成功した後、workerのsweepがサーバ側で投入する。1段目が失敗・中止
    された場合は2段目を投入しない。2段目の紐づけ先とRecipeは、1段目を投入する前に
    確かめる。
    """
    video = payload.video
    await _validate_project_context(session, video.project_id)
    video = await _validate_story_links_of(session, video)
    resolved = await _resolve_references(
        session, source, video.project_id, video.scene_id, video.shot_id
    )
    _, recipe, *_ = await _resolve_generation_defaults(session, video, resolved)
    schema = recipe.input_schema if isinstance(recipe.input_schema, dict) else {}
    if FIRST_FRAME_INPUT not in schema:
        raise _validation_error(
            "videoのRecipeは開始フレームを受けるi2vにします。",
            {"recipe_id": recipe.id},
        )

    image_job = await _submit_generation_job(session, source, payload.image)
    now = schemas.now_iso()
    followup = GenerationJobFollowup(
        id=schemas.new_id(),
        parent_job_id=image_job.id,
        payload=video.model_copy(update={"queue_sequence": None}).model_dump(
            mode="json"
        ),
        state="pending",
        created_at=now,
        updated_at=now,
    )
    session.add(followup)
    await _commit(session)
    return {"image_job": image_job, "followup": followup}


@router.get(
    "/generation-job-followups/{followup_id}",
    response_model=schemas.GenerationJobFollowupRead,
)
async def get_generation_job_followup(followup_id: str, session: SessionDep):
    return await _get_or_404(
        session, GenerationJobFollowup, "GenerationJobFollowup", followup_id
    )
