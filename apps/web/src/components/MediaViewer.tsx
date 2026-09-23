import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import { api } from "../api/client";
import type { Artifact } from "../api/client";
import { mediaLabel } from "./ArtifactPreview";

/**
 * 一覧のどこからでも拡大・前後移動・動画音声確認を共通化するビューア (#149)。
 *
 * A/B比較やコンタクトシートなど `CandidateGallery` 固有の機能は持たない。
 * ここでは「1件を大きく見る・前後へ移動する」だけに絞る。
 */
interface ViewTransform { zoom: number; x: number; y: number; }
const INITIAL_TRANSFORM: ViewTransform = { zoom: 1, x: 0, y: 0 };
function clampZoom(value: number): number { return Math.min(8, Math.max(0.25, value)); }

function ZoomableImage({ artifact }: { artifact: Artifact }) {
  const [transform, setTransform] = useState(INITIAL_TRANSFORM);
  const [failed, setFailed] = useState(false);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const wheel = (event: globalThis.WheelEvent) => {
      event.preventDefault();
      setTransform((current) => ({
        ...current,
        zoom: clampZoom(current.zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15)),
      }));
    };
    viewport.addEventListener("wheel", wheel, { passive: false });
    return () => viewport.removeEventListener("wheel", wheel);
  }, []);

  if (failed) {
    return <div className="media-viewer-empty muted">画像を取得できません。移動または削除された可能性があります。</div>;
  }

  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const dx = event.clientX - drag.current.x;
    const dy = event.clientY - drag.current.y;
    drag.current = { x: event.clientX, y: event.clientY };
    setTransform((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
  };

  return (
    <div
      ref={viewportRef}
      className="media-viewer-viewport"
      onPointerDown={(event) => {
        drag.current = { x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={pointerMove}
      onPointerUp={(event) => {
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={() => { drag.current = null; }}
    >
      <img
        src={api.artifactContentUrl(artifact.id)}
        alt={`Artifact ${artifact.id}`}
        onError={() => setFailed(true)}
        draggable={false}
        style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.zoom})` }}
      />
    </div>
  );
}

function ViewerMedia({ artifact }: { artifact: Artifact }) {
  const [failed, setFailed] = useState(false);
  const mediaType = artifact.media_type;

  if (artifact.availability !== "complete") {
    return (
      <div className="media-viewer-empty muted">
        実ファイルがなく、記録だけが残っています。
        <span className="muted"> availability: {artifact.availability}</span>
      </div>
    );
  }
  if (mediaType.startsWith("image/")) return <ZoomableImage artifact={artifact} />;
  if (failed) {
    return <div className="media-viewer-empty muted">ファイルを取得できません。移動または削除された可能性があります。</div>;
  }
  const url = api.artifactContentUrl(artifact.id);
  if (mediaType.startsWith("video/")) {
    return <video className="media-viewer-media" onError={() => setFailed(true)} src={url} controls />;
  }
  if (mediaType.startsWith("audio/")) {
    return <audio className="media-viewer-media" onError={() => setFailed(true)} src={url} controls />;
  }
  return (
    <p className="media-viewer-empty">
      <a href={url} target="_blank" rel="noreferrer">{mediaLabel(mediaType)}を開く</a>
      <span className="muted"> ({mediaType})</span>
    </p>
  );
}

interface Props {
  /** 前後移動の対象になる一覧。表示順そのままで渡す。 */
  items: Artifact[];
  /** 開いている項目の index。null なら閉じている (制御コンポーネント)。 */
  index: number | null;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

export function MediaViewer({ items, index, onIndexChange, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const open = index !== null && index >= 0 && index < items.length;
  const item = open && index !== null ? items[index] : null;

  // 表示中の項目を id で覚えておく (一覧が入れ替わっても同じ項目を指し続けるため)。
  // items の参照が変わったレンダーでは更新しない (直後の追従effectがこの値を頼りに index を探し直す)。
  const shownIdRef = useRef<string | null>(null);
  const prevItemsRef = useRef(items);
  const itemsChanged = prevItemsRef.current !== items;
  prevItemsRef.current = items;
  if (!itemsChanged) {
    shownIdRef.current = open && item ? item.id : null;
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      dialog.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // 一覧が入れ替わったとき (ポーリング等による再取得・並び替え)、覚えていた id を探し直して
  // 同じ項目を指すよう index を追従させる。見つからなくなっていたら閉じる。
  // 前へ/次へによる意図的な移動 (onIndexChange呼び出し) はここでは行わない。
  useEffect(() => {
    if (!itemsChanged || index === null) return;
    const id = shownIdRef.current;
    if (id === null) return;
    const nextIndex = items.findIndex((candidate) => candidate.id === id);
    if (nextIndex === -1) {
      onClose();
    } else if (nextIndex !== index) {
      onIndexChange(nextIndex);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsChanged, items, index, onClose, onIndexChange]);

  useEffect(() => {
    if (!open || index === null) return;
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      if (items.length > 1 && event.key === "ArrowRight") {
        event.preventDefault();
        onIndexChange((index + 1) % items.length);
      } else if (items.length > 1 && event.key === "ArrowLeft") {
        event.preventDefault();
        onIndexChange((index - 1 + items.length) % items.length);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [open, index, items.length, onIndexChange]);

  return (
    <dialog
      ref={dialogRef}
      className="media-viewer-dialog"
      aria-label="メディアビューア"
      tabIndex={-1}
      onClose={onClose}
    >
      {item && index !== null && (
        <div className="media-viewer-inner">
          <div className="media-viewer-toolbar row">
            <span className="muted">{index + 1} / {items.length}</span>
            {items.length > 1 && (
              <>
                <button type="button" onClick={() => onIndexChange((index - 1 + items.length) % items.length)}>前へ</button>
                <button type="button" onClick={() => onIndexChange((index + 1) % items.length)}>次へ</button>
              </>
            )}
            <button type="button" onClick={onClose}>閉じる</button>
          </div>
          <div className="media-viewer-body">
            <ViewerMedia key={item.id} artifact={item} />
          </div>
          <p className="muted">画像はdragで移動、wheelでzoom。←/→:前後の項目へ移動、Esc:閉じる。</p>
        </div>
      )}
    </dialog>
  );
}
