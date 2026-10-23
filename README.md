# Uproot

<img src="build/icon.png" width="96" align="right" alt="" />

A Windows desktop tool that uninstalls applications **and** cleans up what their
own uninstallers leave behind: leftover files and folders, registry keys, shell
extensions / context-menu handlers, services and startup entries, and orphaned
shared runtimes.

Built with Electron (plain CommonJS, no bundler, no runtime npm dependencies).
All privileged work is done through PowerShell, and every destructive action is
either reversible (quarantine) or backed up (registry export) first.

## Requirements

- Windows 10 or 11 (x64)
- Node.js 22+ to run from source
- Windows PowerShell 5.1 (present on all supported Windows versions)
- `winget` (App Installer) is optional but enables uninstall of Store/MSIX and
  winget-managed packages; the app works without it

## Running from source

```powershell
npm install
npm start        # launches the app
npm run dev      # same, with DevTools open
npm test         # unit tests for the pure logic (node:test, no Electron needed)
```

> Formerly **App Remover**. On first launch Uproot moves your settings, history,
> logs and quarantine store from `%APPDATA%\App Remover` to `%APPDATA%\Uproot`;
> existing quarantine batches stay restorable.

## Using the app

### Appearance

The theme is switchable between **Dark**, **Light** and **System** (follows the
Windows app theme). Change it in two places:

- the icon button in the top command bar — each click cycles Dark → Light →
  System, and the glyph shows the current mode (sun / moon / monitor); or
- **Settings → Appearance**, via the segmented control.

The choice is persisted in `settings.json` and applied by the main process with
`nativeTheme.themeSource`, so the whole window — including native scrollbars and
form controls — matches from the moment it opens.

### Privacy

The **Privacy** view inventories Windows telemetry and behaviour-tracking items
that can be removed through the same pipeline as application leftovers:

- **Services** — the Connected User Experiences and Telemetry pipeline
  (`DiagTrack`), the WAP push / telemetry relay (`dmwappushservice`) and the
  Windows Error Reporting Service (optional, unchecked by default). The service
  key is exported to a `.reg` backup before `sc delete` runs.
- **Scheduled tasks** — everything under the Application Experience, Customer
  Experience Improvement Program, Feedback, Windows Error Reporting, Device
  Information, DiskDiagnostic and Autochk folders (benign tasks such as
  `StartupAppTask` are always skipped). Tasks are exported to XML first.
- **File stores** — the Connected Devices (Timeline) activity history, feedback
  staging data and the Windows Error Reporting report folders. Files follow the
  chosen cleanup mode: quarantine, or permanent delete.

The scan is catalog-driven: a live service, task or folder only appears after it
matched an entry in `src/main/privacy/privacy.js`, so everything the tool can
remove is reviewable in one place. The **Settings → Privacy** group decides
which of the three categories the scan includes.

### Removing built-in Windows components

Windows blocks force-removal of its own apps. With **Settings → Overrides →
"Force-remove Windows components"** enabled (the wizard also offers to turn it
on the first time you try) the uninstall wizard:

- un-hides system components in the app list;
- removes an MSIX package **for every user account** and takes the
  **provisioned copy** out of new profiles (with a UAC prompt);
- verifies removal by checking the registry entry and package registration,
  ignoring the OS-managed package folders that always remain under
  `WindowsApps`.

Removing protected components can break Windows features, Store apps or
updates. The default keeps the override off, and every attempt shows a red
warning in the wizard's first step.

### Finding an application

The search box matches every word you type (all terms must match) against name,
publisher, version, winget id, install path and architecture, and ranks
name matches first. Matching text is highlighted, and when a result matched on
something other than the name, the row shows which field it matched.

| Shortcut | Action |
| --- | --- |
| `Ctrl`+`F` or `/` | Focus the application search (from any view) |
| `↓` / `↑` | Move the selection through the results |
| `Enter` | Open the first result |
| `Esc` | Clear the search |

Paths, install commands and registry keys are monospaced and hover-reveal a
**copy** button; the full value is also available as a tooltip when truncated.

## Building an installer

```powershell
npm run pack     # unpacked build in dist/ (fast, no installer)
npm run dist     # NSIS installer in dist/
```

The icon is generated from `build/icon.svg` (and `build/icon-small.svg` for
16–32 px, where the roots would blur). After editing either, regenerate
`build/icon.png` and the multi-resolution `build/icon.ico` with:

```powershell
npm run icons
```

The application itself runs as a standard user (`asInvoker`). It elevates
**per operation** through a UAC prompt only when a step actually needs
administrator rights.

## How it works

### 1. Enumeration

Installed programs are gathered from three independent sources and merged:

- **Registry** — the `Uninstall` keys under HKLM, HKCU, the WOW6432Node view,
  and every loaded user hive (`HKEY_USERS`), so per-user installs are included.
- **winget** — `winget list` (parsed from its fixed-width table; no JSON output
  is available in current winget builds).
- **AppX / MSIX** — `Get-AppxPackage`.

The merge joins winget rows to registry rows by their `ARP\...\KeyName`, joins
`MSIX\...` rows to AppX packages by full package name, and falls back to fuzzy
name matching only as a last resort. Multi-source apps show a combined source
badge.

### 2. Uninstall

For each app a plan is derived, in this order of preference:

1. **AppX / MSIX** — `Remove-AppxPackage` (optionally for all users + the
   provisioned package, which requires elevation)
2. **MSI** — silent `msiexec /x{GUID} /qn /norestart` with a verbose log
3. **Vendor quiet uninstaller** — detected from `QuietUninstallString`
4. **winget** — `winget uninstall --id ... --exact --silent`
5. **Vendor interactive uninstaller** — runs the real UI wizard
6. **Protocol handler URL** — opens the vendor's uninstall URI

Running processes from the install folder are closed first (optional), and
removal is verified afterwards by re-checking the registry entry, the AppX
registration and the install folder.

### 3. Leftover scanning

After an uninstall (or on demand for any installed app), the scanner looks for:

- **Files and folders** in install/program/app-data locations whose name matches
  the application — with a whole-tree walk for install folders
- **Registry keys** created by the app, matched by name and path
- **Whole-registry path references** (`reg query <root> /s /f <path> /d`) that
  catch COM registrations, shell integration and similar dependencies that are
  not keyed on the app name
- **Services, scheduled tasks, startup entries and shell extensions** whose
  target or command line points into the app's install folder or matches its
  names
- **Shared runtimes** (VC++, .NET, Java, …) whose import tables show the app
  depended on them

Matches are scored and given a confidence (`MATCH` / `PROBABLE` / `REVIEW`).
Only high-confidence matches are pre-selected; anything that also matches
another installed product is unchecked automatically and flagged.

### 4. Cleanup and reversibility

- **Files** are moved to a **quarantine store** by default (permanent delete is
  opt-in). Restore or purge individual batches from the Quarantine view.
- **Registry keys** are always exported to `.reg` backups before deletion; the
  handler/CLSID keys of shell extensions are removed the same way.
- **Services** are stopped and removed with `sc delete` (service key exported
  first). **Scheduled tasks** are exported to XML then unregistered. **Startup
  entries** have only the specific Run value removed — the whole `Run` key is
  never deleted.
- Machine-scope changes are performed by an elevated worker, one UAC prompt per
  operation.

### Safety model

A cleanup target is refused if it is a drive root, a top-level directory, a
protected system directory (Windows, Program Files, ProgramData, user profile
roots, …), an ancestor of a protected directory, or inside the quarantine store.
Only files clearly attributable to the application are offered, and nothing is
ever removed silently.

## Shared runtime analysis

The Runtimes view reads the PE import tables of every other installed program to
find which shared runtimes actually have dependants. A runtime with **no known
dependants** is only ever reported as a *suggestion* — drivers and other software
can use these silently — and is never removed automatically.

## Project layout

```
src/
  main/            Electron main process
    scan/          registry, winget and AppX enumeration + merge
    leftovers/     leftover discovery + quarantine/cleanup worker
    privacy/       catalog-driven Windows telemetry & activity inventory
    system/        services, tasks, startup, shell extensions, runtime analysis
    uninstall/     plan derivation + uninstall execution
    util/          process/PS/registry/elevation/PE-parsing helpers
    ipc.js         all renderer<->main channels
    store.js       settings, history, quarantine/log locations
  preload/         contextBridge API
  renderer/        UI (index.html, CSS, core/views/wizard/main JS)
build/             icon sources (SVG) and generated icon.png / icon.ico
scripts/           icon builder and manual probes against the live system
test/              unit tests
fixtures/          captured winget / AppX output used by tests and probes
```

## Notes and limitations

- Interaction with a vendor's interactive uninstaller cannot be automated; the
  wizard window is shown and the user finishes it.
- winget in some versions does not support `--output json`; the positional table
  parser handles the current fixed-width format.
- MSIX packages removed for "all users" also remove the provisioned package;
  this requires administrator rights.
- Runtime analysis is a heuristic built from import tables; treat its
  suggestions as guidance, not proof of safety.
