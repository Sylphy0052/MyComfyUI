/**
 * 配色テーマ (ライト・ダーク・システム追随) をlocalStorageへ保存し、
 * 起動直後の一瞬だけ別テーマで表示されるFOUCを避けるために、
 * 適用先属性 (`document.documentElement`の`data-theme`) の計算をUI状態から切り出す。
 *
 * 描画前に同じ属性を確定させる`index.html`のスクリプトは、ここの定数から`themeBootScript.ts`が
 * ビルド時に組み立てる。storage keyや解決規則を変えるときは両ファイルを合わせて見る。
 */

export const THEME_PREFERENCE_VALUES = ["light", "dark", "system"] as const;
export type ThemePreference = (typeof THEME_PREFERENCE_VALUES)[number];

/** `data-theme`属性へ書く、解決済みの見た目。system選択時はこちらへ解決してから書く。 */
export type ResolvedTheme = "light" | "dark";

/** storageやmatchMediaが使えず解決できないときの見た目。CSSの既定 (ダーク) に合わせる。 */
export const FALLBACK_RESOLVED_THEME: ResolvedTheme = "dark";

export const DEFAULT_THEME_PREFERENCE: ThemePreference = "system";

export const THEME_STORAGE_KEY = "mycomfyui.theme.v1";

export const SYSTEM_LIGHT_QUERY = "(prefers-color-scheme: light)";

function pickThemePreference(raw: string | null | undefined): ThemePreference | undefined {
  if (!raw) return undefined;
  return THEME_PREFERENCE_VALUES.find((value) => value === raw);
}

/** プライベートモードなどでstorageが使えない環境では、既定値へ諦めて開く。 */
export function readStoredThemePreference(): ThemePreference {
  try {
    return pickThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY)) ?? DEFAULT_THEME_PREFERENCE;
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

export function persistThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch (error) {
    // 書き込めない環境でも操作は続けられるようにする。次回起動時の復元だけが効かなくなるため、
    // 選んだテーマが戻る理由を追えるよう開発者向けに警告だけ残す。
    console.warn("テーマの選択をlocalStorageへ保存できませんでした。次回起動時は既定のテーマで開きます。", error);
  }
}

/** systemの実体はOS設定次第で変わるため、都度この関数で解決した値をdata-theme属性へ書く。 */
export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference !== "system") return preference;
  try {
    return window.matchMedia(SYSTEM_LIGHT_QUERY).matches ? "light" : "dark";
  } catch {
    return FALLBACK_RESOLVED_THEME;
  }
}

export function applyResolvedTheme(theme: ResolvedTheme): void {
  document.documentElement.setAttribute("data-theme", theme);
}

/**
 * OS設定の変更を購読し、解除関数を返す。matchMediaや`addEventListener`が使えない環境では
 * resolveThemeと同じく例外を投げず、追随だけを諦める (選択時点の解決結果は反映済み)。
 */
export function subscribeSystemTheme(onChange: () => void): () => void {
  try {
    const media = window.matchMedia(SYSTEM_LIGHT_QUERY);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  } catch {
    return () => {};
  }
}
