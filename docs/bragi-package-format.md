# Bragi package format

This document describes the `.bragi` import/export format so external tools can create packages for Obsidian Canvas.

A `.bragi` file is JSON canvas data, not a plugin update or compressed archive. It describes canvas content and assets; imports write assets only into `_bragi/assets` inside the vault.

Implementation: `src/import-export.ts`.

## Top-level structure

Minimal structure:

```json
{
  "format": "bragi-canvas-package",
  "version": 2,
  "exportDate": "2026-05-13T00:00:00.000Z",
  "canvasName": "example",
  "nodeCount": 2,
  "assetCount": 1,
  "canvas": {
    "nodes": [],
    "edges": []
  },
  "assets": []
}
```

Fields:

- `format`: must be `bragi-canvas-package`.
- `version`: must currently be `2`.
- `exportDate`: export time, preferably an ISO timestamp.
- `canvasName`: original canvas name without the `.canvas` extension.
- `nodeCount`: number of entries in `canvas.nodes`.
- `assetCount`: number of entries in `assets`.
- `canvas`: Obsidian Canvas data.
- `assets`: packaged assets encoded as base64.

## canvas

`canvas` uses the native Obsidian Canvas JSON structure:

```json
{
  "nodes": [],
  "edges": []
}
```

Bragi preserves additional fields supported by Obsidian Canvas, including Bragi metadata stored directly on nodes.

## assets

Assets are stored as an array:

```json
{
  "path": "assets/ref.png",
  "encoding": "base64",
  "data": "iVBORw0KGgoAAAANSUhEUg..."
}
```

Fields:

- `path`: package-relative asset path, starting with `assets/`.
- `encoding`: must currently be `base64`.
- `data`: base64 file content without a `data:image/...` prefix.

On import, `assets/ref.png` is written to `_bragi/assets/ref.png` in the vault. A collision produces a name such as `_bragi/assets/ref_2.png`; the file node is updated to the actual path.

Asset path restrictions:

- Must start with `assets/`.
- Must not be absolute.
- Must not contain `..`, empty segments, backslashes or null characters.
- Must not contain plugin release filenames: `main.js`, `manifest.json` or `styles.css`.

These restrictions keep `.bragi` a canvas data format rather than a plugin installation or update mechanism.

## Common node fields

Every node needs these basic fields:

```json
{
  "id": "node-1",
  "type": "text",
  "x": 0,
  "y": 0,
  "width": 400,
  "height": 240
}
```

Required fields:

- `id`: string, unique within the canvas.
- `type`: `text`, `file`, `link` or `group`.
- `x`, `y`: canvas position.
- `width`, `height`: node dimensions.

Optional fields:

- `color`: an Obsidian Canvas color, usually `"1"` through `"6"`, or a hex color. Bragi Mark toggles `"6"`.

## Text nodes

```json
{
  "id": "prompt",
  "type": "text",
  "text": "Generate a cinematic product image.",
  "x": 0,
  "y": 0,
  "width": 420,
  "height": 180
}
```

Additional required field:

- `text`: node text content.

## File nodes

```json
{
  "id": "ref-image",
  "type": "file",
  "file": "assets/ref.png",
  "x": -520,
  "y": 0,
  "width": 360,
  "height": 360
}
```

Additional required field:

- `file`: vault-relative file path. Packages should use an asset path such as `assets/ref.png`.

When `file` points to `assets/...`, import rewrites it to the actual `_bragi/assets/...` path.

Currently recognized media types:

- Images: `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`
- Videos: `.mp4`, `.mov`, `.webm`
- Audio: `.mp3`, `.wav`
- Markdown prompt files: `.md`

Optional file-node fields:

- `subpath`: an Obsidian file subpath such as `#Heading`.
- `bragiAssetId`: a manually assigned BytePlus/Volcengine Asset ID, primarily for Seedance face references.

Do not set manually:

- `bragiAssetIds`: the internal cache of assets for multiple providers. External packages should let the plugin populate it.

## Link nodes

```json
{
  "id": "external-link",
  "type": "link",
  "url": "https://example.com",
  "x": 0,
  "y": 300,
  "width": 400,
  "height": 180
}
```

Additional required field:

- `url`: link address.

## Group nodes

```json
{
  "id": "group-1",
  "type": "group",
  "label": "References",
  "x": -560,
  "y": -40,
  "width": 460,
  "height": 460,
  "background": "assets/group-bg.png",
  "backgroundStyle": "cover"
}
```

Optional group fields:

- `label`: group name.
- `background`: background image path. An `assets/...` path is rewritten to its actual `_bragi/assets/...` location during import.
- `backgroundStyle`: `cover`, `ratio` or `repeat`.

## Edge rules

```json
{
  "id": "edge-1",
  "fromNode": "ref-image",
  "fromSide": "right",
  "fromEnd": "none",
  "toNode": "prompt",
  "toSide": "left",
  "toEnd": "arrow",
  "label": "reference"
}
```

Required fields:

- `id`: string, unique within the canvas.
- `fromNode`: source node ID.
- `toNode`: destination node ID.

Optional fields:

- `fromSide`：`top`、`right`、`bottom`、`left`
- `toSide`：`top`、`right`、`bottom`、`left`
- `fromEnd`: `none` or `arrow`
- `toEnd`: `none` or `arrow`
- `color`
- `label`

To use a node as generation input, connect it to the target with a directed edge:

- `toNode` must identify the target prompt/generation node.
- Prefer `toEnd: "arrow"`. If omitted, Bragi treats it as an arrow end.
- Prefer `fromEnd: "none"`; it can also be omitted.

Bragi ignores undirected and bidirectional edges when collecting generation inputs.

## Bragi custom node fields

These optional fields are stored directly on Obsidian Canvas nodes.

### Input order

```json
{
  "bragiImageOrder": ["_bragi/assets/ref-a.png", "_bragi/assets/ref-b.png"],
  "bragiTextOrder": ["text-node-a", "text-node-b"],
  "bragiAudioOrder": ["_bragi/assets/voice.wav"]
}
```

Fields:

- `bragiImageOrder`: preferred order of upstream image references.
- `bragiTextOrder`: preferred upstream text/Markdown order, stored as node IDs.
- `bragiAudioOrder`: preferred upstream audio order.

Important limitation:

The importer rewrites only `node.file` and `node.background`, not `bragiImageOrder`, `bragiAudioOrder` or `bragiTextOrder`.

Recommendations for externally generated packages:

- These ordering fields can be omitted entirely.
- If included, treat them as hints rather than guaranteed ordering.
- Do not rely on `bragiTextOrder` matching imported nodes: import generates new node IDs.
- Do not rely on path-order fields after filename collisions: imported files receive suffixes but these custom fields are not rewritten.
- Prefer storing edges in the desired input order in `canvas.edges`. Bragi falls back to upstream edge order when saved ordering fields do not match.

### Last generation settings

```json
{
  "bragiLastGen": {
    "image": {
      "modelId": "gpt-image-2",
      "params": {
        "aspectRatio": "1:1"
      },
      "batchCount": 1
    }
  }
}
```

This optional field prefills a node's generation bar.

Top-level keys usually identify generation types: `image`, `video`, `text` or `audio`.

If `modelId` is unavailable in the user's environment, the UI may ignore it or be unable to use it.

### Do not include running-task state

Do not write these fields when generating an external package:

```json
{
  "bragiGenerating": true,
  "bragiGenModelName": "model",
  "bragiGenStartedAt": 1777777777777
}
```

These fields represent an in-progress generation. Without a corresponding in-memory task after import, Bragi may mark the node interrupted.

## Minimal working package

This example contains one image asset and one prompt node:

```json
{
  "format": "bragi-canvas-package",
  "version": 2,
  "exportDate": "2026-05-13T00:00:00.000Z",
  "canvasName": "minimal",
  "nodeCount": 2,
  "assetCount": 1,
  "canvas": {
    "nodes": [
      {
        "id": "ref-image",
        "type": "file",
        "file": "assets/ref.png",
        "x": 0,
        "y": 0,
        "width": 360,
        "height": 360
      },
      {
        "id": "prompt",
        "type": "text",
        "text": "Use the connected image as reference and generate a clean product shot.",
        "x": 520,
        "y": 0,
        "width": 460,
        "height": 220
      }
    ],
    "edges": [
      {
        "id": "edge-ref-to-prompt",
        "fromNode": "ref-image",
        "fromSide": "right",
        "fromEnd": "none",
        "toNode": "prompt",
        "toSide": "left",
        "toEnd": "arrow"
      }
    ]
  },
  "assets": [
    {
      "path": "assets/ref.png",
      "encoding": "base64",
      "data": "<base64 png bytes>"
    }
  ]
}
```

After import:

- `assets/ref.png` is written to `_bragi/assets/ref.png`.
- If that path exists, a name such as `_bragi/assets/ref_2.png` is used.
- The file node's `file` field is updated to the actual path.
- All node and edge IDs are regenerated.

## External generation checklist

When creating a `.bragi` package with another tool:

1. Create a UTF-8 JSON file with the `.bragi` extension.
2. Set the top-level `format` to `bragi-canvas-package`.
3. Set the top-level `version` to `2`.
4. Put Obsidian Canvas data in `canvas`.
5. Encode asset files as base64 and put them in `assets`.
6. Point file nodes and group backgrounds to `assets/...` paths.
7. Ensure every node ID is unique within the canvas.
8. Ensure every edge ID is unique within the canvas.
9. Ensure each edge's `fromNode` and `toNode` reference existing nodes.
10. Use directed edges pointing at the target with `toEnd: "arrow"` for generation inputs.
11. Do not use absolute paths such as `/Users/...` or `C:\...`.
12. Do not include runtime fields such as `bragiGenerating`.
13. Do not place plugin release files in `assets`.
14. Test both import modes:
    - Merge into the open canvas.
    - Import as a new canvas.

## Import behavior

### Merge into the open canvas

Bragi performs these steps:

1. Write assets into `_bragi/assets`.
2. Rewrite file-node and group-background paths.
3. Regenerate imported node and edge IDs to avoid collisions.
4. Remap edge `fromNode` and `toNode` values to the new IDs.
5. Move imported content to the right of the existing canvas content, leaving a 200 px gap.
6. Append the imported nodes and edges.

### Import as a new canvas

Bragi performs these steps:

1. Write assets into `_bragi/assets`.
2. Rewrite file-node and group-background paths.
3. Regenerate all node and edge IDs.
4. Create a `.canvas` file named after the `.bragi` file.
5. Add a suffix such as `_1` or `_2` if the canvas filename exists.
6. Open the new canvas.

## Current limitations

- Only format version `2` is supported.
- The importer validates the top-level format, asset list and path safety, but does not implement full JSON Schema validation.
- Only `node.file` and `node.background` are rewritten automatically.
- Node IDs always change on import; custom fields containing node IDs are not automatically remapped.
- Filename collisions add suffixes without updating paths in custom fields.
- If canvas data references an asset missing from `assets`, import may finish with a broken file reference.
