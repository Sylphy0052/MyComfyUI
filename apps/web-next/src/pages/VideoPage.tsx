import { Alert, Button, Grid, Group, Loader, Stack, Tabs, Text, Textarea, Title } from "@mantine/core";
import { useCallback, useEffect, useRef } from "react";
import { useSearchParams } from "react-router";

import type { SourceImage } from "../imageGen/deriveForm";
import { EMPTY_TARGET, type ImageTarget } from "../imageGen/imageForm";
import { TargetPicker } from "../imageGen/TargetPicker";
import { initialTarget, paramsFromTarget, targetFromParams } from "../imageGen/targetParams";
import { reimportInputImage, useProjectStory, useSubmitImageJob, useUploadInputImage } from "../imageGen/useImageGen";
import { notifyError } from "../notifications";
import { artifactIdOf } from "../projectDetail/MediaThumb";
import { useSceneAdoptions } from "../projectDetail/useStory";
import { useProjectList } from "../projects/useProjects";
import { useStoredVideoInput, useVideoRecipes, useVideoResultEntries } from "../videoGen/useVideoGen";
import {
  addReferences,
  buildVideoInputs,
  defaultDraft,
  REFERENCES_MAX,
  videoBlockedReason,
  videoImage,
  videoImageFromSource,
  VIDEO_MODE_LABELS,
  type VideoDraft,
  type VideoImage,
  type VideoMode,
  type VideoParams,
  type VideoRecipes,
} from "../videoGen/videoForm";
import { FirstFrameField, ReferencesField } from "../videoGen/VideoImageFields";
import { VideoParamsFields } from "../videoGen/VideoParamsFields";
import { VideoResultPanel } from "../videoGen/VideoResultPanel";

const INPUT_PREFIX = "input:";

/** 動画は1人のキャラの衣装だけを使う。URLに`cast`があっても2人目以降は使わない。 */
function videoTargetFromParams(params: URLSearchParams): ImageTarget {
  return { ...targetFromParams(params), extraCast: [] };
}

function VideoWorkspace({ recipes }: { recipes: VideoRecipes }) {
  const [stored, setStored] = useStoredVideoInput(recipes);
  const [searchParams, setSearchParams] = useSearchParams();
  const results = useVideoResultEntries();
  // Jobの投入は画像と同じ。投入後にJob一覧を取り直す。
  const submit = useSubmitImageJob();
  const upload = useUploadInputImage();

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

  // URLの対象を、次に開いたときの復元用に残す。初回の復元を決めるまでは、空の対象で上書きしない。
  const initialized = useRef(false);
  useEffect(() => {
    if (!initialized.current) return;
    setStored((current) => ({ ...current, target: videoTargetFromParams(new URLSearchParams(targetKey)) }));
  }, [targetKey, setStored]);

  // 開いたときに一度だけ、最後に使った対象を戻す。
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const restored = initialTarget(target, stored.target);
    if (restored) changeTarget({ ...restored, extraCast: [] });
    // 開いたときの値だけを使う。
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
  const pickReference = useCallback(
    (source: SourceImage) =>
      setDraft((current) => ({ ...current, references: addReferences(current.references, [videoImageFromSource(source)]) })),
    [setDraft],
  );
  const reserveReference = useCallback(() => pickReference, [pickReference]);
  const removeReference = useCallback(
    (index: number) =>
      setDraft((current) => ({ ...current, references: current.references.filter((_, i) => i !== index) })),
    [setDraft],
  );

  // ---- Projectからの補完 ----

  // Sceneを選ぶと、採用済みのシーン画像を先頭フレームに、`video_motion`を自由欄に入れる。
  // 手で選んだ先頭フレームと、手で書いた自由欄は上書きしない。同じSceneでは入れ直さない。
  const adoptions = useSceneAdoptions(target.projectId ?? "", target.projectId === null ? null : target.sceneId);
  const sceneFilled = draft.filled.sceneId;
  useEffect(() => {
    if (scene === null || !adoptions.isSuccess || sceneFilled === scene.id) return;
    const artifactId = adoptions.data.find((item) => item.slot === "scene_image")?.artifact_id ?? null;
    const motion = scene.video_motion.trim();
    setDraft((current) => ({
      ...current,
      firstFrame:
        artifactId !== null && (current.firstFrame === null || current.firstFrame.auto)
          ? videoImage({ artifact_id: artifactId }, "シーンの採用画像", true)
          : current.firstFrame,
      prompt: motion !== "" && (current.prompt.trim() === "" || current.prompt === current.filled.motion) ? motion : current.prompt,
      filled: { ...current.filled, sceneId: scene.id, motion: motion !== "" ? motion : current.filled.motion },
    }));
  }, [scene, adoptions.isSuccess, adoptions.data, sceneFilled, setDraft]);
  const sceneMotion = scene?.video_motion.trim() ?? "";
  const insertMotion = () =>
    setDraft((current) => ({ ...current, prompt: sceneMotion, filled: { ...current.filled, motion: sceneMotion } }));

  // 衣装を選ぶと、衣装の参照画像を参照の枠へ入れる。手で足した参照画像は残し、前の衣装から入れたものは置き換える。
  // アップロードした参照画像 (`input:`) はsha256を持たないため、入力cacheへ取り込み直す。
  // fillSeqは入れ直すたびに進め、取り込みを待つ間に衣装が変わったら、待っていた結果を捨てる。
  const costumeFilled = draft.filled.costumeId;
  const fillSeq = useRef(0);
  const fillingId = useRef<string | null>(null);
  useEffect(() => {
    if (costume === null) {
      fillSeq.current += 1;
      fillingId.current = null;
      return;
    }
    if (costumeFilled === costume.id || fillingId.current === costume.id) return;
    const costumeId = costume.id;
    const seq = ++fillSeq.current;
    fillingId.current = costumeId;
    const resolveKey = async (key: string): Promise<VideoImage | null> => {
      const artifactId = artifactIdOf(key);
      if (artifactId !== null) return videoImage({ artifact_id: artifactId }, "衣装の参照画像", true);
      if (!key.startsWith(INPUT_PREFIX)) return null;
      try {
        const reference = await reimportInputImage(key.slice(INPUT_PREFIX.length), upload.mutateAsync);
        return videoImage({ relative_path: reference.relative_path, sha256: reference.sha256 }, "衣装の参照画像", true);
      } catch (error) {
        notifyError("衣装の参照画像を取り込めませんでした", error);
        return null;
      }
    };
    void (async () => {
      const images = (await Promise.all(costume.reference_images.slice(0, REFERENCES_MAX).map(resolveKey))).flatMap(
        (image) => image ?? [],
      );
      if (seq !== fillSeq.current) return;
      fillingId.current = null;
      setDraft((current) => ({
        ...current,
        references: addReferences(
          current.references.filter((item) => !item.auto),
          images,
        ),
        filled: { ...current.filled, costumeId },
      }));
    })();
  }, [costume, costumeFilled, setDraft, upload.mutateAsync]);

  // ---- 投入 ----

  const blockedReason = videoBlockedReason(draft, recipe);
  const canSubmit = blockedReason === null && !storyLoading && storyError === null && missing.length === 0;
  const onSubmit = () => {
    if (recipe === null) return;
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
        <Stack gap="md">
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
          <TargetPicker
            target={target}
            onChange={changeTarget}
            characters={characterList}
            scenes={sceneList}
            missing={missing}
            multi={false}
          />
          {storyError ? <Alert color="red">{storyError.message}</Alert> : null}
          <Tabs
            keepMounted={false}
            value={draft.mode}
            onChange={(value) => value !== null && setDraft((current) => ({ ...current, mode: value as VideoMode }))}
          >
            <Tabs.List>
              <Tabs.Tab value="i2v">{VIDEO_MODE_LABELS.i2v}</Tabs.Tab>
              <Tabs.Tab value="ref2v">{VIDEO_MODE_LABELS.ref2v}</Tabs.Tab>
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
          </Tabs>
          <Stack gap={4}>
            <Textarea
              label="プロンプト"
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
          </Stack>
          {recipe !== null ? <VideoParamsFields params={params} onChange={updateParams} recipe={recipe} /> : null}
          {blockedReason !== null ? (
            <Text size="xs" c="dimmed" data-testid="blocked-reason">
              {blockedReason}
            </Text>
          ) : null}
          <Button onClick={onSubmit} disabled={!canSubmit} loading={submit.isPending}>
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

/** `/video`。「画像から」「参照から」の入力欄と、この画面から投入した生成の結果欄。 */
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
