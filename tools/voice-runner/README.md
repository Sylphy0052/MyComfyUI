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
- TTS と ASR の venv が用意されていること。`docker/` のイメージには irodori の venv が入っており、ASR も同じ venv で動く
- GPU は 1 度に 1 Backend だけを使う。1 リクエストにつき 1 つの Backend をロードし、
  生成が終わったらプロセスを落として VRAM を返す

runner 自身の venv には FastAPI と Uvicorn と PyYAML しか入れない。

## 設定

`engines.yaml` に engine ごとの Python path、`model_id`、`model_revision`、
`sample_rate`、`needs_katakana` を書く。TTS の engine は irodori だけで、Python path は
`docker/Dockerfile` のイメージ内の venv を指す。ASR (whisper) も同じ venv で動かす。

別の場所の設定を読ませるときは環境変数 `VOICE_RUNNER_CONFIG` にパスを渡す。

## 起動

起動と停止は ComfyUI と同じく外部運用とする。Application API は runner のプロセスを
起動しない。

```bash
uv run --project tools/voice-runner \
  uvicorn voice_runner.app:app --host 127.0.0.1 --port 8770
```

上の例の `--host 127.0.0.1` は、UI と Backend が同じマシンにある手元完結構成のもの
である。bind アドレスは構成で変わる。

- 手元完結構成 (UI と Backend が同一マシン): `--host 127.0.0.1`。LAN から
  到達しない。
- Remote 構成 (Backend を別マシンへ置く): `--host 0.0.0.0`。Firewall で到達元を
  手元 PC へ限定した上で使う。手順は
  [Remote GPUホストの準備](../../docs/operations/remote-gpu-host.md)の
  「ComfyUI以外のポートも同じ扱いにする」と手順 3 にある。

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

worker は生成の直前に `torch.manual_seed` / `torch.cuda.manual_seed_all` /
`np.random.seed` を呼び、irodori の `SamplingRequest.seed` にも同じ値を渡す。
使用した seed は応答へ含める。

## 参照テキスト

書き起こしを生成に使うかは engine ごとに `engines.yaml` の `uses_reference_transcript`
で決める (Issue #436)。irodori は使わないので `false` とし、`reference_audio` だけを
渡せばよい。

書き起こしを使う engine では、`reference_transcript` に参照音声の正しい書き起こしを
渡す。**嘘を渡すと生成が破綻する** (検証_minimax/18 で 655 秒の暴走)。この engine では
書き起こしの無い参照音声を 422 で拒む。書き起こしを使う engine を足すときは、
`engines.yaml` の `uses_reference_transcript: true` に加えて、Application API の
`REFERENCE_TRANSCRIPT_ENGINES` (`apps/api/src/mycomfyui_api/adapters/voice/base.py`) と
Web の同名の集合 (`apps/web/src/components/VoicePanel.tsx`) にも engine を足す。

参照を使わないときは `reference_audio` と `reference_transcript` を省き、
`caption` (声質の文章指定。例: 「落ち着いた若い女性の声」) を渡す。参照と `caption` を
両方渡すと両方を使う。どちらも無い要求と、`reference_transcript` だけの要求は 422 で
拒む。

## Irodori-TTS を Docker で動かす

`irodori` engine は [Irodori-TTS](https://github.com/Aratako/Irodori-TTS) を使う。
参照音声か `caption` で声質を決める。参照が無いときは `no_ref` で `caption` だけから作る。
`reference_transcript` は受け取るが生成には使わない。
入力は漢字かな交じりのままでよい。

計算機サーバでは `docker/Dockerfile` のイメージで runner ごと動かす。イメージには
runner 本体の venv (`/opt/runner`) と Irodori-TTS の venv (`/opt/irodori/.venv`) を
分けて入れてあり、`engines.yaml` の `irodori.python` は後者を指す。ほかの engine の
venv はイメージに無いため、`GET /v1/health` では `available: false` になる。

```bash
# tools/voice-runner をサーバへ置き、そのディレクトリで実行する
docker build -f docker/Dockerfile -t kfuruhashi-voice-runner:irodori .
nvidia-smi                 # 空いている GPU を確かめる
docker/run.sh <gpu_index>  # 127.0.0.1:18770 で待ち受ける
docker stop kfuruhashi-voice-runner-g<gpu_index>  # 使い終えたら止める
```

コンテナ名は GPU 番号を含む (`kfuruhashi-voice-runner-g0` など)。別 GPU で同時に
起動するときは、ホスト側ポートが重ならないよう `VOICE_RUNNER_HOST_PORT=18771 docker/run.sh 1`
のように変える。

モデル (`Aratako/Irodori-TTS-v4.1-Small` とコーデック
`Aratako/Semantic-DACVAE-Japanese-32dim`) は `engines.yaml` の `model_revision` と
`codec_revision` (HF の commit sha) で固定してあり、`/ssdnas2/data/kfuruhashi/hf-cache`
へ取得する。tokenizer はモデルの repo に同梱されている。取得を初回の生成まで
遅らせると、回線が遅いときに `timeout_sec: 300` に掛かる。初回の前に次で取得しておく。
GPU は使わない。

```bash
y() { awk -v k="$1:" '$1 == k {print $2}' engines.yaml; }
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e USER="$(id -un)" \
  -e MODEL_REV="$(y model_revision)" -e CODEC_REV="$(y codec_revision)" \
  -v /ssdnas2/data/kfuruhashi/hf-cache:/hf-cache kfuruhashi-voice-runner:irodori \
  /opt/irodori/.venv/bin/python -c '
import os
from huggingface_hub import hf_hub_download, snapshot_download
snapshot_download("Aratako/Irodori-TTS-v4.1-Small", revision=os.environ["MODEL_REV"],
                  allow_patterns=["model.safetensors", "tokenizer/*"])
hf_hub_download("Aratako/Semantic-DACVAE-Japanese-32dim", "weights.pth",
                revision=os.environ["CODEC_REV"])'
```

`model_revision` を更新するときは
`curl -s https://huggingface.co/api/models/<repo> | jq -r .sha` で現在の sha を取る。
ASR の `openai/whisper-large-v3-turbo` は固定していない。
手元の Application API からは
`ssh.exe -L 8770:127.0.0.1:18770 <server>` で転送し、
`MYCOMFYUI_VOICE_RUNNER_BASE_URL=http://127.0.0.1:8770` で接続する。

2026-10-07 に g18 (A100 1 枚) で `POST /v1/speech` が 200 を返し、48kHz の wav を得た
ことを確認した。7 秒の台詞で生成は約 22 秒 (モデル読み込み込み)、VRAM のピークは約 4.5GB。
同じ参照音声・本文・seed で 2 回生成した wav はバイト単位で一致した。

## 実機での確認

Remote GPU ホストは 2026-09-20 に構築した。runner の常駐手順は
[Remote GPUホストの準備](../../docs/operations/remote-gpu-host.md)の手順 3 にある。

この runner を実機で起動して生成を通した確認はまだ取れていない。Application API 側は
`MYCOMFYUI_VOICE_STUB=true` のスタブ Backend で経路を確認している。実機で確認すべき
項目は Issue #11 の「検証計画」に残してある。
