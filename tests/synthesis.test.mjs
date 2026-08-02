import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalStringify,
  decodeAiJsonl,
  decodeCompactJsonl,
  encodeAiJsonl,
  encodeCompactJsonl,
  parseProjectionSource,
  synthesizeGraph
} from "../tools/synthesis-core.mjs";
import { atomicWrite, parseArgs } from "../tools/synthesize.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const AGENT_HASH = "a".repeat(64);
const GRAPH_HASH = "b".repeat(64);
const SHARED_LINEAGE = "1".repeat(64);

async function fixture(name) {
  return JSON.parse(await readFile(path.join(ROOT, "tests", "fixtures", name), "utf8"));
}

function synthesisOptions(graph, providers) {
  return {
    graph,
    providers,
    rendererGraphSha256: "9".repeat(64),
    baseGraphSha256: GRAPH_HASH,
    agentIndexSha256: AGENT_HASH
  };
}

function regionalProvider(template, id, family, context) {
  const provider = structuredClone(template);
  provider.provider_id = id;
  provider.derivation_family = family;
  provider.source_snapshot_sha256 = id.at(-1).repeat(64);
  provider.contributions = [structuredClone(template.contributions[0])];
  provider.contributions[0].id = `${id}-node`;
  provider.contributions[0].contexts = [[context, 0.85]];
  provider.contributions[0].relevance = 0;
  provider.contributions[0].lineage_ids = [SHARED_LINEAGE];
  return provider;
}

test("synthesis is byte-deterministic and provider edges never become Primary", async () => {
  const graph = await fixture("aethergraph-v3.synthetic.json");
  const provider = await fixture("projection-source-v1.synthetic.json");
  const first = synthesizeGraph(synthesisOptions(graph, [provider]));
  const second = synthesizeGraph(synthesisOptions(graph, [provider]));

  assert.equal(canonicalStringify(first), canonicalStringify(second));
  assert.equal(encodeAiJsonl(first), encodeAiJsonl(second));
  assert.equal(encodeCompactJsonl(encodeAiJsonl(first)), encodeCompactJsonl(encodeAiJsonl(second)));
  const projected = first.latent.filter((edge) => edge[9] === 16
    && first.reason_vocab[edge[8]]?.basis?.includes("projection-source"));
  assert.equal(projected.length, 1);
  assert.notEqual(projected[0][10], "primary");
  assert.equal(first.reason_vocab[projected[0][8]].evidence, "reported");
});

test("legacy basic UTC offsets are canonicalized at the v4 boundary", async () => {
  const graph = await fixture("aethergraph-v3.synthetic.json");
  graph.observed_at = "2026-08-02T12:08:33-0700";
  const output = synthesizeGraph(synthesisOptions(graph, []));
  assert.equal(output.observed_at, "2026-08-02T19:08:33Z");
  assert.equal(output.synthesis.regions[0].observed_at, "2026-08-02T19:08:33Z");
});

test("ungrounded base topics remain search labels and do not become synthesized subjects", async () => {
  const graph = await fixture("aethergraph-v3.synthetic.json");
  const target = graph.nodes.find((node) => node.id === "synthetic-focus");
  target.label_source = "none";
  target.topics = ["ungrounded-list-vocabulary"];
  target.facets = ["declared-facet"];
  const output = synthesizeGraph(synthesisOptions(graph, []));
  const node = output.nodes.find((item) => item.id === "synthetic-focus");
  const subjects = new Set(node.synthesis.subjects.map(([term]) => term));
  assert.equal(subjects.has("ungrounded-list-vocabulary"), false);
  assert.equal(subjects.has("declared-facet"), true);
  assert.deepEqual(node.topics, ["ungrounded-list-vocabulary"],
    "the source label remains available for local search and inspection");
});

test("malformed, stale, and private-target providers are isolated as degraded regions", async () => {
  const graph = await fixture("aethergraph-v3.synthetic.json");
  const template = await fixture("projection-source-v1.synthetic.json");
  const malformed = { ...structuredClone(template), unexpected: true, provider_id: "malformed-source" };
  const stale = structuredClone(template);
  stale.provider_id = "stale-source";
  stale.base.graph_sha256 = "8".repeat(64);
  const privateTarget = structuredClone(template);
  privateTarget.provider_id = "private-target";
  privateTarget.contributions = [structuredClone(template.contributions[0])];
  privateTarget.contributions[0].node = "synthetic-archive";
  const output = synthesizeGraph(synthesisOptions(graph, [malformed, stale, privateTarget]));

  const external = output.synthesis.regions.filter((region) => region.id !== "base-graph");
  assert.deepEqual(external.map((region) => region.status), ["degraded", "degraded", "degraded"]);
  assert.equal(external.every((region) => region.contributions === 0), true);
  assert.match(external.flatMap((region) => region.omissions).join(" "),
    /invalid-envelope|base-hash-mismatch|privacy-ineligible-node/);
});

test("shared lineage prevents false corroboration without erasing distinct regional framing", async () => {
  const graph = await fixture("aethergraph-v3.synthetic.json");
  const template = await fixture("projection-source-v1.synthetic.json");
  const providers = [
    regionalProvider(template, "region-1", "family-one", "structural"),
    regionalProvider(template, "region-2", "family-two", "continuity-memory"),
    regionalProvider(template, "region-3", "family-three", "indexed-memory")
  ];
  const output = synthesizeGraph(synthesisOptions(graph, providers));
  const node = output.nodes.find((item) => item.id === "synthetic-focus");

  assert.equal(node.synthesis.support.regions, 4);
  assert.equal(node.synthesis.support.independent, 1);
  assert.equal(node.synthesis.support.lineages, 1);
  assert.deepEqual(new Set(node.synthesis.region_attribution.map(([id]) => id)),
    new Set(["base-graph", "region-1", "region-2", "region-3"]));
  assert.equal(node.synthesis.region_attribution.every(([, weight]) => weight > 0), true,
    "query-independent support must remain recruitable when relevance is zero");
  const contexts = new Set(node.synthesis.contexts.map(([term]) => term));
  assert.equal(["structural", "continuity-memory", "indexed-memory"].every((term) => contexts.has(term)), true);
});

test("encoded private phrases are omitted and external evidence cannot self-upgrade", async () => {
  const graph = await fixture("aethergraph-v3.synthetic.json");
  const provider = await fixture("projection-source-v1.synthetic.json");
  provider.contributions[0].subjects.push(["secret-client-name", 1]);
  provider.contributions[0].evidence = "verified-source";
  const output = synthesizeGraph(synthesisOptions(graph, [provider]));
  const node = output.nodes.find((item) => item.id === "synthetic-focus");

  assert.equal(node.synthesis.subjects.some(([term]) => term === "secret-client-name"), false);
  const region = output.synthesis.regions.find((item) => item.id === "synthetic-context");
  assert.equal(region.omissions.includes("semantic-term-omitted"), true);
  assert.equal(region.omissions.includes("external-evidence-downgraded"), true);
  assert.doesNotMatch(canonicalStringify(output.synthesis), /secret-client-name/);
});

test("AI projection excludes non-agent-safe nodes and compact coding round-trips exactly", async () => {
  const graph = await fixture("aethergraph-v3.synthetic.json");
  const provider = await fixture("projection-source-v1.synthetic.json");
  const output = synthesizeGraph(synthesisOptions(graph, [provider]));
  const ai = encodeAiJsonl(output);
  const compact = encodeCompactJsonl(ai);
  const decoded = decodeAiJsonl(ai);

  assert.equal(decoded.nodes.length, 3);
  assert.equal(decoded.nodes.every((node) => node.privacy === "agent-safe"), true);
  assert.deepEqual(decoded.synthesis.regions, output.synthesis.regions);
  assert.deepEqual(decoded.synthesis.residuals, output.synthesis.residuals);
  assert.doesNotMatch(ai, /synthetic-archive|Historical graph sketch/);
  assert.equal(decodeCompactJsonl(compact), ai);
});

test("base-region receipts cannot fingerprint excluded renderer nodes", async () => {
  const graph = await fixture("aethergraph-v3.synthetic.json");
  const changed = structuredClone(graph);
  changed.nodes.find((node) => node.privacy !== "agent-safe").title = "Different excluded title";
  const first = synthesizeGraph({ graph });
  const second = synthesizeGraph({ graph: changed });
  const snapshot = (value) => value.synthesis.regions.find((region) => region.id === "base-graph")
    .source_snapshot_sha256;

  assert.equal(snapshot(first), snapshot(second));
  assert.doesNotMatch(encodeAiJsonl(second), /Different excluded title/);
});

test("core cannot self-assert active recall from an opaque label", async () => {
  const graph = await fixture("aethergraph-v3.synthetic.json");
  const output = synthesizeGraph({ ...synthesisOptions(graph, []), mode: "active", frameRef: "claimed-frame" });
  assert.equal(output.synthesis.mode, "resting");
  assert.match(output.synthesis.frame_ref, /^resting-/);
});

test("provider parser enforces byte bounds before JSON parsing", () => {
  const parsed = parseProjectionSource("x".repeat(128), { limits: { providerBytes: 64 } });
  assert.deepEqual(parsed.codes, ["provider-too-large"]);
  assert.equal(parsed.document, null);
});

test("CLI rejects aliases and atomic writes leave no temporary file", async () => {
  assert.throws(() => parseArgs(["--graph", "same.json", "--out", "same.json"]), /./);
  const directory = await mkdtemp(path.join(os.tmpdir(), "aethergraph-synthesis-"));
  try {
    const destination = path.join(directory, "result.json");
    await atomicWrite(destination, "one\n");
    await atomicWrite(destination, "two\n");
    assert.equal(await readFile(destination, "utf8"), "two\n");
    assert.deepEqual(await readdir(directory), ["result.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("all public synthesis schemas parse and carry draft 2020-12 identifiers", async () => {
  const names = [
    "aethergraph-v3.schema.json",
    "aethergraph-v4.schema.json",
    "aethergraph-projection-source-v1.schema.json",
    "aethergraph-ai-v1.schema.json",
    "aethergraph-ai-compact-v1.schema.json"
  ];
  for (const name of names) {
    const schema = JSON.parse(await readFile(path.join(ROOT, "schemas", name), "utf8"));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.match(schema.$id, /^https:\/\/github\.com\/Apocky\/aethergraph\//);
  }
});

test("checked-in v4 and AI fixtures are exact deterministic encodings", async () => {
  const graph = await fixture("aethergraph-v3.synthetic.json");
  const expectedV4 = await fixture("aethergraph-v4.synthetic.json");
  const actualV4 = synthesizeGraph({ graph, rendererGraphSha256: "9".repeat(64) });
  const ai = await readFile(path.join(ROOT, "tests", "fixtures", "aethergraph-ai-v1.synthetic.jsonl"), "utf8");
  const compact = await readFile(path.join(ROOT, "tests", "fixtures", "aethergraph-ai-compact-v1.synthetic.jsonl"), "utf8");

  assert.equal(canonicalStringify(actualV4), canonicalStringify(expectedV4));
  assert.equal(encodeAiJsonl(actualV4), ai);
  assert.equal(encodeCompactJsonl(ai), compact);
});
