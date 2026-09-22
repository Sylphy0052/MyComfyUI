import { useEffect, useMemo, useRef, useState } from "react";

import { ApiError, api } from "../api/client";
import type {
  Artifact,
  GenerationJob,
  GenerationPreview,
  Recipe,
} from "../api/client";
import { ExecutionPreview } from "./ExecutionPreview";
import { ModelSelector } from "./ModelSelector";

type DerivationMode = "img2img" | "inpaint" | "upscale" | "controlnet";

interface Props {
  projectId: string | null;
  sceneId: string | null;
  shotId: string | null;
  recipes: Recipe[];
  sourceArtifactId: string | null;
  onSourceArtifactChange: (artifactId: string | null) => void;
  onSubmittedJob: (job: GenerationJob) => void;
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

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function mediaTypeOf(file: File): string {
  if (file.type) return file.type;
  const name = file.name.toLowerCase();
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  return "image/png";
}

export function ImageDerivationPanel({
  projectId,
  sceneId,
  shotId,
  recipes,
  sourceArtifactId,
  onSourceArtifactChange,
  onSubmittedJob,
}: Props) {
  const [recipeId, setRecipeId] = useState("");
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [maskId, setMaskId] = useState("");
  const [sourceMode, setSourceMode] = useState<"artifact" | "cached">("artifact");
  const [sourcePath, setSourcePath] = useState("");
  const [sourceSha256, setSourceSha256] = useState("");
  const [maskMode, setMaskMode] = useState<"artifact" | "cached">("artifact");
  const [maskPath, setMaskPath] = useState("");
  const [maskSha256, setMaskSha256] = useState("");
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<GenerationPreview | null>(null);
  const [previewError, setPreviewError] = useState<ApiError | null>(null);
  const sourceArtifactIdRef = useRef(sourceArtifactId);
  sourceArtifactIdRef.current = sourceArtifactId;

  const recipe = useMemo(
    () => recipes.find((item) => item.id === recipeId) ?? null,
    [recipes, recipeId],
  );
  const mode = modeOf(recipe);

  useEffect(() => {
    if (!recipeId && recipes.length) setRecipeId(recipes[0].id);
  }, [recipeId, recipes]);

  useEffect(() => {
    if (sourceArtifactId) setSourceMode("artifact");
  }, [sourceArtifactId]);

  useEffect(() => {
    let active = true;
    setSourceMode("artifact");
    setMaskMode("artifact");
    setMaskId("");
    setSourcePath("");
    setSourceSha256("");
    setMaskPath("");
    setMaskSha256("");
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
        setArtifacts(items);
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

  useEffect(() => {
    const defaults = (recipe?.defaults ?? {}) as Record<string, unknown>;
    if (defaults.denoise !== undefined) setDenoise(String(defaults.denoise));
    if (defaults.width !== undefined) setWidth(String(defaults.width));
    if (defaults.height !== undefined) setHeight(String(defaults.height));
    if (defaults.control_strength !== undefined) {
      setControlStrength(String(defaults.control_strength));
    }
  }, [recipe]);

  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
  }, [
    recipeId,
    sourceMode,
    sourceArtifactId,
    sourcePath,
    sourceSha256,
    maskMode,
    maskId,
    maskPath,
    maskSha256,
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
  ]);

  const buildInputs = (): Record<string, unknown> | null => {
    const sourceReady =
      sourceMode === "artifact"
        ? Boolean(sourceArtifactId)
        : Boolean(sourcePath.trim() && sourceSha256.trim());
    if (!recipe || !mode || !sourceReady) {
      setError("Recipeと派生元画像を選択してください。");
      return null;
    }
    const inputs: Record<string, unknown> = {
      ...modelValues,
      source_image:
        sourceMode === "artifact"
          ? { artifact_id: sourceArtifactId }
          : { relative_path: sourcePath.trim(), sha256: sourceSha256.trim() },
    };
    if (mode === "upscale") return inputs;
    if (!prompt.trim()) {
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
    Object.assign(inputs, {
      positive_prompt: prompt,
      negative_prompt: negative,
      denoise: denoiseValue,
      seed: seedValue,
    });
    if (mode === "inpaint") {
      const grow = Number(growMaskBy);
      const maskReady =
        maskMode === "artifact"
          ? Boolean(maskId)
          : Boolean(maskPath.trim() && maskSha256.trim());
      if (!maskReady || !Number.isInteger(grow) || grow < 0) {
        setError("mask画像と0以上のmask拡張値を指定してください。");
        return null;
      }
      inputs.mask_image =
        maskMode === "artifact"
          ? { artifact_id: maskId }
          : { relative_path: maskPath.trim(), sha256: maskSha256.trim() };
      inputs.grow_mask_by = grow;
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
      Object.assign(inputs, {
        width: values[0], height: values[1], batch_size: 1,
        control_strength: values[2], control_start: values[3], control_end: values[4],
      });
    }
    return inputs;
  };

  const registerInput = async (file: File, target: "source" | "mask") => {
    if (file.size > 25 * 1024 * 1024) {
      setError("登録する画像は25MB以下にしてください。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const stored = await api.createImageReference(
        file.name,
        await toBase64(file),
        mediaTypeOf(file),
      );
      if (target === "source") {
        setSourceMode("cached");
        setSourcePath(stored.relative_path);
        setSourceSha256(stored.sha256);
      } else {
        setMaskMode("cached");
        setMaskPath(stored.relative_path);
        setMaskSha256(stored.sha256);
      }
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
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

  if (recipes.length === 0) return null;
  const sourceReady =
    sourceMode === "artifact"
      ? Boolean(sourceArtifactId)
      : Boolean(sourcePath.trim() && sourceSha256.trim());
  return (
    <section className="panel">
      <h2>画像派生生成</h2>
      <div className="stack">
        <label htmlFor="derivation-recipe">処理</label>
        <select id="derivation-recipe" value={recipeId} onChange={(event) => setRecipeId(event.target.value)}>
          {recipes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <label htmlFor="derivation-source-mode">入力方法</label>
        <select id="derivation-source-mode" value={sourceMode} onChange={(event) => setSourceMode(event.target.value as "artifact" | "cached")}>
          <option value="artifact">Artifact</option>
          <option value="cached">登録済み入力cache</option>
        </select>
        <label htmlFor="derivation-source">派生元画像</label>
        {sourceMode === "artifact" ? (
          <select id="derivation-source" value={sourceArtifactId ?? ""} onChange={(event) => onSourceArtifactChange(event.target.value || null)}>
            <option value="">選択してください</option>
            {sourceArtifactId && !artifacts.some((item) => item.id === sourceArtifactId) && (
              <option value={sourceArtifactId}>選択候補 {sourceArtifactId.slice(0, 8)}</option>
            )}
            {artifacts.map((item) => <option key={item.id} value={item.id}>{item.id.slice(0, 8)} / {item.sha256.slice(0, 12)}</option>)}
          </select>
        ) : (
          <div className="stack">
            <input type="file" accept="image/*" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void registerInput(file, "source"); }} />
            <input id="derivation-source" value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} placeholder="inputs/<sha256>/<file>" />
            <input value={sourceSha256} onChange={(event) => setSourceSha256(event.target.value)} placeholder="SHA-256" />
            <p className="muted">入力cacheはManifestのinput_refsへ記録し、Artifact親子関係は持ちません。</p>
          </div>
        )}
        <ModelSelector recipe={recipe} values={modelValues} onChange={setModelValues} onValidityChange={setModelsValid} idPrefix="derivation-model" />
        {mode !== "upscale" && <>
          <label htmlFor="derivation-prompt">プロンプト</label>
          <textarea id="derivation-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          <label htmlFor="derivation-negative">除外したい要素</label>
          <textarea id="derivation-negative" value={negative} onChange={(event) => setNegative(event.target.value)} />
          <div className="row">
            <label>denoise<input type="number" min="0" max="1" step="0.05" value={denoise} onChange={(event) => setDenoise(event.target.value)} /></label>
            <label>seed<input type="number" value={seed} onChange={(event) => setSeed(event.target.value)} /></label>
          </div>
        </>}
        {mode === "inpaint" && <>
          <label>mask入力方法<select value={maskMode} onChange={(event) => setMaskMode(event.target.value as "artifact" | "cached")}><option value="artifact">Artifact</option><option value="cached">登録済み入力cache</option></select></label>
          <label htmlFor="derivation-mask">mask画像</label>
          {maskMode === "artifact" ? (
            <select id="derivation-mask" value={maskId} onChange={(event) => setMaskId(event.target.value)}>
              <option value="">選択してください</option>
              {artifacts.map((item) => <option key={item.id} value={item.id}>{item.id.slice(0, 8)}</option>)}
            </select>
          ) : (
            <div className="stack">
              <input type="file" accept="image/*" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void registerInput(file, "mask"); }} />
              <input id="derivation-mask" value={maskPath} onChange={(event) => setMaskPath(event.target.value)} placeholder="inputs/<sha256>/<file>" />
              <input value={maskSha256} onChange={(event) => setMaskSha256(event.target.value)} placeholder="SHA-256" />
            </div>
          )}
          <label>mask拡張(px)<input type="number" min="0" value={growMaskBy} onChange={(event) => setGrowMaskBy(event.target.value)} /></label>
        </>}
        {mode === "controlnet" && <>
          <div className="row">
            <label>幅<input type="number" value={width} onChange={(event) => setWidth(event.target.value)} /></label>
            <label>高さ<input type="number" value={height} onChange={(event) => setHeight(event.target.value)} /></label>
            <label>制御強度<input type="number" step="0.05" value={controlStrength} onChange={(event) => setControlStrength(event.target.value)} /></label>
          </div>
          <div className="row">
            <label>制御開始<input type="number" min="0" max="1" step="0.05" value={controlStart} onChange={(event) => setControlStart(event.target.value)} /></label>
            <label>制御終了<input type="number" min="0" max="1" step="0.05" value={controlEnd} onChange={(event) => setControlEnd(event.target.value)} /></label>
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
