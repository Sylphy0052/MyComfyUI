import { Alert, Button, Grid, Group, Select, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import type { Recipe } from "../api/client";
import { FROM_ARTIFACT_PARAM, restoreFromArtifactParam } from "../imageGen/artifactRestore";
import { BgmParamsFields, BgmPromptFields } from "../bgm/BgmFields";
import { BgmResultPanel } from "../bgm/BgmResultPanel";
import {
  bgmJobBody,
  buildBgmInputs,
  defaultBgmForm,
  defaultSeconds,
  DEFAULT_SECONDS,
  SECONDS_MAX,
  type BgmForm,
  type BgmTarget,
} from "../bgm/bgmForm";
import {
  BGM_STORAGE_KEYS,
  restoreBgmFromJob,
  useAdoptedVideoSeconds,
  useBgmResultEntries,
  useStoredBgmInput,
  useSubmitBgmJobs,
  type BgmStorageKeys,
} from "../bgm/useBgm";
import { WithBgmRecipe } from "../bgm/WithBgmRecipe";
import { notifyError } from "../notifications";
import { useScenes } from "../projectDetail/useStory";
import { useProjectList } from "../projects/useProjects";

/** URLのクエリ名。 */
const PROJECT_PARAM = "project";
const SCENE_PARAM = "scene";

function targetFromParams(params: URLSearchParams): BgmTarget {
  return { projectId: params.get(PROJECT_PARAM) || null, sceneId: params.get(SCENE_PARAM) || null };
}

function paramsFromTarget(target: BgmTarget): URLSearchParams {
  const params = new URLSearchParams();
  if (target.projectId) params.set(PROJECT_PARAM, target.projectId);
  if (target.sceneId) params.set(SCENE_PARAM, target.sceneId);
  return params;
}

function hasAny(target: BgmTarget | null): boolean {
  return target !== null && (target.projectId !== null || target.sceneId !== null);
}

/**
 * 開いたURLに対象が無ければ、最後に使った対象へ戻す。ナビはProjectだけを引き継ぐため、
 * Projectだけが前回と同じなら、Sceneも前回の値へ戻す。
 */
function initialTarget(fromUrl: BgmTarget, stored: BgmTarget | null): BgmTarget | null {
  if (stored === null || !hasAny(stored)) return null;
  if (!hasAny(fromUrl)) return stored;
  return fromUrl.sceneId === null && fromUrl.projectId === stored.projectId ? stored : null;
}

/**
 * 一覧に無いID (ゴミ箱のProjectなど) も選択中の値として出せるよう、候補へ足す。
 * 一覧の取得に失敗したときは「見つかりません」とは言えないため、IDだけを出す。
 */
function withCurrent(options: { value: string; label: string }[], current: string | null, loadFailed: boolean) {
  if (current === null || options.some((option) => option.value === current)) return options;
  return [...options, { value: current, label: loadFailed ? current : `(見つかりません) ${current}` }];
}

/** 長さの既定値の出どころを、長さ欄の下に添える。 */
function secondsNote(
  target: BgmTarget,
  video: { isLoading: boolean; error: Error | null; data: number | null | undefined },
): string {
  if (target.sceneId === null) return `既定は${DEFAULT_SECONDS}秒`;
  if (video.isLoading) return "採用済みの動画を確認中";
  if (video.error) return `採用済みの動画の長さを読めないため、既定は${DEFAULT_SECONDS}秒`;
  if (video.data == null) return `採用済みの動画が無いため、既定は${DEFAULT_SECONDS}秒`;
  if (video.data > SECONDS_MAX) return `採用済みの動画の長さ (${video.data}秒) が上限を超えるため、既定は${SECONDS_MAX}秒`;
  return `Sceneの採用済み動画の長さ (${video.data}秒) が既定`;
}

export type BgmWorkspaceProps = {
  recipe: Recipe;
  target: BgmTarget;
  /** 対象を変えられる画面 (`/bgm`) だけが渡す。省略すると対象を固定し、選択欄は変えられず、前回の対象も戻さない。 */
  onTargetChange?: (next: BgmTarget) => void;
  /** 入力欄と結果欄の保存キー。 */
  storageKeys: BgmStorageKeys;
  /** `?from_artifact=`の生成物ID。あれば、開いたときにその生成設定を入力欄へ戻す。 */
  fromArtifact?: string | null;
};

/** BGMの入力欄と結果欄。`/bgm`とシーン生成のBGMの工程が使う。 */
export function BgmWorkspace({ recipe, target, onTargetChange, storageKeys, fromArtifact = null }: BgmWorkspaceProps) {
  const [stored, setStored] = useStoredBgmInput(recipe, storageKeys.input);
  const client = useQueryClient();
  const results = useBgmResultEntries(storageKeys.results);
  const submit = useSubmitBgmJobs();

  const targetKey = paramsFromTarget(target).toString();
  const form = stored.form ?? defaultBgmForm(recipe);

  const projects = useProjectList("active");
  const scenes = useScenes(target.projectId);
  const sceneList = scenes.data ?? [];
  const scene = sceneList.find((item) => item.id === target.sceneId) ?? null;
  const video = useAdoptedVideoSeconds(target.projectId, target.sceneId);

  const storyLoading = target.projectId !== null && (projects.isPending || scenes.isPending);
  // ゴミ箱・削除済みのProjectは有効な一覧に無い。投入を止める。
  const projectMissing =
    target.projectId !== null &&
    projects.data !== undefined &&
    !projects.data.some((item) => item.id === target.projectId);
  // 一覧を取得できなかったときは、あるかどうかが分からない。「見つかりません」と誤案内せず、取得失敗として投入を止める。
  const loadError = target.projectId === null ? null : (projects.error ?? scenes.error ?? null);
  const missing = storyLoading || loadError !== null
    ? []
    : [projectMissing ? "Project" : null, target.sceneId !== null && scene === null ? "Scene" : null].filter(
        (name): name is string => name !== null,
      );

  // 対象を固定した画面は、入力欄を更新するときに対象も同じ更新で残す。
  // 別々に更新すると、後の更新が先の更新を打ち消すことがある。
  const fixed = !onTargetChange;
  const { projectId: fixedProjectId, sceneId: fixedSceneId } = target;
  const updateForm = useCallback(
    (update: Partial<BgmForm>) =>
      setStored((current) => ({
        ...current,
        ...(fixed ? { target: { projectId: fixedProjectId, sceneId: fixedSceneId } } : {}),
        form: { ...(current.form ?? defaultBgmForm(recipe)), ...update },
      })),
    [setStored, recipe, fixed, fixedProjectId, fixedSceneId],
  );
  const changeTarget = useCallback(
    (next: BgmTarget) => onTargetChange?.(next),
    [onTargetChange],
  );

  // `from_artifact`の設定を取りに行っている間は、入力欄を操作させず投入も止める (戻した値で上書きされるため)。
  const [restoring, setRestoring] = useState(() => fromArtifact !== null);

  // 対象を変えられる画面 (`/bgm`) だけ、URLの対象を次に開いたときの復元用に残す。初回の復元を決めるまでは、空の対象で上書きしない。
  // 2つのeffectは宣言順に走る順序に依存する。初回は、ここが`initialized`がfalseのため何もせず、
  // 次のeffectが`true`にして復元する。復元でURLが変わると`targetKey`が変わり、ここが保存する。
  // 2つの順序を入れ替えると、初回に空の対象を保存して前回の対象を失う。
  const initialized = useRef(false);
  useEffect(() => {
    // 対象を固定した画面は、`updateForm`が対象も残すので、ここでは残さない。
    if (!initialized.current || fixed) return;
    setStored((current) => ({ ...current, target: targetFromParams(new URLSearchParams(targetKey)) }));
  }, [targetKey, setStored, fixed]);
  // 開いたときに一度だけ、`from_artifact`の生成設定か、最後に使った対象を戻す。
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    if (fromArtifact === null) {
      if (onTargetChange) {
        const restored = initialTarget(target, stored.target);
        if (restored) changeTarget(restored);
      }
      return;
    }
    void restoreFromArtifactParam({
      client,
      artifactId: fromArtifact,
      restore: (jobId) => restoreBgmFromJob(client, jobId, recipe),
      apply: (restored) => {
        // 戻したSceneを「適用済み」にして、下のSceneの補完 (雰囲気と長さの入れ直し) が戻した入力を上書きしないようにする。
        appliedSceneId.current = restored.target.sceneId;
        setStored({ form: restored.form, target: restored.target });
        changeTarget(restored.target);
      },
      // 失敗したら、`from_artifact`の無い通常の起動と同じ対象 (前回の対象) に戻す。
      onFail: () => changeTarget(initialTarget(target, stored.target) ?? target),
    }).finally(() => setRestoring(false));
    // 依存配列は意図して空。開いたときの`target` / `stored.target`だけを使い、以後の変更では走らせない。
  }, []);

  // Sceneを選んだら、その「BGMの雰囲気」を日本語欄へ入れ、長さを既定値 (採用済み動画の長さか30秒) に戻す。
  // 開いたときのSceneが前回と同じなら、前回の入力をそのまま使う。
  const appliedSceneId = useRef<string | null>(stored.target?.sceneId ?? null);
  // 対象を固定した画面でリセットしたとき、補完を入れ直すために数える。
  const [resetCount, setResetCount] = useState(0);
  const sceneId = scene?.id ?? null;
  const sceneMood = scene?.bgm_mood ?? "";
  useEffect(() => {
    if (target.sceneId === null) {
      appliedSceneId.current = null;
      return;
    }
    if (sceneId === null || appliedSceneId.current === sceneId) return;
    appliedSceneId.current = sceneId;
    updateForm(sceneMood.trim() === "" ? { seconds: null } : { moodJa: sceneMood, seconds: null });
  }, [target.sceneId, sceneId, sceneMood, updateForm, resetCount]);
  // リセットは入力欄を既定に戻す。対象を固定した画面は、Sceneが変わらず補完が走らないので、
  // 保存した対象を外し「適用済み」も戻して、補完を入れ直す。
  const onReset = () => {
    setStored((current) => ({ ...current, form: defaultBgmForm(recipe), ...(fixed ? { target: null } : {}) }));
    if (fixed) {
      appliedSceneId.current = null;
      setResetCount((count) => count + 1);
    }
  };

  const seconds = form.seconds ?? defaultSeconds(video.data ?? null);
  // 長さが既定のままで採用済みの動画を確認している間は、30秒で投入しないよう待つ。
  const secondsPending = form.seconds === null && target.sceneId !== null && video.isLoading;
  const canSubmit =
    !restoring && form.tags.trim() !== "" && !storyLoading && loadError === null && missing.length === 0 && !secondsPending;
  const onSubmit = () => {
    const bodies = Array.from({ length: form.count }, (_, index) =>
      bgmJobBody(recipe, target, buildBgmInputs(form, seconds, index, recipe)),
    );
    submit.mutate(
      { bodies, onSubmitted: (job) => results.add({ jobId: job.id }) },
      { onError: (error) => notifyError("投入できませんでした", error) },
    );
  };

  const projectOptions = (projects.data ?? []).map((project) => ({ value: project.id, label: project.name }));
  return (
    <Grid gap="lg">
      <Grid.Col span={{ base: 12, lg: 5 }}>
        <Stack gap="md" inert={restoring}>
          <Group justify={onTargetChange ? "space-between" : "flex-end"}>
            {onTargetChange ? <Title order={2}>BGM</Title> : null}
            <Button
              variant="default"
              size="xs"
              onClick={onReset}
            >
              リセット
            </Button>
          </Group>
          {restoring ? (
            <Text size="xs" c="dimmed" data-testid="restoring-note">
              生成物の設定を読み込み中です
            </Text>
          ) : null}
          <SimpleGrid cols={2} spacing="xs">
            <Select
              label="Project"
              placeholder="指定しない"
              data={withCurrent(projectOptions, target.projectId, projects.isError)}
              value={target.projectId}
              onChange={(projectId) => changeTarget({ projectId, sceneId: null })}
              disabled={!onTargetChange}
              searchable
              clearable
              error={projects.error?.message}
            />
            <Select
              label="Scene"
              placeholder="指定しない"
              data={withCurrent(
                sceneList.map((item) => ({ value: item.id, label: item.name })),
                target.sceneId,
                scenes.isError,
              )}
              value={target.sceneId}
              onChange={(next) => changeTarget({ ...target, sceneId: next })}
              disabled={target.projectId === null || !onTargetChange}
              clearable
              error={scenes.error?.message}
            />
          </SimpleGrid>
          {loadError !== null ? (
            <Alert color="red" data-testid="target-load-error">
              ProjectまたはSceneの一覧を取得できないため、生成できません: {loadError.message}
            </Alert>
          ) : null}
          {missing.length > 0 ? (
            <Alert color="yellow" data-testid="target-missing">
              {missing.join("・")}が見つかりません。選び直してください。
            </Alert>
          ) : null}
          <BgmPromptFields form={form} onChange={updateForm} />
          <BgmParamsFields
            form={form}
            onChange={updateForm}
            recipe={recipe}
            seconds={seconds}
            secondsNote={secondsNote(target, video)}
          />
          {form.tags.trim() === "" ? (
            <Text size="xs" c="dimmed">
              タグを入れると生成できます。
            </Text>
          ) : null}
          <Button onClick={onSubmit} disabled={!canSubmit} loading={submit.isPending}>
            {form.count > 1 ? `${form.count}本生成` : "生成"}
          </Button>
        </Stack>
      </Grid.Col>
      <Grid.Col span={{ base: 12, lg: 7 }}>
        <BgmResultPanel entries={results.entries} onRemove={results.remove} />
      </Grid.Col>
    </Grid>
  );
}

/** `/bgm`。タグ・歌詞・長さの入力欄と、この画面から投入した生成の結果欄。 */
export function BgmPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  return (
    <WithBgmRecipe>
      {(recipe) => (
        <BgmWorkspace
          recipe={recipe}
          target={targetFromParams(searchParams)}
          onTargetChange={(next) => setSearchParams(paramsFromTarget(next), { replace: true })}
          storageKeys={BGM_STORAGE_KEYS}
          fromArtifact={searchParams.get(FROM_ARTIFACT_PARAM)}
        />
      )}
    </WithBgmRecipe>
  );
}
