// Run by CI on the published site folder: node tools/stamp-version.mjs _site <version>
// Adds ?v=<version> to every local module, script and stylesheet URL, so a tablet that reloads after an
// update never mixes cached old files with new ones (GitHub Pages lets browsers cache files for 10 minutes),
// and writes version.txt, which the tablet app checks to notice that a new version is out.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const [dir, version] = process.argv.slice(2);
if (!dir || !/^[\w.-]+$/.test(version || '')) {
  console.error('usage: node tools/stamp-version.mjs <site folder> <version>');
  process.exit(1);
}
const v = `?v=${version}`;

function* files(d) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) yield* files(p); else yield p;
  }
}

let changed = 0;
for (const p of files(dir)) {
  const ext = extname(p);
  if (ext !== '.js' && ext !== '.html') continue;
  const before = readFileSync(p, 'utf8');
  let after = before;
  if (ext === '.js') {
    // static imports: from './x.js'   dynamic imports: import('./x.js')
    after = after
      .replace(/(\bfrom\s*)(['"])(\.{1,2}\/[^'"?]+\.js)\2/g, `$1$2$3${v}$2`)
      .replace(/(\bimport\(\s*)(['"])(\.{1,2}\/[^'"?]+\.js)\2/g, `$1$2$3${v}$2`);
  } else {
    // <script src="…/x.js"> and <link href="…/styles.css"> pointing at this site
    after = after.replace(/((?:src|href)=")((?!https?:|data:|\/\/)[^"?#]+\.(?:js|css))"/g, `$1$2${v}"`);
  }
  if (after !== before) { writeFileSync(p, after); changed++; }
}
writeFileSync(join(dir, 'version.txt'), `${version}\n`);
console.log(`stamped ${changed} files with ${version}`);
