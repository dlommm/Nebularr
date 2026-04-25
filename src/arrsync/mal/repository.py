from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from sqlalchemy import bindparam, text
from sqlalchemy.orm import Session

from arrsync.mal.titles import (
    merge_additional_title_lists,
    titles_from_jikan_anime_data,
    titles_from_mal_api_response,
)


def _jsonify_row(row: Mapping[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, val in dict(row).items():
        if val is not None and hasattr(val, "isoformat"):
            out[key] = val.isoformat()
        else:
            out[key] = val
    return out


def get_mal_sync_ui_snapshot(session: Session) -> dict[str, Any]:
    """Recent MAL cron job state for /api/status and the Web UI."""
    running: list[dict[str, Any]] = []
    for r in session.execute(
        text(
            """
            select id as run_id, job_type, started_at
            from app.mal_job_run
            where status = 'running'
            order by started_at desc
            """
        )
    ).mappings():
        running.append(_jsonify_row(r))
    last_finished: dict[str, dict[str, Any]] = {}
    for r in session.execute(
        text(
            """
            select distinct on (job_type)
                job_type, status, started_at, finished_at, error_message
            from app.mal_job_run
            where finished_at is not null
            order by job_type, finished_at desc
            """
        )
    ).mappings():
        last_finished[str(r["job_type"])] = _jsonify_row(r)
    return {"running": running, "last_finished": last_finished}


def insert_mal_job_run(session: Session, job_type: str) -> int:
    row = session.execute(
        text(
            """
            insert into app.mal_job_run (job_type, status, started_at, details)
            values (:job_type, 'running', now(), '{}'::jsonb)
            returning id
            """
        ),
        {"job_type": job_type},
    ).scalar_one()
    return int(row)


def finish_mal_job_run(
    session: Session,
    run_id: int,
    status: str,
    details: dict[str, Any],
    error_message: str | None = None,
) -> None:
    session.execute(
        text(
            """
            update app.mal_job_run
            set status = :status,
                finished_at = now(),
                details = cast(:details as jsonb),
                error_message = :error_message
            where id = :id
            """
        ),
        {
            "id": run_id,
            "status": status,
            "details": json.dumps(details, default=str),
            "error_message": error_message,
        },
    )


def latest_dub_list_sha(session: Session) -> str | None:
    row = session.execute(
        text(
            """
            select content_sha256
            from mal.dub_list_fetch
            where error_message is null and http_status is not null and http_status < 400
            order by id desc
            limit 1
            """
        )
    ).scalar_one_or_none()
    return str(row) if row else None


def get_ingest_checkpoint(session: Session, job_name: str) -> str | None:
    row = session.execute(
        text("select cursor from mal.ingest_checkpoint where job_name = :job_name"),
        {"job_name": job_name},
    ).scalar_one_or_none()
    return str(row) if row else None


def set_ingest_checkpoint(session: Session, job_name: str, cursor: str | None, metadata: dict[str, Any]) -> None:
    session.execute(
        text(
            """
            insert into mal.ingest_checkpoint (job_name, cursor, run_metadata, updated_at)
            values (:job_name, :cursor, cast(:metadata as jsonb), now())
            on conflict (job_name) do update
            set cursor = excluded.cursor,
                run_metadata = excluded.run_metadata,
                updated_at = now()
            """
        ),
        {
            "job_name": job_name,
            "cursor": cursor,
            "metadata": json.dumps(metadata, default=str),
        },
    )


def clear_auto_warehouse_links(session: Session) -> None:
    session.execute(
        text(
            """
            delete from mal.warehouse_link
            where match_method in ('tvdb', 'tmdb', 'imdb', 'title_year')
            """
        )
    )


def delete_links_for_undubbed(session: Session) -> None:
    session.execute(
        text(
            """
            delete from mal.warehouse_link wl
            using mal.anime a
            where wl.mal_id = a.mal_id and a.is_english_dubbed = false
            """
        )
    )


def upsert_manual_warehouse_links(session: Session) -> int:
    result = session.execute(
        text(
            """
            insert into mal.warehouse_link (
                mal_id, instance_name, arr_entity, warehouse_source_id,
                match_method, confidence, match_detail, last_verified_at, updated_at
            )
            select
                m.mal_id,
                m.instance_name,
                m.arr_entity,
                m.warehouse_source_id,
                'manual',
                'high',
                jsonb_build_object('note', coalesce(m.note, '')),
                now(),
                now()
            from mal.manual_link m
            on conflict (mal_id, instance_name, arr_entity) do update
            set warehouse_source_id = excluded.warehouse_source_id,
                match_method = 'manual',
                confidence = 'high',
                match_detail = excluded.match_detail,
                last_verified_at = now(),
                updated_at = now()
            """
        )
    )
    return result.rowcount or 0


def insert_tvdb_series_links(session: Session) -> int:
    result = session.execute(
        text(
            """
            insert into mal.warehouse_link (
                mal_id, instance_name, arr_entity, warehouse_source_id,
                match_method, confidence, match_detail, last_verified_at, updated_at
            )
            select distinct on (e.mal_id, s.instance_name)
                e.mal_id,
                s.instance_name,
                'sonarr_series',
                s.source_id,
                'tvdb',
                'high',
                jsonb_build_object('tvdb_id', e.external_id),
                now(),
                now()
            from mal.anime a
            join mal.anime_external_id e on e.mal_id = a.mal_id and e.site = 'tvdb'
            join warehouse.series s
              on s.deleted = false
             and nullif(trim(s.payload->>'tvdbId'), '') is not null
             and trim(s.payload->>'tvdbId') = trim(e.external_id)
            where a.is_english_dubbed = true
            order by e.mal_id, s.instance_name, s.source_id
            on conflict (mal_id, instance_name, arr_entity) do update
            set warehouse_source_id = excluded.warehouse_source_id,
                match_method = excluded.match_method,
                confidence = excluded.confidence,
                match_detail = excluded.match_detail,
                last_verified_at = now(),
                updated_at = now()
            """
        )
    )
    return result.rowcount or 0


def insert_tmdb_radarr_links(session: Session) -> int:
    result = session.execute(
        text(
            """
            insert into mal.warehouse_link (
                mal_id, instance_name, arr_entity, warehouse_source_id,
                match_method, confidence, match_detail, last_verified_at, updated_at
            )
            select distinct on (e.mal_id, m.instance_name)
                e.mal_id,
                m.instance_name,
                'radarr_movie',
                m.source_id,
                'tmdb',
                'high',
                jsonb_build_object('tmdb_id', e.external_id),
                now(),
                now()
            from mal.anime a
            join mal.anime_external_id e on e.mal_id = a.mal_id and e.site = 'tmdb'
            join warehouse.movie m
              on m.deleted = false
             and nullif(trim(m.payload->>'tmdbId'), '') is not null
             and trim(m.payload->>'tmdbId') = trim(e.external_id)
            where a.is_english_dubbed = true
            order by e.mal_id, m.instance_name, m.source_id
            on conflict (mal_id, instance_name, arr_entity) do update
            set warehouse_source_id = excluded.warehouse_source_id,
                match_method = excluded.match_method,
                confidence = excluded.confidence,
                match_detail = excluded.match_detail,
                last_verified_at = now(),
                updated_at = now()
            """
        )
    )
    return result.rowcount or 0


def insert_imdb_radarr_links(session: Session) -> int:
    result = session.execute(
        text(
            """
            insert into mal.warehouse_link (
                mal_id, instance_name, arr_entity, warehouse_source_id,
                match_method, confidence, match_detail, last_verified_at, updated_at
            )
            select distinct on (e.mal_id, m.instance_name)
                e.mal_id,
                m.instance_name,
                'radarr_movie',
                m.source_id,
                'imdb',
                'high',
                jsonb_build_object('imdb_id', e.external_id),
                now(),
                now()
            from mal.anime a
            join mal.anime_external_id e on e.mal_id = a.mal_id and e.site = 'imdb'
            join warehouse.movie m
              on m.deleted = false
             and nullif(trim(m.payload->>'imdbId'), '') is not null
             and lower(trim(replace(m.payload->>'imdbId', 'tt', ''))) = lower(trim(replace(e.external_id, 'tt', '')))
            where a.is_english_dubbed = true
            order by e.mal_id, m.instance_name, m.source_id
            on conflict (mal_id, instance_name, arr_entity) do update
            set warehouse_source_id = excluded.warehouse_source_id,
                match_method = excluded.match_method,
                confidence = excluded.confidence,
                match_detail = excluded.match_detail,
                last_verified_at = now(),
                updated_at = now()
            """
        )
    )
    return result.rowcount or 0


def count_dubbed_without_link(session: Session) -> int:
    row = session.execute(
        text(
            """
            select count(*) from mal.anime a
            where a.is_english_dubbed = true
              and not exists (
                  select 1 from mal.warehouse_link l where l.mal_id = a.mal_id
              )
            """
        )
    ).scalar_one()
    return int(row or 0)


def mark_dubbed_from_snapshot(session: Session, fetch_id: int, mal_ids: list[int]) -> None:
    if not mal_ids:
        return
    for mid in mal_ids:
        session.execute(
            text(
                """
                insert into mal.dub_list_snapshot_item (dub_list_fetch_id, mal_id)
                values (:fetch_id, :mid)
                on conflict (dub_list_fetch_id, mal_id) do nothing
                """
            ),
            {"fetch_id": fetch_id, "mid": mid},
        )
        session.execute(
            text(
                """
                insert into mal.anime (
                    mal_id, is_english_dubbed, dub_list_seen_at, dub_list_last_present_at, mal_fetch_status
                )
                values (:mid, true, now(), now(), 'pending')
                on conflict (mal_id) do update
                set is_english_dubbed = true,
                    dub_list_seen_at = now(),
                    dub_list_last_present_at = now()
                """
            ),
            {"mid": mid},
        )


def clear_dub_flag_not_in_list(session: Session, active_ids: list[int]) -> int:
    if not active_ids:
        result = session.execute(
            text(
                """
                update mal.anime
                set is_english_dubbed = false
                where is_english_dubbed = true
                """
            )
        )
        return result.rowcount or 0
    result = session.execute(
        text(
            """
            update mal.anime
            set is_english_dubbed = false
            where is_english_dubbed = true
              and mal_id not in :ids
            """
        ).bindparams(bindparam("ids", expanding=True)),
        {"ids": active_ids},
    )
    return result.rowcount or 0


def insert_dub_list_fetch(
    session: Session,
    *,
    source_url: str,
    content_sha256: str,
    id_count: int,
    raw: dict[str, Any] | None,
    http_status: int | None,
    error_message: str | None,
) -> int:
    row = session.execute(
        text(
            """
            insert into mal.dub_list_fetch (source_url, content_sha256, id_count, raw, http_status, error_message)
            values (:source_url, :sha, :id_count, cast(:raw as jsonb), :http_status, :error_message)
            returning id
            """
        ),
        {
            "source_url": source_url,
            "sha": content_sha256,
            "id_count": id_count,
            "raw": json.dumps(raw, default=str) if raw is not None else None,
            "http_status": http_status,
            "error_message": error_message,
        },
    ).scalar_one()
    return int(row)


def upsert_anime_from_mal_api(
    session: Session,
    mal_id: int,
    mal_response: dict[str, Any],
    *,
    status: str,
    error: str | None,
) -> None:
    main_title, additional_titles = titles_from_mal_api_response(mal_response)
    media_type = mal_response.get("media_type")
    stat = mal_response.get("status")
    start_date = mal_response.get("start_date")
    num_episodes = mal_response.get("num_episodes")
    nsfw_raw = mal_response.get("nsfw")
    nsfw: bool | None
    if isinstance(nsfw_raw, bool):
        nsfw = nsfw_raw
    elif isinstance(nsfw_raw, str):
        nsfw = nsfw_raw.lower() not in {"", "white"}
    else:
        nsfw = None
    mean = mal_response.get("mean")
    mean_score = float(mean) if mean is not None else None
    session.execute(
        text(
            """
            insert into mal.anime (
                mal_id, mal_response, mal_fetch_status, mal_last_error, mal_fetched_at,
                main_title, additional_titles, media_type, status, start_date, num_episodes, nsfw, mean_score
            )
            values (
                :mal_id, cast(:mal_response as jsonb), :fetch_status, :err, now(),
                :main_title, cast(:additional_titles as jsonb), :media_type, :status, :start_date, :num_episodes, :nsfw, :mean_score
            )
            on conflict (mal_id) do update
            set mal_response = excluded.mal_response,
                mal_fetch_status = excluded.mal_fetch_status,
                mal_last_error = excluded.mal_last_error,
                mal_fetched_at = now(),
                main_title = excluded.main_title,
                additional_titles = excluded.additional_titles,
                media_type = excluded.media_type,
                status = excluded.status,
                start_date = excluded.start_date,
                num_episodes = excluded.num_episodes,
                nsfw = excluded.nsfw,
                mean_score = excluded.mean_score
            """
        ),
        {
            "mal_id": mal_id,
            "mal_response": json.dumps(mal_response, default=str),
            "fetch_status": status,
            "err": error,
            "main_title": main_title,
            "additional_titles": json.dumps(additional_titles),
            "media_type": media_type,
            "status": stat,
            "start_date": start_date,
            "num_episodes": num_episodes,
            "nsfw": nsfw,
            "mean_score": mean_score,
        },
    )


def set_jikan_response(session: Session, mal_id: int, body: dict[str, Any]) -> None:
    session.execute(
        text(
            """
            update mal.anime
            set jikan_response = cast(:body as jsonb),
                jikan_fetched_at = now()
            where mal_id = :mal_id
            """
        ),
        {"mal_id": mal_id, "body": json.dumps(body, default=str)},
    )


def merge_jikan_title_variants(session: Session, mal_id: int, jikan_anime_data: dict[str, Any]) -> None:
    """Append Jikan title strings into ``additional_titles`` (English ``main_title`` unchanged)."""
    incoming = titles_from_jikan_anime_data(jikan_anime_data)
    if not incoming:
        return
    row = session.execute(
        text(
            """
            select main_title, coalesce(additional_titles, '[]'::jsonb) as extra
            from mal.anime
            where mal_id = :mal_id
            """
        ),
        {"mal_id": mal_id},
    ).mappings().first()
    if row is None:
        return
    primary = row["main_title"]
    if primary is not None:
        primary = str(primary).strip() or None
    merged = merge_additional_title_lists(primary, row["extra"], incoming)
    session.execute(
        text(
            """
            update mal.anime
            set additional_titles = cast(:titles as jsonb)
            where mal_id = :mal_id
            """
        ),
        {"mal_id": mal_id, "titles": json.dumps(merged)},
    )


def upsert_external_id(session: Session, mal_id: int, site: str, external_id: str, source: str) -> None:
    session.execute(
        text(
            """
            insert into mal.anime_external_id (mal_id, site, external_id, source, updated_at)
            values (:mal_id, :site, :external_id, :src, now())
            on conflict (mal_id, site) do update
            set external_id = excluded.external_id,
                source = excluded.source,
                updated_at = now()
            """
        ),
        {"mal_id": mal_id, "site": site, "external_id": external_id, "src": source},
    )


def list_anime_needing_mal_fetch(session: Session, limit: int) -> list[int]:
    rows = session.execute(
        text(
            """
            select mal_id from mal.anime
            where is_english_dubbed = true
              and (
                    mal_fetch_status in ('pending', 'error')
                 or mal_fetched_at is null
                 or mal_fetched_at < now() - interval '14 days'
              )
            order by mal_id
            limit :lim
            """
        ),
        {"lim": limit},
    ).scalars()
    return [int(x) for x in rows]


def sample_unmatched_mal_ids(session: Session, limit: int = 50) -> list[int]:
    rows = session.execute(
        text(
            """
            select a.mal_id from mal.anime a
            where a.is_english_dubbed = true
              and not exists (select 1 from mal.warehouse_link l where l.mal_id = a.mal_id)
            order by a.mal_id
            limit :lim
            """
        ),
        {"lim": limit},
    ).scalars()
    return [int(x) for x in rows]
