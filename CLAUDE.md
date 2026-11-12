# AL Workspace Focus - agent guide

## Purpose

This is a general-purpose VS Code extension for Business Central AL projects. It opens a smaller workspace containing selected apps, their transitive local dependencies and optional matching tests, without editing the original workspace or app files. Unfocus returns to the exact original workspace or folder.

Read `package.json` for the current version, scripts, supported VS Code engine and package contents. Read `README.md` for the user-facing workflow. This guide describes implementation constraints, not additional product features.

## Architecture

Production is TypeScript bundled by esbuild into `out/extension.js`. It runs exclusively in VS Code's browser extension host, including on desktop and remote connections. Node is used for development tools and external test controllers only.

| Location | Responsibility |
| --- | --- |
| `src/extension/extension.ts` | Activation, composition, command registration and workspace/trust event subscriptions. |
| `src/services/focusController.ts` | Native app selection, progress, cancellation, readiness, diagnostics, status bar and Focus/Refresh/Unfocus lifecycle. |
| `src/services/workspaceFiles.ts` | Read the original workspace and directly listed manifests through `workspace.fs`; validate saved, consistent snapshots. |
| `src/services/workspaceOrigin.ts` | Original workspace recovery, filesystem-host compatibility and path/URI resolution. |
| `src/services/cacheFolders.ts` | Automatic `.focussed` location, origin-derived host fingerprint and immutable ignore file. |
| `src/services/focusCache.ts` | Cache identity, publication, validation, reuse and recognition of active focuses. |
| `src/host/browserHost.ts` | URI helpers, Web Crypto, bounded cache I/O, directory checks and owned-stage cleanup. |
| `src/al/` | Manifest schemas, dependency resolution, cycle/duplicate checks and test-app matching. |
| `src/workspace/` | JSONC transformation, path warnings, cache-input encoding and metadata schema. |
| `src/shared/` | Schema primitives, inferred model types, errors, settings and JSONC/UTF-8 helpers. |
| `test/data`, `test/host`, `test/repo` | Domain tests, mocked VS Code tests and shipped-bundle/repository contracts. |
| `test/integration/` | Browser-only test drivers and external Node controllers for actual VS Code journeys. |

Keep domain modules in `src/al`, `src/workspace` and `src/shared` free of VS Code, Node filesystem and process imports. Host-specific effects belong in the host/services layer.

## Public behavior

The command IDs are `alWorkspaceFocus.focus`, `alWorkspaceFocus.refresh` and `alWorkspaceFocus.unfocus`. Keep existing IDs, native context menus, Quick Pick, progress notification and status bar behavior unless a behavior change is explicitly requested.

| Setting | Default | Meaning |
| --- | --- | --- |
| `alWorkspaceFocus.includeTests` | `false` | Include matching tests for explicitly selected production apps. |
| `alWorkspaceFocus.showStartupNotification` | `true` | Notify once per activation when Focus availability has been acknowledged by the UI. |

Activation must remain lightweight: no manifest scan, workspace generation or location picker. It may validate an already-active cache to recover the original origin.

Menu visibility and Focus/Refresh enablement use the acknowledged `alWorkspaceFocus.ready` context. Runtime `workspace.isTrusted` checks remain authoritative. The notification is not a promise that AL loading has finished; already-open context menus must be reopened. Notification dismissal must not delay activation.

## Models, dependencies and JSONC

- `AppManifestSchema`, `AppDependencySchema` and `FocusMetadataSchema` are the source of truth for runtime validation and their inferred TypeScript models. Keep schema imports in `focusTypes.ts` type-only to avoid runtime cycles.
- Models are plain objects with compile-time readonly types, not frozen objects or class instances. Do not introduce coercion, strict unknown-field rejection or runtime freezing as a refactoring shortcut.
- Manifest GUIDs accept the existing GUID shape and normalize to lowercase; do not substitute stricter RFC UUID validation. A dependency supports `id` or legacy `appId`; if both are supplied, they must agree.
- AL versions have four integer components, each between 0 and 2147483647. Leading zeros are accepted and the source string is preserved. Ordinary three-part semver is not equivalent.
- Missing dependencies become an empty array; explicit null and malformed values are errors. Preserve existing error codes, messages and field locations.
- Dependency closure uses GUIDs, includes only listed local apps and retains original root order. Duplicate IDs and local cycles are errors; external dependencies and identity/version differences produce reviewable warnings.
- Automatic tests apply only to explicitly selected production apps, not every prerequisite. Matching prefers a same-publisher sibling named `<folder> Test`, then a unique same-publisher `<manifest name> Test`. Required or explicitly selected test apps remain included independently of the setting.
- A catalog owns its app-ID index. If app data changes, rebuild the catalog rather than shallow-copying it with a stale `byId` map. Build path-rewriting lookups once per transformation.

Workspace and manifest files are decoded as UTF-8 and parsed using Microsoft's `jsonc-parser`, supporting comments, trailing commas and a BOM. Workspace edits use parser-derived nodes and offsets. Keep the single-pass folder-run pruning: repeated per-folder reparsing previously hurt responsiveness.

Do not replace the workspace transformation with regex parsing or full `JSON.stringify` serialization. Preserve comments, unknown settings/properties, custom folder attributes and escaped string contents. Physical output line endings are LF.

## Source and URI safeguards

- Read only manifests directly belonging to roots listed in the original workspace. Do not replace this with `findFiles`, `workspaceContains` or a recursive repository scan.
- Retain `p-map`'s ordered mapping, concurrency 64, fail-fast behavior and AbortSignal. Start I/O inside the mapper. Preserve checks after in-flight reads and cancellation.
- Load from the original origin when already focused, not the reduced workspace. Preserve both complete raw-content snapshots and the final source revalidation before opening; do not use timestamps or cached catalogs as substitutes.
- Never save/discard dirty source editors, modify source AL settings, run builds, download dependencies or use `updateWorkspaceFolders` to implement Focus.
- Use `vscode.Uri` and `workspace.fs` for local and remote I/O. Infer the real scheme/authority from observed URIs, never from `env.remoteName`.
- Resolve paths using source-path semantics, not the browser client's OS. Preserve drive roots, UNC paths, remote POSIX casing and encoded characters. `Uri.fsPath` or Node's `path` alone is not a cross-host replacement.
- Keep app-relative AL settings and workspace variables intact. Leave ambiguous relative configuration paths unchanged with warnings rather than guessing.

Pass an actual URI to `vscode.openFolder` with `{ forceReuseWindow: true, noRecentEntry: true }`. Native Workspace Trust and dirty-editor prompts stay in charge.

## Cache and lifecycle safeguards

`.focussed` is created beside the original `.code-workspace`, or inside the opened app folder for a folder origin. There is no location picker. Its own `.gitignore` contains `*`; the repository's tracked ignore rules are not edited.

Gitignore does not make copied settings private, prevent cloud syncing or untrack committed files. Cache files inherit filesystem/provider permissions. Public `workspace.fs` cannot enforce ACLs, POSIX modes or race-proof no-follow guarantees; do not claim otherwise.

- Publish the managed ignore file before copying workspace configuration. Preserve modified, linked or unsaved managed files and report the problem.
- Keep URI/authority containment, directory/file-type, exposed-link, read-size and metadata checks. Cached GUIDs must already be canonical, lowercase, unique and sorted; do not normalize invalid metadata into acceptance. Preserve UTF-16 text limits and NUL rejection.
- SHA-256 hashes bind raw workspace/manifest inputs, absence markers, selection/options and cache/source identity. AL source contents are not part of the hash.
- Writers use separate random publication directories. Write the workspace first and `focus.json` last, then re-read and verify the completed entry. The sidecar is a logical completion marker, not a portable atomicity guarantee.
- Safe duplicate completed entries are allowed. Prefer the current intact entry; never overwrite a user-edited focus or another writer's files.
- Retain completed caches through Unfocus, reload and restart. Cleanup deletes only the current operation's token-validated incomplete files. Ownership changes and cleanup failures must remain visible, including after cancellation.
- A focus is recognized only when its validated metadata origin maps to exactly the `.focussed` folder the entry lies in; cache naming alone is not ownership. Compare that location with `sameUri`, never as strings, and derive the host fingerprint from the origin rather than from the opened path. There is no profile registration: do not reintroduce Memento or `globalStorageUri` state.
- A planted `.focussed` entry can therefore only point at a workspace file beside it or at its containing folder. Keep that bound when changing recognition.
- Caches from 0.4.x (`al-workspace-focus-browser-v1`) and earlier Node-host caches are unsupported. Do not migrate or delete them automatically.
- Preserve no-op cache hits/Refresh and exact-origin recovery, including when a generated workspace is edited or removed. Do not infer shutdown state or restore on process exit.

Cache format, transform version and path policy are declared in `src/shared/settings.ts`. Preserve serialization and compatibility during refactoring. Intentional output/format changes need a compatibility decision and appropriate versioning.

## Development

Use npm and the lockfile. Development requires Node 22.22.2+, Node 24.15.0+, or Node 26+, and npm 10+. These are the supported versions of the locked npm-run-all2 script runner; the extension itself remains browser-only. Do not add runtime Node dependencies or polyfills.

```powershell
npm ci
npm run ci:check
npm run watch
npm run package
npm run package:list
```

Run dependency installation when dependencies change or are missing, not as an automatic first step. Avoid unrelated dependency upgrades. `npm run compile` checks browser/overall types, zero-warning lint and the bundle. `npm test` runs Vitest; use existing test-file selectors for focused checks.

`npm run watch` runs esbuild and the overall/browser type checks concurrently. `npm run test:data`, `test:host` and `test:repo` select the existing Vitest projects; only host tests have a VS Code mock alias.

Press F5 for the configured web-worker development host. The default build task starts watchers with readiness matchers; install the recommended esbuild problem-matchers extension. Watch builds stay readable with source maps for debugging. Normal and package builds use full esbuild minification, remove the stale generated map and remain map-free. Do not add property mangling, encryption or obfuscation; public API/model names must remain compatible. generate-license-file produces `out/THIRD-PARTY-NOTICES.txt` from the installed production dependencies during normal builds; do not edit or commit that generated file. Keep the project's own LICENSE unchanged and retain legal comments. Build output is `out/extension.js`. The manifest's positive package allowlist intentionally excludes sources, maps, tests, agent instructions and fixture data.

Formatting is four spaces, single quotes and semicolons in TypeScript, with strict typing and type-only imports. Use interfaces for structural models except schema-derived aliases. Keep function/method signatures on one source line. All text files use LF; Markdown paragraphs and list items are not hard-wrapped. Prefer small focused helpers, explicit errors and standard APIs; avoid unnecessary casts, abstractions and comments.

Public scripts deliberately invoke relative `node node_modules/...` entrypoints, including npm-run-all2, to avoid Windows CMD shim problems in paths containing `&`. Native launches must remain non-shell and support spaces/special characters.

## Verification and environment boundaries

Use `npm run ci:check` for runtime changes. Add focused cases for changed behavior or compatibility, not tests that merely restate constants or implementation details.

Actual browser tests use isolated profiles and owned source fixtures:

```powershell
$env:VSCODE_EXECUTABLE_PATH = 'C:\path\to\Code.exe'
npm run test:integration -- --version stable
npm run test:smoke -- --version stable
npm run test:smoke -- --version stable --folder
npm run test:readiness
```

For minimum-host verification, run `npm run test:integration:minimum` with an executable matching the declared minimum, or clear the override to allow an owned download. `ALWF_VSCODE_CACHE_PATH` selects the download location. Linux native tests need a display or Xvfb.

Lifecycle coverage must observe Focus, cache hit, unchanged Refresh, reload, full quit/restart, exact Unfocus, unchanged source hashes and retained completed cache. A mocked URI or VM bundle check does not prove actual worker execution or a remote journey.

For representative performance measurements, use an owned workspace-file copy referencing read-only real app roots so `.focussed` stays in the fixture. Compare baseline/candidate on the same pinned host and extension workload. Record handler, validated generation and observed switch separately; retain slow/failed runs. The goal is below ten seconds, ideally below five, not a guaranteed deadline or AL-compilation time.

The browser-only design avoids a previously measured Node extension-host stall in VS Code's startup file-search/process creation. Extension affinity did not remove that stall. Do not reintroduce a Node `main` entry, companion host, hidden search scan or speculative URI workaround. Shared VS Code filesystem and workbench services still cause timing variability.

Never install test builds into the normal profile, bypass native trust, save user editors, provision WSL/Docker/SSH hosts or modify system installations without explicit authorization. Restrict cleanup to inspected, explicitly owned fixtures/caches and process IDs. Preserve useful sanitized evidence without retaining credentials or raw connection logs. Report unavailable real-host coverage honestly.

## Documentation, artwork and Git

Keep `README.md` concise, generic and user-oriented. Do not insert private repository names, workspace statistics, benchmark transcripts or implementation history. Update `CHANGELOG.md` for meaningful releases.

`assets/icon.svg` is the supplied editable artwork. The committed `icon-x512.png` is the extension icon and `icon-x48.png` is the README header. Normal builds must not overwrite them with generated replacement artwork.

This guide and local `.claude` state are Git-ignored. Keep shared `.vscode` configuration, package-lock and the supplied assets trackable; do not delete local agent guidance as part of cleanup.

Inspect the working tree before editing and preserve unrelated user changes. Make commits, pushes, branch changes, releases and normal-profile installations only when explicitly requested. Do not stash/reset existing work or automatically include unrelated files.
