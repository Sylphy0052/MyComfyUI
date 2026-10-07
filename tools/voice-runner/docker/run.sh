#!/bin/bash
# 計算機サーバ上で実行: ./run.sh <gpu_index>
# 常駐させず、使い終えたら docker stop kfuruhashi-voice-runner で止める。
# --user の uid はイメージの /etc/passwd に無い。getpass.getuser() (torch が使う) は
# USER を先に読むため、USER を渡して passwd の参照を避ける。
set -eu
GPU=${1:?gpu index}
D=/ssdnas2/data/kfuruhashi
mkdir -p "$D/hf-cache"
docker run -d --rm --init --name kfuruhashi-voice-runner --gpus "device=${GPU}" \
  --user "$(id -u):$(id -g)" -e HOME=/tmp -e USER="$(id -un)" \
  -p 127.0.0.1:18770:8770 \
  -v "$D/hf-cache:/hf-cache" \
  kfuruhashi-voice-runner:irodori
