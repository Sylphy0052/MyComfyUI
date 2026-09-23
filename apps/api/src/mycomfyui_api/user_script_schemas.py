"""ユーザースクリプトAPIの要求と応答(ADR 0003)。"""

from typing import Any, Literal

from pydantic import Field, field_validator

from mycomfyui_api.schemas import ApiModel, ResourceId

#: 登録できる本文の上限。
MAX_SOURCE_LENGTH = 256 * 1024
MAX_ARGUMENTS = 64
MAX_ARGUMENT_LENGTH = 4096
MAX_INPUTS = 16

UserScriptRunStatus = Literal[
    "pending_approval", "approved", "running", "succeeded", "failed", "cancelled"
]


class UserScriptCapabilities(ApiModel):
    """scriptが実行時に使う能力の宣言。上限は設定の値以下に限る。

    ネットワークは使わせない。`none`以外の値は受け付けない。
    """

    network: Literal["none"] = "none"
    cpu_seconds: int = Field(default=60, ge=1)
    memory_bytes: int = Field(default=512 * 1024 * 1024, ge=16 * 1024 * 1024)
    max_tasks: int = Field(default=16, ge=1)
    wall_seconds: int = Field(default=120, ge=1)
    output_bytes: int = Field(default=64 * 1024 * 1024, ge=0)
    output_files: int = Field(default=16, ge=0)


class UserScriptCreate(ApiModel):
    name: str = Field(min_length=1, max_length=120)
    source: str = Field(min_length=1, max_length=MAX_SOURCE_LENGTH)
    capabilities: UserScriptCapabilities = Field(default_factory=UserScriptCapabilities)

    @field_validator("source")
    @classmethod
    def _reject_nul(cls, value: str) -> str:
        if "\x00" in value:
            raise ValueError("本文にNUL文字は含められません。")
        return value


class UserScriptRead(ApiModel):
    id: str
    name: str
    sha256: str
    capabilities: dict[str, Any]
    created_at: str


class UserScriptDetail(UserScriptRead):
    source: str


class UserScriptRunCreate(ApiModel):
    """実行内容のpreview要求。これだけでは実行しない。"""

    arguments: list[str] = Field(default_factory=list, max_length=MAX_ARGUMENTS)
    input_artifact_ids: list[ResourceId] = Field(
        default_factory=list, max_length=MAX_INPUTS
    )

    @field_validator("arguments")
    @classmethod
    def _validate_arguments(cls, value: list[str]) -> list[str]:
        for item in value:
            if len(item) > MAX_ARGUMENT_LENGTH:
                raise ValueError(f"引数は{MAX_ARGUMENT_LENGTH}文字以内にしてください。")
            if "\x00" in item:
                raise ValueError("引数にNUL文字は含められません。")
        return value

    @field_validator("input_artifact_ids")
    @classmethod
    def _unique_inputs(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value):
            raise ValueError("同じArtifactを重ねて指定できません。")
        return value


class UserScriptRunInput(ApiModel):
    artifact_id: str
    sha256: str
    mount_path: str


class UserScriptRunRead(ApiModel):
    """runの内容と結果。承認CLIはこの値からdigestを計算し直して照合する。"""

    id: str
    script_id: str
    script_name: str
    script_sha256: str
    script_source: str
    interpreter: str
    arguments: list[str]
    inputs: list[UserScriptRunInput]
    capabilities: dict[str, Any]
    output_destination: str
    digest: str
    status: UserScriptRunStatus
    approval_expires_at: str
    approved_at: str | None
    started_at: str | None
    finished_at: str | None
    exit_code: int | None
    failure_reason: str | None
    stdout: str | None
    stderr: str | None
    output_artifact_ids: list[str]
    created_at: str


class UserScriptRunApprove(ApiModel):
    """承認CLIが鍵で署名したtoken。REST APIではtokenを作れない。"""

    approval_token: str = Field(pattern=r"^[0-9a-f]{64}$")


class UserScriptAuditEventRead(ApiModel):
    id: str
    event_type: str
    script_id: str | None
    run_id: str | None
    digest: str | None
    detail: dict[str, Any]
    created_at: str
