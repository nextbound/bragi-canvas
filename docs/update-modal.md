# Update modal plan

## Decision

Ship a lightweight update reminder first. No forced upgrade, no custom backend service, and no permanent "skip this version".

The goal is to nudge users who do not visit Obsidian Community Plugins manually. If a newer Bragi Canvas release exists, the old version should keep reminding users while still letting them continue their work.

## Version source

Use GitHub's latest release API:

`https://api.github.com/repos/nextbound/bragi-canvas/releases/latest`

Why this source:

- It reflects the latest published release, not a possibly-ahead `main` branch.
- It gives us `tag_name`, `html_url`, release title, and release notes.
- It avoids a separate Bragi service.

The Obsidian community plugin registry is useful for discovery, but it does not include the latest plugin version. `manifest.json` and `versions.json` are useful release metadata, but they should not be overloaded as notification policy.

## Prompt behavior

Automatic prompt:

1. Do not run a background polling interval.
2. Trigger the check when the user opens or switches to any canvas.
3. Treat the 3-hour rule as a cache TTL, not a timer:
   - if `lastCheckedAt` is less than 3 hours ago, do not hit GitHub again;
   - use the latest cached update result if one exists.
4. Compare installed `this.manifest.version` with the latest GitHub release tag.
5. If latest is newer and reminder suppression allows it, show the modal.

This avoids showing an update modal to users who merely opened Obsidian for unrelated notes.

Reminder rule:

- Show the automatic modal at most once per release every 3 hours.
- Use elapsed time rather than Obsidian sessions because many users keep Obsidian open for several days while working on long canvas projects.
- If the user closes the modal or clicks `Later`, do not show it again for roughly 3 hours.
- If a newer release appears, the old reminder state should not suppress the new version.

Manual check:

- Add command: `Bragi Canvas: Check for updates`.
- Manual check ignores automatic reminder suppression.
- If current, show a Notice.
- If outdated, open the same update modal.

## Suppression strategy

Do not use "Skip this version" in the MVP.

Use a rolling 3-hour reminder instead:

- Persist the latest release version we prompted for.
- Persist the timestamp when the modal was last shown.
- Suppress automatic prompts only when the same latest release was shown less than 3 hours ago.
- Do not persist a permanent opt-out.
- Manual checks bypass this suppression.

Persist:

```ts
updatePrompt: {
  lastCheckedAt?: number
  latestVersion?: string
  latestReleaseUrl?: string
  latestReleaseName?: string
  lastPromptedVersion?: string
  lastPromptedAt?: number
}
```

Rules:

- `lastPromptedVersion` is the latest release version that triggered the modal.
- `lastPromptedAt` is set when the automatic modal is shown, not when the network check succeeds.
- `latestVersion`, `latestReleaseUrl`, and `latestReleaseName` cache the last successful GitHub response so the 3-hour TTL still works after plugin reloads.
- Suppress automatic prompts when:
  - `lastPromptedVersion === latestVersion`, and
  - `Date.now() - lastPromptedAt < 3 * 60 * 60 * 1000`.
- If `latestVersion` changes, ignore `lastPromptedAt` and allow the modal again.

This keeps the product behavior nudgy for users who leave Obsidian running for days, without adding a hidden permanent opt-out path.

## Modal UX

Title:

`Update Bragi Canvas`

Body:

- Current version.
- Latest version.
- Short release title if GitHub provides one.
- Short instruction: `Click Update, then use Obsidian's Community Plugins update flow if prompted.`
- Inline release notes link is allowed, but it must not be a modal action button.

Buttons:

- `Update`: open `obsidian://show-plugin?id=bragi-canvas`.
- `Later`: close and suppress the automatic reminder for about 3 hours.

If the Obsidian URI does not work on a platform, the release notes URL is the fallback path.

## Update path

The supported update path is to take the user to Obsidian's community plugin update UI, not to silently replace plugin files.

Button behavior:

1. `Update` opens `obsidian://show-plugin?id=bragi-canvas`.
2. The modal also offers an inline release notes link, but not a separate button.
3. If the Obsidian URI fails, the inline GitHub release page is the fallback.

Why not direct self-update:

- Obsidian's public plugin API does not expose a stable "update this community plugin now" method.
- Obsidian's documented update flow is user-mediated: Settings -> Community plugins -> Check for updates -> Update or Update all.
- A plugin could theoretically download `main.js`, `manifest.json`, and `styles.css` into its own plugin folder, but that bypasses Obsidian's update UI, creates reload/race risks, and depends on behavior outside the stable public API.

So the MVP should be an update prompt plus a deep link into the plugin page. Let Obsidian own the actual install/update action.

## Network and caching

Use `requestUrl` because it is already used throughout the plugin and works inside Obsidian/Electron.

Disclose this network request in the README: Bragi Canvas checks GitHub releases to notify users about plugin updates. Do not send telemetry or vault/user data with this request.

Suggested automatic check cadence:

- Check at most once every 3 hours per installed version.
- Do not register a background polling interval. The 3-hour value is a TTL checked when canvas activation wakes the update checker.
- Store `lastCheckedAt` only for successful checks.
- If the check fails, fail silent except for the manual command.
- Do not block plugin startup on the network request.

This means users can get the prompt soon after returning to a canvas, but the plugin does not keep polling while Obsidian sits in the background.

## Implementation modules

- `src/update-check.ts`
  - Fetch latest release.
  - Validate response.
  - Compare semantic versions.
  - Decide whether an automatic prompt is allowed.
- `src/ui/update-modal.ts`
  - Render modal.
  - Open Obsidian plugin page and release notes.
  - Close the modal and persist 3-hour reminder suppression state.
- `src/main.ts`
  - Trigger update checks from canvas activation.
  - Reuse the existing `layout-change` flow and/or Obsidian workspace events such as `active-leaf-change` / `file-open`.
  - Add manual command.

## MVP checklist

1. Add persisted `updatePrompt` settings.
2. Add GitHub latest-release fetch and version comparison.
3. Show the update modal only when Bragi is relevant.
4. Suppress the automatic modal for about 3 hours after it has appeared for the current latest release.
5. Add manual update-check command.
6. Add focused tests for version comparison and 3-hour suppression logic.
