import logging
import re
from contextlib import asynccontextmanager
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from sqlalchemy.exc import SQLAlchemyError

from mycomfyui_api.adapters.agent import create_agent_provider
from mycomfyui_api.adapters.aimedia.client import create_reference_source
from mycomfyui_api.bootstrap import ensure_default_recipes, ensure_voice_recipes
from mycomfyui_api.db import dispose_engine, get_engine, get_session_factory
from mycomfyui_api.engines import ExecutorRegistry
from mycomfyui_api.errors import (
    ApiError,
    api_error_handler,
    storage_error_handler,
    unhandled_error_handler,
    validation_error_handler,
)
from mycomfyui_api.queue import JobQueueWorker, recover_interrupted_jobs
from mycomfyui_api.references import router as reference_router
from mycomfyui_api.routers import router
from mycomfyui_api.settings import get_settings

logger = logging.getLogger(__name__)

REQUEST_ID_PATTERN = re.compile(r"\A[A-Za-z0-9._-]{1,64}\Z")


def _resolve_request_id(raw: str | None) -> str:
    """要求元のIDは書式を満たすものだけ引き継ぐ。満たさなければ採番する。"""
    if raw is not None and REQUEST_ID_PATTERN.match(raw):
        return raw
    return str(uuid4())


@asynccontextmanager
async def lifespan(app: FastAPI):
    get_engine()
    session_factory = get_session_factory()
    async with session_factory() as session:
        recovered = await recover_interrupted_jobs(session)
        if recovered:
            logger.info("中断Jobを%d件failedへ倒しました。", recovered)
        await ensure_default_recipes(session)
        await ensure_voice_recipes(session)
    # Executorはengineごとにレジストリから引く。キューは全Jobで1本のまま、
    # 画像Jobと音声Jobが同じGPU直列キューへ積まれる。
    worker = JobQueueWorker(session_factory, ExecutorRegistry(session_factory))
    worker.start()
    app.state.queue_worker = worker
    app.state.reference_source = None
    app.state.agent_provider = None
    # ワーカーを起動した後は、以降どこで失敗しても後始末まで進める。参照Adapterの
    # 生成はfixtureの読み込みで失敗しうるため、tryの外へ出さない。
    try:
        settings = get_settings()
        app.state.reference_source = create_reference_source(
            settings.aimedia_base_url, settings.aimedia_fixture_path
        )
        # 提案Providerは接続を張らない。CLIが無い環境でも起動を止めず、提案を
        # 要求したときに初めて失敗する。
        app.state.agent_provider = create_agent_provider(settings)
        yield
    finally:
        await worker.stop()
        if app.state.reference_source is not None:
            await app.state.reference_source.aclose()
        if app.state.agent_provider is not None:
            await app.state.agent_provider.aclose()
        await dispose_engine()


def create_app() -> FastAPI:
    app = FastAPI(title="MyComfyUI Application API", version="0.1.0", lifespan=lifespan)
    app.add_exception_handler(ApiError, api_error_handler)
    app.add_exception_handler(RequestValidationError, validation_error_handler)
    app.add_exception_handler(SQLAlchemyError, storage_error_handler)
    app.add_exception_handler(Exception, unhandled_error_handler)
    app.include_router(router)
    app.include_router(reference_router)

    @app.middleware("http")
    async def set_request_id(request: Request, call_next):
        request.state.request_id = _resolve_request_id(
            request.headers.get("X-Request-ID")
        )
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        return response

    @app.get("/api/v1/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
