# EDR 3D Viewer

Single-page WebGL (three.js) viewer for OGC API – EDR `cube` queries returning CoverageJSON.

**Live:** https://maartenplieger.github.io/3d-edr-viewer/ · **Source:** https://github.com/maartenplieger/3d-edr-viewer

![The jet stream over Europe from the KNMI HARMONIE DINI model: wind speed above 50 kt as a volume, with streamlines of the derived wind, above the base map and the earth surface](docs/screenshot.png)

Controls on the left, 3D view on the right. Isosurfaces are computed in the browser with
marching cubes; slices are coloured with a colour map and contour lines.

Built with [Vite](https://vite.dev) (Node.js 20.19 or newer):

```sh
npm install
npm run dev       # development server with live reload: http://localhost:8765
npm run build     # single-page app in dist/
npm run preview   # serve dist/ at http://localhost:8765 to check the build
```

`dist/` is a static single-page app with relative paths: copy it to any web server, at any path. Every push to
`main` builds it and publishes it on GitHub Pages (`.github/workflows/deploy.yml`; the repository needs
*Settings → Pages → Source: GitHub Actions*). three.js and
topojson-client come from npm (`package.json`); the coastline/border data and the base maps are fetched at
run time.

On startup it applies the first preset, *Jet stream – DINI (uwcw-ha-det-dini-5p5km, geoservices)*: KNMI UWCW HARMONIE model-level wind
speed for the latest run over the full model domain (every 4th level from level 4, 4×4 averaged), as a volume filled
above 50 kt with vertical scale ×10. To use other data, enter an EDR
endpoint (e.g. `https://geoservices.knmi.nl/edr`) or a collection URL (`…/edr/collections/{id}`) at the top of
the **Data** panel and press Enter or *Open*. An endpoint lists all its collections with at least two levels
(and a cube query) under *Collection*, and opens the first; pick another there. A complete cube URL can still
be pasted under *Paste a cube URL* at the bottom of the panel.

## Notes

- **Panel.** « at the top of the panel hides it, so the 3D view gets the whole window; ☰ in the view bar
  brings it back. The choice is remembered in the browser.
- **Grid cells.** *Appearance → Grid cells* draws the cells in use: their edges on the ground, and on the
  west and north walls a line per column and per loaded level (following the actual heights in pressure
  altitude mode). With a horizontal step these are the averaged cells, on a native grid the native cells.
- **Wind with streamlines.** When a collection has both wind speed and wind direction
  (`wind_speed…` and `wind_from_direction…`), the parameter list ends with *Wind: speed + direction, with
  streamlines*. It loads both: the speed is drawn as usual, and 4000 particles with fading trails move with the
  wind on their model level (*Streamlines* in the view bar switches them off). The fastest wind crosses the area
  in about 12 s, so the speed is shown relatively, not in real time. Particles start where the volume is drawn:
  with *fill above* only above the threshold, so they trace e.g. the jet stream. The direction (where the wind
  comes from, clockwise from true north) is turned to grid north per column on a rotated pole grid. With a
  horizontal step directions are averaged as unit vectors, so 350° and 10° give 0°, not 180°. Hovering shows the
  direction too.
- **Kinds of levels.** EDR gives no usable vertical CRS here (`customvrs`), so the kind is told from the
  collection and parameter names: `…pl` are pressure levels (hPa), `…hagl` / `…height` heights above ground
  (m), anything else model levels (1 = top). Requests use the collection's own level values: a run of
  consecutive levels as a range (`z=200/850`), otherwise a list. *Level from/to* select a range of those values,
  and switch to all levels when a collection has other levels than the previous one. Pressure levels are drawn at
  their ISA height and heights at their height, with labels like `500 hPa` or `1000 m`; model levels are spaced
  evenly, or by their pressure in *Pressure altitude* mode.
- **Large grids.** To keep sliders smooth at full resolution: isosurfaces of grids above 500k points are
  computed in a web worker (`src/isoworker.js`), only for the newest slider value, while the previous surface
  stays visible; while only the volume is shown no isosurface is computed at all. The volume threshold and
  density are shader settings and follow the slider directly; streamline starting points follow once the slider
  settles. The view is only drawn when something changes, so an idle view costs almost nothing. If dragging the
  camera is still heavy, lower the volume *Quality* (ray-marching steps) or use a horizontal or vertical step.
- **Points read.** The HUD shows how many values were read from the server (grid × levels × parameters), how
  many of them had no data, and with a horizontal step how many points are shown after averaging.
- **View controls.** The bar at the top left of the 3D view has the parameter and the time (changing either
  loads it; ‹ › step to the previous or next time), the threshold (the first isosurface value, also the
  volume's fill threshold) with the volume density below it, how it is shown (volume filled above, below or in a band around the threshold, or
  an isosurface) and the vertical scale. They drive the same controls as the panel and stay in sync with it.
- **Animation.** ▶ next to the time steps through all times of the run and wraps around; the menu next to it
  sets the time per frame. While one time is shown, the next is loaded. Every loaded cube stays in memory
  (up to 1 GB, oldest used dropped first), so a second loop, or going back to a time, needs no request. The
  *Load* button always fetches from the server again. A manual load or time change stops the animation.
- **Flying.** Fly through the scene with the keyboard, like a plane with inertia. <kbd>W</kbd>/<kbd>S</kbd>
  speed up and slow down along the nose (past zero you fly backwards), <kbd>A</kbd>/<kbd>D</kbd> push sideways,
  <kbd>Q</kbd>/<kbd>E</kbd> down/up, and the arrow keys turn and pitch, with a smooth start and stop. After you
  let go of the keys the plane keeps its speed (the path follows the nose in a turn); brake with <kbd>S</kbd>.
  The top speed is low, so it never goes fast; <kbd>Shift</kbd> gives 2× thrust and top speed, <kbd>Space</kbd> stops at once. In a turn the view banks and the
  nose lifts a little, and climbing or descending tilts the nose, like a plane. While flying, the bottom right
  shows the position (lon/lat), the height (model level, or km in pressure altitude mode), the speed and the
  heading. Speeds follow the size of the loaded area. Using the mouse stops the flight, levels the view and
  moves the orbit point to the data ahead. Keys are ignored while a panel field has the focus; click the view
  to fly again. *Appearance → Sky with horizon and stars* adds a reference while flying: a sky dome with the
  true horizon and stars, infinitely far away, so turning, pitching and banking show against it. *Earth surface
  around the data* continues the base map over about seven times the data area, with faint degree lines, as a
  reference for height and motion when flying low. The preset switches both on.
- **Presets.** The *Presets* section applies a complete view in one click; the first one is also the start
  view. Presets are defined in the `PRESETS` list in `src/main.js`.
  - *Jet stream – DINI (uwcw-ha-det-dini-5p5km, geoservices)*: KNMI UWCW HARMONIE DINI from
    `geoservices.knmi.nl`, wind speed on the full model domain, every 4th model level from level 4 (8 levels
    per request), 4×4 averaged, as a
    volume filled above 50 kt with vertical scale ×10, with the sky and the earth surface on.
  - *Jet stream – Nordic (MEPS, meteocore)*: the MEPS forecast from FMI's meteocore
    (`https://meteocore.app.meteo.fi/edr`), wind speed on 13 pressure levels (1000–50 hPa) at their height,
    filled above 25 m/s (≈ 50 kt) with vertical scale ×15. The full domain at the native 2.5 km grid is over
    meteocore's limit of a million values per request, so the server resamples it to 300×300 points.
- **Server resolution.** *Server resolution* (e.g. `300x300`) asks the server to resample the data to that
  many points in x and y (EDR `resolution-x` / `resolution-y`), for servers that support it; empty uses the
  server's own grid. Unlike the horizontal step, which averages after downloading, this makes the requests
  smaller, which servers with a size limit need for large areas.

- **Native grid.** When a collection lists a rotated pole CRS in the cube's `crs_details` (adaguc-server
  with `crs=native`), the *Grid* selector offers it and uses it by default. The cube then comes back on the
  model's own grid, without resampling. The scene is built in rotated coordinates, where that grid is regular.
  Borders are rotated to match, the base map is requested from the WMS in the same `PROJ4:` CRS, and hover
  shows real lon/lat. The bbox fields stay lon/lat; as EDR requires, the request bbox is in the coordinates
  of `crs`, so it is converted to the rotated box that covers it, and the server returns the native cells
  inside that.
- **Requests.** Levels are fetched 5 per request (`z=10/14`, `z=15/19`, …), 6 requests in
  parallel. *Levels / request* = 1 gives one request per level; a large value fetches the
  whole cube in one request.
  *Vertical step* n loads only every n-th level from *Level from* (e.g. 1, 4, 7, … for 3), requested as a
  list (`z=1,4,7,10,13`); that means fewer requests and faster loading, at a coarser vertical resolution.
- **×10 server bug.** In a multi-level response the KNMI EDR server currently returns every
  level after the first one multiplied by 10 (whole numbers only). The *×10 fix* option
  (`auto`) detects this per response and divides those levels by 10.
- **Vertical coordinate.** *Model level index* spaces levels evenly, which stretches the
  boundary layer where the 10 °C surface lives. *Pressure altitude* also loads
  `air_pressure_ml` and places every grid point at its ISA altitude.
- **Isosurface / volume.** The threshold values can be drawn as marching-cubes isosurfaces,
  as a ray-marched volume (soft band around each value, or fill above/below the first value),
  or both.
- **Full model domain.** The *Full model domain* button sets the bbox to the collection's
  extent (≈ −42…39°E, 38…70°N, 676×564 points per level at the server's native spacing) and
  loads it. *Horizontal step* `auto` averages blocks of n×n points while loading so each level
  stays below ~100k points (2×2 for the full domain). Points outside the model domain come back as
  `-9999` and are treated as missing. *Netherlands* switches back to the default bbox.
- **Base map.** The bottom of the cube shows a GetMap image from the KNMI `baselayers` WMS
  (`https://geoservices.knmi.nl/wms?DATASET=baselayers`), requested in CRS:84 for the cube's
  bbox. Pick another layer or *None* under Appearance; vector borders are optional.
- **Depth haze.** Data further from the viewer fades slightly towards a blue-grey haze
  (Appearance → *Depth haze*, *Haze amount*). The fog range is fitted to the scene every frame,
  so the effect looks the same at any zoom level; the volume applies it per ray sample.
- Model level 1 is the model top (~14 hPa) and level 90 the lowest level near the surface.
- Hover over a slice or isosurface to read the value, position, model level and (if loaded)
  pressure.

## Files

- `src/edr.js` – EDR URL parsing/building, CoverageJSON → regular grid, scale fix
- `src/isosurface.js` – marching cubes on a grid with per-point heights (`src/mctables.js`: its lookup tables)
- `src/isoworker.js` – computes isosurfaces of large grids off the main thread
- `src/streamlines.js` – particles with trails moving with the derived wind
- `src/volume.js` – volume resampling, 3D texture and ray-marching shader
- `src/rotpole.js` – rotated pole CRS from WKT, rotated ↔ lon/lat
- `src/colormaps.js` – colour maps, shader texture and colour bar
- `src/main.js` – scene, UI wiring, slices, labels, picking
- `public/favicon.svg` – the icon: the ADAGUC globe seen from space, with a data cube and a jet stream
- `vite.config.js` – dev server and build settings

## Licence

Copyright 2026 Maarten Plieger. Licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE)
for the third-party parts: the marching cubes tables from three.js (MIT), and the bundled three.js (MIT) and
topojson-client (ISC).
