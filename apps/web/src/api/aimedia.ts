/**
 * ai-media 参照 API v1 のうち、画面が読む項目だけの型。
 *
 * 正本は `contracts/ai-media/v1/schema/reference-api.schema.json` とする。
 * Application API はこの本文をそのまま中継するため、OpenAPI 側では任意の object に
 * なる。ここでは表示に使う項目だけを宣言し、本文全体の再定義はしない。
 */

export interface ImmutableReference {
  source_locator: string;
  revision: string;
  path: string;
  sha256: string;
  anchor?: string | null;
  note?: string | null;
}

export interface SceneSummary {
  id: string;
  project_id: string;
  sequence: number;
  summary: string;
  shot_count: number;
  notes?: string | null;
  tags?: string[];
  production_status?: ProductionStatus;
  reference: ImmutableReference;
}

export interface SceneList {
  items: SceneSummary[];
}

export interface ShotSummary {
  id: string;
  scene_id: string;
  sequence: number;
  duration_sec: number;
  summary: string;
  notes?: string | null;
  tags?: string[];
  production_status?: ProductionStatus;
  reference: ImmutableReference;
}

export interface ShotList {
  items: ShotSummary[];
}

export interface Provenance {
  resource: ImmutableReference;
  schema?: { name: string; reference: ImmutableReference };
  references?: {
    json_pointer: string;
    declared_path: string;
    reference: ImmutableReference;
  }[];
}

export type ProductionStatus =
  | "not_started"
  | "in_progress"
  | "has_candidates"
  | "accepted"
  | "completed";

/** SceneのBGM。Shot単位では作らない。 */
export interface MusicGenerationSpec {
  engine?: string;
  profile?: string;
  required?: boolean;
  mood: string;
  genre?: string | null;
  instrumental?: boolean;
  duration_sec?: number | null;
  seed?: number | null;
}

export interface SceneData {
  id: string;
  project_id: string;
  summary: string;
  notes?: string | null;
  tags?: string[];
  production_status?: ProductionStatus;
  location?: { id: string; display_name?: string | null };
  time_of_day?: string;
  season?: string | null;
  characters?: { id: string; display_name?: string | null }[];
  goal?: string | null;
  music?: MusicGenerationSpec | null;
}

export interface SceneEnvelope {
  kind: "scene";
  data: SceneData;
  provenance: Provenance;
}

/** 動画生成が参照する画像。`path`はai-media側のファイルで、ComfyUIの入力ではない。 */
export interface ShotReference {
  path: string;
  role: "background" | "standing" | "detail" | "expression" | "action";
  character_id?: string | null;
  note?: string | null;
}

/** Shot本文が持つ動画生成の想定。実際の投入値はVideoPanelで別途指定する。 */
export interface VideoGenerationSpec {
  engine?: string;
  mode: "t2v" | "i2v" | "ref2v";
  audio_mode?: "native" | "external_voice" | "silent";
  profile?: string;
  seed?: number | null;
  references?: ShotReference[];
  first_frame?: string | null;
  last_frame?: string | null;
}

export interface ShotData {
  id: string;
  scene_id: string;
  sequence: number;
  duration_sec: number;
  summary: string;
  notes?: string | null;
  tags?: string[];
  production_status?: ProductionStatus;
  camera?: {
    framing: string;
    angle?: string;
    movement?: string;
    composition?: string | null;
  };
  characters?: {
    character_id: string;
    role?: string;
    action?: string | null;
    expression?: string | null;
  }[];
  dialogue?: {
    speaker: string;
    text: string;
    reading?: string | null;
    voice_id: string;
    delivery?: string | null;
    start_sec?: number | null;
  }[];
  video?: VideoGenerationSpec;
}

export interface ShotEnvelope {
  kind: "shot";
  data: ShotData;
  provenance: Provenance;
}

/**
 * Canon descriptor。本文は返らず、`canon_id`、種別、表示名、不変参照だけを持つ。
 */
export interface CanonDescriptor {
  canon_id: string;
  kind: string;
  display_name: string | null;
  reference: ImmutableReference;
}

export interface CanonList {
  items: CanonDescriptor[];
}
