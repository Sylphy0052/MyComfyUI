# voice-runner

音声生成 (TTS) と読み検証 (ASR) の Backend を束ねる HTTP サービス。

Application API からは常に HTTP で呼ぶ。UI と Backend が同じマシンにある構成でも、
Backend だけ別マシンにある構成でも、変わるのは接続先 URL
(`MYCOMFYUI_VOICE_RUNNER_BASE_URL`) だけで、実行経路は分岐しない。

## なぜ分けるか

- 「各 Backend を別 venv・別プロセスで起動する」責務を runner 側へ閉じ込める。
  Application API の venv へ torch と transformers を持ち込まない。
- 既存の ComfyUI Adapter が「外部で起動済みのプロセスへ HTTP で接続する」形のため、
  実行経路の作りを揃えられる。
- ローカルとリモートで経路が分かれないので、障害処理と timeout 処理を 1 系統で書ける。

## 前提

- Python 3.12 と [uv](https://docs.astral.sh/uv/)
- TTS と ASR の各 venv が、このマシンに用意されていること
- GPU は 1 度に 1 Backend だけを使う。1 リクエストにつき 1 つの Backend をロードし、
  生成が終わったらプロセスを落として VRAM を返す

runner 自身の venv には FastAPI と Uvicorn と PyYAML しか入れない。

## 設定

`engines.yaml` に engine ごとの Python path、`model_id`、`model_revision`、
`sample_rate`、`needs_katakana` を書く。値の出典は novel-writer の
`tools/ai-media/config/local-tools.yaml` の `voice` と `asr`。
ai-media 側は参照専用の契約のため、MyComfyUI からは書き換えない。

別の場所の設定を読ませるときは環境変数 `VOICE_RUNNER_CONFIG` にパスを渡す。

## 起動

起動と停止は ComfyUI と同じく外部運用とする。Application API は runner のプロセスを
起動しない。

```bash
uv run --project tools/voice-runner \
  uvicorn voice_runner.app:app --host 127.0.0.1 --port 8770
```

Backend を別マシンへ置く構成では、そのマシンで `--host 0.0.0.0` を付けて起動し、
Application API 側の `MYCOMFYUI_VOICE_RUNNER_BASE_URL` をそのホストへ向ける。
認証を持たないため、公開先は信頼できるネットワークの中だけに限る。到達できる相手は
誰でも生成を投入でき、rate limit も同時実行数の上限も無い。Application API 側の直列
キューは runner を直接叩かれると迂回されるため、`--host 0.0.0.0` で公開する場合は
ファイアウォールか VPN で到達範囲を絞る。

## Endpoint

|Endpoint|入力|出力|
|---|---|---|
|`POST /v1/speech`|engine、text、reading、参照音声 (base64)、参照テキスト、seed、timeout|wav (base64)、sample_rate、audio_sec、elapsed_sec、vram_peak_mb、model、revision、使用した seed|
|`POST /v1/transcribe`|wav (base64)、language|書き起こしテキスト、duration_sec、model|
|`GET /v1/health`|—|engine 一覧、利用可否、model、revision|

wav と参照音声は body の JSON へ base64 で載せる。リモート構成では runner 側の
ファイルシステムに参照音声が存在せず、パスでは渡せないためである。上限は 32 MiB。

`GET /v1/health` はモデルをロードしない。engine の Python 実行ファイルがあるかどうか
だけを見る。

## Backend の起動方法

`workers/` の script を、engine ごとの venv の Python で 1 回だけ実行する。

```
<engine の python> workers/tts_worker.py <request.json> <response.json>
```

入出力はファイルで渡す。stdout は進捗、stderr はモデルの警告に使われるため、結果の
受け渡しには使わない。exit code が非 0 なら失敗として扱い、**別の Backend へ自動で
fallback しない**。

`workers/` の script は runner の venv では動かない。torch と各 Backend の
ライブラリを必要とするため、engine の venv の Python から起動される前提で書いてある。

## seed の再現

3 つの engine はいずれも `seed` 引数を持たない。生成の直前に `torch.manual_seed` /
`torch.cuda.manual_seed_all` / `np.random.seed` を呼べば波形が再現することが
novel-writer の `検証_tts/06_seed固定` で 3 engine とも確認されている。worker が
生成直前にこれらを呼び、使用した seed を応答へ含める。

## 参照テキスト

`reference_transcript` には参照音声の正しい書き起こしを渡す。**嘘を渡すと生成が
破綻する** (検証_minimax/18 で 655 秒の暴走)。書き起こしを持たない Voice Canon は
実行対象にしない。

## 実機での確認

現時点ではこの runner を動かせる GPU マシンを用意できていない。Application API 側は
`MYCOMFYUI_VOICE_STUB=true` のスタブ Backend で経路を確認している。実機で確認すべき
項目は Issue #11 の「検証計画」に残してある。
