// ─────────────────────────────────────────────
// Figma Slides Exporter — code.js (sandbox)
// Runs in Figma's plugin sandbox. No DOM access.
// Communicates with ui.html via postMessage.
// ─────────────────────────────────────────────

figma.showUI(__html__, { width: 420, height: 580, title: "Slides Exporter" });

// ── Helpers ──────────────────────────────────

/** Convert a Figma RGBA color to a 6-char hex string */
function rgbToHex(color) {
  const r = Math.round((color.r || 0) * 255).toString(16).padStart(2, "0");
  const g = Math.round((color.g || 0) * 255).toString(16).padStart(2, "0");
  const b = Math.round((color.b || 0) * 255).toString(16).padStart(2, "0");
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
    const fontWeight = safeGet(node.fontWeight, 400);
    const bold = fontWeight >= 600;

    const fontName = node.fontName !== figma.mixed ? node.fontName : null;
    const fontStyle = safeGet(fontName ? fontName.style : "", "");
    const italic = fontStyle.toLowerCase().includes("italic");
    const fontFamily = fontName ? fontName.family : "";

    let color = "000000";
    const fills = safeGet(node.fills, []);
    if (Array.isArray(fills) && fills.length > 0) {
      const solidFill = fills.find((f) => f.type === "SOLID" && f.visible !== false);
      if (solidFill) color = rgbToHex(solidFill.color);
    }

    const rawAlign = safeGet(node.textAlignHorizontal, "LEFT");
    const align = rawAlign.toLowerCase();

    const lineHeight = safeGet(node.lineHeight, { unit: "AUTO" });
    const lineHeightPx =
      lineHeight.unit === "PIXELS"
        ? lineHeight.value
        : lineHeight.unit === "PERCENT"
        ? (fontSize * lineHeight.value) / 100
        : fontSize * 1.2;

    const letterSpacing = safeGet(node.letterSpacing, { unit: "PERCENT", value: 0 });
    const charSpacingPt =
      letterSpacing.unit === "PIXELS"
        ? letterSpacing.value * 0.75
        : (fontSize * letterSpacing.value) / 100;

    results.push({
      text: node.characters,
      x, y, w, h,
      fontSize, bold, italic, fontFamily, color, align, lineHeightPx,
      charSpacingPt: Math.max(0, charSpacingPt),
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
 * Recursively collect nodes to export as individual images:
 * - Nodes with IMAGE fills (placed bitmaps)
 * - VECTOR / BOOLEAN_OPERATION nodes (icons / compound paths)
 * Stops recursing once a target node is found.
 */
function collectIndividualNodes(node, rootFrame, results = []) {
  if (node.visible === false) return results;

  const isTarget = node !== rootFrame && (
    nodeHasImageFill(node) ||
    node.type === "VECTOR" ||
    node.type === "BOOLEAN_OPERATION"
  );

  if (isTarget) {
    const abs = node.absoluteBoundingBox;
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
      collectIndividualNodes(child, rootFrame, results);
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
      results.push({ x, y, w, h, imageBytes: Array.from(bytes) });
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
    return Array.from(bytes);
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

async function runExport({ includeTextOverlay, exportScale }) {
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

  const slides = [];

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];

    figma.ui.postMessage({
      type: "progress",
      stage: "frame",
      current: i + 1,
      total: frames.length,
      message: `Rasterising "${frame.name}" (${i + 1}/${frames.length})…`,
    });

    const indivNodeInfos = collectIndividualNodes(frame, frame);
    const indivNodeRefs = indivNodeInfos.map((info) => info.node);

    const imageBytes = await exportFrameImage(frame, exportScale, indivNodeRefs);

    if (indivNodeInfos.length > 0) {
      figma.ui.postMessage({
        type: "progress",
        stage: "frame",
        current: i + 1,
        total: frames.length,
        message: `Exporting ${indivNodeInfos.length} image(s)/icon(s) from "${frame.name}"…`,
      });
    }

    const individualImages = await exportIndividualNodes(indivNodeInfos, exportScale);
    const textNodes = includeTextOverlay ? extractTextNodes(frame, frame) : [];

    let bgColor = "FFFFFF";
    if (frame.fills && Array.isArray(frame.fills) && frame.fills.length > 0) {
      const solidBg = frame.fills.find((f) => f.type === "SOLID" && f.visible !== false);
      if (solidBg) bgColor = rgbToHex(solidBg.color);
    }

    slides.push({
      index: i,
      name: frame.name,
      width: frame.width,
      height: frame.height,
      bgColor,
      imageBytes,
      textNodes,
      individualImages,
    });
  }

  figma.ui.postMessage({
    type: "slides-ready",
    slides,
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
      });
      break;

    case "close":
      figma.closePlugin();
      break;

    default:
      console.warn("Unknown message type:", msg.type);
  }
};
