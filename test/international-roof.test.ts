import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { mappedBuildings } from '../src/render/world.ts';
import { INTERNATIONAL_MAIN_HALL, buildTerminalShells } from '../src/render/static/terminals.ts';
import { type FacadeTextures } from '../src/render/textures.ts';
import { withinAny } from '../src/sim/terminal/fittings.ts';
import { loadLayoutFromDisk } from './helpers/layout.ts';

vi.mock('../src/render/textures.ts', async (original) => ({
  ...await original<typeof import('../src/render/textures.ts')>(),
  textTexture: () => ({ texture: new THREE.Texture(), aspect: 10 }),
}));

const layout = loadLayoutFromDisk();
const { own, aboveRoofs, mainHallParts } = mappedBuildings(layout);
const facade = new THREE.CanvasTexture();
const facades: FacadeTextures = { glass: facade, glassLit: facade, windows: facade, windowsLit: facade, decks: facade, decksLit: facade };
const { shell, glows } = buildTerminalShells(layout.terminals, facades, mainHallParts);
const hall = shell.getObjectByName('international-departures-hall')!;
const metal = hall.getObjectByName('international-wing-roof') as THREE.Mesh;
const glazing = hall.getObjectByName('international-skylights') as THREE.Mesh;

describe('the Dianne Feinstein International Terminal exterior', () => {
  it('uses the mapped upper hall and shoulders once and leaves all its exterior in the cutaway group', () => {
    expect(mainHallParts.map(p => p.height)).toEqual(expect.arrayContaining([7, 13, 19, 26, 32, 38, 41]));
    expect([...own, ...aboveRoofs].some(b => mainHallParts.some(p => p.poly === b.poly))).toBe(false);
    expect(hall.parent).toBe(shell);
    expect(metal.parent).toBe(hall);
    expect(hall.getObjectByName('international-curtain-wall')?.parent).toBe(hall);
    const flat = (shell.getObjectByName('terminal-roofs') as THREE.Mesh).geometry.getAttribute('position');
    const footprint = layout.terminals.buildings.find(building => building.name === INTERNATIONAL_MAIN_HALL)!;
    const inside = withinAny([footprint.poly]);
    const redundant = Array.from({ length: flat.count }, (_, i) => i)
      .some(i => flat.getY(i) === footprint.height && inside(flat.getX(i), -flat.getZ(i)));
    expect(redundant).toBe(false);
  });

  it('has the three risen spans, four central glazed lights and the projecting cantilever tips', () => {
    const p = metal.geometry.getAttribute('position');
    const top = new Map<number, number>();
    for (let i = 0; i < p.count; i++) top.set(p.getX(i), Math.max(top.get(p.getX(i)) ?? 0, p.getY(i)));
    const samples = [...top.entries()].sort((a, b) => a[0] - b[0]);
    const peaks = samples.filter((s, i) => i > 0 && i + 1 < samples.length && s[1] > samples[i - 1][1] && s[1] > samples[i + 1][1]);
    expect(samples.at(-1)![0] - samples[0][0]).toBeCloseTo(262, 1);
    expect(peaks).toHaveLength(3);
    for (const [, height] of peaks) expect(height - samples[0][1]).toBeGreaterThan(5);
    const g = glazing.geometry.getAttribute('position');
    const edges = new Set<number>();
    for (let i = 0; i < g.count; i++) if (g.getX(i) === 0) edges.add(g.getZ(i));
    expect(edges.size).toBe(8);
    expect(glows.some(light => light.material === glazing.material)).toBe(true);
  });

  it('keeps the roof clear of the mapped stands, even with an aircraft of the full permitted span', () => {
    hall.updateWorldMatrix(true, true);
    const v = new THREE.Vector3();
    const extent = metal.geometry.boundingBox!;
    for (const stand of layout.airfield.stands) {
      v.set(stand.x, 0, -stand.y);
      hall.worldToLocal(v);
      const dx = Math.max(extent.min.x - v.x, 0, v.x - extent.max.x);
      const dz = Math.max(extent.min.z - v.z, 0, v.z - extent.max.z);
      expect(Math.hypot(dx, dz), stand.id).toBeGreaterThan(stand.span / 2 + 1);
    }
  });
});
