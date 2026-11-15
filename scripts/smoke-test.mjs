import assert from 'node:assert/strict';
import fs from 'node:fs';

const requiredFiles = [
  'src/AppPanel.tsx',
  'src/WatchPanel.tsx',
  'src/watchText.ts',
  'src/panelTypes.ts',
  'src/types.ts',
  'src/index.ts',
  'lib/history-service.cjs',
  'lib/http-utils.cjs',
  'lib/signalk-units.cjs',
  'lib/watch-service.cjs',
  'lib/watch/engine.cjs',
  'lib/watch/path-monitor.cjs',
  'lib/watch/gnss.cjs',
  'lib/watch/narrate.cjs',
  'lib/watch/format.cjs',
  'lib/watch/stats.cjs',
  'lib/watch/sources.cjs',
  'lib/watch/rules.cjs',
  'lib/watch/rule-parser.cjs',
  'lib/watch/rule-assist.cjs',
  'index.cjs',
  'README.md',
  'docs/watchkeeper.md',
  'CHANGELOG.md',
  'LICENSE',
  '.github/workflows/plugin-ci.yml'
];

for (const file of requiredFiles) {
  assert.equal(fs.existsSync(file), true, `Missing required file: ${file}`);
}

const pluginSource = fs.readFileSync('index.cjs', 'utf8');
for (const route of ['status', 'series', 'inventory', 'unusual', 'report']) {
  assert.match(pluginSource, new RegExp(`router\\.get\\('/watch/${route}'`), `GET /watch/${route} is registered`);
}
for (const route of ['rules/compile', 'rules/save', 'rules/add', 'rules/remove', 'feedback', 'mute', 'unmute', 'replay']) {
  assert.match(pluginSource, new RegExp(`router\\.post\\('/watch/${route.replace('/', '\\/')}'`), `POST /watch/${route} is registered`);
}
assert.match(pluginSource, /id: 'signalk-watchkeeper'/);

const appPanelSource = fs.readFileSync('src/AppPanel.tsx', 'utf8');
assert.match(appPanelSource, /\/plugins\/signalk-watchkeeper/);

// The registry and app store both read package.json metadata directly, so a
// missing field here is a silent score loss rather than a build failure.
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
assert.equal(pkg.name, 'signalk-watchkeeper');
assert.ok(pkg.keywords.includes('signalk-node-server-plugin'), 'Missing signalk-node-server-plugin keyword');
assert.ok(typeof pkg.repository?.url === 'string', 'package.json needs a repository URL');
assert.ok(typeof pkg.engines?.node === 'string', 'package.json needs engines.node');
assert.equal(pkg.license, 'Apache-2.0', 'package.json license must be the SPDX id Apache-2.0, matching LICENSE');
for (const asset of [pkg.signalk.appIcon, ...(pkg.signalk.screenshots || [])]) {
  const relative = String(asset).replace(/^\.?\//, '');
  assert.equal(fs.existsSync(relative), true, `Declared Signal K asset is missing: ${asset}`);
  assert.ok(
    pkg.files.some((entry) => relative === entry || relative.startsWith(`${entry}/`)),
    `Declared Signal K asset is not published: ${asset}`
  );
}

// The Signal K plugin registry measures the test suite against the published
// tarball, not against this checkout: everything `npm test` reads has to be
// covered by "files", and scripts/run-tests.mjs has to tolerate an App Store
// install, where devDependencies - TypeScript among them - are absent.
for (const entry of ['scripts/run-tests.mjs', 'test', 'src', 'tsconfig.json', 'tsconfig.test.json']) {
  assert.equal(fs.existsSync(entry), true, `Missing test-suite path: ${entry}`);
  assert.ok(
    pkg.files.some((published) => entry === published || entry.startsWith(`${published}/`)),
    `"${entry}" is read by "npm test" but is not in package.json "files"`
  );
}
assert.match(
  fs.readFileSync('scripts/run-tests.mjs', 'utf8'),
  /resolveTscBin/,
  'scripts/run-tests.mjs must degrade to the node:test suites when typescript is not installed'
);

// That check needs a build, so CI runs it again after one.
assert.match(
  fs.readFileSync('.github/workflows/ci.yml', 'utf8'),
  /- run: npm run build\s*\n(?:\s*#.*\n)*\s*- run: npm run lint/,
  'ci.yml must run the smoke test after building the panel'
);

// signalk-server picks the container script tag from package.json's "type":
// with "module" it emits <script type="module" src=".../remoteEntry.js">, so
// remoteEntry.js must be the ESM container, or the admin UI reports "Module
// ... is not available" and the panel never mounts.
if (fs.existsSync('public/remoteEntry.js')) {
  const remoteEntry = fs.readFileSync('public/remoteEntry.js', 'utf8');
  if (pkg.type === 'module') {
    assert.match(
      remoteEntry,
      /export\s*\{[^}]*\bas get\b[^}]*\}/,
      'public/remoteEntry.js must export `get` for an ESM ("type": "module") webapp'
    );
    assert.match(remoteEntry, /\binit\b/, 'public/remoteEntry.js must export `init`');
  } else {
    assert.match(
      remoteEntry,
      new RegExp(`var\\s+${pkg.name.replace(/[-@/]/g, '_')}\\b`),
      'a non-module webapp needs the global `var` container in public/remoteEntry.js'
    );
  }
}

// The plugin-ci caller must keep pointing at the canonical reusable workflow,
// otherwise the registry silently falls back to guessing build/test commands.
const pluginCi = fs.readFileSync('.github/workflows/plugin-ci.yml', 'utf8');
assert.match(pluginCi, /SignalK\/signalk-server\/\.github\/workflows\/plugin-ci\.yml@/);
assert.match(pluginCi, /build-command: npm run build/);
assert.match(pluginCi, /test-command: npm run test/);
// The registry takes 10 points off unless plugin-ci ran on the exact commit a
// release was published from, so it runs on every pushed branch and tag.
// The `push:` block is read on its own (up to the next key at its indent),
// and its lists may be block or flow style, quoted either way.
{
  const lines = pluginCi.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => /^\s*push:\s*(#.*)?$/.test(line));
  assert.ok(start >= 0, 'plugin-ci must run on push');
  const indent = lines[start].search(/\S/);
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !line.trim().startsWith('#') && line.search(/\S/) <= indent) break;
    block.push(line.replace(/\s+#.*$/, ''));
  }
  const allows = (key) => {
    const text = block.join('\n');
    const flow = new RegExp(`^\\s*${key}:\\s*\\[([^\\]]*)\\]`, 'm').exec(text);
    const items = flow
      ? flow[1].split(',')
      : (() => {
          const at = block.findIndex((line) => new RegExp(`^\\s*${key}:\\s*$`).test(line));
          if (at < 0) return [];
          const own = block[at].search(/\S/);
          const found = [];
          for (const line of block.slice(at + 1)) {
            if (!line.trim()) continue;
            if (line.search(/\S/) <= own) break;
            const item = /^\s*-\s*(.*)$/.exec(line);
            if (item) found.push(item[1]);
          }
          return found;
        })();
    return items.map((item) => item.trim().replace(/^(['"])(.*)\1$/, '$2')).includes('**');
  };
  assert.ok(allows('branches'), 'plugin-ci must run on every pushed branch');
  assert.ok(allows('tags'), 'plugin-ci must run on every pushed tag');
}

console.log('smoke-ok');
