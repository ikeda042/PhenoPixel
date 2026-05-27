from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from .indexer import RepoIndex, tokenize
from .renderers import humanize_identifier, normalize_lookup_key


IMPORT_RE = re.compile(r'^import\s+([A-Za-z_][A-Za-z0-9_]*)\s+from\s+[\'"]([^\'"]+)[\'"]', re.MULTILINE)
ROUTE_RE = re.compile(r'<Route\s+path="([^"]+)"\s+element={<([A-Za-z_][A-Za-z0-9_]*)\s*/>}[\s/]*/?>')
FUNCTION_RE = re.compile(
    r"const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:useCallback\(\s*)?(?:async\s*)?\([^)]*\)\s*=>\s*{",
    re.MULTILINE,
)
QUERY_PARAM_RE = re.compile(r"searchParams\.get\(['\"]([^'\"]+)['\"]\)")
API_TEMPLATE_RE = re.compile(r"\$\{apiBase\}/([^`]+)")
ENDPOINT_LITERAL_RE = re.compile(
    r"['\"]((?:get|update|elastic|extract|nd2parser|nd2_files|filemanager|graph_engine)[A-Za-z0-9_/\-{}.]*)['\"]"
)
BUTTON_RE = re.compile(r"<Button\b(?P<attrs>[^>]*)>(?P<body>.*?)</Button>", re.DOTALL)
CLICK_RE = re.compile(r"onClick=\{(.*?)\}")
STRING_RE = re.compile(r"['\"]([^'\"]+)['\"]")
HEADING_RE = re.compile(r"<BreadcrumbCurrentLink[^>]*>([^<]+)</BreadcrumbCurrentLink>")
PATH_PARAM_RE = re.compile(r"\$\{[^}]+\}")


@dataclass(frozen=True)
class ApiCall:
    endpoint: str
    line: int
    function_name: str | None


@dataclass(frozen=True)
class UiAction:
    label: str
    handler_name: str | None
    line: int
    endpoints: tuple[str, ...]


@dataclass(frozen=True)
class PageNode:
    route: str
    component_name: str
    display_name: str
    file_path: str
    query_params: tuple[str, ...]
    api_calls: tuple[ApiCall, ...]
    actions: tuple[UiAction, ...]
    aliases: tuple[str, ...]

    def endpoint_names(self) -> list[str]:
        return sorted({call.endpoint for call in self.api_calls})

    def match_action(self, query: str) -> list[UiAction]:
        normalized_query = normalize_lookup_key(query)
        ranked: list[tuple[int, UiAction]] = []
        for action in self.actions:
            score = 0
            haystacks = (
                normalize_lookup_key(action.label),
                normalize_lookup_key(action.handler_name or ""),
                normalize_lookup_key(" ".join(action.endpoints)),
            )
            for haystack in haystacks:
                if normalized_query and normalized_query in haystack:
                    score += 24
            for token in tokenize(query):
                for haystack in haystacks:
                    if token in haystack:
                        score += 6
            if score > 0:
                ranked.append((score, action))
        ranked.sort(key=lambda item: (-item[0], item[1].line, item[1].label))
        return [action for _, action in ranked]


class FrontendGraph:
    def __init__(self, pages: list[PageNode]):
        self.pages = sorted(pages, key=lambda page: page.route)
        self._by_route = {page.route: page for page in self.pages}

    def resolve_page(self, page_ref: str) -> PageNode | None:
        normalized_ref = normalize_lookup_key(page_ref)
        for page in self.pages:
            if normalized_ref in {normalize_lookup_key(alias) for alias in page.aliases}:
                return page
        return self._by_route.get(page_ref)

    def search(self, query: str) -> list[PageNode]:
        normalized_query = normalize_lookup_key(query)
        ranked: list[tuple[int, PageNode]] = []
        for page in self.pages:
            score = 0
            haystacks = [normalize_lookup_key(alias) for alias in page.aliases]
            haystacks.extend(normalize_lookup_key(call.endpoint) for call in page.api_calls)
            if normalized_query:
                score += sum(12 for haystack in haystacks if normalized_query in haystack)
            for token in tokenize(query):
                score += sum(4 for haystack in haystacks if token in haystack)
            if score > 0:
                ranked.append((score, page))
        ranked.sort(key=lambda item: (-item[0], item[1].route))
        return [page for _, page in ranked]


def build_frontend_graph(repo_root: Path, repo_index: RepoIndex) -> FrontendGraph:
    main_record = repo_index.get("frontend/src/main.tsx")
    if main_record is None:
        return FrontendGraph([])

    imports = _parse_imports(main_record.text)
    pages: list[PageNode] = []
    for route, component_name in ROUTE_RE.findall(main_record.text):
        import_path = imports.get(component_name)
        if not import_path or not import_path.startswith("./pages/"):
            continue
        file_path = _resolve_ts_import("frontend/src/main.tsx", import_path)
        record = repo_index.get(file_path)
        if record is None:
            continue
        display_name = _extract_display_name(record.text, component_name, route)
        query_params = tuple(sorted(set(QUERY_PARAM_RE.findall(record.text))))
        function_blocks = _extract_function_blocks(record.text)
        function_endpoints = {
            name: _extract_endpoints(body)
            for name, _, _, body in function_blocks
        }
        api_calls = _build_api_calls(record.text, function_blocks, function_endpoints)
        actions = _build_actions(record.text, function_blocks, function_endpoints)
        aliases = _build_aliases(route, component_name, display_name, file_path)
        pages.append(
            PageNode(
                route=route,
                component_name=component_name,
                display_name=display_name,
                file_path=file_path,
                query_params=query_params,
                api_calls=tuple(api_calls),
                actions=tuple(actions),
                aliases=tuple(sorted(aliases)),
            )
        )

    return FrontendGraph(pages)


def _parse_imports(text: str) -> dict[str, str]:
    return {name: path for name, path in IMPORT_RE.findall(text)}


def _resolve_ts_import(base_path: str, import_path: str) -> str:
    base_dir = Path(base_path).parent
    resolved = (base_dir / import_path).with_suffix(".tsx")
    return resolved.as_posix()


def _extract_display_name(text: str, component_name: str, route: str) -> str:
    heading_match = HEADING_RE.search(text)
    if heading_match:
        return heading_match.group(1).strip()
    return humanize_identifier(component_name.removesuffix("Page") or route.strip("/"))


def _extract_function_blocks(text: str) -> list[tuple[str, int, int, str]]:
    blocks: list[tuple[str, int, int, str]] = []
    for match in FUNCTION_RE.finditer(text):
        name = match.group(1)
        brace_index = text.find("{", match.end() - 1)
        if brace_index < 0:
            continue
        body_end = _find_matching_brace(text, brace_index)
        if body_end < 0:
            continue
        start_line = text[: match.start()].count("\n") + 1
        end_line = text[:body_end].count("\n") + 1
        body = text[brace_index : body_end + 1]
        blocks.append((name, start_line, end_line, body))
    return blocks


def _find_matching_brace(text: str, start_index: int) -> int:
    depth = 0
    index = start_index
    in_string: str | None = None
    in_line_comment = False
    in_block_comment = False
    while index < len(text):
        char = text[index]
        next_char = text[index + 1] if index + 1 < len(text) else ""

        if in_line_comment:
            if char == "\n":
                in_line_comment = False
            index += 1
            continue

        if in_block_comment:
            if char == "*" and next_char == "/":
                in_block_comment = False
                index += 2
                continue
            index += 1
            continue

        if in_string:
            if char == "\\":
                index += 2
                continue
            if char == in_string:
                in_string = None
            index += 1
            continue

        if char == "/" and next_char == "/":
            in_line_comment = True
            index += 2
            continue
        if char == "/" and next_char == "*":
            in_block_comment = True
            index += 2
            continue
        if char in {"'", '"', "`"}:
            in_string = char
            index += 1
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index
        index += 1
    return -1


def _extract_endpoints(body: str) -> list[str]:
    endpoints: set[str] = set()
    for match in API_TEMPLATE_RE.finditer(body):
        endpoint = _normalize_endpoint(match.group(1))
        if endpoint:
            endpoints.add(endpoint)
    for match in ENDPOINT_LITERAL_RE.finditer(body):
        endpoint = _normalize_endpoint(match.group(1))
        if endpoint:
            endpoints.add(endpoint)
    return sorted(endpoints)


def _normalize_endpoint(raw: str) -> str | None:
    cleaned = (raw or "").strip()
    if not cleaned:
        return None
    cleaned = cleaned.split("?")[0]
    cleaned = PATH_PARAM_RE.sub("{param}", cleaned)
    cleaned = cleaned.strip("/")
    if not cleaned or cleaned.startswith("{endpoint}") or cleaned == "{param}":
        return None
    return cleaned


def _build_api_calls(
    file_text: str,
    function_blocks: list[tuple[str, int, int, str]],
    function_endpoints: dict[str, list[str]],
) -> list[ApiCall]:
    api_calls: dict[tuple[str, str | None], ApiCall] = {}
    for function_name, start_line, _, body in function_blocks:
        endpoints = function_endpoints.get(function_name, [])
        if not endpoints:
            continue
        for endpoint in endpoints:
            line = _find_line_number(body, endpoint)
            api_call = ApiCall(
                endpoint=endpoint,
                line=(start_line + line - 1) if line else start_line,
                function_name=function_name,
            )
            api_calls[(endpoint, function_name)] = api_call
    return sorted(api_calls.values(), key=lambda api_call: (api_call.line, api_call.endpoint))


def _build_actions(
    file_text: str,
    function_blocks: list[tuple[str, int, int, str]],
    function_endpoints: dict[str, list[str]],
) -> list[UiAction]:
    actions: dict[tuple[str | None, str], UiAction] = {}
    function_start_lines = {name: start for name, start, _, _ in function_blocks}

    for match in BUTTON_RE.finditer(file_text):
        attrs = match.group("attrs")
        body = match.group("body")
        click_match = CLICK_RE.search(attrs)
        if not click_match:
            continue
        handler_name = _extract_handler_name(click_match.group(1))
        label = _extract_button_label(body)
        if not label and not handler_name:
            continue
        endpoints = tuple(function_endpoints.get(handler_name or "", ()))
        line = file_text[: match.start()].count("\n") + 1
        key = (handler_name, label or humanize_identifier(handler_name or "action"))
        actions[key] = UiAction(
            label=label or humanize_identifier(handler_name or "action"),
            handler_name=handler_name,
            line=line,
            endpoints=endpoints,
        )

    for function_name, endpoints in function_endpoints.items():
        if not endpoints:
            continue
        if not function_name.startswith(("handle", "load", "fetch")):
            continue
        key = (function_name, humanize_identifier(function_name))
        actions.setdefault(
            key,
            UiAction(
                label=humanize_identifier(function_name),
                handler_name=function_name,
                line=function_start_lines.get(function_name, 1),
                endpoints=tuple(endpoints),
            ),
        )

    return sorted(actions.values(), key=lambda action: (action.line, action.label))


def _extract_handler_name(expression: str) -> str | None:
    cleaned = expression.strip()
    match = re.search(r"([A-Za-z_][A-Za-z0-9_]*)\s*\(", cleaned)
    if match:
        return match.group(1)
    match = re.search(r"([A-Za-z_][A-Za-z0-9_]*)$", cleaned)
    return match.group(1) if match else None


def _extract_button_label(body: str) -> str:
    text_only = re.sub(r"<[^>]+>", " ", body)
    text_only = re.sub(r"\s+", " ", text_only).strip()
    if text_only and "{" not in text_only and "}" not in text_only:
        return text_only
    strings = [value for value in STRING_RE.findall(body) if value]
    if strings:
        return " / ".join(dict.fromkeys(strings))
    return ""


def _build_aliases(
    route: str,
    component_name: str,
    display_name: str,
    file_path: str,
) -> set[str]:
    aliases = {
        route,
        route.lstrip("/"),
        component_name,
        component_name.removesuffix("Page"),
        display_name,
        Path(file_path).name,
        file_path,
        Path(file_path).stem,
    }
    return {alias for alias in aliases if alias}


def _find_line_number(text: str, needle: str) -> int | None:
    index = text.find(needle)
    if index < 0:
        return None
    return text[:index].count("\n") + 1
