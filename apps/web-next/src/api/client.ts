import type { components } from "./schema";

export type GenerationJob = components["schemas"]["GenerationJobRead"];
export type ProjectRecord = components["schemas"]["ProjectRead"];
export type ProjectList = components["schemas"]["ProjectList"];

/** Web UIとApplication APIは同一originで配信する。 */
const API_BASE = "/api/v1";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** FastAPIのエラー本文 (`detail`) を読める文にする。読めなければHTTPの状態を返す。 */
async function describeFailure(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "detail" in body) {
      const detail = (body as { detail: unknown }).detail;
      if (typeof detail === "string") return detail;
      return JSON.stringify(detail);
    }
  } catch {
    // 本文がJSONでなければ状態行で代える。
  }
  return `${response.status} ${response.statusText}`;
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    throw new ApiError(response.status, await describeFailure(response));
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function jobPreviewUrl(jobId: string, previewSeq: number): string {
  return `${API_BASE}/generation-jobs/${encodeURIComponent(jobId)}/preview?seq=${previewSeq}`;
}

export function eventsUrl(): URL {
  const url = new URL(`${API_BASE}/events`, window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return url;
}
