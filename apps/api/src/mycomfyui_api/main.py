import logging
import re
from contextlib import asynccontextmanager
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from sqlalchemy.exc import SQLAlchemyError

from mycomfyui_api.adapters.comfyui.executor import ComfyUIExecutor
from mycomfyui_api.db import dispose_engine, get_engine, get_session_factory
from mycomfyui_api.errors import (
    ApiError,
    api_error_handler,
    storage_error_handler,
    unhandled_error_handler,
    validation_error_handler,
)
from mycomfyui_api.queue import JobQueueWorker, recover_interrupted_jobs
from mycomfyui_api.routers import router

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
    worker = JobQueueWorker(session_factory, ComfyUIExecutor(session_factory))
    worker.start()
    app.state.queue_worker = worker
    try:
        yield
    finally:
        await worker.stop()
        await dispose_engine()


def create_app() -> FastAPI:
    app = FastAPI(title="MyComfyUI Application API", version="0.1.0", lifespan=lifespan)
    app.add_exception_handler(ApiError, api_error_handler)
    app.add_exception_handler(RequestValidationError, validation_error_handler)
    app.add_exception_handler(SQLAlchemyError, storage_error_handler)
    app.add_exception_handler(Exception, unhandled_error_handler)
    app.include_router(router)

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
