/**
 * 1文字キーのショートカットを見送るべきキー入力かを判定する。
 * 入力欄で文字を打っているとき、修飾キーを併用したとき (ブラウザ既定の操作)、
 * キーリピート、モーダルのdialogを開いている間は反応させない。
 */
export function ignoresShortcut(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return true;
  const target = event.target;
  if (target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']")) {
    return true;
  }
  return document.querySelector("dialog[open]") !== null;
}
