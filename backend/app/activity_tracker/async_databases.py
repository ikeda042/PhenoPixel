from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from sqlalchemy import Column, Index, Integer, MetaData, String, Table
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

DB_DIR: Path = Path(__file__).resolve().parent / "data"
DB_PATH: Path = DB_DIR / "activity_tracker.db"

_INITIALIZED: bool = False
_ENGINE: AsyncEngine | None = None
_SESSION_MAKER: async_sessionmaker[AsyncSession] | None = None

_METADATA: MetaData = MetaData()

activity_log: Table = Table(
    "activity_log",
    _METADATA,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("created_at", String, nullable=False),
    Column("action_name", String, nullable=False),
    Index("idx_activity_log_created_at", "created_at"),
    Index("idx_activity_log_action_name", "action_name"),
)


def _get_engine() -> AsyncEngine:
    global _ENGINE
    if _ENGINE is None:
        _ENGINE = create_async_engine(
            f"sqlite+aiosqlite:///{DB_PATH}", future=True
        )
    return _ENGINE


async def init_db() -> None:
    global _INITIALIZED, _SESSION_MAKER
    if _INITIALIZED:
        return
    DB_DIR.mkdir(parents=True, exist_ok=True)
    engine = _get_engine()
    async with engine.begin() as conn:
        await conn.exec_driver_sql("PRAGMA journal_mode=WAL;")
        await conn.run_sync(_METADATA.create_all)
    _SESSION_MAKER = async_sessionmaker(engine, expire_on_commit=False)
    _INITIALIZED = True


@asynccontextmanager
async def get_db() -> AsyncSession:
    await init_db()
    if _SESSION_MAKER is None:
        raise RuntimeError("Database session maker is not initialized")
    db = _SESSION_MAKER()
    try:
        yield db
    finally:
        await db.close()
