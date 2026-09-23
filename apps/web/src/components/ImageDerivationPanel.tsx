import { useEffect, useMemo, useRef, useState } from "react";

import { ApiError, api } from "../api/client";
import type {
  AgentProvider,
  GenerationJob,
  GenerationPreview,
  Recipe,
} from "../api/client";
import { ExecutionPreview } from "./ExecutionPreview";
import { ModelSelector } from "./ModelSelector";
import { LookProfileManager } from "./LookProfileManager";
import { PromptAssist } from "./PromptAssist";
import { EmptyState } from "./ui/EmptyState";
import { mergePrompt } from "../prompt/merge";
import { MediaPicker } from "./MediaPicker";
import type { PickedMedia } from "./MediaPicker";

type DerivationMode = "img2img" | "inpaint" | "upscale" | "controlnet";

interface Props {
  projectId: string | null;
  sceneId: string | null;
  shotId: string | null;
  recipes: Recipe[];
  /** Recipe一覧の初回取得中。取得未完了を0件と区別するために使う。 */
  recipesLoading: boolean;
  /** Recipe一覧の取得失敗時のメッセージ。取得失敗を0件と区別するために使う。 */
  recipesError: string | null;
  /** Recipe一覧の取得に失敗したとき、再取得を促す導線に使う。 */
  onRetryRecipes: () => void;
  sourceArtifactId: string | null;
  onSourceArtifactChange: (artifactId: string | null) => void;
  onSubmittedJob: (job: GenerationJob) => void;
  /** Recipeが1件も無いとき、登録先のWorkflow管理画面へ移る導線に使う。 */
  onManageWorkflows: () => void;
}

function templateName(recipe: Recipe): string {
  const reference = recipe.workflow_template_ref as Record<string, unknown>;
  return typeof reference?.name === "string" ? reference.name : "";
}

function modeOf(recipe: Recipe | null): DerivationMode | null {
  switch (recipe ? templateName(recipe) : "") {
    case "anima_img2img": return "img2img";
    case "anima_inpaint": return "inpaint";
    case "image_upscale": return "upscale";
    case "sd15_controlnet": return "controlnet";
    default: return null;
  }
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} (${error.code})`;
  return String(error);
}

export function ImageDerivationPanel({
  projectId,
  sceneId,
  shotId,
  recipes,
  recipesLoading,
  recipesError,
  onRetryRecipes,
  sourceArtifactId,
  onSourceArtifactChange,
  onSubmittedJob,
  onManageWorkflows,
}: Props) {
  const [recipeId, setRecipeId] = useState("");
  const [sourceMedia, setSourceMedia] = useState<PickedMedia[]>([]);
  const [maskMedia, setMaskMedia] = useState<PickedMedia[]>([]);
  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState("");
  const [denoise, setDenoise] = useState("0.65");
  const [seed, setSeed] = useState("-1");
  const [width, setWidth] = useState("832");
  const [height, setHeight] = useState("1216");
  const [growMaskBy, setGrowMaskBy] = useState("6");
  const [controlStrength, setControlStrength] = useState("0.8");
  const [controlStart, setControlStart] = useState("0");
  const [controlEnd, setControlEnd] = useState("1");
  const [modelValues, setModelValues] = useState<Record<string, string>>({});
  const [modelsValid, setModelsValid] = useState(false);
  const [lookProfileIds, setLookProfileIds] = useState<string[]>([]);
  const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<GenerationPreview | null>(null);
  const [previewError, setPreviewError] = useState<ApiError | null>(null);
  const [providers, setProviders] = useState<AgentProvider[]>([]);
  const sourceArtifactIdRef = useRef(sourceArtifactId);
  sourceArtifactIdRef.current = sourceArtifactId;

  const recipe = useMemo(
    () => recipes.find((item) => item.id === recipeId) ?? null,
    [recipes, recipeId],
  );
  const mode = modeOf(recipe);

  useEffect(() => {
    if (!recipes.length) return;
    // Recipe一覧が差し替わって選択中のidが消えた場合も選び直す。
    if (recipeId && recipes.some((item) => item.id === recipeId)) return;
    // 既定は img2img とし、無い場合だけ先頭のRecipeへ落とす。
    const preferred = recipes.find((item) => modeOf(item) === "img2img");
    setRecipeId((preferred ?? recipes[0]).id);
  }, [recipeId, recipes]);

  useEffect(() => {
    void api.listAgentProviders().then(setProviders).catch(() => setProviders([]));
  }, []);

  // 親から共有されるsourceArtifactIdが変わったら、pickerの選択をそれに合わせる。
  useEffect(() => {
    if (!sourceArtifactId) return;
    setSourceMedia((current) => {
      const first = current[0];
      if (first && "artifact_id" in first.source && first.source.artifact_id === sourceArtifactId) {
        return current;
      }
      return [{
        key: sourceArtifactId,
        label: sourceArtifactId.slice(0, 8),
        source: { artifact_id: sourceArtifactId },
      }];
    });
  }, [sourceArtifactId]);

  useEffect(() => {
    let active = true;
    setSourceMedia([]);
    setMaskMedia([]);
    api
      .listArtifacts({
        projectId: projectId ?? undefined,
        sceneId: sceneId ?? undefined,
        shotId: shotId ?? undefined,
        unassigned: !projectId,
        kind: "image",
        availability: "complete",
        limit: 100,
      })
      .then((items) => {
        if (!active) return;
        const currentSource = sourceArtifactIdRef.current;
        if (!currentSource || !items.some((item) => item.id === currentSource)) {
          onSourceArtifactChange(items[0]?.id ?? null);
        }
      })
      .catch((cause) => {
        if (active) setError(describe(cause));
      });
    return () => { active = false; };
  }, [projectId, sceneId, shotId]);

  const handleSourceMediaChange = (next: PickedMedia[]) => {
    setSourceMedia(next);
    const item = next[0];
    onSourceArtifactChange(item && "artifact_id" in item.source ? item.source.artifact_id : null);
  };

  useEffect(() => {
    const defaults = (recipe?.defaults ?? {}) as Record<string, unknown>;
    if (defaults.denoise !== undefined) setDenoise(String(defaults.denoise));
    if (defaults.width !== undefined) setWidth(String(defaults.width));
    if (defaults.height !== undefined) setHeight(String(defaults.height));
    if (defaults.control_strength !== undefined) {
      setControlStrength(String(defaults.control_strength));
    }
    setTouchedFields(new Set());
  }, [recipe]);

  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
  }, [
    recipeId,
    sourceMedia,
    maskMedia,
    prompt,
    negative,
    denoise,
    seed,
    width,
    height,
    growMaskBy,
    controlStrength,
    controlStart,
    controlEnd,
    modelValues,
    lookProfileIds,
  ]);

  const buildInputs = (): Record<string, unknown> | null => {
    const sourceItem = sourceMedia[0];
    if (!recipe || !mode || !sourceItem) {
      setError("Recipeと派生元画像を選択してください。");
      return null;
    }
    const inputs: Record<string, unknown> = {
      ...modelValues,
      source_image: sourceItem.source,
    };
    if (mode === "upscale") return inputs;
    const include = (name: string) => lookProfileIds.length === 0 || touchedFields.has(name);
    if (include("positive_prompt") && !prompt.trim()) {
      setError("プロンプトを入力してください。");
      return null;
    }
    const denoiseValue = Number(denoise);
    const seedValue = Number(seed);
    if (!Number.isFinite(denoiseValue) || denoiseValue < 0 || denoiseValue > 1) {
      setError("denoiseは0以上1以下で入力してください。");
      return null;
    }
    if (!Number.isInteger(seedValue)) {
      setError("seedは整数で入力してください。");
      return null;
    }
    if (include("positive_prompt")) inputs.positive_prompt = prompt;
    if (include("negative_prompt")) inputs.negative_prompt = negative;
    if (include("denoise")) inputs.denoise = denoiseValue;
    if (include("seed")) inputs.seed = seedValue;
    if (mode === "inpaint") {
      const grow = Number(growMaskBy);
      const maskItem = maskMedia[0];
      if (!maskItem || !Number.isInteger(grow) || grow < 0) {
        setError("mask画像と0以上のmask拡張値を指定してください。");
        return null;
      }
      inputs.mask_image = maskItem.source;
      if (include("grow_mask_by")) inputs.grow_mask_by = grow;
    }
    if (mode === "controlnet") {
      const values = [width, height, controlStrength, controlStart, controlEnd].map(Number);
      if (values.some((value) => !Number.isFinite(value))) {
        setError("参照画像制御の数値を確認してください。");
        return null;
      }
      if (
        !Number.isInteger(values[0]) || values[0] <= 0 ||
        !Number.isInteger(values[1]) || values[1] <= 0 ||
        values[2] <= 0 || values[3] < 0 || values[4] > 1 || values[3] > values[4]
      ) {
        setError("幅・高さ・制御強度・制御範囲が不正です。");
        return null;
      }
      if (include("width")) inputs.width = values[0];
      if (include("height")) inputs.height = values[1];
      if (include("batch_size")) inputs.batch_size = 1;
      if (include("control_strength")) inputs.control_strength = values[2];
      if (include("control_start")) inputs.control_start = values[3];
      if (include("control_end")) inputs.control_end = values[4];
    }
    return inputs;
  };

  const execute = async (previewOnly: boolean) => {
    const inputs = buildInputs();
    if (!inputs || !recipe) return;
    setBusy(true);
    setError(null);
    try {
      const payload = {
        kind: "image",
        project_id: projectId,
        scene_id: sceneId,
        shot_id: shotId,
        recipe_id: recipe.id,
        look_profile_ids: lookProfileIds,
        inputs,
      };
      if (previewOnly) {
        setPreview(await api.previewJob(payload));
        setPreviewError(null);
      } else {
        onSubmittedJob(await api.createJob(payload));
      }
    } catch (cause) {
      if (previewOnly && cause instanceof ApiError) {
        setPreview(null);
        setPreviewError(cause);
      } else {
        setError(describe(cause));
      }
    } finally {
      setBusy(false);
    }
  };

  if (recipesLoading) {
    return (
      <section className="panel">
        <h2>画像派生生成</h2>
        <EmptyState title="Recipeを読み込んでいます…" />
      </section>
    );
  }
  if (recipesError) {
    return (
      <section className="panel">
        <h2>画像派生生成</h2>
        <EmptyState
          title="Recipeの取得に失敗しました。"
          description={recipesError}
          action={
            <button type="button" onClick={onRetryRecipes}>
              再取得
            </button>
          }
        />
      </section>
    );
  }
  if (recipes.length === 0) {
    return (
      <section className="panel">
        <h2>画像派生生成</h2>
        <EmptyState
          title="使えるRecipeがまだありません。"
          description="Workflow管理でRecipeを登録すると、画像派生生成を使えます。"
          action={
            <button type="button" onClick={onManageWorkflows}>
              Workflow管理を開く
            </button>
          }
        />
      </section>
    );
  }
  const sourceReady = sourceMedia.length > 0;
  return (
    <section className="panel">
      <h2>画像派生生成</h2>
      <div className="stack">
        <label htmlFor="derivation-recipe">処理</label>
        <select id="derivation-recipe" value={recipeId} onChange={(event) => setRecipeId(event.target.value)}>
          {recipes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <MediaPicker
          kind="image"
          label="派生元画像"
          value={sourceMedia}
          onChange={handleSourceMediaChange}
          multiple={false}
          disabled={busy}
          maxBytes={25 * 1024 * 1024}
          projectId={projectId}
          sceneId={sceneId}
          shotId={shotId}
        />
        <ModelSelector recipe={recipe} values={modelValues} onChange={setModelValues} onValidityChange={setModelsValid} idPrefix="derivation-model" />
        <LookProfileManager
          kind="image"
          recipe={recipe}
          selectedIds={lookProfileIds}
          onSelectionChange={setLookProfileIds}
        />
        {mode !== "upscale" && <>
          <PromptAssist
            providers={providers}
            idPrefix="derivation"
            placeholder="例: 元画像の構図を保ったまま、夕暮れの海辺に置き換える。"
            onApply={(result) => {
              // 既に入力されているプロンプトは残し、補完結果をタグ順に沿って追記する。
              setPrompt((current) => mergePrompt(current, result.positive).prompt);
              setNegative((current) => mergePrompt(current, result.negative).prompt);
              setTouchedFields((current) =>
                new Set(current).add("positive_prompt").add("negative_prompt"),
              );
            }}
          />
          <label htmlFor="derivation-prompt">プロンプト</label>
          <textarea id="derivation-prompt" value={prompt} onChange={(event) => { setPrompt(event.target.value); setTouchedFields((current) => new Set(current).add("positive_prompt")); }} />
          <label htmlFor="derivation-negative">除外したい要素</label>
          <textarea id="derivation-negative" value={negative} onChange={(event) => { setNegative(event.target.value); setTouchedFields((current) => new Set(current).add("negative_prompt")); }} />
          <div className="row">
            <label>denoise<input type="number" min="0" max="1" step="0.05" value={denoise} onChange={(event) => { setDenoise(event.target.value); setTouchedFields((current) => new Set(current).add("denoise")); }} /></label>
            <label>seed<input type="number" value={seed} onChange={(event) => { setSeed(event.target.value); setTouchedFields((current) => new Set(current).add("seed")); }} /></label>
          </div>
        </>}
        {mode === "inpaint" && <>
          <MediaPicker
            kind="image"
            label="mask画像"
            value={maskMedia}
            onChange={setMaskMedia}
            multiple={false}
            disabled={busy}
            maxBytes={25 * 1024 * 1024}
            projectId={projectId}
            sceneId={sceneId}
            shotId={shotId}
          />
          <label>mask拡張(px)<input type="number" min="0" value={growMaskBy} onChange={(event) => { setGrowMaskBy(event.target.value); setTouchedFields((current) => new Set(current).add("grow_mask_by")); }} /></label>
        </>}
        {mode === "controlnet" && <>
          <div className="row">
            <label>幅<input type="number" value={width} onChange={(event) => { setWidth(event.target.value); setTouchedFields((current) => new Set(current).add("width")); }} /></label>
            <label>高さ<input type="number" value={height} onChange={(event) => { setHeight(event.target.value); setTouchedFields((current) => new Set(current).add("height")); }} /></label>
            <label>制御強度<input type="number" step="0.05" value={controlStrength} onChange={(event) => { setControlStrength(event.target.value); setTouchedFields((current) => new Set(current).add("control_strength")); }} /></label>
          </div>
          <div className="row">
            <label>制御開始<input type="number" min="0" max="1" step="0.05" value={controlStart} onChange={(event) => { setControlStart(event.target.value); setTouchedFields((current) => new Set(current).add("control_start")); }} /></label>
            <label>制御終了<input type="number" min="0" max="1" step="0.05" value={controlEnd} onChange={(event) => { setControlEnd(event.target.value); setTouchedFields((current) => new Set(current).add("control_end")); }} /></label>
          </div>
        </>}
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button type="button" disabled={busy || !modelsValid || !sourceReady} onClick={() => void execute(true)}>投入前に確認</button>
          <button type="button" className="primary" disabled={busy || !modelsValid || !sourceReady} onClick={() => void execute(false)}>{busy ? "処理中..." : "派生生成を投入"}</button>
        </div>
        <ExecutionPreview preview={preview} error={previewError} loading={busy} />
      </div>
    </section>
  );
}
