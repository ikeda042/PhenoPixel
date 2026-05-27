import asyncio
import io
from concurrent.futures import ProcessPoolExecutor
from functools import partial
from typing import Annotated, AsyncIterator, Literal

from fastapi import APIRouter, File, HTTPException, Path, Query, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from app.database_manager.crud import DatabaseManagerCrud


router_database_manager: APIRouter = APIRouter(tags=["database_manager"])
annotation_executor: ProcessPoolExecutor = ProcessPoolExecutor()
heatmap_executor: ProcessPoolExecutor = ProcessPoolExecutor(max_workers=1)
UPLOAD_CHUNK_SIZE: int = 1024 * 1024 * 100


async def _iter_upload(file: UploadFile) -> AsyncIterator[bytes]:
    while True:
        chunk = await file.read(UPLOAD_CHUNK_SIZE)
        if not chunk:
            break
        yield chunk


@router_database_manager.get("/get-databases", response_model=list[str])
async def get_databases() -> list[str]:
    return await DatabaseManagerCrud.list_databases()


@router_database_manager.post("/database_files")
async def upload_database(file: Annotated[UploadFile, File()] = ...) -> dict:
    try:
        payload = await DatabaseManagerCrud.save_upload(
            file.filename or "",
            _iter_upload(file),
        )
        DatabaseManagerCrud.migrate_database(str(payload["filename"]))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        await file.close()
    return payload


@router_database_manager.get("/database_files/{dbname}")
async def download_database_endpoint(dbname: Annotated[str, Path()]) -> FileResponse:
    try:
        db_path = DatabaseManagerCrud.resolve_database_path(dbname)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not db_path.is_file():
        raise HTTPException(status_code=404, detail="Database not found")
    return FileResponse(
        db_path,
        media_type="application/octet-stream",
        filename=db_path.name,
    )


@router_database_manager.delete("/database_files/{dbname}")
async def delete_database_endpoint(dbname: Annotated[str, Path()]) -> dict:
    try:
        deleted = await DatabaseManagerCrud.delete_database(dbname)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return {"deleted": True, "filename": deleted}


@router_database_manager.patch("/database_files/{dbname}")
async def rename_database_endpoint(
    dbname: Annotated[str, Path()],
    new_name: Annotated[str, Query(alias="new_name")] = ...,
) -> dict:
    try:
        previous, updated = await DatabaseManagerCrud.rename_database(dbname, new_name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return {"previous": previous, "filename": updated}


@router_database_manager.get("/get-cell-ids", response_model=list[str])
def get_cell_ids_endpoint(dbname: Annotated[str, Query()] = ...) -> list[str]:
    try:
        return DatabaseManagerCrud.get_cell_ids(dbname)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router_database_manager.get("/get-cell-ids-by-label", response_model=list[str])
def get_cell_ids_by_label_endpoint(
    dbname: Annotated[str, Query()] = ...,
    label: Annotated[str, Query()] = ...,
) -> list[str]:
    try:
        return DatabaseManagerCrud.get_cell_ids_by_label(dbname, label)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router_database_manager.get("/get-cells-fast-bundle")
async def get_cells_fast_bundle_endpoint(
    dbname: Annotated[str, Query()] = ...,
    label: Annotated[str | None, Query()] = None,
    draw_contour: Annotated[bool, Query()] = True,
    draw_scale_bar: Annotated[bool, Query()] = True,
    fluo1_color: Annotated[
        Literal["blue", "green", "red", "yellow", "magenta", "gray"] | None,
        Query(description="blue | green | red | yellow | magenta | gray"),
    ] = None,
    fluo2_color: Annotated[
        Literal["blue", "green", "red", "yellow", "magenta", "gray"] | None,
        Query(description="blue | green | red | yellow | magenta | gray"),
    ] = None,
    gain: Annotated[float, Query(gt=0)] = 1.0,
) -> StreamingResponse:
    try:
        loop = asyncio.get_running_loop()
        task = partial(
            DatabaseManagerCrud.get_cells_fast_bundle,
            dbname,
            label=label,
            draw_contour=draw_contour,
            draw_scale_bar=draw_scale_bar,
            fluo1_color=fluo1_color,
            fluo2_color=fluo2_color,
            gain=gain,
        )
        zip_bytes = await loop.run_in_executor(annotation_executor, task)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return StreamingResponse(io.BytesIO(zip_bytes), media_type="application/zip")


@router_database_manager.get("/get-manual-labels", response_model=list[str])
def get_manual_labels_endpoint(
    dbname: Annotated[str, Query()] = ...,
) -> list[str]:
    try:
        return DatabaseManagerCrud.get_manual_labels(dbname)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router_database_manager.get("/get-cell-contour")
def get_cell_contour_endpoint(
    dbname: Annotated[str, Query()] = ...,
    cell_id: Annotated[str, Query()] = ...,
) -> dict:
    try:
        contour = DatabaseManagerCrud.get_cell_contour(dbname, cell_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except LookupError:
        raise HTTPException(status_code=404, detail="Cell contour not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return {"contour": contour}


@router_database_manager.get("/get-cell-label", response_model=str)
def get_cell_label_endpoint(
    dbname: Annotated[str, Query()] = ...,
    cell_id: Annotated[str, Query()] = ...,
) -> str:
    try:
        return DatabaseManagerCrud.get_cell_label(dbname, cell_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except LookupError:
        raise HTTPException(status_code=404, detail="Cell label not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router_database_manager.get("/get-cell-image")
def get_cell_image_endpoint(
    dbname: Annotated[str, Query()] = ...,
    cell_id: Annotated[str, Query()] = ...,
    image_type: Annotated[str, Query(description="ph | fluo1 | fluo2")] = ...,
    draw_contour: Annotated[bool, Query()] = False,
    draw_scale_bar: Annotated[bool, Query()] = False,
    gain: Annotated[float, Query(gt=0)] = 1.0,
    fluo_color: Annotated[
        Literal["blue", "green", "red", "yellow", "magenta", "gray"] | None,
        Query(description="blue | green | red | yellow | magenta | gray"),
    ] = None,
) -> StreamingResponse:
    try:
        image_bytes = DatabaseManagerCrud.get_cell_image(
            dbname,
            cell_id,
            image_type,
            draw_contour=draw_contour,
            draw_scale_bar=draw_scale_bar,
            gain=gain,
            fluo_color=fluo_color,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except LookupError:
        raise HTTPException(status_code=404, detail="Cell image not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return StreamingResponse(io.BytesIO(image_bytes), media_type="image/png")


@router_database_manager.get("/get-cell-image-optical-boost")
def get_cell_image_optical_boost_endpoint(
    dbname: Annotated[str, Query()] = ...,
    cell_id: Annotated[str, Query()] = ...,
    image_type: Annotated[str, Query(description="fluo1 | fluo2")] = ...,
    draw_contour: Annotated[bool, Query()] = False,
    draw_scale_bar: Annotated[bool, Query()] = False,
    fluo_color: Annotated[
        Literal["blue", "green", "red", "yellow", "magenta", "gray"] | None,
        Query(description="blue | green | red | yellow | magenta | gray"),
    ] = None,
) -> StreamingResponse:
    try:
        image_bytes = DatabaseManagerCrud.get_cell_image_optical_boost(
            dbname,
            cell_id,
            image_type,
            draw_contour=draw_contour,
            draw_scale_bar=draw_scale_bar,
            fluo_color=fluo_color,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except LookupError:
        raise HTTPException(status_code=404, detail="Cell image not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return StreamingResponse(io.BytesIO(image_bytes), media_type="image/png")


@router_database_manager.get("/get-cell-overlay")
def get_cell_overlay_endpoint(
    dbname: Annotated[str, Query()] = ...,
    cell_id: Annotated[str, Query()] = ...,
    draw_scale_bar: Annotated[bool, Query()] = False,
    overlay_mode: Annotated[Literal["ph", "fluo", "raw"], Query()] = "ph",
    scale: Annotated[float, Query(gt=0, le=1)] = 1.0,
    fluo1_color: Annotated[
        Literal["blue", "green", "red", "yellow", "magenta", "gray"] | None,
        Query(description="blue | green | red | yellow | magenta | gray"),
    ] = None,
    fluo2_color: Annotated[
        Literal["blue", "green", "red", "yellow", "magenta", "gray"] | None,
        Query(description="blue | green | red | yellow | magenta | gray"),
    ] = None,
    image_format: Annotated[
        Literal["png", "jpeg", "jpg"], Query(alias="format")
    ] = "png",
    jpeg_quality: Annotated[int, Query(ge=10, le=95)] = 80,
) -> StreamingResponse:
    try:
        image_bytes = DatabaseManagerCrud.get_cell_overlay(
            dbname,
            cell_id,
            draw_scale_bar=draw_scale_bar,
            overlay_mode=overlay_mode,
            scale=scale,
            fluo1_color=fluo1_color,
            fluo2_color=fluo2_color,
            image_format=image_format,
            jpeg_quality=jpeg_quality,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except LookupError:
        raise HTTPException(status_code=404, detail="Cell overlay not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    media_type = (
        "image/jpeg" if image_format.lower() in ("jpeg", "jpg") else "image/png"
    )
    return StreamingResponse(io.BytesIO(image_bytes), media_type=media_type)


@router_database_manager.get("/get-cell-overlay-zip")
async def get_cell_overlay_zip_endpoint(
    dbname: Annotated[str, Query()] = ...,
    draw_scale_bar: Annotated[bool, Query()] = False,
    overlay_mode: Annotated[Literal["ph", "fluo", "raw"], Query()] = "ph",
    scale: Annotated[float, Query(gt=0, le=1)] = 1.0,
    fluo1_color: Annotated[
        Literal["blue", "green", "red", "yellow", "magenta", "gray"] | None,
        Query(description="blue | green | red | yellow | magenta | gray"),
    ] = None,
    fluo2_color: Annotated[
        Literal["blue", "green", "red", "yellow", "magenta", "gray"] | None,
        Query(description="blue | green | red | yellow | magenta | gray"),
    ] = None,
    image_format: Annotated[
        Literal["png", "jpeg", "jpg"], Query(alias="format")
    ] = "png",
    jpeg_quality: Annotated[int, Query(ge=10, le=95)] = 80,
) -> StreamingResponse:
    try:
        loop = asyncio.get_running_loop()
        task = partial(
            DatabaseManagerCrud.get_cell_overlay_zip,
            dbname,
            draw_scale_bar=draw_scale_bar,
            overlay_mode=overlay_mode,
            scale=scale,
            fluo1_color=fluo1_color,
            fluo2_color=fluo2_color,
            image_format=image_format,
            jpeg_quality=jpeg_quality,
        )
        zip_bytes = await loop.run_in_executor(annotation_executor, task)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return StreamingResponse(io.BytesIO(zip_bytes), media_type="application/zip")


@router_database_manager.patch("/update-cell-label")
def update_cell_label_endpoint(
    dbname: Annotated[str, Query()] = ...,
    cell_id: Annotated[str, Query()] = ...,
    label: Annotated[str, Query()] = ...,
) -> dict:
    try:
        updated = DatabaseManagerCrud.update_cell_label(dbname, cell_id, label)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except LookupError:
        raise HTTPException(status_code=404, detail="Cell label not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return {"cell_id": cell_id, "label": updated}


@router_database_manager.patch("/elastic-contour")
def elastic_contour_endpoint(
    dbname: Annotated[str, Query()] = ...,
    cell_id: Annotated[str, Query()] = ...,
    delta: Annotated[int, Query()] = 0,
) -> dict:
    try:
        contour = DatabaseManagerCrud.apply_elastic_contour(dbname, cell_id, delta)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except LookupError:
        raise HTTPException(status_code=404, detail="Cell contour not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return {"cell_id": cell_id, "contour": contour}


@router_database_manager.patch("/elastic-contour-bulk")
def elastic_contour_bulk_endpoint(
    dbname: Annotated[str, Query()] = ...,
    delta: Annotated[int, Query()] = 0,
    label: Annotated[str | None, Query()] = None,
) -> dict:
    try:
        return DatabaseManagerCrud.apply_elastic_contour_bulk(dbname, delta, label)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router_database_manager.get("/get-cell-replot")
def get_cell_replot_endpoint(
    dbname: Annotated[str, Query()] = ...,
    cell_id: Annotated[str, Query()] = ...,
    image_type: Annotated[str, Query(description="ph | fluo1 | fluo2 | overlay")] = "fluo1",
    degree: Annotated[int, Query(ge=1)] = 4,
    dark_mode: Annotated[bool, Query()] = False,
) -> StreamingResponse:
    try:
        image_bytes = DatabaseManagerCrud.get_cell_replot(
            dbname,
            cell_id,
            image_type=image_type,
            degree=degree,
            dark_mode=dark_mode,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except LookupError:
        raise HTTPException(status_code=404, detail="Cell image not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return StreamingResponse(io.BytesIO(image_bytes), media_type="image/png")


@router_database_manager.get("/get-cell-heatmap")
async def get_cell_heatmap_endpoint(
    dbname: Annotated[str, Query()] = ...,
    cell_id: Annotated[str, Query()] = ...,
    image_type: Annotated[str, Query(description="fluo1 | fluo2")] = "fluo1",
    degree: Annotated[int, Query(ge=1)] = 4,
) -> StreamingResponse:
    try:
        loop = asyncio.get_running_loop()
        image_bytes = await loop.run_in_executor(
            heatmap_executor,
            DatabaseManagerCrud.get_cell_heatmap,
            dbname,
            cell_id,
            image_type,
            degree,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except LookupError:
        raise HTTPException(status_code=404, detail="Cell image not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return StreamingResponse(io.BytesIO(image_bytes), media_type="image/png")


@router_database_manager.get("/get-cell-distribution")
def get_cell_distribution_endpoint(
    dbname: Annotated[str, Query()] = ...,
    cell_id: Annotated[str, Query()] = ...,
    image_type: Annotated[str, Query(description="ph | fluo1 | fluo2")] = "fluo1",
) -> StreamingResponse:
    try:
        image_bytes = DatabaseManagerCrud.get_cell_intensity_distribution(
            dbname, cell_id, image_type
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except LookupError:
        raise HTTPException(status_code=404, detail="Cell image not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return StreamingResponse(io.BytesIO(image_bytes), media_type="image/png")


@router_database_manager.get("/get-cell-map256")
async def get_cell_map256_endpoint(
    dbname: Annotated[str, Query()] = ...,
    cell_id: Annotated[str, Query()] = ...,
    image_type: Annotated[str, Query(description="fluo1 | fluo2 | overlay")] = "fluo1",
    degree: Annotated[int, Query(ge=1)] = 4,
    map_mode: Annotated[Literal["map256", "raw"], Query(description="map256 | raw")] = "map256",
) -> StreamingResponse:
    try:
        loop = asyncio.get_running_loop()
        image_bytes = await loop.run_in_executor(
            heatmap_executor,
            DatabaseManagerCrud.get_cell_map256,
            dbname,
            cell_id,
            image_type,
            degree,
            map_mode,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except LookupError:
        raise HTTPException(status_code=404, detail="Cell image not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return StreamingResponse(io.BytesIO(image_bytes), media_type="image/png")


@router_database_manager.get("/get-cell-map256-jet")
async def get_cell_map256_jet_endpoint(
    dbname: Annotated[str, Query()] = ...,
    cell_id: Annotated[str, Query()] = ...,
    image_type: Annotated[str, Query(description="fluo1 | fluo2 | overlay")] = "fluo1",
    degree: Annotated[int, Query(ge=1)] = 4,
    map_mode: Annotated[Literal["map256", "raw"], Query(description="map256 | raw")] = "map256",
) -> StreamingResponse:
    try:
        loop = asyncio.get_running_loop()
        image_bytes = await loop.run_in_executor(
            heatmap_executor,
            DatabaseManagerCrud.get_cell_map256_jet,
            dbname,
            cell_id,
            image_type,
            degree,
            map_mode,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except LookupError:
        raise HTTPException(status_code=404, detail="Cell image not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return StreamingResponse(io.BytesIO(image_bytes), media_type="image/png")


@router_database_manager.get("/get-annotation-zip")
async def get_annotation_zip_endpoint(
    dbname: Annotated[str, Query()] = ...,
    image_type: Annotated[str, Query(description="ph | fluo1 | fluo2")] = "ph",
    raw: Annotated[bool, Query()] = False,
    downscale: Annotated[float | None, Query(ge=0.05, le=1.0)] = None,
) -> StreamingResponse:
    try:
        loop = asyncio.get_running_loop()
        zip_bytes = await loop.run_in_executor(
            annotation_executor,
            DatabaseManagerCrud.get_annotation_zip,
            dbname,
            image_type,
            raw,
            downscale,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Database not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return StreamingResponse(io.BytesIO(zip_bytes), media_type="application/zip")
