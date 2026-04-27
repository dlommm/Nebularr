from arrsync.mal.externals import externals_from_jikan_data, extract_ids_from_url


def test_extract_ids_from_url_supports_core_sites() -> None:
    assert ("imdb", "tt1234567") in extract_ids_from_url("https://www.imdb.com/title/tt1234567/")
    assert ("tmdb", "9999") in extract_ids_from_url("https://www.themoviedb.org/tv/9999-name")
    assert ("tvdb", "121212") in extract_ids_from_url("https://thetvdb.com/series/example?id=121212")


def test_externals_from_jikan_data_scans_nested_urls() -> None:
    payload = {
        "external": [
            {"name": "Official Site", "url": "https://example.org/show"},
        ],
        "streaming": [
            {"name": "Alt", "url": "https://www.imdb.com/title/tt7654321/"},
        ],
        "relations": [
            {
                "relation": "Adaptation",
                "entry": [
                    {"type": "anime", "url": "https://www.themoviedb.org/tv/112233-title"},
                ],
            }
        ],
    }
    pairs = externals_from_jikan_data(payload)
    assert ("imdb", "tt7654321") in pairs
    assert ("tmdb", "112233") in pairs
