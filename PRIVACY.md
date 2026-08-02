# Privacy

Aethergraph is local-first. The distributed plugin contains no vault, graph payload, user configuration, or diagnostic state.

## What the plugin reads

To draw a graph, Aethergraph can read note metadata available through Obsidian and a local Aethergraph v3 payload. That data may include local paths, display titles, tags, topics, and connection evidence. It stays in the local Obsidian environment unless the user separately exports or shares it.

## Network behavior

Aethergraph does not send analytics or diagnostic data to a remote service. It does not require an account.

## Diagnostics

Diagnostics are disabled by default. When a user explicitly enables them, Aethergraph retains only a bounded local diagnostic stream. Diagnostic references are salted locally; note bodies, titles, tags, and source paths are not diagnostic fields. Nodes marked `withhold_from_telemetry`, and nodes with missing or unrecognized privacy metadata, receive no stable diagnostic reference.

Disabling diagnostics stops new collection and clears retained diagnostic events, frame samples, errors, and identity references. Removing the plugin directory removes the distributed code; remove the plugin's local settings through Obsidian if you also want to clear its local configuration.

## Sharing and exports

A label such as `shareable` describes a local policy decision; it is not consent or legal authority to publish a note. Review every export independently. Synthetic examples are the only graph data included in this repository.
