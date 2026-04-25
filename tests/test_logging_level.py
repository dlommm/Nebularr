import pytest

from arrsync.logging import ALLOWED_LOG_LEVELS, apply_root_log_level, configure_logging, normalize_log_level


def test_normalize_log_level_accepts_aliases() -> None:
    assert normalize_log_level("debug") == "DEBUG"
    assert normalize_log_level("INFO") == "INFO"


def test_normalize_log_level_rejects_unknown() -> None:
    with pytest.raises(ValueError, match="invalid log level"):
        normalize_log_level("verbose")


def test_allowed_levels_include_critical() -> None:
    assert "CRITICAL" in ALLOWED_LOG_LEVELS


def test_apply_root_log_level_returns_normalized() -> None:
    configure_logging("INFO")
    assert apply_root_log_level("warning") == "WARNING"
