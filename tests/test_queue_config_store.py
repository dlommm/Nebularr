"""Queue policy store: defaults, clamps, corrupt-JSON resilience."""

from __future__ import annotations

from arrsync.services.queue_config_store import (
    DEFAULT_QUEUE_POLICY,
    read_queue_policy,
    write_queue_policy,
)
from fakes import FakeSession


def test_defaults_when_unset() -> None:
    session = FakeSession()
    assert read_queue_policy(session) == DEFAULT_QUEUE_POLICY


def test_defaults_on_corrupt_json() -> None:
    session = FakeSession()
    session.settings["app.queue_policy_json"] = "{not json"
    assert read_queue_policy(session) == DEFAULT_QUEUE_POLICY


def test_write_clamps_and_round_trips() -> None:
    session = FakeSession()
    policy = write_queue_policy(
        session,
        {"batch_size": 10_000, "max_attempts": 0, "backoff_base_seconds": 60, "unknown": 1},
    )
    assert policy["batch_size"] == 500  # clamped to max
    assert policy["max_attempts"] == 1  # clamped to min
    assert policy["backoff_base_seconds"] == 60
    assert policy["backoff_cap_seconds"] == DEFAULT_QUEUE_POLICY["backoff_cap_seconds"]
    assert read_queue_policy(session) == policy


def test_cap_never_undercuts_base() -> None:
    session = FakeSession()
    policy = write_queue_policy(session, {"backoff_base_seconds": 600, "backoff_cap_seconds": 30})
    assert policy["backoff_cap_seconds"] >= policy["backoff_base_seconds"]


def test_partial_update_preserves_other_fields() -> None:
    session = FakeSession()
    write_queue_policy(session, {"batch_size": 25})
    policy = write_queue_policy(session, {"max_attempts": 3})
    assert policy["batch_size"] == 25
    assert policy["max_attempts"] == 3
