# AGENTS.md — Velocity

Notes for any agent (human or AI) working on Velocity. Read this before
building or releasing.

## Repositories

- **Private (source):** `https://github.com/barusoup/Velocity`
  Full source code, Tauri config, and the GitHub Actions release workflow
  (`.github/workflows/release.yml`) live here. Nothing user-facing is
  downloaded from this repo.
- **Public (builds + issues):** `https://github.com/barusoup/Velocity-Public`
  Hosts the compiled installers **and** the auto-update manifest as GitHub
  Releases, and is the one and only place users file bug reports / feedback
  (via Issues). No website, no GitHub Pages.

This repo's working tree has **no** website folder — Velocity has no marketing
site. Downloads come straight from the public repo's Releases page.

## The auto-updater

Velocity checks for updates on startup (`src/updater.ts`, invoked from
`src/main.tsx`), downloads the signed platform bundle, verifies its signature
against the embedded public key, installs it, and relaunches — no user
action, no prompts.

- The **manifest** (`latest.json`) is a regular release asset on the public
  repo, uploaded under the fixed name `latest.json` every release. The
  "latest release download" pattern keeps its URL stable forever:

  ```
  https://github.com/barusoup/Velocity-Public/releases/latest/download/latest.json
  ```
- The app's updater endpoint is set in `src-tauri/tauri.conf.json` under
  `plugins.updater.endpoints` and points at that URL.
- Signing keypair: the **public key** is embedded in
  `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). The **private key**
  and its password are stored as repository secrets on the private repo:
  `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
  Never commit the private key. Regenerating the keypair would break updates
  for every prior install.

### Fixed asset names (do not change)

The release workflow uploads each build under a fixed asset name (no version
in the name) so `releases/latest/download/<name>` always resolves to the
newest release:

| Artifact                              | Purpose                              |
|---------------------------------------|--------------------------------------|
| `Velocity-Setup-x64.exe`              | Windows installer (= windows updater target) |
| `Velocity-Setup-x64.exe.sig`          | Windows updater signature           |
| `Velocity-macOS-arm64.dmg`            | macOS Apple Silicon installer       |
| `Velocity-macOS-arm64.app.tar.gz`     | macOS arm64 updater target          |
| `Velocity-macOS-arm64.app.tar.gz.sig` | macOS arm64 updater signature       |
| `Velocity-macOS-x64.dmg`              | macOS Intel installer               |
| `Velocity-macOS-x64.app.tar.gz`       | macOS x86_64 updater target         |
| `Velocity-macOS-x64.app.tar.gz.sig`   | macOS x86_64 updater signature      |
| `Velocity-Linux-x86_64.AppImage`      | Linux installer (= linux updater target) |
| `Velocity-Linux-x86_64.AppImage.sig`   | Linux updater signature           |
| `latest.json`                         | Tauri updater manifest (version, notes, pub_date, per-platform signature + url) |

The manifest's per-platform `url`s also use `releases/latest/download/...` so
the manifest stays valid even across cached GitHub release redirects.

### Manifest schema (Tauri v2)

```json
{
  "version": "0.0.0",
  "notes": "Release notes (markdown-ish, '- ' bullets)",
  "pub_date": "2026-06-29T00:00:00Z",
  "platforms": {
    "windows-x86_64": { "signature": "...", "url": ".../Velocity-Setup-x64.exe" },
    "darwin-aarch64": { "signature": "...", "url": ".../Velocity-macOS-arm64.app.tar.gz" },
    "darwin-x86_64":  { "signature": "...", "url": ".../Velocity-macOS-x64.app.tar.gz" },
    "linux-x86_64":   { "signature": "...", "url": ".../Velocity-Linux-x86_64.AppImage" }
  }
}
```

## Finalizing a release

The one and only release mechanism is the workflow + the steps below.

### Prerequisites (already in place after the first release)
1. A Tauri updater signing keypair exists, with the public key in
   `tauri.conf.json` and the private key + password as repo secrets
   (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) on the
   private repo. Never commit the private key.
2. A cross-repo publish token is stored as the secret `PUBLIC_REPO_TOKEN` on
   the private repo (any token with `contents:write` on
   `barusoup/Velocity-Public`). The release workflow uses it to create the
   release and upload assets on the public repo.
3. `src-tauri/tauri.conf.json` is configured with the Updater plugin
   (`plugins.updater`), bundle targets (`nsis` / `dmg` / `app` / `appimage` —
   `app` produces the macOS `.app.tar.gz` updater target; `appimage`'s updater
   target is the `.AppImage` itself),
   `bundle.createUpdaterArtifacts: true`, and the endpoint pointing at the
   manifest URL above.
4. `.github/workflows/release.yml` on the private repo runs a 4-target matrix
   (windows, macos-arm64, macos-x64, linux), signs the updater bundles, then a
   `publish` job composes `latest.json` and creates the GitHub Release on the
   public repo. It triggers automatically on an annotated tag `vX.Y.Z`.

### Per release
1. **Bump version** in lockstep (keep all three identical, semver, no `v`
   prefix):
   - `package.json` → `"version"`
   - `src-tauri/tauri.conf.json` → `"version"`
   - `src-tauri/Cargo.toml` → `[package] version`
2. **Commit + push the source** to the private repo's default branch (`main`)
   on `https://github.com/barusoup/Velocity`. Don't commit build artifacts
   (`dist/`, `src-tauri/target/`) or `src-tauri/gen/`.
3. **Tag and push** an annotated tag:
   ```
   git tag -a v0.0.0 -m "Velocity 0.0.0"
   git push origin v0.0.0
   ```
   This kicks off `.github/workflows/release.yml`.
4. The workflow:
   - Builds Windows, macOS arm64, macOS x64, and Linux with `tauri build`,
     signing the updater bundles with the private-key secrets (producing
     `.sig` sidecars and the mac `.app.tar.gz` / linux `.AppImage.tar.gz`
     updater targets).
   - Stages every asset under its fixed name (see the table above).
   - In the `publish` job: reads each `.sig` to populate the manifest, writes
     `latest.json` with `version`/`notes`/`pub_date`/per-platform
     `signature`+`url`, and creates a GitHub Release on
     `barusoup/Velocity-Public` tagged `vX.Y.Z`, uploading the installers,
     the updater targets + signatures, and `latest.json`.
5. The agent verifies:
   - `https://github.com/barusoup/Velocity-Public/releases/latest` resolves to
     the new release and all fixed-name assets (table above) are attached.
   - `https://github.com/barusoup/Velocity-Public/releases/latest/download/latest.json`
     serves the new manifest with `version` matching the tag.
   - Optional smoke check: install the build on at least one OS and confirm an
     older copy detects + applies the update and restarts.

## Making a release without a git tag
The workflow also accepts `workflow_dispatch` with a `version` input. Prefer
the tag-driven flow above; use the manual dispatch only when re-publishing a
build without a new tag.

## Don't
- Don't commit `dist/`, `src-tauri/target/`, or `src-tauri/gen/` to the
  private repo.
- Don't commit the updater private key anywhere.
- Don't change the fixed asset names without updating the workflow AND
  `latest.json` for every prior release (or the old releases will 404). Keep
  them stable forever.
- Don't regenerate the signing keypair — it invalidates updates for every
  currently-installed build.