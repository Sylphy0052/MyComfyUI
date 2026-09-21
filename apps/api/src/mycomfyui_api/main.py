import asyncio
import logging
import re
from contextlib import asynccontextmanager
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.exc import SQLAlchemyError
from starlette import status
from starlette.middleware.body_limit import RequestBodyLimitMiddleware

from mycomfyui_api.adapters.agent import create_agent_providers
from mycomfyui_api.adapters.aimedia.client import create_reference_source
from mycomfyui_api.bootstrap import (
    ensure_default_recipes,
    ensure_media_recipes,
    ensure_voice_recipes,
)
from mycomfyui_api.db import dispose_engine, get_engine, get_session_factory
from mycomfyui_api.engines import ExecutorRegistry
from mycomfyui_api.errors import (
    ApiError,
    api_error_handler,
    error_response,
    storage_error_handler,
    unhandled_error_handler,
    validation_error_handler,
)
from mycomfyui_api.migrator import upgrade_to_head
from mycomfyui_api.queue import (
    JobQueueWorker,
    recover_interrupted_applications,
    recover_interrupted_jobs,
)
from mycomfyui_api.projects import router as project_router
from mycomfyui_api.portability import router as portability_router
from mycomfyui_api.operations import router as operations_router
from mycomfyui_api.references import router as reference_router
from mycomfyui_api.routers import router
from mycomfyui_api.settings import get_settings
from mycomfyui_api.structure import router as structure_router
from mycomfyui_api.workflows import ensure_workflows

logger = logging.getLogger(__name__)

REQUEST_ID_PATTERN = re.compile(r"\A[A-Za-z0-9._-]{1,64}\Z")


def _resolve_request_id(raw: str | None) -> str:
    """要求元のIDは書式を満たすものだけ引き継ぐ。満たさなければ採番する。"""
    if raw is not None and REQUEST_ID_PATTERN.match(raw):
        return raw
    return str(uuid4())


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 空の`data_root`を渡されても起動できるよう、engineを作る前にschemaを揃える。
    # Alembicは同期APIのため、event loopを止めないよう別threadで走らせる。
    await asyncio.to_thread(upgrade_to_head)
    get_engine()
    session_factory = get_session_factory()
    async with session_factory() as session:
        recovered = await recover_interrupted_jobs(session)
        if recovered:
            logger.info("中断Jobを%d件failedへ倒しました。", recovered)
        # 適用中のまま終了したstepも同じ理由で失敗へ倒す。占有したままだと同じstepを
        # 再実行できなくなる。
        interrupted = await recover_interrupted_applications(session)
        if interrupted:
            logger.info("中断した提案の適用を%d件failedへ倒しました。", interrupted)
        # RecipeはWorkflowの版を指すため、レジストリの登録を先に済ませる。
        versions = await ensure_workflows(session)
        await ensure_default_recipes(session, versions)
        await ensure_voice_recipes(session, versions)
        await ensure_media_recipes(session, versions)
    # Executorはengineごとにレジストリから引く。キューは全Jobで1本のまま、
    # 画像Jobと音声Jobが同じGPU直列キューへ積まれる。
    worker = JobQueueWorker(session_factory, ExecutorRegistry(session_factory))
    worker.start()
    app.state.queue_worker = worker
    app.state.reference_source = None
    app.state.agent_providers = {}
    # ワーカーを起動した後は、以降どこで失敗しても後始末まで進める。参照Adapterの
    # 生成はfixtureの読み込みで失敗しうるため、tryの外へ出さない。
    try:
        settings = get_settings()
        app.state.reference_source = create_reference_source(
            settings.aimedia_base_url, settings.aimedia_fixture_path
        )
        # 提案Providerは接続を張らない。CLIが無い環境でも起動を止めず、提案を
        # 要求したときに初めて失敗する。
        app.state.agent_providers = create_agent_providers(settings)
        yield
    finally:
        await worker.stop()
        if app.state.reference_source is not None:
            await app.state.reference_source.aclose()
        for provider in app.state.agent_providers.values():
            await provider.aclose()
        await dispose_engine()


#: 本文の上限に足す余裕。JSONの他の項目とheaderのぶん。
REQUEST_BODY_MARGIN_BYTES = 64 * 1024


def _max_request_bytes() -> int:
    """受け付ける要求本文の上限。

    一番大きい本文は取り込む素材のbase64になる。参照音声と参照画像で上限が違うため、
    大きいほうへ合わせる。個別のEndpointで長さを見る前に、ASGIの入口で切る。ここを
    通してしまうと、上限を超える本文でも丸ごとメモリへ載ってからでないと断れない。
    """
    settings = get_settings()
    largest = max(
        settings.voice_max_audio_bytes,
        settings.max_image_bytes,
        settings.project_package_max_bytes,
    )
    encoded = (largest + 2) // 3 * 4
    return encoded + REQUEST_BODY_MARGIN_BYTES


def create_app() -> FastAPI:
    app = FastAPI(title="MyComfyUI Application API", version="0.1.0", lifespan=lifespan)
    app.add_exception_handler(ApiError, api_error_handler)
    app.add_exception_handler(RequestValidationError, validation_error_handler)
    app.add_exception_handler(SQLAlchemyError, storage_error_handler)
    app.add_exception_handler(Exception, unhandled_error_handler)
    app.include_router(router)
    app.include_router(project_router)
    app.include_router(portability_router)
    app.include_router(operations_router)
    app.include_router(structure_router)
    app.include_router(reference_router)
    # 実際に届いたバイト数を数えて打ち切る。`Content-Length`を送らない要求
    # (chunked)はheaderだけでは測れず、次のミドルウェアを素通りするため、
    # ASGIの受信側にも関所を置く。
    app.add_middleware(RequestBodyLimitMiddleware, max_body_size=_max_request_bytes())

    @app.middleware("http")
    async def limit_request_body(request: Request, call_next):
        """`Content-Length`が上限を超える要求は本文を読まずに断る。

        `RequestBodyLimitMiddleware`だけでも本文は止まるが、そちらは
        `{"detail": ...}`の形で返り、共通Envelopeにならない。長さを申告する
        要求はここで先に断る。申告しない要求(chunked)は測れないため、内側の
        関所が受信バイト数で止める。
        """
        declared = request.headers.get("Content-Length")
        if declared is not None and declared.isdigit():
            limit = _max_request_bytes()
            if int(declared) > limit:
                # 例外ハンドラはこのミドルウェアの内側にあり、ここで送出しても
                # 共通Envelopeにならない。応答を直接組み立てて返す。
                return error_response(
                    request,
                    ApiError(
                        "VALIDATION_ERROR",
                        "要求本文が大きすぎます。",
                        details={"limit": limit},
                        status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                    ),
                )
        return await call_next(request)

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

    # 許可originはミドルウェアの最も外側に置く。preflightを本文の関所より手前で
    # 返し、エラー応答にも許可headerが付くようにする。既定は空で、設定した
    # originが無い間はCORSのheaderを一切返さない。開発時はViteのproxyが同一
    # originへ寄せるため、設定は要らない。
    allowed_origins = get_settings().allowed_origin_list
    if allowed_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(allowed_origins),
            # 認証を持たないAPIのため、cookieと認証headerの送出は許さない。
            allow_credentials=False,
            allow_methods=["*"],
            allow_headers=["*"],
            expose_headers=["X-Request-ID"],
        )

    return app


app = create_app()
