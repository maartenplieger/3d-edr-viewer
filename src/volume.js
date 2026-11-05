// Ray-marched volume rendering of a scalar field stored in a 3D texture.
import * as THREE from 'three';

const MISSING = -60000; // fits in a half float; anything below MISSING / 2 counts as no data

/**
 * Resamples the field onto a grid that is regular in world z, bottom level first, as half floats.
 * pz holds the world height of every grid point (k = 0 is the top level).
 */
export function resampleVolume(field, nx, ny, nz, pz, zmin, zmax, uniformLevels) {
  const layer = nx * ny;
  if (uniformLevels) {
    const out = new Uint16Array(layer * nz);
    for (let t = 0; t < nz; t++) {
      const src = (nz - 1 - t) * layer;
      for (let n = 0; n < layer; n++) {
        const v = field[src + n];
        out[t * layer + n] = THREE.DataUtils.toHalfFloat(v === v ? v : MISSING);
      }
    }
    return { data: out, depth: nz };
  }
  const depth = Math.min(256, Math.max(96, nz * 2));
  const out = new Uint16Array(layer * depth);
  for (let n = 0; n < layer; n++) {
    const h = (k) => pz[k * layer + n];
    let k = nz - 1;
    for (let t = 0; t < depth; t++) {
      const z = zmin + ((zmax - zmin) * t) / (depth - 1);
      let v = NaN;
      if (z >= h(nz - 1) && z <= h(0)) {
        while (k > 0 && h(k - 1) < z) k--;
        if (k === 0) v = field[n];
        else {
          const lo = field[k * layer + n], hi = field[(k - 1) * layer + n];
          const f = (z - h(k)) / Math.max(h(k - 1) - h(k), 1e-9);
          v = lo + (hi - lo) * f;
        }
      }
      out[t * layer + n] = THREE.DataUtils.toHalfFloat(v === v ? v : MISSING);
    }
  }
  return { data: out, depth };
}

export function createVolumeMaterial(shared) {
  const uniforms = {
    ...shared, // cmap, vmin, vmax, isoValues, isoColors shared with the slice material
    vol: { value: null },
    texSize: { value: new THREE.Vector3(1, 1, 1) },
    cameraLocal: { value: new THREE.Vector3() },
    style: { value: 2 },
    isoCount: { value: 0 },
    width: { value: 1.5 },
    density: { value: 1 },
    steps: { value: 320 },
    useCmap: { value: 0 },
    cmin: { value: 0 }, // colour-map range of the volume
    cmax: { value: 1 },
  };
  return new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    vertexShader: /* glsl */ `
      uniform vec3 cameraLocal;
      varying vec3 vOrigin;
      varying vec3 vDirection;
      void main() {
        vOrigin = cameraLocal;
        vDirection = position - cameraLocal;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      precision highp sampler3D;
      uniform sampler3D vol;
      uniform sampler2D cmap;
      uniform vec3 texSize;
      uniform float cmin, cmax, width, density, steps, useCmap, isoCount;
      uniform int style;
      uniform float isoValues[4];
      uniform vec3 isoColors[4];
      varying vec3 vOrigin;
      varying vec3 vDirection;

      vec2 hitBox(vec3 o, vec3 d) {
        vec3 inv = 1.0 / d;
        vec3 t0 = (vec3(-0.5) - o) * inv, t1 = (vec3(0.5) - o) * inv;
        vec3 tmin = min(t0, t1), tmax = max(t0, t1);
        return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
      }
      float sampleVol(vec3 p) {
        return texture(vol, (p * (texSize - 1.0) + 0.5) / texSize).r;
      }
      vec3 cmapColor(float v) {
        return texture(cmap, vec2(clamp((v - cmin) / max(cmax - cmin, 1e-6), 0.0, 1.0), 0.5)).rgb;
      }
      // Opacity (0..1) and colour of the transfer function at value v.
      float transfer(float v, out vec3 col) {
        float a = 0.0;
        col = isoColors[0];
        if (style == 2) {
          for (int k = 0; k < 4; k++) {
            if (float(k) >= isoCount) break;
            float x = (v - isoValues[k]) / max(width, 1e-3);
            float w = exp(-x * x);
            if (w > a) { a = w; col = isoColors[k]; }
          }
        } else if (isoCount > 0.0) {
          float s = style == 0 ? v - isoValues[0] : isoValues[0] - v;
          a = smoothstep(-0.5 * width, 0.5 * width, s);
        }
        if (useCmap > 0.5) col = cmapColor(v);
        return a;
      }

      void main() {
        vec3 d = normalize(vDirection);
        vec2 b = hitBox(vOrigin, d);
        if (b.x > b.y) discard;
        b.x = max(b.x, 0.0);
        float dt = 1.7320508 / steps;
        float t = b.x + dt * fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
        vec3 light = normalize(vec3(-0.4, -0.6, 1.0));
        vec3 g = 1.0 / texSize;
        vec4 acc = vec4(0.0);
        for (int n = 0; n < 2048; n++) {
          if (t > b.y) break;
          vec3 p = vOrigin + d * t + 0.5;
          float v = sampleVol(p);
          if (v > -30000.0) {
            vec3 col;
            float a = transfer(v, col);
            if (a > 0.004) {
              vec3 grad = vec3(
                sampleVol(p + vec3(g.x, 0, 0)) - sampleVol(p - vec3(g.x, 0, 0)),
                sampleVol(p + vec3(0, g.y, 0)) - sampleVol(p - vec3(0, g.y, 0)),
                sampleVol(p + vec3(0, 0, g.z)) - sampleVol(p - vec3(0, 0, g.z)));
              float shade = length(grad) > 1e-4 ? 0.45 + 0.55 * abs(dot(normalize(grad), light)) : 0.8;
              float alpha = 1.0 - exp(-a * density * 12.0 * dt);
              acc.rgb += (1.0 - acc.a) * alpha * col * shade;
              acc.a += (1.0 - acc.a) * alpha;
              if (acc.a > 0.97) break;
            }
          }
          t += dt;
        }
        if (acc.a < 0.003) discard;
        gl_FragColor = vec4(acc.rgb / acc.a, acc.a);
      }`,
  });
}

export function createVolumeTexture({ data, depth }, nx, ny) {
  const tex = new THREE.Data3DTexture(data, nx, ny, depth);
  tex.format = THREE.RedFormat;
  tex.type = THREE.HalfFloatType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

const tmp = new THREE.Vector3();

// Feeds the camera position in box-local coordinates and picks the face side to rasterise:
// front faces from outside the box, back faces from inside.
export function updateVolumeCamera(mesh, camera) {
  mesh.updateWorldMatrix(true, false);
  const c = mesh.worldToLocal(tmp.copy(camera.position));
  mesh.material.uniforms.cameraLocal.value.copy(c);
  const inside = Math.abs(c.x) < 0.5 && Math.abs(c.y) < 0.5 && Math.abs(c.z) < 0.5;
  const side = inside ? THREE.BackSide : THREE.FrontSide;
  if (mesh.material.side !== side) {
    mesh.material.side = side;
    mesh.material.needsUpdate = true;
  }
}
