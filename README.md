# Bragi Canvas

Bragi Canvas turns Obsidian Canvas into a node-based AI generation workspace. It uses selected canvas nodes and incoming edges as prompts and references, runs the model you choose, then writes the generated output back to the canvas as connected nodes.

## Features

- Generate images, videos, text, speech, music, and sound effects from selected canvas nodes.
- Use incoming canvas edges as prompt text and reference inputs.
- Display upstream image, text, and audio references directly on canvas nodes.
- Batch-generate outputs from one prompt.
- Arrange nodes, duplicate connected workflows, split images into tiles, pin generated media, and download outputs.
- Import and export portable `.bragi` canvas workflow packages.
- Optionally expose the active canvas through a local MCP server for agent workflows and automation.

## Requirements

- Obsidian desktop app 1.8.7 or newer.
- Obsidian UI language set to English or English (GB). Bragi Canvas relies on Obsidian's English canvas labels for its toolbar hooks and will not load in other UI languages.
- At least one configured AI provider key for the generation type you want to use.

Bragi Canvas is desktop-only because it uses Obsidian desktop APIs and local file operations.

## Install

After Bragi Canvas is listed in the Obsidian Community Plugins browser:

1. Open Obsidian settings.
2. Go to Community plugins.
3. Search for "Bragi Canvas".
4. Install and enable the plugin.

For beta testing before community approval, install the latest GitHub release with BRAT:

1. Install the BRAT plugin.
2. Run "BRAT: Add a beta plugin for testing".
3. Use `https://github.com/nextbound/bragi-canvas`.
4. Enable Bragi Canvas after BRAT installs it.

You can also manually copy `manifest.json`, `main.js`, and `styles.css` from the latest release into:

```text
<vault>/.obsidian/plugins/bragi-canvas/
```

## Use

1. Open a `.canvas` file.
2. Select a text node or markdown file node.
3. Choose image, video, text, or audio generation from the floating canvas toolbar.
4. Select a model and parameters in the generation bar.
5. Run the generation. Bragi Canvas creates the output node near the source node and connects it back to the source.

Incoming directed edges are treated as upstream references. Text nodes contribute prompt text, image nodes become image references, video nodes can be used for supported video workflows, and audio nodes can be used for supported audio workflows.

## MCP server

The MCP server is disabled by default. When enabled in settings, it listens on `127.0.0.1` and exposes canvas operations to local MCP clients. You can configure the port and an optional access token. If a token is set, clients must send `Authorization: Bearer <token>` on every request.

Use the MCP server only for trusted local clients that you want to let read or modify the active Obsidian canvas.

## Providers

Bragi Canvas supports multiple provider integrations, including OpenAI, Anthropic, AWS Bedrock, Google Gemini (Gemini, Imagen, and Veo), Volcengine, BytePlus, Kling, fal.ai, ElevenLabs, MiniMax, Legnext, TokenRouter (`https://api.tokenrouter.com/v1`), APIMart, xAI, and Luma. Availability depends on the models and credentials configured in plugin settings.

Provider credentials are stored by Obsidian in this plugin's local settings data. They are used only to make the provider requests selected by the user.

No provider API keys are bundled with the plugin or included in release assets.

## Network and data disclosure

Bragi Canvas sends prompts and selected upstream reference files to the AI providers configured by the user when a generation is run. Some providers require publicly fetchable reference URLs; for those workflows, Bragi Canvas may upload temporary copies of selected reference files to the built-in Bragi Relay service so the provider can fetch them. Relay-hosted files are intended as temporary transfer files and are not used for client-side telemetry.

The plugin can also run an optional local MCP server on `127.0.0.1` when enabled in settings. If an MCP access token is configured, clients must send the matching bearer token.

Bragi Canvas does not include client-side analytics or telemetry.

## Development

```bash
npm install
npm run dev
npm run build
```

Release tags must be plain semantic versions such as `1.12.4`. Do not prefix tags with `v`.

## Release checklist

1. Update `manifest.json` `version` and `minAppVersion`.
2. Update `package.json` and `package-lock.json` to the same version.
3. Add the version to `versions.json` with the supported `minAppVersion`.
4. Commit the changes.
5. Push a numeric tag that exactly matches `manifest.json` `version`.
6. GitHub Actions builds `main.js` and publishes release assets: `manifest.json`, `main.js`, and `styles.css`.

## License

Bragi Canvas is licensed under the Business Source License 1.1. See [LICENSE](LICENSE).
