import { useEffect, useMemo, useState } from "react";

import { ApiError, api } from "../api/client";
import type { Artifact, GenerationJob, Recipe } from "../api/client";
import type { SceneEnvelope } from "../api/aimedia";

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

  const [mood, setMood] = useState("");
  const [genre, setGenre] = useState("");
  const [instrumental, setInstrumental] = useState(true);
  const [secondsStr, setSecondsStr] = useState("14");
  const [seedStr, setSeedStr] = useState("-1");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioArtifactsByJob, setAudioArtifactsByJob] = useState<
    Record<string, Artifact[]>
  >({});

  const musicJobs = useMemo(
    () => jobs.filter((job) => job.kind === "music"),
    [jobs],
  );
  const succeededMusicJobIds = musicJobs
    .filter((job) => job.state === "succeeded")
    .map((job) => job.id)
    .join(",");

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

  const submit = async () => {
    if (!projectId || !sceneId || !shotId) return;
    const recipe = recipes.find((item) => item.id === recipeId);
    if (!recipe) return;
    if (!mood.trim()) {
      setError("moodを入力してください。");
      return;
    }
    const seconds = Number.parseFloat(secondsStr);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      setError("尺は0より大きい数値で入力してください。");
      return;
    }
    const seed = Number.parseInt(seedStr || "-1", 10);
    if (!Number.isFinite(seed)) {
      setError("seedは整数で入力してください。");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const job = await api.createJob({
        kind: "music",
        project_id: projectId,
        scene_id: sceneId,
        shot_id: shotId,
        recipe_id: recipe.id,
        inputs: {
          positive_prompt: tags,
          seconds,
          seed,
        },
      });
      onSubmittedJob(job);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="panel">
      <h2>音楽生成</h2>

      <p className="muted">
        BGMはScene単位で作るが、Application APIの要求はshot_idを必須にしているため、
        選択中のShotのIDをそのまま送る。
      </p>

      <div className="stack">
        <div>
          <label htmlFor="music-recipe">Recipe</label>
          <select
            id="music-recipe"
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

        <div className="row">
          <div>
            <label htmlFor="music-mood">mood</label>
            <input
              id="music-mood"
              value={mood}
              onChange={(event) => setMood(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="music-genre">genre</label>
            <input
              id="music-genre"
              value={genre}
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

        <div>
          <button
            type="button"
            className="primary"
            disabled={submitting || !shotId || !recipeId}
            onClick={submit}
          >
            {submitting ? "投入中..." : "音楽生成を投入"}
          </button>
        </div>
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
                    <audio
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
