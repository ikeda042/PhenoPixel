import asyncio
import io
import logging
from concurrent.futures import ProcessPoolExecutor
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from fastapi.responses import StreamingResponse

from app.activity_tracker.crud import ACTION_BULK_ENGINE, record_activity
from app.bulk_engine.crud import BulkEngineCrud
from app.slack.notifier import build_bulk_engine_completed_message, notify_slack


logger: logging.Logger = logging.getLogger("uvicorn.error")


async def _track_bulk_engine_activity() -> None:
    try:
        await record_activity(ACTION_BULK_ENGINE)
    except Exception as exc:
        logger.warning("Activity tracking failed: %s", exc)


router_bulk_engine: APIRouter = APIRouter(
    tags=["bulk_engine"],
    dependencies=[Depends(_track_bulk_engine_activity)],
)
bulk_executor: ProcessPoolExecutor = ProcessPoolExecutor()
heatmap_bulk_executor: ProcessPoolExecutor = ProcessPoolExecutor(max_workers=1)


async def _notify_bulk_engine_completed(
    db_name: str,
    task: str,
    label: str | None,
    channel: str | None,
    degree: int | None,
    center_ratio: float | None = None,
    max_to_min_ratio: float | None = None,
) -> None:
    try:
        task_text = task.strip() if task else "bulkengine task"
        slack_message = build_bulk_engine_completed_message(
            db_name,
            task_text=task_text,
            label=label,
            channel=channel,
            degree=degree,
            center_ratio=center_ratio,
            max_to_min_ratio=max_to_min_ratio,
        )
        await notify_slack(
            slack_message,
            success_log=("Slack notified for bulk engine: %s (%s)", (db_name, task_text)),
        )
    except Exception as exc:
        logger.warning("Slack notification failed: %s", exc)


class CellLength(BaseModel):
    cell_id: str
    length: float


class CellArea(BaseModel):
    cell_id: str
    area: float


class NormalizedMedian(BaseModel):
    cell_id: str
    normalized_median: float


class RawIntensity(BaseModel):
    cell_id: str
    intensities: list[int]


class HeatmapVector(BaseModel):
    cell_id: str
    u1: list[float]
    g: list[float]


@router_bulk_engine.get("/get-heatmap-vectors-csv")
async def get_heatmap_vectors_csv_endpoint(
    dbname: Annotated[str, Query()] = ...,
    label: Annotated[str | None, Query()] = None,
    channel: Annotated[str, Query(description="fluo1 | fluo2")] = "fluo1",
    degree: Annotated[int, Query(ge=1)] = 4,
) -> StreamingResponse:
    try:
        loop = asyncio.get_running_loop()
        csv_bytes = await loop.run_in_executor(
            heatmap_bulk_executor,
            BulkEngineCrud.get_heatmap_vectors_csv,
            dbname,
            label,
            channel,
            degree,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return StreamingResponse(io.BytesIO(csv_bytes), media_type="text/csv")


@router_bulk_engine.get("/get-heatmap-vectors", response_model=list[HeatmapVector])
async def get_heatmap_vectors_endpoint(
    dbname: Annotated[str, Query()] = ...,
    label: Annotated[str | None, Query()] = None,
    channel: Annotated[str, Query(description="fluo1 | fluo2")] = "fluo1",
    degree: Annotated[int, Query(ge=1)] = 4,
) -> list[HeatmapVector]:
    try:
        loop = asyncio.get_running_loop()
        vectors = await loop.run_in_executor(
            heatmap_bulk_executor,
            BulkEngineCrud.get_heatmap_vectors,
            dbname,
            label,
            channel,
            degree,
        )
        return [
            HeatmapVector(
                cell_id=cell_id,
                u1=[float(pair[0]) for pair in path],
                g=[float(pair[1]) for pair in path],
            )
            for cell_id, path in vectors
            if path
        ]
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router_bulk_engine.get("/get-heatmap-abs-plot")
async def get_heatmap_abs_plot_endpoint(
    dbname: Annotated[str, Query()] = ...,
    label: Annotated[str | None, Query()] = None,
    channel: Annotated[str, Query(description="fluo1 | fluo2")] = "fluo1",
    degree: Annotated[int, Query(ge=1)] = 4,
) -> StreamingResponse:
    try:
        loop = asyncio.get_running_loop()
        plot_bytes = await loop.run_in_executor(
            heatmap_bulk_executor,
            BulkEngineCrud.create_heatmap_abs_plot,
            dbname,
            label,
            channel,
            degree,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    asyncio.create_task(
        _notify_bulk_engine_completed(
            dbname,
            "heatmap abs plot",
            label,
            channel,
            degree,
        )
    )
    return StreamingResponse(io.BytesIO(plot_bytes), media_type="image/png")


@router_bulk_engine.get("/get-heatmap-rel-plot")
async def get_heatmap_rel_plot_endpoint(
    dbname: Annotated[str, Query()] = ...,
    label: Annotated[str | None, Query()] = None,
    channel: Annotated[str, Query(description="fluo1 | fluo2")] = "fluo1",
    degree: Annotated[int, Query(ge=1)] = 4,
) -> StreamingResponse:
    try:
        loop = asyncio.get_running_loop()
        plot_bytes = await loop.run_in_executor(
            heatmap_bulk_executor,
            BulkEngineCrud.create_heatmap_rel_plot,
            dbname,
            label,
            channel,
            degree,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    asyncio.create_task(
        _notify_bulk_engine_completed(
            dbname,
            "heatmap rel plot",
            label,
            channel,
            degree,
        )
    )
    return StreamingResponse(io.BytesIO(plot_bytes), media_type="image/png")


@router_bulk_engine.get("/get-hu-separation-overlay")
async def get_hu_separation_overlay_endpoint(
    dbname: Annotated[str, Query()] = ...,
    label: Annotated[str | None, Query()] = None,
    channel: Annotated[str, Query(description="fluo1 | fluo2")] = "fluo1",
    degree: Annotated[int, Query(ge=1)] = 4,
    center_ratio: Annotated[float, Query(ge=0.0, le=1.0)] = 0.15,
    max_to_min_ratio: Annotated[float, Query(ge=0.0)] = 0.9,
) -> StreamingResponse:
    try:
        loop = asyncio.get_running_loop()
        overlay_bytes = await loop.run_in_executor(
            heatmap_bulk_executor,
            BulkEngineCrud.create_hu_separation_overlay,
            dbname,
            label,
            channel,
            degree,
            center_ratio,
            max_to_min_ratio,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    asyncio.create_task(
        _notify_bulk_engine_completed(
            dbname,
            "hu separation overlay",
            label,
            channel,
            degree,
            center_ratio,
            max_to_min_ratio,
        )
    )
    return StreamingResponse(io.BytesIO(overlay_bytes), media_type="image/png")


@router_bulk_engine.get("/get-map256-strip")
async def get_map256_strip_endpoint(
    dbname: Annotated[str, Query()] = ...,
    label: Annotated[str | None, Query()] = None,
    channel: Annotated[str, Query(description="fluo1 | fluo2")] = "fluo1",
    degree: Annotated[int, Query(ge=1)] = 4,
) -> StreamingResponse:
    try:
        loop = asyncio.get_running_loop()
        image_bytes = await loop.run_in_executor(
            heatmap_bulk_executor,
            BulkEngineCrud.create_map256_strip,
            dbname,
            label,
            channel,
            degree,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return StreamingResponse(io.BytesIO(image_bytes), media_type="image/png")


@router_bulk_engine.get("/get-map256-contour")
async def get_map256_contour_endpoint(
    dbname: Annotated[str, Query()] = ...,
    label: Annotated[str | None, Query()] = None,
    channel: Annotated[str, Query(description="fluo1 | fluo2")] = "fluo1",
    degree: Annotated[int, Query(ge=1)] = 4,
    intensity_mode: Annotated[
        str,
        Query(description="absolute | relative"),
    ] = "absolute",
) -> StreamingResponse:
    try:
        loop = asyncio.get_running_loop()
        image_bytes = await loop.run_in_executor(
            heatmap_bulk_executor,
            BulkEngineCrud.create_map256_contour,
            dbname,
            label,
            channel,
            degree,
            intensity_mode,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return StreamingResponse(io.BytesIO(image_bytes), media_type="image/png")


@router_bulk_engine.get("/get-contours-grid-plot")
async def get_contours_grid_plot(
    dbname: Annotated[str, Query()] = ...,
    label: Annotated[str | None, Query()] = None,
) -> StreamingResponse:
    try:
        loop = asyncio.get_running_loop()
        plot_bytes = await loop.run_in_executor(
            bulk_executor, BulkEngineCrud.create_contours_grid_plot, dbname, label
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return StreamingResponse(io.BytesIO(plot_bytes), media_type="image/png")


@router_bulk_engine.get("/get-contours-grid-json")
async def get_contours_grid_json(
    dbname: Annotated[str, Query()] = ...,
    label: Annotated[str | None, Query()] = None,
) -> StreamingResponse:
    try:
        loop = asyncio.get_running_loop()
        json_bytes = await loop.run_in_executor(
            bulk_executor, BulkEngineCrud.get_contours_grid_json, dbname, label
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return StreamingResponse(io.BytesIO(json_bytes), media_type="application/json")


@router_bulk_engine.get("/get-cell-lengths", response_model=list[CellLength])
async def get_cell_lengths(
    dbname: Annotated[str, Query()] = ...,
    label: Annotated[str | None, Query()] = None,
) -> list[CellLength]:
    try:
        loop = asyncio.get_running_loop()
        lengths = await loop.run_in_executor(
            bulk_executor,
            BulkEngineCrud.get_cell_lengths_by_label,
            dbname,
            label,
        )
        return [CellLength(cell_id=cell_id, length=length) for cell_id, length in lengths]
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router_bulk_engine.get("/get-cell-lengths-plot")
async def get_cell_lengths_plot(
    dbname: Annotated[str, Query()] = ...,
    label: Annotated[str | None, Query()] = None,
) -> StreamingResponse:
    try:
        loop = asyncio.get_running_loop()
        plot_bytes = await loop.run_in_executor(
            bulk_executor, BulkEngineCrud.create_cell_length_boxplot, dbname, label
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return StreamingResponse(io.BytesIO(plot_bytes), media_type="image/png")


@router_bulk_engine.get("/get-cell-areas", response_model=list[CellArea])
def get_cell_areas(
    dbname: Annotated[str, Query()] = ...,
    label: Annotated[str | None, Query()] = None,
) -> list[CellArea]:
    try:
        areas = BulkEngineCrud.get_cell_areas_by_label(dbname, label)
        return [CellArea(cell_id=cell_id, area=area) for cell_id, area in areas]
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router_bulk_engine.get("/get-cell-areas-plot")
async def get_cell_areas_plot(
    dbname: Annotated[str, Query()] = ...,
    label: Annotated[str | None, Query()] = None,
) -> StreamingResponse:
    try:
        loop = asyncio.get_running_loop()
        plot_bytes = await loop.run_in_executor(
            bulk_executor, BulkEngineCrud.create_cell_area_boxplot, dbname, label
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return StreamingResponse(io.BytesIO(plot_bytes), media_type="image/png")


@router_bulk_engine.get("/get-normalized-medians", response_model=list[NormalizedMedian])
async def get_normalized_medians(
    dbname: Annotated[str, Query()] = ...,
    label: Annotated[str | None, Query()] = None,
    channel: Annotated[str, Query(description="ph | fluo1 | fluo2")] = "ph",
) -> list[NormalizedMedian]:
    try:
        loop = asyncio.get_running_loop()
        medians = await loop.run_in_executor(
            bulk_executor,
            BulkEngineCrud.get_normalized_medians_by_label,
            dbname,
            label,
            channel,
        )
        return [
            NormalizedMedian(cell_id=cell_id, normalized_median=median)
            for cell_id, median in medians
        ]
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router_bulk_engine.get("/get-normalized-medians-plot")
async def get_normalized_medians_plot(
    dbname: Annotated[str, Query()] = ...,
    label: Annotated[str | None, Query()] = None,
    channel: Annotated[str, Query(description="ph | fluo1 | fluo2")] = "ph",
) -> StreamingResponse:
    try:
        loop = asyncio.get_running_loop()
        plot_bytes = await loop.run_in_executor(
            bulk_executor,
            BulkEngineCrud.create_normalized_median_boxplot,
            dbname,
            label,
            channel,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return StreamingResponse(io.BytesIO(plot_bytes), media_type="image/png")


@router_bulk_engine.get("/get-fitc-aggregation-plot")
async def get_fitc_aggregation_plot(
    dbname: Annotated[str, Query()] = ...,
    label: Annotated[str | None, Query()] = None,
    channel: Annotated[str, Query(description="fluo1 | fluo2")] = "fluo1",
) -> StreamingResponse:
    try:
        loop = asyncio.get_running_loop()
        plot_bytes = await loop.run_in_executor(
            bulk_executor,
            BulkEngineCrud.create_fitc_aggregation_ratio_plot,
            dbname,
            label,
            channel,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return StreamingResponse(io.BytesIO(plot_bytes), media_type="image/png")


@router_bulk_engine.get("/get-raw-intensities", response_model=list[RawIntensity])
async def get_raw_intensities(
    dbname: Annotated[str, Query()] = ...,
    label: Annotated[str | None, Query()] = None,
    channel: Annotated[str, Query(description="ph | fluo1 | fluo2")] = "ph",
) -> list[RawIntensity]:
    try:
        loop = asyncio.get_running_loop()
        raw_rows = await loop.run_in_executor(
            bulk_executor,
            BulkEngineCrud.get_raw_intensities_by_label,
            dbname,
            label,
            channel,
        )
        return [
            RawIntensity(cell_id=cell_id, intensities=intensities)
            for cell_id, intensities in raw_rows
        ]
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
