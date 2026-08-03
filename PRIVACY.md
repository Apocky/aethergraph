# Privacy

Aethergraph is local-first. The distributed plugin contains no vault, graph payload, user configuration, or usage state.

## What the plugin reads

To draw a graph, Aethergraph can read note metadata available through Obsidian and a local Aethergraph v3 or v4 payload. That data may include local paths, display titles, tags, topics, controlled subjects, contextual frames, and connection evidence. It stays in the local Obsidian environment unless the user separately exports or shares it.

The optional synthesizer runs outside the plugin. It accepts bounded, hash-bound projection
files and never needs direct access to a memory service. Public releases contain only code,
schemas, and invented fixtures. They do not contain projection files or generated graphs.

## Network behavior

Aethergraph does not make network requests, send analytics, collect client telemetry, or require an account.

The plugin contains no network client. Task-conditioned recall is computed locally from the
loaded graph and the text currently typed into the local filter. Filter text is not persisted.

## On-demand health check

The **Check graph health** command reads the current renderer and payload state only when invoked, shows a transient Obsidian notice, and does not retain or write an event stream. The legacy `withhold_from_telemetry` field remains in the data contract for compatibility and is treated as an additional machine-export exclusion; it does not activate any telemetry behavior.

Removing the plugin directory removes the distributed code; remove the plugin's local settings through Obsidian if you also want to clear its view preferences.

## Sharing and exports

A label such as `agent-safe` or `shareable` describes a local processing rule; it is not consent or legal authority to publish a note. The canonical AI JSONL exporter excludes non-agent-safe nodes by default, but every export still requires independent review. Synthetic examples are the only graph data included in this repository.
