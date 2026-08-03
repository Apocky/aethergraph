# Security policy

## Supported versions

Security fixes are provided for the latest 0.3.x release.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/Apocky/aethergraph/security/advisories/new) for security or privacy issues. Do not include vault content, filenames, note titles, tags, or other private material in a public issue.

For non-sensitive defects, open a GitHub issue with the smallest synthetic reproduction possible.

## Security boundary

Aethergraph runs inside Obsidian and can inspect the vault data needed to draw its graph. Treat plugin installation as permission to read that vault locally. The plugin does not grant permission to publish, upload, or redistribute vault material.

The release process rejects common secret formats, absolute user-profile paths, runtime state, and non-synthetic graph payloads. These checks reduce risk but do not replace human review.

Projection-source files are untrusted local inputs. The offline synthesizer validates exact
envelope and contribution fields, byte and row limits, base hashes, agent-safe document IDs,
score ranges, and controlled vocabularies before a contribution can affect the graph. Externally
asserted verified evidence is downgraded to reported evidence. A rejected source has zero
provider influence, remains visible as a degraded receipt, and cannot erase independently valid
sources.

Renderer input is capped at 128 MiB. Each projection source is capped at 1 MiB; one synthesis run
accepts at most 32 sources and 4,096 contributions per source. Base-graph and agent-index inputs
are bounded and hashed without being copied into the output. The CLI rejects duplicate output
paths and input/output aliases after lexical path resolution; it does not resolve filesystem-link
aliases. Each output is written through an exclusively created temporary file, synchronized, then renamed.
Temporary-file mode is `0600` where the platform honors POSIX modes.

The Obsidian runtime never opens a memory store, holds a provider credential, or performs a
network request. Active-recall query text remains transient and is not written to settings or
payloads. The runtime contains no client telemetry or persistent diagnostic sink.
