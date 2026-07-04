from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import create_engine
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
