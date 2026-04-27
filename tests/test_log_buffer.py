import logging

from arrsync import log_buffer as log_buffer_mod
from arrsync.log_buffer import RING_MAX_LINES, attach_ring_buffer_handler, get_recent_logs_parsed, ring_buffer_capacity
from arrsync.logging import JsonFormatter, configure_logging


def test_ring_buffer_capacity_matches_max() -> None:
    assert ring_buffer_capacity() == RING_MAX_LINES


def test_get_recent_logs_parsed_round_trip() -> None:
    configure_logging("INFO")
    log = logging.getLogger("arrsync.test.ring")
    log.info("hello", extra={"request_id": "abc"})
    parsed = get_recent_logs_parsed(10)
    assert parsed
    last = parsed[-1]
    assert last.get("message") == "hello"
    assert last.get("logger") == "arrsync.test.ring"
    assert last.get("request_id") == "abc"


def test_reconfigure_clears_ring_buffer() -> None:
    configure_logging("INFO")
    logging.getLogger("arrsync.t.reconf").info("first")
    assert any(x.get("message") == "first" for x in get_recent_logs_parsed(50))
    configure_logging("WARNING")
    logging.getLogger("arrsync.t.reconf").warning("second")
    msgs = [x.get("message") for x in get_recent_logs_parsed(50)]
    assert "second" in msgs
    assert "first" not in msgs


def test_attach_ring_buffer_replaces_previous_handler() -> None:
    configure_logging("DEBUG")
    root = logging.getLogger()
    n = len(root.handlers)
    attach_ring_buffer_handler(JsonFormatter(), logging.DEBUG, root)
    assert len(root.handlers) == n


def test_non_json_line_shows_parse_error() -> None:
    configure_logging("INFO")
    with log_buffer_mod._lock:
        log_buffer_mod._lines.append("not-json{")
    out = get_recent_logs_parsed(5)
    assert out[-1].get("parse_error") is True
