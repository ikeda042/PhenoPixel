# PhenoPixel MCP with Gemini CLI

PhenoPixel exposes a read-only FastMCP server at `/mcp` on the existing FastAPI app.
Use it to inspect the repository, trace frontend pages to backend routes, and build
context bundles for explanation tasks.

## Start the backend

Run from the repository root:

```sh
cd backend
../venv/bin/uvicorn main:app --host 0.0.0.0 --port 3000 --reload
```

- Local machine URL: `http://localhost:3000/mcp`
- LAN URL example: `http://192.168.1.20:3000/mcp`

If you want Gemini CLI from another device on the same LAN, keep `--host 0.0.0.0`
and replace the IP with the backend machine's actual LAN address.

## Gemini CLI settings.json

Add an MCP server entry in either:

- `~/.gemini/settings.json`
- `.gemini/settings.json`

Example:

```json
{
  "mcpServers": {
    "phenopixel": {
      "httpUrl": "http://localhost:3000/mcp",
      "timeout": 10000,
      "includeTools": [
        "build_context_bundle",
        "search_code",
        "read_source_fragment",
        "explain_api_surface",
        "list_pages",
        "explain_page",
        "trace_page_api",
        "trace_ui_action",
        "explain_algorithm",
        "build_page_context"
      ]
    }
  }
}
```

LAN example:

```json
{
  "mcpServers": {
    "phenopixel-lan": {
      "httpUrl": "http://192.168.1.20:3000/mcp",
      "timeout": 10000,
      "includeTools": [
        "list_pages",
        "explain_page",
        "trace_page_api",
        "trace_ui_action",
        "explain_algorithm"
      ]
    }
  }
}
```

## Gemini CLI command examples

Add the server from the CLI:

```sh
gemini mcp add --transport http phenopixel http://localhost:3000/mcp
```

Inspect exposed tools/resources/prompts from this repository:

```sh
cd backend
../venv/bin/fastmcp list http://localhost:3000/mcp --resources --prompts
```

## Suggested usage

- `list_pages`: enumerate route/page targets that the MCP server understands.
- `explain_page`: get the curated page summary in the order: page overview, main flows,
  APIs, backend implementation, related algorithm, code references.
- `trace_ui_action`: map a UI action label or handler name to the exact backend endpoint.
- `explain_algorithm`: start from module README notes, then follow the corresponding
  `crud.py`, then append the page and endpoint trail.

## Scope and safety

This v1 surface is read-only.

- Included: repo/context tools, frontend page tracing, backend API explanation.
- Excluded: mutation endpoints, extraction execution, git/system actions, database writes.
- Excluded from indexing: `frontend/dist/**`, `backend/app/databases/**`, `.db`,
  images, videos, fonts, and generated files.
