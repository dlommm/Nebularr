from __future__ import annotations

from arrsync.services.repository import _extract_video_resolution


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
