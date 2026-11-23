"""Ingestie-pipeline: alle bronnen ophalen, valideren en in SQLite zetten.

Gebruik:
  python -m app.ingest                     # alle bronnen, opslaan
  python -m app.ingest --dry-run --debug   # alleen tonen wat binnenkomt, niets opslaan
  python -m app.ingest --source carbu      # één bron
"""
from __future__ import annotations

import argparse
import json
import logging
import statistics
import sys
import time
from collections import defaultdict

from . import db
from .config import Settings, settings
from .fuels import price_ok
from .geo import haversine_km, valid_coord
from .sources import REGISTRY, StationRecord

log = logging.getLogger("ingest")

MAX_PRICE_AGE_S = 30 * 86400      # bronprijs ouder dan 30 dagen = weggooien
OUTLIER_FRACTION = 0.35           # >35% van de mediaan per brandstof af = outlier


def validate(records: list[StationRecord], s: Settings, now: float) -> tuple[list[StationRecord], int]:
    """Filtert ongeldige stations/prijzen. Geeft (geldige stations, aantal afgekeurde prijzen+stations)."""
    rejected = 0
    kept: list[StationRecord] = []
    for st in records:
        if not valid_coord(st.lat, st.lon) or haversine_km(s.anchor_lat, s.anchor_lon, st.lat, st.lon) > s.region_radius_km + 5:
            rejected += 1
            continue
        kept.append(st)

    # Mediaan per brandstof over deze run voor outlier-detectie.
    by_fuel: dict[str, list[float]] = defaultdict(list)
    for st in kept:
        for p in st.prices:
            if price_ok(p.fuel, p.price):
                by_fuel[p.fuel].append(p.price)
    medians = {f: statistics.median(v) for f, v in by_fuel.items() if len(v) >= 5}

    for st in kept:
        good = []
        for p in st.prices:
            if not price_ok(p.fuel, p.price):
                rejected += 1
                continue
            med = medians.get(p.fuel)
            if med and abs(p.price - med) / med > OUTLIER_FRACTION:
                log.debug("outlier: %s %s %.3f (mediaan %.3f)", st.name, p.fuel, p.price, med)
                rejected += 1
                continue
            if p.updated_at is not None:
                if p.updated_at > now + 3600:
                    p.updated_at = now            # klok/tijdzone-fout bron: begrenzen
                elif now - p.updated_at > MAX_PRICE_AGE_S:
                    rejected += 1
                    continue
            good.append(p)
        st.prices = good
    return kept, rejected


def store(con, records: list[StationRecord], now: float) -> int:
    n = 0
    for st in records:
        con.execute(
            """INSERT INTO stations(id,source,name,brand,address,city,country,lat,lon,seen_at,hours)
               VALUES(?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET name=excluded.name, brand=excluded.brand, address=excluded.address,
                 city=excluded.city, country=excluded.country, lat=excluded.lat, lon=excluded.lon, seen_at=excluded.seen_at,
                 hours=COALESCE(excluded.hours, stations.hours)""",
            (st.id, st.source, st.name, st.brand, st.address, st.city, st.country, st.lat, st.lon, now,
             json.dumps(st.hours) if st.hours else None),
        )
        for p in st.prices:
            upd = p.updated_at or now
            # Alleen overschrijven als de nieuwe prijs niet ouder is dan wat er al staat.
            con.execute(
                """INSERT INTO prices(station_id,fuel,price,updated_at,fetched_at) VALUES(?,?,?,?,?)
                   ON CONFLICT(station_id,fuel) DO UPDATE SET price=excluded.price, updated_at=excluded.updated_at,
                     fetched_at=excluded.fetched_at WHERE excluded.updated_at >= prices.updated_at""",
                (st.id, p.fuel, p.price, upd, now),
            )
            con.execute(
                """INSERT INTO price_history(station_id,fuel,day,price,updated_at)
                   VALUES(?,?,date(?,'unixepoch','localtime'),?,?)
                   ON CONFLICT(station_id,fuel,day) DO UPDATE SET price=excluded.price, updated_at=excluded.updated_at
                     WHERE excluded.updated_at >= price_history.updated_at""",
                (st.id, p.fuel, upd, p.price, upd),
            )
            n += 1
    return n


def run(source_names: list[str] | None = None, dry_run: bool = False, s: Settings = settings) -> int:
    names = source_names or s.enabled_sources
    failures = 0
    con = None if dry_run else db.connect(s.db_path)
    for name in names:
        cls = REGISTRY.get(name)
        if not cls:
            log.error("onbekende bron %r (beschikbaar: %s)", name, ", ".join(REGISTRY))
            failures += 1
            continue
        src = cls(s)
        ok, why = src.enabled()
        if not ok:
            log.warning("bron %s overgeslagen: %s", name, why)
            continue
        started = time.time()
        run_id = None
        if con:
            run_id = con.execute("INSERT INTO runs(started_at,source) VALUES(?,?)", (started, name)).lastrowid
            con.commit()
        try:
            raw = src.fetch()
            now = time.time()
            recs, rejected = validate(raw, s, now)
            n_prices = sum(len(r.prices) for r in recs)
            log.info("%s: %d stations, %d prijzen, %d afgekeurd (%.1fs)", name, len(recs), n_prices, rejected, now - started)
            if dry_run:
                _print_table(name, recs)
            else:
                assert con is not None
                stored = store(con, recs, now)
                con.execute("UPDATE runs SET finished_at=?, ok=1, stations=?, prices=?, rejected=? WHERE id=?",
                            (time.time(), len(recs), stored, rejected, run_id))
                con.commit()
        except Exception as exc:  # noqa: BLE001 - één bron mag de pipeline niet stoppen
            failures += 1
            log.exception("bron %s mislukt: %s (oude prijzen blijven staan)", name, exc)
            if con:
                con.rollback()
                con.execute("UPDATE runs SET finished_at=?, ok=0, error=? WHERE id=?", (time.time(), str(exc)[:500], run_id))
                con.commit()
    if con:
        store_region_stats(con, time.time())
        con.close()
    return 1 if failures == len(names) else 0


def region_averages(prices: list[tuple[str, float]]) -> dict[str, tuple[float, int]]:
    """[(brandstof, prijs)] → {brandstof: (gemiddelde, aantal)}; alleen brandstoffen met ≥ 5 pompen."""
    by: dict[str, list[float]] = defaultdict(list)
    for fuel, price in prices:
        by[fuel].append(price)
    return {f: (round(statistics.mean(v), 4), len(v)) for f, v in by.items() if len(v) >= 5}


def store_region_stats(con, now: float) -> None:
    """Regiogemiddelde van de prijzen die deze run (laatste 2 u) zijn opgehaald → region_stats."""
    rows = con.execute("SELECT fuel, price FROM prices WHERE fetched_at >= ?", (now - 7200,)).fetchall()
    for fuel, (avg, n) in region_averages([(r["fuel"], r["price"]) for r in rows]).items():
        con.execute("INSERT OR REPLACE INTO region_stats(t,fuel,avg,n) VALUES(?,?,?,?)", (round(now), fuel, avg, n))
    con.commit()


def _print_table(name: str, recs: list[StationRecord]) -> None:
    print(f"\n=== {name}: {len(recs)} stations ===")
    for r in sorted(recs, key=lambda r: (r.country, r.city or "", r.name)):
        prices = "  ".join(f"{p.fuel}={p.price:.3f}" + ("" if p.updated_at is None else time.strftime("@%d-%m", time.localtime(p.updated_at)))
                           for p in sorted(r.prices, key=lambda p: p.fuel))
        print(f"  [{r.country}] {r.name[:34]:34} {(r.city or '')[:16]:16} {r.lat:.4f},{r.lon:.4f}  {prices or '— geen prijs'}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Brandstofprijzen ophalen en opslaan")
    ap.add_argument("--source", action="append", help=f"bron(nen): {', '.join(REGISTRY)} (standaard: SOURCES uit .env)")
    ap.add_argument("--dry-run", action="store_true", help="niets opslaan, alleen tonen")
    ap.add_argument("--debug", action="store_true", help="uitgebreide logging")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if a.debug else getattr(logging, settings.log_level.upper(), logging.INFO),
                        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s", stream=sys.stderr)
    if not a.debug:
        logging.getLogger("httpx").setLevel(logging.WARNING)
    return run(a.source, a.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
