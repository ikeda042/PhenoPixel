import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastmcp.utilities.lifespan import combine_lifespans

from app.activity_tracker.router import router_activity_tracker
from app.bulk_engine.router import router_bulk_engine
from app.cellextraction.router import router_cellextraction
from app.database_manager.crud import migrate_all_databases
from app.database_manager.router import router_database_manager
from app.extracted_data.router import router_extracted_data
from app.file_manager.router import router_file_manager
from app.graphengine.router import router_graphengine
from app.mcp import create_mcp_http_app
from app.mother_machine.router import router_mother_machine
from app.nd2files.router import router_nd2
from app.nd2parser.router import router_nd2parser
from app.system.router import router_system

API_PREFIX: str = "/api/v1"
mcp_app = create_mcp_http_app()


@asynccontextmanager
async def app_lifespan(_: FastAPI):
    failures = migrate_all_databases()
    for db_name, error in failures:
        logging.getLogger("uvicorn.error").warning(
            "Database migration skipped for %s: %s", db_name, error
        )
    yield


app: FastAPI = FastAPI(
    docs_url=f"{API_PREFIX}/docs",
    openapi_url=f"{API_PREFIX}/openapi.json",
    lifespan=combine_lifespans(app_lifespan, mcp_app.lifespan),
)
logger: logging.Logger = logging.getLogger("uvicorn.error")
FRONTEND_DIST_DIR: Path = Path(__file__).resolve().parent.parent / "frontend" / "dist"
FRONTEND_INDEX: Path = FRONTEND_DIST_DIR / "index.html"

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(router_nd2, prefix=API_PREFIX)
app.include_router(router_nd2parser, prefix=API_PREFIX)
app.include_router(router_extracted_data, prefix=API_PREFIX)
app.include_router(router_cellextraction, prefix=API_PREFIX)
app.include_router(router_database_manager, prefix=API_PREFIX)
app.include_router(router_bulk_engine, prefix=API_PREFIX)
app.include_router(router_file_manager, prefix=API_PREFIX)
app.include_router(router_graphengine, prefix=API_PREFIX)
app.include_router(router_system, prefix=API_PREFIX)
app.include_router(router_activity_tracker, prefix=API_PREFIX)
app.include_router(router_mother_machine, prefix=API_PREFIX)
app.mount("/mcp", mcp_app)


@app.api_route("/mcp", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"], include_in_schema=False)
async def redirect_mcp_root(request: Request) -> RedirectResponse:
    return RedirectResponse(url=str(request.url.replace(path="/mcp/")), status_code=307)


@app.exception_handler(HTTPException)
async def http_exception_handler(
    request: Request, exc: HTTPException
) -> JSONResponse:
    if exc.status_code >= 500:
        logger.error(
            "HTTP %s %s %s: %s",
            exc.status_code,
            request.method,
            request.url.path,
            exc.detail,
        )
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
        headers=exc.headers,
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(
    request: Request, exc: Exception
) -> JSONResponse:
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Internal Server Error"})


@app.get(f"{API_PREFIX}/")
def read_root() -> dict[str, str]:
    return {"message": "Hello from PhenoPixel"}


@app.get(f"{API_PREFIX}/health")
def read_health() -> dict[str, str]:
    return {"status": "ok"}


if FRONTEND_INDEX.is_file():
    assets_dir: Path = FRONTEND_DIST_DIR / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/", include_in_schema=False)
    def serve_index() -> FileResponse:
        return FileResponse(FRONTEND_INDEX)

    @app.get("/{full_path:path}", include_in_schema=False)
    def serve_spa(full_path: str) -> FileResponse:
        if full_path.startswith(API_PREFIX.lstrip("/")):
            raise HTTPException(status_code=404, detail="Not Found")
        file_path: Path = FRONTEND_DIST_DIR / full_path
        if file_path.is_file():
            return FileResponse(file_path)
        directory_index: Path = file_path / "index.html"
        if directory_index.is_file():
            return FileResponse(directory_index)
        html_path: Path = file_path.with_suffix(".html")
        if html_path.is_file():
            return FileResponse(html_path)
        return FileResponse(FRONTEND_INDEX)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=3000, reload=True)
