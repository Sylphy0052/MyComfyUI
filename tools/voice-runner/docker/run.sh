#!/bin/bash
# 計算機サーバ上で実行: ./run.sh <gpu_index>
# 常駐させず、使い終えたら docker stop kfuruhashi-voice-runner-g<gpu_index> で止める。
# コンテナ名はGPU番号を含む。別GPUで同時に起動するときは、ホスト側ポートが重ならない
# よう VOICE_RUNNER_HOST_PORT (既定 18770) を変える。
# --user の uid はイメージの /etc/passwd に無い。getpass.getuser() (torch が使う) は
# USER を先に読むため、USER を渡して passwd の参照を避ける。
set -eu
GPU=${1:?gpu index}
[[ $GPU =~ ^[0-9]+$ ]] || { echo "gpu index must be a number: $GPU" >&2; exit 2; }
HOST_PORT=${VOICE_RUNNER_HOST_PORT:-18770}
[[ $HOST_PORT =~ ^[0-9]+$ ]] && ((HOST_PORT >= 1 && HOST_PORT <= 65535)) \
  || { echo "VOICE_RUNNER_HOST_PORT must be 1-65535: $HOST_PORT" >&2; exit 2; }
D=/ssdnas2/data/kfuruhashi
mkdir -p "$D/hf-cache"
rc=0
out=$(docker run -d --rm --init --name "kfuruhashi-voice-runner-g${GPU}" --gpus "device=${GPU}" \
  --cap-drop ALL --security-opt no-new-privileges \
  --user "$(id -u):$(id -g)" -e HOME=/tmp -e USER="$(id -un)" \
  -p "127.0.0.1:${HOST_PORT}:8770" \
  -v "$D/hf-cache:/hf-cache" \
  kfuruhashi-voice-runner:irodori 2>&1) || rc=$?
if ((rc != 0)); then
  echo "$out" >&2
  # docker のエラー文言 (port is already allocated / address already in use) でポート衝突を判定する
  if grep -qiE 'port is already allocated|address already in use' <<<"$out"; then
    echo "ホスト側ポート ${HOST_PORT} は使用中です。VOICE_RUNNER_HOST_PORT で変えられます (例: VOICE_RUNNER_HOST_PORT=$((HOST_PORT + 1)) $0 ${GPU})。" >&2
  fi
  exit "$rc"
fi
echo "$out"
