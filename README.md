# Bragi Canvas

Bragi Canvas turns Obsidian Canvas into a node-based AI generation workspace. Connect text, image, video, and audio nodes, then run generation from the canvas toolbar to create new media nodes beside the source node.

## Features

- Generate images, videos, text, and audio from selected canvas nodes.
- Use incoming canvas edges as prompt and reference inputs.
- Display upstream image, text, and audio references directly on canvas nodes.
- Arrange, duplicate, pin, download, split, import, and export canvas workflows.
- Optionally expose the active canvas through a local MCP server for agent workflows.

## Requirements

- Obsidian desktop app 1.5.0 or newer.
- Obsidian UI language set to English. Bragi Canvas relies on Obsidian's English canvas labels for its toolbar hooks and will not load in other UI languages.
- At least one configured AI provider key for the generation type you want to use.

Bragi Canvas is desktop-only because it uses Obsidian desktop APIs and local file operations.

## Install

After Bragi Canvas is available in the Obsidian Community Plugins browser:

1. Open Obsidian settings.
2. Go to Community plugins.
3. Search for "Bragi Canvas".
4. Install and enable the plugin.

For beta testing before community approval, install the latest GitHub release with BRAT or manually copy `manifest.json`, `main.js`, and `styles.css` from the release into:

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

## Providers

Bragi Canvas supports multiple provider integrations, including OpenAI, Gemini, BytePlus or Volcengine, Kling, fal.ai, ElevenLabs, MiniMax, APIMart, Legnext, TokenRouter, and AWS Bedrock. Availability depends on the models and credentials configured in plugin settings.

Provider credentials are stored by Obsidian in this plugin's local settings data. They are used only to make the provider requests selected by the user.

## Network And Data Disclosure

Bragi Canvas sends prompts and selected upstream reference files to the AI providers configured by the user when a generation is run. Some providers require publicly fetchable reference URLs; for those workflows, Bragi Canvas may upload temporary copies of selected reference files to the Bragi Relay service at `relay.bragi.now` so the provider can fetch them. Relay-hosted files are intended as temporary transfer files and are not used for client-side telemetry.

The plugin can also run an optional local MCP server on `127.0.0.1` when enabled in settings. If an MCP access token is configured, clients must send the matching bearer token.

Bragi Canvas does not include client-side analytics or telemetry.

## Development

```bash
npm install
npm run dev
npm run build
```

Release tags must be plain semantic versions such as `1.12.4`. Do not prefix tags with `v`.

## Release Checklist

1. Update `manifest.json` `version` and `minAppVersion`.
2. Update `versions.json` when `minAppVersion` changes.
3. Commit the changes.
4. Push a numeric tag that exactly matches `manifest.json` `version`.
5. GitHub Actions builds `main.js` and publishes release assets: `manifest.json`, `main.js`, and `styles.css`.

## License

Bragi Canvas is licensed under the Business Source License 1.1. See [LICENSE](LICENSE).
