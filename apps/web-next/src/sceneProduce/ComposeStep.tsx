import { Alert, Anchor, Button, Group, Loader, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { type SyntheticEvent, useState } from "react";
import { Link } from "react-router";

import { artifactContentUrl, type StoryScene } from "../api/client";
import { useSubmitImageJob } from "../imageGen/useImageGen";
import { notifyError } from "../notifications";
import { useSceneAdoptions } from "../projectDetail/useStory";
import { VideoResult } from "../videoGen/VideoResultPanel";
import { useVideoResultEntries } from "../videoGen/useVideoGen";
import {
  buildComposeInputs,
  composeJobBody,
  DEFAULT_BGM_VOLUME,
  DEFAULT_VOICE_VOLUME,
  type Duration,
  exceedsVideo,
  MAX_START_SEC,
  MAX_VOICE_TRACKS,
  MAX_VOLUME,
  packedStarts,
  parseBounded,
  roundSec,
  voiceRowsOf,
} from "./composeForm";
import { useComposeRecipe } from "./useSceneProduce";

/** 工程ごと・シーンごとに別の保存キーにする。ほかのシーンの結果と混ざらない。 */
function resultsKeyOf(sceneId: string): string {
  return `web-next:scene-produce-compose-results:${sceneId}`;
}

const LOADING: Duration = { state: "loading" };

function secondsOf(duration: Duration): number | null {
  return duration.state === "ready" ? duration.seconds : null;
}

function DurationText({ duration }: { duration: Duration }) {
  if (duration.state === "loading") return <Text size="xs" c="dimmed">読み込み中</Text>;
  if (duration.state === "error") return <Text size="xs" c="red">尺を読めません</Text>;
  return <Text size="xs">{roundSec(duration.seconds)}秒</Text>;
}

/** 入力欄の値。手で直した文字列があればそれを、無ければ初期値を使う。 */
type Edit = { start?: string; volume?: string };

/**
 * シーン生成の統合の工程。採用した動画・台詞の音声・BGMを並べ、compose Jobを投入する。
 * 尺は`<video>`と`<audio>`の`duration`で読む。読み込み中と読めないときは投入できない。
 */
export function ComposeStep({ projectId, scene }: { projectId: string; scene: StoryScene }) {
  const adoptions = useSceneAdoptions(projectId, scene.id);
  const recipe = useComposeRecipe();
  const results = useVideoResultEntries(resultsKeyOf(scene.id));
  const submit = useSubmitImageJob();
  const [durations, setDurations] = useState<Record<string, Duration>>({});
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [bgmVolumeEdit, setBgmVolumeEdit] = useState<string | null>(null);

  const report = (artifactId: string, next: Duration) =>
    setDurations((prev) => {
      const current = prev[artifactId];
      const same =
        current?.state === next.state &&
        (current.state !== "ready" || (next.state === "ready" && current.seconds === next.seconds));
      return same ? prev : { ...prev, [artifactId]: next };
    });
  /** `<video>`・`<audio>`に付ける。メタデータの読み込みで尺を、失敗で読めないことを記録する。 */
  const mediaProps = (artifactId: string) => ({
    preload: "metadata" as const,
    controls: true,
    src: artifactContentUrl(artifactId),
    onLoadedMetadata: (event: SyntheticEvent<HTMLMediaElement>) => {
      const seconds = event.currentTarget.duration;
      report(artifactId, Number.isFinite(seconds) && seconds > 0 ? { state: "ready", seconds } : { state: "error" });
    },
    onError: () => report(artifactId, { state: "error" }),
  });
  const durationOf = (artifactId: string): Duration => durations[artifactId] ?? LOADING;
  const patchEdit = (dialogueId: string, patch: Edit) =>
    setEdits((prev) => ({ ...prev, [dialogueId]: { ...prev[dialogueId], ...patch } }));

  const videoPath = `/scenes/${encodeURIComponent(scene.id)}/produce?${new URLSearchParams({
    project: projectId,
    step: "video",
  })}`;

  if (adoptions.isError) {
    return (
      <Alert color="red" mt="sm" data-testid="compose-adoptions-error">
        採用の状況を取得できません: {adoptions.error.message}
      </Alert>
    );
  }
  if (!adoptions.data) return <Loader size="sm" mt="sm" />;

  const video = adoptions.data.find((item) => item.slot === "video") ?? null;
  const bgm = adoptions.data.find((item) => item.slot === "bgm") ?? null;
  const allRows = voiceRowsOf(scene, adoptions.data);
  const rows = allRows.slice(0, MAX_VOICE_TRACKS);
  const excluded = allRows.length - rows.length;
  const withoutVoice = scene.dialogues.length - allRows.length;

  const videoDuration = video ? durationOf(video.artifact_id) : LOADING;
  const voiceDurations = rows.map((row) => durationOf(row.artifactId));
  const packed = packedStarts(voiceDurations.map(secondsOf));

  /** 行ごとの入力の検証結果。`start`・`volume`は有効なときの値。 */
  const lines = rows.map((row, index) => {
    const edit = edits[row.dialogueId] ?? {};
    const startText = edit.start ?? (packed[index] === null ? "" : String(packed[index]));
    const volumeText = edit.volume ?? String(DEFAULT_VOICE_VOLUME);
    const start = parseBounded(startText, 0, MAX_START_SEC);
    const volume = parseBounded(volumeText, 0, MAX_VOLUME);
    const seconds = secondsOf(voiceDurations[index] ?? LOADING);
    const videoSeconds = secondsOf(videoDuration);
    const overrun =
      start !== null && seconds !== null && videoSeconds !== null && exceedsVideo(start, seconds, videoSeconds);
    // 前の行の尺が読めず、初期値がまだ決まらない開始。読み込み側の案内に任せ、入力の誤りとは数えない。
    const pending = edit.start === undefined && packed[index] === null;
    const bad = volume === null || (!pending && start === null);
    return { row, startText, volumeText, start, volume, overrun, bad, duration: voiceDurations[index] ?? LOADING };
  });
  const bgmVolumeText = bgmVolumeEdit ?? String(DEFAULT_BGM_VOLUME);
  const bgmVolume = parseBounded(bgmVolumeText, 0, MAX_VOLUME);

  const durationList = [videoDuration, ...voiceDurations];
  const loading = durationList.some((item) => item.state === "loading");
  const unreadable = durationList.some((item) => item.state === "error");
  const hasOverrun = lines.some((line) => line.overrun);
  const invalid = lines.some((line) => line.bad) || (bgm !== null && bgmVolume === null);
  const canSubmit =
    video !== null && recipe.data != null && !loading && !unreadable && !hasOverrun && !invalid && !submit.isPending;

  const onSubmit = () => {
    if (!canSubmit || !video || !recipe.data) return;
    const voices = lines.flatMap((line) =>
      line.start === null || line.volume === null
        ? []
        : [{ artifact_id: line.row.artifactId, start_sec: line.start, volume: line.volume }],
    );
    const inputs = buildComposeInputs({
      videoArtifactId: video.artifact_id,
      voices,
      bgm: bgm && bgmVolume !== null ? { artifactId: bgm.artifact_id, volume: bgmVolume } : null,
    });
    submit.mutate(composeJobBody({ recipeId: recipe.data.id, projectId, sceneId: scene.id, inputs }), {
      onSuccess: (job) => results.add({ jobId: job.id }),
      onError: (error) => notifyError("投入できませんでした", error),
    });
  };

  return (
    <Stack mt="sm" gap="md" data-testid="compose-step">
      {video === null ? (
        <Alert color="yellow" data-testid="compose-no-video">
          動画の工程で採用してください。統合には採用した動画が要ります。{" "}
          <Anchor component={Link} to={videoPath} data-testid="compose-video-link">
            動画の工程へ
          </Anchor>
        </Alert>
      ) : (
        <Stack gap={4}>
          <Group gap="xs">
            <Title order={5}>動画</Title>
            <DurationText duration={videoDuration} />
          </Group>
          <video
            {...mediaProps(video.artifact_id)}
            style={{ width: "100%", maxHeight: 280 }}
            data-testid="compose-video"
            data-artifact-id={video.artifact_id}
          />
        </Stack>
      )}

      <Stack gap={4}>
        <Title order={5}>台詞の音声</Title>
        {rows.length === 0 ? (
          <Text size="sm" c="dimmed" data-testid="compose-no-voice">
            採用した台詞の音声はありません。入れずに統合します。
          </Text>
        ) : (
          <Table withTableBorder verticalSpacing="xs" data-testid="compose-voices">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>台詞</Table.Th>
                <Table.Th>音声</Table.Th>
                <Table.Th>尺</Table.Th>
                <Table.Th>開始 (秒)</Table.Th>
                <Table.Th>音量</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {lines.map((line) => (
                <Table.Tr
                  key={line.row.dialogueId}
                  data-testid="compose-voice-row"
                  data-dialogue-id={line.row.dialogueId}
                  data-overrun={line.overrun}
                >
                  <Table.Td maw={220}>
                    <Text size="xs" lineClamp={2}>
                      {line.row.lineNo}. {line.row.text}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <audio
                      {...mediaProps(line.row.artifactId)}
                      style={{ width: 220, height: 32 }}
                      data-testid="compose-voice-audio"
                    />
                  </Table.Td>
                  <Table.Td>
                    <DurationText duration={line.duration} />
                  </Table.Td>
                  <Table.Td>
                    <TextInput
                      size="xs"
                      w={90}
                      inputMode="decimal"
                      value={line.startText}
                      error={line.bad && line.start === null}
                      onChange={(event) => patchEdit(line.row.dialogueId, { start: event.currentTarget.value })}
                      data-testid="compose-start"
                    />
                    {line.overrun ? (
                      <Text size="xs" c="red" data-testid="compose-overrun">
                        動画の尺を超えます
                      </Text>
                    ) : null}
                  </Table.Td>
                  <Table.Td>
                    <TextInput
                      size="xs"
                      w={70}
                      inputMode="decimal"
                      value={line.volumeText}
                      error={line.volume === null}
                      onChange={(event) => patchEdit(line.row.dialogueId, { volume: event.currentTarget.value })}
                      data-testid="compose-volume"
                    />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
        {excluded > 0 ? (
          <Alert color="yellow" data-testid="compose-voice-limit">
            台詞の音声は{MAX_VOICE_TRACKS}本までです。超えた{excluded}行は統合に含めません。
          </Alert>
        ) : null}
        {withoutVoice > 0 ? (
          <Text size="xs" c="dimmed" data-testid="compose-voice-missing">
            音声が未採用の台詞が{withoutVoice}行あります。含めません。
          </Text>
        ) : null}
      </Stack>

      <Stack gap={4}>
        <Title order={5}>BGM</Title>
        {bgm === null ? (
          <Text size="sm" c="dimmed" data-testid="compose-no-bgm">
            採用したBGMはありません。入れずに統合します。
          </Text>
        ) : (
          <Group gap="md" data-testid="compose-bgm" data-artifact-id={bgm.artifact_id}>
            <audio
              {...mediaProps(bgm.artifact_id)}
              style={{ width: 260, height: 32 }}
              data-testid="compose-bgm-audio"
            />
            <TextInput
              size="xs"
              w={90}
              label="音量"
              inputMode="decimal"
              value={bgmVolumeText}
              error={bgmVolume === null}
              onChange={(event) => setBgmVolumeEdit(event.currentTarget.value)}
              data-testid="compose-bgm-volume"
            />
          </Group>
        )}
      </Stack>

      {loading && video !== null ? (
        <Text size="sm" c="dimmed" data-testid="compose-loading">
          メディアの尺を読み込んでいます。終わるまで投入できません。
        </Text>
      ) : null}
      {unreadable ? (
        <Alert color="red" data-testid="compose-unreadable">
          尺を読めない素材があります。動画か音声を採用し直してください。
        </Alert>
      ) : null}
      {hasOverrun ? (
        <Alert color="red" data-testid="compose-overrun-alert">
          動画の尺を超える台詞があります。開始時刻を前へ直すと投入できます。
        </Alert>
      ) : null}
      {invalid && !hasOverrun ? (
        <Alert color="red" data-testid="compose-invalid">
          開始は0〜{MAX_START_SEC}秒、音量は0〜{MAX_VOLUME}の数値で入力してください。
        </Alert>
      ) : null}
      {recipe.isError ? (
        <Alert color="red" data-testid="compose-recipe-error">
          統合のRecipeを取得できません: {recipe.error.message}
        </Alert>
      ) : null}

      <Group>
        <Button onClick={onSubmit} disabled={!canSubmit} loading={submit.isPending} data-testid="compose-submit">
          統合する
        </Button>
      </Group>

      <Stack gap="md" data-testid="compose-results">
        <Title order={5}>結果</Title>
        {results.entries.length === 0 ? (
          <Text size="sm" c="dimmed">
            まだ統合していません。
          </Text>
        ) : null}
        {results.entries.map((entry) => (
          <VideoResult key={entry.jobId} entry={entry} slot="compose" onRemove={() => results.remove(entry.jobId)} />
        ))}
      </Stack>
    </Stack>
  );
}
