from __future__ import annotations

import re
from typing import Any
from urllib.parse import unquote, urlparse

_SITE_ALIASES = (
    ("imdb", re.compile(r"imdb\.com/title/(tt\d+)", re.I)),
    ("imdb", re.compile(r"imdb\.com/.*/(tt\d+)", re.I)),
    ("tmdb", re.compile(r"themoviedb\.org/(?:movie|tv)/(\d+)", re.I)),
    ("tvdb", re.compile(r"thetvdb\.com/(?:dereferrer|/?)series/(\d+)", re.I)),
    ("tvdb", re.compile(r"thetvdb\.com/.*[?&]id=(\d+)", re.I)),
)


def extract_ids_from_url(url: str) -> list[tuple[str, str]]:
    if not url:
        return []
    parsed = urlparse(url)
    path = unquote(parsed.path or "")
    full = f"{parsed.netloc}{path}"
    out: list[tuple[str, str]] = []
    for site, rx in _SITE_ALIASES:
        m = rx.search(full) or rx.search(url)
        if m:
            val = m.group(1).strip()
            if site == "imdb" and not val.startswith("tt"):
                val = f"tt{val}"
            out.append((site, val))
    return out


def externals_from_jikan_data(data: dict[str, Any]) -> list[tuple[str, str]]:
    """Parse Jikan v4 anime `data` (full resource) for tvdb/tmdb/imdb."""
    found: list[tuple[str, str]] = []
    externals = data.get("external") or data.get("externals") or []
    if not isinstance(externals, list):
        return found
    for item in externals:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "")).lower()
        url = str(item.get("url", ""))
        pairs = extract_ids_from_url(url)
        if pairs:
            found.extend(pairs)
            continue
        if "imdb" in name and url:
            pairs = extract_ids_from_url(url)
            found.extend(pairs)
    # de-dupe by site keeping first
    seen: set[str] = set()
    uniq: list[tuple[str, str]] = []
    for site, eid in found:
        key = f"{site}:{eid}"
        if key in seen:
            continue
        seen.add(key)
        uniq.append((site, eid))
    return uniq
