// Export a new dataset version, or read an existing version back and compare every mesh and steel member.
// node tools/models/export-international-roof.mjs [--verify] /path/to/version.glb
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const args = process.argv.slice(2);
const verify = args[0] === '--verify';
if (verify) args.shift();
if (args.length !== 1) throw new Error('Expected [--verify] <version.glb>');
const path = resolve(args[0]);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const server = await createServer({ root, configFile: false, cacheDir: 'node_modules/.vite-roof-dataset', logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
let browser;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  const page = await browser.newPage();
  await page.route('**/__roof-export', route => route.fulfill({ contentType: 'text/html', body: '<title>Roof dataset export</title>' }));
  await page.goto('http://127.0.0.1:' + port + '/__roof-export');
  const existing = verify ? await readFile(path) : null;
  const { data, ...model } = await page.evaluate(async bytes => {
    const { roofDataset } = await import('/tools/models/roof-dataset.mjs');
    return roofDataset(bytes);
  }, existing?.toString('base64') ?? null);
  const bytes = existing ?? Buffer.from(data, 'base64');
  if (bytes.length > 512 * 1024) throw new Error('GLB exceeds the repository binary size limit');
  if (!existing) await writeFile(path, bytes, { flag: 'wx' });
  console.log(JSON.stringify({ ...model, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
