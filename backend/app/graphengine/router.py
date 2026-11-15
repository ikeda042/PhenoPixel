import asyncio
import io
from collections.abc import Callable
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.graphengine.crud import GraphEngineCrud, GraphEngineResult
from app.shared.analysis_executor import ANALYSIS_WORKERS, analysis_executor

router_graphengine: APIRouter = APIRouter(tags=["graph_engine"])


class GraphEngineResultResponse(BaseModel):
    filename: str
    mean_length: float
    nagg_rate: float | None


async def _render_graph_engine_image(
    render_fn: Callable[[str | None, bytes], bytes],
    mode: str | None,
    file: UploadFile,
) -> StreamingResponse:
    try:
        content: bytes = await file.read()
        if not content:
            raise ValueError("Uploaded file is empty")
        loop: asyncio.AbstractEventLoop = asyncio.get_running_loop()
        image_bytes: bytes = await loop.run_in_executor(analysis_executor, render_fn, mode, content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        await file.close()
    return StreamingResponse(io.BytesIO(image_bytes), media_type="image/png")


@router_graphengine.post("/graph_engine/heatmap_abs")
async def graph_engine_heatmap_abs(
    file: Annotated[UploadFile, File()],
    mode: Annotated[str | None, Form()] = None,
) -> StreamingResponse:
    return await _render_graph_engine_image(GraphEngineCrud.create_heatmap_abs_plot, mode, file)


@router_graphengine.post("/graph_engine/heatmap_rel")
async def graph_engine_heatmap_rel(
    file: Annotated[UploadFile, File()],
    mode: Annotated[str | None, Form()] = None,
) -> StreamingResponse:
    return await _render_graph_engine_image(GraphEngineCrud.create_heatmap_rel_plot, mode, file)


@router_graphengine.post("/graph_engine/distribution")
async def graph_engine_distribution(
    file: Annotated[UploadFile, File()],
    mode: Annotated[str | None, Form()] = None,
) -> StreamingResponse:
    return await _render_graph_engine_image(GraphEngineCrud.create_distribution_plot, mode, file)


@router_graphengine.post("/graph_engine/distribution_box")
async def graph_engine_distribution_box(
    file: Annotated[UploadFile, File()],
    mode: Annotated[str | None, Form()] = None,
) -> StreamingResponse:
    return await _render_graph_engine_image(GraphEngineCrud.create_distribution_box_plot, mode, file)


@router_graphengine.post(
    "/graph_engine/images",
    response_class=StreamingResponse,
    responses={200: {"content": {"application/zip": {"schema": {"type": "string", "format": "binary"}}}}},
)
async def graph_engine_images(
    file: Annotated[UploadFile, File()],
    mode: Annotated[str | None, Form()] = None,
) -> StreamingResponse:
    try:
        content = await file.read()
        if not content:
            raise ValueError("Uploaded file is empty")
        bundle = await asyncio.get_running_loop().run_in_executor(
            analysis_executor, GraphEngineCrud.create_plot_bundle, mode, content
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        await file.close()
    return StreamingResponse(io.BytesIO(bundle), media_type="application/zip")


@router_graphengine.post("/graph_engine/{mode}", response_model=list[GraphEngineResultResponse])
async def analyze_graph_engine(
    mode: str,
    files: Annotated[list[UploadFile], File()],
    ctrl_file: Annotated[UploadFile | None, File()] = None,
) -> list[GraphEngineResultResponse]:
    if not files:
        raise HTTPException(status_code=400, detail="No files provided")
    try:
        ctrl_bytes: bytes | None = await ctrl_file.read() if ctrl_file else None
        payloads: list[tuple[str, bytes]] = []
        for file in files:
            content: bytes = await file.read()
            if not content:
                continue
            payloads.append((file.filename or "file.csv", content))
        if not payloads:
            raise ValueError("No valid CSV files uploaded")
        loop: asyncio.AbstractEventLoop = asyncio.get_running_loop()
        if len(payloads) == 1:
            results: list[GraphEngineResult] = await loop.run_in_executor(
                analysis_executor, GraphEngineCrud.analyze_files, mode, payloads, ctrl_bytes
            )
        else:
            ctrl = await loop.run_in_executor(
                analysis_executor, GraphEngineCrud.parse_control, mode, ctrl_bytes
            )
            semaphore = asyncio.Semaphore(ANALYSIS_WORKERS)

            async def analyze_one(name: str, content: bytes) -> GraphEngineResult:
                async with semaphore:
                    return await loop.run_in_executor(
                        analysis_executor, GraphEngineCrud.analyze_file, name, content, ctrl
                    )

            results = await asyncio.gather(*(analyze_one(name, content) for name, content in payloads))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        if ctrl_file:
            await ctrl_file.close()
        for file in files:
            await file.close()
    return [
        GraphEngineResultResponse(
            filename=result.filename,
            mean_length=result.mean_length,
            nagg_rate=result.nagg_rate,
        )
        for result in results
    ]
