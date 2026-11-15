"""Bound the total number of CPU-heavy analysis workers per server process."""

import os
from concurrent.futures import ProcessPoolExecutor
from multiprocessing import get_context


def _worker_count() -> int:
    available = getattr(os, "process_cpu_count", os.cpu_count)() or 1
    default = min(4, available)
    try:
        configured = int(os.environ.get("PHENOPIXEL_ANALYSIS_WORKERS", default))
    except ValueError:
        return default
    return max(1, min(configured, 32))


ANALYSIS_WORKERS = _worker_count()

# Spawn avoids inheriting application threads and Matplotlib state on POSIX.
analysis_executor = ProcessPoolExecutor(
    max_workers=ANALYSIS_WORKERS, mp_context=get_context("spawn")
)
