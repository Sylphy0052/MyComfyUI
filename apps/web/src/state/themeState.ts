/**
 * 配色テーマ (ライト・ダーク・システム追随) をlocalStorageへ保存し、
 * 起動直後の一瞬だけ別テーマで表示されるFOUCを避けるために、
 * 適用先属性 (`document.documentElement`の`data-theme`) の計算をUI状態から切り出す。
 *
 * `index.html`内のインラインスクリプトも同じstorage keyと解決規則を使うため、
 * ここでの定義変更時はそちらも合わせて直す。
 */

export const THEME_PREFERENCE_VALUES = ["light", "dark", "system"] as const;
export type ThemePreference = (typeof THEME_PREFERENCE_VALUES)[number];

/** `data-theme`属性へ書く、解決済みの見た目。system選択時はこちらへ解決してから書く。 */
export type ResolvedTheme = "light" | "dark";

export const DEFAULT_THEME_PREFERENCE: ThemePreference = "system";

const STORAGE_KEY = "mycomfyui.theme.v1";

const SYSTEM_LIGHT_QUERY = "(prefers-color-scheme: light)";

function pickThemePreference(raw: string | null | undefined): ThemePreference | undefined {
  if (!raw) return undefined;
  return THEME_PREFERENCE_VALUES.find((value) => value === raw);
}

/** プライベートモードなどでstorageが使えない環境では、既定値へ諦めて開く。 */
export function readStoredThemePreference(): ThemePreference {
  try {
    return pickThemePreference(window.localStorage.getItem(STORAGE_KEY)) ?? DEFAULT_THEME_PREFERENCE;
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

export function persistThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // 書き込めない環境でも操作は続けられるようにする。次回起動時の復元だけが効かなくなる。
  }
}

/** systemの実体はOS設定次第で変わるため、都度この関数で解決した値をdata-theme属性へ書く。 */
export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference !== "system") return preference;
  try {
    return window.matchMedia(SYSTEM_LIGHT_QUERY).matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyResolvedTheme(theme: ResolvedTheme): void {
  document.documentElement.setAttribute("data-theme", theme);
}
