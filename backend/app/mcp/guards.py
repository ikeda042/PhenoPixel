from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


EXACT_ALLOWLIST: tuple[str, ...] = (
    "README.md",
    "Readme_ja.md",
    "backend/main.py",
    "backend/openapi.json",
    "frontend/src/main.tsx",
    "frontend/src/utils/apiBase.ts",
)
GLOB_ALLOWLIST: tuple[str, ...] = (
    "backend/app/**/*.py",
    "backend/app/**/README.md",
    "frontend/src/pages/**/*.tsx",
    "frontend/src/components/**/*.tsx",
)
EXCLUDED_PREFIXES: tuple[str, ...] = (
    "frontend/dist/",
    "backend/app/databases/",
)
DENIED_NAME_SUFFIXES: tuple[str, ...] = (
    ".db",
    ".db-shm",
    ".db-wal",
    ".sqlite",
    ".sqlite3",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".bmp",
    ".mp4",
    ".mov",
    ".avi",
    ".webm",
    ".mkv",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
)
MAX_FRAGMENT_BYTES: int = 24_000
MAX_FRAGMENT_LINES: int = 160
DEFAULT_FRAGMENT_LINES: int = 120


class GuardViolation(ValueError):
    pass


@dataclass(frozen=True)
class SourceFragment:
    path: str
    start_line: int
    end_line: int
    total_lines: int
    text: str


def _to_rel_path(repo_root: Path, path: Path) -> str:
    return path.relative_to(repo_root).as_posix()


def _is_excluded(rel_path: str) -> bool:
    if any(rel_path.startswith(prefix) for prefix in EXCLUDED_PREFIXES):
        return True
    return rel_path.lower().endswith(DENIED_NAME_SUFFIXES)


@lru_cache(maxsize=8)
def _allowed_rel_paths(repo_root_str: str) -> frozenset[str]:
    repo_root = Path(repo_root_str)
    allowed: set[str] = set()

    for rel_path in EXACT_ALLOWLIST:
        path = repo_root / rel_path
        if path.is_file() and not _is_excluded(rel_path):
            allowed.add(rel_path)

    for pattern in GLOB_ALLOWLIST:
        for path in repo_root.glob(pattern):
            if not path.is_file():
                continue
            rel_path = _to_rel_path(repo_root, path)
            if _is_excluded(rel_path):
                continue
            allowed.add(rel_path)

    return frozenset(sorted(allowed))


def iter_allowed_repo_files(repo_root: Path) -> list[Path]:
    allowed = _allowed_rel_paths(str(repo_root.resolve()))
    return [repo_root / rel_path for rel_path in allowed]


def normalize_requested_path(repo_root: Path, requested_path: str) -> Path:
    raw = (requested_path or "").strip()
    if not raw:
        raise GuardViolation("Path is required")

    raw_path = Path(raw)
    if ".." in raw_path.parts:
        raise GuardViolation("Parent path traversal is not allowed")

    repo_root = repo_root.resolve()
    candidate = raw_path if raw_path.is_absolute() else repo_root / raw_path
    try:
        resolved = candidate.resolve(strict=False)
        resolved.relative_to(repo_root)
    except ValueError as exc:
        raise GuardViolation("Path must stay inside the repository") from exc

    rel_path = _to_rel_path(repo_root, resolved)
    if rel_path not in _allowed_rel_paths(str(repo_root)):
        raise GuardViolation(f"Path is not in the MCP allowlist: {rel_path}")
    if not resolved.is_file():
        raise GuardViolation(f"File not found: {rel_path}")
    return resolved


def enforce_fragment_limits(
    text: str,
    *,
    max_lines: int = MAX_FRAGMENT_LINES,
    max_bytes: int = MAX_FRAGMENT_BYTES,
) -> None:
    line_count = len(text.splitlines()) or (1 if text else 0)
    byte_count = len(text.encode("utf-8"))
    if line_count > max_lines:
        raise GuardViolation(
            f"Fragment exceeds line limit ({line_count} > {max_lines})"
        )
    if byte_count > max_bytes:
        raise GuardViolation(
            f"Fragment exceeds byte limit ({byte_count} > {max_bytes})"
        )


def read_source_fragment(
    repo_root: Path,
    requested_path: str,
    *,
    start_line: int = 1,
    line_count: int = DEFAULT_FRAGMENT_LINES,
) -> SourceFragment:
    if start_line < 1:
        raise GuardViolation("start_line must be >= 1")
    if line_count < 1:
        raise GuardViolation("line_count must be >= 1")
    if line_count > MAX_FRAGMENT_LINES:
        raise GuardViolation(
            f"Requested line_count exceeds the maximum allowed ({MAX_FRAGMENT_LINES})"
        )

    path = normalize_requested_path(repo_root, requested_path)
    text = path.read_text(encoding="utf-8", errors="ignore")
    lines = text.splitlines()
    total_lines = len(lines)
    start_index = start_line - 1
    if start_index >= total_lines:
        raise GuardViolation("start_line is beyond the end of the file")

    end_index = min(start_index + line_count, total_lines)
    excerpt = "\n".join(lines[start_index:end_index])
    if end_index < total_lines and excerpt:
        excerpt += "\n"
    enforce_fragment_limits(excerpt)

    return SourceFragment(
        path=_to_rel_path(repo_root.resolve(), path.resolve()),
        start_line=start_line,
        end_line=end_index,
        total_lines=total_lines,
        text=excerpt,
    )
