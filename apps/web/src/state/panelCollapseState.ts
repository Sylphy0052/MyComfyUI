import { useCallback, useState } from "react";

/**
 * 生成画面右列のパネルの開閉をパネルごとにlocalStorageへ保存する (#402)。
 * 保存値が無い・壊れている場合は開いた状態として扱う。
 */
export type CollapsiblePanelId = "latestImage" | "candidates" | "resultColumn";

const STORAGE_KEY = "mycomfyui.panelCollapsed.v1";

function readStoredCollapseMap(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? "{}",
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function persistCollapsed(
  panelId: CollapsiblePanelId,
  collapsed: boolean,
): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...readStoredCollapseMap(), [panelId]: collapsed }),
    );
  } catch {
    // 書き込めない環境でも開閉自体は効かせる。次回起動時の復元だけが効かなくなる。
  }
}

export function usePanelCollapsed(
  panelId: CollapsiblePanelId,
): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(
    () => readStoredCollapseMap()[panelId] === true,
  );
  const toggle = useCallback(() => {
    setCollapsed((current) => {
      persistCollapsed(panelId, !current);
      return !current;
    });
  }, [panelId]);
  return [collapsed, toggle];
}
