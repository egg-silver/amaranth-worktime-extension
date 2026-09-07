---
name: amaranth-release-package
description: Build and verify the minimal ZIP used to distribute the amaranth-worktime Chrome extension. Use when the user asks to package, archive, prepare, or verify a release ZIP for this extension.
---

# Amaranth release package

Create the distributable archive from the current checkout.

1. Read `manifest.json` and `package.json`. Keep their versions equal before packaging. Treat `manifest.json` as the extension version source of truth.
2. Run `npm test`. Stop and report the failing command if the suite is red.
3. Run `npm run package`. The script is `scripts/package.mjs`; it writes `dist/amaranth-worktime-extension.zip`.
4. Run `unzip -tq dist/amaranth-worktime-extension.zip`.
5. Inspect the archive. It must contain only the extension runtime files: `manifest.json`, the root runtime files, and files below `lib/`, `fonts/`, and `icons/`. It must not contain tests, docs, Git metadata, `package.json`, or development scripts.
6. Run `git diff --check` and report the exact archive path, file count, byte size, and verification results.

The archive has flat entries with `manifest.json` at its root. Its stable filename makes file-manager extraction produce an `amaranth-worktime-extension` folder instead of a versioned folder. Do not add a version to the archive filename.

Packaging does not publish a GitHub release. Publish or attach the archive only when the user explicitly asks for a release or deployment. The extension's runtime update checker uses the production release repository configured in `lib/update.js`; packaging does not change that path.

Done means the tests pass, ZIP integrity passes, the archive contains only allowed runtime paths, and the working tree has no whitespace errors.
