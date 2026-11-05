# EDR 3D Viewer

Single-page WebGL (three.js) viewer for OGC API – EDR `cube` queries returning CoverageJSON.
Controls on the left, 3D view on the right. Isosurfaces are computed in the browser with
marching cubes; slices are coloured with a colour map and contour lines.

No build step — serve the folder over HTTP and open it:

```sh
python3 -m http.server 8765
# open http://localhost:8765
```

On startup it loads the KNMI UWCW HARMONIE model-level wind speed cube (levels 10–90,
bbox 3,50.7,7.3,53.6) and draws a 4.5 kt isosurface (vertical scale ×2). Paste another EDR cube URL in the
**Data** panel and press *Apply URL & load* to change collection, instance, time, bbox or levels.

## Notes

- **Requests.** Levels are fetched 5 per request (`z=10/14`, `z=15/19`, …), 6 requests in
  parallel. *Levels / request* = 1 gives one request per level; a large value fetches the
  whole cube in one request.
- **×10 server bug.** In a multi-level response the KNMI EDR server currently returns every
  level after the first one multiplied by 10 (whole numbers only). The *×10 fix* option
  (`auto`) detects this per response and divides those levels by 10.
- **Vertical coordinate.** *Model level index* spaces levels evenly, which stretches the
  boundary layer where the 10 °C surface lives. *Pressure altitude* also loads
  `air_pressure_ml` and places every grid point at its ISA altitude.
- **Isosurface / volume.** The threshold values can be drawn as marching-cubes isosurfaces,
  as a ray-marched volume (soft band around each value, or fill above/below the first value),
  or both.
- Model level 1 is the model top (~14 hPa) and level 90 the lowest level near the surface.
- Hover over a slice or isosurface to read the value, position, model level and (if loaded)
  pressure.

## Files

- `src/edr.js` – EDR URL parsing/building, CoverageJSON → regular grid, scale fix
- `src/isosurface.js` – marching cubes on a grid with per-point heights
- `src/volume.js` – volume resampling, 3D texture and ray-marching shader
- `src/colormaps.js` – colour maps, shader texture and colour bar
- `src/main.js` – scene, UI wiring, slices, labels, picking
