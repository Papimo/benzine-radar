"""Bronregister. Nieuwe bron = module met een BaseFuelSource-subklasse + regel hieronder."""
from __future__ import annotations

from .anwb import AnwbSource
from .base import BaseFuelSource, PriceRecord, StationRecord
from .carbu import CarbuSource
from .tankerkoenig import TankerkoenigSource

REGISTRY: dict[str, type[BaseFuelSource]] = {
    AnwbSource.name: AnwbSource,
    CarbuSource.name: CarbuSource,
    TankerkoenigSource.name: TankerkoenigSource,
}

# Bij dezelfde pomp uit meerdere bronnen: welke bron wint (lager = beter).
# carbu heeft voor BE een echte prijsdatum, Tankerkönig is officiële MTS-K-data voor DE.
PRIORITY: dict[str, dict[str, int]] = {
    "BE": {"carbu": 0, "anwb": 1},
    "DE": {"tankerkoenig": 0, "anwb": 1},
    "NL": {"anwb": 0},
}

__all__ = ["REGISTRY", "PRIORITY", "BaseFuelSource", "StationRecord", "PriceRecord"]
