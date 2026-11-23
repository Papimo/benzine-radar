"""ANWB points-of-interest API (dezelfde JSON die de ANWB-site/app gebruikt).

Dekt NL én pompen net over de grens in BE en DE, zonder API-key.
Let op: de bron geeft GEEN prijsdatum per station; we gebruiken het ophaalmoment.
Endpoint/velden kunnen wijzigen: zie `parse()` — daar staan alle aannames over de response.
"""
from __future__ import annotations

from typing import Any

from ..fuels import normalize
from ..geo import bbox
from .base import BaseFuelSource, PriceRecord, StationRecord
from .http import PoliteClient

URL = "https://api.anwb.nl/routing/points-of-interest/v3/all"
ISO3 = {"NLD": "NL", "BEL": "BE", "DEU": "DE", "LUX": "LU", "FRA": "FR"}


DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]


def parse_hours(raw: Any) -> list | None:
    """ANWB openingHours → [['1111111', '00:00', '24:00'], ...] (dagen ma..zo)."""
    if not isinstance(raw, list) or not raw:
        return None
    out = []
    for h in raw:
        days = h.get("dayOfWeek") or []
        if not days or not h.get("opens") or not h.get("closes"):
            continue
        out.append(["".join("1" if d in days else "0" for d in DAYS), h["opens"][:5], h["closes"][:5]])
    return out or None


def parse(data: dict[str, Any]) -> list[StationRecord]:
    out: list[StationRecord] = []
    for item in data.get("value", []):
        if item.get("type") != "FUEL_STATION":
            continue
        coord = item.get("coordinates") or {}
        addr = item.get("address") or {}
        country = ISO3.get(addr.get("iso3CountryCode", ""), "")
        if not country:
            continue
        st = StationRecord(
            source="anwb",
            source_id=str(item.get("id")),
            name=(item.get("title") or "").strip() or "Onbekend",
            country=country,
            lat=coord.get("latitude"),
            lon=coord.get("longitude"),
            brand=(item.get("title") or "").split(" ")[0].upper() or None,
            address=addr.get("streetAddress"),
            city=addr.get("city"),
            hours=parse_hours(item.get("openingHours")),
        )
        for p in item.get("prices") or []:
            fuel = normalize(p.get("fuelType") or p.get("fuelName") or "")
            if fuel and isinstance(p.get("value"), (int, float)) and p.get("currency", "EUR") == "EUR":
                st.prices.append(PriceRecord(fuel=fuel, price=float(p["value"])))
        out.append(st)
    return out


class AnwbSource(BaseFuelSource):
    name = "anwb"
    countries = ("NL", "BE", "DE")

    def fetch(self) -> list[StationRecord]:
        s = self.settings
        min_lat, min_lon, max_lat, max_lon = bbox(s.anchor_lat, s.anchor_lon, s.region_radius_km)
        http = PoliteClient(s.user_agent, s.http_timeout_s, s.request_delay_s)
        try:
            data = http.get_json(URL, {
                "type-filter": "FUEL_STATION",
                "bounding-box-filter": f"{min_lat:.4f},{min_lon:.4f},{max_lat:.4f},{max_lon:.4f}",
            })
        finally:
            http.close()
        total = data.get("totalResults")
        got = len(data.get("value", []))
        if isinstance(total, int) and total > got:
            # Mocht de API ooit gaan pagineren: dan hier het gebied in tegels opdelen.
            self.log.warning("ANWB gaf %d van %d resultaten terug (paginering?)", got, total)
        return parse(data)
