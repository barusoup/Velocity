# AGENTS.md — Velocity

Notes for any agent (human or AI) working on Velocity. Read this before
building or releasing.

## Repository

- **Single repo:** `https://github.com/barusoup/Velocity`
  Source code, Tauri config, the GitHub Actions release workflow
  (`.github/workflows/release.yml`), compiled installers, the auto-update
  manifest, and the issue tracker all live here. Downloads come straight from
  this repo's Releases page.

This repo's working tree has **no** website folder — Velocity has no marketing
site beyond the README.

## The auto-updater

Velocity checks for updates on startup (`src/updater.ts`, invoked from
`src/main.tsx`), downloads the signed platform bundle, verifies its signature
against the embedded public key, installs it, and relaunches — no user
action, no prompts.

- The **manifest** (`latest.json`) is a regular release asset on this repo,
  uploaded under the fixed name `latest.json` every stable release. The
  "latest release download" pattern keeps its URL stable forever:

  ```
  https://github.com/barusoup/Velocity/releases/latest/download/latest.json
  ```
- The app's updater endpoint is set in `src-tauri/tauri.conf.json` under
  `plugins.updater.endpoints` and points at that URL.
- Signing keypair: the **public key** is embedded in
  `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). The **private key**
  and its password are stored as repository secrets:
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
    "darwin-aarch64": { "signature": "...", "url": ".../Velocity-macOS-arm64.app.tar.gz" }
  }
}
```

## Finalizing a release

When asked to push a release, an agent must perform every step below. This is
the **only** supported release path.

### Prerequisites (verified once, already in place)
1. A Tauri updater signing keypair exists, with the public key in
   `tauri.conf.json` and the private key + password as repo secrets
   (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) on the
   private repo. Never commit the private key.
2. `src-tauri/tauri.conf.json` has the Updater plugin configured
   (`plugins.updater`), bundle targets including `nsis` / `dmg` / `app`,
   `bundle.createUpdaterArtifacts: true`, and the endpoint pointing at the
   manifest URL.
3. `.github/workflows/release.yml` is the CI/CD workflow.
   It triggers automatically on an annotated tag `vX.Y.Z`. Its `build`
   matrix runs `npm run verify-release` as a fail-fast gate before any
   platform build, so a broken icon state in the source tree aborts the
   workflow before 8-minute matrix builds burn CI minutes.

### Step-by-step

1. **Bump version** in lockstep (keep all three identical, semver, no `v`
   prefix):
   - `package.json` → `"version"`
   - `src-tauri/tauri.conf.json` → `"version"`
   - `src-tauri/Cargo.toml` → `[package] version`

   Also update the **Settings page footer** (`src/components/SettingsPage.tsx`,
   bottom-of-page "Velocity vX.Y.Z" string) so the in-app version matches the
   new release. This footer is hardcoded and must be edited by hand each
   release.

2. **Clean the working tree.** Remove anything not fit for the source repo:
   - AI agent artifacts: `.claude/`, `.codex/`, `.commandcode/`, `.opencode/`
     (these should already be in `.gitignore` — verify and add missing entries)
   - Scratch / temp / debug files left in the project root (e.g.
     `ts_output.txt`, `all_lines.txt`, `print_lines.cjs`, `show_line.cjs`,
     `*.lines.txt` — already in `.gitignore`, but check none are tracked)
   - Build outputs: `dist/`, `src-tauri/target/`, `src-tauri/gen/`
   - Log files: `*.log`
   - Any other files that are not source code, not config, not design assets
   - Update `.gitignore` if a new category of temp files is found; commit the
     `.gitignore` change alongside the source

3. **Verify release assets locally.** This is a hard gate — never tag a
   release whose verify exits non-zero:
   ```
   npm run verify-release
   ```
   `scripts/verify-release-assets.mjs` checks:
   - **`icon.ico` has ≥ 3 ICONDIR frames.** Single-frame ICO pixelates the
     Windows taskbar at every size. Typical `npx tauri icon` output is 6
     frames (16/24/32/48/64/256).
   - **`icon.icns` has the `icns` magic.** Files without the magic load as
     broken-image icons on macOS.
   - **`tauri.conf.json`'s `bundle.icon` does NOT include `desktop-icon.png`.**
     The 875×875 wrapper is a SOURCE for `npx tauri icon`, never a bundling
     target — it has a 13 px transparent horizontal pad that fuzzes any
     downscaled copy.
   - **`public/icon.png` and `public/splash-icon.png` exist AND are tracked
     by git.** Untracked = 404 in production. CI runners only carry tracked
     files (`actions/checkout@v4`) even though Vite's local build doesn't
     care.
   - **`velocity-logo.png` (the byte-preserving canonical master) exists on
     disk.** Required for re-deriving the icon set after any source-of-truth
     change.
   - **`src-tauri/icons/desktop-icon.png` is square.** Non-square wrappers
     break `npx tauri icon`'s center-crop logic.

   Fix any failing check before tag-and-push. The script ALSO runs as a
   fail-fast gate inside `.github/workflows/release.yml`'s `build` matrix,
   so a bad local state is caught before 8-minute platform builds waste CI
   minutes.

4. **Stage, commit, and push source**:
   ```
   git add -A
   git commit -m "Velocity X.Y.Z"
   git push origin main
   ```
   Confirm no build artifacts or secrets leaked into the commit. The default
   branch is `main` at `https://github.com/barusoup/Velocity`.

5. **Tag and push** an annotated tag matching the version:
   ```
   git tag -a vX.Y.Z -m "Velocity X.Y.Z"
   git push origin vX.Y.Z
   ```
   This kicks off `.github/workflows/release.yml`.

6. **Wait for the workflow to finish.** The workflow:
   - Runs `npm run verify-release` on every matrix build as a fail-fast
     gate. A non-zero exit there means a bad commit slipped past the local
     verify — cancel / drop the tag, fix, and re-push.
    - Builds Windows + macOS Apple Silicon (arm64) with `tauri build`, signing the
     updater bundles (produces `.sig` sidecars and updater targets).
   - Stages every asset under its fixed name (see the fixed-asset-names table
     above).
   - In the `publish` job: reads each `.sig`, composes `latest.json`
     (omitting platforms that weren't built), creates a GitHub Release tagged
     `vX.Y.Z`, and uploads all installers, updater targets + signatures, and
     the manifest.

7. **Verify the release**:
   - `https://github.com/barusoup/Velocity/releases/latest` resolves to the
     new release and all expected assets are attached.
   - `https://github.com/barusoup/Velocity/releases/latest/download/latest.json`
     serves the new manifest with `version` matching the tag, and only
     includes platforms that were actually built (non-empty `signature`).
   - Optional smoke test: install the build on at least one OS and confirm an
     older copy detects + applies the update and restarts.

   **If the smoke install shows a fuzzy or wrong OS icon even though
   `npm run verify-release` was green, the install is fine — it's a
   per-user OS icon cache that needs flushing.** Use these recipes to force
   a re-read of the bundled icon:

   - **Windows**: `ie4uinit.exe -show`. If still wrong, delete the cache
     file and restart Explorer:
     ```powershell
     del /a "%LocalAppData%\Microsoft\Windows\Explorer\IconCache.db"
     del /a "%LocalAppData%\Microsoft\Windows\Explorer\thumbcache_*.db"
     taskkill /F /IM explorer.exe & start explorer.exe
     ```
   - **macOS**: drag the installed `.app` out of `/Applications`, drag it
     back. The Dock re-reads the icon at relaunch time.

### Removing an existing tag

If re-releasing the same version (e.g. to fix a broken build), the workflow
already drops the existing release + tag before creating the new one. No
manual cleanup needed — the `publish` job includes a `Drop prior release for
overwrite` step that handles it via `gh release delete`.

### Release notes

The release body is user-facing — it appears in the
auto-updater dialog and on the public Releases page. The publish workflow
reads notes from the **annotated tag message** (`git tag -a`). Put the final,
user-facing text in the tag body (not just the commit subject). Same content
goes into the `"notes"` field of `latest.json` on **stable** releases only;
experimental pre-releases skip `latest.json` (see below).

#### Writing rules

- **Never reference source code.** No filenames, no function names, no
  commit hashes, no PR numbers, no internal identifiers.
- **Rewrite for users.** Turn rough dev notes into plain, specific sentences
  a player would understand. Prefer "Fixed the 100-song cap when importing
  Spotify playlists" over "fix spotify import limit".
- **Be concise but complete.** Cover everything the user would notice. Omit
  internal trivia (dependency bumps, refactors, CI changes) that don't affect
  the player.
- **Use present tense for features, past tense for fixes** where it reads
  naturally ("Adds …", "Fixed …", "Reworked …").

#### Layout (required for non-trivial releases)

Organize notes into a short intro, then **bold category headers**, then
`- ` bullets under each. Section order is flexible — group by what makes sense
for the release — but always use this structure instead of one flat list.

1. **Intro (1–2 sentences).** What this release is. For experimental builds,
   state that it is early access, may be unstable, and that the auto-updater
   will not offer it to stable installs.
2. **New** — features and additions.
3. **Thematic fix/improvement sections** — name them for the release (e.g.
   *Queue & playback*, *Imports & library*, *UI & windowing*, *Lyrics &
   video*). Use as many sections as needed; merge small related items rather
   than creating one-item sections.
4. **And more** (optional) — one line catching smaller polish items not worth
   their own bullet.

Good (structure and tone — v0.1.0 Experimental):
```
Experimental pre-release. Early access build — features may be unstable and
the auto-updater will not offer this version to stable installs.

**New**
- Home page with personalized recommendations and daily picks
- Save artists to your Collection
- Inline search suggestions as you type

**Queue & playback**
- Reworked queue and listening history logic
- Remade the song preload system for smoother playback
- Clear All in the queue menu now clears the right list depending on which tab you're on

**Imports & library**
- Fixed the 100-song cap when importing Spotify playlists
- Fixed some songs failing to load due to API data handling

**UI & windowing**
- Fixed window size not restoring after leaving fullscreen
- Fixed inertial scrolling on song lists fighting with marquee scrolling

**And more** — numerous smaller player, search, and stability improvements throughout the app.
```

Bad:
```
- feat: add TabNavigation component (closes #42, 7a3f1e9)
- fix: handle OOM in src/parsers/LogParser.ts
- chore: bump serde to 1.0.200
- reworked queue, fixed spotify cap, sidebar bug, fullscreen, marquee scroll collision, ...
```

After publish, verify the release body on GitHub matches the
tag notes. If the workflow picked up the wrong text (e.g. commit subject
instead of tag annotation), patch the release body on the public repo.

#### Experimental pre-releases

Tag annotations containing "experimental" (case-insensitive), or
`workflow_dispatch` with `experimental: true`, publish a **pre-release** on
Experimental releases: title suffix " Experimental", `--prerelease`, and no
`latest.json` asset so `releases/latest` stays on the current stable build.
Release notes still use the same layout and writing rules above; the intro
must call out the experimental / no-auto-update behavior.

## Making a release without a git tag
The workflow also accepts `workflow_dispatch` with a `version` input. Prefer
the tag-driven flow above; use the manual dispatch only when re-publishing a
build without a new tag.

## Optional: pre-commit icon-system guardrail

Velocity ships an opt-in git hook at `.githooks/pre-commit` that blocks the
icon-system regressions documented throughout this file — re-adding
`desktop-icon.png` to `bundle.icon`, git-rm'ing `public/icon.png` /
`public/splash-icon.png`, and regressing `icon.ico` to single-frame.

It's not auto-enabled. Wire it once per checkout:

```
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit   # macOS only; Windows Git Bash picks up the executable bit when the hook ships executable in the index.
```

After that, every local commit runs the same ICONDIR/bundle.icon checks as
`scripts/verify-release-assets.mjs`. To skip for a single commit (emergency
hotfix, etc.), use `git commit --no-verify -m "..."`. The local hook and
the CI verify-release gate are independent — both run, but the hook runs
before git writes the commit object, the CI gate runs after tag-and-push.

### Tier 3: post-build bundled-installer verification

For belt-and-suspenders, after `npm run tauri -- build` produces a real
installer, run `npm run verify-bundled-installer`. The script uses `7z`
(p7zip on macOS, 7-Zip standalone on Windows) to extract the produced
artifacts — NSIS `.exe`, `.dmg`, or `.app.tar.gz` — and re-runs the
ICONDIR / icns-magic checks against the EMBEDDED icon resources. This
catches the failure class where the pre-build verifier says green but
Tauri's bundler still ships a broken icon (the registry of issues that
wiped out the previous release).

Without `7z` on PATH the script refuses to run with a clear install
message: `brew install p7zip` (macOS) or install 7-Zip standalone
(Windows) unblocks it.

## Don't
- Don't commit `dist/`, `src-tauri/target/`, or `src-tauri/gen/` to the
  private repo.
- Don't commit the updater private key anywhere.
- Don't change the fixed asset names without updating the workflow AND
  `latest.json` for every prior release (or the old releases will 404). Keep
  them stable forever.
- Don't regenerate the signing keypair — it invalidates updates for every
  currently-installed build.
- Don't auto-sync `public/icon.png` or `public/splash-icon.png` from
  `src-tauri/icons/icon.png` (or any other Tauri derivative). The `public/`
  icons are **user-curated** and NOT part of the `npx tauri icon` regen
  chain; edit them by hand only when you intend to change the in-app UI
  art.

> Icon provenance and regen workflow live in **Design assets** below —
> `velocity-logo.png` is the byte-preserving source-of-truth and
> `src-tauri/icons/` is the reproducible regen artifact set.
> `public/icon.png` and `public/splash-icon.png` are separate, user-curated
> assets and are **not** part of this chain.

## Design assets

**Canonical byte-preserving master:** `velocity-logo.png` (project root), the
user's original full-resolution artwork, preserved untouched — currently
862 × 875 px. This file is **non-square on purpose** (it's your highest-resolution
raw raster), so **do not feed it directly to `npx tauri icon`** — doing so
recovers the original "black borders / squashed" bug because the CLI expects a
square source.

**Canonical square wrapper:** `src-tauri/icons/desktop-icon.png` —
875 × 875 RGBA. It holds the original 862 × 875 design with a 13-px transparent
horizontal pad so `npx tauri icon` gets a perfectly square RGBA source with the
visible artwork untouched at native res. **This is the file you feed to
`npx tauri icon`.**

**Re-derive step** (only needed if the source-of-truth master changes):
If `velocity-logo.png` doesn't exist at the root yet, run step 1 first to
create it; otherwise carry on with step 2.

1. Drop the new full-res source PNG into the project root and rename it to
   `velocity-logo.png` (preserves chain of custody — never overwrite
   `velocity-logo.png` if you've lost the previous bytes; commit each
   replacement so the history is reviewable).
2. Regenerate the square wrapper. Prereq (use `python -m pip` not bare `pip`,
   so the install lands in the same interpreter that runs the recipe):
   `python -m pip install Pillow`. PIL re-encodes the PNG every run, so on a
   no-op rerun `desktop-icon.png`'s bytes will differ from the previous run
   by a few bytes (deflate state) even though the image is identical — that's
   the encoder, not a real change. PIL's integer-arithmetic centering also
   implies a 1-px asymmetry when the source-to-canvas pixel difference is odd
   (e.g. an 862×875 source into an 875×875 canvas puts 6 px on the left, 7 on
   the right); this is invisible at taskbar frame sizes and is left as-is:
   ```bash
   python -c "from PIL import Image; src = Image.open('velocity-logo.png').convert('RGBA'); w, h = src.size; s = max(w, h); canvas = Image.new('RGBA', (s, s), (0, 0, 0, 0)); canvas.paste(src, ((s - w) // 2, (s - h) // 2)); canvas.save('src-tauri/icons/desktop-icon.png')"
   ```
3. Regenerate every Tauri derivative from the square wrapper (NOT from
   `velocity-logo.png`), then reorder the `.ico` frames so the largest
   frame is first. Some Windows shortcut-rendering paths load the first
   frame they can decode and scale it; putting the 256×256 frame first
   prevents those paths from upscaling a 32×32 frame:
   ```bash
   npm run regen-icons
   ```

That is the full regen — stop here. `public/icon.png` and
`public/splash-icon.png` are user-curated (sidebar + splash) and are NOT
part of this chain; do not copy Tauri derivatives over them as a follow-up
to step 3.

**Commit together.** `src-tauri/icons/` is the regen artifact set — every
`npx tauri icon` run produces a large diff, and that's expected.
Hand-editing its contents is not productive (the next regen will
overwrite your changes); commit only changes that came out of the
recipe above.

**`public/` icons are user-curated.** `public/icon.png` (consumed by
`src/components/Shared.tsx` and `src/components/Sidebar.tsx`) and
`public/splash-icon.png` (consumed by `index.html` for the splash image
and `<link rel="preload">`) are NOT part of this regen chain. Edit them by
hand only when you intend to change the in-app UI art — never via the
recipe above.