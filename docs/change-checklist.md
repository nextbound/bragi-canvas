# Change and release checklist

Use this checklist for changes to Bragi Canvas or its companion repositories.
Update only affected surfaces. Do not make empty edits just to touch every repo.

## Before merging

| Change | Review and update when affected |
| --- | --- |
| MCP tools, fields, defaults, results or errors | Plugin schema/behavior; skill `SKILL.md` and `references/tools.md`; public MCP guide and examples |
| Models, providers or generation parameters | Plugin catalog and UI/MCP behavior; skill `references/models.md`; website catalog and setup/capability docs |
| Connections, prompts or task recovery | Plugin behavior tests; skill gotchas/workflows; public first-generation and recovery guides |
| File migration, uploads, storage or permissions | Plugin/Worker behavior; skill limitations; public migration and privacy docs |
| Website routes or UI | Navigation, redirects, search and relevant screenshots; keyboard, mobile and theme checks when affected |

In the PR description, record affected repositories with companion PRs or
commit IDs, checks run, and a short reason for any surface that needs no update.
Use the existing PR/task for this record; no separate tracking system is needed.

Use matching branch suffixes for coupled plugin/skill changes. Verify both
candidate revisions before merging either, then merge the companion changes as
one coordinated operation. Matching branch names alone are not verification.

Run each affected repository's `npm run verify`. For catalog changes also run
plugin `npm run audit:catalog`. In the coordination workspace run
`npm run sync:check -- --plugin PLUGIN_DIR --skill SKILL_DIR --website WEBSITE_DIR`
against the actual companion checkouts. This checks versions and tool names;
review parameter and behavior changes explicitly because it cannot verify prose.
Do not report a failed or skipped check as passed.

## Plugin release and website follow-through

1. Verify the release commit using `docs/obsidian-review-checklist.md`, publish the
   plugin, check its three assets, and open the Community release check page.
2. After the stable release exists, update the website's `releases.json`, public
   changelog and released catalog, plus the docs identified above. Never publish
   Unreleased changes as a released version; derive public notes from the plugin
   `CHANGELOG.md` and verify released entries against the published plugin tag.
3. Run website `npm run verify` and `npm run check:releases`, review the preview,
   then deploy the merged website change and check installation, version and search.

A plugin fix may ship before the website. Keep the website follow-up linked in
the release PR/task until deployed; if deferred, record a target date and what
remains. Report plugin publication and website completion separately. A release
check failure or an unavailable GitHub check leaves that step incomplete; fix or
record it explicitly rather than silently skipping it. No bot or scheduled job
is implied by this checklist.
