"""OpenAPIスナップショットを`contracts/openapi/openapi.json`へ書き出す。

FastAPIが生成するOpenAPIがREST契約の正本であり、Web UIのTypeScript型はこの
スナップショットから生成する。API変更時はこのscriptを実行し、差分をcommitする。

    uv run --project apps/api python apps/api/scripts/export_openapi.py
"""

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
OUTPUT_PATH = REPO_ROOT / "contracts" / "openapi" / "openapi.json"


def main() -> int:
    from mycomfyui_api.main import create_app

    spec = create_app().openapi()
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(
        json.dumps(spec, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {OUTPUT_PATH.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
