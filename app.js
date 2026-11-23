// Benzine-radar frontend (vanilla JS + Leaflet). Kaart pas zichtbaar bij "Toon route".
(() => {
  const $ = (s) => document.querySelector(s);
  const fmtE = (v) => (v < 0 ? "−€ " : "€ ") + Math.abs(v).toFixed(2).replace(".", ",");
  const fmtN = (v, d = 1) => Number(v).toFixed(d).replace(".", ",");
  const ago = (ts) => {
    const h = (Date.now() / 1000 - ts) / 3600;
    if (h < 1) return `${Math.max(1, Math.round(h * 60))} min geleden`;
    if (h < 48) return `${Math.round(h)} uur geleden`;
    return `${Math.round(h / 24)} dagen geleden`;
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const store = {
    get: (k) => { try { return JSON.parse(localStorage.getItem("br:" + k)); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem("br:" + k, JSON.stringify(v)); } catch {} },
  };
  // Trend t.o.v. de laatste prijs van een eerdere dag (ct/L); stijgen = rood.
  const trend = (s) => {
    if (s.prev_price == null) return "";
    const d = Math.round((s.price - s.prev_price) * 1000) / 10;
    if (!d) return `<span class="tr eq" title="gelijk aan gisteren">=</span>`;
    return `<span class="tr ${d > 0 ? "up" : "dn"}" title="t.o.v. gisteren: € ${String(s.prev_price.toFixed(3)).replace(".", ",")}">${d > 0 ? "▲" : "▼"}${Math.abs(d).toFixed(1).replace(".", ",")}</span>`;
  };
  const mine = () => store.get("mine");            // { id, name } of null
  const showOld = () => $("#show_old").checked;
  const clientLog = (msg) => { try { fetch("/api/clientlog?msg=" + encodeURIComponent(String(msg).slice(0, 300))); } catch {} };

  let cfg, fuel = "euro95", sort = "net", last = null, selId = null, traffic = null, lastRun = 0;
  const byId = new Map();                          // key → station (key "via:<id>" voor onderweg-pompen)
  const routeCache = new Map();                    // "van>naar" → /api/route-antwoord
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const TYPE_LABEL = { bebouwd: "Bebouwde kom", buitenweg: "Buitenweg", snelweg: "Snelweg" };
  const FLAG = { NL: "NL", BE: "BE", DE: "DE" };
  const SORT_LABEL = { net: "besparing", price: "literprijs", time: "rijtijd", per_min: "€ per minuut", mix: "dichtbij ↔ goedkoop" };
  const fmtMin = (m) => { m = Math.round(m); return m >= 60 ? `${Math.floor(m / 60)} u ${String(m % 60).padStart(2, "0")}` : `${m} min`; };
  const inPeak = (peaks) => { const d = new Date(), h = d.getHours() + d.getMinutes() / 60; return d.getDay() % 6 !== 0 && peaks.some(([a, b]) => h >= a && h < b); };
  const near = (lat1, lon1, lat2, lon2) => { const k = 111.32, dx = (lon2 - lon1) * k * Math.cos(lat1 * Math.PI / 180), dy = (lat2 - lat1) * k; return Math.hypot(dx, dy); };

  // ---------- Kaart: pas aangemaakt bij de eerste "Toon route" (verborgen kaart = 0 px = MapLibre-waakhond slaat alarm) ----------
  let map = null, layer, trafficLayer, trafficCtl;
  const pin = (cls, text) => L.divIcon({ className: "", html: `<div class="pin ${cls}"><b>${text}</b></div>`, iconSize: [30, 30], iconAnchor: [15, 30] });
  function ensureMap() {
    if (map) return;
    map = L.map("map", { zoomControl: true }).setView([50.89, 5.9], 10);
    const OSM = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
    let vec = null, fallbackOn = false;
    const useFallback = (reason) => {
      if (fallbackOn) return;
      fallbackOn = true;
      console.warn("Kaart: terugval naar Esri —", reason); clientLog("kaart-terugval: " + reason);
      if (vec) { try { map.removeLayer(vec); } catch {} vec = null; }
      const g = dark ? "Dark" : "Light";
      const esri = (n) => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${g}_Gray_${n}/MapServer/tile/{z}/{y}/{x}`;
      L.tileLayer(esri("Base"), { maxZoom: 18, maxNativeZoom: 16, attribution: `Esri, HERE, Garmin, ${OSM}` }).addTo(map).bringToBack();
      L.tileLayer(esri("Reference"), { maxZoom: 18, maxNativeZoom: 16 }).addTo(map);
    };
    try {
      if (!L.maplibreGL || !window.maplibregl) throw new Error("MapLibre-scripts niet geladen");
      vec = L.maplibreGL({ style: BR_MAPSTYLE.style(dark), attribution: `${OSM} · OpenMapTiles · OpenFreeMap` }).addTo(map);
      const gl = vec.getMaplibreMap();
      gl.on("error", (e) => clientLog("maplibre-fout: " + (e?.error?.message || e?.error || "onbekend")));
      gl.on("webglcontextlost", () => useFallback("WebGL-context verloren"));
      setTimeout(() => {
        if (!vec) return;
        let n = 0; try { n = gl.queryRenderedFeatures().length; } catch (e) { return useFallback("query: " + e.message); }
        if (!n) useFallback(`geen kaartdata na 8 s (stijl geladen: ${gl.isStyleLoaded()}, canvas ${gl.getCanvas().width}x${gl.getCanvas().height})`);
        else clientLog(`kaart ok: ${n} objecten`);
      }, 8000);
    } catch (e) { useFallback("start: " + e.message); }
    layer = L.layerGroup().addTo(map);
    trafficLayer = L.layerGroup();
    const TrafficCtl = L.Control.extend({
      onAdd() {
        const b = L.DomUtil.create("button", "trafficbtn");
        b.type = "button"; b.title = "Filemeldingen en knelpunten op deze route tonen";
        L.DomEvent.disableClickPropagation(b);
        b.onclick = () => { const on = !map.hasLayer(trafficLayer); on ? trafficLayer.addTo(map) : trafficLayer.remove(); store.set("traffic", on); paint(); };
        const paint = () => { const on = map.hasLayer(trafficLayer); b.classList.toggle("on", on); b.textContent = on ? "File: aan" : "File: uit"; };
        this.paint = paint; paint(); return b;
      },
    });
    trafficCtl = new TrafficCtl({ position: "topright" }).addTo(map);
    if (store.get("traffic") !== false) { trafficLayer.addTo(map); trafficCtl.paint(); }
    map.on("contextmenu", (e) => { $("#q").value = `${e.latlng.lat.toFixed(5)},${e.latlng.lng.toFixed(5)}`; run(); });
  }
  const mapOpen = () => $("#app").classList.contains("withmap");
  function openMap() {
    $("#app").classList.replace("nomap", "withmap");
    ensureMap();
    paintMapBtn();
    requestAnimationFrame(() => { map.invalidateSize(); drawSelected(); });
  }
  function closeMap() { $("#app").classList.replace("withmap", "nomap"); paintMapBtn(); }
  const paintMapBtn = () => document.querySelectorAll("#trip .showroute").forEach((b) => { b.textContent = mapOpen() ? "Verberg kaart" : "Toon route op kaart"; });

  async function init() {
    cfg = await (await fetch("/api/config")).json();
    $("#version").textContent = "v" + cfg.version;
    const d = cfg.defaults, saved = store.get("form") || {};
    $("#q").value = saved.q_text ?? saved.q ?? d.address;
    $("#dest").value = saved.dest_text ?? "";
    $("#tank_l").value = saved.tank_l ?? d.tank_l;
    $("#consumption").value = saved.consumption ?? d.consumption;
    $("#radius_km").value = saved.radius_km ?? d.radius_km;
    $("#max_min").value = saved.max_min ?? 15;
    $("#time_eur_h").value = saved.time_eur_h ?? 12;
    $("#level").value = saved.level ?? 25;
    $("#jerry").checked = !!saved.jerry;
    $("#show_old").checked = !!store.get("show_old");
    paintLiters();
    $("#reference").value = saved.reference ?? "nearest";
    $("#ref_price").value = saved.ref_price ?? "";
    fuel = saved.fuel ?? d.fuel;
    sort = store.get("sort") ?? "net";
    $("#mix").value = store.get("mix") ?? 50;
    paintMaxMin(); paintMine();
    const fsel = $("#fuel");
    for (const [code, label] of Object.entries(cfg.fuels)) fsel.add(new Option(label, code));
    fsel.value = fuel;
    fsel.onchange = () => { fuel = fsel.value; if (last) run(); };
    const car = $("#car");
    for (const [k, c] of Object.entries(BR_MAPSTYLE.CARS)) car.add(new Option(c.name, k));
    const known = saved.car in BR_MAPSTYLE.CARS;
    car.value = known ? saved.car : "standaard";
    const applyCar = () => { const m = BR_MAPSTYLE.mixed(car.value); if (m) $("#consumption").value = m; };
    if (!known) applyCar();
    car.onchange = () => { applyCar(); if (last) run(); };
    $("#consumption").addEventListener("input", () => { car.value = "eigen"; });
    $("#discounts").value = store.get("discounts") ?? "";
    $("#alarm").value = store.get("alarm") ?? "";
    fillAddr([]);
    paintPlaces();
    health();
    loadTraffic(); setInterval(loadTraffic, 10 * 60 * 1000);
    // Prijzen worden 3× per dag ververst: lijst om het half uur (en bij terugkomen in de app) opnieuw berekenen.
    setInterval(() => { if (last && !document.hidden) run(); }, 30 * 60 * 1000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden && last && Date.now() - lastRun > 30 * 60 * 1000) run(); });
    run();
  }

  // ---------- Vaste adressen (thuis, werk …), alleen in deze browser ----------
  const places = () => store.get("places") || [];
  function paintPlaces() {
    $("#places").innerHTML = places().map((p, i) => `<span class="chip"><button type="button" data-place="${i}" title="${esc(p.label)}">${i === 0 ? "⌂" : "◆"} ${esc(p.name)}</button><button type="button" class="x" data-delplace="${i}" title="${esc(p.name)} vergeten">×</button></span>`).join("") +
      `<button type="button" class="chip add" data-addplace>+ adres bewaren</button>`;
  }
  $("#quick").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.place != null) {
      const p = places()[b.dataset.place]; if (!p) return;
      $("#q").value = p.label; if (p.lat != null) sugg.set(p.label, { lat: p.lat, lon: p.lon }); run();
    } else if (b.dataset.delplace != null) {
      const list = places(); list.splice(Number(b.dataset.delplace), 1); store.set("places", list); paintPlaces();
    } else if (b.dataset.addplace != null) {
      const text = $("#q").value.trim(); if (!text) return;
      const name = prompt(`Naam voor "${text}" (bv. Thuis, Werk):`, places().length ? "Werk" : "Thuis"); if (!name) return;
      const c = sugg.get(text) || (last?.origin ? { lat: last.origin.lat, lon: last.origin.lon } : {});
      store.set("places", [...places().filter((p) => p.name !== name.trim()), { name: name.trim().slice(0, 20), label: text, ...c }].slice(0, 6));
      paintPlaces();
    } else if (b.id === "logopen") openLog();
  });

  // ---------- Tankpas / korting per merk (ct/L), bv. "Shell 3, Tango 2" ----------
  function discounts() {
    const out = [];
    for (const part of ($("#discounts").value || "").split(/[;\n]|,(?=\s*[^\d\s])/)) {
      const m = part.trim().match(/^(.+?)\s*[-:=]?\s*(\d+(?:[.,]\d+)?)\s*(?:ct|cent)?$/i);
      if (m) out.push([m[1].trim().toLowerCase(), parseFloat(m[2].replace(",", ".")) / 100]);
    }
    return out;
  }
  const discOf = (s) => { const n = `${s.brand || ""} ${s.name || ""}`.toLowerCase(); return Math.max(0, ...discounts().filter(([b]) => n.includes(b)).map(([, v]) => v)); };
  const r3 = (v) => Math.round(v * 1000) / 1000;
  function applyDiscounts(data) {
    for (const s of [...data.results, ...(data.via?.results || [])]) {
      if (s.list_price != null) continue;
      const d = discOf(s); s.list_price = s.price; s.disc = d;
      if (d) { s.price = r3(s.price - d); if (s.prev_price != null) s.prev_price = r3(s.prev_price - d); }
    }
    const ref = data.reference, r = ref?.station_id && data.results.find((x) => x.id === ref.station_id);
    if (r) ref.price = r.price;
  }

  // ---------- Openingstijden (bron: ANWB) ----------
  const DAYN = ["ma", "di", "wo", "do", "vr", "za", "zo"];
  function hoursInfo(h) {
    if (!h?.length) return null;
    const d = new Date(), wd = (d.getDay() + 6) % 7, now = d.toTimeString().slice(0, 5);
    const is247 = h.some((r) => r[0] === "1111111" && r[1] === "00:00" && (r[2] === "24:00" || r[2] === "23:59" || r[2] === "00:00"));
    const isOpen = (r) => { const c = r[2] === "00:00" ? "24:00" : r[2]; return c > r[1] ? r[1] <= now && now < c : now >= r[1] || now < c; };
    const today = h.filter((r) => r[0][wd] === "1");
    const week = h.map((r) => { const days = [...r[0]].map((x, i) => (x === "1" ? DAYN[i] : null)).filter(Boolean); return `${days.length === 7 ? "dagelijks" : days.join(" ")} ${r[1]}–${r[2]}`; }).join(" · ");
    return { is247, open: is247 || today.some(isOpen), today: today.map((r) => `${r[1]}–${r[2]}`).join(", ") || "gesloten", week };
  }
  const hoursTag = (s) => { const h = hoursInfo(s.hours); if (!h) return ""; return h.is247 ? ` <i class="tag h24" title="${esc(h.week)}">24/7</i>` : h.open ? "" : ` <i class="tag shut" title="Vandaag: ${esc(h.today)}">dicht</i>`; };

  // ---------- Prijsalarm: melding als een pomp binnen je rijtijd onder je prijs zit ----------
  function checkAlarm() {
    const bar = $("#alarmbar"), thr = Number($("#alarm").value);
    if (!thr || !last?.results?.length) { bar.hidden = true; return; }
    const hits = last.results.filter((s) => !s.stale && s.price <= thr).sort((a, b) => a.price - b.price);
    if (!hits.length) { bar.hidden = true; return; }
    const b = hits[0];
    bar.hidden = false;
    bar.innerHTML = `🔔 <b>Prijsalarm</b>: ${hits.length} pomp${hits.length > 1 ? "en" : ""} onder € ${fmtN(thr, 3)} · goedkoopst <button type="button" class="linkbtn" data-key="${esc(b.id)}">${esc(b.name)} ${esc(b.city || "")}</button> € ${fmtN(b.price, 3)} (${fmtMin(b.min)})`;
    bar.querySelector("[data-key]").onclick = () => select(b.id, false);
    const seen = store.get("alarm_seen") || {}, k = `${b.id}|${b.price}|${new Date().toDateString()}`;
    if ("Notification" in window && Notification.permission === "granted" && !seen[k]) {
      try { new Notification("Benzine-radar: prijsalarm", { body: `${b.name} ${b.city || ""}: € ${fmtN(b.price, 3)} (onder € ${fmtN(thr, 3)})`, tag: "br-alarm" }); } catch { /* bv. Android zonder SW-melding */ }
      store.set("alarm_seen", { [k]: 1 });
    }
  }

  // ---------- Nu of later tanken: regiogemiddelde per weekdag en dagdeel ----------
  const SLOT = ["ochtend", "middag", "avond"], slotOf = (d) => (d.getHours() < 10 ? 0 : d.getHours() < 15 ? 1 : 2);
  const DAYL = ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"];
  async function loadTiming() {
    const box = $("#timing");
    let series;
    try { series = (await (await fetch("/api/stats?fuel=" + fuel)).json()).series || []; } catch { box.hidden = true; return; }
    if (!series.length) { box.hidden = true; return; }
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const days = new Map();
    for (const [t, avg] of series) { const d = new Date(t * 1000), k = d.toDateString(); if (!days.has(k)) days.set(k, []); days.get(k).push([d, avg]); }
    const dev = {};
    for (const pts of days.values()) {
      if (pts.length < 2) continue;
      const m = mean(pts.map((p) => p[1]));
      for (const [d, a] of pts) (dev[((d.getDay() + 6) % 7) * 3 + slotOf(d)] ||= []).push(a - m);
    }
    const [lt, lavg] = series.at(-1), today = new Date(lt * 1000).toDateString();
    const prev = [...series].reverse().find(([t]) => new Date(t * 1000).toDateString() !== today);
    let html = `<b>Regio nu</b> gemiddeld € ${fmtN(lavg, 3)}`;
    if (prev) { const d = Math.round((lavg - prev[1]) * 1000) / 10; html += ` · ${d ? `<span class="tr ${d > 0 ? "up" : "dn"}">${d > 0 ? "▲" : "▼"}${fmtN(Math.abs(d))} ct</span>` : "gelijk"} t.o.v. ${new Date(prev[0] * 1000).toLocaleDateString("nl-NL", { weekday: "long" })}`; }
    const exp = (k) => (dev[k]?.length >= 2 ? mean(dev[k]) : null);
    const nDays = days.size;
    if (nDays >= 7) {
      const d = new Date(), cur = ((d.getDay() + 6) % 7) * 3 + slotOf(d), now = exp(cur);
      const next = [1, 2, 3].map((i) => (cur + i) % 21).map((k) => ({ k, v: exp(k) })).filter((x) => x.v != null);
      const best = next.reduce((a, b) => (!a || b.v < a.v ? b : a), null);
      const name = (k) => `${DAYL[Math.floor(k / 3)]}${SLOT[k % 3]}`;
      if (now != null && best && now - best.v >= 0.01) html += ` · <b class="neg">Wachten kan lonen</b>: ${name(best.k)} meestal ±${fmtN((now - best.v) * 100)} ct goedkoper`;
      else if (now != null) html += ` · <b class="pos">Nu tanken is prima</b>: het komende etmaal meestal niet goedkoper`;
      const all = Object.keys(dev).map(Number).map((k) => ({ k, v: exp(k) })).filter((x) => x.v != null);
      const low = all.reduce((a, b) => (!a || b.v < a.v ? b : a), null);
      if (low) html += `<small>Goedkoopste moment van de week (gemiddeld over ${nDays} dagen): ${name(low.k)}.</small>`;
    } else {
      html += `<small>Advies per dagdeel volgt na een week metingen (nu ${nDays} dag${nDays === 1 ? "" : "en"}; prijzen worden 3× per dag opgehaald).</small>`;
    }
    box.innerHTML = html; box.hidden = false;
  }

  // ---------- Tanklogboek: wat je getankt hebt en wat het opleverde ----------
  const logList = () => store.get("log") || [];
  function logTank(s) {
    const c = calc(s), gainL = last.reference.price - s.price, fixed = gainL * c.L - c.save;
    const v = prompt(`Getankt bij ${s.name}: hoeveel liter?`, String(c.L)); if (v == null) return;
    const L = Math.max(0, parseFloat(v.replace(",", "."))); if (!L) return;
    store.set("log", [{ t: Date.now(), id: s.id, name: s.name, city: s.city || "", fuel, price: s.price, liters: L, save: r2(gainL * L - fixed), ref: last.reference.price }, ...logList()].slice(0, 500));
    openLog();
  }
  const r2 = (v) => Math.round(v * 100) / 100;
  function openLog() {
    const list = logList(), dlg = $("#logbook");
    const sum = (k) => list.reduce((a, x) => a + (k === "cost" ? x.price * x.liters : x[k]), 0);
    const month = new Date(); month.setDate(1); month.setHours(0, 0, 0, 0);
    const thisM = list.filter((x) => x.t >= month.getTime()).reduce((a, x) => a + x.save, 0);
    dlg.innerHTML = `<div class="shead"><b>Tanklogboek</b><button type="button" data-close aria-label="Sluiten">✕</button></div>` +
      (list.length ? `<div class="kpis">
        <div><b class="${sum("save") >= 0 ? "pos" : "neg"}">${fmtE(sum("save"))}</b><span>bespaard totaal</span></div>
        <div><b>${fmtE(thisM)}</b><span>deze maand</span></div>
        <div><b>${fmtN(sum("liters"), 0)} L</b><span>${list.length}× getankt</span></div>
        <div><b>${fmtE(sum("cost"))}</b><span>uitgegeven</span></div></div>
        <table class="logtab"><thead><tr><th>Datum</th><th>Pomp</th><th class="n">L</th><th class="n">€/L</th><th class="n">Bespaard</th><th></th></tr></thead><tbody>
        ${list.map((x, i) => `<tr><td>${new Date(x.t).toLocaleDateString("nl-NL", { day: "numeric", month: "short" })}</td><td>${esc(x.name)} <small>${esc(x.city)}</small></td><td class="n">${fmtN(x.liters, 0)}</td><td class="n">${fmtN(x.price, 3)}</td><td class="n ${x.save >= 0 ? "pos" : "neg"}">${fmtE(x.save)}</td><td><button type="button" class="x" data-dellog="${i}" title="Verwijderen">×</button></td></tr>`).join("")}
        </tbody></table><p class="hint">Bespaard = t.o.v. de referentie op dat moment, na aftrek van rit en tijd. Alleen opgeslagen in deze browser.</p>`
      : `<p class="hint">Nog niets gelogd. Klik in het detail van een pomp op <b>⛽ Getankt</b>.</p>`);
    if (!dlg.open) dlg.showModal();
  }
  $("#logbook").addEventListener("click", (e) => {
    if (e.target === $("#logbook") || e.target.closest("[data-close]")) $("#logbook").close();
    const d = e.target.closest("[data-dellog]");
    if (d && confirm("Deze tankbeurt verwijderen?")) { const l = logList(); l.splice(Number(d.dataset.dellog), 1); store.set("log", l); openLog(); }
  });

  // ---------- Adres-suggesties (Photon) + recente adressen ----------
  const sugg = new Map();                          // getoonde tekst → { lat, lon }
  const recent = () => store.get("recent") || [];
  function fillAddr(list) {
    const dl = $("#addr"); dl.innerHTML = "";
    const seen = new Set();
    for (const r of [...list, ...recent()]) {
      if (seen.has(r.label)) continue; seen.add(r.label);
      if (r.lat != null) sugg.set(r.label, { lat: r.lat, lon: r.lon });
      dl.append(new Option(r.label));
    }
  }
  function remember(text) {
    if (!text || /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(text)) return;
    const c = sugg.get(text);
    store.set("recent", [{ label: text, ...(c || {}) }, ...recent().filter((r) => r.label !== text)].slice(0, 8));
  }
  let suggT;
  for (const id of ["#q", "#dest"]) {
    $(id).addEventListener("input", (e) => {
      const v = e.target.value.trim();
      clearTimeout(suggT);
      if (v.length < 3 || sugg.has(v)) return;
      suggT = setTimeout(async () => {
        try { fillAddr(await (await fetch("/api/suggest?q=" + encodeURIComponent(v))).json()); } catch { /* geen suggesties */ }
      }, 250);
    });
  }
  const asQuery = (text) => { const c = sugg.get(text); return c ? `${c.lat},${c.lon}` : text; };

  // ---------- Verkeer: alleen meldingen/knelpunten op de getoonde route ----------
  async function loadTraffic() {
    try { traffic = await (await fetch("/api/traffic")).json(); } catch { return; }
    if (last && selId) { renderTrip(selId); if (mapOpen()) drawSelected(); }
  }
  function onRoute(geom) {
    const pts = (geom?.coordinates || []).filter((_, i) => i % 3 === 0);
    return (lat, lon) => pts.some(([x, y]) => near(lat, lon, y, x) < 0.3);
  }
  function drawTraffic(geoms) {
    trafficLayer.clearLayers();
    if (!traffic) return;
    const hits = geoms.map(onRoute), hit = (lat, lon) => hits.some((h) => h(lat, lon));
    const peak = inPeak(traffic.peaks);
    for (const h of traffic.hotspots.filter((x) => hit(x.lat, x.lon))) {
      L.marker([h.lat, h.lon], { icon: L.divIcon({ className: "", html: `<div class="hot ${peak ? "now" : ""}"></div>`, iconSize: [44, 44], iconAnchor: [22, 22] }) })
        .bindTooltip(`<b>Bekend knelpunt</b><br>${esc(h.name)}<br>${peak ? "Nu spits: file waarschijnlijk" : "Druk in de spits (werkdagen 7–9:30, 16–18:30)"}`, { className: "lbl" })
        .addTo(trafficLayer);
    }
    for (const i of traffic.incidents.filter((x) => hit(x.lat, x.lon))) {
      const sym = i.kind === "closure" || i.blocked ? "⛔" : i.kind === "roadworks" ? "⚒" : "!";
      L.marker([i.lat, i.lon], { icon: L.divIcon({ className: "", html: `<div class="inc ${i.kind}${i.blocked ? " blocked" : ""}"><b>${sym}</b></div>`, iconSize: [22, 22], iconAnchor: [11, 11] }) })
        .bindPopup(`<b>${esc(i.label)}: ${esc(i.title)}</b><br>${esc(i.sub)}<br><small>${esc(i.text)}</small><br><small>Bron: ${esc(i.source)}</small>`, { maxWidth: 320 })
        .addTo(trafficLayer);
    }
  }
  function routeWarnings(geom) {
    if (!traffic || !geom?.coordinates) return [];
    const hit = onRoute(geom), out = [], peak = inPeak(traffic.peaks);
    for (const i of traffic.incidents) if (hit(i.lat, i.lon)) out.push({ cls: i.blocked || i.kind === "closure" ? "bad" : "warn", txt: `${i.label}: ${i.title}${i.sub ? " (" + i.sub + ")" : ""}` });
    for (const h of traffic.hotspots) if (hit(h.lat, h.lon)) out.push({ cls: peak ? "warn" : "info", txt: `${h.name}: ${peak ? "nu spits, reken op file" : "kan druk zijn in de spits"}` });
    return out;
  }

  async function routeBetween(a, b) {
    const k = `${a.lat},${a.lon}>${b.lat},${b.lon}`;
    if (routeCache.has(k)) return routeCache.get(k);
    const p = fetch(`/api/route?from_lat=${a.lat}&from_lon=${a.lon}&to_lat=${b.lat}&to_lon=${b.lon}`).then((r) => r.json());
    routeCache.set(k, p);
    try { return await p; } catch (e) { routeCache.delete(k); throw e; }
  }
  const getRoute = (s) => routeBetween(last.origin, s);

  // ---------- Ritoverzicht: km per soort weg, max. snelheid, rijtijd, verbruik ----------
  async function renderTrip(id) {
    const box = $("#trip"), s = byId.get(id);
    if (!s) { box.hidden = true; return; }
    let r; try { r = await getRoute(s); } catch { box.hidden = true; return; }
    if (selId !== id) return;
    const car = $("#car").value, own = Number($("#consumption").value) || 6, carName = BR_MAPSTYLE.CARS[car]?.name || "";
    const parts = r.parts?.length ? r.parts : [{ country: s.country, type: "buitenweg", limit: 80, km: r.km, min: r.min, avg_kmh: Math.round(r.km / (r.min / 60)), min_at_limit: r.km / 80 * 60, roads: [], note: "geschat" }];
    let L_tot = 0;
    const rows = parts.map((p) => {
      const l100 = BR_MAPSTYLE.per100(car, p.type, p.limit, own), liters = p.km * l100 / 100; L_tot += liters;
      return { ...p, l100, liters };
    });
    const km = rows.reduce((a, p) => a + p.km, 0), min = rows.reduce((a, p) => a + p.min, 0), minLim = rows.reduce((a, p) => a + p.min_at_limit, 0);
    const price = s.price, kmL = km / L_tot;
    const byType = {}; rows.forEach((p) => { byType[p.type] = (byType[p.type] || 0) + p.km; });
    const warns = routeWarnings(r.geometry);
    box.hidden = false;
    box.innerHTML = `
      <h2>Rit naar ${esc(s.name)} <small>${esc(s.city || "")}</small><button type="button" class="showroute">${mapOpen() ? "Verberg kaart" : "Toon route op kaart"}</button>${s.via ? "" : `<button type="button" class="minebtn${mine()?.id === s.id ? " on" : ""}" data-star="${esc(s.id)}">${mine()?.id === s.id ? "★ Mijn pomp · loslaten" : "☆ Maak dit mijn pomp"}</button>`}<button type="button" class="minebtn" data-log>⛽ Getankt</button></h2>
      ${(() => { const c = calc(s); return `<div class="mobsum">
        <span>Besparing</span><b class="sv ${tone(c.save)}">${fmtE(c.save)}</b><span>Per liter</span><b class="${tone(c.save)}">${fmtPL(c.perL)}</b>
        <span>Totaal ${c.L} L + rit</span><b>${fmtE(c.total)}</b><span>${s.via ? "Omrijden" : "Rit heen + terug"}</span><b>${fmtMin(c.min)} · ${fmtN(c.km)} km</b></div>`; })()}
      <p class="pinfo">Prijs <b>€ ${fmtN(s.price, 3)}</b>${s.disc ? ` (paal € ${fmtN(s.list_price, 3)} − ${fmtN(s.disc * 100)} ct pas)` : ""}${s.prev_price != null ? ` · gisteren € ${fmtN(s.prev_price, 3)} ${trend(s)}` : ""} · bijgewerkt ${ago(s.updated_at)} (${esc(s.source)}${s.source === "anwb" ? ", ophaalmoment" : ""})${s.stale ? ' · <span class="neg">ouder dan 24 u</span>' : ""}${(() => { const h = hoursInfo(s.hours); return h ? ` · ${h.is247 ? "<b>24/7 open</b>" : `vandaag ${esc(h.today)} ${h.open ? '<span class="pos">nu open</span>' : '<span class="neg">nu dicht</span>'}`} <small title="${esc(h.week)}">(${esc(h.week)})</small>` : ""; })()}</p>
      ${(() => { const c = calc(s); return `<p class="calc">${c.L} L tanken ${fmtE(c.fill)} + ${s.via ? "omrijden" : "rit heen en terug"} ${fmtN(c.km)} km ${fmtE(c.trip)} + tijd ${fmtMin(c.min)} ${fmtE(c.time)} = <b>${fmtE(c.total)}</b> · <b class="${tone(c.save)}">${fmtE(c.save)}</b> (${fmtPL(c.perL)}) · ${payoff(c).txt}</p>`; })()}
      <div class="kpis">
        <div><b>${fmtN(km)} km</b><span>enkele reis</span></div>
        <div><b>${fmtMin(min)}</b><span>verwachte rijtijd</span></div>
        <div><b>${fmtN(kmL)} km/L</b><span>${fmtN(100 / kmL)} L/100 km</span></div>
        <div><b>${fmtE(L_tot * price * 2)}</b><span>brandstof retour</span></div>
      </div>
      <div class="mixbar" title="Verdeling van de km per soort weg">
        ${["bebouwd", "buitenweg", "snelweg"].filter((t) => byType[t]).map((t) => `<i class="t-${t}" style="flex:${byType[t]}">${Math.round(byType[t] / km * 100)}%</i>`).join("")}
      </div>
      <div class="legend">${["bebouwd", "buitenweg", "snelweg"].map((t) => `<span><i class="t-${t}"></i>${TYPE_LABEL[t]}</span>`).join("")}</div>
      <table class="triptab">
        <thead><tr><th>Stuk</th><th class="n">km</th><th class="n">Max</th><th class="n">Rijtijd</th><th class="n">Gem.</th><th class="n">Liter</th><th class="n">km/L</th></tr></thead>
        <tbody>${rows.map((p) => `<tr>
          <td><span class="sw t-${p.type}"></span><b>${TYPE_LABEL[p.type]}</b> <span class="cc ${p.country}">${FLAG[p.country]}</span>
            <div class="roads">${esc(p.roads.join(" · "))}${p.note ? ` <em>${esc(p.note)}</em>` : ""}</div></td>
          <td class="n">${fmtN(p.km)}</td><td class="n"><span class="limit">${p.limit}</span></td>
          <td class="n">${fmtMin(p.min)}</td><td class="n">${p.avg_kmh}</td>
          <td class="n">${fmtN(p.liters, 2)}</td><td class="n">${fmtN(100 / p.l100)}</td></tr>`).join("")}</tbody>
        <tfoot>
          <tr><td>Enkele reis</td><td class="n">${fmtN(km)}</td><td></td><td class="n">${fmtMin(min)}</td><td class="n">${Math.round(km / (min / 60))}</td><td class="n">${fmtN(L_tot, 2)}</td><td class="n">${fmtN(kmL)}</td></tr>
          <tr><td>Heen en terug</td><td class="n">${fmtN(km * 2)}</td><td></td><td class="n">${fmtMin(min * 2)}</td><td></td><td class="n">${fmtN(L_tot * 2, 2)}</td><td class="n">${fmtE(L_tot * 2 * price)}</td></tr>
        </tfoot>
      </table>
      <p class="tripnote">Rijtijd = OSRM (realistisch, zonder file). Precies op de maximumsnelheid zou het ${fmtMin(minLim)} zijn.
        Verbruik: ${esc(carName)}${car === "eigen" ? ` (${fmtN(own)} L/100)` : ", per soort weg"}. Land en wegtype zijn geschat.</p>
      ${warns.length ? `<ul class="warns">${warns.map((w) => `<li class="${w.cls}">${esc(w.txt)}</li>`).join("")}</ul>` : traffic ? `<p class="ok">Geen filemeldingen of bekende knelpunten op deze route.</p>` : ""}`;
  }

  // ---------- Tanken: hoeveel liter (tankniveau-schuif + jerrycan) ----------
  const JERRY_L = 15;
  function liters() {
    const size = Number($("#tank_l").value) || 0, lvl = Number($("#level").value) / 100;
    const tank = Math.max(0, Math.round(size * (1 - lvl))), jerry = $("#jerry").checked ? JERRY_L : 0;
    return { tank, jerry, total: tank + jerry };
  }
  const LEVEL_TXT = (v) => v <= 5 ? "leeg (reserve)" : v < 20 ? "bijna leeg" : v < 40 ? "± ¼ vol" : v < 60 ? "± ½ vol" : v < 85 ? "± ¾ vol" : "bijna vol";
  function paintLiters() {
    const l = liters(), v = Number($("#level").value);
    $("#level_out").textContent = `${v}%`;
    $("#gauge").style.setProperty("--lvl", v + "%");
    $("#gauge").title = `${LEVEL_TXT(v)} · ${l.tank} L in de tank${l.jerry ? ` + ${l.jerry} L jerrycan` : ""}`;
    $("#fill_out").textContent = `${l.total} L${l.jerry ? " (incl. jerrycan)" : ""}`;
  }

  // ---------- Kosten per pomp, alles bij de nu gekozen liters ----------
  // Normale pomp: totaal = tanken + rit heen en terug (brandstof) + rijtijd heen en terug (× €/u),
  // besparing = totaal bij de referentie − totaal hier. Onderweg: alleen het omrijden telt.
  function calc(s) {
    const L = liters().total, ref = last.reference, cons = Number($("#consumption").value) || 6;
    const eurH = Number($("#time_eur_h").value) || 0, fill = L * s.price;
    let km, min, trip, time, save;
    if (s.via) {
      km = s.offer.detour_km; min = s.offer.extra_min; trip = s.offer.detour_cost_eur; time = s.offer.time_cost_eur;
      save = (ref.price - s.price) * L - trip - time;
    } else {
      km = 2 * s.km; min = 2 * s.min; trip = km * cons / 100 * s.price; time = min / 60 * eurH;
      const refTotal = L * ref.price + 2 * ref.km * cons / 100 * ref.price + 2 * ref.min / 60 * eurH;
      save = refTotal - (fill + trip + time);
    }
    const perL = L ? save / L : 0, gainL = ref.price - s.price;
    const fixed = gainL * L - save;                  // wat de rit extra kost t.o.v. de referentie
    const be = gainL > 0 ? (fixed > 0 ? fixed / gainL : 0) : null;
    const extraMin = s.via ? min : Math.max(0, 2 * (s.min - ref.min));
    return { L, fill, km, min, trip, time, total: fill + trip + time, save, perL, be, extraMin };
  }
  function payoff(c) {
    if (c.be == null) return { cls: "neg", txt: "niet goedkoper per liter" };
    if (c.be === 0) return { cls: "pos", txt: "loont altijd" };
    return c.be > c.L ? { cls: "neg", txt: `loont pas vanaf ${Math.ceil(c.be)} L` } : { cls: "pos", txt: `loont vanaf ${Math.ceil(c.be)} L` };
  }
  // Rood ↔ groen: kleur + sterkte naar besparing (± € 0,25 = neutraal, volle kleur vanaf € 5).
  const tone = (save) => (Math.abs(save) < 0.25 ? "zero" : save > 0 ? "pos" : "neg");
  const toneStyle = (save) => `--t:${Math.min(1, Math.abs(save) / 5).toFixed(2)}`;
  const fmtPL = (v) => (v < 0 ? "−" : "+") + Math.abs(v * 100).toFixed(1).replace(".", ",") + " ct/L";

  // ---------- Vaste suggesties: Slimste rit · Dichtbij ≤ 5 km · Beste deal · Onderweg ----------
  // Slimste rit = meeste netto besparing per minuut rijden (heen + terug): korte rit, groot voordeel.
  const NEAR_KM = 5, SMART_MIN_SAVE = 0.5;
  const perMin = (s) => { const c = calc(s); return c.save / Math.max(c.min, 1); };
  function renderPicks(results) {
    const box = $("#picks"), via = last.via, maxMin = Number($("#max_min").value);
    const pool = results.filter((s) => showOld() || !s.stale);
    const best = (list, key) => list.length ? list.reduce((a, b) => (key(b) > key(a) ? b : a)) : null;
    const smart = best(pool.filter((s) => calc(s).save >= SMART_MIN_SAVE), perMin);
    const close = best(pool.filter((s) => s.km <= NEAR_KM), (s) => calc(s).save);
    const deal = best(pool, (s) => calc(s).save);
    const card = (kind, title, s, key, extra) => {
      const c = calc(s), p = payoff(c);
      return `<button type="button" class="pick ${kind} t-${tone(c.save)}" style="${toneStyle(c.save)}" data-key="${esc(key)}">
        <span class="ptitle">${title}</span>
        <span class="pname"><span class="cc ${s.country}">${s.country}</span> ${esc(s.name)}<small>${esc(s.city || "")}</small></span>
        <span class="pprice">€ ${fmtN(s.price, 3)}${trend(s)}</span>
        <span class="pmeta">${extra}</span>
        <span class="psave">${fmtE(c.save)}<small>${fmtPL(c.perL)}</small></span>
        <span class="ppay ${p.cls}">${p.txt}</span>
      </button>`;
    };
    const empty = (kind, title, txt, focus) => `<${focus ? 'button type="button" data-focus="dest"' : "div"} class="pick ${kind} empty"><span class="ptitle">${title}</span><span class="pmeta">${txt}</span></${focus ? "button" : "div"}>`;
    const trip = (s) => `${fmtN(s.km)} km · ${fmtMin(s.min)} enkel`;
    let html = smart ? card("smart", "Slimste rit <small>meeste € per rijminuut</small>", smart, smart.id, `${trip(smart)} · <b>${fmtE(perMin(smart))}/min</b>`)
      : empty("smart", "Slimste rit", "Geen pomp die de rit waard is (≥ € 0,50 netto).");
    html += close ? card("near", `Dichtbij <small>≤ ${NEAR_KM} km, beste besparing</small>`, close, close.id, trip(close))
      : empty("near", `Dichtbij ≤ ${NEAR_KM} km`, `Geen pomp met prijs binnen ${NEAR_KM} km rijden.`);
    if (deal && deal !== smart) html += card("deal", "Beste deal <small>meeste besparing</small>", deal, deal.id, trip(deal));
    const vbest = via?.results?.length ? via.results.map((v) => byId.get("via:" + v.id)).reduce((a, b) => (calc(b).save > calc(a).save ? b : a)) : null;
    if (vbest) {
      html += card("via", `Onderweg <small>naar ${esc(last.dest.label.split(",")[0])}</small>`, vbest, "via:" + vbest.id, `+${Math.round(vbest.offer.extra_min)} min / +${fmtN(vbest.offer.detour_km)} km omrijden`);
    } else if (via) {
      html += empty("via", "Onderweg", `Geen pomp langs de route met ≤ ${maxMin} min omrijden.`);
    } else {
      html += empty("via", "Onderweg", `Vul onder ⚙ "Onderweg naar" in (bv. werk): dan zoek ik de pomp met het minste omrijden.`, true);
    }
    box.hidden = false; box.innerHTML = html;
    box.querySelectorAll("[data-key]").forEach((b) => b.onclick = () => select(b.dataset.key, false));
    box.querySelector("[data-focus]")?.addEventListener("click", () => { openSettings(true); $("#dest").focus(); });
  }

  // ---------- Instellingen (⚙) en "mijn pomp" ----------
  function openSettings(on) {
    $("#settings").hidden = !on; $("#gear").setAttribute("aria-expanded", on);
  }
  function paintMine() {
    const m = mine();
    $("#mine_hint").innerHTML = m ? `★ Mijn pomp: <b>${esc(m.name)}</b>` : "Mijn pomp kies je met ★ in de lijst.";
    $("#gear_sum").textContent = ` ${$("#max_min").value} min · € ${$("#time_eur_h").value || 0}/u${$("#reference").value === "station" && m ? " · ★" : ""}`;
  }
  function toggleMine(s) {
    const m = mine();
    if (m && m.id === s.id) { store.set("mine", null); $("#reference").value = "nearest"; }
    else { store.set("mine", { id: s.id, name: `${s.name}${s.city ? " " + s.city : ""}` }); $("#reference").value = "station"; }
    paintMine(); run();
  }

  function paintMaxMin() { $("#max_min_out").textContent = `${$("#max_min").value} min`; if (cfg) paintMine(); }

  // Hoe vers zijn de prijzen? Groen < 8 u, geel < 16 u, rood ouder. GitHub-versie: ook volgende ophaalronde.
  const RUNS_UTC = [[6, 0], [11, 0], [17, 30]];   // = cron in deploy/site/prices.yml
  function paintFresh(h) {
    const t = h.generated_at || Math.max(0, ...Object.values(h.sources || {}));
    const el = $("#fresh");
    if (!t) { el.hidden = false; el.className = "fresh old"; el.textContent = "Nog geen prijzen opgehaald"; return; }
    const age = (Date.now() / 1000 - t) / 3600, when = new Date(t * 1000);
    let next = "";
    if (h.generated_at) {
      const now = new Date(), cand = [0, 1].flatMap((d) => RUNS_UTC.map(([hh, mm]) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + d, hh, mm)));
      const n = cand.find((x) => x > now.getTime() + 60000);
      if (n) next = ` · volgende ronde ± ${new Date(n).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}`;
    }
    el.className = "fresh " + (age < 8 ? "ok" : age < 16 ? "mid" : "old");
    el.innerHTML = `<i></i>Prijzen opgehaald <b>${ago(t)}</b> (${when.toLocaleString("nl-NL", { weekday: "short", hour: "2-digit", minute: "2-digit" })})${next}`;
    el.title = "Per pomp staat in het detail wanneer die prijs voor het laatst is bijgewerkt.";
    el.hidden = false;
  }
  async function health() {
    try {
      const h = await (await fetch("/api/health")).json();
      paintFresh(h);
      const src = Object.entries(h.sources).map(([s, t]) => `${s}: ${ago(t)}`).join(" · ") || "nog geen prijzen opgehaald";
      const n = Object.entries(h.stations_with_price).map(([c, k]) => `${c} ${k}`).join(" · ");
      $("#foot").innerHTML = (h.generated_at ? `Prijzen opgehaald door GitHub ${ago(h.generated_at)} (3× per dag)<br>` : "") + `Bronnen — ${esc(src)}<br>Pompen met prijs — ${esc(n || "0")}` +
        (h.recent_errors.length ? `<br><span class="err">Laatste fout: ${esc(h.recent_errors[0].source)} — ${esc(h.recent_errors[0].error)}</span>` : "");
    } catch { /* niet kritisch */ }
  }

  function params() {
    const qText = $("#q").value.trim(), destText = $("#dest").value.trim();
    const p = { q: asQuery(qText), fuel, tank_l: Math.max(1, liters().total), consumption: $("#consumption").value,
      radius_km: $("#radius_km").value, reference: $("#reference").value, sort: sort === "mix" ? "net" : sort,
      max_min: $("#max_min").value, time_eur_h: $("#time_eur_h").value || 0 };
    if (p.q !== qText) p.label = qText;
    if (destText) p.dest = asQuery(destText);
    if ($("#reference").value === "custom" && $("#ref_price").value) p.ref_price = $("#ref_price").value;
    if ($("#reference").value === "station") { if (mine()) p.ref_id = mine().id; else p.reference = "nearest"; }
    store.set("form", { ...p, tank_l: $("#tank_l").value, level: $("#level").value, jerry: $("#jerry").checked, q_text: qText, dest_text: destText, ref_price: $("#ref_price").value, car: $("#car").value });
    return p;
  }

  async function run() {
    const p = params();
    if (!p.q) return;
    $("#go").disabled = true; $("#go").textContent = "Zoeken…";
    try {
      const r = await fetch("/api/search?" + new URLSearchParams(p));
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail?.[0]?.msg || data.detail || data.error || r.statusText);
      remember($("#q").value.trim()); remember($("#dest").value.trim()); fillAddr([]);
      store.set("last_result", { t: Date.now(), data });
      applyDiscounts(data); last = data; lastRun = Date.now(); render(); checkAlarm(); loadTiming(); health();
    } catch (e) {
      const saved = store.get("last_result");
      if (saved && (!navigator.onLine || e instanceof TypeError)) {   // offline: laatste lijst tonen
        applyDiscounts(saved.data); last = saved.data; render();
        $("#summary").insertAdjacentHTML("afterbegin", `<span class="err">Offline: lijst van ${ago(saved.t / 1000)}.</span> `);
        return;
      }
      $("#summary").innerHTML = `<span class="err">${esc(e.message)}</span>`;
      $("#results").after($("#trip")); $("#results").innerHTML = ""; $("#picks").hidden = true; $("#trip").hidden = true; closeMap();
    } finally {
      $("#go").disabled = false; $("#go").textContent = "Zoek";
    }
  }

  // Balans dichtbij ↔ goedkoop: 0 = alleen rijafstand, 100 = alleen literprijs (beide genormaliseerd 0..1).
  function mixSort(list) {
    const w = Number($("#mix").value) / 100;
    const span = (k) => { const v = list.map(k); const lo = Math.min(...v), hi = Math.max(...v); return (x) => (hi > lo ? (k(x) - lo) / (hi - lo) : 0); };
    const nk = span((s) => s.km), np = span((s) => s.price);
    return [...list].sort((a, b) => ((1 - w) * nk(a) + w * np(a)) - ((1 - w) * nk(b) + w * np(b)));
  }

  function sortList(list) {
    if (sort === "mix") return mixSort(list);
    const k = {
      price: (s) => s.price + s.min / 1e4,
      time: (s) => s.min + s.price / 1e3,
      per_min: (s) => (calc(s).save > 0 ? -perMin(s) : 1e6 - calc(s).save),
    }[sort] || ((s) => -calc(s).save);
    return [...list].sort((a, b) => k(a) - k(b));
  }

  const TOP = 10;
  let showAll = false;
  function render() {
    const { reference, count } = last;
    const viaList = (last.via?.results || []).map((v) => ({ ...v, via: true, key: "via:" + v.id }));
    $("#viatab").hidden = !last.via;
    if (sort === "via" && !last.via) sort = "net";
    $("#sortbar").hidden = false;
    $("#mixbar").hidden = sort !== "mix";
    document.querySelectorAll("#sortbar button").forEach((b) => b.classList.toggle("on", b.dataset.sort === sort));
    byId.clear();
    viaList.forEach((v) => byId.set(v.key, v));
    last.results.forEach((s) => { s.key = s.id; byId.set(s.id, s); });
    const maxMin = $("#max_min").value;
    if (!last.results.length) {
      $("#summary").innerHTML = `Geen pompen met deze brandstof binnen <b>${maxMin} min</b> rijden. Schuif "Max. rijtijd" verder open.`;
      $("#results").after($("#trip")); $("#results").innerHTML = ""; $("#trip").hidden = true; $("#picks").hidden = true; closeMap(); return;
    }
    const fresh = last.results.filter((s) => !s.stale), old = last.results.filter((s) => s.stale);
    const all = sort === "via" ? [...viaList].sort((a, b) => calc(b).save - calc(a).save)
      : showOld() ? [...sortList(fresh), ...sortList(old)] : sortList(fresh);   // oude prijzen: onderaan of weg
    if (!all.length) all.push(...sortList(old));
    const list = showAll ? all : all.slice(0, TOP), L = liters().total;
    $("#summary").innerHTML = (reference.missing ? `<span class="err">Mijn pomp (${esc(mine()?.name || "")}) heeft geen prijs voor deze brandstof of ligt buiten de straal.</span> ` : "") +
      `<b>${L} L</b> tanken · vergeleken met <b>${esc(reference.label)}</b> à <b>€ ${fmtN(reference.price, 3)}</b> · ` +
      (sort === "via" ? `omrijden op weg naar <b>${esc(last.dest.label.split(",")[0])}</b>` : `rit heen en terug meegerekend · ${last.results.length} pompen binnen <b>${maxMin} min</b> (van ${count} in straal)`);
    const box = $("#results"), keepOpen = !$("#trip").hidden && byId.has(selId);
    box.after($("#trip"));   // detail eerst uit de lijst halen, anders verdwijnt het met innerHTML
    const myId = mine()?.id;
    box.innerHTML = `<div class="row th"><span>#</span><span>Pomp</span><span class="n">Prijs/L</span><span class="n">Besparing</span><span class="n pl">Per liter</span><span class="n tot">Totaal ${L} L</span><span class="st" title="Mijn pomp">★</span></div>` +
      list.map((s, idx) => {
        const c = calc(s), t = tone(c.save);
        const where = s.via ? `+${Math.round(c.min)} min · +${fmtN(c.km)} km omrijden` : `${fmtN(s.km)} km · ${Math.round(s.min)} min`;
        return `<div class="row t-${t}${s.stale ? " old" : ""}" style="${toneStyle(c.save)}" data-id="${esc(s.key)}" tabindex="0">
          <span class="nr">${idx + 1}</span>
          <span class="who"><span class="cc ${s.country}">${s.country}</span> <b>${esc(s.name)}</b>${s.is_reference ? ' <i class="tag ref">ref</i>' : ""}${s.stale ? ` <i class="tag stale" title="prijs ${ago(s.updated_at)}">oud</i>` : ""}${s.disc ? ` <i class="tag disc" title="tankpas-korting">−${fmtN(s.disc * 100)} ct</i>` : ""}${hoursTag(s)}
            <small>${esc(s.city || "")} · ${where}</small></span>
          <span class="n pr">€ ${fmtN(s.price, 3)}${trend(s)}</span>
          <span class="n sv ${t}">${fmtE(c.save)}</span>
          <span class="n pl ${t}">${fmtPL(c.perL)}</span>
          <span class="n tot">${fmtE(c.total)}</span>
          ${s.via ? "<span></span>" : `<button type="button" class="star${myId === s.id ? " on" : ""}" data-star="${esc(s.id)}" title="${myId === s.id ? "Mijn pomp (referentie) · klik om los te laten" : "Maak dit mijn pomp (referentie)"}">★</button>`}
        </div>`;
      }).join("") +
      (all.length > TOP ? `<button type="button" class="more-rows">${showAll ? `Alleen top ${TOP}` : `Toon alle ${all.length}`}</button>` : "") +
      (sort !== "via" && old.length ? `<p class="oldnote">${showOld() ? `${old.length} pomp(en) met een prijs ouder dan 24 u staan onderaan, gedimd.` : `${old.length} pomp(en) met een prijs ouder dan 24 u verborgen.`} <button type="button" class="linkbtn" data-old>${showOld() ? "Verberg" : "Toon toch"}</button></p>` : "");
    box.querySelectorAll(".row[data-id]").forEach((r) => {
      r.onclick = (e) => { if (!e.target.closest(".star")) select(r.dataset.id, true, false, true); };
      r.onkeydown = (e) => { if (e.key === "Enter") r.click(); };
    });
    box.querySelector(".more-rows")?.addEventListener("click", () => { showAll = !showAll; render(); });
    box.querySelectorAll("[data-star]").forEach((b) => b.onclick = () => toggleMine(byId.get(b.dataset.star)));
    box.querySelector("[data-old]")?.addEventListener("click", () => { $("#show_old").checked = !showOld(); store.set("show_old", showOld()); render(); });
    renderPicks(last.results);
    select(byId.has(selId) ? selId : all[0].key, keepOpen, !keepOpen);
  }

  async function select(key, fromList, quiet = false, toggle = false) {
    if (toggle && key === selId && !$("#trip").hidden) { $("#trip").hidden = true; document.querySelectorAll(".row.sel").forEach((r) => r.classList.remove("sel")); return; }
    selId = key;
    document.querySelectorAll(".row[data-id]").forEach((c) => c.classList.toggle("sel", c.dataset.id === key));
    document.querySelectorAll(".pick[data-key]").forEach((b) => b.classList.toggle("on", b.dataset.key === key));
    const row = document.querySelector(`.row[data-id="${CSS.escape(key)}"]`);
    const trip = $("#trip");
    if (row) row.after(trip); else $("#results").after(trip);   // detail klapt open onder de gekozen rij
    if (quiet && !fromList) { trip.hidden = true; return; }   // bij nieuwe lijst: alles dicht
    if (!fromList && row) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    renderTrip(key);
    if (mapOpen()) drawSelected();
  }

  // Kaart: alleen start, gekozen pomp (+ bestemming bij onderweg) en de route.
  async function drawSelected() {
    if (!map || !last || !selId) return;
    const s = byId.get(selId), o = last.origin, key = selId;
    if (!s) return;
    let legs;
    try { legs = await Promise.all(s.via ? [routeBetween(o, s), routeBetween(s, last.dest)] : [getRoute(s)]); } catch { return; }
    if (selId !== key || !mapOpen()) return;
    layer.clearLayers();
    for (const r of legs) {
      L.geoJSON(r.geometry, { interactive: false, style: { color: "#f5c400", weight: 6, opacity: 0.95, dashArray: r.method === "schatting" ? "6 8" : null } }).addTo(layer);
      L.geoJSON(r.geometry, { interactive: false, style: { color: "#17181a", weight: 2, opacity: 0.8 } }).addTo(layer);
    }
    L.marker([o.lat, o.lon], { icon: pin("home", "⌂"), zIndexOffset: 1000 }).addTo(layer)
      .bindTooltip(esc(o.label.split(",").slice(0, 2).join(",")), { className: "lbl" });
    if (s.via) L.marker([last.dest.lat, last.dest.lon], { icon: pin("home", "⚑"), zIndexOffset: 900 }).addTo(layer)
      .bindTooltip(esc(last.dest.label.split(",").slice(0, 2).join(",")), { className: "lbl" });
    L.marker([s.lat, s.lon], { icon: pin("sel", "€"), zIndexOffset: 800 }).addTo(layer)
      .bindTooltip(`${esc(s.name)} · € ${fmtN(s.price, 3)} · ${fmtE(calc(s).save)}`, { className: "lbl", permanent: true, direction: "top", offset: [0, -30] });
    drawTraffic(legs.map((r) => r.geometry));
    map.fitBounds(L.featureGroup(layer.getLayers()).getBounds().pad(0.15));
  }

  $("#form").addEventListener("submit", (e) => { e.preventDefault(); run(); });
  $("#sortbar").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    sort = b.dataset.sort; store.set("sort", sort);
    selId = null; showAll = false; if (last) render();
  });
  let mixT;
  $("#mix").addEventListener("input", () => {
    store.set("mix", $("#mix").value);
    clearTimeout(mixT); mixT = setTimeout(() => { if (last) { selId = null; render(); } }, 60);
  });
  $("#max_min").addEventListener("input", paintMaxMin);
  $("#max_min").addEventListener("change", () => last && run());
  let litT;
  const relit = () => { paintLiters(); params(); clearTimeout(litT); litT = setTimeout(() => last && render(), 40); };
  for (const id of ["#level", "#jerry", "#tank_l", "#time_eur_h", "#consumption"]) $(id).addEventListener("input", relit);
  $("#closemap").onclick = closeMap;
  $("#gear").onclick = () => openSettings($("#settings").hidden);
  $("#settings_close").onclick = () => openSettings(false);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") openSettings(false); });
  document.addEventListener("click", (e) => { if (!$("#settings").hidden && !e.target.closest("#settings, #gear")) openSettings(false); });
  $("#show_old").addEventListener("change", () => { store.set("show_old", showOld()); if (last) render(); });
  $("#reference").addEventListener("change", () => { paintMine(); if (last) run(); });
  $("#time_eur_h").addEventListener("input", paintMine);
  $("#trip").addEventListener("click", (e) => {
    if (e.target.closest(".showroute")) mapOpen() ? closeMap() : openMap();
    const st = e.target.closest("[data-star]"); if (st) toggleMine(byId.get(st.dataset.star));
    if (e.target.closest("[data-log]")) logTank(byId.get(selId));
  });
  $("#discounts").addEventListener("change", () => { store.set("discounts", $("#discounts").value.trim()); if (last) run(); });
  $("#alarm").addEventListener("change", () => {
    store.set("alarm", $("#alarm").value); store.set("alarm_seen", {});
    if ($("#alarm").value && "Notification" in window && Notification.permission === "default") Notification.requestPermission().then(checkAlarm);
    else checkAlarm();
  });
  init();
})();
