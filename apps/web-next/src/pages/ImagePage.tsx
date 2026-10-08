import { Alert, Button, Grid, Group, Loader, Stack, Tabs, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import type { Recipe } from "../api/client";
import { ParamsFields } from "../imageGen/ParamsFields";
import { PromptFields } from "../imageGen/PromptFields";
import { ResultPanel } from "../imageGen/ResultPanel";
import { TargetPicker } from "../imageGen/TargetPicker";
import {
  buildInputs,
  composedPrompts,
  defaultForm,
  EMPTY_TARGET,
  type ImageForm,
  type ImageTarget,
} from "../imageGen/imageForm";
import { buildSupplementTags } from "../imageGen/promptTags";
import {
  jobIdOfArtifact,
  restoreFromJob,
  useProjectStory,
  useResultEntries,
  useStoredInput,
  useSubmitImageJob,
  useTxt2ImgRecipe,
  type RestoredInput,
} from "../imageGen/useImageGen";
import { notifyError } from "../notifications";

/** URLのクエリ名。衣装は設計文書に合わせて`outfit`とする。 */
const TARGET_PARAMS: [keyof ImageTarget, string][] = [
  ["projectId", "project"],
  ["sceneId", "scene"],
  ["characterId", "character"],
  ["costumeId", "outfit"],
];

function targetFromParams(params: URLSearchParams): ImageTarget {
  const target = { ...EMPTY_TARGET };
  for (const [field, name] of TARGET_PARAMS) target[field] = params.get(name) || null;
  return target;
}

function paramsFromTarget(target: ImageTarget): URLSearchParams {
  const params = new URLSearchParams();
  for (const [field, name] of TARGET_PARAMS) {
    const value = target[field];
    if (value) params.set(name, value);
  }
  return params;
}

function hasAny(target: ImageTarget | null): boolean {
  return target !== null && TARGET_PARAMS.some(([field]) => target[field] !== null);
}

/**
 * 開いたURLに対象が無ければ、最後に使った対象へ戻す。ナビはProjectだけを引き継ぐため、
 * Projectだけが前回と同じなら、Scene・キャラ・衣装も前回の値へ戻す。
 */
function initialTarget(fromUrl: ImageTarget, stored: ImageTarget | null): ImageTarget | null {
  if (stored === null || !hasAny(stored)) return null;
  if (!hasAny(fromUrl)) return stored;
  const onlyProject = fromUrl.sceneId === null && fromUrl.characterId === null && fromUrl.costumeId === null;
  return onlyProject && fromUrl.projectId === stored.projectId ? stored : null;
}

function ImageWorkspace({ recipe }: { recipe: Recipe }) {
  const client = useQueryClient();
  const [stored, setStored] = useStoredInput();
  const [searchParams, setSearchParams] = useSearchParams();
  const results = useResultEntries();
  const submit = useSubmitImageJob();
  const [restoringJobId, setRestoringJobId] = useState<string | null>(null);

  const target = targetFromParams(searchParams);
  const targetKey = paramsFromTarget(target).toString();
  const form = stored.form ?? defaultForm(recipe);

  const story = useProjectStory(target.projectId);
  const characterList = story.characters;
  const sceneList = story.scenes;
  const character = characterList.find((item) => item.id === target.characterId) ?? null;
  const costume = character?.costumes.find((item) => item.id === target.costumeId) ?? null;
  const scene = sceneList.find((item) => item.id === target.sceneId) ?? null;
  const supplement = buildSupplementTags(character, costume, scene);
  const composed = composedPrompts(form, supplement);

  const storyLoading = story.isLoading;
  const storyError = story.error;
  const missing = storyLoading
    ? []
    : [
        target.sceneId !== null && scene === null ? "Scene" : null,
        target.characterId !== null && character === null ? "キャラ" : null,
        target.costumeId !== null && costume === null ? "衣装" : null,
      ].filter((name): name is string => name !== null);

  const updateForm = useCallback(
    (update: Partial<ImageForm>) =>
      setStored((current) => ({ ...current, form: { ...(current.form ?? defaultForm(recipe)), ...update } })),
    [setStored, recipe],
  );
  const changeTarget = useCallback(
    (next: ImageTarget) => setSearchParams(paramsFromTarget(next), { replace: true }),
    [setSearchParams],
  );
  const applyRestored = useCallback(
    (restored: RestoredInput) => {
      setStored({ form: restored.form, target: restored.target });
      setSearchParams(paramsFromTarget(restored.target), { replace: true });
    },
    [setStored, setSearchParams],
  );

  // URLの対象を、次に開いたときの復元用に残す。初回の復元を決めるまでは、空の対象で上書きしない。
  const initialized = useRef(false);
  useEffect(() => {
    if (!initialized.current) return;
    setStored((current) => ({ ...current, target: targetFromParams(new URLSearchParams(targetKey)) }));
  }, [targetKey, setStored]);

  // 開いたときに一度だけ、`from_artifact`の設定か、最後に使った対象を戻す。
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const fromArtifact = searchParams.get("from_artifact");
    if (fromArtifact === null) {
      const restored = initialTarget(target, stored.target);
      if (restored) changeTarget(restored);
      return;
    }
    void (async () => {
      try {
        const jobId = await jobIdOfArtifact(client, fromArtifact);
        applyRestored(await restoreFromJob(client, jobId, recipe));
        notifications.show({ color: "green", message: "生成物の設定を入力欄へ戻しました" });
      } catch (error) {
        notifyError("生成物の設定を戻せませんでした", error);
        changeTarget(target);
      }
    })();
    // 開いたときの値だけを使う。
  }, []);

  const restoreJob = async (jobId: string) => {
    setRestoringJobId(jobId);
    try {
      applyRestored(await restoreFromJob(client, jobId, recipe));
      notifications.show({ color: "green", message: "設定を入力欄へ戻しました" });
    } catch (error) {
      notifyError("設定を入力欄へ戻せませんでした", error);
    } finally {
      setRestoringJobId(null);
    }
  };

  const canSubmit = composed.positive !== "" && !storyLoading && storyError === null && missing.length === 0;
  const onSubmit = () =>
    submit.mutate(
      {
        kind: "image",
        recipe_id: recipe.id,
        use_inherited_defaults: false,
        project_id: target.projectId,
        story_scene_id: target.sceneId,
        story_character_id: target.characterId,
        story_costume_id: target.costumeId,
        inputs: buildInputs(form, supplement, recipe),
      },
      {
        onSuccess: (job) => results.add({ jobId: job.id, count: form.batchSize }),
        onError: (error) => notifyError("投入できませんでした", error),
      },
    );

  return (
    <Grid gap="lg">
      <Grid.Col span={{ base: 12, lg: 5 }}>
        <Stack gap="md">
          <Group justify="space-between">
            <Title order={2}>画像</Title>
            <Button variant="default" size="xs" onClick={() => setStored((current) => ({ ...current, form: defaultForm(recipe) }))}>
              リセット
            </Button>
          </Group>
          <TargetPicker
            target={target}
            onChange={changeTarget}
            characters={characterList}
            scenes={sceneList}
            missing={missing}
          />
          {storyError ? <Alert color="red">{storyError.message}</Alert> : null}
          <Tabs value="txt2img">
            <Tabs.List>
              <Tabs.Tab value="txt2img">新規</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="txt2img" pt="sm">
              <Stack gap="md">
                <PromptFields
                  supplementPositive={supplement.positive}
                  supplementNegative={supplement.negative}
                  excludedPositive={form.excludedPositive}
                  excludedNegative={form.excludedNegative}
                  positiveFree={form.positiveFree}
                  negativeFree={form.negativeFree}
                  composedPositive={composed.positive}
                  composedNegative={composed.negative}
                  onChange={updateForm}
                />
                <ParamsFields form={form} onChange={updateForm} recipe={recipe} />
              </Stack>
            </Tabs.Panel>
          </Tabs>
          <Button onClick={onSubmit} disabled={!canSubmit} loading={submit.isPending}>
            生成
          </Button>
        </Stack>
      </Grid.Col>
      <Grid.Col span={{ base: 12, lg: 7 }}>
        <ResultPanel
          entries={results.entries}
          onRemove={results.remove}
          onRestore={(jobId) => void restoreJob(jobId)}
          restoringJobId={restoringJobId}
        />
      </Grid.Col>
    </Grid>
  );
}

/** `/image`。新規生成 (`anima_txt2img`) の入力欄と、この画面から投入した生成の結果欄。 */
export function ImagePage() {
  const recipe = useTxt2ImgRecipe();
  if (recipe.isPending) return <Loader size="sm" />;
  if (recipe.error) {
    return (
      <Alert color="red" title="Recipeを読めません">
        {recipe.error.message}
      </Alert>
    );
  }
  if (recipe.data === null) {
    return (
      <Alert color="yellow" title="新規生成のRecipeがありません">
        anima_txt2imgのRecipeを登録してから開いてください。
      </Alert>
    );
  }
  return <ImageWorkspace recipe={recipe.data} />;
}
