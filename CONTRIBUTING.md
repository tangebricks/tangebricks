# Contributing

Thanks for your interest in projectx-poc.

## Before you open a pull request

1. Install dependencies: `pnpm install --frozen-lockfile` (Node 24, pnpm 10.18.0).
2. Run the local gate: `pnpm check:changed`. It typechecks the workspace and runs the tests affected by your change. It must exit 0.
3. Open the pull request against `main`. CI and the `Security` workflow run on every pull request into `main`.

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

## Licence of contributions

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same licence as the rest of the project.

## Security issues

Do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
