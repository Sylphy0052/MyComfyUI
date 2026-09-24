import { useEffect, useRef } from "react";

import { WorkflowRegistry } from "./WorkflowRegistry";

interface Props {
  open: boolean;
  onClose: () => void;
  sceneId: string | null;
  shotId: string | null;
  /** 開いている間はdialog要素を、閉じたらnullを渡す。トーストの表示先に使う。 */
  onDialogOpenChange: (dialog: HTMLDialogElement | null) => void;
}

/** Workflowの登録・版・スナップショットをラボの画面の上に開くダイアログ。 */
export function WorkflowRegistryDialog({
  open,
  onClose,
  sceneId,
  shotId,
  onDialogOpenChange,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    onDialogOpenChange(open ? dialog : null);
  }, [open, onDialogOpenChange]);

  return (
    <dialog
      ref={dialogRef}
      className="panel workflow-registry-dialog"
      aria-label="Workflow"
      onClose={() => {
        // Escで閉じたときはブラウザが先にdialogを閉じる。effectを待つとトーストが閉じたdialogに
        // 一瞬残って見えなくなるため、closeイベントの時点で表示先を戻す。
        onDialogOpenChange(null);
        onClose();
      }}
      // 開いている間は、背後の画面のショートカット (採否など) へキーを渡さない。
      onKeyDown={(event) => event.stopPropagation()}
    >
      {/* 開くたびに取り直すため、閉じている間はmountしない。 */}
      {open && <WorkflowRegistry sceneId={sceneId} shotId={shotId} />}
      <button type="button" onClick={onClose}>
        閉じる
      </button>
    </dialog>
  );
}
