import type { DragEvent } from "react";

/**
 * 一覧の画像をMediaPickerへドラッグして割り当てるときのdataTransfer形式 (Issue #150)。
 * dragover中はgetDataが空を返すため、受け入れ可否はtypesにこの値があるかで判断する。
 */
export const ARTIFACT_DRAG_TYPE = "application/x-mycomfyui-artifact";

export interface ArtifactDragPayload {
  id: string;
  media_type: string;
}

/** ドラッグ元の要素のonDragStartから呼ぶ。 */
export function startArtifactDrag(event: DragEvent<HTMLElement>, payload: ArtifactDragPayload): void {
  event.dataTransfer.setData(ARTIFACT_DRAG_TYPE, JSON.stringify(payload));
  event.dataTransfer.effectAllowed = "copy";
}

/** drop時にpayloadを取り出す。形式が合わなければnullを返す。 */
export function readArtifactDrag(dataTransfer: DataTransfer): ArtifactDragPayload | null {
  const raw = dataTransfer.getData(ARTIFACT_DRAG_TYPE);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as ArtifactDragPayload).id === "string" &&
      typeof (parsed as ArtifactDragPayload).media_type === "string"
    ) {
      const { id, media_type } = parsed as ArtifactDragPayload;
      return { id, media_type };
    }
  } catch {
    // 他アプリから同じtypeで来た壊れたデータは無視する。
  }
  return null;
}

export function hasArtifactDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(ARTIFACT_DRAG_TYPE);
}

export function hasFileDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes("Files");
}
