# Releasing

Follow these steps to publish a new version of `dsh-token-receipt` to npm.

## Pre-release checks

1. Run syntax checks, unit tests, and a package dry run:

```bash
npm run check
npm test
npm pack --dry-run
```

2. Sign in to npm with the publisher account for `dsh-token-receipt`:

```bash
npm login
```

## Publish a release

Bump the version in `package.json` with `patch`, `minor`, or `major`, then push the commit and tag to `main`:

```bash
npm version patch
git push origin main --tags
```

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which runs the test suite and publishes to npm with provenance through npm Trusted Publishing (GitHub OIDC). The package's trusted publisher is bound to this repository and `release.yml`, so no `NPM_TOKEN` secret is required.

If the package is new, or the workflow file is renamed, configure the trusted publisher once:

```bash
npm trust github dsh-token-receipt --file release.yml --repo maxlee/dsh-token-receipt --allow-publish
```

To publish directly from a local checkout instead, run:

```bash
npm publish --access public
```
