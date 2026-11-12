# <img src="./assets/icon-x48.png" alt="" height="48"> AL Workspace Focus

Work on the AL apps you need without loading every app in your workspace. AL Workspace Focus opens a smaller workspace containing your selected apps and their local dependencies, while keeping your original workspace and app files unchanged.

---

## Features

- **Focus on one or several apps** from an `app.json` context menu or the command palette.
- **Include dependencies automatically** when their app folders are listed in your original workspace.
- **Keep shared folders and settings** available in the focused workspace.
- **Include matching test apps** with an optional setting.
- **Return to your full workspace** with Unfocus.
- **Keep your focus across reloads and restarts**, with no folder picker or manual workspace setup.

---

## Usage

1. Open a saved workspace that lists your AL app folders, or open an individual app folder.
2. Right-click an app's `app.json` in Explorer or the editor and choose **AL Workspace Focus: Focus on Apps...**.
3. To select several apps, run the same command from the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).

Click the **Focus** status bar item, or run **AL Workspace Focus: Unfocus**, to return to the original workspace. **AL Workspace Focus: Refresh Focus** updates the current selection after app dependencies change.

Focus remains active until you explicitly Unfocus, even after reloading or restarting VS Code.

Focused workspaces are stored in `.focussed` beside your original workspace file, or inside an opened app folder. Its own `.gitignore` keeps the contents out of normal Git staging without changing your repository's ignore rules.

> Cached workspaces copy your settings. Gitignore does not make those files private or prevent cloud syncing. Review any dependency or path warnings before continuing.

---

## Extension Settings

Find these under **AL Workspace Focus** in VS Code Settings.

| Setting | Default | Description |
| --- | --- | --- |
| `alWorkspaceFocus.includeTests` | `false` | Include matching test apps for the production apps you select. |
| `alWorkspaceFocus.showStartupNotification` | `true` | Show a message when Focus becomes available. |

---

## Requirements

- VS Code 1.134 or later.
- A trusted workspace with saved workspace and `app.json` changes.
- App folders listed directly in the workspace; repository subfolders are not scanned automatically.

Works with local desktop workspaces, Remote SSH, WSL and Dev Containers. Focus manages workspace folders; it does not build apps or download missing dependencies.

---

## Installing

For a packaged `.vsix` file, run **Extensions: Install from VSIX...** in VS Code and select the file.

## Developer Notes

Use Node 22.22.2+, Node 24.15.0+, or Node 26+, with npm 10 or later.

```powershell
npm ci
npm run ci:check
npm run watch
npm run package
```

Press **F5** to start the watchers and debug the extension in a separate VS Code window.

Normal and packaged builds are fully minified and contain no source maps. Dependency license notices are generated automatically. Watch builds stay readable with source maps for development.

---

## License

Licensed under the [MIT License](./LICENSE).
