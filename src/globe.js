// Globe projection: the flat scene (x, y along the grid in km from the centre of the data, z up) is wrapped
// around a sphere with the Earth's radius. A point goes to its real lon/lat, at its height above the sphere;
// the centre of the data lands at the origin on top of the globe, with the scene's axes there, so the view
// starts like the flat one, only curved. Everything is in the scene's units (km horizontally).
import { ecefOf, dot } from './sun.js';

export const EARTH_RADIUS = 6371; // km, the scene's horizontal unit

/**
 * geo: { lon0, lat0, kx, ky, frame } of the scene (frame: the scene axes as Earth-fixed unit vectors),
 * proj: the rotated pole of a native grid, or null; vscale: vertical scale (heights are multiplied by it).
 */
export function makeGlobe(geo, proj, vscale) {
  const { lon0, lat0, kx, ky, frame } = geo;
  const R = EARTH_RADIUS, { x: fx, y: fy, up } = frame;

  // Earth-fixed position (km, from the Earth's centre) → scene, with the centre of the globe at (0, 0, -R)
  const fromEcef = (p, out = []) => {
    out[0] = dot(fx, p);
    out[1] = dot(fy, p);
    out[2] = dot(up, p) - R;
    return out;
  };

  // lon/lat (degrees) and height (scene units, already scaled) → scene
  const placeLonLat = (lon, lat, h, out = []) => {
    const n = ecefOf(lon, lat), r = R + h;
    return fromEcef([n[0] * r, n[1] * r, n[2] * r], out);
  };

  // Flat scene point (z unscaled, as in the flat scene) → globe scene point
  const place = (x, y, z, out = []) => {
    const gx = lon0 + x / kx, gy = lat0 + y / ky; // grid coordinates: lon/lat, or rotated lon/lat
    const [lon, lat] = proj ? proj.toGeo(gx, gy) : [gx, gy];
    return placeLonLat(lon, lat, z * vscale, out);
  };

  // Globe scene point → { lon, lat, height (unscaled scene z), x, y (flat scene) }, for read-outs
  const unplace = (X, Y, Z) => {
    const p = [X * fx[0] + Y * fy[0] + (Z + R) * up[0], X * fx[1] + Y * fy[1] + (Z + R) * up[1], X * fx[2] + Y * fy[2] + (Z + R) * up[2]];
    const r = Math.hypot(p[0], p[1], p[2]);
    const lat = Math.asin(p[2] / r) * 180 / Math.PI, lon = Math.atan2(p[1], p[0]) * 180 / Math.PI;
    const [gx, gy] = proj ? proj.toRot(lon, lat) : [lon, lat];
    return { lon, lat, height: (r - R) / vscale, x: (gx - lon0) * kx, y: (gy - lat0) * ky };
  };

  // Turns a normal of the flat scene (z unscaled) at (x, y, z) into the globe scene: along the local axes there
  const mapNormal = (x, y, z, nx, ny, nz, out = []) => {
    const e = 0.5; // a small step, in km
    const p = place(x, y, z), px = place(x + e, y, z), py = place(x, y + e, z), pz = place(x, y, z + e / vscale);
    const ax = [px[0] - p[0], px[1] - p[1], px[2] - p[2]], ay = [py[0] - p[0], py[1] - p[1], py[2] - p[2]], az = [pz[0] - p[0], pz[1] - p[1], pz[2] - p[2]];
    const len = (v) => Math.hypot(v[0], v[1], v[2]) || 1;
    const lx = len(ax), ly = len(ay), lz = len(az);
    // The flat normal with the vertical scale applied, then along the local (nearly orthogonal) axes
    const sx = nx, sy = ny, sz = nz / vscale;
    for (let i = 0; i < 3; i++) out[i] = (sx * ax[i]) / lx + (sy * ay[i]) / ly + (sz * az[i]) / lz;
    const l = len(out);
    out[0] /= l; out[1] /= l; out[2] /= l;
    return out;
  };

  return { R, vscale, place, placeLonLat, unplace, mapNormal, fromEcef, centre: [0, 0, -R], proj, geo };
}
