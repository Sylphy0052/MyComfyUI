import {
  Button,
  Checkbox,
  FileButton,
  Group,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { IconUpload } from "@tabler/icons-react";

import { artifactContentUrl, type StoryCharacter } from "../api/client";
import { SEED_MAX } from "../imageGen/imageForm";
import { notifyError } from "../notifications";
import { VoiceCaptionAssistField } from "./VoiceCaptionAssist";
import { useImportVoiceReference } from "./useVoice";
import { CAPTION_MAX, captionProblem, type VoiceForm } from "./voiceForm";

type Update = (update: Partial<VoiceForm>) => void;

/** NumberInputの空欄は直前の値のままにする。 */
function asNumber(value: string | number, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

/** 台詞文・読み・話者・演技指示の欄。 */
export function VoiceLineFields({
  form,
  onChange,
  characters,
  speakerId,
  projectSelected,
  loadError,
}: {
  form: VoiceForm;
  onChange: Update;
  characters: StoryCharacter[];
  /** 一覧に実在する話者のキャラID。Projectを指定していない、または一覧に無いときは`null`。 */
  speakerId: string | null;
  projectSelected: boolean;
  loadError: string | undefined;
}) {
  return (
    <Stack gap="sm">
      <Textarea
        label="台詞文 *"
        description="読み上げる文。1行ぶんを入れる。"
        autosize
        minRows={2}
        maxRows={8}
        value={form.text}
        onChange={(event) => onChange({ text: event.currentTarget.value })}
        data-testid="voice-text"
      />
      <TextInput
        label="読み"
        description="漢字の読みを直したいときに、ひらがなかカタカナで入れる。空なら台詞文のまま。"
        value={form.reading}
        onChange={(event) => onChange({ reading: event.currentTarget.value })}
        data-testid="voice-reading"
      />
      {projectSelected ? (
        <Select
          label="話者"
          description="キャラを選ぶと、そのキャラの声の参照がCloneに入ります。"
          placeholder="指定しない"
          data={characters.map((character) => ({ value: character.id, label: character.name }))}
          value={speakerId}
          onChange={(next) => onChange({ speakerId: next })}
          searchable
          clearable
          error={loadError}
          data-testid="voice-speaker"
        />
      ) : (
        <TextInput
          label="話者"
          description="名前を入れる (任意)。Projectを指定するとキャラを選べます。"
          value={form.speakerName}
          onChange={(event) => onChange({ speakerName: event.currentTarget.value })}
          data-testid="voice-speaker-name"
        />
      )}
      <Textarea
        label="演技指示"
        description="日本語で書く (任意)。例: ささやくように"
        autosize
        minRows={1}
        maxRows={4}
        value={form.direction}
        onChange={(event) => onChange({ direction: event.currentTarget.value })}
        data-testid="voice-direction"
      />
    </Stack>
  );
}

/** 声の指定。Clone (参照音声) か、声質の文章 (caption)。 */
export function VoiceSourceFields({
  form,
  onChange,
  character,
}: {
  form: VoiceForm;
  onChange: Update;
  /** 話者に選んだキャラ。 */
  character: StoryCharacter | null;
}) {
  const importer = useImportVoiceReference();
  const characterVoice = character?.voice_media_key ?? null;
  const captionError = form.caption === "" ? null : captionProblem(form.caption);
  const captionLength = [...form.caption].length;
  const artifactKey = characterVoice?.startsWith("artifact:") ? characterVoice.slice("artifact:".length) : null;

  return (
    <Stack gap="sm">
      <Stack gap={4}>
        <Text size="sm" fw={500}>
          声
        </Text>
        <SegmentedControl
          size="xs"
          data={[
            { value: "clone", label: "Clone (参照音声)" },
            { value: "caption", label: "声質の文章" },
          ]}
          value={form.mode}
          onChange={(mode) => onChange({ mode: mode as VoiceForm["mode"] })}
          data-testid="voice-mode"
        />
      </Stack>
      {form.mode === "caption" ? (
        <Stack gap="xs">
          <Textarea
            label="声質の文章 *"
            description={`声の特徴を日本語で書く。改行は使えません。${CAPTION_MAX}字以内。`}
            autosize
            minRows={2}
            maxRows={6}
            value={form.caption}
            onChange={(event) => onChange({ caption: event.currentTarget.value })}
            error={captionError}
            data-testid="voice-caption"
          />
          <VoiceCaptionAssistField
            direction={form.direction}
            storyCharacterId={character?.id ?? null}
            caption={form.caption}
            onApply={(caption) => onChange({ caption })}
          />
        </Stack>
      ) : (
        <Stack gap="xs">
          <SegmentedControl
            size="xs"
            data={[
              { value: "character", label: "キャラの声", disabled: characterVoice === null },
              { value: "file", label: "参照音声ファイル" },
            ]}
            value={form.referenceSource}
            onChange={(referenceSource) => onChange({ referenceSource: referenceSource as VoiceForm["referenceSource"] })}
            data-testid="voice-reference-source"
          />
          {form.referenceSource === "character" ? (
            <Stack gap={4} data-testid="voice-character-voice">
              {characterVoice === null ? (
                <Text size="sm" c="dimmed">
                  {character === null
                    ? "Projectを指定して話者にキャラを選ぶと、そのキャラの声を使えます。"
                    : "話者のキャラに声の参照がありません。Projectのキャラ画面で設定してください。"}
                </Text>
              ) : (
                <>
                  <Text size="sm">{character?.name}の声の参照を使います。</Text>
                  {artifactKey !== null ? (
                    <audio controls preload="none" src={artifactContentUrl(artifactKey)} style={{ width: "100%" }} />
                  ) : null}
                </>
              )}
            </Stack>
          ) : (
            <Stack gap={4}>
              <Group gap="xs">
                <FileButton
                  accept="audio/wav,audio/x-wav,.wav"
                  onChange={(file) => {
                    if (!file) return;
                    importer.importFile(
                      file,
                      (reference) => onChange({ reference, referenceSource: "file" }),
                      (error) => notifyError("参照音声をアップロードできません", error),
                    );
                  }}
                >
                  {(props) => (
                    <Button
                      {...props}
                      size="xs"
                      variant="light"
                      leftSection={<IconUpload size={14} />}
                      loading={importer.isPending}
                      data-testid="voice-reference-upload"
                    >
                      参照音声をアップロード
                    </Button>
                  )}
                </FileButton>
                <Button size="xs" variant="default" disabled={form.reference === null} onClick={() => onChange({ reference: null })}>
                  外す
                </Button>
              </Group>
              <Text size="sm" c={form.reference ? undefined : "dimmed"} data-testid="voice-reference-label">
                {form.reference?.label ?? "参照音声は未設定です (PCMのwavのみ)。結果欄の「参照音声にする」でも入れられます。"}
              </Text>
            </Stack>
          )}
        </Stack>
      )}
      {form.mode === "caption" ? (
        <Text size="xs" c="dimmed" data-testid="voice-caption-count" data-over={captionLength > CAPTION_MAX}>
          {captionLength}/{CAPTION_MAX}字
        </Text>
      ) : null}
    </Stack>
  );
}

/** 常に出すパラメータ (seed・ASRによる読みの検証)。 */
export function VoiceParamsFields({ form, onChange }: { form: VoiceForm; onChange: Update }) {
  return (
    <Stack gap="sm">
      <Group align="flex-end" gap="sm">
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            seed
          </Text>
          <SegmentedControl
            size="xs"
            data={[
              { value: "random", label: "ランダム (-1)" },
              { value: "fixed", label: "固定" },
            ]}
            value={form.seedMode}
            onChange={(seedMode) => onChange({ seedMode: seedMode as VoiceForm["seedMode"] })}
            data-testid="voice-seed-mode"
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
            data-testid="voice-seed"
          />
        ) : null}
      </Group>
      <Checkbox
        label="ASRで読みを検証する"
        description="生成した音声を書き起こし、台詞の読みと一致するか調べる。"
        checked={form.verifyAsr}
        onChange={(event) => onChange({ verifyAsr: event.currentTarget.checked })}
        data-testid="voice-verify-asr"
      />
    </Stack>
  );
}
