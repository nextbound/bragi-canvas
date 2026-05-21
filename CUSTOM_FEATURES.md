# Custom Features

This fork is used to document and prepare workflow improvements from a customized Bragi Canvas build for upstream review.

The full current local plugin build is included in [`custom-plugin-snapshot/`](custom-plugin-snapshot/) for inspection. It contains only `manifest.json`, `main.js`, and `styles.css`; it does not include local settings, API keys, canvas files, generated assets, or vault content.

Some features started as local prototypes in a compiled plugin build and are being organized into source-level changes before individual pull requests. The goal is to split them into focused, reviewable features instead of sending one large mixed change.

## Feature Overview

| Feature | Status | Summary |
| --- | --- | --- |
| Image annotation tools | Implemented in this PR | Add bounding boxes, numbered markers, and mosaic masking directly from image nodes. |
| Scene/material cutout | Implemented in this PR | Extract an object or material from an image node and save the result back to the canvas as a new image node. |
| Reference image composition | Implemented in this PR | Combine one or more reference images into a single generated reference sheet for downstream image workflows. |
| Image file hover preview | Implemented in this PR | Preview image files from the left file explorer by hovering over them. |
| Canvas toolbar bindings | Implemented in this PR | Surface generation and image-tool actions directly on the canvas selection toolbar, with a fallback binding for menu re-renders. |
| Preset slots and chained outputs | Implemented in this PR | Add canvas preset slots that collect generated outputs and can feed them into downstream prompt nodes. |
| Provider workflow presets | Local prototype | Add workflow-oriented provider/model presets used in a personal image-generation pipeline. |

## Details

### Image Annotation Tools

Adds right-click image actions for marking up reference images without leaving the canvas:

- Draw rectangular callouts on image nodes.
- Place numbered visual markers.
- Paint mosaic masks over sensitive or irrelevant regions.
- Save the annotated result as a new image node connected to the original.

This is useful when a prompt needs to refer to exact regions in a reference image.

### Scene/Material Cutout

Adds a canvas-based cutout workflow for extracting a subject, product, material, or scene element from an existing image node.

The intended workflow is:

- Select an image node.
- Open the cutout tool.
- Brush/select the region to keep or remove.
- Save the extracted result back into the canvas as a reusable image node.

### Reference Image Composition

Adds a way to compose selected reference images into one combined reference image. This is useful for providers or workflows that work better with a single visual reference rather than many separate inputs.

Example use cases:

- Put product, style, and scene references into one visual board.
- Combine annotated references before sending them into an image model.
- Create a compact reference sheet for repeatable generation workflows.

### Image File Hover Preview

Adds a lightweight preview for image files in the Obsidian file explorer. When the cursor hovers over an image file in the left sidebar, a preview appears so users can identify visual assets without opening each file.

This is useful for vaults with many generated images, references, and intermediate assets.

### Canvas Toolbar Bindings

Adds first-level canvas toolbar actions for common Bragi workflows:

- Generate image, video, text, or audio from prompt nodes.
- Run image annotation, cutout, and reference-composition tools from image nodes.
- Run speech-to-text and audio isolation from audio nodes.
- Keep those actions available even when Obsidian re-renders the canvas menu.

### Preset Slots and Chained Outputs

Adds a lightweight workflow slot pattern for repeatable canvas pipelines.

The intended workflow is:

- Add a preset slot from the bottom canvas card menu.
- Connect a prompt node to the preset slot.
- Optionally connect the preset slot to downstream prompt nodes.
- Generated outputs are placed inside the slot and connected to downstream prompts.
- If a downstream prompt has saved image-generation settings, it can automatically run using the new upstream output.

### Provider Workflow Presets

The customized build also includes provider/model routing preferences used in a personal workflow. These are documented for context, but they are likely not the first features to upstream because they are more opinionated.

## Suggested Upstream Split

If maintainers are interested, the most reviewable order is:

1. Image annotation tools
2. Scene/material cutout
3. Reference image composition
4. Preset slots and chained outputs
5. Canvas toolbar bindings
6. Image file hover preview
7. Provider workflow presets

Each feature can be split into its own branch and pull request.
