import { notifications } from "@mantine/notifications";
import type { QueryClient } from "@tanstack/react-query";

import { apiRequest, type GenerationJob, type GenerationManifest } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { notifyError } from "../notifications";
import { isRecord } from "./imageForm";
import { jobIdOfArtifact } from "./useImageGen";

/** Viewerの「この設定で生成画面へ」が付けるクエリ名。受けた画面は、設定を戻したらURLから消す。 */
export const FROM_ARTIFACT_PARAM = "from_artifact";

const enc = encodeURIComponent;

export type JobSettings = { job: GenerationJob; manifest: GenerationManifest };

/**
 * 元のJobとそのManifestを取る。`kind`が違うJob (動画の画面へ画像のJobを渡したなど) は、
 * 入力欄に合わない値を戻さないよう断る。
 */
export async function fetchJobSettings(client: QueryClient, jobId: string, kind: string, label: string): Promise<JobSettings> {
  const job = await client.fetchQuery({
    queryKey: queryKeys.job(jobId),
    queryFn: () => apiRequest<GenerationJob>(`/generation-jobs/${enc(jobId)}`),
  });
  if (job.kind !== kind) throw new Error(`この生成物は${label}の設定ではありません`);
  const manifest = await client.fetchQuery({
    queryKey: queryKeys.manifest(job.manifest_id),
    queryFn: () => apiRequest<GenerationManifest>(`/generation-manifests/${enc(job.manifest_id)}`),
  });
  return { job, manifest };
}

/** ManifestのWorkflowスナップショット (JSON)。台詞のようにManifestへ潰れて残る入力を、元の形で読む。 */
export async function fetchWorkflowSnapshot(client: QueryClient, manifest: GenerationManifest): Promise<Record<string, unknown>> {
  const snapshot = await client.fetchQuery({
    queryKey: queryKeys.workflowSnapshot(manifest.workflow_artifact_id),
    queryFn: () => apiRequest<unknown>(`/artifacts/${enc(manifest.workflow_artifact_id)}/content`),
  });
  if (!isRecord(snapshot)) throw new Error("生成設定のスナップショットを読めませんでした");
  return snapshot;
}

/** 戻した結果の通知。一部を戻せなかったときは黄色で理由を添える。 */
export function notifyRestoredInput(warning: string | null, message: string) {
  notifications.show(warning === null ? { color: "green", message } : { color: "yellow", title: message, message: warning });
}

/**
 * `?from_artifact=<生成物ID>`で開いたとき、その生成物を作ったJobの設定を入力欄へ戻す。
 * `restore`がJobから入力欄の値を作り、`apply`が保存値とURLへ反映する (URLの`from_artifact`は`apply`が消す)。
 * 失敗したら通知を出し、`onFail`でURLから`from_artifact`を消す。
 */
export async function restoreFromArtifactParam<T extends { warning: string | null }>({
  client,
  artifactId,
  restore,
  apply,
  onFail,
}: {
  client: QueryClient;
  artifactId: string;
  restore: (jobId: string) => Promise<T>;
  apply: (restored: T) => void;
  onFail: () => void;
}) {
  try {
    const restored = await restore(await jobIdOfArtifact(client, artifactId));
    apply(restored);
    notifyRestoredInput(restored.warning, "生成物の設定を入力欄へ戻しました");
  } catch (error) {
    notifyError("生成物の設定を戻せませんでした", error);
    onFail();
  }
}
