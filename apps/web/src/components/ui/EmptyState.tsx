import type { ReactNode } from "react";

/** 一覧が空のとき、空である理由と次の一手を示す。 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <p className="empty-state-title">{title}</p>
      {description && <p className="muted">{description}</p>}
      {action}
    </div>
  );
}
