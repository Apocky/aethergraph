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
const runtimeModule = new Module(path.join(__dirname, '..', 'main.synthesis.cjs'), module);
runtimeModule.filename = path.join(__dirname, '..', 'main.synthesis.cjs');
runtimeModule.paths = Module._nodeModulePaths(path.dirname(runtimeModule.filename));
runtimeModule._compile(fs.readFileSync(runtimePath, 'utf8'), runtimeModule.filename);
const Plugin = runtimeModule.exports;
const { validatePayload } = Plugin.__payload;
const { modulateRecall, modulateRegions, regionSummary } = Plugin.__synthesis;
const { nodeSubjects, nodeContexts, buildLabelStats, chooseClusterLabel, normalizedLabel,
  semanticPoolIdentity, selectRenderableEdges, safeNoteTarget, titleCounts,
  disambiguatedTitle } = Plugin.__relations;

const EDGE_FIELDS = ['a', 'b', 'weight', 'facet', 'reach', 'span', 'facet_gap',
  'relevance', 'reason', 'signals', 'presentation'];
const H64 = 'a'.repeat(64);

function node(id, title, subjects, contexts) {
  return {
    id, title, display_title: title, description: `${title} description`,
    display_title_source: 'source-title', label_source: 'document',
    topics: [], display_tags: [], path: `Synthetic/${id}.md`, type: 'concept', project: 'Synthetic',
    area: 'Tests', label_area: 'Tests', role: 'example', facets: [], tags: [], aliases: [],
    evidence: 'verified-source', privacy: 'agent-safe', withhold_from_telemetry: false,
    authority: 'projection', source_path: null, source_sha256: null, source_commit: null,
    source_tree_dirty: null, hand_authored: true, standing: 0.5,
    standing_parts: { provenance: 0.5, corroboration: 1, load: 1, contested: false },
    corroboration: 1, load: 1, contested: false, authority_rank: 2, hybridity: 0,
    family: 'surface', view_scope: 'core', mass: 1024, age: 0.1,
    synthesis: {
      subjects: subjects || [], contexts: contexts || [],
      importance: { score: 0.5, parts: { standing: 0.5, load: 0.5, authority: 0.5, support: 0.5 } },
      utility: { score: 0.4, frame_ref: 'resting-frame',
        parts: { direct: 0.4, neighbour: 0.2, goal: 0 } },
      activation: { score: 0.3, direct: 0.3, propagated: 0, inhibited: 0 },
      confidence: { score: 0.6,
        parts: { evidence: 0.8, independence: 0.4, freshness: 0.7, coverage: 0.5, residual: 0 } },
      support: { regions: 1, independent: 1, lineages: 1 },
      region_attribution: [['base-graph', 1]], residuals: [],
    },
  };
}

function payload() {
  const nodes = [
    node('focus', 'Holistic memory synthesis', [['memory-synthesis', 1]], [['active-recall', 0.9]]),
    node('primary-neighbour', 'Build pipeline'),
    node('context-neighbour', 'Governed workspace'),
    node('archive-neighbour', 'Historical appendix'),
  ];
  return {
    schema: 'aethergraph.v4', observed_at: '2026-08-02T12:00:00.000Z',
    counts: { nodes: 4, explicit: 1, latent: 2, ghosts: 0, severed: 0 }, legend: {}, nodes,
    edge_fields: EDGE_FIELDS.slice(), facet_vocab: ['memory'], reason_vocab: ['synthetic relation'],
    presentation_vocab: ['primary', 'context', 'archive'],
    explicit: [[0, 1, 0.9, 0, 0.1, 0.1, 0, 0.9, 0, 1, 'primary']],
    latent: [[0, 2, 0.9, 0, 0.1, 0.1, 0, 0.9, 0, 1, 'context'],
      [0, 3, 0.9, 0, 0.1, 0.1, 0, 0.9, 0, 1, 'archive']],
    ghosts: [], severed: [],
    synthesis: {
      schema: 'aethergraph.synthesis.v1', frame_ref: 'resting-frame', mode: 'resting', authority: 'none',
      base: { agent_index_sha256: null, graph_sha256: H64 }, algorithm: 'holistic-modulator-v1',
      regions: [{ id: 'base-graph', status: 'active', activation: 0.8, inhibition: 0,
        gain: 0.8, confidence: 0.8, contributions: 4, omissions: [],
        derivation_family: 'graph-structure', observed_at: '2026-08-02T12:00:00Z',
        source_snapshot_sha256: H64 }],
      budget: { node_limit: 4, edge_limit: 3, token_estimate_limit: 1000,
        selected_nodes: 4, selected_edges: 3 },
      working_set: nodes.map(item => item.id), residuals: [],
    },
  };
}

test('v4 validation accepts the exact synthesis and canonical edge contract', () => {
  const value = payload();
  assert.equal(validatePayload(value), value);
  assert.deepEqual(nodeSubjects(value.nodes[0]), ['memory-synthesis']);
  assert.deepEqual(nodeContexts(value.nodes[0]), ['active-recall']);
  assert.equal(regionSummary(value.synthesis).label, '1 active · 0 degraded · 0 inactive');
});

test('v4 validation preserves bounded legacy graph semantics', () => {
  const value = payload();
  value.nodes[0].source_commit = 'unavailable-not-a-git-repository';
  value.reason_vocab = [{ label: 'declared relationship',
    basis: ['declared-link', 'complete transport-or-limit notice'],
    evidence: 'verified-source' }];
  value.ghosts = [{ name: 'Structural ghost', docs: 34, anchors: [{ n: 0, w: 34 }] }];
  value.counts.ghosts = 1;
  assert.equal(validatePayload(value), value);
});

test('v4 validation fails closed on identity, edge, vocabulary and synthesis defects', () => {
  const duplicate = payload(); duplicate.nodes[1].id = duplicate.nodes[0].id;
  assert.throws(() => validatePayload(duplicate), /unique/);

  const shortEdge = payload(); shortEdge.explicit[0] = shortEdge.explicit[0].slice(0, 10);
  assert.throws(() => validatePayload(shortEdge), /malformed/);

  const badFacet = payload(); badFacet.explicit[0][3] = 7;
  assert.throws(() => validatePayload(badFacet), /facet/);

  const badPresentation = payload(); badPresentation.latent[0][10] = 'primary-ish';
  assert.throws(() => validatePayload(badPresentation), /presentation/);

  const unknownWorkingNode = payload(); unknownWorkingNode.synthesis.working_set[0] = 'missing-node';
  assert.throws(() => validatePayload(unknownWorkingNode), /unknown node id/);

  const badScore = payload(); badScore.nodes[0].synthesis.confidence.score = 1.01;
  assert.throws(() => validatePayload(badScore), /confidence.score/);

  const unknownRegion = payload();
  unknownRegion.nodes[0].synthesis.region_attribution[0][0] = 'invented-region';
  assert.throws(() => validatePayload(unknownRegion), /unknown region id/);

  const badRegionHash = payload(); badRegionHash.synthesis.regions[0].source_snapshot_sha256 = 'abc';
  assert.throws(() => validatePayload(badRegionHash), /source_snapshot_sha256/);

  const badRegionFamily = payload(); badRegionFamily.synthesis.regions[0].derivation_family = 'raw prose';
  assert.throws(() => validatePayload(badRegionFamily), /derivation_family/);

  const badRegionTime = payload(); badRegionTime.synthesis.regions[0].observed_at = 'yesterday';
  assert.throws(() => validatePayload(badRegionTime), /observed_at/);

  const rawResidual = payload(); rawResidual.synthesis.residuals = [{ code: 'contradiction',
    severity: 'high', nodes: ['focus'], evidence: 'residual' }];
  assert.throws(() => validatePayload(rawResidual), /severity/);
});

test('task recall recruits typed one-hop neighbours then applies deterministic inhibition', () => {
  const value = payload();
  const first = modulateRecall(value, 'memory synthesis', { limit: 3 });
  const second = modulateRecall(value, 'memory synthesis', { limit: 3 });
  assert.deepEqual(first, second);
  assert.equal(first.active, true);
  assert.equal(first.tokenCount, 2);
  assert.deepEqual(first.workingSet, ['focus', 'primary-neighbour', 'context-neighbour']);
  assert.ok(first.scores[1].activation > first.scores[2].activation);
  assert.ok(first.scores[2].rawActivation > first.scores[3].rawActivation);
  assert.equal(first.scores[1].direct, 0, 'neighbour is recruited without substring fit');
  assert.equal(first.scores[3].selected, false);
  assert.equal(first.scores[3].inhibited, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(first, 'query'), false);
  assert.equal(JSON.stringify(first).includes('memory synthesis'), false);
});

test('empty recall is inactive and does not invent a working set', () => {
  assert.deepEqual(modulateRecall(payload(), '  ', { limit: 2 }),
    { active: false, tokenCount: 0, budget: 0, workingSet: [], scores: [] });
});

test('active recall adapts below a larger offline ingest budget', () => {
  const value = payload();
  value.nodes = Array.from({ length: 100 }, (_, index) =>
    node(`memory-${index}`, `Memory ${index}`, [['memory', 1]], []));
  value.explicit = [];
  value.latent = [];
  value.synthesis.budget.node_limit = 128;
  const recall = modulateRecall(value, 'memory');
  assert.equal(recall.budget, 40);
  assert.equal(recall.workingSet.length, 40);
  assert.equal(recall.scores.filter(item => item.inhibited === 1).length, 60);
});

test('task recall recruits only explicitly attributed regions without retaining query text', () => {
  const value = payload();
  value.synthesis.regions.push(
    { id: 'context-bank', status: 'degraded', activation: 0.7, inhibition: 0.2,
      gain: 0.7, confidence: 0.6, contributions: 2, omissions: ['partial-coverage'],
      derivation_family: 'semantic-index', observed_at: '2026-08-02T11:00:00Z',
      source_snapshot_sha256: 'b'.repeat(64) },
    { id: 'inactive-bank', status: 'inactive', activation: 0, inhibition: 1,
      gain: 0, confidence: 0, contributions: 0, omissions: ['unavailable'],
      derivation_family: 'episodic-ledger', observed_at: '2026-08-02T10:00:00Z',
      source_snapshot_sha256: 'c'.repeat(64) },
  );
  value.nodes[0].synthesis.region_attribution = [['base-graph', 0.8], ['context-bank', 0.6]];
  value.nodes[0].synthesis.support.regions = 2;
  value.nodes[1].synthesis.region_attribution = [['context-bank', 1]];
  value.nodes[2].synthesis.region_attribution = [['inactive-bank', 1]];
  validatePayload(value);

  const recall = modulateRecall(value, 'memory synthesis', { limit: 3 });
  const regions = modulateRegions(value, recall);
  assert.equal(regions.active, true);
  assert.equal(regions.total, 3);
  assert.equal(regions.recruited, 2);
  assert.equal(regions.regions.find(region => region.id === 'inactive-bank').recruitment, 0);
  assert.ok(regions.regions.find(region => region.id === 'base-graph').recruitment > 0);
  assert.ok(regions.regions.find(region => region.id === 'context-bank').recruitment > 0);
  const contextRegion = regions.regions.find(region => region.id === 'context-bank');
  assert.equal(contextRegion.derivationFamily, 'semantic-index');
  assert.equal(contextRegion.recruitment,
    Math.min(1, contextRegion.excitation * contextRegion.gain));
  assert.equal(Object.prototype.hasOwnProperty.call(regions, 'query'), false);
  assert.equal(JSON.stringify(regions).includes('memory synthesis'), false);
  assert.deepEqual(modulateRegions(value, recall), regions);
});

test('cluster labels reject corpus-wide structural wording and never repeat a normalized term', () => {
  const nodes = Array.from({ length: 30 }, (_, index) =>
    node(`n-${index}`, `Document ${index}`, [['03-synthetic-reference-collection', 1]], []));
  nodes[0].synthesis.subjects.push(['memory-modulation', 0.9]);
  nodes[1].synthesis.subjects.push(['memory-modulation', 0.8]);
  const stats = buildLabelStats(nodes);
  const cluster = { n: 2,
    subjects: new Map([['03-synthetic-reference-collection', 2], ['memory-modulation', 2]]),
    topics: new Map(), tags: new Map(), facets: new Map(),
    contexts: new Map([['03-synthetic-reference-collection', 2]]) };
  const used = new Map();
  const first = chooseClusterLabel(cluster, stats, used);
  assert.equal(first.label, 'Memory modulation');
  assert.equal(normalizedLabel(first.label), 'memory modulation');
  assert.equal(chooseClusterLabel(cluster, stats, used), null,
    'one normalized semantic term may speak only once per frame');
});

test('screen overlap alone cannot merge semantically unrelated notes', () => {
  const alikeA = node('alike-a', 'First memory note', [['memory-modulation', 1]], []);
  const alikeB = node('alike-b', 'Second memory note', [['memory-modulation', 0.8]], []);
  const different = node('different', 'Rendering note', [['graph-rendering', 1]], []);
  const unlabelled = node('unlabelled', 'Plain note');
  const stats = buildLabelStats([alikeA, alikeB, different, unlabelled,
    ...Array.from({ length: 20 }, (_, index) => node(`filler-${index}`, `Filler ${index}`))]);
  const key = (value, unique, depth = 4) => semanticPoolIdentity(value, stats, 7, depth, unique).key;
  assert.equal(key(alikeA, 0), key(alikeB, 1), 'shared specific semantics may pool');
  assert.notEqual(key(alikeA, 0), key(different, 2), 'different subjects stay separate');
  assert.notEqual(key(unlabelled, 3), key(unlabelled, 4), 'unlabelled nodes stay singletons');
  assert.notEqual(key(alikeA, 0), key(alikeB, 1, 5), 'different depth bands stay separate');
});

test('navigation hubs retain all typed relations but visualize a deterministic bounded sample', () => {
  const nodes = Array.from({ length: 1202 }, (_, index) => ({ d: node(`hub-${index}`, `Hub ${index}`) }));
  const context = Array.from({ length: 1200 }, (_, index) =>
    [0, index + 1, 1, -1, 0, 0, -1, 0.35, 0, 1, 'context']);
  const primary = [0, 1201, 1, -1, 0, 0, -1, 0.9, 1, 1, 'primary'];
  const reasons = ['MOC or structural navigation', 'grounded semantic relation'];
  const first = selectRenderableEdges([...context, primary], [], nodes, reasons,
    ['primary', 'context', 'archive']);
  const second = selectRenderableEdges([...context, primary], [], nodes, reasons,
    ['primary', 'context', 'archive']);
  assert.deepEqual(first, second);
  assert.equal(first.explicit.length, 25);
  assert.equal(first.explicit.filter(edge => edge[10] === 'context').length, 24);
  assert.equal(first.explicit.some(edge => edge === primary), true, 'Primary relations are never capped');
  assert.equal(first.suppressed, 1176);
  assert.equal(context.length + 1, 1201, 'the typed source remains complete');
});

test('Context and Archive navigation budgets are independent', () => {
  const nodes = Array.from({ length: 32 }, (_, index) => ({ d: node(`mixed-${index}`, `Mixed ${index}`) }));
  const context = Array.from({ length: 10 }, (_, index) =>
    [0, index + 1, 1, -1, 0, 0, -1, 0.7, 0, 1, 'context']);
  const archive = Array.from({ length: 20 }, (_, index) =>
    [0, index + 11, 1, -1, 0, 0, -1, 0.4, 0, 1, 'archive']);
  const result = selectRenderableEdges([...context, ...archive], [], nodes,
    ['MOC or structural navigation'], ['primary', 'context', 'archive']);
  assert.equal(result.explicit.filter(edge => edge[10] === 'context').length, 10);
  assert.equal(result.explicit.filter(edge => edge[10] === 'archive').length, 12);
  assert.equal(result.suppressed, 8);
});

test('titles disambiguate duplicate display names and note targets remain inside the vault', () => {
  const a = node('a', 'Repeated title'); a.path = 'One/Alpha.md';
  const b = node('b', 'Repeated title'); b.path = 'Two/Beta.md';
  const counts = titleCounts([a, b]);
  assert.equal(disambiguatedTitle(a, counts), 'Repeated title — Alpha');
  assert.equal(disambiguatedTitle(b, counts), 'Repeated title — Beta');
  const nestedA = node('nested-a', 'Overview'); nestedA.path = 'A/Index/Overview.md';
  const nestedB = node('nested-b', 'Overview'); nestedB.path = 'B/Index/Overview.md';
  const nestedCounts = titleCounts([nestedA, nestedB]);
  assert.equal(disambiguatedTitle(nestedA, nestedCounts), 'Overview — A/Index/Overview');
  assert.equal(disambiguatedTitle(nestedB, nestedCounts), 'Overview — B/Index/Overview');
  assert.deepEqual(safeNoteTarget('Folder/Note.md#^stable-block'),
    { path: 'Folder/Note.md', subpath: '#^stable-block' });
  assert.equal(safeNoteTarget('../Private.md'), null);
  assert.equal(safeNoteTarget('C:/Private.md'), null);
  assert.equal(safeNoteTarget('Folder/Not markdown.txt'), null);
});
