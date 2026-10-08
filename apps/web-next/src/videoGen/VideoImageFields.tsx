import { Button, CloseButton, Group, Image, SimpleGrid, Stack, Text } from "@mantine/core";

import type { StoryCharacter } from "../api/client";
import type { SourceImage } from "../imageGen/deriveForm";
import type { ImageTarget } from "../imageGen/imageForm";
import { SourceImagePicker } from "../imageGen/SourceImagePicker";
import { REFERENCES_MAX, refKeyOf, type VideoImage } from "./videoForm";

type PickerProps = {
  /** 取り込みを待つ選び方で使う。取り込む前に呼び、返り値へ画像を渡す。 */
  reservePick: () => (source: SourceImage) => void;
  onPick: (source: SourceImage) => void;
  target: ImageTarget;
  characters: StoryCharacter[];
};

const NO_CARRY_NOTE = "選んだ画像のProject・Scene・キャラ・衣装は、上の対象へは引き継ぎません。";

function noop() {
  // 選んだ画像の表示はこのファイルで持つため、ピッカー側の「選び直す」は使わない。
}

/** 画像から: 先頭フレームを1枚選ぶ。生成物、衣装の参照画像、アップロードから選べる。 */
export function FirstFrameField({
  image,
  onClear,
  ...picker
}: PickerProps & { image: VideoImage | null; onClear: () => void }) {
  return (
    <Stack gap="xs" data-testid="first-frame-field">
      {image !== null ? (
        <Group gap="sm" wrap="nowrap" data-testid="first-frame-selected">
          <Image src={image.previewUrl} alt="選んだ先頭フレーム" h={96} w="auto" fit="contain" />
          <Stack gap={4}>
            <Text size="xs" c="dimmed">
              {image.label}
              {image.auto ? " (自動で入れました)" : ""}
            </Text>
            <Button size="compact-xs" variant="default" onClick={onClear}>
              選び直す
            </Button>
          </Stack>
        </Group>
      ) : (
        <Text size="xs" c="dimmed">
          先頭フレームが未選択です。下から1枚選んでください。
        </Text>
      )}
      <SourceImagePicker
        source={null}
        onClear={noop}
        hideSelection
        title="先頭フレームを選ぶ"
        note={NO_CARRY_NOTE}
        {...picker}
      />
    </Stack>
  );
}

/** 参照から: 参照画像を1〜`REFERENCES_MAX`枚選ぶ。上限に達したら、外すまで足せない。 */
export function ReferencesField({
  images,
  onRemove,
  ...picker
}: PickerProps & { images: VideoImage[]; onRemove: (index: number) => void }) {
  const full = images.length >= REFERENCES_MAX;
  return (
    <Stack gap="xs" data-testid="references-field">
      <Text size="sm" fw={500}>
        {`参照画像 (${images.length}/${REFERENCES_MAX})`}
      </Text>
      {images.length === 0 ? (
        <Text size="xs" c="dimmed">
          参照画像が未選択です。下から1〜{REFERENCES_MAX}枚選んでください。
        </Text>
      ) : (
        <SimpleGrid cols={4} spacing="xs">
          {images.map((image, index) => (
            <Stack key={refKeyOf(image.ref)} gap={2} pos="relative" data-testid="reference-item">
              <Image src={image.previewUrl} alt={`参照画像${index + 1}`} h={80} fit="cover" />
              <Text size="xs" c="dimmed" truncate>
                {image.label}
                {image.auto ? " (自動)" : ""}
              </Text>
              <CloseButton
                size="sm"
                pos="absolute"
                top={2}
                right={2}
                variant="filled"
                aria-label={`参照画像${index + 1}を外す`}
                onClick={() => onRemove(index)}
              />
            </Stack>
          ))}
        </SimpleGrid>
      )}
      {full ? (
        <Text size="xs" c="dimmed" data-testid="references-full">
          参照画像は{REFERENCES_MAX}枚までです。足すには、どれかを外してください。
        </Text>
      ) : (
        <SourceImagePicker
          source={null}
          onClear={noop}
          hideSelection
          title="参照画像を追加"
          note={NO_CARRY_NOTE}
          {...picker}
        />
      )}
    </Stack>
  );
}
