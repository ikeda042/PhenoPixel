from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any

from fastmcp import FastMCP

from .backend_graph import BackendEndpoint, BackendGraph, build_backend_graph
from .frontend_graph import FrontendGraph, PageNode, build_frontend_graph
from .guards import SourceFragment, read_source_fragment as read_guarded_source_fragment
from .indexer import RepoIndex, RepoIndexer, SearchResult
from .renderers import format_code_reference, render_sections


REPO_ROOT = Path(__file__).resolve().parents[3]
mcp = FastMCP("PhenoPixel Context MCP", on_duplicate="warn")


class MCPService:
    def __init__(self, repo_root: Path | None = None):
        self.repo_root = (repo_root or REPO_ROOT).resolve()
        self.indexer = RepoIndexer(self.repo_root)
        self._cached_bundle: tuple[
            tuple[int, int], RepoIndex, FrontendGraph, BackendGraph
        ] | None = None

    def _bundle(self) -> tuple[RepoIndex, FrontendGraph, BackendGraph]:
        repo_index = self.indexer.build()
        token = repo_index.snapshot_token
        if self._cached_bundle and self._cached_bundle[0] == token:
            return self._cached_bundle[1], self._cached_bundle[2], self._cached_bundle[3]
        frontend_graph = build_frontend_graph(self.repo_root, repo_index)
        backend_graph = build_backend_graph(self.repo_root, repo_index)
        self._cached_bundle = (token, repo_index, frontend_graph, backend_graph)
        return repo_index, frontend_graph, backend_graph

    def build_context_bundle(
        self, query: str, language: str = "auto", max_snippets: int = 12
    ) -> dict[str, Any]:
        repo_index, frontend_graph, backend_graph = self._bundle()
        snippets = self.indexer.search(query, limit=max_snippets)
        matching_pages = frontend_graph.search(query)[:4]
        matching_endpoints = backend_graph.search(query)[:6]
        sections = [
            (
                "概要",
                [
                    f"query={query}",
                    f"language={language}",
                    f"indexed_files={len(repo_index.files)}",
                ],
            ),
            (
                "関連ページ",
                [
                    f"{page.display_name} ({page.route}) -> {page.file_path}"
                    for page in matching_pages
                ],
            ),
            (
                "関連 API",
                [
                    f"{'/'.join(endpoint.methods) or 'GET'} {endpoint.full_path} [{endpoint.module}]"
                    for endpoint in matching_endpoints
                ],
            ),
            (
                "コード断片",
                [
                    f"{result.path}:{result.start_line} score={result.score}\n{result.snippet}"
                    for result in snippets
                ],
            ),
        ]
        return {
            "query": query,
            "language": language,
            "snippets": [self._serialize_search_result(result) for result in snippets],
            "pages": [self._serialize_page(page) for page in matching_pages],
            "endpoints": [self._serialize_endpoint(endpoint) for endpoint in matching_endpoints],
            "answer": render_sections(sections),
        }

    def search_code(self, query: str, scope: str = "all", limit: int = 8) -> dict[str, Any]:
        results = self.indexer.search(query, scope=scope, limit=limit)
        sections = [
            ("検索条件", [f"query={query}", f"scope={scope}", f"limit={limit}"]),
            (
                "一致",
                [
                    f"{result.path}:{result.start_line} score={result.score}\n{result.snippet}"
                    for result in results
                ],
            ),
        ]
        return {
            "query": query,
            "scope": scope,
            "results": [self._serialize_search_result(result) for result in results],
            "answer": render_sections(sections),
        }

    def read_source_fragment(
        self, path: str, start_line: int = 1, line_count: int = 120
    ) -> dict[str, Any]:
        fragment = read_guarded_source_fragment(
            self.repo_root,
            path,
            start_line=start_line,
            line_count=line_count,
        )
        return {
            "path": fragment.path,
            "start_line": fragment.start_line,
            "end_line": fragment.end_line,
            "total_lines": fragment.total_lines,
            "text": fragment.text,
            "answer": self._render_fragment(fragment),
        }

    def explain_api_surface(self, query: str) -> dict[str, Any]:
        _, _, backend_graph = self._bundle()
        matches = backend_graph.search(query)[:8]
        sections = [
            ("対象", [query]),
            (
                "API",
                [
                    self._describe_endpoint(endpoint)
                    for endpoint in matches
                ],
            ),
            (
                "コード参照",
                [
                    ref
                    for endpoint in matches
                    for ref in self._collect_endpoint_refs(endpoint)
                ],
            ),
        ]
        return {
            "query": query,
            "matches": [self._serialize_endpoint(endpoint) for endpoint in matches],
            "answer": render_sections(sections),
        }

    def list_pages(self) -> dict[str, Any]:
        _, frontend_graph, _ = self._bundle()
        pages = frontend_graph.pages
        sections = [
            ("ページ一覧", [f"{page.display_name} ({page.route})" for page in pages]),
        ]
        return {
            "pages": [self._serialize_page(page) for page in pages],
            "answer": render_sections(sections),
        }

    def explain_page(self, page_ref: str, question: str | None = None) -> dict[str, Any]:
        _, frontend_graph, backend_graph = self._bundle()
        page = self._require_page(frontend_graph, page_ref)
        endpoints = backend_graph.resolve_many(page.endpoint_names())
        algorithm_lines = self._build_algorithm_lines(
            backend_graph=backend_graph,
            query=question or page.display_name,
            page=page,
            endpoints=endpoints,
        )
        sections = [
            (
                "ページ概要",
                [
                    f"{page.display_name} ({page.route})",
                    f"query params: {', '.join(page.query_params) if page.query_params else 'なし'}",
                    f"source: {page.file_path}",
                ],
            ),
            (
                "主な処理",
                [
                    self._describe_action(action)
                    for action in page.actions[:8]
                ],
            ),
            (
                "呼び出し API",
                [
                    self._describe_endpoint(endpoint)
                    for endpoint in endpoints
                ],
            ),
            (
                "backend 実装",
                [
                    self._describe_backend_impl(endpoint)
                    for endpoint in endpoints
                ],
            ),
            ("関連アルゴリズム", algorithm_lines),
            (
                "コード参照",
                self._collect_page_refs(page)
                + [ref for endpoint in endpoints for ref in self._collect_endpoint_refs(endpoint)],
            ),
        ]
        return {
            "page": self._serialize_page(page),
            "endpoints": [self._serialize_endpoint(endpoint) for endpoint in endpoints],
            "answer": render_sections(sections),
        }

    def trace_page_api(self, page_ref: str) -> dict[str, Any]:
        _, frontend_graph, backend_graph = self._bundle()
        page = self._require_page(frontend_graph, page_ref)
        endpoints = backend_graph.resolve_many(page.endpoint_names())
        sections = [
            ("ページ", [f"{page.display_name} ({page.route})"]),
            (
                "API",
                [self._describe_endpoint(endpoint) for endpoint in endpoints],
            ),
            (
                "コード参照",
                [ref for endpoint in endpoints for ref in self._collect_endpoint_refs(endpoint)],
            ),
        ]
        return {
            "page": self._serialize_page(page),
            "endpoints": [self._serialize_endpoint(endpoint) for endpoint in endpoints],
            "answer": render_sections(sections),
        }

    def trace_ui_action(self, page_ref: str, action_query: str) -> dict[str, Any]:
        _, frontend_graph, backend_graph = self._bundle()
        page = self._require_page(frontend_graph, page_ref)
        actions = page.match_action(action_query)
        matches: list[dict[str, Any]] = []
        answer_lines: list[str] = []
        for action in actions[:6]:
            endpoints = backend_graph.resolve_many(list(action.endpoints))
            matches.append(
                {
                    "label": action.label,
                    "handler_name": action.handler_name,
                    "endpoints": [self._serialize_endpoint(endpoint) for endpoint in endpoints],
                }
            )
            endpoint_list = ", ".join(endpoint.short_path for endpoint in endpoints) or "なし"
            answer_lines.append(
                f"{action.label} / {action.handler_name or 'inline'} -> {endpoint_list}"
            )

        sections = [
            ("対象", [f"{page.display_name} ({page.route})", f"action={action_query}"]),
            ("一致アクション", answer_lines),
            (
                "コード参照",
                [self._collect_action_ref(page, action) for action in actions[:6]],
            ),
        ]
        return {
            "page": self._serialize_page(page),
            "action_query": action_query,
            "matches": matches,
            "answer": render_sections(sections),
        }

    def explain_algorithm(
        self, query: str, page_ref: str | None = None
    ) -> dict[str, Any]:
        _, frontend_graph, backend_graph = self._bundle()
        page = frontend_graph.resolve_page(page_ref or "") if page_ref else None
        endpoints = backend_graph.resolve_many(page.endpoint_names()) if page else []
        algorithm_lines = self._build_algorithm_lines(
            backend_graph=backend_graph,
            query=query,
            page=page,
            endpoints=endpoints,
        )
        sections = [
            ("対象", [query] + ([f"page={page.route}"] if page else [])),
            ("関連アルゴリズム", algorithm_lines),
            (
                "コード参照",
                ([ref for ref in self._collect_page_refs(page)] if page else [])
                + [ref for endpoint in endpoints for ref in self._collect_endpoint_refs(endpoint)],
            ),
        ]
        return {
            "query": query,
            "page": self._serialize_page(page) if page else None,
            "answer": render_sections(sections),
        }

    def build_page_context(self, page_ref: str, question: str) -> dict[str, Any]:
        page_payload = self.explain_page(page_ref, question)
        search_payload = self.search_code(f"{page_ref} {question}", scope="all", limit=6)
        sections = [
            ("質問", [question]),
            ("ページ要約", [page_payload["answer"]]),
            ("関連コード", [search_payload["answer"]]),
        ]
        return {
            "page": page_payload["page"],
            "question": question,
            "answer": render_sections(sections),
        }

    def repo_overview_resource(self) -> dict[str, Any]:
        return self.indexer.overview()

    def repo_openapi_resource(self) -> dict[str, Any]:
        repo_index, _, backend_graph = self._bundle()
        openapi_record = repo_index.get("backend/openapi.json")
        return {
            "path_count": len(backend_graph.endpoints),
            "example_paths": [endpoint.full_path for endpoint in backend_graph.endpoints[:12]],
            "source": "backend/openapi.json",
            "bytes": openapi_record.size if openapi_record else 0,
        }

    def frontend_pages_resource(self) -> dict[str, Any]:
        return self.list_pages()

    def frontend_page_resource(self, route: str) -> dict[str, Any]:
        return self.explain_page(_ensure_route(route))

    def frontend_page_api_map_resource(self, route: str) -> dict[str, Any]:
        return self.trace_page_api(_ensure_route(route))

    @staticmethod
    def _serialize_search_result(result: SearchResult) -> dict[str, Any]:
        return {
            "path": result.path,
            "score": result.score,
            "start_line": result.start_line,
            "end_line": result.end_line,
            "snippet": result.snippet,
        }

    @staticmethod
    def _serialize_page(page: PageNode | None) -> dict[str, Any] | None:
        if page is None:
            return None
        return {
            "route": page.route,
            "display_name": page.display_name,
            "component_name": page.component_name,
            "file_path": page.file_path,
            "query_params": list(page.query_params),
            "api_calls": [
                {
                    "endpoint": api_call.endpoint,
                    "line": api_call.line,
                    "function_name": api_call.function_name,
                }
                for api_call in page.api_calls
            ],
        }

    @staticmethod
    def _serialize_endpoint(endpoint: BackendEndpoint) -> dict[str, Any]:
        return {
            "full_path": endpoint.full_path,
            "short_path": endpoint.short_path,
            "methods": list(endpoint.methods),
            "module": endpoint.module,
            "router_path": endpoint.router_path,
            "router_line": endpoint.router_line,
            "crud_path": endpoint.crud_path,
            "crud_calls": [
                {
                    "class_name": call.class_name,
                    "method_name": call.method_name,
                    "line": call.line,
                    "definition_line": call.definition_line,
                }
                for call in endpoint.crud_calls
            ],
            "readme_path": endpoint.readme_path,
            "readme_line": endpoint.readme_line,
            "summary": endpoint.summary,
            "description": endpoint.description,
        }

    @staticmethod
    def _render_fragment(fragment: SourceFragment) -> str:
        sections = [
            (
                "ソース断片",
                [
                    f"path={fragment.path}",
                    f"lines={fragment.start_line}-{fragment.end_line}/{fragment.total_lines}",
                    fragment.text,
                ],
            )
        ]
        return render_sections(sections)

    @staticmethod
    def _require_page(frontend_graph: FrontendGraph, page_ref: str) -> PageNode:
        page = frontend_graph.resolve_page(page_ref)
        if page is None:
            raise ValueError(f"Unknown page reference: {page_ref}")
        return page

    @staticmethod
    def _describe_action(action) -> str:
        endpoint_part = ", ".join(action.endpoints) if action.endpoints else "API なし"
        return f"{action.label} ({action.handler_name or 'inline'}) -> {endpoint_part}"

    @staticmethod
    def _describe_endpoint(endpoint: BackendEndpoint) -> str:
        methods = "/".join(endpoint.methods) or "GET"
        suffix = f" [{endpoint.module}]" if endpoint.module else ""
        return f"{methods} {endpoint.full_path}{suffix}"

    @staticmethod
    def _describe_backend_impl(endpoint: BackendEndpoint) -> str:
        router_ref = format_code_reference(endpoint.router_path, endpoint.router_line)
        crud_ref = format_code_reference(
            endpoint.crud_path,
            next(
                (call.definition_line for call in endpoint.crud_calls if call.definition_line),
                None,
            ),
        )
        parts = [part for part in (router_ref, crud_ref) if part]
        return f"{endpoint.short_path} -> {', '.join(parts)}"

    @staticmethod
    def _collect_page_refs(page: PageNode | None) -> list[str]:
        if page is None:
            return []
        refs = [format_code_reference(page.file_path, 1)]
        refs.extend(
            format_code_reference(page.file_path, api_call.line) for api_call in page.api_calls[:8]
        )
        return list(dict.fromkeys(ref for ref in refs if ref))

    @staticmethod
    def _collect_action_ref(page: PageNode, action) -> str:
        return format_code_reference(page.file_path, action.line)

    @staticmethod
    def _collect_endpoint_refs(endpoint: BackendEndpoint) -> list[str]:
        refs = [
            format_code_reference(endpoint.router_path, endpoint.router_line),
            format_code_reference(
                endpoint.crud_path,
                next(
                    (call.definition_line for call in endpoint.crud_calls if call.definition_line),
                    None,
                ),
            ),
            format_code_reference(endpoint.readme_path, endpoint.readme_line),
        ]
        return [ref for ref in refs if ref]

    def _build_algorithm_lines(
        self,
        *,
        backend_graph: BackendGraph,
        query: str,
        page: PageNode | None,
        endpoints: list[BackendEndpoint],
    ) -> list[str]:
        modules = backend_graph.modules_for_endpoints(endpoints)
        if not modules and page is not None:
            endpoint_matches = backend_graph.search(query)
            modules = backend_graph.modules_for_endpoints(endpoint_matches[:6])

        lines: list[str] = []
        for module in modules:
            module_endpoints = backend_graph.endpoints_for_module(module)
            readme_endpoint = next(
                (endpoint for endpoint in module_endpoints if endpoint.readme_path),
                None,
            )
            crud_endpoint = next(
                (endpoint for endpoint in module_endpoints if endpoint.crud_path),
                None,
            )
            if readme_endpoint and readme_endpoint.readme_path:
                lines.append(
                    f"README: {readme_endpoint.readme_path}:{readme_endpoint.readme_line or 1}"
                )
            if crud_endpoint and crud_endpoint.crud_path:
                definition_line = next(
                    (
                        call.definition_line
                        for call in crud_endpoint.crud_calls
                        if call.definition_line
                    ),
                    1,
                )
                lines.append(f"実装: {crud_endpoint.crud_path}:{definition_line}")

        if page is not None:
            if endpoints:
                lines.append(
                    f"page endpoint: {page.route} -> {', '.join(endpoint.short_path for endpoint in endpoints)}"
                )
            else:
                lines.append(f"page endpoint: {page.route} -> API 未解決")

        if not lines:
            matches = backend_graph.search(query)[:4]
            lines.extend(self._describe_endpoint(endpoint) for endpoint in matches)
        return list(dict.fromkeys(lines))


@lru_cache(maxsize=4)
def get_mcp_service(repo_root: Path | None = None) -> MCPService:
    return MCPService(repo_root=repo_root)


def create_mcp_http_app():
    return mcp.http_app(path="/")


def _ensure_route(route: str) -> str:
    cleaned = (route or "").strip()
    return cleaned if cleaned.startswith("/") else f"/{cleaned}"


@mcp.tool
def build_context_bundle(
    query: str,
    language: str = "auto",
    max_snippets: int = 12,
) -> dict[str, Any]:
    return get_mcp_service().build_context_bundle(
        query=query,
        language=language,
        max_snippets=max_snippets,
    )


@mcp.tool
def search_code(query: str, scope: str = "all", limit: int = 8) -> dict[str, Any]:
    return get_mcp_service().search_code(query=query, scope=scope, limit=limit)


@mcp.tool
def read_source_fragment(
    path: str,
    start_line: int = 1,
    line_count: int = 120,
) -> dict[str, Any]:
    return get_mcp_service().read_source_fragment(
        path=path,
        start_line=start_line,
        line_count=line_count,
    )


@mcp.tool
def explain_api_surface(query: str) -> dict[str, Any]:
    return get_mcp_service().explain_api_surface(query=query)


@mcp.tool
def list_pages() -> dict[str, Any]:
    return get_mcp_service().list_pages()


@mcp.tool
def explain_page(page_ref: str, question: str | None = None) -> dict[str, Any]:
    return get_mcp_service().explain_page(page_ref=page_ref, question=question)


@mcp.tool
def trace_page_api(page_ref: str) -> dict[str, Any]:
    return get_mcp_service().trace_page_api(page_ref=page_ref)


@mcp.tool
def trace_ui_action(page_ref: str, action_query: str) -> dict[str, Any]:
    return get_mcp_service().trace_ui_action(
        page_ref=page_ref,
        action_query=action_query,
    )


@mcp.tool
def explain_algorithm(query: str, page_ref: str | None = None) -> dict[str, Any]:
    return get_mcp_service().explain_algorithm(query=query, page_ref=page_ref)


@mcp.tool
def build_page_context(page_ref: str, question: str) -> dict[str, Any]:
    return get_mcp_service().build_page_context(page_ref=page_ref, question=question)


@mcp.resource("repo://overview")
def repo_overview() -> dict[str, Any]:
    return get_mcp_service().repo_overview_resource()


@mcp.resource("repo://openapi")
def repo_openapi() -> dict[str, Any]:
    return get_mcp_service().repo_openapi_resource()


@mcp.resource("frontend://pages")
def frontend_pages() -> dict[str, Any]:
    return get_mcp_service().frontend_pages_resource()


@mcp.resource("frontend://page/{route*}")
def frontend_page(route: str) -> dict[str, Any]:
    return get_mcp_service().frontend_page_resource(route)


@mcp.resource("frontend://page/{route*}/api-map")
def frontend_page_api_map(route: str) -> dict[str, Any]:
    return get_mcp_service().frontend_page_api_map_resource(route)


@mcp.prompt
def analyze_page(page_ref: str, question: str = "") -> str:
    return (
        "Use explain_page and build_page_context for "
        f"{page_ref}. Focus on this question: {question or 'overall behavior'}."
    )
