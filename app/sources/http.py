"""HTTP zonder extra pakketten (urllib): vaste User-Agent, timeouts, retries met backoff en rate-limiting."""
from __future__ import annotations

import gzip
import json
import logging
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

log = logging.getLogger("http")


class HTTPError(Exception):
    def __init__(self, msg: str, status: int | None = None) -> None:
        super().__init__(msg)
        self.status = status


def request(url: str, params: dict[str, Any] | None = None, headers: dict[str, str] | None = None,
            timeout: float = 20, body: Any = None) -> bytes:
    """Eén verzoek (GET, of POST met JSON-body). Gooit HTTPError."""
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    h = {"Accept-Encoding": "gzip", **(headers or {})}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            if r.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
            return raw
    except urllib.error.HTTPError as exc:
        raise HTTPError(f"HTTP {exc.code} {url[:120]}", exc.code) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise HTTPError(f"netwerkfout {url[:120]}: {exc}") from exc


def get_json(url: str, params: dict[str, Any] | None = None, headers: dict[str, str] | None = None,
             timeout: float = 20) -> Any:
    return json.loads(request(url, params, headers, timeout))


def post_json(url: str, body: Any, headers: dict[str, str] | None = None, timeout: float = 20) -> Any:
    return json.loads(request(url, None, headers, timeout, body))


class PoliteClient:
    def __init__(self, user_agent: str, timeout_s: float = 20, delay_s: float = 1.0, retries: int = 3,
                 extra_headers: dict[str, str] | None = None) -> None:
        self.headers = {
            "User-Agent": user_agent,
            "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
            "Accept-Language": "nl,en;q=0.8,de;q=0.6,fr;q=0.5",
            **(extra_headers or {}),
        }
        self.timeout = timeout_s
        self.delay_s = delay_s
        self.retries = retries
        self._last = 0.0

    def _wait(self) -> None:
        gap = time.monotonic() - self._last
        if gap < self.delay_s:
            time.sleep(self.delay_s - gap)
        self._last = time.monotonic()

    def get(self, url: str, params: dict[str, Any] | None = None) -> bytes:
        """GET met retries op netwerkfouten, 429 en 5xx."""
        last_exc: HTTPError | None = None
        for attempt in range(1, self.retries + 1):
            self._wait()
            try:
                return request(url, params, self.headers, self.timeout)
            except HTTPError as exc:
                last_exc = exc
                if exc.status is not None and 400 <= exc.status < 500 and exc.status != 429:
                    break  # client-fout: niet opnieuw proberen
                if attempt == self.retries:
                    break
                backoff = (2 ** attempt) + random.random()
                log.warning("GET mislukt (poging %d/%d): %s — wacht %.1fs", attempt, self.retries, exc, backoff)
                time.sleep(backoff)
        assert last_exc is not None
        raise last_exc

    def get_json(self, url: str, params: dict[str, Any] | None = None) -> Any:
        return json.loads(self.get(url, params))

    def get_text(self, url: str, params: dict[str, Any] | None = None) -> str:
        return self.get(url, params).decode("utf-8", errors="replace")

    def close(self) -> None:
        pass
