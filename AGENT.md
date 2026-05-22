# AGENT.md

This repository is an Obsidian community plugin. Treat Obsidian Community review compatibility as a hard release requirement, not as a post-release cleanup task.

## Branch Workflow

- Do not make feature, fix, model/provider, MCP, or release-prep changes directly on `main`.
- Create a branch before editing, using `feat/<short-topic>`, `fix/<short-topic>`, `docs/<short-topic>`, `refactor/<short-topic>`, or `release/<version>` / `chore/release-<version>`.
- If the change also requires skill updates, use the same branch suffix in the skill repository (`nextbound/bragi-canvas-skill`) and keep both branches in sync.
- Before merging plugin changes, confirm the paired skill branch has been updated for any MCP tool, model/provider, generation behavior, params, return shape, or gotcha changes.
- Cross-reference paired plugin and skill PRs/branches when merging. Do not merge only one side of a coupled change.

## Required Before Release

- Run `npm run lint:obsidian`.
- Run `npm run build`.
- Verify `manifest.json`, `package.json`, `package-lock.json`, and `versions.json` are version-aligned.
- Update the root `CHANGELOG.md` for every version bump.
- Verify the release tag is plain semver with no `v` prefix, for example `1.12.14`.
- Verify the GitHub release has separate `manifest.json`, `main.js`, and `styles.css` assets. Do not upload a zip instead.

## Obsidian Review Rules

- Use sentence case for all UI text, settings text, notices, placeholders, commands, tooltips, and menu labels.
- Avoid file-level `eslint-disable`. If a lint suppression is unavoidable, scope it to the smallest block and explain why.
- Do not leave unused imports, variables, functions, or debug `console.log` calls.
- Avoid `as any`. Prefer typed runtime boundaries or narrow local casts with comments.
- Keep CSS scoped to Bragi classes such as `.bragi-*` or `.bragi-canvas-*`.
- Do not use `!important` unless a reviewer-approved exception is unavoidable.
- Do not duplicate CSS selectors; Obsidian's backend CSS lint reports them.
- Do not hardcode `.obsidian` paths. Use Obsidian APIs and `Vault.configDir` where applicable.
- Use `Plugin.loadData()` and `Plugin.saveData()` for plugin data.
- Use `normalizePath()` for user-controlled vault paths.
- Do not bundle provider API keys or secrets. Bragi Relay configuration is allowed only through the existing user/runtime configuration path.

## Bragi-Specific Release Notes

- `manifest.json` must keep `"id": "bragi-canvas"`, `"author": "Nextbound"`, and `"authorUrl": "https://bragi.now"`.
- Treat `manifest.json` as the source of truth for `minAppVersion`; do not lower it without checking all Obsidian APIs used by the plugin.
- If `minAppVersion` changes, update the matching entry in `versions.json`.
- The repository uses `MPL-2.0` because it is recognized by GitHub and Obsidian's review backend.
- Submit or preview reviews through the Obsidian Community backend at `community.obsidian.md` when possible. Do not rely only on the old `obsidian-releases` PR workflow.

## Reference Asset Upload Policy

- When a provider needs a publicly fetchable reference asset URL, prefer the built-in Bragi temporary relay path first (`src/providers/upload.ts` + `src/providers/bragi-relay.ts`) and pass the returned public URL into the model request.
- Keep upload endpoints and model-input URL endpoints conceptually separate. The relay upload API endpoint is only for writing bytes; the model request must receive the returned fetchable asset URL, not the upload endpoint.
- Use a provider's own upload/File API only when that provider cannot consume a Bragi Relay HTTPS URL, or when it explicitly requires provider-native file IDs/URIs for the requested feature.
- Do not write provider keys, relay tokens, uploaded asset URLs, or temporary media files into the repository. Keep live-test outputs summarized and redacted.

## Reference Checklist

For the full checklist and rationale, read `docs/obsidian-review-checklist.md`.
