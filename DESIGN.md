# Velocity Design Language

## Philosophy

Velocity is a **dark-first, content-forward** music player. The UI recedes so the music—album art, artist imagery, lyrics—takes center stage. Every visual decision serves three goals:

1. **Disappear when not needed** — pure black backgrounds let content breathe. Controls fade in on hover, panels slide out of view. The app should feel like the music is playing in a dark room, not inside a piece of software.
2. **Surface details deliberately** — outlines, panels, and menus appear with precise opacity and timing. Nothing is loud unless it needs to be discovered.
3. **Respond to the music** — accent colors are extracted from album art in real time, tinting heroes, buttons, and waveforms. The app dresses itself to match what you're listening to.

---

## Canvas & Color

### Black as the default state

The app body is `#000000`. Not a dark grey, not a muted charcoal—true black. This is the canvas that pages, the sidebar, and backgrounds sit on. Most page-level containers inherit this black, making them seamless with the body unless they explicitly opt into a surface color.

### Surfaces are stacked in greys

| Surface | Class | When Used |
|---------|-------|-----------|
| Page background | `bg-black` | Default for every page, card, and empty state |
| Elevated panel | `bg-neutral-950` | Dropdowns, context menus, filter panels, modals |
| Hover hint | `bg-neutral-900` or `bg-white/[0.055]` | Card hover, track row hover, sidebar link active |
| Faint backdrop | `bg-white/5` or `bg-white/6` | Input backgrounds, very subtle highlight states |
| Frosted surface | `backdrop-blur-md bg-white/5` | Search input, filter button, player bar, top bar |

The frosted-glass effect (`backdrop-blur-md`) is used sparingly—only on floating elements that sit above the page and need to show a hint of what's behind: the player bar, the search input, the history pill. Each frosted element carries its own animation properties so the blur never traps its own backdrop.

### Text hierarchy through opacity

Text never uses multiple greys—it uses a single white (`#ffffff`) at varying opacities:

| Opacity | Role |
|---------|------|
| `100%` | Headings, hero titles, primary play buttons, active states |
| `92%` | Track titles (body) |
| `88%` | Queue track titles |
| `85%` | Player bar track title |
| `78%` | Active track index |
| `76%` | Album metadata |
| `72%` | Menu items (inactive), secondary buttons |
| `58-62%` | Table headers, filter labels, secondary buttons |
| `48-52%` | Metadata, duration, timestamps, tab labels (inactive) |
| `40-42%` | Placeholders, empty state text, queue section labels |
| `32-38%` | File size labels, faint metadata |
| `12-24%` | Subtle hints, disabled icons |
| `8-10%` | Borders, dividers on light surfaces |
| `4-6%` | Faint hover backgrounds, subtle separators |

This creates a flat, ordered hierarchy without introducing color variation. The user's eye reads importance from contrast against black, not from hue.

### Neutral Tailwind palette as shorthand

- `neutral-100` (`#f5f5f5`) — body text, primary labels
- `neutral-200` (`#e5e5e5`) — sidebar nav links
- `neutral-300` (`#d4d4d4`) — track index numbers, play counts
- `neutral-400` (`#a3a3a3`) — secondary text (artist names, metadata)
- `neutral-500` (`#737373`) — inactive icons, search placeholder
- `neutral-700` (`#404040`) — ghost button borders
- `neutral-800` (`#262626`) — artwork placeholders, slider tracks, hover fills
- `neutral-900` (`#171717`) — card hover, panel surfaces, active sidebar links
- `neutral-950` (`#0a0a0a`) — elevated surfaces (menus, dropdowns)
- `black` (`#000000`) — root background

### Accent from artwork

Dominant colors are extracted from album art via `utils/artwork-color.ts` and propagated through React context to:

- Album and artist page hero backgrounds (mixed with black at 34% and 86%)
- Play buttons (mixed with white at 22%)
- Lyrics waveform bars
- Queue drag overlays (muted saturation × 0.45, lightness × 0.62)

Fallback accent is `#505050` (neutral grey).

### Semantic colors

- **Green `#1bd760`** — saved-state indicator (SaveButton disc, badge icon). Hover: `#20e57a`.
- **Red `red-400` / `red-500`** — destructive actions, errors, retry button.
- **White `#ffffff`** — play buttons, slider thumbs, seek fill, save badge, filter pill selected state.

---

## Borders & Separation

Surfaces that sit on black don't need borders—they blend into the page naturally. Borders only appear when an element must be visually separable from its neighbors.

### Border usage rules

- **No border on black** — cards, pages, and containers that are `bg-black` need no outline against the body.
- **`border-white/10`** — default border for floating panels (menus, filter panels, context menus, modals) and inputs. This is the standard separation line.
- **`border-white/12`** — player bar border. Slightly more visible because the player bar sits on top of page content.
- **`border-white/8`** — modals and very subtle separators.
- **`border-white/5`** — sidebar in lyrics page mode.
- **`border-neutral-900`** — sidebar right edge.
- **`border-neutral-700`** — ghost button borders.
- **Dividers** — always `h-px bg-white/8` inside menus and panels.

The rule: if an element is on the same black background as its parent, no border. If it floats above the page or needs to be distinguishable from adjacent black surfaces, a thin `border-white/10` is enough.

### Search filter menu example

The filter popout is a floating panel on a black page. It uses `border-white/10` to separate itself from the background, `bg-black` to match the app, and `shadow-[0_18px_48px_rgba(0,0,0,0.48)]` to establish depth. Inside, dividers are `bg-white/8`—faint lines between sections.

---

## Typography

### Font stack

```
system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
```

No custom fonts. The OS native font keeps the UI fast and familiar. OpenType features `ss01`, `cv02`, `cv03` are enabled for stylistic alternates.

### Responsive base size

```css
html { font-size: clamp(14px, calc(13.6px + 0.1875vw), 17px); }
```

Scales smoothly from 14px on small screens to 17px on wide ones.

### Size hierarchy

| Context | Size | Weight |
|---------|------|--------|
| Artist hero name | `clamp(4rem, 7vw, 9rem)` | Bold |
| Album title | `clamp(2.5rem, 5.2vw, 4.4rem)` | Bold |
| Section headings | `text-xl` | Bold / Extrabold |
| Page title (h1) | `text-2xl` / `text-3xl` | Extrabold, `tracking-tight` |
| Top result title | `clamp(1.2rem, 2.4vw, 1.55rem)` | Bold, `tracking-tight` |
| Track list titles | `text-[15px]` | Semibold / Medium |
| Player bar title | `0.98rem` | Semibold |
| Body / secondary | `text-sm` (`0.875rem`) | Normal |
| Metadata | `text-xs` (`0.75rem`) | Normal / Semibold |
| Timestamps | `text-[11px]` `tabular-nums` | Normal |

### Weights used

- `font-extrabold` (800) — page titles, hero headings
- `font-bold` (700) — section heads, album titles, nav links active
- `font-semibold` (600) — buttons, nav links, menu items, track titles
- `font-medium` (500) — track titles in list views
- Normal (400) — body text, metadata

---

## Spacing & Layout

### Design tokens as CSS custom properties

Every major UI dimension is a `clamp()` value on `#root`, scaled smoothly between viewports:

| Token | Purpose |
|-------|---------|
| `--ui-sidebar-open` | Expanded sidebar width: `12.5–15rem` |
| `--ui-sidebar-closed` | Collapsed sidebar width: `3.25–4rem` |
| `--ui-topbar-height` | Top bar height: `3.25–4.25rem` |
| `--ui-page-pad` | Page horizontal padding: `1–2.75rem` |
| `--ui-content-max` | Max content width: `64–82rem` |
| `--ui-player-max` | Player bar max width: `56–90rem` |
| `--ui-player-side` | Player bar side panels: `11–15rem` |
| `--ui-control` | Standard control button: `2.4–3rem` |
| `--ui-art-sm` | Small artwork (player bar): `3.2–4rem` |
| `--ui-art-row` | Track row artwork: `3.25–4rem` |
| `--ui-art-lg` | Large artwork (page hero): `10–14rem` |
| `--ui-radius-panel` | Panel border radius: `1–1.75rem` |
| `--ui-player-bottom` | Player bar bottom offset: `0.75–1.5rem` |
| `--ui-player-height` | Player bar height: `4.1–5.4rem` |

### Responsive breakpoint

At `≤760px`: sidebar collapses to a rail, player bar side panels hide, bottom margin reduces.

### Common spacing

- Page padding: `px-[var(--ui-page-pad)]`
- Section gaps: `gap-3` (cards), `gap-2` (button groups)
- Track row padding: `px-3 py-2`
- Menu item padding: `px-4 py-2.5`
- Card padding: `p-3`
- Empty state padding: `p-12`

---

## Components

### Buttons

| Variant | Style | Interaction |
|---------|-------|-------------|
| **Primary (play)** | `rounded-full bg-white text-black shadow-lg` | `hover:scale-105`, `active:scale-[0.93]` |
| **Ghost** | `rounded-full border border-neutral-700 px-4 py-2 text-xs font-semibold text-neutral-200` | `hover:border-neutral-500 hover:text-white` |
| **Search filter** | `rounded-full border border-white/10 bg-white/5 backdrop-blur-md` | `hover:border-white/15 hover:bg-white/10` |
| **Icon** | `flex h-9 w-9 items-center justify-center rounded-full text-neutral-400` | `hover:bg-neutral-800 hover:text-white` |
| **Text** | `font-semibold text-white/58` | `hover:text-white` |
| **Track row play** | `h-6 w-6`, hidden until hover | `opacity-0 group-hover:opacity-100` |

### Inputs

The search input sets the pattern:

```
rounded-full border border-white/10 bg-white/5 pl-11 pr-10
text-[0.95rem] text-white placeholder-neutral-500 backdrop-blur-md
hover:border-white/15 hover:bg-white/10
focus:border-white/15 focus:bg-white/10
```

All inputs share: transparent or faint background, thin white border, frosted blur on floating elements.

### Cards

Cards are minimal—just artwork with title + subtitle below:

```
rounded-xl p-3 transition-colors hover:bg-neutral-900
```

Artwork is `aspect-square` with a play button that slides up on hover (`translate-y-2 opacity-0 group-hover:translate-y-0 group-hover:opacity-100`).

### Menus & Dropdowns

Floating panels share a consistent anatomy:

```
rounded-[4px] border border-white/10 bg-neutral-950
shadow-[0_18px_48px_rgba(0,0,0,0.48)]
```

Items: `px-4 py-2.5 text-sm font-semibold`, hover state `bg-white/8` (no border radius on items—only the panel has corners). Sections separated by `h-px bg-white/8`. Opens with `artist-menu-pop` animation: 170ms scale+fade.

### Player Bar

A floating frosted element at the bottom of the screen:

```
rounded-xl border border-white/12 bg-neutral-950/90 backdrop-blur-md
shadow-[0_20px_60px_rgba(0,0,0,0.62)]
```

Enters with `player-bar-enter` (380ms, fade + translate + blur). Hides with a separate transition on the lyrics page. The bar is the only element that uses `border-white/12`—it needs slightly more separation because it overlays page content.

### Track Rows

Grid-based rows with consistent hover and active states:

```
grid grid-cols-[1.75rem_minmax(0,1fr)_minmax(7.5rem,10rem)_4.5rem_2.25rem]
rounded-md px-3 py-2 text-sm hover:bg-neutral-900
```

Active track: `bg-white/[0.04]` — extremely subtle, just enough to mark which is playing. Row number is replaced by animated playing bars when the track is active.

---

## Shadows

Shadows establish depth for floating elements. They are always `rgba(0,0,0,…)`—pure black shadows on a black background read as "lifted" rather than colored.

| Depth | Shadow | Element |
|-------|--------|---------|
| Low | `rgba(0,0,0,0.32)` | Upload button, release cards |
| Medium | `rgba(0,0,0,0.48)` | Context menus, dropdowns, filter panels |
| High | `rgba(0,0,0,0.55)` | Queue panel |
| Highest | `rgba(0,0,0,0.62)` | Player bar, import modal |

---

## Animation & Motion

### Easing philosophy

Almost no CSS built-in easings. Custom cubic-bezier curves give a consistent feel:

- `cubic-bezier(0.22, 1, 0.36, 1)` — primary ease-out-exaggerated. Used for sidebar, player bar, volume, and most layout transitions. Feels fast at the start, settles gently.
- `cubic-bezier(0.16, 1, 0.3, 1)` — secondary easing for entrances. Used for page content, artist discography dominoes, menu pops.
- `cubic-bezier(0.32, 0.72, 0, 1)` — show/hide transitions. Used for search bar and player bar visibility toggles.
- `cubic-bezier(0.2, 0.9, 0.28, 1.08)` — spring-like. Used for the lyrics dialog entrance.

### Common animation patterns

| Pattern | Duration | Easing |
|---------|----------|--------|
| Page enter (opacity only) | 180ms | `(0.16, 1, 0.3, 1)` |
| Menu pop | 170ms | `(0.16, 1, 0.3, 1)` |
| Player bar enter | 380ms | `(0.4, 0, 0.2, 1)` |
| Sidebar width | 220ms | `(0.22, 1, 0.36, 1)` |
| Search bar show/hide | 320-360ms | Multi-property |
| Staggered card enter | 340-460ms (54ms stagger) | `(0.16, 1, 0.3, 1)` |
| Track row hover color | 150ms | `ease` |
| Button press | 80ms | `ease-out` |

### Marquee system

Overflowing text animates with a back-and-forth marquee driven by per-instance generated keyframes. Edge fade via `mask-image` gradient (12px fade zone). Pauses 0.85s at each end, travels at 40px/s. Respects `prefers-reduced-motion`.

### Reduced motion

Every animation has a `@media (prefers-reduced-motion)` counterpart that neutralizes it. Animations snap to final state, transitions are removed, and marquees become truncation.

---

## Icons

- **Lucide React** (`lucide-react`) for standard UI icons
- Custom SVG components in `src/icons.tsx` for music-service-specific logos
- Animated wrapper components for shuffle, repeat, and volume (crossfade between states)
- Save button has a bespoke animation sequence: disc pop → check mark pop → sparkle burst (360ms total, spring-like easing)

---

## Summary

Velocity's design language is **minimal, monochromatic, and music-reactive**. It achieves richness not through color variety but through opacity layering, precise animation timing, and dynamic accent extraction from content. The app is built to be a dark room for your music library—every pixel either shows your content or stays out of the way.
