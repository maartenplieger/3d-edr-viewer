// Land and sea from vectors: the Natural Earth land polygons, coastlines and country borders of the world-atlas
// TopoJSON (the same file as the vector borders), drawn into a canvas in a given projection. Used as the base map
// texture instead of a WMS image: the world in lon/lat for the globe, or the data's area in the grid's own
// coordinates (also a rotated pole grid) for the map under the data.

export const VECTOR_LAYER = 'vector:naturalearth';

// Colours for the dark theme; the materials multiply them with the map brightness
const STYLE = {
  sea: '#1f5577',
  land: '#6b7d62',
  coast: 'rgba(205, 220, 230, 0.55)',
  borders: 'rgba(205, 220, 230, 0.3)',
};

/**
 * land: polygons (arrays of rings of [lon, lat]); borders: lines (arrays of [lon, lat]);
 * project(lon, lat) → [x, y] in canvas pixels; period: the canvas width of 360° of longitude in the projection
 * (rings crossing the date line of the projection are unwrapped and drawn shifted as well).
 */
export function drawVectorMap({ land, borders, width, height, project, period }) {
  // An OffscreenCanvas in the worker (vectorworker.js), a canvas element on the main thread
  const canvas = typeof document === 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  // Drawn by the CPU (willReadFrequently): an accelerated canvas is drawn in the browser's GPU process, which the
  // WebGL view shares, so the view would wait for these thousands of polygons even with the drawing in a worker
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = STYLE.sea;
  ctx.fillRect(0, 0, width, height);
  const lw = Math.max(0.8, width / 4096);

  // Projected ring, unwrapped so it has no jumps of more than half a period; with its x range
  const unwrap = (ring) => {
    const out = [];
    let prevX = null, shift = 0, min = Infinity, max = -Infinity;
    for (const [lon, lat] of ring) {
      const p = project(lon, lat);
      if (!p) continue;
      let x = p[0] + shift;
      if (prevX != null && period) {
        while (x - prevX > period / 2) { shift -= period; x -= period; }
        while (prevX - x > period / 2) { shift += period; x += period; }
      }
      prevX = x;
      out.push(x, p[1]);
      if (x < min) min = x;
      if (x > max) max = x;
    }
    return { pts: out, min, max };
  };
  // The shifts (multiples of the period) at which a shape with this x range shows on the canvas: only those
  // where it overlaps it (usually just 0)
  const shifts = (min, max) => {
    if (!period) return [0];
    const list = [];
    for (let k = Math.floor(-max / period) + 1; k < Math.ceil((width - min) / period); k++) list.push(k * period);
    return list;
  };
  const trace = (pts, dx) => {
    ctx.moveTo(pts[0] + dx, pts[1]);
    for (let n = 2; n < pts.length; n += 2) ctx.lineTo(pts[n] + dx, pts[n + 1]);
  };

  // Land: all polygons with their holes in one path, filled once (even-odd: the polygons do not overlap, so the
  // holes stay open); one fill per polygon took seconds with the thousands in the file. The same path stroked is
  // the coast.
  ctx.beginPath();
  for (const polygon of land) {
    const parts = polygon.map(unwrap).filter((r) => r.pts.length >= 6);
    if (!parts.length) continue;
    let min = Infinity, max = -Infinity;
    for (const r of parts) { if (r.min < min) min = r.min; if (r.max > max) max = r.max; }
    for (const dx of shifts(min, max)) for (const r of parts) { trace(r.pts, dx); ctx.closePath(); }
  }
  ctx.fillStyle = STYLE.land;
  ctx.fill('evenodd');
  ctx.lineJoin = 'round';
  ctx.strokeStyle = STYLE.coast;
  ctx.lineWidth = lw;
  ctx.stroke();

  // Country borders: lines, broken where the projection jumps (a line is not unwrapped like a closed ring)
  if (borders) {
    ctx.strokeStyle = STYLE.borders;
    ctx.lineWidth = lw * 0.8;
    ctx.beginPath();
    for (const line of borders) {
      let prev = null;
      for (const [lon, lat] of line) {
        const p = project(lon, lat);
        if (!p) { prev = null; continue; }
        if (prev && (!period || Math.abs(p[0] - prev[0]) < period / 2)) ctx.lineTo(p[0], p[1]);
        else ctx.moveTo(p[0], p[1]);
        prev = p;
      }
    }
    ctx.stroke();
  }
  return canvas;
}

// project() and period for an area in grid coordinates ([x0, y0, x1, y1]: lon/lat, or rotated lon/lat with
// proj) drawn into a width × height canvas
export function gridProjection(bbox, proj, width, height) {
  const [x0, y0, x1, y1] = bbox, sx = width / (x1 - x0), sy = height / (y1 - y0);
  return {
    period: 360 * sx,
    project: (lon, lat) => {
      const [gx, gy] = proj ? proj.toRot(lon, lat) : [lon, lat];
      return [(gx - x0) * sx, (y1 - gy) * sy];
    },
  };
}

// The land polygons of a world-atlas TopoJSON (its "land" object, or the countries merged), as arrays of rings
export function landPolygons(topojson, topo) {
  const geom = topo.objects.land ? topojson.feature(topo, topo.objects.land) : topojson.merge(topo, topo.objects.countries.geometries);
  const geoms = geom.type === 'FeatureCollection' ? geom.features.map((f) => f.geometry) : [geom.geometry ?? geom];
  const out = [];
  for (const g of geoms) {
    if (!g) continue;
    if (g.type === 'Polygon') out.push(g.coordinates);
    else if (g.type === 'MultiPolygon') out.push(...g.coordinates);
  }
  return out;
}
