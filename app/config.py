"""Configuratie uit .env (met verstandige standaardwaarden)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

try:  # python-dotenv is optioneel; zonder pakket gelden alleen echte omgevingsvariabelen
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env")
except ImportError:  # pragma: no cover
    pass

APP_VERSION = "1.1.0"


def _f(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except ValueError:
        return default


def _i(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except ValueError:
        return default


def _list(name: str, default: str) -> list[str]:
    return [x.strip() for x in os.getenv(name, default).split(",") if x.strip()]


@dataclass(frozen=True)
class Settings:
    # Algemeen
    db_path: Path = field(default_factory=lambda: (ROOT / os.getenv("DB_PATH", "data/benzine-radar.sqlite")).resolve())
    host: str = os.getenv("HOST", "127.0.0.1")
    port: int = _i("PORT", 8120)
    log_level: str = os.getenv("LOG_LEVEL", "INFO")
    user_agent: str = os.getenv("USER_AGENT", f"benzine-radar/{APP_VERSION} (self-hosted fuel price comparer)")

    # Ankerpunt + regio (Heerlen)
    anchor_lat: float = _f("ANCHOR_LAT", 50.8882)
    anchor_lon: float = _f("ANCHOR_LON", 5.9795)
    region_radius_km: float = _f("REGION_RADIUS_KM", 50)
    default_address: str = os.getenv("DEFAULT_ADDRESS", "Heerlen")

    # Standaardwaarden formulier
    default_tank_l: float = _f("DEFAULT_TANK_L", 45)
    default_consumption: float = _f("DEFAULT_CONSUMPTION_L100", 6.5)
    default_radius_km: float = _f("DEFAULT_RADIUS_KM", 35)
    routing_candidates: int = _i("ROUTING_CANDIDATES", 40)

    # Bronnen
    enabled_sources: list[str] = field(default_factory=lambda: _list("SOURCES", "anwb,carbu,tankerkoenig"))
    tankerkoenig_api_key: str = os.getenv("TANKERKOENIG_API_KEY", "")
    carbu_towns: list[str] = field(
        default_factory=lambda: _list(
            "CARBU_TOWNS",
            "Lanaken,Maasmechelen,Riemst,Tongeren,Bilzen,Genk,Maaseik,Voeren,Kelmis,Welkenraedt,Eupen",
        )
    )
    request_delay_s: float = _f("REQUEST_DELAY_S", 1.0)
    http_timeout_s: float = _f("HTTP_TIMEOUT_S", 20)
    stale_after_h: float = _f("STALE_AFTER_H", 72)

    # Geocoding & routing
    nominatim_url: str = os.getenv("NOMINATIM_URL", "https://nominatim.openstreetmap.org")
    osrm_url: str = os.getenv("OSRM_URL", "https://router.project-osrm.org")
    ors_api_key: str = os.getenv("ORS_API_KEY", "")
    route_cache_h: float = _f("ROUTE_CACHE_H", 24)


settings = Settings()
