from __future__ import annotations

import pytest

from arrsync.postgres_bootstrap import (
    _quote_ident,
    _validate_db_name,
    bootstrap_arrapp_from_admin_url,
)


class TestValidateDbName:
    def test_accepts_word_characters(self) -> None:
        assert _validate_db_name("arrapp_db_1") == "arrapp_db_1"

    @pytest.mark.parametrize("bad", ["", "arr-app", "arr app", 'arr"app', "db;drop table x"])
    def test_rejects_unsafe_names(self, bad: str) -> None:
        with pytest.raises(ValueError):
            _validate_db_name(bad)


class TestQuoteIdent:
    def test_wraps_in_double_quotes(self) -> None:
        assert _quote_ident("arrapp") == '"arrapp"'

    def test_escapes_embedded_quotes(self) -> None:
        assert _quote_ident('we"ird') == '"we""ird"'


class TestBootstrapValidation:
    def test_rejects_non_postgres_url(self) -> None:
        with pytest.raises(ValueError, match="PostgreSQL"):
            bootstrap_arrapp_from_admin_url("mysql://root@db/arr", "arr", "pw")

    def test_rejects_empty_password(self) -> None:
        with pytest.raises(ValueError, match="password"):
            bootstrap_arrapp_from_admin_url("postgresql+psycopg://admin@db/arr", "arr", "")

    def test_rejects_database_mismatch(self) -> None:
        with pytest.raises(ValueError, match="same database"):
            bootstrap_arrapp_from_admin_url("postgresql+psycopg://admin@db/other", "arr", "pw")

    def test_rejects_invalid_database_name(self) -> None:
        with pytest.raises(ValueError, match="letters, digits"):
            bootstrap_arrapp_from_admin_url("postgresql+psycopg://admin@db/arr-x", "arr-x", "pw")
