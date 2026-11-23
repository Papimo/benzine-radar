"""SQLite-opslag: stations, prijzen (laatst bekende geldige), caches en run-log."""
from __future__ import annotations

import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from .config import settings

SCHEMA = """
CREATE TABLE IF NOT EXISTS stations (
    id          TEXT PRIMARY KEY,          -- '<bron>:<bron-id>'
    source      TEXT NOT NULL,
    name        TEXT NOT NULL,
    brand       TEXT,
    address     TEXT,
    city        TEXT,
    country     TEXT NOT NULL,             -- NL / BE / DE
    lat         REAL NOT NULL,
    lon         REAL NOT NULL,
    seen_at     REAL NOT NULL              -- laatste keer gezien in een run (epoch)
);
CREATE INDEX IF NOT EXISTS ix_stations_latlon ON stations(lat, lon);

-- Eén rij per station+brandstof: de laatst bekende GELDIGE prijs.
-- Een mislukte run overschrijft niets, dus oude prijzen blijven met hun tijdstempel staan.
CREATE TABLE IF NOT EXISTS prices (
    station_id  TEXT NOT NULL REFERENCES stations(id),
    fuel        TEXT NOT NULL,
    price       REAL NOT NULL,
    updated_at  REAL NOT NULL,             -- prijsdatum volgens bron, anders ophaalmoment
    fetched_at  REAL NOT NULL,
    PRIMARY KEY (station_id, fuel)
);

-- Prijsgeschiedenis: laatste geldige prijs per pomp+brandstof per (lokale) dag, voor de trend t.o.v. gisteren.
CREATE TABLE IF NOT EXISTS price_history (
    station_id  TEXT NOT NULL,
    fuel        TEXT NOT NULL,
    day         TEXT NOT NULL,             -- YYYY-MM-DD lokaal
    price       REAL NOT NULL,
    updated_at  REAL NOT NULL,
    PRIMARY KEY (station_id, fuel, day)
);
INSERT OR IGNORE INTO price_history(station_id, fuel, day, price, updated_at)
    SELECT station_id, fuel, date(updated_at, 'unixepoch', 'localtime'), price, updated_at FROM prices;

CREATE TABLE IF NOT EXISTS geocode_cache (
    query       TEXT PRIMARY KEY,
    lat         REAL, lon REAL, label TEXT,
    created_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS route_cache (
    key         TEXT PRIMARY KEY,
    payload     TEXT NOT NULL,
    created_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  REAL NOT NULL,
    finished_at REAL,
    source      TEXT NOT NULL,
    ok          INTEGER NOT NULL DEFAULT 0,
    stations    INTEGER NOT NULL DEFAULT 0,
    prices      INTEGER NOT NULL DEFAULT 0,
    rejected    INTEGER NOT NULL DEFAULT 0,
    error       TEXT
);

-- Regiogemiddelde per brandstof per ophaalrun (voor "nu of later tanken": patroon per weekdag en dagdeel).
CREATE TABLE IF NOT EXISTS region_stats (
    t           REAL NOT NULL,
    fuel        TEXT NOT NULL,
    avg         REAL NOT NULL,
    n           INTEGER NOT NULL,
    PRIMARY KEY (t, fuel)
);
"""


def connect(path: Path | None = None) -> sqlite3.Connection:
    p = path or settings.db_path
    p.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(p, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")
    con.executescript(SCHEMA)
    if "hours" not in {r[1] for r in con.execute("PRAGMA table_info(stations)")}:
        con.execute("ALTER TABLE stations ADD COLUMN hours TEXT")   # openingstijden als JSON (v1.1)
    return con


@contextmanager
def session(path: Path | None = None) -> Iterator[sqlite3.Connection]:
    con = connect(path)
    try:
        yield con
        con.commit()
    finally:
        con.close()


# ---------- caches ----------

def cache_get(con: sqlite3.Connection, table: str, key: str, max_age_s: float) -> sqlite3.Row | None:
    col = "query" if table == "geocode_cache" else "key"
    row = con.execute(f"SELECT * FROM {table} WHERE {col}=?", (key,)).fetchone()
    if row and time.time() - row["created_at"] <= max_age_s:
        return row
    return None


def route_cache_get(con: sqlite3.Connection, key: str, max_age_s: float) -> Any | None:
    row = cache_get(con, "route_cache", key, max_age_s)
    return json.loads(row["payload"]) if row else None


def route_cache_put(con: sqlite3.Connection, key: str, payload: Any) -> None:
    con.execute(
        "INSERT OR REPLACE INTO route_cache(key,payload,created_at) VALUES(?,?,?)",
        (key, json.dumps(payload), time.time()),
    )
    con.commit()
