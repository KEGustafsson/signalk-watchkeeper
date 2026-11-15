import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { parse as parseYaml } from 'yaml';

const requiredFiles = [
  'src/AppPanel.tsx',
  'src/WatchPanel.tsx',
  'src/watchText.ts',
  'src/panelTypes.ts',
  'src/types.ts',
  'src/index.ts',
  'lib/history-service.cjs',
  'lib/http-utils.cjs',
  'lib/settings.cjs',
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

// The admin page renders schema() as stored JSON: the switch first, then the
// sections, and nothing JSON would drop.
{
  const plugin = createRequire(import.meta.url)('../index.cjs')({});
  const schema = plugin.schema();
  assert.deepEqual(JSON.parse(JSON.stringify(schema)), schema, 'schema() must be plain JSON');
  assert.deepEqual(JSON.parse(JSON.stringify(plugin.uiSchema())), plugin.uiSchema(), 'uiSchema() must be plain JSON');
  assert.deepEqual(Object.keys(schema.properties), ['watchEnabled', 'alerts', 'watching', 'ruleAssist', 'replay', 'advanced']);
}

const appPanelSource = fs.readFileSync('src/AppPanel.tsx', 'utf8');
assert.match(appPanelSource, /\/plugins\/signalk-watchkeeper/);

// The registry and app store both read package.json metadata directly, so a
// missing field here is a silent score loss rather than a build failure.
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
assert.equal(pkg.name, 'signalk-watchkeeper');
assert.ok(pkg.keywords.includes('signalk-node-server-plugin'), 'Missing signalk-node-server-plugin keyword');
assert.ok(typeof pkg.repository?.url === 'string', 'package.json needs a repository URL');
assert.ok(typeof pkg.engines?.node === 'string', 'package.json needs engines.node');
assert.equal(pkg.license, 'EUPL-1.2', 'package.json license must be the SPDX id EUPL-1.2, matching LICENSE');
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
// release was published from, so it runs on every pushed branch and tag:
// on.push lists '**' for both, with no exclusions and no path filter.
{
  const workflow = parseYaml(pluginCi);
  const push = workflow && workflow.on && workflow.on.push;
  assert.ok(push && typeof push === 'object', 'plugin-ci must run on push');
  const runsOnEvery = (key) =>
    Array.isArray(push[key]) && push[key].includes('**') && !push[key].some((item) => String(item).startsWith('!'));
  assert.ok(runsOnEvery('branches'), 'plugin-ci must run on every pushed branch');
  assert.ok(runsOnEvery('tags'), 'plugin-ci must run on every pushed tag');
  assert.ok(!('paths' in push) && !('paths-ignore' in push), 'plugin-ci must not filter pushes by path');
}

console.log('smoke-ok');
