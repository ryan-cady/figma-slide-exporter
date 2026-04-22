# Figma Slides Exporter

A Figma plugin that exports your presentation frames to:
- **PowerPoint (.pptx)** — downloaded directly to your machine, no auth needed
- **Google Slides JSON** — a batchUpdate payload ready for the Slides API

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
            ├─ pptxgenjs → builds .pptx in-browser → download
            └─ custom builder → Google Slides batchUpdate JSON → download
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

## Export modes

### PowerPoint (.pptx)

- Each frame → one slide
- Frame rasterised as PNG background (preserves all visual fidelity)
- Text nodes overlaid as actual editable text objects
- Transparent text boxes sit on top of the image so formatting is preserved

**Tip:** The raster background means shapes, gradients, and effects look pixel-perfect.
Text is selectable and searchable but may not perfectly match Figma fonts
unless those fonts are installed on the target machine.

### Google Slides JSON

Exports a `_slides_api.json` file containing a Google Slides
[`batchUpdate`](https://developers.google.com/slides/api/reference/rest/v1/presentations/batchUpdate)
request payload.

To use it, you need to:

1. Upload each slide's background PNG to a publicly accessible URL
   (e.g. Google Cloud Storage, Cloudflare R2, or even a temporary Imgur link)
2. Replace the `__REPLACE_WITH_UPLOADED_URL_FOR_SLIDE_N__` placeholders
3. Run the payload against the Slides API with OAuth:

```javascript
const { google } = require('googleapis');
const slides = google.slides({ version: 'v1', auth: yourOAuth2Client });

const payload = require('./my_presentation_slides_api.json');

await slides.presentations.batchUpdate({
  presentationId: 'YOUR_PRESENTATION_ID',
  requestBody: payload,
});
```

---

## Options

| Option | Default | Description |
|--------|---------|-------------|
| Text overlay | On | Adds editable text boxes on top of rasterised background |
| Raster scale | 2× | Export resolution. 2× is sharp on most screens; 3× for print |

---

## Architecture notes

### Why rasterise + overlay?

Figma's layout engine supports features (auto-layout, variables, components,
complex fills) that have no 1:1 PPTX equivalent. Rasterising each frame as
a PNG preserves visual accuracy. The text overlay then adds editability.
This is the same strategy used by the commercial plugins you referenced.

### Why no direct Google Slides push from the plugin?

Figma plugins can't initiate OAuth flows directly — they run in a sandboxed
iframe with no persistent storage and no ability to open popups. The JSON
export approach works around this: generate the payload in the plugin, then
run it through an external script or backend that handles OAuth.

See Part 2 of this project (sync script) for a Node.js implementation.

---

## Project structure

```
figma-slides-exporter/
├── manifest.json   — Figma plugin manifest
├── code.js         — Plugin sandbox (Figma API access, frame traversal)
├── ui.html         — Plugin UI (pptxgenjs, PPTX/JSON build logic)
└── README.md       — This file
```

---

## Known limitations

- **Fonts:** Figma fonts are not embedded in .pptx. The text overlay uses
  `Arial` as a safe fallback. You can map font names in `ui.html`
  near the `s.addText(...)` call.
- **Vector shapes:** Non-text, non-image elements (SVG paths, etc.) are
  captured in the raster background but not as editable PPTX shapes.
- **Animations:** Figma's Smart Animate has no PPTX equivalent; ignored.
- **Google Slides JSON:** Background images require a manual upload step
  before the payload is usable. Part 2 of this project automates this.
