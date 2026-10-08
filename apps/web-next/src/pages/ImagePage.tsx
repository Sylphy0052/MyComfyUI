import { Alert, Button, Grid, Group, Loader, Stack, Tabs, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import type { ArtifactRecord, Recipe } from "../api/client";
import { EditFields, RefFields, RefStrengthField } from "../imageGen/DeriveFields";
import { ParamsFields } from "../imageGen/ParamsFields";
import { PromptAssistPanel } from "../imageGen/PromptAssistPanel";
import { PromptFields } from "../imageGen/PromptFields";
import { ResultPanel } from "../imageGen/ResultPanel";
import { SourceImagePicker } from "../imageGen/SourceImagePicker";
import { SweepFields } from "../imageGen/SweepFields";
import { TargetPicker } from "../imageGen/TargetPicker";
import {
  buildDeriveInputs,
  deriveBlockedReason,
  IMG2IMG_TEMPLATE,
  INITIAL_DERIVE,
  REF_SIGLIP_TEMPLATE,
  resultCountOf,
  sourceFromArtifact,
  templateOfDerive,
  usesPrompt,
  type DeriveState,
  type GenerateMode,
  type SourceImage,
  type UploadedImage,
} from "../imageGen/deriveForm";
import {
  buildInputs,
  composedPrompts,
  defaultForm,
  type ImageForm,
  type ImageTarget,
} from "../imageGen/imageForm";
import { buildCastSupplementTags, isExcluded, type CastEntry } from "../imageGen/promptTags";
import { buildSweepBody, planSweep } from "../imageGen/sweep";
import { initialTarget, paramsFromTarget, targetFromParams } from "../imageGen/targetParams";
import {
  jobIdOfArtifact,
  restoreFromJob,
  useDeriveRecipes,
  useProjectStory,
  useResultEntries,
  useStoredInput,
  useSubmitImageJob,
  useTxt2ImgRecipe,
  type RestoredInput,
} from "../imageGen/useImageGen";
import { useSubmitSweep, useSweepEntries } from "../imageGen/useSweep";
import { notifyError } from "../notifications";
import { useProjectList } from "../projects/useProjects";

/** 戻した結果の通知。一部を戻せなかったときは黄色で理由を添える。 */
function notifyRestored(restored: RestoredInput, message: string) {
  notifications.show(
    restored.warning === null
      ? { color: "green", message }
      : { color: "yellow", title: message, message: restored.warning },
  );
}

function ImageWorkspace({ recipe }: { recipe: Recipe }) {
  const client = useQueryClient();
  const [stored, setStored] = useStoredInput(recipe);
  const [searchParams, setSearchParams] = useSearchParams();
  const results = useResultEntries();
  const submit = useSubmitImageJob();
  const submitSweep = useSubmitSweep();
  const sweeps = useSweepEntries();
  const [restoringJobId, setRestoringJobId] = useState<string | null>(null);
  const [mode, setMode] = useState<GenerateMode>("txt2img");
  const [derive, setDerive] = useState<DeriveState>(INITIAL_DERIVE);
  const deriveRecipes = useDeriveRecipes().data ?? {};

  const target = targetFromParams(searchParams);
  const targetKey = paramsFromTarget(target).toString();
  const form = stored.form ?? defaultForm(recipe);

  const story = useProjectStory(target.projectId);
  const projects = useProjectList("active");
  const characterList = story.characters;
  const sceneList = story.scenes;
  const character = characterList.find((item) => item.id === target.characterId) ?? null;
  const costume = character?.costumes.find((item) => item.id === target.costumeId) ?? null;
  const scene = sceneList.find((item) => item.id === target.sceneId) ?? null;
  // 2人目以降は新規タブだけで使う。参照・修正は先頭キャラだけで補完タグを作る。
  const multi = mode === "txt2img";
  const extraEntries = multi
    ? target.extraCast.map((member) => {
        const extraCharacter = characterList.find((item) => item.id === member.characterId) ?? null;
        const extraCostume = extraCharacter?.costumes.find((item) => item.id === member.costumeId) ?? null;
        return { member, character: extraCharacter, costume: extraCostume };
      })
    : [];
  const cast: CastEntry[] = character
    ? [
        { character, costume },
        ...extraEntries.flatMap((entry) =>
          entry.character ? [{ character: entry.character, costume: entry.costume }] : [],
        ),
      ]
    : [];
  const supplement = buildCastSupplementTags(cast, scene);
  const composed = composedPrompts(form, supplement);

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
        ...extraEntries.flatMap((entry, index) => [
          entry.character === null ? `キャラ${index + 2}` : null,
          entry.character !== null && entry.member.costumeId !== null && entry.costume === null
            ? `衣装${index + 2}`
            : null,
        ]),
      ].filter((name): name is string => name !== null);

  const updateForm = useCallback(
    (update: Partial<ImageForm>) =>
      setStored((current) => ({ ...current, form: { ...(current.form ?? defaultForm(recipe)), ...update } })),
    [setStored, recipe],
  );
  // 対象を変えたら、外したタグを今の補完タグにあるものだけに絞る。前の対象で外した同名のタグが見えないまま外れ続けないようにする。
  const prunedTargetKey = useRef(targetKey);
  useEffect(() => {
    if (prunedTargetKey.current === targetKey || storyLoading || storyError !== null) return;
    prunedTargetKey.current = targetKey;
    setStored((current) =>
      current.form === null
        ? current
        : {
            ...current,
            form: {
              ...current.form,
              excludedPositive: current.form.excludedPositive.filter((tag) => isExcluded(tag, supplement.positive)),
              excludedNegative: current.form.excludedNegative.filter((tag) => isExcluded(tag, supplement.negative)),
            },
          },
    );
  }, [targetKey, storyLoading, storyError, supplement, setStored]);
  const changeTarget = useCallback(
    (next: ImageTarget) => setSearchParams(paramsFromTarget(next), { replace: true }),
    [setSearchParams],
  );
  // 参照・修正は1人ずつ。新規以外へ切り替えた時点で2人目以降が残っていれば、URLから外して知らせる。
  const extraCastCount = target.extraCast.length;
  useEffect(() => {
    if (mode === "txt2img" || extraCastCount === 0) return;
    changeTarget({ ...targetFromParams(new URLSearchParams(targetKey)), extraCast: [] });
    notifications.show({ color: "yellow", message: "参照・修正は1人ずつです。2人目以降を外しました" });
  }, [mode, extraCastCount, targetKey, changeTarget]);
  const updateDerive = useCallback(
    (update: Partial<DeriveState>) => setDerive((current) => ({ ...current, ...update })),
    [],
  );
  // 元画像を選んだら、その紐づけを対象へ引き継ぐ。紐づけの無い生成物なら対象も空にする。
  // アップロードは紐づけを持たず、今の対象のまま使う。
  // 元画像が変わると大きさが合わなくなるため、マスク画像は外す。
  // pickSeqは元画像を選び直すたびに進め、取り込みを待つ間に選び直されたら、待っていた結果を捨てる。
  const pickSeq = useRef(0);
  const pickSource = useCallback(
    (source: SourceImage) => {
      pickSeq.current += 1;
      setDerive((current) => ({ ...current, source, mask: null }));
      if (source.origin !== "upload") changeTarget(source.links);
    },
    [changeTarget],
  );
  // 取り込みを始めるときに呼び、取り込めたら返り値へ元画像を渡す。入力欄を切り替えた後でも反映する。
  const reservePick = useCallback(() => {
    const seq = ++pickSeq.current;
    return (source: SourceImage) => {
      if (seq === pickSeq.current) pickSource(source);
    };
  }, [pickSource]);
  // マスクは元画像に合わせて作るため、取り込みの間に元画像が変わったら捨てる。
  const reserveMask = useCallback(() => {
    const seq = pickSeq.current;
    return (mask: UploadedImage) => {
      if (seq === pickSeq.current) setDerive((current) => ({ ...current, mask }));
    };
  }, []);
  const clearSource = useCallback(() => {
    pickSeq.current += 1;
    setDerive((current) => ({ ...current, source: null, mask: null }));
  }, []);
  const sendToEdit = useCallback(
    (artifact: ArtifactRecord) => {
      pickSource(sourceFromArtifact(artifact));
      setMode("edit");
    },
    [pickSource],
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
        const restored = await restoreFromJob(client, jobId, recipe);
        applyRestored(restored);
        notifyRestored(restored, "生成物の設定を入力欄へ戻しました");
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
      const restored = await restoreFromJob(client, jobId, recipe);
      applyRestored(restored);
      notifyRestored(restored, "設定を入力欄へ戻しました");
    } catch (error) {
      notifyError("設定を入力欄へ戻せませんでした", error);
    } finally {
      setRestoringJobId(null);
    }
  };

  const deriveMode = mode === "txt2img" ? null : mode;
  const deriveTemplate = deriveMode === null ? null : templateOfDerive(deriveMode, derive);
  const deriveRecipe = deriveTemplate === null ? null : (deriveRecipes[deriveTemplate] ?? null);
  // 方式が決まる前の参照・修正タブは、入力欄の表示だけ代表のRecipeに合わせる。
  const fallbackTemplate = mode === "ref" ? REF_SIGLIP_TEMPLATE : IMG2IMG_TEMPLATE;
  const paramsRecipe = deriveMode === null ? recipe : (deriveRecipe ?? deriveRecipes[fallbackTemplate] ?? recipe);
  const blockedReason = deriveMode === null ? null : deriveBlockedReason(deriveMode, derive, deriveRecipe);
  const promptNeeded = usesPrompt(mode, derive);
  // スイープは新規タブだけで使う。オンの間は、軸の入力が不正でも投入しない。
  const sweepPlan = planSweep(form);
  const sweepOn = mode === "txt2img" && form.sweepEnabled;
  const canSubmit =
    (!promptNeeded || composed.positive !== "") &&
    !storyLoading &&
    storyError === null &&
    missing.length === 0 &&
    blockedReason === null &&
    (!sweepOn || sweepPlan.ok);
  const onSubmit = () => {
    if (sweepOn) {
      if (!sweepPlan.ok) return;
      submitSweep.mutate(buildSweepBody(sweepPlan, form, supplement, recipe, target, new Date()), {
        onError: (error) => notifyError("スイープを投入できませんでした", error),
      });
      return;
    }
    const submitRecipe = deriveMode === null ? recipe : deriveRecipe;
    if (submitRecipe === null) return;
    submit.mutate(
      {
        kind: "image",
        recipe_id: submitRecipe.id,
        use_inherited_defaults: false,
        project_id: target.projectId,
        story_scene_id: target.sceneId,
        story_character_id: target.characterId,
        story_costume_id: target.costumeId,
        inputs:
          deriveMode === null
            ? buildInputs(form, supplement, recipe)
            : buildDeriveInputs(deriveMode, derive, form, supplement, submitRecipe),
      },
      {
        onSuccess: (job) => results.add({ jobId: job.id, count: resultCountOf(submitRecipe, form) }),
        onError: (error) => notifyError("投入できませんでした", error),
      },
    );
  };

  const promptFields = (
    <PromptFields
      supplementPositive={supplement.positive}
      supplementSections={
        supplement.groups === null
          ? undefined
          : [{ label: "共通", tags: supplement.head }, ...supplement.groups].filter((section) => section.tags.length > 0)
      }
      supplementNegative={supplement.negative}
      excludedPositive={form.excludedPositive}
      excludedNegative={form.excludedNegative}
      positiveFree={form.positiveFree}
      negativeFree={form.negativeFree}
      composedPositive={composed.positive}
      composedNegative={composed.negative}
      assist={
        <PromptAssistPanel
          recipeId={recipe.id}
          contextTags={supplement.positive.filter((tag) => !isExcluded(tag, form.excludedPositive))}
          positiveFree={form.positiveFree}
          onApply={(positiveFree) => updateForm({ positiveFree })}
        />
      }
      onChange={updateForm}
    />
  );
  const sourcePicker = (
    <SourceImagePicker
      source={derive.source}
      onPick={pickSource}
      reservePick={reservePick}
      onClear={clearSource}
      target={target}
      characters={characterList}
    />
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
            multi={multi}
          />
          {storyError ? <Alert color="red">{storyError.message}</Alert> : null}
          <Tabs keepMounted={false} value={mode} onChange={(value) => value !== null && setMode(value as GenerateMode)}>
            <Tabs.List>
              <Tabs.Tab value="txt2img">新規</Tabs.Tab>
              <Tabs.Tab value="ref">参照</Tabs.Tab>
              <Tabs.Tab value="edit">修正</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="txt2img" pt="sm">
              <Stack gap="md">
                {promptFields}
                <ParamsFields
                  form={form}
                  onChange={updateForm}
                  recipe={recipe}
                  detailSweep={<SweepFields form={form} onChange={updateForm} plan={sweepPlan} />}
                />
              </Stack>
            </Tabs.Panel>
            <Tabs.Panel value="ref" pt="sm">
              <Stack gap="md">
                {sourcePicker}
                <RefFields state={derive} onChange={updateDerive} />
                {promptFields}
                <ParamsFields
                  form={form}
                  onChange={updateForm}
                  recipe={paramsRecipe}
                  detailExtra={<RefStrengthField state={derive} onChange={updateDerive} />}
                />
              </Stack>
            </Tabs.Panel>
            <Tabs.Panel value="edit" pt="sm">
              <Stack gap="md">
                {sourcePicker}
                <EditFields
                  state={derive}
                  onChange={updateDerive}
                  reserveMask={reserveMask}
                  img2imgRecipe={deriveRecipes[IMG2IMG_TEMPLATE] ?? null}
                />
                {promptNeeded ? (
                  <>
                    {promptFields}
                    <ParamsFields form={form} onChange={updateForm} recipe={paramsRecipe} />
                  </>
                ) : null}
              </Stack>
            </Tabs.Panel>
          </Tabs>
          {blockedReason !== null ? (
            <Text size="xs" c="dimmed" data-testid="blocked-reason">
              {blockedReason}
            </Text>
          ) : null}
          {sweepOn ? (
            <Text size="xs" c={sweepPlan.ok ? undefined : "red"} data-testid="sweep-submit-note">
              {sweepPlan.ok ? `スイープ: ${sweepPlan.summary}` : `スイープを投入できません: ${sweepPlan.reason}`}
            </Text>
          ) : null}
          <Button onClick={onSubmit} disabled={!canSubmit} loading={submit.isPending || submitSweep.isPending}>
            {sweepOn ? "スイープを生成" : "生成"}
          </Button>
        </Stack>
      </Grid.Col>
      <Grid.Col span={{ base: 12, lg: 7 }}>
        <ResultPanel
          entries={results.entries}
          onRemove={results.remove}
          onRestore={(jobId) => void restoreJob(jobId)}
          restoringJobId={restoringJobId}
          onSendToEdit={sendToEdit}
          sweeps={sweeps.entries}
          onRemoveSweep={sweeps.remove}
        />
      </Grid.Col>
    </Grid>
  );
}

/** `/image`。新規・参照・修正の入力欄と、この画面から投入した生成の結果欄。 */
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
