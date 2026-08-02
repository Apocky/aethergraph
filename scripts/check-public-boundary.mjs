import { readdir, readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseProjectionSource, synthesizeGraph } from "../tools/synthesis-core.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const EDGE_FIELDS = Object.freeze([
  "a",
  "b",
  "weight",
  "facet",
  "reach",
  "span",
  "facet_gap",
  "relevance",
  "reason",
  "signals",
  "presentation"
]);

const TOP_LEVEL_FIELDS = Object.freeze([
  "schema",
  "observed_at",
  "counts",
  "legend",
  "nodes",
  "edge_fields",
  "facet_vocab",
  "reason_vocab",
  "presentation_vocab",
  "explicit",
  "latent",
  "ghosts",
  "severed"
]);

const NODE_FIELDS = Object.freeze([
  "id",
  "title",
  "display_title",
  "display_title_source",
  "label_source",
  "topics",
  "display_tags",
  "path",
  "type",
  "project",
  "area",
  "label_area",
  "role",
  "facets",
  "tags",
  "aliases",
  "evidence",
  "privacy",
  "withhold_from_telemetry",
  "authority",
  "source_path",
  "source_sha256",
  "source_commit",
  "source_tree_dirty",
  "hand_authored",
  "standing",
  "standing_parts",
  "corroboration",
  "load",
  "contested",
  "authority_rank",
  "hybridity",
  "family",
  "view_scope",
  "mass",
  "age"
]);

const REQUIRED_REPOSITORY_FILES = Object.freeze([
  "LICENSE",
  "README.md",
  "PRIVACY.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "manifest.json",
  "versions.json",
  "package.json",
  "package-lock.json",
  "schemas/aethergraph-v3.schema.json",
  "schemas/aethergraph-v4.schema.json",
  "schemas/aethergraph-projection-source-v1.schema.json",
  "schemas/aethergraph-ai-v1.schema.json",
  "schemas/aethergraph-ai-compact-v1.schema.json",
  "specs/HOLISTIC_MEMORY_SYNTHESIS_ORGAN_V1.csl",
  "tools/synthesis-core.mjs",
  "tools/synthesize.mjs",
  "tests/fixtures/aethergraph-v3.synthetic.json",
  "tests/fixtures/aethergraph-v4.synthetic.json",
  "tests/fixtures/projection-source-v1.synthetic.json",
  "tests/fixtures/aethergraph-ai-v1.synthetic.jsonl",
  "tests/fixtures/aethergraph-ai-compact-v1.synthetic.jsonl",
  "tests/synthesis.test.mjs"
]);

const REQUIRED_RELEASE_FILES = Object.freeze(["main.js", "manifest.json", "styles.css"]);
const SKIP_DIRECTORIES = new Set([".git", "node_modules", "coverage", "dist", "release"]);
const FORBIDDEN_BASENAMES = new Set(["data.json", ".env", ".env.local", ".env.production"]);
const TEXT_EXTENSIONS = new Set([".cjs", ".csl", ".css", ".js", ".json", ".jsonl", ".md", ".mjs", ".txt", ".yaml", ".yml"]);
const SYNTHETIC_FIXTURE = "tests/fixtures/aethergraph-v3.synthetic.json";
const SYNTHETIC_V4_FIXTURE = "tests/fixtures/aethergraph-v4.synthetic.json";
const SYNTHETIC_PROVIDER_FIXTURE = "tests/fixtures/projection-source-v1.synthetic.json";
const MAX_PUBLIC_FILE_BYTES = 2 * 1024 * 1024;

function normalize(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function sameArray(left, right) {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function scanText(relativePath, text) {
  const findings = [];
  const rules = [
    {
      label: "absolute Windows user-profile path",
      pattern: /\b[A-Za-z]:[\\/]Users[\\/][^\\/\s"'<>]+/i
    },
    {
      label: "absolute Unix user-profile path",
      pattern: /\/(?:Users|home)\/[^/\s"'<>]+/
    },
    {
      label: "private-key material",
      pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/
    },
    {
      label: "AWS access key",
      pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/
    },
    {
      label: "GitHub access token",
      pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/
    },
    {
      label: "Slack access token",
      pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/
    },
    {
      label: "generic secret key",
      pattern: /\bsk-[A-Za-z0-9]{32,}\b/
    }
  ];

  for (const { label, pattern } of rules) {
    if (pattern.test(text)) findings.push(`${relativePath}: ${label}`);
  }
  const internalTokens = [
    ["private vault metadata folder", ["99", "Meta"].join("\\s+")],
    ["private source-mirror folder", ["98", "Source", "Mirrors"].join("\\s+")],
    ["private generator name", ["vault", "sync"].join("")],
    ["private corpus identifier", ["T", "97"].join("")],
    ["private memory-bank name", ["Mem", "Palace"].join("")],
    ["private memory-bank name", ["Brain", "monsoon"].join("")],
    ["private memory-bank name", ["Ana", "mnesis"].join("")]
  ];
  for (const [label, source] of internalTokens) {
    if (new RegExp(`\\b${source}\\b`, "i").test(text)) findings.push(`${relativePath}: ${label}`);
  }
  if (relativePath === "main.js" || relativePath.startsWith("tools/")) {
    const runtimeRules = [
      ["network fetch primitive", new RegExp(`\\b${["fet", "ch"].join("")}\\s*\\(`)],
      ["XML HTTP primitive", new RegExp(`\\b${["XML", "HttpRequest"].join("")}\\b`)],
      ["web socket primitive", new RegExp(`\\b${["Web", "Socket"].join("")}\\b`)],
      ["beacon primitive", new RegExp(`\\b${["send", "Beacon"].join("")}\\b`)],
      ["dynamic evaluation", new RegExp(`\\b${["ev", "al"].join("")}\\s*\\(`)],
      ["Node network module", /(?:node:)?https?|node:net|undici/],
      ["child process primitive", /child_process|execFile|execSync|spawnSync|\bspawn\s*\(/]
    ];
    for (const [label, pattern] of runtimeRules) {
      if (pattern.test(text)) findings.push(`${relativePath}: ${label} is forbidden in the public runtime`);
    }
  }
  return findings;
}

function checkExactFields(value, expected, label, findings) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    findings.push(`${label}: expected an object`);
    return;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (!sameArray(actual, wanted)) {
    const missing = wanted.filter((field) => !actual.includes(field));
    const extra = actual.filter((field) => !wanted.includes(field));
    if (missing.length) findings.push(`${label}: missing fields ${missing.join(", ")}`);
    if (extra.length) findings.push(`${label}: unexpected fields ${extra.join(", ")}`);
  }
}

export function validateGraph(graph, label = SYNTHETIC_FIXTURE) {
  const findings = [];
  checkExactFields(graph, TOP_LEVEL_FIELDS, label, findings);
  if (!graph || typeof graph !== "object") return findings;

  if (graph.schema !== "aethergraph.v3") findings.push(`${label}: schema must be aethergraph.v3`);
  if (!sameArray(graph.edge_fields, EDGE_FIELDS)) findings.push(`${label}: edge_fields is not the canonical v3 order`);
  if (!sameArray(graph.presentation_vocab, ["primary", "context", "archive"])) {
    findings.push(`${label}: presentation_vocab must be primary, context, archive`);
  }
  if (!Array.isArray(graph.nodes)) {
    findings.push(`${label}: nodes must be an array`);
    return findings;
  }

  const nodeIds = new Set();
  let hasWithheldNode = false;
  graph.nodes.forEach((node, index) => {
    checkExactFields(node, NODE_FIELDS, `${label}: nodes[${index}]`, findings);
    if (!node || typeof node !== "object") return;
    if (typeof node.id !== "string" || !node.id) findings.push(`${label}: nodes[${index}] has no stable synthetic id`);
    else if (nodeIds.has(node.id)) findings.push(`${label}: duplicate node id ${node.id}`);
    else nodeIds.add(node.id);
    if (typeof node.withhold_from_telemetry !== "boolean") {
      findings.push(`${label}: nodes[${index}].withhold_from_telemetry must be boolean`);
    }
    if (!["core", "corpus", "all"].includes(node.view_scope)) {
      findings.push(`${label}: nodes[${index}].view_scope must be core, corpus, or all`);
    }
    hasWithheldNode ||= node.withhold_from_telemetry === true;
    if (typeof node.path !== "string" || path.isAbsolute(node.path) || node.path.includes("\\")) {
      findings.push(`${label}: nodes[${index}].path must be a portable relative path`);
    }
  });
  if (!hasWithheldNode) findings.push(`${label}: fixture must exercise withhold_from_telemetry`);

  const presentations = new Set();
  const facetGaps = new Set();
  let edgeCount = 0;
  for (const collectionName of ["explicit", "latent"]) {
    const collection = graph[collectionName];
    if (!Array.isArray(collection)) {
      findings.push(`${label}: ${collectionName} must be an array`);
      continue;
    }
    collection.forEach((edge, index) => {
      edgeCount += 1;
      if (!Array.isArray(edge) || edge.length !== EDGE_FIELDS.length) {
        findings.push(`${label}: ${collectionName}[${index}] must contain ${EDGE_FIELDS.length} compact fields`);
        return;
      }
      const [a, b, , facet, , , facetGap, , reason, signals, presentation] = edge;
      if (!Number.isInteger(a) || a < 0 || a >= graph.nodes.length) findings.push(`${label}: ${collectionName}[${index}] endpoint a is invalid`);
      if (!Number.isInteger(b) || b < 0 || b >= graph.nodes.length) findings.push(`${label}: ${collectionName}[${index}] endpoint b is invalid`);
      if (a === b) findings.push(`${label}: ${collectionName}[${index}] is a self-loop`);
      if (!Number.isInteger(facet) || facet < -1 || facet >= graph.facet_vocab.length) findings.push(`${label}: ${collectionName}[${index}] facet index is invalid`);
      if (![-1, 0, 1].includes(facetGap)) findings.push(`${label}: ${collectionName}[${index}] facet_gap is not tri-state`);
      if (!Number.isInteger(reason) || reason < 0 || reason >= graph.reason_vocab.length) findings.push(`${label}: ${collectionName}[${index}] reason index is invalid`);
      if (!Number.isInteger(signals) || signals < 0) findings.push(`${label}: ${collectionName}[${index}] signals must be a non-negative bit field`);
      if (!["primary", "context", "archive"].includes(presentation)) findings.push(`${label}: ${collectionName}[${index}] presentation is invalid`);
      facetGaps.add(facetGap);
      presentations.add(presentation);
    });
  }

  if (!sameArray([...presentations].sort(), ["archive", "context", "primary"])) {
    findings.push(`${label}: fixture must contain Primary, Context, and Archive edges`);
  }
  if (!sameArray([...facetGaps].sort((a, b) => a - b), [-1, 0, 1])) {
    findings.push(`${label}: fixture must contain all facet_gap states`);
  }

  if (graph.counts?.nodes !== graph.nodes.length) findings.push(`${label}: counts.nodes does not match nodes`);
  if (graph.counts?.explicit !== graph.explicit?.length) findings.push(`${label}: counts.explicit does not match explicit`);
  if (graph.counts?.latent !== graph.latent?.length) findings.push(`${label}: counts.latent does not match latent`);
  if (edgeCount !== (graph.explicit?.length ?? 0) + (graph.latent?.length ?? 0)) findings.push(`${label}: edge accounting failed`);

  if (!Array.isArray(graph.ghosts)) findings.push(`${label}: ghosts must be an array`);
  else {
    for (const [ghostIndex, ghost] of graph.ghosts.entries()) {
      for (const [anchorIndex, anchor] of (ghost?.anchors ?? []).entries()) {
        if (!Number.isInteger(anchor.n) || anchor.n < 0 || anchor.n >= graph.nodes.length) {
          findings.push(`${label}: ghosts[${ghostIndex}].anchors[${anchorIndex}] references an invalid node`);
        }
      }
    }
  }

  if (!Array.isArray(graph.severed)) findings.push(`${label}: severed must be an array`);
  else {
    graph.severed.forEach((item, index) => {
      if (!Array.isArray(item?.pair) || item.pair.length !== 2 || item.pair.some((id) => !nodeIds.has(id))) {
        findings.push(`${label}: severed[${index}] must reference two known node ids`);
      }
    });
  }

  return findings;
}

function validateManifest(manifest) {
  const findings = [];
  if (manifest.id !== "aethergraph") findings.push("manifest.json: id must be aethergraph");
  if (manifest.version !== "0.2.0") findings.push("manifest.json: public beta version must be 0.2.0");
  if (manifest.isDesktopOnly !== true) findings.push("manifest.json: beta must remain desktop-only");
  if (typeof manifest.minAppVersion !== "string" || !manifest.minAppVersion) findings.push("manifest.json: minAppVersion is required");
  return findings;
}

async function walk(directory, root = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const relative = normalize(path.relative(root, absolute));
    if (entry.isSymbolicLink()) {
      files.push({ absolute, relative, symbolicLink: true, size: 0 });
      continue;
    }
    if (entry.isDirectory()) files.push(...await walk(absolute, root));
    else if (entry.isFile()) {
      const stat = await lstat(absolute);
      files.push({ absolute, relative, symbolicLink: false, size: stat.size });
    }
  }
  return files;
}

async function readJson(absolute, relative, findings) {
  try {
    return JSON.parse(await readFile(absolute, "utf8"));
  } catch (error) {
    findings.push(`${relative}: invalid JSON (${error.message})`);
    return null;
  }
}

export async function runBoundaryChecks({ root = ROOT, release = false } = {}) {
  const findings = [];
  const files = await walk(root);
  const byPath = new Map(files.map((file) => [file.relative, file]));

  for (const required of REQUIRED_REPOSITORY_FILES) {
    if (!byPath.has(required)) findings.push(`${required}: required public repository file is missing`);
  }
  if (release) {
    for (const required of REQUIRED_RELEASE_FILES) {
      if (!byPath.has(required)) findings.push(`${required}: required Obsidian release file is missing`);
    }
  }

  for (const file of files) {
    const basename = path.basename(file.relative).toLowerCase();
    if (file.symbolicLink) {
      findings.push(`${file.relative}: symbolic links are not allowed in the public package`);
      continue;
    }
    if (FORBIDDEN_BASENAMES.has(basename)) findings.push(`${file.relative}: runtime state or environment file is forbidden`);
    if (file.size > MAX_PUBLIC_FILE_BYTES && file.relative !== "main.js") {
      findings.push(`${file.relative}: public file exceeds ${MAX_PUBLIC_FILE_BYTES} bytes`);
    }

    const extension = path.extname(file.relative).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension) && !["LICENSE", ".gitignore"].includes(file.relative)) continue;
    const text = await readFile(file.absolute, "utf8");
    findings.push(...scanText(file.relative, text));

    if (extension === ".json") {
      const parsed = await readJson(file.absolute, file.relative, findings);
      const fixtureForSchema = {
        "aethergraph.v3": SYNTHETIC_FIXTURE,
        "aethergraph.v4": SYNTHETIC_V4_FIXTURE,
        "aethergraph.projection-source.v1": SYNTHETIC_PROVIDER_FIXTURE
      };
      if (parsed?.schema && Object.hasOwn(fixtureForSchema, parsed.schema)
          && file.relative !== fixtureForSchema[parsed.schema]) {
        findings.push(`${file.relative}: non-synthetic ${parsed.schema} payload is forbidden`);
      }
      if (["aethergraph.ai.v1", "aethergraph.ai.compact.v1"].includes(parsed?.schema)) {
        findings.push(`${file.relative}: generated synthesis or AI payload is forbidden`);
      }
    }
  }

  const manifestFile = byPath.get("manifest.json");
  const versionsFile = byPath.get("versions.json");
  const fixtureFile = byPath.get(SYNTHETIC_FIXTURE);
  const providerFixtureFile = byPath.get(SYNTHETIC_PROVIDER_FIXTURE);
  const schemaFile = byPath.get("schemas/aethergraph-v3.schema.json");

  if (manifestFile) {
    const manifest = await readJson(manifestFile.absolute, manifestFile.relative, findings);
    if (manifest) findings.push(...validateManifest(manifest));
    if (manifest && versionsFile) {
      const versions = await readJson(versionsFile.absolute, versionsFile.relative, findings);
      if (versions?.[manifest.version] !== manifest.minAppVersion) {
        findings.push("versions.json: beta version must map to manifest minAppVersion");
      }
    }
  }
  if (fixtureFile) {
    const graph = await readJson(fixtureFile.absolute, fixtureFile.relative, findings);
    if (graph) findings.push(...validateGraph(graph));
  }
  if (fixtureFile && providerFixtureFile) {
    const graph = await readJson(fixtureFile.absolute, fixtureFile.relative, findings);
    const providerText = await readFile(providerFixtureFile.absolute, "utf8");
    const provider = parseProjectionSource(providerText);
    if (provider.codes.length) findings.push(`${SYNTHETIC_PROVIDER_FIXTURE}: ${provider.codes.join(", ")}`);
    if (graph && provider.document) {
      const base = provider.document.base;
      const synthesized = synthesizeGraph({
        graph,
        providers: [provider],
        baseGraphSha256: base.graph_sha256,
        agentIndexSha256: base.agent_index_sha256
      });
      const region = synthesized.synthesis.regions.find((item) => item.id === provider.document.provider_id);
      if (region?.status !== "active") {
        findings.push(`${SYNTHETIC_PROVIDER_FIXTURE}: fixture provider must be active after validation`);
      }
    }
  }
  if (schemaFile) {
    const schema = await readJson(schemaFile.absolute, schemaFile.relative, findings);
    if (schema?.$schema !== "https://json-schema.org/draft/2020-12/schema") {
      findings.push("schemas/aethergraph-v3.schema.json: expected JSON Schema draft 2020-12");
    }
  }
  for (const relative of REQUIRED_REPOSITORY_FILES.filter((item) => item.startsWith("schemas/"))) {
    const file = byPath.get(relative);
    if (!file) continue;
    const schema = await readJson(file.absolute, file.relative, findings);
    if (schema?.$schema !== "https://json-schema.org/draft/2020-12/schema") {
      findings.push(`${relative}: expected JSON Schema draft 2020-12`);
    }
  }

  return findings;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const release = process.argv.includes("--release");
  const findings = await runBoundaryChecks({ release });
  if (findings.length) {
    console.error(`Public-boundary check failed with ${findings.length} finding(s):`);
    for (const finding of findings) console.error(`- ${finding}`);
    process.exitCode = 1;
  } else {
    console.log(`Public-boundary check passed (${release ? "release" : "repository"} mode).`);
  }
}
