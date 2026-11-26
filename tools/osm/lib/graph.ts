// Turning OSM ways into a topological graph: nodes where ways meet, end or are forced to split,
// and edges that keep the polyline between two such nodes.

import type { OsmWay } from './osm.ts';

export interface RawEdge<A> {
  a: number;
  b: number;
  /** OSM node ids along the edge, endpoints included. */
  osmNodes: number[];
  attrs: A;
  wayId: number;
}

export interface RawGraph<A> {
  /** OSM node id of each graph node. */
  nodeIds: number[];
  indexOf: Map<number, number>;
  edges: RawEdge<A>[];
}

export function buildGraph<A>(ways: readonly { way: OsmWay; attrs: A }[], forced: ReadonlySet<number> = new Set()): RawGraph<A> {
  const uses = new Map<number, number>();
  for (const { way } of ways) {
    for (const id of way.nodes) uses.set(id, (uses.get(id) ?? 0) + 1);
  }
  const isJunction = (id: number, atEnd: boolean): boolean => atEnd || (uses.get(id) ?? 0) > 1 || forced.has(id);

  const nodeIds: number[] = [];
  const indexOf = new Map<number, number>();
  const nodeFor = (id: number): number => {
    let index = indexOf.get(id);
    if (index === undefined) {
      index = nodeIds.length;
      nodeIds.push(id);
      indexOf.set(id, index);
    }
    return index;
  };

  const edges: RawEdge<A>[] = [];
  for (const { way, attrs } of ways) {
    if (way.nodes.length < 2) continue;
    let start = 0;
    for (let i = 1; i < way.nodes.length; i += 1) {
      const last = i === way.nodes.length - 1;
      if (!isJunction(way.nodes[i], last)) continue;
      const osmNodes = way.nodes.slice(start, i + 1);
      if (osmNodes.length >= 2 && !(osmNodes.length === 2 && osmNodes[0] === osmNodes[1])) {
        edges.push({ a: nodeFor(osmNodes[0]), b: nodeFor(osmNodes[osmNodes.length - 1]), osmNodes, attrs, wayId: way.id });
      }
      start = i;
    }
  }
  return { nodeIds, indexOf, edges };
}

/** Connected-component label per node, and the label of the largest component by edge count. */
export function components(nodeCount: number, edges: readonly { a: number; b: number }[]): { label: Int32Array; largest: number; count: number } {
  const parent = new Int32Array(nodeCount);
  for (let i = 0; i < nodeCount; i += 1) parent[i] = i;
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  for (const e of edges) {
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra !== rb) parent[ra] = rb;
  }
  const label = new Int32Array(nodeCount);
  const size = new Map<number, number>();
  for (let i = 0; i < nodeCount; i += 1) label[i] = find(i);
  for (const e of edges) size.set(label[e.a], (size.get(label[e.a]) ?? 0) + 1);
  let largest = -1;
  let best = -1;
  for (const [root, n] of size) {
    if (n > best) {
      best = n;
      largest = root;
    }
  }
  return { label, largest, count: size.size };
}
