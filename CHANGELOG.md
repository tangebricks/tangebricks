# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches 1.0.

## [Unreleased]

Phase 0 (trust fixes) stories merged so far:

- 0.2: Apache-2.0 licence, SECURITY.md and secret and dependency scanners.
- 0.3: Threat model and a security sweep of the code the audit had not read.
- 0.4: Every brick uses the verified workspace, never one supplied by the caller.
- 0.5: Cross-tenant attack suite that attacks real sub-routes, with a known-failures registry.
- 0.6: Every admin and mutating route is authorised.
- 0.7: Workspace-scoped unique keys and a tenant lint that parses WHERE clauses.
- 0.8: No fallback secrets in source; SSRF guards on user-supplied URLs.
- 0.9: No fabricated success; the checkout "complete" bypass is removed.
- 0.11: Unsafe and stub bricks are quarantined and hidden from the default catalog.
- 0.15: Per-project scoped MCP tokens replace the shared bearer.
- 0.16: Every studio-api query is scoped to its organisation and project.
- 0.17: Generated apps' entity tables live outside the Studio database.
- 0.18: `poc_graphs` is workspace-scoped; no shared-key graph writes.
- 0.12: Honest README with an evidence-generated "What works today" section, live-evidence integrity record and check, `release:check`, and this changelog.
- 0.14: Hardened auth sessions: secure cookies, hashed session tokens, stricter JWT checks, CSRF, CORS and WebSocket origin checks.

Public repository:

- The project is public as `tangebricks/tangebricks`, starting from a single import commit of the private proof-of-concept repository. Earlier commits, tags and pull request numbers refer to that private history.
- Frozen evidence that cites private commits is listed in `scripts/pre-public-commits.json`; `evidence:check` accepts those SHAs only for the files listed.
- Retired `docs:stats` and its frozen 2026-10 stats line in the README; the generated "What works today" section replaces it.
- Retired the central task file and the internal planning notes; `stories:gate` skips the task file when it is absent.

## [0.1.0] - 2026-11-21

- Proof of concept merged to `main` in the private pre-public repository (story 0.1): the hypothesis register, its evidence and `PROOF.md`, the bricks, assembler, runtime, deploy tooling, MCP endpoint and studio, with a green CI gate.

[Unreleased]: https://github.com/tangebricks/tangebricks/commits/main
