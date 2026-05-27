import asyncio
import logging
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException

router_system: APIRouter = APIRouter(tags=["system"])
logger: logging.Logger = logging.getLogger("uvicorn.error")
REPO_ROOT: Path = Path(__file__).resolve().parents[2].parent


@router_system.post("/system/git-pull")
async def git_pull() -> dict[str, str]:
    if not (REPO_ROOT / ".git").exists():
        raise HTTPException(status_code=500, detail="Repository root not found")

    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    process = await asyncio.create_subprocess_exec(
        "git",
        "pull",
        "--ff-only",
        cwd=REPO_ROOT,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout_bytes, stderr_bytes = await process.communicate()
    stdout = stdout_bytes.decode().strip() if stdout_bytes else ""
    stderr = stderr_bytes.decode().strip() if stderr_bytes else ""
    if stdout:
        logger.info("git pull stdout:\n%s", stdout)
    if stderr:
        logger.warning("git pull stderr:\n%s", stderr)
    if process.returncode != 0:
        raise HTTPException(status_code=500, detail=stderr or stdout or "git pull failed")
    return {"status": "ok", "output": stdout}
