// The stage: renderer, camera, sky, sun and the lighting that follows the time of day.

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { daylight, sunAt } from '../shared/sun.ts';

const DEG = Math.PI / 180;

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
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(42, 1, 2, 60_000);
    this.scene.fog = this.fog;

    this.sky.scale.setScalar(50_000);
    this.sky.material.fog = false;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
    this.envSky.scale.setScalar(1000);
    this.envScene.add(this.envSky);

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun, this.sun.target, this.hemisphere);

    this.stars = makeStars();
    this.scene.add(this.stars);

    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.resize();
    const onResize = (): void => this.resize();
    window.addEventListener('resize', onResize);
    this.listeners.push(() => window.removeEventListener('resize', onResize));
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
      this.sun.intensity = 0.16;
    } else {
      this.sun.color.copy(sunColour);
      this.sun.intensity = 3.4 * THREE.MathUtils.smoothstep(elevationDeg, -3, 12) * (1 - 0.75 * this.haze);
    }
    this.hemisphere.intensity = 0.1 + 1.25 * day + 0.5 * this.haze * day;
    this.hemisphere.color.setRGB(0.55 + 0.25 * day, 0.66 + 0.2 * day, 1);
    this.hemisphere.groundColor.setRGB(0.2 + 0.12 * day, 0.19 + 0.1 * day, 0.16 + 0.06 * day);

    const u = this.sky.material.uniforms;
    u.sunPosition.value.set(sun.dir[0], sun.dir[2], -sun.dir[1]);
    u.turbidity.value = 4 + 10 * this.haze;
    u.rayleigh.value = 1.3 + 1.2 * (1 - low) * day;
    u.mieCoefficient.value = 0.004 + 0.02 * this.haze;
    u.mieDirectionalG.value = 0.82;

    // Fog takes the colour of the horizon so distant ground fades into the sky.
    const horizon = new THREE.Color().setRGB(0.62, 0.72, 0.84).lerp(new THREE.Color(0xe9a36b), (1 - low) * day * 0.55);
    const night = new THREE.Color(0x060a14);
    this.fog.color.copy(night).lerp(horizon, day);
    if (this.haze > 0) this.fog.color.lerp(new THREE.Color().setRGB(0.72, 0.75, 0.78).multiplyScalar(0.15 + 0.85 * day), this.haze * 0.8);
    this.fog.density = 0.000035 + 0.00085 * this.haze * this.haze;

    this.renderer.toneMappingExposure = 0.3 + 0.32 * day;
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
    for (const key of ['sunPosition', 'turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG'] as const) {
      const value = from[key].value;
      if (value instanceof THREE.Vector3) (to[key].value as THREE.Vector3).copy(value);
      else to[key].value = value;
    }
    const previous = this.envTarget;
    this.envTarget = this.pmrem.fromScene(this.envScene, 0, 1, 2000);
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = 0.25 + 0.55 * this.day;
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
