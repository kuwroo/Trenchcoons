import * as THREE from 'three';
import { createSilhouetteCrossGeometry } from './bladeGeometry.js';
import { createGrassMaterial } from './grassMaterial.js';
import { createColorNoiseTexture } from './noiseTexture.js';
import { createGrassSilhouetteTexture, loadGrassSilhouetteFromUrl } from './grassSilhouette.js';
import { fbm2, terrainHeight, terrainNormal, setTerrainParams } from './noise.js';

/**
 * Each instance = ONE grass clump silhouette card (Vecteezy-style tuft).
 * Near + far LOD share the same shape; far is scaled up / sparser.
 */
export class GrassField {
  constructor({
    size = 42,
    bladeCount = 35000,
    segments = 1, // unused (silhouette card)
    bladeWidth = 0.85,
    bladeHeight = 0.7,
    curvature = 0.14,
    bunchBlades = 1,
    lodNear = 14,
    lodFar = 28,
    terrainAmp = 1.35,
    terrainFreq = 1.0,
  } = {}) {
    this.size = size;
    this.targetCount = bladeCount;
    this.segments = segments;
    this.bladeWidth = bladeWidth;
    this.bladeHeight = bladeHeight;
    this.curvature = curvature;
    this.bunchBlades = bunchBlades;
    this.densityScale = 1;
    this.scaleMin = 0.85;
    this.scaleMax = 1.2;
    this.usePath = true;
    this.slopeMask = true;
    this.lodNear = lodNear;
    this.lodFar = lodFar;
    this.lodEnabled = true;
    this.terrainAmp = terrainAmp;
    this.terrainFreq = terrainFreq;
    setTerrainParams({ amplitude: terrainAmp, frequency: terrainFreq });
    this._up = new THREE.Vector3(0, 1, 0);
    this._normal = new THREE.Vector3();
    this._qAlign = new THREE.Quaternion();

    this.group = new THREE.Group();
    this.group.name = 'GrassField';

    this._noiseMap = createColorNoiseTexture(256);
    this._alphaMap = createGrassSilhouetteTexture(512);

    this.nearMat = createGrassMaterial({
      noiseMap: this._noiseMap,
      alphaMap: this._alphaMap,
      lodNear,
      lodFar,
      lodFadeIn: false,
    });
    this.farMat = createGrassMaterial({
      noiseMap: this._noiseMap,
      alphaMap: this._alphaMap,
      lodNear,
      lodFar,
      lodFadeIn: true,
    });
    this._linkSharedUniforms(this.nearMat, this.farMat);
    this.material = this.nearMat;

    // Try load reference PNG/JPG silhouette (white → alpha)
    this._tryLoadRefSilhouette();

    // Crossed cards so edge-on views still show the clump silhouette
    this.nearGeo = createSilhouetteCrossGeometry(bladeWidth, bladeHeight);
    this.farGeo = createSilhouetteCrossGeometry(bladeWidth * 1.25, bladeHeight * 1.1);

    const farBudget = Math.max(2000, Math.floor(bladeCount * 0.16));
    this.nearMesh = new THREE.InstancedMesh(this.nearGeo, this.nearMat, bladeCount);
    this.farMesh = new THREE.InstancedMesh(this.farGeo, this.farMat, farBudget);
    for (const m of [this.nearMesh, this.farMesh]) {
      m.castShadow = false;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    }
    this.mesh = this.nearMesh;
    this.farBudget = farBudget;

    this._dummy = new THREE.Object3D();
    this._phases = new Float32Array(bladeCount);
    this._colorVars = new Float32Array(bladeCount);
    this._stiffness = new Float32Array(bladeCount);
    this._farPhases = new Float32Array(farBudget);
    this._farColors = new Float32Array(farBudget);
    this._farStiff = new Float32Array(farBudget);

    this.group.add(this.nearMesh, this.farMesh);
    this.rebuild();
  }

  async _tryLoadRefSilhouette() {
    try {
      // Prefer offline-cleaned PNG (better bg removal), fall back to JPG + runtime clean
      const tex = await loadGrassSilhouetteFromUrl('/grass-clump.png');
      this._alphaMap = tex;
      this.nearMat.uniforms.uAlphaMap.value = tex;
      this.farMat.uniforms.uAlphaMap.value = tex;
      // linked uniform should share — also set far explicitly
      if (this.farMat.uniforms.uAlphaMap) this.farMat.uniforms.uAlphaMap.value = tex;
    } catch {
      try {
        const tex = await loadGrassSilhouetteFromUrl('/grass-clump-ref.jpg');
        this._alphaMap = tex;
        this.nearMat.uniforms.uAlphaMap.value = tex;
        this.farMat.uniforms.uAlphaMap.value = tex;
      } catch {
        // keep procedural silhouette
      }
    }
  }

  _linkSharedUniforms(a, b) {
    const skip = new Set(['uLodNear', 'uLodFar', 'uLodFadeIn', 'uLodEnabled']);
    for (const key of Object.keys(a.uniforms)) {
      if (skip.has(key)) continue;
      if (b.uniforms[key]) b.uniforms[key] = a.uniforms[key];
    }
  }

  setLodDistances(near, far) {
    this.lodNear = near;
    this.lodFar = Math.max(far, near + 1);
    this.nearMat.uniforms.uLodNear.value = this.lodNear;
    this.nearMat.uniforms.uLodFar.value = this.lodFar;
    this.farMat.uniforms.uLodNear.value = this.lodNear;
    this.farMat.uniforms.uLodFar.value = this.lodFar;
  }

  setLodEnabled(on) {
    this.lodEnabled = on;
    const v = on ? 1 : 0;
    this.nearMat.uniforms.uLodEnabled.value = v;
    this.farMat.uniforms.uLodEnabled.value = v;
    this.farMesh.visible = on;
  }

  setTime(t) {
    this.material.uniforms.uTime.value = t;
  }

  setPlayer(pos) {
    this.material.uniforms.uPlayerPos.value.copy(pos);
  }

  setWindDir(angleDeg) {
    const r = (angleDeg * Math.PI) / 180;
    this.material.uniforms.uWindDir.value.set(Math.cos(r), Math.sin(r));
  }

  setBladeShape({ width, height } = {}) {
    if (width != null) this.bladeWidth = width;
    if (height != null) this.bladeHeight = height;

    const nearNext = createSilhouetteCrossGeometry(this.bladeWidth, this.bladeHeight);
    const farNext = createSilhouetteCrossGeometry(this.bladeWidth * 1.25, this.bladeHeight * 1.1);

    const copyAttrs = (fromGeo, toGeo) => {
      for (const name of ['aPhase', 'aColorVar', 'aStiffness']) {
        const a = fromGeo.getAttribute(name);
        if (a) toGeo.setAttribute(name, a);
      }
    };
    copyAttrs(this.nearGeo, nearNext);
    copyAttrs(this.farGeo, farNext);

    this.nearGeo.dispose();
    this.farGeo.dispose();
    this.nearGeo = nearNext;
    this.farGeo = farNext;
    this.nearMesh.geometry = nearNext;
    this.farMesh.geometry = farNext;
  }

  setTerrain({ amplitude, frequency } = {}) {
    if (amplitude != null) this.terrainAmp = amplitude;
    if (frequency != null) this.terrainFreq = frequency;
    setTerrainParams({ amplitude: this.terrainAmp, frequency: this.terrainFreq });
  }

  _placeInstance(dummy, x, y, z, n, random, scaleMin, scaleMax, scaleBoost = 1) {
    // Align clump +Y to terrain normal so grass sits on slopes
    this._normal.set(n.x, n.y, n.z).normalize();
    this._qAlign.setFromUnitVectors(this._up, this._normal);
    dummy.position.set(x, y, z);
    dummy.quaternion.copy(this._qAlign);
    // Yaw around the slope normal (local Y after align)
    dummy.rotateY(random() * Math.PI * 2);
    const t = random();
    const scaleY = (scaleMin + t * (scaleMax - scaleMin) * 0.5 + (scaleMax - scaleMin) * 0.25) * scaleBoost;
    const scaleX = (0.92 + random() * 0.2) * scaleBoost;
    dummy.scale.set(scaleX, scaleY, 1);
    dummy.updateMatrix();
  }

  /** Rebuild or update ground mesh vertices to match terrainHeight. */
  _updateGroundMesh(size) {
    const segs = 160; // denser mesh for visible hills
    if (!this.ground) {
      const ggeo = new THREE.PlaneGeometry(size + 6, size + 6, segs, segs);
      ggeo.rotateX(-Math.PI / 2);
      const gmat = new THREE.MeshStandardMaterial({
        color: new THREE.Color('#6fc468'),
        roughness: 1.0,
        metalness: 0.0,
        flatShading: false,
      });
      this.ground = new THREE.Mesh(ggeo, gmat);
      this.ground.receiveShadow = true;
      this.ground.position.y = 0;
    }
    const pos = this.ground.geometry.attributes.position;
    for (let vi = 0; vi < pos.count; vi++) {
      const px = pos.getX(vi);
      const pz = pos.getZ(vi);
      pos.setY(vi, terrainHeight(px, pz));
    }
    pos.needsUpdate = true;
    this.ground.geometry.computeVertexNormals();
  }

  rebuild({
    densityScale = this.densityScale,
    scaleMin = this.scaleMin,
    scaleMax = this.scaleMax,
    usePath = this.usePath,
    slopeMask = this.slopeMask,
  } = {}) {
    this.densityScale = densityScale;
    this.scaleMin = scaleMin;
    this.scaleMax = Math.max(scaleMax, scaleMin + 0.05);
    this.usePath = usePath;
    this.slopeMask = slopeMask;
    setTerrainParams({ amplitude: this.terrainAmp, frequency: this.terrainFreq });

    const size = this.size;
    const half = size * 0.5;
    const area = size * size;
    // Silhouette clumps are wider — moderate density
    const baseDensity = (this.targetCount / area) * densityScale * 0.85;
    const gridStep = 1 / Math.sqrt(Math.max(baseDensity, 0.4));
    const chunkStep = gridStep * 2.5;

    const dummy = this._dummy;
    let rng = 1234567;
    const random = () => {
      rng = (rng * 1664525 + 1013904223) >>> 0;
      return rng / 0xffffffff;
    };

    const accept = (x, z, randomFn) => {
      const dn = fbm2(x * 0.045, z * 0.045, 4) * 2 - 1;
      if (dn < -0.28) return false;
      if (randomFn() > dn * 0.45 + 0.72) return false;
      if (usePath) {
        const path = Math.exp(-((x * 0.08) ** 2) * 0.35 - ((z - 2) * 0.15) ** 2);
        if (path > 0.55 && randomFn() > 0.15) return false;
      }
      const nrm = terrainNormal(x, z);
      // Allow moderate slopes so grass loads on hills (reject only steep cliffs)
      if (slopeMask && nrm.y < 0.55) return false;
      return true;
    };

    let i = 0;
    const max = this.targetCount;
    for (let gx = -half; gx < half && i < max; gx += gridStep) {
      for (let gz = -half; gz < half && i < max; gz += gridStep) {
        const x = gx + (random() - 0.5) * gridStep * 0.9;
        const z = gz + (random() - 0.5) * gridStep * 0.9;
        if (!accept(x, z, random)) continue;
        const y = terrainHeight(x, z);
        const nrm = terrainNormal(x, z);
        this._placeInstance(dummy, x, y, z, nrm, random, scaleMin, scaleMax, 1);
        this.nearMesh.setMatrixAt(i, dummy.matrix);
        this._phases[i] = random() * Math.PI * 2;
        this._colorVars[i] = random();
        this._stiffness[i] = random();
        i++;
      }
    }
    this.nearMesh.count = i;
    this.nearMesh.instanceMatrix.needsUpdate = true;
    this.nearGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(this._phases.slice(0, i), 1));
    this.nearGeo.setAttribute('aColorVar', new THREE.InstancedBufferAttribute(this._colorVars.slice(0, i), 1));
    this.nearGeo.setAttribute('aStiffness', new THREE.InstancedBufferAttribute(this._stiffness.slice(0, i), 1));

    let j = 0;
    const maxFar = this.farBudget;
    rng = 987654321;
    for (let gx = -half; gx < half && j < maxFar; gx += chunkStep) {
      for (let gz = -half; gz < half && j < maxFar; gz += chunkStep) {
        const x = gx + (random() - 0.5) * chunkStep * 0.7;
        const z = gz + (random() - 0.5) * chunkStep * 0.7;
        if (!accept(x, z, random)) continue;
        if (random() > 0.75) continue;
        const y = terrainHeight(x, z);
        const nrm = terrainNormal(x, z);
        this._placeInstance(dummy, x, y, z, nrm, random, scaleMin, scaleMax, 1.2);
        this.farMesh.setMatrixAt(j, dummy.matrix);
        this._farPhases[j] = random() * Math.PI * 2;
        this._farColors[j] = random();
        this._farStiff[j] = random();
        j++;
      }
    }
    this.farMesh.count = j;
    this.farMesh.instanceMatrix.needsUpdate = true;
    this.farGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(this._farPhases.slice(0, j), 1));
    this.farGeo.setAttribute('aColorVar', new THREE.InstancedBufferAttribute(this._farColors.slice(0, j), 1));
    this.farGeo.setAttribute('aStiffness', new THREE.InstancedBufferAttribute(this._farStiff.slice(0, j), 1));

    this._updateGroundMesh(size);

    this.setLodDistances(this.lodNear, this.lodFar);
    this.setLodEnabled(this.lodEnabled);

    return { near: i, far: j, total: i + j };
  }

  get object() {
    return this.group;
  }

  get count() {
    return (this.nearMesh?.count || 0) + (this.farMesh?.count || 0);
  }
}
