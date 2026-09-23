"""Web UIへJob状態の変化だけを通知する、非永続のEvent Hub。"""

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from mycomfyui_api import schemas
from mycomfyui_api.settings import get_settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1", tags=["events"])
QUEUE_SIZE = 100
MAX_SUBSCRIBERS = 32
HEARTBEAT_SECONDS = 20.0
SEND_TIMEOUT_SECONDS = 5.0
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"}

#: 終端に至っていないJobの状態。`contracts/events/job-event.schema.json`の
#: `state`列挙のうち、`phase`が`terminal`にならないものと一致させる。schemaと
#: 二重定義になっているため、どちらかを変えたらもう片方も直す。
NON_TERMINAL_JOB_STATES = ("queued", "running", "cancelling")


class SubscriberLimitReached(RuntimeError):
    """購読枠が埋まっていて新しい接続を受けられない。"""


class EventHub:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[dict[str, object]]] = set()
        self._sequence = 0

    @asynccontextmanager
    async def subscribe(self) -> AsyncIterator[asyncio.Queue[dict[str, object]]]:
        if len(self._subscribers) >= MAX_SUBSCRIBERS:
            raise SubscriberLimitReached("WebSocket subscriber limit reached")
        queue: asyncio.Queue[dict[str, object]] = asyncio.Queue(maxsize=QUEUE_SIZE)
        self._subscribers.add(queue)
        try:
            yield queue
        finally:
            self._subscribers.discard(queue)

    async def publish_job(self, job_id: str, state: str) -> None:
        """Job状態の変化を配る。ここでの失敗は呼び出し元へ返さない。

        発行はJobの作成・取消・実行のcommit直後に呼ばれる。通知の失敗で
        例外を返すと、DBへ確定済みの操作がAPIの500になったり、`running`の
        まま実行へ進まないJobが残る。通知は再取得の引き金でしかないため、
        失敗はログに残して捨てる。
        """
        try:
            self._publish_job(job_id, state)
        except Exception:
            logger.warning("Job状態の通知に失敗した job_id=%s", job_id, exc_info=True)

    def _publish_job(self, job_id: str, state: str) -> None:
        event = self.event(
            "generation_job.state_changed",
            "generation_job",
            job_id,
            {
                "job_id": job_id,
                "state": state,
                "phase": (state if state in NON_TERMINAL_JOB_STATES else "terminal"),
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
    """まだ繋がっているときだけ閉じる。閉じる操作自体の失敗は握る。

    切断はclient側の都合でいつでも起きる。閉じ方の失敗まで呼び出し元へ返すと、
    通知経路の後始末だけのためにtracebackがログへ残る。
    """
    if websocket.client_state.name != "CONNECTED":
        return
    try:
        await websocket.close(code=code, reason=reason)
    except Exception:
        logger.debug("WebSocketを閉じる途中で切断された", exc_info=True)


async def _stream(
    websocket: WebSocket, queue: asyncio.Queue[dict[str, object]]
) -> None:
    """接続が切れるまでイベントを送り続ける。無音が続けばheartbeatを挟む。"""
    await asyncio.wait_for(
        websocket.send_json(
            job_events.event("connection.ready", "connection", "events", {})
        ),
        timeout=SEND_TIMEOUT_SECONDS,
    )
    while True:
        try:
            event = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_SECONDS)
        except TimeoutError:
            event = job_events.event("connection.heartbeat", "connection", "events", {})
        await asyncio.wait_for(websocket.send_json(event), timeout=SEND_TIMEOUT_SECONDS)


@router.websocket("/events")
async def job_event_stream(websocket: WebSocket) -> None:
    if not _allowed(websocket):
        # acceptより前のcloseはhandshakeの拒否になる。この時点の状態は
        # CONNECTINGで、_close_quietlyの判定には掛からないため直接閉じる。
        await websocket.close(code=1008, reason="Origin is not allowed")
        return
    try:
        await websocket.accept()
    except WebSocketDisconnect:
        # ハンドシェイクの途中でタブを閉じられただけ。通知経路の外へは出さない。
        logger.debug("WebSocketの確立前に切断された", exc_info=True)
        return
    except Exception:
        # 切断以外でacceptが通らないのは設定か実装の問題で、放置すると全接続が
        # 黙って失敗する。debugでは気付けないため上のレベルで残す。
        logger.warning("WebSocketを確立できなかった", exc_info=True)
        return
    try:
        async with job_events.subscribe() as queue:
            await _stream(websocket, queue)
    except SubscriberLimitReached:
        # 購読枠が空くまで待たせない。画面はRESTのポーリングへ落ちて動き続ける。
        await _close_quietly(websocket, 1013, "Subscriber limit reached")
    except TimeoutError:
        # 受け取らないclientを抱えたままにしない。障害切り分けのため、
        # 購読枠の不足とは別の理由を返す。
        await _close_quietly(websocket, 1011, "Send timed out")
    except WebSocketDisconnect:
        return
    except Exception:
        # 切断の検出方法はASGI実装によって型が違う。想定外の型で落として
        # tracebackを残さず、理由を記録して閉じる。
        logger.warning("WebSocketの配信を中断した", exc_info=True)
        await _close_quietly(websocket, 1011, "Unexpected error")
