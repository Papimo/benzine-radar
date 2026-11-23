// Eigen kaartstijl "Wegdek": alleen wegen, water, landsgrenzen en namen (OpenFreeMap-vectortegels, geen key).
// Keuze uit design/index.html (optie 4). Licht = beton, donker = asfalt, snelwegen signaalgeel.
window.BR_MAPSTYLE = (() => {
  const NAME = ["coalesce", ["get", "name:nl"], ["get", "name:latin"], ["get", "name"]];
  const PAL = {
    light: { bg: "#ecebe6", water: "#c9d6db", minor: "#ffffff", sec: "#ffffff", secCase: "#d3d0c6", prim: "#ffffff", primCase: "#b9b6ab",
      mw: "#f5c400", mwCase: "#a88600", border: "#8a5a9e", ink: "#17181a", muted: "#64666b", refInk: "#17181a" },
    dark: { bg: "#23262a", water: "#1b3442", minor: "#3d4148", sec: "#535860", secCase: "#1a1c1f", prim: "#6c727b", primCase: "#1a1c1f",
      mw: "#f5c400", mwCase: "#17181a", border: "#b48ac7", ink: "#ecebe6", muted: "#9a9ca1", refInk: "#17181a" },
  };
  const cls = (a) => ["match", ["get", "class"], a, true, false];
  const road = (id, classes, color, w, minzoom, casing) => {
    // Zoom-expressie moet bovenaan staan (["+", interpolate, 2] keurt MapLibre af → hele stijl weg, kaart zwart).
    const iw = (d) => ["interpolate", ["exponential", 1.5], ["zoom"], 7, w[0] + d, 12, w[1] + d, 16, w[2] + d];
    const width = iw(0);
    const base = { type: "line", source: "o", "source-layer": "transportation", minzoom, filter: cls(classes), layout: { "line-cap": "round", "line-join": "round" } };
    const L = [];
    if (casing) L.push({ ...base, id: id + "-c", paint: { "line-color": casing, "line-width": iw(2) } });
    L.push({ ...base, id, paint: { "line-color": color, "line-width": width } });
    return L;
  };
  function style(dark) {
    const p = dark ? PAL.dark : PAL.light;
    const label = (id, classes, font, size, color, minzoom = 0) => ({ id, type: "symbol", source: "o", "source-layer": "place", minzoom, filter: cls(classes),
      layout: { "text-field": NAME, "text-font": [font], "text-size": size }, paint: { "text-color": color, "text-halo-color": p.bg, "text-halo-width": 2 } });
    return {
      version: 8, glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
      sources: { o: { type: "vector", url: "https://tiles.openfreemap.org/planet" } },
      layers: [
        { id: "bg", type: "background", paint: { "background-color": p.bg } },
        { id: "water", type: "fill", source: "o", "source-layer": "water", paint: { "fill-color": p.water } },
        { id: "river", type: "line", source: "o", "source-layer": "waterway", minzoom: 9, filter: cls(["river", "canal"]), paint: { "line-color": p.water, "line-width": 1.6 } },
        ...road("tert", ["tertiary", "minor"], p.minor, [0, .6, 5], 13),
        ...road("sec", ["secondary"], p.sec, [.2, 1.4, 8], 10),
        ...road("prim", ["primary"], p.prim, [.5, 2.6, 12], 7, p.primCase),
        ...road("trunk", ["trunk"], p.prim, [.8, 3.2, 14], 6, p.primCase),
        ...road("mw", ["motorway"], p.mw, [1, 4, 16], 5, p.mwCase),
        { id: "border", type: "line", source: "o", "source-layer": "boundary", filter: ["all", ["==", ["get", "admin_level"], 2], ["!=", ["get", "maritime"], 1]],
          paint: { "line-color": p.border, "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1, 12, 2.5], "line-dasharray": [3, 2] } },
        { id: "ref", type: "symbol", source: "o", "source-layer": "transportation_name", minzoom: 8, filter: ["all", cls(["motorway", "trunk"]), ["has", "ref"]],
          layout: { "symbol-placement": "line", "symbol-spacing": 400, "text-field": ["get", "ref"], "text-font": ["Noto Sans Bold"], "text-size": 11, "text-rotation-alignment": "viewport" },
          paint: { "text-color": p.refInk, "text-halo-color": p.mw, "text-halo-width": 3 } },
        { id: "roadname", type: "symbol", source: "o", "source-layer": "transportation_name", minzoom: 14, filter: cls(["primary", "secondary"]),
          layout: { "symbol-placement": "line", "text-field": NAME, "text-font": ["Noto Sans Regular"], "text-size": 11 },
          paint: { "text-color": p.muted, "text-halo-color": p.bg, "text-halo-width": 1.5 } },
        label("village", ["village"], "Noto Sans Regular", 11, p.muted, 12),
        label("town", ["town"], "Noto Sans Bold", 13, p.ink, 8),
        label("city", ["city"], "Noto Sans Bold", 16, p.ink),
      ],
    };
  }
  // Verbruik in L/100 km per soort weg (praktijkwaarden, benzine). Snelweg hangt af van de snelheid die er geldt.
  const CARS = {
    standaard: { name: "Middenklasse benzine, 2.0 atmosferisch (standaard)", bebouwd: 7.2, buitenweg: 5.2, s100: 5.6, s120: 6.4, s130: 7.0 },
    compact: { name: "Compacte benzine, 1.5 turbo", bebouwd: 6.6, buitenweg: 4.8, s100: 5.2, s120: 5.9, s130: 6.5 },
    hybride: { name: "Kleine hybride", bebouwd: 3.6, buitenweg: 3.9, s100: 4.6, s120: 5.4, s130: 6.0 },
    suv: { name: "SUV benzine, 1.6 turbo", bebouwd: 8.8, buitenweg: 6.4, s100: 7.0, s120: 8.0, s130: 8.8 },
    eigen: { name: "Eigen verbruik (vast, uit veld Verbruik)" },
  };
  const per100 = (car, type, limit, own) => {
    const c = CARS[car];
    if (!c || car === "eigen") return own;
    if (type !== "snelweg") return c[type];
    return limit >= 130 ? c.s130 : limit >= 120 ? c.s120 : c.s100;
  };
  const mixed = (car) => { const c = CARS[car]; return c && c.bebouwd ? +((c.bebouwd + c.buitenweg + c.s100) / 3).toFixed(1) : null; };
  return { style, CARS, per100, mixed };
})();
