"""Web UIへJob状態の変化だけを通知する、非永続のEvent Hub。"""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from mycomfyui_api import schemas
from mycomfyui_api.settings import get_settings

router = APIRouter(prefix="/api/v1", tags=["events"])
QUEUE_SIZE = 100
MAX_SUBSCRIBERS = 32
HEARTBEAT_SECONDS = 20.0
SEND_TIMEOUT_SECONDS = 5.0
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"}


class EventHub:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[dict[str, object]]] = set()
        self._sequence = 0

    @asynccontextmanager
    async def subscribe(self) -> AsyncIterator[asyncio.Queue[dict[str, object]]]:
        if len(self._subscribers) >= MAX_SUBSCRIBERS:
            raise RuntimeError("WebSocket subscriber limit reached")
        queue: asyncio.Queue[dict[str, object]] = asyncio.Queue(maxsize=QUEUE_SIZE)
        self._subscribers.add(queue)
        try:
            yield queue
        finally:
            self._subscribers.discard(queue)

    async def publish_job(self, job_id: str, state: str) -> None:
        event = self.event(
            "generation_job.state_changed",
            "generation_job",
            job_id,
            {
                "job_id": job_id,
                "state": state,
                "phase": (
                    state
                    if state in ("queued", "running", "cancelling")
                    else "terminal"
                ),
            },
        )
        for queue in tuple(self._subscribers):
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                # 通知は再取得トリガーであり、REST同期が正本なので切断しない。
                pass

    def event(
        self,
        event_type: str,
        resource_type: str,
        resource_id: str,
        payload: dict[str, object],
    ) -> dict[str, object]:
        self._sequence += 1
        return {
            "event_id": self._sequence,
            "event_type": event_type,
            "occurred_at": schemas.now_iso(),
            "resource_type": resource_type,
            "resource_id": resource_id,
            "payload": payload,
        }


job_events = EventHub()


def _allowed(websocket: WebSocket) -> bool:
    origin = websocket.headers.get("origin")
    client_host = websocket.client.host if websocket.client else ""
    # 明示的に許可したoriginはCORSと同じ扱いにする。それ以外は、originを送らない
    # clientと開発用proxyのためにloopbackからの接続だけを残す。
    if origin is not None and origin in get_settings().allowed_origin_list:
        return True
    if client_host not in LOOPBACK_HOSTS:
        return False
    if origin is None:
        return True
    parsed = urlsplit(origin)
    host = websocket.headers.get("host", "")
    host_name = urlsplit(f"//{host}").hostname
    expected = f"{parsed.scheme}://{host}"
    return (
        parsed.scheme in ("http", "https")
        and parsed.hostname in LOOPBACK_HOSTS
        and host_name in LOOPBACK_HOSTS
        and origin == expected
    )


async def _close_quietly(websocket: WebSocket, code: int, reason: str) -> None:
    """まだ繋がっているときだけ閉じる。既に切れていれば何もしない。"""
    if websocket.client_state.name == "CONNECTED":
        await websocket.close(code=code, reason=reason)


@router.websocket("/events")
async def job_event_stream(websocket: WebSocket) -> None:
    if not _allowed(websocket):
        await websocket.close(code=1008, reason="Origin is not allowed")
        return
    await websocket.accept()
    try:
        async with job_events.subscribe() as queue:
            await asyncio.wait_for(
                websocket.send_json(
                    job_events.event("connection.ready", "connection", "events", {})
                ),
                timeout=SEND_TIMEOUT_SECONDS,
            )
            while True:
                try:
                    event = await asyncio.wait_for(
                        queue.get(), timeout=HEARTBEAT_SECONDS
                    )
                except TimeoutError:
                    event = job_events.event(
                        "connection.heartbeat", "connection", "events", {}
                    )
                await asyncio.wait_for(
                    websocket.send_json(event), timeout=SEND_TIMEOUT_SECONDS
                )
    except RuntimeError:
        # 購読枠が空くまで待たせない。画面はRESTのポーリングへ落ちて動き続ける。
        await _close_quietly(websocket, 1013, "Subscriber limit reached")
        return
    except TimeoutError:
        # 受け取らないclientを抱えたままにしない。障害切り分けのため、
        # 購読枠の不足とは別の理由を返す。
        await _close_quietly(websocket, 1011, "Send timed out")
        return
    except WebSocketDisconnect:
        return
