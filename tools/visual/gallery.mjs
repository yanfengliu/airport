#!/usr/bin/env node
// The progress gallery: an uncommitted page of screenshots under artifacts/gallery/ (ignored).
//
//   node tools/visual/gallery.mjs add <image> --title "..." [--note "..."] [--group "..."]
//   node tools/visual/gallery.mjs rebuild
//
// `add` copies the image into artifacts/gallery/shots/, records it in manifest.json and rewrites
// index.html, newest first within each group. Open artifacts/gallery/index.html in a browser.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = join(root, 'artifacts', 'gallery');
const shots = join(dir, 'shots');
const manifestPath = join(dir, 'manifest.json');

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function load() {
  return existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { entries: [] };
}

function render(manifest) {
  const groups = [];
  for (const e of manifest.entries) {
    let g = groups.find((x) => x.name === e.group);
    if (!g) groups.push((g = { name: e.group, entries: [] }));
    g.entries.push(e);
  }
  groups.reverse();
  const sections = groups
    .map((g) => {
      const cards = [...g.entries]
        .reverse()
        .map(
          (e) => `      <figure>
        <a href="shots/${escapeHtml(e.file)}" target="_blank"><img loading="lazy" src="shots/${escapeHtml(e.file)}" alt="${escapeHtml(e.title)}"></a>
        <figcaption><strong>${escapeHtml(e.title)}</strong><span class="when">${escapeHtml(e.when)}</span>${e.note ? `<p>${escapeHtml(e.note)}</p>` : ''}</figcaption>
      </figure>`,
        )
        .join('\n');
      return `    <section>\n      <h2>${escapeHtml(g.name)} <small>${g.entries.length}</small></h2>\n      <div class="grid">\n${cards}\n      </div>\n    </section>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SFO simulation — progress gallery</title>
<style>
  :root { color-scheme: dark; --bg: #0e1116; --card: #171b22; --line: #262c36; --text: #e6e9ee; --dim: #8b95a5; --accent: #6cb6ff; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  header { padding: 28px 32px 8px; }
  h1 { margin: 0 0 4px; font-size: 22px; font-weight: 650; }
  header p { margin: 0; color: var(--dim); }
  section { padding: 12px 32px 20px; }
  h2 { font-size: 15px; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; color: var(--accent); border-bottom: 1px solid var(--line); padding-bottom: 8px; }
  h2 small { color: var(--dim); font-weight: 400; margin-left: 6px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 18px; }
  figure { margin: 0; background: var(--card); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  figure img { display: block; width: 100%; height: auto; background: #000; }
  figcaption { padding: 10px 14px 12px; }
  figcaption strong { display: block; }
  figcaption p { margin: 4px 0 0; color: var(--dim); font-size: 13.5px; }
  .when { color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; }
  @media (max-width: 520px) { .grid { grid-template-columns: 1fr; } section, header { padding-left: 16px; padding-right: 16px; } }
</style>
</head>
<body>
  <header>
    <h1>SFO simulation — progress gallery</h1>
    <p>${manifest.entries.length} captures, newest group first. Click an image for full resolution. This folder is not committed.</p>
  </header>
${sections}
</body>
</html>
`;
}

const [command, ...rest] = process.argv.slice(2);
const manifest = load();
mkdirSync(shots, { recursive: true });

if (command === 'add') {
  const image = rest[0];
  if (!image || !existsSync(image)) throw new Error(`gallery: image not found: ${image}`);
  const option = (name, fallback = '') => (rest.includes(`--${name}`) ? rest[rest.indexOf(`--${name}`) + 1] : fallback);
  const title = option('title', basename(image));
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  const file = `${stamp}-${slug}${extname(image).toLowerCase()}`;
  copyFileSync(image, join(shots, file));
  manifest.entries.push({
    file,
    title,
    note: option('note'),
    group: option('group', 'Progress'),
    when: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dir, 'index.html'), render(manifest));
  console.log(join(dir, 'shots', file));
} else if (command === 'rebuild') {
  writeFileSync(join(dir, 'index.html'), render(manifest));
  console.log(join(dir, 'index.html'));
} else {
  throw new Error('usage: gallery.mjs add <image> --title "..." [--note "..."] [--group "..."] | rebuild');
}
