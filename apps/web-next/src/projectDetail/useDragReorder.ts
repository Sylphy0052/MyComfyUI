import { useRef, useState, type DragEvent } from "react";

/** 並べ替えの動かし方。ドラッグした行を、ドロップ先の位置へ差し込む。 */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return next;
  next.splice(to, 0, moved);
  return next;
}

/**
 * HTML5のネイティブDnDで行を並べ替える。依存ライブラリは使わない。
 * 並び順は呼び出し側が持つので、ドロップで決まった新しい順序を`onReorder`へ渡すだけにする。
 */
export function useDragReorder(ids: readonly string[], onReorder: (ids: string[]) => void) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // 状態は再描画まで古いままなので、続けて発火するイベントの判定にはrefを使う。
  const dragRef = useRef<string | null>(null);

  const reset = () => {
    dragRef.current = null;
    setDragId(null);
    setOverId(null);
  };

  const rowProps = (id: string) => ({
    draggable: true,
    "data-dragging": dragId === id ? "true" : undefined,
    "data-drop-target": overId === id && dragId !== id ? "true" : undefined,
    onDragStart: (event: DragEvent) => {
      event.dataTransfer.effectAllowed = "move";
      // Firefoxはデータを入れないとドラッグが始まらない。
      event.dataTransfer.setData("text/plain", id);
      dragRef.current = id;
      setDragId(id);
    },
    onDragEnter: (event: DragEvent) => {
      if (dragRef.current === null) return;
      event.preventDefault();
      setOverId(id);
    },
    onDragOver: (event: DragEvent) => {
      if (dragRef.current === null) return;
      // preventDefaultしないと、この要素がドロップ先として扱われない。
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    onDrop: (event: DragEvent) => {
      const dragging = dragRef.current;
      if (dragging === null) return;
      event.preventDefault();
      const from = ids.indexOf(dragging);
      const to = ids.indexOf(id);
      reset();
      if (from >= 0 && to >= 0 && from !== to) onReorder(moveItem(ids, from, to));
    },
    onDragEnd: reset,
  });

  return { rowProps };
}
