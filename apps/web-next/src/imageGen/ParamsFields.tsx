import {
  Accordion,
  ActionIcon,
  Autocomplete,
  Group,
  NumberInput,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { IconArrowsExchange } from "@tabler/icons-react";
import { useState, type ReactNode } from "react";

import type { Recipe } from "../api/client";
import { acceptsInput, BATCH_MAX, presetOf, SEED_MAX, SIZE_PRESETS, type ImageForm, type SeedMode } from "./imageForm";
import { useModelOptions } from "./useImageGen";

type Update = (update: Partial<ImageForm>) => void;

/** NumberInputの空欄は直前の値のままにする。 */
function asNumber(value: string | number, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function SizeField({ form, onChange }: { form: ImageForm; onChange: Update }) {
  const preset = presetOf(form.width, form.height);
  const landscape = form.width > form.height;
  return (
    <Stack gap={4}>
      <Text size="sm" fw={500}>
        サイズ
      </Text>
      <Group gap="xs">
        <SegmentedControl
          size="xs"
          data={SIZE_PRESETS.map((item) => item.label)}
          value={preset ?? ""}
          onChange={(label) => {
            const next = SIZE_PRESETS.find((item) => item.label === label);
            if (!next) return;
            onChange(
              landscape ? { width: next.long, height: next.short } : { width: next.short, height: next.long },
            );
          }}
        />
        <Tooltip label="縦横を入れ替える">
          <ActionIcon
            variant="default"
            aria-label="縦横を入れ替える"
            onClick={() => onChange({ width: form.height, height: form.width })}
          >
            <IconArrowsExchange size={16} />
          </ActionIcon>
        </Tooltip>
        <Text size="sm" data-testid="image-size">
          {form.width}×{form.height}
          {preset === null ? " (カスタム)" : ""}
        </Text>
      </Group>
    </Stack>
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

function DetailFields({
  form,
  onChange,
  recipe,
  extra,
}: {
  form: ImageForm;
  onChange: Update;
  recipe: Recipe;
  extra?: ReactNode;
}) {
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
            {extra}
            <ModelField
              label="生成モデル (unet)"
              value={form.unetName}
              options={optionsOf("unet_name")}
              onChange={(unetName) => onChange({ unetName })}
            />
            <ModelField
              label="テキストエンコーダ (clip)"
              value={form.clipName}
              options={optionsOf("clip_name")}
              onChange={(clipName) => onChange({ clipName })}
            />
            <ModelField
              label="VAE"
              value={form.vaeName}
              options={optionsOf("vae_name")}
              onChange={(vaeName) => onChange({ vaeName })}
            />
            <SimpleGrid cols={2} spacing="xs">
              <NumberInput
                label="steps"
                size="xs"
                min={1}
                max={1000}
                value={form.steps}
                onChange={(value) => onChange({ steps: asNumber(value, form.steps) })}
              />
              <NumberInput
                label="cfg"
                size="xs"
                min={0.1}
                max={100}
                step={0.5}
                decimalScale={2}
                value={form.cfg}
                onChange={(value) => onChange({ cfg: asNumber(value, form.cfg) })}
              />
              <TextInput
                label="sampler"
                size="xs"
                value={form.samplerName}
                onChange={(event) => onChange({ samplerName: event.currentTarget.value })}
                disabled={!acceptsInput(recipe, "sampler_name")}
                description={lockedNote("sampler_name")}
              />
              <TextInput
                label="scheduler"
                size="xs"
                value={form.scheduler}
                onChange={(event) => onChange({ scheduler: event.currentTarget.value })}
                disabled={!acceptsInput(recipe, "scheduler")}
                description={lockedNote("scheduler")}
              />
            </SimpleGrid>
            {acceptsInput(recipe, "hires_enabled") ? (
              <Switch
                label="hires (拡大してかけ直す)"
                checked={form.hiresEnabled}
                onChange={(event) => onChange({ hiresEnabled: event.currentTarget.checked })}
              />
            ) : null}
            {form.hiresEnabled && acceptsInput(recipe, "hires_enabled") ? (
              <SimpleGrid cols={3} spacing="xs">
                <NumberInput
                  label="倍率"
                  size="xs"
                  min={1}
                  max={4}
                  step={0.25}
                  decimalScale={2}
                  value={form.hiresScale}
                  onChange={(value) => onChange({ hiresScale: asNumber(value, form.hiresScale) })}
                />
                <NumberInput
                  label="steps (0で1段目と同じ)"
                  size="xs"
                  min={0}
                  max={1000}
                  value={form.hiresSteps}
                  onChange={(value) => onChange({ hiresSteps: asNumber(value, form.hiresSteps) })}
                />
                <NumberInput
                  label="denoise"
                  size="xs"
                  min={0}
                  max={1}
                  step={0.05}
                  decimalScale={2}
                  value={form.hiresDenoise}
                  onChange={(value) => onChange({ hiresDenoise: asNumber(value, form.hiresDenoise) })}
                />
              </SimpleGrid>
            ) : null}
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

/**
 * 常に出すパラメータ (サイズ・枚数・seed) と、「詳細」に折りたたむパラメータ。
 * Recipeが受け付けない項目 (修正のサイズ・枚数など) は出さない。`detailExtra`は「詳細」の先頭に足す。
 */
export function ParamsFields({
  form,
  onChange,
  recipe,
  detailExtra,
}: {
  form: ImageForm;
  onChange: Update;
  recipe: Recipe;
  detailExtra?: ReactNode;
}) {
  return (
    <Stack gap="sm">
      {acceptsInput(recipe, "width") ? <SizeField form={form} onChange={onChange} /> : null}
      <Group align="flex-end" gap="sm">
        {acceptsInput(recipe, "batch_size") ? (
          <NumberInput
            label="枚数"
            w={100}
            min={1}
            max={BATCH_MAX}
            value={form.batchSize}
            onChange={(value) => onChange({ batchSize: asNumber(value, form.batchSize) })}
          />
        ) : null}
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
            value={form.seedMode}
            onChange={(seedMode) => onChange({ seedMode: seedMode as SeedMode })}
          />
        </Stack>
        {form.seedMode === "fixed" ? (
          <NumberInput
            aria-label="seedの値"
            w={200}
            min={0}
            max={SEED_MAX}
            allowDecimal={false}
            value={form.seed}
            onChange={(value) => onChange({ seed: asNumber(value, form.seed) })}
          />
        ) : null}
      </Group>
      <DetailFields form={form} onChange={onChange} recipe={recipe} extra={detailExtra} />
    </Stack>
  );
}
