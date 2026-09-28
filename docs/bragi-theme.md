# Bragi color system

Bragi UI uses independent `--bragi-*` CSS variables at the top of `src/styles.css`. It does not inherit the Obsidian accent or depend directly on Tailwind CSS.

The grayscale follows the hierarchy of the [Tailwind neutral palette](https://tailwindcss.com/docs/customizing-colors). Some hex values match exactly; others are nearby custom values, such as pure white for toolbars instead of neutral-50.

## Principles

| Surface | Tokens |
|------|--------|
| Canvas, nodes, toolbars and panels | `--bragi-*` |
| Hovered or selected edges | Obsidian `--color-accent` |
| Default edges | `--bragi-edge-default` |

## Light mode and Tailwind neutral

| Bragi token | Value | Tailwind reference |
|-------------|-----|---------------|
| `--bragi-canvas-bg` | `#f5f5f5` | neutral-100 |
| `--bragi-surface` | `#ffffff` | White toolbar/panel background |
| `--bragi-surface-muted` | `#f6f6f6` | ~neutral-50 |
| `--bragi-edge-default` | `#d4d4d4` | neutral-300 |
| `--bragi-text` / `--bragi-accent` | `#161616` | ~neutral-900 |
| `--bragi-border` | `#00000012` | Black at 7% opacity, not a solid neutral |

## Dark mode and Tailwind neutral

| Bragi token | Value | Tailwind reference |
|-------------|-----|---------------|
| `--bragi-canvas-bg` | `#191919` | ~neutral-900 |
| `--bragi-surface` | `#404040` | neutral-700, toolbars/panels |
| `--bragi-surface-muted` | `#525252` | neutral-600 |
| `--bragi-edge-default` | `#525252` | neutral-600 |
| `--bragi-text` / `--bragi-accent` | `#f0f0f0` | ~neutral-100 |
| `--bragi-border` | `#ffffff12` | White at 7% opacity |

## Floating toolbars

These components share the `--bragi-surface` background:

- Canvas bottom menu: `.canvas-card-menu`
- Node selection menu: `.bragi-canvas-menu`
- Generation bar: `.bragi-generate-bar`

Dark mode overrides Obsidian's `--background-secondary` rule on `.canvas-card-menu`; the stylesheet already handles this.

## Changing colors

Edit the token block at the top of `src/styles.css`, then copy it to `styles.css`. Updating a development vault is a separate, explicit `npm run sync:dev-vault -- /absolute/plugin/directory` action.
