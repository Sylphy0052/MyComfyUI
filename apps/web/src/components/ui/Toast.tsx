import type { ReactNode } from "react";

import { Icon } from "./Icon";
import { IconButton } from "./IconButton";

export type ToastTone = "info" | "success" | "danger";

/**
 * 作業を止めずに結果を知らせる通知1件分。表示位置と表示期間の管理は
 * 呼び出し側（通知の配線、R-04）で行う。
 *
 * 失敗は即座に読み上げるため alert、それ以外は status とする。
 */
export function Toast({
  tone = "info",
  message,
  action,
  onDismiss,
}: {
  tone?: ToastTone;
  message: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div
      className={`toast toast-${tone}`}
      role={tone === "danger" ? "alert" : "status"}
    >
      <span className="toast-message">{message}</span>
      {action}
      {onDismiss && (
        <IconButton
          icon={<Icon name="x" />}
          label="通知を閉じる"
          onClick={onDismiss}
        />
      )}
    </div>
  );
}
