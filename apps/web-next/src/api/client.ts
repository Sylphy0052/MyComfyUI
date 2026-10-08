import type { components } from "./schema";

export type GenerationJob = components["schemas"]["GenerationJobRead"];
export type ProjectRecord = components["schemas"]["ProjectRead"];
export type ProjectList = components["schemas"]["ProjectList"];
export type ProjectPurgeResult = components["schemas"]["ProjectPurgeResult"];

/** Web UIとApplication APIは同一originで配信する。 */
const API_BASE = "/api/v1";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 入力検証の422は`{msg}`の配列を返す。読める文だけを取り出す。 */
function validationMessages(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item: unknown) => (item && typeof item === "object" ? (item as { msg?: unknown }).msg : null))
    .filter((msg): msg is string => typeof msg === "string");
}

/**
 * エラー本文を読める文にする。読めなければHTTPの状態を返す。
 * Application APIは`{code, message, details}`を返し、FastAPIの既定の応答 (存在しないパスなど) は`detail`を返す。
 */
async function describeFailure(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "message" in body) {
      const { message, details } = body as { message: unknown; details?: unknown };
      if (typeof message === "string") {
        const reasons = validationMessages(details);
        return reasons.length > 0 ? `${message} (${reasons.join(" / ")})` : message;
      }
    }
    if (body && typeof body === "object" && "detail" in body) {
      const detail = (body as { detail: unknown }).detail;
      if (typeof detail === "string") return detail;
      // 入力検証の422は`detail`が`{msg}`の配列になる。
      const messages = validationMessages(detail);
      if (messages.length > 0) return messages.join(" / ");
      return JSON.stringify(detail);
    }
  } catch {
    // 本文がJSONでなければ状態行で代える。
  }
  return `${response.status} ${response.statusText}`;
}

const UNREACHABLE_MESSAGE = "APIに接続できません。Application APIが起動しているか確認してください。";

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch {
    throw new ApiError(0, UNREACHABLE_MESSAGE);
  }
  if (!response.ok) {
    throw new ApiError(response.status, await describeFailure(response));
  }
  if (response.status === 204) return undefined as T;
  try {
    return (await response.json()) as T;
  } catch {
    // devサーバーがAPIの代わりにHTMLを返したときなど。
    throw new ApiError(response.status, UNREACHABLE_MESSAGE);
  }
}

export function jobPreviewUrl(jobId: string, previewSeq: number): string {
  return `${API_BASE}/generation-jobs/${encodeURIComponent(jobId)}/preview?seq=${previewSeq}`;
}

export function eventsUrl(): URL {
  const url = new URL(`${API_BASE}/events`, window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return url;
}
