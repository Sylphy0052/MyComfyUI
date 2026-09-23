import type { ReactNode } from "react";

import { classNames } from "./Button";

/**
 * 状態を示す小さな札。tone には既存の状態クラス（succeeded、failed、
 * decision-accepted など）を渡し、色は styles.css 側で決める。
 */
export function Badge({
  tone,
  className,
  children,
}: {
  tone?: string;
  className?: string;
  children: ReactNode;
}) {
  return <span className={classNames("badge", tone, className)}>{children}</span>;
}
