import { useEffect, useMemo, useState } from "react";

import { ApiError, api } from "../api/client";
import type { GenerationJob, LookProfileCreate, Recipe } from "../api/client";
import {
  PRESET_INPUT_ROLE_LABEL,
  buildPresetInputRows,
  notifyLookProfilesChanged,
  productionChoiceWarning,
} from "../preset/productionChoices";
import type { PresetInputRole, PresetInputRow } from "../preset/productionChoices";
import type { Candidate } from "./CandidateGallery";
import { LoadingPlaceholder } from "./LoadingPlaceholder";

interface Props {
  candidate: Candidate;
  onClose: () => void;
}

type Category = LookProfileCreate["category"];

const ROLES: PresetInputRole[] = ["fixed", "auto", "choice"];
const VALUE_PREVIEW_LENGTH = 80;

function describe(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} (${error.code})`;
  return String(error);
}

function preview(value: unknown): string {
  if (value === undefined) return "(値なし)";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > VALUE_PREVIEW_LENGTH ? `${text.slice(0, VALUE_PREVIEW_LENGTH)}…` : text;
}

/**
 * 候補ギャラリーの1枚から、その生成条件をPresetとして保存するパネル (#161)。
 *
 * Recipeの入力ごとに「固定 / 自動で埋まる / モードBで選ばせる」を選ばせ、固定は値ごと
 * `inputs` へ、選ばせる項目は `production_choice_inputs` へ保存する。
 */
export function PresetPromotionPanel({ candidate, onClose }: Props) {
  const [job, setJob] = useState<GenerationJob | null>(null);
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [rows, setRows] = useState<PresetInputRow[]>([]);
  const [name, setName] = useState(`Preset ${candidate.artifact.sha256.slice(0, 8)}`);
  const [category, setCategory] = useState<Category>("general");
  const [description, setDescription] = useState("");
  const [recipeScoped, setRecipeScoped] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdName, setCreatedName] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const loadedJob = await api.getJob(candidate.jobId);
      const [manifest, recipes] = await Promise.all([
        api.getManifest(loadedJob.manifest_id),
        api.listRecipes(loadedJob.kind),
      ]);
      const loadedRecipe = recipes.find((item) => item.id === loadedJob.recipe_id);
      if (!loadedRecipe) throw new Error("この候補を生成したRecipeが見つかりません。");
      if (!active) return;
      setJob(loadedJob);
      setRecipe(loadedRecipe);
      setRows(buildPresetInputRows(loadedRecipe, manifest));
      setDescription(`候補 ${candidate.artifact.sha256.slice(0, 12)} (${loadedRecipe.name}) から作成`);
    };
    load()
      .catch((cause) => { if (active) setError(describe(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [candidate.jobId, candidate.artifact.sha256]);

  const counts = useMemo(() => {
    const result: Record<PresetInputRole, number> = { fixed: 0, auto: 0, choice: 0 };
    for (const row of rows) result[row.role] += 1;
    return result;
  }, [rows]);
  const warning = productionChoiceWarning(counts.choice);

  const changeRole = (target: string, role: PresetInputRole) => {
    setRows((current) => current.map((row) => (row.name === target ? { ...row, role } : row)));
  };

  const save = async () => {
    if (!job || !recipe) return;
    if (!name.trim()) {
      setError("名前を入力してください。");
      return;
    }
    const inputs = Object.fromEntries(
      rows.filter((row) => row.role === "fixed").map((row) => [row.name, row.value]),
    );
    if (Object.keys(inputs).length === 0) {
      setError("固定する項目を1つ以上選んでください。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api.createLookProfile({
        name: name.trim(),
        kind: job.kind as LookProfileCreate["kind"],
        category,
        description: description.trim() || null,
        recipe_id: recipeScoped ? recipe.id : null,
        inputs,
        production_choice_inputs: rows.filter((row) => row.role === "choice").map((row) => row.name),
      });
      setCreatedName(created.name);
      notifyLookProfilesChanged();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel stack" aria-label="候補からPresetを作る">
      <div className="row">
        <h2>候補からPresetを作る</h2>
        <button type="button" onClick={onClose}>閉じる</button>
      </div>
      <p className="muted">
        この候補の生成条件を、固定する項目・自動で埋まる項目・モードBで選ばせる項目に振り分けてPresetにします。
      </p>
      {error && <p className="error">{error}</p>}
      {createdName && (
        <p>Preset「{createdName}」を作成しました。生成フォームのPreset節から適用できます。</p>
      )}
      {loading ? <LoadingPlaceholder label="候補の生成条件を取得中です。" lines={3} /> : recipe && (
        <fieldset className="stack" disabled={busy || createdName !== null}>
          <legend>Preset作成</legend>
          <label>名前<input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>分類<select value={category} onChange={(event) => setCategory(event.target.value as Category)}><option value="general">general</option><option value="style">画風</option><option value="character">人物</option><option value="background">背景</option></select></label>
          <label>説明<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          <label><input type="checkbox" checked={recipeScoped} onChange={(event) => setRecipeScoped(event.target.checked)} />Recipe専用（{recipe.name}）</label>
          <table>
            <thead>
              <tr><th scope="col">入力</th><th scope="col">候補の値</th><th scope="col">扱い</th></tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.name}>
                  <th scope="row">{row.label}</th>
                  <td className="mono">{preview(row.value)}</td>
                  <td>
                    <select
                      aria-label={`${row.label}の扱い`}
                      value={row.role}
                      onChange={(event) => changeRole(row.name, event.target.value as PresetInputRole)}
                    >
                      {ROLES.map((role) => (
                        <option key={role} value={role} disabled={role === "fixed" && row.value === undefined}>
                          {PRESET_INPUT_ROLE_LABEL[role]}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            固定 {counts.fixed}件 / 自動で埋まる {counts.auto}件 / モードBで選ばせる {counts.choice}件。
            固定は候補の値をそのまま使います。自動で埋まる項目は、キャラクター・場面・Recipe既定値から埋まります。
          </p>
          {warning && <p className="error" role="status">{warning}</p>}
          <button type="button" className="primary" onClick={() => void save()}>{busy ? "保存中..." : "Presetとして保存"}</button>
        </fieldset>
      )}
    </section>
  );
}
