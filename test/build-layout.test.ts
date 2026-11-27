// The layout build's guard on its one provenance: a build of only some sections is refused when
// the raw extract has changed since the others were built, however the sections are named.
// Bound: the guard alone, on the committed provenance and a made-up changed digest; it reads no
// raw extract and builds nothing.

import { describe, expect, it } from 'vitest';
import { LAYOUT_FILES } from '../src/shared/layout.ts';
import { partialBuildProblem, sectionsToBuild } from '../tools/osm/lib/provenance.ts';
import { loadProvenanceFromDisk } from './helpers/layout.ts';

const before = loadProvenanceFromDisk();
const same = Object.fromEntries(Object.entries(before.themes).map(([name, theme]) => [name, { sha256: theme.sha256 }]));
const first = Object.keys(same)[0];
const changed = { ...same, [first]: { sha256: '0'.repeat(64) } };

describe('building only some sections of the layout', () => {
  it('takes each section named once, and refuses a name that is not a section', () => {
    expect(sectionsToBuild(undefined)).toEqual([...LAYOUT_FILES]);
    expect(sectionsToBuild('rail,airfield,rail')).toEqual(['airfield', 'rail']);
    expect(() => sectionsToBuild('airfeld')).toThrow(/no such section/);
  });

  it('refuses a partial build from a changed extract, one section named as many times as there are sections included', () => {
    const repeated = LAYOUT_FILES.map(() => 'airfield' as const);
    expect(partialBuildProblem(sectionsToBuild(repeated.join(',')), changed, () => before)).toMatch(new RegExp(`raw extract has changed .*${first}`));
    // The guard judges which sections are left out, even when handed the names as given.
    expect(partialBuildProblem(repeated, changed, () => before)).toMatch(/raw extract has changed/);
    expect(partialBuildProblem(sectionsToBuild('airfield,roads'), changed, () => before)).toMatch(/raw extract has changed/);
  });

  it('allows a partial build from the extract the files came from, and a full build from any', () => {
    expect(partialBuildProblem(sectionsToBuild('airfield'), same, () => before)).toBeNull();
    expect(partialBuildProblem(sectionsToBuild(undefined), changed, () => before)).toBeNull();
    expect(partialBuildProblem(sectionsToBuild([...LAYOUT_FILES].reverse().join(',')), changed, () => before)).toBeNull();
    // Nothing built yet: nothing for the provenance to be wrong about.
    expect(partialBuildProblem(sectionsToBuild('airfield'), changed, () => null)).toBeNull();
  });
});
