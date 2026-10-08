import {
  Accordion,
  Autocomplete,
  Group,
  NumberInput,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { useState } from "react";

import type { Recipe } from "../api/client";
import { acceptsInput } from "../imageGen/imageForm";
import { useModelOptions } from "../imageGen/useImageGen";
import {
  composeBgmTags,
  COUNT_MAX,
  INSTRUMENTAL_TAG,
  SECONDS_MAX,
  SEED_INPUT_MAX,
  type BgmForm,
} from "./bgmForm";

type Update = (update: Partial<BgmForm>) => void;

/** NumberInputの空欄は直前の値のままにする。 */
function asNumber(value: string | number, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

/** 日本語の雰囲気欄・タグ欄・歌詞欄。歌詞が空のときは`instrumental`を補うので、投入するタグを見せる。 */
export function BgmPromptFields({ form, onChange }: { form: BgmForm; onChange: Update }) {
  const composed = composeBgmTags(form);
  const instrumental = form.lyrics.trim() === "";
  return (
    <Stack gap="sm">
      <Textarea
        label="雰囲気 (日本語)"
        description="Sceneを選ぶと、Sceneの「BGMの雰囲気」が入ります。タグへの変換にはまだ対応していません。"
        autosize
        minRows={2}
        maxRows={6}
        value={form.moodJa}
        onChange={(event) => onChange({ moodJa: event.currentTarget.value })}
        data-testid="bgm-mood"
      />
      <Textarea
        label="タグ *"
        description="mood、genre、楽器、テンポをカンマ区切りで並べる。"
        autosize
        minRows={2}
        maxRows={8}
        value={form.tags}
        onChange={(event) => onChange({ tags: event.currentTarget.value })}
        data-testid="bgm-tags"
      />
      <Textarea
        label="歌詞"
        description={`空のときは ${INSTRUMENTAL_TAG} をタグに付けて投入します。`}
        autosize
        minRows={2}
        maxRows={10}
        value={form.lyrics}
        onChange={(event) => onChange({ lyrics: event.currentTarget.value })}
        data-testid="bgm-lyrics"
      />
      <Text size="xs" c="dimmed" data-testid="bgm-composed-tags" data-instrumental={instrumental}>
        投入するタグ: {composed === "" ? "(空)" : composed}
      </Text>
    </Stack>
  );
}

function DetailFields({ form, onChange, recipe }: { form: BgmForm; onChange: Update; recipe: Recipe }) {
  const [opened, setOpened] = useState<string | null>(null);
  // ComfyUIへ問い合わせるため、「詳細」を開いたときだけ取る。
  const models = useModelOptions(recipe.workflow_version_id, opened === "detail");
  const ckptOptions = models.data?.slots?.find((slot) => slot.variable === "ckpt_name")?.options ?? [];
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
            <Autocomplete
              label="生成モデル"
              size="xs"
              value={form.ckptName}
              data={ckptOptions}
              onChange={(ckptName) => onChange({ ckptName })}
            />
            <Textarea
              label="避けたい要素"
              description="歌詞を入れるときは、vocals / singing を外してください。"
              size="xs"
              autosize
              minRows={1}
              maxRows={4}
              value={form.negative}
              onChange={(event) => onChange({ negative: event.currentTarget.value })}
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
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

/**
 * 常に出すパラメータ (長さ・枚数・seed) と、「詳細」に折りたたむパラメータ。
 * `seconds`は表示する長さ (秒)。`secondsNote`に既定値の出どころを添える。
 */
export function BgmParamsFields({
  form,
  onChange,
  recipe,
  seconds,
  secondsNote,
}: {
  form: BgmForm;
  onChange: Update;
  recipe: Recipe;
  seconds: number;
  secondsNote: string;
}) {
  return (
    <Stack gap="sm">
      <Group align="flex-start" gap="sm">
        <NumberInput
          label="長さ (秒)"
          w={220}
          min={1}
          max={SECONDS_MAX}
          step={1}
          decimalScale={1}
          value={seconds}
          onChange={(value) => typeof value === "number" && onChange({ seconds: value })}
          description={secondsNote}
          data-testid="bgm-seconds"
        />
        <NumberInput
          label="枚数"
          w={100}
          min={1}
          max={COUNT_MAX}
          allowDecimal={false}
          value={form.count}
          onChange={(value) => onChange({ count: asNumber(value, form.count) })}
          data-testid="bgm-count"
        />
      </Group>
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
            value={form.seedMode}
            onChange={(seedMode) => onChange({ seedMode: seedMode as BgmForm["seedMode"] })}
          />
        </Stack>
        {form.seedMode === "fixed" ? (
          <NumberInput
            aria-label="seedの値"
            w={200}
            min={0}
            max={SEED_INPUT_MAX}
            allowDecimal={false}
            value={form.seed}
            onChange={(value) => onChange({ seed: asNumber(value, form.seed) })}
          />
        ) : null}
      </Group>
      {form.seedMode === "fixed" && form.count > 1 ? (
        <Text size="xs" c="dimmed">
          枚数が2以上のときは、Jobごとにseedを1ずつ増やします。
        </Text>
      ) : null}
      <DetailFields form={form} onChange={onChange} recipe={recipe} />
    </Stack>
  );
}
