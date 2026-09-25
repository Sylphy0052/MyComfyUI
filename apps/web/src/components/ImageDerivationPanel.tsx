import { useEffect, useMemo, useRef, useState } from "react";

import { ApiError, api } from "../api/client";
import { REFERENCE_STRENGTH_MAX } from "../derivation/changeOperations";
import { describeApiError, templateName } from "../derivation/recipeTemplate";
import type {
  AgentProvider,
  GenerationJob,
  GenerationPreview,
  Recipe,
} from "../api/client";
import { ExecutionPreview } from "./ExecutionPreview";
import { ModelSelector } from "./ModelSelector";
import { LookProfileManager } from "./LookProfileManager";
import { AssistNotes, PromptAssist } from "./PromptAssist";
import { PromptDiffReview } from "./PromptDiffReview";
import type { PromptDiffState } from "./PromptDiffReview";
import { EmptyState } from "./ui/EmptyState";
import { MediaPicker } from "./MediaPicker";
import type { PickedMedia } from "./MediaPicker";
import { NumberSlider, SEED_FIELD_NAME, SeedButtons, SwapButton, SLIDER_SPECS } from "./OutputControls";

type DerivationMode = "img2img" | "inpaint" | "upscale" | "controlnet" | "reference";

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
  /** 直前に完了したJobのseed。seedの「前回」ボタンに使う。完了Jobが無ければnull (#319)。 */
  lastSeed?: number | null;
}

function modeOf(recipe: Recipe | null): DerivationMode | null {
  switch (recipe ? templateName(recipe) : "") {
    case "anima_img2img": return "img2img";
    case "anima_inpaint": return "inpaint";
    case "image_upscale": return "upscale";
    case "sd15_controlnet": return "controlnet";
    case "anima_ref_siglip": return "reference";
    case "anima_ref_incontext": return "reference";
    default: return null;
  }
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
  lastSeed = null,
}: Props) {
  const [recipeId, setRecipeId] = useState("");
  const [sourceMedia, setSourceMedia] = useState<PickedMedia[]>([]);
  const [maskMedia, setMaskMedia] = useState<PickedMedia[]>([]);
  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState("");
  const [denoise, setDenoise] = useState("0.65");
  const [referenceStrength, setReferenceStrength] = useState("1.0");
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
  const [promptDiff, setPromptDiff] = useState<PromptDiffState | null>(null);
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
        if (active) setError(describeApiError(cause));
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
    if (defaults.reference_strength !== undefined) {
      setReferenceStrength(String(defaults.reference_strength));
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
    referenceStrength,
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
    const seedValue = Number(seed);
    if (!Number.isInteger(seedValue)) {
      setError("seedは整数で入力してください。");
      return null;
    }
    if (include("positive_prompt")) inputs.positive_prompt = prompt;
    if (include("negative_prompt")) inputs.negative_prompt = negative;
    if (mode === "reference") {
      const referenceStrengthValue = Number(referenceStrength);
      if (!Number.isFinite(referenceStrengthValue) || referenceStrengthValue < 0 || referenceStrengthValue > 2) {
        setError("参照強度は0以上2以下で入力してください。");
        return null;
      }
      if (include("reference_strength")) inputs.reference_strength = referenceStrengthValue;
    } else {
      const denoiseValue = Number(denoise);
      if (!Number.isFinite(denoiseValue) || denoiseValue < 0 || denoiseValue > 1) {
        setError("denoiseは0以上1以下で入力してください。");
        return null;
      }
      if (include("denoise")) inputs.denoise = denoiseValue;
    }
    if (include(SEED_FIELD_NAME)) inputs.seed = seedValue;
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
      // 幅・高さはComfyUIのEmptyLatentImageが受け付ける64〜8192の8刻みに限る。
      const validDimension = (value: number) =>
        Number.isInteger(value) && value >= 64 && value <= 8192 && value % 8 === 0;
      if (
        !validDimension(values[0]) ||
        !validDimension(values[1]) ||
        values[2] <= 0 || values[3] < 0 || values[4] > 1 || values[3] > values[4]
      ) {
        setError("幅・高さ (64〜8192の8の倍数)・制御強度・制御範囲が不正です。");
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
        setError(describeApiError(cause));
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
      {/* 投入操作はパネルの長さに関わらず押せるよう、上端へ固定する。 */}
      <div className="form-actions">
        <button type="button" disabled={busy || !modelsValid || !sourceReady} onClick={() => void execute(true)}>投入前に確認</button>
        <button type="button" className="primary" disabled={busy || !modelsValid || !sourceReady} onClick={() => void execute(false)}>{busy ? "処理中..." : "派生生成を投入"}</button>
      </div>
      <div className="stack">
        <label htmlFor="derivation-recipe">ベース (Recipe)</label>
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
          enableRoleTagging
        />
        <p className="muted">登録素材・アップロードから選んだ画像は入力cacheとしてManifestのinput_refsへ記録し、Artifact親子関係は持ちません。</p>
        <ModelSelector recipe={recipe} values={modelValues} onChange={setModelValues} onValidityChange={setModelsValid} idPrefix="derivation-model" />
        <LookProfileManager
          kind="image"
          recipe={recipe}
          selectedIds={lookProfileIds}
          onSelectionChange={setLookProfileIds}
        />
        {mode !== "upscale" && <>
          {promptDiff ? (
            <PromptDiffReview
              fields={promptDiff.fields}
              onCancel={() => setPromptDiff(null)}
              onAccept={(result) => {
                if ("positive_prompt" in result) setPrompt(result.positive_prompt);
                if ("negative_prompt" in result) setNegative(result.negative_prompt);
                setTouchedFields((current) => {
                  const next = new Set(current);
                  Object.keys(result).forEach((name) => next.add(name));
                  return next;
                });
                setPromptDiff(null);
              }}
            >
              {promptDiff.notes && <AssistNotes result={promptDiff.notes} />}
            </PromptDiffReview>
          ) : (
            <PromptAssist
              providers={providers}
              idPrefix="derivation"
              recipeId={recipeId}
              current={{ positive: prompt, negative }}
              projectId={projectId}
              placeholder="例: 元画像の構図を保ったまま、夕暮れの海辺に置き換える。"
              onApply={(result) => {
                // 既存のプロンプトをすぐ上書きせず、差分レビューを開いて採否を選ばせる。
                setPromptDiff({
                  notes: result.notes,
                  fields: [
                    {
                      key: "positive_prompt",
                      label: "プロンプト",
                      current: prompt,
                      proposed: result.positive,
                      acceptRemovals: result.review,
                      reasons: result.notes,
                    },
                    {
                      key: "negative_prompt",
                      label: "ネガティブプロンプト",
                      current: negative,
                      proposed: result.negative,
                    },
                  ],
                });
              }}
            />
          )}
          {/* 差分レビュー中に書き換えると、反映したときに書いた分が黙って消える。 */}
          <label htmlFor="derivation-prompt">プロンプト</label>
          <textarea id="derivation-prompt" value={prompt} readOnly={promptDiff !== null} onChange={(event) => { setPrompt(event.target.value); setTouchedFields((current) => new Set(current).add("positive_prompt")); }} />
          <label htmlFor="derivation-negative">ネガティブプロンプト</label>
          <textarea id="derivation-negative" value={negative} readOnly={promptDiff !== null} onChange={(event) => { setNegative(event.target.value); setTouchedFields((current) => new Set(current).add("negative_prompt")); }} />
          <div className="field-row">
            {mode === "reference" ? (
              <label>参照強度<input type="number" min="0" max={REFERENCE_STRENGTH_MAX} step="0.05" value={referenceStrength} onChange={(event) => { setReferenceStrength(event.target.value); setTouchedFields((current) => new Set(current).add("reference_strength")); }} /></label>
            ) : (
              <label htmlFor="derivation-denoise">denoise
                <NumberSlider
                  id="derivation-denoise"
                  value={denoise}
                  spec={SLIDER_SPECS.denoise}
                  onChange={(next) => { setDenoise(next); setTouchedFields((current) => new Set(current).add("denoise")); }}
                />
              </label>
            )}
            <label htmlFor="derivation-seed">seed
              <div className="seed-input">
                <input id="derivation-seed" type="number" value={seed} onChange={(event) => { setSeed(event.target.value); setTouchedFields((current) => new Set(current).add(SEED_FIELD_NAME)); }} />
                <SeedButtons
                  lastSeed={lastSeed}
                  onChange={(next) => { setSeed(next); setTouchedFields((current) => new Set(current).add(SEED_FIELD_NAME)); }}
                />
              </div>
            </label>
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
          <div className="field-row">
            <label htmlFor="derivation-width">幅
              <NumberSlider
                id="derivation-width"
                value={width}
                spec={SLIDER_SPECS.width}
                onChange={(next) => { setWidth(next); setTouchedFields((current) => new Set(current).add("width")); }}
              />
            </label>
            {/* 幅・高さの入力は派生中も編集できるため、入れ替えも同じく無効化しない (#343)。 */}
            <SwapButton
              width={width}
              height={height}
              onSwap={(next) => {
                setWidth(next.width);
                setHeight(next.height);
                setTouchedFields((current) => new Set(current).add("width").add("height"));
              }}
            />
            <label htmlFor="derivation-height">高さ
              <NumberSlider
                id="derivation-height"
                value={height}
                spec={SLIDER_SPECS.height}
                onChange={(next) => { setHeight(next); setTouchedFields((current) => new Set(current).add("height")); }}
              />
            </label>
          </div>
          <div className="field-row">
            <label>制御強度<input type="number" step="0.05" value={controlStrength} onChange={(event) => { setControlStrength(event.target.value); setTouchedFields((current) => new Set(current).add("control_strength")); }} /></label>
          </div>
          <div className="field-row">
            <label>制御開始<input type="number" min="0" max="1" step="0.05" value={controlStart} onChange={(event) => { setControlStart(event.target.value); setTouchedFields((current) => new Set(current).add("control_start")); }} /></label>
            <label>制御終了<input type="number" min="0" max="1" step="0.05" value={controlEnd} onChange={(event) => { setControlEnd(event.target.value); setTouchedFields((current) => new Set(current).add("control_end")); }} /></label>
          </div>
        </>}
        {error && <p className="error">{error}</p>}
        <ExecutionPreview preview={preview} error={previewError} loading={busy} />
      </div>
    </section>
  );
}
