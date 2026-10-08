import { Alert, type MantineSpacing } from "@mantine/core";

/** 取り直しの失敗。表示中の値と編集欄は残したまま、古いかもしれないことだけを知らせる。 */
export function RefetchErrorAlert({ error, mb }: { error: Error | null; mb?: MantineSpacing }) {
  if (!error) return null;
  return (
    <Alert color="red" variant="light" py="xs" mb={mb}>
      最新の状態を取得できません。表示は古い可能性があります: {error.message}
    </Alert>
  );
}
