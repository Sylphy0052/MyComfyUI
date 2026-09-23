import os
from functools import lru_cache
from pathlib import Path
from typing import Literal

from platformdirs import user_config_path, user_data_path
from pydantic import Field, field_validator
from pydantic_settings import (
    BaseSettings,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
    TomlConfigSettingsSource,
)

#: 提案Providerの識別子。`claude_code`と`codex`はCLIをsubprocessで呼び、`qwen`は
#: OpenAI互換HTTPで常駐する推論サーバーへ問い合わせ、`stub`は同梱fixtureを返す。
AgentProviderId = Literal["claude_code", "codex", "qwen", "stub"]

CONFIG_FILE_ENV = "MYCOMFYUI_CONFIG_FILE"


def default_config_file() -> Path:
    """OS標準の利用者設定ファイルを返す。"""
    return user_config_path("MyComfyUI", appauthor=False) / "config.toml"


def config_file() -> Path:
    """起動時指定があればそれを、なければ既定の設定ファイルを返す。"""
    override = os.environ.get(CONFIG_FILE_ENV)
    return Path(override).expanduser() if override else default_config_file()


class Settings(BaseSettings):
    """Runtime settings that never include Backend credentials."""

    model_config = SettingsConfigDict(
        env_prefix="MYCOMFYUI_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    data_root: Path = user_data_path("MyComfyUI", appauthor=False)
    comfyui_base_url: str = "http://127.0.0.1:8188"
    comfyui_timeout_seconds: float = Field(default=600.0, gt=0)
    #: ai-media参照APIの接続先。未設定の間は同梱fixtureを参照する。
    aimedia_base_url: str | None = None
    #: 参照fixtureの差し替え先。上流が未実装の間、Canonが更新された状態を再現して
    #: 更新警告と再実行の判定を確かめるために使う。未設定なら同梱fixtureを読む。
    aimedia_fixture_path: Path | None = None
    #: novel-writerのリポジトリの場所。prompt提案が作法・実測知見・既存作品のpromptを
    #: 読み取り専用で参照する。未設定なら参照しない。
    novel_writer_root: Path | None = None
    #: 投入前にタグの実在を確かめる辞書。a1111-sd-webui-tagcompleteの`danbooru.csv`
    #: と同じ形式を読む。未設定なら実在は確かめず、干渉する組み合わせだけを検出する。
    tag_dictionary_path: Path | None = None
    #: リクエストでProviderを指定しなかったときに使う既定値。APIキーを設定へ持たず、
    #: CLIの既存認証を使う。
    agent_provider: AgentProviderId = "claude_code"
    #: Claude Code CLIの実行ファイル。PATH上の名前でも絶対パスでもよい。
    agent_cli_path: str = "claude"
    agent_model: str = "sonnet"
    agent_timeout_seconds: float = Field(default=120.0, gt=0)
    #: 1回の提案取得で許す上限額。CLIへ渡し、超過はCLI側で打ち切らせる。
    agent_max_budget_usd: float = Field(default=0.5, gt=0)
    #: 提案へ添付する画像1枚あたりの上限バイト数。Claudeの画像入力の上限に合わせる。
    agent_max_image_bytes: int = Field(default=5 * 1024 * 1024, gt=0)
    #: Codex CLIの実行ファイル。PATH上の名前でも絶対パスでもよい。
    agent_codex_cli_path: str = "codex"
    #: 未指定ならCodex CLIの既定モデルを使う。
    agent_codex_model: str | None = None
    #: Qwenを動かすOpenAI互換推論サーバーの接続先。Remote GPU Hostで動かす場合も
    #: ComfyUIとvoice-runnerと同じく、この値だけをRemote PCのURLへ変える。
    agent_qwen_base_url: str = "http://127.0.0.1:8000/v1"
    #: 推論サーバーへ渡すモデル名。画像タグの整理にも同じモデルを使う。
    agent_qwen_model: str = "qwen3"
    #: `agent_qwen_model`が画像入力を受け付けるか。VL系のモデルを置いたときだけ真にする。
    #: 偽のままなら、画像を添付するプロンプト補完ではQwenを非対応として扱う。
    agent_qwen_supports_images: bool = False
    #: 提案1件あたりの実行上限。ローカル推論はCLI経由より遅くなりうるため別に持つ。
    agent_qwen_timeout_seconds: float = Field(default=180.0, gt=0)
    #: Backendを起動させずに状態だけを読む照会口。Remote GPU Hostでgpu-proxyを挟む構成で
    #: 使う。未設定なら到達性の確認に推論サーバーの`/models`を使う。推論の接続先は
    #: `agent_qwen_base_url`のままで、この値は状態の確認にしか使わない。
    agent_qwen_status_url: str | None = None
    #: 状態照会の打ち切り時間。照会口は起動を伴わず即座に返るため、提案本体より短くする。
    agent_qwen_status_timeout_seconds: float = Field(default=2.0, gt=0)
    #: 承認の有効期限。超過した承認では副作用のある操作を実行しない。
    agent_approval_ttl_seconds: int = Field(default=1800, gt=0)
    #: stub Providerを常に失敗させる。Provider障害が他機能を止めないことの確認に使う。
    agent_stub_failure: bool = False
    #: 音声とASRのBackendを束ねるvoice-runnerの接続先。ローカル構成でもリモート構成でも
    #: この値だけが変わり、実行経路は分岐しない。
    voice_runner_base_url: str = "http://127.0.0.1:8770"
    #: voice-runnerへの1リクエストの上限。`ai-media/docs/tts-backends.md`の既定に合わせる。
    voice_runner_timeout_seconds: float = Field(default=300.0, gt=0)
    #: base64で受け渡すwavのサイズ上限。参照音声と生成音声の両方に適用する。
    voice_max_audio_bytes: int = Field(default=32 * 1024 * 1024, gt=0)
    #: 実GPU Backendの代わりにスタブを使う。UIと履歴の経路を手元で確かめるために使う。
    voice_stub: bool = False
    #: スタブBackendを常に失敗させる。Backend障害時にJobがfailedへ落ちることの確認に使う。
    voice_stub_failure: bool = False
    #: 実ComfyUIの代わりに内蔵stubで実行する。到達できる実機が無い間、画像・動画・音楽の
    #: 投入から保存までの経路を手元で確かめるために使う。
    comfyui_stub: bool = False
    #: ComfyUI stubの生成を常に失敗させる。疎通(`/system_stats`相当)には効かせない。
    comfyui_stub_failure: bool = False
    #: 合成に使うffmpegの実行ファイル。PATH上の名前でも絶対パスでもよい。
    ffmpeg_path: str = "ffmpeg"
    #: 尺の確認に使うffprobeの実行ファイル。
    ffprobe_path: str = "ffprobe"
    #: 合成1件の実行上限。
    compose_timeout_seconds: float = Field(default=600.0, gt=0)
    #: 取り込む参照画像とガイド音声の上限バイト数。
    max_image_bytes: int = Field(default=32 * 1024 * 1024, gt=0)
    #: 画像タグ抽出に使うWD14 Taggerのモデル。ComfyUIの`WD14Tagger|pysssss`へ渡す。
    #: 初めて使うモデルはComfyUI側でのダウンロードが入り、初回だけ時間がかかる。
    image_tagger_model: str = "wd-swinv2-tagger-v3"
    #: タグを採用する確信度の下限。下げるほど数は増え、無関係なタグも混じる。
    image_tagger_threshold: float = Field(default=0.35, ge=0.0, le=1.0)
    #: キャラクター名タグだけに適用する下限。誤検出を避けるため本体より高く保つ。
    image_tagger_character_threshold: float = Field(default=0.85, ge=0.0, le=1.0)
    #: `closed_mouth`ではなく`closed mouth`の形で受け取り、そのままプロンプトへ渡す。
    image_tagger_replace_underscore: bool = True
    #: 抽出から除くタグ。ComfyUIのノードへそのまま渡すカンマ区切りの文字列。
    image_tagger_exclude_tags: str = ""
    #: 抽出1件の実行上限。ComfyUIの起動待ちとモデル読み込みを含む。
    image_tagger_timeout_seconds: float = Field(default=300.0, gt=0)
    #: 抽出したタグをQwenで整理・拡張する。失敗しても抽出結果はそのまま返す。
    image_tagger_refine: bool = True
    #: 外部画像Artifactが使用できる総量。無認証loopback APIからの無制限保存を防ぐ。
    external_image_import_quota_bytes: int = Field(
        default=20 * 1024 * 1024 * 1024, gt=0
    )
    #: preview tokenの有効期間。この間だけ同一hashのconfirmを受け付ける。
    external_image_preview_ttl_seconds: int = Field(default=900, gt=0)
    #: Artifact実体込みProject packageの受入上限。base64化後の本文には別途余裕を足す。
    project_package_max_bytes: int = Field(default=512 * 1024 * 1024, gt=0)
    #: APIがbindするhost。認証を持たないため、loopback以外へ広げると同一LANの
    #: 別端末から操作できてしまう。既定はloopbackのままにする。
    api_host: str = "127.0.0.1"
    #: bindするport。0を渡すとOSが空きportを選ぶ。
    api_port: int = Field(default=8000, ge=0, le=65535)
    #: ブラウザからの呼び出しを許すoriginをカンマ区切りで並べる。空のままなら
    #: CORSのheaderを返さず、開発時のViteのproxyのように同一originからの呼び出し
    #: だけが通る。
    allowed_origins: str = ""
    #: ユーザースクリプトの登録と実行を有効にする。任意コードの実行経路を開くため、
    #: 利用者が明示的に有効にするまで閉じておく(ADR 0003)。
    user_scripts_enabled: bool = False
    #: sandboxを組み立てる実行ファイル。PATHの探索で別の実行ファイルを掴まないよう、
    #: 絶対パスだけを受け付ける。
    user_scripts_bwrap_path: str = "/usr/bin/bwrap"
    user_scripts_prlimit_path: str = "/usr/bin/prlimit"
    user_scripts_systemd_run_path: str = "/usr/bin/systemd-run"
    user_scripts_systemctl_path: str = "/usr/bin/systemctl"
    #: sandboxの中でscriptを実行するinterpreter。sandboxへは`/usr`だけを見せるため、
    #: `/usr`配下のパスに限る。
    user_scripts_python_path: str = "/usr/bin/python3"
    #: previewから承認と実行までの期限。過ぎたrunは承認を取り直す。
    user_scripts_approval_ttl_seconds: int = Field(default=900, gt=0)
    #: scriptの能力manifestが宣言できる上限。manifestはこれ以下の値だけを持てる。
    user_scripts_max_cpu_seconds: int = Field(default=300, gt=0)
    user_scripts_max_memory_bytes: int = Field(default=2 * 1024 * 1024 * 1024, gt=0)
    user_scripts_max_tasks: int = Field(default=64, gt=0)
    user_scripts_max_wall_seconds: int = Field(default=600, gt=0)
    user_scripts_max_output_bytes: int = Field(default=256 * 1024 * 1024, gt=0)
    user_scripts_max_output_files: int = Field(default=64, gt=0)
    #: stdoutとstderrそれぞれの保存上限。超えたらrunを止める。
    user_scripts_max_log_bytes: int = Field(default=1024 * 1024, gt=0)

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        """既定値、TOML、環境変数、起動時引数の優先順位を保つ。"""
        return (
            init_settings,
            env_settings,
            dotenv_settings,
            TomlConfigSettingsSource(settings_cls, toml_file=config_file()),
            file_secret_settings,
        )

    @field_validator("api_host")
    @classmethod
    def _reject_blank_host(cls, value: str) -> str:
        """空文字を弾く。

        `bind(("", port))`は全interfaceで待ち受ける。引数の受け渡しでhostが空に
        なったときに、loopbackのつもりでLANへ公開されるのを防ぐ。
        """
        if not value.strip():
            raise ValueError("api_hostに空文字は指定できません。")
        return value

    @property
    def allowed_origin_list(self) -> tuple[str, ...]:
        """許可originを並び順のまま返す。空白だけの項目は落とす。"""
        return tuple(
            origin.strip()
            for origin in self.allowed_origins.split(",")
            if origin.strip()
        )

    @property
    def database_path(self) -> Path:
        return self.data_root / "db" / "mycomfyui.sqlite3"

    @property
    def database_url(self) -> str:
        return f"sqlite+aiosqlite:///{self.database_path}"

    @property
    def artifacts_root(self) -> Path:
        return self.data_root / "artifacts"

    @property
    def agent_workspace_root(self) -> Path:
        """提案Providerを起動する作業ディレクトリの親。

        リポジトリを読ませないため、提案ごとに空のディレクトリを作ってcwdにする。
        `tmp/`配下のため、終端後に消しても他の記録へ影響しない。
        """
        return self.data_root / "tmp" / "agent"

    @property
    def user_script_approval_key_path(self) -> Path:
        """ユーザースクリプトの承認tokenを署名する鍵。応答にもログにも出さない。"""
        return self.data_root / "secrets" / "user-script-approval.key"

    @property
    def user_script_runs_root(self) -> Path:
        """runごとの作業ディレクトリの親。終了後に消す。"""
        return self.data_root / "tmp" / "script-runs"


@lru_cache
def get_settings() -> Settings:
    return Settings()
