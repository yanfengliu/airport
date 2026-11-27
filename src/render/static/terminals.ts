// Terminal buildings from outside: curtain walls, roofs, and the jet bridges reaching the stands.

import * as THREE from 'three';
import type { Airfield, Terminals } from '../../shared/layout.ts';
import { MeshBuilder, box, fillPolygon, rgb, wallPolygon } from '../builder.ts';
import type { FacadeTextures } from '../textures.ts';
import type { NightGlow } from './buildings.ts';
import { solidMesh } from './common.ts';

const FASCIA = 1.6;
export const BRIDGE_FLOOR = 4.1;
export const BRIDGE_ROOF = 6.9;
export const BRIDGE_TUNNEL = rgb(0xcfd3d6);
export const BRIDGE_STEEL = rgb(0x8a9097);

/** The last length of a stand's jet bridge, which reaches out to the aircraft door: drawn as it moves. */
export interface BridgeEnd {
  stand: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface TerminalShells {
  /** Walls and roofs: hidden in cut-away view so the floors inside can be seen. */
  shell: THREE.Group;
  /** Jet bridges and anything else that stays visible in cut-away view. */
  fixtures: THREE.Group;
  /** The moving ends of the jet bridges, for src/render/dynamic/bridge-layer.ts. */
  bridgeEnds: BridgeEnd[];
  glows: NightGlow[];
}

export function buildTerminalShells(terminals: Terminals, airfield: Airfield, facades: FacadeTextures): TerminalShells {
  const shell = new THREE.Group();
  shell.name = 'terminal-shells';
  const fixtures = new THREE.Group();
  fixtures.name = 'terminal-fixtures';

  const glass = new MeshBuilder();
  const trim = new MeshBuilder();
  const roofs = new MeshBuilder();
  const white = rgb(0xd6d9dc);
  const roofTone = rgb(0xb4b9bf);
  const glassTone = rgb(0xffffff);
  for (const b of terminals.buildings) {
    const top = b.height;
    const base = b.minHeight;
    const glazedTop = Math.max(base + 1, top - FASCIA);
    wallPolygon(glass, b.poly, base, glazedTop, glassTone, 1);
    wallPolygon(trim, b.poly, glazedTop, top + 0.5, white);
    fillPolygon(roofs, b.poly, top, roofTone);
    if (base > 0.5) {
      // A bridge between buildings: close its underside so it is not hollow from below.
      wallPolygon(trim, b.poly, base - 0.6, base, white);
    }
  }
  const glassMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: facades.glass,
    emissiveMap: facades.glassLit,
    emissive: 0xffffff,
    emissiveIntensity: 0,
    roughness: 0.22,
    metalness: 0.35,
    envMapIntensity: 1.3,
  });
  const trimMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.05 });
  const roofMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05 });
  shell.add(solidMesh(glass, glassMaterial, 'terminal-glass'));
  shell.add(solidMesh(trim, trimMaterial, 'terminal-trim'));
  shell.add(solidMesh(roofs, roofMaterial, 'terminal-roofs'));

  // Jet bridges as mapped: a boxed walkway along each segment, on a post at its outer end. The
  // last segment, which telescopes out to the door, is drawn by the bridge layer as it moves.
  const bridge = new MeshBuilder();
  const bridgeEnds: BridgeEnd[] = [];
  for (const stand of airfield.stands) {
    const mapped = stand.bridge;
    if (!mapped || mapped.length < 4) continue;
    // From the terminal door out to the aircraft: the map draws some bridges the other way round.
    // Without a door, the end nearer where the nose stops is the aircraft's.
    const n = mapped.length;
    const [tx, ty] = stand.door ?? [Number.NaN, Number.NaN];
    const fromDoor = (k: number): number => Math.hypot(mapped[k] - tx, mapped[k + 1] - ty);
    const fromStop = (k: number): number => Math.hypot(mapped[k] - stand.x, mapped[k + 1] - stand.y);
    const reversed = stand.door ? fromDoor(n - 2) < fromDoor(0) : fromStop(0) < fromStop(n - 2);
    const line: number[] = [];
    for (let i = 0; i < n; i += 2) {
      const k = reversed ? n - 2 - i : i;
      line.push(mapped[k], mapped[k + 1]);
    }
    let last = -1;
    for (let i = 2; i < line.length; i += 2) if (Math.hypot(line[i] - line[i - 2], line[i + 1] - line[i - 1]) >= 0.5) last = i;
    for (let i = 2; i < line.length; i += 2) {
      const x0 = line[i - 2];
      const y0 = line[i - 1];
      const x1 = line[i];
      const y1 = line[i + 1];
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (len < 0.5) continue;
      if (i === last) {
        bridgeEnds.push({ stand: stand.id, x0, y0, x1, y1 });
        continue;
      }
      const heading = Math.atan2(y1 - y0, x1 - x0);
      box(bridge, (x0 + x1) / 2, (y0 + y1) / 2, BRIDGE_FLOOR, BRIDGE_ROOF, len / 2 + 0.8, 1.55, heading, BRIDGE_TUNNEL, BRIDGE_TUNNEL);
      box(bridge, x1, y1, 0, BRIDGE_FLOOR, 0.45, 0.45, heading, BRIDGE_STEEL, BRIDGE_STEEL);
    }
  }
  fixtures.add(solidMesh(bridge, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.2 }), 'jet-bridges'));

  return { shell, fixtures, bridgeEnds, glows: [{ material: glassMaterial, strength: 0.55 }] };
}
