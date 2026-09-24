import {
  DEFAULT_THEME_PREFERENCE,
  FALLBACK_RESOLVED_THEME,
  SYSTEM_LIGHT_QUERY,
  THEME_PREFERENCE_VALUES,
  THEME_STORAGE_KEY,
} from "./themeState";

/**
 * React描画前に`data-theme`属性を確定させ、既定 (ダーク) からの一瞬の切替 (FOUC) を防ぐスクリプト。
 * vite.config.tsのプラグインがビルド時に`index.html`の`<head>`へ差し込む。
 * storage keyと解決規則はthemeState.tsの定数から組み立て、二重管理を避ける。
 * 設定ファイルから読まれるため、モジュールの評価時にブラウザのAPIへ触れない。
 */
export function buildThemeBootScript(): string {
  return `(function () {
  var root = document.documentElement;
  try {
    var stored = window.localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    var preference = ${JSON.stringify(THEME_PREFERENCE_VALUES)}.indexOf(stored) >= 0 ? stored : ${JSON.stringify(DEFAULT_THEME_PREFERENCE)};
    root.setAttribute(
      "data-theme",
      preference !== "system"
        ? preference
        : window.matchMedia(${JSON.stringify(SYSTEM_LIGHT_QUERY)}).matches
          ? "light"
          : "dark"
    );
  } catch (e) {
    root.setAttribute("data-theme", ${JSON.stringify(FALLBACK_RESOLVED_THEME)});
  }
})();`;
}
