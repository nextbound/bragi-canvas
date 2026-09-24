# 1.40.1 validation

## Automated checks

`npm run verify` runs the same checks locally, on pull requests and on tagged releases: TypeScript, Obsidian lint, 33 test scripts, the 50-model catalog, version consistency and a pure production build.

The new behavioral coverage verifies dormant canvas snapshots across restarts, provider/task identity, serialized settings writes, source context before awaits, transient retry timing, durable downloaded output before canvas saves, save failures, stale callbacks, credential errors, shared-asset copying and partial completion. Real localhost HTTP requests cover Host/Origin, optional token, JSON-only POST, declared and streamed 64 MiB limits, and the 30-second upload timeout. Tests use synthetic data and mocked provider responses; they do not submit paid generations.

## Native Obsidian smoke test

Tested on Obsidian 1.13.7 in a dedicated `Bragi Demo` vault containing only synthetic text and public example media, with no provider credentials. The production bundle exposed its MCP server on a separate local port.

- Loaded 1.40.1 and verified the command-palette and placeholder **Resume checking** entries.
- Kept A and B tasks, opened only A, changed settings, and reloaded the app twice. Both tasks remained in persisted storage; B retained its attention state.
- Resumed A's previously downloaded result and checked the saved canvas JSON: the original placeholder ID became a `file` node. B remained untouched.
- Opened B and used the command palette to finish its local result.

The native test caught a Canvas-specific behavior: importing a different node type with an existing ID reuses the old runtime instance. Result application removes that instance before importing the file node while preserving the ID and saved edges. Regression coverage checks that ordering.

Provider submission counts and simulated network failures are covered offline. Native smoke tests deliberately reuse downloaded fixture media and do not call a generation service. Downloaded results can be applied even after the provider connection is removed; stale success and terminal callbacks cannot modify a rebound view. Older Obsidian versions were not exercised interactively.
