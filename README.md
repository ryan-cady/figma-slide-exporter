# Figma Slides Exporter

A Figma plugin that exports your presentation frames to **PowerPoint (.pptx)** —
downloaded directly to your machine, no auth needed.

---

## How it works

```
Figma frames
    │
    ├─ code.js (sandbox)
    │   ├─ traverses top-level frames
    │   ├─ rasterises each frame via exportAsync()
    │   └─ extracts text nodes with position/style
    │
    └─► ui.html (iframe)
            └─ pptxgenjs → builds .pptx in-browser → download
```

Each **top-level frame** on the current Figma page becomes one slide.

---

## Setup

### In Figma (Development mode)

1. Open Figma Desktop (plugin development requires the desktop app)
2. **Plugins → Development → Import plugin from manifest…**
3. Point it at `manifest.json` in this folder
4. Run the plugin from **Plugins → Development → Slides Exporter**

### What you need

- Figma Desktop app (free)
- No external dependencies — `pptxgenjs` loads from CDN at runtime

---

## Export

- Each frame → one slide
- Frame rasterised as PNG background (preserves all visual fidelity)
- Text nodes overlaid as actual editable text objects
- Transparent text boxes sit on top of the image so formatting is preserved

**Tip:** The raster background means shapes, gradients, and effects look pixel-perfect.
Text is selectable and searchable but may not perfectly match Figma fonts
unless those fonts are installed on the target machine.

---

## Options

| Option | Default | Description |
|--------|---------|-------------|
| Selectable text overlay | On | Lay editable text boxes on top of the rasterised background |
| Raster scale | 2× | Export resolution — 1× smallest, 2× sharp on most screens, 3× for print |
| Force safe font | Off | Replace all text with a single widely-available font instead of the frame's original Figma fonts |
| Safe font family | Arial | Dropdown of common web-safe / Google fonts (Calibri, Georgia, Helvetica Neue, Lato, Montserrat, Noto Sans, Nunito, Open Sans, Oswald, Playfair Display, Poppins, PT Sans, Raleway, Roboto, Source Sans Pro, Times New Roman, Trebuchet MS, Ubuntu, Verdana), or "Other" to type in any custom/Google Font name. Only shown when *Force safe font* is on |
| Preserve simple vectors | Off | Export rectangles, ellipses, lines, and regular polygons/stars as native, editable PPTX shapes instead of flattened images. See [limitations](#known-limitations) for which shapes qualify |

---

## Using with Google Slides

There's no direct export to Google Slides, but the `.pptx` converts cleanly:

1. Turn on **Force safe font** and pick a Google Font (or type one in via "Other")
   so the text renders correctly once it's out of Figma's font environment.
2. Export the `.pptx`.
3. Upload it to Google Drive, then open it — Drive opens `.pptx` files directly
   in Google Slides, converting it automatically.

---

## Architecture notes

### Why rasterise + overlay?

Figma's layout engine supports features (auto-layout, variables, components,
complex fills) that have no 1:1 PPTX equivalent. Rasterising each frame as
a PNG preserves visual accuracy. The text overlay then adds editability.
This is the same strategy used by the commercial plugins you referenced.

---

## Project structure

```
figma-slides-exporter/
├── manifest.json   — Figma plugin manifest
├── code.js         — Plugin sandbox (Figma API access, frame traversal)
├── ui.html         — Plugin UI (pptxgenjs, PPTX build logic)
└── README.md       — This file
```

---

## Known limitations

- **Fonts:** Figma fonts are not embedded in .pptx — the text overlay
  references the original Figma font family by name, so it only renders
  correctly if that font is installed on the machine opening the file.
  Use the **Force safe font** option to substitute a widely-available
  font (or any custom/Google Font name) instead.
- **Vector shapes:** By default, non-text, non-image elements are captured as
  flattened images rather than editable PPTX shapes. Turning on **Preserve
  simple vectors** upgrades a subset of them to real, editable PowerPoint
  autoshapes — but only when all of the following hold, otherwise that shape
  falls back to a flattened image:
  - It's a rectangle, ellipse, line, regular polygon (3–8 sides), or star
    (4, 5, 6, 7, 8, 10, 12, 16, 24, or 32 points) — freeform vector paths
    (icons, custom illustrations, boolean groups) never qualify
  - It isn't rotated
  - Its fill and stroke (if any) are flat solid colors, not gradients or images
  - A rectangle's corner radius is uniform, not mixed per-corner
- **Animations:** Figma's Smart Animate has no PPTX equivalent; ignored.
