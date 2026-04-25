import json
import logging
import sys
from datetime import datetime, timezone
from typing import Any

ALLOWED_LOG_LEVELS: tuple[str, ...] = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")

_LOG_RECORD_STANDARD_ATTRS = frozenset(logging.LogRecord("", 0, "", 0, "", (), None).__dict__.keys())


def normalize_log_level(raw: str) -> str:
    name = raw.strip().upper()
    if name not in ALLOWED_LOG_LEVELS:
        raise ValueError(f"invalid log level {raw!r}; allowed: {', '.join(ALLOWED_LOG_LEVELS)}")
    return name


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        for key, value in record.__dict__.items():
            if key in _LOG_RECORD_STANDARD_ATTRS or key.startswith("_"):
                continue
            payload[key] = value
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def apply_root_log_level(level: str) -> str:
    """Set the root logger and its handlers to *level* (validated). Returns normalized name.

    The ``arrsync`` *logger* stays at DEBUG so child loggers (``arrsync.*``) can emit. The
    configured *user* level is enforced by the root ``StreamHandler`` and the web UI
    ``RingBufferHandler`` only — otherwise setting ``arrsync`` to e.g. ERROR would block INFO
    records before they reached the in-memory buffer, and the Logs page would stay empty.
    """
    from arrsync.log_buffer import RingBufferHandler, attach_ring_buffer_handler

    normalized = normalize_log_level(level)
    numeric = getattr(logging, normalized)
    root = logging.getLogger()
    root.setLevel(numeric)
    for handler in root.handlers:
        handler.setLevel(numeric)
    # Web UI buffer listens on the ``arrsync`` logger tree so we always capture app logs regardless of
    # uvicorn's dictConfig (uvicorn loggers use propagate=False). Re-attach if something stripped it.
    arrsync_log = logging.getLogger("arrsync")
    arrsync_log.setLevel(logging.DEBUG)
    has_ring = any(isinstance(h, RingBufferHandler) for h in arrsync_log.handlers)
    if not has_ring:
        attach_ring_buffer_handler(JsonFormatter(), numeric, arrsync_log)
    else:
        for h in arrsync_log.handlers:
            if isinstance(h, RingBufferHandler):
                h.setLevel(numeric)
    return normalized


def configure_logging(level: str) -> None:
    normalized = normalize_log_level(level)
    numeric = getattr(logging, normalized)
    formatter = JsonFormatter()
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)
    handler.setLevel(numeric)
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    from arrsync.log_buffer import attach_ring_buffer_handler, clear_ring_buffer

    clear_ring_buffer()
    arrsync_log = logging.getLogger("arrsync")
    arrsync_log.setLevel(logging.DEBUG)
    attach_ring_buffer_handler(formatter, numeric, arrsync_log)
    root.setLevel(numeric)
