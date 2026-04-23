from dataclasses import dataclass
from datetime import datetime
from typing import Any


@dataclass(slots=True)
class SyncRequest:
    source: str
    mode: str
    reason: str


@dataclass(slots=True)
class CapabilitySet:
    source: str
    app_version: str
    supports_history: bool
    supports_episode_include_files: bool
    raw: dict[str, Any]


@dataclass(slots=True)
class SyncResult:
    source: str
    mode: str
    status: str
    records_processed: int
    started_at: datetime
    finished_at: datetime
    details: dict[str, Any]
