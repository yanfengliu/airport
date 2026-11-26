// Map-style camera: it looks at a point on the ground from a distance, a compass bearing and a
// tilt. Drag to pan, right-drag (or Ctrl/Shift-drag) to orbit, wheel to zoom towards the cursor.

import * as THREE from 'three';

export interface CameraView {
  /** Ground point looked at, map metres east and north. */
  x: number;
  y: number;
  /** Height of the looked-at point above ground. */
  h?: number;
  /** Metres from the camera to that point. */
  distance: number;
  /** Compass bearing the camera faces, degrees clockwise from north. */
  bearing: number;
  /** Degrees from straight down: 0 is a plan view, 90 is level with the horizon. */
  tilt: number;
}

export interface FollowTarget {
  x: number;
  y: number;
  h: number;
}

const DEG = Math.PI / 180;
const MIN_TILT = 2 * DEG;
const MAX_TILT = 88.5 * DEG;
const MIN_DISTANCE = 12;
const MAX_DISTANCE = 14_000;

export class MapCamera {
  /** Smoothed state actually applied to the camera. */
  x = 0;
  y = 0;
  h = 0;
  distance = 5000;
  bearing = 0;
  tilt = 45 * DEG;

  private goal = { x: 0, y: 0, h: 0, distance: 5000, bearing: 0, tilt: 45 * DEG };
  private stiffness = 9;
  private follow: (() => FollowTarget | null) | null = null;
  private readonly keys = new Set<string>();
  private drag: { mode: 'pan' | 'orbit'; anchor: THREE.Vector3 | null; lastX: number; lastY: number; moved: number } | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly cleanup: (() => void)[] = [];
  /** World half-extent the look-at point is kept inside. */
  bounds = 4200;
  /** Called when the viewer clicks without dragging; receives client coordinates. */
  onClick: ((clientX: number, clientY: number) => void) | null = null;
  /** Called when the viewer pans by hand, which ends follow mode. */
  onUserPan: (() => void) | null = null;

  readonly camera: THREE.PerspectiveCamera;
  private readonly dom: HTMLElement;

  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    this.camera = camera;
    this.dom = dom;
    this.attach();
  }

  get isFollowing(): boolean {
    return this.follow !== null;
  }

  view(): CameraView {
    return { x: this.x, y: this.y, h: this.h, distance: this.distance, bearing: ((this.bearing / DEG) % 360 + 360) % 360, tilt: this.tilt / DEG };
  }

  /** Move to a view. With `immediate` the camera jumps; otherwise it eases there. */
  setView(view: Partial<CameraView>, immediate = false): void {
    if (view.x !== undefined) this.goal.x = view.x;
    if (view.y !== undefined) this.goal.y = view.y;
    if (view.h !== undefined) this.goal.h = view.h;
    if (view.distance !== undefined) this.goal.distance = THREE.MathUtils.clamp(view.distance, MIN_DISTANCE, MAX_DISTANCE);
    if (view.tilt !== undefined) this.goal.tilt = THREE.MathUtils.clamp(view.tilt * DEG, MIN_TILT, MAX_TILT);
    if (view.bearing !== undefined) {
      // Take the short way round.
      const wanted = view.bearing * DEG;
      const delta = Math.atan2(Math.sin(wanted - this.goal.bearing), Math.cos(wanted - this.goal.bearing));
      this.goal.bearing += delta;
    }
    this.stiffness = 3.2;
    if (immediate) this.snap();
  }

  snap(): void {
    this.x = this.goal.x;
    this.y = this.goal.y;
    this.h = this.goal.h;
    this.distance = this.goal.distance;
    this.bearing = this.goal.bearing;
    this.tilt = this.goal.tilt;
    this.apply();
  }

  /** Keep the look-at point on a moving thing; pass null to stop. */
  setFollow(source: (() => FollowTarget | null) | null): void {
    this.follow = source;
  }

  update(dt: number): void {
    this.applyKeys(dt);
    if (this.follow) {
      const target = this.follow();
      if (target) {
        this.goal.x = target.x;
        this.goal.y = target.y;
        this.goal.h = target.h;
      } else {
        this.follow = null;
      }
    }
    const k = 1 - Math.exp(-dt * this.stiffness);
    this.x += (this.goal.x - this.x) * k;
    this.y += (this.goal.y - this.y) * k;
    this.h += (this.goal.h - this.h) * k;
    this.distance *= Math.exp(Math.log(this.goal.distance / this.distance) * k);
    this.bearing += (this.goal.bearing - this.bearing) * k;
    this.tilt += (this.goal.tilt - this.tilt) * k;
    if (Math.abs(this.goal.distance - this.distance) < 0.01 * this.distance && Math.hypot(this.goal.x - this.x, this.goal.y - this.y) < 0.5) this.stiffness = 9;
    this.apply();
  }

  /** The ground point under a client position, in three.js space, or null above the horizon. */
  groundAt(clientX: number, clientY: number): THREE.Vector3 | null {
    const rect = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.ground, hit)) return null;
    if (hit.distanceTo(this.camera.position) > 40_000) return null;
    return hit;
  }

  /** A ray through a client position, for picking. */
  rayAt(clientX: number, clientY: number): THREE.Ray {
    const rect = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.ray.clone();
  }

  dispose(): void {
    for (const off of this.cleanup) off();
  }

  private apply(): void {
    const sinT = Math.sin(this.tilt);
    const cosT = Math.cos(this.tilt);
    const east = Math.sin(this.bearing);
    const north = Math.cos(this.bearing);
    const cx = this.x - east * this.distance * sinT;
    const cy = this.y - north * this.distance * sinT;
    const ch = this.h + this.distance * cosT;
    this.camera.position.set(cx, ch, -cy);
    // Looking straight down, "up" on screen is the bearing; otherwise it is the sky.
    if (sinT > 0.05) this.camera.up.set(0, 1, 0);
    else this.camera.up.set(east, 0, -north);
    this.camera.lookAt(this.x, this.h, -this.y);
    const near = THREE.MathUtils.clamp(this.distance * 0.02, 0.6, 60);
    if (Math.abs(this.camera.near - near) > near * 0.05) {
      this.camera.near = near;
      this.camera.far = 60_000;
      this.camera.updateProjectionMatrix();
    }
  }

  private clampGoal(): void {
    this.goal.x = THREE.MathUtils.clamp(this.goal.x, -this.bounds, this.bounds);
    this.goal.y = THREE.MathUtils.clamp(this.goal.y, -this.bounds, this.bounds);
    this.goal.distance = THREE.MathUtils.clamp(this.goal.distance, MIN_DISTANCE, MAX_DISTANCE);
    this.goal.tilt = THREE.MathUtils.clamp(this.goal.tilt, MIN_TILT, MAX_TILT);
  }

  private userPanned(): void {
    if (this.follow) {
      this.follow = null;
      this.onUserPan?.();
    }
  }

  private applyKeys(dt: number): void {
    if (this.keys.size === 0) return;
    const has = (...codes: string[]): boolean => codes.some((c) => this.keys.has(c));
    const move = this.goal.distance * 0.9 * dt;
    let forward = 0;
    let right = 0;
    if (has('KeyW', 'ArrowUp')) forward += 1;
    if (has('KeyS', 'ArrowDown')) forward -= 1;
    if (has('KeyD', 'ArrowRight')) right += 1;
    if (has('KeyA', 'ArrowLeft')) right -= 1;
    if (forward !== 0 || right !== 0) {
      const east = Math.sin(this.goal.bearing);
      const north = Math.cos(this.goal.bearing);
      this.goal.x += (east * forward + north * right) * move;
      this.goal.y += (north * forward - east * right) * move;
      this.userPanned();
    }
    if (has('KeyQ')) this.goal.bearing -= 1.2 * dt;
    if (has('KeyE')) this.goal.bearing += 1.2 * dt;
    if (has('KeyR')) this.goal.tilt -= 0.8 * dt;
    if (has('KeyF')) this.goal.tilt += 0.8 * dt;
    if (has('KeyZ', 'Equal', 'NumpadAdd')) this.goal.distance *= Math.exp(-1.6 * dt);
    if (has('KeyX', 'Minus', 'NumpadSubtract')) this.goal.distance *= Math.exp(1.6 * dt);
    this.stiffness = 9;
    this.clampGoal();
  }

  private attach(): void {
    const dom = this.dom;
    const on = <K extends keyof HTMLElementEventMap>(target: HTMLElement | Window, type: K, handler: (e: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions): void => {
      target.addEventListener(type, handler as EventListener, options);
      this.cleanup.push(() => target.removeEventListener(type, handler as EventListener, options));
    };

    on(dom, 'contextmenu', (e) => e.preventDefault());
    on(dom, 'pointerdown', (e) => {
      if (e.button > 2) return;
      dom.setPointerCapture(e.pointerId);
      const orbit = e.button !== 0 || e.ctrlKey || e.shiftKey || e.metaKey;
      this.drag = { mode: orbit ? 'orbit' : 'pan', anchor: orbit ? null : this.groundAt(e.clientX, e.clientY), lastX: e.clientX, lastY: e.clientY, moved: 0 };
    });
    on(dom, 'pointermove', (e) => {
      const drag = this.drag;
      if (!drag) return;
      const dx = e.clientX - drag.lastX;
      const dy = e.clientY - drag.lastY;
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.moved < 4) return;
      if (drag.mode === 'orbit') {
        this.goal.bearing -= dx * 0.0055;
        this.goal.tilt -= dy * 0.0045;
        this.clampGoal();
        this.bearing = this.goal.bearing;
        this.tilt = this.goal.tilt;
        this.apply();
        return;
      }
      if (!drag.anchor) return;
      // Slide the world so the grabbed ground point stays under the cursor.
      const now = this.groundAt(e.clientX, e.clientY);
      if (!now) return;
      this.goal.x += drag.anchor.x - now.x;
      this.goal.y += -(drag.anchor.z - now.z);
      this.clampGoal();
      this.x = this.goal.x;
      this.y = this.goal.y;
      this.apply();
      this.userPanned();
    });
    const end = (e: PointerEvent): void => {
      const drag = this.drag;
      this.drag = null;
      if (dom.hasPointerCapture(e.pointerId)) dom.releasePointerCapture(e.pointerId);
      if (drag && drag.moved < 4 && e.button === 0 && e.type === 'pointerup') this.onClick?.(e.clientX, e.clientY);
    };
    on(dom, 'pointerup', end);
    on(dom, 'pointercancel', end);

    on(
      dom,
      'wheel',
      (e) => {
        e.preventDefault();
        const scale = Math.exp(THREE.MathUtils.clamp(e.deltaY, -240, 240) * (e.ctrlKey ? 0.012 : 0.0016));
        const before = this.goal.distance;
        const after = THREE.MathUtils.clamp(before * scale, MIN_DISTANCE, MAX_DISTANCE);
        const ratio = after / before;
        const point = this.follow ? null : this.groundAt(e.clientX, e.clientY);
        if (point) {
          // Zoom about the ground point under the cursor.
          this.goal.x = point.x + (this.goal.x - point.x) * ratio;
          this.goal.y = -point.z + (this.goal.y + point.z) * ratio;
        }
        this.goal.distance = after;
        this.stiffness = 12;
        this.clampGoal();
      },
      { passive: false },
    );

    on(window, 'keydown', (e) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      this.keys.add(e.code);
    });
    on(window, 'keyup', (e) => {
      this.keys.delete(e.code);
    });
    on(window, 'blur', () => this.keys.clear());
  }
}
