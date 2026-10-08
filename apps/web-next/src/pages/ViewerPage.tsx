import { Alert, Stack, Tabs, Title } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import { ArtifactDrawer } from "../viewer/ArtifactDrawer";
import { ImageTab } from "../viewer/ImageTab";
import { TrashTab } from "../viewer/TrashTab";
import { useJobArtifact } from "../viewer/useViewer";
import { ViewerFilterBar } from "../viewer/ViewerFilterBar";
import { mediaItemsQuery, readFilters, readTab, writeFilters, type ViewerFilters } from "../viewer/viewerFilters";

/**
 * `/viewer`。タブとフィルタはURLに持たせ、開き直すと同じ条件で出す。
 * `?job=`で来たときは (Jobのドロワーの「結果を開く」)、そのJobの生成物を詳細で開く。
 */
export function ViewerPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = readTab(searchParams);
  const filters = readFilters(searchParams);
  const jobId = searchParams.get("job");
  const jobArtifact = useJobArtifact(jobId);
  const [openedId, setOpenedId] = useState<string | null>(null);
  const drawerId = openedId ?? (jobId !== null ? (jobArtifact.data?.id ?? null) : null);

  // react-routerの`setSearchParams`は関数で渡しても描画時のURLを元にするので、URLへの反映前に続けて操作すると
  // 前の変更が消える。最後に書いたURLを持っておき、そこへ重ねる。
  const latestParams = useRef(searchParams);
  useEffect(() => {
    latestParams.current = searchParams;
  }, [searchParams]);
  const updateParams = (update: (params: URLSearchParams) => URLSearchParams) => {
    const params = update(new URLSearchParams(latestParams.current));
    latestParams.current = params;
    setSearchParams(params, { replace: true });
  };

  const setFilters = (patch: Partial<ViewerFilters>) =>
    updateParams((params) => writeFilters(params, { ...readFilters(params), ...patch }));
  const setTab = (next: string | null) =>
    updateParams((params) => {
      if (next === "trash") params.set("tab", "trash");
      else params.delete("tab");
      return params;
    });
  const closeDrawer = () => {
    setOpenedId(null);
    // 閉じたあとに同じJobの結果が開き直さないよう、`job`を外す。
    if (jobId !== null)
      updateParams((params) => {
        params.delete("job");
        return params;
      });
  };

  return (
    <Stack>
      <Title order={2}>Viewer</Title>
      {jobId !== null && jobArtifact.data === null ? (
        <Alert color="yellow" variant="light">
          このJobの生成物はありません (まだ終わっていないか、ゴミ箱にあります)。
        </Alert>
      ) : null}
      {jobArtifact.error ? <Alert color="red">Jobの生成物を取得できません: {jobArtifact.error.message}</Alert> : null}
      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          <Tabs.Tab value="image">画像</Tabs.Tab>
          <Tabs.Tab value="trash">ゴミ箱</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="image" pt="md">
          {tab === "image" ? (
            <Stack gap="sm">
              <ViewerFilterBar filters={filters} onChange={setFilters} />
              {/* 条件が変わったら選択を持ち越さないよう、絞り込みごとに作り直す。 */}
              <ImageTab key={mediaItemsQuery(filters).toString()} filters={filters} onOpen={setOpenedId} />
            </Stack>
          ) : null}
        </Tabs.Panel>
        <Tabs.Panel value="trash" pt="md">
          {tab === "trash" ? <TrashTab onOpen={setOpenedId} /> : null}
        </Tabs.Panel>
      </Tabs>
      <ArtifactDrawer artifactId={drawerId} onClose={closeDrawer} />
    </Stack>
  );
}
