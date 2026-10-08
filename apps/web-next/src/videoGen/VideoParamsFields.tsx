import {
  Accordion,
  ActionIcon,
  Autocomplete,
  Group,
  NumberInput,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { IconArrowsExchange } from "@tabler/icons-react";
import { useState } from "react";

import type { Recipe } from "../api/client";
import { acceptsInput } from "../imageGen/imageForm";
import { useModelOptions } from "../imageGen/useImageGen";
import {
  framesFromSeconds,
  MAX_FRAMES,
  MIN_FRAMES,
  SEED_MAX,
  secondsOfFrames,
  type SeedMode,
  type VideoParams,
} from "./videoForm";

type Update = (update: Partial<VideoParams>) => void;

/** 長さ(秒)の入力の上限。範囲の外は端のフレーム数へ寄せるため、入力は大きめに許す。 */
const SECONDS_INPUT_MAX = 60;

/** NumberInputの空欄・入力途中は直前の値のままにする。 */
function asNumber(value: string | number, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function SizeField({ params, onChange }: { params: VideoParams; onChange: Update }) {
  return (
    <Group align="flex-end" gap="xs">
      <NumberInput
        label="幅"
        w={110}
        min={64}
        max={4096}
        step={16}
        allowDecimal={false}
        value={params.width}
        onChange={(value) => onChange({ width: asNumber(value, params.width) })}
      />
      <Tooltip label="縦横を入れ替える">
        <ActionIcon
          variant="default"
          size="lg"
          aria-label="縦横を入れ替える"
          onClick={() => onChange({ width: params.height, height: params.width })}
        >
          <IconArrowsExchange size={16} />
        </ActionIcon>
      </Tooltip>
      <NumberInput
        label="高さ"
        w={110}
        min={64}
        max={4096}
        step={16}
        allowDecimal={false}
        value={params.height}
        onChange={(value) => onChange({ height: asNumber(value, params.height) })}
      />
    </Group>
  );
}

/** 長さは秒で入力する。投入するフレーム数 (17k+5) と、その秒数を横に出す。 */
function LengthField({ params, onChange }: { params: VideoParams; onChange: Update }) {
  const frames = framesFromSeconds(params.seconds, params.fps);
  const rounded = secondsOfFrames(frames, params.fps);
  return (
    <Group align="flex-end" gap="sm">
      <NumberInput
        label="長さ (秒)"
        w={130}
        min={0.1}
        max={SECONDS_INPUT_MAX}
        step={0.5}
        decimalScale={1}
        value={params.seconds}
        onChange={(value) => onChange({ seconds: asNumber(value, params.seconds) })}
      />
      <Text size="sm" pb={8} data-testid="video-frames" data-frames={frames}>
        {`→ ${frames}フレーム (${rounded.toFixed(1)}秒)`}
      </Text>
      <Text size="xs" c="dimmed" pb={8}>
        {`${MIN_FRAMES}〜${MAX_FRAMES}フレーム、17k+5の値に丸めます`}
      </Text>
    </Group>
  );
}

function SeedField({ params, onChange }: { params: VideoParams; onChange: Update }) {
  return (
    <Group align="flex-end" gap="sm">
      <Stack gap={4}>
        <Text size="sm" fw={500}>
          seed
        </Text>
        <SegmentedControl
          size="xs"
          data={[
            { value: "random", label: "ランダム" },
            { value: "fixed", label: "固定" },
          ]}
          value={params.seedMode}
          onChange={(seedMode) => onChange({ seedMode: seedMode as SeedMode })}
        />
      </Stack>
      {params.seedMode === "fixed" ? (
        <NumberInput
          aria-label="seedの値"
          w={200}
          min={0}
          max={SEED_MAX}
          allowDecimal={false}
          value={params.seed}
          onChange={(value) => onChange({ seed: asNumber(value, params.seed) })}
        />
      ) : null}
    </Group>
  );
}

function ModelField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return <Autocomplete label={label} value={value} data={options} onChange={onChange} size="xs" />;
}

function DetailFields({ params, onChange, recipe }: { params: VideoParams; onChange: Update; recipe: Recipe }) {
  const [opened, setOpened] = useState<string | null>(null);
  // ComfyUIへ問い合わせるため、「詳細」を開いたときだけ取る。
  const models = useModelOptions(recipe.workflow_version_id, opened === "detail");
  const optionsOf = (variable: string) =>
    models.data?.slots?.find((slot) => slot.variable === variable)?.options ?? [];
  const lockedNote = (name: string) => (acceptsInput(recipe, name) ? undefined : "このRecipeでは変えられません");

  return (
    <Accordion variant="contained" value={opened} onChange={setOpened}>
      <Accordion.Item value="detail">
        <Accordion.Control>詳細</Accordion.Control>
        <Accordion.Panel>
          <Stack gap="xs">
            {models.data && !models.data.backend_reachable ? (
              <Text size="xs" c="dimmed">
                ComfyUIに接続できないため、モデルの候補を出せません。名前は手で入力できます。
              </Text>
            ) : null}
            <ModelField
              label="生成モデル (unet)"
              value={params.unetName}
              options={optionsOf("unet_name")}
              onChange={(unetName) => onChange({ unetName })}
            />
            <ModelField
              label="テキストエンコーダ (clip)"
              value={params.clipName}
              options={optionsOf("clip_name")}
              onChange={(clipName) => onChange({ clipName })}
            />
            <ModelField
              label="Video VAE"
              value={params.videoVaeName}
              options={optionsOf("video_vae_name")}
              onChange={(videoVaeName) => onChange({ videoVaeName })}
            />
            <ModelField
              label="Audio VAE"
              value={params.audioVaeName}
              options={optionsOf("audio_vae_name")}
              onChange={(audioVaeName) => onChange({ audioVaeName })}
            />
            <SimpleGrid cols={2} spacing="xs">
              <NumberInput
                label="steps"
                size="xs"
                min={1}
                max={1000}
                allowDecimal={false}
                value={params.steps}
                onChange={(value) => onChange({ steps: asNumber(value, params.steps) })}
              />
              <NumberInput
                label="fps"
                size="xs"
                min={1}
                max={120}
                decimalScale={2}
                value={params.fps}
                onChange={(value) => onChange({ fps: asNumber(value, params.fps) })}
                disabled={!acceptsInput(recipe, "fps")}
                description={lockedNote("fps")}
              />
              <TextInput
                label="sampler"
                size="xs"
                value={params.samplerName}
                onChange={(event) => onChange({ samplerName: event.currentTarget.value })}
                disabled={!acceptsInput(recipe, "sampler_name")}
                description={lockedNote("sampler_name")}
              />
              <TextInput
                label="scheduler"
                size="xs"
                value={params.schedulerName}
                onChange={(event) => onChange({ schedulerName: event.currentTarget.value })}
                disabled={!acceptsInput(recipe, "scheduler")}
                description={lockedNote("scheduler")}
              />
            </SimpleGrid>
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

/** 常に出すパラメータ (サイズ・長さ・seed) と、「詳細」に折りたたむパラメータ (steps・sampler・scheduler・モデル・fps)。 */
export function VideoParamsFields({
  params,
  onChange,
  recipe,
}: {
  params: VideoParams;
  onChange: Update;
  recipe: Recipe;
}) {
  return (
    <Stack gap="sm">
      <SizeField params={params} onChange={onChange} />
      <LengthField params={params} onChange={onChange} />
      <SeedField params={params} onChange={onChange} />
      <DetailFields params={params} onChange={onChange} recipe={recipe} />
    </Stack>
  );
}
