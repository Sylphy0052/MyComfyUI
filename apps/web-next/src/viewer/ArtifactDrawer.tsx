import {
  Alert,
  Badge,
  Button,
  Code,
  Divider,
  Drawer,
  Group,
  Image,
  Loader,
  SegmentedControl,
  Stack,
  Table,
  Text,
  Textarea,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useState } from "react";
import { useNavigate } from "react-router";

import { artifactContentUrl, type ArtifactDecision, type ArtifactRecord } from "../api/client";
import { FROM_ARTIFACT_PARAM } from "../imageGen/artifactRestore";
import { notifyError } from "../notifications";
import { useArtifact } from "../projectDetail/useStory";
import { LinkSelects } from "./LinkSelects";
import {
  useAdoptSceneImage,
  useApplyLinks,
  useBatchOperation,
  useGenerationSettings,
  useSetDecision,
  useUpdateMemo,
} from "./useViewer";
import { NO_LINKS, type StoryLinks } from "./viewerFilters";

/** `PATCH /artifacts/{id}`の`memo`の上限 (`ARTIFACT_MEMO_MAX_LENGTH`)。 */
const MEMO_MAX = 2_000;

const DECISION_OPTIONS = [
  { value: "undecided", label: "未判定" },
  { value: "accepted", label: "採用" },
  { value: "rejected", label: "不採用" },
];

/** 生成設定のうち、Workflowの識別子のように通常の操作で見ないもの。 */
const HIDDEN_PARAMETERS = new Set(["workflow_template", "workflow_template_sha256", "filename_prefix", "seed"]);

function linksOf(artifact: ArtifactRecord): StoryLinks {
  return {
    project: artifact.assigned_project_id,
    scene: artifact.story_scene_id ?? null,
    character: artifact.story_character_id ?? null,
    outfit: artifact.story_costume_id ?? null,
  };
}

function sameLinks(a: StoryLinks, b: StoryLinks): boolean {
  return a.project === b.project && a.scene === b.scene && a.character === b.character && a.outfit === b.outfit;
}

function formatValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function Preview({ artifact }: { artifact: ArtifactRecord }) {
  const url = artifactContentUrl(artifact.id);
  if (artifact.kind === "image") return <Image src={url} alt="プレビュー" fit="contain" mah={420} radius="sm" />;
  if (artifact.kind === "video") return <video controls muted src={url} style={{ width: "100%", borderRadius: 4 }} />;
  if (artifact.kind === "audio") return <audio controls src={url} style={{ width: "100%" }} />;
  return <Text c="dimmed">この種別はプレビューできません ({artifact.kind})</Text>;
}

function MemoEditor({ artifact }: { artifact: ArtifactRecord }) {
  const saved = artifact.memo ?? "";
  const [memo, setMemo] = useState(saved);
  const update = useUpdateMemo();
  const save = () =>
    update.mutate(
      { artifactId: artifact.id, memo },
      {
        onSuccess: () => notifications.show({ color: "green", message: "メモを保存しました" }),
        onError: (error) => notifyError("メモを保存できません", error),
      },
    );
  return (
    <Stack gap={4}>
      <Textarea
        label="メモ"
        autosize
        minRows={2}
        maxRows={6}
        maxLength={MEMO_MAX}
        value={memo}
        onChange={(event) => setMemo(event.currentTarget.value)}
      />
      <Group justify="flex-end">
        <Button size="xs" onClick={save} loading={update.isPending} disabled={memo === saved}>
          メモを保存
        </Button>
      </Group>
    </Stack>
  );
}

function LinkEditor({ artifact }: { artifact: ArtifactRecord }) {
  const saved = linksOf(artifact);
  const [links, setLinks] = useState(saved);
  const apply = useApplyLinks();
  const run = (next: StoryLinks, message: string) =>
    apply.mutate(
      { items: [{ id: artifact.id, projectId: artifact.assigned_project_id }], links: next },
      {
        onSuccess: () => {
          setLinks(next);
          notifications.show({ color: "green", message });
        },
        onError: (error) => notifyError("紐づけを変更できません", error),
      },
    );
  const unchanged = sameLinks(links, saved);
  return (
    <Stack gap="xs">
      <Title order={5}>紐づけ</Title>
      <LinkSelects size="xs" value={links} onChange={setLinks} disabled={apply.isPending} />
      <Group justify="flex-end" gap="xs">
        <Button
          size="xs"
          variant="default"
          onClick={() => run(NO_LINKS, "紐づけを外しました")}
          disabled={sameLinks(saved, NO_LINKS)}
          loading={apply.isPending}
        >
          紐づけを外す
        </Button>
        <Button size="xs" onClick={() => run(links, "紐づけを保存しました")} disabled={unchanged} loading={apply.isPending}>
          紐づけを保存
        </Button>
      </Group>
    </Stack>
  );
}

function DecisionEditor({ artifact }: { artifact: ArtifactRecord }) {
  const setDecision = useSetDecision();
  const adopt = useAdoptSceneImage();
  const projectId = artifact.assigned_project_id;
  const sceneId = artifact.story_scene_id ?? null;
  const adoptSceneImage = () => {
    if (!projectId || !sceneId) return;
    adopt.mutate(
      { projectId, sceneId, artifactId: artifact.id },
      {
        onSuccess: () => notifications.show({ color: "green", message: "シーン画像に採用しました" }),
        onError: (error) => notifyError("採用できません", error),
      },
    );
  };
  return (
    <Stack gap="xs">
      <Title order={5}>採否</Title>
      <SegmentedControl
        data={DECISION_OPTIONS}
        value={artifact.decision}
        disabled={setDecision.isPending}
        onChange={(value) =>
          setDecision.mutate(
            { artifactId: artifact.id, decision: value as ArtifactDecision },
            { onError: (error) => notifyError("採否を変更できません", error) },
          )
        }
      />
      {artifact.kind === "image" && projectId && sceneId ? (
        <Group>
          <Button size="xs" variant="light" onClick={adoptSceneImage} loading={adopt.isPending}>
            紐づけたシーンのシーン画像に採用
          </Button>
        </Group>
      ) : null}
    </Stack>
  );
}

function GenerationSettings({ jobId }: { jobId: string | null }) {
  const { job, manifest } = useGenerationSettings(jobId);
  if (jobId === null) {
    return (
      <Text size="sm" c="dimmed">
        生成設定はありません (取り込んだ素材です)。
      </Text>
    );
  }
  const error = job.error ?? manifest.error;
  if (error) return <Alert color="red">生成設定を取得できません: {error.message}</Alert>;
  if (!job.data || !manifest.data) return <Loader size="xs" />;
  const rows: [string, string][] = [
    ["Recipe", job.data.recipe_id],
    ["seed", String(manifest.data.seed)],
    ...Object.entries(manifest.data.model ?? {}).map(([name, value]): [string, string] => [name, formatValue(value)]),
    ...Object.entries(manifest.data.parameters ?? {})
      .filter(([name]) => !HIDDEN_PARAMETERS.has(name))
      .map(([name, value]): [string, string] => [name, formatValue(value)]),
  ];
  return (
    <Stack gap="xs" data-testid="generation-settings">
      <Text size="sm" fw={600}>
        プロンプト
      </Text>
      <Code block style={{ whiteSpace: "pre-wrap" }}>
        {manifest.data.resolved_prompt || "(なし)"}
      </Code>
      <Table withRowBorders={false} verticalSpacing={2} fz="xs">
        <Table.Tbody>
          {rows.map(([name, value]) => (
            <Table.Tr key={name}>
              <Table.Td c="dimmed" w={160} style={{ verticalAlign: "top" }}>
                {name}
              </Table.Td>
              <Table.Td style={{ wordBreak: "break-all" }}>{value}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

/**
 * 生成画面の行き先。画像・動画は種別で決まる。音声は台詞とBGMで画面が分かれるが、生成物には区別が無いので、
 * 元のJobの種別 (`voice` / `music`) で決める。Jobを読めるまでは決まらない。
 */
function restorePathOf(artifactKind: string, jobKind: string | undefined): string | null {
  if (artifactKind === "image") return "/image";
  if (artifactKind === "video") return "/video";
  if (artifactKind !== "audio") return null;
  if (jobKind === "voice") return "/voice";
  return jobKind === "music" ? "/bgm" : null;
}

/** 「この設定で生成画面へ」。生成物を作ったJobの設定を、種別に合う生成画面の入力欄へ戻す。 */
function RestoreButton({ artifact }: { artifact: ArtifactRecord }) {
  const navigate = useNavigate();
  const { job } = useGenerationSettings(artifact.job_id);
  const path = restorePathOf(artifact.kind, job.data?.kind);
  return (
    <Button
      variant="light"
      disabled={artifact.job_id === null || path === null}
      onClick={() => path !== null && navigate(`${path}?${new URLSearchParams({ [FROM_ARTIFACT_PARAM]: artifact.id })}`)}
    >
      この設定で生成画面へ
    </Button>
  );
}

function ArtifactDetail({ artifactId, onClose }: { artifactId: string; onClose: () => void }) {
  const artifact = useArtifact(artifactId);
  const trash = useBatchOperation();
  if (artifact.isPending) return <Loader size="sm" />;
  if (artifact.error) return <Alert color="red">生成物を取得できません: {artifact.error.message}</Alert>;
  const data = artifact.data;
  const trashed = data.deleted_at !== null;

  const moveToTrash = () =>
    trash.mutate(
      { ids: [data.id], operation: "trash" },
      {
        onSuccess: () => {
          notifications.show({ message: "ゴミ箱へ移しました" });
          onClose();
        },
        onError: (error) => notifyError("ゴミ箱へ移せません", error),
      },
    );

  return (
    <Stack gap="md" data-testid="artifact-detail" data-artifact-id={data.id}>
      <Preview artifact={data} />
      <Group gap="xs">
        <Text size="xs" c="dimmed">
          作成: {new Date(data.created_at).toLocaleString("ja-JP")}
        </Text>
        {trashed ? <Badge color="gray">ゴミ箱</Badge> : null}
      </Group>
      {trashed ? (
        <Alert color="yellow" variant="light">
          ゴミ箱にある生成物です。編集するにはゴミ箱タブで復元してください。
        </Alert>
      ) : (
        <>
          <DecisionEditor artifact={data} />
          <Divider />
          {/* 保存後の取り直しで編集欄を保存済みの値へ揃えるため、値が変わったら作り直す。 */}
          <MemoEditor key={`memo:${data.memo ?? ""}`} artifact={data} />
          <Divider />
          <LinkEditor key={`links:${Object.values(linksOf(data)).join("/")}`} artifact={data} />
          <Divider />
        </>
      )}
      <Stack gap="xs">
        <Title order={5}>生成設定</Title>
        <GenerationSettings jobId={data.job_id} />
      </Stack>
      <Group justify="space-between">
        <RestoreButton artifact={data} />
        {trashed ? null : (
          <Button color="red" variant="light" onClick={moveToTrash} loading={trash.isPending}>
            ゴミ箱へ移す
          </Button>
        )}
      </Group>
    </Stack>
  );
}

/** 生成物の詳細。右のドロワーで開き、採否・メモ・紐づけを直す。 */
export function ArtifactDrawer({ artifactId, onClose }: { artifactId: string | null; onClose: () => void }) {
  return (
    <Drawer opened={artifactId !== null} onClose={onClose} position="right" size="lg" title="生成物の詳細">
      {artifactId !== null ? <ArtifactDetail key={artifactId} artifactId={artifactId} onClose={onClose} /> : null}
    </Drawer>
  );
}
