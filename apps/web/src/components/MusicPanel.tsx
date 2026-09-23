import { useEffect, useMemo, useState } from "react";

import { ApiError, api } from "../api/client";
import type {
  AgentProvider,
  Artifact,
  GenerationJob,
  GenerationPreview,
  Recipe,
} from "../api/client";
import type { SceneEnvelope } from "../api/aimedia";
import { ExecutionPreview } from "./ExecutionPreview";
import { MediaViewer } from "./MediaViewer";
import { ModelSelector } from "./ModelSelector";
import { PromptAssistField } from "./PromptAssist";
import { PromptDiffReview } from "./PromptDiffReview";
import type { PromptDiffField } from "./PromptDiffReview";
import { Icon } from "./ui/Icon";
import { IconButton } from "./ui/IconButton";

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.message} (${error.code})`;
  }
  return String(error);
}

interface Props {
  projectId: string | null;
  sceneId: string | null;
  shotId: string | null;
  scene: SceneEnvelope | null;
  jobs: GenerationJob[];
  onSubmittedJob: (job: GenerationJob) => void;
}

export function MusicPanel({
  projectId,
  sceneId,
  shotId,
  scene,
  jobs,
  onSubmittedJob,
}: Props) {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [recipeId, setRecipeId] = useState("");
  const [useInheritedDefaults, setUseInheritedDefaults] = useState(false);

  const [mood, setMood] = useState("");
  const [genre, setGenre] = useState("");
  const [providers, setProviders] = useState<AgentProvider[]>([]);
  const [promptDiff, setPromptDiff] = useState<PromptDiffField[] | null>(null);
  const [instrumental, setInstrumental] = useState(true);
  const [secondsStr, setSecondsStr] = useState("14");
  const [seedStr, setSeedStr] = useState("-1");
  const [modelValues, setModelValues] = useState<Record<string, string>>({});
  const [modelsValid, setModelsValid] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewResult, setPreviewResult] = useState<GenerationPreview | null>(
    null,
  );
  const [previewError, setPreviewError] = useState<ApiError | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [audioArtifactsByJob, setAudioArtifactsByJob] = useState<
    Record<string, Artifact[]>
  >({});
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  const recipe = useMemo(
    () => recipes.find((item) => item.id === recipeId) ?? null,
    [recipes, recipeId],
  );

  const musicJobs = useMemo(
    () => jobs.filter((job) => job.kind === "music"),
    [jobs],
  );
  const succeededMusicJobIds = musicJobs
    .filter((job) => job.state === "succeeded")
    .map((job) => job.id)
    .join(",");

  const succeededMusicArtifacts = useMemo(
    () =>
      musicJobs
        .filter((job) => job.state === "succeeded")
        .flatMap((job) =>
          (audioArtifactsByJob[job.id] ?? []).filter(
            (artifact) => artifact.kind === "audio",
          ),
        ),
    [musicJobs, audioArtifactsByJob],
  );

  const tags = useMemo(
    () =>
      [
        mood.trim() || null,
        genre.trim() || null,
        instrumental ? "instrumental, no vocals" : null,
      ]
        .filter((item): item is string => Boolean(item))
        .join(", "),
    [mood, genre, instrumental],
  );

  useEffect(() => {
    void api.listAgentProviders().then(setProviders).catch(() => setProviders([]));
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const list = await api.listRecipes("music");
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

  // Scene が切り替わったら、Scene 本文が持つ BGM の想定を初期値として読み込む。
  useEffect(() => {
    const music = scene?.data.music;
    if (!music) return;
    // 開いている差分は読み込み前の mood と genre を土台にしているため閉じる。
    setPromptDiff(null);
    setMood(music.mood ?? "");
    setGenre(music.genre ?? "");
    setInstrumental(music.instrumental ?? true);
    if (music.duration_sec !== null && music.duration_sec !== undefined) {
      setSecondsStr(String(music.duration_sec));
    }
  }, [scene]);

  useEffect(() => {
    if (!succeededMusicJobIds) {
      setAudioArtifactsByJob({});
      return;
    }
    let active = true;
    (async () => {
      try {
        const ids = succeededMusicJobIds.split(",");
        const entries = await Promise.all(
          ids.map(async (id) => [id, await api.listJobArtifacts(id)] as const),
        );
        if (active) setAudioArtifactsByJob(Object.fromEntries(entries));
      } catch (cause) {
        if (active) setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [succeededMusicJobIds]);

  /** 入力の検証と`inputs`の組み立て。プレビューと投入で同じ値を使う。 */
  const buildInputs = (): Record<string, unknown> | null => {
    if (useInheritedDefaults) return {};
    if (!mood.trim()) {
      setError("moodを入力してください。");
      return null;
    }
    const seconds = Number.parseFloat(secondsStr);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      setError("尺は0より大きい数値で入力してください。");
      return null;
    }
    const seed = Number.parseInt(seedStr || "-1", 10);
    if (!Number.isFinite(seed)) {
      setError("seedは整数で入力してください。");
      return null;
    }
    return {
      ...modelValues,
      positive_prompt: tags,
      seconds,
      seed,
    };
  };

  const submit = async () => {
    if (!recipe && !useInheritedDefaults) return;
    const inputs = buildInputs();
    if (!inputs) return;
    setSubmitting(true);
    setError(null);
    try {
      const job = await api.createJob({
        kind: "music",
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

  /** 投入せずに解決済み入力とWorkflow差分だけを取る。Jobは作られない。 */
  const runPreview = async () => {
    if (!recipe && !useInheritedDefaults) return;
    const inputs = buildInputs();
    if (!inputs) return;
    setPreviewing(true);
    setError(null);
    try {
      const result = await api.previewJob({
        kind: "music",
        project_id: projectId,
        scene_id: sceneId,
        shot_id: shotId,
        recipe_id: recipe?.id,
        use_inherited_defaults: useInheritedDefaults,
        inputs,
      });
      setPreviewResult(result);
      setPreviewError(null);
    } catch (cause) {
      setPreviewResult(null);
      if (cause instanceof ApiError) {
        setPreviewError(cause);
      } else {
        setError(describe(cause));
      }
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <section className="panel">
      <h2>音楽生成</h2>

      <p className="muted">
        Projectなしでは汎用BGMとして、Project選択時は現在のScene/Shotに紐づけて作る。
      </p>

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
          <label htmlFor="music-recipe">Recipe</label>
          <select
            id="music-recipe"
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
              if ("mood" in result) setMood(result.mood);
              if ("genre" in result) setGenre(result.genre);
              setPromptDiff(null);
            }}
          />
        ) : (
          <PromptAssistField
            providers={providers}
            idPrefix="music-assist"
            subject="曲の説明"
            outputLabel="moodとgenre"
            submitLabel="条件を補完"
            placeholder="例: 夜の暗室で静かに作業する場面。落ち着いたピアノ中心で。"
            onAssist={async ({ instruction, provider_id }) => {
              const result = await api.assistMusicPrompt({ instruction, provider_id });
              // 既存の条件をすぐ上書きせず、差分レビューを開いて採否を選ばせる。
              setPromptDiff([
                { key: "mood", label: "mood", current: mood, proposed: result.mood },
                { key: "genre", label: "genre", current: genre, proposed: result.genre },
              ]);
            }}
          />
        )}
        <div className="row">
          <div>
            <label htmlFor="music-mood">mood</label>
            <input
              id="music-mood"
              value={mood}
              // 差分レビュー中に書き換えると、反映したときに書いた分が黙って消える。
              readOnly={promptDiff !== null}
              onChange={(event) => setMood(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="music-genre">genre</label>
            <input
              id="music-genre"
              value={genre}
              readOnly={promptDiff !== null}
              onChange={(event) => setGenre(event.target.value)}
            />
          </div>
        </div>

        <label htmlFor="music-instrumental">
          <input
            id="music-instrumental"
            type="checkbox"
            checked={instrumental}
            onChange={(event) => setInstrumental(event.target.checked)}
          />
          instrumental (ボーカル無し)
        </label>

        <div className="row">
          <div>
            <label htmlFor="music-seconds">尺 (秒)</label>
            <input
              id="music-seconds"
              type="number"
              step="0.1"
              value={secondsStr}
              onChange={(event) => setSecondsStr(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="music-seed">seed (-1で自動採番)</label>
            <input
              id="music-seed"
              type="number"
              value={seedStr}
              onChange={(event) => setSeedStr(event.target.value)}
            />
          </div>
        </div>

        <p className="muted mono">
          {tags ? `投入するタグ: ${tags}` : "moodを入力するとタグを組み立てる。"}
        </p>

        {error && <p className="error">{error}</p>}

        <div className="row">
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
            {submitting ? "投入中..." : "音楽生成を投入"}
          </button>
        </div>

        <ExecutionPreview
          preview={previewResult}
          error={previewError}
          loading={previewing}
        />
      </div>

      <h3 className="muted">生成した音楽</h3>
      {musicJobs.filter((job) => job.state === "succeeded").length === 0 ? (
        <p className="muted">成功した音楽Jobはまだありません。</p>
      ) : (
        <ul className="list plain">
          {musicJobs
            .filter((job) => job.state === "succeeded")
            .map((job) => (
              <li key={job.id} className="stack">
                <span className="row">
                  <span className="muted">{`順番${job.queue_sequence}`}</span>
                  <span className={`badge ${job.state}`}>{job.state}</span>
                </span>
                {(audioArtifactsByJob[job.id] ?? [])
                  .filter((artifact) => artifact.kind === "audio")
                  .map((artifact) => (
                    <div key={artifact.id} className="stack">
                      <audio controls src={api.artifactContentUrl(artifact.id)} />
                      <IconButton
                        icon={<Icon name="expand" />}
                        label="拡大"
                        onClick={() =>
                          setViewerIndex(
                            succeededMusicArtifacts.findIndex(
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
        items={succeededMusicArtifacts}
        index={viewerIndex}
        onIndexChange={setViewerIndex}
        onClose={() => setViewerIndex(null)}
      />
    </section>
  );
}
