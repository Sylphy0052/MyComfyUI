import {
  DEFAULT_THEME_PREFERENCE,
  FALLBACK_RESOLVED_THEME,
  SYSTEM_LIGHT_QUERY,
  THEME_PREFERENCE_VALUES,
  THEME_STORAGE_KEY,
} from "./themeState";

/**
 * React描画前に`data-theme`属性を確定させ、既定 (ダーク) からの一瞬の切替 (FOUC) を防ぐスクリプト。
 * vite.config.tsのプラグインが、dev serverの配信時とビルド時に`index.html`の`<head>`へ差し込む。
 * storage key・選択肢・既定値・クエリ・フォールバックの値はthemeState.tsの定数から埋め込む。
 * systemを解決する分岐はthemeState.tsの`resolveTheme`と揃えて手で書いている。
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
