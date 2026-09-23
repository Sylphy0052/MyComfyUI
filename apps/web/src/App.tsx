import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";

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
import { AssetBrowser } from "./components/AssetBrowser";
import { CandidateGallery } from "./components/CandidateGallery";
import type { Candidate } from "./components/CandidateGallery";
import { PresetPromotionPanel } from "./components/PresetPromotionPanel";
import { ComposePanel } from "./components/ComposePanel";
import { GenerationForm } from "./components/GenerationForm";
import { GenerationSweepPanel } from "./components/GenerationSweepPanel";
import { IntegrityList } from "./components/IntegrityList";
import { ImageChangePanel } from "./components/ImageChangePanel";
import { ImageDerivationPanel } from "./components/ImageDerivationPanel";
import { JobQueue } from "./components/JobQueue";
import { MediaLibrary } from "./components/MediaLibrary";
import { MusicPanel } from "./components/MusicPanel";
import { ProjectWorkspace } from "./components/ProjectWorkspace";
import { SceneBrowser } from "./components/SceneBrowser";
import { ResizablePane } from "./components/ui/ResizablePane";
import { ToastRegion } from "./components/ui/ToastRegion";
import type { ToastItem } from "./components/ui/ToastRegion";
import { NotifyContext } from "./components/ui/notify";
import type { Notice } from "./components/ui/notify";
import { VideoPanel } from "./components/VideoPanel";
import { VoicePanel } from "./components/VoicePanel";
import { WorkflowRegistry } from "./components/WorkflowRegistry";
import { tagCheckWarnings } from "./prompt/tagCheck";
import {
  persistUiState,
  readInitialUiState,
  uiStateFromUrl,
} from "./state/uiState";
import type {
  GenerationTab,
  ImageSubTab,
  Mode,
  UiState,
  View,
} from "./state/uiState";
import {
  applyResolvedTheme,
  persistThemePreference,
  readStoredThemePreference,
  resolveTheme,
  subscribeSystemTheme,
} from "./state/themeState";
import type { ThemePreference } from "./state/themeState";
import { useFrozenWhenInactive } from "./state/useFrozenWhenInactive";
import {
  COLLAPSED_RAIL_WIDTH,
  clampPaneWidth,
  persistPaneLayoutState,
  readPaneLayoutState,
} from "./state/layoutState";
import type { PaneId, PaneLayoutState } from "./state/layoutState";

/** WebSocketは再取得トリガーだけに使い、RESTで得られる状態を正本とする。 */
const POLL_INTERVAL_MS = 2000;
const CONNECTED_POLL_INTERVAL_MS = 15000;

const MODES: { value: Mode; label: string }[] = [
  { value: "production", label: "作品制作 (モードB)" },
  { value: "lab", label: "ラボ (モードA)" },
];

const THEME_PREFERENCES: { value: ThemePreference; label: string }[] = [
  { value: "light", label: "ライト" },
  { value: "dark", label: "ダーク" },
  { value: "system", label: "システム" },
];

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

const IMAGE_SUBTABS: { value: ImageSubTab; label: string }[] = [
  { value: "generate", label: "生成" },
  { value: "change", label: "変更" },
  { value: "derive", label: "派生" },
  { value: "sweep", label: "スイープ" },
];

/** 作品制作 (モードB) で出すサブタブ。技術寄りの派生・スイープは隠す。 */
const PRODUCTION_IMAGE_SUBTABS = new Set<ImageSubTab>(["generate", "change"]);

const JOB_KIND_LABELS: Record<string, string> = Object.fromEntries(
  GENERATION_TABS.map((tab) => [tab.value, tab.label]),
);

// 成功トーストは自動で消す。失敗は見落としを避けるため手動で閉じるまで残す。
const TOAST_SUCCESS_TTL_MS = 5000;
// 取り消しの付いた通知は、ボタンを押す余裕を持たせて成功通知より長く残す。
const TOAST_UNDO_TTL_MS = 8000;

const DECISION_NOTICES: Record<ArtifactDecision, string> = {
  accepted: "採用しました",
  rejected: "却下しました",
  undecided: "判定を戻しました",
};

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
  // index.htmlのインラインスクリプトが起動直後にdata-theme属性を書くため、
  // ここではその続きとしてlocalStorageから選好を読み、以降の変更を反映・保存する。
  const [themePreference, setThemePreference] = useState<ThemePreference>(
    readStoredThemePreference,
  );
  // ペイン幅・折りたたみはURLに載せず、端末ごとのlocalStorageだけへ保存する。
  const [paneLayout, setPaneLayout] = useState<PaneLayoutState>(
    readPaneLayoutState,
  );
  const appRef = useRef<HTMLDivElement>(null);
  const paneDragRef = useRef<{
    paneId: PaneId;
    side: "left" | "right";
    startX: number;
    startWidth: number;
  } | null>(null);
  const paneLayoutRef = useRef(paneLayout);
  paneLayoutRef.current = paneLayout;

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      const drag = paneDragRef.current;
      if (!drag) return;
      const deltaX = event.clientX - drag.startX;
      const signedDelta = drag.side === "left" ? deltaX : -deltaX;
      const nextWidth = clampPaneWidth(drag.startWidth + signedDelta);
      setPaneLayout((previous) => ({
        ...previous,
        widths: { ...previous.widths, [drag.paneId]: nextWidth },
      }));
    }
    function handlePointerUp() {
      if (!paneDragRef.current) return;
      paneDragRef.current = null;
      persistPaneLayoutState(paneLayoutRef.current);
    }
    function handlePointerCancel() {
      // ドラッグ中にポインタが失われた場合も掴んだ状態を残さない。
      paneDragRef.current = null;
    }
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
    };
  }, []);

  const startPaneResize = useCallback(
    (paneId: PaneId, side: "left" | "right") =>
      (event: ReactPointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        paneDragRef.current = {
          paneId,
          side,
          startX: event.clientX,
          startWidth: paneLayoutRef.current.widths[paneId],
        };
      },
    [],
  );

  /** 矢印キーでの幅変更。ドラッグと同じ最小/最大幅にclampする。 */
  const handlePaneResizeKeyDown = useCallback(
    (paneId: PaneId) => (event: KeyboardEvent<HTMLDivElement>) => {
      const stepMap: Record<string, number> = {
        ArrowLeft: -10,
        ArrowRight: 10,
        ArrowUp: -10,
        ArrowDown: 10,
      };
      const step = stepMap[event.key];
      if (step === undefined) return;
      event.preventDefault();
      setPaneLayout((previous) => {
        const nextWidth = clampPaneWidth(previous.widths[paneId] + step);
        const next: PaneLayoutState = {
          ...previous,
          widths: { ...previous.widths, [paneId]: nextWidth },
        };
        persistPaneLayoutState(next);
        return next;
      });
    },
    [],
  );

  const togglePaneCollapsed = useCallback((paneId: PaneId) => {
    setPaneLayout((previous) => {
      const next: PaneLayoutState = {
        ...previous,
        collapsed: { ...previous.collapsed, [paneId]: !previous.collapsed[paneId] },
      };
      persistPaneLayoutState(next);
      return next;
    });
  }, []);

  const appStyle = {
    "--pane-scene-browser-width": paneLayout.collapsed.sceneBrowser
      ? `${COLLAPSED_RAIL_WIDTH}px`
      : `${paneLayout.widths.sceneBrowser}px`,
    "--pane-job-queue-width": paneLayout.collapsed.jobQueue
      ? `${COLLAPSED_RAIL_WIDTH}px`
      : `${paneLayout.widths.jobQueue}px`,
  } as CSSProperties;
  // URLとlocalStorageから復元した値で開く。以降の変更は永続化のeffectで書き戻す。
  const [initialUiState] = useState(readInitialUiState);
  const [mode, setMode] = useState<Mode>(initialUiState.mode);
  const [view, setView] = useState<View>(initialUiState.view);
  const [visitedViews, setVisitedViews] = useState<ReadonlySet<View>>(
    () =>
      new Set([
        initialUiState.mode === "production" ? "generate" : initialUiState.view,
      ]),
  );
  const [generationTab, setGenerationTab] = useState<GenerationTab>(
    initialUiState.generationTab,
  );
  const [imageSubTab, setImageSubTab] = useState<ImageSubTab>(
    initialUiState.imageSubTab,
  );

  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [projectId, setProjectId] = useState<string | null>(
    initialUiState.projectId,
  );
  const [scenes, setScenes] = useState<SceneSummary[]>([]);
  const [sceneId, setSceneId] = useState<string | null>(initialUiState.sceneId);
  const [scene, setScene] = useState<SceneEnvelope | null>(null);
  const [shots, setShots] = useState<ShotSummary[]>([]);
  const [shotId, setShotId] = useState<string | null>(initialUiState.shotId);
  const [shot, setShot] = useState<ShotEnvelope | null>(null);

  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [recipesLoading, setRecipesLoading] = useState(true);
  const [recipesError, setRecipesError] = useState<string | null>(null);
  const [recipesRetryToken, setRecipesRetryToken] = useState(0);
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
  const [structureToken, setStructureToken] = useState(0);
  const [eventsConnected, setEventsConnected] = useState(false);
  const jobsRequestSequence = useRef(0);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // 全画面A/B比較の<dialog>がtop layerで開いている間、通常DOMのToastRegionは
  // z-indexに関わらず隠れる (#186)。開いているdialog要素をここへ受け取り、
  // その中へToastRegionをportalして表示先を切り替える。
  const [comparisonDialogEl, setComparisonDialogEl] = useState<HTMLDialogElement | null>(null);
  // ジョブ一覧を初めて取得した時点と、スコープ切替直後はnullに戻し、
  // 既存ジョブや無関係スコープのジョブを完了通知として出さないようにする。
  const previousJobStatesRef = useRef<Map<string, string> | null>(null);
  const toastTimersRef = useRef<Set<number>>(new Set());
  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);
  const toastSequenceRef = useRef(0);
  // 操作の結果を知らせる。取り消しに失敗したら、失敗の通知を閉じるまで残す。
  const notify = useCallback(
    (notice: Notice) => {
      const id = `notice:${++toastSequenceRef.current}`;
      // 閉じる前の連打で同じ取り消しが二重に走らないよう、1回だけ通す。
      let isActionUsed = false;
      const action = notice.action && {
        label: notice.action.label,
        onAction: () => {
          if (isActionUsed) return;
          isActionUsed = true;
          notice.action!.onAction().catch((cause: unknown) => {
            notify({ tone: "danger", message: `取り消せませんでした: ${describe(cause)}` });
          });
        },
      };
      setToasts((current) => [
        ...current.filter(
          (toast) => !notice.group || toast.group !== notice.group,
        ),
        { id, tone: notice.tone, message: notice.message, group: notice.group, action },
      ]);
      if (notice.tone === "danger") return;
      const timerId = window.setTimeout(
        () => {
          toastTimersRef.current.delete(timerId);
          dismissToast(id);
        },
        action ? TOAST_UNDO_TTL_MS : TOAST_SUCCESS_TTL_MS,
      );
      toastTimersRef.current.add(timerId);
    },
    [dismissToast],
  );
  useEffect(() => {
    const timers = toastTimersRef.current;
    return () => {
      for (const timerId of timers) window.clearTimeout(timerId);
    };
  }, []);
  // 選好を選ぶたびに保存し、data-theme属性へ反映する。systemのときはOS設定の変更も
  // 都度追随させる (ページ再読み込みなしでライト⇔ダークが切り替わる環境向け)。
  useEffect(() => {
    persistThemePreference(themePreference);
    applyResolvedTheme(resolveTheme(themePreference));
    if (themePreference !== "system") return;
    return subscribeSystemTheme(() => applyResolvedTheme(resolveTheme("system")));
  }, [themePreference]);
  const [derivationSourceArtifactId, setDerivationSourceArtifactId] =
    useState<string | null>(null);
  const [promotionArtifactId, setPromotionArtifactId] = useState<string | null>(null);
  const [comparisonJobIds, setComparisonJobIds] = useState<string[] | null>(null);
  const [comparisonArtifactsByJob, setComparisonArtifactsByJob] = useState<
    Record<string, Artifact[]>
  >({});
  const [comparisonExperimentId, setComparisonExperimentId] = useState<string | null>(null);
  const comparisonRequestSequence = useRef(0);

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
        "anima_ref_siglip",
        "anima_ref_incontext",
      ]);
      return recipes.filter((recipe) => allowed.has(recipeTemplateName(recipe)));
    },
    [recipes],
  );
  const changeRecipes = useMemo(() => {
    const allowed = new Set(["anima_ref_siglip", "anima_ref_incontext"]);
    return recipes.filter((recipe) => allowed.has(recipeTemplateName(recipe)));
  }, [recipes]);

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

  // 作品制作では画像生成の画面だけを出す。ラボのView・タブは書き換えず、
  // ラボへ戻ったときに元の位置を残すため、表示用の値だけをここで差し替える。
  const isProduction = mode === "production";
  const shownView: View = isProduction ? "generate" : view;
  const shownGenerationTab: GenerationTab = isProduction ? "image" : generationTab;
  const shownImageSubTab: ImageSubTab =
    isProduction && !PRODUCTION_IMAGE_SUBTABS.has(imageSubTab) ? "generate" : imageSubTab;

  // 作品制作の「次へ」。未選択なら先頭、最後のShotなら次は無い。
  const nextShotId = useMemo(() => {
    const index = shots.findIndex((item) => item.id === shotId);
    return shots[index + 1]?.id ?? null;
  }, [shots, shotId]);

  /** モードBの条件 (Project・Scene・Shot・Presetと入力) を保ったまま、ラボの生成画面へ移る。 */
  const enterLab = useCallback(() => {
    setMode("lab");
    setView("generate");
    setGenerationTab("image");
    setImageSubTab("generate");
  }, []);

  const switchMode = useCallback(
    (next: Mode) => {
      if (next === mode) return;
      if (next === "lab") enterLab();
      else setMode("production");
    },
    [mode, enterLab],
  );

  const useProject = useCallback((nextProjectId: string | null) => {
    setProjectId(nextProjectId);
    if (nextProjectId) setView("generate");
  }, []);

  // 一度開いたViewはマウントしたまま hidden で隠し、戻ったときに入力を残す。
  // 未訪問のViewまで最初から立ち上げると、開いてもいない画面の取得が走るため、
  // 訪問済みのものだけをマウント対象にする。
  useEffect(() => {
    setVisitedViews((current) => {
      if (current.has(shownView)) return current;
      const next = new Set(current);
      next.add(shownView);
      return next;
    });
  }, [shownView]);

  const lastViewRef = useRef<View>(initialUiState.view);
  const lastModeRef = useRef<Mode>(initialUiState.mode);

  useEffect(() => {
    const next: UiState = {
      mode,
      view,
      generationTab,
      imageSubTab,
      projectId,
      sceneId,
      shotId,
    };
    // モードの切替もViewの切替と同じく履歴へ積み、戻る操作で元のモードへ帰れるようにする。
    const viewChanged =
      lastViewRef.current !== view || lastModeRef.current !== mode;
    lastViewRef.current = view;
    lastModeRef.current = mode;
    persistUiState(next, viewChanged ? "push" : "replace");
  }, [mode, view, generationTab, imageSubTab, projectId, sceneId, shotId]);

  useEffect(() => {
    const restore = () => {
      const restored = uiStateFromUrl(window.location.search);
      // 復元先のViewを現在地として扱い、戻った先をもう一度履歴へ積まない。
      lastViewRef.current = restored.view;
      lastModeRef.current = restored.mode;
      setMode(restored.mode);
      setView(restored.view);
      setGenerationTab(restored.generationTab);
      setImageSubTab(restored.imageSubTab);
      setProjectId(restored.projectId);
      setSceneId(restored.sceneId);
      setShotId(restored.shotId);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  // 隠れているViewには直前の選択を渡し続ける。Scene/Shotを切り替えるたびに
  // 見えていないViewまで一覧を取り直すのを避ける。
  const projectsActive = shownView === "projects";
  const projectsSelectedId = useFrozenWhenInactive(projectId, projectsActive);

  const assetsActive = shownView === "assets";
  const assetsProjects = useFrozenWhenInactive(projects, assetsActive);
  const assetsProjectId = useFrozenWhenInactive(projectId, assetsActive);
  const assetsScenes = useFrozenWhenInactive(scenes, assetsActive);
  const assetsSceneId = useFrozenWhenInactive(sceneId, assetsActive);
  const assetsShots = useFrozenWhenInactive(shots, assetsActive);
  const assetsShotId = useFrozenWhenInactive(shotId, assetsActive);

  const workflowsActive = shownView === "workflows";
  const workflowsSceneId = useFrozenWhenInactive(sceneId, workflowsActive);
  const workflowsShotId = useFrozenWhenInactive(shotId, workflowsActive);

  // 初回取得の往復中に選択が変わることがある。書き戻す前に現在値を見る。
  const projectIdRef = useRef(projectId);
  useEffect(() => {
    projectIdRef.current = projectId;
  }, [projectId]);

  useEffect(() => {
    let active = true;
    setRecipesLoading(true);
    (async () => {
      try {
        const [projectList, recipeList] = await Promise.all([
          api.listProjects(),
          api.listRecipes("image"),
        ]);
        if (!active) return;
        setProjects(projectList.items);
        setRecipes(recipeList);
        setRecipesError(null);
        // 復元したProjectが削除されていることがある。無効なIDを抱えたままだと
        // Scene取得が毎回失敗し、その状態をURLとlocalStorageへ書き戻し続ける。
        const restoredProjectId = initialUiState.projectId;
        if (
          restoredProjectId &&
          projectIdRef.current === restoredProjectId &&
          !projectList.items.some((item) => item.id === restoredProjectId)
        ) {
          setProjectId(null);
          setError(
            "前回選んでいたProjectが見つかりません。Projectを選び直してください。",
          );
        }
      } catch (cause) {
        if (active) {
          setError(describe(cause));
          setRecipesError(describe(cause));
        }
      } finally {
        if (active) setRecipesLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [recipesRetryToken]);

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
    const sequence = ++jobsRequestSequence.current;
    const list = await api.listJobs(jobScope);
    if (sequence !== jobsRequestSequence.current) return;
    setJobs(list);

    const previous = previousJobStatesRef.current;
    if (previous) {
      const newToasts: ToastItem[] = [];
      for (const job of list) {
        const previousState = previous.get(job.id);
        if (
          previousState &&
          previousState !== job.state &&
          (job.state === "succeeded" || job.state === "failed")
        ) {
          const kindLabel = JOB_KIND_LABELS[job.kind] ?? job.kind;
          const succeeded = job.state === "succeeded";
          newToasts.push({
            id: `${job.id}:${job.state}`,
            tone: succeeded ? "success" : "danger",
            message: succeeded
              ? `${kindLabel}の生成が完了しました`
              : `${kindLabel}の生成に失敗しました${job.failure_message ? `: ${job.failure_message}` : ""}`,
            jobId: job.id,
          });
        }
      }
      if (newToasts.length > 0) {
        setToasts((current) => [...current, ...newToasts]);
        for (const toast of newToasts) {
          if (toast.tone === "success") {
            const timerId = window.setTimeout(() => {
              toastTimersRef.current.delete(timerId);
              dismissToast(toast.id);
            }, TOAST_SUCCESS_TTL_MS);
            toastTimersRef.current.add(timerId);
          }
        }
      }
    }
    previousJobStatesRef.current = new Map(
      list.map((job) => [job.id, job.state]),
    );
  }, [jobScope, dismissToast]);

  useEffect(() => {
    previousJobStatesRef.current = null;
  }, [jobScope]);

  const navigateToJob = useCallback(
    (jobId: string) => {
      const job = jobs.find((item) => item.id === jobId);
      // 一覧に無いJobへ移ると、ラボへ切り替わるだけで何も選ばれない画面になる。
      if (!job) {
        setError(`Job ${jobId} が現在のJob一覧に見つかりません。`);
        return;
      }
      setError(null);
      setGenerationTab(job.kind as GenerationTab);
      // Job一覧はラボにだけあるため、作品制作から開いたときもラボへ移る。
      setMode("lab");
      setView("generate");
      setSelectedJobId(jobId);
    },
    [jobs],
  );

  const refreshJobsRef = useRef(refreshJobs);
  useEffect(() => { refreshJobsRef.current = refreshJobs; }, [refreshJobs]);

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let refreshTimer: number | null = null;
    let stableTimer: number | null = null;
    let retryDelay = 500;

    const scheduleRefresh = () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void refreshJobsRef.current().catch((cause) => setError(describe(cause)));
      }, 100);
    };
    const retryLater = () => {
      const jittered = retryDelay * (0.75 + Math.random() * 0.5);
      reconnectTimer = window.setTimeout(connect, jittered);
      retryDelay = Math.min(retryDelay * 2, 10000);
    };
    const connect = () => {
      if (stopped) return;
      const url = new URL("/api/v1/events", window.location.href);
      url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      try {
        socket = new WebSocket(url);
      } catch {
        // 生成時点で弾かれると以降のイベントが来ない。ここで次を予約しないと
        // 再接続が止まり、通知経路が復帰しなくなる。
        retryLater();
        return;
      }
      socket.onopen = () => {
        setEventsConnected(true);
        scheduleRefresh();
        // 5秒つながり続けたら再接続間隔を初期値へ戻す。すぐ切れる接続では
        // 戻さず、バックオフを伸ばしたまま次の再接続へ入る。
        stableTimer = window.setTimeout(() => { retryDelay = 500; }, 5000);
      };
      socket.onmessage = (event) => {
        try {
          const message: unknown = JSON.parse(String(event.data));
          if (
            message && typeof message === "object" &&
            (message as Record<string, unknown>).event_type ===
              "generation_job.state_changed"
          ) {
            scheduleRefresh();
          }
        } catch {
          // 通知は再取得トリガーだけなので、壊れた1件は無視して定期同期へ任せる。
        }
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        setEventsConnected(false);
        if (stableTimer !== null) {
          window.clearTimeout(stableTimer);
          stableTimer = null;
        }
        if (stopped) return;
        retryLater();
      };
    };
    connect();
    return () => {
      stopped = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      if (stableTimer !== null) window.clearTimeout(stableTimer);
      socket?.close();
    };
  }, []);

  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        await refreshJobs();
      } catch (cause) {
        if (active) setError(describe(cause));
      }
    };
    void tick();
    const timer = window.setInterval(
      tick,
      eventsConnected ? CONNECTED_POLL_INTERVAL_MS : POLL_INTERVAL_MS,
    );
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [eventsConnected, refreshJobs]);

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
  const visibleCandidates = useMemo(
    () => {
      if (!comparisonJobIds) return candidates;
      return comparisonJobIds.flatMap((jobId) =>
        (comparisonArtifactsByJob[jobId] ?? [])
          .filter((artifact) => artifact.kind === "image")
          .map((artifact) => ({ artifact, jobId })),
      );
    },
    [candidates, comparisonArtifactsByJob, comparisonJobIds],
  );
  const promotionCandidate = useMemo(
    () => visibleCandidates.find((item) => item.artifact.id === promotionArtifactId) ?? null,
    [visibleCandidates, promotionArtifactId],
  );

  useEffect(() => {
    comparisonRequestSequence.current += 1;
    setComparisonJobIds(null);
    setComparisonArtifactsByJob({});
    setComparisonExperimentId(null);
  }, [projectId]);

  const compareExperiment = useCallback(async (experimentId: string, jobIds: string[]) => {
    const sequence = ++comparisonRequestSequence.current;
    setError(null);
    try {
      const entries = await Promise.all(
        jobIds.map(async (jobId) => [jobId, await api.listJobArtifacts(jobId)] as const),
      );
      if (sequence !== comparisonRequestSequence.current) return;
      setComparisonArtifactsByJob(Object.fromEntries(entries));
      setComparisonJobIds(jobIds);
      setComparisonExperimentId(experimentId);
    } catch (cause) {
      setError(describe(cause));
    }
  }, []);

  const submit = async (
    recipe: Recipe | null,
    inputs: Record<string, unknown>,
    useInheritedDefaults: boolean,
    batchCount: number,
    lookProfileIds: string[],
  ) => {
    setSubmitting(true);
    setError(null);
    const payload = {
      kind: "image",
      project_id: projectId,
      scene_id: sceneId,
      shot_id: shotId,
      recipe_id: recipe?.id,
      use_inherited_defaults: useInheritedDefaults,
      look_profile_ids: lookProfileIds,
      inputs,
    };
    if (!(await confirmPromptTags(payload))) {
      setSubmitting(false);
      return;
    }
    const createdJobs: GenerationJob[] = [];
    try {
      for (let index = 0; index < batchCount; index += 1) {
        const job = await api.createJob(payload);
        createdJobs.push(job);
      }
      const lastJob = createdJobs.at(-1);
      if (lastJob) setSelectedJobId(lastJob.id);
      await refreshJobs();
    } catch (cause) {
      if (createdJobs.length > 0) {
        setSelectedJobId(createdJobs.at(-1)?.id ?? null);
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

  /**
   * 投入の前にプロンプトのタグを確かめる。実在しないタグや干渉する組み合わせが
   * あれば確認を求め、取り消されたら結果を確認欄に残して偽を返す。
   *
   * タグの確認は助言なので、プレビュー自体が失敗したときは投入を止めない。解決
   * できない入力なら、続く投入が同じ理由で失敗して利用者へ伝わる。
   */
  const confirmPromptTags = async (
    payload: Parameters<typeof api.previewJob>[0],
  ): Promise<boolean> => {
    let result: GenerationPreview;
    try {
      result = await api.previewJob(payload);
    } catch {
      return true;
    }
    const warnings = tagCheckWarnings(result.tag_check);
    if (warnings.length === 0) {
      return true;
    }
    const proceed = window.confirm(
      `プロンプトのタグに確認が必要な点があります。\n\n${warnings
        .map((warning) => `- ${warning}`)
        .join("\n")}\n\nこのまま投入しますか？`,
    );
    if (!proceed) {
      setPreviewResult(result);
      setPreviewError(null);
    }
    return proceed;
  };

  /** 投入せずに解決済み入力とWorkflow差分だけを取る。Jobは作られない。 */
  const preview = async (
    recipe: Recipe | null,
    inputs: Record<string, unknown>,
    useInheritedDefaults: boolean,
    lookProfileIds: string[],
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
        look_profile_ids: lookProfileIds,
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
    if (!window.confirm("ジョブをキャンセルします。キャンセルは取り消せません。続けますか？")) {
      return;
    }
    setError(null);
    try {
      await api.cancelJob(jobId);
      await refreshJobs();
    } catch (cause) {
      setError(describe(cause));
    }
  };

  const applyDecision = async (artifactId: string, decision: ArtifactDecision) => {
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
  };

  const decide = async (artifactId: string, decision: ArtifactDecision) => {
    const previous = Object.values(artifactsByJob)
      .flat()
      .find((artifact) => artifact.id === artifactId)?.decision;
    setBusyArtifactId(artifactId);
    setError(null);
    try {
      await applyDecision(artifactId, decision);
      if (previous && previous !== decision) {
        notify({
          tone: "success",
          message: DECISION_NOTICES[decision],
          group: "decision",
          action: {
            label: "取り消す",
            onAction: () => applyDecision(artifactId, previous),
          },
        });
      }
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusyArtifactId(null);
    }
  };

  // 再実行で作った派生 Job も、投入直後と同じようにキューへ反映する。
  const handleDerivedJob = (job: GenerationJob) => {
    setSelectedJobId(job.id);
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

  const handleImageSubTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentTab: ImageSubTab,
  ) => {
    const nextTab = nextTabForKey(event.key, IMAGE_SUBTABS, currentTab);
    if (!nextTab) return;

    event.preventDefault();
    setImageSubTab(nextTab);
    document.getElementById(`image-subtab-${nextTab}`)?.focus();
  };

  return (
    <NotifyContext.Provider value={notify}>
    <div className="app" ref={appRef} style={appStyle}>
      <header>
        <h1>MyComfyUI</h1>
        <span className="muted">
          Projectの有無を選び、画像・音声・動画・音楽・合成の生成を投入する。
        </span>
        <span
          className={`badge ${eventsConnected ? "events-connected" : "events-offline"}`}
        >
          進捗通知:{eventsConnected ? "WebSocket" : "REST同期"}
        </span>
        <nav className="row mode-switch" aria-label="モード">
          {MODES.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={mode === item.value}
              className={mode === item.value ? "primary" : undefined}
              onClick={() => switchMode(item.value)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <nav className="row theme-switch" aria-label="テーマ">
          {THEME_PREFERENCES.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={themePreference === item.value}
              className={themePreference === item.value ? "primary" : undefined}
              onClick={() => setThemePreference(item.value)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        {!isProduction && (
          <nav className="row" aria-label="ラボの画面">
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
        )}
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

      {visitedViews.has("projects") && (
        <ProjectWorkspace
          hidden={!projectsActive}
          selectedProjectId={projectsSelectedId}
          onSelectProject={useProject}
          onRestoreSelection={setProjectId}
          onActiveProjectsChanged={setProjects}
        />
      )}

      {visitedViews.has("generate") && (
        <>
          <div hidden={shownView !== "generate"}>
            <ResizablePane
              side="left"
              label="シーン一覧"
              collapsed={paneLayout.collapsed.sceneBrowser}
              onToggleCollapse={() => togglePaneCollapsed("sceneBrowser")}
              onResizeStart={startPaneResize("sceneBrowser", "left")}
              onResizeKeyDown={handlePaneResizeKeyDown("sceneBrowser")}
            >
              <SceneBrowser
                simple={isProduction}
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
              {isProduction && (
                <button
                  type="button"
                  disabled={!nextShotId}
                  onClick={() => nextShotId && setShotId(nextShotId)}
                >
                  次のShotへ
                </button>
              )}
            </ResizablePane>
          </div>

          <div className="generation-workspace" hidden={shownView !== "generate"}>
            <nav
              className="generation-tabs"
              hidden={isProduction}
              role="tablist"
              aria-label="生成種別"
            >
              {GENERATION_TABS.map((item) => (
                <button
                  key={item.value}
                  id={`generation-tab-${item.value}`}
                  type="button"
                  role="tab"
                  aria-selected={shownGenerationTab === item.value}
                  aria-controls={`generation-panel-${item.value}`}
                  tabIndex={shownGenerationTab === item.value ? 0 : -1}
                  className={
                    shownGenerationTab === item.value ? "primary" : undefined
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
              hidden={shownGenerationTab !== "image"}
              className="image-workspace"
            >
              <div className="image-input-column">
                <nav
                  className="image-subtabs"
                  role="tablist"
                  aria-label="画像の入力種別"
                >
                  {(isProduction
                    ? IMAGE_SUBTABS.filter((item) => PRODUCTION_IMAGE_SUBTABS.has(item.value))
                    : IMAGE_SUBTABS
                  ).map((item) => (
                    <button
                      key={item.value}
                      id={`image-subtab-${item.value}`}
                      type="button"
                      role="tab"
                      aria-selected={shownImageSubTab === item.value}
                      aria-controls={`image-subpanel-${item.value}`}
                      tabIndex={shownImageSubTab === item.value ? 0 : -1}
                      className={shownImageSubTab === item.value ? "primary" : undefined}
                      onClick={() => setImageSubTab(item.value)}
                      onKeyDown={(event) =>
                        handleImageSubTabKeyDown(event, item.value)
                      }
                    >
                      {item.label}
                    </button>
                  ))}
                </nav>

                <div
                  id="image-subpanel-generate"
                  role="tabpanel"
                  aria-labelledby="image-subtab-generate"
                  hidden={shownImageSubTab !== "generate"}
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
                    simple={isProduction}
                  />
                </div>

                <div
                  id="image-subpanel-change"
                  role="tabpanel"
                  aria-labelledby="image-subtab-change"
                  hidden={shownImageSubTab !== "change"}
                >
                  <ImageChangePanel
                    projectId={projectId}
                    sceneId={sceneId}
                    shotId={shotId}
                    recipes={changeRecipes}
                    recipesLoading={recipesLoading}
                    recipesError={recipesError}
                    onRetryRecipes={() => setRecipesRetryToken((token) => token + 1)}
                    sourceArtifactId={derivationSourceArtifactId}
                    onSourceArtifactChange={setDerivationSourceArtifactId}
                    onSubmittedJob={handleDerivedJob}
                    onManageWorkflows={() => {
                      // Workflow管理はラボにだけあるため、作品制作から開いたときもラボへ移る。
                      setMode("lab");
                      setView("workflows");
                    }}
                  />
                </div>

                <div
                  id="image-subpanel-derive"
                  role="tabpanel"
                  aria-labelledby="image-subtab-derive"
                  hidden={shownImageSubTab !== "derive"}
                >
                  <ImageDerivationPanel
                    projectId={projectId}
                    sceneId={sceneId}
                    shotId={shotId}
                    recipes={derivationRecipes}
                    recipesLoading={recipesLoading}
                    recipesError={recipesError}
                    onRetryRecipes={() => setRecipesRetryToken((token) => token + 1)}
                    sourceArtifactId={derivationSourceArtifactId}
                    onSourceArtifactChange={setDerivationSourceArtifactId}
                    onSubmittedJob={handleDerivedJob}
                    onManageWorkflows={() => setView("workflows")}
                  />
                </div>

                <div
                  id="image-subpanel-sweep"
                  role="tabpanel"
                  aria-labelledby="image-subtab-sweep"
                  hidden={shownImageSubTab !== "sweep"}
                >
                  <GenerationSweepPanel
                    active={
                      shownView === "generate" &&
                      shownGenerationTab === "image" &&
                      shownImageSubTab === "sweep"
                    }
                    projectId={projectId}
                    sceneId={sceneId}
                    shotId={shotId}
                    recipes={txt2imgRecipes}
                    onJobsChanged={() => { void refreshJobs().catch((cause) => setError(describe(cause))); }}
                    activeComparisonId={comparisonExperimentId}
                    onCompare={compareExperiment}
                  />
                </div>
              </div>

              <div className="image-result-column">
                {promotionCandidate && !isProduction && (
                  <PresetPromotionPanel
                    key={promotionCandidate.artifact.id}
                    candidate={promotionCandidate}
                    onClose={() => setPromotionArtifactId(null)}
                  />
                )}
                <CandidateGallery
                  candidates={visibleCandidates}
                  busyArtifactId={busyArtifactId}
                  onDecide={decide}
                  onDerive={(artifactId) => {
                    setDerivationSourceArtifactId(artifactId);
                    setImageSubTab("derive");
                  }}
                  onChangeSource={(artifactId) => {
                    setDerivationSourceArtifactId(artifactId);
                    setImageSubTab("change");
                  }}
                  onPromoteToPreset={setPromotionArtifactId}
                  active={shownView === "generate" && shownGenerationTab === "image"}
                  simple={isProduction}
                  comparisonActive={comparisonJobIds !== null}
                  onDialogOpenChange={setComparisonDialogEl}
                  onClearComparison={() => {
                    comparisonRequestSequence.current += 1;
                    setComparisonJobIds(null);
                    setComparisonArtifactsByJob({});
                    setComparisonExperimentId(null);
                  }}
                />
              </div>
            </div>

            <div
              id="generation-panel-video"
              role="tabpanel"
              aria-labelledby="generation-tab-video"
              hidden={shownGenerationTab !== "video"}
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
              hidden={shownGenerationTab !== "music"}
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
              hidden={shownGenerationTab !== "voice"}
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
              hidden={shownGenerationTab !== "compose"}
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

          <div hidden={shownView !== "generate" || isProduction}>
            <ResizablePane
              side="right"
              label="ジョブ一覧"
              collapsed={paneLayout.collapsed.jobQueue}
              onToggleCollapse={() => togglePaneCollapsed("jobQueue")}
              onResizeStart={startPaneResize("jobQueue", "right")}
              onResizeKeyDown={handlePaneResizeKeyDown("jobQueue")}
            >
              <JobQueue
                jobs={jobs}
                selectedJobId={selectedJobId}
                manifest={manifest}
                onSelect={setSelectedJobId}
                onCancel={cancel}
                projects={projects}
                unassigned={!projectId}
                onAssignmentChanged={refreshJobs}
              />
            </ResizablePane>
          </div>

          <div className="full" hidden={shownView !== "generate" || isProduction}>
            <AgentPanel
              projectId={projectId}
              sceneId={sceneId}
              shotId={shotId}
              recipes={recipes}
              onAppliedJob={handleDerivedJob}
            />
          </div>
        </>
      )}

      {visitedViews.has("assets") && (
        <>
          <div className="full" hidden={shownView !== "assets"}>
            <AssetBrowser
              projectId={assetsProjectId}
              scenes={assetsScenes}
              sceneId={assetsSceneId}
              onSelectScene={setSceneId}
              shots={assetsShots}
              shotId={assetsShotId}
              onSelectShot={setShotId}
              projects={assetsProjects}
              onDeriveArtifact={(artifactId) => {
                setDerivationSourceArtifactId(artifactId);
                setGenerationTab("image");
                setImageSubTab("derive");
                setView("generate");
              }}
              onRerunJob={handleDerivedJob}
            />
          </div>
          <div className="full" hidden={shownView !== "assets"}>
            <IntegrityList sceneId={assetsSceneId} shotId={assetsShotId} />
          </div>
          <div className="full" hidden={shownView !== "assets"}>
            <MediaLibrary
              projectId={assetsProjectId}
              sceneId={assetsSceneId}
              shotId={assetsShotId}
            />
          </div>
        </>
      )}

      {visitedViews.has("workflows") && (
        <div className="full" hidden={shownView !== "workflows"}>
          <WorkflowRegistry
            sceneId={workflowsSceneId}
            shotId={workflowsShotId}
          />
        </div>
      )}

      {comparisonDialogEl
        ? createPortal(
            <ToastRegion
              toasts={toasts}
              onDismiss={dismissToast}
              onNavigate={navigateToJob}
            />,
            comparisonDialogEl,
          )
        : (
          <ToastRegion
            toasts={toasts}
            onDismiss={dismissToast}
            onNavigate={navigateToJob}
          />
        )}
    </div>
    </NotifyContext.Provider>
  );
}
