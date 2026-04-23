import pytest

from arrsync.config import Settings
from arrsync.validation import validate_settings


def test_validate_settings_rejects_non_postgres():
    settings = Settings(
        database_url="sqlite:///tmp.db",
        sonarr_base_url="http://sonarr:8989",
        radarr_base_url="http://radarr:7878",
    )
    with pytest.raises(ValueError):
        validate_settings(settings)


def test_validate_settings_rejects_invalid_arr_base_url():
    settings = Settings(
        database_url="postgresql+psycopg://arrapp:arrapp@localhost:5432/arranalytics",
        sonarr_base_url="not-a-url",
        radarr_base_url="http://radarr:7878",
    )
    with pytest.raises(ValueError):
        validate_settings(settings)


def test_validate_settings_rejects_invalid_alert_webhook_url():
    settings = Settings(
        database_url="postgresql+psycopg://arrapp:arrapp@localhost:5432/arranalytics",
        sonarr_base_url="http://sonarr:8989",
        radarr_base_url="http://radarr:7878",
        alert_webhook_urls="not-a-url",
    )
    with pytest.raises(ValueError):
        validate_settings(settings)
