import logging
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.activity_tracker.crud import (
    ALLOWED_ACTIONS,
    get_daily_activity_summary,
    record_activity,
)

router_activity_tracker: APIRouter = APIRouter(tags=["activity_tracker"])
logger: logging.Logger = logging.getLogger("uvicorn.error")


class TrackActivityRequest(BaseModel):
    action_name: str = Field(..., min_length=1, max_length=64)


class ActivityPoint(BaseModel):
    date: str
    count: int


class ActivitySummaryResponse(BaseModel):
    start_date: str
    end_date: str
    points: list[ActivityPoint]
    total: int


@router_activity_tracker.post("/activity/track")
async def track_activity(payload: TrackActivityRequest) -> dict:
    action_name = payload.action_name.strip()
    if action_name not in ALLOWED_ACTIONS:
        raise HTTPException(status_code=400, detail="Unsupported action_name")
    try:
        await record_activity(action_name)
    except Exception as exc:
        logger.error("Failed to record activity: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to record activity") from exc
    return {"ok": True, "action_name": action_name}


@router_activity_tracker.get("/activity/weekly", response_model=ActivitySummaryResponse)
async def get_weekly_activity(
    days: Annotated[int, Query(ge=1, le=31)] = 7,
    action_name: Annotated[str | None, Query()] = None,
) -> ActivitySummaryResponse:
    if action_name is not None:
        normalized = action_name.strip()
        if not normalized:
            raise HTTPException(status_code=400, detail="Invalid action_name")
        if normalized not in ALLOWED_ACTIONS:
            raise HTTPException(status_code=400, detail="Unsupported action_name")
        action_name = normalized
    try:
        summary = await get_daily_activity_summary(days=days, action_name=action_name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("Failed to load activity summary: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to load activity summary") from exc
    return ActivitySummaryResponse(**summary)
