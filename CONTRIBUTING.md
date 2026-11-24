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

## Licence of contributions

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same licence as the rest of the project.

## Security issues

Do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
