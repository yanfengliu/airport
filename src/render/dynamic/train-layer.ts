// Draws the trains: AirTrain on its guideway, BART and Caltrain on their tracks. One instanced
// mesh of a car per kind of train; each train is as many cars as its route says.

import * as THREE from 'three';
import { CONFIG } from '../../sim/config.ts';
import type { Transit, TransitRoute } from '../../sim/transit/trains.ts';
import { MeshBuilder, box, rgb, type RGB } from '../builder.ts';

type Kind = TransitRoute['kind'];

interface CarStyle {
  length: number;
  width: number;
  height: number;
  /** Height of the floor above the rail. */
  floor: number;
  body: RGB;
  band: RGB;
  glass: RGB;
  roof: RGB;
  capacity: number;
}

/** The cars' length and width are the simulation's, which keeps trains on tracks side by side apart by them. */
const cars = CONFIG.transit.cars;
const STYLES: Record<Kind, CarStyle> = {
  airtrain: { ...cars.airtrain, height: 3.3, floor: 0.9, body: rgb(0xeef1f3), band: rgb(0x1f6fb5), glass: rgb(0x22303a), roof: rgb(0xd8dde1), capacity: 48 },
  bart: { ...cars.bart, height: 3.2, floor: 1.0, body: rgb(0xc9cfd4), band: rgb(0x1d5fa8), glass: rgb(0x1c2730), roof: rgb(0xb4bbc1), capacity: 40 },
  caltrain: { ...cars.caltrain, height: 4.7, floor: 0.6, body: rgb(0xd8dadc), band: rgb(0xb3262d), glass: rgb(0x1c2730), roof: rgb(0xa9afb4), capacity: 24 },
};

/** A car as stacked slabs: skirt, coloured band, windows, roof. The gap between cars is in its length. */
function carGeometry(style: CarStyle): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const halfL = style.length / 2 - 0.35;
  const halfW = style.width / 2;
  const h0 = style.floor;
  const top = style.floor + style.height;
  const band = h0 + style.height * 0.2;
  const sill = h0 + style.height * 0.42;
  const head = h0 + style.height * 0.78;
  box(b, 0, 0, h0, band, halfL, halfW, 0, style.body, style.body);
  box(b, 0, 0, band, sill, halfL, halfW + 0.02, 0, style.band, style.band);
  box(b, 0, 0, sill, head, halfL - 0.25, halfW - 0.04, 0, style.glass, style.glass);
  box(b, 0, 0, head, top, halfL, halfW, 0, style.body, style.roof);
  // Running gear, so the car does not float.
  box(b, 0, 0, 0.15, h0, halfL - 1.2, halfW - 0.5, 0, rgb(0x2b2f33), rgb(0x2b2f33));
  return b.build();
}

export class TrainLayer {
  readonly group = new THREE.Group();
  private readonly meshes = new Map<Kind, THREE.InstancedMesh>();
  private readonly counts = new Map<Kind, number>();
  private readonly matrix = new THREE.Matrix4();
  private readonly pose = { x: 0, y: 0, z: 0, heading: 0, visible: true };

  constructor() {
    this.group.name = 'trains';
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.2, envMapIntensity: 0.8 });
    for (const kind of Object.keys(STYLES) as Kind[]) {
      const mesh = new THREE.InstancedMesh(carGeometry(STYLES[kind]), material, STYLES[kind].capacity);
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.name = `trains-${kind}`;
      this.meshes.set(kind, mesh);
      this.group.add(mesh);
    }
  }

  /** Place every car; `alpha` is how far the frame is between the last two simulation steps. */
  update(transit: Transit, alpha: number): void {
    for (const kind of this.meshes.keys()) this.counts.set(kind, 0);
    const m = this.matrix.elements;
    for (const train of transit.trains) {
      const route = transit.routes[train.route];
      const mesh = this.meshes.get(route.kind)!;
      for (let car = 0; car < route.cars; car += 1) {
        transit.carPose(train, car, this.pose, alpha);
        if (!this.pose.visible) continue;
        const index = this.counts.get(route.kind)!;
        if (index >= STYLES[route.kind].capacity) break;
        this.counts.set(route.kind, index + 1);
        const c = Math.cos(this.pose.heading);
        const s = Math.sin(this.pose.heading);
        // Rotation about the vertical by the heading, then translation: forward (+X) turns towards -Z.
        m[0] = c;
        m[1] = 0;
        m[2] = -s;
        m[3] = 0;
        m[4] = 0;
        m[5] = 1;
        m[6] = 0;
        m[7] = 0;
        m[8] = s;
        m[9] = 0;
        m[10] = c;
        m[11] = 0;
        m[12] = this.pose.x;
        m[13] = this.pose.z;
        m[14] = -this.pose.y;
        m[15] = 1;
        mesh.setMatrixAt(index, this.matrix);
      }
    }
    for (const [kind, mesh] of this.meshes) {
      mesh.count = this.counts.get(kind)!;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
