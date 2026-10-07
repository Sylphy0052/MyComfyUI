#!/bin/bash
# g18上で実行: ./run.sh <gpu_index>。Qwen3.8-27B (UD-IQ3_S) をllama.cpp serverで起動する。
# OpenAI互換APIを127.0.0.1:18000にだけ公開する。常駐させず、使い終えたら docker stop kfuruhashi-qwen
set -eu
GPU=${1:?gpu index}
D=/ssdnas2/data/kfuruhashi
docker run -d --rm --init --name kfuruhashi-qwen --gpus "device=${GPU}" --user "$(id -u):$(id -g)" \
  -p 127.0.0.1:18000:8080 \
  -v $D/llm-models:/models:ro \
  ghcr.io/ggml-org/llama.cpp:server-cuda \
  -m /models/Qwen3.8-27B-UD-IQ3_S.gguf --alias qwen3.8-27b-ud-iq3s \
  -c 16384 -ngl 999 --jinja --host 0.0.0.0 --port 8080
