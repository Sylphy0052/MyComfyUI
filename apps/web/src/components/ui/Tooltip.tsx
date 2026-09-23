import type { ReactNode } from "react";

/**
 * hover とキーボードフォーカスで出る短いラベル。
 *
 * 見た目の補助に限り、支援技術からは隠す。読み上げる名前は子要素に
 * aria-label などで持たせる。
 */
export function Tooltip({
  content,
  children,
}: {
  content: ReactNode;
  children: ReactNode;
}) {
  return (
    <span className="tooltip-host">
      {children}
      <span className="tooltip" aria-hidden="true">
        {content}
      </span>
    </span>
  );
}
