"""Dub-list source registry: which public English-dub lists to ingest.

Both supported sources publish MAL-id arrays with a full and a partial bucket:
MAL-Dubs `{dubbed: [], incomplete: []}` and MyDubList `{dubbed: [], partial: []}`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from arrsync.config import Settings
from arrsync.mal.constants import (
    DEFAULT_DUB_INFO_URL,
    DEFAULT_MYDUBLIST_URL_TEMPLATE,
    MYDUBLIST_CONFIDENCE_TIERS,
)

SOURCE_MAL_DUBS = "mal_dubs"
SOURCE_MYDUBLIST = "mydublist"


@dataclass(frozen=True)
class DubSourceSpec:
    name: str
    url: str
    dubbed_key: str
    partial_key: str


def normalize_mydublist_tier(tier: str | None) -> str:
    candidate = (tier or "").strip().lower()
    if candidate in MYDUBLIST_CONFIDENCE_TIERS:
        return candidate
    return "normal"


def parse_dub_source_payload(spec: DubSourceSpec, raw_json: Any) -> tuple[list[int], list[int]]:
    """Extract ``(dubbed_ids, partial_ids)``; an id in both arrays counts as dubbed."""
    if not isinstance(raw_json, dict):
        raise ValueError(f"{spec.name}: dub list payload is not an object")
    dubbed_raw = raw_json.get(spec.dubbed_key)
    if not isinstance(dubbed_raw, list):
        raise ValueError(f"{spec.name}: dub list missing {spec.dubbed_key} array")
    partial_raw = raw_json.get(spec.partial_key)
    if not isinstance(partial_raw, list):
        partial_raw = []
    dubbed = sorted({int(x) for x in dubbed_raw})
    partial = sorted({int(x) for x in partial_raw} - set(dubbed))
    return dubbed, partial


def enabled_dub_sources(settings: Settings, flags: dict[str, bool], tier: str) -> list[DubSourceSpec]:
    specs: list[DubSourceSpec] = []
    if flags.get("source_mal_dubs_enabled", True):
        specs.append(
            DubSourceSpec(
                name=SOURCE_MAL_DUBS,
                url=settings.mal_dub_info_url or DEFAULT_DUB_INFO_URL,
                dubbed_key="dubbed",
                partial_key="incomplete",
            )
        )
    if flags.get("source_mydublist_enabled", True):
        template = settings.mydublist_url_template or DEFAULT_MYDUBLIST_URL_TEMPLATE
        specs.append(
            DubSourceSpec(
                name=SOURCE_MYDUBLIST,
                url=template.format(tier=normalize_mydublist_tier(tier)),
                dubbed_key="dubbed",
                partial_key="partial",
            )
        )
    return specs
