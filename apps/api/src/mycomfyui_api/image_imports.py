"""外部画像の検証と、実行不能なRecipe下書きへのメタデータ抽出。"""

import base64
import binascii
import hashlib
import io
import json
import re
import struct
import warnings
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image, UnidentifiedImageError

MAX_IMAGE_BYTES = 25 * 1024 * 1024
MAX_IMAGE_DIMENSION = 32_768
MAX_IMAGE_PIXELS = 40_000_000
MAX_IMAGE_FRAMES = 100
MAX_METADATA_ENTRIES = 64
MAX_METADATA_VALUE_BYTES = 256 * 1024
MAX_METADATA_TOTAL_BYTES = 1024 * 1024

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
JPEG_SIGNATURE = b"\xff\xd8\xff"


class ImageImportError(ValueError):
    """入力画像を安全に取り込めない。"""


@dataclass(frozen=True)
class ParsedImage:
    data: bytes
    sha256: str
    byte_size: int
    media_type: str
    source_format: str
    width: int
    height: int
    metadata: dict[str, str]
    recipe_draft: dict[str, Any]
    warnings: list[str]


def parse_image(file_name: str, content_base64: str, media_type: str) -> ParsedImage:
    """base64を復号し、形式・寸法・PNGメタデータを検証する。"""
    try:
        data = base64.b64decode(content_base64, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ImageImportError("画像のbase64を解釈できません。") from error
    if not data:
        raise ImageImportError("画像が空です。")
    return parse_image_bytes(file_name, data, media_type)


def parse_image_bytes(file_name: str, data: bytes, media_type: str) -> ParsedImage:
    """復号済みbytesを、通常の外部画像取込と同じ境界で検証する。"""
    if not data:
        raise ImageImportError("画像が空です。")
    if len(data) > MAX_IMAGE_BYTES:
        raise ImageImportError(
            f"画像は{MAX_IMAGE_BYTES // (1024 * 1024)}MB以下にしてください。"
        )

    normalized_media_type = media_type.split(";", 1)[0].strip().lower()
    if data.startswith(PNG_SIGNATURE):
        actual_media_type = "image/png"
        source_format = "png"
        width, height, metadata = _parse_png(data)
    elif data.startswith(JPEG_SIGNATURE):
        actual_media_type = "image/jpeg"
        source_format = "jpeg"
        width, height = _jpeg_dimensions(data)
        metadata = {}
    elif data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        actual_media_type = "image/webp"
        source_format = "webp"
        width, height = _webp_dimensions(data)
        metadata = {}
    else:
        raise ImageImportError("PNG、JPEG、WebPの画像だけを取り込めます。")
    if normalized_media_type != actual_media_type:
        raise ImageImportError(
            f"media_typeと実ファイル形式が一致しません: {normalized_media_type}"
        )
    _validate_dimensions(width, height)
    _verify_decode(data, source_format, width, height)
    recipe_draft, warnings = _recipe_draft(file_name, metadata, width, height)
    return ParsedImage(
        data=data,
        sha256=hashlib.sha256(data).hexdigest(),
        byte_size=len(data),
        media_type=actual_media_type,
        source_format=source_format,
        width=width,
        height=height,
        metadata=metadata,
        recipe_draft=recipe_draft,
        warnings=warnings,
    )


def _validate_dimensions(width: int, height: int) -> None:
    if width <= 0 or height <= 0:
        raise ImageImportError("画像の寸法が不正です。")
    if width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION:
        raise ImageImportError(
            f"画像の各辺は{MAX_IMAGE_DIMENSION}px以下にしてください。"
        )
    if width * height > MAX_IMAGE_PIXELS:
        raise ImageImportError("画像の総画素数が上限を超えています。")


def _verify_decode(
    data: bytes, source_format: str, expected_width: int, expected_height: int
) -> None:
    """許可形式をPillowで実デコードし、独自parserだけでは見抜けない破損を拒否する。"""
    expected_format = {"png": "PNG", "jpeg": "JPEG", "webp": "WEBP"}[source_format]
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data), formats=[expected_format]) as image:
                if image.format != expected_format or image.size != (
                    expected_width,
                    expected_height,
                ):
                    raise ImageImportError("画像形式または寸法の検証結果が一致しません。")
                image.verify()
            # verify()後のImageは再利用できないため、再度開いて全frameをデコードする。
            with Image.open(io.BytesIO(data), formats=[expected_format]) as image:
                frames = getattr(image, "n_frames", 1)
                if frames > MAX_IMAGE_FRAMES:
                    raise ImageImportError(
                        f"画像のframe数は{MAX_IMAGE_FRAMES}以下にしてください。"
                    )
                if frames * expected_width * expected_height > MAX_IMAGE_PIXELS:
                    raise ImageImportError(
                        "全frameを合計した画素数が上限を超えています。"
                    )
                for index in range(frames):
                    image.seek(index)
                    image.load()
    except ImageImportError:
        raise
    except (
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
        EOFError,
        OSError,
        UnidentifiedImageError,
        ValueError,
    ) as error:
        raise ImageImportError("画像を正常にデコードできません。") from error


def _parse_png(data: bytes) -> tuple[int, int, dict[str, str]]:
    offset = len(PNG_SIGNATURE)
    width = height = 0
    metadata: dict[str, str] = {}
    metadata_total = 0
    found_iend = False
    while offset + 12 <= len(data):
        length = int.from_bytes(data[offset : offset + 4], "big")
        chunk_type = data[offset + 4 : offset + 8]
        end = offset + 12 + length
        if end > len(data):
            raise ImageImportError("PNG chunkが途中で切れています。")
        chunk_data = data[offset + 8 : offset + 8 + length]
        expected_crc = int.from_bytes(data[offset + 8 + length : end], "big")
        if zlib.crc32(chunk_type + chunk_data) & 0xFFFFFFFF != expected_crc:
            raise ImageImportError("PNG chunkのCRCが一致しません。")
        if chunk_type == b"IHDR":
            if length != 13 or width or height:
                raise ImageImportError("PNGのIHDRが不正です。")
            width, height = struct.unpack(">II", chunk_data[:8])
        elif chunk_type in (b"tEXt", b"zTXt", b"iTXt"):
            if length > MAX_METADATA_VALUE_BYTES:
                raise ImageImportError("PNGメタデータchunkが上限を超えています。")
            entry = _png_text(chunk_type, chunk_data)
            if entry is not None and entry[0] not in metadata:
                encoded = entry[1].encode("utf-8")
                metadata_total += len(encoded)
                if (
                    len(metadata) >= MAX_METADATA_ENTRIES
                    or metadata_total > MAX_METADATA_TOTAL_BYTES
                ):
                    raise ImageImportError("PNGメタデータの総量が上限を超えています。")
                metadata[entry[0]] = entry[1]
        elif chunk_type == b"IEND":
            found_iend = True
            if end != len(data):
                raise ImageImportError("PNGのIEND後に余分なデータがあります。")
            break
        offset = end
    if not found_iend or not width or not height:
        raise ImageImportError("PNGの構造が不正です。")
    return width, height, metadata


def _png_text(chunk_type: bytes, data: bytes) -> tuple[str, str] | None:
    try:
        keyword_raw, rest = data.split(b"\0", 1)
    except ValueError:
        return None
    keyword = keyword_raw.decode("latin-1").strip()
    if not keyword or len(keyword) > 79:
        return None
    try:
        if chunk_type == b"tEXt":
            text = rest.decode("latin-1")
        elif chunk_type == b"zTXt":
            if not rest or rest[0] != 0:
                return None
            text = _bounded_decompress(rest[1:]).decode("latin-1")
        else:
            if len(rest) < 2:
                return None
            compressed, method = rest[0], rest[1]
            if method != 0:
                return None
            language, translated_and_text = rest[2:].split(b"\0", 1)
            del language
            _translated, text_raw = translated_and_text.split(b"\0", 1)
            if compressed == 1:
                text_raw = _bounded_decompress(text_raw)
            elif compressed != 0:
                return None
            text = text_raw.decode("utf-8")
    except (UnicodeDecodeError, ValueError, zlib.error) as error:
        raise ImageImportError(f"PNGメタデータを解釈できません: {keyword}") from error
    if len(text.encode("utf-8")) > MAX_METADATA_VALUE_BYTES:
        raise ImageImportError(f"PNGメタデータが上限を超えています: {keyword}")
    return keyword, text


def _bounded_decompress(data: bytes) -> bytes:
    decoder = zlib.decompressobj()
    decoded = decoder.decompress(data, MAX_METADATA_VALUE_BYTES + 1)
    if len(decoded) > MAX_METADATA_VALUE_BYTES or decoder.unconsumed_tail:
        raise ImageImportError("圧縮PNGメタデータの展開後サイズが上限を超えています。")
    decoded += decoder.flush(MAX_METADATA_VALUE_BYTES + 1 - len(decoded))
    if len(decoded) > MAX_METADATA_VALUE_BYTES or not decoder.eof:
        raise ImageImportError("圧縮PNGメタデータの展開後サイズが上限を超えています。")
    return decoded


def _jpeg_dimensions(data: bytes) -> tuple[int, int]:
    if not data.endswith(b"\xff\xd9"):
        raise ImageImportError("JPEGの終端が不正です。")
    offset = 2
    sof_markers = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
    while offset + 4 <= len(data):
        if data[offset] != 0xFF:
            offset += 1
            continue
        marker = data[offset + 1]
        offset += 2
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            continue
        if offset + 2 > len(data):
            break
        length = int.from_bytes(data[offset : offset + 2], "big")
        if length < 2 or offset + length > len(data):
            raise ImageImportError("JPEG segmentが不正です。")
        if marker in sof_markers:
            if length < 7:
                raise ImageImportError("JPEGのSOFが不正です。")
            height = int.from_bytes(data[offset + 3 : offset + 5], "big")
            width = int.from_bytes(data[offset + 5 : offset + 7], "big")
            return width, height
        offset += length
    raise ImageImportError("JPEGの寸法を取得できません。")


def _webp_dimensions(data: bytes) -> tuple[int, int]:
    if len(data) < 30 or int.from_bytes(data[4:8], "little") + 8 != len(data):
        raise ImageImportError("WebPのRIFF構造が不正です。")
    chunk = data[12:16]
    payload = data[20:]
    if chunk == b"VP8X" and len(payload) >= 10:
        width = 1 + int.from_bytes(payload[4:7], "little")
        height = 1 + int.from_bytes(payload[7:10], "little")
    elif chunk == b"VP8L" and len(payload) >= 5 and payload[0] == 0x2F:
        bits = int.from_bytes(payload[1:5], "little")
        width = (bits & 0x3FFF) + 1
        height = ((bits >> 14) & 0x3FFF) + 1
    elif chunk == b"VP8 " and len(payload) >= 10 and payload[3:6] == b"\x9d\x01\x2a":
        width = int.from_bytes(payload[6:8], "little") & 0x3FFF
        height = int.from_bytes(payload[8:10], "little") & 0x3FFF
    else:
        raise ImageImportError("WebPの寸法を取得できません。")
    return width, height


def _recipe_draft(
    file_name: str, metadata: dict[str, str], width: int, height: int
) -> tuple[dict[str, Any], list[str]]:
    inputs: dict[str, Any] = {"width": width, "height": height}
    model: dict[str, str] = {}
    source = "image"
    warnings: list[str] = []
    parameters = metadata.get("parameters")
    prompt_json = metadata.get("prompt")
    if parameters:
        source = "a1111"
        _apply_a1111(parameters, inputs, model)
    elif prompt_json:
        source = "comfyui"
        _apply_comfyui(prompt_json, inputs, model, warnings)
    if "workflow" in metadata:
        warnings.append("埋込Workflowは非信頼入力のため、直接実行しません。")
    return (
        {
            "name": f"{Path(file_name).stem}から作成",
            "kind": "image",
            "source": source,
            "suggested_inputs": inputs,
            "suggested_model": model,
            "requires_review": True,
            "executable": False,
        },
        warnings,
    )


def _apply_a1111(
    parameters: str, inputs: dict[str, Any], model: dict[str, str]
) -> None:
    settings_start = parameters.rfind("\nSteps:")
    body = parameters if settings_start < 0 else parameters[:settings_start]
    settings = "" if settings_start < 0 else parameters[settings_start + 1 :]
    negative_marker = "\nNegative prompt:"
    if negative_marker in body:
        positive, negative = body.split(negative_marker, 1)
        inputs["positive_prompt"] = positive.strip()
        inputs["negative_prompt"] = negative.strip()
    elif body.strip():
        inputs["positive_prompt"] = body.strip()
    patterns: dict[str, tuple[str, Any]] = {
        "steps": (r"(?:^|, )Steps: ([0-9]+)", int),
        "cfg": (r"(?:^|, )CFG scale: ([0-9.]+)", float),
        "seed": (r"(?:^|, )Seed: (-?[0-9]+)", int),
    }
    try:
        for name, (pattern, convert) in patterns.items():
            match = re.search(pattern, settings)
            if match:
                inputs[name] = convert(match.group(1))
    except (OverflowError, ValueError) as error:
        raise ImageImportError("A1111メタデータの数値を解釈できません。") from error
    model_match = re.search(r"(?:^|, )Model: ([^,]+)", settings)
    if model_match:
        model["checkpoint"] = model_match.group(1).strip()


def _apply_comfyui(
    prompt_json: str,
    inputs: dict[str, Any],
    model: dict[str, str],
    warnings: list[str],
) -> None:
    try:
        prompt = json.loads(prompt_json)
    except (RecursionError, TypeError, ValueError):
        warnings.append("ComfyUI promptメタデータを解釈できませんでした。")
        return
    if not isinstance(prompt, dict):
        warnings.append("ComfyUI promptメタデータの形式が不正です。")
        return
    sampler: dict[str, Any] | None = None
    nodes: dict[str, dict[str, Any]] = {}
    for node_id, raw in prompt.items():
        if not isinstance(raw, dict):
            continue
        nodes[str(node_id)] = raw
        node_inputs = raw.get("inputs")
        if not isinstance(node_inputs, dict):
            continue
        class_type = raw.get("class_type")
        if class_type in ("KSampler", "KSamplerAdvanced") and sampler is None:
            sampler = node_inputs
        for variable in ("unet_name", "clip_name", "vae_name", "ckpt_name"):
            value = node_inputs.get(variable)
            if isinstance(value, str):
                model[variable] = value
    if sampler is None:
        return
    for name in ("seed", "steps", "cfg"):
        value = sampler.get(name)
        if isinstance(value, int | float) and not isinstance(value, bool):
            inputs[name] = value
    for role, target_name in (("positive", "positive_prompt"), ("negative", "negative_prompt")):
        ref = sampler.get(role)
        if not isinstance(ref, list) or not ref:
            continue
        node = nodes.get(str(ref[0]))
        node_inputs = node.get("inputs") if isinstance(node, dict) else None
        text = node_inputs.get("text") if isinstance(node_inputs, dict) else None
        if isinstance(text, str):
            inputs[target_name] = text
