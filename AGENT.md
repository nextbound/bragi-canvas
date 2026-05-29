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

## Settings Migrations

- Keep all `data.json` settings schema migrations in the centralized settings migration pipeline.
- Every settings schema migration must have an explicit order and advance `settingsSchemaVersion`.
- Settings migrations should be pure data transformations. Do not put UI, filesystem, network, or provider test side effects in them.
- `loadSettings()` and settings import must use the same migration entry point.
- Keep file, asset, canvas, and vault-content migrations in their own modules. Do not mix them into settings schema migration code.
- When adding a settings field, update defaults, validator/import parsing, migration behavior, and the test plan in the same change.

## Canvas Inline Tool Mode

- For tools that directly operate on a canvas node, prefer `CanvasInlineToolSession` over a modal or full-screen overlay.
- The standard flow is: toolbar entry -> create inline session -> focus target node -> lock non-target canvas interaction -> replace the floating topbar -> mount a temporary node layer -> save or cancel -> fully clean up classes, datasets, listeners, observers, and temporary DOM.
- Keep tool-specific state and rendering in the feature module. The inline session should own focus, viewport restore, selection restore, interaction gating, and topbar lifecycle.
- Editing coordinates may use the node's displayed dimensions. When writing a media file, map annotations or edits back to the original asset dimensions so saved outputs preserve the source resolution.
- New inline tools must run `npm run build`, `npm run lint:obsidian`, and `git diff --check`, and should be manually checked for enter/exit behavior, topbar restoration, interaction lock, connection-point suppression, and cleanup after repeated open/close cycles.

## Model / Provider Catalog Changes

- Adding a model to the local catalogue or adding provider support for a model must not automatically enable that model for existing users.
- Treat newly supported models as addable candidates only. They may appear in Add Model and provider Manage models flows, but they must not appear in settings model lists, panels, or MCP `list_models` until the user explicitly enables them.
- A model is available only when `modelPrefs[modelId].enabled === true`, its active provider is configured, the provider supports the model, and `providerModelPrefs[providerId][modelId] === true`.
- When connecting an already enabled model to an additional provider, preserve the existing active provider unless the user explicitly switches providers or removes the active provider connection.
- When renaming or replacing a model ID, migrate `modelPrefs`, active provider selection, and `providerModelPrefs` in the centralized settings migration pipeline.
- MCP model exposure must match the settings UI: only explicitly enabled models with a configured active provider connection should be returned.

## Reference Asset Upload Policy

- When a provider needs a publicly fetchable reference asset URL, prefer the built-in Bragi temporary relay path first (`src/providers/upload.ts` + `src/providers/bragi-relay.ts`) and pass the returned public URL into the model request.
- Keep upload endpoints and model-input URL endpoints conceptually separate. The relay upload API endpoint is only for writing bytes; the model request must receive the returned fetchable asset URL, not the upload endpoint.
- Use a provider's own upload/File API only when that provider cannot consume a Bragi Relay HTTPS URL, or when it explicitly requires provider-native file IDs/URIs for the requested feature.
- Do not write provider keys, relay tokens, uploaded asset URLs, or temporary media files into the repository. Keep live-test outputs summarized and redacted.

## Reference Checklist

For the full checklist and rationale, read `docs/obsidian-review-checklist.md`.
