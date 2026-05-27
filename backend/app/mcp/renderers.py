from __future__ import annotations

import re
from collections.abc import Iterable


CAMEL_SPLIT_RE = re.compile(r"(?<!^)(?=[A-Z])")
NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")


def humanize_identifier(value: str) -> str:
    raw = (value or "").strip().strip("/")
    if not raw:
        return ""
    raw = raw.replace(".tsx", "").replace(".ts", "").replace(".py", "")
    raw = raw.replace("-", " ").replace("_", " ")
    raw = CAMEL_SPLIT_RE.sub(" ", raw)
    raw = re.sub(r"\s+", " ", raw).strip()
    replacements = {
        "Nd2": "ND2",
        "Api": "API",
        "Ui": "UI",
    }
    parts = [replacements.get(part, part) for part in raw.split()]
    return " ".join(parts)


def normalize_lookup_key(value: str) -> str:
    lowered = (value or "").lower()
    return NON_ALNUM_RE.sub("", lowered)


def format_code_reference(path: str | None, line: int | None) -> str:
    if not path:
        return ""
    return f"{path}:{line or 1}"


def render_sections(sections: Iterable[tuple[str, list[str]]]) -> str:
    lines: list[str] = []
    for title, items in sections:
        normalized_items = [item for item in items if item]
        lines.append(f"{title}:")
        if normalized_items:
            lines.extend(f"- {item}" for item in normalized_items)
        else:
            lines.append("- 該当情報は見つかりませんでした。")
    return "\n".join(lines)
