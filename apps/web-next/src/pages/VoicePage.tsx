import { Alert, Button, Grid, Group, Select, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import type { Recipe, StoryCharacter, StorySceneDialogue } from "../api/client";
import { FROM_ARTIFACT_PARAM, restoreFromArtifactParam } from "../imageGen/artifactRestore";
import { notifyError } from "../notifications";
import { useCharacters, useScenes } from "../projectDetail/useStory";
import { useProjectList } from "../projects/useProjects";
import {
  characterOf,
  LINE_SKIP_REASONS,
  lineLabel,
  lineSkipOf,
  SceneLineList,
  speakerNameOf,
  voicedSpeakerOf,
  type LineNotice,
  type LineSkip,
} from "../voice/SceneLineList";
import {
  VOICE_STORAGE_KEYS,
  restoreVoiceFromJob,
  useStoredVoiceInput,
  useSubmitVoiceJob,
  useVoiceResultEntries,
  type VoiceStorageKeys,
} from "../voice/useVoice";
import { VoiceLineFields, VoiceParamsFields, VoiceSourceFields } from "../voice/VoiceFields";
import { VoiceResultPanel } from "../voice/VoiceResultPanel";
import {
  buildVoiceBody,
  defaultVoiceForm,
  formForLine,
  voiceProblem,
  type VoiceForm,
  type VoiceReferenceFile,
  type VoiceTarget,
} from "../voice/voiceForm";
import { WithVoiceRecipe } from "../voice/WithVoiceRecipe";

/** URLのクエリ名。 */
const PROJECT_PARAM = "project";
const SCENE_PARAM = "scene";

/** 台詞の行の候補に出す本文の長さの上限。 */
const LINE_LABEL_MAX = 24;

function targetFromParams(params: URLSearchParams): VoiceTarget {
  return { projectId: params.get(PROJECT_PARAM) || null, sceneId: params.get(SCENE_PARAM) || null };
}

function paramsFromTarget(target: VoiceTarget): URLSearchParams {
  const params = new URLSearchParams();
  if (target.projectId) params.set(PROJECT_PARAM, target.projectId);
  if (target.sceneId) params.set(SCENE_PARAM, target.sceneId);
  return params;
}

function hasAny(target: VoiceTarget | null): boolean {
  return target !== null && (target.projectId !== null || target.sceneId !== null);
}

/**
 * 開いたURLに対象が無ければ、最後に使った対象へ戻す。ナビはProjectだけを引き継ぐため、
 * Projectだけが前回と同じなら、Sceneも前回の値へ戻す。
 */
function initialTarget(fromUrl: VoiceTarget, stored: VoiceTarget | null): VoiceTarget | null {
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

/** 台詞の行の候補。行ID (採用先の指定に使う) を持たない行は選べないので除く。 */
function lineOptions(
  dialogues: { id?: string | null; speaker_character_id: string; text: string }[],
  characters: StoryCharacter[],
) {
  return dialogues.flatMap((line, index) => {
    if (!line.id) return [];
    const speaker = speakerNameOf(characters, line.speaker_character_id);
    const text = [...line.text].length > LINE_LABEL_MAX ? `${[...line.text].slice(0, LINE_LABEL_MAX).join("")}…` : line.text;
    return [{ value: line.id, label: `${index + 1}. ${speaker}: ${text}` }];
  });
}

export type VoiceWorkspaceProps = {
  recipe: Recipe;
  target: VoiceTarget;
  /** 対象を変えられる画面 (`/voice`) だけが渡す。省略すると対象を固定し、選択欄は変えられず、前回の対象も戻さない。 */
  onTargetChange?: (next: VoiceTarget) => void;
  /** 入力欄と結果欄の保存キー。 */
  storageKeys: VoiceStorageKeys;
  /** `?from_artifact=`の生成物ID。あれば、開いたときにその生成設定を入力欄へ戻す。 */
  fromArtifact?: string | null;
};

/** 音声の入力欄・台詞の一覧・結果欄。`/voice`とシーン生成の音声の工程が使う。 */
export function VoiceWorkspace({ recipe, target, onTargetChange, storageKeys, fromArtifact = null }: VoiceWorkspaceProps) {
  const [stored, setStored] = useStoredVoiceInput(recipe, storageKeys.input);
  const client = useQueryClient();
  const results = useVoiceResultEntries(storageKeys.results);
  const submit = useSubmitVoiceJob();
  const [lineNotice, setLineNotice] = useState<LineNotice | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);

  const targetKey = paramsFromTarget(target).toString();
  const form = stored.form ?? defaultVoiceForm(recipe);

  const projects = useProjectList("active");
  const scenes = useScenes(target.projectId);
  const characters = useCharacters(target.projectId);
  const sceneList = scenes.data ?? [];
  const characterList = characters.data ?? [];
  const scene = sceneList.find((item) => item.id === target.sceneId) ?? null;
  // 一覧に無い話者・台詞の行 (別のProjectで選んだ値など) は、選んでいないものとして扱う。
  const character = target.projectId === null ? null : characterOf(characterList, form.speakerId);
  const lines = lineOptions(scene?.dialogues ?? [], characterList);
  const dialogueId = lines.some((line) => line.value === form.dialogueId) ? form.dialogueId : null;

  // ゴミ箱・削除済みのProjectは有効な一覧に無い。投入を止める。
  const projectMissing =
    target.projectId !== null &&
    projects.data !== undefined &&
    !projects.data.some((item) => item.id === target.projectId);
  // Projectが無いと分かれば、Scene・キャラの一覧は404になるだけなので待たない。
  const storyLoading =
    target.projectId !== null &&
    (projects.isPending || (!projectMissing && (scenes.isPending || characters.isPending)));
  // 一覧を取得できなかったときは、あるかどうかが分からない。「見つかりません」と誤案内せず、取得失敗として投入を止める。
  const loadError =
    target.projectId === null
      ? null
      : (projects.error ?? (projectMissing ? null : (scenes.error ?? characters.error)) ?? null);
  const missing =
    storyLoading || loadError !== null
      ? []
      : [projectMissing ? "Project" : null, target.sceneId !== null && scene === null ? "Scene" : null].filter(
          (name): name is string => name !== null,
        );

  // 対象を固定した画面は、入力欄を更新するときに対象も同じ更新で残す。
  // 別々に更新すると、後の更新が先の更新を打ち消すことがある。
  const fixed = !onTargetChange;
  const { projectId: fixedProjectId, sceneId: fixedSceneId } = target;
  const updateForm = useCallback(
    (update: Partial<VoiceForm>) =>
      setStored((current) => ({
        ...current,
        ...(fixed ? { target: { projectId: fixedProjectId, sceneId: fixedSceneId } } : {}),
        form: { ...(current.form ?? defaultVoiceForm(recipe)), ...update },
      })),
    [setStored, recipe, fixed, fixedProjectId, fixedSceneId],
  );
  // 話者にキャラを選んだら、そのキャラの声の参照をCloneに入れる。キャラを外したら、キャラの声を参照にしている状態を戻す。
  const changeForm = (update: Partial<VoiceForm>) => {
    if (!("speakerId" in update)) return updateForm(update);
    const picked = characterOf(characterList, update.speakerId ?? null);
    if (picked?.voice_media_key) return updateForm({ ...update, mode: "clone", referenceSource: "character" });
    return updateForm(form.referenceSource === "character" ? { ...update, referenceSource: "file" } : update);
  };
  // URLを書き換える。対象の変更で、前の対象に属する選択 (話者・台詞の行) は外す。
  const applyTarget = useCallback(
    (next: VoiceTarget) => onTargetChange?.(next),
    [onTargetChange],
  );
  const changeTarget = (next: VoiceTarget) => {
    if (next.projectId !== target.projectId || next.sceneId !== target.sceneId) setLineNotice(null);
    if (next.projectId !== target.projectId) {
      updateForm({
        speakerId: null,
        dialogueId: null,
        ...(form.referenceSource === "character" ? { referenceSource: "file" as const } : {}),
      });
    } else if (next.sceneId !== target.sceneId) {
      updateForm({ dialogueId: null });
    }
    applyTarget(next);
  };

  // `from_artifact`の設定を取りに行っている間は、入力欄を操作させず投入も止める (戻した値で上書きされるため)。
  const [restoring, setRestoring] = useState(() => fromArtifact !== null);

  // 対象を変えられる画面 (`/voice`) だけ、URLの対象を次に開いたときの復元用に残す。初回の復元を決めるまでは、空の対象で上書きしない。
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
        if (restored) applyTarget(restored);
      }
      return;
    }
    void restoreFromArtifactParam({
      client,
      artifactId: fromArtifact,
      restore: (jobId) => restoreVoiceFromJob(client, jobId, recipe),
      apply: (restored) => {
        setStored({ form: restored.form, target: restored.target });
        applyTarget(restored.target);
      },
      // 失敗したら、`from_artifact`の無い通常の起動と同じ対象 (前回の対象) に戻す。
      onFail: () => applyTarget(initialTarget(target, stored.target) ?? target),
    }).finally(() => setRestoring(false));
    // 依存配列は意図して空。開いたときの`target` / `stored.target`だけを使い、以後の変更では走らせない。
  }, []);

  const problem = voiceProblem(form, character);
  const canSubmit =
    !restoring && form.text.trim() !== "" && problem === null && !storyLoading && loadError === null && missing.length === 0;
  const dialogues = scene?.dialogues ?? [];
  const labelOf = (line: StorySceneDialogue, index: number) =>
    lineLabel(index, speakerNameOf(characterList, line.speaker_character_id));
  // 「台詞の行」で採用先を選んで投入したときも、結果欄にどの行の音声かを出す。
  const selectedIndex = dialogueId === null ? -1 : dialogues.findIndex((line) => line.id === dialogueId);
  const selectedLine = selectedIndex === -1 ? null : labelOf(dialogues[selectedIndex], selectedIndex);
  const onSubmit = () => {
    submit.mutate(
      {
        body: buildVoiceBody(form, recipe, target, character, dialogueId),
        onSubmitted: (job) => results.add({ jobId: job.id, text: form.text.trim(), line: selectedLine }),
      },
      { onError: (error) => notifyError("投入できませんでした", error) },
    );
  };

  // 台詞の一覧からの投入。行IDが無い行・台詞が空の行・話者のキャラに声の参照が無い行は投入しない。
  // 投入中は一覧の操作を止め、同じ行のJobが重ねて投入されないようにする。
  const linesDisabled = storyLoading || loadError !== null || missing.length > 0 || bulkRunning || submit.isPending;
  // `lineSkipOf`が`null`の行だけを渡す。話者のキャラに声があるので、Cloneでキャラの声を使う。
  const submitLine = (line: StorySceneDialogue, index: number, speaker: StoryCharacter) => {
    const lineForm = formForLine(form, line, true);
    return submit.mutateAsync({
      body: buildVoiceBody(lineForm, recipe, target, speaker, lineForm.dialogueId),
      onSubmitted: (job) => results.add({ jobId: job.id, text: line.text.trim(), line: labelOf(line, index) }),
    });
  };
  // 行の「投入」。行を入力欄へ読み込み、投入できる行ならそのまま1本投入する。
  const onSubmitLine = (line: StorySceneDialogue, index: number) => {
    const speaker = voicedSpeakerOf(characterList, line);
    updateForm(formForLine(form, line, speaker !== null));
    const skip = lineSkipOf(characterList, line);
    if (skip !== null || speaker === null) {
      setLineNotice({
        color: "yellow",
        text: `${labelOf(line, index)}は${LINE_SKIP_REASONS[skip ?? "noVoice"]}、入力欄へ読み込むだけで投入していません。`,
      });
      return;
    }
    setLineNotice(null);
    submitLine(line, index, speaker).catch((error: unknown) => notifyError("投入できませんでした", error));
  };
  // 「全行を投入」。1行1 Jobで上から順に投入する。失敗したら、そこで止めて以降の行は投入しない。
  const onSubmitAll = async () => {
    setBulkRunning(true);
    setLineNotice(null);
    const skipped: Record<LineSkip, string[]> = { noId: [], empty: [], noVoice: [] };
    const notSubmitted: string[] = [];
    let submitted = 0;
    let failedLabel: string | null = null;
    try {
      for (const [index, line] of dialogues.entries()) {
        const label = labelOf(line, index);
        if (failedLabel !== null) {
          notSubmitted.push(label);
          continue;
        }
        const skip = lineSkipOf(characterList, line);
        const speaker = voicedSpeakerOf(characterList, line);
        if (skip !== null || speaker === null) {
          skipped[skip ?? "noVoice"].push(label);
          continue;
        }
        try {
          await submitLine(line, index, speaker);
          submitted += 1;
        } catch (error) {
          failedLabel = label;
          notifyError(`${label}を投入できませんでした`, error);
        }
      }
    } finally {
      setBulkRunning(false);
    }
    const parts = [`${submitted}行を投入しました。`];
    if (failedLabel !== null) {
      parts.push(`${failedLabel}で失敗したため、そこで止めました。`);
      if (notSubmitted.length > 0) parts.push(`止めたため投入しなかった行: ${notSubmitted.join("、")}`);
    }
    for (const [skip, labels] of Object.entries(skipped) as [LineSkip, string[]][]) {
      if (labels.length > 0) parts.push(`${LINE_SKIP_REASONS[skip]}投入しなかった行: ${labels.join("、")}`);
    }
    const anySkipped = Object.values(skipped).some((labels) => labels.length > 0);
    setLineNotice({ color: failedLabel === null && !anySkipped ? "green" : "yellow", text: parts.join(" ") });
  };

  const applyReference = (reference: VoiceReferenceFile) =>
    updateForm({ mode: "clone", referenceSource: "file", reference });

  const projectOptions = (projects.data ?? []).map((project) => ({ value: project.id, label: project.name }));
  return (
    <Grid gap="lg">
      <Grid.Col span={{ base: 12, lg: 5 }}>
        <Stack gap="md" inert={restoring}>
          <Group justify={onTargetChange ? "space-between" : "flex-end"}>
            {onTargetChange ? <Title order={2}>音声</Title> : null}
            <Button
              variant="default"
              size="xs"
              onClick={() => setStored((current) => ({ ...current, form: defaultVoiceForm(recipe) }))}
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
              disabled={bulkRunning || !onTargetChange}
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
              disabled={target.projectId === null || bulkRunning || !onTargetChange}
              clearable
              error={scenes.error?.message}
            />
          </SimpleGrid>
          {loadError !== null ? (
            <Alert color="red" data-testid="target-load-error">
              Project・Scene・キャラの一覧を取得できないため、生成できません: {loadError.message}
            </Alert>
          ) : null}
          {missing.length > 0 ? (
            <Alert color="yellow" data-testid="target-missing">
              {missing.join("・")}が見つかりません。選び直してください。
            </Alert>
          ) : null}
          {scene !== null ? (
            <Select
              label="台詞の行"
              description="採用先にするSceneの台詞の行。選ぶと、できた音声をその行へ採用できます。本文は入りません。"
              placeholder="指定しない"
              data={lines}
              value={dialogueId}
              onChange={(next) => updateForm({ dialogueId: next })}
              clearable
              data-testid="voice-dialogue"
            />
          ) : null}
          {scene !== null && target.projectId !== null ? (
            <SceneLineList
              projectId={target.projectId}
              sceneId={scene.id}
              dialogues={dialogues}
              characters={characterList}
              disabled={linesDisabled}
              running={bulkRunning}
              notice={lineNotice}
              onDismissNotice={() => setLineNotice(null)}
              onSubmitLine={onSubmitLine}
              onSubmitAll={() => void onSubmitAll()}
            />
          ) : null}
          <VoiceLineFields
            form={form}
            onChange={changeForm}
            characters={characterList}
            speakerId={character?.id ?? null}
            projectSelected={target.projectId !== null}
            loadError={characters.error?.message}
          />
          <VoiceSourceFields form={form} onChange={changeForm} character={character} />
          <VoiceParamsFields form={form} onChange={changeForm} />
          {form.text.trim() === "" ? (
            <Text size="xs" c="dimmed">
              台詞文を入れると生成できます。
            </Text>
          ) : problem !== null ? (
            <Text size="xs" c="red" data-testid="voice-problem">
              {problem}
            </Text>
          ) : null}
          <Button onClick={onSubmit} disabled={!canSubmit || bulkRunning} loading={submit.isPending}>
            生成
          </Button>
        </Stack>
      </Grid.Col>
      <Grid.Col span={{ base: 12, lg: 7 }}>
        <VoiceResultPanel entries={results.entries} onRemove={results.remove} onUseReference={applyReference} />
      </Grid.Col>
    </Grid>
  );
}

/** `/voice`。台詞1行・話者・声の入力欄と、この画面から投入した生成の結果欄。 */
export function VoicePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  return (
    <WithVoiceRecipe>
      {(recipe) => (
        <VoiceWorkspace
          recipe={recipe}
          target={targetFromParams(searchParams)}
          onTargetChange={(next) => setSearchParams(paramsFromTarget(next), { replace: true })}
          storageKeys={VOICE_STORAGE_KEYS}
          fromArtifact={searchParams.get(FROM_ARTIFACT_PARAM)}
        />
      )}
    </WithVoiceRecipe>
  );
}
