import type { GenerationExperimentBody, Recipe } from "../api/client";
import { buildInputs, SEED_MAX, type ImageForm, type ImageTarget, type SweepMode } from "./imageForm";
import type { SupplementTags } from "./promptTags";

export type SweepAxisName = "seed" | "cfg" | "steps" | "prompt_fragment";

/** 軸の表示順。backendの`GenerationSweepAxes`と同じ並びで、見出しとラベルもこの順に出す。 */
export const AXIS_ORDER: SweepAxisName[] = ["seed", "cfg", "steps", "prompt_fragment"];

/** 見出しとラベルに出す軸名。 */
export const AXIS_LABELS: Record<SweepAxisName, string> = {
  seed: "seed",
  cfg: "cfg",
  steps: "steps",
  prompt_fragment: "断片",
};

// backendの`GenerationSweepAxes`・`GenerationExperimentCreate`・`_expand_experiment`に合わせた上限。
const AXIS_VALUES_MAX = 20;
const CFG_MAX = 100;
const STEPS_MAX = 1_000;
const FRAGMENT_MAX_LENGTH = 2_000;
const RAW_COMBINATIONS_MAX = 1_000;
/** 重複を除いた後の投入件数の上限。 */
export const SWEEP_ITEMS_MAX = 50;

/** 軸ごとの値。入力欄が空の軸は空配列で、スイープしない。 */
export type SweepAxes = Record<SweepAxisName, (number | string)[]>;

export type SweepPlan =
  | {
      ok: true;
      axes: SweepAxes;
      /** 値のある軸。AXIS_ORDER順。 */
      active: SweepAxisName[];
      mode: SweepMode;
      /** 重複を除いた投入件数。 */
      count: number;
      /** 「cfg 3値 × steps 2値 = 6件」のような表示。 */
      summary: string;
    }
  | { ok: false; reason: string };

/** 数値の列をカンマ・空白・改行で分けた生の文字列にする。空の項目は捨てる。 */
function splitNumbers(text: string): string[] {
  return text
    .split(/[,\s、，]+/)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/** プロンプト断片は`|`か改行で分ける。タグ自体がカンマを含むため、カンマでは分けない。 */
export function splitFragments(text: string): string[] {
  return text
    .split(/[|\n]/)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

type Parsed<T> = { ok: true; values: T[] } | { ok: false; reason: string };

function parseNumbers(text: string, name: string, accept: (value: number) => boolean, rule: string): Parsed<number> {
  const values: number[] = [];
  for (const raw of splitNumbers(text)) {
    const value = Number(raw);
    if (!Number.isFinite(value) || !accept(value)) return { ok: false, reason: `${name}は${rule} (「${raw}」)` };
    values.push(value);
  }
  return { ok: true, values };
}

const isInteger = (value: number) => Number.isInteger(value);

function parseAxes(form: ImageForm): { ok: true; axes: SweepAxes } | { ok: false; reason: string } {
  const seed = parseNumbers(
    form.sweepSeed,
    "seed",
    (value) => isInteger(value) && (value === -1 || (value >= 0 && value <= SEED_MAX)),
    "-1または0以上の整数で入れてください",
  );
  if (!seed.ok) return seed;
  const cfg = parseNumbers(form.sweepCfg, "cfg", (value) => value > 0 && value <= CFG_MAX, `0より大きく${CFG_MAX}以下で入れてください`);
  if (!cfg.ok) return cfg;
  const steps = parseNumbers(
    form.sweepSteps,
    "steps",
    (value) => isInteger(value) && value >= 1 && value <= STEPS_MAX,
    `1以上${STEPS_MAX}以下の整数で入れてください`,
  );
  if (!steps.ok) return steps;
  const fragments = splitFragments(form.sweepFragment);
  if (fragments.some((item) => item.length > FRAGMENT_MAX_LENGTH)) {
    return { ok: false, reason: `プロンプト断片は${FRAGMENT_MAX_LENGTH}文字以下にしてください` };
  }
  const axes: SweepAxes = { seed: seed.values, cfg: cfg.values, steps: steps.values, prompt_fragment: fragments };
  for (const name of AXIS_ORDER) {
    if (axes[name].length > AXIS_VALUES_MAX) {
      return { ok: false, reason: `${AXIS_LABELS[name]}は${AXIS_VALUES_MAX}値までです` };
    }
  }
  return { ok: true, axes };
}

/** 軸の値の組み合わせ。backendの`_expand_experiment`と同じ順で、重複は除く。 */
export function expandCombinations(axes: SweepAxes, mode: SweepMode): Record<string, number | string>[] {
  const active = AXIS_ORDER.filter((name) => axes[name].length > 0);
  let rows: (number | string)[][] = [[]];
  if (mode === "cartesian") {
    for (const name of active) rows = rows.flatMap((row) => axes[name].map((value) => [...row, value]));
  } else {
    const length = Math.max(...active.map((name) => axes[name].length));
    rows = Array.from({ length }, (_, index) =>
      active.map((name) => (axes[name].length === 1 ? axes[name][0] : axes[name][index])),
    );
  }
  const seen = new Set<string>();
  const unique: Record<string, number | string>[] = [];
  for (const row of rows) {
    const key = JSON.stringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(Object.fromEntries(active.map((name, index) => [name, row[index]])));
  }
  return unique;
}

/** 入力欄の内容から、投入できるスイープかを決める。 */
export function planSweep(form: ImageForm): SweepPlan {
  const parsed = parseAxes(form);
  if (!parsed.ok) return parsed;
  const { axes } = parsed;
  const active = AXIS_ORDER.filter((name) => axes[name].length > 0);
  if (active.length === 0) return { ok: false, reason: "軸を1つ以上入れてください" };
  const lengths = active.map((name) => axes[name].length);
  const mode = form.sweepMode;
  if (mode === "zip") {
    const longest = Math.max(...lengths);
    if (lengths.some((length) => length !== 1 && length !== longest)) {
      return { ok: false, reason: "対にするときは、各軸の値の数を1つか最も多い軸に揃えてください" };
    }
  } else if (lengths.reduce((total, length) => total * length, 1) > RAW_COMBINATIONS_MAX) {
    return { ok: false, reason: `組み合わせが${RAW_COMBINATIONS_MAX}件を超えます` };
  }
  const count = expandCombinations(axes, mode).length;
  if (count > SWEEP_ITEMS_MAX) {
    return { ok: false, reason: `${count}件になります。重複を除いて${SWEEP_ITEMS_MAX}件以下にしてください` };
  }
  const parts = active.map((name) => `${AXIS_LABELS[name]} ${axes[name].length}値`);
  const summary =
    mode === "zip" ? `対: ${count}件 (${parts.join("・")})` : `${parts.join(" × ")} = ${count}件`;
  return { ok: true, axes, active, mode, count, summary };
}

/** セルのラベル用に値を短くする。 */
function valueText(name: SweepAxisName, value: unknown): string {
  const text = String(value);
  return name === "prompt_fragment" && text.length > 24 ? `${text.slice(0, 24)}…` : text;
}

/** 「cfg=5 / steps=20」のようなセルのラベル。 */
export function cellLabel(variables: Record<string, unknown>): string {
  return AXIS_ORDER.filter((name) => name in variables)
    .map((name) => `${AXIS_LABELS[name]}=${valueText(name, variables[name])}`)
    .join(" / ");
}

export function axisValueText(name: SweepAxisName, value: unknown): string {
  return valueText(name, value);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 実験名。日時と、スイープした軸を入れる。 */
export function sweepName(now: Date, active: SweepAxisName[]): string {
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `sweep ${stamp} ${active.map((name) => AXIS_LABELS[name]).join("×")}`;
}

/** seedがランダムで軸にも無いとき、全セルで揃えるseed。比較の違いを軸だけにする。 */
function sharedRandomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

/** `POST /generation-experiments`の本文。`base_inputs`は通常の投入と同じ入力にする。 */
export function buildSweepBody(
  plan: Extract<SweepPlan, { ok: true }>,
  form: ImageForm,
  supplement: SupplementTags,
  recipe: Recipe,
  target: ImageTarget,
  now: Date,
): GenerationExperimentBody {
  const baseInputs = buildInputs(form, supplement, recipe);
  if (plan.axes.seed.length === 0 && form.seedMode === "random" && "seed" in baseInputs) {
    baseInputs.seed = sharedRandomSeed();
  }
  const axes: GenerationExperimentBody["axes"] = {};
  if (plan.axes.seed.length > 0) axes.seed = plan.axes.seed as number[];
  if (plan.axes.cfg.length > 0) axes.cfg = plan.axes.cfg as number[];
  if (plan.axes.steps.length > 0) axes.steps = plan.axes.steps as number[];
  if (plan.axes.prompt_fragment.length > 0) axes.prompt_fragment = plan.axes.prompt_fragment as string[];
  return {
    name: sweepName(now, plan.active),
    recipe_id: recipe.id,
    base_inputs: baseInputs,
    axes,
    mode: plan.mode,
    project_id: target.projectId,
    story_scene_id: target.sceneId,
    story_character_id: target.characterId,
    story_costume_id: target.costumeId,
  };
}
