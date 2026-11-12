# Changelog

## 1.0.0

- Fully minify normal and packaged builds without source maps; keep watch builds readable for debugging.
- Generate dependency license notices automatically during normal builds instead of maintaining them by hand.
- Recognize a focus by checking that its recorded original workspace or folder owns the `.focussed` folder it lies in, instead of a per-profile registration. Unfocus now also works from another profile, after extension storage was cleared, or from another client of the same remote.
- Stop using extension state and profile storage. Focuses created by 0.4.x are no longer recognized; reopen the original workspace manually. Focuses created by this version are not recognized after downgrading to 0.5.x.
- Simplify cache helpers and publication without changing the cache format; existing 0.5.x focuses are reused as they are.

## 0.5.2

- Use schema-backed models and a standard bounded promise mapper while preserving existing validation and cache behavior.
- Reuse workspace lookups, controller helpers and native test utilities.

## 0.5.1

- Simplify the README around features, usage and settings, without project-specific benchmarks or implementation details.
- Use the supplied artwork for the extension icon and README header.

## 0.5.0

- Create `.focussed` automatically beside the original workspace file or inside an opened app folder, with no location picker.
- Ignore cache contents through `.focussed/.gitignore` without changing the repository's tracked ignore rules.
- Publish ignore and profile-registration files without overwriting existing modified content; preserve source and remote URI semantics.
- Keep registered 0.4.x browser caches available for validated Unfocus while new focuses use the automatic location.

## 0.4.1

- Read listed manifests through a bounded rolling queue instead of fixed batches, avoiding redundant directory stats for app roots.
- Detect duplicate roots using normalized URI keys without pairwise URI parsing.
- Remove omitted JSONC folder runs in one edit pass while preserving selected-root comments and unrelated configuration.
- Reduce serial cache filesystem round trips while retaining ancestor/link checks, immutable publication, digest verification and complete source revalidation before opening.

## 0.4.0

- Run exclusively in VS Code's browser worker to avoid the Node host's startup search/process-creation stall.
- Use URI-based filesystem I/O and Web Crypto without a Node fallback or helper service.
- Remember a user-selected private cache folder per local/remote host, outside source workspaces.
- Retain validated immutable cache entries; concurrent writers may safely complete duplicate entries without overwriting user edits.
- Preserve native Focus/Refresh/Unfocus commands, the acknowledged readiness notification and exact-origin lifecycle.
- Replace Node-host verification drivers with actual-browser-worker activation, readiness and lifecycle checks.

## 0.3.1

- Use one acknowledged UI-ready state for Focus menus, command enablement and the startup notification instead of waiting for VS Code's late trust context key.
- Suppress stale readiness notifications when trust or workspace folders change during a UI update.

## 0.3.0

- Show a non-blocking startup notification when Focus becomes available; disable it with `alWorkspaceFocus.showStartupNotification`.

## 0.1.0

- Focus a saved AL workspace on selected apps, transitive listed dependencies and optional matching tests.
- Keep non-app roots and source JSONC configuration without editing the original workspace.
- Retain host-local, content-addressed focuses through reloads and restarts until explicit Unfocus.
