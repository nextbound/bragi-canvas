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
- The standard flow is: toolbar entry -> create inline session -> focus target node -> lock non-target canvas interaction -> mount the optional top toolbar (native selection menu via `renderToolbar`) and/or bottom toolbar (framework-owned div via `bottomToolbar`) -> mount a temporary node layer -> save or cancel -> fully clean up classes, datasets, listeners, observers, and temporary DOM.
- A session may have a top toolbar, a bottom toolbar, or both — both are optional. The top toolbar reuses Obsidian's native `.bragi-canvas-menu`; the bottom toolbar is a framework-owned `.bragi-inline-tool-bottom-bar` div the session mounts/positions/removes. Tools pass `bottomToolbar: { render, className }` instead of hand-rolling a bottom bar via `mountLayer`.
- Both toolbars are positioned RELATIVE TO THE NODE (fixed `NODE_TOOLBAR_GAP`, centered on the node) via `positionNodeToolbar` from `node-toolbar-position.ts` — top forced `above`, bottom forced `below`. Do NOT pin toolbars to the viewport. The session runs a rAF loop to keep them tracking pan/zoom/resize; `context.repositionToolbars()` requests a one-shot reposition after a tool's own layout change (e.g. a dropdown widening the menu).
- Keep tool-specific state and rendering in the feature module. The inline session should own focus, viewport restore, selection restore, interaction gating, and both toolbars' lifecycle + positioning.
- Focus must use the inline session's safe-rect viewport targeting so neither toolbar covers the target node. The safe rect MEASURES each toolbar's height and reserves it (height + gap) above/below the node — there is no hardcoded margin. If the node can't fit with both gaps, it is scaled down. Do not center solely on the node bbox, and do not reintroduce magic-number margins like `bottomMarginPx: 160`.
- Focus animation should direct-fit to the final safe rect before it starts: compute visible size from rendered DOM using Canvas `scale`, convert the target scale back to Canvas `zoom`/`tZoom`, and keep `node.focus()` only as a fallback. Rendered correction is a small safety pass, not the normal second animation step.
- Inline sessions are scoped by canvas wrapper. Closing must make the session inactive before restoring the viewport or native toolbar, and non-target canvas chrome must sit behind the target node while interactions are locked.
- Keyboard shortcuts, pointer gates, toolbar queries, native topbar suppression, and connection-point hiding must be scoped to the active session's wrapper or session-tagged menu. Do not use body-level selectors or document-level handlers to block interaction in other canvases.
- When restoring the native topbar after inline tool exit, force an `auto-above` selection-menu reposition during reveal so transient inline/restore placement does not leave the topbar below the node.
- A solid-fill button in a toolbar (e.g. Save) must use `align-self: stretch` so its height matches the sibling icon buttons — do NOT use a fixed vertical padding + `align-self: center`, which leaves the top/bottom gap larger than the left/right. Give it `margin-inline-start` for breathing room from its neighbor (the toolbar `gap` is ~1px, fine for transparent icons but too tight against a solid block). This `margin-inline-start` assumes the solid button is NOT the first child; if it leads the toolbar the margin stacks on the container padding and looks asymmetric.
- Editing coordinates may use the node's displayed dimensions. When writing a media file, map annotations or edits back to the original asset dimensions so saved outputs preserve the source resolution.
- New inline tools must run `npm run build`, `npm run lint:obsidian`, and `git diff --check`, and should be manually checked for enter/exit behavior, node-relative top/bottom toolbar placement (on wide vs tall nodes, with a sidebar open, and after window resize), topbar restoration, interaction lock, connection-point suppression, and cleanup after repeated open/close cycles.

## Model / Provider Catalog Changes

- Adding a model to the local catalogue or adding provider support for a model must not automatically enable that model for existing users.
- Treat newly supported models as addable candidates only. They may appear in Add Model and provider Manage models flows, but they must not appear in settings model lists, panels, or MCP `list_models` until the user explicitly enables them.
- A model is available only when `modelPrefs[modelId].enabled === true`, its active provider is configured, the provider supports the model, and `providerModelPrefs[providerId][modelId] === true`.
- When connecting an already enabled model to an additional provider, preserve the existing active provider unless the user explicitly switches providers or removes the active provider connection.
- When renaming or replacing a model ID, migrate `modelPrefs`, active provider selection, and `providerModelPrefs` in the centralized settings migration pipeline.
- MCP model exposure must match the settings UI: only explicitly enabled models with a configured active provider connection should be returned.

### Modeling provider differences (do not fork models)

All "this provider differs from the base model" facts live in the model's `supportedProviders[providerId]` entry (`ProviderConfig`) or in a param's `providerOverrides`. Do not create a second model entry for a neutered/variant provider. Full reference and rationale: `docs/model-provider-rules.md`.

- `apiModelId` — upstream model id. The settings id editor is locked (static label) by default.
- `editableApiModelId?: boolean` — opt-in pencil editor, only for providers that accept arbitrary upstream ids (e.g. BytePlus C-Dance). Ignored when `aggregated`.
- `aggregated?: boolean` — the provider routes the model's modes to multiple upstream ids internally (DashScope Wan 2.7; DashScope voice). Routing stays hard-coded in the provider; the catalog only marks it. Locks the id editor. Must not also set `editableApiModelId`.
- `modes?: Mode[]` — restrict a provider to a subset of the model's modes. The mode dropdown and MCP schema show only the active provider's effective modes; unsupported modes are hidden, never shown as disabled/"not supported". Provider resolution is strict-to-active (no mode-based fallback).
- Param `providerOverrides[providerId]` — narrow a param's `options`/`default`/`min`/`max`/`step`/`unit` for one provider, or set `hidden: true` to drop it entirely for that provider.
- Extension cost: new instances of existing param types and existing modalities are pure catalog data. A brand-new param `type`, a brand-new `Mode` value, or a 5th `GenerationType` is a one-time, bounded code change (panel render + MCP schema, or the `Mode`/`GenerationType` union + `make*` + panel wiring); after that, instances of that kind are declarative again.

### Catalog checks

- `npm run check:catalog` is a no-network static gate (also part of root `npm run verify`). It fails the build on: unknown provider id in `supportedProviders`; `supportedProviders[p].modes` not a subset of `model.modes`; an orphan mode offered by no provider; `providerOverrides` referencing a provider not in `supportedProviders`; `aggregated` together with `editableApiModelId` or with an empty `apiModelId`; a DashScope voice model with `clone`/`design`/`modelIds` whose DashScope entry is not marked `aggregated`.
- `npm run audit:catalog` exercises the real panel/MCP logic across every model x provider x mode and reports invalid defaults, empty option lists, missing modality makers, etc. Run it after catalog changes.
- When you add a model/provider and a check fails, fix the catalog, not the script.

## Reference Asset Upload Policy

- When a provider needs a publicly fetchable reference asset URL, prefer the built-in Bragi temporary relay path first (`src/providers/upload.ts` + `src/providers/bragi-relay.ts`) and pass the returned public URL into the model request.
- Before uploading a reference image, preserve PNG/JPEG bytes as-is and convert every other image format to PNG. Keep this normalization in the shared upload preparation helper instead of adding provider-specific WebP/GIF/BMP branches.
- Keep upload endpoints and model-input URL endpoints conceptually separate. The relay upload API endpoint is only for writing bytes; the model request must receive the returned fetchable asset URL, not the upload endpoint.
- Use a provider's own upload/File API only when that provider cannot consume a Bragi Relay HTTPS URL, or when it explicitly requires provider-native file IDs/URIs for the requested feature.
- Do not write provider keys, relay tokens, uploaded asset URLs, or temporary media files into the repository. Keep live-test outputs summarized and redacted.

## Reference Checklist

For the full checklist and rationale, read `docs/obsidian-review-checklist.md`.
