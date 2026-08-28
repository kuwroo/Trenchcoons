/** Simple deterministic 2D value noise + fbm (no deps). */

function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

export function valueNoise2(x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smoothstep(x - x0);
  const fy = smoothstep(y - y0);
  const a = hash2(x0, y0);
  const b = hash2(x0 + 1, y0);
  const c = hash2(x0, y0 + 1);
  const d = hash2(x0 + 1, y0 + 1);
  const u = a + (b - a) * fx;
  const v = c + (d - c) * fx;
  return u + (v - u) * fy;
}

export function fbm2(x, y, octaves = 4) {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(x * freq, y * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** Global terrain amplitude (panel-controllable). */
let _terrainAmp = 1.35;
let _terrainFreq = 1.0;

export function setTerrainParams({ amplitude, frequency } = {}) {
  if (amplitude != null) _terrainAmp = amplitude;
  if (frequency != null) _terrainFreq = frequency;
}

export function getTerrainParams() {
  return { amplitude: _terrainAmp, frequency: _terrainFreq };
}

/**
 * Terrain height in world units — multi-scale hills + ridges for clear slopes.
 */
export function terrainHeight(x, z) {
  const f = _terrainFreq;
  const hills =
    fbm2(x * 0.028 * f, z * 0.028 * f, 5) * 3.2 +
    fbm2(x * 0.01 * f + 20, z * 0.01 * f - 8, 4) * 2.8 +
    fbm2(x * 0.055 * f, z * 0.055 * f, 3) * 1.1;
  // Gentle long ridges so slopes read from camera
  const ridges =
    Math.sin(x * 0.045 * f + 0.4) * Math.cos(z * 0.038 * f) * 1.15 +
    Math.sin(z * 0.06 * f - x * 0.02 * f) * 0.65;
  // Soft valley near origin path so player still has a playable area
  const path = Math.exp(-(x * x) * 0.004 - (z - 2) * (z - 2) * 0.003) * 0.85;

  return (hills + ridges) * 0.55 * _terrainAmp - path * _terrainAmp * 0.35;
}

export function terrainNormal(x, z, eps = 0.4) {
  const hL = terrainHeight(x - eps, z);
  const hR = terrainHeight(x + eps, z);
  const hD = terrainHeight(x, z - eps);
  const hU = terrainHeight(x, z + eps);
  const nx = hL - hR;
  const ny = 2 * eps;
  const nz = hD - hU;
  const len = Math.hypot(nx, ny, nz) || 1;
  return { x: nx / len, y: ny / len, z: nz / len };
}

/** Max slope angle (radians) for grass placement when slope mask is on. */
export function slopeAngleFromNormal(n) {
  // n.y = cos(slopeAngle) for unit normal
  return Math.acos(Math.min(1, Math.max(-1, n.y)));
}
