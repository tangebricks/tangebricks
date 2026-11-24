# Task File Fixture for Story Gate Tests

#### [ ] UC9.1 — Case A Done with no provenance
**Status:** done · **Size:** S · **Depends on:** — · **Findings:** F-TRUST-4

Goal: Test story with no provenance comment.

#### [ ] UC0.4 — Case B Done with docs only commits
**Status:** done · **Size:** S · **Depends on:** — · **Findings:** F-TRUST-4
<!-- provenance: { "agent": "Amelia (Dev)", "model": "claude-opus-5-5", "commits": ["c8e8a9c"] } -->

Goal: Test story whose commit touches only Markdown.

#### [ ] UC9.1 — Case C Done citing base commit
**Status:** done · **Size:** S · **Depends on:** — · **Findings:** F-TRUST-4
<!-- provenance: { "agent": "Amelia (Dev)", "model": "claude-opus-5-5", "commits": ["86544e8"] } -->

Goal: Test story citing base commit 86544e8 whose subject does not start with UC9.1:.

#### [ ] UC9.2 — Case D Review missing model
**Status:** review · **Size:** S · **Depends on:** — · **Findings:** F-TRUST-4
<!-- provenance: { "agent": "Amelia (Dev)", "commits": ["c8e8a9c"] } -->

Goal: Test story with review status missing model.

#### [ ] UC0.1 — Case E Valid done story
**Status:** done · **Size:** S · **Depends on:** — · **Findings:** F-TRUST-4
<!-- provenance: { "agent": "Sofia/Bob (BMAD Method)", "model": "Gemini 3.8 Flash (High)", "commits": ["63a8be2", "2332f00", "b4294d1"] } -->

Goal: Valid done story with code diff and matching commit subjects.

#### [ ] UC9.3 — Case F Todo story
**Status:** todo · **Size:** S · **Depends on:** — · **Findings:** F-TRUST-4

Goal: Todo story skipped.

#### [ ] UC9.4 — Case F In-progress story
**Status:** in-progress · **Size:** S · **Depends on:** — · **Findings:** F-TRUST-4

Goal: In-progress story skipped.
