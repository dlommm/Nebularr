from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from arrsync.config import Settings


def build_engine(settings: Settings) -> Engine:
    connect_args = {
        "options": f"-c statement_timeout={settings.sql_statement_timeout_ms}",
    }
    return create_engine(
        settings.database_url,
        pool_size=settings.sqlalchemy_pool_size,
        max_overflow=settings.sqlalchemy_max_overflow,
        pool_recycle=settings.sqlalchemy_pool_recycle,
        pool_pre_ping=True,
        connect_args=connect_args,
        future=True,
    )


def build_session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


@contextmanager
def session_scope(session_factory: sessionmaker[Session]) -> Iterator[Session]:
    session = session_factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def advisory_lock_key(source: str, mode: str) -> tuple[int, int]:
    key = f"{source}:{mode}"
    total = sum(ord(ch) for ch in key)
    return total // 32768, total % 32768


def try_advisory_lock(session: Session, source: str, mode: str) -> bool:
    k1, k2 = advisory_lock_key(source, mode)
    result = session.execute(text("select pg_try_advisory_lock(:k1, :k2)"), {"k1": k1, "k2": k2})
    return bool(result.scalar_one())


def advisory_unlock(session: Session, source: str, mode: str) -> None:
    k1, k2 = advisory_lock_key(source, mode)
    session.execute(text("select pg_advisory_unlock(:k1, :k2)"), {"k1": k1, "k2": k2})
