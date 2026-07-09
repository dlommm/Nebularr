from __future__ import annotations

import pytest

from arrsync.mal.dub_sources import (
    SOURCE_MAL_DUBS,
    SOURCE_MYDUBLIST,
    DubSourceSpec,
    enabled_dub_sources,
    normalize_mydublist_tier,
    parse_dub_source_payload,
)
from fakes import FakeSettings

MAL_DUBS_SPEC = DubSourceSpec(
    name=SOURCE_MAL_DUBS, url="http://example/dubInfo.json", dubbed_key="dubbed", partial_key="incomplete"
)
MYDUBLIST_SPEC = DubSourceSpec(
    name=SOURCE_MYDUBLIST, url="http://example/dubbed_english.json", dubbed_key="dubbed", partial_key="partial"
)


def test_parse_mal_dubs_shape_with_incomplete() -> None:
    dubbed, partial = parse_dub_source_payload(
        MAL_DUBS_SPEC, {"dubbed": [5, 1, 5], "incomplete": [9, 3]}
    )
    assert dubbed == [1, 5]
    assert partial == [3, 9]


def test_parse_mydublist_shape_with_partial() -> None:
    dubbed, partial = parse_dub_source_payload(
        MYDUBLIST_SPEC, {"dubbed": [7], "partial": [2], "_license": "CC BY 4.0"}
    )
    assert dubbed == [7]
    assert partial == [2]


def test_parse_missing_partial_array_is_empty() -> None:
    dubbed, partial = parse_dub_source_payload(MAL_DUBS_SPEC, {"dubbed": [4]})
    assert dubbed == [4]
    assert partial == []


def test_parse_missing_dubbed_array_raises() -> None:
    with pytest.raises(ValueError, match="missing dubbed array"):
        parse_dub_source_payload(MAL_DUBS_SPEC, {"incomplete": [1]})


def test_parse_non_object_payload_raises() -> None:
    with pytest.raises(ValueError, match="not an object"):
        parse_dub_source_payload(MAL_DUBS_SPEC, [1, 2, 3])


def test_parse_id_in_both_arrays_counts_as_dubbed() -> None:
    dubbed, partial = parse_dub_source_payload(
        MAL_DUBS_SPEC, {"dubbed": [1, 2], "incomplete": [2, 3]}
    )
    assert dubbed == [1, 2]
    assert partial == [3]


def test_normalize_mydublist_tier() -> None:
    assert normalize_mydublist_tier("Very-High") == "very-high"
    assert normalize_mydublist_tier("bogus") == "normal"
    assert normalize_mydublist_tier(None) == "normal"


def test_enabled_dub_sources_builds_both_specs() -> None:
    settings = FakeSettings(mal_dub_info_url="http://example/dubInfo.json")
    flags = {"source_mal_dubs_enabled": True, "source_mydublist_enabled": True}
    specs = enabled_dub_sources(settings, flags, "high")
    assert [s.name for s in specs] == [SOURCE_MAL_DUBS, SOURCE_MYDUBLIST]
    assert specs[0].partial_key == "incomplete"
    assert specs[1].partial_key == "partial"
    assert "/confidence/high/" in specs[1].url


def test_enabled_dub_sources_respects_flags() -> None:
    settings = FakeSettings()
    specs = enabled_dub_sources(
        settings, {"source_mal_dubs_enabled": False, "source_mydublist_enabled": True}, "normal"
    )
    assert [s.name for s in specs] == [SOURCE_MYDUBLIST]
    specs = enabled_dub_sources(
        settings, {"source_mal_dubs_enabled": False, "source_mydublist_enabled": False}, "normal"
    )
    assert specs == []


def test_enabled_dub_sources_invalid_tier_falls_back_to_normal() -> None:
    settings = FakeSettings()
    specs = enabled_dub_sources(
        settings, {"source_mal_dubs_enabled": False, "source_mydublist_enabled": True}, "../evil"
    )
    assert "/confidence/normal/" in specs[0].url
