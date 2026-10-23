"""Artwork preferences, stored in app.settings as one JSON document.

``mode`` decides whether posters/fanart fetched from Sonarr/Radarr are kept on the
runtime volume ("cache", the default and the fast path) or streamed through on
every request ("live", for operators who cannot spare the disk). ``cache_max_mb``
caps the cache; 0 means no cap.
"""

from __future__ import annotations

import json
from typing import Literal, TypedDict, cast

from sqlalchemy import text
from sqlalchemy.orm import Session

ARTWORK_SETTINGS_KEY = "app.artwork_json"

ArtworkMode = Literal["cache", "live"]
ARTWORK_MODES: frozenset[str] = frozenset({"cache", "live"})
MAX_CACHE_MB = 1_048_576  # 1 TiB; anything larger is a typo


class ArtworkSettings(TypedDict):
    enabled: bool
    mode: ArtworkMode
    remote_fallback: bool
    cache_max_mb: int


DEFAULT_ARTWORK_SETTINGS: ArtworkSettings = {
    "enabled": True,
    "mode": "cache",
    # Off by default: falling back to TheTVDB/TMDB makes requests leave the LAN.
    "remote_fallback": False,
    "cache_max_mb": 0,
}


def _stored(session: Session) -> dict[str, object]:
    raw = session.execute(
        text("select value from app.settings where key = :key"),
        {"key": ARTWORK_SETTINGS_KEY},
    ).scalar_one_or_none()
    if not raw:
        return {}
    try:
        parsed = json.loads(str(raw))
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def normalize_artwork_settings(values: dict[str, object]) -> ArtworkSettings:
    """Coerce a stored or submitted document onto the defaults, dropping bad values."""
    result: ArtworkSettings = dict(DEFAULT_ARTWORK_SETTINGS)  # type: ignore[assignment]
    for key in ("enabled", "remote_fallback"):
        value = values.get(key)
        if isinstance(value, bool):
            result[key] = value  # type: ignore[literal-required]
    mode = values.get("mode")
    if isinstance(mode, str) and mode in ARTWORK_MODES:
        result["mode"] = cast(ArtworkMode, mode)
    cap = values.get("cache_max_mb")
    if isinstance(cap, int) and not isinstance(cap, bool):
        result["cache_max_mb"] = max(0, min(cap, MAX_CACHE_MB))
    return result


def read_artwork_settings(session: Session) -> ArtworkSettings:
    return normalize_artwork_settings(_stored(session))


def write_artwork_settings(session: Session, updates: dict[str, object]) -> ArtworkSettings:
    merged = normalize_artwork_settings({**read_artwork_settings(session), **updates})
    session.execute(
        text(
            """
            insert into app.settings(key, value, updated_at)
            values(:key, :value, now())
            on conflict (key) do update
            set value = excluded.value,
                updated_at = now()
            """
        ),
        {"key": ARTWORK_SETTINGS_KEY, "value": json.dumps(merged, sort_keys=True)},
    )
    return merged
