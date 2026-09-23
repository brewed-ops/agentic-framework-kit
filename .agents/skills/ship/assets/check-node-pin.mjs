/**
 * Fails the build if .nvmrc pins a Node that any installed package refuses.
 *
 * Cloudflare Pages installs exactly the .nvmrc version. The first Pages build
 * (2026-09-23) died on "Node.js v22.11.0 is not supported by Astro!" - Astro 7
 * needs >=22.12 and undici >=22.19 - while every local build passed, because
 * this machine runs Node 24 and never used the pin. Runs as `prebuild`, so the
 * mismatch now fails here first, not in CI.
 *
 * Reads every package's `engines.node` from package-lock.json (the exact tree
 * `npm ci` installs) and tests the pinned version against each range.
 */
import { readFileSync } from 'node:fs';
import semver from 'semver';

const root = new URL('../', import.meta.url);
const pin = readFileSync(new URL('.nvmrc', root), 'utf8').trim().replace(/^v/, '');
if (!semver.valid(pin)) {
  console.error(`.nvmrc must be an exact version (Cloudflare installs it as written), got "${pin}"`);
  process.exit(1);
}
const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8'));
const refused = Object.entries(lock.packages ?? {})
  .filter(([, p]) => !p.optional && typeof p.engines?.node === 'string')
  .filter(([, p]) => !semver.satisfies(pin, p.engines.node))
  .map(([path, p]) => `  ${path.replace(/^.*node_modules\//, '') || '(root)'} needs node ${p.engines.node}`);

if (refused.length) {
  console.error(`.nvmrc pins Node ${pin}, which ${refused.length} package(s) refuse:\n${refused.join('\n')}`);
  process.exit(1);
}
console.log(`.nvmrc Node ${pin} satisfies every engines.node in the lockfile.`);
