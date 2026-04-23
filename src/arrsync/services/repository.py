from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from arrsync.models import CapabilitySet
from arrsync.security import decrypt_secret, encrypt_secret


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def record_capabilities(session: Session, caps: CapabilitySet, instance_name: str = "default") -> None:
    session.execute(
        text(
            """
            insert into app.sync_state (source, instance_name, capabilities, updated_at)
            values (:source, :instance_name, cast(:capabilities as jsonb), now())
            on conflict (source, instance_name) do update
            set capabilities = excluded.capabilities,
                updated_at = now()
            """
        ),
        {"source": caps.source, "instance_name": instance_name, "capabilities": _to_json(caps.raw)},
    )
    session.execute(
        text(
            """
            insert into app.settings (key, value, updated_at)
            values (:key, :value, now())
            on conflict (key) do update
            set value = excluded.value, updated_at = now()
            """
        ),
        {"key": f"{caps.source}.app_version", "value": caps.app_version},
    )


def create_sync_run(
    session: Session,
    source: str,
    mode: str,
    instance_name: str = "default",
    trigger: str = "manual",
) -> int:
    result = session.execute(
        text(
            """
            insert into warehouse.sync_run (source, mode, instance_name, status, started_at, details)
            values (
                :source,
                :mode,
                :instance_name,
                'running',
                now(),
                jsonb_build_object(
                    'instance_name',
                    cast(:instance_name as text),
                    'trigger',
                    cast(:trigger as text)
                )
            )
            returning id
            """
        ),
        {"source": source, "mode": mode, "instance_name": instance_name, "trigger": trigger},
    )
    run_id = int(result.scalar_one())
    session.execute(
        text(
            """
            insert into app.job_run_summary (source, mode, instance_name, status, started_at)
            values (:source, :mode, :instance_name, 'running', now())
            """
        ),
        {"source": source, "mode": mode, "instance_name": instance_name},
    )
    return run_id


def finish_sync_run(
    session: Session,
    run_id: int,
    source: str,
    mode: str,
    status: str,
    records_processed: int,
    details: dict[str, Any] | None = None,
    error_message: str | None = None,
    instance_name: str = "default",
) -> None:
    session.execute(
        text(
            """
            update warehouse.sync_run
            set status = :status,
                finished_at = now(),
                records_processed = :records_processed,
                details = cast(:details as jsonb),
                error_message = :error_message
            where id = :run_id
            """
        ),
        {
            "status": status,
            "records_processed": records_processed,
            "details": _to_json(details or {}),
            "error_message": error_message,
            "run_id": run_id,
        },
    )
    session.execute(
        text(
            """
            update app.job_run_summary
            set status = :status,
                finished_at = now(),
                rows_written = :records_processed,
                details = cast(:details as jsonb),
                error_message = :error_message
            where id = (
                select id from app.job_run_summary
                where source = :source and mode = :mode and instance_name = :instance_name
                order by started_at desc
                limit 1
            )
            """
        ),
        {
            "status": status,
            "records_processed": records_processed,
            "details": _to_json(details or {}),
            "error_message": error_message,
            "source": source,
            "mode": mode,
            "instance_name": instance_name,
        },
    )


def update_sync_run_progress(
    session: Session,
    run_id: int,
    source: str,
    mode: str,
    instance_name: str,
    records_processed: int,
    details: dict[str, Any],
) -> None:
    session.execute(
        text(
            """
            update warehouse.sync_run
            set records_processed = :records_processed,
                details = coalesce(details, '{}'::jsonb) || cast(:details as jsonb)
            where id = :run_id and status = 'running'
            """
        ),
        {
            "records_processed": records_processed,
            "details": _to_json(details),
            "run_id": run_id,
        },
    )
    session.execute(
        text(
            """
            update app.job_run_summary
            set rows_written = :records_processed,
                details = coalesce(details, '{}'::jsonb) || cast(:details as jsonb)
            where id = (
                select id from app.job_run_summary
                where source = :source and mode = :mode and instance_name = :instance_name
                order by started_at desc
                limit 1
            )
            """
        ),
        {
            "records_processed": records_processed,
            "details": _to_json(details),
            "source": source,
            "mode": mode,
            "instance_name": instance_name,
        },
    )


def upsert_series(session: Session, instance: str, row: dict[str, Any], run_id: int, sync_source: str) -> None:
    session.execute(
        text(
            """
            insert into warehouse.series
            (source_id, instance_name, title, monitored, path, genres, status, payload, sync_source, sync_run_id, seen_at, last_seen_at, deleted)
            values
            (:source_id, :instance_name, :title, :monitored, :path, cast(:genres as jsonb), :status, cast(:payload as jsonb), :sync_source, :sync_run_id, now(), now(), false)
            on conflict (source_id, instance_name) do update
            set title = excluded.title,
                monitored = excluded.monitored,
                path = excluded.path,
                genres = excluded.genres,
                status = excluded.status,
                payload = excluded.payload,
                sync_source = excluded.sync_source,
                sync_run_id = excluded.sync_run_id,
                last_seen_at = now(),
                deleted = false
            """
        ),
        {
            "source_id": row.get("id"),
            "instance_name": instance,
            "title": row.get("title", ""),
            "monitored": bool(row.get("monitored", True)),
            "path": row.get("path"),
            "genres": _to_json(row.get("genres", [])),
            "status": row.get("status"),
            "payload": _to_json(row),
            "sync_source": sync_source,
            "sync_run_id": run_id,
        },
    )


def upsert_episode(session: Session, instance: str, row: dict[str, Any], run_id: int, sync_source: str) -> None:
    air_date = row.get("airDateUtc") or row.get("airDate")
    session.execute(
        text(
            """
            insert into warehouse.episode
            (source_id, instance_name, series_source_id, season_number, episode_number, title, air_date, runtime_minutes, monitored, payload, sync_source, sync_run_id, seen_at, last_seen_at, deleted)
            values
            (:source_id, :instance_name, :series_source_id, :season_number, :episode_number, :title, :air_date, :runtime_minutes, :monitored, cast(:payload as jsonb), :sync_source, :sync_run_id, now(), now(), false)
            on conflict (source_id, instance_name) do update
            set title = excluded.title,
                air_date = excluded.air_date,
                runtime_minutes = excluded.runtime_minutes,
                monitored = excluded.monitored,
                payload = excluded.payload,
                sync_source = excluded.sync_source,
                sync_run_id = excluded.sync_run_id,
                last_seen_at = now(),
                deleted = false
            """
        ),
        {
            "source_id": row.get("id"),
            "instance_name": instance,
            "series_source_id": row.get("seriesId"),
            "season_number": row.get("seasonNumber", 0),
            "episode_number": row.get("episodeNumber", 0),
            "title": row.get("title", ""),
            "air_date": air_date,
            "runtime_minutes": row.get("runtime"),
            "monitored": bool(row.get("monitored", True)),
            "payload": _to_json(row),
            "sync_source": sync_source,
            "sync_run_id": run_id,
        },
    )


def _extract_media_languages(episode_or_movie_file: dict[str, Any]) -> tuple[list[str], list[str]]:
    media_info = episode_or_movie_file.get("mediaInfo") or {}
    langs = episode_or_movie_file.get("languages") or []
    audio_languages = []
    for lang in langs:
        if isinstance(lang, dict):
            value = lang.get("name") or lang.get("value")
            if value:
                audio_languages.append(str(value).lower())
    if media_info.get("audioLanguages"):
        audio_languages.extend(str(media_info.get("audioLanguages")).lower().replace(",", " ").split())
    subtitle_languages: list[str] = []
    if media_info.get("subtitles"):
        subtitle_languages = str(media_info.get("subtitles")).lower().replace(",", " ").split()
    return sorted(set(audio_languages)), sorted(set(subtitle_languages))


def upsert_episode_file(
    session: Session,
    instance: str,
    episode_id: int,
    row: dict[str, Any],
    run_id: int,
    sync_source: str,
) -> None:
    audio_languages, subtitle_languages = _extract_media_languages(row)
    media_info = row.get("mediaInfo") or {}
    quality = ((row.get("quality") or {}).get("quality") or {}).get("name")
    session.execute(
        text(
            """
            insert into warehouse.episode_file
            (source_id, instance_name, episode_source_id, path, size_bytes, quality, audio_languages, subtitle_languages, audio_codec, audio_channels, video_codec, payload, sync_source, sync_run_id, seen_at, last_seen_at, deleted)
            values
            (:source_id, :instance_name, :episode_source_id, :path, :size_bytes, :quality, :audio_languages, :subtitle_languages, :audio_codec, :audio_channels, :video_codec, cast(:payload as jsonb), :sync_source, :sync_run_id, now(), now(), false)
            on conflict (source_id, instance_name) do update
            set path = excluded.path,
                size_bytes = excluded.size_bytes,
                quality = excluded.quality,
                audio_languages = excluded.audio_languages,
                subtitle_languages = excluded.subtitle_languages,
                audio_codec = excluded.audio_codec,
                audio_channels = excluded.audio_channels,
                video_codec = excluded.video_codec,
                payload = excluded.payload,
                sync_source = excluded.sync_source,
                sync_run_id = excluded.sync_run_id,
                last_seen_at = now(),
                deleted = false
            """
        ),
        {
            "source_id": row.get("id"),
            "instance_name": instance,
            "episode_source_id": episode_id,
            "path": row.get("path"),
            "size_bytes": row.get("size"),
            "quality": quality,
            "audio_languages": audio_languages,
            "subtitle_languages": subtitle_languages,
            "audio_codec": media_info.get("audioCodec"),
            "audio_channels": media_info.get("audioChannels"),
            "video_codec": media_info.get("videoCodec"),
            "payload": _to_json(row),
            "sync_source": sync_source,
            "sync_run_id": run_id,
        },
    )


def upsert_movie(session: Session, instance: str, row: dict[str, Any], run_id: int, sync_source: str) -> None:
    session.execute(
        text(
            """
            insert into warehouse.movie
            (source_id, instance_name, title, year, monitored, path, status, payload, sync_source, sync_run_id, seen_at, last_seen_at, deleted)
            values
            (:source_id, :instance_name, :title, :year, :monitored, :path, :status, cast(:payload as jsonb), :sync_source, :sync_run_id, now(), now(), false)
            on conflict (source_id, instance_name) do update
            set title = excluded.title,
                year = excluded.year,
                monitored = excluded.monitored,
                path = excluded.path,
                status = excluded.status,
                payload = excluded.payload,
                sync_source = excluded.sync_source,
                sync_run_id = excluded.sync_run_id,
                last_seen_at = now(),
                deleted = false
            """
        ),
        {
            "source_id": row.get("id"),
            "instance_name": instance,
            "title": row.get("title", ""),
            "year": row.get("year"),
            "monitored": bool(row.get("monitored", True)),
            "path": row.get("path"),
            "status": row.get("status"),
            "payload": _to_json(row),
            "sync_source": sync_source,
            "sync_run_id": run_id,
        },
    )


def upsert_movie_file(
    session: Session,
    instance: str,
    movie_id: int,
    row: dict[str, Any],
    run_id: int,
    sync_source: str,
) -> None:
    audio_languages, subtitle_languages = _extract_media_languages(row)
    media_info = row.get("mediaInfo") or {}
    quality = ((row.get("quality") or {}).get("quality") or {}).get("name")
    session.execute(
        text(
            """
            insert into warehouse.movie_file
            (source_id, instance_name, movie_source_id, path, size_bytes, quality, audio_languages, subtitle_languages, audio_codec, audio_channels, video_codec, payload, sync_source, sync_run_id, seen_at, last_seen_at, deleted)
            values
            (:source_id, :instance_name, :movie_source_id, :path, :size_bytes, :quality, :audio_languages, :subtitle_languages, :audio_codec, :audio_channels, :video_codec, cast(:payload as jsonb), :sync_source, :sync_run_id, now(), now(), false)
            on conflict (source_id, instance_name) do update
            set path = excluded.path,
                size_bytes = excluded.size_bytes,
                quality = excluded.quality,
                audio_languages = excluded.audio_languages,
                subtitle_languages = excluded.subtitle_languages,
                audio_codec = excluded.audio_codec,
                audio_channels = excluded.audio_channels,
                video_codec = excluded.video_codec,
                payload = excluded.payload,
                sync_source = excluded.sync_source,
                sync_run_id = excluded.sync_run_id,
                last_seen_at = now(),
                deleted = false
            """
        ),
        {
            "source_id": row.get("id"),
            "instance_name": instance,
            "movie_source_id": movie_id,
            "path": row.get("path"),
            "size_bytes": row.get("size"),
            "quality": quality,
            "audio_languages": audio_languages,
            "subtitle_languages": subtitle_languages,
            "audio_codec": media_info.get("audioCodec"),
            "audio_channels": media_info.get("audioChannels"),
            "video_codec": media_info.get("videoCodec"),
            "payload": _to_json(row),
            "sync_source": sync_source,
            "sync_run_id": run_id,
        },
    )


def mark_tombstones(session: Session, table: str, instance_name: str, seen_ids: set[int]) -> None:
    if not seen_ids:
        session.execute(
            text(f"update {table} set deleted = true where instance_name = :instance_name"),  # noqa: S608
            {"instance_name": instance_name},
        )
        return
    session.execute(
        text(f"update {table} set deleted = true where instance_name = :instance_name and source_id <> all(:seen_ids)"),  # noqa: S608
        {"instance_name": instance_name, "seen_ids": list(seen_ids)},
    )


def mark_deleted_source_ids(session: Session, table: str, instance_name: str, ids: list[int]) -> None:
    if not ids:
        return
    session.execute(
        text(f"update {table} set deleted = true where instance_name = :instance_name and source_id = any(:ids)"),  # noqa: S608
        {"instance_name": instance_name, "ids": ids},
    )


def enqueue_webhook(
    session: Session,
    source: str,
    event_type: str,
    payload: dict[str, Any],
    dedupe_key: str | None,
) -> None:
    session.execute(
        text(
            """
            insert into app.webhook_queue(source, event_type, payload, dedupe_key, status, attempts, next_attempt_at)
            values (:source, :event_type, cast(:payload as jsonb), :dedupe_key, 'queued', 0, now())
            on conflict do nothing
            """
        ),
        {
            "source": source,
            "event_type": event_type,
            "payload": _to_json(payload),
            "dedupe_key": dedupe_key,
        },
    )


def claim_webhook_jobs(session: Session, batch_size: int = 20) -> list[dict[str, Any]]:
    result = session.execute(
        text(
            """
            update app.webhook_queue
            set status = 'retrying', attempts = attempts + 1
            where id in (
                select id
                from app.webhook_queue
                where status in ('queued', 'retrying') and next_attempt_at <= now()
                order by received_at
                limit :batch_size
                for update skip locked
            )
            returning id, source, event_type, payload, attempts
            """
        ),
        {"batch_size": batch_size},
    )
    rows = []
    for row in result.mappings():
        rows.append(dict(row))
    return rows


def mark_webhook_done(session: Session, queue_id: int) -> None:
    session.execute(
        text(
            """
            update app.webhook_queue
            set status = 'done', processed_at = now(), error_message = null
            where id = :queue_id
            """
        ),
        {"queue_id": queue_id},
    )


def mark_webhook_failed(session: Session, queue_id: int, attempts: int, error_message: str) -> None:
    status = "dead_letter" if attempts >= 5 else "retrying"
    session.execute(
        text(
            """
            update app.webhook_queue
            set status = :status,
                next_attempt_at = now() + make_interval(secs => :delay_seconds),
                error_message = :error_message
            where id = :queue_id
            """
        ),
        {
            "status": status,
            "delay_seconds": min(attempts * 30, 900),
            "error_message": error_message[:1000],
            "queue_id": queue_id,
        },
    )


def update_watermark(session: Session, source: str, history_time: datetime | None, history_id: int | None) -> None:
    update_watermark_for_instance(session, source, "default", history_time, history_id)


def update_watermark_for_instance(
    session: Session,
    source: str,
    instance_name: str,
    history_time: datetime | None,
    history_id: int | None,
) -> None:
    session.execute(
        text(
            """
            insert into app.sync_state(source, instance_name, last_history_time, last_history_id, updated_at)
            values (:source, :instance_name, :history_time, :history_id, now())
            on conflict (source, instance_name) do update
            set last_history_time = coalesce(excluded.last_history_time, app.sync_state.last_history_time),
                last_history_id = coalesce(excluded.last_history_id, app.sync_state.last_history_id),
                updated_at = now()
            """
        ),
        {
            "source": source,
            "instance_name": instance_name,
            "history_time": history_time,
            "history_id": history_id,
        },
    )


def get_watermark(session: Session, source: str) -> tuple[str | None, int | None]:
    return get_watermark_for_instance(session, source, "default")


def get_watermark_for_instance(session: Session, source: str, instance_name: str) -> tuple[str | None, int | None]:
    row = session.execute(
        text(
            """
            select last_history_time, last_history_id
            from app.sync_state
            where source = :source and instance_name = :instance_name
            """
        ),
        {"source": source, "instance_name": instance_name},
    ).first()
    if not row:
        return None, None
    history_time = row[0].isoformat() if row[0] else None
    history_id = int(row[1]) if row[1] is not None else None
    return history_time, history_id


def prune_old_rows(session: Session, keep_days: int = 30) -> None:
    session.execute(
        text("delete from app.webhook_queue where processed_at < now() - make_interval(days => :keep_days)"),
        {"keep_days": keep_days},
    )
    session.execute(
        text("delete from app.job_run_summary where started_at < now() - make_interval(days => :keep_days)"),
        {"keep_days": keep_days},
    )


def _to_json(value: Any) -> str:
    import json

    return json.dumps(value, default=str)


def list_enabled_integrations(session: Session, source: str) -> list[dict[str, Any]]:
    rows = session.execute(
        text(
            """
            select source, name, base_url, api_key, enabled, webhook_enabled
            from app.integration_instance
            where source = :source and enabled = true
            order by name
            """
        ),
        {"source": source},
    ).mappings()
    result = [dict(r) for r in rows]
    for row in result:
        row["api_key"] = decrypt_secret(str(row.get("api_key", "")))
    return result


def seed_default_integrations(
    session: Session,
    sonarr_base_url: str,
    sonarr_api_key: str,
    radarr_base_url: str,
    radarr_api_key: str,
) -> None:
    session.execute(
        text(
            """
            insert into app.integration_instance(source, name, base_url, api_key, enabled, webhook_enabled, updated_at)
            values
              ('sonarr', 'default', :sonarr_base_url, :sonarr_api_key, true, true, now()),
              ('radarr', 'default', :radarr_base_url, :radarr_api_key, true, true, now())
            on conflict (source, name) do update
            set base_url = excluded.base_url,
                api_key = case
                    when excluded.api_key = '' then app.integration_instance.api_key
                    else excluded.api_key
                end,
                updated_at = now()
            """
        ),
        {
            "sonarr_base_url": sonarr_base_url,
            "sonarr_api_key": encrypt_secret(sonarr_api_key),
            "radarr_base_url": radarr_base_url,
            "radarr_api_key": encrypt_secret(radarr_api_key),
        },
    )


def try_job_lock(session: Session, lock_name: str, owner_id: str, lease_seconds: int = 1800) -> bool:
    row = session.execute(
        text(
            """
            insert into app.job_lock(lock_name, owner_id, acquired_at, heartbeat_at, expires_at)
            values (:lock_name, :owner_id, now(), now(), now() + make_interval(secs => :lease_seconds))
            on conflict (lock_name) do update
            set owner_id = excluded.owner_id,
                acquired_at = case when app.job_lock.expires_at < now() then now() else app.job_lock.acquired_at end,
                heartbeat_at = case when app.job_lock.expires_at < now() then now() else app.job_lock.heartbeat_at end,
                expires_at = case when app.job_lock.expires_at < now() then excluded.expires_at else app.job_lock.expires_at end
            where app.job_lock.expires_at < now()
            returning owner_id
            """
        ),
        {"lock_name": lock_name, "owner_id": owner_id, "lease_seconds": lease_seconds},
    ).first()
    return row is not None


def heartbeat_job_lock(session: Session, lock_name: str, owner_id: str, lease_seconds: int = 1800) -> None:
    session.execute(
        text(
            """
            update app.job_lock
            set heartbeat_at = now(),
                expires_at = now() + make_interval(secs => :lease_seconds)
            where lock_name = :lock_name and owner_id = :owner_id
            """
        ),
        {"lock_name": lock_name, "owner_id": owner_id, "lease_seconds": lease_seconds},
    )


def release_job_lock(session: Session, lock_name: str, owner_id: str) -> None:
    session.execute(
        text("delete from app.job_lock where lock_name = :lock_name and owner_id = :owner_id"),
        {"lock_name": lock_name, "owner_id": owner_id},
    )
