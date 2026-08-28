import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GrassField } from './grassField.js';
import { terrainHeight } from './noise.js';
import { DEFAULTS as SAVED_DEFAULTS } from './defaults.js';

const canvas = document.getElementById('c');
const statsEl = document.getElementById('stats');
const LS_KEY = 'procedural-grass-settings-v4-silhouette';

// Project defaults (from src/defaults.js — update via "Save as project defaults" / F2)
let DEFAULTS = { ...SAVED_DEFAULTS };

// ---- renderer / scene ----
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = DEFAULTS.exposure;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
// Soft Ghibli sky (reference)
const skyColor = DEFAULTS.fogColor || '#a8d4f5';
scene.background = new THREE.Color(skyColor);
scene.fog = new THREE.Fog(skyColor, DEFAULTS.fogNear ?? 18, DEFAULTS.fogFar ?? 62);

const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 200);
// Lower, longer view like the reference
camera.position.set(0, 2.4, 7.5);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI * 0.48;
controls.minDistance = 2.5;
controls.maxDistance = 28;
controls.target.set(0, 1.1, 0);

// ---- lights (sun directional + sky fill) ----
const hemi = new THREE.HemisphereLight(0xc8e8ff, 0x6aaf55, 0.85);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff8e0, DEFAULTS.sunIntensity ?? 1.05);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 120;
sun.shadow.camera.left = -36;
sun.shadow.camera.right = 36;
sun.shadow.camera.top = 36;
sun.shadow.camera.bottom = -36;
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.04;
scene.add(sun);
scene.add(sun.target);
sun.target.position.set(0, 0, 0);

// soft opposite fill so shadowed side isn’t pure black
const fill = new THREE.DirectionalLight(0xa8c8ff, 0.22);
scene.add(fill);

// Visible sun disc in the sky (follows directional light)
const sunGroup = new THREE.Group();
const sunCore = new THREE.Mesh(
  new THREE.SphereGeometry(2.2, 24, 24),
  new THREE.MeshBasicMaterial({ color: 0xffe08a, fog: false, depthWrite: false })
);
const sunGlow = new THREE.Mesh(
  new THREE.SphereGeometry(4.5, 24, 24),
  new THREE.MeshBasicMaterial({
    color: 0xffc857,
    transparent: true,
    opacity: 0.28,
    fog: false,
    depthWrite: false,
  })
);
const sunHalo = new THREE.Mesh(
  new THREE.SphereGeometry(7.5, 24, 24),
  new THREE.MeshBasicMaterial({
    color: 0xfff3c0,
    transparent: true,
    opacity: 0.12,
    fog: false,
    depthWrite: false,
  })
);
sunGroup.add(sunCore, sunGlow, sunHalo);
sunGroup.renderOrder = 1;
scene.add(sunGroup);

/**
 * Place directional sun + disc from azimuth / elevation (degrees).
 * Azimuth 0° = +X (east), 90° = +Z (south). Elevation 0° = horizon, 90° = zenith.
 */
function setSunFromAngles(azimuthDeg, elevationDeg) {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = THREE.MathUtils.clamp(elevationDeg, 2, 89) * (Math.PI / 180);
  const dist = 55;
  const cosEl = Math.cos(el);
  const x = dist * cosEl * Math.cos(az);
  const y = dist * Math.sin(el);
  const z = dist * cosEl * Math.sin(az);

  sun.position.set(x, y, z);
  sun.target.position.set(0, 0, 0);
  sun.target.updateMatrixWorld();
  sun.updateMatrixWorld();

  // fill from opposite side, lower
  fill.position.set(-x * 0.35, Math.max(6, y * 0.25), -z * 0.35);

  sunGroup.position.set(x, y, z);
  sunGroup.visible = elevationDeg > 3;

  // Warm sun near horizon, cooler at noon
  const warm = THREE.MathUtils.smoothstep(elevationDeg, 5, 35);
  const col = new THREE.Color().setHSL(0.1 - warm * 0.02, 0.55 - warm * 0.15, 0.72 + warm * 0.1);
  sun.color.copy(col);
  sunCore.material.color.copy(col).multiplyScalar(1.1);
  sunGlow.material.color.copy(col);

  // Drive custom grass shader sun (ShaderMaterial ignores Three.js lights)
  if (grass?.material?.uniforms) {
    const u = grass.material.uniforms;
    if (u.uSunDir) u.uSunDir.value.set(x, y, z).normalize();
    if (u.uSunColor) u.uSunColor.value.copy(col);
    if (u.uSunIntensity) u.uSunIntensity.value = sun.intensity;
  }
}

// ---- grass ----
const cores = navigator.hardwareConcurrency || 4;
// Slightly lower budget — far LOD clumps cover distance
// Each instance is a full bunch — fewer instances than single blades
const bladeBudget = cores <= 4 ? 32000 : cores <= 8 ? 45000 : 58000;

const grass = new GrassField({
  size: 48,
  bladeCount: bladeBudget,
  // width/height = silhouette card size (one clump icon per instance)
  bladeWidth: DEFAULTS.bladeWidth ?? 0.95,
  bladeHeight: DEFAULTS.bladeHeight ?? 0.72,
  lodNear: DEFAULTS.lodNear ?? 12,
  lodFar: DEFAULTS.lodFar ?? 24,
  terrainAmp: DEFAULTS.terrainAmp ?? 1.35,
  terrainFreq: DEFAULTS.terrainFreq ?? 1.0,
});
scene.add(grass.object);
scene.add(grass.ground);

setSunFromAngles(DEFAULTS.sunAzimuth ?? 40, DEFAULTS.sunElevation ?? 48);
grass.setWindDir(DEFAULTS.windAngle);

// ---- player ----
const player = new THREE.Group();
const body = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.28, 0.7, 6, 12),
  new THREE.MeshStandardMaterial({ color: 0xf0d0a0, roughness: 0.55, metalness: 0.05 })
);
body.castShadow = true;
body.position.y = 0.7;
player.add(body);

const hat = new THREE.Mesh(
  new THREE.SphereGeometry(0.2, 16, 12),
  new THREE.MeshStandardMaterial({ color: 0xe07050, roughness: 0.4 })
);
hat.position.y = 1.25;
hat.castShadow = true;
player.add(hat);

player.position.set(0, 0, 4);
scene.add(player);

// Soft green trail shadow under player (reference: dark mint underfoot, not pure black)
const contactShadow = new THREE.Mesh(
  new THREE.CircleGeometry(1, 48),
  new THREE.MeshBasicMaterial({
    color: 0x3d6b38,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    fog: true,
  })
);
contactShadow.rotation.x = -Math.PI / 2;
contactShadow.renderOrder = 2;
scene.add(contactShadow);

// ---- wind arrow helper in scene (XZ) ----
const windArrowGroup = new THREE.Group();
const arrowMat = new THREE.MeshBasicMaterial({ color: 0xa8e878, transparent: true, opacity: 0.85 });
const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.6, 8), arrowMat);
shaft.rotation.z = Math.PI / 2;
shaft.position.x = 0.8;
const head = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.35, 10), arrowMat);
head.rotation.z = -Math.PI / 2;
head.position.x = 1.75;
const base = new THREE.Mesh(
  new THREE.RingGeometry(0.55, 0.65, 32),
  new THREE.MeshBasicMaterial({ color: 0x7ecf6a, side: THREE.DoubleSide, transparent: true, opacity: 0.5 })
);
base.rotation.x = -Math.PI / 2;
windArrowGroup.add(shaft, head, base);
windArrowGroup.position.set(0, 0.15, 0);
scene.add(windArrowGroup);

function placeWindArrow() {
  const y = terrainHeight(0, 0) + 0.08;
  windArrowGroup.position.set(0, y, 0);
}
placeWindArrow();

// ---- input ----
const keys = new Set();
window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  // don't steal space from page when typing in panel — no text inputs currently
});
window.addEventListener('keyup', (e) => keys.delete(e.code));

const playerVel = new THREE.Vector3();
const tmp = new THREE.Vector3();
let moveSpeed = DEFAULTS.moveSpeed;
let cameraFollow = DEFAULTS.cameraFollow;

function updatePlayer(dt) {
  const forward = tmp.set(0, 0, 0);
  camera.getWorldDirection(forward);
  forward.y = 0;
  if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
  forward.normalize();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

  const wish = new THREE.Vector3();
  if (keys.has('KeyW') || keys.has('ArrowUp')) wish.add(forward);
  if (keys.has('KeyS') || keys.has('ArrowDown')) wish.sub(forward);
  if (keys.has('KeyA') || keys.has('ArrowLeft')) wish.sub(right);
  if (keys.has('KeyD') || keys.has('ArrowRight')) wish.add(right);

  if (wish.lengthSq() > 0) {
    wish.normalize().multiplyScalar(moveSpeed);
    playerVel.lerp(wish, 1 - Math.exp(-12 * dt));
  } else {
    playerVel.multiplyScalar(Math.exp(-10 * dt));
  }

  player.position.x += playerVel.x * dt;
  player.position.z += playerVel.z * dt;

  const lim = grass.size * 0.48;
  player.position.x = THREE.MathUtils.clamp(player.position.x, -lim, lim);
  player.position.z = THREE.MathUtils.clamp(player.position.z, -lim, lim);
  player.position.y = terrainHeight(player.position.x, player.position.z);

  if (playerVel.lengthSq() > 0.01) {
    const face = Math.atan2(playerVel.x, playerVel.z);
    body.rotation.y = THREE.MathUtils.lerp(body.rotation.y, face, 1 - Math.exp(-10 * dt));
    hat.rotation.y = body.rotation.y;
  }

  if (cameraFollow) {
    controls.target.lerp(
      new THREE.Vector3(player.position.x, player.position.y + 1.15, player.position.z),
      1 - Math.exp(-4 * dt)
    );
  }

  grass.setPlayer(tmp.set(player.position.x, player.position.y + 0.35, player.position.z));

  // Contact shadow follows player footprint
  const pr = grass.material.uniforms.uPlayerRadius?.value ?? 1.2;
  const interactOn = grass.material.uniforms.uInteractEnabled?.value > 0.5;
  contactShadow.visible = interactOn && player.visible;
  contactShadow.position.set(player.position.x, player.position.y + 0.035, player.position.z);
  // Slightly elongated footprint in move direction
  const speed = playerVel.length();
  const s = pr * (1.1 + Math.min(speed, 4) * 0.04);
  contactShadow.scale.set(s * 1.15, s * 0.95, 1);
  const pushSh = grass.material.uniforms.uPushShadow?.value ?? 0.85;
  contactShadow.material.opacity = 0.28 + pushSh * 0.32;
}

// ---- UI helpers ----
const $ = (id) => document.getElementById(id);

function bindRange(id, onChange, { format = (v) => Number(v).toFixed(2), suffix = '' } = {}) {
  const el = $(id);
  const label = $(id + 'Val');
  const apply = () => {
    const v = parseFloat(el.value);
    if (label) label.textContent = `${format(v)}${suffix}`;
    onChange(v, el);
  };
  el.addEventListener('input', apply);
  return { el, apply, get: () => parseFloat(el.value), set: (v) => { el.value = v; apply(); } };
}

function bindCheck(id, onChange) {
  const el = $(id);
  const apply = () => onChange(el.checked, el);
  el.addEventListener('change', apply);
  return { el, apply, get: () => el.checked, set: (v) => { el.checked = v; apply(); } };
}

function bindColor(id, onChange) {
  const el = $(id);
  const apply = () => onChange(el.value, el);
  el.addEventListener('input', apply);
  return { el, apply, get: () => el.value, set: (v) => { el.value = v; apply(); } };
}

// panel collapse
const panel = $('panel');
$('panelToggle').addEventListener('click', () => {
  panel.classList.toggle('collapsed');
  $('panelToggle').textContent = panel.classList.contains('collapsed') ? '▸' : '▾';
});

// ---- wind compass ----
const compass = $('windCompass');
const compassCtx = compass.getContext('2d');
let windAngle = DEFAULTS.windAngle;

function drawWindCompass(angleDeg, strength = 1) {
  const ctx = compassCtx;
  const w = compass.width;
  const h = compass.height;
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) * 0.38;

  ctx.clearRect(0, 0, w, h);

  // face
  ctx.beginPath();
  ctx.arc(cx, cy, r + 10, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(20, 40, 24, 0.9)';
  ctx.fill();

  // ticks
  ctx.strokeStyle = 'rgba(180, 220, 160, 0.35)';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (r - 4), cy + Math.sin(a) * (r - 4));
    ctx.lineTo(cx + Math.cos(a) * (r + 6), cy + Math.sin(a) * (r + 6));
    ctx.stroke();
  }

  // cardinal labels (screen: 0°=+X right, 90°=+Z down in our mapping for compass visual)
  ctx.fillStyle = 'rgba(200, 240, 180, 0.85)';
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('E', cx + r + 14, cy);
  ctx.fillText('W', cx - r - 14, cy);
  ctx.fillText('S', cx, cy + r + 14);
  ctx.fillText('N', cx, cy - r - 14);

  // wind arrow (angle 0 → +X, increases toward +Z)
  const rad = (angleDeg * Math.PI) / 180;
  const len = r * (0.45 + 0.45 * Math.min(strength, 1.5) / 1.5);
  const x2 = cx + Math.cos(rad) * len;
  const y2 = cy + Math.sin(rad) * len;

  ctx.strokeStyle = '#8fd96a';
  ctx.fillStyle = '#8fd96a';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  // arrow head
  const ah = 10;
  const ang = Math.atan2(y2 - cy, x2 - cx);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - ah * Math.cos(ang - 0.4), y2 - ah * Math.sin(ang - 0.4));
  ctx.lineTo(x2 - ah * Math.cos(ang + 0.4), y2 - ah * Math.sin(ang + 0.4));
  ctx.closePath();
  ctx.fill();

  // center hub
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#dff5d0';
  ctx.fill();
}

function setWindAngle(deg, { fromUI = false } = {}) {
  windAngle = ((deg % 360) + 360) % 360;
  grass.setWindDir(windAngle);
  windArrowGroup.rotation.y = -windAngle * (Math.PI / 180); // visual align on XZ
  $('windAngleLabel').textContent = `${Math.round(windAngle)}°`;
  if (!fromUI) {
    $('windAngle').value = String(Math.round(windAngle));
    $('windAngleVal').textContent = `${Math.round(windAngle)}°`;
  }
  drawWindCompass(windAngle, grass.material.uniforms.uWindStrength.value);
}

// drag on compass
function angleFromEvent(ev) {
  const rect = compass.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / rect.width) * compass.width - compass.width / 2;
  const y = ((ev.clientY - rect.top) / rect.height) * compass.height - compass.height / 2;
  let deg = (Math.atan2(y, x) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}

let draggingCompass = false;
compass.addEventListener('pointerdown', (e) => {
  draggingCompass = true;
  compass.setPointerCapture(e.pointerId);
  $('windAutoRotate').checked = false;
  setWindAngle(angleFromEvent(e));
});
compass.addEventListener('pointermove', (e) => {
  if (!draggingCompass) return;
  setWindAngle(angleFromEvent(e));
});
compass.addEventListener('pointerup', () => { draggingCompass = false; });
compass.addEventListener('pointercancel', () => { draggingCompass = false; });

// ---- bind controls ----
let rebuildTimer = null;
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => doRebuild(), 150);
}

function doRebuild() {
  grass.setTerrain({
    amplitude: parseFloat($('terrainAmp')?.value ?? '1.35'),
    frequency: parseFloat($('terrainFreq')?.value ?? '1'),
  });
  grass.setBladeShape({
    width: parseFloat($('bladeWidth').value),
    height: parseFloat($('bladeHeight').value),
  });
  const n = grass.rebuild({
    densityScale: parseFloat($('density').value),
    scaleMin: parseFloat($('scaleMin').value),
    scaleMax: parseFloat($('scaleMax').value),
    usePath: $('usePath').checked,
    slopeMask: $('slopeMask').checked,
  });
  const near = typeof n === 'object' ? n.near : n;
  const far = typeof n === 'object' ? n.far : 0;
  statsEl.textContent = `${near.toLocaleString()} near + ${far.toLocaleString()} chunks · rebuilt`;
  placeWindArrow();
}

bindRange('windAngle', (v) => {
  setWindAngle(v, { fromUI: true });
  $('windAngleVal').textContent = `${Math.round(v)}°`;
}, { format: (v) => String(Math.round(v)), suffix: '°' });

bindRange('windStrength', (v) => {
  grass.material.uniforms.uWindStrength.value = v;
  drawWindCompass(windAngle, v);
});
bindRange('windGlobal', (v) => { grass.material.uniforms.uWindGlobal.value = v; });
bindRange('windGust', (v) => { grass.material.uniforms.uWindGust.value = v; });
bindRange('windTurb', (v) => { grass.material.uniforms.uWindTurb.value = v; });
bindRange('windSpeed', (v) => { grass.material.uniforms.uWindSpeed.value = v; });
bindRange('waveScale', (v) => { grass.material.uniforms.uWaveScale.value = v; });
bindRange('waveTravel', (v) => { grass.material.uniforms.uWaveTravel.value = v; });
bindRange('waveWidth', (v) => { grass.material.uniforms.uWaveWidth.value = v; });
bindRange('windSync', (v) => { grass.material.uniforms.uSync.value = v; });
bindRange('windAutoSpeed', () => {});

bindCheck('windEnabled', (on) => {
  grass.material.uniforms.uWindEnabled.value = on ? 1 : 0;
  windArrowGroup.visible = on;
});
bindCheck('windAutoRotate', () => {});

['bladeWidth', 'bladeHeight', 'density', 'scaleMin', 'scaleMax'].forEach((id) => {
  bindRange(id, () => scheduleRebuild(), {
    format: (v) => Number(v).toFixed(2),
    suffix: '',
  });
});
bindRange('terrainAmp', () => scheduleRebuild(), { format: (v) => Number(v).toFixed(2) });
bindRange('terrainFreq', () => scheduleRebuild(), { format: (v) => Number(v).toFixed(2) });
$('rebuildTerrainBtn')?.addEventListener('click', () => doRebuild());
bindCheck('usePath', () => scheduleRebuild());
bindCheck('slopeMask', () => scheduleRebuild());
bindCheck('lodEnabled', (on) => {
  grass.setLodEnabled(on);
  if ($('grassVisible').checked) grass.farMesh.visible = on;
});
bindRange('lodNear', (v) => {
  grass.setLodDistances(v, parseFloat($('lodFar').value));
}, { format: (v) => String(Math.round(v)) });
bindRange('lodFar', (v) => {
  grass.setLodDistances(parseFloat($('lodNear').value), v);
}, { format: (v) => String(Math.round(v)) });
bindCheck('grassVisible', (on) => {
  grass.nearMesh.visible = on;
  grass.farMesh.visible = on && grass.lodEnabled;
});

$('rebuildBtn').addEventListener('click', () => doRebuild());

bindCheck('interactEnabled', (on) => {
  grass.material.uniforms.uInteractEnabled.value = on ? 1 : 0;
  contactShadow.visible = on && player.visible;
});
bindRange('playerRadius', (v) => { grass.material.uniforms.uPlayerRadius.value = v; });
bindRange('pushStrength', (v) => { grass.material.uniforms.uPushStrength.value = v; });
bindRange('flattenStrength', (v) => { grass.material.uniforms.uFlattenStrength.value = v; });
bindRange('pushShadow', (v) => {
  if (grass.material.uniforms.uPushShadow) grass.material.uniforms.uPushShadow.value = v;
});
bindRange('moveSpeed', (v) => { moveSpeed = v; }, { format: (v) => Number(v).toFixed(1) });
bindCheck('playerVisible', (on) => {
  player.visible = on;
  contactShadow.visible = on && grass.material.uniforms.uInteractEnabled.value > 0.5;
});
bindCheck('cameraFollow', (on) => { cameraFollow = on; });

bindColor('grassColor', (v) => grass.material.uniforms.uGrassColor.value.set(v));
bindColor('noiseColor', (v) => grass.material.uniforms.uNoiseColor.value.set(v));
bindRange('noiseScale', (v) => { grass.material.uniforms.uNoiseScale.value = v; });
bindRange('noiseStrength', (v) => { grass.material.uniforms.uNoiseStrength.value = v; });
bindRange('noiseContrast', (v) => { grass.material.uniforms.uNoiseContrast.value = v; });
bindRange('patchSoftness', (v) => { grass.material.uniforms.uPatchSoftness.value = v; });
bindRange('rootAO', (v) => { grass.material.uniforms.uRootAO.value = v; });
bindColor('groundColor', (v) => {
  if (grass.ground) grass.ground.material.color.set(v);
});
bindColor('fogColor', (v) => {
  scene.background.set(v);
  if (scene.fog) scene.fog.color.set(v);
  grass.material.uniforms.uFogColor.value.set(v);
});
bindRange('ambient', (v) => { grass.material.uniforms.uAmbient.value = v; });
bindRange('sss', (v) => { grass.material.uniforms.uSSS.value = v; });
bindRange('specular', (v) => { grass.material.uniforms.uSpecular.value = v; });

bindCheck('fogEnabled', (on) => {
  grass.material.uniforms.uFogEnabled.value = on ? 1 : 0;
  scene.fog = on
    ? new THREE.Fog(
        grass.material.uniforms.uFogColor.value,
        parseFloat($('fogNear').value),
        parseFloat($('fogFar').value)
      )
    : null;
});
bindRange('fogNear', (v) => {
  grass.material.uniforms.uFogNear.value = v;
  if (scene.fog) scene.fog.near = v;
}, { format: (v) => String(Math.round(v)) });
bindRange('fogFar', (v) => {
  grass.material.uniforms.uFogFar.value = v;
  if (scene.fog) scene.fog.far = v;
}, { format: (v) => String(Math.round(v)) });
bindCheck('shadowsEnabled', (on) => {
  renderer.shadowMap.enabled = on;
  sun.castShadow = on;
});
bindCheck('groundVisible', (on) => {
  if (grass.ground) grass.ground.visible = on;
});
bindCheck('sunDiscVisible', (on) => {
  sunGroup.visible = on && parseFloat($('sunElevation').value) > 3;
});
function refreshSun() {
  setSunFromAngles(parseFloat($('sunAzimuth').value), parseFloat($('sunElevation').value));
  sunGroup.visible = $('sunDiscVisible').checked && parseFloat($('sunElevation').value) > 3;
}
bindRange('sunAzimuth', () => refreshSun(), {
  format: (v) => String(Math.round(v)),
  suffix: '°',
});
bindRange('sunElevation', () => refreshSun(), {
  format: (v) => String(Math.round(v)),
  suffix: '°',
});
bindRange('sunIntensity', (v) => {
  sun.intensity = v;
  if (grass.material.uniforms.uSunIntensity) {
    grass.material.uniforms.uSunIntensity.value = v;
  }
});
bindRange('hemiIntensity', (v) => {
  hemi.intensity = v;
  // Map sky fill somewhat into grass ambient so panel still feels connected
  if (grass.material.uniforms.uAmbient) {
    grass.material.uniforms.uAmbient.value = 0.22 + v * 0.35;
  }
});
bindRange('exposure', (v) => { renderer.toneMappingExposure = v; });

function collectSettings() {
  const out = {};
  panel.querySelectorAll('input').forEach((el) => {
    if (!el.id) return;
    if (el.type === 'checkbox') out[el.id] = el.checked;
    else if (el.type === 'color') out[el.id] = el.value;
    else if (el.type === 'range') out[el.id] = parseFloat(el.value);
    else out[el.id] = el.value;
  });
  return out;
}

function applySettingsObject(d, { rebuild = true } = {}) {
  if (!d || typeof d !== 'object') return;

  // Merge over project defaults so partial saves still work
  const merged = { ...DEFAULTS, ...d };

  const set = (id, val) => {
    const el = $(id);
    if (!el || val === undefined || val === null) return;
    if (el.type === 'checkbox') el.checked = !!val;
    else el.value = String(val);
  };

  Object.keys(merged).forEach((k) => set(k, merged[k]));

  // Apply without double-firing rebuild storms: pause autosave briefly
  suppressingPersist = true;
  panel.querySelectorAll('input[type="range"]').forEach((el) => {
    el.dispatchEvent(new Event('input'));
  });
  panel.querySelectorAll('input[type="checkbox"]').forEach((el) => {
    el.dispatchEvent(new Event('change'));
  });
  panel.querySelectorAll('input[type="color"]').forEach((el) => {
    el.dispatchEvent(new Event('input'));
  });
  if (merged.windAngle != null) setWindAngle(Number(merged.windAngle));
  suppressingPersist = false;

  if (rebuild) doRebuild();
  // Snapshot after apply so next reload keeps this look
  persistLocal(true);
}

function applyDefaults() {
  applySettingsObject(DEFAULTS, { rebuild: true });
  setSaveStatus('Restored project defaults', 'ok');
}

let suppressingPersist = false;
let persistTimer = null;

function persistLocal(immediate = false) {
  if (suppressingPersist) return;
  const write = () => {
    try {
      const s = collectSettings();
      localStorage.setItem(LS_KEY, JSON.stringify(s));
      // dual-write sessionStorage so a hard refresh in the same tab still has a copy
      sessionStorage.setItem(LS_KEY, JSON.stringify(s));
    } catch {
      /* ignore */
    }
  };
  if (immediate) {
    write();
    return;
  }
  clearTimeout(persistTimer);
  persistTimer = setTimeout(write, 80);
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY) || sessionStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    // sanity: need at least a couple known keys
    if (parsed.grassColor == null && parsed.windStrength == null && parsed.bladeWidth == null) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function setSaveStatus(msg, kind = 'muted') {
  const status = $('saveStatus');
  if (!status) return;
  status.textContent = msg;
  status.style.color =
    kind === 'ok' ? '#9fd48a' : kind === 'warn' ? '#f0c070' : 'rgba(200, 232, 184, 0.65)';
}

async function saveAsProjectDefaults() {
  const settings = collectSettings();
  try {
    const res = await fetch('/__save-defaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'save failed');
    DEFAULTS = { ...data.settings };
    persistLocal(true);
    setSaveStatus(`Saved ${data.count} settings as project defaults ✓  (F2 anytime)`, 'ok');
  } catch (err) {
    persistLocal(true);
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'defaults.json';
    a.click();
    URL.revokeObjectURL(a.href);
    setSaveStatus(`Downloaded defaults.json — server save failed (${err.message})`, 'warn');
  }
}

$('saveDefaultsBtn').addEventListener('click', () => saveAsProjectDefaults());
$('resetBtn').addEventListener('click', () => applyDefaults());

window.addEventListener('keydown', (e) => {
  if (e.key === 'F2') {
    e.preventDefault();
    saveAsProjectDefaults();
  }
});

// Persist on every tweak + when leaving the page
panel.querySelectorAll('input').forEach((el) => {
  el.addEventListener('input', () => persistLocal());
  el.addEventListener('change', () => persistLocal());
});
window.addEventListener('beforeunload', () => persistLocal(true));
window.addEventListener('pagehide', () => persistLocal(true));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persistLocal(true);
});
// Safety net: snapshot every 2s while the tab is open
setInterval(() => persistLocal(true), 2000);

// initial labels / compass from project defaults (may be overwritten by session restore)
setWindAngle(DEFAULTS.windAngle ?? 45);
panel.querySelectorAll('input[type="range"]').forEach((el) => {
  const id = el.id;
  const label = $(id + 'Val');
  if (!label) return;
  if (
    id === 'windAngle' ||
    id === 'fogNear' ||
    id === 'fogFar' ||
    id === 'bladeSegments' ||
    id === 'bunchBlades' ||
    id === 'sunAzimuth' ||
    id === 'sunElevation' ||
    id === 'lodNear' ||
    id === 'lodFar'
  ) {
    label.textContent =
      id === 'windAngle' || id === 'sunAzimuth' || id === 'sunElevation'
        ? `${Math.round(el.value)}°`
        : String(Math.round(el.value));
  } else if (id === 'moveSpeed') {
    label.textContent = Number(el.value).toFixed(1);
  } else {
    label.textContent = Number(el.value).toFixed(2);
  }
});

// Restore last session if we have one — otherwise keep code/HTML defaults and start autosaving
const local = loadLocal();
if (local) {
  applySettingsObject(local, { rebuild: true });
  setSaveStatus('Restored your last session from browser storage ✓  ·  F2 = save as project defaults', 'ok');
} else {
  // Do NOT rebuild/reset further — stay on current HTML/control values and begin tracking
  persistLocal(true);
  setSaveStatus(
    'No saved session yet. Tweak freely — auto-saves every change. Press F2 when you like the look.',
    'warn'
  );
}

// ---- resize ----
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---- loop ----
const clock = new THREE.Clock();
let frames = 0;
let fpsAccum = 0;
let fps = 0;

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  updatePlayer(dt);
  grass.setTime(t);
  controls.update();

  if ($('windAutoRotate').checked && $('windEnabled').checked) {
    const spd = parseFloat($('windAutoSpeed').value);
    setWindAngle(windAngle + spd * 60 * dt); // deg/sec scaled
  }

  // bob wind arrow slightly
  windArrowGroup.position.y = terrainHeight(0, 0) + 0.08 + Math.sin(t * 2.2) * 0.02;

  renderer.render(scene, camera);

  frames++;
  fpsAccum += dt;
  if (fpsAccum >= 0.5) {
    fps = Math.round(frames / fpsAccum);
    frames = 0;
    fpsAccum = 0;
    const dir = Math.round(windAngle);
    statsEl.textContent =
      `${grass.nearMesh.count.toLocaleString()} near · ${grass.farMesh.count.toLocaleString()} chunks · ${fps} fps\n` +
      `wind ${grass.material.uniforms.uWindStrength.value.toFixed(2)} @ ${dir}°` +
      (grass.material.uniforms.uWindEnabled.value < 0.5 ? ' (off)' : '');
  }

  requestAnimationFrame(frame);
}

statsEl.textContent = `${grass.nearMesh.count.toLocaleString()} near · ${grass.farMesh.count.toLocaleString()} chunks · ready`;
requestAnimationFrame(frame);
