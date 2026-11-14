# Releasing

This repository is set up for a public npm package and a GitHub repository.

## Before the first publish

1. Confirm the package name in `package.json` is still available:
   `npm view dsh-token-receipt version`.
2. Log in to npm with the account that owns `@maxlee`:
   `npm login`.
3. Run the local checks:
   `npm run check && npm pack --dry-run`.

## Publish a version

```bash
npm version patch        # or minor / major
git push origin main --tags
npm publish --access public
```

For a trusted-publishing release from GitHub Actions, create an
`NPM_TOKEN` repository secret (or configure npm trusted publishing) and push a
`v*` tag. The `release.yml` workflow publishes with provenance.

## Push the repository

```bash
git remote add origin git@github.com:maxlee/dsh-token-receipt.git
git push -u origin main --tags
```
