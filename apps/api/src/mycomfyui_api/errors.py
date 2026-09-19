from typing import Any

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette import status


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
            request_id=request.state.request_id,
        ).model_dump(),
    )


async def api_error_handler(request: Request, error: ApiError) -> JSONResponse:
    return error_response(request, error)


async def validation_error_handler(
    request: Request, error: RequestValidationError
) -> JSONResponse:
    return error_response(
        request,
        ApiError(
            "VALIDATION_ERROR",
            "入力値が正しくありません。",
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            details=error.errors(),
        ),
    )
