import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

/**
 * 主要画面の左右ペインに幅変更・折りたたみを共通で与える部品。
 *
 * ペイン幅の指定・折りたたみ時の帯・ドラッグハンドルをここへ集約し、
 * 個々の画面のCSSへ `grid-template-columns` を書き足していく状態を避ける。
 * 幅・折りたたみの値そのものは呼び出し側 (state/layoutState.ts) が持ち、
 * この部品は見た目と操作だけを担う。
 */
export function ResizablePane({
  side,
  label,
  collapsed,
  onToggleCollapse,
  onResizeStart,
  children,
}: {
  /** グリッド内での位置。ハンドルの位置とアイコンの向きを決める。 */
  side: "left" | "right";
  /** 折りたたみボタンのaria-label等に使う、ペインの名前。 */
  label: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  if (collapsed) {
    const expandGlyph = side === "left" ? "»" : "«";
    return (
      <div className="pane-shell pane-shell--collapsed" data-side={side}>
        <button
          type="button"
          className="pane-collapse-toggle"
          onClick={onToggleCollapse}
          aria-label={`${label}を開く`}
          title={`${label}を開く`}
        >
          {expandGlyph}
        </button>
      </div>
    );
  }

  const collapseGlyph = side === "left" ? "«" : "»";
  const handle = (
    <div
      className="pane-resize-handle"
      data-side={side}
      role="separator"
      aria-orientation="vertical"
      aria-label={`${label}の幅を変更`}
      onPointerDown={onResizeStart}
    />
  );
  const toolbar = (
    <div className="pane-shell__toolbar" data-side={side}>
      <button
        type="button"
        className="pane-collapse-toggle"
        onClick={onToggleCollapse}
        aria-label={`${label}を畳む`}
        title={`${label}を畳む`}
      >
        {collapseGlyph}
      </button>
    </div>
  );

  return (
    <div className="pane-shell" data-side={side}>
      {side === "right" && handle}
      {toolbar}
      <div className="pane-shell__body">{children}</div>
      {side === "left" && handle}
    </div>
  );
}
