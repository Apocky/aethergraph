# Aethergraph

Aethergraph is a local-first Obsidian graph view designed to show fewer, clearer, and more explainable relationships between notes.

Version 0.3.0 is a public desktop release. It contains plugin source, reproducible release tooling, an offline synthesis tool, schemas, and synthetic test data only—never a user's vault, generated graph, provider projection, settings, or repository history from another project.

## What makes a connection meaningful

Aethergraph treats declared tags as one signal, not as a complete map of a document's subject. Two notes with no shared tag have **no shared declared tag**; that fact alone does not prove they belong to different domains.

Displayed connections can combine several local signals, including explicit links, normalized tags, topical terms, curated relationships, and corroborating document metadata. Each edge carries a presentation tier and a reason code:

- **Primary** — the strongest, most useful relationships for the focused note.
- **Context** — relevant supporting relationships that add framing.
- **Archive** — lower-priority or historical relationships available when broader recall is useful.

The interface can progressively reveal these tiers instead of drawing every candidate edge at once. A connection score is a ranking aid, not a claim of truth, authorship, consent, or publication authority.

Large MOCs and indexes remain complete, searchable document collections without dominating the canvas. Aethergraph keeps every typed relationship available in the connection browser, while deterministically limiting structural hub spokes to 24 Context or 12 Archive representatives per hub. Primary relationships are never hub-capped. The status line distinguishes **visualized** relationships from the complete **typed** count.

At broad zoom levels, nearby notes pool into soft semantic light regions with one crisp representative label. Labels are selected from document-grounded subjects, topics, tags, and facets using visible-corpus specificity; structural folder contexts cannot become repeated topical headings. Labels are globally deduplicated, measured for collision, and limited to an adaptive 18–48 per viewport. Zooming in resolves pools back toward individual document titles.

On first run, no generator is required: Aethergraph builds an in-memory graph from Obsidian's metadata cache and shows only authored note links. Frontmatter titles and H1 headings improve labels; tags remain labels and search metadata, but shared tags alone never create a connection. An optional validated `aethergraph.v3` or `aethergraph.v4` payload at `.aethergraph/aethergraph.json` can add qualified semantic and contextual relations.

## Holistic memory synthesis

V4 adds an offline modulation organ rather than a flat database merge. It produces a bounded resting receipt for the saved payload, while the plugin derives transient active-recall state from the current query. Together they can:

- recruit typed projection regions from exact base snapshots, source confidence, freshness, coverage, and node-level region attribution;
- reject malformed, mismatched, degraded, inactive, private-target, or unknown-target inputs; deduplicate overlapping lineages; and cap provider counts and rows, provider-created edges and degrees, and the resting node and token working set;
- keep subject, context, relevance, importance, task utility, activation, confidence, and epistemic status distinct;
- preserve contradictions, omissions, and degraded regions instead of averaging them into false consensus; and
- allocate a bounded working set for the renderer and machine-ingest output.

Projection sources contribute typed metadata tied to stable document IDs and exact base hashes. They do not send prose prompts or recalled document bodies into the renderer. Projection-only relationships are emitted only as Context or Archive; the synthesizer never upgrades them to Primary.

Typing into the plugin's **recall** field activates direct matches and spreads bounded activation through one hop of typed relationships. Primary connections carry more activation than Context, and Archive carries the least. An adaptive deterministic working-set budget stays within the declared resting limit and suppresses the long tail. The query text remains only in the open view and is not written to settings or payloads.

## Install

After Aethergraph is approved in the Obsidian community directory, install it from **Settings → Community plugins → Browse** and search for **Aethergraph**.

For the current release package:

1. Download the release archive from the [GitHub releases page](https://github.com/Apocky/aethergraph/releases).
2. Extract it into `<your-vault>/.obsidian/plugins/aethergraph/`.
3. Confirm that `main.js`, `manifest.json`, and `styles.css` are directly inside that directory.
4. In Obsidian, open **Settings → Community plugins**, reload installed plugins, and enable **Aethergraph**.

The release is desktop-only while mobile behavior remains unverified. Back up important vaults and test the plugin on a copy before relying on it in a primary workspace.

## Local data and privacy

Aethergraph reads graph inputs inside Obsidian and renders them locally. It does not require an account, make network requests, implement analytics, or collect client telemetry.

The **Check graph health** command reads current renderer and payload state on demand, displays a transient Obsidian notice, and writes nothing. The legacy `withhold_from_telemetry` payload field is retained for schema compatibility and is treated as an additional exclusion from machine-ingest exports; the plugin has no telemetry subsystem. See [PRIVACY.md](PRIVACY.md) for the full boundary.

## Navigation

- Single-click a node to focus it and inspect its evidence.
- Double-click or Ctrl/Cmd-click a node to open the exact vault file.
- Connection titles and displayed paths open their exact Markdown targets; the adjacent **Focus** button stays in the graph.
- **Browse all typed connections** opens a searchable, incremental list, including relationships omitted from the visual budget.
- Heading and block fragments such as `Note.md#Heading` or `Note.md#^block-id` are preserved when a payload supplies them. Missing or unsafe targets fail closed with a notice.

## Aethergraph v3 and v4 data models

The v3 payload is an indexed, compact graph:

- `nodes` contains document labels, topics, facets, provenance state, and privacy policy.
- `edge_fields` defines the position of every value in compact rows.
- `explicit` contains observed or curated connections.
- `latent` contains inferred candidates that satisfy the renderer's evidence gates.
- `ghosts` describes aggregate context without turning it into a document node.
- `severed` records intentionally suppressed pairs and their local rationale.

Each compact edge has the fields `a`, `b`, `weight`, `facet`, `reach`, `span`, `facet_gap`, `relevance`, `reason`, `signals`, and `presentation`. `a` and `b` are indexes into `nodes`; vocabulary indexes resolve through the corresponding top-level vocabulary arrays. The `presentation` value is `primary`, `context`, or `archive`.

`facet_gap` is deliberately tri-state:

- `-1` — unknown because one or both endpoints lack controlled facets.
- `0` — the endpoints share at least one controlled facet.
- `1` — both endpoints have controlled facets and their facet sets are known-disjoint.

Even `facet_gap = 1` is not a domain-crossing claim. It says only that two non-empty controlled-facet sets are disjoint.

V4 retains that compact edge contract and adds a bounded `synthesis` receipt plus a synthesis summary on each node. A node can therefore expose controlled subjects and contexts, scoped importance and utility, current activation, confidence components, independent support counts, and residual codes without pretending any one score is truth.

The normative shapes are [v3](schemas/aethergraph-v3.schema.json), [v4](schemas/aethergraph-v4.schema.json), and the [projection-source contract](schemas/aethergraph-projection-source-v1.schema.json). Their fixtures use invented documents, providers, IDs, and paths.

## LLM, DI, and AI ingest output

The offline synthesizer can derive two streaming representations from the same validated synthesis:

- `aethergraph.ai.v1` JSONL is canonical and lossless for the agent-safe projection it emits. It uses explicit keys and emits `manifest`, `source` (region receipt), `residual`, `node`, `relation`, `ghost`, and `severed` records; subjects and contexts remain on their node records.
- `aethergraph.ai.compact.v1` JSONL is a reversible dictionary-coded companion intended for token-dense contexts. Its first line defines every code needed to expand it back to the canonical records.

The normative shapes are the [canonical AI schema](schemas/aethergraph-ai-v1.schema.json) and [compact AI schema](schemas/aethergraph-ai-compact-v1.schema.json).

The compact form is never the truth source, and lossy abbreviation is not used for canonical interchange. Only `agent-safe` nodes not marked `withhold_from_telemetry` enter either AI stream. Review any local output before sharing it.

The renderer graph is required. Base-graph and agent-index files are read only to bind their SHA-256 hashes; projection sources remain separate, repeatable `--provider` inputs. This example writes all three outputs:

```powershell
node tools/synthesize.mjs `
  --graph path/to/aethergraph-v3.json `
  --base-graph path/to/agent-safe-graph.json `
  --agent-index path/to/agent-index.jsonl `
  --provider path/to/projection-source.json `
  --out path/to/aethergraph-v4.json `
  --ai-out path/to/aethergraph.ai.jsonl `
  --compact-out path/to/aethergraph.ai.compact.jsonl
```

Run the built-in help for every accepted option:

```powershell
npm run synthesize -- --help
```

## Development

The repository has no runtime npm dependencies. Node.js 20 or newer is sufficient. `main.js` is a minified release artifact and is intentionally not committed.

```powershell
npm ci
npm run build
npm test
npm run check:public
npm run check:release
```

`check:public` scans the repository boundary and validates the manifest, public schemas, and synthetic v3, v4, projection, and AI fixtures. `check:release` also requires the three Obsidian release files.

## Status and limitations

- Public release: interfaces and ranking behavior may change before 1.0.
- Desktop only until mobile behavior is tested.
- Labels and topics remain only as good as the source document metadata and local extraction.
- Semantic relevance is probabilistic; inspect the displayed reasons before acting on a connection.
- More projection sources can amplify duplicated noise; lineage deduplication and visible inhibition reduce that risk but do not eliminate the need for evaluation.
- The offline synthesizer gives rejected, degraded, and inactive provider receipts zero influence while keeping their status visible. Availability is not evidence, consent, truth, or effect authority.
- Saved v4 output contains a resting synthesis receipt. Task-conditioned regional recruitment is transient in the open plugin view and is not written back to that payload.
- A privacy label is a processing rule, not consent or authority to share content.

Security reports belong in [private vulnerability reporting](https://github.com/Apocky/aethergraph/security/advisories/new). Non-sensitive bugs and synthetic reproductions can use GitHub issues.

## License

Aethergraph is released under the [MIT License](LICENSE).
