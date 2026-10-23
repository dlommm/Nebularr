"""Posters and fanart from Sonarr/Radarr, served through Nebularr.

The browser never talks to Sonarr/Radarr: every image is fetched server-side with
the integration's stored API key, through the same egress guard as every other
outbound request, from the ``images`` list each sync already stores in the
warehouse ``payload``. Fetches go to ``/api/v3/mediacover/{id}/{file}`` rather
than the payload's ``url`` so an Arr ``urlBase`` already present in the configured
base URL is not applied twice.

Cache layout under ``<runtime dir>/artwork``::

    <cover>/<sha[:2]>/<sha>-<lastWrite>.<ext>

``sha`` hashes (source, instance, item, cover, size); ``lastWrite`` comes from the
Arr's own cover URL, so a re-scraped poster gets a new name and the stale file is
replaced on the next fetch. In "live" mode nothing is kept except a small poster
sample for the sign-in wall.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import random
import re
import shutil
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx
from sqlalchemy import text

from arrsync.config import Settings
from arrsync.db import session_scope
from arrsync.runtime_database_url import runtime_dir
from arrsync.services import repository as repo
from arrsync.services.artwork_store import ArtworkSettings, read_artwork_settings
from arrsync.services.url_guard import EgressGuardedTransport, UrlPolicyError

log = logging.getLogger(__name__)

KIND_SOURCE = {"series": "sonarr", "movie": "radarr"}
_KIND_TABLE = {"series": "warehouse.series", "movie": "warehouse.movie"}
# Sizes the Arrs keep on disk next to each original (Sonarr/Radarr MediaCoverService).
COVER_SIZES: dict[str, frozenset[int | None]] = {
    "poster": frozenset({None, 250, 500}),
    "fanart": frozenset({None, 180, 360}),
    "banner": frozenset({None}),
    "clearlogo": frozenset({None}),
}
PREFETCH_COVERS: tuple[tuple[str, int | None], ...] = (("poster", 500), ("fanart", None))
PREFETCH_CONCURRENCY = 4
MAX_IMAGE_BYTES = 20 * 1024 * 1024
# Posters kept even in live mode, so the sign-in wall still has artwork.
WALL_SAMPLE_SIZE = 60
WALL_MAX_COUNT = 80

_SETTINGS_TTL_SECONDS = 10.0
_WALL_INDEX_TTL_SECONDS = 60.0
_CAP_CHECK_EVERY_WRITES = 50
_TOKEN_RE = re.compile(r"^[0-9a-f]{64}-[0-9A-Za-z]{1,40}$")
_UNSAFE_LAST_WRITE = re.compile(r"[^0-9A-Za-z]")
_EXT_BY_TYPE = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}
_TYPE_BY_EXT = {ext: ctype for ctype, ext in _EXT_BY_TYPE.items()}


@dataclass(frozen=True)
class ImageRef:
    source: str
    instance_name: str
    item_id: int
    cover: str
    filename: str
    last_write: str
    remote_url: str | None


@dataclass(frozen=True)
class Artwork:
    content_type: str
    etag: str
    path: Path | None = None
    body: bytes | None = None


@dataclass
class PrefetchReport:
    reason: str
    mode: str
    started_at: str
    finished_at: str | None = None
    fetched: int = 0
    already_cached: int = 0
    unavailable: int = 0
    pruned: int = 0
    evicted: int = 0
    interrupted: bool = False
    errors: list[str] = field(default_factory=list)


def sniff_image_type(data: bytes) -> str | None:
    """Trust the bytes, not the upstream Content-Type."""
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return None


def cache_key(source: str, instance_name: str, item_id: int, cover: str, size: int | None) -> str:
    raw = f"{source}|{instance_name}|{item_id}|{cover}|{size or 'orig'}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def sized_filename(filename: str, size: int | None) -> str:
    if size is None:
        return filename
    stem, dot, ext = filename.rpartition(".")
    return f"{stem}-{size}.{ext}" if dot else f"{filename}-{size}"


def image_ref_from_payload(
    images: Any, *, source: str, instance_name: str, item_id: int, cover: str
) -> ImageRef | None:
    """Pick ``cover`` out of an Arr ``images`` list (as stored in the payload)."""
    if not isinstance(images, list):
        return None
    for image in images:
        if not isinstance(image, dict):
            continue
        if str(image.get("coverType", "")).lower() != cover:
            continue
        url = str(image.get("url") or "")
        remote = image.get("remoteUrl")
        remote_url = str(remote) if isinstance(remote, str) and remote.startswith(("https://", "http://")) else None
        parsed = urlparse(url)
        filename = parsed.path.rsplit("/", 1)[-1] if parsed.path else ""
        if not filename or "." not in filename:
            filename = f"{cover}.jpg"
        last_write = (parse_qs(parsed.query).get("lastWrite") or ["0"])[0]
        last_write = _UNSAFE_LAST_WRITE.sub("", last_write)[:40] or "0"
        if not url and remote_url is None:
            return None
        return ImageRef(
            source=source,
            instance_name=instance_name,
            item_id=item_id,
            cover=cover,
            filename=filename,
            last_write=last_write,
            remote_url=remote_url,
        )
    return None


def validate_request(kind: str, cover: str, size: int | None) -> None:
    if kind not in KIND_SOURCE:
        raise ValueError("kind must be 'series' or 'movie'")
    sizes = COVER_SIZES.get(cover)
    if sizes is None:
        raise ValueError(f"cover must be one of {', '.join(sorted(COVER_SIZES))}")
    if size not in sizes:
        allowed = ", ".join(str(s) for s in sorted(s for s in sizes if s is not None)) or "none"
        raise ValueError(f"size for {cover} must be omitted or one of: {allowed}")


class ArtworkService:
    def __init__(
        self,
        settings: Settings,
        session_factory: Any,
        *,
        cache_root: Path | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        stop_event: asyncio.Event | None = None,
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self._cache_root = cache_root
        self._transport = transport
        self._stop_event = stop_event
        self._client: httpx.AsyncClient | None = None
        self._locks: dict[str, asyncio.Lock] = {}
        self._settings_cache: tuple[float, ArtworkSettings] | None = None
        self._wall_index: tuple[float, list[str]] | None = None
        self._writes_since_cap_check = 0
        self._prefetch_lock = asyncio.Lock()
        self.last_prefetch: PrefetchReport | None = None

    # --- plumbing -------------------------------------------------------------

    @property
    def root(self) -> Path:
        return self._cache_root if self._cache_root is not None else runtime_dir() / "artwork"

    def _http(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                timeout=self.settings.http_timeout_seconds,
                transport=self._transport or EgressGuardedTransport(policy=self.settings.egress_policy),
                follow_redirects=False,
            )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()

    @property
    def prefetch_running(self) -> bool:
        return self._prefetch_lock.locked()

    def current_settings(self) -> ArtworkSettings:
        cached = self._settings_cache
        if cached is not None and time.monotonic() - cached[0] < _SETTINGS_TTL_SECONDS:
            return cached[1]
        with session_scope(self.session_factory) as session:
            value = read_artwork_settings(session)
        self._settings_cache = (time.monotonic(), value)
        return value

    def invalidate_settings(self) -> None:
        self._settings_cache = None

    def _lock_for(self, key: str) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            lock = self._locks[key] = asyncio.Lock()
        return lock

    # --- warehouse lookups ------------------------------------------------------

    def _resolve(
        self, kind: str, instance_name: str, item_id: int, cover: str
    ) -> tuple[ImageRef, dict[str, Any] | None] | None:
        source = KIND_SOURCE[kind]
        with session_scope(self.session_factory) as session:
            images = session.execute(
                text(
                    f"select payload->'images' from {_KIND_TABLE[kind]} "  # noqa: S608 - table from a fixed map
                    "where source_id = :item_id and instance_name = :instance_name and not deleted"
                ),
                {"item_id": item_id, "instance_name": instance_name},
            ).scalar_one_or_none()
            ref = image_ref_from_payload(
                images, source=source, instance_name=instance_name, item_id=item_id, cover=cover
            )
            if ref is None:
                return None
            integration = next(
                (i for i in repo.list_enabled_integrations(session, source) if str(i["name"]) == instance_name),
                None,
            )
        return ref, integration

    def _all_items(self) -> tuple[list[tuple[str, str, int, Any]], dict[tuple[str, str], dict[str, Any]]]:
        """Every live series and movie with its images, plus enabled integrations."""
        items: list[tuple[str, str, int, Any]] = []
        integrations: dict[tuple[str, str], dict[str, Any]] = {}
        with session_scope(self.session_factory) as session:
            for kind, table in _KIND_TABLE.items():
                rows = session.execute(
                    text(
                        f"select source_id, instance_name, payload->'images' as images "  # noqa: S608 - fixed map
                        f"from {table} where not deleted"
                    )
                ).mappings()
                items.extend((kind, str(r["instance_name"]), int(r["source_id"]), r["images"]) for r in rows)
            for source in ("sonarr", "radarr"):
                for integration in repo.list_enabled_integrations(session, source):
                    integrations[(source, str(integration["name"]))] = integration
        return items, integrations

    # --- disk cache ---------------------------------------------------------------

    def _cover_dir(self, cover: str, sha: str) -> Path:
        return self.root / cover / sha[:2]

    def _cached_path(self, cover: str, sha: str, last_write: str) -> Path | None:
        directory = self._cover_dir(cover, sha)
        for candidate in directory.glob(f"{sha}-{last_write}.*"):
            if candidate.is_file() and candidate.suffix in _TYPE_BY_EXT:
                return candidate
        return None

    def _store(self, cover: str, sha: str, last_write: str, data: bytes, content_type: str) -> Path:
        directory = self._cover_dir(cover, sha)
        directory.mkdir(parents=True, exist_ok=True)
        final = directory / f"{sha}-{last_write}{_EXT_BY_TYPE[content_type]}"
        tmp = directory / f".{sha}.{uuid.uuid4().hex}.tmp"
        tmp.write_bytes(data)
        os.replace(tmp, final)
        for stale in directory.glob(f"{sha}-*"):
            if stale != final:
                stale.unlink(missing_ok=True)
        if cover == "poster":
            self._wall_index = None
        return final

    def _iter_files(self) -> Iterator[Path]:
        root = self.root
        if not root.is_dir():
            return
        for cover in COVER_SIZES:
            cover_dir = root / cover
            if not cover_dir.is_dir():
                continue
            for shard in cover_dir.iterdir():
                if not shard.is_dir():
                    continue
                for path in shard.iterdir():
                    if path.is_file() and not path.name.startswith("."):
                        yield path

    def stats(self) -> dict[str, Any]:
        by_cover: dict[str, dict[str, int]] = {}
        total_files = 0
        total_bytes = 0
        for path in self._iter_files():
            size = path.stat().st_size
            entry = by_cover.setdefault(path.parent.parent.name, {"files": 0, "bytes": 0})
            entry["files"] += 1
            entry["bytes"] += size
            total_files += 1
            total_bytes += size
        return {"files": total_files, "bytes": total_bytes, "by_cover": by_cover}

    def clear(self) -> int:
        removed = sum(1 for _ in self._iter_files())
        for cover in COVER_SIZES:
            shutil.rmtree(self.root / cover, ignore_errors=True)
        self._wall_index = None
        return removed

    def enforce_cap(self, max_mb: int) -> int:
        """Evict least-recently-served files (mtime is bumped on every hit) until
        the cache fits under ``max_mb``. Returns how many files were removed."""
        if max_mb <= 0:
            return 0
        limit = max_mb * 1024 * 1024
        files = [(p.stat().st_mtime, p.stat().st_size, p) for p in self._iter_files()]
        total = sum(size for _, size, _ in files)
        removed = 0
        for _, size, path in sorted(files, key=lambda f: f[0]):
            if total <= limit:
                break
            path.unlink(missing_ok=True)
            total -= size
            removed += 1
        if removed:
            self._wall_index = None
        return removed

    def _poster_count(self) -> int:
        return len(self._wall_tokens())

    def trim_for_live(self) -> int:
        """Switching to live mode hands the disk back: keep only a random poster
        sample for the sign-in wall and delete everything else."""
        removed = 0
        posters: list[Path] = []
        for path in list(self._iter_files()):
            if path.parent.parent.name == "poster":
                posters.append(path)
            else:
                path.unlink(missing_ok=True)
                removed += 1
        random.shuffle(posters)
        for path in posters[WALL_SAMPLE_SIZE:]:
            path.unlink(missing_ok=True)
            removed += 1
        self._wall_index = None
        return removed

    # --- sign-in wall ---------------------------------------------------------------

    def _wall_tokens(self) -> list[str]:
        cached = self._wall_index
        if cached is not None and time.monotonic() - cached[0] < _WALL_INDEX_TTL_SECONDS:
            return cached[1]
        tokens = [
            path.stem
            for path in self._iter_files()
            if path.parent.parent.name == "poster" and _TOKEN_RE.match(path.stem)
        ]
        self._wall_index = (time.monotonic(), tokens)
        return tokens

    def wall(self, count: int) -> list[str]:
        """Random cached posters for the sign-in page, as opaque tokens. Only files
        already on disk are ever offered, so this endpoint never triggers a fetch."""
        tokens = self._wall_tokens()
        count = max(0, min(count, WALL_MAX_COUNT, len(tokens)))
        return random.sample(tokens, count)

    def wall_file(self, token: str) -> Path | None:
        if not _TOKEN_RE.match(token):
            return None
        directory = self.root / "poster" / token[:2]
        for candidate in directory.glob(f"{token}.*"):
            if candidate.is_file() and candidate.suffix in _TYPE_BY_EXT:
                return candidate
        return None

    # --- fetching -------------------------------------------------------------------

    async def _download(self, url: str, headers: dict[str, str]) -> bytes | None:
        try:
            async with self._http().stream("GET", url, headers=headers) as resp:
                if resp.status_code != 200:
                    return None
                declared = resp.headers.get("content-length")
                if declared and declared.isdigit() and int(declared) > MAX_IMAGE_BYTES:
                    return None
                chunks: list[bytes] = []
                received = 0
                async for chunk in resp.aiter_bytes():
                    received += len(chunk)
                    if received > MAX_IMAGE_BYTES:
                        return None
                    chunks.append(chunk)
                return b"".join(chunks)
        except (httpx.HTTPError, UrlPolicyError) as exc:
            log.debug("artwork fetch failed", extra={"error": type(exc).__name__})
            return None

    async def _fetch(
        self,
        ref: ImageRef,
        size: int | None,
        integration: dict[str, Any] | None,
        remote_fallback: bool,
    ) -> tuple[bytes, str] | None:
        candidates: list[tuple[str, dict[str, str]]] = []
        if integration is not None:
            base_url = str(integration["base_url"]).rstrip("/")
            headers = {"X-Api-Key": str(integration.get("api_key", ""))}
            names = [sized_filename(ref.filename, size)]
            if size is not None:
                names.append(ref.filename)  # the Arr may not have resized this one yet
            candidates.extend((f"{base_url}/api/v3/mediacover/{ref.item_id}/{name}", headers) for name in names)
        if remote_fallback and ref.remote_url:
            candidates.append((ref.remote_url, {}))  # never send the API key off-LAN
        for url, headers in candidates:
            data = await self._download(url, headers)
            if not data:
                continue
            content_type = sniff_image_type(data)
            if content_type is not None:
                return data, content_type
        return None

    async def get(
        self, kind: str, instance_name: str, item_id: int, cover: str, size: int | None = None
    ) -> Artwork | None:
        validate_request(kind, cover, size)
        prefs = await asyncio.to_thread(self.current_settings)
        if not prefs["enabled"]:
            return None
        resolved = await asyncio.to_thread(self._resolve, kind, instance_name, item_id, cover)
        if resolved is None:
            return None
        ref, integration = resolved
        sha = cache_key(ref.source, instance_name, item_id, cover, size)
        etag = f'"{sha[:20]}-{ref.last_write}"'
        hit = self._serve_cached(cover, sha, ref.last_write, etag)
        if hit is not None:
            return hit
        async with self._lock_for(sha):
            hit = self._serve_cached(cover, sha, ref.last_write, etag)
            if hit is not None:
                return hit
            fetched = await self._fetch(ref, size, integration, prefs["remote_fallback"])
            if fetched is None:
                return None
            data, content_type = fetched
            keep = prefs["mode"] == "cache" or (cover == "poster" and self._poster_count() < WALL_SAMPLE_SIZE)
            if not keep:
                return Artwork(content_type=content_type, etag=etag, body=data)
            path = await asyncio.to_thread(self._store, cover, sha, ref.last_write, data, content_type)
            await self._maybe_enforce_cap(prefs)
            return Artwork(content_type=content_type, etag=etag, path=path)

    def _serve_cached(self, cover: str, sha: str, last_write: str, etag: str) -> Artwork | None:
        path = self._cached_path(cover, sha, last_write)
        if path is None:
            return None
        try:
            os.utime(path)  # recency for cap eviction
        except OSError:
            pass
        return Artwork(content_type=_TYPE_BY_EXT[path.suffix], etag=etag, path=path)

    async def _maybe_enforce_cap(self, prefs: ArtworkSettings) -> None:
        if prefs["cache_max_mb"] <= 0:
            return
        self._writes_since_cap_check += 1
        if self._writes_since_cap_check < _CAP_CHECK_EVERY_WRITES:
            return
        self._writes_since_cap_check = 0
        await asyncio.to_thread(self.enforce_cap, prefs["cache_max_mb"])

    # --- background prefetch -----------------------------------------------------------

    def _stopping(self) -> bool:
        return self._stop_event is not None and self._stop_event.is_set()

    async def prefetch(self, reason: str = "manual") -> PrefetchReport | None:
        """Warm the cache for every series and movie (cache mode), or keep the
        sign-in wall sample topped up (live mode). Returns None if a prefetch is
        already running or artwork is turned off."""
        if self._prefetch_lock.locked():
            return None
        async with self._prefetch_lock:
            self.invalidate_settings()
            prefs = await asyncio.to_thread(self.current_settings)
            if not prefs["enabled"]:
                return None
            report = PrefetchReport(
                reason=reason, mode=prefs["mode"], started_at=datetime.now(timezone.utc).isoformat()
            )
            self.last_prefetch = report
            items, integrations = await asyncio.to_thread(self._all_items)
            wanted: list[tuple[ImageRef, int | None, str, dict[str, Any] | None]] = []
            valid: dict[str, str] = {}
            for kind, instance_name, item_id, images in items:
                source = KIND_SOURCE[kind]
                integration = integrations.get((source, instance_name))
                for cover, sizes in COVER_SIZES.items():
                    ref = image_ref_from_payload(
                        images, source=source, instance_name=instance_name, item_id=item_id, cover=cover
                    )
                    if ref is None:
                        continue
                    for size in sizes:
                        sha = cache_key(source, instance_name, item_id, cover, size)
                        valid[sha] = ref.last_write
                        if (cover, size) in PREFETCH_COVERS:
                            wanted.append((ref, size, sha, integration))
            if prefs["mode"] == "live":
                wanted = [w for w in wanted if w[0].cover == "poster"]
                random.shuffle(wanted)
                wanted = wanted[: max(0, WALL_SAMPLE_SIZE - self._poster_count())]
            semaphore = asyncio.Semaphore(PREFETCH_CONCURRENCY)

            async def warm(ref: ImageRef, size: int | None, sha: str, integration: dict[str, Any] | None) -> None:
                if self._stopping():
                    report.interrupted = True
                    return
                if self._cached_path(ref.cover, sha, ref.last_write) is not None:
                    report.already_cached += 1
                    return
                async with semaphore, self._lock_for(sha):
                    if self._cached_path(ref.cover, sha, ref.last_write) is not None:
                        report.already_cached += 1
                        return
                    fetched = await self._fetch(ref, size, integration, prefs["remote_fallback"])
                    if fetched is None:
                        report.unavailable += 1
                        return
                    data, content_type = fetched
                    await asyncio.to_thread(self._store, ref.cover, sha, ref.last_write, data, content_type)
                    report.fetched += 1

            await asyncio.gather(*(warm(*w) for w in wanted))
            if not report.interrupted:
                report.pruned = await asyncio.to_thread(self._prune, valid)
                report.evicted = await asyncio.to_thread(self.enforce_cap, prefs["cache_max_mb"])
            report.finished_at = datetime.now(timezone.utc).isoformat()
            log.info(
                "artwork prefetch finished",
                extra={
                    "reason": reason,
                    "mode": report.mode,
                    "fetched": report.fetched,
                    "already_cached": report.already_cached,
                    "unavailable": report.unavailable,
                    "pruned": report.pruned,
                    "evicted": report.evicted,
                    "interrupted": report.interrupted,
                },
            )
            return report

    def _prune(self, valid: dict[str, str]) -> int:
        """Drop files for items that left the warehouse or whose art was replaced."""
        removed = 0
        for path in list(self._iter_files()):
            sha, _, last_write = path.stem.partition("-")
            if valid.get(sha) != last_write:
                path.unlink(missing_ok=True)
                removed += 1
        if removed:
            self._wall_index = None
        return removed
