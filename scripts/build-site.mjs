// Builds the live demo for GitHub Pages into _site/ (or the folder given as the first
// argument). It is the normal dashboard in "static demo" mode: the sample data is
// generated in the browser by lib/demo.js, so there is no server, no WHOOP account and no
// real data involved.
//
// Usage: node scripts/build-site.mjs [outDir]
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, '_site'));
const REPO = 'https://github.com/toniilein/whoop-dashboard';
const SITE = 'https://toniilein.github.io/whoop-dashboard/';
const SETUP = `${REPO}/blob/main/docs/setup.md`;

await rm(OUT, { recursive: true, force: true });
await mkdir(path.join(OUT, 'lib'), { recursive: true });
for (const f of ['app.js', 'charts.js', 'styles.css', 'favicon.svg']) {
  await cp(path.join(ROOT, 'public', f), path.join(OUT, f));
}
// the sample data generator and the code it needs; none of it touches Node APIs
for (const f of ['demo.js', 'dashboard.js', 'insights.js']) {
  await cp(path.join(ROOT, 'lib', f), path.join(OUT, 'lib', f));
}
await cp(path.join(ROOT, 'docs', 'social-preview.png'), path.join(OUT, 'social-preview.png'));

let html = await readFile(path.join(ROOT, 'public', 'index.html'), 'utf8');
const swap = (from, to) => {
  if (!html.includes(from)) throw new Error(`public/index.html changed; update build-site.mjs (missing: ${from})`);
  html = html.replace(from, to);
};
const description = 'Live demo with sample data: a local, open-source dashboard for your WHOOP data with research-backed health markers, a year of calendar heatmaps and your own drag-and-drop cockpit.';

swap('<html lang="en">', '<html lang="en" data-mode="static-demo">');
// GitHub Pages serves the site from /whoop-dashboard/, so every path must be relative
html = html.replaceAll('href="/', 'href="./').replaceAll('src="/', 'src="./');
swap('<title>WHOOP Dashboard</title>', [
  '<title>WHOOP Dashboard demo</title>',
  `  <meta name="description" content="${description}">`,
  '  <meta property="og:title" content="WHOOP Dashboard: live demo">',
  `  <meta property="og:description" content="${description}">`,
  `  <meta property="og:image" content="${SITE}social-preview.png">`,
  `  <meta property="og:url" content="${SITE}">`,
  '  <meta name="twitter:card" content="summary_large_image">',
].join('\n'));
swap(
  '<button type="button" class="btn ghost" id="exitDemoBtn" hidden>Exit preview</button>',
  `<button type="button" class="btn ghost" id="exitDemoBtn" hidden>Exit preview</button>\n      <a class="btn primary" href="${REPO}">Get it on GitHub</a>`,
);
swap(
  'You are looking at generated sample data. Connect WHOOP to see your own numbers.',
  `This is a live demo with generated sample data. To see your own WHOOP data, run it on your computer: <a href="${SETUP}">setup guide</a>.`,
);
swap(
  'Data from the WHOOP Developer API. Not affiliated with WHOOP.',
  `Sample data only. Not affiliated with WHOOP. <a href="${REPO}">Source on GitHub</a>, MIT licensed.`,
);
await writeFile(path.join(OUT, 'index.html'), html);
await writeFile(path.join(OUT, '.nojekyll'), '');
console.log(`Built the demo site in ${path.relative(process.cwd(), OUT) || OUT}`);
