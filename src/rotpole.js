// Rotated pole grids (PROJ ob_tran with o_proj=longlat, CF rotated_latitude_longitude).
// The scene works in the rotated coordinates, where the model grid is regular; these functions convert
// to and from real lon/lat for borders, the base map and readouts.

const D = Math.PI / 180;

const param = (wkt, names) => {
  for (const n of names) {
    const m = new RegExp(`PARAMETER\\["${n}[^"]*",\\s*(-?[\\d.eE+-]+)`, 'i').exec(wkt);
    if (m) return Number(m[1]);
  }
  return null;
};

/**
 * Reads a rotated pole CRS from WKT, as written by PROJ for "+proj=ob_tran +o_proj=longlat ..."
 * (parameters lon_0, o_lat_p, o_lon_p) or for a CF rotated pole (Pole rotation (netCDF CF convention)).
 * Returns null for other CRSs.
 */
export function parseRotatedPoleWkt(wkt) {
  if (!wkt) return null;
  let lon0, oLatP, oLonP;
  if (/ob_tran/i.test(wkt)) {
    lon0 = param(wkt, ['lon_0']) ?? 0;
    oLatP = param(wkt, ['o_lat_p']);
    oLonP = param(wkt, ['o_lon_p']) ?? 0;
  } else if (/Pole rotation/i.test(wkt)) {
    const poleLon = param(wkt, ['Grid north pole longitude']);
    oLatP = param(wkt, ['Grid north pole latitude']);
    oLonP = param(wkt, ['North pole grid longitude']) ?? 0;
    lon0 = poleLon == null ? null : poleLon + 180;
  } else {
    return null;
  }
  if (lon0 == null || oLatP == null) return null;
  if (oLonP !== 0) throw new Error(`Rotated pole with o_lon_p=${oLonP} is not supported`);
  const radius = Number(/ELLIPSOID\["[^"]*",\s*([\d.eE+]+)/i.exec(wkt)?.[1]) || 6367470;
  return makeRotatedPole({ lon0: ((lon0 + 540) % 360) - 180, oLatP, radius });
}

// The south pole of the rotated grid lies at (lon0, -oLatP); rotated (0, 0) is at (lon0, 90 - oLatP).
export function makeRotatedPole({ lon0, oLatP, radius = 6367470 }) {
  const t = (90 - oLatP) * D, st = Math.sin(t), ct = Math.cos(t);
  return {
    lon0, oLatP,
    proj4: `+proj=ob_tran +o_proj=longlat +lon_0=${lon0} +o_lat_p=${oLatP} +o_lon_p=0 +a=${radius} +e=0 +no_defs`,
    // rotated (x, y) in degrees → [lon, lat]
    toGeo(x, y) {
      const sx = Math.sin(x * D), cx = Math.cos(x * D), sy = Math.sin(y * D), cy = Math.cos(y * D);
      const lat = Math.asin(Math.max(-1, Math.min(1, ct * sy + st * cy * cx)));
      const lon = lon0 + Math.atan2(cy * sx, ct * cy * cx - st * sy) / D;
      return [((lon + 540) % 360) - 180, lat / D];
    },
    // [lon, lat] → rotated [x, y] in degrees
    toRot(lon, lat) {
      const dl = (lon - lon0) * D, sl = Math.sin(lat * D), cl = Math.cos(lat * D);
      const y = Math.asin(Math.max(-1, Math.min(1, ct * sl - st * cl * Math.cos(dl))));
      const x = Math.atan2(cl * Math.sin(dl), ct * cl * Math.cos(dl) + st * sl);
      return [x / D, y / D];
    },
  };
}

// The bbox [minx, miny, maxx, maxy] that covers bbox [x0, y0, x1, y1] after transform(x, y). The edges are sampled,
// because they are curved in the other coordinates (fine as long as no pole is inside the bbox).
function transformBBox(transform, [w, s, e, n], steps = 32) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i <= steps; i++) {
    const f = i / steps, a = w + (e - w) * f, b = s + (n - s) * f;
    for (const [u, v] of [[a, s], [a, n], [w, b], [e, b]]) {
      const [x, y] = transform(u, v);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  const r = (v) => +v.toFixed(4);
  return [r(x0), r(y0), r(x1), r(y1)];
}

// Rotated bbox that covers a lon/lat bbox [W, S, E, N], for cube requests with the native crs.
export const bboxToRot = (proj, bbox) => transformBBox(proj.toRot, bbox);
// Lon/lat bbox [W, S, E, N] that covers a rotated bbox.
export const bboxToGeo = (proj, bbox) => transformBBox(proj.toGeo, bbox);

// The rotated pole CRS that a collection offers for cube requests, as { crs, proj } or null.
export function nativeCubeCrs(collection) {
  const details = collection?.data_queries?.cube?.link?.variables?.crs_details || [];
  for (const d of details) {
    const proj = parseRotatedPoleWkt(d.wkt);
    if (proj) return { crs: d.crs, proj };
  }
  return null;
}
