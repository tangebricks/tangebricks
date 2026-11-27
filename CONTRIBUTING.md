# Contributing

Thanks for your interest in projectx-poc.

## Before you open a pull request

1. Install dependencies: `pnpm install --frozen-lockfile` (Node 24, pnpm 10.18.0).
2. Run the local gate: `pnpm check:changed`. It typechecks the workspace and runs the tests affected by your change. It must exit 0.
3. Open the pull request against `main`. CI and the `Security` workflow run on every pull request into `main`.

## Coverage of the money and auth code

`pnpm coverage:money` runs the tests of the money and auth bricks (credit-wallet, metered-usage,
checkout-gateway, subscription-plans, core-auth, llm-gateway) and `packages/gateway-adapters` with V8
coverage, prints a per-file table and writes `coverage/coverage-summary.json`. It fails when any brick falls
below its thresholds in `vitest.coverage.config.ts`. CI runs it in the `coverage` job, where the thresholds
are never rewritten.

Locally, `autoUpdate` raises a brick's thresholds (to whole percents) when your change adds coverage, by
editing `vitest.coverage.config.ts`. Commit that change with your pull request, so the floor moves up with
the code. Do not lower a threshold to make a run pass; add the missing tests. `pnpm coverage:proof` shows
that a run below a threshold fails.

## Formatting

The code is formatted with [Prettier](https://prettier.io/) (pinned in `package.json`, settings in
`.prettierrc.json`). Format the whole repository with:

```sh
pnpm format          # rewrites files in place
pnpm format:check    # changes nothing; fails if any file is not formatted (CI runs this)
```

`.prettierignore` lists what Prettier never touches: generated and recorded files (`evidence/`,
`catalog.json`, fixtures and so on), JSON (scripts write it and check it byte for byte), Markdown, and
the five H12 "no glue code" files whose sha256 the recorded live H12 run pinned. Do not format those by hand
either.

The repository was formatted in one mechanical commit, listed in `.git-blame-ignore-revs`. To keep
`git blame` pointing at the commits that really changed each line, run once in your clone:

```sh
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

## Import boundaries

`pnpm lint:deps` ([dependency-cruiser](https://github.com/sverweij/dependency-cruiser), settings in
`.dependency-cruiser.cjs`) checks what bricks, packages and apps may import. CI runs it in the `gates` job.

- A brick (`bricks/<id>/src`, `test`, `client`) imports its own files by relative path, and anything else only
  as a package: `@poc/sdk`, node built-ins, `cloudflare:*`, and packages its own `package.json` declares,
  through their entry point and `exports` (`@poc/credit-wallet`, not `@poc/credit-wallet/src/wallet.ts`).
- No brick imports a file in another brick's folder (`../../credit-wallet/src/...`), and no package does either.
- `packages/*` never import `apps/*`.

To use another package from a brick, declare it in that brick's `package.json`: `dependencies` when `src`
imports it at runtime, `devDependencies` when only tests or client code that is not shipped do. A client entry the
brick exports and ships (for example integration-connections' `"./client"`) declares `react` as a
`peerDependency`, plus a `devDependency` for its tests; only client code that is not exported or shipped may keep
`react` dev-only. Use `workspace:*` for `@poc/*`
packages and the exact version the root `package.json` pins for anything else (for example
`"vitest": "5.1.1"`), then run `pnpm install`. If the other brick does not export what you need, export it
from its entry point rather than importing the file.

`docs/import-boundaries.md` explains the rules and lists every existing exception. Do not add an exception
to get a change through; an exception names one file and the exact files it may import, with a reason.

## Unused code

`pnpm lint:unused` ([knip](https://knip.dev), settings in `knip.ts`) fails on unused files, exports, exported types,
duplicate exports and dependencies, and on dependencies a file imports without declaring them. CI runs it in the
`gates` job; it takes about 10 seconds.

When it names something:

- Delete it if nothing uses it: the file, the dependency (`pnpm remove`), or the `export` keyword when only its own
  file uses the symbol.
- If code reaches a file by path rather than by import (a spawned script, an esbuild entry, a generated import
  string), add the file to that workspace's `entry` in `knip.ts`, with a comment saying who loads it.
- Exports a brick manifest names (route factories, executors, capability exports, guards, handlers) are safe without
  any of this: they must be exported by the brick's package entry, and knip never reports an entry's exports.
- Only if it must stay anyway, add an entry to `scripts/lint-unused-allowlist.ts`: the file, the kind of finding and
  the exact names, with a reason that says why it stays (public API kept on purpose, used by name at run time, a proof
  input left as recorded). No globs and no whole-file entries. An entry that no longer matches a finding fails the
  gate, so delete it once the code is cleaned up.

## Sign your commits (DCO)

This project uses the [Developer Certificate of Origin 1.1](https://developercertificate.org/).
Every commit must carry a `Signed-off-by` line, which certifies that you wrote the change
or otherwise have the right to submit it under this project's licence. Add it with:

```sh
git commit -s
```

The `DCO` workflow checks this on every pull request into `main`. It fails when any commit in the
pull request (merge commits and `[bot]` authors excepted) lacks a `Signed-off-by: <Name> <email>`
line matching that commit's author name and email. Commits already on `main` are not checked.

The sign-off must name the commit's **author**. The commands below sign as the committer (your
`user.name` / `user.email`), so they fix only commits you authored. If a commit's author and
committer differ, the author must sign it off, or the commit must be re-authored
(`git commit --amend --reset-author -s --no-edit`). To fix your own commits and force-push:

```sh
git commit --amend -s --no-edit      # only the last commit
git rebase --signoff origin/main     # every commit on the branch
git push --force-with-lease
```

You can run the same check locally: `node scripts/check-dco.ts origin/main HEAD`.

Maintainers: add the `dco` check (shown as "DCO / dco") to the required status checks in the
`main` branch protection rule, so an unsigned pull request cannot be merged.

## Git hooks

`pnpm install` installs local git hooks with [lefthook](https://github.com/evilmartians/lefthook)
(`lefthook.yml`), through the `prepare` script (`scripts/install-hooks.mjs`). The script does nothing
when `CI` is set to a true value (anything but empty, `0` or `false`) or outside a git work tree, and never fails the install. To install the hooks again
by hand, run `pnpm exec lefthook install`.

- **pre-commit** runs, in this order:
  - `prettier --write` on the staged files, with `.prettierrc.json` and `.prettierignore`. The
    formatted files are re-staged.
  - `oxlint --fix` on the staged `.ts`, `.tsx`, `.js` and `.mjs` files, with the rules and ignore
    patterns in `.oxlintrc.json`. Its autofixes are re-staged; anything it cannot fix stops the commit.
  - `gitleaks` on the staged changes, with `.gitleaks.toml`. It uses `GITLEAKS_BIN` if set, otherwise
    `gitleaks` on your `PATH`. If gitleaks is not installed, the hook prints a warning and passes.
    The `Security` workflow's gitleaks job scans every pull request either way.
- **commit-msg** refuses a message without a `Signed-off-by` trailer naming the commit's author
  (`scripts/check-commit-msg.ts`, using the same rules as the `DCO` workflow). Fix it with `git commit -s`.
  Merge commits and `fixup!` / `squash!` / `amend!` commits are skipped locally, but the `DCO` check
  on the pull request still requires a sign-off on any `fixup!` / `squash!` / `amend!` commit you push
  without squashing it first.

Do not bypass the hooks with `--no-verify` (or `LEFTHOOK=0`). CI runs the same checks on every pull
request and is the real gate, so a skipped hook only moves the failure to CI.

## Licence of contributions

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same licence as the rest of the project.

## Security issues

Do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
