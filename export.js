// Usage: npm run export  (log in through the dashboard first)
//        npm run export -- --rebuild exports/<folder>  (regenerate CSVs from saved raw JSON)
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWhoopClient, AuthRequiredError } from './lib/whoop.js';
import { exportAll, rebuildFromRaw } from './lib/export.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const rebuildIdx = process.argv.indexOf('--rebuild');
if (rebuildIdx > -1) {
  const dir = path.resolve(process.argv[rebuildIdx + 1] || '');
  const summary = await rebuildFromRaw(dir);
  console.log(`Rebuilt CSVs and summary in ${dir}`);
  console.log(JSON.stringify(summary.counts));
  process.exit(0);
}
if (existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));

const client = createWhoopClient({
  clientId: process.env.WHOOP_CLIENT_ID,
  clientSecret: process.env.WHOOP_CLIENT_SECRET,
  redirectUri: process.env.WHOOP_REDIRECT_URI,
  dataDir: path.join(ROOT, 'data'),
});

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
const outDir = path.join(ROOT, 'exports', `whoop-export-${stamp}`);

const started = Date.now();
try {
  const { summary } = await exportAll(client, outDir);
  console.log(`\nDone in ${Math.round((Date.now() - started) / 1000)}s. Files are in ${outDir}`);
  console.log(JSON.stringify(summary.counts));
} catch (err) {
  if (err instanceof AuthRequiredError) {
    console.error('Not logged in to WHOOP. Open http://localhost:3000, click Connect WHOOP, then run this again.');
  } else {
    console.error('Export failed:', err.message);
  }
  process.exit(1);
}
