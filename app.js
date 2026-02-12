import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.mjs";

const pdfInput = document.getElementById("pdfInput");
const pagesEl = document.getElementById("pages");
const saveBtn = document.getElementById("saveBtn");
const clearPageBtn = document.getElementById("clearPageBtn");
const penOnlyEl = document.getElementById("penOnly");
const statusEl = document.getElementById("status");

function setStatus(msg) {
  statusEl.textContent = msg;
  console.log("[status]", msg);
}

window.addEventListener("error", (e) => {
  console.error("Window error:", e.error || e.message);
  setStatus("Error — open console (F12).");
});

window.addEventListener("unhandledrejection", (e) => {
  console.error("Unhandled promise rejection:", e.reason);
  setStatus("Error — open console (F12).");
});

let pdfFile = null;
let pdfDoc = null;
let pageModels = []; // [{pageNumber, width, height, svgEl, strokes: Stroke[]}]
let activePageIndex = 0;

// Stroke = { id, color, width, points:[{x,y,t}], tStart, tEnd }

function baseName(filename) {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(0, dot) : filename;
}

function pad3(n) {
  return String(n).padStart(3, "0");
}

function nowMs() {
  return performance.timeOrigin + performance.now();
}

function makeSvgInkLayer(width, height) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("inkLayer");
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  return svg;
}

function getLocalPoint(svg, clientX, clientY) {
  const rect = svg.getBoundingClientRect();
  const x = (clientX - rect.left) * (svg.viewBox.baseVal.width / rect.width);
  const y = (clientY - rect.top) * (svg.viewBox.baseVal.height / rect.height);
  return { x, y };
}

function pointsToPathD(points) {
  if (!points.length) return "";
  const parts = [`M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`];
  for (let i = 1; i < points.length; i++) {
    parts.push(`L ${points[i].x.toFixed(2)} ${points[i].y.toFixed(2)}`);
  }
  return parts.join(" ");
}

function appendStrokeToSvg(svg, stroke) {
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", stroke.color);
  path.setAttribute("stroke-width", String(stroke.width));
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");

  // geometry
  path.setAttribute("d", pointsToPathD(stroke.points));

  // timestamps: store start time + per-point delta ms
  const deltas = stroke.points.map(p => Math.max(0, Math.round(p.t - stroke.tStart)));
  path.setAttribute("data-tstart", String(Math.round(stroke.tStart)));
  path.setAttribute("data-dt", deltas.join(","));
  path.setAttribute("data-id", stroke.id);

  svg.appendChild(path);
}

function rebuildSvg(svg, strokes) {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  for (const s of strokes) appendStrokeToSvg(svg, s);
}

function attachInking(svg, model) {
  let drawing = false;
  let currentStroke = null;

  const strokeColor = "#0b57d0";
  const strokeWidth = 2.5;

  // Keep default browser panning/scrolling for touch/finger
  // Only disable it for pen while drawing (we do that via preventDefault below)
  // Also: ensure svg has touch-action: auto in CSS if you want full scrolling.
  // (We’ll keep touch-action: none BUT only for pen events; see note below.)

  svg.addEventListener("pointerdown", (e) => {
    // Only stylus draws
    if (e.pointerType !== "pen") return;

    svg.setPointerCapture(e.pointerId);
    drawing = true;

    const t = nowMs();
    const p = getLocalPoint(svg, e.clientX, e.clientY);

    currentStroke = {
      id: crypto.randomUUID(),
      color: strokeColor,
      width: strokeWidth,
      points: [{ x: p.x, y: p.y, t }],
      tStart: t,
      tEnd: t
    };

    // live path
    appendStrokeToSvg(svg, currentStroke);

    // prevent palm/pen gestures from scrolling while drawing
    e.preventDefault();
  }, { passive: false });

  svg.addEventListener("pointermove", (e) => {
    if (!drawing || !currentStroke) return;
    if (e.pointerType !== "pen") return;

    const t = nowMs();
    const p = getLocalPoint(svg, e.clientX, e.clientY);

    currentStroke.points.push({ x: p.x, y: p.y, t });
    currentStroke.tEnd = t;

    const livePath = svg.lastElementChild;
    if (livePath && livePath.tagName.toLowerCase() === "path") {
      livePath.setAttribute("d", pointsToPathD(currentStroke.points));
      const deltas = currentStroke.points.map(pt => Math.max(0, Math.round(pt.t - currentStroke.tStart)));
      livePath.setAttribute("data-tstart", String(Math.round(currentStroke.tStart)));
      livePath.setAttribute("data-dt", deltas.join(","));
    }

    e.preventDefault();
  }, { passive: false });

  function endStroke(e) {
    if (!drawing || !currentStroke) return;
    if (e && e.pointerType !== "pen") return;

    drawing = false;

    // commit
    model.strokes.push(currentStroke);
    currentStroke = null;
  }

  svg.addEventListener("pointerup", endStroke);
  svg.addEventListener("pointercancel", endStroke);
}


async function renderPdf(arrayBuffer) {
  pagesEl.innerHTML = "";
  pageModels = [];
  activePageIndex = 0;

  setStatus("Opening PDF…");
  pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  setStatus(`Rendering ${pdfDoc.numPages} page(s)…`);

  for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber++) {
    const page = await pdfDoc.getPage(pageNumber);

    // scale for readability (change to 1.0 if you want A4-ish size)
    const viewport = page.getViewport({ scale: 1.6 });

    const pageWrap = document.createElement("section");
    pageWrap.className = "page";

    const header = document.createElement("div");
    header.className = "pageHeader";
    header.innerHTML = `<div>Page ${pageNumber}</div><div class="meta"></div>`;
    pageWrap.appendChild(header);

    const stage = document.createElement("div");
    stage.className = "stage";

    const canvas = document.createElement("canvas");
    canvas.className = "pdfCanvas";
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    stage.appendChild(canvas);

    const svg = makeSvgInkLayer(canvas.width, canvas.height);
    stage.appendChild(svg);

    pageWrap.appendChild(stage);
    pagesEl.appendChild(pageWrap);

    // render PDF into canvas
    const ctx = canvas.getContext("2d", { alpha: false });
    await page.render({ canvasContext: ctx, viewport }).promise;

    const model = {
      pageNumber,
      width: canvas.width,
      height: canvas.height,
      svgEl: svg,
      strokes: []
    };

    pageModels.push(model);
    attachInking(svg, model);

    stage.addEventListener("click", () => {
      activePageIndex = pageNumber - 1;
      clearPageBtn.disabled = false;
      setStatus(`Active page: ${pageNumber}`);
    });
  }

  saveBtn.disabled = false;
  clearPageBtn.disabled = false;
  setStatus(`Ready — rendered ${pdfDoc.numPages} page(s).`);
}

function svgStringForPage(model, pdfName) {
  const svg = model.svgEl.cloneNode(true);

  svg.setAttribute("data-source-pdf", pdfName);
  svg.setAttribute("data-page", String(model.pageNumber));
  svg.setAttribute("data-exported-at", new Date().toISOString());

  // Ensure export matches model strokes
  rebuildSvg(svg, model.strokes);

  return new XMLSerializer().serializeToString(svg);
}

async function saveSvgsToFolder() {
  if (!pdfFile || !pageModels.length) return;

  if (!("showDirectoryPicker" in window)) {
    alert("Folder saving needs Chrome/Edge (File System Access API).");
    return;
  }

  const pdfName = baseName(pdfFile.name);

  // User chooses a directory (browser security prevents auto “same folder as PDF”)
  setStatus("Choose an output folder…");
  const rootDir = await window.showDirectoryPicker({ mode: "readwrite" });

  const outDir = await rootDir.getDirectoryHandle(pdfName, { create: true });

  setStatus("Saving SVGs…");

  for (const model of pageModels) {
    const svgText = svgStringForPage(model, pdfFile.name);
    const filename = `page-${pad3(model.pageNumber)}.svg`;

    const fh = await outDir.getFileHandle(filename, { create: true });
    const writable = await fh.createWritable();
    await writable.write(svgText);
    await writable.close();
  }

  const manifest = {
    sourcePdf: pdfFile.name,
    exportedAt: new Date().toISOString(),
    pages: pageModels.map(m => ({
      page: m.pageNumber,
      width: m.width,
      height: m.height,
      svg: `page-${pad3(m.pageNumber)}.svg`,
      strokes: m.strokes.length
    }))
  };

  const mf = await outDir.getFileHandle("manifest.json", { create: true });
  const mw = await mf.createWritable();
  await mw.write(JSON.stringify(manifest, null, 2));
  await mw.close();

  setStatus(`Saved ${pageModels.length} SVG(s) to folder “${pdfName}”.`);
  alert(`Saved ${pageModels.length} SVG(s) into folder “${pdfName}”.`);
}

pdfInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  try {
    pdfFile = file;
    setStatus(`Loading ${file.name}…`);
    const buf = await file.arrayBuffer();
    await renderPdf(buf);
  } catch (err) {
    console.error(err);
    setStatus("Failed to load PDF — open console (F12).");
    alert("PDF load failed. Open DevTools (F12) → Console and paste the error here.");
  }
});

saveBtn.addEventListener("click", saveSvgsToFolder);

clearPageBtn.addEventListener("click", () => {
  const m = pageModels[activePageIndex];
  if (!m) return;
  m.strokes = [];
  rebuildSvg(m.svgEl, m.strokes);
  setStatus(`Cleared page ${m.pageNumber}.`);
});

setStatus("Ready. Choose a PDF…");
