import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { eventsUrl } from "./client";
import { queryKeys } from "./queryKeys";

/** `/api/v1/events`が配るイベント (`events.py`の`EventHub.event`)。 */
export type ApiEvent = {
  event_id: number;
  event_type: string;
  occurred_at: string;
  resource_type: string;
  resource_id: string;
  payload: Record<string, unknown>;
};

export type JobProgress = {
  value: number;
  max: number;
  node: string | null;
  previewSeq: number;
};

/**
 * イベントの種類ごとに無効化するqueryKey。WebSocketは再取得の引き金だけに使い、
 * RESTで得る状態を正本とする。後続の画面は、自分のqueryKeyをここへ足す。
 */
const invalidations: Record<string, (event: ApiEvent) => QueryKey[]> = {
  "generation_job.state_changed": () => [queryKeys.jobs],
};

function parseEvent(data: unknown): ApiEvent | null {
  try {
    const message: unknown = JSON.parse(String(data));
    if (!message || typeof message !== "object") return null;
    const record = message as Partial<ApiEvent>;
    if (typeof record.event_type !== "string") return null;
    return { ...record, payload: record.payload ?? {} } as ApiEvent;
  } catch {
    return null;
  }
}

function applyProgress(client: QueryClient, event: ApiEvent): void {
  const { job_id: jobId, value, max, node, preview_seq: previewSeq } = event.payload;
  if (typeof jobId !== "string" || typeof value !== "number" || typeof max !== "number") return;
  const progress: JobProgress = {
    value,
    max,
    node: typeof node === "string" ? node : null,
    previewSeq: typeof previewSeq === "number" ? previewSeq : 0,
  };
  client.setQueryData(queryKeys.jobProgress(jobId), progress);
}

/**
 * WebSocketへ接続し続け、イベントに応じてQueryを無効化する。切れたら指数バックオフで再接続し、
 * 再接続できたら取りこぼした変化を拾うためJob一覧を取り直す。
 * `onEvent`は無効化の後に、受けたイベントをそのまま渡す (トーストなど)。
 */
export function useApiEvents(onEvent?: (event: ApiEvent) => void): void {
  const client = useQueryClient();
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let stableTimer: number | null = null;
    let retryDelay = 500;
    let connectedBefore = false;

    const retryLater = () => {
      const jittered = retryDelay * (0.75 + Math.random() * 0.5);
      reconnectTimer = window.setTimeout(connect, jittered);
      retryDelay = Math.min(retryDelay * 2, 10000);
    };
    const connect = () => {
      if (stopped) return;
      try {
        socket = new WebSocket(eventsUrl());
      } catch {
        retryLater();
        return;
      }
      socket.onopen = () => {
        if (connectedBefore) void client.invalidateQueries({ queryKey: queryKeys.jobs });
        connectedBefore = true;
        // 5秒つながり続けたら再接続の間隔を初期値へ戻す。
        stableTimer = window.setTimeout(() => {
          retryDelay = 500;
        }, 5000);
      };
      socket.onmessage = (message) => {
        const event = parseEvent(message.data);
        if (!event) return;
        if (event.event_type === "generation_job.progress") {
          applyProgress(client, event);
          return;
        }
        for (const queryKey of invalidations[event.event_type]?.(event) ?? []) {
          void client.invalidateQueries({ queryKey });
        }
        onEventRef.current?.(event);
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (stableTimer !== null) window.clearTimeout(stableTimer);
        stableTimer = null;
        if (!stopped) retryLater();
      };
    };

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (stableTimer !== null) window.clearTimeout(stableTimer);
      socket?.close();
    };
  }, [client]);
}
