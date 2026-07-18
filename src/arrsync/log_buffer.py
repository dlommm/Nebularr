"""In-memory ring buffer of recent JSON log lines for the Web UI."""

from __future__ import annotations

import json
import logging
import threading
from collections import deque
from typing import Any

RING_MAX_LINES = 2500

# A record logged with ``extra={RING_EXCLUDE_ATTR: True}`` is still written to
# stdout by the normal StreamHandler, but is deliberately dropped from this
# Web-UI ring buffer. GET /api/ui/logs serves the buffer unauthenticated exactly
# while the setup bootstrap-token gate is active, so the one-time token line must
# never land here even though it stays visible in container stdout.
RING_EXCLUDE_ATTR = "ring_exclude"

_lines: deque[str] = deque(maxlen=RING_MAX_LINES)
_lock = threading.Lock()
_attached_handler: logging.Handler | None = None
_ring_target: logging.Logger | None = None


class _RingExcludeFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return not getattr(record, RING_EXCLUDE_ATTR, False)


class RingBufferHandler(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.addFilter(_RingExcludeFilter())

    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = self.format(record)
            with _lock:
                _lines.append(msg)
        except Exception:
            self.handleError(record)


def clear_ring_buffer() -> None:
    with _lock:
        _lines.clear()


def attach_ring_buffer_handler(formatter: logging.Formatter, level: int, target: logging.Logger) -> None:
    """Register (or replace) the ring-buffer handler on *target* (use the **root** logger to capture
    httpx, SQLAlchemy, and other app-adjacent libraries that log outside ``arrsync.*``).
    """
    global _attached_handler, _ring_target
    with _lock:
        if _attached_handler is not None and _ring_target is not None:
            try:
                _ring_target.removeHandler(_attached_handler)
            except ValueError:
                pass
        handler = RingBufferHandler()
        handler.setFormatter(formatter)
        handler.setLevel(level)
        target.addHandler(handler)
        _attached_handler = handler
        _ring_target = target


def get_recent_log_lines(limit: int) -> list[str]:
    limit = max(1, min(int(limit), RING_MAX_LINES))
    with _lock:
        snap = list(_lines)
    return snap[-limit:]


def get_recent_logs_parsed(limit: int) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for line in get_recent_log_lines(limit):
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            out.append({"ts": None, "level": "UNKNOWN", "logger": "", "message": line, "parse_error": True})
    return out


def ring_buffer_capacity() -> int:
    return RING_MAX_LINES
