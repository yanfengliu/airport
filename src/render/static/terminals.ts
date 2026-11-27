// Terminal buildings from outside: curtain walls and roofs. The jet bridges are in bridges.ts.

import * as THREE from 'three';
import type { Terminals } from '../../shared/layout.ts';
import { MeshBuilder, fillPolygon, rgb, wallPolygon } from '../builder.ts';
import type { FacadeTextures } from '../textures.ts';
import type { NightGlow } from './buildings.ts';
import { solidMesh } from './common.ts';

const FASCIA = 1.6;

export interface TerminalShells {
  /** Walls and roofs: hidden in cut-away view so the floors inside can be seen. */
  shell: THREE.Group;
  glows: NightGlow[];
}

export function buildTerminalShells(terminals: Terminals, facades: FacadeTextures): TerminalShells {
  const shell = new THREE.Group();
  shell.name = 'terminal-shells';

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

  return { shell, glows: [{ material: glassMaterial, strength: 0.55 }] };
}
