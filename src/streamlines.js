// Animated streamlines: particles carried along by a horizontal wind field on model levels, drawn as
// fading trails. The wind is given per grid point in scene directions (x east-ish, y north-ish), so the
// caller has already turned it to the grid (e.g. on a rotated pole grid).
import * as THREE from 'three';

const TRAIL = 12; // positions per trail, head first

export class Streamlines {
  constructor(count = 4000) {
    this.count = count;
    this.field = null;
    this.ijk = new Float32Array(count * 3); // particle positions in grid index space
    this.age = new Float32Array(count);
    this.life = new Float32Array(count);
    this.trail = new Float32Array(count * TRAIL * 3); // scene positions, head first
    const segments = count * (TRAIL - 1);
    this.positions = new Float32Array(segments * 2 * 3);
    this.colors = new Float32Array(segments * 2 * 4);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geom.setAttribute('color', new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage));
    const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: true });
    // Depth haze: besides taking on the haze colour, distant trails also fade out, like the volume does
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <fog_fragment>', /* glsl */ `
        #ifdef USE_FOG
          float hazeFactor = smoothstep( fogNear, fogFar, vFogDepth );
          gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, hazeFactor );
          gl_FragColor.a *= 1.0 - 0.8 * hazeFactor;
        #endif`);
    };
    material.customProgramCacheKey = () => 'streamlines-haze'; // not shared with plain line materials
    this.object = new THREE.LineSegments(geom, material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 11; // after the volume, which does not write depth
    this.object.visible = false;
  }

  /**
   * field: { nx, ny, nz, u, v, speed, px, py, pz, seedable(n) → bool, crossTime, place(x, y, z) → [x, y, z] or null }
   * u, v: wind per grid point in scene directions (same unit as speed); px, py: scene x/y of columns and rows;
   * pz: scene z per grid point; seedable: whether particles may live at grid point n (e.g. inside the volume).
   * The fastest wind (99th percentile) crosses the area in crossTime seconds.
   */
  setField(field) {
    const keep = this.field && this.field.nx === field.nx && this.field.ny === field.ny && this.field.nz === field.nz;
    // The 99th percentile only depends on the speeds, not on where particles may start (e.g. the threshold)
    if (this.topOf !== field.speed) {
      const sorted = Float32Array.from(field.speed.filter((s) => s === s)).sort();
      this.top = sorted.length ? sorted[Math.floor(sorted.length * 0.99)] : 0;
      this.topOf = field.speed;
    }
    const top = this.top;
    this.field = field;
    const extX = Math.abs(field.px.at(-1) - field.px[0]), extY = Math.abs(field.py.at(-1) - field.py[0]);
    // Scene units per second for one unit of wind speed
    this.scale = top > 0 ? Math.max(extX, extY) / (top * field.crossTime) : 0;
    this.cellX = (field.px.at(-1) - field.px[0]) / Math.max(field.nx - 1, 1);
    this.cellY = (field.py.at(-1) - field.py[0]) / Math.max(field.ny - 1, 1);
    // Grid points where particles may start
    const seeds = [];
    for (let n = 0; n < field.u.length; n++) if (field.seedable(n)) seeds.push(n);
    this.seeds = seeds;
    // A new time of the same grid keeps the particles where they are, so the motion continues
    for (let p = 0; p < this.count; p++) {
      if (!keep || !this.alive(p)) this.spawn(p, Math.random());
    }
    this.writeGeometry();
  }

  alive(p) {
    const f = this.field;
    const i = this.ijk[p * 3], j = this.ijk[p * 3 + 1], k = this.ijk[p * 3 + 2];
    if (!(i >= 0 && i <= f.nx - 1 && j >= 0 && j <= f.ny - 1)) return false;
    const n = (Math.round(k) * f.ny + Math.round(j)) * f.nx + Math.round(i);
    return f.seedable(n);
  }

  // A new particle at a random seedable grid point; ageFraction spreads the ages so not all die at once
  spawn(p, ageFraction = 0) {
    const f = this.field;
    this.life[p] = 3 + Math.random() * 5;
    this.age[p] = this.life[p] * ageFraction;
    if (!this.seeds.length) {
      this.ijk[p * 3] = -1; // nothing to show
      this.trail.fill(NaN, p * TRAIL * 3, (p + 1) * TRAIL * 3);
      return;
    }
    const n = this.seeds[Math.floor(Math.random() * this.seeds.length)];
    const k = Math.floor(n / (f.nx * f.ny)), j = Math.floor((n % (f.nx * f.ny)) / f.nx), i = n % f.nx;
    const ci = Math.min(f.nx - 1, Math.max(0, i + Math.random() - 0.5));
    const cj = Math.min(f.ny - 1, Math.max(0, j + Math.random() - 0.5));
    this.ijk.set([ci, cj, k], p * 3);
    const pos = this.scenePosition(ci, cj, k);
    for (let t = 0; t < TRAIL; t++) this.trail.set(pos, (p * TRAIL + t) * 3);
  }

  // Bilinear sample of a per-point field at fractional column/row on level k
  sample(a, i, j, k) {
    const f = this.field;
    const i0 = Math.min(f.nx - 2, Math.max(0, Math.floor(i))), j0 = Math.min(f.ny - 2, Math.max(0, Math.floor(j)));
    const ti = f.nx > 1 ? i - i0 : 0, tj = f.ny > 1 ? j - j0 : 0;
    const base = k * f.nx * f.ny;
    const at = (di, dj) => a[base + Math.min(f.ny - 1, j0 + dj) * f.nx + Math.min(f.nx - 1, i0 + di)];
    return (at(0, 0) * (1 - ti) + at(1, 0) * ti) * (1 - tj) + (at(0, 1) * (1 - ti) + at(1, 1) * ti) * tj;
  }

  scenePosition(i, j, k) {
    const f = this.field;
    const x = f.px[0] + i * this.cellX, y = f.py[0] + j * this.cellY, z = this.sample(f.pz, i, j, k);
    return f.place ? f.place(x, y, z) : [x, y, z]; // place: e.g. onto the globe
  }

  update(dt) {
    if (!this.field || !this.object.visible || !this.scale) return;
    const f = this.field;
    for (let p = 0; p < this.count; p++) {
      if (this.ijk[p * 3] < 0) { if (this.seeds.length) this.spawn(p); continue; }
      this.age[p] += dt;
      const i = this.ijk[p * 3], j = this.ijk[p * 3 + 1], k = this.ijk[p * 3 + 2];
      const u = this.sample(f.u, i, j, k), v = this.sample(f.v, i, j, k);
      if (this.age[p] > this.life[p] || u !== u || v !== v) { this.spawn(p); continue; }
      const ni = i + (u * this.scale * dt) / this.cellX, nj = j + (v * this.scale * dt) / this.cellY;
      this.ijk[p * 3] = ni;
      this.ijk[p * 3 + 1] = nj;
      if (!this.alive(p)) { this.spawn(p); continue; }
      // Shift the trail one step and put the new head in front
      const start = p * TRAIL * 3;
      this.trail.copyWithin(start + 3, start, start + (TRAIL - 1) * 3);
      this.trail.set(this.scenePosition(ni, nj, k), start);
    }
    this.writeGeometry();
  }

  writeGeometry() {
    const pos = this.positions, col = this.colors;
    let o = 0, c = 0;
    for (let p = 0; p < this.count; p++) {
      // Fade in after a spawn and out before the end of life, so particles do not pop
      const fade = this.ijk[p * 3] < 0 ? 0 : Math.min(1, this.age[p] / 0.6, (this.life[p] - this.age[p]) / 0.8);
      for (let t = 0; t < TRAIL - 1; t++) {
        const a = (p * TRAIL + t) * 3, b = a + 3;
        pos[o++] = this.trail[a]; pos[o++] = this.trail[a + 1]; pos[o++] = this.trail[a + 2];
        pos[o++] = this.trail[b]; pos[o++] = this.trail[b + 1]; pos[o++] = this.trail[b + 2];
        const alphaHead = Math.max(0, fade) * 0.9 * (1 - t / (TRAIL - 1));
        const alphaTail = Math.max(0, fade) * 0.9 * (1 - (t + 1) / (TRAIL - 1));
        col.set([0.95, 0.97, 1, alphaHead, 0.95, 0.97, 1, alphaTail], c);
        c += 8;
      }
    }
    // NaN positions (no particle) are not drawn
    this.object.geometry.attributes.position.needsUpdate = true;
    this.object.geometry.attributes.color.needsUpdate = true;
  }
}
