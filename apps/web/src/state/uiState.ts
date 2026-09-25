/**
 * 画面状態 (View・タブ・選択中のProject/Scene/Shot) をURLとlocalStorageへ保存し、
 * リロード後の復元と、URLを渡すだけで同じ画面を開ける共有を成立させる。
 *
 * URLを正本とし、URLに無い項目だけlocalStorageで補う。URLを手で編集したときは
 * 前回のセッションより貼られたリンクを優先させたいため、この順序にしている。
 */

/** 作品制作 (モードB) とラボ (モードA)。View・タブはラボの中の位置を表す。 */
export const MODE_VALUES = ["production", "lab"] as const;
export const VIEW_VALUES = [
  "projects",
  "generate",
  "assets",
] as const;
/** Project詳細のタブ。旧`view=characters`はここへ移す。 */
export const PROJECT_TAB_VALUES = ["overview", "characters", "scenes"] as const;
export const GENERATION_TAB_VALUES = [
  "image",
  "video",
  "music",
  "voice",
  "compose",
] as const;
export const IMAGE_SUBTAB_VALUES = ["generate", "change", "derive", "sweep"] as const;

export type Mode = (typeof MODE_VALUES)[number];
export type View = (typeof VIEW_VALUES)[number];
export type GenerationTab = (typeof GENERATION_TAB_VALUES)[number];
export type ImageSubTab = (typeof IMAGE_SUBTAB_VALUES)[number];
export type ProjectTab = (typeof PROJECT_TAB_VALUES)[number];

export type UiState = {
  mode: Mode;
  view: View;
  generationTab: GenerationTab;
  imageSubTab: ImageSubTab;
  projectTab: ProjectTab;
  projectId: string | null;
  sceneId: string | null;
  shotId: string | null;
};

export const DEFAULT_UI_STATE: UiState = {
  mode: "production",
  view: "generate",
  generationTab: "image",
  imageSubTab: "generate",
  projectTab: "overview",
  projectId: null,
  sceneId: null,
  shotId: null,
};

const STORAGE_KEY = "mycomfyui.ui.v1";

/** 壊れた値や極端に長い値でURLとstorageが膨らむのを防ぐ。 */
const MAX_ID_LENGTH = 200;

const PARAM_NAMES = {
  mode: "mode",
  view: "view",
  generationTab: "tab",
  imageSubTab: "sub",
  projectTab: "ptab",
  projectId: "project",
  sceneId: "scene",
  shotId: "shot",
} as const;

function pickEnum<T extends string>(
  values: readonly T[],
  raw: string | null | undefined,
): T | undefined {
  if (!raw) return undefined;
  return values.find((value) => value === raw);
}

function pickId(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_ID_LENGTH) return undefined;
  return trimmed;
}

/**
 * Projectを外すとScene/Shotは宙に浮く。復元時に前のProjectのIDが混ざると
 * 存在しないShotを選び続けることになるため、ここで打ち切る。
 */
function withConsistentSelection(state: UiState): UiState {
  if (!state.projectId) {
    return { ...state, projectId: null, sceneId: null, shotId: null };
  }
  if (!state.sceneId) return { ...state, sceneId: null, shotId: null };
  return state;
}

export function readUrlUiState(search: string): Partial<UiState> {
  const params = new URLSearchParams(search);
  const partial: Partial<UiState> = {};

  const rawView = params.get(PARAM_NAMES.view);
  const view = pickEnum(VIEW_VALUES, rawView);
  if (view) partial.view = view;
  const projectTab = pickEnum(PROJECT_TAB_VALUES, params.get(PARAM_NAMES.projectTab));
  if (projectTab) partial.projectTab = projectTab;
  if (!view && rawView === "characters") {
    // 旧「キャラクター」画面はProject詳細のキャラクタータブへ移した。旧リンクの意味をptabより優先する。
    partial.view = "projects";
    partial.projectTab = "characters";
  }
  const generationTab = pickEnum(
    GENERATION_TAB_VALUES,
    params.get(PARAM_NAMES.generationTab),
  );
  if (generationTab) partial.generationTab = generationTab;
  const imageSubTab = pickEnum(
    IMAGE_SUBTAB_VALUES,
    params.get(PARAM_NAMES.imageSubTab),
  );
  if (imageSubTab) partial.imageSubTab = imageSubTab;

  const projectId = pickId(params.get(PARAM_NAMES.projectId));
  if (projectId) partial.projectId = projectId;
  const sceneId = pickId(params.get(PARAM_NAMES.sceneId));
  if (sceneId) partial.sceneId = sceneId;
  const shotId = pickId(params.get(PARAM_NAMES.shotId));
  if (shotId) partial.shotId = shotId;

  // モード導入前のリンクはViewやタブだけを持つ。それらはラボの位置なので、
  // modeが無ければラボで開く。modeが明示されていればそちらを優先する。
  const mode = pickEnum(MODE_VALUES, params.get(PARAM_NAMES.mode));
  if (mode) partial.mode = mode;
  else if (view || rawView === "characters" || projectTab || generationTab || imageSubTab)
    partial.mode = "lab";

  return partial;
}

export function readStoredUiState(): Partial<UiState> {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // プライベートモードなどでstorageが使えない環境では永続化を諦め、既定値で開く。
    return {};
  }
  if (!raw) return {};

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};

  const source = parsed as Record<string, unknown>;
  const partial: Partial<UiState> = {};
  const mode = pickEnum(
    MODE_VALUES,
    typeof source.mode === "string" ? source.mode : null,
  );
  if (mode) partial.mode = mode;
  const rawView = typeof source.view === "string" ? source.view : null;
  const view = pickEnum(VIEW_VALUES, rawView);
  if (view) partial.view = view;
  else if (rawView === "characters") {
    partial.view = "projects";
    partial.projectTab = "characters";
  }
  const projectTab = pickEnum(
    PROJECT_TAB_VALUES,
    typeof source.projectTab === "string" ? source.projectTab : null,
  );
  if (projectTab) partial.projectTab = projectTab;
  const generationTab = pickEnum(
    GENERATION_TAB_VALUES,
    typeof source.generationTab === "string" ? source.generationTab : null,
  );
  if (generationTab) partial.generationTab = generationTab;
  const imageSubTab = pickEnum(
    IMAGE_SUBTAB_VALUES,
    typeof source.imageSubTab === "string" ? source.imageSubTab : null,
  );
  if (imageSubTab) partial.imageSubTab = imageSubTab;
  const projectId = pickId(
    typeof source.projectId === "string" ? source.projectId : null,
  );
  if (projectId) partial.projectId = projectId;
  const sceneId = pickId(
    typeof source.sceneId === "string" ? source.sceneId : null,
  );
  if (sceneId) partial.sceneId = sceneId;
  const shotId = pickId(
    typeof source.shotId === "string" ? source.shotId : null,
  );
  if (shotId) partial.shotId = shotId;

  return partial;
}

/** 起動時の初期状態。URL > localStorage > 既定値の順に採用する。 */
export function readInitialUiState(): UiState {
  const stored = readStoredUiState();
  const fromUrl: Partial<UiState> = { ...readUrlUiState(window.location.search) };
  // Projectを伴わないScene/ShotはURLから受け取らない。どのProjectのIDか
  // 判断できず、前回のProjectと噛み合わない組で開くことになるため。
  if (!fromUrl.projectId) {
    delete fromUrl.sceneId;
    delete fromUrl.shotId;
  }
  // URLで別のProjectを指定されたら、前回のScene/Shotは持ち越さない。
  // 他のProjectに属するIDのまま開くと、存在しない選択で一度取得しに行くことになる。
  const carried =
    fromUrl.projectId && fromUrl.projectId !== stored.projectId
      ? { ...stored, sceneId: null, shotId: null }
      : stored;
  return withConsistentSelection({
    ...DEFAULT_UI_STATE,
    ...carried,
    ...fromUrl,
  });
}

/** 戻る操作で復元する状態。URLに無い項目は既定値へ戻し、履歴をそのまま再現する。 */
export function uiStateFromUrl(search: string): UiState {
  return withConsistentSelection({
    ...DEFAULT_UI_STATE,
    ...readUrlUiState(search),
  });
}

export function toSearchString(state: UiState): string {
  const params = new URLSearchParams();
  // 既定値は省いてURLを短く保つ。共有されたリンクで何が指定されたかを読み取りやすくする。
  // modeの無いview/tab付きURLはラボとして読むため、view/tabを書くときはmodeも明示する。
  const hasLabPosition =
    state.view !== DEFAULT_UI_STATE.view ||
    state.projectTab !== DEFAULT_UI_STATE.projectTab ||
    state.generationTab !== DEFAULT_UI_STATE.generationTab ||
    state.imageSubTab !== DEFAULT_UI_STATE.imageSubTab;
  if (state.mode !== DEFAULT_UI_STATE.mode || hasLabPosition) {
    params.set(PARAM_NAMES.mode, state.mode);
  }
  if (state.view !== DEFAULT_UI_STATE.view) {
    params.set(PARAM_NAMES.view, state.view);
  }
  if (state.projectTab !== DEFAULT_UI_STATE.projectTab) {
    params.set(PARAM_NAMES.projectTab, state.projectTab);
  }
  if (state.generationTab !== DEFAULT_UI_STATE.generationTab) {
    params.set(PARAM_NAMES.generationTab, state.generationTab);
  }
  if (state.imageSubTab !== DEFAULT_UI_STATE.imageSubTab) {
    params.set(PARAM_NAMES.imageSubTab, state.imageSubTab);
  }
  if (state.projectId) params.set(PARAM_NAMES.projectId, state.projectId);
  if (state.sceneId) params.set(PARAM_NAMES.sceneId, state.sceneId);
  if (state.shotId) params.set(PARAM_NAMES.shotId, state.shotId);

  const query = params.toString();
  return query ? `?${query}` : "";
}

/**
 * 状態をURLとlocalStorageへ書き出す。
 * View切替だけ履歴へ積み、タブや選択の変更はreplaceにする。タブを押すたびに
 * 履歴が伸びると、戻るボタンで前の画面へ帰れなくなるため。
 */
export function persistUiState(
  state: UiState,
  mode: "push" | "replace",
): void {
  const next = `${window.location.pathname}${toSearchString(state)}${window.location.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (mode === "push") {
    if (next !== current) window.history.pushState(null, "", next);
  } else {
    window.history.replaceState(null, "", next);
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 書き込めない環境でも操作は続けられるようにする。復元だけが効かなくなる。
  }
}
