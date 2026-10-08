import { Alert, Button, Grid, Group, Loader, Select, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import type { Recipe, StoryCharacter, StorySceneDialogue } from "../api/client";
import { notifyError } from "../notifications";
import { useCharacters, useScenes } from "../projectDetail/useStory";
import { useProjectList } from "../projects/useProjects";
import { lineLabel, SceneLineList, speakerNameOf, type LineNotice } from "../voice/SceneLineList";
import { useStoredVoiceInput, useSubmitVoiceJob, useVoiceRecipe, useVoiceResultEntries } from "../voice/useVoice";
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
    const speaker = characters.find((character) => character.id === line.speaker_character_id)?.name ?? "(不明)";
    const text = [...line.text].length > LINE_LABEL_MAX ? `${[...line.text].slice(0, LINE_LABEL_MAX).join("")}…` : line.text;
    return [{ value: line.id, label: `${index + 1}. ${speaker}: ${text}` }];
  });
}

function VoiceWorkspace({ recipe }: { recipe: Recipe }) {
  const [stored, setStored] = useStoredVoiceInput(recipe);
  const [searchParams, setSearchParams] = useSearchParams();
  const results = useVoiceResultEntries();
  const submit = useSubmitVoiceJob();
  const [lineNotice, setLineNotice] = useState<LineNotice | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);

  const target = targetFromParams(searchParams);
  const targetKey = paramsFromTarget(target).toString();
  const form = stored.form ?? defaultVoiceForm(recipe);

  const projects = useProjectList("active");
  const scenes = useScenes(target.projectId);
  const characters = useCharacters(target.projectId);
  const sceneList = scenes.data ?? [];
  const characterList = characters.data ?? [];
  const scene = sceneList.find((item) => item.id === target.sceneId) ?? null;
  // 一覧に無い話者・台詞の行 (別のProjectで選んだ値など) は、選んでいないものとして扱う。
  const character = target.projectId === null ? null : (characterList.find((item) => item.id === form.speakerId) ?? null);
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

  const updateForm = useCallback(
    (update: Partial<VoiceForm>) =>
      setStored((current) => ({ ...current, form: { ...(current.form ?? defaultVoiceForm(recipe)), ...update } })),
    [setStored, recipe],
  );
  // 話者にキャラを選んだら、そのキャラの声の参照をCloneに入れる。キャラを外したら、キャラの声を参照にしている状態を戻す。
  const changeForm = (update: Partial<VoiceForm>) => {
    if (!("speakerId" in update)) return updateForm(update);
    const picked = characterList.find((item) => item.id === update.speakerId) ?? null;
    if (picked?.voice_media_key) return updateForm({ ...update, mode: "clone", referenceSource: "character" });
    return updateForm(form.referenceSource === "character" ? { ...update, referenceSource: "file" } : update);
  };
  // URLを書き換える。対象の変更で、前の対象に属する選択 (話者・台詞の行) は外す。
  const applyTarget = useCallback(
    (next: VoiceTarget) => setSearchParams(paramsFromTarget(next), { replace: true }),
    [setSearchParams],
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

  // URLの対象を、次に開いたときの復元用に残す。初回の復元を決めるまでは、空の対象で上書きしない。
  // 2つのeffectは宣言順に走る順序に依存する。初回は、ここが`initialized`がfalseのため何もせず、
  // 次のeffectが`true`にして復元する。復元でURLが変わると`targetKey`が変わり、ここが保存する。
  // 2つの順序を入れ替えると、初回に空の対象を保存して前回の対象を失う。
  const initialized = useRef(false);
  useEffect(() => {
    if (!initialized.current) return;
    setStored((current) => ({ ...current, target: targetFromParams(new URLSearchParams(targetKey)) }));
  }, [targetKey, setStored]);
  // 開いたときに一度だけ、最後に使った対象を戻す。
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const restored = initialTarget(target, stored.target);
    if (restored) applyTarget(restored);
    // 依存配列は意図して空。開いたときの`target` / `stored.target`だけを使い、以後の変更では走らせない。
  }, []);

  const problem = voiceProblem(form, character);
  const canSubmit =
    form.text.trim() !== "" && problem === null && !storyLoading && loadError === null && missing.length === 0;
  const dialogues = scene?.dialogues ?? [];
  const labelOf = (line: StorySceneDialogue, index: number) =>
    lineLabel(index, speakerNameOf(characterList, line.speaker_character_id));
  // 「台詞の行」で採用先を選んで投入したときも、結果欄にどの行の音声かを出す。
  const selectedIndex = dialogueId === null ? -1 : dialogues.findIndex((line) => line.id === dialogueId);
  const selectedDialogue = dialogues[selectedIndex];
  const selectedLine = selectedDialogue ? labelOf(selectedDialogue, selectedIndex) : null;
  const onSubmit = () => {
    submit.mutate(
      {
        body: buildVoiceBody(form, recipe, target, character, dialogueId),
        onSubmitted: (job) => results.add({ jobId: job.id, text: form.text.trim(), line: selectedLine }),
      },
      { onError: (error) => notifyError("投入できませんでした", error) },
    );
  };

  // 台詞の一覧からの投入。話者のキャラに声の参照が無い行は投入しない。
  const linesDisabled = storyLoading || loadError !== null || missing.length > 0 || bulkRunning;
  const voicedSpeakerOf = (line: StorySceneDialogue) => {
    const speaker = characterList.find((item) => item.id === line.speaker_character_id) ?? null;
    return speaker?.voice_media_key ? speaker : null;
  };
  const submitLine = (line: StorySceneDialogue, index: number, speaker: StoryCharacter) => {
    const lineForm = formForLine(form, line, true);
    return submit.mutateAsync({
      body: buildVoiceBody(lineForm, recipe, target, speaker, lineForm.dialogueId),
      onSubmitted: (job) => results.add({ jobId: job.id, text: line.text.trim(), line: labelOf(line, index) }),
    });
  };
  // 行の「投入」。行を入力欄へ読み込み、声があればそのまま1本投入する。
  const onSubmitLine = (line: StorySceneDialogue, index: number) => {
    const speaker = voicedSpeakerOf(line);
    updateForm(formForLine(form, line, speaker !== null));
    if (speaker === null) {
      setLineNotice({
        color: "yellow",
        text: `${labelOf(line, index)}は話者のキャラに声の参照が無いため、入力欄へ読み込むだけで投入していません。`,
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
    const skipped: string[] = [];
    let submitted = 0;
    let failedAt: string | null = null;
    try {
      for (const [index, line] of dialogues.entries()) {
        const speaker = voicedSpeakerOf(line);
        if (speaker === null) {
          skipped.push(labelOf(line, index));
          continue;
        }
        try {
          await submitLine(line, index, speaker);
          submitted += 1;
        } catch (error) {
          failedAt = labelOf(line, index);
          notifyError(`${failedAt}を投入できませんでした`, error);
          break;
        }
      }
    } finally {
      setBulkRunning(false);
    }
    const parts = [`${submitted}行を投入しました。`];
    if (failedAt !== null) parts.push(`${failedAt}で失敗したため、以降の行は投入していません。`);
    if (skipped.length > 0) parts.push(`声の参照が無いため投入しなかった行: ${skipped.join("、")}`);
    setLineNotice({ color: failedAt === null && skipped.length === 0 ? "green" : "yellow", text: parts.join(" ") });
  };

  const applyReference = (reference: VoiceReferenceFile) =>
    updateForm({ mode: "clone", referenceSource: "file", reference });

  const projectOptions = (projects.data ?? []).map((project) => ({ value: project.id, label: project.name }));
  return (
    <Grid gap="lg">
      <Grid.Col span={{ base: 12, lg: 5 }}>
        <Stack gap="md">
          <Group justify="space-between">
            <Title order={2}>音声</Title>
            <Button
              variant="default"
              size="xs"
              onClick={() => setStored((current) => ({ ...current, form: defaultVoiceForm(recipe) }))}
            >
              リセット
            </Button>
          </Group>
          <SimpleGrid cols={2} spacing="xs">
            <Select
              label="Project"
              placeholder="指定しない"
              data={withCurrent(projectOptions, target.projectId, projects.isError)}
              value={target.projectId}
              onChange={(projectId) => changeTarget({ projectId, sceneId: null })}
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
              disabled={target.projectId === null}
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
          <Button onClick={onSubmit} disabled={!canSubmit} loading={submit.isPending}>
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
  const recipe = useVoiceRecipe();
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
      <Alert color="yellow" title="音声生成のRecipeがありません">
        音声のRecipeを登録してから開いてください。
      </Alert>
    );
  }
  return <VoiceWorkspace recipe={recipe.data} />;
}
