# Building and releasing LoreCode

This guide covers the desktop extension. The Cloudflare Worker in `apps/api` is
released separately and must be deployed before publishing a version that
depends on API changes.

## Prerequisites

- Node.js 22 or newer
- npm
- A VS Code extension Marketplace publisher named `techrift` for Marketplace
  releases
- An Open VSX namespace named `techrift` only when releasing to Open VSX

Install the project dependencies once:

```bash
npm ci
```

## Verify a release build

Run the checks from the repository root:

```bash
npm run test:unit
npm run package:vsix
```

The last command creates `lorecode-<version>.vsix` in the repository root.
It is intentionally ignored by Git. The package command compiles the extension
first and uses the repository's pinned `@vscode/vsce` version for a repeatable
build.

To try the packaged extension locally, use VS Code's **Extensions: Install from
VSIX...** command and select that `.vsix` file. Disable or uninstall any other
local copy first so that the test is unambiguous.

## Prepare the version

1. Confirm that `README.md`, `CHANGELOG.md`, and the extension manifest describe
   the release accurately.
2. Update the version with npm. Use the version bump that matches the change:

   ```bash
   npm version patch
   # or: npm version minor
   # or: npm version major
   ```

   This updates `package.json`, `package-lock.json`, creates a Git commit, and
   creates a matching tag. Review it before pushing.
3. Run the verification commands again and install the resulting VSIX locally.
4. Push the release commit and tag after the Marketplace publication succeeds.

## Publish to the VS Code Marketplace

Create a Personal Access Token in Azure DevOps with the **Marketplace > Manage**
scope. Log in once on the release machine:

```bash
npx vsce login techrift
```

Publish the version already recorded in `package.json`:

```bash
npx vsce publish
```

Use `npx vsce publish patch` only when the version has not been bumped yet and
you deliberately want `vsce` to perform the patch bump. Do not run it after
`npm version`, which would create an unexpected second version change.

## Publish to Open VSX (optional)

Open VSX is a separate registry from the VS Code Marketplace. Create an Open VSX
access token, then publish the already-built VSIX:

```bash
npx ovsx publish lorecode-<version>.vsix -p "$OVSX_PAT"
```

Keep the token in a secure environment variable or your CI secret store; never
commit it to the repository.

## Release checklist

- [ ] Extension tests and lint pass.
- [ ] The VSIX builds and installs successfully in a clean VS Code profile.
- [ ] The API is deployed if this release changes API behavior.
- [ ] `package.json`, `package-lock.json`, and `CHANGELOG.md` have the intended version.
- [ ] Marketplace publication succeeds.
- [ ] The release commit and tag are pushed.
- [ ] The published Marketplace page is checked for the correct icon, README, and version.
