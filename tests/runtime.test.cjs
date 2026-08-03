const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

global.window = { crypto: crypto.webcrypto };
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'obsidian') return {
    Plugin: class {}, ItemView: class {}, Notice: class {}, PluginSettingTab: class {},
    Setting: class {}, Menu: class {}, Modal: class {}, TFile: class {},
  };
  return originalLoad.apply(this, arguments);
};
const runtimePath = path.join(__dirname, '..', 'src', 'main.js');
const runtimeModule = new Module(path.join(__dirname, '..', 'main.cjs'), module);
runtimeModule.filename = path.join(__dirname, '..', 'main.cjs');
runtimeModule.paths = Module._nodeModulePaths(path.dirname(runtimeModule.filename));
runtimeModule._compile(fs.readFileSync(runtimePath, 'utf8'), runtimeModule.filename);
const Plugin = runtimeModule.exports;
const { buildBaselinePayload, validatePayload } = Plugin.__payload;

function note(notePath, size, mtime) {
  return { path: notePath, basename: path.basename(notePath, '.md'),
    parent: { path: path.posix.dirname(notePath) }, stat: { size, mtime } };
}

test('fresh-vault baseline uses only authored links', () => {
  const files = [note('Garden/Irrigation.md', 800, 3), note('Garden/Soil Sensor.md', 600, 2),
    note('Garden/Pollinators.md', 400, 1)];
  const caches = new Map([
    [files[0], { frontmatter: { title: 'Irrigation Demand', tags: ['water'] },
      links: [{ link: 'Soil Sensor' }, { link: 'Soil Sensor' }] }],
    [files[1], { headings: [{ level: 1, heading: 'Calibrating Soil Sensors' }],
      tags: [{ tag: '#water' }], links: [] }],
    [files[2], { frontmatter: { tags: ['water', 'habitat'] }, links: [] }]
  ]);
  const stems = new Map(files.map((file) => [file.basename, file]));
  const payload = buildBaselinePayload({
    vault: { getMarkdownFiles: () => files },
    metadataCache: { getFileCache: (file) => caches.get(file),
      getFirstLinkpathDest: (link) => stems.get(link) || null }
  });
  assert.equal(validatePayload(payload), payload);
  assert.equal(payload.nodes.length, 3);
  assert.equal(payload.explicit.length, 1);
  assert.equal(payload.latent.length, 0);
  assert.equal(payload.nodes[1].display_title, 'Calibrating Soil Sensors');
  assert.ok(payload.nodes.every((node) => node.privacy === 'private-local'));
  assert.ok(!payload.explicit.some((edge) => edge.includes(2)));
});

test('payload validator rejects invalid endpoints and unbounded strings', () => {
  const base = { schema: 'aethergraph.v3', nodes: [{ id: 'a', path: 'a.md', title: 'A' }],
    explicit: [], latent: [], ghosts: [], severed: [], facet_vocab: [], reason_vocab: [],
    presentation_vocab: [], edge_fields: [] };
  assert.equal(validatePayload(base), base);
  assert.throws(() => validatePayload({ ...base, explicit: [[0, 2, 1, -1, 0, 0, -1]] }), /invalid endpoints/);
  assert.throws(() => validatePayload({ ...base, nodes: [{ ...base.nodes[0], title: 'x'.repeat(5000) }] }),
    /bounded string/);
});

test('public plugin contains no client telemetry or persistent diagnostic sink', () => {
  const source = fs.readFileSync(runtimePath, 'utf8');
  assert.doesNotMatch(source, /class\s+Telemetry|aethergraph\.telemetry|registerInterval\s*\(/);
  assert.doesNotMatch(source, /telemetryFile\s*=|writeReport\s*\(|\.aethergraph\/diagnostics/);
});

test('Obsidian command ids and unload behavior satisfy review boundaries', () => {
  const source = fs.readFileSync(runtimePath, 'utf8');
  const commandIds = [...source.matchAll(/addCommand\s*\(\s*\{[\s\S]*?\bid:\s*['"]([^'"]+)['"]/g)]
    .map((match) => match[1]);
  assert.equal(commandIds.length, 3);
  assert.ok(commandIds.every((id) => !id.includes('aethergraph')));
  const commandNames = [...source.matchAll(/addCommand\s*\(\s*\{[\s\S]*?\bname:\s*['"]([^'"]+)['"]/g)]
    .map((match) => match[1]);
  assert.ok(commandNames.every((name) => !/aethergraph/i.test(name)));
  assert.doesNotMatch(source, /detachLeavesOfType\s*\(/);
});

test('hover details use the resolved hovered node', () => {
  const source = fs.readFileSync(runtimePath, 'utf8');
  const start = source.indexOf('  showTip() {');
  const end = source.indexOf('  neighbourhood(n) {', start);
  const body = start >= 0 && end > start ? source.slice(start, end) : '';
  assert.match(body, /const best = this\.hover/);
  assert.match(body, /this\.titleFor\(best\)/);
  assert.doesNotMatch(body, /this\.titleFor\(n\)/);
});

test('reset updates live views without rebuilding render loops', () => {
  const source = fs.readFileSync(runtimePath, 'utf8');
  const start = source.indexOf("id: 'reset-view'");
  const end = source.indexOf("id: 'check-health'", start);
  const body = start >= 0 && end > start ? source.slice(start, end) : '';
  assert.match(body, /view\.resetToDefaults\(\)/);
  assert.doesNotMatch(body, /view\.onOpen\(|view\.build\(|contentEl\.empty\(/);
});
