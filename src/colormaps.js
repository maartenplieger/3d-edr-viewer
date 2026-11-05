import * as THREE from 'three';

const STOPS = {
  viridis: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'],
  coolwarm: ['#053061', '#2166ac', '#4393c3', '#92c5de', '#d1e5f0', '#f7f7f7', '#fddbc7', '#f4a582', '#d6604d', '#b2182b', '#67001f'],
  magma: ['#000004', '#1c1044', '#4f127b', '#812581', '#b5367a', '#e55064', '#fb8761', '#fec287', '#fcfdbf'],
  greys: ['#111111', '#f0f0f0'],
};

export const COLORMAP_NAMES = ['turbo', 'coolwarm', 'viridis', 'magma', 'greys'];

export const hexToRgb = (h) => [1, 3, 5].map((o) => parseInt(h.slice(o, o + 2), 16) / 255);

// Returns sRGB [r, g, b] in 0..1 for t in 0..1.
export function sampleColormap(name, t) {
  t = Math.min(1, Math.max(0, t));
  if (name === 'turbo') {
    const r = 0.13572138 + t * (4.6153926 + t * (-42.66032258 + t * (132.13108234 + t * (-152.94239396 + t * 59.28637943))));
    const g = 0.09140261 + t * (2.19418839 + t * (4.84296658 + t * (-14.18503333 + t * (4.27729857 + t * 2.82956604))));
    const b = 0.1066733 + t * (12.64194608 + t * (-60.58204836 + t * (110.36276771 + t * (-89.90310912 + t * 27.34824973))));
    return [r, g, b].map((c) => Math.min(1, Math.max(0, c)));
  }
  const stops = (STOPS[name] || STOPS.viridis).map(hexToRgb);
  const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  return stops[i].map((c, n) => c + (stops[i + 1][n] - c) * f);
}

export function colormapHex(name, t) {
  return '#' + sampleColormap(name, t).map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
}

export function makeColormapTexture(name) {
  const n = 256, data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const [r, g, b] = sampleColormap(name, i / (n - 1));
    data.set([r * 255, g * 255, b * 255, 255], i * 4);
  }
  const tex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

export function drawColorbar(canvas, name, isoMarks = []) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  for (let x = 0; x < w; x++) {
    ctx.fillStyle = colormapHex(name, x / (w - 1));
    ctx.fillRect(x, 0, 1, h);
  }
  for (const { t, color } of isoMarks) {
    if (t < 0 || t > 1) continue;
    const x = Math.round(t * (w - 1));
    ctx.fillStyle = '#000';
    ctx.fillRect(x - 2, 0, 5, h);
    ctx.fillStyle = color;
    ctx.fillRect(x - 1, 0, 3, h);
  }
}
