/**
 * Application API の接続先を実行時に解決する (Issue #64)。
 *
 * Tauri shell は空き loopback port で sidecar を起動するため、接続先をビルド時に
 * 固定できない。shell は bundle 読み込み前に `window.__MYCOMFYUI_API_BASE_URL__`
 * へ `http://127.0.0.1:<port>` を書き込み、画面はその値を使う。
 * 注入がない Web 版配布と開発時の Vite proxy では、従来どおり同一 origin を使う。
 */

/** API のパス接頭辞。同一 origin 時はこれだけを使う。 */
const API_PATH_PREFIX = "/api/v1";

/** shell が接続先を注入する global の名前。 */
export const API_BASE_URL_GLOBAL = "__MYCOMFYUI_API_BASE_URL__";

declare global {
  interface Window {
    __MYCOMFYUI_API_BASE_URL__?: unknown;
  }
}

/**
 * 注入値を検証して origin + path へ正規化する。
 * loopback 以外も受けるが、scheme は http/https だけに限る。
 */
function normalize(injected: unknown): string | null {
  if (typeof injected !== "string" || injected.trim() === "") {
    return null;
  }
  let url: URL;
  try {
    url = new URL(injected.trim());
  } catch {
    console.warn(
      `${API_BASE_URL_GLOBAL} が URL として読めないため同一 origin を使います`,
    );
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    console.warn(
      `${API_BASE_URL_GLOBAL} の scheme (${url.protocol}) は使えないため同一 origin を使います`,
    );
    return null;
  }
  // 末尾の "/" を落としてから接頭辞を足す。shell が path 付きで渡す場合も保つ。
  const prefix = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  return `${prefix}${API_PATH_PREFIX}`;
}

let resolved: string | null = null;

/**
 * API の base URL を返す。最初の呼び出しで解決し、以降は同じ値を使う。
 * 注入は bundle 読み込み前に済む前提だが、解決を初回リクエストまで遅らせる。
 */
export function apiBaseUrl(): string {
  if (resolved === null) {
    resolved =
      (typeof window === "undefined"
        ? null
        : normalize(window[API_BASE_URL_GLOBAL])) ?? API_PATH_PREFIX;
  }
  return resolved;
}
