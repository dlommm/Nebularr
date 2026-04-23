from sqlalchemy import create_engine, text

from alembic import command
from alembic.config import Config

from arrsync.config import Settings


def run_migrations(settings: Settings) -> None:
    # Ensure alembic_version can be created under app schema before first migration.
    engine = create_engine(settings.database_url, future=True)
    with engine.begin() as conn:
        conn.execute(text("create schema if not exists app"))
        conn.execute(text("create schema if not exists warehouse"))
    engine.dispose()

    cfg = Config("alembic.ini")
    cfg.set_main_option("sqlalchemy.url", settings.database_url)
    command.upgrade(cfg, "head")
