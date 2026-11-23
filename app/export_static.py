"""Prijzen ophalen en als JSON-bestanden wegschrijven voor de statische site (GitHub Pages).

Gebruik (in GitHub Actions, 3× per dag):
  python -m app.export_static --out data

Schrijft:
  data/prices.json  alle pompen in de regio Heerlen met laatst bekende geldige prijs per brandstof
                    (+ prijs van een eerdere dag voor de trend en openingstijden)
  data/stats.json   regiogemiddelde per brandstof per ophaalmoment, laatste 8 weken ("nu of later tanken")

Zelfde bronnen en validatie als de lokale versie (app/sources + ingest.validate). Een mislukte bron laat de
vorige prijzen staan: het vorige prices.json wordt ingelezen en alleen aangevuld met nieuwere prijzen.
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from .config import APP_VERSION, settings
from .fuels import FUELS
from .ingest import region_averages, validate
from .sources import REGISTRY

log = logging.getLogger("export")
TZ = ZoneInfo("Europe/Amsterdam")
DROP_AFTER_S = 30 * 86400      # pomp 30 dagen niet meer gezien → uit het bestand
STATS_KEEP_S = 56 * 86400


def _day(ts: float) -> str:
    return datetime.fromtimestamp(ts, TZ).strftime("%Y-%m-%d")


def _read(path: Path, empty: dict) -> dict:
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return empty


def merge(old: dict, records: list, now: float) -> dict:
    """Nieuwe stationrecords over de vorige stand heen leggen. Geeft {id: station}."""
    stations = {s["id"]: s for s in old.get("stations", [])}
    for st in records:
        prev = stations.get(st.id, {})
        p = dict(prev.get("p", {}))
        for pr in st.prices:
            upd = pr.updated_at or now
            o = p.get(pr.fuel)                       # [prijs, bijgewerkt, prijs eerdere dag]
            if o and upd < o[1]:
                continue                             # nooit overschrijven met een oudere prijs
            prev_day = None
            if o:
                prev_day = o[0] if _day(o[1]) != _day(upd) else o[2]
            p[pr.fuel] = [round(pr.price, 3), round(upd), prev_day]
        stations[st.id] = {
            "id": st.id, "source": st.source, "name": st.name, "brand": st.brand, "address": st.address,
            "city": st.city, "country": st.country, "lat": round(st.lat, 5), "lon": round(st.lon, 5),
            "hours": st.hours or prev.get("hours"), "seen": round(now), "p": p,
        }
    return {k: v for k, v in stations.items() if v.get("p") and now - v.get("seen", now) <= DROP_AFTER_S}


def run(out: Path) -> int:
    out.mkdir(parents=True, exist_ok=True)
    old = _read(out / "prices.json", {})
    stats = _read(out / "stats.json", {"series": {}})
    sources = dict(old.get("sources", {}))
    errors: list[dict] = []
    fresh: list = []
    for name in settings.enabled_sources:
        src = REGISTRY[name](settings)
        ok, why = src.enabled()
        if not ok:
            log.info("bron %s overgeslagen: %s", name, why)
            continue
        try:
            recs, rejected = validate(src.fetch(), settings, time.time())
            log.info("%s: %d stations, %d afgekeurd", name, len(recs), rejected)
            fresh.extend(recs)
            sources[name] = round(time.time())
        except Exception as exc:  # noqa: BLE001 - één bron mag de rest niet stoppen
            log.exception("bron %s mislukt (vorige prijzen blijven staan)", name)
            errors.append({"source": name, "t": round(time.time()), "error": str(exc)[:300]})
    now = time.time()
    if not fresh:
        log.error("geen enkele bron gaf prijzen; bestanden blijven ongewijzigd")
        return 1
    stations = merge(old, fresh, now)
    (out / "prices.json").write_text(json.dumps({
        "version": APP_VERSION, "generated_at": round(now), "region": "Heerlen",
        "anchor": {"lat": settings.anchor_lat, "lon": settings.anchor_lon}, "radius_km": settings.region_radius_km,
        "stale_after_h": settings.stale_after_h, "fuels": FUELS, "sources": sources, "errors": errors,
        "stations": sorted(stations.values(), key=lambda s: s["id"]),
    }, ensure_ascii=False, separators=(",", ":")), "utf-8")

    series = stats.get("series", {})
    avgs = region_averages([(p.fuel, p.price) for st in fresh for p in st.prices])
    for fuel, (avg, n) in avgs.items():
        series.setdefault(fuel, []).append([round(now), avg, n])
    for fuel in series:
        series[fuel] = [r for r in series[fuel] if now - r[0] <= STATS_KEEP_S]
    (out / "stats.json").write_text(json.dumps({"series": series}, separators=(",", ":")), "utf-8")
    log.info("%d pompen weggeschreven naar %s", len(stations), out)
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Prijzen ophalen → JSON voor de statische site")
    ap.add_argument("--out", default="data", help="uitvoermap (standaard: data)")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s", stream=sys.stderr)
    return run(Path(a.out))


if __name__ == "__main__":
    raise SystemExit(main())
