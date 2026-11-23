"""Tankerkönig (Duitsland, MTS-K-data). Vereist TANKERKOENIG_API_KEY (gratis aan te vragen op
https://creativecommons.tankerkoenig.de). Zonder key slaat de pipeline deze bron netjes over;
DE-pompen komen dan alleen via ANWB binnen.

Meerdere zoekpunten langs de grens, straal max 25 km (API-limiet), ontdubbeld op station-ID.
"""
from __future__ import annotations

from typing import Any

from .base import BaseFuelSource, PriceRecord, StationRecord
from .http import PoliteClient

URL = "https://creativecommons.tankerkoenig.de/json/list.php"

# Zoekpunten (lat, lon) in de Duitse grensstreek rond Zuid-Limburg.
SEARCH_POINTS: list[tuple[str, float, float]] = [
    ("Aachen", 50.7753, 6.0839),
    ("Herzogenrath", 50.8700, 6.0940),
    ("Geilenkirchen", 50.9650, 6.1190),
    ("Heinsberg", 51.0630, 6.0960),
    ("Selfkant", 51.0020, 5.9200),
    ("Eschweiler", 50.8180, 6.2650),
    ("Stolberg", 50.7700, 6.2270),
    ("Monschau", 50.5550, 6.2400),
]
FUEL_KEYS = {"e10": "euro95", "e5": "e5", "diesel": "diesel"}


def parse(data: dict[str, Any]) -> list[StationRecord]:
    if not data.get("ok"):
        raise RuntimeError(f"Tankerkönig: {data.get('message', 'onbekende fout')}")
    out: list[StationRecord] = []
    for s in data.get("stations", []):
        st = StationRecord(
            source="tankerkoenig",
            source_id=s["id"],
            name=(s.get("name") or "").strip() or "Onbekend",
            country="DE",
            lat=s.get("lat"),
            lon=s.get("lng"),
            brand=(s.get("brand") or None),
            address=" ".join(x for x in [s.get("street"), str(s.get("houseNumber") or "")] if x).strip() or None,
            city=s.get("place"),
        )
        for key, fuel in FUEL_KEYS.items():
            v = s.get(key)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                st.prices.append(PriceRecord(fuel=fuel, price=float(v)))
        out.append(st)
    return out


class TankerkoenigSource(BaseFuelSource):
    name = "tankerkoenig"
    countries = ("DE",)

    def enabled(self) -> tuple[bool, str]:
        if not self.settings.tankerkoenig_api_key:
            return False, "TANKERKOENIG_API_KEY ontbreekt in .env"
        return True, ""

    def fetch(self) -> list[StationRecord]:
        s = self.settings
        http = PoliteClient(s.user_agent, s.http_timeout_s, s.request_delay_s)
        seen: dict[str, StationRecord] = {}
        try:
            for label, lat, lon in SEARCH_POINTS:
                try:
                    data = http.get_json(URL, {"lat": lat, "lng": lon, "rad": 25, "sort": "dist",
                                               "type": "all", "apikey": s.tankerkoenig_api_key})
                    for st in parse(data):
                        seen.setdefault(st.source_id, st)
                except Exception as exc:  # noqa: BLE001
                    self.log.warning("tankerkoenig: zoekpunt %s mislukt: %s", label, exc)
        finally:
            http.close()
        return list(seen.values())
