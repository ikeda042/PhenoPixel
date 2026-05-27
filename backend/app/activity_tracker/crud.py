from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, insert, select

from app.activity_tracker.async_databases import activity_log, get_db

ACTION_TOP_PAGE: str = "top_page"
ACTION_CELL_EXTRACTION: str = "cell_extraction"
ACTION_BULK_ENGINE: str = "bulk_engine"

ALLOWED_ACTIONS: set[str] = {
    ACTION_TOP_PAGE,
    ACTION_CELL_EXTRACTION,
    ACTION_BULK_ENGINE,
}

_MAX_ACTION_LENGTH: int = 64


def _normalize_action_name(action_name: str) -> str:
    cleaned = (action_name or "").strip()
    if not cleaned:
        raise ValueError("Action name is required")
    if len(cleaned) > _MAX_ACTION_LENGTH:
        raise ValueError("Action name is too long")
    return cleaned


def _format_timestamp(timestamp: datetime) -> str:
    return timestamp.strftime("%Y-%m-%d %H:%M:%S")


async def record_activity(action_name: str, created_at: datetime | None = None) -> None:
    normalized = _normalize_action_name(action_name)
    if normalized == ACTION_TOP_PAGE:
        return
    timestamp = created_at or datetime.utcnow()
    async with get_db() as db:
        stmt = insert(activity_log).values(
            created_at=_format_timestamp(timestamp),
            action_name=normalized,
        )
        await db.execute(stmt)
        await db.commit()


def record_activity_sync(action_name: str, created_at: datetime | None = None) -> None:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        asyncio.run(record_activity(action_name, created_at=created_at))
        return
    loop.create_task(record_activity(action_name, created_at=created_at))


async def get_daily_activity_summary(
    days: int = 7,
    action_name: str | None = None,
) -> dict[str, Any]:
    if days < 1:
        raise ValueError("Days must be at least 1")
    end_date = datetime.utcnow().date()
    start_date = end_date - timedelta(days=days - 1)

    async with get_db() as db:
        day_expr = func.date(activity_log.c.created_at).label("day")
        stmt = (
            select(day_expr, func.count().label("count"))
            .where(
                func.date(activity_log.c.created_at).between(
                    start_date.isoformat(), end_date.isoformat()
                )
            )
            .group_by(day_expr)
            .order_by(day_expr)
        )
        if action_name:
            normalized = _normalize_action_name(action_name)
            stmt = stmt.where(activity_log.c.action_name == normalized)
        else:
            stmt = stmt.where(activity_log.c.action_name != ACTION_TOP_PAGE)
        result = await db.execute(stmt)
        rows = result.mappings().all()

    counts_by_day = {row["day"]: row["count"] for row in rows}
    points: list[dict[str, Any]] = []
    total = 0
    for index in range(days):
        day = start_date + timedelta(days=index)
        day_str = day.isoformat()
        count = int(counts_by_day.get(day_str, 0))
        total += count
        points.append({"date": day_str, "count": count})

    return {
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
        "points": points,
        "total": total,
    }
