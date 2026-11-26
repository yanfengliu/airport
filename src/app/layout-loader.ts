// Fetch the layout sections the app is built from.

import { LAYOUT_FILES, type Layout, type Provenance } from '../shared/layout.ts';

export interface LoadedLayout {
  layout: Layout;
  provenance: Provenance;
}

export async function loadLayout(onProgress: (done: number, total: number) => void): Promise<LoadedLayout> {
  const base = `${import.meta.env.BASE_URL}data/`;
  const total = LAYOUT_FILES.length + 1;
  let done = 0;
  const get = async <T,>(name: string): Promise<T> => {
    const response = await fetch(`${base}${name}.json`);
    if (!response.ok) throw new Error(`Could not load ${name}.json (${response.status})`);
    const data = (await response.json()) as T;
    done += 1;
    onProgress(done, total);
    return data;
  };
  const [sections, provenance] = await Promise.all([Promise.all(LAYOUT_FILES.map((name) => get<unknown>(name))), get<Provenance>('provenance')]);
  const layout = Object.fromEntries(LAYOUT_FILES.map((name, i) => [name, sections[i]])) as unknown as Layout;
  return { layout, provenance };
}
