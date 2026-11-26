// The stage: renderer, camera, sky, sun and the lighting that follows the time of day.

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { daylight, sunAt } from '../shared/sun.ts';

const DEG = Math.PI / 180;
/** The widest the "aperture" opens, at night. */
const MAX_EXPOSURE = 3.2;

export interface StageOptions {
  canvas: HTMLCanvasElement;
  /** Keep the drawing buffer so screenshots can read the canvas. */
  preserveDrawingBuffer?: boolean;
}

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  readonly hemisphere = new THREE.HemisphereLight(0xbfd4ff, 0x4a4436, 1);
  readonly sky = new Sky();
  /** 0 at night, 1 by day; materials that glow at night read this. */
  day = 1;
  /** Extra haze from the weather, 0 clear to 1 dense fog. */
  haze = 0;
  /** What to multiply the brightness of lamps and lit windows by so the exposure does not change them. */
  lampGain = 0.5;

  private readonly fog = new THREE.FogExp2(0xb8c7d6, 0.00004);
  private readonly stars: THREE.Points;
  private readonly pmrem: THREE.PMREMGenerator;
  private readonly envScene = new THREE.Scene();
  private readonly envSky = new Sky();
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private envSunElevation = 99;
  private envHaze = -1;
  private readonly sunDir = new THREE.Vector3(0, 1, 0);
  private readonly listeners: (() => void)[] = [];

  constructor(options: StageOptions) {
    this.renderer = new THREE.WebGLRenderer({
      canvas: options.canvas,
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.6;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.camera = new THREE.PerspectiveCamera(42, 1, 2, 60_000);
    this.scene.fog = this.fog;

    this.sky.scale.setScalar(50_000);
    this.sky.material.fog = false;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
    this.envSky.scale.setScalar(1000);
    this.envScene.add(this.envSky);
    // The sky shader is far brighter than sunlit ground at the exposure the ground needs, so it
    // gets a gain of its own; without it the midday sky is plain white.
    for (const sky of [this.sky, this.envSky]) {
      sky.material.uniforms.skyGain = { value: 1 };
      sky.material.uniforms.skyAdd = { value: new THREE.Vector3() };
      sky.material.fragmentShader = sky.material.fragmentShader
        .replace('void main() {', 'uniform float skyGain;\nuniform vec3 skyAdd;\nvoid main() {')
        .replace('gl_FragColor = vec4( texColor, 1.0 );', 'gl_FragColor = vec4( texColor * skyGain + skyAdd, 1.0 );');
      sky.material.needsUpdate = true;
    }
    // Reflections take the clear sky; clouds in them would smear across the whole bay.
    this.envSky.material.uniforms.cloudCoverage.value = 0;

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.00012;
    this.sun.shadow.normalBias = 0.45;
    this.scene.add(this.sun, this.sun.target, this.hemisphere);

    this.stars = makeStars();
    this.scene.add(this.stars);

    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.resize();
    const onResize = (): void => this.resize();
    window.addEventListener('resize', onResize);
    this.listeners.push(() => window.removeEventListener('resize', onResize));
  }

  /** Density of the haze, for things that fade themselves with distance. */
  get fogDensity(): number {
    return this.fog.density;
  }

  resize(): void {
    const canvas = this.renderer.domElement;
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  /**
   * Set sun, sky, fog and exposure for a clock time, and keep the shadow frustum around the point
   * the camera looks at. `focus` is that point in three.js space; `reach` is how far from it
   * shadows should extend, in metres.
   */
  update(secondsOfDay: number, focus: THREE.Vector3, reach: number): void {
    const sun = sunAt(secondsOfDay);
    const day = daylight(secondsOfDay);
    this.day = day;
    const elevationDeg = sun.elevation / DEG;

    // By night the "sun" light is the moon: a dim, cool light from a fixed high angle.
    const moonUp = elevationDeg < -4;
    if (moonUp) this.sunDir.set(-0.35, 0.82, 0.45).normalize();
    else this.sunDir.set(sun.dir[0], Math.max(0.03, sun.dir[2]), -sun.dir[1]).normalize();

    const low = THREE.MathUtils.smoothstep(elevationDeg, -2, 28);
    const sunColour = new THREE.Color().setHSL(0.07 + 0.05 * low, 0.85 - 0.6 * low, 0.5 + 0.22 * low);
    if (moonUp) {
      this.sun.color.setRGB(0.55, 0.65, 1);
      // The moon comes up gradually, so the light does not jump as the sun's glow goes.
      this.sun.intensity = 0.2 * THREE.MathUtils.smoothstep(-elevationDeg, 4, 8);
    } else {
      this.sun.color.copy(sunColour);
      this.sun.intensity = 3.8 * THREE.MathUtils.smoothstep(elevationDeg, -3, 12) * (1 - 0.75 * this.haze);
    }
    this.hemisphere.intensity = 0.055 + 0.39 * day + 0.2 * this.haze * day;
    // The sky's light is blue by day and takes some of the sunset's warmth when the sun is low.
    const warmth = (1 - low) * day * 0.6;
    this.hemisphere.color.setRGB(0.55 + 0.25 * day + 0.2 * warmth, 0.66 + 0.2 * day - 0.08 * warmth, 1 - 0.3 * warmth);
    this.hemisphere.groundColor.setRGB(0.2 + 0.12 * day, 0.19 + 0.1 * day, 0.16 + 0.06 * day);

    const u = this.sky.material.uniforms;
    u.sunPosition.value.set(sun.dir[0], sun.dir[2], -sun.dir[1]);
    u.turbidity.value = 2.2 + 12 * this.haze;
    u.rayleigh.value = 2.5 + 1.0 * (1 - low) * day;
    u.mieCoefficient.value = 0.0014 + 0.02 * this.haze;
    u.mieDirectionalG.value = 0.8;
    u.time.value = secondsOfDay;
    u.cloudCoverage.value = 0.3 + 0.65 * this.haze;
    u.cloudDensity.value = 0.35 + 0.5 * this.haze;

    // Fog takes the colour of the horizon so distant ground fades into the sky.
    const horizon = new THREE.Color().setRGB(0.62, 0.72, 0.84).lerp(new THREE.Color(0xe9a36b), (1 - low) * day * 0.55);
    const night = new THREE.Color(0x060a14);
    this.fog.color.copy(night).lerp(horizon, day);
    if (this.haze > 0) this.fog.color.lerp(new THREE.Color().setRGB(0.72, 0.75, 0.78).multiplyScalar(0.15 + 0.85 * day), this.haze * 0.8);
    this.fog.density = 0.000035 + 0.00085 * this.haze * this.haze;

    // Expose for the ground: brighter light, smaller aperture, so noon does not wash out and dusk
    // does not go black.
    const c = this.sun.color;
    const ground = this.sun.intensity * (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) * Math.max(0, this.sunDir.y) + this.hemisphere.intensity * 0.9;
    const exposure = THREE.MathUtils.clamp(1.05 / Math.pow(Math.max(0.02, ground), 0.85), 0.3, MAX_EXPOSURE);
    this.renderer.toneMappingExposure = exposure;
    // Lamps are tuned for the widest aperture; with a smaller one they would otherwise go dim.
    this.lampGain = MAX_EXPOSURE / exposure / 2;
    // The sky's own brightness falls with the sun far faster than the ground's, so its gain is
    // set against the exposure rather than left to it.
    u.skyGain.value = (0.18 + 1.25 * (1 - low)) / exposure;
    // The model's sky goes black away from the sunset; the real one stays a deep blue through
    // twilight and never quite reaches black over a city.
    const twilight = 4 * day * (1 - day);
    (u.skyAdd.value as THREE.Vector3).set(0.004 + 0.05 * twilight, 0.006 + 0.075 * twilight, 0.014 + 0.14 * twilight).multiplyScalar(1 - 0.6 * this.haze);
    (this.stars.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - day * 2.5) * (1 - this.haze);
    this.stars.visible = day < 0.4;

    // Shadows: an orthographic box around the focus, snapped to whole texels so edges do not crawl.
    const size = THREE.MathUtils.clamp(reach, 120, 2600);
    const cam = this.sun.shadow.camera;
    if (cam.right !== size) {
      cam.left = -size;
      cam.right = size;
      cam.top = size;
      cam.bottom = -size;
      cam.near = 10;
      cam.far = 9000;
      cam.updateProjectionMatrix();
    }
    const texel = (2 * size) / this.sun.shadow.mapSize.x;
    const fx = Math.round(focus.x / texel) * texel;
    const fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, 0, fz);
    this.sun.position.set(fx + this.sunDir.x * 4000, this.sunDir.y * 4000, fz + this.sunDir.z * 4000);
    this.sun.target.updateMatrixWorld();

    this.stars.position.copy(this.camera.position);
    this.sky.position.copy(this.camera.position);

    if (Math.abs(elevationDeg - this.envSunElevation) > 1.5 || Math.abs(this.haze - this.envHaze) > 0.1) this.refreshEnvironment(elevationDeg);
  }

  /** Reflections: a small cube map of the sky, redone when the sun has moved noticeably. */
  private refreshEnvironment(elevationDeg: number): void {
    this.envSunElevation = elevationDeg;
    this.envHaze = this.haze;
    const from = this.sky.material.uniforms;
    const to = this.envSky.material.uniforms;
    for (const key of ['sunPosition', 'turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG', 'skyGain', 'skyAdd'] as const) {
      const value = from[key].value;
      if (value instanceof THREE.Vector3) (to[key].value as THREE.Vector3).copy(value);
      else to[key].value = value;
    }
    const previous = this.envTarget;
    this.envTarget = this.pmrem.fromScene(this.envScene, 0, 1, 2000);
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = 0.06 + 0.2 * this.day;
    previous?.dispose();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    for (const off of this.listeners) off();
    this.envTarget?.dispose();
    this.pmrem.dispose();
    this.renderer.dispose();
  }
}

function makeStars(): THREE.Points {
  const count = 1400;
  const positions = new Float32Array(count * 3);
  // A fixed seed keeps the sky the same in every capture.
  let seed = 20261125;
  const random = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < count; i += 1) {
    const azimuth = random() * Math.PI * 2;
    const height = 0.04 + random() * 0.96;
    const r = Math.sqrt(1 - height * height);
    positions[i * 3] = Math.cos(azimuth) * r * 40_000;
    positions[i * 3 + 1] = height * 40_000;
    positions[i * 3 + 2] = Math.sin(azimuth) * r * 40_000;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({ color: 0xdfe8ff, size: 1.6, sizeAttenuation: false, transparent: true, depthWrite: false, fog: false });
  const stars = new THREE.Points(geometry, material);
  stars.frustumCulled = false;
  stars.renderOrder = -10;
  return stars;
}
