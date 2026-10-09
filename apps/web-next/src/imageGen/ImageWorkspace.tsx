import { Alert, Button, Grid, Group, Stack, Tabs, Text, Title, useMantineTheme } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ArtifactRecord, Recipe } from "../api/client";
import { EditFields, RefFields, RefStrengthField } from "./DeriveFields";
import { ParamsFields } from "./ParamsFields";
import { PromptAssistPanel } from "./PromptAssistPanel";
import { PromptFields } from "./PromptFields";
import { ResultPanel } from "./ResultPanel";
import { SourceImagePicker } from "./SourceImagePicker";
import { SweepFields } from "./SweepFields";
import { TargetPicker } from "./TargetPicker";
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
} from "./deriveForm";
import {
  buildInputs,
  composedPrompts,
  defaultForm,
  imageJobBody,
  type ImageForm,
  type ImageStorageKeys,
  type ImageTarget,
} from "./imageForm";
import { buildCastSupplementTags, castEntriesOf, isExcluded } from "./promptTags";
import { buildSweepBody, planSweep } from "./sweep";
import { initialTarget, paramsFromTarget, targetFromParams } from "./targetParams";
import {
  jobIdOfArtifact,
  restoreFromJob,
  useDeriveRecipes,
  useProjectStory,
  useResultEntries,
  useStoredInput,
  useSubmitImageJob,
  type RestoredInput,
} from "./useImageGen";
import { useSubmitSweep, useSweepEntries } from "./useSweep";
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

export type ImageWorkspaceProps = {
  recipe: Recipe;
  /** 生成の対象 (Project・Scene・キャラ・衣装・2人目以降)。 */
  target: ImageTarget;
  /**
   * 対象を変えるとき (対象の選択、元画像の紐づけ、設定を戻したとき) に呼ぶ。
   * 渡さなければ対象は`target`に固定され、対象の選択欄を出さず、開いたときの対象の復元もしない。
   */
  onTargetChange?: (next: ImageTarget) => void;
  /** 入力値・結果欄・スイープの保存先。画面ごとに分けて、互いの保存値を上書きしない。 */
  storageKeys: ImageStorageKeys;
  /** 補完タグにSceneの背景・時間帯・ポーズ・表情を含めるか。falseならキャラと衣装の分だけ。 */
  includeScene?: boolean;
  /** 開いたときに設定を入力欄へ戻す生成物のid (`/image`の`from_artifact`)。 */
  fromArtifact?: string | null;
  title?: string;
  /**
   * `lg`以上で、左右のペインを表示領域の高さに収め、それぞれ個別にスクロールさせるか。
   * ステッパーの下に埋め込む画面では、縦のスクロールが二重になるので渡さない。
   */
  paneScroll?: boolean;
};

/** AppShell.Mainの上下の余白とヘッダーを除いた、表示領域の高さ。 */
const PANE_HEIGHT = "calc(100dvh - var(--app-shell-header-offset, 0rem) - 2 * var(--app-shell-padding))";

export function ImageWorkspace({
  recipe,
  target,
  onTargetChange,
  storageKeys,
  includeScene = true,
  fromArtifact = null,
  title = "画像",
  paneScroll = false,
}: ImageWorkspaceProps) {
  const theme = useMantineTheme();
  const wide = useMediaQuery(`(min-width: ${theme.breakpoints.lg})`);
  const paneStyle = paneScroll && wide ? { height: PANE_HEIGHT, overflowY: "auto" as const } : undefined;
  const client = useQueryClient();
  const [stored, setStored] = useStoredInput(recipe, storageKeys.input);
  const results = useResultEntries(storageKeys.results);
  const submit = useSubmitImageJob();
  const submitSweep = useSubmitSweep(storageKeys.sweeps);
  const sweeps = useSweepEntries(storageKeys.sweeps);
  const [restoringJobId, setRestoringJobId] = useState<string | null>(null);
  const [mode, setMode] = useState<GenerateMode>("txt2img");
  const [derive, setDerive] = useState<DeriveState>(INITIAL_DERIVE);
  const deriveRecipes = useDeriveRecipes().data ?? {};

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
  const cast = castEntriesOf(target, characterList, multi);
  const supplement = buildCastSupplementTags(cast, includeScene ? scene : null);
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
    (next: ImageTarget) => onTargetChange?.(next),
    [onTargetChange],
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
      changeTarget(restored.target);
    },
    [setStored, changeTarget],
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
    if (onTargetChange === undefined) return;
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
    // 投入のPOSTが返る前に別画面へ移っても結果欄へ記録できるよう、mutateのコールバックでなくPromiseで受ける。
    // mutateのコールバックは、画面が外れると呼ばれない。
    submit
      .mutateAsync(
        imageJobBody(
          submitRecipe,
          target,
          deriveMode === null
            ? buildInputs(form, supplement, recipe)
            : buildDeriveInputs(deriveMode, derive, form, supplement, submitRecipe),
        ),
      )
      .then(
        (job) => results.add({ jobId: job.id, count: resultCountOf(submitRecipe, form) }),
        (error: unknown) => notifyError("投入できませんでした", error),
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
      <Grid.Col span={{ base: 12, lg: 5 }} style={paneStyle}>
        <Stack gap="md">
          <Group justify="space-between">
            <Title order={2}>{title}</Title>
            <Button variant="default" size="xs" onClick={() => setStored((current) => ({ ...current, form: defaultForm(recipe) }))}>
              リセット
            </Button>
          </Group>
          {onTargetChange ? (
            <TargetPicker
              target={target}
              onChange={changeTarget}
              characters={characterList}
              scenes={sceneList}
              missing={missing}
              multi={multi}
            />
          ) : missing.length > 0 ? (
            <Alert color="yellow" title="指定した対象が見つかりません">
              {missing.join("・")}を確かめてください。
            </Alert>
          ) : null}
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
      <Grid.Col span={{ base: 12, lg: 7 }} style={paneStyle}>
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
