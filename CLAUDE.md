# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Figma plugin (`Slides Exporter`) that exports the top-level frames on the current Figma page to a `.pptx` file, downloaded directly to the user's machine. No auth, no server, no build step — just two files loaded directly by Figma.

## Running / testing

There is no build system, package manager, linter, or test suite in this repo (no `package.json`). To try changes:

1. Open Figma Desktop app (plugin development requires desktop, not browser).
2. **Plugins → Development → Import plugin from manifest…** and point it at `manifest.json`.
3. Run **Plugins → Development → Slides Exporter** on a page with top-level frames.
4. After editing `code.js` or `ui.html`, re-run the plugin from the same menu — Figma reloads the files from disk each run, no reimport needed.

`pptxgenjs` is loaded from CDN (`unpkg.com`) inside `ui.html` at runtime — there's no bundling or local dependency to install.

## Architecture

Two isolated JS contexts talk over `postMessage`, mirroring standard Figma plugin structure:

```
code.js (plugin sandbox — has Figma API, no DOM)
    │  figma.ui.postMessage(...)
    ▼
ui.html (iframe — has DOM/CDN libs, no Figma API)
    │  parent.postMessage({ pluginMessage: ... })
    ▼
code.js
```

- **`code.js`** — runs in Figma's sandbox. Traverses `figma.currentPage.children` (top-level `FRAME`s only, one per slide), and for each frame:
  - Rasterises the frame background via `exportAsync()` (`exportFrameImage`), *unless* the frame's own fill is a flat solid color and nothing needs a raster fallback — in which case the raster pass is skipped entirely and the color is sent as `bgColor` for PPTX to use as a native slide background.
  - Walks the frame's node tree (`collectIndividualNodes`) to pull out anything that should NOT be baked into the background raster: image-filled nodes and shape/line nodes (`SHAPE_NODE_TYPES`). These are exported as their own transparent PNGs (`exportIndividualNodes`) and hidden during the background export so they aren't double-rendered.
  - When `preserveVectors` is on, eligible shapes (`tryExtractVectorShape`) are instead described as native PPTX autoshape data (type, fill, stroke, corner radius) and sent as `vectorShapes` instead of being rasterised — see the eligibility rules in `README.md`'s "Known limitations" section, mirrored in code as `SHAPE_NODE_TYPES`, `POLYGON_SHAPE_BY_SIDES`, `SUPPORTED_STAR_POINTS`.
  - Extracts `TEXT` nodes (`extractTextNodes`) with position/size relative to the parent frame, resolved font family/weight/style, color, alignment, line height, and letter spacing, to become an editable text overlay.
  - Sends one `postMessage({ type: "slide", slide: {...} })` per frame as it finishes, then a final `slides-done`.
- **`ui.html`** — runs in the iframe. Collects `slide` messages keyed by index, and once `slides-done` arrives, builds the `.pptx` with `pptxgenjs` (`buildPPTX`): background image or solid color, then individual images, then native vector shapes, then transparent text boxes on top (in that z-order) — and triggers a browser download via `pptx.writeFile()`.

### Key invariants to preserve when touching this flow

- **Coordinate space**: all positions/sizes sent from `code.js` are relative to the root frame's `absoluteBoundingBox`, in Figma px (96/inch). `ui.html` converts px → inches/points via `pxToInch`/`pxToPt` (96px/inch, 72pt/inch) so exported geometry matches the Figma file's physical size exactly, not a rescaled-to-fit size.
- **Clipping**: `exportAsync()` on an isolated node ignores clipping from an ancestor frame's "Clip content". `isClippedByAncestor` detects when a shape/image would render its full unclipped bounds instead of the visually-clipped ones; those nodes are excluded from the individual-export pass and left to the background raster instead (which does clip correctly), forcing `isSolidBg` off so the raster pass isn't skipped.
- **Masking groups**: a group whose children include an `isMask` layer must be exported as one flattened unit (`hasMaskChild`) — exporting the masked child alone ignores the mask shape entirely.
- **`figma.mixed`**: several node properties (`fontName`, `cornerRadius`, etc.) can read as the `figma.mixed` symbol rather than a value when a node isn't uniform. `safeGet` provides fallbacks; `extractTextNodes` additionally samples the first character's font via `getRangeFontName(0, 1)` when `fontName` is mixed, so a family isn't lost entirely just because one character's weight/style differs.
- **`postMessage` payloads must be plain data** — no live Figma node references. Vector shape/image results carry the `node` reference internally for a second pass (e.g. `exportIndividualNodes`) and it's stripped (`{ node, ...rest }`) before being put on a message.
- Only one `.pptx` export path exists (Google Slides JSON export was removed — see git history); "using with Google Slides" is achieved via the **Force safe font** option plus uploading the `.pptx` to Google Drive, not a separate export format.

### File map

- `manifest.json` — Figma plugin manifest (entry points, no permissions needed).
- `code.js` — sandbox logic described above.
- `ui.html` — UI markup/styles, state, and the entire PPTX build pipeline, all inline (no separate JS/CSS files).
- `README.md` — user-facing docs; keep the Options table and "Known limitations" section in sync with `code.js`/`ui.html` when changing option behavior or shape/font eligibility rules.
