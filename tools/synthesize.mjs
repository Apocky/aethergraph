#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_LIMITS,
  canonicalStringify,
  encodeAiJsonl,
  encodeCompactJsonl,
  parseProjectionSource,
  sha256Hex,
  synthesizeGraph
} from "./synthesis-core.mjs";

function usage() {
  return [
    "Usage: node tools/synthesize.mjs --graph <renderer.json> --out <v4.json>",
    "  [--base-graph <agent-safe-graph.json> | --base-graph-sha256 <hex>]",
    "  [--agent-index <agent-safe-index.jsonl> | --agent-index-sha256 <hex>]",
    "  [--provider <projection.json>]... [--ai-out <records.jsonl>]",
    "  [--compact-out <compact.jsonl>]"
  ].join("\n");
}

export function parseArgs(argv) {
  const result = { providers: [] };
  const single = new Set([
    "graph", "out", "base-graph", "base-graph-sha256", "agent-index",
    "agent-index-sha256", "ai-out", "compact-out"
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") return { help: true, providers: [] };
    if (!token.startsWith("--")) throw new TypeError(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError(`missing value for --${key}`);
    index += 1;
    if (key === "provider") result.providers.push(value);
    else if (single.has(key)) {
      if (Object.hasOwn(result, key)) throw new TypeError(`duplicate --${key}`);
      result[key] = value;
    } else throw new TypeError(`unknown option: --${key}`);
  }
  if (!result.graph || !result.out) throw new TypeError("--graph and --out are required");
  if (result["base-graph"] && result["base-graph-sha256"]) {
    throw new TypeError("use --base-graph or --base-graph-sha256, not both");
  }
  if (result["agent-index"] && result["agent-index-sha256"]) {
    throw new TypeError("use --agent-index or --agent-index-sha256, not both");
  }
  assertDistinctPaths(result);
  return result;
}

async function hashBoundedFile(filePath, maximumBytes = 64 * 1024 * 1024) {
  const info = await stat(filePath);
  if (!info.isFile()) throw new TypeError("hash input must be a regular file");
  if (info.size > maximumBytes) throw new RangeError(`hash input exceeds ${maximumBytes} bytes`);
  const digest = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return digest.digest("hex");
}

let temporarySequence = 0;

export async function atomicWrite(filePath, bytes) {
  const destination = path.resolve(filePath);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = path.join(path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${temporarySequence += 1}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, destination);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function assertDistinctPaths(args) {
  const inputs = [args.graph, args["base-graph"], args["agent-index"], ...args.providers]
    .filter(Boolean).map((item) => path.resolve(item));
  const outputs = [args.out, args["ai-out"], args["compact-out"]]
    .filter(Boolean).map((item) => path.resolve(item));
  const key = (item) => process.platform === "win32" ? item.toLowerCase() : item;
  const inputKeys = new Set(inputs.map(key));
  const outputKeys = outputs.map(key);
  if (new Set(outputKeys).size !== outputKeys.length) throw new TypeError("output paths must be distinct");
  if (outputKeys.some((item) => inputKeys.has(item))) throw new TypeError("output paths must not alias inputs");
}

export async function runCli(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return { help: true };
  }
  assertDistinctPaths(args);
  const rendererInfo = await stat(args.graph);
  if (!rendererInfo.isFile()) throw new TypeError("renderer graph must be a regular file");
  if (rendererInfo.size > 64 * 1024 * 1024) throw new RangeError("renderer graph exceeds 64 MiB");
  const rendererBytes = await readFile(args.graph);
  const rendererText = rendererBytes.toString("utf8");
  const graph = JSON.parse(rendererText);
  const providerPaths = [...args.providers].sort((a, b) => a.localeCompare(b));
  if (providerPaths.length > DEFAULT_LIMITS.providers) {
    throw new RangeError(`provider limit is ${DEFAULT_LIMITS.providers}`);
  }
  const providers = [];
  for (const providerPath of providerPaths) {
    const providerInfo = await stat(providerPath);
    if (!providerInfo.isFile()) throw new TypeError("provider input must be a regular file");
    if (providerInfo.size > DEFAULT_LIMITS.providerBytes) {
      providers.push({ document: null, sourceHash: "0".repeat(64), codes: ["provider-too-large"] });
      continue;
    }
    const text = await readFile(providerPath, "utf8");
    providers.push(parseProjectionSource(text));
  }
  const baseGraphSha256 = args["base-graph"]
    ? await hashBoundedFile(args["base-graph"]) : args["base-graph-sha256"] ?? null;
  const agentIndexSha256 = args["agent-index"]
    ? await hashBoundedFile(args["agent-index"]) : args["agent-index-sha256"] ?? null;
  const output = synthesizeGraph({
    graph,
    providers,
    rendererGraphSha256: sha256Hex(rendererBytes),
    baseGraphSha256,
    agentIndexSha256
  });
  const graphText = `${canonicalStringify(output)}\n`;
  let aiText = null;
  if (args["ai-out"] || args["compact-out"]) aiText = encodeAiJsonl(output);
  const compactText = args["compact-out"] ? encodeCompactJsonl(aiText) : null;
  await atomicWrite(args.out, graphText);
  if (args["ai-out"]) await atomicWrite(args["ai-out"], aiText);
  if (args["compact-out"]) await atomicWrite(args["compact-out"], compactText);
  return {
    graph_sha256: sha256Hex(graphText),
    ai_sha256: aiText ? sha256Hex(aiText) : null,
    regions: output.synthesis.regions.length,
    selected_nodes: output.synthesis.budget.selected_nodes,
    selected_edges: output.synthesis.budget.selected_edges
  };
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const result = await runCli(process.argv.slice(2));
    if (!result.help) process.stdout.write(`${canonicalStringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}\n`);
    process.exitCode = 1;
  }
}
