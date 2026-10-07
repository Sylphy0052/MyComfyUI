# voice-runner を Irodori-TTS エンジン付きで動かすイメージ。
# build context は tools/voice-runner。
#
#   docker build -f docker/Dockerfile -t kfuruhashi-voice-runner:irodori .
#
# runner 本体と Irodori-TTS は venv を分ける (pyproject.toml の方針)。
# engines.yaml の irodori.python はこのイメージの /opt/irodori/.venv/bin/python を指す。
FROM python:3.12.15-slim

# torchcodec (torchaudio の読み込み) が FFmpeg の共有ライブラリを使う。
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.8.24 /uv /usr/local/bin/uv
# Irodori-TTS は .python-version で 3.10 を指定しているため uv に取得させる。
# run.sh は --user で動かすので、/root ではなく全員が読める場所へ置く。
ENV UV_LINK_MODE=copy UV_PYTHON_INSTALL_DIR=/opt/uv-python

ARG IRODORI_REF=89f9d8fbd4d51ea019867ee1197725ede1df13c5
RUN git clone https://github.com/Aratako/Irodori-TTS.git /opt/irodori \
    && git -C /opt/irodori checkout "${IRODORI_REF}" \
    && cd /opt/irodori && uv sync --frozen --extra cu128 --no-dev

COPY . /app
RUN uv venv --python /usr/local/bin/python3.12 /opt/runner && uv pip install --python /opt/runner/bin/python -e /app

# モデルは HF_HOME (run.sh でホストの /ssdnas2 をマウント) に取得する。
ENV HF_HOME=/hf-cache
WORKDIR /app
EXPOSE 8770
CMD ["/opt/runner/bin/uvicorn", "voice_runner.app:app", "--host", "0.0.0.0", "--port", "8770"]
