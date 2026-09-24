import { createPortal } from "react-dom";

import { Button } from "./Button";
import { Toast } from "./Toast";
import type { ToastTone } from "./Toast";

export type ToastItem = {
  id: string;
  tone: ToastTone;
  message: string;
  jobId?: string;
  group?: string;
  action?: {
    label: string;
    onAction: () => void;
  };
};

/**
 * 複数件の Toast を画面隅へ積んで表示する。入力欄と重ならない位置に
 * 固定し、モーダルにはしない (作業を妨げないため)。
 */
export function ToastRegion({
  toasts,
  onDismiss,
  onNavigate,
}: {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
  onNavigate: (jobId: string) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-region" aria-live="polite">
      {toasts.map(({ action, ...toast }) => (
        <Toast
          key={toast.id}
          tone={toast.tone}
          onDismiss={() => onDismiss(toast.id)}
          action={
            action && (
              <Button
                variant="ghost"
                onClick={() => {
                  onDismiss(toast.id);
                  action.onAction();
                }}
              >
                {action.label}
              </Button>
            )
          }
          message={
            toast.jobId ? (
              <button
                type="button"
                className="toast-message-link"
                onClick={() => onNavigate(toast.jobId!)}
              >
                {toast.message}
              </button>
            ) : (
              toast.message
            )
          }
        />
      ))}
    </div>
  );
}

/**
 * top layerで開いている<dialog>があればその中へ、無ければ通常のDOMへToastRegionを描画する。
 * <dialog>のshowModal()中は通常DOMの要素がz-indexに関わらず隠れるため (#186)。
 */
export function ToastHost({
  dialogEl,
  ...region
}: {
  dialogEl: HTMLDialogElement | null;
} & Parameters<typeof ToastRegion>[0]) {
  const content = <ToastRegion {...region} />;
  return dialogEl ? createPortal(content, dialogEl) : content;
}
