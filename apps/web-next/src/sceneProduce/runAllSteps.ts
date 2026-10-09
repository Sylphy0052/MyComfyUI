import { apiRequest, artifactContentUrl, type MusicPromptAssist } from "../api/client";
import { fetchAdoptedVideoSeconds, RESULTS_MAX as BGM_RESULTS_MAX } from "../bgm/useBgm";
import { suggestedBgmTags } from "../bgm/BgmTagAssist";
import { BGM_TEMPLATE, bgmJobBody, buildBgmInputs, defaultBgmForm, defaultSeconds } from "../bgm/bgmForm";
import { buildInputs, composedPrompts, defaultForm, imageJobBody, TXT2IMG_TEMPLATE } from "../imageGen/imageForm";
import { buildCastSupplementTags, castEntriesOf } from "../imageGen/promptTags";
import { addCostumeReference, putAdoption, RESULTS_MAX as IMAGE_RESULTS_MAX } from "../imageGen/useImageGen";
import { INSTRUCTION_MAX } from "../promptAssist/useInstructionAssist";
import {
  buildVideoInputs,
  defaultDraft,
  fillDraftFromScene,
  videoBlockedReason,
  videoJobBody,
  VIDEO_TEMPLATES,
} from "../videoGen/videoForm";
import { RESULTS_MAX as VIDEO_RESULTS_MAX } from "../videoGen/useVideoGen";
import { LINE_SKIP_REASONS, lineLabel, lineSkipOf, speakerNameOf, voicedSpeakerOf } from "../voice/SceneLineList";
import { RESULTS_MAX as VOICE_RESULTS_MAX, TEXT_PREVIEW_MAX as VOICE_TEXT_PREVIEW_MAX } from "../voice/useVoice";
import { buildVoiceBody, defaultVoiceForm, formForLine } from "../voice/voiceForm";
import {
  buildComposeInputs,
  COMPOSE_TEMPLATE,
  type ComposeVoiceInput,
  composeJobBody,
  DEFAULT_BGM_VOLUME,
  DEFAULT_VOICE_VOLUME,
  exceedsVideo,
  MAX_VOICE_TRACKS,
  packedStarts,
  roundSec,
  voiceRowsOf,
} from "./composeForm";
import {
  fetchAdoptions,
  fetchCharacters,
  fetchRecipe,
  loadDuration,
  messageOf,
  RunBlocked,
  type RunContext,
  stepsToRun,
  submitAndWait,
} from "./runAll";
import { characterTargetOf, sceneImageTargetOf, videoTargetOf } from "./stepTargets";
import {
  appendResultEntry,
  bgmKeysOf,
  characterKeysOf,
  composeResultsKeyOf,
  sceneImageKeysOf,
  videoKeysOf,
  voiceKeysOf,
} from "./storageKeys";
import type { StepId } from "./steps";

// 一括実行の工程ごとの中身。各工程の画面の既定の入力 (Projectから埋めた値) で1回だけ生成し、最初の候補を採用する。
// 入力の組み立ては画面と同じ関数 (`imageJobBody`・`buildInputs`・`bgmJobBody`・`videoJobBody`・`composeJobBody`など) を使う。

type StepOutcome = "done" | "skipped";

const txt2imgRecipe = (ctx: RunContext) =>
  fetchRecipe(ctx.client, "image", "画像", (recipes) =>
    recipes.find((recipe) => recipe.workflow_template_ref.name === TXT2IMG_TEMPLATE),
  );

/** キャラ画像。参照画像が無い衣装ごとに1枚生成して、その衣装の参照へ足す。 */
async function runCharacter(ctx: RunContext): Promise<StepOutcome> {
  const { client, projectId, scene } = ctx;
  const characters = await fetchCharacters(client, projectId);
  const done = new Set<string>();
  const todo: { characterId: string; costumeId: string }[] = [];
  for (const entry of scene.cast) {
    const character = characters.find((item) => item.id === entry.character_id);
    if (!character) {
      ctx.notice("キャラが見つからない登場は、キャラ画像を生成しません。");
      continue;
    }
    if (!entry.costume_id) {
      // 衣装の指定が無い登場は、肖像を参照画像とみなす。肖像も無ければ生成先が無い。
      if (!character.portrait_media_key) {
        ctx.notice(`${character.name}は衣装の指定も肖像も無いため、キャラ画像を生成しません。`);
      }
      continue;
    }
    const costume = character.costumes.find((item) => item.id === entry.costume_id);
    if (!costume) {
      ctx.notice(`${character.name}の衣装が見つからないため、キャラ画像を生成しません。`);
      continue;
    }
    if (costume.reference_images.length > 0 || done.has(costume.id)) continue;
    done.add(costume.id);
    todo.push({ characterId: character.id, costumeId: costume.id });
  }
  if (todo.length === 0) return "skipped";

  const recipe = await txt2imgRecipe(ctx);
  for (const { characterId, costumeId } of todo) {
    const latest = await fetchCharacters(client, projectId);
    const character = latest.find((item) => item.id === characterId);
    const costume = character?.costumes.find((item) => item.id === costumeId);
    if (!character || !costume) throw new RunBlocked("キャラまたは衣装が途中で見つからなくなりました");
    const target = characterTargetOf(projectId, characterId, costumeId);
    const supplement = buildCastSupplementTags(castEntriesOf(target, latest, false), null);
    const form = defaultForm(recipe);
    if (composedPrompts(form, supplement).positive === "") {
      throw new RunBlocked(`${character.name}のキャラ画像のプロンプトが空です`);
    }
    const { artifact } = await submitAndWait(
      ctx,
      imageJobBody(recipe, target, buildInputs(form, supplement, recipe)),
      "image",
      (job) =>
        appendResultEntry(
          characterKeysOf(characterId, costumeId).results,
          { jobId: job.id, count: 1 },
          IMAGE_RESULTS_MAX,
        ),
    );
    await addCostumeReference(client, projectId, costume, artifact.id);
  }
  return "done";
}

/** シーン画像。シーン画像の画面と同じ補完タグ・既定値で1枚生成して採用する。 */
async function runSceneImage(ctx: RunContext): Promise<StepOutcome> {
  const { client, projectId, scene } = ctx;
  const characters = await fetchCharacters(client, projectId);
  const recipe = await txt2imgRecipe(ctx);
  const target = sceneImageTargetOf(projectId, scene);
  const supplement = buildCastSupplementTags(castEntriesOf(target, characters, true), scene);
  const form = defaultForm(recipe);
  if (composedPrompts(form, supplement).positive === "") {
    throw new RunBlocked("シーン画像のプロンプトが空です。シーンの背景・ポーズなどか、キャラのタグを入力してください");
  }
  const { artifact } = await submitAndWait(
    ctx,
    imageJobBody(recipe, target, buildInputs(form, supplement, recipe)),
    "image",
    (job) =>
      appendResultEntry(
        sceneImageKeysOf(scene.id).results,
        { jobId: job.id, count: 1 },
        IMAGE_RESULTS_MAX,
      ),
  );
  await putAdoption(projectId, scene.id, "scene_image", artifact.id);
  return "done";
}

/** 音声。台詞を1行1 Jobで順に投入し、行ごとに最初の候補を採用する。声の参照が無い話者の行は飛ばす。 */
async function runVoice(ctx: RunContext): Promise<StepOutcome> {
  const { client, projectId, scene } = ctx;
  // 一括実行では`stepsToRun`が先に外すので通らない。単体で呼ばれたときの保険として残す
  if (scene.dialogues.length === 0) return "skipped";
  const characters = await fetchCharacters(client, projectId);
  const recipe = await fetchRecipe(client, "voice", "音声", (recipes) => recipes[0]);
  const base = defaultVoiceForm(recipe);
  let submitted = 0;
  for (const [index, line] of scene.dialogues.entries()) {
    const label = lineLabel(index, speakerNameOf(characters, line.speaker_character_id));
    const skip = lineSkipOf(characters, line);
    const speaker = voicedSpeakerOf(characters, line);
    if (skip !== null || speaker === null) {
      ctx.notice(`${label}は${LINE_SKIP_REASONS[skip ?? "noVoice"]}、音声を投入しませんでした。`);
      continue;
    }
    const adoptions = await fetchAdoptions(client, projectId, scene.id);
    if (adoptions.some((item) => item.slot === "voice" && item.dialogue_id === line.id)) continue;
    const lineForm = formForLine(base, line, true);
    const { artifact } = await submitAndWait(
      ctx,
      buildVoiceBody(lineForm, recipe, { projectId, sceneId: scene.id }, speaker, lineForm.dialogueId),
      "audio",
      (job) =>
        appendResultEntry(
          voiceKeysOf(scene.id).results,
          { jobId: job.id, text: line.text.trim().slice(0, VOICE_TEXT_PREVIEW_MAX), line: label },
          VOICE_RESULTS_MAX,
        ),
    );
    await putAdoption(projectId, scene.id, "voice", artifact.id, line.id ?? null);
    submitted += 1;
  }
  return submitted > 0 ? "done" : "skipped";
}

/** BGM。シーンの`bgm_mood`を`/music-prompt-assists`でタグにして、既定の長さで1曲生成する。 */
async function runBgm(ctx: RunContext): Promise<StepOutcome> {
  const { client, projectId, scene } = ctx;
  const mood = scene.bgm_mood.trim();
  if (mood === "") throw new RunBlocked("シーンのBGMの雰囲気 (bgm_mood) が空のため、BGMのタグを作れません");
  if (mood.length > INSTRUCTION_MAX) {
    throw new RunBlocked(`シーンのBGMの雰囲気が長すぎます (${INSTRUCTION_MAX}文字まで)`);
  }
  const recipe = await fetchRecipe(client, "music", "BGM", (recipes) =>
    recipes.find((item) => item.workflow_template_ref.name === BGM_TEMPLATE),
  );
  let tags: string;
  try {
    const assist = await apiRequest<MusicPromptAssist>("/music-prompt-assists", {
      method: "POST",
      body: JSON.stringify({ instruction: mood }),
    });
    tags = suggestedBgmTags(assist);
  } catch (error) {
    throw new RunBlocked(`BGMの雰囲気をタグへ変換できませんでした: ${messageOf(error)}`);
  }
  if (tags === "") throw new RunBlocked("BGMの雰囲気から作ったタグが空です");
  const videoSeconds = await fetchAdoptedVideoSeconds(projectId, scene.id).catch(() => null);
  const form = { ...defaultBgmForm(recipe), moodJa: mood, tags, count: 1 };
  const inputs = buildBgmInputs(form, defaultSeconds(videoSeconds), 0, recipe);
  const { artifact } = await submitAndWait(
    ctx,
    bgmJobBody(recipe, { projectId, sceneId: scene.id }, inputs),
    "audio",
    (job) => appendResultEntry(bgmKeysOf(scene.id).results, { jobId: job.id }, BGM_RESULTS_MAX),
  );
  await putAdoption(projectId, scene.id, "bgm", artifact.id);
  return "done";
}

/** 動画。動画の画面と同じ補完 (i2v、先頭フレームは採用したシーン画像、プロンプトは`video_motion`) で1本生成する。 */
async function runVideo(ctx: RunContext): Promise<StepOutcome> {
  const { client, projectId, scene } = ctx;
  const adoptions = await fetchAdoptions(client, projectId, scene.id);
  const sceneImage = adoptions.find((item) => item.slot === "scene_image") ?? null;
  if (sceneImage === null) throw new RunBlocked("採用したシーン画像が無いため、動画の先頭フレームを決められません");
  if (scene.video_motion.trim() === "") {
    throw new RunBlocked("シーンの動き (video_motion) が空のため、動画のプロンプトを決められません");
  }
  const recipe = await fetchRecipe(client, "video", "動画", (recipes) =>
    recipes.find((item) => item.workflow_template_ref.name === VIDEO_TEMPLATES.i2v),
  );
  const draft = fillDraftFromScene(
    defaultDraft({ i2v: recipe, ref2v: null, prompt: null }),
    scene.id,
    scene.video_motion,
    sceneImage.artifact_id,
  );
  const reason = videoBlockedReason(draft, recipe, null);
  if (reason !== null) throw new RunBlocked(`動画を投入できません: ${reason}`);
  const target = videoTargetOf(projectId, scene);
  const body = videoJobBody(
    recipe,
    {
      project_id: projectId,
      story_scene_id: scene.id,
      story_character_id: target.characterId,
      story_costume_id: target.costumeId,
    },
    buildVideoInputs(draft, recipe),
  );
  const { artifact } = await submitAndWait(ctx, body, "video", (job) =>
    appendResultEntry(videoKeysOf(scene.id).results, { jobId: job.id }, VIDEO_RESULTS_MAX),
  );
  await putAdoption(projectId, scene.id, "video", artifact.id);
  return "done";
}

async function durationOf(ctx: RunContext, artifactId: string, kind: "audio" | "video", label: string): Promise<number> {
  try {
    return await loadDuration(artifactContentUrl(artifactId), ctx.signal, kind);
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    throw new RunBlocked(`${label}の尺を読めません (${messageOf(error)})`);
  }
}

/** 統合。台詞の音声を先頭から詰めて、既定の音量で動画に載せる。 */
async function runCompose(ctx: RunContext): Promise<StepOutcome> {
  const { client, projectId, scene } = ctx;
  const adoptions = await fetchAdoptions(client, projectId, scene.id);
  const video = adoptions.find((item) => item.slot === "video") ?? null;
  if (video === null) throw new RunBlocked("採用した動画が無いため、統合できません");
  const bgm = adoptions.find((item) => item.slot === "bgm") ?? null;
  const allRows = voiceRowsOf(scene, adoptions);
  const rows = allRows.slice(0, MAX_VOICE_TRACKS);
  if (allRows.length > rows.length) {
    ctx.notice(`台詞の音声は先頭の${MAX_VOICE_TRACKS}本だけを統合に載せました。`);
  }
  const recipe = await fetchRecipe(client, "compose", "統合", (recipes) =>
    recipes.find((item) => item.workflow_template_ref.name === COMPOSE_TEMPLATE),
  );

  const videoSeconds = await durationOf(ctx, video.artifact_id, "video", "動画");
  const voiceSeconds: number[] = [];
  for (const row of rows) voiceSeconds.push(await durationOf(ctx, row.artifactId, "audio", `${row.lineNo}行目の音声`));
  const starts = packedStarts(voiceSeconds);
  const voices: ComposeVoiceInput[] = [];
  for (const [index, row] of rows.entries()) {
    const start = starts[index] ?? null;
    const seconds = voiceSeconds[index];
    if (start === null || seconds === undefined) throw new RunBlocked(`${row.lineNo}行目の音声の開始位置を決められません`);
    if (exceedsVideo(start, seconds, videoSeconds)) {
      throw new RunBlocked(
        `台詞の音声が動画の長さ (${roundSec(videoSeconds)}秒) を超えます (${row.lineNo}行目は${roundSec(start)}秒から${roundSec(seconds)}秒)`,
      );
    }
    voices.push({ artifact_id: row.artifactId, start_sec: start, volume: DEFAULT_VOICE_VOLUME });
  }
  const inputs = buildComposeInputs({
    videoArtifactId: video.artifact_id,
    voices,
    bgm: bgm ? { artifactId: bgm.artifact_id, volume: DEFAULT_BGM_VOLUME } : null,
  });
  const { artifact } = await submitAndWait(
    ctx,
    composeJobBody({ recipeId: recipe.id, projectId, sceneId: scene.id, inputs }),
    "video",
    // 統合の結果欄は`ComposeStep`が動画の結果欄のフック (`useVideoResultEntries`) で読むので、上限も動画に揃える
    (job) => appendResultEntry(composeResultsKeyOf(scene.id), { jobId: job.id }, VIDEO_RESULTS_MAX),
  );
  await putAdoption(projectId, scene.id, "compose", artifact.id);
  return "done";
}

const EXECUTORS: Record<StepId, (ctx: RunContext) => Promise<StepOutcome>> = {
  character: runCharacter,
  scene_image: runSceneImage,
  voice: runVoice,
  bgm: runBgm,
  video: runVideo,
  compose: runCompose,
};

/**
 * 工程を1つ実行する。直前の工程の結果を踏まえ、実行の時点の最新のキャラ・採用で、まだ要るかを確かめてから進める。
 * 要らなければ何も投入せず`skipped`を返す。
 */
export async function executeStep(id: StepId, ctx: RunContext): Promise<StepOutcome> {
  const [characters, adoptions] = await Promise.all([
    fetchCharacters(ctx.client, ctx.projectId),
    fetchAdoptions(ctx.client, ctx.projectId, ctx.scene.id),
  ]);
  if (!stepsToRun(ctx.scene, characters, adoptions).includes(id)) return "skipped";
  return EXECUTORS[id](ctx);
}
