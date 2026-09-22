# MyComfyUI Web UI

Scene/Shot から画像と音声の生成を投入し、キューと候補を確認する画面。React 19、TypeScript、Vite で実装する(ADR 0001)。

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
|全幅(音声生成)|voice-runner の状態、Shot の台詞一覧、Voice Canon と参照音声の指定、音声 Job の投入、台詞ごとの読み検証と尺|

音声生成の欄では、台詞が参照する `voice_id` ごとに Voice Canon と参照音声 wav、その書き起こしを
指定する。参照 API は Voice Canon 本文を返さないため、参照音声と書き起こしは画面から渡す。
読み検証の一覧は、一致しなかった台詞と、読みの指定が無いまま不一致になった台詞(Shot へ `reading`
を追記する候補)、Shot の尺を超えた台詞を区別して表示する。

入力欄は Recipe の `input_schema` から組み立てる。モデルファイル名と ComfyUI のノード名は
Recipe の `defaults` 側に固定されており、画面には出さない。

## 進捗の追い方

Jobの状態変化は`WebSocket /api/v1/events`を再取得トリガーとして即時反映する。
初回接続、再接続、通知受信時は`GET /api/v1/generation-jobs`から確定状態を取得する。
接続中も15秒間隔で同期し、WebSocketを利用できない間は2秒間隔へ戻す。RESTで得られる状態を正本とする。

## 確認

```bash
npm run typecheck
npm run build
```
