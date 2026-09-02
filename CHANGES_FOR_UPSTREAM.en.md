# Keyflow Changes Report (for the Upstream Author)

This is a fork of **windschord/keyflow latest `main` (5ccc5ef, Microsoft Store release)** with **9 commits** in total. The changes fall into three categories: **performance optimizations, feature extensions, and bug fixes**.

> Note: the fork also includes a "smart piano glove" feature (Bluetooth BLE connection, firmware commands, glove control panel, Arduino firmware, etc.). Since it is a custom feature I built for my own hardware and has no value for general users, it has been **fully excluded** from this report. Everything below is general-purpose improvement.

---

## 1. Performance Optimizations

### 1.1 Persistent cache for score coordinates / cursor state (core change)

**Problem**: `buildNoteIdMap` walks through every note with the OSMD cursor to build a `noteId → coordinate/cursor-state` map. For a 1000+ note piece this took **8–13 seconds** on every first import and every re-open, freezing the UI.

**Solution**: added a persistent `ScoreMapCache` (v2) pipeline:

- **Data structures** (`osmd-controller.ts`):
  - `noteIdToCursorState`: noteId → cursor iteratorIndex (used by `moveCursor`)
  - `noteIdToSvgCoord`: noteId → in-page coordinates + `pageIndex` (used by fingering/highlight overlays)
  - `iteratorIndexToCursorStyle`: iteratorIndex → snapshot of `cursorElement.style.cssText` (for O(1) jumps)
  - `zoomBase`: the zoom at cache creation; if the zoom no longer matches, only the cursor styles are discarded, coordinates remain usable
- **Read/write** (`ScoreRenderer/index.tsx`): after loading, read `.scoremap.cache.json`; if `applyCache` hits, skip cursor traversal entirely; otherwise write back via `serializeCache`.
- **Permissions** (`main/path-allowlist.ts`, `main/index.ts`): `assertAllowedSidecarWritePath` now also allows writing `*.scoremap.cache.json`, still limited to derived files of user-approved MusicXML files.
- **Linked deletion** (`main/library-handlers.ts`): removing a score from the library also removes both `.annotation.json` and `.scoremap.cache.json` sidecars.

**Result**: re-opening dropped from 8–13 s to milliseconds.

### 1.2 O(1) cursor jumps

Cursor movement no longer calls `cursor.next()` repeatedly: it restores the cached style directly from the target noteId's iteratorIndex, and reparents the cursor to the SVG of the correct page in paged mode. Falls back to step-by-step traversal only when the cache misses.

### 1.3 Deferring synchronous main-process writes (fixes open/save jank)

- electron-store's synchronous `writeFileSync` blocked for a measured **7–8 s** on slow disks (e.g. OneDrive): `library:upsert` and `addRecentFile` now run deferred via `setImmediate` / fire-and-forget (`main/library-handlers.ts`, `main/file-handlers.ts`, `main/index.ts`).
- Reordered the renderer's `openMusicXmlFile`: `annotationStore.load` now runs before `setScore`, and `buildNoteIdMap` is deferred into the macro-task queue with `setTimeout(0)` so the synchronous traversal cannot block IPC responses. Annotation-load IPC went from ~12 s to a few milliseconds.

### 1.4 Fixing gray-out on the cache-hit path

`noteIdToGraphicalNote` stores `GraphicalNote` **object references**, which cannot be serialized, so gray-out broke when the cache was hit. Added `rebuildGrayoutNoteMap`: it walks the GraphicSheet directly (MusicPages → staffEntries → notes), reuses the existing matching logic, and rebuilds the noteId → SVG element map in milliseconds — cursor-independent, so both code paths behave identically.

### 1.5 Ignoring repeats during cursor traversal

Set `EngravingRules.CursorIgnoreRepetitions = true`: the cursor no longer re-walks repeated measures, eliminating duplicate traversal and the flood of "could not resolve" warning noise in `buildNoteIdMap`, and speeding up first imports noticeably.

### 1.6 Fixed A4 pagination + CSS zoom

Switched to a fixed `A4_P` page format at 794px; window zoom is expressed only via outer CSS zoom while OSMD's own zoom stays 1.0, so coordinate caches are independent of window size. Removed the `setZoom` / ResizeObserver re-render path so window changes no longer corrupt cached coordinates.

### 1.7 Layout-thrashing suppression

In `buildNoteIdMap`, all page SVGs' `getBoundingClientRect` values are pre-fetched once into `svgRects` before the loop; inside the loop only the current page's rect is referenced, avoiding repeated forced reflows.

---

## 2. Feature Extensions

### 2.1 Sequence loop playback

- Replaced the inline toolbar loop input with a non-modal, draggable floating panel `LoopRangePanel` (closes with Escape).
- Added a **loop toggle**: when enabled, the sequence wraps from its end back to its start for true looping.
- Added `parseRangeIntoSegments` / `setupPlaybackSequence` to the audio engine: parses "1-3, 5-7" into segment lists and builds `boundaries` edge scheduling (jump/stop). Loop jumps run atomically inside the audio-thread callback as `pause → seek → releaseAll → start` to avoid a click/noise across frames.
- Added `deriveRepeatPlayRange`: derives the playback order from MusicXML repeats (`repeatStart/repeatEnd`, 1st/2nd endings) and pre-fills the range input; manual edits are never overwritten.

### 2.2 Layout persistence

Added `ScoreLayout = 'vertical' | 'horizontal'` with **horizontal as the default**; the choice is persisted via electron-store and restored on next launch. Only CSS switches the arrangement — no OSMD re-render.

### 2.3 Library page polish

Redesigned the table into a card list, added a loading skeleton, search + sort dropdown, unified empty/error states, and a delete-confirmation modal. The Header is now hidden on the score view (shown only on the library view), and the library top bar gained "Back to score / Open file / Settings" buttons. Also added a full-screen loading overlay.

### 2.4 i18n: added Chinese, fixed Japanese

- Extended `Language` to `en / ja / zh`; added a complete Chinese resource `zh.ts` (351 lines, structurally aligned with ja/en; conventional English like ON/OFF, BPM, SRAM is kept).
- Restored the Japanese texts in `ja.ts` that had been rewritten into English; `en.ts` gained the missing keys.
- Added Chinese labels to the main-process menu (`menu.ts`); `resolve-language` now accepts `zh` (manual selection only, no auto-detection).

### 2.5 Fingering editing

Added `FingeringEditToggle` (forces fingering display when enabled) and `FingeringPicker` (clicking a fingering number on the score shows a 1–5 selection bar, written to the annotation-store).

### 2.6 Unified dropdown component `KfSelect`

Re-implemented the native select with button + popover (`aria-haspopup="listbox"`, closes on outside click/Escape, checkmark for selection), replacing native selects in SettingsModal and FingeringPanel.

### 2.7 Unified design system

Introduced `keyflow-ui.css` (`kf-*` classes: buttons/segments/sliders/toggles/dropdowns/modals) and migrated the inline styles of toolbar/header components to unified classes, with a unified accent color.

---

## 3. Bug Fixes

1. **Repeat parsing** (`parser.ts`): `Measure` now carries `repeatStart / repeatEnd / endingStart / endingEnd` extracted from MusicXML (used for loop-order derivation).
2. **Title extraction**: a `work-title → movement-title → credit-words` candidate chain that filters out MuseScore's localized placeholders (e.g. "未命名乐谱"), keeping library and score titles consistent.
3. **Fallback for failed time-matching**: notes whose tick match fails in `buildNoteIdMap` (e.g. whole measures lost to accumulated tuplet rounding errors like septuplets) are paired 1:1 with remaining candidates by tick order in a fallback phase, avoiding mis-pairing.
4. **Measure click hit-testing**: switched to per-staff independent rectangles (`measureNumberToRect`), fixing unresponsive bass-staff clicks and accidental hits in the gap between the two staves.
5. **Loop panel close button**: the hardcoded `aria-label="Close"` now goes through i18n, keeping UI and tests consistent across languages.

---

*Generated by reviewing `git diff origin-latest/main..HEAD` (base = 5ccc5ef) file by file.*
