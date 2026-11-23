"""Normalisatie van brandstofnamen over landen heen.

Canonieke soorten:
  euro95  - Super 95 (in NL/BE is dit E10; in DE heet het 'Super E10')
  e5      - Super 95 E5 (vooral DE; in NL/BE nauwelijks nog als 95 verkocht)
  super98 - Super Plus 98 (E5)
  diesel  - Diesel B7
  lpg     - Autogas
"""
from __future__ import annotations

import re

FUELS: dict[str, str] = {
    "euro95": "Euro95 / E10",
    "e5": "Super E5 (95)",
    "super98": "Super 98",
    "diesel": "Diesel",
    "lpg": "LPG / Autogas",
}

# Volgorde telt: specifieker eerst.
_PATTERNS: list[tuple[str, str]] = [
    (r"diesel.*(special|premium|ultimate|excellium|v-power|plus|supreme)|diesel_special", "diesel_premium"),
    (r"\bdiesel\b|\bb7\b|^go$|gazole", "diesel"),
    (r"98|super ?plus|sp98|euro98", "super98"),
    (r"\be10\b|euro ?95|super ?95|^e10$", "euro95"),
    (r"\be5\b|super e5", "e5"),
    (r"lpg|autogas|gpl", "lpg"),
    (r"cng|erdgas", "cng"),
    (r"adblue", "adblue"),
]


def normalize(raw: str) -> str | None:
    """Zet een bronnaam (bv. 'Super 95 (E10)', 'EURO95', 'e10', 'GO') om naar een canonieke code."""
    s = raw.strip().lower()
    if not s:
        return None
    for pat, code in _PATTERNS:
        if re.search(pat, s):
            return code
    return None


# Realistische bandbreedte per liter (EUR). Daarbuiten = fout/outlier.
PRICE_BOUNDS: dict[str, tuple[float, float]] = {
    "lpg": (0.4, 1.8),
    "cng": (0.8, 3.5),
}
DEFAULT_BOUNDS = (1.0, 3.5)


def price_ok(fuel: str, price: float | None) -> bool:
    if price is None:
        return False
    lo, hi = PRICE_BOUNDS.get(fuel, DEFAULT_BOUNDS)
    return lo <= price <= hi
