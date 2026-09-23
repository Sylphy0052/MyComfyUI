import { useEffect, useRef, useState } from "react";

import { ignoresShortcut } from "./ui/shortcuts";

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: "作品制作 (モードB)",
    items: [
      ["G", "画像生成を投入する"],
      ["← / →", "前 / 次の候補を選ぶ"],
      ["A", "選択中の候補を採用する"],
      ["X", "選択中の候補を却下する"],
      ["U", "選択中の候補の判定を戻す"],
      ["N", "次のShotへ移る"],
    ],
  },
  {
    title: "ラボの候補比較",
    items: [
      ["[ / ]", "比較のA / Bを操作対象にする"],
      ["← / →", "操作対象の側の候補を切り替える"],
      ["A / X / U", "操作対象の候補を採用 / 却下 / 判定を戻す"],
      ["F", "全画面比較を切り替える"],
    ],
  },
  {
    title: "共通",
    items: [
      ["?", "この一覧を開く"],
      ["Esc", "一覧・全画面を閉じる"],
    ],
  },
];

/** ヘッダーに置くショートカット一覧のボタンとダイアログ。?キーでも開く。 */
export function ShortcutHelp() {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      // ?はShiftと併用して打つため、ignoresShortcutの修飾キー判定 (Shiftを含まない) で弾かれない。
      if (event.key !== "?" || ignoresShortcut(event)) return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="shortcut-help-button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
      >
        ショートカット (?)
      </button>
      <dialog
        ref={dialogRef}
        className="panel shortcut-help"
        aria-label="キーボードショートカット"
        onClose={() => setOpen(false)}
        // 一覧を開いている間は、背後の画面のショートカット (採否など) へキーを渡さない。
        onKeyDown={(event) => event.stopPropagation()}
      >
        <h2>キーボードショートカット</h2>
        <p className="muted">入力欄で文字を打っている間は反応しません。</p>
        {GROUPS.map((group) => (
          <section key={group.title}>
            <h3>{group.title}</h3>
            <dl>
              {group.items.map(([key, description]) => (
                <div key={key} className="shortcut-row">
                  <dt>
                    <kbd>{key}</kbd>
                  </dt>
                  <dd>{description}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <button type="button" onClick={() => setOpen(false)}>
          閉じる
        </button>
      </dialog>
    </>
  );
}
