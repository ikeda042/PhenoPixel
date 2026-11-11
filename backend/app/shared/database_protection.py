from pathlib import Path


PROTECTED_DATABASE_NAMES = frozenset({"test_database.db"})


def ensure_database_file_unprotected(path: Path) -> None:
    # Check the resolved name too so an upload through a symlink cannot truncate it.
    if any(
        name.casefold() in PROTECTED_DATABASE_NAMES
        for name in (path.name, path.resolve().name)
    ):
        raise PermissionError(
            "test_database.db is a bundled database and cannot be deleted, renamed, or overwritten"
        )
