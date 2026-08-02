# Aethergraph

Aethergraph is a local-first Obsidian graph view designed to show fewer, clearer, and more explainable relationships between notes.

Version 0.1.0 is a public desktop beta. It contains plugin code and synthetic test data only—never a user's vault, generated graph, settings, diagnostic state, or repository history from another project.

## What makes a connection meaningful

Aethergraph treats declared tags as one signal, not as a complete map of a document's subject. Two notes with no shared tag have **no shared declared tag**; that fact alone does not prove they belong to different domains.

Displayed connections can combine several local signals, including explicit links, normalized tags, topical terms, curated relationships, and corroborating document metadata. Each edge carries a presentation tier and a reason code:

- **Primary** — the strongest, most useful relationships for the focused note.
- **Context** — relevant supporting relationships that add framing.
- **Archive** — lower-priority or historical relationships available when broader recall is useful.

The interface can progressively reveal these tiers instead of drawing every candidate edge at once. A connection score is a ranking aid, not a claim of truth, authorship, consent, or publication authority.

On first run, no generator is required: Aethergraph builds an in-memory graph from Obsidian's metadata cache and shows only authored note links. Frontmatter titles and H1 headings improve labels; tags remain labels and search metadata, but shared tags alone never create a connection. An optional validated `aethergraph.v3` payload at `.aethergraph/aethergraph.json` can add qualified semantic and contextual relations.

## Install the public beta

1. Download the release archive from the [GitHub releases page](https://github.com/Apocky/aethergraph/releases).
2. Extract it into `<your-vault>/.obsidian/plugins/aethergraph/`.
3. Confirm that `main.js`, `manifest.json`, and `styles.css` are directly inside that directory.
4. In Obsidian, open **Settings → Community plugins**, reload installed plugins, and enable **Aethergraph**.

The beta is desktop-only while mobile behavior remains unverified. Back up important vaults and test the plugin on a copy before relying on it in a primary workspace.

## Local data and diagnostics

Aethergraph reads graph inputs inside Obsidian and renders them locally. It does not require an account and does not send analytics or diagnostics to a remote service.

Diagnostics are off by default. Explicitly enabling them creates only a bounded local diagnostic stream. References are locally salted, and note bodies, titles, tags, and source paths are not diagnostic fields. Unknown privacy lanes and nodes marked `withhold_from_telemetry` receive no stable diagnostic reference. See [PRIVACY.md](PRIVACY.md) for the full boundary.

## Aethergraph v3 data model

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

The normative machine-readable shape is in [schemas/aethergraph-v3.schema.json](schemas/aethergraph-v3.schema.json). [tests/fixtures/aethergraph-v3.synthetic.json](tests/fixtures/aethergraph-v3.synthetic.json) demonstrates all three presentation tiers with invented documents and paths.

## Development checks

The repository intentionally has no runtime npm dependencies. Node.js 20 or newer is sufficient.

```powershell
npm test
npm run check:public
npm run check:release
```

`check:public` scans the repository and validates the manifest and synthetic fixture. `check:release` also requires and validates the three Obsidian release files.

## Status and limitations

- Public beta: interfaces and ranking behavior may change.
- Desktop only until mobile behavior is tested.
- Labels and topics remain only as good as the source document metadata and local extraction.
- Semantic relevance is probabilistic; inspect the displayed reasons before acting on a connection.
- A privacy label is a processing rule, not consent or authority to share content.

Security reports belong in [private vulnerability reporting](https://github.com/Apocky/aethergraph/security/advisories/new). Non-sensitive bugs and synthetic reproductions can use GitHub issues.

## License

Aethergraph is released under the [MIT License](LICENSE).
