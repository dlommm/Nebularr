from arrsync.mal.titles import (
    merge_additional_title_lists,
    titles_from_jikan_anime_data,
    titles_from_mal_api_response,
)


def test_mal_api_prefers_english_alternative_title() -> None:
    primary, additional = titles_from_mal_api_response(
        {
            "title": "Cowboy Bebop",
            "alternative_titles": {
                "en": "Cowboy Bebop",
                "ja": "カウボーイビバップ",
                "synonyms": ["See You Space Cowboy"],
            },
        }
    )
    assert primary == "Cowboy Bebop"
    assert "カウボーイビバップ" in additional
    assert "See You Space Cowboy" in additional


def test_mal_api_english_primary_japanese_and_synonyms_in_additional() -> None:
    primary, additional = titles_from_mal_api_response(
        {
            "title": "Shingeki no Kyojin",
            "alternative_titles": {
                "en": "Attack on Titan",
                "ja": "進撃の巨人",
                "synonyms": ["AoT"],
            },
        }
    )
    assert primary == "Attack on Titan"
    assert "Shingeki no Kyojin" in additional
    assert "進撃の巨人" in additional
    assert "AoT" in additional


def test_jikan_titles_collects_variants() -> None:
    titles = titles_from_jikan_anime_data(
        {
            "title": "Default",
            "title_english": "English Title",
            "title_japanese": "日本語",
            "titles": [{"type": "Default", "title": "Default"}, {"type": "English", "title": "English Title"}],
        }
    )
    assert "English Title" in titles
    assert "日本語" in titles
    assert "Default" in titles


def test_merge_respects_primary() -> None:
    merged = merge_additional_title_lists("English", ["Romaji", "English"], ["日本語", "Romaji"])
    assert "Romaji" in merged
    assert "日本語" in merged
    assert len(merged) == 2
