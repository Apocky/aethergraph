import { createHash } from "node:crypto";

export const PROVIDER_SCHEMA = "aethergraph.projection-source.v1";
export const SYNTHESIS_SCHEMA = "aethergraph.synthesis.v1";
export const AI_SCHEMA = "aethergraph.ai.v1";
export const COMPACT_AI_SCHEMA = "aethergraph.ai.compact.v1";

export const DEFAULT_LIMITS = Object.freeze({
  providerBytes: 1024 * 1024,
  providers: 32,
  contributionsPerProvider: 4096,
  termsPerContribution: 64,
  lineagePerContribution: 64,
  residualNodes: 64,
  nodeLimit: 128,
  edgeLimit: 512,
  tokenEstimateLimit: 8192,
  providerEdgeLimit: 2048,
  providerDegreeLimit: 8
});

const PROVIDER_FIELDS = Object.freeze([
  "schema", "provider_id", "observed_at", "status", "authority",
  "derivation_family", "base", "source_snapshot_sha256", "omissions",
  "contributions"
]);
const NODE_CONTRIBUTION_FIELDS = Object.freeze([
  "kind", "id", "node", "subjects", "contexts", "relevance", "importance",
  "utility", "confidence", "evidence", "lineage_ids", "as_of"
]);
const EDGE_CONTRIBUTION_FIELDS = Object.freeze([
  "kind", "id", "a", "b", "relation", "score", "confidence", "evidence",
  "lineage_ids", "as_of", "status"
]);
const RESIDUAL_CONTRIBUTION_FIELDS = Object.freeze([
  "kind", "id", "nodes", "code", "severity", "evidence", "lineage_ids", "as_of"
]);

const EVIDENCE = new Set([
  "verified-runtime", "verified-source", "inferred", "reported", "proposed",
  "unknown", "refuted", "residual"
]);
const EVIDENCE_WEIGHT = Object.freeze({
  "verified-runtime": 1,
  "verified-source": 0.9,
  inferred: 0.65,
  reported: 0.45,
  proposed: 0.25,
  unknown: 0.15,
  refuted: 0,
  residual: 0.15
});
const PROVIDER_STATUS = new Set(["active", "degraded", "inactive"]);
const AUTHORITY = new Set(["read_only", "none"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const HASH = /^[a-f0-9]{64}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const FIXED_TERMS = new Set([
  "architecture", "causal", "concept", "context", "contradiction", "decision",
  "continuity-memory", "dependency", "evidence", "explicit-degree", "goal",
  "graph-structure", "historical", "implementation", "index-coverage",
  "indexed-memory", "kind-ckpt", "kind-compact", "kind-decision", "kind-done",
  "kind-escalation", "kind-handoff", "kind-ingest", "kind-note", "kind-other",
  "kind-owe", "kind-redaction", "kind-refutation", "kind-repair", "kind-verdict",
  "method", "privacy-agent-safe", "privacy-private-local", "provenance",
  "provenance-agent", "provenance-ingest", "provenance-runtime",
  "provenance-source", "provenance-user", "provenance-verification",
  "record-coverage", "reference", "relevance", "risk", "semantic",
  "source-append", "source-initial", "source-other", "source-rescan",
  "source-unchanged", "structural", "system", "temporal", "test", "utility"
]);
const FIXED_RELATIONS = new Set([
  "contextualizes", "contradicts", "depends-on", "derived-from", "duplicates",
  "extends", "implements", "precedes", "references", "related-to", "supports", "tests"
]);
const FIXED_RESIDUALS = new Set([
  "contradiction", "coverage-gap", "identity-ambiguity", "lineage-overlap",
  "low-confidence", "missing-source", "provider-residual", "staleness"
]);
const PUBLIC_OMISSIONS = new Set([
  "base-hash-mismatch", "base-hash-unavailable", "duplicate-provider-id",
  "external-evidence-downgraded", "invalid-contribution", "invalid-envelope",
  "invalid-json", "provider-degraded", "provider-inactive", "provider-omission",
  "provider-too-large", "privacy-ineligible-node", "semantic-term-omitted",
  "unknown-node", "unsupported-relation"
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortedObject(value) {
  if (Array.isArray(value)) return value.map(sortedObject);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedObject(value[key])]));
}

export function canonicalStringify(value) {
  return JSON.stringify(sortedObject(value));
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clamp(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function score(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function round(value) {
  return Number(clamp(value).toFixed(6));
}

function exactFields(value, fields) {
  if (!isObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

function validTime(value) {
  return typeof value === "string" && value.length <= 35 && RFC3339.test(value)
    && Number.isFinite(Date.parse(value));
}

function canonicalTime(value) {
  if (validTime(value)) return value;
  if (typeof value !== "string" || value.length > 64) {
    throw new TypeError("renderer observed_at must be a valid date-time");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError("renderer observed_at must be a valid date-time");
  return new Date(parsed).toISOString().replace(".000Z", "Z");
}

function validSlug(value) {
  return typeof value === "string" && value.length <= 128 && SLUG.test(value);
}

function validSafeId(value) {
  return typeof value === "string" && SAFE_ID.test(value);
}

function validHash(value) {
  return typeof value === "string" && HASH.test(value);
}

function validStringArray(value, predicate, maximum) {
  return Array.isArray(value) && value.length <= maximum && value.every(predicate);
}

function validWeightedTerms(value, limits) {
  return Array.isArray(value) && value.length <= limits.termsPerContribution
    && value.every((term) => Array.isArray(term) && term.length === 2
      && validSlug(term[0]) && score(term[1]));
}

function validLineage(value, limits) {
  return validStringArray(value, validHash, limits.lineagePerContribution);
}

function validateContribution(value, limits) {
  if (!isObject(value) || !["node", "edge", "residual"].includes(value.kind)) return false;
  if (value.kind === "node") {
    return exactFields(value, NODE_CONTRIBUTION_FIELDS)
      && validSafeId(value.id) && validSafeId(value.node)
      && validWeightedTerms(value.subjects, limits) && validWeightedTerms(value.contexts, limits)
      && score(value.relevance) && (value.importance === null || score(value.importance))
      && (value.utility === null || score(value.utility)) && score(value.confidence)
      && EVIDENCE.has(value.evidence) && validLineage(value.lineage_ids, limits)
      && validTime(value.as_of);
  }
  if (value.kind === "edge") {
    return exactFields(value, EDGE_CONTRIBUTION_FIELDS)
      && validSafeId(value.id) && validSafeId(value.a) && validSafeId(value.b) && value.a !== value.b
      && validSlug(value.relation) && score(value.score) && score(value.confidence)
      && EVIDENCE.has(value.evidence) && validLineage(value.lineage_ids, limits)
      && validTime(value.as_of) && PROVIDER_STATUS.has(value.status);
  }
  return exactFields(value, RESIDUAL_CONTRIBUTION_FIELDS)
    && validSafeId(value.id)
    && validStringArray(value.nodes, validSafeId, limits.residualNodes)
    && validSlug(value.code) && score(value.severity) && EVIDENCE.has(value.evidence)
    && validLineage(value.lineage_ids, limits) && validTime(value.as_of);
}

function normaliseLimits(overrides = {}) {
  const limits = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (Object.hasOwn(limits, key) && Number.isInteger(value) && value > 0) limits[key] = value;
  }
  return limits;
}

export function parseProjectionSource(text, { limits: limitOverrides } = {}) {
  const limits = normaliseLimits(limitOverrides);
  const bytes = Buffer.byteLength(text, "utf8");
  const sourceHash = sha256Hex(text);
  if (bytes > limits.providerBytes) {
    return { document: null, sourceHash, codes: ["provider-too-large"] };
  }
  try {
    return { document: JSON.parse(text), sourceHash, codes: [] };
  } catch {
    return { document: null, sourceHash, codes: ["invalid-json"] };
  }
}

function normaliseProviderInput(input) {
  if (isObject(input) && Object.hasOwn(input, "document") && Array.isArray(input.codes)) {
    return {
      document: input.document,
      sourceHash: validHash(input.sourceHash) ? input.sourceHash : sha256Hex(canonicalStringify(input)),
      codes: input.codes.filter((code) => PUBLIC_OMISSIONS.has(code))
    };
  }
  return { document: input, sourceHash: sha256Hex(canonicalStringify(input)), codes: [] };
}

function validateProvider(input, expectedBase, limits) {
  const wrapped = normaliseProviderInput(input);
  const value = wrapped.document;
  const fallbackId = `invalid-${wrapped.sourceHash.slice(0, 12)}`;
  const result = { value, id: fallbackId, sourceHash: wrapped.sourceHash, codes: [...wrapped.codes] };
  if (result.codes.length || !exactFields(value, PROVIDER_FIELDS)) {
    result.codes.push("invalid-envelope");
    return result;
  }
  result.id = validSlug(value.provider_id) ? value.provider_id : fallbackId;
  const envelopeValid = value.schema === PROVIDER_SCHEMA
    && validSlug(value.provider_id) && validTime(value.observed_at)
    && PROVIDER_STATUS.has(value.status) && AUTHORITY.has(value.authority)
    && validSlug(value.derivation_family)
    && exactFields(value.base, ["agent_index_sha256", "graph_sha256"])
    && validHash(value.base.agent_index_sha256) && validHash(value.base.graph_sha256)
    && validHash(value.source_snapshot_sha256)
    && validStringArray(value.omissions, validSlug, 64)
    && Array.isArray(value.contributions)
    && value.contributions.length <= limits.contributionsPerProvider;
  if (!envelopeValid) {
    result.codes.push("invalid-envelope");
    return result;
  }
  if (value.contributions.some((item) => !validateContribution(item, limits))) {
    result.codes.push("invalid-contribution");
    return result;
  }
  if (!expectedBase.agentIndex || !expectedBase.graph) {
    result.codes.push("base-hash-unavailable");
    return result;
  }
  if (value.base.agent_index_sha256 !== expectedBase.agentIndex
      || value.base.graph_sha256 !== expectedBase.graph) {
    result.codes.push("base-hash-mismatch");
    return result;
  }
  if (value.status === "degraded") result.codes.push("provider-degraded");
  if (value.status === "inactive") result.codes.push("provider-inactive");
  return result;
}

function semanticSlug(value) {
  if (typeof value !== "string") return "";
  const slug = value.toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 128);
  return validSlug(slug) ? slug : "";
}

function controlledTerms(graph) {
  const terms = new Set(FIXED_TERMS);
  const add = (value) => {
    const term = semanticSlug(value);
    if (term) terms.add(term);
  };
  for (const value of graph.facet_vocab ?? []) add(value);
  for (const node of graph.nodes ?? []) {
    if (node.privacy !== "agent-safe" || node.withhold_from_telemetry === true) continue;
    for (const value of [...(node.topics ?? []), ...(node.facets ?? [])]) add(value);
    add(node.area);
    add(node.role);
    add(node.family);
  }
  return terms;
}

function effectiveEvidence(evidence) {
  return evidence === "verified-runtime" || evidence === "verified-source" ? "reported" : evidence;
}

function freshness(asOf, referenceTime) {
  const age = Math.max(0, Date.parse(referenceTime) - Date.parse(asOf));
  return round(Math.exp(-age / (180 * 24 * 60 * 60 * 1000)));
}

function providerReceipt(validation, graph, terms) {
  const value = validation.value;
  const codes = new Set(validation.codes);
  const safeNodeIds = new Set(graph.nodes.filter((node) => node.privacy === "agent-safe"
    && node.withhold_from_telemetry !== true).map((node) => node.id));
  const contributions = [];
  const residuals = [];
  let semanticFatal = false;
  let omittedTerms = 0;
  let suppliedTerms = 0;

  if (codes.size === 0) {
    for (const raw of value.contributions) {
      const targets = raw.kind === "node" ? [raw.node]
        : raw.kind === "edge" ? [raw.a, raw.b] : raw.nodes;
      if (targets.some((id) => !safeNodeIds.has(id))) {
        codes.add(graph.nodes.some((node) => targets.includes(node.id))
          ? "privacy-ineligible-node" : "unknown-node");
        semanticFatal = true;
        continue;
      }
      const item = clone(raw);
      item.lineage_ids = [...new Set(item.lineage_ids)].sort();
      item.evidence = effectiveEvidence(item.evidence);
      if (item.evidence !== raw.evidence) {
        codes.add("external-evidence-downgraded");
        residuals.push({
          code: "external-evidence-downgraded", severity: 0.25, nodes: targets,
          evidence: "reported"
        });
      }
      if (item.kind === "node") {
        const filterTerms = (pairs) => {
          suppliedTerms += pairs.length;
          return pairs.filter(([term]) => {
            const keep = terms.has(term);
            if (!keep) omittedTerms += 1;
            return keep;
          });
        };
        item.subjects = filterTerms(item.subjects);
        item.contexts = filterTerms(item.contexts);
        if (item.subjects.length + item.contexts.length < raw.subjects.length + raw.contexts.length) {
          codes.add("semantic-term-omitted");
          residuals.push({
            code: "semantic-term-omitted", severity: 0.35, nodes: [item.node],
            evidence: "unknown"
          });
        }
      } else if (item.kind === "edge" && !FIXED_RELATIONS.has(item.relation)) {
        codes.add("unsupported-relation");
        residuals.push({
          code: "unsupported-relation", severity: 0.4, nodes: [item.a, item.b],
          evidence: "unknown"
        });
        continue;
      } else if (item.kind === "residual") {
        item.code = FIXED_RESIDUALS.has(item.code) ? item.code : "provider-residual";
      }
      contributions.push(item);
    }
  }

  const active = value && validation.codes.length === 0 && !semanticFatal && value.status === "active";
  const usable = active ? contributions : [];
  const confidenceValues = usable.filter((item) => item.kind !== "residual")
    .map((item) => item.confidence);
  const confidence = confidenceValues.length
    ? confidenceValues.reduce((sum, item) => sum + item, 0) / confidenceValues.length : 0;
  const signal = usable.map((item) => item.kind === "node" ? item.relevance
    : item.kind === "edge" ? item.score : 1 - item.severity);
  const direct = signal.length ? signal.reduce((sum, item) => sum + item, 0) / signal.length : 0;
  const fresh = value ? freshness(value.observed_at, graph.observed_at) : 0;
  const coverage = Math.min(1, usable.length / Math.max(1, graph.nodes.length));
  const semanticPenalty = suppliedTerms ? omittedTerms / suppliedTerms : 0;
  const activation = active ? round(0.45 * direct + 0.25 * confidence + 0.15 * fresh + 0.15 * coverage) : 0;
  const inhibition = active ? round(Math.min(0.75, semanticPenalty * 0.5)) : 1;
  const rawOmissions = value?.omissions ?? [];
  const omissions = new Set([...codes]);
  if (rawOmissions.length) omissions.add("provider-omission");
  return {
    id: validation.id,
    family: value?.derivation_family ?? "unknown",
    observedAt: value?.observed_at ?? graph.observed_at,
    snapshot: value?.source_snapshot_sha256 ?? validation.sourceHash,
    region: {
      id: validation.id,
      derivation_family: value?.derivation_family ?? "unknown",
      observed_at: value?.observed_at ?? graph.observed_at,
      source_snapshot_sha256: value?.source_snapshot_sha256 ?? validation.sourceHash,
      status: active ? "active" : value?.status === "inactive" && codes.has("provider-inactive")
        ? "inactive" : "degraded",
      activation,
      inhibition,
      gain: round(activation * (1 - inhibition)),
      confidence: round(confidence),
      contributions: usable.length,
      omissions: [...omissions].filter((item) => PUBLIC_OMISSIONS.has(item)).sort()
    },
    contributions: usable,
    residuals: active ? residuals : [{
      code: [...omissions].find((item) => PUBLIC_OMISSIONS.has(item)) ?? "provider-degraded",
      severity: 1,
      nodes: [],
      evidence: "unknown"
    }]
  };
}

function itemOrder(left, right) {
  const evidence = (EVIDENCE_WEIGHT[right.item.evidence] ?? 0) - (EVIDENCE_WEIGHT[left.item.evidence] ?? 0);
  if (evidence) return evidence;
  const confidence = (right.item.confidence ?? 0) - (left.item.confidence ?? 0);
  if (confidence) return confidence;
  const date = String(right.item.as_of).localeCompare(String(left.item.as_of));
  if (date) return date;
  return `${left.provider.id}:${left.item.id}`.localeCompare(`${right.provider.id}:${right.item.id}`);
}

function selectIndependent(items) {
  const selected = [];
  const families = new Set();
  const lineages = new Set();
  for (const candidate of [...items].sort(itemOrder)) {
    const overlap = candidate.item.lineage_ids.some((id) => lineages.has(id));
    if (families.has(candidate.provider.family) || overlap) continue;
    selected.push(candidate);
    families.add(candidate.provider.family);
    for (const id of candidate.item.lineage_ids) lineages.add(id);
  }
  return selected;
}

function selectRegional(items) {
  const selected = [];
  const families = new Set();
  for (const candidate of [...items].sort(itemOrder)) {
    if (families.has(candidate.provider.family)) continue;
    selected.push(candidate);
    families.add(candidate.provider.family);
  }
  return selected;
}

function weightedMean(items, value) {
  let numerator = 0;
  let denominator = 0;
  for (const entry of items) {
    const weight = (entry.item.confidence ?? 1)
      * (EVIDENCE_WEIGHT[entry.item.evidence] ?? 0.15) * entry.provider.region.gain;
    numerator += value(entry.item) * weight;
    denominator += weight;
  }
  return denominator ? numerator / denominator : 0;
}

function termPairs(baseValues, selected, field, maximum) {
  const terms = new Map();
  for (const [index, raw] of baseValues.entries()) {
    const term = semanticSlug(raw);
    if (term) terms.set(term, Math.max(terms.get(term) ?? 0, 0.55 - Math.min(0.3, index * 0.05)));
  }
  for (const entry of selected) {
    const factor = entry.item.confidence * (EVIDENCE_WEIGHT[entry.item.evidence] ?? 0.15)
      * entry.provider.region.gain;
    for (const [term, value] of entry.item[field]) {
      terms.set(term, Math.max(terms.get(term) ?? 0, value * factor));
    }
  }
  return [...terms].map(([term, value]) => [term, round(value)])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, maximum);
}

function termAttribution(finalTerms, baseValues, selected, field) {
  const supportByTerm = new Map();
  const add = (term, regionId, value) => {
    if (!supportByTerm.has(term)) supportByTerm.set(term, new Map());
    const regions = supportByTerm.get(term);
    regions.set(regionId, Math.max(regions.get(regionId) ?? 0, round(value)));
  };
  for (const [index, raw] of baseValues.entries()) {
    const term = semanticSlug(raw);
    if (term) add(term, "base-graph", 0.55 - Math.min(0.3, index * 0.05));
  }
  for (const entry of selected) {
    const factor = entry.item.confidence * (EVIDENCE_WEIGHT[entry.item.evidence] ?? 0.15)
      * entry.provider.region.gain;
    for (const [term, value] of entry.item[field]) add(term, entry.provider.id, value * factor);
  }
  return finalTerms.map(([term]) => [term,
    [...(supportByTerm.get(term) ?? [])].map(([regionId, value]) => [regionId, value])
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  ]);
}

function reasonValue(graph, index) {
  return graph.reason_vocab?.[index] ?? null;
}

function edgeKey(a, b) {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function recomputeCounts(graph) {
  const presentations = { primary: 0, context: 0, archive: 0 };
  for (const edge of [...graph.explicit, ...graph.latent]) {
    if (Object.hasOwn(presentations, edge[10])) presentations[edge[10]] += 1;
  }
  graph.counts = {
    ...graph.counts,
    nodes: graph.nodes.length,
    explicit: graph.explicit.length,
    latent: graph.latent.length,
    ghosts: graph.ghosts.length,
    severed: graph.severed.length,
    ...presentations,
    facet_gap_known_disjoint: [...graph.explicit, ...graph.latent].filter((edge) => edge[6] === 1).length,
    facet_gap_unknown: [...graph.explicit, ...graph.latent].filter((edge) => edge[6] === -1).length
  };
}

function prepareGraph(input) {
  if (!isObject(input) || !["aethergraph.v3", "aethergraph.v4"].includes(input.schema)) {
    throw new TypeError("renderer graph must use aethergraph.v3 or aethergraph.v4");
  }
  if (!Array.isArray(input.nodes) || !Array.isArray(input.explicit) || !Array.isArray(input.latent)) {
    throw new TypeError("renderer graph must contain nodes, explicit edges, and latent edges");
  }
  const graph = clone(input);
  delete graph.synthesis;
  graph.schema = "aethergraph.v4";
  // Legacy renderer v3 accepted ISO-8601 basic UTC offsets (for example
  // -0700).  v4 publishes canonical RFC 3339 so its runtime and JSON Schema
  // date-time contracts agree byte-for-byte.
  graph.observed_at = canonicalTime(graph.observed_at);
  graph.reason_vocab = Array.isArray(graph.reason_vocab) ? graph.reason_vocab : [];
  graph.facet_vocab = Array.isArray(graph.facet_vocab) ? graph.facet_vocab : [];
  graph.ghosts = Array.isArray(graph.ghosts) ? graph.ghosts : [];
  graph.severed = Array.isArray(graph.severed) ? graph.severed : [];
  graph.nodes = graph.nodes.map((node) => {
    const result = clone(node);
    delete result.synthesis;
    delete result.description;
    return result;
  });
  return graph;
}

function agentSafeSpineHash(graph) {
  const safe = new Set(graph.nodes.filter((node) => node.privacy === "agent-safe"
    && node.withhold_from_telemetry !== true).map((node) => node.id));
  const nodes = graph.nodes.filter((node) => safe.has(node.id)).map(clone)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const relations = [];
  for (const collection of ["explicit", "latent"]) {
    for (const edge of graph[collection]) {
      const a = graph.nodes[edge[0]]?.id;
      const b = graph.nodes[edge[1]]?.id;
      if (safe.has(a) && safe.has(b)) relations.push({ collection, a, b, edge: edge.slice(2) });
    }
  }
  relations.sort((a, b) => canonicalStringify(a).localeCompare(canonicalStringify(b)));
  return sha256Hex(canonicalStringify({ schema: "aethergraph.agent-safe-spine.v1", nodes, relations }));
}

export function synthesizeGraph({
  graph: inputGraph,
  providers = [],
  rendererGraphSha256 = null,
  baseGraphSha256 = null,
  agentIndexSha256 = null,
  limits: limitOverrides = {}
}) {
  const limits = normaliseLimits(limitOverrides);
  if (providers.length > limits.providers) throw new RangeError(`provider limit is ${limits.providers}`);
  const graph = prepareGraph(inputGraph);
  const rendererHash = validHash(rendererGraphSha256)
    ? rendererGraphSha256 : sha256Hex(canonicalStringify(inputGraph));
  const expectedBase = {
    graph: validHash(baseGraphSha256) ? baseGraphSha256 : null,
    agentIndex: validHash(agentIndexSha256) ? agentIndexSha256 : null
  };
  const safeSpineHash = agentSafeSpineHash(graph);
  const reportedBaseHash = expectedBase.graph ?? (providers.length ? "0".repeat(64) : safeSpineHash);
  const controlled = controlledTerms(graph);
  const validations = providers.map((provider) => validateProvider(provider, expectedBase, limits));
  const idCounts = new Map();
  for (const item of validations) idCounts.set(item.id, (idCounts.get(item.id) ?? 0) + 1);
  validations.forEach((item, index) => {
    if (item.id === "base-graph") item.codes.push("invalid-envelope");
    if ((idCounts.get(item.id) ?? 0) > 1) {
      item.codes.push("duplicate-provider-id");
      item.id = `${item.id.slice(0, 105)}-${item.sourceHash.slice(0, 8)}-${index + 1}`;
    }
  });
  const providerRows = validations.map((item) => providerReceipt(item, graph, controlled))
    .sort((a, b) => a.id.localeCompare(b.id));
  const safeNodeCount = graph.nodes.filter((node) => node.privacy === "agent-safe"
    && node.withhold_from_telemetry !== true).length;
  const safeEdgeCount = [...graph.explicit, ...graph.latent].filter((edge) => {
    const a = graph.nodes[edge[0]];
    const b = graph.nodes[edge[1]];
    return a?.privacy === "agent-safe" && b?.privacy === "agent-safe"
      && a.withhold_from_telemetry !== true && b.withhold_from_telemetry !== true;
  }).length;
  const baseRegion = {
    id: "base-graph",
    derivation_family: "base-graph",
    observed_at: graph.observed_at,
    source_snapshot_sha256: expectedBase.graph ?? safeSpineHash,
    status: "active",
    activation: 1,
    inhibition: 0,
    gain: 1,
    confidence: 0.8,
    contributions: safeNodeCount + safeEdgeCount,
    omissions: []
  };
  const regions = [baseRegion, ...providerRows.map((item) => item.region)];
  const nodeById = new Map(graph.nodes.map((node, index) => [node.id, { node, index }]));
  const nodeItems = new Map();
  const edgeItems = [];
  const residuals = [];
  for (const provider of providerRows) {
    residuals.push(...provider.residuals);
    for (const item of provider.contributions) {
      const entry = { provider, item };
      if (item.kind === "node") {
        if (!nodeItems.has(item.node)) nodeItems.set(item.node, []);
        nodeItems.get(item.node).push(entry);
      } else if (item.kind === "edge" && item.status === "active") edgeItems.push(entry);
      else if (item.kind === "residual") residuals.push({
        code: FIXED_RESIDUALS.has(item.code) ? item.code : "provider-residual",
        severity: item.severity,
        nodes: [...item.nodes].sort(),
        evidence: item.evidence
      });
    }
  }

  const edgeGroups = new Map();
  for (const entry of edgeItems) {
    const key = `${edgeKey(entry.item.a, entry.item.b)}\u0000${entry.item.relation}`;
    if (!edgeGroups.has(key)) edgeGroups.set(key, []);
    edgeGroups.get(key).push(entry);
  }
  const neighbourEvidence = new Map();
  const providerEdges = [];
  for (const [key, entries] of edgeGroups) {
    const selected = selectIndependent(entries);
    if (!selected.length) continue;
    const first = selected[0].item;
    const combined = round(weightedMean(selected, (item) => item.score));
    const confidence = round(weightedMean(selected, (item) => item.confidence));
    const strength = round(combined * confidence);
    for (const nodeId of [first.a, first.b]) {
      neighbourEvidence.set(nodeId, Math.max(neighbourEvidence.get(nodeId) ?? 0, strength));
    }
    providerEdges.push({ key, a: first.a, b: first.b, relation: first.relation, strength,
      evidence: selected[0].item.evidence });
  }

  const basePairs = new Set();
  for (const edge of [...graph.explicit, ...graph.latent]) {
    const a = graph.nodes[edge[0]]?.id;
    const b = graph.nodes[edge[1]]?.id;
    if (a && b) basePairs.add(edgeKey(a, b));
  }
  const degree = new Map();
  const candidates = providerEdges.filter((edge) => !basePairs.has(edgeKey(edge.a, edge.b)))
    .sort((a, b) => b.strength - a.strength || a.key.localeCompare(b.key));
  let addedEdges = 0;
  for (const item of candidates) {
    if (addedEdges >= limits.providerEdgeLimit) break;
    if ((degree.get(item.a) ?? 0) >= limits.providerDegreeLimit
        || (degree.get(item.b) ?? 0) >= limits.providerDegreeLimit) continue;
    const a = nodeById.get(item.a).index;
    const b = nodeById.get(item.b).index;
    const reason = { label: item.relation, basis: ["projection-source"], evidence: item.evidence };
    let reasonIndex = graph.reason_vocab.findIndex((value) => canonicalStringify(value) === canonicalStringify(reason));
    if (reasonIndex < 0) {
      graph.reason_vocab.push(reason);
      reasonIndex = graph.reason_vocab.length - 1;
    }
    const standingA = Number(graph.nodes[a].standing) || 0;
    const standingB = Number(graph.nodes[b].standing) || 0;
    const ageA = Number(graph.nodes[a].age) || 0;
    const ageB = Number(graph.nodes[b].age) || 0;
    const facetsA = new Set(graph.nodes[a].facets ?? []);
    const facetsB = new Set(graph.nodes[b].facets ?? []);
    const shared = [...facetsA].filter((value) => facetsB.has(value)).sort();
    const facet = shared.length ? graph.facet_vocab.indexOf(shared[0]) : -1;
    const facetGap = shared.length ? 0 : facetsA.size && facetsB.size ? 1 : -1;
    const presentation = item.strength >= 0.35 ? "context" : "archive";
    graph.latent.push([
      Math.min(a, b), Math.max(a, b), item.strength, facet,
      round(Math.abs(standingA - standingB)), round(Math.abs(ageA - ageB)),
      facetGap, item.strength, reasonIndex, 16, presentation
    ]);
    degree.set(item.a, (degree.get(item.a) ?? 0) + 1);
    degree.set(item.b, (degree.get(item.b) ?? 0) + 1);
    addedEdges += 1;
  }

  const maxLoad = Math.max(1, ...graph.nodes.map((node) => Number(node.load) || 0));
  const directByNode = new Map();
  const nodeResidualCodes = new Map();
  const residualSeverity = new Map();
  for (const residual of residuals) {
    for (const id of residual.nodes) {
      if (!nodeResidualCodes.has(id)) nodeResidualCodes.set(id, new Set());
      nodeResidualCodes.get(id).add(residual.code);
      residualSeverity.set(id, Math.max(residualSeverity.get(id) ?? 0, residual.severity));
    }
  }

  for (const node of graph.nodes) {
    const all = nodeItems.get(node.id) ?? [];
    const selected = selectIndependent(all);
    const framing = selectRegional(all);
    const direct = round(weightedMean(framing, (item) => item.relevance));
    directByNode.set(node.id, direct);
    /* Topics generated from a path/list projection are useful search hints, but are not grounded
       enough to become claims about a document's subject. Declared facets remain admissible;
       typed provider subjects can still add independently evidenced framing. */
    const labelSource = String(node.label_source ?? "").trim().toLowerCase();
    const groundedLabel = labelSource && !["none", "unknown", "path", "agent-safe-topics"].includes(labelSource);
    const baseSubjects = groundedLabel
      ? [...(node.topics ?? []), ...(node.facets ?? [])] : [...(node.facets ?? [])];
    const subjects = termPairs(baseSubjects, framing, "subjects", 12);
    const subjectAttribution = termAttribution(subjects, baseSubjects, framing, "subjects");
    const contexts = termPairs([node.area, node.role, node.family].filter(Boolean), framing, "contexts", 8);
    const lineages = new Set(all.flatMap((entry) => entry.item.lineage_ids));
    const attribution = new Map([["base-graph", round(0.25 + 0.5
      * (EVIDENCE_WEIGHT[node.evidence] ?? 0.15) + 0.25 * clamp(Number(node.standing) || 0))]]);
    for (const entry of all) {
      const semanticSupport = Math.max(
        entry.item.importance ?? 0,
        ...entry.item.subjects.map((pair) => pair[1]),
        ...entry.item.contexts.map((pair) => pair[1]),
        0.25
      );
      const weight = round(entry.item.confidence
        * (EVIDENCE_WEIGHT[entry.item.evidence] ?? 0.15)
        * entry.provider.region.gain * semanticSupport);
      attribution.set(entry.provider.id, Math.max(attribution.get(entry.provider.id) ?? 0, weight));
    }
    const standing = clamp(Number(node.standing) || 0);
    const load = clamp(Math.log2((Number(node.load) || 0) + 1) / Math.log2(maxLoad + 1));
    const authority = clamp((Number(node.authority_rank) || 0) / 4);
    const support = clamp(selected.length / 4);
    const importanceScore = round(0.35 * standing + 0.3 * load + 0.2 * authority + 0.15 * support);
    const neighbour = round(neighbourEvidence.get(node.id) ?? 0);
    const goal = round(weightedMean(framing.filter((entry) => entry.item.utility !== null),
      (item) => item.utility ?? 0));
    const utilityScore = round(0.55 * direct + 0.25 * neighbour + 0.2 * goal);
    const baseEvidence = EVIDENCE_WEIGHT[node.evidence] ?? 0.15;
    const evidencePart = selected.length
      ? weightedMean(selected, (item) => EVIDENCE_WEIGHT[item.evidence] ?? 0.15) : baseEvidence;
    const independence = clamp(selected.length / 3);
    const fresh = selected.length
      ? selected.reduce((sum, entry) => sum + freshness(entry.item.as_of, graph.observed_at), 0) / selected.length : 1;
    const coverage = clamp((subjects.length + contexts.length) / 8);
    const residual = clamp(residualSeverity.get(node.id) ?? 0);
    const confidenceScore = round(0.45 * evidencePart + 0.3 * independence
      + 0.15 * fresh + 0.1 * coverage - residual);
    const description = node.privacy === "agent-safe"
      ? [...subjects.slice(0, 3).map(([term]) => term),
        ...contexts.slice(0, 2).map(([term]) => term)].join(" · ").slice(0, 240)
      : "";
    node.description = description;
    node.synthesis = {
      subjects,
      subject_attribution: subjectAttribution,
      contexts,
      importance: { score: importanceScore, parts: { standing: round(standing), load: round(load),
        authority: round(authority), support: round(support) } },
      utility: { score: utilityScore, frame_ref: `resting-${reportedBaseHash.slice(0, 16)}`,
        parts: { direct, neighbour, goal } },
      activation: { score: 0, direct, propagated: 0, inhibited: residual },
      confidence: { score: confidenceScore, parts: { evidence: round(evidencePart),
        independence: round(independence), freshness: round(fresh), coverage: round(coverage), residual } },
      support: { regions: attribution.size, independent: selected.length, lineages: lineages.size },
      residuals: [...(nodeResidualCodes.get(node.id) ?? [])].sort(),
      region_attribution: [...attribution].map(([id, value]) => [id, value])
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    };
  }

  for (const node of graph.nodes) {
    let primary = 0;
    let context = 0;
    let archive = 0;
    for (const edge of [...graph.explicit, ...graph.latent]) {
      const a = graph.nodes[edge[0]];
      const b = graph.nodes[edge[1]];
      if (a?.id !== node.id && b?.id !== node.id) continue;
      const other = a.id === node.id ? b : a;
      const value = directByNode.get(other.id) ?? 0;
      if (edge[10] === "primary") primary = Math.max(primary, value);
      else if (edge[10] === "context") context = Math.max(context, value);
      else archive = Math.max(archive, value);
    }
    const propagated = round(0.25 * primary + 0.12 * context + 0.03 * archive);
    const synthesis = node.synthesis;
    synthesis.activation.propagated = propagated;
    synthesis.activation.score = round((0.6 * synthesis.activation.direct + propagated)
      * (1 - synthesis.activation.inhibited));
  }

  const dedupedResiduals = new Map();
  for (const item of residuals) {
    const safeCode = PUBLIC_OMISSIONS.has(item.code) || FIXED_RESIDUALS.has(item.code)
      ? item.code : "provider-residual";
    const nodes = [...new Set(item.nodes.filter((id) => nodeById.has(id)))].sort();
    const evidence = effectiveEvidence(item.evidence);
    const key = `${safeCode}\u0000${nodes.join("\u0000")}\u0000${evidence}`;
    const previous = dedupedResiduals.get(key);
    if (!previous || item.severity > previous.severity) {
      dedupedResiduals.set(key, { code: safeCode, severity: round(item.severity), nodes, evidence });
    }
  }
  const finalResiduals = [...dedupedResiduals.values()]
    .sort((a, b) => b.severity - a.severity || a.code.localeCompare(b.code)
      || a.nodes.join("\u0000").localeCompare(b.nodes.join("\u0000")));
  const opaqueFrameRef = `resting-${reportedBaseHash.slice(0, 16)}`;
  for (const node of graph.nodes) node.synthesis.utility.frame_ref = opaqueFrameRef;
  const rankedNodes = graph.nodes.filter((node) => node.privacy === "agent-safe"
      && node.withhold_from_telemetry !== true)
    .sort((a, b) => b.synthesis.activation.score - a.synthesis.activation.score
      || b.synthesis.utility.score - a.synthesis.utility.score
      || b.synthesis.importance.score - a.synthesis.importance.score
      || String(a.id).localeCompare(String(b.id)));
  const workingSet = [];
  let tokenEstimate = 0;
  for (const node of rankedNodes) {
    if (workingSet.length >= limits.nodeLimit) break;
    const estimate = Math.max(1, Math.ceil((node.description.length + canonicalStringify(node.synthesis).length) / 4));
    if (workingSet.length && tokenEstimate + estimate > limits.tokenEstimateLimit) break;
    workingSet.push(node.id);
    tokenEstimate += estimate;
  }
  const workingIds = new Set(workingSet);
  const selectedEdges = [...graph.explicit, ...graph.latent].filter((edge) => {
    const a = graph.nodes[edge[0]]?.id;
    const b = graph.nodes[edge[1]]?.id;
    return workingIds.has(a) && workingIds.has(b);
  }).length;
  graph.synthesis = {
    schema: SYNTHESIS_SCHEMA,
    frame_ref: opaqueFrameRef,
    mode: "resting",
    authority: "none",
    base: { agent_index_sha256: expectedBase.agentIndex, graph_sha256: reportedBaseHash },
    algorithm: "holistic-modulator-v1",
    regions,
    budget: {
      node_limit: limits.nodeLimit,
      edge_limit: limits.edgeLimit,
      token_estimate_limit: limits.tokenEstimateLimit,
      selected_nodes: workingSet.length,
      selected_edges: Math.min(selectedEdges, limits.edgeLimit)
    },
    working_set: workingSet,
    residuals: finalResiduals
  };
  graph.legend = { ...graph.legend, synthesis: {
    importance: "structural priority, not truth",
    utility: "frame-scoped usefulness, not universal value",
    activation: "bounded participation in the current frame",
    confidence: "support quality, independence, freshness, coverage, and residual penalty"
  } };
  graph.latent.sort((left, right) => {
    const order = { primary: 0, context: 1, archive: 2 };
    return order[left[10]] - order[right[10]] || right[7] - left[7]
      || left[0] - right[0] || left[1] - right[1] || left[8] - right[8];
  });
  recomputeCounts(graph);
  return graph;
}

function filterAgentSafeGraph(input) {
  const graph = clone(input);
  const oldToNew = new Map();
  const nodes = [];
  input.nodes.forEach((node, index) => {
    if (node.privacy === "agent-safe" && node.withhold_from_telemetry !== true) {
      oldToNew.set(index, nodes.length);
      nodes.push(clone(node));
    }
  });
  const edges = (collection) => collection.filter((edge) => oldToNew.has(edge[0]) && oldToNew.has(edge[1]))
    .map((edge) => [oldToNew.get(edge[0]), oldToNew.get(edge[1]), ...edge.slice(2)]);
  graph.nodes = nodes;
  graph.explicit = edges(input.explicit);
  graph.latent = edges(input.latent);
  graph.ghosts = input.ghosts.map((ghost) => ({ ...clone(ghost), anchors: ghost.anchors
    .filter((anchor) => oldToNew.has(anchor.n)).map((anchor) => ({ ...anchor, n: oldToNew.get(anchor.n) })) }))
    .filter((ghost) => ghost.anchors.length);
  const ids = new Set(nodes.map((node) => node.id));
  graph.severed = input.severed.filter((item) => item.pair.every((id) => ids.has(id))).map(clone);
  graph.synthesis.working_set = graph.synthesis.working_set.filter((id) => ids.has(id));
  graph.synthesis.residuals = graph.synthesis.residuals.map((item) => ({ ...item,
    nodes: item.nodes.filter((id) => ids.has(id)) }));
  graph.synthesis.budget.selected_nodes = graph.synthesis.working_set.length;
  graph.synthesis.budget.selected_edges = Math.min(graph.synthesis.budget.edge_limit,
    [...graph.explicit, ...graph.latent].filter((edge) => {
      const working = new Set(graph.synthesis.working_set);
      return working.has(graph.nodes[edge[0]].id) && working.has(graph.nodes[edge[1]].id);
    }).length);
  recomputeCounts(graph);
  return graph;
}

export function encodeAiJsonl(inputGraph) {
  if (inputGraph.schema !== "aethergraph.v4" || inputGraph.synthesis?.schema !== SYNTHESIS_SCHEMA) {
    throw new TypeError("AI encoding requires a synthesized aethergraph.v4 graph");
  }
  const graph = filterAgentSafeGraph(inputGraph);
  const meta = clone(graph);
  delete meta.nodes;
  delete meta.explicit;
  delete meta.latent;
  delete meta.ghosts;
  delete meta.severed;
  const sources = meta.synthesis.regions;
  const residuals = meta.synthesis.residuals;
  delete meta.synthesis.regions;
  delete meta.synthesis.residuals;
  const records = [{ schema: AI_SCHEMA, record: "manifest", graph: meta }];
  sources.forEach((source, index) => records.push({
    schema: AI_SCHEMA, record: "source", index, source
  }));
  residuals.forEach((residual, index) => records.push({
    schema: AI_SCHEMA, record: "residual", index, residual
  }));
  graph.nodes.forEach((node, index) => records.push({ schema: AI_SCHEMA, record: "node", index, node }));
  for (const collection of ["explicit", "latent"]) {
    graph[collection].forEach((edge, index) => records.push({
      schema: AI_SCHEMA,
      record: "relation",
      collection,
      index,
      a: graph.nodes[edge[0]].id,
      b: graph.nodes[edge[1]].id,
      weight: edge[2],
      facet_index: edge[3],
      facet: edge[3] >= 0 ? graph.facet_vocab[edge[3]] : null,
      reach: edge[4],
      span: edge[5],
      facet_gap: edge[6],
      relevance: edge[7],
      reason_index: edge[8],
      reason: reasonValue(graph, edge[8]),
      signals: edge[9],
      presentation: edge[10]
    }));
  }
  graph.ghosts.forEach((ghost, index) => records.push({ schema: AI_SCHEMA, record: "ghost", index, ghost }));
  graph.severed.forEach((severed, index) => records.push({ schema: AI_SCHEMA, record: "severed", index, severed }));
  return `${records.map(canonicalStringify).join("\n")}\n`;
}

export function decodeAiJsonl(text) {
  const records = text.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const manifest = records.find((item) => item.schema === AI_SCHEMA && item.record === "manifest");
  if (!manifest || !isObject(manifest.graph)) throw new TypeError("missing aethergraph.ai.v1 manifest");
  const graph = clone(manifest.graph);
  graph.synthesis.regions = records.filter((item) => item.record === "source")
    .sort((a, b) => a.index - b.index).map((item) => clone(item.source));
  graph.synthesis.residuals = records.filter((item) => item.record === "residual")
    .sort((a, b) => a.index - b.index).map((item) => clone(item.residual));
  graph.nodes = records.filter((item) => item.record === "node").sort((a, b) => a.index - b.index)
    .map((item) => clone(item.node));
  const byId = new Map(graph.nodes.map((node, index) => [node.id, index]));
  const decodeRelations = (collection) => records.filter((item) => item.record === "relation"
      && item.collection === collection).sort((a, b) => a.index - b.index).map((item) => [
        byId.get(item.a), byId.get(item.b), item.weight, item.facet_index, item.reach,
        item.span, item.facet_gap, item.relevance, item.reason_index, item.signals, item.presentation
      ]);
  graph.explicit = decodeRelations("explicit");
  graph.latent = decodeRelations("latent");
  graph.ghosts = records.filter((item) => item.record === "ghost").sort((a, b) => a.index - b.index)
    .map((item) => clone(item.ghost));
  graph.severed = records.filter((item) => item.record === "severed").sort((a, b) => a.index - b.index)
    .map((item) => clone(item.severed));
  return graph;
}

function collectKeys(value, keys) {
  if (Array.isArray(value)) value.forEach((item) => collectKeys(item, keys));
  else if (isObject(value)) {
    Object.entries(value).forEach(([key, item]) => {
      keys.add(key);
      collectKeys(item, keys);
    });
  }
}

function compactValue(value, keyIndex) {
  if (Array.isArray(value)) return [1, ...value.map((item) => compactValue(item, keyIndex))];
  if (isObject(value)) {
    const output = [0];
    for (const key of Object.keys(value).sort()) output.push(keyIndex.get(key), compactValue(value[key], keyIndex));
    return output;
  }
  return value;
}

function expandValue(value, keys) {
  if (!Array.isArray(value) || ![0, 1].includes(value[0])) return value;
  if (value[0] === 1) return value.slice(1).map((item) => expandValue(item, keys));
  const output = {};
  if (value.length % 2 !== 1) throw new TypeError("invalid compact object record");
  for (let index = 1; index < value.length; index += 2) {
    const key = keys[value[index]];
    if (typeof key !== "string") throw new TypeError("invalid compact key index");
    output[key] = expandValue(value[index + 1], keys);
  }
  return output;
}

export function encodeCompactJsonl(aiText) {
  const records = aiText.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const keys = new Set();
  records.forEach((record) => collectKeys(record, keys));
  const dictionary = [...keys].sort();
  const keyIndex = new Map(dictionary.map((key, index) => [key, index]));
  const header = {
    schema: COMPACT_AI_SCHEMA,
    source_schema: AI_SCHEMA,
    source_sha256: sha256Hex(aiText),
    tags: { object: 0, array: 1 },
    keys: dictionary
  };
  return `${canonicalStringify(header)}\n${records.map((record) => JSON.stringify(compactValue(record, keyIndex))).join("\n")}\n`;
}

export function decodeCompactJsonl(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  const header = JSON.parse(lines.shift());
  if (header.schema !== COMPACT_AI_SCHEMA || header.source_schema !== AI_SCHEMA
      || !Array.isArray(header.keys)) throw new TypeError("invalid compact AI header");
  const aiText = `${lines.map((line) => canonicalStringify(expandValue(JSON.parse(line), header.keys))).join("\n")}\n`;
  if (sha256Hex(aiText) !== header.source_sha256) throw new TypeError("compact AI checksum mismatch");
  return aiText;
}
