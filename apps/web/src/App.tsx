import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError, api } from "./api/client";
import type {
  Artifact,
  ArtifactDecision,
  GenerationJob,
  GenerationManifest,
  Recipe,
} from "./api/client";
import type {
  Project,
  SceneEnvelope,
  SceneSummary,
  ShotEnvelope,
  ShotSummary,
} from "./api/aimedia";
import { CandidateGallery } from "./components/CandidateGallery";
import type { Candidate } from "./components/CandidateGallery";
import { GenerationForm } from "./components/GenerationForm";
import { JobQueue } from "./components/JobQueue";
import { SceneBrowser } from "./components/SceneBrowser";

/**
 * 進捗は REST の定期取得で追う。WebSocket 通知は #9 以降で追加する。
 * REST で得られる状態を正本とする方針は ADR 0001 のとおり。
 */
const POLL_INTERVAL_MS = 2000;

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    return error.requestId
      ? `${error.message} (${error.code} / request_id=${error.requestId})`
      : `${error.message} (${error.code})`;
  }
  return String(error);
}

export function App() {
  const [error, setError] = useState<string | null>(null);

  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [scenes, setScenes] = useState<SceneSummary[]>([]);
  const [sceneId, setSceneId] = useState<string | null>(null);
  const [scene, setScene] = useState<SceneEnvelope | null>(null);
  const [shots, setShots] = useState<ShotSummary[]>([]);
  const [shotId, setShotId] = useState<string | null>(null);
  const [shot, setShot] = useState<ShotEnvelope | null>(null);

  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [manifest, setManifest] = useState<GenerationManifest | null>(null);
  const [artifactsByJob, setArtifactsByJob] = useState<
    Record<string, Artifact[]>
  >({});
  const [submitting, setSubmitting] = useState(false);
  const [busyArtifactId, setBusyArtifactId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [projectList, recipeList] = await Promise.all([
          api.listProjects(),
          api.listRecipes("image"),
        ]);
        if (!active) return;
        setProjects(projectList.items);
        setRecipes(recipeList);
        if (projectList.items.length > 0) {
          setProjectId(projectList.items[0].id);
        }
      } catch (cause) {
        if (active) setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    (async () => {
      try {
        const list = await api.listScenes(projectId);
        if (!active) return;
        setScenes(list.items);
        setSceneId(list.items.length > 0 ? list.items[0].id : null);
      } catch (cause) {
        if (active) setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !sceneId) {
      setScene(null);
      setShots([]);
      setShotId(null);
      return;
    }
    let active = true;
    (async () => {
      try {
        const [envelope, shotList] = await Promise.all([
          api.getScene(projectId, sceneId),
          api.listShots(projectId, sceneId),
        ]);
        if (!active) return;
        setScene(envelope);
        setShots(shotList.items);
        setShotId(shotList.items.length > 0 ? shotList.items[0].id : null);
      } catch (cause) {
        if (active) setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [projectId, sceneId]);

  useEffect(() => {
    if (!projectId || !sceneId || !shotId) {
      setShot(null);
      return;
    }
    let active = true;
    (async () => {
      try {
        const envelope = await api.getShot(projectId, sceneId, shotId);
        if (active) setShot(envelope);
      } catch (cause) {
        if (active) setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [projectId, sceneId, shotId]);

  const refreshJobs = useCallback(async () => {
    if (!shotId) {
      setJobs([]);
      return;
    }
    const list = await api.listJobs({ shotId });
    setJobs(list);
  }, [shotId]);

  useEffect(() => {
    if (!shotId) {
      setJobs([]);
      setSelectedJobId(null);
      return;
    }
    let active = true;
    const tick = async () => {
      try {
        const list = await api.listJobs({ shotId });
        if (active) setJobs(list);
      } catch (cause) {
        if (active) setError(describe(cause));
      }
    };
    void tick();
    const timer = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [shotId]);

  useEffect(() => {
    if (!selectedJobId) {
      setManifest(null);
      return;
    }
    const job = jobs.find((item) => item.id === selectedJobId);
    if (!job) {
      setManifest(null);
      return;
    }
    if (manifest?.id === job.manifest_id) {
      return;
    }
    let active = true;
    (async () => {
      try {
        const found = await api.getManifest(job.manifest_id);
        if (active) setManifest(found);
      } catch (cause) {
        if (active) setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [selectedJobId, jobs, manifest]);

  const succeededIds = jobs
    .filter((job) => job.state === "succeeded")
    .map((job) => job.id)
    .join(",");

  useEffect(() => {
    if (!succeededIds) {
      setArtifactsByJob({});
      return;
    }
    let active = true;
    (async () => {
      try {
        const ids = succeededIds.split(",");
        const entries = await Promise.all(
          ids.map(
            async (id) => [id, await api.listJobArtifacts(id)] as const,
          ),
        );
        if (active) setArtifactsByJob(Object.fromEntries(entries));
      } catch (cause) {
        if (active) setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [succeededIds]);

  const candidates = useMemo<Candidate[]>(() => {
    const items: Candidate[] = [];
    for (const [jobId, artifacts] of Object.entries(artifactsByJob)) {
      for (const artifact of artifacts) {
        if (artifact.kind === "image") {
          items.push({ artifact, jobId });
        }
      }
    }
    return items.sort((left, right) =>
      left.artifact.created_at.localeCompare(right.artifact.created_at),
    );
  }, [artifactsByJob]);

  const submit = async (recipe: Recipe, inputs: Record<string, unknown>) => {
    if (!sceneId || !shotId) return;
    setSubmitting(true);
    setError(null);
    try {
      // キューは全 Job で 1 本のため、投入時点の最大値の次を使う。
      const all = await api.listJobs({});
      const nextSequence =
        all.reduce((max, job) => Math.max(max, job.queue_sequence), 0) + 1;
      const job = await api.createJob({
        kind: "image",
        scene_ref: { id: sceneId },
        shot_ref: { id: shotId },
        recipe_id: recipe.id,
        queue_sequence: nextSequence,
        inputs,
      });
      setSelectedJobId(job.id);
      await refreshJobs();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async (jobId: string) => {
    setError(null);
    try {
      await api.cancelJob(jobId);
      await refreshJobs();
    } catch (cause) {
      setError(describe(cause));
    }
  };

  const decide = async (artifactId: string, decision: ArtifactDecision) => {
    setBusyArtifactId(artifactId);
    setError(null);
    try {
      const updated = await api.updateDecision(artifactId, decision);
      setArtifactsByJob((current) => {
        const next: Record<string, Artifact[]> = {};
        for (const [jobId, artifacts] of Object.entries(current)) {
          next[jobId] = artifacts.map((artifact) =>
            artifact.id === updated.id ? updated : artifact,
          );
        }
        return next;
      });
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusyArtifactId(null);
    }
  };

  return (
    <div className="app">
      <header>
        <h1>MyComfyUI</h1>
        <span className="muted">
          Scene/Shotから画像生成を投入し、進捗と候補を確認する。
        </span>
      </header>

      <div>
        <SceneBrowser
          projects={projects}
          projectId={projectId}
          onSelectProject={setProjectId}
          scenes={scenes}
          sceneId={sceneId}
          onSelectScene={setSceneId}
          scene={scene}
          shots={shots}
          shotId={shotId}
          onSelectShot={setShotId}
          shot={shot}
        />
      </div>

      <div>
        {error && (
          <div className="panel">
            <p className="error">{error}</p>
            <button type="button" onClick={() => setError(null)}>
              閉じる
            </button>
          </div>
        )}
        <GenerationForm
          recipes={recipes}
          disabled={!shotId}
          submitting={submitting}
          onSubmit={submit}
        />
        <CandidateGallery
          candidates={candidates}
          busyArtifactId={busyArtifactId}
          onDecide={decide}
        />
      </div>

      <div>
        <JobQueue
          jobs={jobs}
          selectedJobId={selectedJobId}
          manifest={manifest}
          onSelect={setSelectedJobId}
          onCancel={cancel}
        />
      </div>
    </div>
  );
}
