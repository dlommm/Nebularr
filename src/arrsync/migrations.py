from pathlib import Path

from sqlalchemy import create_engine, text

from alembic import command
from alembic.config import Config

from arrsync.config import Settings


def _alembic_ini_path() -> Path:
    # Docker image copies alembic.ini to /app (the WORKDIR); dev installs run
    # from arbitrary directories, so fall back to the repo root next to src/.
    cwd_ini = Path("alembic.ini")
    if cwd_ini.exists():
        return cwd_ini
    return Path(__file__).resolve().parents[2] / "alembic.ini"


def run_migrations(settings: Settings) -> None:
    # Ensure alembic_version can be created under app schema before first migration.
    engine = create_engine(settings.database_url, future=True)
    with engine.begin() as conn:
        conn.execute(text("create schema if not exists app"))
        conn.execute(text("create schema if not exists warehouse"))
    engine.dispose()

    ini_path = _alembic_ini_path()
    cfg = Config(str(ini_path))
    cfg.set_main_option("script_location", str(ini_path.resolve().parent / "alembic"))
    cfg.set_main_option("sqlalchemy.url", settings.database_url)
    # The app configures logging itself; see alembic/env.py.
    cfg.attributes["configure_logger"] = False
    command.upgrade(cfg, "head")
