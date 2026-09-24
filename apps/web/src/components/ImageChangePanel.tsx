import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "../api/client";
import type { GenerationJob, Recipe } from "../api/client";
import {
  CHANGE_OPERATIONS,
  CHANGE_TEMPLATE_RECIPE_LABELS,
  planForOperations,
} from "../derivation/changeOperations";
import type { ChangeOperation } from "../derivation/changeOperations";
import { describeApiError, templateName } from "../derivation/recipeTemplate";
import { EmptyState } from "./ui/EmptyState";
import { MediaPicker } from "./MediaPicker";
import type { PickedMedia } from "./MediaPicker";

interface Props {
  projectId: string | null;
  sceneId: string | null;
  shotId: string | null;
  /** 「Anima 参照 ポーズ・表情」「Anima 参照 衣装」のRecipeだけに絞って渡す。 */
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
}

export function ImageChangePanel({
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
}: Props) {
  const [sourceMedia, setSourceMedia] = useState<PickedMedia[]>([]);
  const [operations, setOperations] = useState<ReadonlySet<ChangeOperation>>(new Set());
  const [prompt, setPrompt] = useState("");
  // 除外したい要素は画面に出さず、元画像の生成条件から取り込んだ値をそのまま送信にだけ使う。
  const [negative, setNegative] = useState("");
  // 元画像からのプロンプト取り込みに失敗したことを画面に伝えるためのフラグ。
  const [promptRestoreFailed, setPromptRestoreFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourceArtifactIdRef = useRef(sourceArtifactId);
  sourceArtifactIdRef.current = sourceArtifactId;

  const plan = useMemo(() => planForOperations(operations), [operations]);
  const recipe = useMemo(
    () => (plan ? recipes.find((item) => templateName(item) === plan.templateName) ?? null : null),
    [recipes, plan],
  );

  // 親から共有されるsourceArtifactIdが変わったら、pickerの選択をそれに合わせる。
  // ギャラリーの「この画像を変える」から渡された場合はここだけを経由する。
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

  const handleSourceMediaChange = (next: PickedMedia[]) => {
    setSourceMedia(next);
    const item = next[0];
    onSourceArtifactChange(item && "artifact_id" in item.source ? item.source.artifact_id : null);
  };

  // 元画像を選ぶたびに、その生成条件のプロンプトを説明の初期値として取り込む。
  // 取れない (Artifactでない/Jobが無い/取得失敗) ときは空のまま始める。
  useEffect(() => {
    let active = true;
    const item = sourceMedia[0];
    const artifactId = item && "artifact_id" in item.source ? item.source.artifact_id : null;
    if (!artifactId) {
      setPrompt("");
      setNegative("");
      setPromptRestoreFailed(false);
      return;
    }
    (async () => {
      try {
        const artifact = item?.artifact ?? (await api.getArtifact(artifactId));
        if (!active) return;
        if (!artifact.job_id) {
          setPrompt("");
          setNegative("");
          setPromptRestoreFailed(false);
          return;
        }
        const job = await api.getJob(artifact.job_id);
        if (!active) return;
        const manifest = await api.getManifest(job.manifest_id);
        if (!active) return;
        setPrompt(manifest.resolved_prompt ?? "");
        const parameters = manifest.parameters as Record<string, unknown>;
        setNegative(typeof parameters.negative_prompt === "string" ? parameters.negative_prompt : "");
        setPromptRestoreFailed(false);
      } catch {
        // 取得できなくても元画像の選択自体は成立させ、説明を空欄で始める。取得に失敗したことだけ画面に伝える。
        if (active) {
          setPrompt("");
          setNegative("");
          setPromptRestoreFailed(true);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [sourceMedia]);

  const toggleOperation = (operation: ChangeOperation) => {
    setOperations((current) => {
      const next = new Set(current);
      if (next.has(operation)) next.delete(operation);
      else next.add(operation);
      return next;
    });
  };

  const execute = async () => {
    const sourceItem = sourceMedia[0];
    if (!sourceItem) {
      setError("元画像を選択してください。");
      return;
    }
    if (!plan) {
      setError("変えたい要素を選んでください。");
      return;
    }
    if (!recipe) {
      setError(
        `Recipe「${CHANGE_TEMPLATE_RECIPE_LABELS[plan.templateName]}」が見つかりません。ラボ (モードA) で登録してください。`,
      );
      return;
    }
    if (!prompt.trim()) {
      setError("生成したい絵の説明を入力してください。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const job = await api.createJob({
        kind: "image",
        project_id: projectId,
        scene_id: sceneId,
        shot_id: shotId,
        recipe_id: recipe.id,
        inputs: {
          source_image: sourceItem.source,
          positive_prompt: prompt,
          // 取り込めなかったときは送らず、Recipeの既定値を使わせる。
          ...(negative ? { negative_prompt: negative } : {}),
          reference_strength: plan.referenceStrength,
        },
      });
      onSubmittedJob(job);
    } catch (cause) {
      setError(describeApiError(cause));
    } finally {
      setBusy(false);
    }
  };

  if (recipesLoading) {
    return (
      <section className="panel">
        <h2>画像を変更</h2>
        <EmptyState title="Recipeを読み込んでいます…" />
      </section>
    );
  }
  if (recipesError) {
    return (
      <section className="panel">
        <h2>画像を変更</h2>
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
        <h2>画像を変更</h2>
        <EmptyState
          title="使えるRecipeがまだありません。"
          description="ラボ (モードA) でRecipeを登録すると、画像の変更ができます。"
          action={
            <button type="button" onClick={onManageWorkflows}>
              ラボで登録する
            </button>
          }
        />
      </section>
    );
  }
  const sourceReady = sourceMedia.length > 0;
  return (
    <section className="panel">
      <h2>画像を変更</h2>
      <div className="stack">
        <MediaPicker
          kind="image"
          label="元画像"
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
        {promptRestoreFailed && (
          <p className="muted">元画像の生成条件からプロンプトを取り込めませんでした。説明欄は空で始まります。</p>
        )}
        <span>変えたい要素</span>
        <div className="row" role="group" aria-label="変えたい要素">
          {CHANGE_OPERATIONS.map((item) => (
            <label key={item.value} className="row">
              <input
                type="checkbox"
                checked={operations.has(item.value)}
                disabled={busy}
                onChange={() => toggleOperation(item.value)}
              />
              {item.label}
            </label>
          ))}
        </div>
        <label htmlFor="change-description">生成したい絵の説明</label>
        <textarea
          id="change-description"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
        {error && <p className="error">{error}</p>}
        <button
          type="button"
          className="primary"
          disabled={busy || !sourceReady}
          onClick={() => void execute()}
        >
          {busy ? "処理中..." : "変更を投入"}
        </button>
      </div>
    </section>
  );
}
