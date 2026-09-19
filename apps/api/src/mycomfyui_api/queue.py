"""GPU直列ジョブキューの実行制御。

Backend実行本体(ComfyUI Adapter等)は後続Issueの対象。ここでは`JobExecutor`
Protocolで差し込み口を用意し、未接続時は`UnavailableExecutor`で即失敗させる。
"""

import asyncio
import logging
from dataclasses import dataclass
from typing import Protocol

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from mycomfyui_api import schemas
from mycomfyui_api.models import GenerationJob

logger = logging.getLogger(__name__)

POLL_INTERVAL_SECONDS = 0.5

FAILURE_CODE_INTERRUPTED = "INTERRUPTED"
FAILURE_CODE_EXECUTOR_UNAVAILABLE = "EXECUTOR_UNAVAILABLE"


@dataclass(frozen=True)
class ExecutionOutcome:
    """Executorの実行結果。失敗時だけ理由系項目を持つ。"""

    succeeded: bool
    failure_code: str | None = None
    failure_stage: str | None = None
    failure_message: str | None = None
    retryable: bool | None = None


class JobExecutor(Protocol):
    """Backend実行を差し込むための抽象。#7でComfyUI Adapter実装に差し替える。"""

    async def run(
        self, job: GenerationJob, cancel_event: asyncio.Event
    ) -> ExecutionOutcome: ...


class UnavailableExecutor:
    """Backend未接続時のプレースホルダー。常に実行失敗として扱う。"""

    async def run(
        self, job: GenerationJob, cancel_event: asyncio.Event
    ) -> ExecutionOutcome:
        return ExecutionOutcome(
            succeeded=False,
            failure_code=FAILURE_CODE_EXECUTOR_UNAVAILABLE,
            failure_stage="backend_start",
            failure_message="実行Backendが未接続のため開始できません。",
            retryable=True,
        )


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
            processed = await self._process_next()
            if not processed:
                await asyncio.sleep(self._poll_interval)

    async def _process_next(self) -> bool:
        job_id = await self._claim_next()
        if job_id is None:
            return False
        cancel_event = asyncio.Event()
        self._cancel_events[job_id] = cancel_event
        try:
            job = await self._load(job_id)
            outcome = await self._executor.run(job, cancel_event)
        finally:
            self._cancel_events.pop(job_id, None)
        await self._finalize(job_id, outcome, cancel_event)
        return True

    async def _claim_next(self) -> str | None:
        """1件だけqueuedからrunningへ遷移させる。同時に2件目を掴まない。"""
        async with self._session_factory() as session:
            result = await session.execute(
                select(GenerationJob)
                .where(GenerationJob.state == "queued")
                .order_by(GenerationJob.queue_sequence.asc())
                .limit(1)
            )
            job = result.scalars().first()
            if job is None:
                return None
            job.state = "running"
            job.started_at = schemas.now_iso()
            await session.commit()
            return job.id

    async def _load(self, job_id: str) -> GenerationJob:
        async with self._session_factory() as session:
            job = await session.get(GenerationJob, job_id)
            assert job is not None
            return job

    async def _finalize(
        self, job_id: str, outcome: ExecutionOutcome, cancel_event: asyncio.Event
    ) -> None:
        async with self._session_factory() as session:
            job = await session.get(GenerationJob, job_id)
            if job is None:
                return
            if cancel_event.is_set() and not outcome.succeeded:
                job.state = "cancelled"
            elif outcome.succeeded:
                job.state = "succeeded"
            else:
                job.state = "failed"
                job.failure_code = outcome.failure_code
                job.failure_stage = outcome.failure_stage
                job.failure_message = outcome.failure_message
                job.retryable = outcome.retryable
            job.finished_at = schemas.now_iso()
            await session.commit()
