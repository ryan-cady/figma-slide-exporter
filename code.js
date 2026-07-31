// ─────────────────────────────────────────────
// Figma Slides Exporter — code.js (sandbox)
// Runs in Figma's plugin sandbox. No DOM access.
// Communicates with ui.html via postMessage.
// ─────────────────────────────────────────────

figma.showUI(__html__, { width: 420, height: 580, title: "Slides Exporter" });

// ── Helpers ──────────────────────────────────

/** Convert a Figma RGBA color to a 6-char hex string */
function rgbToHex(color) {
  const toByte = (c) => Math.max(0, Math.min(255, Math.round((c || 0) * 255)));
  const r = toByte(color.r).toString(16).padStart(2, "0");
  const g = toByte(color.g).toString(16).padStart(2, "0");
  const b = toByte(color.b).toString(16).padStart(2, "0");
  return `${r}${g}${b}`;
}

/** Safely read a possibly-mixed value (Figma returns Symbol for mixed) */
function safeGet(value, fallback) {
  return value !== figma.mixed ? value : fallback;
}

/**
 * Recursively find all TEXT nodes inside a frame.
 * Returns their content, style, and position relative to the root frame.
 */
function extractTextNodes(node, rootFrame, results = []) {
  if (node.type === "TEXT") {
    const abs = node.absoluteBoundingBox;
    const rootAbs = rootFrame.absoluteBoundingBox;
    if (!abs || !rootAbs) return results;

    const x = abs.x - rootAbs.x;
    const y = abs.y - rootAbs.y;
    const w = abs.width;
    const h = abs.height;

    const fontSize = safeGet(node.fontSize, 16);

    // node.fontName reads as figma.mixed the moment ANY character in the run
    // differs in style from the rest (e.g. one stray character bolded by
    // accident) — even when the family is uniform throughout. Rather than
    // losing the family entirely in that case (which left fontFamily "" and
    // made the PPTX renderer fall back to Arial), sample the first
    // character's font as a representative value.
    let fontName = node.fontName;
    if (fontName === figma.mixed) {
      try {
        fontName = node.characters.length > 0 ? node.getRangeFontName(0, 1) : null;
      } catch (e) {
        fontName = null;
      }
      if (fontName === figma.mixed) fontName = null;
    }
    const fontStyle = safeGet(fontName ? fontName.style : "", "Regular");
    const italic = fontStyle.toLowerCase().includes("italic");
    const baseFamily = fontName ? fontName.family : "";

    // PowerPoint has no numeric font-weight control, only a binary bold flag.
    // Request the specifically-named weight variant (e.g. "Inter SemiBold")
    // for anything other than Regular/Bold so weights like Medium/Light/Black
    // aren't all flattened down to Regular.
    const weightName = fontStyle.replace(/italic/i, "").trim() || "Regular";
    const bold = weightName.toLowerCase() === "bold";
    const fontFamily =
      baseFamily && !["regular", "bold"].includes(weightName.toLowerCase())
        ? `${baseFamily} ${weightName}`
        : baseFamily;

    let color = "000000";
    const fills = safeGet(node.fills, []);
    if (Array.isArray(fills) && fills.length > 0) {
      // fills[] is bottom-to-top; the last matching SOLID paint is the one actually rendered.
      const solidFills = fills.filter((f) => f.type === "SOLID" && f.visible !== false);
      const solidFill = solidFills[solidFills.length - 1];
      if (solidFill) color = rgbToHex(solidFill.color);
    }

    const rawAlign = safeGet(node.textAlignHorizontal, "LEFT");
    const align = rawAlign.toLowerCase();

    // Figma: TOP | CENTER | BOTTOM  →  pptxgenjs: top | middle | bottom
    const rawVAlign = safeGet(node.textAlignVertical, "TOP");
    const valign = rawVAlign === "CENTER" ? "middle" : rawVAlign.toLowerCase();

    const lineHeight = safeGet(node.lineHeight, { unit: "AUTO" });
    const lineHeightPx =
      lineHeight.unit === "PIXELS"
        ? lineHeight.value
        : lineHeight.unit === "PERCENT"
        ? (fontSize * lineHeight.value) / 100
        : fontSize * 1.2;

    const letterSpacing = safeGet(node.letterSpacing, { unit: "PERCENT", value: 0 });
    const letterSpacingPx =
      letterSpacing.unit === "PIXELS"
        ? letterSpacing.value
        : (fontSize * letterSpacing.value) / 100;
    // Figma px → pt, same 96→72dpi ratio used for font size. Negative values
    // (tight/condensed tracking) are valid in Figma and OOXML — don't clamp.
    const charSpacingPt = letterSpacingPx * 0.75;

    results.push({
      text: node.characters,
      x, y, w, h,
      fontSize, bold, italic, fontFamily, color, align, valign, lineHeightPx,
      charSpacingPt,
      opacity: node.opacity !== undefined ? node.opacity : 1,
    });

    return results;
  }

  if ("children" in node) {
    for (const child of node.children) {
      if (child.visible === false) continue;
      extractTextNodes(child, rootFrame, results);
    }
  }

  return results;
}

/**
 * Export a frame as a PNG at the given scale.
 * Falls back to 1× on memory errors.
 */
/** Recursively collect all TEXT nodes in a subtree */
function collectTextNodes(node, results = []) {
  if (node.type === "TEXT") { results.push(node); return results; }
  if ("children" in node) {
    for (const child of node.children) collectTextNodes(child, results);
  }
  return results;
}

/** Returns true if node has at least one IMAGE-type fill */
function nodeHasImageFill(node) {
  const fills = safeGet(node.fills, []);
  return Array.isArray(fills) && fills.some((f) => f.type === "IMAGE" && f.visible !== false);
}

/**
 * Returns true if any immediate child of `node` is a mask layer (isMask === true).
 * Figma clips its masked siblings only when the group is composited as a whole —
 * a masked layer exported on its own (exportAsync on just the image node) ignores
 * the mask shape entirely and renders its full, unclipped rectangle. So a group
 * like this must be flattened and exported as one unit rather than recursed into.
 */
function hasMaskChild(node) {
  return "children" in node && node.children.some((c) => c.isMask);
}

/** Node types treated as standalone shapes/lines, exported individually rather than baked into the background */
const SHAPE_NODE_TYPES = new Set([
  "RECTANGLE",
  "ELLIPSE",
  "LINE",
  "POLYGON",
  "STAR",
  "VECTOR",
  "BOOLEAN_OPERATION",
]);

/** Regular-polygon side count → matching PPTX autoshape name */
const POLYGON_SHAPE_BY_SIDES = { 3: "triangle", 4: "diamond", 5: "pentagon", 6: "hexagon", 7: "heptagon", 8: "octagon" };

/** Star point counts pptxgenjs ships a dedicated autoshape for */
const SUPPORTED_STAR_POINTS = new Set([4, 5, 6, 7, 8, 10, 12, 16, 24, 32]);

/**
 * Try to describe a RECTANGLE/ELLIPSE/LINE/POLYGON/STAR node as a native PPTX
 * autoshape (fill + stroke color, geometry) instead of a flattened raster image.
 * Returns null when the shape can't be represented cleanly as one — a rotated
 * shape, a gradient/image fill or stroke, mixed corner radii, or a polygon/star
 * point count with no matching PPTX autoshape — and the caller falls back to
 * rasterising it as an image instead.
 */
function tryExtractVectorShape(node) {
  // A native PPTX shape's x/y/w/h describe its un-rotated box; the only
  // geometry we read below (absoluteBoundingBox) is the POST-rotation
  // axis-aligned box, which only matches the un-rotated box when there's no
  // rotation. Rather than risk placing a rotated shape at the wrong size,
  // skip it and let it fall back to the raster pass.
  if (Math.abs(node.rotation || 0) > 0.01) return null;

  let shapeType;
  let rectRadius;

  if (node.type === "RECTANGLE") {
    const radius = node.cornerRadius;
    if (radius === figma.mixed) return null;
    if (radius > 0) {
      shapeType = "roundRect";
      rectRadius = radius;
    } else {
      shapeType = "rect";
    }
  } else if (node.type === "ELLIPSE") {
    shapeType = "ellipse";
  } else if (node.type === "LINE") {
    shapeType = "line";
  } else if (node.type === "POLYGON") {
    shapeType = POLYGON_SHAPE_BY_SIDES[node.pointCount];
    if (!shapeType) return null;
  } else if (node.type === "STAR") {
    if (!SUPPORTED_STAR_POINTS.has(node.pointCount)) return null;
    shapeType = `star${node.pointCount}`;
  } else {
    return null;
  }

  let fillColor = null;
  let fillOpacity = 1;
  const fills = safeGet(node.fills, []);
  if (Array.isArray(fills)) {
    const visibleFills = fills.filter((f) => f.visible !== false);
    const solidFills = visibleFills.filter((f) => f.type === "SOLID");
    const topFill = solidFills[solidFills.length - 1];
    if (topFill) {
      fillColor = rgbToHex(topFill.color);
      fillOpacity = topFill.opacity !== undefined ? topFill.opacity : 1;
    } else if (visibleFills.length > 0) {
      return null; // gradient/image fill — no clean autoshape equivalent
    }
  }

  let strokeColor = null;
  let strokeWeight = 0;
  const strokes = safeGet(node.strokes, []);
  if (Array.isArray(strokes)) {
    const visibleStrokes = strokes.filter((s) => s.visible !== false);
    const solidStrokes = visibleStrokes.filter((s) => s.type === "SOLID");
    const topStroke = solidStrokes[solidStrokes.length - 1];
    if (topStroke) {
      strokeColor = rgbToHex(topStroke.color);
      strokeWeight = safeGet(node.strokeWeight, 0) || 0;
    } else if (visibleStrokes.length > 0) {
      return null; // gradient stroke — no clean autoshape equivalent
    }
  }

  if (node.type === "LINE" && !strokeColor) return null; // invisible line, nothing to draw

  return {
    shapeType,
    rectRadius,
    fillColor,
    fillOpacity,
    strokeColor,
    strokeWeight,
    opacity: node.opacity !== undefined ? node.opacity : 1,
  };
}

/**
 * exportAsync on an isolated node renders that node's own full geometry and
 * ignores any cropping contributed by an ancestor frame's "Clip content" —
 * so a shape that looks like a thin sliver in Figma (because a parent frame
 * clips it down) would export as its full, much larger, unclipped bounds.
 * Detect that case by checking whether the node's bounds actually fit inside
 * every clipping ancestor up to (and including) the root frame being exported.
 */
function isClippedByAncestor(node, rootFrame) {
  const nodeAbs = node.absoluteRenderBounds || node.absoluteBoundingBox;
  if (!nodeAbs) return false;
  const EPS = 0.5;
  let current = node.parent;
  while (current) {
    if (current.clipsContent) {
      const pAbs = current.absoluteBoundingBox;
      if (pAbs) {
        const fitsX = nodeAbs.x >= pAbs.x - EPS && nodeAbs.x + nodeAbs.width <= pAbs.x + pAbs.width + EPS;
        const fitsY = nodeAbs.y >= pAbs.y - EPS && nodeAbs.y + nodeAbs.height <= pAbs.y + pAbs.height + EPS;
        if (!fitsX || !fitsY) return true;
      }
    }
    if (current.id === rootFrame.id) break;
    current = current.parent;
  }
  return false;
}

/**
 * Recursively collect nodes to export as individual images, each on its own
 * transparent PNG rather than flattened into the artboard's background raster:
 * - Nodes with IMAGE fills (placed bitmaps)
 * - Shapes and lines (RECTANGLE, ELLIPSE, LINE, POLYGON, STAR, VECTOR, BOOLEAN_OPERATION)
 * Stops recursing once a target node is found. Shapes that are visually clipped
 * by an ancestor frame are left out (flagged via `clippedFound`) so they fall
 * back to the background raster, which renders the clip correctly.
 *
 * When `preserveVectors` is on, eligible shape nodes are described as native
 * PPTX autoshapes into `vectorResults` instead of being queued for image
 * export — see `tryExtractVectorShape`.
 */
function collectIndividualNodes(node, rootFrame, results = [], vectorResults = [], clippedFound = { any: false }, preserveVectors = false) {
  if (node.visible === false) return results;

  const isShapeCandidate = node !== rootFrame && (
    nodeHasImageFill(node) ||
    SHAPE_NODE_TYPES.has(node.type)
  );

  // A group that masks its own children (e.g. an image mask) must be exported
  // as one flattened unit — exportAsync on the group itself applies the mask
  // correctly, but exporting the masked child alone would not. Stop recursing
  // here rather than descending into the mask shape and the image separately.
  const isMaskingGroup = node !== rootFrame && !isShapeCandidate && hasMaskChild(node);

  if (isShapeCandidate || isMaskingGroup) {
    if (isClippedByAncestor(node, rootFrame)) {
      clippedFound.any = true;
      return results;
    }

    if (preserveVectors) {
      const vectorShape = tryExtractVectorShape(node);
      if (vectorShape) {
        const abs = node.absoluteBoundingBox;
        const rootAbs = rootFrame.absoluteBoundingBox;
        if (abs && rootAbs) {
          vectorResults.push({
            node,
            ...vectorShape,
            x: abs.x - rootAbs.x,
            y: abs.y - rootAbs.y,
            w: abs.width,
            h: abs.height,
          });
        }
        return results;
      }
    }

    // absoluteBoundingBox is geometry only — a LINE node's is 0 along its thin
    // axis, since visible thickness comes entirely from the stroke. exportAsync
    // rasterizes the actual visual footprint (stroke, effects, etc.), which is
    // what absoluteRenderBounds reports, so use that for placement to keep the
    // exported pixels aligned with the box we tell PowerPoint to put them in.
    const abs = node.absoluteRenderBounds || node.absoluteBoundingBox;
    const rootAbs = rootFrame.absoluteBoundingBox;
    if (abs && rootAbs) {
      results.push({
        node,
        x: abs.x - rootAbs.x,
        y: abs.y - rootAbs.y,
        w: abs.width,
        h: abs.height,
      });
    }
    return results;
  }

  if ("children" in node) {
    for (const child of node.children) {
      collectIndividualNodes(child, rootFrame, results, vectorResults, clippedFound, preserveVectors);
    }
  }

  return results;
}

/** Export each individual node as a PNG and return serialisable data */
async function exportIndividualNodes(nodeInfos, scale) {
  const results = [];
  for (const { node, x, y, w, h } of nodeInfos) {
    try {
      const bytes = await node.exportAsync({
        format: "PNG",
        constraint: { type: "SCALE", value: scale },
      });
      results.push({ x, y, w, h, imageBytes: bytes });
    } catch (e) {
      console.warn(`Skipped node "${node.name}": ${e.message}`);
    }
  }
  return results;
}

/**
 * Export a frame as a PNG with text nodes AND individually-exported nodes hidden,
 * so the raster background contains only shapes/backgrounds.
 * All visibility is restored immediately after export.
 * Falls back to 1× on memory errors.
 */
async function exportFrameImage(frame, scale = 2, extraHideNodes = []) {
  const textNodes = collectTextNodes(frame);
  const allHide = [...textNodes, ...extraHideNodes];
  const wasVisible = allHide.map((n) => n.visible);
  for (const n of allHide) n.visible = false;

  try {
    const bytes = await frame.exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: scale },
    });
    return bytes;
  } catch (e) {
    if (scale > 1) {
      console.warn(`Frame "${frame.name}": ${scale}× export failed, retrying at 1×`);
      return exportFrameImage(frame, 1, extraHideNodes);
    }
    console.error(`Frame "${frame.name}": export failed`, e);
    return null;
  } finally {
    for (let i = 0; i < allHide.length; i++) {
      allHide[i].visible = wasVisible[i];
    }
  }
}

// ── Main export flow ──────────────────────────

async function runExport({ includeTextOverlay, exportScale, preserveVectors }) {
  const page = figma.currentPage;
  const frames = page.children.filter((n) => n.type === "FRAME");

  if (frames.length === 0) {
    figma.ui.postMessage({
      type: "error",
      message: "No top-level frames found on this page. Each frame = one slide.",
    });
    return;
  }

  figma.ui.postMessage({
    type: "progress",
    stage: "start",
    total: frames.length,
    message: `Found ${frames.length} frame${frames.length !== 1 ? "s" : ""} — starting export…`,
  });

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];

    figma.ui.postMessage({
      type: "progress",
      stage: "frame",
      current: i + 1,
      total: frames.length,
      message: `Processing "${frame.name}" (${i + 1}/${frames.length})…`,
    });

    const clippedFound = { any: false };
    const vectorShapeInfos = [];
    const indivNodeInfos = collectIndividualNodes(frame, frame, [], vectorShapeInfos, clippedFound, preserveVectors);
    const indivNodeRefs = indivNodeInfos.map((info) => info.node);
    const vectorNodeRefs = vectorShapeInfos.map((info) => info.node);

    // Determine the artboard's own background: if the topmost visible fill is a
    // flat SOLID paint, use that color directly as the PPTX slide background and
    // skip rasterising the frame entirely — every shape/line/image is exported as
    // its own transparent layer instead of being flattened together. If any shape
    // was left out of that individual-export pass because an ancestor frame clips
    // it (see isClippedByAncestor), we still need the raster pass to render it
    // correctly, so the background can't be skipped in that case.
    let bgColor = "FFFFFF";
    let isSolidBg = true;
    if (frame.fills && Array.isArray(frame.fills) && frame.fills.length > 0) {
      const visibleFills = frame.fills.filter((f) => f.visible !== false);
      const topFill = visibleFills[visibleFills.length - 1];
      isSolidBg = !topFill || topFill.type === "SOLID";
      const solidFills = visibleFills.filter((f) => f.type === "SOLID");
      const solidBg = solidFills[solidFills.length - 1];
      if (solidBg) bgColor = rgbToHex(solidBg.color);
    }
    if (clippedFound.any) isSolidBg = false;

    const imageBytes = isSolidBg
      ? null
      : await exportFrameImage(frame, exportScale, [...indivNodeRefs, ...vectorNodeRefs]);

    if (indivNodeInfos.length > 0) {
      figma.ui.postMessage({
        type: "progress",
        stage: "frame",
        current: i + 1,
        total: frames.length,
        message: `Exporting ${indivNodeInfos.length} shape(s)/image(s) from "${frame.name}"…`,
      });
    }

    const individualImages = await exportIndividualNodes(indivNodeInfos, exportScale);
    const textNodes = includeTextOverlay ? extractTextNodes(frame, frame) : [];
    // Drop the live node reference — postMessage can only send plain data.
    const vectorShapes = vectorShapeInfos.map(({ node, ...rest }) => rest);

    figma.ui.postMessage({
      type: "slide",
      slide: {
        index: i,
        name: frame.name,
        width: frame.width,
        height: frame.height,
        bgColor,
        imageBytes,
        textNodes,
        individualImages,
        vectorShapes,
      },
    });
  }

  figma.ui.postMessage({
    type: "slides-done",
    total: frames.length,
    pageName: page.name,
  });
}

// ── Message handler ───────────────────────────

figma.ui.onmessage = (msg) => {
  switch (msg.type) {
    case "start-export":
      runExport({
        includeTextOverlay: msg.includeTextOverlay !== undefined ? msg.includeTextOverlay : true,
        exportScale: msg.exportScale !== undefined ? msg.exportScale : 2,
        preserveVectors: msg.preserveVectors !== undefined ? msg.preserveVectors : false,
      });
      break;

    case "close":
      figma.closePlugin();
      break;

    default:
      console.warn("Unknown message type:", msg.type);
  }
};
