"""Session factory that can be bound after DATABASE_URL is known (first-run setup)."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session, sessionmaker


class DeferredSessionFactory:
    """Behaves like sessionmaker for ``session_factory()`` calls; bind when the DB URL is ready."""

    __slots__ = ("_inner",)

    def __init__(self) -> None:
        self._inner: sessionmaker[Session] | None = None

    @property
    def ready(self) -> bool:
        return self._inner is not None

    def bind(self, inner: sessionmaker[Session]) -> None:
        self._inner = inner

    def unbind(self) -> None:
        self._inner = None

    def __call__(self, *args: Any, **kwargs: Any) -> Session:
        if self._inner is None:
            raise RuntimeError("database session factory not bound")
        return self._inner(*args, **kwargs)
