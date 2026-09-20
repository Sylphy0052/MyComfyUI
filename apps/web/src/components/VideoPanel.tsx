import { useEffect, useMemo, useState } from "react";

import { ApiError, api } from "../api/client";
import type {
  Artifact,
  ComfyUIBackendHealth,
  GenerationJob,
  GenerationPreview,
  Recipe,
} from "../api/client";
import type { ShotEnvelope } from "../api/aimedia";
import { ExecutionPreview } from "./ExecutionPreview";

/** フレーム数のグリッド。17k+5に合わない値はComfyUI側で切り上げられ、指定した尺とずれる。 */
const FRAME_GRID_STEP = 17;
const FRAME_GRID_BASE = 5;
const MIN_FRAMES = 124;
const MAX_FRAMES = 362;
const FPS = 24;

/** R2Vが受け付ける参照画像の枚数の上限。バックエンドの制約に合わせる。 */
const MAX_REFERENCES = 9;

type VideoMode = "ref2v" | "i2v";

/** 投入用の素材指定。取り込んだ入力cacheか、既存Artifactのどちらかを指す。 */
type MaterialSource = { relative_path: string; sha256: string } | { artifact_id: string };

interface MaterialItem {
  key: string;
  label: string;
  source: MaterialSource;
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.message} (${error.code})`;
  }
  return String(error);
}

async function toBase64(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of buffer) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
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
  const [health, setHealth] = useState<ComfyUIBackendHealth | null>(null);

  const [prompt, setPrompt] = useState("");
  const [secondsStr, setSecondsStr] = useState("5.2");
  const [widthStr, setWidthStr] = useState("864");
  const [heightStr, setHeightStr] = useState("480");
  const [seedStr, setSeedStr] = useState("-1");
  const [audioMode, setAudioMode] = useState<"native" | "external_voice" | "silent">(
    "native",
  );
  const [guideFrameIdxStr, setGuideFrameIdxStr] = useState("0");

  const [imageArtifacts, setImageArtifacts] = useState<Artifact[]>([]);
  const [audioArtifacts, setAudioArtifacts] = useState<Artifact[]>([]);

  const [references, setReferences] = useState<MaterialItem[]>([]);
  const [pickedRefArtifact, setPickedRefArtifact] = useState("");
  const [firstFrame, setFirstFrame] = useState<MaterialItem | null>(null);
  const [pickedFirstFrameArtifact, setPickedFirstFrameArtifact] = useState("");
  const [guideAudio, setGuideAudio] = useState<MaterialItem | null>(null);
  const [pickedGuideAudioArtifact, setPickedGuideAudioArtifact] = useState("");

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

  const seconds = Number.parseFloat(secondsStr);
  const frames =
    Number.isFinite(seconds) && seconds > 0 ? framesFromSeconds(seconds) : null;

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
    setFirstFrame(null);
    setGuideAudio(null);
  }, [shotId]);

  useEffect(() => {
    if (!shotId) {
      setImageArtifacts([]);
      setAudioArtifacts([]);
      return;
    }
    let active = true;
    (async () => {
      try {
        const [images, audios] = await Promise.all([
          api.listArtifacts({ shotId, kind: "image", limit: 50 }),
          api.listArtifacts({ shotId, kind: "audio", limit: 50 }),
        ]);
        if (!active) return;
        setImageArtifacts(images);
        setAudioArtifacts(audios);
      } catch (cause) {
        if (active) setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [shotId]);

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

  const addReferenceFile = async (file: File) => {
    if (references.length >= MAX_REFERENCES) {
      setError(`参照画像は${MAX_REFERENCES}枚までです。`);
      return;
    }
    setError(null);
    try {
      const stored = await api.createImageReference(
        file.name,
        await toBase64(file),
        file.type,
      );
      setReferences((current) => [
        ...current,
        {
          key: crypto.randomUUID(),
          label: file.name,
          source: { relative_path: stored.relative_path, sha256: stored.sha256 },
        },
      ]);
    } catch (cause) {
      setError(describe(cause));
    }
  };

  const addReferenceArtifact = (artifactId: string) => {
    if (!artifactId) return;
    if (references.length >= MAX_REFERENCES) {
      setError(`参照画像は${MAX_REFERENCES}枚までです。`);
      return;
    }
    setReferences((current) => [
      ...current,
      {
        key: crypto.randomUUID(),
        label: `Artifact ${artifactId.slice(0, 8)}`,
        source: { artifact_id: artifactId },
      },
    ]);
  };

  const removeReference = (key: string) => {
    setReferences((current) => current.filter((item) => item.key !== key));
  };

  const setFirstFrameFile = async (file: File) => {
    setError(null);
    try {
      const stored = await api.createImageReference(
        file.name,
        await toBase64(file),
        file.type,
      );
      setFirstFrame({
        key: crypto.randomUUID(),
        label: file.name,
        source: { relative_path: stored.relative_path, sha256: stored.sha256 },
      });
    } catch (cause) {
      setError(describe(cause));
    }
  };

  const setFirstFrameArtifact = (artifactId: string) => {
    if (!artifactId) return;
    setFirstFrame({
      key: crypto.randomUUID(),
      label: `Artifact ${artifactId.slice(0, 8)}`,
      source: { artifact_id: artifactId },
    });
  };

  const setGuideAudioFile = async (file: File) => {
    setError(null);
    try {
      const stored = await api.createImageReference(
        file.name,
        await toBase64(file),
        file.type,
      );
      setGuideAudio({
        key: crypto.randomUUID(),
        label: file.name,
        source: { relative_path: stored.relative_path, sha256: stored.sha256 },
      });
    } catch (cause) {
      setError(describe(cause));
    }
  };

  const setGuideAudioArtifact = (artifactId: string) => {
    if (!artifactId) return;
    setGuideAudio({
      key: crypto.randomUUID(),
      label: `Artifact ${artifactId.slice(0, 8)}`,
      source: { artifact_id: artifactId },
    });
  };

  const buildInputs = (): Record<string, unknown> | null => {
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
      if (!firstFrame) {
        setError("開始フレームの画像を指定してください。");
        return null;
      }
      inputs.first_frame = firstFrame.source;
    }

    if (audioMode === "external_voice") {
      if (!guideAudio) {
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
      inputs.guide_audio = guideAudio.source;
      inputs.guide_frame_idx = guideFrameIdx;
    }

    return inputs;
  };

  const submit = async () => {
    if (!projectId || !sceneId || !shotId || !recipe) return;
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
        recipe_id: recipe.id,
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
    if (!projectId || !sceneId || !shotId || !recipe) return;
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
        recipe_id: recipe.id,
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
        <div>
          <label htmlFor="video-recipe">Recipe</label>
          <select
            id="video-recipe"
            value={recipeId}
            onChange={(event) => setRecipeId(event.target.value)}
          >
            {recipes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>

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
          <div className="stack">
            <h3 className="muted">参照画像 (1〜{MAX_REFERENCES}枚)</h3>
            <input
              type="file"
              accept="image/*"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void addReferenceFile(file);
                event.target.value = "";
              }}
            />
            <div className="row">
              <select
                value={pickedRefArtifact}
                onChange={(event) => setPickedRefArtifact(event.target.value)}
              >
                <option value="">既存の画像Artifactから選ぶ</option>
                {imageArtifacts.map((artifact) => (
                  <option key={artifact.id} value={artifact.id}>
                    {`${artifact.id.slice(0, 8)} / ${artifact.created_at}`}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  addReferenceArtifact(pickedRefArtifact);
                  setPickedRefArtifact("");
                }}
              >
                追加
              </button>
            </div>
            <ul className="list plain">
              {references.map((item, index) => (
                <li key={item.key}>
                  <span className="row">
                    <span>{`${index + 1}. ${item.label}`}</span>
                    <button type="button" onClick={() => removeReference(item.key)}>
                      削除
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            <p className="muted">
              {`${references.length}/${MAX_REFERENCES}枚`}
            </p>
          </div>
        )}

        {mode === "i2v" && (
          <div className="stack">
            <h3 className="muted">開始フレーム</h3>
            <input
              type="file"
              accept="image/*"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void setFirstFrameFile(file);
                event.target.value = "";
              }}
            />
            <div className="row">
              <select
                value={pickedFirstFrameArtifact}
                onChange={(event) =>
                  setPickedFirstFrameArtifact(event.target.value)
                }
              >
                <option value="">既存の画像Artifactから選ぶ</option>
                {imageArtifacts.map((artifact) => (
                  <option key={artifact.id} value={artifact.id}>
                    {`${artifact.id.slice(0, 8)} / ${artifact.created_at}`}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  setFirstFrameArtifact(pickedFirstFrameArtifact);
                  setPickedFirstFrameArtifact("");
                }}
              >
                この画像にする
              </button>
            </div>
            <p className="muted mono">
              {firstFrame ? firstFrame.label : "開始フレームは未指定。"}
            </p>
          </div>
        )}

        {audioMode === "external_voice" && (
          <div className="stack">
            <h3 className="muted">ガイド音声</h3>
            <input
              type="file"
              accept="audio/*"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void setGuideAudioFile(file);
                event.target.value = "";
              }}
            />
            <div className="row">
              <select
                value={pickedGuideAudioArtifact}
                onChange={(event) =>
                  setPickedGuideAudioArtifact(event.target.value)
                }
              >
                <option value="">既存の音声Artifactから選ぶ</option>
                {audioArtifacts.map((artifact) => (
                  <option key={artifact.id} value={artifact.id}>
                    {`${artifact.id.slice(0, 8)} / ${artifact.created_at}`}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  setGuideAudioArtifact(pickedGuideAudioArtifact);
                  setPickedGuideAudioArtifact("");
                }}
              >
                この音声にする
              </button>
            </div>
            <p className="muted mono">
              {guideAudio ? guideAudio.label : "ガイド音声は未指定。"}
            </p>
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
            disabled={submitting || previewing || !shotId || !recipeId}
            onClick={runPreview}
          >
            {previewing ? "確認中..." : "投入前に確認"}
          </button>
          <button
            type="button"
            className="primary"
            disabled={submitting || previewing || !shotId || !recipeId}
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
                    <video
                      key={artifact.id}
                      controls
                      src={api.artifactContentUrl(artifact.id)}
                    />
                  ))}
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}
