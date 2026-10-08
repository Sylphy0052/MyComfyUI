import { Alert, Button, Grid, Group, Loader, Stack, Tabs, Text, Textarea, Title } from "@mantine/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";

import { FROM_ARTIFACT_PARAM, restoreFromArtifactParam } from "../imageGen/artifactRestore";
import type { SourceImage } from "../imageGen/deriveForm";
import { type ImageTarget } from "../imageGen/imageForm";
import { TargetPicker } from "../imageGen/TargetPicker";
import { initialTarget, paramsFromTarget, targetFromParams } from "../imageGen/targetParams";
import { buildSupplementTags } from "../imageGen/promptTags";
import { useProjectStory, useSubmitImageJob, useTxt2ImgRecipe } from "../imageGen/useImageGen";
import { notifyError } from "../notifications";
import { useProjectList } from "../projects/useProjects";
import { GuideAudioField } from "../videoGen/GuideAudioField";
import { notifyDroppedReferences } from "../videoGen/referenceNotice";
import { useCostumeFill } from "../videoGen/useCostumeFill";
import { useSceneFill } from "../videoGen/useSceneFill";
import {
  restoreVideoFromJob,
  useStoredVideoInput,
  useSubmitPromptOnlyVideo,
  useVideoRecipes,
  useVideoResultEntries,
} from "../videoGen/useVideoGen";
import {
  addReferences,
  buildPromptOnlyBody,
  buildVideoInputs,
  defaultDraft,
  mergeReferences,
  videoBlockedReason,
  videoImageFromSource,
  VIDEO_MODE_LABELS,
  type VideoDraft,
  type VideoMode,
  type VideoParams,
  type VideoRecipes,
} from "../videoGen/videoForm";
import { FirstFrameField, ReferencesField } from "../videoGen/VideoImageFields";
import { VideoParamsFields } from "../videoGen/VideoParamsFields";
import { VideoPromptAssistField } from "../videoGen/VideoPromptAssist";
import { VideoResultPanel } from "../videoGen/VideoResultPanel";

/** 動画は1人のキャラの衣装だけを使う。URLに`cast`があっても2人目以降は使わない。 */
function videoTargetFromParams(params: URLSearchParams): ImageTarget {
  return { ...targetFromParams(params), extraCast: [] };
}

function VideoWorkspace({ recipes }: { recipes: VideoRecipes }) {
  const [stored, setStored] = useStoredVideoInput(recipes);
  const [searchParams, setSearchParams] = useSearchParams();
  const client = useQueryClient();
  const results = useVideoResultEntries();
  // Jobの投入は画像と同じ。投入後にJob一覧を取り直す。
  const submit = useSubmitImageJob();
  // 「プロンプトだけ」は画像Jobと、その後のi2v Jobの予約を1回で投入する。
  const submitPrompt = useSubmitPromptOnlyVideo();
  const imageRecipe = useTxt2ImgRecipe().data ?? null;

  const draft = stored.draft;
  const params = draft.params[draft.mode];
  const recipe = recipes[draft.mode];
  const target = videoTargetFromParams(searchParams);
  const targetKey = paramsFromTarget(target).toString();

  const story = useProjectStory(target.projectId);
  const projects = useProjectList("active");
  const characterList = story.characters;
  const sceneList = story.scenes;
  const character = characterList.find((item) => item.id === target.characterId) ?? null;
  const costume = character?.costumes.find((item) => item.id === target.costumeId) ?? null;
  const scene = sceneList.find((item) => item.id === target.sceneId) ?? null;

  const storyLoading = story.isLoading || (target.projectId !== null && projects.isPending);
  const storyError = story.error;
  // Project一覧を読めないと、Projectが有効か (ゴミ箱・削除済みでないか) を確かめられない。Projectを指す対象のときだけ投入を止める。
  const projectsError = target.projectId !== null ? projects.error : null;
  // ゴミ箱・削除済みのProjectは有効な一覧に無い。投入を止める。
  const projectMissing =
    target.projectId !== null && projects.data !== undefined && !projects.data.some((item) => item.id === target.projectId);
  const missing = storyLoading
    ? []
    : [
        projectMissing ? "Project" : null,
        target.sceneId !== null && scene === null ? "Scene" : null,
        target.characterId !== null && character === null ? "キャラ" : null,
        target.costumeId !== null && costume === null ? "衣装" : null,
      ].filter((name): name is string => name !== null);

  const setDraft = useCallback(
    (update: (current: VideoDraft) => VideoDraft) =>
      setStored((current) => ({ ...current, draft: update(current.draft) })),
    [setStored],
  );
  const updateParams = useCallback(
    (update: Partial<VideoParams>) =>
      setDraft((current) => ({
        ...current,
        params: { ...current.params, [current.mode]: { ...current.params[current.mode], ...update } },
      })),
    [setDraft],
  );
  const changeTarget = useCallback(
    (next: ImageTarget) => setSearchParams(paramsFromTarget(next), { replace: true }),
    [setSearchParams],
  );

  // `from_artifact`の設定を取りに行っている間は、入力欄を操作させず投入も止める (戻した値で上書きされるため)。
  const [restoring, setRestoring] = useState(() => searchParams.get(FROM_ARTIFACT_PARAM) !== null);

  // URLの対象を、次に開いたときの復元用に残す。
  // 下の復元effectより前に置くこと。順序は次の2点で効く。
  // - 初回の描画では`initialized`がまだfalseなので、ここは保存せずに抜ける。URLが空のまま、保存済みの対象を空で上書きしない。
  // - 復元effectが`initialized`をtrueにして`changeTarget`を呼ぶと、URLが変わって`targetKey`が変わり、
  //   次の描画でここが復元後の対象を保存する。入れ替えると、復元前の空の対象を保存してしまう。
  const initialized = useRef(false);
  useEffect(() => {
    if (!initialized.current) return;
    setStored((current) => ({ ...current, target: videoTargetFromParams(new URLSearchParams(targetKey)) }));
  }, [targetKey, setStored]);

  // 開いたときに一度だけ、`from_artifact`の生成設定か、最後に使った対象を戻す。
  // 依存配列を`[]`にするのは、開いた時点の`target`・`stored.target`だけを使い、その後の変更で戻し直さないため
  // (`initialized`でも二重実行を防ぐ)。web-nextにはESLint設定が無く、`ImagePage`の`[]`のeffectにも抑止コメントは無いため、
  // `react-hooks/exhaustive-deps`の抑止コメントは付けない。
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const fromArtifact = searchParams.get(FROM_ARTIFACT_PARAM);
    if (fromArtifact === null) {
      const restored = initialTarget(target, stored.target);
      if (restored) changeTarget({ ...restored, extraCast: [] });
      return;
    }
    // 入力欄と対象を保存値へ入れてからURLを替える。Scene・衣装の補完は、戻した草稿が補完済みの対象を持つので上書きしない。
    void restoreFromArtifactParam({
      client,
      artifactId: fromArtifact,
      restore: (jobId) => restoreVideoFromJob(client, jobId, recipes),
      apply: (restored) => {
        setStored({ draft: restored.draft, target: restored.target });
        setSearchParams(paramsFromTarget(restored.target), { replace: true });
      },
      // 失敗したら、`from_artifact`の無い通常の起動と同じ対象 (前回の対象) に戻す。
      onFail: () => changeTarget({ ...(initialTarget(target, stored.target) ?? target), extraCast: [] }),
    }).finally(() => setRestoring(false));
  }, []);

  // ---- 画像の選択 ----

  // 先頭フレームを選び直すたびに進め、取り込みを待つ間に選び直されたら、待っていた結果を捨てる。
  const frameSeq = useRef(0);
  const pickFirstFrame = useCallback(
    (source: SourceImage) => {
      frameSeq.current += 1;
      setDraft((current) => ({ ...current, firstFrame: videoImageFromSource(source) }));
    },
    [setDraft],
  );
  const reserveFirstFrame = useCallback(() => {
    const seq = ++frameSeq.current;
    return (source: SourceImage) => {
      if (seq === frameSeq.current) setDraft((current) => ({ ...current, firstFrame: videoImageFromSource(source) }));
    };
  }, [setDraft]);
  const clearFirstFrame = useCallback(() => {
    frameSeq.current += 1;
    setDraft((current) => ({ ...current, firstFrame: null }));
  }, [setDraft]);
  // 取り込みを待った後に読むことがあるため、最新の参照画像をrefで持つ。
  const referencesRef = useRef(draft.references);
  referencesRef.current = draft.references;
  const pickReference = useCallback(
    (source: SourceImage) => {
      const added = [videoImageFromSource(source)];
      notifyDroppedReferences(mergeReferences(referencesRef.current, added));
      setDraft((current) => ({ ...current, references: addReferences(current.references, added) }));
    },
    [setDraft],
  );
  const reserveReference = useCallback(() => pickReference, [pickReference]);
  const removeReference = useCallback(
    (index: number) =>
      setDraft((current) => ({ ...current, references: current.references.filter((_, i) => i !== index) })),
    [setDraft],
  );

  // ---- Projectからの補完 ----

  const { sceneMotion, insertMotion, adoptionsError } = useSceneFill({
    projectId: target.projectId,
    sceneId: target.sceneId,
    scene,
    filledSceneId: draft.filled.sceneId,
    setDraft,
  });
  useCostumeFill({ costume, filledCostumeId: draft.filled.costumeId, referencesRef, setDraft });

  // ---- 投入 ----

  const blockedReason = videoBlockedReason(draft, recipe, imageRecipe);
  const canSubmit =
    !restoring && blockedReason === null && !storyLoading && storyError === null && projectsError === null && missing.length === 0;
  const onSubmit = () => {
    if (recipe === null) return;
    if (draft.mode === "prompt") {
      if (imageRecipe === null) return;
      submitPrompt.mutate(
        buildPromptOnlyBody(
          draft,
          recipe,
          imageRecipe,
          {
            project_id: target.projectId,
            story_scene_id: target.sceneId,
            story_character_id: target.characterId,
            story_costume_id: target.costumeId,
          },
          buildSupplementTags(character, costume, scene),
        ),
        {
          onSuccess: (result) => results.add({ jobId: result.image_job.id, followupId: result.followup.id }),
          onError: (error) => notifyError("投入できませんでした", error),
        },
      );
      return;
    }
    submit.mutate(
      {
        kind: "video",
        recipe_id: recipe.id,
        use_inherited_defaults: false,
        project_id: target.projectId,
        story_scene_id: target.sceneId,
        story_character_id: target.characterId,
        story_costume_id: target.costumeId,
        inputs: buildVideoInputs(draft, recipe),
      },
      {
        onSuccess: (job) => results.add({ jobId: job.id }),
        onError: (error) => notifyError("投入できませんでした", error),
      },
    );
  };

  const pickerProps = { target, characters: characterList };
  return (
    <Grid gap="lg">
      <Grid.Col span={{ base: 12, lg: 5 }}>
        <Stack gap="md" inert={restoring}>
          <Group justify="space-between">
            <Title order={2}>動画</Title>
            <Button
              variant="default"
              size="xs"
              onClick={() => setDraft((current) => ({ ...defaultDraft(recipes), mode: current.mode }))}
            >
              リセット
            </Button>
          </Group>
          {restoring ? (
            <Text size="xs" c="dimmed" data-testid="restoring-note">
              生成物の設定を読み込み中です
            </Text>
          ) : null}
          <TargetPicker
            target={target}
            onChange={changeTarget}
            characters={characterList}
            scenes={sceneList}
            missing={missing}
            multi={false}
          />
          {storyError ? <Alert color="red">{storyError.message}</Alert> : null}
          {projectsError ? (
            <Alert color="red" title="Project一覧を読めません" data-testid="projects-error">
              {projectsError.message}
            </Alert>
          ) : null}
          {adoptionsError ? (
            <Alert color="yellow" title="Sceneの採用画像を取得できませんでした" data-testid="adoptions-error">
              先頭フレームは手で選んでください。({adoptionsError.message})
            </Alert>
          ) : null}
          <Tabs
            keepMounted={false}
            value={draft.mode}
            onChange={(value) => value !== null && setDraft((current) => ({ ...current, mode: value as VideoMode }))}
          >
            <Tabs.List>
              <Tabs.Tab value="i2v">{VIDEO_MODE_LABELS.i2v}</Tabs.Tab>
              <Tabs.Tab value="ref2v">{VIDEO_MODE_LABELS.ref2v}</Tabs.Tab>
              <Tabs.Tab value="prompt">{VIDEO_MODE_LABELS.prompt}</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="i2v" pt="sm">
              <FirstFrameField
                image={draft.firstFrame}
                onClear={clearFirstFrame}
                onPick={pickFirstFrame}
                reservePick={reserveFirstFrame}
                {...pickerProps}
              />
            </Tabs.Panel>
            <Tabs.Panel value="ref2v" pt="sm">
              <ReferencesField
                images={draft.references}
                onRemove={removeReference}
                onPick={pickReference}
                reservePick={reserveReference}
                {...pickerProps}
              />
            </Tabs.Panel>
            <Tabs.Panel value="prompt" pt="sm">
              <Stack gap="xs">
                <Text size="xs" c="dimmed">
                  画像を1枚作り、その画像を先頭フレームにして動画を作ります。キャラ・衣装・Sceneのタグは画像のプロンプトの前に足されます。
                </Text>
                <Textarea
                  label="画像のプロンプト"
                  placeholder="1段目の画像に写すものを書く"
                  autosize
                  minRows={3}
                  maxRows={10}
                  value={draft.imagePrompt}
                  onChange={(event) => {
                    const imagePrompt = event.currentTarget.value;
                    setDraft((current) => ({ ...current, imagePrompt }));
                  }}
                />
                <Textarea
                  label="画像のネガティブプロンプト"
                  placeholder="空ならRecipeの既定値を使う"
                  autosize
                  minRows={2}
                  maxRows={8}
                  value={draft.imageNegative}
                  onChange={(event) => {
                    const imageNegative = event.currentTarget.value;
                    setDraft((current) => ({ ...current, imageNegative }));
                  }}
                />
              </Stack>
            </Tabs.Panel>
          </Tabs>
          <GuideAudioField
            recipe={recipe}
            audio={draft.guideAudio}
            onChange={(guideAudio) => setDraft((current) => ({ ...current, guideAudio }))}
            projectId={target.projectId}
            scene={scene}
            characters={characterList}
          />
          <Stack gap={4}>
            <Textarea
              label={draft.mode === "prompt" ? "動画のプロンプト" : "プロンプト"}
              placeholder="動きや場面を文章で書く"
              autosize
              minRows={4}
              maxRows={12}
              value={draft.prompt}
              onChange={(event) => {
                const prompt = event.currentTarget.value;
                setDraft((current) => ({ ...current, prompt }));
              }}
            />
            {sceneMotion !== "" && draft.prompt !== sceneMotion ? (
              <Group>
                <Button size="compact-xs" variant="light" onClick={insertMotion} data-testid="insert-motion">
                  Sceneの動きを入れ直す
                </Button>
              </Group>
            ) : null}
            <VideoPromptAssistField
              prompt={draft.prompt}
              onApply={(prompt) => setDraft((current) => ({ ...current, prompt }))}
            />
          </Stack>
          {recipe !== null ? <VideoParamsFields params={params} onChange={updateParams} recipe={recipe} /> : null}
          {blockedReason !== null ? (
            <Text size="xs" c="dimmed" data-testid="blocked-reason">
              {blockedReason}
            </Text>
          ) : null}
          <Button onClick={onSubmit} disabled={!canSubmit} loading={submit.isPending || submitPrompt.isPending}>
            生成
          </Button>
        </Stack>
      </Grid.Col>
      <Grid.Col span={{ base: 12, lg: 7 }}>
        <VideoResultPanel entries={results.entries} onRemove={results.remove} />
      </Grid.Col>
    </Grid>
  );
}

/** `/video`。「画像から」「参照から」「プロンプトだけ」の入力欄と、この画面から投入した生成の結果欄。 */
export function VideoPage() {
  const recipes = useVideoRecipes();
  if (recipes.isPending) return <Loader size="sm" />;
  if (recipes.error) {
    return (
      <Alert color="red" title="Recipeを読めません">
        {recipes.error.message}
      </Alert>
    );
  }
  if (recipes.data.i2v === null && recipes.data.ref2v === null) {
    return (
      <Alert color="yellow" title="動画のRecipeがありません">
        minimax_h3_i2v か minimax_h3_ref2v のRecipeを登録してから開いてください。
      </Alert>
    );
  }
  return <VideoWorkspace recipes={recipes.data} />;
}
