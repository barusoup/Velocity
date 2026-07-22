<p align="center">
  <img src="public/icon.png" alt="Velocity" width="128" height="128">
</p>

<h1 align="center">Velocity</h1>

<p align="center">
  <strong>A fast, focused desktop music player for Windows and macOS.</strong>
</p>

<p align="center">
  <a href="https://github.com/barusoup/Velocity/releases/latest">
    <img src="https://img.shields.io/github/v/release/barusoup/Velocity?label=latest&sort=semver" alt="Latest release">
  </a>
  <a href="https://github.com/barusoup/Velocity/releases">
    <img src="https://img.shields.io/github/downloads/barusoup/Velocity/total?label=downloads" alt="Downloads">
  </a>
  <a href="https://github.com/barusoup/Velocity/issues">
    <img src="https://img.shields.io/github/issues/barusoup/Velocity" alt="Issues">
  </a>
</p>

---

Velocity is a native desktop music player built with [Tauri](https://tauri.app/) and [React](https://react.dev/). It streams from YouTube Music, lets you save your favorite content, and wraps playback in a clean, distraction-free interface.

## Download

Installers for **Windows** and **macOS (Apple Silicon)** are on the [Releases](https://github.com/barusoup/Velocity/releases) page.

| Platform | Installer |
|----------|-----------|
| Windows (x64) | `Velocity-Setup-x64.exe` |
| macOS (arm64) | `Velocity-macOS-arm64.dmg` |

Stable installs update automatically on launch when available.

> **Experimental builds** (pre-releases tagged *Experimental*) are early-access snapshots. They may be unstable and are not offered through the auto-updater on stable installs.

## Features

- **Home** — personalized recommendations and daily picks based on your taste profile
- **Collection** — save songs, albums, and artists; upload and browse local content
- **Search** — inline suggestions and search filters
- **Queue & playback** — autoplay, listening history, loudness normalization, and gapless preloading
- **Lyrics** — synced lyrics with smooth follow-along
- **Discord Rich Presence** — show what you're playing
- **Imports** — bring in playlists from Spotify, Apple Music, and YT Music

## Screenshots

<p align="center">
  <img src="public/splash-icon.png" alt="Velocity splash" width="360">
</p>

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://www.rust-lang.org/tools/install) (stable)
- Platform tooling for [Tauri v2](https://v2.tauri.app/start/prerequisites/)

### Run locally

```bash
npm install
npm run tauri dev
```

### Build

```bash
npm run tauri build
```

### Release checks

```bash
npm run verify-release
```

See [Agents.md](Agents.md) for the full release workflow, icon regeneration chain, and agent notes.

## Feedback

Found a bug or have a suggestion? [Open an issue](https://github.com/barusoup/Velocity/issues).

## License

Velocity is licensed under the [GNU GPL v3.0](LICENSE) by [barusoup](https://github.com/barusoup).
