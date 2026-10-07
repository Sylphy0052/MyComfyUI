"""engines.yamlの読み込み。

engineごとのpython path、model_id、model_revision、sample_rate、needs_katakana、
uses_reference_transcriptはrunner側で持つ。Application APIはこれらを知らず、engine名だけを送る。
"""

import os
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

#: 設定ファイルの既定の場所。環境変数で差し替えられる。
DEFAULT_CONFIG_PATH = Path(__file__).resolve().parents[2] / "engines.yaml"

CONFIG_PATH_ENV = "VOICE_RUNNER_CONFIG"

DEFAULT_TIMEOUT_SEC = 300.0


class ConfigError(RuntimeError):
    """設定を読めない、または内容が想定と違う。"""


@dataclass(frozen=True)
class EngineConfig:
    """1つのTTS Backendの所在と、生成に必要な値。"""

    id: str
    python: Path
    model_id: str
    model_revision: str | None
    sample_rate: int
    needs_katakana: bool
    timeout_sec: float
    home: Path | None = None
    #: コーデックのHF repo idと固定revision。無ければIrodori-TTS側の既定repoを最新で取得する。
    codec_repo: str | None = None
    codec_revision: str | None = None
    #: 参照音声の書き起こしを生成に使うか。使うengineでは参照音声と組で必須にする。
    uses_reference_transcript: bool = False

    @property
    def available(self) -> bool:
        """実行できるかどうか。モデルはロードせず、実行ファイルの有無だけを見る。"""
        return self.python.is_file() and os.access(self.python, os.X_OK)

    @property
    def detail(self) -> str | None:
        if self.available:
            return None
        return f"Python実行ファイルがありません: {self.python}"


@dataclass(frozen=True)
class AsrConfig:
    """読み検証に使うASRの所在。"""

    python: Path
    model_id: str
    language: str
    timeout_sec: float

    @property
    def available(self) -> bool:
        return self.python.is_file() and os.access(self.python, os.X_OK)


@dataclass(frozen=True)
class RunnerConfig:
    engines: dict[str, EngineConfig]
    asr: AsrConfig

    def engine(self, engine_id: str) -> EngineConfig:
        found = self.engines.get(engine_id)
        if found is None:
            raise ConfigError(f"設定に無いengineです: {engine_id}")
        return found


def _float(raw: Any, fallback: float) -> float:
    return float(raw) if isinstance(raw, int | float) else fallback


def _flag(engine_id: str, raw: dict[str, Any], key: str) -> bool:
    """真偽値の設定を読む。省略はFalse。

    `bool("false")`は真になり設定の意図と逆に働くため、bool以外は失敗させる。
    """
    value = raw.get(key, False)
    if not isinstance(value, bool):
        raise ConfigError(f"{engine_id}の{key}はtrueかfalseで書いてください。")
    return value


_REVISION_PATTERN = re.compile(r"[0-9a-f]{40}")


def _revision(engine_id: str, raw: dict[str, Any], key: str) -> str | None:
    """HFのcommit shaを読む。キーがあるのに不正な値を黙って捨てると固定が外れるため失敗させる。

    YAMLは引用符なしの数字だけのshaをintに、`12345e67`の形をfloatに読むので、
    str以外もここで弾く。
    """
    if key not in raw:
        return None
    value = raw[key]
    if not isinstance(value, str) or not _REVISION_PATTERN.fullmatch(value):
        raise ConfigError(
            f"{engine_id}の{key}は40桁の小文字16進のcommit shaを引用符付きで書いてください。"
        )
    return value


def _engine(engine_id: str, raw: Any) -> EngineConfig:
    if not isinstance(raw, dict):
        raise ConfigError(f"{engine_id}の設定がmappingではありません。")
    python = raw.get("python")
    model_id = raw.get("model_id")
    sample_rate = raw.get("sample_rate")
    if not isinstance(python, str) or not isinstance(model_id, str):
        raise ConfigError(f"{engine_id}にpythonかmodel_idがありません。")
    if not isinstance(sample_rate, int) or sample_rate <= 0:
        raise ConfigError(f"{engine_id}のsample_rateが不正です。")
    revision = _revision(engine_id, raw, "model_revision")
    home = raw.get("home")
    codec_repo = raw.get("codec_repo")
    codec_revision = _revision(engine_id, raw, "codec_revision")
    if codec_repo is not None and (
        not isinstance(codec_repo, str) or not codec_repo.strip()
    ):
        raise ConfigError(f"{engine_id}のcodec_repoが空でない文字列ではありません。")
    if (codec_repo is None) != (codec_revision is None):
        raise ConfigError(
            f"{engine_id}のcodec_repoとcodec_revisionは両方書くか両方省いてください。"
        )
    return EngineConfig(
        id=engine_id,
        python=Path(python),
        model_id=model_id,
        model_revision=revision,
        sample_rate=sample_rate,
        needs_katakana=_flag(engine_id, raw, "needs_katakana"),
        timeout_sec=_float(raw.get("timeout_sec"), DEFAULT_TIMEOUT_SEC),
        home=Path(home) if isinstance(home, str) else None,
        codec_repo=codec_repo,
        codec_revision=codec_revision,
        uses_reference_transcript=_flag(engine_id, raw, "uses_reference_transcript"),
    )


def load(path: Path | None = None) -> RunnerConfig:
    """設定を読む。壊れていれば起動時に失敗させる。

    参照のたびに失敗する状態で立ち上がると、原因が設定にあることが分かりにくい。
    """
    source = path or Path(os.environ.get(CONFIG_PATH_ENV, DEFAULT_CONFIG_PATH))
    try:
        document = yaml.safe_load(source.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as error:
        raise ConfigError(f"設定を読み込めません: {source}") from error
    if not isinstance(document, dict):
        raise ConfigError(f"設定の形式が想定外です: {source}")
    raw_engines = document.get("engines")
    if not isinstance(raw_engines, dict) or not raw_engines:
        raise ConfigError("設定にenginesがありません。")
    raw_asr = document.get("asr")
    if not isinstance(raw_asr, dict):
        raise ConfigError("設定にasrがありません。")
    asr_python = raw_asr.get("python")
    asr_model = raw_asr.get("model_id")
    if not isinstance(asr_python, str) or not isinstance(asr_model, str):
        raise ConfigError("asrにpythonかmodel_idがありません。")
    language = raw_asr.get("language")
    return RunnerConfig(
        engines={
            str(engine_id): _engine(str(engine_id), raw)
            for engine_id, raw in raw_engines.items()
        },
        asr=AsrConfig(
            python=Path(asr_python),
            model_id=asr_model,
            language=language if isinstance(language, str) else "ja",
            timeout_sec=_float(raw_asr.get("timeout_sec"), DEFAULT_TIMEOUT_SEC),
        ),
    )


@lru_cache(maxsize=1)
def get_config() -> RunnerConfig:
    return load()
