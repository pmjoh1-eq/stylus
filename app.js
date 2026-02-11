
/* global pdfjsLib */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.js";

const pdfInput = document.getElementById("pdfInput");
const pagesEl = document.getElementById("pages");
const saveBtn = document.getElementById("saveBtn");
const clearPageBtn = document.getElementById("clearPageBtn");
const penOnlyEl = document.getElementById("penOnly");

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

  // timestamps (per point)
  // Store as comma-separated deltas from tStart (smaller than absolute times)
  const deltas = stroke.points.map(p => Math.max(0, Math.round(p.t - stroke.tStart)));
  path.setAttribute("data-tstart", String(Math.round(stroke.tStart)));
  path.setAttribute("data-dt", deltas.join(","));

  // optional: preserve an id
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

  svg.addEventListener("pointerdown", (e) => {
    // Pen-only option
    if (penOnlyEl.checked && e.pointerType !== "pen") return;

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

    // create a live path element
    appendStrokeToSvg(svg, currentStroke);
    e.preventDefault();
  });

  svg.addEventListener("pointermove", (e) => {
    if (!drawing || !currentStroke) return;
    if (penOnlyEl.checked && e.pointerType !== "pen") return;

    const t = nowMs();
    const p = getLocalPoint(svg, e.clientX, e.clientY);

    currentStroke.points.push({ x: p.x, y: p.y, t });
    currentStroke.tEnd = t;

    // update the last path (live)
    const livePath = svg.lastElementChild;
    if (livePath && livePath.tagName.toLowerCase() === "path") {
      livePath.setAttribute("d", pointsToPathD(currentStroke.points));
      const deltas = currentStroke.points.map(pt => Math.max(0, Math.round(pt.t - currentStroke.tStart)));
      livePath.setAttribute("data-tstart", String(Math.round(currentStroke.tStart)));
      livePath.setAttribute("data-dt", deltas.join(","));
    }

    e.preventDefault();
  });

  function endStroke() {
    if (!drawing || !currentStroke) return;
    drawing = false;

    // commit to model
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

  pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber++) {
    const page = await pdfDoc.getPage(pageNumber);

    // scale for readability (you can tweak)
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

    // set active page on click (for "clear current page")
    stage.addEventListener("click", () => {
      activePageIndex = pageNumber - 1;
      clearPageBtn.disabled = false;
    });
  }

  saveBtn.disabled = false;
  clearPageBtn.disabled = false;
}

function svgStringForPage(model, pdfName) {
  // Clone ink layer and embed minimal metadata
  const svg = model.svgEl.cloneNode(true);

  svg.setAttribute("data-source-pdf", pdfName);
  svg.setAttribute("data-page", String(model.pageNumber));
  svg.setAttribute("data-exported-at", new Date().toISOString());

  // Ensure it’s rebuilt from model (not relying on DOM state)
  rebuildSvg(svg, model.strokes);

  const serializer = new XMLSerializer();
  return serializer.serializeToString(svg);
}

async function saveSvgsToFolder() {
  if (!pdfFile || !pageModels.length) return;

  if (!("showDirectoryPicker" in window)) {
    alert("Your browser doesn't support saving to folders (File System Access API). Use Chrome/Edge.");
    return;
  }

  const pdfName = baseName(pdfFile.name);

  // User chooses a directory (cannot auto-detect “same folder as PDF”)
  const rootDir = await window.showDirectoryPicker({ mode: "readwrite" });

  // Create subfolder named after PDF
  const outDir = await rootDir.getDirectoryHandle(pdfName, { create: true });

  // Save each page SVG
  for (const model of pageModels) {
    const svgText = svgStringForPage(model, pdfFile.name);
    const filename = `page-${pad3(model.pageNumber)}.svg`;

    const fh = await outDir.getFileHandle(filename, { create: true });
    const writable = await fh.createWritable();
    await writable.write(svgText);
    await writable.close();
  }

  // Optional manifest (helps playback tooling later)
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

  alert(`Saved ${pageModels.length} SVG(s) into folder “${pdfName}”.`);
}

pdfInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  pdfFile = file;
  const buf = await file.arrayBuffer();
  await renderPdf(buf);
});

saveBtn.addEventListener("click", saveSvgsToFolder);

clearPageBtn.addEventListener("click", () => {
  const m = pageModels[activePageIndex];
  if (!m) return;
  m.strokes = [];
  rebuildSvg(m.svgEl, m.strokes);
});
