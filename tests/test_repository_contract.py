from arrsync.services.repository import _extract_media_languages


def test_extract_media_languages_from_contract_like_payload():
    payload = {
        "languages": [{"name": "English"}, {"name": "Japanese"}],
        "mediaInfo": {"audioLanguages": "eng, jpn", "subtitles": "eng,spa"},
    }
    audio, subs = _extract_media_languages(payload)
    assert "english" in audio
    assert "japanese" in audio
    assert "eng" in audio
    assert "jpn" in audio
    assert "eng" in subs
    assert "spa" in subs


def test_extract_media_languages_splits_slash_separated_dual_audio():
    # Sonarr renders multi-track mediaInfo languages slash-joined, no spaces.
    payload = {
        "languages": [{"name": "Japanese"}],
        "mediaInfo": {"audioLanguages": "jpn/eng", "subtitles": "eng/spa/ger"},
    }
    audio, subs = _extract_media_languages(payload)
    assert audio == ["eng", "japanese", "jpn"]
    assert subs == ["eng", "ger", "spa"]


def test_extract_media_languages_splits_slash_with_spaces():
    payload = {
        "languages": [],
        "mediaInfo": {"audioLanguages": "Japanese / English", "subtitles": ""},
    }
    audio, subs = _extract_media_languages(payload)
    assert audio == ["english", "japanese"]
    assert subs == []
