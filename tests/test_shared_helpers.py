"""Unit coverage for arrsync.routers.shared helpers shared across routers."""

from __future__ import annotations

from arrsync.routers.shared import clamp_limit


def test_clamp_limit_default_behavior_unchanged() -> None:
    assert clamp_limit(0) == 200
    assert clamp_limit(-5) == 200
    assert clamp_limit(50) == 50
    assert clamp_limit(5000) == 2000


def test_clamp_limit_max_limit_keyword_still_works() -> None:
    # Existing call sites across the codebase (reporting.py, sync_ops.py, library.py)
    # pass max_limit= explicitly; that must keep working exactly as before.
    assert clamp_limit(100, default=500, max_limit=5000) == 100
    assert clamp_limit(0, default=500, max_limit=5000) == 500
    assert clamp_limit(9999, default=500, max_limit=5000) == 5000


def test_clamp_limit_maximum_alias_overrides_max_limit_default() -> None:
    # maximum= is an additive alias for max_limit=, used where default == ceiling
    # (a single-value clamp, e.g. CSV export row caps).
    assert clamp_limit(5000, default=100_000, maximum=100_000) == 5000
    assert clamp_limit(0, default=100_000, maximum=100_000) == 100_000
    assert clamp_limit(-1, default=100_000, maximum=100_000) == 100_000
    assert clamp_limit(999_999, default=100_000, maximum=100_000) == 100_000


def test_clamp_limit_maximum_wins_over_max_limit_when_both_given() -> None:
    assert clamp_limit(9999, max_limit=2000, maximum=5000) == 5000
