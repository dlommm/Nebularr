"""Normalize MAL / Jikan title payloads: English-primary display + alternate strings for matching."""

from __future__ import annotations

import json
from typing import Any


def titles_from_mal_api_response(mal_response: dict[str, Any]) -> tuple[str | None, list[str]]:
    """Return (primary English-forward title, other known titles).

    MAL's top-level ``title`` is often Japanese or romaji; ``alternative_titles.en`` is preferred when set.
    """
    if not mal_response:
        return None, []
    base = str(mal_response.get("title") or "").strip() or None
    en: str | None = None
    ja: str | None = None
    synonyms: list[str] = []
    alt = mal_response.get("alternative_titles")
    if isinstance(alt, dict):
        en = str(alt.get("en") or "").strip() or None
        ja = str(alt.get("ja") or "").strip() or None
        syn_raw = alt.get("synonyms")
        if isinstance(syn_raw, list):
            synonyms = [str(s).strip() for s in syn_raw if str(s).strip()]
    primary = en or base
    additional: list[str] = []
    primary_l = primary.lower() if primary else ""

    def push(s: str | None) -> None:
        if not s:
            return
        sl = s.lower()
        if primary and sl == primary_l:
            return
        if any(sl == x.lower() for x in additional):
            return
        additional.append(s)

    push(base)
    push(ja)
    for s in synonyms:
        push(s)
    return primary, additional


def titles_from_jikan_anime_data(data: dict[str, Any]) -> list[str]:
    """Collect human-readable titles from Jikan v4 anime ``data`` (full resource)."""
    out: list[str] = []
    for key in ("title_english", "title_japanese", "title"):
        v = str(data.get(key) or "").strip()
        if v:
            out.append(v)
    titles = data.get("titles")
    if isinstance(titles, list):
        for item in titles:
            if isinstance(item, dict):
                t = str(item.get("title") or "").strip()
                if t:
                    out.append(t)
    return _unique_preserve_order(out)


def merge_additional_title_lists(primary: str | None, existing: Any, incoming: list[str]) -> list[str]:
    """Merge JSON/list ``existing`` with new strings; never duplicates ``primary`` (case-insensitive)."""
    merged: list[str] = []
    seen: set[str] = set()
    pl = primary.lower() if primary else ""

    def push(s: str | None) -> None:
        if not s:
            return
        sl = s.lower()
        if pl and sl == pl:
            return
        if sl in seen:
            return
        seen.add(sl)
        merged.append(s)

    if isinstance(existing, str):
        try:
            existing = json.loads(existing)
        except json.JSONDecodeError:
            existing = []
    if isinstance(existing, list):
        for x in existing:
            push(str(x).strip() if x is not None else None)
    for s in incoming:
        push(str(s).strip() if s is not None else None)
    return merged


def _unique_preserve_order(strings: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for s in strings:
        sl = s.lower()
        if sl in seen:
            continue
        seen.add(sl)
        out.append(s)
    return out
