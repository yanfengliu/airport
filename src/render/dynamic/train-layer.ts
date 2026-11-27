// Draws the trains: AirTrain on its guideway, BART and Caltrain on their tracks, each train as many
// cars as its route says. AirTrain's cars are Polyfork's guideway shuttle; BART's and Caltrain's are
// our own models (tools/models/original/trains.ts), a driving cab at each end of a train, their
// doors sliding open while it stands at a stop. Without the models, each car is drawn as stacked
// slabs of its line's colours.

import * as THREE from 'three';
import { CONFIG } from '../../sim/config.ts';
import type { Train, Transit, TransitRoute } from '../../sim/transit/trains.ts';
import { MeshBuilder, box, rgb, type RGB } from '../builder.ts';
import { Crowd, flatMaterial, outfitTable, placement, type Models } from '../models/library.ts';

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

/** Each line's models: a car, and a car with a driving cab, or one model for every car. */
export const MODELS: Record<Kind, { car: string; cab?: string }> = {
  airtrain: { car: 'guideway-rail-shuttle-3d67d7' },
  bart: { car: 'rapid-transit-car', cab: 'rapid-transit-cab-car' },
  caltrain: { car: 'bilevel-commuter-car', cab: 'bilevel-commuter-cab-car' },
};
/** Room between two cars coupled, metres, which a car's model leaves out of its length. */
export const GAP = 0.7;
/** Seconds the doors take to open, and to close. */
export const DOORS_MOVE = 1.6;

/**
 * How far open a train's doors are, 0 shut to 1 open, at `now`: opening over DOORS_MOVE seconds from
 * `since`, when they were first seen open, and closing over the last DOORS_MOVE seconds before `until`.
 */
export function doorShare(since: number, until: number, now: number): number {
  return Math.max(0, Math.min(1, (now - since) / DOORS_MOVE, (until - now) / DOORS_MOVE));
}

/** A car as stacked slabs: skirt, coloured band, windows, roof. The gap between cars is in its length. */
function carGeometry(style: CarStyle): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const halfL = style.length / 2 - GAP / 2;
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

/** How a line's cars are drawn: with its models (rigged ones as a crowd, posed), or as slabs. */
interface Line {
  /** For a static model or the slabs: one instanced mesh for every car. */
  mesh?: THREE.InstancedMesh;
  /** The static model's scale, to the car's length and width. */
  scale?: [number, number, number];
  /** For rigged models: the cars and the cab cars, posed per car. */
  car?: Crowd;
  cab?: Crowd;
  count: number;
}

export class TrainLayer {
  readonly group = new THREE.Group();
  private readonly lines = new Map<Kind, Line>();
  private readonly matrix = new THREE.Matrix4();
  private readonly pose = { x: 0, y: 0, z: 0, heading: 0, visible: true };
  /** When each train standing at a stop was first seen with its doors open, simulation seconds. */
  private readonly opened = new Map<number, number>();

  constructor(models: Models = new Map()) {
    this.group.name = 'trains';
    const slabs = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.2, envMapIntensity: 0.8 });
    for (const kind of Object.keys(STYLES) as Kind[]) {
      const style = STYLES[kind];
      const wanted = MODELS[kind];
      const car = models.get(wanted.car);
      const cab = wanted.cab ? models.get(wanted.cab) : undefined;
      let line: Line;
      if (car?.poses && (!wanted.cab || cab?.poses)) {
        // Our own models, with doors that move: drawn as they are made (row 0 of their colours).
        const crowd = (model: NonNullable<typeof car>): Crowd => {
          const c = new Crowd(model, style.capacity, outfitTable(model, true, 0));
          c.mesh.castShadow = true;
          c.mesh.name = `trains-${kind}-${model.info.id}`;
          this.group.add(c.mesh);
          return c;
        };
        line = { car: crowd(car), cab: cab ? crowd(cab) : undefined, count: 0 };
      } else if (car) {
        // A model to its line's car: as long as the car less the gap, as wide as it.
        const [mx, , mz] = [car.info.box[3], car.info.box[4], car.info.box[5]];
        const mesh = new THREE.InstancedMesh(car.geometry, flatMaterial(), style.capacity);
        line = { mesh, scale: [style.width / mx, 1, (style.length - GAP) / mz], count: 0 };
      } else {
        line = { mesh: new THREE.InstancedMesh(carGeometry(style), slabs, style.capacity), count: 0 };
      }
      if (line.mesh) {
        line.mesh.count = 0;
        line.mesh.castShadow = true;
        line.mesh.receiveShadow = true;
        line.mesh.frustumCulled = false;
        line.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        line.mesh.name = `trains-${kind}`;
        this.group.add(line.mesh);
      }
      this.lines.set(kind, line);
    }
  }

  /** How far open a train's doors are, 0 shut to 1 open, at `now`. */
  private doors(train: Train, now: number): number {
    if (train.doorsUntil < 0) {
      this.opened.delete(train.id);
      return 0;
    }
    const since = this.opened.get(train.id) ?? now;
    if (!this.opened.has(train.id)) this.opened.set(train.id, now);
    return doorShare(since, train.doorsUntil, now);
  }

  /**
   * Place every car; `alpha` is how far the frame is between the last two simulation steps, `now`
   * the simulation's time, for the doors.
   */
  update(transit: Transit, alpha: number, now = 0): void {
    for (const line of this.lines.values()) {
      line.count = 0;
      line.car?.begin();
      line.cab?.begin();
    }
    for (const train of transit.trains) {
      const route = transit.routes[train.route];
      const line = this.lines.get(route.kind)!;
      const open = line.car ? this.doors(train, now) : 0;
      for (let car = 0; car < route.cars; car += 1) {
        transit.carPose(train, car, this.pose, alpha);
        if (!this.pose.visible) continue;
        const { x, y, z, heading } = this.pose;
        if (line.car) {
          // A driving cab at each end of the train, facing out; the rest of the cars between.
          const end = car === 0 || car === route.cars - 1;
          const crowd = end && line.cab ? line.cab : line.car;
          const facing = car === route.cars - 1 && car !== 0 ? heading + Math.PI : heading;
          const [first, count] = crowd.pose('doors');
          const frame = open <= 0 ? crowd.pose('rest')[0] : first + Math.min(count - 1, Math.floor(open * count));
          crowd.add(x, y, z, facing, frame, 0);
          continue;
        }
        if (line.count >= line.mesh!.instanceMatrix.count) break;
        const [sx, sy, sz] = line.scale ?? [1, 1, 1];
        if (line.scale) placement(this.matrix, x, y, z, heading, sx, sy, sz);
        else {
          // The slabs are made along +x: rotation about the vertical by the heading, then translation.
          const c = Math.cos(heading);
          const s = Math.sin(heading);
          this.matrix.set(c, 0, s, x, 0, 1, 0, z, -s, 0, c, -y, 0, 0, 0, 1);
        }
        line.mesh!.setMatrixAt(line.count, this.matrix);
        line.count += 1;
      }
    }
    for (const line of this.lines.values()) {
      if (line.mesh) {
        line.mesh.count = line.count;
        line.mesh.instanceMatrix.needsUpdate = true;
      }
      line.car?.end();
      line.cab?.end();
    }
  }
}
