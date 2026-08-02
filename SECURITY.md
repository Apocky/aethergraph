# Security policy

## Supported versions

Security fixes are provided for the latest 0.1.x beta release.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/Apocky/aethergraph/security/advisories/new) for security or privacy issues. Do not include vault content, filenames, note titles, tags, or other private material in a public issue.

For non-sensitive defects, open a GitHub issue with the smallest synthetic reproduction possible.

## Security boundary

Aethergraph runs inside Obsidian and can inspect the vault data needed to draw its graph. Treat plugin installation as permission to read that vault locally. The plugin does not grant permission to publish, upload, or redistribute vault material.

The release process rejects common secret formats, absolute user-profile paths, runtime state, and non-synthetic graph payloads. These checks reduce risk but do not replace human review.
