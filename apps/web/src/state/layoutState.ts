/**
 * 主要画面 (制作/生成) の左右ペイン幅と折りたたみ状態をlocalStorageへ保存する。
 *
 * URLには載せない。幅や折りたたみはブラウザ・端末ごとの作業スペースの都合であり、
 * リンク共有で引き継ぐべき情報ではない上、URLが不必要に長くなるのを避けるため。
 * uiState.ts (mycomfyui.ui.v1) とは別のキーを使い、責務を分ける。
 */

export const PANE_IDS = ["sceneBrowser", "jobQueue"] as const;
export type PaneId = (typeof PANE_IDS)[number];

export type PaneLayoutState = {
  widths: Record<PaneId, number>;
  collapsed: Record<PaneId, boolean>;
};

export const DEFAULT_PANE_WIDTHS: Record<PaneId, number> = {
  sceneBrowser: 320,
  jobQueue: 360,
};

export const MIN_PANE_WIDTH = 220;
export const MAX_PANE_WIDTH = 560;
/** 折りたたみ時に残す帯の幅。開くボタンを置ける最小限にする。 */
export const COLLAPSED_RAIL_WIDTH = 40;

export const DEFAULT_PANE_LAYOUT_STATE: PaneLayoutState = {
  widths: { ...DEFAULT_PANE_WIDTHS },
  collapsed: { sceneBrowser: false, jobQueue: false },
};

const STORAGE_KEY = "mycomfyui.layout.v1";

export function clampPaneWidth(value: number, paneId: PaneId): number {
  if (Number.isNaN(value)) return DEFAULT_PANE_WIDTHS[paneId];
  return Math.min(MAX_PANE_WIDTH, Math.max(MIN_PANE_WIDTH, Math.round(value)));
}

/** 壊れた・古い形式の値は既定値へ落とし、UIが起動できなくなるのを避ける。 */
export function readPaneLayoutState(): PaneLayoutState {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return { ...DEFAULT_PANE_LAYOUT_STATE };
  }
  if (!raw) return { ...DEFAULT_PANE_LAYOUT_STATE };

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_PANE_LAYOUT_STATE };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ...DEFAULT_PANE_LAYOUT_STATE };
  }

  const source = parsed as Record<string, unknown>;
  const widths: Record<PaneId, number> = { ...DEFAULT_PANE_WIDTHS };
  const collapsed: Record<PaneId, boolean> = {
    ...DEFAULT_PANE_LAYOUT_STATE.collapsed,
  };

  const rawWidths = source.widths;
  if (rawWidths && typeof rawWidths === "object") {
    for (const paneId of PANE_IDS) {
      const value = (rawWidths as Record<string, unknown>)[paneId];
      if (typeof value === "number" && Number.isFinite(value)) {
        widths[paneId] = clampPaneWidth(value, paneId);
      }
    }
  }

  const rawCollapsed = source.collapsed;
  if (rawCollapsed && typeof rawCollapsed === "object") {
    for (const paneId of PANE_IDS) {
      const value = (rawCollapsed as Record<string, unknown>)[paneId];
      if (typeof value === "boolean") {
        collapsed[paneId] = value;
      }
    }
  }

  return { widths, collapsed };
}

export function persistPaneLayoutState(state: PaneLayoutState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // プライベートモードなどでstorageが使えない環境では永続化を諦める。
  }
}
