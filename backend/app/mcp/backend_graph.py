from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from .indexer import RepoIndex, tokenize


API_PREFIX = "/api/v1"
DECORATOR_RE = re.compile(r'^@router_[A-Za-z0-9_]+\.(get|post|put|patch|delete)\("([^"]+)"')
HANDLER_RE = re.compile(r"^(?:async\s+def|def)\s+([A-Za-z_][A-Za-z0-9_]*)\(")
CRUD_CALL_RE = re.compile(r"([A-Z][A-Za-z0-9_]*Crud)\.([A-Za-z_][A-Za-z0-9_]*)")
PATH_PARAM_RE = re.compile(r"\{[^}]+\}")


@dataclass(frozen=True)
class CrudReference:
    class_name: str
    method_name: str
    line: int
    definition_line: int | None


@dataclass(frozen=True)
class BackendEndpoint:
    full_path: str
    short_path: str
    normalized_key: str
    methods: tuple[str, ...]
    module: str
    tags: tuple[str, ...]
    summary: str
    description: str
    handler_name: str | None
    router_path: str | None
    router_line: int | None
    crud_path: str | None
    crud_calls: tuple[CrudReference, ...]
    readme_path: str | None
    readme_line: int | None


class BackendGraph:
    def __init__(self, endpoints: list[BackendEndpoint]):
        self.endpoints = sorted(endpoints, key=lambda endpoint: endpoint.full_path)
        self._by_key: dict[str, BackendEndpoint] = {
            endpoint.normalized_key: endpoint for endpoint in self.endpoints
        }
        self._module_map: dict[str, list[BackendEndpoint]] = {}
        for endpoint in self.endpoints:
            self._module_map.setdefault(endpoint.module, []).append(endpoint)

    def resolve_endpoint(self, endpoint_ref: str) -> BackendEndpoint | None:
        normalized = normalize_endpoint_key(endpoint_ref)
        return self._by_key.get(normalized)

    def resolve_many(self, endpoint_refs: list[str]) -> list[BackendEndpoint]:
        resolved: list[BackendEndpoint] = []
        seen: set[str] = set()
        for endpoint_ref in endpoint_refs:
            endpoint = self.resolve_endpoint(endpoint_ref)
            if not endpoint or endpoint.normalized_key in seen:
                continue
            seen.add(endpoint.normalized_key)
            resolved.append(endpoint)
        return sorted(resolved, key=lambda endpoint: endpoint.full_path)

    def search(self, query: str) -> list[BackendEndpoint]:
        normalized_query = (query or "").strip().lower()
        query_tokens = tokenize(query)
        if not normalized_query:
            return []

        matches: list[tuple[int, BackendEndpoint]] = []
        for endpoint in self.endpoints:
            score = 0
            haystacks = (
                endpoint.full_path.lower(),
                endpoint.short_path.lower(),
                endpoint.summary.lower(),
                endpoint.description.lower(),
                " ".join(endpoint.tags).lower(),
                endpoint.module.lower(),
            )
            for haystack in haystacks:
                if normalized_query in haystack:
                    score += 24
            for token in query_tokens:
                for haystack in haystacks:
                    if token in haystack:
                        score += 6
            if score > 0:
                matches.append((score, endpoint))

        matches.sort(key=lambda item: (-item[0], item[1].full_path))
        return [endpoint for _, endpoint in matches]

    def modules_for_endpoints(self, endpoints: list[BackendEndpoint]) -> list[str]:
        return sorted({endpoint.module for endpoint in endpoints})

    def endpoints_for_module(self, module: str) -> list[BackendEndpoint]:
        return sorted(self._module_map.get(module, ()), key=lambda endpoint: endpoint.full_path)


def build_backend_graph(repo_root: Path, repo_index: RepoIndex) -> BackendGraph:
    openapi_data = json.loads(repo_index.get("backend/openapi.json").text)
    endpoints: dict[str, BackendEndpoint] = {}

    router_paths = [
        path
        for path in repo_index.iter_paths()
        if path.startswith("backend/app/") and path.endswith("/router.py")
    ]
    for router_path in router_paths:
        parsed = _parse_router_file(repo_root, repo_index, router_path)
        for endpoint in parsed:
            endpoints[endpoint.normalized_key] = endpoint

    for full_path, path_item in openapi_data.get("paths", {}).items():
        normalized_key = normalize_endpoint_key(full_path)
        existing = endpoints.get(normalized_key)
        methods = tuple(sorted(method.upper() for method in path_item))
        first_method = next(iter(path_item.values()), {})
        summary = str(first_method.get("summary") or first_method.get("operationId") or "")
        description = str(first_method.get("description") or "")
        tags = tuple(sorted({tag for item in path_item.values() for tag in item.get("tags", [])}))
        if existing:
            endpoints[normalized_key] = BackendEndpoint(
                full_path=full_path,
                short_path=existing.short_path,
                normalized_key=existing.normalized_key,
                methods=methods or existing.methods,
                module=existing.module,
                tags=tags or existing.tags,
                summary=summary or existing.summary,
                description=description or existing.description,
                handler_name=existing.handler_name,
                router_path=existing.router_path,
                router_line=existing.router_line,
                crud_path=existing.crud_path,
                crud_calls=existing.crud_calls,
                readme_path=existing.readme_path,
                readme_line=existing.readme_line,
            )
            continue

        short_path = full_path.removeprefix(f"{API_PREFIX}/").strip("/")
        module = tags[0] if tags else "unknown"
        endpoints[normalized_key] = BackendEndpoint(
            full_path=full_path,
            short_path=short_path,
            normalized_key=normalized_key,
            methods=methods,
            module=module,
            tags=tags,
            summary=summary,
            description=description,
            handler_name=None,
            router_path=None,
            router_line=None,
            crud_path=None,
            crud_calls=(),
            readme_path=None,
            readme_line=None,
        )

    return BackendGraph(list(endpoints.values()))


def normalize_endpoint_key(endpoint_ref: str) -> str:
    cleaned = (endpoint_ref or "").strip()
    if not cleaned:
        return ""
    cleaned = cleaned.removeprefix(API_PREFIX).strip("/")
    cleaned = PATH_PARAM_RE.sub("{param}", cleaned)
    return cleaned


def _parse_router_file(
    repo_root: Path, repo_index: RepoIndex, router_path: str
) -> list[BackendEndpoint]:
    record = repo_index.get(router_path)
    if record is None:
        return []

    lines = record.text.splitlines()
    module = Path(router_path).parent.name
    crud_path = f"backend/app/{module}/crud.py"
    crud_record = repo_index.get(crud_path)
    readme_path = f"backend/app/{module}/README.md"
    readme_record = repo_index.get(readme_path)

    endpoints: list[BackendEndpoint] = []
    pending_decorator: tuple[str, str, int] | None = None
    index = 0
    while index < len(lines):
        stripped = lines[index].strip()
        decorator_match = DECORATOR_RE.match(stripped)
        if decorator_match:
            pending_decorator = (
                decorator_match.group(1).upper(),
                decorator_match.group(2),
                index + 1,
            )
            index += 1
            continue

        if pending_decorator:
            handler_match = HANDLER_RE.match(stripped)
            if handler_match:
                method, route_path, decorator_line = pending_decorator
                handler_name = handler_match.group(1)
                body_start = index
                body_end = body_start + 1
                while body_end < len(lines):
                    next_line = lines[body_end].strip()
                    if DECORATOR_RE.match(next_line):
                        break
                    body_end += 1
                body_text = "\n".join(lines[body_start:body_end])
                crud_calls = _extract_crud_calls(body_text, body_start + 1, crud_record)
                full_path = (
                    route_path
                    if route_path.startswith(API_PREFIX)
                    else f"{API_PREFIX}{route_path if route_path.startswith('/') else f'/{route_path}'}"
                )
                short_path = full_path.removeprefix(f"{API_PREFIX}/").strip("/")
                endpoints.append(
                    BackendEndpoint(
                        full_path=full_path,
                        short_path=short_path,
                        normalized_key=normalize_endpoint_key(full_path),
                        methods=(method,),
                        module=module,
                        tags=(module,),
                        summary=handler_name.replace("_", " "),
                        description="",
                        handler_name=handler_name,
                        router_path=router_path,
                        router_line=decorator_line,
                        crud_path=crud_path if crud_record else None,
                        crud_calls=tuple(crud_calls),
                        readme_path=readme_path if readme_record else None,
                        readme_line=_find_readme_line(readme_record.text, short_path)
                        if readme_record
                        else None,
                    )
                )
                pending_decorator = None
                index = body_end
                continue

        index += 1

    return endpoints


def _extract_crud_calls(
    body_text: str,
    body_start_line: int,
    crud_record,
) -> list[CrudReference]:
    crud_calls: list[CrudReference] = []
    for match in CRUD_CALL_RE.finditer(body_text):
        class_name, method_name = match.groups()
        relative_line = body_text[: match.start()].count("\n")
        call_line = body_start_line + relative_line
        definition_line = None
        if crud_record:
            definition_line = _find_definition_line(crud_record.text, method_name)
        crud_calls.append(
            CrudReference(
                class_name=class_name,
                method_name=method_name,
                line=call_line,
                definition_line=definition_line,
            )
        )
    return crud_calls


def _find_definition_line(text: str, function_name: str) -> int | None:
    pattern = re.compile(rf"^\s*def\s+{re.escape(function_name)}\(", re.MULTILINE)
    match = pattern.search(text)
    if not match:
        return None
    return text[: match.start()].count("\n") + 1


def _find_readme_line(text: str, short_path: str) -> int | None:
    for needle in (f"/{short_path}", short_path):
        index = text.find(needle)
        if index >= 0:
            return text[:index].count("\n") + 1
    return 1 if text else None
