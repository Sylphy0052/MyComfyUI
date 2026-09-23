import { useEffect, useMemo, useState } from "react";

import { ApiError, api } from "../api/client";
import type {
  AgentProvider,
  Artifact,
  ComfyUIBackendHealth,
  GenerationJob,
  GenerationPreview,
  Recipe,
} from "../api/client";
import type { ShotEnvelope } from "../api/aimedia";
import { ExecutionPreview } from "./ExecutionPreview";
import { MediaPicker } from "./MediaPicker";
import type { PickedMedia } from "./MediaPicker";
import { MediaViewer } from "./MediaViewer";
import { ModelSelector } from "./ModelSelector";
import { PromptAssistField } from "./PromptAssist";
import { PromptDiffReview } from "./PromptDiffReview";
import type { PromptDiffField } from "./PromptDiffReview";
import { Icon } from "./ui/Icon";
import { IconButton } from "./ui/IconButton";

/** フレーム数のグリッド。17k+5に合わない値はComfyUI側で切り上げられ、指定した尺とずれる。 */
const FRAME_GRID_STEP = 17;
const FRAME_GRID_BASE = 5;
const MIN_FRAMES = 124;
const MAX_FRAMES = 362;
const FPS = 24;

/** R2Vが受け付ける参照画像の枚数の上限。バックエンドの制約に合わせる。 */
const MAX_REFERENCES = 9;

type VideoMode = "ref2v" | "i2v";

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.message} (${error.code})`;
  }
  return String(error);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 秒数を17k+5グリッド上のフレーム数へ丸める。切り上げてから学習範囲へ収める。 */
function framesFromSeconds(seconds: number): number {
  const steps = Math.ceil((seconds * FPS - FRAME_GRID_BASE) / FRAME_GRID_STEP);
  const raw = FRAME_GRID_BASE + steps * FRAME_GRID_STEP;
  return clamp(raw, MIN_FRAMES, MAX_FRAMES);
}

/** Recipeが指すWorkflowテンプレート名。ref2vとi2vの判定に使う。 */
function templateNameOf(recipe: Recipe): string | null {
  const ref: unknown = recipe.workflow_template_ref;
  if (ref !== null && typeof ref === "object" && !Array.isArray(ref)) {
    const name = (ref as Record<string, unknown>).name;
    if (typeof name === "string") return name;
  }
  return null;
}

function modeOf(recipe: Recipe): VideoMode | null {
  const name = templateNameOf(recipe);
  if (name === "minimax_h3_ref2v") return "ref2v";
  if (name === "minimax_h3_i2v") return "i2v";
  return null;
}

interface Props {
  projectId: string | null;
  sceneId: string | null;
  shotId: string | null;
  shot: ShotEnvelope | null;
  jobs: GenerationJob[];
  onSubmittedJob: (job: GenerationJob) => void;
}

export function VideoPanel({
  projectId,
  sceneId,
  shotId,
  shot,
  jobs,
  onSubmittedJob,
}: Props) {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [recipeId, setRecipeId] = useState("");
  const [useInheritedDefaults, setUseInheritedDefaults] = useState(false);
  const [health, setHealth] = useState<ComfyUIBackendHealth | null>(null);

  const [prompt, setPrompt] = useState("");
  const [providers, setProviders] = useState<AgentProvider[]>([]);
  const [promptDiff, setPromptDiff] = useState<PromptDiffField[] | null>(null);
  const [secondsStr, setSecondsStr] = useState("5.2");
  const [widthStr, setWidthStr] = useState("864");
  const [heightStr, setHeightStr] = useState("480");
  const [seedStr, setSeedStr] = useState("-1");
  const [audioMode, setAudioMode] = useState<"native" | "external_voice" | "silent">(
    "native",
  );
  const [guideFrameIdxStr, setGuideFrameIdxStr] = useState("0");
  const [modelValues, setModelValues] = useState<Record<string, string>>({});
  const [modelsValid, setModelsValid] = useState(false);

  const [references, setReferences] = useState<PickedMedia[]>([]);
  const [firstFrame, setFirstFrame] = useState<PickedMedia[]>([]);
  const [guideAudio, setGuideAudio] = useState<PickedMedia[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videoArtifactsByJob, setVideoArtifactsByJob] = useState<
    Record<string, Artifact[]>
  >({});
  const [previewResult, setPreviewResult] = useState<GenerationPreview | null>(
    null,
  );
  const [previewError, setPreviewError] = useState<ApiError | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  const recipe = useMemo(
    () => recipes.find((item) => item.id === recipeId) ?? null,
    [recipes, recipeId],
  );
  const mode = useMemo(() => (recipe ? modeOf(recipe) : null), [recipe]);
  const videoJobs = useMemo(
    () => jobs.filter((job) => job.kind === "video"),
    [jobs],
  );
  const succeededVideoJobIds = videoJobs
    .filter((job) => job.state === "succeeded")
    .map((job) => job.id)
    .join(",");

  const succeededVideoArtifacts = useMemo(
    () =>
      videoJobs
        .filter((job) => job.state === "succeeded")
        .flatMap((job) =>
          (videoArtifactsByJob[job.id] ?? []).filter(
            (artifact) => artifact.kind === "video",
          ),
        ),
    [videoJobs, videoArtifactsByJob],
  );

  const seconds = Number.parseFloat(secondsStr);
  const frames =
    Number.isFinite(seconds) && seconds > 0 ? framesFromSeconds(seconds) : null;

  useEffect(() => {
    void api.listAgentProviders().then(setProviders).catch(() => setProviders([]));
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [list, status] = await Promise.all([
          api.listRecipes("video"),
          api.getComfyUIBackendHealth(),
        ]);
        if (!active) return;
        setRecipes(list);
        setHealth(status);
        if (list.length > 0) setRecipeId((current) => current || list[0].id);
      } catch (cause) {
        if (active) setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Recipe (mode) を切り替えたら、そのモードで実績のある幅・高さへ合わせ直す。
  useEffect(() => {
    if (mode === "ref2v") {
      setWidthStr("864");
      setHeightStr("480");
    } else if (mode === "i2v") {
      setWidthStr("512");
      setHeightStr("768");
    }
  }, [mode]);

  // Shot が変わったら参照素材の指定をやり直す。別 Shot の指定を引き継がない。
  useEffect(() => {
    setReferences([]);
    setFirstFrame([]);
    setGuideAudio([]);
  }, [projectId, shotId]);

  useEffect(() => {
    if (!succeededVideoJobIds) {
      setVideoArtifactsByJob({});
      return;
    }
    let active = true;
    (async () => {
      try {
        const ids = succeededVideoJobIds.split(",");
        const entries = await Promise.all(
          ids.map(async (id) => [id, await api.listJobArtifacts(id)] as const),
        );
        if (active) setVideoArtifactsByJob(Object.fromEntries(entries));
      } catch (cause) {
        if (active) setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [succeededVideoJobIds]);

  const buildInputs = (): Record<string, unknown> | null => {
    if (useInheritedDefaults) return {};
    if (!mode) {
      setError("選んだRecipeのWorkflowテンプレートが未対応です。");
      return null;
    }
    if (!prompt.trim()) {
      setError("プロンプトを入力してください。");
      return null;
    }
    if (!Number.isFinite(seconds) || seconds <= 0) {
      setError("秒数は0より大きい数値で入力してください。");
      return null;
    }
    const length = framesFromSeconds(seconds);
    const width = Number.parseInt(widthStr, 10);
    if (!Number.isFinite(width) || width <= 0) {
      setError("幅は正の整数で入力してください。");
      return null;
    }
    const height = Number.parseInt(heightStr, 10);
    if (!Number.isFinite(height) || height <= 0) {
      setError("高さは正の整数で入力してください。");
      return null;
    }
    const seed = Number.parseInt(seedStr || "-1", 10);
    if (!Number.isFinite(seed)) {
      setError("seedは整数で入力してください。");
      return null;
    }

    const inputs: Record<string, unknown> = {
      ...modelValues,
      positive_prompt: prompt,
      length,
      width,
      height,
      seed,
      audio_mode: audioMode,
    };

    if (mode === "ref2v") {
      if (references.length < 1 || references.length > MAX_REFERENCES) {
        setError(`参照画像は1〜${MAX_REFERENCES}枚で指定してください。`);
        return null;
      }
      inputs.references = references.map((item) => item.source);
    } else {
      const firstFrameItem = firstFrame[0];
      if (!firstFrameItem) {
        setError("開始フレームの画像を指定してください。");
        return null;
      }
      inputs.first_frame = firstFrameItem.source;
    }

    if (audioMode === "external_voice") {
      const guideAudioItem = guideAudio[0];
      if (!guideAudioItem) {
        setError("ガイド音声を指定してください。");
        return null;
      }
      const guideFrameIdx = Number.parseInt(guideFrameIdxStr || "0", 10);
      if (
        !Number.isFinite(guideFrameIdx) ||
        guideFrameIdx < 0 ||
        guideFrameIdx >= length
      ) {
        setError(`guide_frame_idxは0以上${length}未満で指定してください。`);
        return null;
      }
      inputs.guide_audio = guideAudioItem.source;
      inputs.guide_frame_idx = guideFrameIdx;
    }

    return inputs;
  };

  const submit = async () => {
    if (!recipe && !useInheritedDefaults) return;
    const inputs = buildInputs();
    if (!inputs) return;

    setSubmitting(true);
    setError(null);
    try {
      const job = await api.createJob({
        kind: "video",
        project_id: projectId,
        scene_id: sceneId,
        shot_id: shotId,
        recipe_id: recipe?.id,
        use_inherited_defaults: useInheritedDefaults,
        inputs,
      });
      onSubmittedJob(job);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const runPreview = async () => {
    if (!recipe && !useInheritedDefaults) return;
    const inputs = buildInputs();
    if (!inputs) return;

    setPreviewing(true);
    setError(null);
    try {
      const preview = await api.previewJob({
        kind: "video",
        project_id: projectId,
        scene_id: sceneId,
        shot_id: shotId,
        recipe_id: recipe?.id,
        use_inherited_defaults: useInheritedDefaults,
        inputs,
      });
      setPreviewResult(preview);
      setPreviewError(null);
    } catch (cause) {
      if (cause instanceof ApiError) {
        setPreviewError(cause);
        setPreviewResult(null);
      } else {
        setError(describe(cause));
      }
    } finally {
      setPreviewing(false);
    }
  };

  const shotVideo = shot?.data.video;

  return (
    <section className="panel">
      <h2>動画生成</h2>

      <p className="muted">
        {health === null
          ? "Backendの状態を確認中。"
          : health.reachable
            ? `ComfyUI: ${health.base_url}`
            : `ComfyUIへ接続できません: ${health.reason ?? "理由不明"}`}
      </p>

      {shotVideo && (
        <p className="muted">
          {`Shot本文の想定: mode=${shotVideo.mode} / audio_mode=${shotVideo.audio_mode ?? "未指定"} / 参照${(shotVideo.references ?? []).length}枚 (ComfyUI側のファイルではないため、そのまま投入には使わない)`}
        </p>
      )}

      <div className="stack">
        <button
          type="button"
          disabled={!projectId}
          aria-pressed={useInheritedDefaults}
          className={useInheritedDefaults ? "primary" : undefined}
          onClick={() => setUseInheritedDefaults((value) => !value)}
        >
          {useInheritedDefaults ? "Project既定値を使用中" : "Project既定値へ戻す"}
        </button>
        <div>
          <label htmlFor="video-recipe">Recipe</label>
          <select
            id="video-recipe"
            value={recipeId}
            disabled={useInheritedDefaults}
            onChange={(event) => setRecipeId(event.target.value)}
          >
            {recipes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>

        <ModelSelector
          recipe={recipe}
          disabled={useInheritedDefaults}
          values={modelValues}
          onChange={setModelValues}
          onValidityChange={setModelsValid}
        />

        {promptDiff ? (
          <PromptDiffReview
            fields={promptDiff}
            onCancel={() => setPromptDiff(null)}
            onAccept={(result) => {
              if ("prompt" in result) setPrompt(result.prompt);
              setPromptDiff(null);
            }}
          />
        ) : (
          <PromptAssistField
            providers={providers}
            idPrefix="video-assist"
            subject="動画の説明"
            outputLabel="Prompt"
            submitLabel="Promptを補完"
            placeholder="例: 赤いコートの女性が暗室をゆっくり歩き、カメラは横から追う。"
            onAssist={async ({ instruction, provider_id }) => {
              const result = await api.assistVideoPrompt({ instruction, provider_id });
              // 既存のプロンプトをすぐ上書きせず、差分レビューを開いて採否を選ばせる。
              setPromptDiff([
                { key: "prompt", label: "プロンプト", current: prompt, proposed: result.prompt },
              ]);
            }}
          />
        )}
        <label htmlFor="video-prompt">プロンプト</label>
        <textarea
          id="video-prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />

        <div className="row">
          <div>
            <label htmlFor="video-seconds">秒数</label>
            <input
              id="video-seconds"
              type="number"
              step="0.1"
              value={secondsStr}
              onChange={(event) => setSecondsStr(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="video-width">幅</label>
            <input
              id="video-width"
              type="number"
              value={widthStr}
              onChange={(event) => setWidthStr(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="video-height">高さ</label>
            <input
              id="video-height"
              type="number"
              value={heightStr}
              onChange={(event) => setHeightStr(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="video-seed">seed (-1で自動採番)</label>
            <input
              id="video-seed"
              type="number"
              value={seedStr}
              onChange={(event) => setSeedStr(event.target.value)}
            />
          </div>
        </div>

        <p className="muted">
          {frames !== null
            ? `${frames}フレーム (${(frames / FPS).toFixed(2)}秒)`
            : "秒数を入力するとフレーム数を計算する。"}
        </p>
        <p className="muted">
          17k+5グリッドに合わない値はComfyUI側で切り上げられ、指定した尺とずれるため丸める。
        </p>

        <div>
          <label htmlFor="video-audio-mode">audio_mode</label>
          <select
            id="video-audio-mode"
            value={audioMode}
            onChange={(event) =>
              setAudioMode(
                event.target.value as "native" | "external_voice" | "silent",
              )
            }
          >
            <option value="native">native (H3が音声も生成する)</option>
            <option value="external_voice">
              external_voice (生成済み音声をガイドにする)
            </option>
            <option value="silent">silent (無音)</option>
          </select>
        </div>

        {mode === "ref2v" && (
          <MediaPicker
            kind="image"
            label={`参照画像 (1〜${MAX_REFERENCES}枚)`}
            value={references}
            onChange={setReferences}
            multiple
            max={MAX_REFERENCES}
            min={1}
            projectId={projectId}
            sceneId={sceneId}
            shotId={shotId}
          />
        )}

        {mode === "i2v" && (
          <MediaPicker
            kind="image"
            label="開始フレーム"
            value={firstFrame}
            onChange={setFirstFrame}
            multiple={false}
            projectId={projectId}
            sceneId={sceneId}
            shotId={shotId}
          />
        )}

        {audioMode === "external_voice" && (
          <div className="stack">
            <MediaPicker
              kind="audio"
              label="ガイド音声"
              value={guideAudio}
              onChange={setGuideAudio}
              multiple={false}
              accept="audio/*"
              projectId={projectId}
              sceneId={sceneId}
              shotId={shotId}
            />
            <label htmlFor="video-guide-frame-idx">
              guide_frame_idx (ガイド音声を当てはめるフレーム位置)
            </label>
            <input
              id="video-guide-frame-idx"
              type="number"
              value={guideFrameIdxStr}
              onChange={(event) => setGuideFrameIdxStr(event.target.value)}
            />
          </div>
        )}

        {error && <p className="error">{error}</p>}

        <div>
          <button
            type="button"
            disabled={
              submitting ||
              previewing ||
              !modelsValid ||
              (!recipeId && !useInheritedDefaults)
            }
            onClick={runPreview}
          >
            {previewing ? "確認中..." : "投入前に確認"}
          </button>
          <button
            type="button"
            className="primary"
            disabled={
              submitting ||
              previewing ||
              !modelsValid ||
              (!recipeId && !useInheritedDefaults)
            }
            onClick={submit}
          >
            {submitting ? "投入中..." : "動画生成を投入"}
          </button>
        </div>
        <ExecutionPreview
          preview={previewResult}
          error={previewError}
          loading={previewing}
        />
      </div>

      <h3 className="muted">生成した動画</h3>
      {videoJobs.filter((job) => job.state === "succeeded").length === 0 ? (
        <p className="muted">成功した動画Jobはまだありません。</p>
      ) : (
        <ul className="list plain">
          {videoJobs
            .filter((job) => job.state === "succeeded")
            .map((job) => (
              <li key={job.id} className="stack">
                <span className="row">
                  <span className="muted">{`順番${job.queue_sequence}`}</span>
                  <span className={`badge ${job.state}`}>{job.state}</span>
                </span>
                {(videoArtifactsByJob[job.id] ?? [])
                  .filter((artifact) => artifact.kind === "video")
                  .map((artifact) => (
                    <div key={artifact.id} className="stack">
                      <video controls src={api.artifactContentUrl(artifact.id)} />
                      <IconButton
                        icon={<Icon name="expand" />}
                        label="拡大"
                        onClick={() =>
                          setViewerIndex(
                            succeededVideoArtifacts.findIndex(
                              (item) => item.id === artifact.id,
                            ),
                          )
                        }
                      />
                    </div>
                  ))}
              </li>
            ))}
        </ul>
      )}
      <MediaViewer
        items={succeededVideoArtifacts}
        index={viewerIndex}
        onIndexChange={setViewerIndex}
        onClose={() => setViewerIndex(null)}
      />
    </section>
  );
}
