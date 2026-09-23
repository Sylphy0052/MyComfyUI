/**
 * 作品制作の計画 (F-07 #152)。場面または日本語の記述から、工程ごとの内容とPresetを組む。
 *
 * 計画はF-06の工程と同じくフロント側で場面ごとに `localStorage` へ持つ。APIとDBは変えない。
 * 開始後は各パネルが計画のPresetと選ばせる項目の値を使い、工程ごとに設定を組み直さずに進める。
 */
import { useEffect, useRef } from "react";

import type { LookProfile, Recipe } from "../api/client";
import type { CanonDescriptor, SceneData } from "../api/aimedia";
import type { PipelineStepId } from "./pipelineState";

/** Presetを割り当てる枠。音声・BGMの工程は台詞とBGMで別のPresetを持つ。 */
export type PresetSlotId = "background" | "character" | "voice" | "music" | "video" | "finish";

export interface PresetSlot {
  id: PresetSlotId;
  step: PipelineStepId;
  label: string;
  kind: string;
  /** 候補を絞るPresetの分類。未指定なら分類を問わない。 */
  category?: string;
}

export const PRESET_SLOTS: readonly PresetSlot[] = [
  { id: "background", step: "background", label: "背景", kind: "image", category: "background" },
  { id: "character", step: "character", label: "キャラクター参照", kind: "image", category: "character" },
  { id: "voice", step: "audio", label: "台詞", kind: "voice" },
  { id: "music", step: "audio", label: "BGM", kind: "music" },
  { id: "video", step: "video", label: "動画", kind: "video" },
  { id: "finish", step: "finish", label: "仕上げ", kind: "compose" },
];

export interface NamedItem {
  id: string;
  name: string;
}

export interface ProductionPlan {
  sceneId: string;
  /** 場面の設定から組んだか、日本語の記述から組んだか。 */
  source: "scene" | "brief";
  brief: string;
  background: { location: string; timeOfDay: string; note: string };
  characters: NamedItem[];
  audio: { bgmMood: string; bgmGenre: string };
  /** 枠ごとのPreset ID。無い枠は「Project/場面の既定値」を使う。 */
  presets: Partial<Record<PresetSlotId, string>>;
  /** Preset IDごとの、モードBで選ばせる項目の値。 */
  choiceValues: Record<string, Record<string, string>>;
  started: boolean;
}

const STORAGE_KEY = "mycomfyui.productionPlan.v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isPlan(value: unknown, sceneId: string): value is ProductionPlan {
  if (!isRecord(value) || value.sceneId !== sceneId) return false;
  const { background, audio, characters, presets, choiceValues } = value;
  return (
    (value.source === "scene" || value.source === "brief") &&
    typeof value.brief === "string" &&
    typeof value.started === "boolean" &&
    isStringRecord(background) &&
    isStringRecord(audio) &&
    Array.isArray(characters) &&
    characters.every((item) => isRecord(item) && typeof item.id === "string" && typeof item.name === "string") &&
    isStringRecord(presets) &&
    isRecord(choiceValues) &&
    Object.values(choiceValues).every(isStringRecord)
  );
}

function readStoredMap(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 場面の計画を読む。未作成か壊れた値ならnull。 */
export function readProductionPlan(sceneId: string | null): ProductionPlan | null {
  if (!sceneId) return null;
  const stored = readStoredMap()[sceneId];
  return isPlan(stored, sceneId) ? stored : null;
}

/** 他の場面の計画を消さないよう、書き込み直前に読み直して1場面だけ差し替える。nullなら消す。 */
export function persistProductionPlan(sceneId: string, plan: ProductionPlan | null): void {
  const next = { ...readStoredMap() };
  if (plan) next[sceneId] = plan;
  else delete next[sceneId];
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 書き込めない環境でも画面上の計画は使える。再読み込み後の復元だけが効かなくなる。
  }
}

function namedFromScene(item: { id: string; display_name?: string | null }): NamedItem {
  return { id: item.id, name: item.display_name || item.id };
}

/** 工程の枠ごとにPresetの候補を絞る。 */
export function presetCandidates(slot: PresetSlot, profiles: LookProfile[]): LookProfile[] {
  return profiles.filter(
    (profile) => profile.kind === slot.kind && (!slot.category || profile.category === slot.category),
  );
}

/** 各枠の候補の先頭を既定で選ぶ。候補が無い枠はPresetを付けず、Project/場面の既定値を使う。 */
function defaultPresets(profiles: LookProfile[]): Partial<Record<PresetSlotId, string>> {
  const presets: Partial<Record<PresetSlotId, string>> = {};
  for (const slot of PRESET_SLOTS) {
    const first = presetCandidates(slot, profiles)[0];
    if (first) presets[slot.id] = first.id;
  }
  return presets;
}

/** 場面の場所・時間帯・キャラクター・BGM指定から計画を組む。 */
export function planFromScene(scene: SceneData, profiles: LookProfile[]): ProductionPlan {
  return {
    sceneId: scene.id,
    source: "scene",
    brief: "",
    background: {
      location: scene.location ? namedFromScene(scene.location).name : "",
      timeOfDay: scene.time_of_day && scene.time_of_day !== "unknown" ? scene.time_of_day : "",
      note: scene.summary ?? "",
    },
    characters: (scene.characters ?? []).map(namedFromScene),
    audio: { bgmMood: scene.music?.mood ?? "", bgmGenre: scene.music?.genre ?? "" },
    presets: defaultPresets(profiles),
    choiceValues: {},
    started: false,
  };
}

/** 記述に名前が出てくる候補を、記述中の出現順に返す。長い名前を先に取り、短い名前の部分一致を避ける。 */
function matchNames(text: string, candidates: NamedItem[]): NamedItem[] {
  const found: { item: NamedItem; index: number }[] = [];
  let rest = text;
  const byLength = [...candidates].filter((item) => item.name.trim()).sort((a, b) => b.name.length - a.name.length);
  for (const item of byLength) {
    const index = rest.indexOf(item.name);
    if (index < 0 || found.some((entry) => entry.item.id === item.id)) continue;
    found.push({ item, index: text.indexOf(item.name) });
    rest = rest.split(item.name).join(" ".repeat(item.name.length));
  }
  return found.sort((a, b) => a.index - b.index).map((entry) => entry.item);
}

/** 時間帯の語。場面の `time_of_day` の値 (ai-media scene schema) で埋める。長い語を先に照合する。 */
const TIME_OF_DAY_WORDS: readonly [string, string][] = [
  ["早朝", "dawn"],
  ["明け方", "dawn"],
  ["昼下がり", "afternoon"],
  ["午後", "afternoon"],
  ["夕方", "evening"],
  ["夕暮れ", "evening"],
  ["朝", "morning"],
  ["昼", "noon"],
  ["夜", "night"],
];

/**
 * 日本語の記述から計画を組む。LLMは使わず、プロジェクトのCanonにあるキャラクター名・場所名との
 * 照合だけで埋める。照合できなかった項目は空欄のまま残し、確認画面で直させる。
 */
export function planFromBrief(
  sceneId: string,
  brief: string,
  canon: CanonDescriptor[],
  profiles: LookProfile[],
): ProductionPlan {
  const named = (kind: string) =>
    canon
      .filter((item) => item.kind === kind)
      .map((item) => ({ id: item.canon_id, name: item.display_name || item.canon_id }));
  const location = matchNames(brief, named("location"))[0];
  const timeOfDay = TIME_OF_DAY_WORDS.find(([word]) => brief.includes(word))?.[1] ?? "";
  return {
    sceneId,
    source: "brief",
    brief,
    background: { location: location?.name ?? "", timeOfDay, note: brief },
    characters: matchNames(brief, named("character")),
    audio: { bgmMood: "", bgmGenre: "" },
    presets: defaultPresets(profiles),
    choiceValues: {},
    started: false,
  };
}

/** 背景工程のプロンプト欄へ入れる説明。 */
export function backgroundPrompt(plan: ProductionPlan): string {
  const { location, timeOfDay, note } = plan.background;
  return [location, timeOfDay, note].map((item) => item.trim()).filter(Boolean).join(", ");
}

/** 開始済みの計画から、1つの枠へ渡すPreset。 */
export interface PlanPreset {
  profile: LookProfile;
  choiceValues: Record<string, string>;
}

export function planPresetFor(
  plan: ProductionPlan | null,
  slot: PresetSlotId,
  profiles: LookProfile[],
): PlanPreset | null {
  if (!plan?.started) return null;
  const id = plan.presets[slot];
  const profile = id ? profiles.find((item) => item.id === id) : undefined;
  if (!profile) return null;
  return { profile, choiceValues: plan.choiceValues[profile.id] ?? {} };
}

/** Recipeの入力定義に合わせて、選ばせる項目の文字列を送る値へ直す。直せない値は文字列のまま送り、APIの検証に任せる。 */
function coerceChoiceValue(recipe: Recipe, name: string, raw: string): unknown {
  const entry = (recipe.input_schema as Record<string, unknown>)[name];
  const type = isRecord(entry) ? entry.type : undefined;
  if (type === "integer" || type === "number") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : raw;
  }
  if (type === "boolean") return raw === "true";
  return raw;
}

/** PresetがこのRecipeへ適用できない理由。適用できるならnull。 */
export function planPresetBlocker(
  preset: PlanPreset,
  recipe: Recipe | null | undefined,
  useInheritedDefaults: boolean,
): string | null {
  if (useInheritedDefaults) return "Project/場面の既定値を使う設定のため、計画のPresetは適用されません。";
  if (!recipe) return null;
  if (preset.profile.kind !== recipe.kind) return "計画のPresetは別の生成種別用のため適用されません。";
  if (preset.profile.recipe_id && preset.profile.recipe_id !== recipe.id) {
    return "計画のPresetは別のRecipe専用のため、このRecipeでは適用されません。";
  }
  return null;
}

/**
 * 計画のPresetを投入内容へ載せる。Presetが固定する入力はパネルの値を送らず、APIがPresetの値で埋める。
 * 選ばせる項目は計画で決めた値を送る。適用できないときは入力をそのまま返す。
 */
export function applyPlanPreset(
  preset: PlanPreset | null | undefined,
  recipe: Recipe | null | undefined,
  useInheritedDefaults: boolean,
  inputs: Record<string, unknown>,
): { inputs: Record<string, unknown>; look_profile_ids?: string[] } {
  if (!preset || !recipe || planPresetBlocker(preset, recipe, useInheritedDefaults)) return { inputs };
  const next = { ...inputs };
  for (const name of Object.keys(preset.profile.inputs)) delete next[name];
  for (const [name, raw] of Object.entries(preset.choiceValues)) {
    if (raw.trim() !== "") next[name] = coerceChoiceValue(recipe, name, raw);
  }
  return { inputs: next, look_profile_ids: [preset.profile.id] };
}

/**
 * 計画のPresetが値を決める入力名。パネルの値は送られないため、入力チェックで未入力を許す。
 * 適用できないときは空集合を返す。
 */
export function planPresetKeys(
  preset: PlanPreset | null | undefined,
  recipe: Recipe | null | undefined,
  useInheritedDefaults: boolean,
): ReadonlySet<string> {
  if (!preset || !recipe || planPresetBlocker(preset, recipe, useInheritedDefaults)) return new Set();
  const keys = new Set(Object.keys(preset.profile.inputs));
  for (const [name, raw] of Object.entries(preset.choiceValues)) {
    if (raw.trim() !== "") keys.add(name);
  }
  return keys;
}

/**
 * Shotごと・Presetごとに1回だけ、PresetのRecipeを選び既定値の引き継ぎを外す。
 * 使用者がその後に変えた選択は上書きしない。F-06の `VideoPanel` の自動投入と同じ方式。
 */
export function usePlanPresetDefaults(
  preset: PlanPreset | null | undefined,
  shotId: string | null,
  recipes: Recipe[],
  setRecipeId: (id: string) => void,
  setUseInheritedDefaults: (value: boolean) => void,
): void {
  const applied = useRef<string | null>(null);
  const profile = preset?.profile;
  useEffect(() => {
    if (!profile || recipes.length === 0) return;
    const key = `${shotId ?? ""}:${profile.id}`;
    if (applied.current === key) return;
    applied.current = key;
    setUseInheritedDefaults(false);
    if (profile.recipe_id && recipes.some((item) => item.id === profile.recipe_id)) {
      setRecipeId(profile.recipe_id);
    }
  }, [profile, shotId, recipes, setRecipeId, setUseInheritedDefaults]);
}
