import asyncio
import json
import logging
import os
import threading
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import aiohttp

logger: logging.Logger = logging.getLogger(__name__)
_ENV_LOADED: bool = False
SlackMessage = str | dict[str, Any]


def _load_env() -> None:
    global _ENV_LOADED
    if _ENV_LOADED:
        return
    _ENV_LOADED = True
    env_path = Path(__file__).resolve().parents[2] / ".env"
    if not env_path.is_file():
        return
    try:
        lines = env_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("export "):
            stripped = stripped[len("export ") :].strip()
        if "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        if not key:
            continue
        value = value.strip().strip('"').strip("'")
        if key not in os.environ:
            os.environ[key] = value


def _get_webhook_url() -> str | None:
    _load_env()
    return (
        os.getenv("SLACK_WEHBOOK_URL")
        or os.getenv("SLACK_WEBHOOK_URL")
        or os.getenv("slack_webhook_url")
    )


def _get_base_path() -> str | None:
    _load_env()
    return (
        os.getenv("BASE_PATH")
        or os.getenv("SERVER_ORIGIN")
        or os.getenv("server_origin")
    )


def _get_landing_page_origin() -> str:
    _load_env()
    return (
        os.getenv("LANDING_PAGE_ORIGIN")
        or os.getenv("LP_ORIGIN")
        or "https://lp.phenopixel.online"
    )


def _normalize_payload(message: SlackMessage) -> dict[str, Any]:
    if isinstance(message, str):
        return {"text": message}
    payload = dict(message)
    if "text" not in payload:
        payload["text"] = ""
    return payload


def _button_element(label: str, url: str) -> dict[str, Any]:
    return {
        "type": "button",
        "text": {"type": "plain_text", "text": label},
        "url": url,
    }


def _build_message_with_buttons(
    display_lines: list[str],
    buttons: list[dict[str, Any]],
) -> SlackMessage:
    message_text = "\n".join(display_lines)
    if not buttons:
        return message_text
    blocks: list[dict[str, Any]] = [
        {"type": "section", "text": {"type": "mrkdwn", "text": message_text}},
        {"type": "actions", "elements": buttons},
    ]
    return {"text": message_text, "blocks": blocks}


async def _post_slack(
    webhook_url: str,
    payload: bytes,
    success_log: tuple[str, tuple[object, ...]],
) -> None:
    timeout = aiohttp.ClientTimeout(total=10)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                webhook_url,
                data=payload,
                headers={"Content-Type": "application/json"},
            ) as response:
                body = await response.text(errors="ignore")
                if response.status >= 400:
                    logger.warning(
                        "Slack notification failed %s: %s",
                        response.status,
                        body.strip() or response.reason,
                    )
                    return
        logger.info(success_log[0], *success_log[1])
    except asyncio.TimeoutError:
        logger.warning("Slack notification failed: timeout")
    except aiohttp.ClientError as exc:
        logger.warning("Slack notification failed: %s", exc)
    except Exception as exc:
        logger.warning("Slack notification failed: %s", exc)


async def notify_slack(
    message: SlackMessage,
    *,
    success_log: tuple[str, tuple[object, ...]] | None = None,
) -> None:
    webhook_url = _get_webhook_url()
    if not webhook_url:
        return

    payload = json.dumps(_normalize_payload(message)).encode("utf-8")
    if success_log is None:
        success_log = ("Slack notified", ())
    await _post_slack(webhook_url, payload, success_log)


def notify_slack_sync(
    message: SlackMessage,
    *,
    success_log: tuple[str, tuple[object, ...]] | None = None,
) -> None:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        def _runner() -> None:
            asyncio.run(notify_slack(message, success_log=success_log))

        thread = threading.Thread(target=_runner, name="slack-webhook", daemon=True)
        thread.start()
        return
    loop.create_task(notify_slack(message, success_log=success_log))


def build_database_created_message(
    db_name: str,
    *,
    message: str | None = None,
    contour_count: int | None = None,
    param1: int | None = None,
    image_size: int | None = None,
    base_path: str | None = None,
) -> SlackMessage:
    if base_path is None:
        base_path = _get_base_path()
    db_url = None
    landing_page_origin = _get_landing_page_origin().rstrip("/")
    cells_url = f"{landing_page_origin}?{urlencode({'db': db_name})}"
    if base_path:
        base_path = base_path.rstrip("/")
        db_url = f"{base_path}/databases/?{urlencode({'db_name': db_name})}"

    base_text = (
        message
        or f"nd2extract\u304c\u5b8c\u4e86\u3057\u307e\u3057\u305f\u3002"
        f"database `{db_name}` \u3092\u4f5c\u6210\u3057\u307e\u3057\u305f\u3002"
    )
    display_lines = [base_text]
    if contour_count is not None:
        line = f"{contour_count}\u500b\u306e\u8f2a\u90ed\u3092\u53d6\u5f97\u3057\u307e\u3057\u305f\u3002"
        display_lines.append(line)
    param_parts = []
    if param1 is not None:
        param_parts.append(f"param1 = {param1}")
    if image_size is not None:
        param_parts.append(f"image_size = {image_size} x {image_size} px^2")
    if param_parts:
        line = ", ".join(param_parts)
        display_lines.append(line)
    buttons: list[dict[str, Any]] = []
    if cells_url:
        buttons.append(_button_element("Open Cells", cells_url))
    if db_url and cells_url is None:
        buttons.append(_button_element("Open Databases", db_url))
    return _build_message_with_buttons(display_lines, buttons)


def build_bulk_engine_completed_message(
    db_name: str,
    *,
    task_text: str,
    label: str | None = None,
    channel: str | None = None,
    degree: int | None = None,
    center_ratio: float | None = None,
    max_to_min_ratio: float | None = None,
    base_path: str | None = None,
) -> SlackMessage:
    if base_path is None:
        base_path = _get_base_path()
    bulk_url = None
    if base_path:
        base_path = base_path.rstrip("/")
        bulk_url = f"{base_path}/bulk-engine?{urlencode({'dbname': db_name})}"

    task_text = task_text.strip() if task_text else "bulkengine task"
    display_lines = [f"bulkengine\u306e{task_text}\u304c\u5b8c\u4e86\u3057\u307e\u3057\u305f\u3002database `{db_name}`"]
    details: list[str] = []
    label_text = str(label).strip() if label is not None else ""
    if label_text:
        details.append(f"label = {label_text}")
    if channel:
        details.append(f"channel = {channel}")
    if degree is not None:
        details.append(f"degree = {degree}")
    if center_ratio is not None:
        details.append(f"center_ratio = {center_ratio}")
    if max_to_min_ratio is not None:
        details.append(f"max_to_min_ratio = {max_to_min_ratio}")
    if details:
        display_lines.extend(details)
    buttons: list[dict[str, Any]] = []
    if bulk_url:
        buttons.append(_button_element("Open Bulk Engine", bulk_url))
    return _build_message_with_buttons(display_lines, buttons)
