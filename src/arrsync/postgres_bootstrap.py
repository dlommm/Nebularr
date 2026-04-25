"""Create/update arrapp role and privileges (replaces docker/postgres/init/00_roles.sh)."""

from __future__ import annotations

import re

from sqlalchemy import create_engine, text
from sqlalchemy.engine.url import make_url


_DB_NAME_RE = re.compile(r"^[a-zA-Z0-9_]+$")


def _validate_db_name(database_name: str) -> str:
    if not _DB_NAME_RE.fullmatch(database_name):
        raise ValueError("database_name must contain only letters, digits, and underscores")
    return database_name


def _quote_ident(ident: str) -> str:
    return '"' + ident.replace('"', '""') + '"'


def bootstrap_arrapp_from_admin_url(admin_database_url: str, database_name: str, arrapp_password: str) -> str:
    """
    Connect as superuser (or any role that can create roles), ensure arrapp exists with
    search_path and schema grants, reassign objects owned by the admin user to arrapp,
    and return a SQLAlchemy URL for arrapp (same host/port/db as admin URL).
    """
    if not admin_database_url.startswith("postgresql"):
        raise ValueError("admin_database_url must be a PostgreSQL SQLAlchemy URL")
    dbn = _validate_db_name(database_name)
    pw = arrapp_password
    if not pw:
        raise ValueError("arrapp_password is required")

    admin_url = make_url(admin_database_url)
    if not admin_url.database or admin_url.database != dbn:
        raise ValueError("admin URL must include the same database path as database_name")

    admin_engine = create_engine(admin_database_url, pool_pre_ping=True, future=True)

    with admin_engine.connect() as conn:
        admin_user = str(conn.execute(text("select current_user")).scalar_one())

    ac_engine = admin_engine.execution_options(isolation_level="AUTOCOMMIT")

    with ac_engine.connect() as conn:
        exists = conn.execute(text("select 1 from pg_roles where rolname = 'arrapp' limit 1")).scalar() == 1
        if exists:
            conn.execute(text("alter role arrapp password :pw"), {"pw": pw})
        else:
            conn.execute(text("create role arrapp login password :pw"), {"pw": pw})

        conn.execute(text("alter role arrapp set search_path = app, warehouse, public"))
        conn.execute(text(f"grant create on database {_quote_ident(dbn)} to arrapp"))

        conn.execute(text("create schema if not exists app authorization arrapp"))
        conn.execute(text("create schema if not exists warehouse authorization arrapp"))
        conn.execute(text("alter schema app owner to arrapp"))
        conn.execute(text("alter schema warehouse owner to arrapp"))
        conn.execute(text("grant usage on schema app to arrapp"))
        conn.execute(text("grant usage on schema warehouse to arrapp"))

        if admin_user != "arrapp":
            conn.execute(text(f"reassign owned by {_quote_ident(admin_user)} to arrapp"))

        conn.execute(
            text(
                """
                do $mal_grants$
                begin
                  if exists (select 1 from information_schema.schemata where schema_name = 'mal') then
                    execute 'grant usage on schema mal to arrapp';
                    execute 'grant all privileges on all tables in schema mal to arrapp';
                    execute 'grant all privileges on all sequences in schema mal to arrapp';
                  end if;
                  if exists (
                    select 1 from information_schema.tables
                    where table_schema = 'app' and table_name = 'mal_job_run'
                  ) then
                    execute 'grant all privileges on app.mal_job_run to arrapp';
                    execute 'grant all privileges on sequence app.mal_job_run_id_seq to arrapp';
                  end if;
                end
                $mal_grants$;
                """
            )
        )

    arrapp_url = admin_url.set(username="arrapp", password=pw)
    rebuilt = arrapp_url.render_as_string(hide_password=False)

    test_engine = create_engine(rebuilt, pool_pre_ping=True, future=True)
    with test_engine.connect() as tconn:
        if tconn.execute(text("select 1")).scalar() != 1:
            raise RuntimeError("arrapp connectivity check failed")

    return rebuilt
