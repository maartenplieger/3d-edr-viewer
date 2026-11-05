// Marching cubes over a regular (i, j, k) grid whose vertices may be displaced vertically
// (terrain-following / pressure-based heights).
import { edgeTable, triTable } from 'three/addons/objects/MarchingCubes.js';

// Corner and edge numbering as in Paul Bourke's tables (used by three.js).
const CORNERS = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
const EDGE_BASE = EDGES.map(([a, b]) => {
  const ca = CORNERS[a], cb = CORNERS[b];
  return { base: ca.map((v, d) => Math.min(v, cb[d])), axis: ca.findIndex((v, d) => v !== cb[d]) };
});

/**
 * @param field Float32Array of size nx*ny*nz, index (k*ny + j)*nx + i; NaN cells are skipped
 * @param px Float32Array(nx) world x per column i
 * @param py Float32Array(ny) world y per row j
 * @param pz Float32Array(nx*ny*nz) world z per grid point
 * @returns {{positions: Float32Array, ijk: Float32Array, indices: Uint32Array}}
 */
export function marchingCubes(field, nx, ny, nz, iso, px, py, pz) {
  const positions = [], ijk = [], indices = [];
  const vid = new Int32Array(nx * ny * nz * 3).fill(-1);
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
          let v = vid[key];
          if (v < 0) {
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
            vid[key] = v;
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
  return {
    positions: new Float32Array(positions),
    ijk: new Float32Array(ijk),
    indices: new Uint32Array(indices),
  };
}
