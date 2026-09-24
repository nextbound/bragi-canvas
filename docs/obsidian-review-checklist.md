# Obsidian review and release checks

Run `npm run verify` on the exact release commit. Pull requests and tagged releases use the same command: TypeScript, Obsidian lint, offline behavioral tests, catalog consistency, version consistency and production build.

- Use supported Obsidian APIs where available. Keep the Canvas internal API contract in `src/types/canvas-internal.d.ts` and narrow optional runtime fields before use.
- Read and write only the selected canvas and the recorded output directory. Preserve shared references and files when copying assets. Keep backup and partial-failure messages accurate.
- Preserve asynchronous task IDs across reloads, settings saves and retryable failures. Never repeat a paid submission as a polling retry.
- Capture canvas identity before asynchronous work. Stale views and unloaded plugins must not receive callbacks that mutate their canvas.
- Keep provider keys out of logs, demos and source. Explain reference uploads and the optional local MCP server accurately. Validate MCP Host, Origin, token (when configured), JSON body size and timeout.
- Validate in a dedicated Obsidian test vault; production builds are pure. `npm run sync:dev-vault -- /absolute/plugin/directory` is an explicit developer action.
- Keep manifest, package, lock, versions and changelog aligned. Tag plain numeric semver and verify the three separate release assets: `manifest.json`, `main.js`, `styles.css`.
- After successful release, open `https://community.obsidian.md/account/plugins/bragi-canvas/check-release` for the Community release check.
