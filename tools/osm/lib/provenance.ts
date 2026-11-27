// Which sections a build of the layout covers, and whether building only those is sound. One
// provenance covers every file, so a build that leaves any section out must be from the raw
// extract the others were built from; otherwise the provenance would claim the new sources for
// files built from the old.

import { LAYOUT_FILES, type LayoutSection, type Provenance } from '../../../src/shared/layout.ts';

/** The sections named in an `--only` list, each once and in their usual order; every section when there is no list. */
export function sectionsToBuild(list: string | undefined): LayoutSection[] {
  if (list === undefined) return [...LAYOUT_FILES];
  const names = list.split(',').map((name) => name.trim()).filter(Boolean);
  const unknown = names.filter((name) => !(LAYOUT_FILES as readonly string[]).includes(name));
  if (unknown.length) throw new Error(`no such section: ${unknown.join(', ')} (the sections are ${LAYOUT_FILES.join(', ')})`);
  return LAYOUT_FILES.filter((section) => names.includes(section));
}

/**
 * Why building only `sections` from a raw extract with these `themes` would leave the provenance
 * wrong, or null when it would not: every section is built, or nothing was built before, or the
 * extract is the one the files already there came from. `before` reads the provenance already there.
 */
export function partialBuildProblem(sections: readonly LayoutSection[], themes: Record<string, { sha256: string }>, before: () => Provenance | null): string | null {
  // Judged by which sections are left out, not by how many names were given.
  if (LAYOUT_FILES.every((section) => sections.includes(section))) return null;
  const built = before();
  if (!built) return null;
  const changed = Object.entries(themes)
    .filter(([name, t]) => built.themes[name]?.sha256 !== t.sha256)
    .map(([name]) => name);
  return changed.length ? `the raw extract has changed since public/data was built (${changed.join(', ')}): build every section, not only ${sections.join(', ')}` : null;
}
