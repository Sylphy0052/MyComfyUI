"""GPU直列ジョブキューの実行制御。

Backend実行本体は`JobExecutor` Protocolで差し込む。既定の実装は
`adapters.comfyui.executor.ComfyUIExecutor`で、ここはBackendの種類を知らない。
"""

import asyncio
import logging
from dataclasses import dataclass
from typing import Protocol

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from mycomfyui_api import schemas
from mycomfyui_api.events import job_events
from mycomfyui_api.models import AgentProposalApplication, GenerationJob

logger = logging.getLogger(__name__)

POLL_INTERVAL_SECONDS = 0.5
MAX_BACKOFF_SECONDS = 30.0

FAILURE_CODE_INTERRUPTED = "INTERRUPTED"
FAILURE_CODE_EXECUTOR_ERROR = "EXECUTOR_ERROR"
FAILURE_CODE_CLAIM_LOST = "CLAIM_LOST"


@dataclass(frozen=True)
class ExecutionOutcome:
    """Executorの実行結果。

    `stop_confirmed`は取消要求に応じてBackendが停止したことを示す。`succeeded`が
    `False`でも`stop_confirmed`が`False`なら「停止処理そのものの失敗」であり、
    取消による`cancelled`ではなく理由付きの`failed`として記録する。
    """

    succeeded: bool
    stop_confirmed: bool = False
    failure_code: str | None = None
    failure_stage: str | None = None
    failure_message: str | None = None
    retryable: bool | None = None


class JobExecutor(Protocol):
    """Backend実行を差し込むための抽象。"""

    async def run(
        self, job: GenerationJob, cancel_event: asyncio.Event
    ) -> ExecutionOutcome: ...


async def recover_interrupted_jobs(session: AsyncSession) -> int:
    """前回プロセスがrunning/cancelling中に終了したJobをfailedへ倒す。

    プロセス再起動後に中断Jobを誤って成功扱いしないための起動時リカバリ。
    """
    result = await session.execute(
        select(GenerationJob).where(GenerationJob.state.in_(("running", "cancelling")))
    )
    jobs = result.scalars().all()
    now = schemas.now_iso()
    for job in jobs:
        job.state = "failed"
        job.finished_at = now
        job.failure_code = FAILURE_CODE_INTERRUPTED
        job.failure_stage = "execution"
        job.failure_message = "プロセス再起動により実行が中断されました。"
        job.retryable = True
    if jobs:
        await session.commit()
    return len(jobs)


async def recover_interrupted_applications(session: AsyncSession) -> int:
    """前回プロセスが適用中(`applying`)のまま終了したstepをfailedへ倒す。

    占有したままの行を残すと、同じstepを二度と実行できなくなる。実行済みかどうかは
    この時点では判定できないため、失敗として残し、利用者が内容を確かめて再実行できる
    状態にする。
    """
    result = await session.execute(
        select(AgentProposalApplication).where(
            AgentProposalApplication.state == "applying"
        )
    )
    applications = result.scalars().all()
    now = schemas.now_iso()
    for application in applications:
        application.state = "failed"
        application.failure_code = FAILURE_CODE_INTERRUPTED
        application.failure_message = (
            "プロセス再起動により適用が中断されました。適用先の有無を確かめてください。"
        )
        application.updated_at = now
    if applications:
        await session.commit()
    return len(applications)


class JobQueueWorker:
    """queue_sequence昇順でqueuedのJobを1件ずつ直列実行する。"""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        executor: JobExecutor,
        *,
        poll_interval: float = POLL_INTERVAL_SECONDS,
    ) -> None:
        self._session_factory = session_factory
        self._executor = executor
        self._poll_interval = poll_interval
        self._cancel_events: dict[str, asyncio.Event] = {}
        self._task: asyncio.Task[None] | None = None
        self._consecutive_errors = 0

    def start(self) -> None:
        self._task = asyncio.create_task(self._run_forever())

    async def stop(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None

    def request_cancel(self, job_id: str) -> None:
        """runningのJobへ取消要求を伝える。Executorがcancel_eventを見て停止する。"""
        event = self._cancel_events.get(job_id)
        if event is not None:
            event.set()

    async def _run_forever(self) -> None:
        while True:
            try:
                processed = await self._process_next()
                self._consecutive_errors = 0
            except Exception:
                logger.exception("キュー処理ループで予期しない例外が発生しました。")
                processed = False
                self._consecutive_errors += 1
            if not processed:
                await asyncio.sleep(self._next_delay())

    def _next_delay(self) -> float:
        """連続失敗時は指数バックオフし、ログ洪水と過剰ポーリングを避ける。"""
        if self._consecutive_errors == 0:
            return self._poll_interval
        backoff = self._poll_interval * (2**self._consecutive_errors)
        return min(backoff, MAX_BACKOFF_SECONDS)

    async def _process_next(self) -> bool:
        job_id = await self._claim_next()
        if job_id is None:
            return False
        cancel_event = asyncio.Event()
        self._cancel_events[job_id] = cancel_event
        try:
            outcome = await self._run_executor(job_id, cancel_event)
        finally:
            self._cancel_events.pop(job_id, None)
        try:
            await self._finalize(job_id, outcome, cancel_event)
        except Exception:
            # ここで失敗するとJobはrunningのまま残るが、ワーカー自体は継続する。
            # 次回プロセス再起動時はrecover_interrupted_jobsが救済する。
            logger.exception("Job %sの状態確定に失敗しました。", job_id)
        return True

    async def _run_executor(
        self, job_id: str, cancel_event: asyncio.Event
    ) -> ExecutionOutcome:
        try:
            job = await self._load(job_id)
        except Exception:
            logger.exception("Job %sの再取得に失敗しました。", job_id)
            return ExecutionOutcome(
                succeeded=False,
                failure_code=FAILURE_CODE_CLAIM_LOST,
                failure_stage="backend_start",
                failure_message="確保直後にJobを再取得できませんでした。",
                retryable=True,
            )
        try:
            return await self._executor.run(job, cancel_event)
        except Exception:
            logger.exception("Job %sの実行中に例外が発生しました。", job_id)
            return ExecutionOutcome(
                succeeded=False,
                failure_code=FAILURE_CODE_EXECUTOR_ERROR,
                failure_stage="execution",
                failure_message="実行中に予期しないエラーが発生しました。",
                retryable=False,
            )

    async def _claim_next(self) -> str | None:
        """1件だけqueuedからrunningへ遷移させる。

        candidateの選定と条件付きUPDATEを分け、UPDATEの影響行数で確保できたか
        判定する。cancel APIが同じJobを先に`cancelled`へ更新した場合はrowcountが
        0になり、このJobは掴まずに次のポーリングへ委ねる。
        """
        async with self._session_factory() as session:
            result = await session.execute(
                select(GenerationJob.id)
                .where(GenerationJob.state == "queued")
                # 同じqueue_sequenceのJobが並んだときも順序を決めておく。
                .order_by(GenerationJob.queue_sequence.asc(), GenerationJob.id.asc())
                .limit(1)
            )
            job_id = result.scalars().first()
            if job_id is None:
                return None
            update_result = await session.execute(
                update(GenerationJob)
                .where(GenerationJob.id == job_id, GenerationJob.state == "queued")
                .values(state="running", started_at=schemas.now_iso())
            )
            await session.commit()
            if update_result.rowcount == 0:
                return None
            await job_events.publish_job(job_id, "running")
            return job_id

    async def _load(self, job_id: str) -> GenerationJob:
        async with self._session_factory() as session:
            job = await session.get(GenerationJob, job_id)
            if job is None:
                raise RuntimeError(f"claimed job {job_id} not found")
            return job

    async def _finalize(
        self, job_id: str, outcome: ExecutionOutcome, cancel_event: asyncio.Event
    ) -> None:
        async with self._session_factory() as session:
            job = await session.get(GenerationJob, job_id)
            if job is None:
                return
            if outcome.succeeded:
                job.state = "succeeded"
            elif cancel_event.is_set() and outcome.stop_confirmed:
                job.state = "cancelled"
            else:
                job.state = "failed"
                job.failure_code = outcome.failure_code
                job.failure_stage = outcome.failure_stage
                job.failure_message = outcome.failure_message
                job.retryable = outcome.retryable
            job.finished_at = schemas.now_iso()
            await session.commit()
            await job_events.publish_job(job.id, job.state)
