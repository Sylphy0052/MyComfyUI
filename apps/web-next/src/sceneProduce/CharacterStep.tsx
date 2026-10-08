import { Alert, Badge, Button, Group, Loader, Paper, Stack, Text } from "@mantine/core";
import { useState } from "react";

import type { StoryCharacter, StoryCostume, StoryScene } from "../api/client";
import { ImageWorkspace } from "../imageGen/ImageWorkspace";
import type { ImageStorageKeys, ImageTarget } from "../imageGen/imageForm";
import { useTxt2ImgRecipe } from "../imageGen/useImageGen";
import { MediaThumb } from "../projectDetail/MediaThumb";
import { useCharacters } from "../projectDetail/useStory";

/**
 * シーン生成のキャラ画像の保存先。`/image`の保存値を上書きしないよう別のkeyにする。
 * 衣装ごとにも分け、別のキャラの入力値・結果・外したタグを持ち越さない。
 */
function storageKeysOf(characterId: string, costumeId: string): ImageStorageKeys {
  const suffix = `${characterId}:${costumeId}`;
  return {
    input: `web-next:scene-produce-character-input:${suffix}`,
    results: `web-next:scene-produce-character-results:${suffix}`,
    sweeps: `web-next:scene-produce-character-sweeps:${suffix}`,
  };
}

/** 行に並べるサムネイルの数。 */
const THUMB_MAX = 4;

type Row = {
  key: string;
  character: StoryCharacter | null;
  /** 衣装の指定が無い (`costume_id`が空) 登場。 */
  noCostume: boolean;
  costume: StoryCostume | null;
};

function rowsOf(scene: StoryScene, characters: StoryCharacter[]): Row[] {
  return scene.cast.map((entry, index) => {
    const character = characters.find((item) => item.id === entry.character_id) ?? null;
    const noCostume = !entry.costume_id;
    const costume = noCostume ? null : (character?.costumes.find((item) => item.id === entry.costume_id) ?? null);
    return { key: `${index}:${entry.character_id}:${entry.costume_id ?? ""}`, character, noCostume, costume };
  });
}

/** 行の参照画像のmedia key。衣装なしの登場は肖像で代える (`hasAllReferenceImages`と同じ解釈)。 */
function referenceKeysOf(row: Row): string[] {
  if (row.noCostume) return row.character?.portrait_media_key ? [row.character.portrait_media_key] : [];
  return row.costume?.reference_images ?? [];
}

function RowBadge({ row, count }: { row: Row; count: number }) {
  if (row.noCostume) {
    return (
      <Badge color="gray" variant="outline">
        衣装なし
      </Badge>
    );
  }
  if (row.costume === null) {
    return (
      <Badge color="red" variant="outline">
        衣装が見つかりません
      </Badge>
    );
  }
  return count > 0 ? (
    <Badge color="green" variant="light">
      参照あり
    </Badge>
  ) : (
    <Badge color="gray" variant="outline">
      参照なし
    </Badge>
  );
}

/** キャラ画像の工程。登場キャラ×衣装の参照画像の有無を出し、無ければその場で生成して衣装の参照に足す。 */
export function CharacterStep({ projectId, scene }: { projectId: string; scene: StoryScene }) {
  const characters = useCharacters(projectId);
  const recipe = useTxt2ImgRecipe();
  const [openKey, setOpenKey] = useState<string | null>(null);

  if (characters.isPending) return <Loader size="sm" />;
  if (characters.data === undefined) {
    return <Alert color="red">{characters.error?.message ?? "キャラを取得できません。"}</Alert>;
  }
  if (scene.cast.length === 0) {
    return (
      <Text c="dimmed" size="sm" mt="sm" data-testid="character-empty">
        登場キャラがいないため、この工程は不要です。
      </Text>
    );
  }

  const rows = rowsOf(scene, characters.data);
  const opened = rows.find((row) => row.key === openKey) ?? null;
  // 参照画像の生成はシーンに紐づけない。シーンの背景・時間帯・ポーズは補完タグに入れない。
  const workspace =
    opened?.character && opened.costume
      ? {
          target: {
            projectId,
            sceneId: null,
            characterId: opened.character.id,
            costumeId: opened.costume.id,
            extraCast: [],
          } satisfies ImageTarget,
          storageKeys: storageKeysOf(opened.character.id, opened.costume.id),
          title: `${opened.character.name} / ${opened.costume.name}`,
        }
      : null;

  return (
    <Stack gap="md" mt="sm">
      <Stack gap="xs" data-testid="character-rows">
        {rows.map((row) => {
          const keys = referenceKeysOf(row);
          const state = row.noCostume ? "no-costume" : keys.length > 0 ? "has-reference" : "no-reference";
          const canGenerate = !row.noCostume && row.costume !== null && keys.length === 0;
          // 参照に追加して参照ありに変わっても、開いている行は閉じられるようにする。
          const isOpen = row.key === openKey;
          return (
            <Paper key={row.key} withBorder p="xs" data-testid="character-row" data-state={state}>
              <Group justify="space-between" wrap="nowrap">
                <Group wrap="nowrap">
                  <Stack gap={0}>
                    <Text fw={500} data-testid="character-row-name">
                      {row.character?.name ?? "キャラが見つかりません"}
                    </Text>
                    <Text size="sm" c="dimmed" data-testid="character-row-costume">
                      {row.noCostume ? "衣装なし" : (row.costume?.name ?? "-")}
                    </Text>
                  </Stack>
                  <Text size="sm" data-testid="character-row-count">
                    参照画像{keys.length}枚
                  </Text>
                  <Group gap={4}>
                    {keys.slice(0, THUMB_MAX).map((key) => (
                      <MediaThumb key={key} mediaKey={key} size={40} />
                    ))}
                  </Group>
                </Group>
                <Group wrap="nowrap">
                  <RowBadge row={row} count={keys.length} />
                  {canGenerate || isOpen ? (
                    <Button
                      size="compact-sm"
                      variant={isOpen ? "filled" : "light"}
                      onClick={() => setOpenKey(isOpen ? null : row.key)}
                      data-testid="character-generate"
                    >
                      {isOpen ? "閉じる" : "生成する"}
                    </Button>
                  ) : null}
                </Group>
              </Group>
            </Paper>
          );
        })}
      </Stack>
      {workspace && recipe.isPending ? <Loader size="sm" /> : null}
      {workspace && recipe.isError ? (
        <Alert color="red">{recipe.error?.message ?? "Recipeを取得できません。"}</Alert>
      ) : null}
      {workspace && recipe.data === null ? <Alert color="yellow">新規生成のRecipeがありません。</Alert> : null}
      {workspace && recipe.data ? (
        <div data-testid="character-workspace">
          {/* 行を切り替えたら、その衣装の保存値で入力欄を作り直す。 */}
          <ImageWorkspace
            key={openKey}
            recipe={recipe.data}
            target={workspace.target}
            storageKeys={workspace.storageKeys}
            includeScene={false}
            title={workspace.title}
          />
        </div>
      ) : null}
    </Stack>
  );
}
