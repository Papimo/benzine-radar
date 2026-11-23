"""carbu.com (België): HTML-scraper van de lijstpagina's per gemeente en brandstof.

Werkwijze:
 1. Gemeentenaam -> carbu-locatie-ID via het JSON-endpoint `getlocation`.
 2. Per gemeente + brandstof de lijstpagina ophalen (±100 pompen rond die gemeente).
 3. Elke pomp staat in een <div class="stationItem" data-lat=.. data-lng=.. data-price=..>.
    De prijsdatum staat verderop in hetzelfde blok als 'dd/mm/yy'.

AFSTEMMEN als carbu de site wijzigt: `LIST_URL`, `FUEL_CODES`, `_ITEM_RE` en `_DATE_RE` hieronder.
"""
from __future__ import annotations

import html as htmllib
import re
from datetime import datetime
from zoneinfo import ZoneInfo

from .base import BaseFuelSource, PriceRecord, StationRecord
from .http import PoliteClient

LOCATION_URL = "https://carbu.com/commonFunctions/getlocation/controller.getlocation_JSON.php"
LIST_URL = "https://carbu.com/belgie/liste-stations-service/{fuel}/{town}/{pc}/{loc_id}"
# carbu-code -> canonieke brandstof
FUEL_CODES: dict[str, str] = {"E10": "euro95", "SP98": "super98", "GO": "diesel"}

_ITEM_RE = re.compile(r'<div\s+id="item_(\d+)"(.*?)class="stationItem', re.S)
_ATTR_RE = re.compile(r'data-([a-z]+)="([^"]*)"')
_DATE_RE = re.compile(r"(\d{2})/(\d{2})/(\d{2,4})")
TZ = ZoneInfo("Europe/Brussels")


def _parse_date(s: str) -> float | None:
    m = _DATE_RE.search(s)
    if not m:
        return None
    d, mo, y = (int(x) for x in m.groups())
    if y < 100:
        y += 2000
    try:
        return datetime(y, mo, d, 12, 0, tzinfo=TZ).timestamp()  # alleen datum bekend: middag aannemen
    except ValueError:
        return None


def parse_list(page: str, fuel: str) -> list[StationRecord]:
    """Parseer één lijstpagina. `fuel` = canonieke code van die pagina."""
    out: list[StationRecord] = []
    matches = list(_ITEM_RE.finditer(page))
    for i, m in enumerate(matches):
        attrs = dict(_ATTR_RE.findall(m.group(2)))
        block_end = matches[i + 1].start() if i + 1 < len(matches) else m.end() + 6000
        block = page[m.end():block_end]
        try:
            lat, lon = float(attrs.get("lat", "")), float(attrs.get("lng", ""))
        except ValueError:
            continue
        addr_parts = htmllib.unescape(attrs.get("address", "")).split("<br/>")
        city = addr_parts[1].strip().split(" ", 1)[-1] if len(addr_parts) > 1 else None
        st = StationRecord(
            source="carbu",
            source_id=m.group(1),
            name=htmllib.unescape(attrs.get("name", "")).strip() or "Onbekend",
            country="BE",
            lat=lat,
            lon=lon,
            brand=(htmllib.unescape(attrs.get("name", "")).split(" ")[0].upper() or None),
            address=addr_parts[0].strip() or None,
            city=city,
        )
        price = attrs.get("price", "").replace(",", ".")
        if price:
            # Datum zoeken in het prijsgedeelte van het blok ('Update-datum: <br/>23/11/26').
            pi = block.find(f'id="price_{m.group(1)}"')
            ts = _parse_date(block[pi:pi + 600]) if pi >= 0 else None
            try:
                st.prices.append(PriceRecord(fuel=fuel, price=float(price), updated_at=ts))
            except ValueError:
                pass
        out.append(st)
    return out


class CarbuSource(BaseFuelSource):
    name = "carbu"
    countries = ("BE",)

    def fetch(self) -> list[StationRecord]:
        s = self.settings
        http = PoliteClient(s.user_agent, s.http_timeout_s, max(s.request_delay_s, 1.5))
        merged: dict[str, StationRecord] = {}
        try:
            for town in s.carbu_towns:
                try:
                    locs = http.get_json(LOCATION_URL, {"location": town, "SHRT": 1})
                    loc = next((l for l in locs if l.get("c") == "BE"), None)
                    if not loc:
                        self.log.warning("carbu: geen BE-locatie voor %r", town)
                        continue
                except Exception as exc:  # noqa: BLE001 - één gemeente mag de rest niet breken
                    self.log.warning("carbu: locatie %r mislukt: %s", town, exc)
                    continue
                for code, fuel in FUEL_CODES.items():
                    url = LIST_URL.format(fuel=code, town=loc["n"], pc=loc["pc"], loc_id=loc["id"])
                    try:
                        page = http.get_text(url)
                    except Exception as exc:  # noqa: BLE001
                        self.log.warning("carbu: %s/%s mislukt: %s", town, code, exc)
                        continue
                    found = parse_list(page, fuel)
                    self.log.debug("carbu: %s %s -> %d pompen", town, code, len(found))
                    for st in found:
                        cur = merged.setdefault(st.source_id, st)
                        if cur is not st:
                            have = {p.fuel for p in cur.prices}
                            cur.prices.extend(p for p in st.prices if p.fuel not in have)
        finally:
            http.close()
        return list(merged.values())
