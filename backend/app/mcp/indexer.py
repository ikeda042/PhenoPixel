from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from .guards import iter_allowed_repo_files


TOKEN_RE = re.compile(r"[A-Za-z0-9_/-]{2,}|[ぁ-んァ-ヶ一-龯]{2,}")
MATCH_LINE_WINDOW: int = 2


@dataclass(frozen=True)
class SearchResult:
    path: str
    score: int
    start_line: int
    end_line: int
    snippet: str


@dataclass(frozen=True)
class FileRecord:
    path: str
    text: str
    size: int
    mtime_ns: int
    line_count: int


@dataclass(frozen=True)
class RepoIndex:
    snapshot_token: tuple[int, int]
    files: dict[str, FileRecord]
    keyword_index: dict[str, tuple[str, ...]]

    def get(self, path: str) -> FileRecord | None:
        return self.files.get(path)

    def iter_paths(self) -> list[str]:
        return sorted(self.files)


def tokenize(text: str) -> list[str]:
    return [token.lower() for token in TOKEN_RE.findall(text or "")]


class RepoIndexer:
    def __init__(self, repo_root: Path):
        self.repo_root = repo_root.resolve()
        self._cached_index: RepoIndex | None = None

    def _build_file_records(self) -> dict[str, FileRecord]:
        records: dict[str, FileRecord] = {}
        for path in iter_allowed_repo_files(self.repo_root):
            rel_path = path.relative_to(self.repo_root).as_posix()
            text = path.read_text(encoding="utf-8", errors="ignore")
            stat = path.stat()
            records[rel_path] = FileRecord(
                path=rel_path,
                text=text,
                size=stat.st_size,
                mtime_ns=stat.st_mtime_ns,
                line_count=len(text.splitlines()),
            )
        return records

    def build(self) -> RepoIndex:
        records = self._build_file_records()
        file_count = len(records)
        max_mtime = max((record.mtime_ns for record in records.values()), default=0)
        token = (file_count, max_mtime)

        if self._cached_index and self._cached_index.snapshot_token == token:
            return self._cached_index

        keyword_map: dict[str, set[str]] = defaultdict(set)
        for rel_path, record in records.items():
            for token_value in set(tokenize(f"{rel_path}\n{record.text}")):
                keyword_map[token_value].add(rel_path)

        index = RepoIndex(
            snapshot_token=token,
            files=records,
            keyword_index={
                key: tuple(sorted(paths)) for key, paths in sorted(keyword_map.items())
            },
        )
        self._cached_index = index
        return index

    def overview(self) -> dict[str, object]:
        index = self.build()
        file_paths = index.iter_paths()
        frontend_files = [path for path in file_paths if path.startswith("frontend/")]
        backend_files = [path for path in file_paths if path.startswith("backend/")]
        readme_files = [path for path in file_paths if path.lower().endswith("readme.md")]
        return {
            "snapshot_token": index.snapshot_token,
            "file_count": len(file_paths),
            "frontend_file_count": len(frontend_files),
            "backend_file_count": len(backend_files),
            "readme_count": len(readme_files),
            "files": file_paths,
        }

    def search(
        self,
        query: str,
        *,
        scope: str = "all",
        limit: int = 8,
    ) -> list[SearchResult]:
        index = self.build()
        query_text = (query or "").strip()
        if not query_text:
            return []

        query_tokens = tokenize(query_text)
        if not query_tokens:
            query_tokens = [query_text.lower()]
        query_lower = query_text.lower()

        candidate_paths = self._candidate_paths(index, query_tokens, scope=scope)
        results: list[SearchResult] = []
        for path in candidate_paths:
            record = index.files[path]
            score = self._score_record(record, query_lower, query_tokens)
            if score <= 0:
                continue
            start_line, end_line, snippet = self._build_snippet(
                record.text, query_lower, query_tokens
            )
            results.append(
                SearchResult(
                    path=record.path,
                    score=score,
                    start_line=start_line,
                    end_line=end_line,
                    snippet=snippet,
                )
            )

        results.sort(key=lambda result: (-result.score, result.path, result.start_line))
        return results[: max(limit, 1)]

    def _candidate_paths(
        self, index: RepoIndex, query_tokens: list[str], *, scope: str
    ) -> list[str]:
        scoped_paths = [
            path for path in index.iter_paths() if _path_matches_scope(path, scope)
        ]
        candidate_paths: set[str] = set()
        for token in query_tokens:
            candidate_paths.update(index.keyword_index.get(token, ()))
        if not candidate_paths:
            return scoped_paths
        return [path for path in scoped_paths if path in candidate_paths]

    @staticmethod
    def _score_record(
        record: FileRecord, query_lower: str, query_tokens: list[str]
    ) -> int:
        haystack = record.text.lower()
        path_lower = record.path.lower()
        score = 0
        if query_lower in path_lower:
            score += 40
        if query_lower in haystack:
            score += 24
        for token in query_tokens:
            score += min(path_lower.count(token), 3) * 12
            score += min(haystack.count(token), 6) * 4
        return score

    @staticmethod
    def _build_snippet(
        text: str, query_lower: str, query_tokens: list[str]
    ) -> tuple[int, int, str]:
        lines = text.splitlines()
        for index, line in enumerate(lines):
            line_lower = line.lower()
            if query_lower in line_lower or any(token in line_lower for token in query_tokens):
                start = max(index - MATCH_LINE_WINDOW, 0)
                end = min(index + MATCH_LINE_WINDOW + 1, len(lines))
                snippet = "\n".join(lines[start:end]).strip()
                return start + 1, end, snippet

        end = min(len(lines), MATCH_LINE_WINDOW + 1)
        snippet = "\n".join(lines[:end]).strip()
        return 1, end, snippet


def _path_matches_scope(path: str, scope: str) -> bool:
    normalized = (scope or "all").strip().lower()
    if normalized == "all":
        return True
    if normalized == "frontend":
        return path.startswith("frontend/")
    if normalized == "backend":
        return path.startswith("backend/")
    if normalized == "docs":
        return path.endswith("README.md") or path in {"README.md", "Readme_ja.md"}
    return True
