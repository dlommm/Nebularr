from __future__ import annotations

from typing import Any

from arrsync.services.repository import (
    _extract_video_resolution,
    upsert_episode_file,
    upsert_movie_file,
)


def test_resolution_from_media_info() -> None:
    assert _extract_video_resolution({"mediaInfo": {"resolution": "1920x1080"}}) == 1080
    assert _extract_video_resolution({"mediaInfo": {"resolution": "3840x2160"}}) == 2160


def test_resolution_falls_back_to_quality_name() -> None:
    row = {"mediaInfo": {}, "quality": {"quality": {"name": "WEBDL-720p"}}}
    assert _extract_video_resolution(row) == 720
    row = {"quality": {"quality": {"name": "HDTV-1080i"}}}
    assert _extract_video_resolution(row) == 1080


def test_resolution_none_when_unparseable() -> None:
    assert _extract_video_resolution({}) is None
    assert _extract_video_resolution({"mediaInfo": {"resolution": "widescreen"}, "quality": {"quality": {"name": "Unknown"}}}) is None


# RecordingSession for capturing upsert SQL and params
class RecordingSession:
    """Accepts any SQL, records it for inspection."""

    def __init__(self) -> None:
        self.statements: list[tuple[str, dict[str, Any] | None]] = []

    def execute(self, query: Any, params: dict[str, Any] | None = None) -> None:
        sql = " ".join(str(query).lower().split())
        self.statements.append((sql, params))


def test_upsert_episode_file_includes_video_resolution() -> None:
    """Verify that upsert_episode_file wires video_resolution into SQL and params."""
    session = RecordingSession()
    row = {
        "id": 100,
        "path": "/path/to/episode.mkv",
        "size": 5000000000,
        "mediaInfo": {"resolution": "1920x1080", "audioCodec": "aac", "audioChannels": 2, "videoCodec": "h264"},
        "quality": {"quality": {"name": "WEBDL-1080p"}},
    }

    upsert_episode_file(
        session=session,
        instance="test-instance",
        episode_id=50,
        row=row,
        run_id=1,
        sync_source="test",
    )

    assert len(session.statements) == 1
    sql, params = session.statements[0]

    # Verify SQL structure includes video_resolution in INSERT
    assert "video_resolution" in sql, "video_resolution missing from INSERT column list"
    # Verify SQL structure includes video_resolution in UPDATE
    assert "video_resolution = excluded.video_resolution" in sql, "video_resolution missing from UPDATE SET"
    # Verify params include the extracted resolution
    assert params is not None
    assert params.get("video_resolution") == 1080, f"Expected video_resolution=1080, got {params.get('video_resolution')}"


def test_upsert_movie_file_includes_video_resolution() -> None:
    """Verify that upsert_movie_file wires video_resolution into SQL and params."""
    session = RecordingSession()
    row = {
        "id": 200,
        "path": "/path/to/movie.mkv",
        "size": 8000000000,
        "mediaInfo": {"resolution": "3840x2160", "audioCodec": "dts", "audioChannels": 6, "videoCodec": "h265"},
        "quality": {"quality": {"name": "Bluray-4K"}},
    }

    upsert_movie_file(
        session=session,
        instance="test-instance",
        movie_id=75,
        row=row,
        run_id=1,
        sync_source="test",
    )

    assert len(session.statements) == 1
    sql, params = session.statements[0]

    # Verify SQL structure includes video_resolution in INSERT
    assert "video_resolution" in sql, "video_resolution missing from INSERT column list"
    # Verify SQL structure includes video_resolution in UPDATE
    assert "video_resolution = excluded.video_resolution" in sql, "video_resolution missing from UPDATE SET"
    # Verify params include the extracted resolution
    assert params is not None
    assert params.get("video_resolution") == 2160, f"Expected video_resolution=2160, got {params.get('video_resolution')}"


def test_upsert_episode_file_resolution_fallback() -> None:
    """Verify that upsert_episode_file uses quality name fallback when mediaInfo unavailable."""
    session = RecordingSession()
    row = {
        "id": 101,
        "path": "/path/to/episode.mkv",
        "size": 3000000000,
        "mediaInfo": {},  # No resolution info
        "quality": {"quality": {"name": "HDTV-720p"}},
    }

    upsert_episode_file(
        session=session,
        instance="test-instance",
        episode_id=51,
        row=row,
        run_id=1,
        sync_source="test",
    )

    assert len(session.statements) == 1
    sql, params = session.statements[0]
    assert params is not None
    assert params.get("video_resolution") == 720, f"Expected video_resolution=720 (fallback), got {params.get('video_resolution')}"


def test_upsert_movie_file_resolution_none() -> None:
    """Verify that upsert_movie_file passes None when resolution cannot be extracted."""
    session = RecordingSession()
    row = {
        "id": 201,
        "path": "/path/to/movie.mkv",
        "size": 2000000000,
        "mediaInfo": {"resolution": "unknown"},
        "quality": {"quality": {"name": "Unknown"}},
    }

    upsert_movie_file(
        session=session,
        instance="test-instance",
        movie_id=76,
        row=row,
        run_id=1,
        sync_source="test",
    )

    assert len(session.statements) == 1
    sql, params = session.statements[0]
    assert params is not None
    assert params.get("video_resolution") is None, f"Expected video_resolution=None, got {params.get('video_resolution')}"


# --- the quality tier, not the frame height --------------------------------
# "1080p" names a tier. Storing a letterboxed file's crop height instead made a
# 1920x960 Bluray-1080p read as 960, which a resolution_min: 1080 rule rejects —
# and under the series-completeness rules one such episode disqualifies a whole
# show. These cases are the shapes that actually appear in a real library.


def test_letterboxed_1080p_is_a_1080p_file() -> None:
    """2:1 (1920x960) and 2.39:1 (1920x800) releases are what broke this: both are
    1080p to Sonarr and to the operator, and neither is 1080 pixels tall."""
    for height in (960, 904, 872, 816, 800):
        row = {
            "quality": {"quality": {"name": "Bluray-1080p", "resolution": 1080}},
            "mediaInfo": {"resolution": f"1920x{height}"},
        }
        assert _extract_video_resolution(row) == 1080, f"1920x{height}"


def test_letterboxed_4k_is_a_4k_file() -> None:
    row = {
        "quality": {"quality": {"name": "Bluray-2160p", "resolution": 2160}},
        "mediaInfo": {"resolution": "3840x1600"},
    }
    assert _extract_video_resolution(row) == 2160


def test_arr_tier_number_wins_over_frame_geometry() -> None:
    """The Arr's own number is the one shown in its UI, so agreeing with it means
    never contradicting what the operator sees."""
    row = {
        "quality": {"quality": {"name": "WEBRip-1080p", "resolution": 1080}},
        "mediaInfo": {"resolution": "1920x960"},
    }
    assert _extract_video_resolution(row) == 1080


def test_quality_name_used_when_the_tier_number_is_absent() -> None:
    row = {
        "quality": {"quality": {"name": "WEBDL-1080p"}},
        "mediaInfo": {"resolution": "1920x800"},
    }
    assert _extract_video_resolution(row) == 1080


def test_width_derives_the_tier_when_no_quality_metadata_exists() -> None:
    """Width is the letterbox-proof signal: 1920 wide is 1080p whatever the crop."""
    assert _extract_video_resolution({"mediaInfo": {"resolution": "1920x816"}}) == 1080
    assert _extract_video_resolution({"mediaInfo": {"resolution": "3840x1608"}}) == 2160
    assert _extract_video_resolution({"mediaInfo": {"resolution": "1280x536"}}) == 720


def test_height_is_the_last_resort_for_unusually_narrow_frames() -> None:
    """A frame too narrow to imply a tier (vertical video, odd crops) still yields
    its height rather than nothing."""
    assert _extract_video_resolution({"mediaInfo": {"resolution": "400x1080"}}) == 1080


def test_nonsense_tier_number_falls_through_instead_of_poisoning_the_column() -> None:
    row = {
        "quality": {"quality": {"name": "WEBDL-1080p", "resolution": 99999}},
        "mediaInfo": {"resolution": "1920x800"},
    }
    assert _extract_video_resolution(row) == 1080


def test_boolean_tier_number_is_not_treated_as_an_int() -> None:
    """bool is a subclass of int in Python; True must not become a resolution."""
    row = {
        "quality": {"quality": {"name": "Bluray-1080p", "resolution": True}},
        "mediaInfo": {"resolution": "1920x1080"},
    }
    assert _extract_video_resolution(row) == 1080


def test_tier_boundaries_map_to_named_tiers() -> None:
    cases = {
        "3840x2160": 2160,
        "2560x1080": 1440,
        "1920x1080": 1080,
        "1280x720": 720,
        "1024x576": 480,
        "852x480": 480,
        "640x480": 360,
    }
    for resolution, expected in cases.items():
        assert _extract_video_resolution({"mediaInfo": {"resolution": resolution}}) == expected, resolution
