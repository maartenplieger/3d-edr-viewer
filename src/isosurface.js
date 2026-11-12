// Marching cubes over a regular (i, j, k) grid whose vertices may be displaced vertically
// (terrain-following / pressure-based heights).
import { edgeTable, triTable } from './mctables.js';

// Corner and edge numbering as in Paul Bourke's tables (used by three.js).
const CORNERS = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
const EDGE_BASE = EDGES.map(([a, b]) => {
  const ca = CORNERS[a], cb = CORNERS[b];
  return { base: ca.map((v, d) => Math.min(v, cb[d])), axis: ca.findIndex((v, d) => v !== cb[d]) };
});

/**
 * Field gradient in world units at grid point (i, j, k), written to out[o..o+2]. Central
 * differences, one-sided at borders or next to missing values.
 */
function gradient(field, nx, ny, nz, px, py, pz, i, j, k, out, o) {
  const idx = (a, b, c) => (c * ny + b) * nx + a;
  const p = idx(i, j, k), f = field[p];
  const diff = (pm, pp, cm, cp) => {
    const fm = pm < 0 ? NaN : field[pm], fp = pp < 0 ? NaN : field[pp];
    if (fm === fm && fp === fp) return (fp - fm) / (cp - cm || 1);
    if (fp === fp) return (fp - f) / (cp - cm || 1);
    if (fm === fm) return (f - fm) / (cp - cm || 1);
    return 0;
  };
  const im = i > 0 ? i - 1 : -1, ip = i < nx - 1 ? i + 1 : -1;
  const jm = j > 0 ? j - 1 : -1, jp = j < ny - 1 ? j + 1 : -1;
  const km = k > 0 ? k - 1 : -1, kp = k < nz - 1 ? k + 1 : -1;
  out[o] = diff(im < 0 ? -1 : idx(im, j, k), ip < 0 ? -1 : idx(ip, j, k), px[im < 0 ? i : im], px[ip < 0 ? i : ip]);
  out[o + 1] = diff(jm < 0 ? -1 : idx(i, jm, k), jp < 0 ? -1 : idx(i, jp, k), py[jm < 0 ? j : jm], py[jp < 0 ? j : jp]);
  const pzm = km < 0 ? -1 : idx(i, j, km), pzp = kp < 0 ? -1 : idx(i, j, kp);
  out[o + 2] = diff(pzm, pzp, pz[pzm < 0 ? p : pzm], pz[pzp < 0 ? p : pzp]);
}

/**
 * @param field Float32Array of size nx*ny*nz, index (k*ny + j)*nx + i; NaN cells are skipped
 * @param px Float32Array(nx) world x per column i
 * @param py Float32Array(ny) world y per row j
 * @param pz Float32Array(nx*ny*nz) world z per grid point
 * @returns {{positions: Float32Array, normals: Float32Array, ijk: Float32Array, indices: Uint32Array}}
 *   normals come from the field gradient, which shades much smoother than face normals on the
 *   flat, wide cells of atmospheric grids.
 */
export function marchingCubes(field, nx, ny, nz, iso, px, py, pz) {
  const positions = [], normals = [], ijk = [], indices = [];
  const g = new Float32Array(6);
  const vid = new Map(); // edge id → vertex index, only for edges the surface crosses
  const cellVerts = new Int32Array(12);
  const idx = (i, j, k) => (k * ny + j) * nx + i;

  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        let cube = 0, bad = false;
        for (let c = 0; c < 8; c++) {
          const o = CORNERS[c];
          const v = field[idx(i + o[0], j + o[1], k + o[2])];
          if (v !== v) { bad = true; break; }
          if (v < iso) cube |= 1 << c;
        }
        if (bad) continue;
        const edges = edgeTable[cube];
        if (edges === 0) continue;

        for (let n = 0; n < 12; n++) {
          if (!(edges & (1 << n))) continue;
          const { base, axis } = EDGE_BASE[n];
          const bi = i + base[0], bj = j + base[1], bk = k + base[2];
          const p0 = idx(bi, bj, bk);
          const key = p0 * 3 + axis;
          let v = vid.get(key);
          if (v === undefined) {
            const ei = bi + (axis === 0), ej = bj + (axis === 1), ek = bk + (axis === 2);
            const p1 = idx(ei, ej, ek);
            const f0 = field[p0], f1 = field[p1];
            const t = f1 === f0 ? 0.5 : (iso - f0) / (f1 - f0);
            v = positions.length / 3;
            positions.push(
              px[bi] + (px[ei] - px[bi]) * t,
              py[bj] + (py[ej] - py[bj]) * t,
              pz[p0] + (pz[p1] - pz[p0]) * t,
            );
            ijk.push(bi + (ei - bi) * t, bj + (ej - bj) * t, bk + (ek - bk) * t);
            gradient(field, nx, ny, nz, px, py, pz, bi, bj, bk, g, 0);
            gradient(field, nx, ny, nz, px, py, pz, ei, ej, ek, g, 3);
            const gx = g[0] + (g[3] - g[0]) * t, gy = g[1] + (g[4] - g[1]) * t, gz = g[2] + (g[5] - g[2]) * t;
            const len = Math.hypot(gx, gy, gz);
            if (len > 0) normals.push(gx / len, gy / len, gz / len);
            else normals.push(0, 0, 1);
            vid.set(key, v);
          }
          cellVerts[n] = v;
        }
        const o = cube * 16;
        for (let t = 0; triTable[o + t] !== -1; t += 3) {
          indices.push(cellVerts[triTable[o + t]], cellVerts[triTable[o + t + 1]], cellVerts[triTable[o + t + 2]]);
        }
      }
    }
  }
  // Make the normals agree with the triangle winding (DoubleSide lighting flips by facing).
  let agree = 0;
  const step = Math.max(3, Math.floor(indices.length / 3 / 4000) * 3);
  for (let t = 0; t < indices.length; t += step) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    agree += (uy * vz - uz * vy) * normals[a] + (uz * vx - ux * vz) * normals[a + 1] + (ux * vy - uy * vx) * normals[a + 2];
  }
  if (agree < 0) for (let n = 0; n < normals.length; n++) normals[n] = -normals[n];

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    ijk: new Float32Array(ijk),
    indices: new Uint32Array(indices),
  };
}
