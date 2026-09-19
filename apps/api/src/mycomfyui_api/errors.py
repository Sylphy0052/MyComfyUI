import logging
from typing import Any
from uuid import uuid4

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.exc import SQLAlchemyError
from starlette import status

logger = logging.getLogger(__name__)


class ErrorEnvelope(BaseModel):
    code: str
    message: str
    details: Any | None = None
    request_id: str


class ApiError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: int = status.HTTP_400_BAD_REQUEST,
        details: Any | None = None,
    ) -> None:
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details


def error_response(request: Request, error: ApiError) -> JSONResponse:
    return JSONResponse(
        status_code=error.status_code,
        content=ErrorEnvelope(
            code=error.code,
            message=error.message,
            details=error.details,
            request_id=getattr(request.state, "request_id", None) or str(uuid4()),
        ).model_dump(),
    )


async def api_error_handler(request: Request, error: ApiError) -> JSONResponse:
    return error_response(request, error)


async def storage_error_handler(
    request: Request, error: SQLAlchemyError
) -> JSONResponse:
    """DB接続やlockの失敗も共通Envelopeで返す。詳細は応答へ出さずログへ残す。"""
    logger.exception("永続化層でエラーが発生しました。", exc_info=error)
    return error_response(
        request,
        ApiError(
            "STORAGE_ERROR",
            "保存先へアクセスできませんでした。",
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        ),
    )


async def unhandled_error_handler(request: Request, error: Exception) -> JSONResponse:
    logger.exception("未処理の例外が発生しました。", exc_info=error)
    return error_response(
        request,
        ApiError(
            "INTERNAL_ERROR",
            "サーバ内部でエラーが発生しました。",
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        ),
    )


def _serializable_errors(error: RequestValidationError) -> list[dict[str, Any]]:
    """検証失敗の内訳をJSONへ変換する。`ctx`は例外objectを含むため文字列化する。"""
    details: list[dict[str, Any]] = []
    for item in error.errors():
        entry = dict(item)
        entry.pop("url", None)
        ctx = entry.get("ctx")
        if ctx:
            entry["ctx"] = {key: str(value) for key, value in ctx.items()}
        details.append(entry)
    return details


async def validation_error_handler(
    request: Request, error: RequestValidationError
) -> JSONResponse:
    return error_response(
        request,
        ApiError(
            "VALIDATION_ERROR",
            "入力値が正しくありません。",
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            details=_serializable_errors(error),
        ),
    )
