/** 画面をまたいで使うqueryKey。WebSocketのイベントからの無効化 (events.ts) もここを参照する。 */
export const queryKeys = {
  jobs: ["generation-jobs"] as const,
  jobProgress: (jobId: string) => ["generation-jobs", jobId, "progress"] as const,
  project: (projectId: string) => ["projects", projectId] as const,
  projects: ["projects"] as const,
};
