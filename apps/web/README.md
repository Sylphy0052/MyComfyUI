# MyComfyUI Web UI

Scene/Shot から画像生成を投入し、キューと候補を確認する画面。React 19、TypeScript、Vite で実装する(ADR 0001)。

## 前提

- Node.js 24 LTS(`.node-version`)
- Application API が `127.0.0.1:8000` で起動していること

## セットアップと起動

依存はリポジトリ直下の npm workspaces で管理する。

```bash
npm ci
npm run dev
```

`npm run dev` は Vite を `127.0.0.1:5173` で起動し、`/api` を Application API へ中継する。
画面からは同一 origin として扱う。API は別プロセスで起動する。

```bash
npm run api:dev
```

## 契約と型

画面が使う TypeScript 型は OpenAPI スナップショットから生成する。手書きの重複型を正本にしない。

```bash
npm run contracts
```

`apps/web/src/api/schema.d.ts` は生成物のため直接編集しない。

ai-media 参照 API の本文は Application API が中継するだけで、OpenAPI 上は任意の object になる。
画面が読む項目だけを `src/api/aimedia.ts` に宣言する。正本は
`contracts/ai-media/v1/schema/reference-api.schema.json` とする。

## 画面

|領域|内容|
|---|---|
|左|Project、Scene、Shot の選択。選択中の Scene と Shot は `revision`、`path`、`sha256` を表示する|
|中央|Recipe の選択と入力、候補画像の比較と採否|
|右|Job キュー、状態、失敗理由、取消、再投入に必要な入力|

入力欄は Recipe の `input_schema` から組み立てる。モデルファイル名と ComfyUI のノード名は
Recipe の `defaults` 側に固定されており、画面には出さない。

## 進捗の追い方

Job の状態は `GET /api/v1/generation-jobs` を 2 秒間隔で取得して更新する。
ADR 0001 が定める WebSocket 通知(`/api/v1/events`)は未実装で、#9 以降で追加する。
REST で得られる状態を正本とする方針は変えない。

## 確認

```bash
npm run typecheck
npm run build
```
