import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError, api } from "../api/client";
import type {
  Artifact,
  GenerationJob,
  GenerationPreview,
  Recipe,
} from "../api/client";
import { ExecutionPreview } from "./ExecutionPreview";

/** BGMは台詞の約3分の1を既定値とする (台詞1.0に対しBGM0.33)。 */
const DEFAULT_VOICE_VOLUME = "1.0";
const DEFAULT_BGM_VOLUME = "0.33";

interface VoiceTrackState {
  key: string;
  artifactId: string;
  startSecStr: string;
  volumeStr: string;
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.message} (${error.code})`;
  }
  return String(error);
}

function artifactLabel(artifact: Artifact): string {
  return `${artifact.id.slice(0, 8)} / ${artifact.created_at}`;
}

interface Props {
  projectId: string | null;
  sceneId: string | null;
  shotId: string | null;
  jobs: GenerationJob[];
  onSubmittedJob: (job: GenerationJob) => void;
}

export function ComposePanel({
  projectId,
  sceneId,
  shotId,
  jobs,
  onSubmittedJob,
}: Props) {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [recipeId, setRecipeId] = useState("");
  const [useInheritedDefaults, setUseInheritedDefaults] = useState(false);

  const [videoArtifacts, setVideoArtifacts] = useState<Artifact[]>([]);
  const [audioArtifacts, setAudioArtifacts] = useState<Artifact[]>([]);

  const [selectedVideoArtifactId, setSelectedVideoArtifactId] = useState("");
  const [voiceTracks, setVoiceTracks] = useState<VoiceTrackState[]>([]);
  const [bgmArtifactId, setBgmArtifactId] = useState("");
  const [bgmVolumeStr, setBgmVolumeStr] = useState(DEFAULT_BGM_VOLUME);

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

  const composeJobs = useMemo(
    () => jobs.filter((job) => job.kind === "compose"),
    [jobs],
  );
  const succeededComposeJobIds = composeJobs
    .filter((job) => job.state === "succeeded")
    .map((job) => job.id)
    .join(",");

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const list = await api.listRecipes("compose");
        if (!active) return;
        setRecipes(list);
        if (list.length > 0) setRecipeId((current) => current || list[0].id);
      } catch (cause) {
        if (active) setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const loadArtifacts = useCallback(async () => {
    const [videos, audios] = await Promise.all([
      api.listArtifacts({
        projectId: projectId ?? undefined,
        shotId: shotId ?? undefined,
        unassigned: !projectId,
        kind: "video",
        limit: 50,
      }),
      api.listArtifacts({
        projectId: projectId ?? undefined,
        shotId: shotId ?? undefined,
        unassigned: !projectId,
        kind: "audio",
        limit: 50,
      }),
    ]);
    return { videos, audios };
  }, [projectId, shotId]);

  // Shot が変わったら候補と選択をやり直す。別 Shot の指定を引き継がない。
  useEffect(() => {
    setSelectedVideoArtifactId("");
    setVoiceTracks([]);
    setBgmArtifactId("");
    let active = true;
    (async () => {
      try {
        const { videos, audios } = await loadArtifacts();
        if (!active) return;
        setVideoArtifacts(videos);
        setAudioArtifacts(audios);
      } catch (cause) {
        if (active) setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [shotId, loadArtifacts]);

  useEffect(() => {
    if (!succeededComposeJobIds) {
      setVideoArtifactsByJob({});
      return;
    }
    let active = true;
    (async () => {
      try {
        const ids = succeededComposeJobIds.split(",");
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
  }, [succeededComposeJobIds]);

  const addVoiceTrack = () => {
    setVoiceTracks((current) => [
      ...current,
      {
        key: crypto.randomUUID(),
        artifactId: "",
        startSecStr: "0",
        volumeStr: DEFAULT_VOICE_VOLUME,
      },
    ]);
  };

  const updateVoiceTrack = (key: string, patch: Partial<VoiceTrackState>) => {
    setVoiceTracks((current) =>
      current.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );
  };

  const removeVoiceTrack = (key: string) => {
    setVoiceTracks((current) => current.filter((item) => item.key !== key));
  };

  const buildInputs = (): Record<string, unknown> | null => {
    if (useInheritedDefaults) return {};
    if (!selectedVideoArtifactId) {
      setError("合成する動画Artifactを選んでください。");
      return null;
    }

    const voices: Record<string, unknown>[] = [];
    for (const track of voiceTracks) {
      if (!track.artifactId) {
        setError("台詞音声のArtifactを選んでください。");
        return null;
      }
      const startSec = Number.parseFloat(track.startSecStr);
      if (!Number.isFinite(startSec) || startSec < 0) {
        setError("台詞音声の開始位置は0以上の数値で入力してください。");
        return null;
      }
      const volume = Number.parseFloat(track.volumeStr);
      if (!Number.isFinite(volume) || volume <= 0) {
        setError("台詞音声の音量は0より大きい数値で入力してください。");
        return null;
      }
      voices.push({ artifact_id: track.artifactId, start_sec: startSec, volume });
    }

    const inputs: Record<string, unknown> = {
      video: { artifact_id: selectedVideoArtifactId },
      voices,
    };

    if (bgmArtifactId) {
      const bgmVolume = Number.parseFloat(bgmVolumeStr);
      if (!Number.isFinite(bgmVolume) || bgmVolume <= 0) {
        setError("BGMの音量は0より大きい数値で入力してください。");
        return null;
      }
      inputs.bgm = { artifact_id: bgmArtifactId, volume: bgmVolume };
    }

    return inputs;
  };

  const submit = async () => {
    const recipe = recipes.find((item) => item.id === recipeId);
    if (!recipe && !useInheritedDefaults) return;
    const inputs = buildInputs();
    if (!inputs) return;

    setSubmitting(true);
    setError(null);
    try {
      const job = await api.createJob({
        kind: "compose",
        project_id: projectId,
        scene_id: sceneId,
        shot_id: shotId,
        recipe_id: recipe?.id,
        use_inherited_defaults: useInheritedDefaults,
        inputs,
      });
      onSubmittedJob(job);
      const { videos, audios } = await loadArtifacts();
      setVideoArtifacts(videos);
      setAudioArtifacts(audios);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const runPreview = async () => {
    const recipe = recipes.find((item) => item.id === recipeId);
    if (!recipe && !useInheritedDefaults) return;
    const inputs = buildInputs();
    if (!inputs) return;

    setPreviewing(true);
    setError(null);
    try {
      const preview = await api.previewJob({
        kind: "compose",
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

  return (
    <section className="panel">
      <h2>動画合成</h2>

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
          <label htmlFor="compose-recipe">Recipe</label>
          <select
            id="compose-recipe"
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

        <div>
          <label htmlFor="compose-video">合成する動画</label>
          <select
            id="compose-video"
            value={selectedVideoArtifactId}
            onChange={(event) => setSelectedVideoArtifactId(event.target.value)}
          >
            <option value="">動画Artifactを選ぶ</option>
            {videoArtifacts.map((artifact) => (
              <option key={artifact.id} value={artifact.id}>
                {artifactLabel(artifact)}
              </option>
            ))}
          </select>
        </div>

        <h3 className="muted">台詞音声 (0件以上)</h3>
        {voiceTracks.length === 0 && (
          <p className="muted">台詞音声は指定しなくても投入できる。</p>
        )}
        <ul className="list plain">
          {voiceTracks.map((track) => (
            <li key={track.key} className="stack">
              <div className="row">
                <select
                  value={track.artifactId}
                  onChange={(event) =>
                    updateVoiceTrack(track.key, { artifactId: event.target.value })
                  }
                >
                  <option value="">音声Artifactを選ぶ</option>
                  {audioArtifacts.map((artifact) => (
                    <option key={artifact.id} value={artifact.id}>
                      {artifactLabel(artifact)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => removeVoiceTrack(track.key)}
                >
                  削除
                </button>
              </div>
              <div className="row">
                <div>
                  <label htmlFor={`compose-voice-start-${track.key}`}>
                    開始位置 (秒)
                  </label>
                  <input
                    id={`compose-voice-start-${track.key}`}
                    type="number"
                    step="0.01"
                    value={track.startSecStr}
                    onChange={(event) =>
                      updateVoiceTrack(track.key, {
                        startSecStr: event.target.value,
                      })
                    }
                  />
                </div>
                <div>
                  <label htmlFor={`compose-voice-volume-${track.key}`}>
                    音量
                  </label>
                  <input
                    id={`compose-voice-volume-${track.key}`}
                    type="number"
                    step="0.01"
                    value={track.volumeStr}
                    onChange={(event) =>
                      updateVoiceTrack(track.key, {
                        volumeStr: event.target.value,
                      })
                    }
                  />
                </div>
              </div>
            </li>
          ))}
        </ul>
        <div>
          <button type="button" onClick={addVoiceTrack}>
            台詞音声を追加
          </button>
        </div>

        <h3 className="muted">BGM (0件か1件)</h3>
        <div>
          <label htmlFor="compose-bgm">BGM Artifact</label>
          <select
            id="compose-bgm"
            value={bgmArtifactId}
            onChange={(event) => setBgmArtifactId(event.target.value)}
          >
            <option value="">指定しない</option>
            {audioArtifacts.map((artifact) => (
              <option key={artifact.id} value={artifact.id}>
                {artifactLabel(artifact)}
              </option>
            ))}
          </select>
        </div>
        {bgmArtifactId && (
          <div>
            <label htmlFor="compose-bgm-volume">BGM音量</label>
            <input
              id="compose-bgm-volume"
              type="number"
              step="0.01"
              value={bgmVolumeStr}
              onChange={(event) => setBgmVolumeStr(event.target.value)}
            />
            <p className="muted">
              BGMは台詞の約3分の1を既定値とする (台詞
              {DEFAULT_VOICE_VOLUME}に対しBGM{DEFAULT_BGM_VOLUME})。
            </p>
          </div>
        )}

        <p className="muted">
          台詞が動画の尺を超えるとJobはfailed
          (COMPOSE_DURATION_EXCEEDED)になる。
        </p>

        {error && <p className="error">{error}</p>}

        <div>
          <button
            type="button"
            disabled={submitting || previewing || (!recipeId && !useInheritedDefaults)}
            onClick={runPreview}
          >
            {previewing ? "確認中..." : "投入前に確認"}
          </button>
          <button
            type="button"
            className="primary"
            disabled={submitting || previewing || (!recipeId && !useInheritedDefaults)}
            onClick={submit}
          >
            {submitting ? "投入中..." : "合成を投入"}
          </button>
        </div>
        <ExecutionPreview
          preview={previewResult}
          error={previewError}
          loading={previewing}
        />
      </div>

      <h3 className="muted">合成した動画</h3>
      {composeJobs.filter((job) => job.state === "succeeded").length === 0 ? (
        <p className="muted">成功した合成Jobはまだありません。</p>
      ) : (
        <ul className="list plain">
          {composeJobs
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
