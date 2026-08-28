import * as THREE from 'three';
import { createColorNoiseTexture } from './noiseTexture.js';
import { createGrassSilhouetteTexture } from './grassSilhouette.js';

/**
 * One silhouette grass clump per instance (Vecteezy-style cutout) + flat tint.
 */
/**
 * @param {object} [opts]
 * @param {THREE.Texture} [opts.noiseMap]
 * @param {THREE.Texture} [opts.alphaMap] grass clump silhouette (alpha)
 * @param {number} [opts.lodNear]
 * @param {number} [opts.lodFar]
 * @param {boolean} [opts.lodFadeIn]
 */
export function createGrassMaterial(opts = {}) {
  const noiseMap = opts.noiseMap || createColorNoiseTexture(256);
  const alphaMap = opts.alphaMap || createGrassSilhouetteTexture(512);

  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uWindEnabled: { value: 1 },
      uWindStrength: { value: 1.15 },
      uWindDir: { value: new THREE.Vector2(1.0, 0.0).normalize() },
      uWindGlobal: { value: 0.55 },
      uWindGust: { value: 1.35 },
      uWindTurb: { value: 0.18 },
      uWindSpeed: { value: 0.85 },
      uWaveScale: { value: 0.38 },
      uWaveTravel: { value: 1.45 },
      uWaveWidth: { value: 2.2 },
      uSync: { value: 0.92 },
      uInteractEnabled: { value: 1 },
      uPlayerPos: { value: new THREE.Vector3(0, 0, 0) },
      uPlayerRadius: { value: 0.95 },
      uPushStrength: { value: 0.65 },
      uFlattenStrength: { value: 0.42 },
      uPushShadow: { value: 0.88 },

      uGrassColor: { value: new THREE.Color('#6fcf3a') },
      uNoiseColor: { value: new THREE.Color('#7dd948') },
      uNoiseMap: { value: noiseMap },
      uAlphaMap: { value: alphaMap },
      uNoiseScale: { value: 0.035 },
      uNoiseStrength: { value: 0.08 },
      uNoiseContrast: { value: 0.65 },
      uPatchSoftness: { value: 0.5 },
      uRootAO: { value: 0.02 },
      uStrokeStrength: { value: 0.0 },
      uAlphaCutoff: { value: 0.15 },

      uSunDir: { value: new THREE.Vector3(0.35, 0.9, 0.2).normalize() },
      uSunColor: { value: new THREE.Color('#fff8e0') },
      uSunIntensity: { value: 1.05 },
      uAmbient: { value: 0.72 },
      uSSS: { value: 0.4 },
      uSpecular: { value: 0.02 },
      uFogColor: { value: new THREE.Color('#a8d4f5') },
      uFogNear: { value: 18 },
      uFogFar: { value: 62 },
      uFogEnabled: { value: 1 },

      uLodNear: { value: opts.lodNear ?? 12 },
      uLodFar: { value: opts.lodFar ?? 24 },
      uLodFadeIn: { value: opts.lodFadeIn ? 1 : 0 },
      uLodEnabled: { value: 1 },
    },
    vertexShader: /* glsl */ `
      precision highp float;

      attribute float aPhase;
      attribute float aColorVar;
      attribute float aStiffness;

      uniform float uTime;
      uniform float uWindEnabled;
      uniform float uWindStrength;
      uniform vec2 uWindDir;
      uniform float uWindGlobal;
      uniform float uWindGust;
      uniform float uWindTurb;
      uniform float uWindSpeed;
      uniform float uWaveScale;
      uniform float uWaveTravel;
      uniform float uWaveWidth;
      uniform float uSync;
      uniform float uInteractEnabled;
      uniform vec3 uPlayerPos;
      uniform float uPlayerRadius;
      uniform float uPushStrength;
      uniform float uFlattenStrength;

      varying float vElevation;
      varying float vInteract;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      varying vec2 vWorldXZ;
      varying vec2 vUv;

      float hash12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }

      float gustPulse(float phase, float width) {
        float s = 0.5 + 0.5 * sin(phase);
        return pow(s, max(width, 1.0));
      }

      void main() {
        vUv = uv;
        vElevation = uv.y;

        vec4 worldPos4 = instanceMatrix * vec4(position, 1.0);
        vec3 worldPos = worldPos4.xyz;
        vec3 root = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vWorldXZ = root.xz;

        float h = uv.y;
        float hBend = h * h * (1.15 - 0.15 * h);
        float h2 = h * h;

        float stiff = mix(0.92, 1.08, aStiffness);
        float t = uTime * uWindSpeed;

        vec2 wdir = length(uWindDir) > 1e-5 ? normalize(uWindDir) : vec2(1.0, 0.0);
        vec2 across = vec2(-wdir.y, wdir.x);

        float along = dot(root.xz, wdir);
        float side = dot(root.xz, across);

        float localPhase = mix(aPhase, 0.0, clamp(uSync, 0.0, 1.0));
        float spatialJitter = (hash12(floor(root.xz * 0.35)) - 0.5) * mix(1.2, 0.12, uSync);

        vec2 windPush = vec2(0.0);

        if (uWindEnabled > 0.5 && uWindStrength > 0.0) {
          float scale = max(uWaveScale, 0.05);
          float travel = uWaveTravel;

          float breath =
              sin(t * 0.55 + localPhase * 0.15) * 0.5
            + sin(t * 0.23) * 0.5;
          breath *= uWindGlobal;

          float p1 = along * scale - t * travel * 1.0 + spatialJitter;
          float p2 = along * scale * 0.42 - t * travel * 0.48 + 0.7;
          float p3 = along * scale * 1.65 - t * travel * 1.55 + side * 0.08;

          float g1 = gustPulse(p1, uWaveWidth);
          float g2 = gustPulse(p2, uWaveWidth * 0.85);
          float g3 = gustPulse(p3, uWaveWidth * 1.15);

          float leanWave =
              sin(p1) * (0.35 + 0.65 * g1) * 0.72
            + sin(p2) * (0.40 + 0.60 * g2) * 0.38
            + sin(p3) * (0.50 + 0.50 * g3) * 0.16;

          float frontCurve = sin(side * scale * 0.55 + t * 0.2) * 0.12
                           + sin(side * scale * 0.18 - along * scale * 0.1) * 0.08;
          leanWave += frontCurve * (0.5 + 0.5 * g1);
          leanWave *= uWindGust;

          float fieldAmt = (breath * 0.45 + leanWave) * stiff;

          float micro =
              sin(t * 4.8 + aPhase * 3.5 + along * 0.8)
            * 0.07
            * uWindTurb
            * (0.35 + 0.65 * h);

          float windAmt = (fieldAmt + micro) * uWindStrength;

          windPush = wdir * windAmt * hBend * 0.58;
          windPush += across * (g1 - 0.35) * uWindGust * hBend * 0.08 * uWindStrength;
          windPush += across * micro * h2 * 0.35;

          worldPos.xz += windPush;
          worldPos.y -= length(windPush) * 0.16 * h;
        }

        vec2 pushDir = vec2(0.0);
        float influence = 0.0;
        if (uInteractEnabled > 0.5) {
          vec2 toBlade = root.xz - uPlayerPos.xz;
          float dist = length(toBlade);
          influence = 1.0 - smoothstep(0.0, uPlayerRadius, dist);
          influence = influence * influence;
          pushDir = dist > 1e-4 ? normalize(toBlade) : vec2(1.0, 0.0);
          worldPos.xz += pushDir * influence * h2 * uPushStrength;
          // Flatten more aggressively for flat bunches
          worldPos.y -= influence * h * uFlattenStrength;
        }
        vInteract = influence;

        // Blade normal in world space; bias upward so thin cards still catch sunlight
        vec3 N = normalize(mat3(instanceMatrix) * normal);
        N = normalize(N + vec3(windPush.x, 0.22, windPush.y) * 0.85
                        + vec3(pushDir.x, 0.0, pushDir.y) * influence * 0.5);
        // Flattened grass faces more upward (self-shadow look)
        N = normalize(mix(N, vec3(0.0, 1.0, 0.0), 0.42 + influence * 0.35));
        vWorldNormal = N;
        vWorldPos = worldPos;

        gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;

      uniform vec3 uGrassColor;
      uniform vec3 uNoiseColor;
      uniform sampler2D uNoiseMap;
      uniform sampler2D uAlphaMap;
      uniform float uNoiseScale;
      uniform float uNoiseStrength;
      uniform float uNoiseContrast;
      uniform float uPatchSoftness;
      uniform float uRootAO;
      uniform float uPushShadow;
      uniform float uStrokeStrength;
      uniform float uAlphaCutoff;
      uniform vec2 uWindDir;

      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform float uSunIntensity;
      uniform float uAmbient;
      uniform float uSSS;
      uniform float uSpecular;
      uniform vec3 uFogColor;
      uniform float uFogNear;
      uniform float uFogFar;
      uniform float uFogEnabled;
      uniform float uLodNear;
      uniform float uLodFar;
      uniform float uLodFadeIn;
      uniform float uLodEnabled;
      uniform vec3 uPlayerPos;
      uniform float uPlayerRadius;
      uniform float uInteractEnabled;

      varying float vElevation;
      varying float vInteract;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      varying vec2 vWorldXZ;
      varying vec2 vUv;

      void main() {
        // Silhouette cutout — one clump shape per instance
        float mask = texture2D(uAlphaMap, vUv).a;
        if (mask < uAlphaCutoff) discard;

        // --- Distance LOD: smooth translucent fade ---
        float dist = length(cameraPosition - vWorldPos);
        float visibility = 1.0;
        if (uLodEnabled > 0.5) {
          if (uLodFadeIn < 0.5) {
            visibility = 1.0 - smoothstep(uLodNear, max(uLodFar, uLodNear + 0.01), dist);
          } else {
            float fadeIn = smoothstep(uLodNear * 0.7, uLodNear + (uLodFar - uLodNear) * 0.15, dist);
            float fadeOut = 1.0 - smoothstep(uLodFar, uLodFar * 1.35, dist);
            visibility = fadeIn * fadeOut;
          }
          visibility = visibility * visibility * (3.0 - 2.0 * visibility);
        }
        if (visibility < 0.004) discard;

        // Flat fill colour (very subtle world patch only)
        vec2 nUV = vWorldXZ * uNoiseScale;
        float p1 = texture2D(uNoiseMap, nUV).r;
        float n = clamp((p1 - 0.5) * uNoiseContrast + 0.5, 0.0, 1.0);
        float soft = max(uPatchSoftness, 0.02);
        float patchMask = smoothstep(0.5 - soft, 0.5 + soft, n);
        vec3 col = mix(uGrassColor, uNoiseColor, patchMask * uNoiseStrength);
        col *= 1.0 - uRootAO * (1.0 - vElevation) * 0.25;
        col = max(col, uGrassColor * 0.95);

        // --- Soft sun (flat-ish lighting, not harsh metal) ---
        vec3 L = normalize(uSunDir);
        vec3 N = normalize(vWorldNormal);
        if (dot(N, L) < 0.0) N = -N;
        vec3 V = normalize(cameraPosition - vWorldPos);

        float ndl = max(dot(N, L), 0.0);
        float wrapDiff = ndl * 0.45 + 0.55; // soft wrap for cartoon meadow
        vec3 sunTerm = uSunColor * uSunIntensity * wrapDiff;

        float hemi = 0.55 + 0.45 * max(N.y, 0.0);
        vec3 sky = vec3(0.65, 0.78, 1.0);
        vec3 groundAmb = vec3(0.45, 0.62, 0.35);
        vec3 ambTerm = mix(groundAmb, sky, hemi) * uAmbient;

        float backlight = max(dot(V, -L), 0.0);
        float sss = pow(backlight, 1.5) * uSSS * 0.4;
        vec3 lit = col * (ambTerm + sunTerm) + col * uSunColor * sss;
        lit = max(lit, col * 0.55);

        // --- Soft green trail / pushed shadow (like reference under character) ---
        float push = clamp(vInteract, 0.0, 1.0);
        // Darker mint, not black
        vec3 crushCol = col * vec3(0.42, 0.55, 0.38);
        lit = mix(lit, crushCol, push * uPushShadow * (0.55 + 0.45 * (1.0 - vElevation)));

        if (uInteractEnabled > 0.5) {
          float pd = length(vWorldXZ - uPlayerPos.xz);
          // Soft elongated footprint shadow
          float blob = 1.0 - smoothstep(0.0, uPlayerRadius * 1.35, pd);
          blob = pow(blob, 1.6);
          vec3 trailCol = col * vec3(0.38, 0.52, 0.36);
          lit = mix(lit, trailCol, blob * 0.55 * uPushShadow);
        }

        if (uFogEnabled > 0.5) {
          float fog = smoothstep(uFogNear, uFogFar, dist);
          lit = mix(lit, uFogColor, fog);
        }

        gl_FragColor = vec4(lit, visibility);
      }
    `,
    side: THREE.DoubleSide,
    // Smooth translucent LOD fades (whole InstancedMesh = one sort unit)
    transparent: true,
    depthWrite: true,
    alphaTest: 0.0,
    opacity: 1,
  });
}
