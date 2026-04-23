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
