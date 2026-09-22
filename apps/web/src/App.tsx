import { useCallback, useEffect, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";

import { ApiError, api } from "./api/client";
import type {
  Artifact,
  ArtifactDecision,
  GenerationJob,
  GenerationManifest,
  GenerationPreview,
  ProjectRecord,
  Recipe,
} from "./api/client";
import type {
  SceneEnvelope,
  SceneSummary,
  ShotEnvelope,
  ShotSummary,
} from "./api/aimedia";
import { AgentPanel } from "./components/AgentPanel";
import { ArtifactHistory } from "./components/ArtifactHistory";
import { AssetBrowser } from "./components/AssetBrowser";
import { CandidateGallery } from "./components/CandidateGallery";
import type { Candidate } from "./components/CandidateGallery";
import { ComposePanel } from "./components/ComposePanel";
import { GenerationForm } from "./components/GenerationForm";
import { IntegrityList } from "./components/IntegrityList";
import { ImageDerivationPanel } from "./components/ImageDerivationPanel";
import { JobQueue } from "./components/JobQueue";
import { MusicPanel } from "./components/MusicPanel";
import { ProjectWorkspace } from "./components/ProjectWorkspace";
import { SceneBrowser } from "./components/SceneBrowser";
import { VideoPanel } from "./components/VideoPanel";
import { VoicePanel } from "./components/VoicePanel";
import { WorkflowRegistry } from "./components/WorkflowRegistry";

/**
 * 進捗は REST の定期取得で追う。WebSocket 通知は #9 以降で追加する。
 * REST で得られる状態を正本とする方針は ADR 0001 のとおり。
 */
const POLL_INTERVAL_MS = 2000;

type View = "projects" | "generate" | "assets" | "workflows";
type GenerationTab = "image" | "video" | "music" | "voice" | "compose";
type LowerTab = "agent" | "history";

const VIEWS: { value: View; label: string }[] = [
  { value: "projects", label: "Project" },
  { value: "generate", label: "生成" },
  { value: "assets", label: "資産ブラウザ" },
  { value: "workflows", label: "Workflow" },
];

const GENERATION_TABS: { value: GenerationTab; label: string }[] = [
  { value: "image", label: "画像" },
  { value: "video", label: "動画" },
  { value: "music", label: "音楽" },
  { value: "voice", label: "音声" },
  { value: "compose", label: "合成" },
];

const LOWER_TABS: { value: LowerTab; label: string }[] = [
  { value: "agent", label: "エージェント" },
  { value: "history", label: "Artifact履歴" },
];

function nextTabForKey<T extends string>(
  key: string,
  tabs: readonly { value: T }[],
  currentTab: T,
): T | null {
  const currentIndex = tabs.findIndex((item) => item.value === currentTab);
  if (currentIndex < 0) return null;

  let nextIndex: number | null = null;
  if (key === "ArrowRight") {
    nextIndex = (currentIndex + 1) % tabs.length;
  } else if (key === "ArrowLeft") {
    nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  } else if (key === "Home") {
    nextIndex = 0;
  } else if (key === "End") {
    nextIndex = tabs.length - 1;
  }

  return nextIndex === null ? null : tabs[nextIndex].value;
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    return error.requestId
      ? `${error.message} (${error.code} / request_id=${error.requestId})`
      : `${error.message} (${error.code})`;
  }
  return String(error);
}

function recipeTemplateName(recipe: Recipe): string {
  const reference = recipe.workflow_template_ref as Record<string, unknown>;
  return typeof reference?.name === "string" ? reference.name : "";
}

export function App() {
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("generate");
  const [generationTab, setGenerationTab] =
    useState<GenerationTab>("image");
  const [lowerTab, setLowerTab] = useState<LowerTab>("agent");

  const [projects, setProjects] = useState<ProjectRecord[]>([]);
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
  const [previewResult, setPreviewResult] = useState<GenerationPreview | null>(
    null,
  );
  const [previewError, setPreviewError] = useState<ApiError | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [busyArtifactId, setBusyArtifactId] = useState<string | null>(null);
  // Job を投入・派生させたときに値を変え、Artifact 履歴を取り直させる。
  const [historyToken, setHistoryToken] = useState(0);
  const [structureToken, setStructureToken] = useState(0);
  const [derivationSourceArtifactId, setDerivationSourceArtifactId] =
    useState<string | null>(null);

  const txt2imgRecipes = useMemo(
    () => recipes.filter((recipe) => recipeTemplateName(recipe) === "anima_txt2img"),
    [recipes],
  );
  const derivationRecipes = useMemo(
    () => {
      const allowed = new Set([
        "anima_img2img",
        "anima_inpaint",
        "image_upscale",
        "sd15_controlnet",
      ]);
      return recipes.filter((recipe) => allowed.has(recipeTemplateName(recipe)));
    },
    [recipes],
  );

  const jobScope = useMemo<Parameters<typeof api.listJobs>[0]>(() => {
    if (!projectId) return { unassigned: true };
    if (shotId) return { projectId, sceneId: sceneId ?? undefined, shotId };
    if (sceneId) return { projectId, sceneId };
    return { projectId };
  }, [projectId, sceneId, shotId]);

  const selectProject = useCallback((nextProjectId: string | null) => {
    setProjectId(nextProjectId);
    if (!nextProjectId) return;
    void api
      .touchProject(nextProjectId)
      .then((updated) => {
        setProjects((current) =>
          current
            .map((project) =>
              project.id === updated.id ? updated : project,
            )
            .sort((left, right) => {
              if (left.favorite !== right.favorite) return left.favorite ? -1 : 1;
              return (right.last_used_at ?? "").localeCompare(
                left.last_used_at ?? "",
              );
            }),
        );
      })
      .catch((cause) => setError(describe(cause)));
  }, []);

  const useProject = useCallback((nextProjectId: string | null) => {
    setProjectId(nextProjectId);
    if (nextProjectId) setView("generate");
  }, []);

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
      } catch (cause) {
        if (active) setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!projectId) {
      setScenes([]);
      setSceneId(null);
      return;
    }
    let active = true;
    (async () => {
      try {
        const list = await api.listScenes(projectId);
        if (!active) return;
        setScenes(list.items);
        setSceneId((current) =>
          current && list.items.some((item) => item.id === current)
            ? current
            : (list.items[0]?.id ?? null),
        );
      } catch (cause) {
        if (active) setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [projectId, structureToken]);

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
        setShotId((current) =>
          current && shotList.items.some((item) => item.id === current)
            ? current
            : (shotList.items[0]?.id ?? null),
        );
      } catch (cause) {
        if (active) setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [projectId, sceneId, structureToken]);

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
  }, [projectId, sceneId, shotId, structureToken]);

  const refreshJobs = useCallback(async () => {
    const list = await api.listJobs(jobScope);
    setJobs(list);
  }, [jobScope]);

  useEffect(() => {
    let active = true;
    let issued = 0;
    let applied = 0;
    const tick = async () => {
      const sequence = ++issued;
      try {
        const list = await api.listJobs(jobScope);
        // 遅れて届いた古い応答で、新しい状態を上書きしない。
        if (active && sequence > applied) {
          applied = sequence;
          setJobs(list);
        }
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
  }, [jobScope]);

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

  // 成功した Job の集合が変わったときだけ Artifact を取り直す。配列のままでは毎回の
  // ポーリングで参照が変わり再取得が走るため、依存配列には文字列で渡す。
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

  const submit = async (
    recipe: Recipe | null,
    inputs: Record<string, unknown>,
    useInheritedDefaults: boolean,
    batchCount: number,
  ) => {
    setSubmitting(true);
    setError(null);
    const createdJobs: GenerationJob[] = [];
    try {
      for (let index = 0; index < batchCount; index += 1) {
        const job = await api.createJob({
          kind: "image",
          project_id: projectId,
          scene_id: sceneId,
          shot_id: shotId,
          recipe_id: recipe?.id,
          use_inherited_defaults: useInheritedDefaults,
          inputs,
        });
        createdJobs.push(job);
      }
      const lastJob = createdJobs.at(-1);
      if (lastJob) setSelectedJobId(lastJob.id);
      setHistoryToken((current) => current + 1);
      await refreshJobs();
    } catch (cause) {
      if (createdJobs.length > 0) {
        setSelectedJobId(createdJobs.at(-1)?.id ?? null);
        setHistoryToken((current) => current + 1);
        await refreshJobs();
        setError(
          `${createdJobs.length}/${batchCount}バッチを投入しました。残りの投入に失敗しました: ${describe(cause)}`,
        );
      } else {
        setError(describe(cause));
      }
    } finally {
      setSubmitting(false);
    }
  };

  /** 投入せずに解決済み入力とWorkflow差分だけを取る。Jobは作られない。 */
  const preview = async (
    recipe: Recipe | null,
    inputs: Record<string, unknown>,
    useInheritedDefaults: boolean,
  ) => {
    setPreviewing(true);
    setError(null);
    try {
      const result = await api.previewJob({
        kind: "image",
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

  // 再実行で作った派生 Job も、投入直後と同じようにキューと履歴へ反映する。
  const handleDerivedJob = (job: GenerationJob) => {
    setSelectedJobId(job.id);
    setHistoryToken((current) => current + 1);
    void refreshJobs().catch((cause) => setError(describe(cause)));
  };

  const handleGenerationTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentTab: GenerationTab,
  ) => {
    const nextTab = nextTabForKey(
      event.key,
      GENERATION_TABS,
      currentTab,
    );
    if (!nextTab) return;

    event.preventDefault();
    setGenerationTab(nextTab);
    document.getElementById(`generation-tab-${nextTab}`)?.focus();
  };

  const handleLowerTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentTab: LowerTab,
  ) => {
    const nextTab = nextTabForKey(event.key, LOWER_TABS, currentTab);
    if (!nextTab) return;

    event.preventDefault();
    setLowerTab(nextTab);
    document.getElementById(`lower-tab-${nextTab}`)?.focus();
  };

  return (
    <div className="app">
      <header>
        <h1>MyComfyUI</h1>
        <span className="muted">
          Projectの有無を選び、画像・音声・動画・音楽・合成の生成を投入する。
        </span>
        <nav className="row">
          {VIEWS.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={view === item.value}
              className={view === item.value ? "primary" : undefined}
              onClick={() => setView(item.value)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      {error && (
        <div className="full">
          <div className="panel">
            <p className="error">{error}</p>
            <button type="button" onClick={() => setError(null)}>
              閉じる
            </button>
          </div>
        </div>
      )}

      {view === "projects" && (
        <ProjectWorkspace
          selectedProjectId={projectId}
          onSelectProject={useProject}
          onActiveProjectsChanged={setProjects}
        />
      )}

      {view === "generate" && (
        <>
          <div>
            <SceneBrowser
              projects={projects}
              projectId={projectId}
              onSelectProject={selectProject}
              onManageProjects={() => setView("projects")}
              onStructureChanged={() => setStructureToken((value) => value + 1)}
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

          <div className="generation-workspace">
            <nav
              className="generation-tabs"
              role="tablist"
              aria-label="生成種別"
            >
              {GENERATION_TABS.map((item) => (
                <button
                  key={item.value}
                  id={`generation-tab-${item.value}`}
                  type="button"
                  role="tab"
                  aria-selected={generationTab === item.value}
                  aria-controls={`generation-panel-${item.value}`}
                  tabIndex={generationTab === item.value ? 0 : -1}
                  className={
                    generationTab === item.value ? "primary" : undefined
                  }
                  onClick={() => setGenerationTab(item.value)}
                  onKeyDown={(event) =>
                    handleGenerationTabKeyDown(event, item.value)
                  }
                >
                  {item.label}
                </button>
              ))}
            </nav>

            <div
              id="generation-panel-image"
              role="tabpanel"
              aria-labelledby="generation-tab-image"
              hidden={generationTab !== "image"}
            >
              <GenerationForm
                projectId={projectId}
                recipes={txt2imgRecipes}
                disabled={false}
                submitting={submitting}
                onSubmit={submit}
                onPreview={preview}
                previewing={previewing}
                preview={previewResult}
                previewError={previewError}
              />
              <CandidateGallery
                candidates={candidates}
                busyArtifactId={busyArtifactId}
                onDecide={decide}
                onDerive={setDerivationSourceArtifactId}
              />
              <ImageDerivationPanel
                projectId={projectId}
                sceneId={sceneId}
                shotId={shotId}
                recipes={derivationRecipes}
                sourceArtifactId={derivationSourceArtifactId}
                onSourceArtifactChange={setDerivationSourceArtifactId}
                onSubmittedJob={handleDerivedJob}
              />
            </div>

            <div
              id="generation-panel-video"
              role="tabpanel"
              aria-labelledby="generation-tab-video"
              hidden={generationTab !== "video"}
            >
              <VideoPanel
                projectId={projectId}
                sceneId={sceneId}
                shotId={shotId}
                shot={shot}
                jobs={jobs}
                onSubmittedJob={handleDerivedJob}
              />
            </div>

            <div
              id="generation-panel-music"
              role="tabpanel"
              aria-labelledby="generation-tab-music"
              hidden={generationTab !== "music"}
            >
              <MusicPanel
                projectId={projectId}
                sceneId={sceneId}
                shotId={shotId}
                scene={scene}
                jobs={jobs}
                onSubmittedJob={handleDerivedJob}
              />
            </div>

            <div
              id="generation-panel-voice"
              role="tabpanel"
              aria-labelledby="generation-tab-voice"
              hidden={generationTab !== "voice"}
            >
              <VoicePanel
                projectId={projectId}
                sceneId={sceneId}
                shotId={shotId}
                shot={shot}
                jobs={jobs}
                onSubmittedJob={handleDerivedJob}
              />
            </div>

            <div
              id="generation-panel-compose"
              role="tabpanel"
              aria-labelledby="generation-tab-compose"
              hidden={generationTab !== "compose"}
            >
              <ComposePanel
                projectId={projectId}
                sceneId={sceneId}
                shotId={shotId}
                jobs={jobs}
                onSubmittedJob={handleDerivedJob}
              />
            </div>
          </div>

          <div>
            <JobQueue
              jobs={jobs}
              selectedJobId={selectedJobId}
              manifest={manifest}
              onSelect={setSelectedJobId}
              onCancel={cancel}
              projects={projects}
              unassigned={!projectId}
              onAssignmentChanged={async () => {
                await refreshJobs();
                setHistoryToken((current) => current + 1);
              }}
            />
          </div>

          <div className="full lower-workspace">
            <nav
              className="lower-tabs"
              role="tablist"
              aria-label="補助機能"
            >
              {LOWER_TABS.map((item) => (
                <button
                  key={item.value}
                  id={`lower-tab-${item.value}`}
                  type="button"
                  role="tab"
                  aria-selected={lowerTab === item.value}
                  aria-controls={`lower-panel-${item.value}`}
                  tabIndex={lowerTab === item.value ? 0 : -1}
                  className={lowerTab === item.value ? "primary" : undefined}
                  onClick={() => setLowerTab(item.value)}
                  onKeyDown={(event) =>
                    handleLowerTabKeyDown(event, item.value)
                  }
                >
                  {item.label}
                </button>
              ))}
            </nav>

            <div
              id="lower-panel-agent"
              role="tabpanel"
              aria-labelledby="lower-tab-agent"
              hidden={lowerTab !== "agent"}
            >
              <AgentPanel
                projectId={projectId}
                sceneId={sceneId}
                shotId={shotId}
                recipes={recipes}
                onAppliedJob={handleDerivedJob}
              />
            </div>

            <div
              id="lower-panel-history"
              role="tabpanel"
              aria-labelledby="lower-tab-history"
              hidden={lowerTab !== "history"}
            >
              <ArtifactHistory
                shotId={shotId}
                unassigned={!projectId}
                refreshToken={historyToken}
                onDerivedJob={handleDerivedJob}
                projects={projects}
                onAssignmentsChanged={async () => {
                  setHistoryToken((current) => current + 1);
                }}
              />
            </div>
          </div>
        </>
      )}

      {view === "assets" && (
        <>
          <div className="full">
            <AssetBrowser
              projectId={projectId}
              scenes={scenes}
              sceneId={sceneId}
              onSelectScene={setSceneId}
              shots={shots}
              shotId={shotId}
              onSelectShot={setShotId}
              projects={projects}
              onAssignmentsChanged={async () => {
                setHistoryToken((current) => current + 1);
              }}
              onDeriveArtifact={(artifactId) => {
                setDerivationSourceArtifactId(artifactId);
                setGenerationTab("image");
                setView("generate");
              }}
            />
          </div>
          <div className="full">
            <IntegrityList sceneId={sceneId} shotId={shotId} />
          </div>
        </>
      )}

      {view === "workflows" && (
        <div className="full">
          <WorkflowRegistry sceneId={sceneId} shotId={shotId} />
        </div>
      )}
    </div>
  );
}
