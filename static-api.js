// Statische versie (GitHub Pages): handelt de /api/*-aanroepen van app.js af in de browser.
// Prijzen komen uit data/prices.json (3× per dag ververst door GitHub Actions), routes van OSRM,
// adressen van Photon, files van de Autobahn-API (alle drie met CORS). Rekenregels = app/search.py.
// Alleen actief als de pagina window.BR_STATIC zet (gedaan door deploy/build_site.py).
(() => {
  if (!window.BR_STATIC) return;
  const OSRM = "https://router.project-osrm.org", PHOTON = "https://photon.komoot.io/api/";
  const DEFAULTS = { address: "Heerlen", tank_l: 45, consumption: 6.5, radius_km: 35, fuel: "euro95" };
  const DEDUPE_M = 80, LOCAL_RADIUS_KM = 5, NEAREST_EXTRA = 15, AIR_KMH = 70, VIA_CANDIDATES = 25, ROUTING_CANDIDATES = 40;
  const PRIORITY = { BE: { carbu: 0, anwb: 1 }, DE: { tankerkoenig: 0, anwb: 1 }, NL: { anwb: 0 } };
  const realFetch = window.fetch.bind(window);
  const dataUrl = (f) => new URL("data/" + f, document.baseURI).href;
  const err = (status, msg) => Object.assign(new Error(msg), { status });
  const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;

  const hav = (lat1, lon1, lat2, lon2) => {
    const rad = Math.PI / 180, p1 = lat1 * rad, p2 = lat2 * rad, dp = p2 - p1, dl = (lon2 - lon1) * rad;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * 6371.0088 * Math.asin(Math.sqrt(a));
  };

  // ---------- Data (in geheugen, na 20 min opnieuw ophalen) ----------
  const cached = {};
  const getJson = async (name) => {
    const c = cached[name];
    if (c && Date.now() - c.t < 20 * 60 * 1000) return c.p;
    const p = realFetch(dataUrl(name), { cache: "no-cache" }).then((r) => { if (!r.ok) throw err(503, `${name} niet bereikbaar`); return r.json(); });
    cached[name] = { t: Date.now(), p };
    p.catch(() => delete cached[name]);
    return p;
  };
  const prices = () => getJson("prices.json");

  // ---------- Adressen (Photon) ----------
  const label = (p) => {
    const street = [p.street || p.name, p.housenumber].filter(Boolean).join(" ");
    const town = [p.postcode, p.city || p.town || p.village].filter(Boolean).join(" ");
    return [street, town, p.countrycode].filter(Boolean).join(", ");
  };
  async function photon(q, limit, anchor) {
    const u = new URL(PHOTON);
    u.search = new URLSearchParams({ q, limit, lat: anchor.lat, lon: anchor.lon });
    const d = await (await realFetch(u)).json();
    return (d.features || []).filter((f) => ["NL", "BE", "DE"].includes(f.properties?.countrycode))
      .map((f) => ({ label: label(f.properties), lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }));
  }
  const geoCache = new Map();
  async function geocode(q) {
    q = (q || "").trim();
    if (!q) throw err(404, "Leeg adres");
    const m = q.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (m) return { lat: +m[1], lon: +m[2], label: `${(+m[1]).toFixed(5)}, ${(+m[2]).toFixed(5)}` };
    const k = q.toLowerCase();
    if (!geoCache.has(k)) {
      const d = await prices();
      geoCache.set(k, photon(q, 3, d.anchor).then((h) => h[0] || null).catch(() => { geoCache.delete(k); throw err(503, "Adreszoeker niet bereikbaar"); }));
    }
    const hit = await geoCache.get(k);
    if (!hit) throw err(404, `Adres niet gevonden: ${q}`);
    return { ...hit };
  }
  async function suggest(q) {
    if ((q || "").trim().length < 3) return [];
    const d = await prices();
    const out = [];
    for (const h of await photon(q, 8, d.anchor)) if (h.label && !out.some((o) => o.label === h.label)) out.push(h);
    return out.slice(0, 6);
  }

  // ---------- Routing (OSRM; terugval: schatting) ----------
  const estimate = (a, b) => { const km = hav(a[0], a[1], b[0], b[1]) * 1.35; return { km, min: km / 55 * 60, method: "schatting" }; };
  const legCache = new Map();
  async function table(origin, dests) {
    const key = (d) => `${origin[0].toFixed(3)},${origin[1].toFixed(3)}>${d[0].toFixed(4)},${d[1].toFixed(4)}`;
    const missing = dests.map((d, i) => (legCache.has(key(d)) ? -1 : i)).filter((i) => i >= 0);
    for (let s = 0; s < missing.length; s += 90) {          // publieke OSRM: max ±100 punten per tabel
      const part = missing.slice(s, s + 90);
      try {
        const coords = [origin, ...part.map((i) => dests[i])].map(([la, lo]) => `${lo.toFixed(6)},${la.toFixed(6)}`).join(";");
        const d = await (await realFetch(`${OSRM}/table/v1/driving/${coords}?sources=0&annotations=duration,distance`)).json();
        if (d.code !== "Ok") throw new Error(d.code);
        part.forEach((i, j) => {
          const du = d.durations[0][j + 1], di = d.distances[0][j + 1];
          if (du != null && di != null) legCache.set(key(dests[i]), { km: di / 1000, min: du / 60, method: "osrm" });
        });
      } catch (e) { console.warn("OSRM-tabel mislukt", e); }
    }
    return dests.map((d) => legCache.get(key(d)) || estimate(origin, d));
  }

  // Ritopbouw per land + wegtype (= app/trip.py).
  const NL = [[5.64, 50.75], [6.02, 50.75], [6.03, 50.80], [6.08, 50.85], [6.07, 50.91], [6.00, 50.93], [5.92, 50.98],
    [5.87, 51.05], [6.00, 51.10], [6.17, 51.18], [6.08, 51.25], [6.20, 51.40], [6.10, 51.60], [5.00, 51.60],
    [5.10, 51.42], [5.50, 51.30], [5.80, 51.15], [5.78, 51.05], [5.75, 50.97], [5.70, 50.90], [5.64, 50.85]];
  const LIMITS = { NL: { snelweg: 100, buitenweg: 80, bebouwd: 50 }, BE: { snelweg: 120, buitenweg: 70, bebouwd: 50 }, DE: { snelweg: 130, buitenweg: 100, bebouwd: 50 } };
  const NOTES = { "NL/snelweg": "06–19 u; daarna vaak 130", "DE/snelweg": "geen limiet, advies 130", "BE/buitenweg": "Wallonië 90" };
  function country(lat, lon) {
    let inside = false;
    for (let i = 0, j = NL.length - 1; i < NL.length; j = i++) {
      const [xi, yi] = NL[i], [xj, yj] = NL[j];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return "NL";
    return lon >= 6.03 || (lat > 50.95 && lon > 5.9) ? "DE" : "BE";
  }
  function roadType(st) {
    const classes = new Set((st.intersections || []).flatMap((x) => x.classes || []));
    const ref = (st.ref || "").toUpperCase(), kmh = st.duration ? st.distance / st.duration * 3.6 : 0;
    if (classes.has("motorway") || (/^[AE]/.test(ref) && kmh > 60)) return "snelweg";
    if (/^[NBLK]/.test(ref) || kmh > 55) return "buitenweg";
    return "bebouwd";
  }
  function breakdown(steps) {
    const acc = new Map();
    for (const st of steps) {
      if (!st.distance) continue;
      const [lon, lat] = st.maneuver.location, c = country(lat, lon), t = roadType(st), k = c + "/" + t;
      if (!acc.has(k)) acc.set(k, { country: c, type: t, limit: LIMITS[c][t], note: NOTES[k] || "", km: 0, min: 0, roads: [] });
      const row = acc.get(k);
      row.km += st.distance / 1000; row.min += st.duration / 60;
      const name = st.ref || st.name;
      if (name && !row.roads.includes(name) && row.roads.length < 4) row.roads.push(name.split(";")[0]);
    }
    return [...acc.values()].map((r) => ({ ...r, km: r2(r.km), min: r2(r.min), avg_kmh: r.min ? Math.round(r.km / (r.min / 60)) : 0, min_at_limit: r2(r.km / r.limit * 60) }));
  }
  async function route(q) {
    const a = [+q.from_lat, +q.from_lon], b = [+q.to_lat, +q.to_lon];
    try {
      const d = await (await realFetch(`${OSRM}/route/v1/driving/${a[1]},${a[0]};${b[1]},${b[0]}?overview=full&geometries=geojson&steps=true`)).json();
      const rt = d.routes[0];
      return { geometry: rt.geometry, km: rt.distance / 1000, min: rt.duration / 60, method: "osrm", parts: breakdown(rt.legs.flatMap((l) => l.steps || [])) };
    } catch {
      const e = estimate(a, b);
      return { geometry: { type: "LineString", coordinates: [[a[1], a[0]], [b[1], b[0]]] }, km: e.km, min: e.min, method: "schatting", parts: [] };
    }
  }

  // ---------- Zoeken (= app/search.py) ----------
  function load(d, fuel, lat, lon, radius) {
    const now = Date.now() / 1000, out = [];
    for (const s of d.stations) {
      const p = s.p[fuel];
      if (!p) continue;
      const air = hav(lat, lon, s.lat, s.lon);
      if (air > radius) continue;
      out.push({ id: s.id, source: s.source, name: s.name, brand: s.brand, address: s.address, city: s.city, country: s.country,
        lat: s.lat, lon: s.lon, price: p[0], updated_at: p[1], prev_price: p[2], hours: s.hours,
        stale: now - p[1] > d.stale_after_h * 3600, air_km: r2(air), km: 0, min: 0, km_return: 0, route_method: "",
        offer: null, is_reference: false, also_in: [] });
    }
    return out;
  }
  function dedupe(items) {
    const rank = (r) => [PRIORITY[r.country]?.[r.source] ?? 9, -r.updated_at];
    const kept = [];
    for (const r of [...items].sort((a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1]; })) {
      const dup = kept.find((k) => k.country === r.country && hav(k.lat, k.lon, r.lat, r.lon) * 1000 < DEDUPE_M);
      if (dup) { if (r.source !== dup.source && !dup.also_in.includes(r.source)) dup.also_in.push(r.source); } else kept.push(r);
    }
    return kept;
  }
  function offer(grossPerL, tank, detourKm, extraMin, cons, price, eurH) {
    const gross = grossPerL * tank;
    detourKm = Math.max(0, detourKm); extraMin = Math.max(0, extraMin);
    const detourCost = detourKm * cons / 100 * price, timeCost = extraMin / 60 * eurH, net = gross - detourCost - timeCost;
    const perMin = extraMin >= 1 ? net / extraMin : null, cost = detourCost + timeCost;
    const be = grossPerL > 0 && cost > 0 ? cost / grossPerL : null;
    return { gross_eur: r2(gross), detour_km: r1(detourKm), detour_cost_eur: r2(detourCost), time_cost_eur: r2(timeCost), net_eur: r2(net),
      extra_min: r1(extraMin), net_per_min: perMin == null ? null : r2(perMin), breakeven_l: be == null ? null : r1(be) };
  }
  const num = (q, k, def, lo, hi) => {
    if (q[k] == null || q[k] === "") return def;
    const f = Number(q[k]);
    if (!Number.isFinite(f)) throw err(400, `${k} moet een getal zijn`);
    if (f < lo || f > hi) throw err(400, `${k} moet tussen ${lo} en ${hi} liggen`);
    return f;
  };

  async function search(q) {
    const d = await prices();
    const fuel = q.fuel || "euro95";
    if (!d.fuels[fuel]) throw err(400, `Onbekende brandstof ${fuel}`);
    const place = await geocode(q.q);
    if (q.label && /^[\d.,\- ]+$/.test(q.q)) place.label = q.label.slice(0, 200);
    let dest = null, destPlace = null;
    if ((q.dest || "").trim()) {
      try { destPlace = await geocode(q.dest); } catch (e) { throw err(404, `Bestemming: ${e.message}`); }
      dest = [destPlace.lat, destPlace.lon];
    }
    const tank = num(q, "tank_l", DEFAULTS.tank_l, 1, 200), cons = num(q, "consumption", DEFAULTS.consumption, 1, 40);
    const radius = num(q, "radius_km", DEFAULTS.radius_km, 1, 80), maxMin = num(q, "max_min", null, 1, 240);
    const eurH = num(q, "time_eur_h", 0, 0, 500), refPrice = num(q, "ref_price", null, 0.1, 5);
    const reference = q.reference || "nearest", refId = q.ref_id || null, o = [place.lat, place.lon];

    let items = dedupe(load(d, fuel, place.lat, place.lon, radius));
    const count = items.length;
    if (maxMin != null) items = items.filter((i) => i.air_km <= maxMin / 60 * AIR_KMH);
    const out = { results: [], reference: null, count, via: null, fuel, origin: place };
    if (destPlace) out.dest = destPlace;
    if (!items.length) return out;

    const byAir = [...items].sort((a, b) => a.air_km - b.air_km);
    const cheapest = [...items].sort((a, b) => a.price - b.price).slice(0, ROUTING_CANDIDATES);
    const mine = reference === "station" ? items.find((i) => i.id === refId) : null;
    const cands = [...new Map([...cheapest, ...byAir.slice(0, NEAREST_EXTRA), ...(mine ? [mine] : [])].map((i) => [i.id, i])).values()];
    (await table(o, cands.map((i) => [i.lat, i.lon]))).forEach((leg, j) => {
      const i = cands[j];
      i.km = r1(leg.km); i.min = r1(leg.min); i.km_return = r1(2 * leg.km); i.route_method = leg.method;
    });
    const nearest = cands.reduce((a, b) => (b.min < a.min ? b : a));
    const base = mine || nearest, ref = { mode: reference, km: base.km, min: base.min };
    if (mine) { Object.assign(ref, { price: mine.price, label: `mijn pomp: ${mine.name}`, station_id: mine.id }); mine.is_reference = true; }
    else if (reference === "custom" && refPrice) Object.assign(ref, { price: refPrice, label: "eigen referentieprijs" });
    else if (reference === "local_avg") {
      const local = items.filter((i) => i.air_km <= LOCAL_RADIUS_KM).map((i) => i.price);
      if (!local.length) local.push(nearest.price);
      Object.assign(ref, { price: Math.round(local.reduce((a, b) => a + b, 0) / local.length * 1000) / 1000, label: `gemiddelde van ${local.length} pomp(en) binnen ${LOCAL_RADIUS_KM} km` });
    } else {
      if (reference === "station") { ref.mode = "nearest"; ref.missing = true; }
      Object.assign(ref, { price: nearest.price, label: `dichtstbijzijnde pomp: ${nearest.name}`, station_id: nearest.id });
      nearest.is_reference = true;
    }
    for (const i of cands) i.offer = offer(ref.price - i.price, tank, 2 * (i.km - base.km), 2 * (i.min - base.min), cons, i.price, eurH);
    out.results = (maxMin != null ? cands.filter((i) => i.min <= maxMin) : cands).sort((a, b) => b.offer.net_eur - a.offer.net_eur);
    out.reference = ref; out.routed = cands.length;
    if (dest) out.via = await via(d, fuel, o, dest, ref.price, tank, cons, eurH, maxMin, radius);
    return out;
  }

  async function via(d, fuel, o, dest, refPrice, tank, cons, eurH, maxMin, radius) {
    const direct = hav(o[0], o[1], dest[0], dest[1]), mid = [(o[0] + dest[0]) / 2, (o[1] + dest[1]) / 2];
    const items = dedupe(load(d, fuel, mid[0], mid[1], direct / 2 + Math.max(5, radius / 3)));
    const [base] = await table(o, [dest]);
    const res = { km: r1(base.km), min: r1(base.min), results: [] };
    if (!items.length) return res;
    const air = (i) => hav(o[0], o[1], i.lat, i.lon) + hav(i.lat, i.lon, dest[0], dest[1]) - direct;
    const cands = [...items].sort((a, b) => air(a) - air(b)).slice(0, VIA_CANDIDATES);
    const pts = cands.map((i) => [i.lat, i.lon]);
    const [toS, sToD] = await Promise.all([table(o, pts), table(dest, pts)]);
    cands.forEach((i, j) => {
      const a = toS[j], b = sToD[j], extra = a.min + b.min - base.min;
      i.km = r1(a.km); i.min = r1(a.min); i.km_return = r1(a.km + b.km); i.route_method = a.method;
      if (maxMin != null && extra > maxMin) return;
      i.offer = offer(refPrice - i.price, tank, a.km + b.km - base.km, extra, cons, i.price, eurH);
      res.results.push(i);
    });
    res.results.sort((a, b) => b.offer.net_eur - a.offer.net_eur);
    res.results = res.results.slice(0, 10);
    return res;
  }

  // ---------- Verkeer (Autobahn-API, = app/traffic.py) ----------
  const HOTSPOTS = [
    { name: "Knooppunt Kerensheide (A2/A76)", lat: 50.9440, lon: 5.8790 },
    { name: "A2 Maastricht – Kruisdonk", lat: 50.8530, lon: 5.7170 },
    { name: "Knooppunt Kunderberg / Buitenring Parkstad", lat: 50.8840, lon: 5.9300 },
    { name: "A76 grens Bocholtz – Aken (Vetschau)", lat: 50.8440, lon: 6.0300 },
    { name: "Kreuz Aachen (A4/A44)", lat: 50.8150, lon: 6.1650 },
    { name: "N78 Lanaken – Maastricht (Maasbrug)", lat: 50.8930, lon: 5.6750 },
    { name: "Knooppunt Het Vonderen / A2 Roermond", lat: 51.1550, lon: 5.9600 },
  ];
  const PEAKS = [[7, 9.5], [16, 18.5]], SERVICES = { warning: "melding", closure: "afsluiting", roadworks: "wegwerk" };
  async function traffic() {
    const incidents = [];
    await Promise.all(["A4", "A44", "A544", "A61"].flatMap((road) => Object.entries(SERVICES).map(async ([svc, lbl]) => {
      try {
        const d = await (await realFetch(`https://verkehr.autobahn.de/o/autobahn/${road}/services/${svc}`)).json();
        for (const it of d[svc] || []) {
          const lat = +it.coordinate?.lat, lon = +it.coordinate?.long;
          if (!Number.isFinite(lat) || it.future || lat < 50.55 || lat > 51.30 || lon < 5.40 || lon > 6.60) continue;
          incidents.push({ kind: svc, label: lbl, lat, lon, blocked: it.isBlocked === "true", title: (it.title || "").trim(), sub: (it.subtitle || "").trim(),
            text: (it.description || []).filter((x) => x.trim()).slice(0, 6).join(" · "), source: "Autobahn GmbH" });
        }
      } catch { /* één weg mag ontbreken */ }
    })));
    return { incidents, hotspots: HOTSPOTS, peaks: PEAKS, fetched_at: Date.now() / 1000 };
  }

  // ---------- Overige endpoints ----------
  async function config() {
    const d = await prices();
    return { version: d.version, fuels: d.fuels, defaults: DEFAULTS, anchor: d.anchor, static: true };
  }
  async function health() {
    const d = await prices(), n = {};
    for (const s of d.stations) n[s.country] = (n[s.country] || 0) + 1;
    return { ok: true, version: d.version, now: Date.now() / 1000, generated_at: d.generated_at, sources: d.sources,
      stations_with_price: n, recent_errors: (d.errors || []).map((e) => ({ source: e.source, finished_at: e.t, error: e.error })) };
  }
  async function stats(q) {
    const s = await getJson("stats.json");
    return { fuel: q.fuel, series: s.series?.[q.fuel || "euro95"] || [] };
  }

  const ROUTES = {
    "/api/config": config, "/api/health": health, "/api/search": search, "/api/route": route, "/api/stats": stats,
    "/api/suggest": (q) => suggest(q.q), "/api/geocode": (q) => geocode(q.q), "/api/traffic": traffic,
    "/api/clientlog": (q) => { console.warn("clientlog:", q.msg); return { ok: true }; },
  };
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input?.url || String(input);
    if (!url.startsWith("/api/")) return realFetch(input, init);
    const u = new URL(url, location.origin), fn = ROUTES[u.pathname];
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (!fn) return Promise.resolve(json(404, { detail: "Niet gevonden" }));
    return Promise.resolve().then(() => fn(Object.fromEntries(u.searchParams))).then((d) => json(200, d),
      (e) => json(e.status || 500, { detail: e.message || String(e) }));
  };

  // PWA: service worker voor offline gebruik (laatste lijst + app-schil).
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
