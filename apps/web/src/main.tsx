import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root が見つかりません。");
}

// ドロップ先を外れたファイルをブラウザが開き、編集中の画面を失わないようにする (Issue #150)。
// ファイルのドラッグだけを止め、テキスト欄へのテキストのドロップは妨げない。
window.addEventListener("dragover", (event) => {
  if (event.defaultPrevented || !event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "none";
});
window.addEventListener("drop", (event) => {
  if (event.defaultPrevented || !event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
});

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
