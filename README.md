# Lazurite - Crystallium Chart Viewer

Local, read-only chart viewer. `website_loader/` is self-contained: it carries its own frontend, the published chart payloads (`charts/`), the track texture (`assets/texture-435.png`) and the generated catalog manifest (`library.json`). It can be uploaded and served on its own, from a domain root or a GitHub Pages project sub-path. The original workspace evidence stays outside this directory and is read-only.

## Start

Requires Node.js 18+ (no npm installation or remote dependencies).

```powershell
# From inside this directory
node server.mjs
```

Open **http://127.0.0.1:4174/**. This is a separate local viewer, not a change to the DeepSeek Harness GUI. Keep the server running while using it. For a different port, set `$env:PORT` before starting. The server binds only to loopback. `node website_loader/server.mjs` from the workspace root works too.

The server reads `charts/` and writes `library.json` from it (only when the records changed), so `/library.json`, `/charts/<id>.json` and `/assets/texture-435.png` are the same files a static host serves. The `/api/library`, `/api/chart/<id>`, `/api/audio/<id>` and `/api/texture` routes remain as local aliases for existing tooling; the page itself does not use them. Audio mappings in `audio-map.json` stay workspace-relative (resolved from the parent of this directory) and their files are **not** part of this folder: a mapped file that is absent is simply no audio, and a standalone clone still starts.

Do not double-click index.html: ES modules and the local chart files require an HTTP server.

## Deploy (GitHub Pages or any static host)

Upload `website_loader/` and nothing else; no build step and no server are needed. The page fetches `library.json`, `charts/<id>.json` and `assets/texture-435.png` relative to itself, so a project site under `https://<user>.github.io/<repo>/` shows the full catalog and live preview. Steps 1–8 below all work there, with one difference: **mapped music does not ship with the folder**, so every chart opens as a silent preview on a static host — attach a local file in the Inspector if you have one. `.soda` binaries, `audio-map.json` targets, `package.json` and `server.mjs` are not needed by the page and are not published.

## Use

- The initial screen is a full-width song catalog: **21 song resources / 63 difficulty records**, with title, artist, exact resource ID and four native columns (Crescent, Lunar, Astral, Bloodlust). Each rectangular difficulty link shows its real name, level and object count, and opens that exact record. Missing records are dashes, not invented levels. The two additional Eclipse records are accessible beside their song metadata. Duplicate titles retain separate rows and explicit resource-variant labels.
- Search by title, artist or resource ID; **Clear search** resets the filter. Filtered song/difficulty counts and a no-results message remain visible. At phone widths, metadata compacts and all four difficulty columns remain visible together (column headings supply the names, with full names retained in accessible link labels). A short resource ID still distinguishes every row; the full ID is retained in the link label and viewer. Very narrow screens can scroll horizontally inside the table container.
- No chart or music is loaded automatically on the initial catalog. Opening a difficulty reveals only the existing playfield and Inspector. **Back to Songs** stops playback/clicks, cancels pending chart selection, and restores the search, catalog scroll position and originating link focus. Music and hit-sound levels, scroll speed and Inspector preferences persist for the page session.
- **Settings** (`#settings`) is a third screen, reachable from the catalog header and from the viewer navigation. It contains the **Show overlapping slide edges** checkbox: checked, each overlapping slide keeps its own visible outline; unchecked (the default), overlapping slide edges combine and only the outer edges are drawn. The choice is written to this browser's `localStorage` (`crystallium.settings.v1`) and read back on load; missing, malformed, wrong-typed or unreadable storage all fall back to unchecked, and nothing is ever uploaded. Opening Settings pauses the viewer — playback and click sounds stop, rendering and viewer shortcuts go inactive — but the chart session is parked rather than discarded: a chart that was still loading finishes into the hidden viewer, and **Back** then restores that exact record from the parked session without re-fetching it. A loaded chart keeps its compiled data, clock time, volumes, rate, scroll speed and selection. Returning never auto-starts music: the chart stays paused even if it was playing before. **Back** returns to the exact catalog or chart route you came from.
- Play/pause, drag the timeline, or jump to a timestamp.
- Space toggles playback; left/right arrows seek 5 seconds when focus is outside controls.
- Rate changes playback time; Scroll changes only the visual approach speed.
- Tap sounds are on by default: each note head emits a short synthesized click at its judgement time (coincident heads share a normalized click). Music volume and Hit-sound volume are separate playback sliders, both starting at 70%. Set either slider to zero to mute only that channel; the other remains unchanged. Disable Tap sounds in the Inspector to stop clicks without changing either slider (re-enabling uses the selected hit-sound level). These levels stay selected when switching charts or attaching/reloading audio, but reset on page reload. Seeking does not replay skipped hits. These are viewer-generated sounds, not recovered game samples or scoring.
- Pause and click a note to inspect its calculated geometry and timing. Keyboard users can focus the playfield and use left/right arrows to step through notes.
- While the timeline has focus, left/right arrows seek one second.
- The Inspector toggle hides the technical panel; it is only available in the viewer. Playback shortcuts and rendering are inactive while the catalog is shown.
- Hash navigation supports browser Back/Forward and direct links: `#songs` (or no hash) shows the catalog; `#/chart/<URL-encoded-resource-id>/<numeric-difficulty-id>` opens the exact record; `#settings` opens the display settings screen. For example, `#/chart/Luxe_Chain_e854fcacafe7/3` opens Luxe Chain Bloodlust. Invalid songs, difficulties or malformed hashes return to the catalog with a message, and opening `#settings` directly (or Back into it) returns to the catalog. No server routes, new dependencies or replacement server are needed.
- Attach matching local audio through the Inspector if a candidate automatic mapping is unavailable or does not align. Automatic matches are based on names/titles, not verified identical masters. The browser reads the file locally through an object URL; it is not uploaded.

## Fidelity and boundaries

The original numeric-array chart schema is used directly. Timing is compiled separately from drawing for deterministic seeks, preserving source easing and scroll groups. This is an offline reconstruction, not a Unity gameplay recording.

Canvas perspective rendering deliberately avoids third-party downloads. The original track texture is served from this folder. Note artwork, GPU blending, some effect animations, and browser audio/device latency are approximations; procedural note colors are viewer colors, not a claim about recovered original note textures. This viewer is not playable: no central player/Onibi marker or center debug dot is drawn; the judgement bar and chart notes remain visible. Dungeon gameplay, scoring, saves, unlocks, and account connections are absent. Empty difficulties remain visible and are handled without gameplay.

Void bodies and borders use a fixed underlay beneath ordinary notes and an additive Canvas blend, rather than opaque endpoint-sorted overlays. This prevents notes popping through long voids when their visible endpoint changes. It is a stable Canvas approximation of the material queues/surface heights, not an implementation of Unity's depth buffer or exact DstAlpha/One shader compositing.

Audio mapping and exact chart/audio clock convention are documented in AUDIO.md. Do not infer chart length from rendered WAV length. Generated native diagnostic files may include output bookkeeping or test segments.

## Verified delivery

- 21 chart payloads and 63 difficulties compile, including one empty difficulty.
- Automated tests cover timing, server restrictions, renderer judgement-line arrival, slide-tail visibility, void boundary clipping and stable overlap layering, synthesized hit-sound crossing, mute, seek and oscillator lifecycle; the catalog/viewer/settings markup contract, the `#settings` route, the settings parking pause (clock and clicks stop, auto-play intent clears, the load generation is untouched) and the overlapping-slide preference codec (default, malformed, true, false) are also covered. The existing 41-test evidence suite passes as well.
- Headless Chrome checks desktop/mobile layout, playback advancement, seeking, chart switching, and empty-difficulty controls without console errors.
- Luxe Chain's mapped WAV was decoded and played by Chrome; audible device output and sample-exact sync remain unobserved.
- 10 chart IDs have candidate local audio mappings in the workspace. They belong to the parent workspace, not to this folder, so they are unavailable on a static host or in a standalone clone; those charts open as silent previews. Training 1's candidate is shorter than the chart; the clock continues silently after audio ends.
- Audio loads are serialized to avoid stale source swaps. An in-flight unavailable source may delay a newer attachment by up to the 2.5-second readiness timeout.

## Checks

Run the module tests from inside this directory (they read `charts/`; no server needed):

```powershell
node --test *.test.js
```

`server.test.js` needs the viewer server running (`node server.mjs`), and the browser check needs Chrome at the standard Windows installation location:

```powershell
node --test server.test.js
node browser-check.mjs
```

From the workspace root, the evidence suite additionally covers the wider reconstruction:

```powershell
.tools/venv/Scripts/python.exe -I tests/verify.py
```

The browser check uses an isolated temporary Chrome profile, never your live profile, and writes local desktop/mobile screenshots in this directory. It does not run the game.

The static server (and the uploaded folder) exposes only the frontend modules, `library.json`, `charts/<id>.json` and the track texture `assets/texture-435.png`; `/api/...` are loopback-only aliases for the same files plus explicitly mapped local audio. It does not expose `.soda` binaries, `audio-map.json` targets, the whole workspace, `package.json`, `server.mjs`, or parent paths. Do not also publish keys, decrypted audio, WAV files, or the rest of the analysis workspace.
