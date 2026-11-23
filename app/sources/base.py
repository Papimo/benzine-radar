"""Basisklasse voor brandstofbronnen + gedeelde datatypes."""
from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field

from ..config import Settings


@dataclass
class PriceRecord:
    fuel: str                    # canonieke code (zie fuels.py)
    price: float                 # EUR per liter
    updated_at: float | None = None  # epoch volgens bron; None = onbekend (dan ophaalmoment)


@dataclass
class StationRecord:
    source: str
    source_id: str
    name: str
    country: str                 # NL / BE / DE
    lat: float
    lon: float
    brand: str | None = None
    address: str | None = None
    city: str | None = None
    prices: list[PriceRecord] = field(default_factory=list)
    hours: list | None = None    # openingstijden [[dagen ma..zo als '1111100', 'van', 'tot'], ...]; None = onbekend

    @property
    def id(self) -> str:
        return f"{self.source}:{self.source_id}"


class BaseFuelSource(ABC):
    """Eén bron = één module. `fetch()` levert ruwe records; validatie gebeurt centraal in ingest.py.

    Een bron mag exceptions gooien: de pipeline vangt ze per bron af, zodat andere bronnen doorlopen.
    """

    name: str = "base"
    countries: tuple[str, ...] = ()

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.log = logging.getLogger(f"source.{self.name}")

    def enabled(self) -> tuple[bool, str]:
        """(aan?, reden). Bv. uit als een API-key ontbreekt."""
        return True, ""

    @abstractmethod
    def fetch(self) -> list[StationRecord]:
        ...
