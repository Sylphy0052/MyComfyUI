/** 画面をまたいで使うqueryKey。WebSocketのイベントからの無効化 (events.ts) もここを参照する。 */
export const queryKeys = {
  jobs: ["generation-jobs"] as const,
  // `jobs`の無効化に巻き込まれないよう、Job一覧とは別の系統に置く。
  jobProgress: (jobId: string) => ["generation-job-progress", jobId] as const,
  // シーン生成画面の状態用。Jobの状態が変わったイベントで取り直すため`jobs`の下に置く。
  sceneProduceJobs: (projectId: string) => ["generation-jobs", "scene-produce", projectId] as const,
  sceneProduceComposeIds: (projectId: string, sceneId: string) =>
    ["generation-jobs", "scene-produce-compose", projectId, sceneId] as const,
  // 1件のJobとその生成物は`jobs`の下に置き、Jobの状態が変わったイベントで一緒に取り直す。
  job: (jobId: string) => ["generation-jobs", "detail", jobId] as const,
  jobImages: (jobId: string) => ["generation-jobs", "detail", jobId, "images"] as const,
  jobAudio: (jobId: string) => ["generation-jobs", "detail", jobId, "audio"] as const,
  jobVideos: (jobId: string) => ["generation-jobs", "detail", jobId, "videos"] as const,
  jobVoiceVerifications: (jobId: string) =>
    ["generation-jobs", "detail", jobId, "voice-verifications"] as const,
  // スイープの実験も`jobs`の下に置く。Jobの状態が変わったイベントで、実験の各セルも取り直す。
  experiment: (experimentId: string) => ["generation-jobs", "experiment", experimentId] as const,
  // 後続Jobの予約。Jobの状態イベントでは変わらないので、`jobs`の外に置き、予約自身を取り直す。
  followup: (followupId: string) => ["generation-job-followups", followupId] as const,
  manifest: (manifestId: string) => ["generation-manifests", manifestId] as const,
  // Manifestが指すWorkflowのスナップショット (JSON)。生成設定を入力欄へ戻すときに読む。
  workflowSnapshot: (artifactId: string) => ["workflow-snapshots", artifactId] as const,
  qwenSettings: ["settings", "qwen"] as const,
  recipes: (kind: string) => ["recipes", kind] as const,
  modelOptions: (workflowVersionId: string) => ["workflow-versions", workflowVersionId, "models"] as const,
  project: (projectId: string) => ["projects", projectId] as const,
  projects: ["projects"] as const,
  // `projects`の下に置き、Projectの変更で`projects`ごと無効化したときに一緒に取り直す。
  projectList: (lifecycle: "active" | "trashed") => ["projects", "list", lifecycle] as const,
  // キャラクター・衣装・シーンもProjectの下に置き、Projectの変更で一緒に取り直す。
  projectCharacters: (projectId: string) => ["projects", projectId, "characters"] as const,
  projectScenes: (projectId: string) => ["projects", projectId, "story-scenes"] as const,
  sceneAdoptions: (projectId: string, sceneId: string) =>
    ["projects", projectId, "story-scenes", sceneId, "adoptions"] as const,
  // 生成物1件ずつの詳細。採否のように別の生成物へ波及する変更では`artifacts`ごと取り直す。
  artifacts: ["artifacts"] as const,
  artifact: (artifactId: string) => ["artifacts", artifactId] as const,
  // 生成物の一覧は取得元のAPIで系統を分ける (`/media-items`と`/artifacts`)。
  // 採否・紐づけ・ゴミ箱の変更では、両方の系統を条件ごとのページまでまとめて取り直す。
  mediaItems: ["media-items"] as const,
  viewerMediaItems: (query: string) => ["media-items", "viewer-list", query] as const,
  // 元画像の選択に出す最近の生成物。
  sourceImages: (query: string) => ["media-items", "source-images", query] as const,
  // /videoのguide_audioに選べる最近の台詞音声。
  voiceAudio: (query: string) => ["media-items", "voice-audio", query] as const,
  // シーン生成画面の状態用。シーンの生成物と、キャラクターの参照候補。
  sceneProduceMedia: (sceneId: string) => ["media-items", "scene-produce", sceneId] as const,
  sceneProduceCharacterMedia: (projectId: string, characterIds: string[]) =>
    ["media-items", "scene-produce-characters", projectId, ...characterIds] as const,
  rejectedArtifactIds: (query: string) => ["media-items", "rejected-ids", query] as const,
  artifactLists: ["artifact-lists"] as const,
  trashedArtifacts: ["artifact-lists", "trashed"] as const,
  // ゴミ箱の変更で影響も変わるので、`artifactLists`の下に置く。
  artifactPurgePreview: (artifactIds: string[]) => ["artifact-lists", "purge-preview", artifactIds] as const,
  jobArtifacts: (jobId: string) => ["artifact-lists", "job", jobId] as const,
};
