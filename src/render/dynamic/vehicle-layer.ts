// Draws road vehicles. Near what the camera looks at, each is one of Polyfork's vehicles of its kind
// (chosen by its id), scaled to its length in the simulation and in its own paint; a truck is a
// tractor pulling a short box trailer. Further off, where a model would cover a few pixels, each is a
// light shape of its kind, tinted: one instanced mesh per kind.

import * as THREE from 'three';
import { VEHICLE_LENGTH, type Vehicle, type VehicleKind } from '../../sim/roads/traffic.ts';
import { LIGHT_COLOURS, type Lights } from '../lights.ts';
import { paintedMaterial, placement, type Models } from '../models/library.ts';
import { buildVehicleGeometry } from '../models/vehicles.ts';

/**
 * Polyfork's vehicles for each kind, with the colour slots that take a vehicle's paint (its body).
 * A truck's second piece is its trailer, drawn `trailer` long behind the tractor.
 */
export const VEHICLE_MODELS: Record<VehicleKind, { id: string; paint: number[] }[]> = {
  car: [
    { id: 'compact-hatchback-386417', paint: [0] },
    { id: 'town-car-56eeb6', paint: [0] },
    { id: 'hatchback-80s-e95554', paint: [0] },
    { id: 'station-wagon-70s-11d67b', paint: [0] },
  ],
  suv: [
    { id: 'family-crossover-suv-42027f', paint: [1] },
    { id: 'pickup-truck-a34bf2', paint: [5] },
  ],
  van: [
    { id: 'family-minivan-924de0', paint: [0] },
    { id: 'boxy-delivery-van-a3ceae', paint: [4] },
  ],
  taxi: [{ id: 'yellow-cab-8df4a0', paint: [1] }],
  shuttle: [{ id: 'campus-shuttle-bus-27dcaa', paint: [0] }],
  bus: [{ id: 'city-bus-49fd97', paint: [2] }],
  truck: [{ id: 'semi-tractor-e9455c', paint: [1] }],
};
export const TRAILER = { id: 'box-trailer-2743e6', paint: [16, 14, 0], length: 8.5 };
/** Vehicles drawn as models: within this share of the camera's distance of what it looks at, at most this far, and only when the camera is nearer than NEAR. */
const NEAR_REACH = 0.9;
const NEAR_REACH_MOST = 900;
const NEAR = 2200;
/** Of each model, drawn at most. */
const MODEL_CAPACITY = 900;

const HEADLIGHT: readonly [number, number, number] = [1, 0.93, 0.78];

const CAPACITY: Record<VehicleKind, number> = { car: 3200, suv: 1800, van: 700, taxi: 500, shuttle: 260, bus: 160, truck: 500 };

/** One of Polyfork's vehicles as drawn: its instances, scale and the offset that centres it. */
interface Fleet {
  mesh: THREE.InstancedMesh;
  count: number;
  /** Uniform scale to the kind's length (a trailer: its own along its length). */
  scale: [number, number, number];
  /** Metres from the model's origin forward to its middle, and half its length, after scaling. */
  middle: number;
  half: number;
}

export class VehicleLayer {
  readonly group = new THREE.Group();
  private readonly meshes = new Map<VehicleKind, THREE.InstancedMesh>();
  private readonly counts = new Map<VehicleKind, number>();
  private readonly fleets = new Map<VehicleKind, Fleet[]>();
  private trailer: Fleet | null = null;
  private readonly matrix = new THREE.Matrix4();
  private readonly colour = new THREE.Color();
  /** Vehicles are skipped when the camera is too far for them to cover a pixel. */
  maxDistance = 9000;

  constructor(models: Models = new Map()) {
    this.group.name = 'vehicles';
    const fleet = (id: string, paint: number[], length: number, stretchOnly = false): Fleet | null => {
      const model = models.get(id);
      if (!model) return null;
      const box = model.info.box;
      const k = length / box[5];
      const scale: [number, number, number] = stretchOnly ? [1, 1, k] : [k, k, k];
      const mesh = new THREE.InstancedMesh(model.geometry, paintedMaterial(paint), MODEL_CAPACITY);
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.setColorAt(0, this.colour.set(0xffffff));
      mesh.name = `vehicles-${id}`;
      this.group.add(mesh);
      return { mesh, count: 0, scale, middle: (box[2] + box[5] / 2) * scale[2], half: (box[5] / 2) * scale[2] };
    };
    for (const [kind, list] of Object.entries(VEHICLE_MODELS) as [VehicleKind, { id: string; paint: number[] }[]][]) {
      // A truck's tractor is drawn at its own size, its trailer cut to a pup's length behind it.
      const drawn = list.map((m) => fleet(m.id, m.paint, kind === 'truck' ? (models.get(m.id)?.info.box[5] ?? 1) : VEHICLE_LENGTH[kind])).filter((f): f is Fleet => f !== null);
      if (drawn.length === list.length) this.fleets.set(kind, drawn);
    }
    this.trailer = fleet(TRAILER.id, TRAILER.paint, TRAILER.length, true);
    if (!this.trailer) this.fleets.delete('truck');
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.25, envMapIntensity: 0.8 });
    for (const kind of Object.keys(CAPACITY) as VehicleKind[]) {
      const mesh = new THREE.InstancedMesh(buildVehicleGeometry(kind, VEHICLE_LENGTH[kind]), material, CAPACITY[kind]);
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.setColorAt(0, this.colour.set(0xffffff));
      mesh.name = `vehicles-${kind}`;
      this.meshes.set(kind, mesh);
      this.group.add(mesh);
    }
  }

  /**
   * With `lights`, each vehicle also shows head and tail lights. (`focusX`, `focusY`) is what the
   * camera looks at: vehicles near it are drawn as models.
   */
  update(vehicles: readonly Vehicle[], alpha: number, cameraDistance: number, lights: Lights | null = null, focusX = 0, focusY = 0): void {
    for (const kind of this.meshes.keys()) this.counts.set(kind, 0);
    for (const list of this.fleets.values()) for (const f of list) f.count = 0;
    if (this.trailer) this.trailer.count = 0;
    const reach = cameraDistance <= NEAR && this.fleets.size ? Math.min(NEAR_REACH_MOST, cameraDistance * NEAR_REACH) : -1;
    if (cameraDistance <= this.maxDistance) {
      const m = this.matrix.elements;
      for (const v of vehicles) {
        const x = v.px + (v.x - v.px) * alpha;
        const y = v.py + (v.y - v.py) * alpha;
        const z = v.pz + (v.z - v.pz) * alpha;
        let turn = v.heading - v.pheading;
        turn = Math.atan2(Math.sin(turn), Math.cos(turn));
        const heading = v.pheading + turn * alpha;
        const c = Math.cos(heading);
        const s = Math.sin(heading);
        const list = this.fleets.get(v.kind);
        if (list && (x - focusX) ** 2 + (y - focusY) ** 2 <= reach * reach && this.model(v, list, x, y, z, heading, c, s)) {
          if (lights) this.lamps(lights, v, x, y, z, c, s);
          continue;
        }
        const mesh = this.meshes.get(v.kind)!;
        const index = this.counts.get(v.kind)!;
        if (index >= CAPACITY[v.kind]) continue;
        this.counts.set(v.kind, index + 1);
        // Rotation about the vertical by `heading`, then translation: forward (+X) turns towards -Z.
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
        m[12] = x;
        m[13] = z + 0.14;
        m[14] = -y;
        m[15] = 1;
        mesh.setMatrixAt(index, this.matrix);
        mesh.setColorAt(index, this.colour.set(v.colour));
        if (lights) this.lamps(lights, v, x, y, z, c, s);
      }
    }
    for (const [kind, mesh] of this.meshes) {
      mesh.count = this.counts.get(kind)!;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    for (const f of [...[...this.fleets.values()].flat(), ...(this.trailer ? [this.trailer] : [])]) {
      f.mesh.count = f.count;
      f.mesh.instanceMatrix.needsUpdate = true;
      if (f.mesh.instanceColor) f.mesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * One vehicle as one of its kind's models, its middle on the vehicle's point; a truck's tractor at
   * the front of the truck's length and its trailer at the back. False if the model's instances are
   * used up.
   */
  private model(v: Vehicle, list: Fleet[], x: number, y: number, z: number, heading: number, c: number, s: number): boolean {
    const f = list[v.id % list.length];
    if (f.count >= MODEL_CAPACITY) return false;
    this.colour.set(v.colour);
    // Where the model's middle goes, ahead of the vehicle's point; its origin is that less its middle.
    const middle = v.kind === 'truck' ? v.length / 2 - f.half : 0;
    const along = middle - f.middle;
    f.mesh.setMatrixAt(f.count, placement(this.matrix, x + c * along, y + s * along, z, heading, f.scale[0], f.scale[1], f.scale[2]));
    f.mesh.setColorAt(f.count, this.colour);
    f.count += 1;
    if (v.kind === 'truck' && this.trailer && this.trailer.count < MODEL_CAPACITY) {
      const t = this.trailer;
      const back = -v.length / 2 + t.half - t.middle;
      t.mesh.setMatrixAt(t.count, placement(this.matrix, x + c * back, y + s * back, z, heading, t.scale[0], t.scale[1], t.scale[2]));
      t.mesh.setColorAt(t.count, this.colour);
      t.count += 1;
    }
    return true;
  }

  /** Head and tail lights, just outside the bodywork so the vehicle itself does not hide them. */
  private lamps(lights: Lights, v: Vehicle, x: number, y: number, z: number, c: number, s: number): void {
    const front = v.length / 2 + 0.4;
    const back = v.length / 2 + 0.3;
    const side = v.kind === 'bus' || v.kind === 'truck' || v.kind === 'shuttle' ? 1 : 0.72;
    const nx = -s * side;
    const ny = c * side;
    const fx = x + c * front;
    const fy = y + s * front;
    const bx = x - c * back;
    const by = y - s * back;
    // Larger than the lamps themselves: a headlight is small but far brighter than its size.
    lights.add(fx + nx, fy + ny, z + 0.7, HEADLIGHT, 1.7);
    lights.add(fx - nx, fy - ny, z + 0.7, HEADLIGHT, 1.7);
    lights.add(bx + nx, by + ny, z + 0.8, LIGHT_COLOURS.RED, 1.1);
    lights.add(bx - nx, by - ny, z + 0.8, LIGHT_COLOURS.RED, 1.1);
  }
}
