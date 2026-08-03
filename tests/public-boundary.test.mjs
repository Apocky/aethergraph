import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  ROOT,
  runBoundaryChecks,
  scanText,
  validateGraph
} from "../scripts/check-public-boundary.mjs";

test("synthetic v3 fixture exercises all public semantics", async () => {
  const fixturePath = path.join(ROOT, "tests", "fixtures", "aethergraph-v3.synthetic.json");
  const graph = JSON.parse(await readFile(fixturePath, "utf8"));
  assert.deepEqual(validateGraph(graph), []);
  assert.equal(graph.nodes.some((node) => node.withhold_from_telemetry), true);
  assert.deepEqual(
    [...new Set([...graph.explicit, ...graph.latent].map((edge) => edge[10]))].sort(),
    ["archive", "context", "primary"]
  );
  assert.deepEqual(
    [...new Set([...graph.explicit, ...graph.latent].map((edge) => edge[6]))].sort((a, b) => a - b),
    [-1, 0, 1]
  );
});

test("scanner recognizes high-risk material without a live example in the repository", () => {
  const windowsPath = ["C:", "Users", "Example", "Notes", "private.md"].join("\\");
  const githubToken = ["gh", "p_", "A".repeat(40)].join("");
  const privateKeyHeader = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");

  assert.match(scanText("sample.txt", windowsPath).join("\n"), /user-profile path/);
  assert.match(scanText("sample.txt", githubToken).join("\n"), /GitHub access token/);
  assert.match(scanText("sample.txt", privateKeyHeader).join("\n"), /private-key material/);
  assert.match(scanText("sample.txt", ["vault", "sync"].join("")).join("\n"), /private generator/);
  assert.match(scanText("sample.txt", ["03", "research", "ai", "conversations"].join("-")).join("\n"),
    /private corpus/);
  assert.match(scanText("main.js", `${["fet", "ch"].join("")}(url)`).join("\n"), /network fetch/);
});

test("repository passes the public boundary in scaffold mode", async () => {
  assert.deepEqual(await runBoundaryChecks({ release: false }), []);
});
