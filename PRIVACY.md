# Privacy

Aethergraph is local-first. The distributed plugin contains no vault, graph payload, user configuration, or diagnostic state.

## What the plugin reads

To draw a graph, Aethergraph can read note metadata available through Obsidian and a local Aethergraph v3 or v4 payload. That data may include local paths, display titles, tags, topics, controlled subjects, contextual frames, and connection evidence. It stays in the local Obsidian environment unless the user separately exports or shares it.

The optional synthesizer runs outside the plugin. It accepts bounded, hash-bound projection
files and never needs direct access to a memory service. Public releases contain only code,
schemas, and invented fixtures. They do not contain projection files or generated graphs.

## Network behavior

Aethergraph does not send analytics or diagnostic data to a remote service. It does not require an account.

The plugin contains no network client. Task-conditioned recall is computed locally from the
loaded graph and the text currently typed into the local filter. Filter text is not persisted
in the payload or diagnostic stream.

## Diagnostics

Diagnostics are disabled by default. When a user explicitly enables them, Aethergraph retains only a bounded local diagnostic stream. Diagnostic references are salted locally; note bodies, titles, tags, and source paths are not diagnostic fields. Nodes marked `withhold_from_telemetry`, and nodes with missing or unrecognized privacy metadata, receive no stable diagnostic reference.

Disabling diagnostics stops new collection and clears retained diagnostic events, frame samples, errors, and identity references. Removing the plugin directory removes the distributed code; remove the plugin's local settings through Obsidian if you also want to clear its local configuration.

## Sharing and exports

A label such as `agent-safe` or `shareable` describes a local processing rule; it is not consent or legal authority to publish a note. The canonical AI JSONL exporter excludes non-agent-safe nodes by default, but every export still requires independent review. Synthetic examples are the only graph data included in this repository.
