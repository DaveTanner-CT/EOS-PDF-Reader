/* ============================================================
   PDF Read-Aloud Highlighter — E.O. Smith High School
   ------------------------------------------------------------
   All processing happens locally in the browser:
     • PDF.js renders pages and extracts text
     • The Web Speech API (speechSynthesis) reads sentences aloud
     • The current sentence is highlighted on the PDF text layer

   No data ever leaves the device.
   ============================================================ */

"use strict";

/* ---------- PDF.js setup ---------- */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

/* ---------- DOM references ---------- */

const els = {
  fileInput: document.getElementById("fileInput"),
  dropZone: document.getElementById("dropZone"),
  uploadCard: document.getElementById("uploadCard"),
  statusBar: document.getElementById("statusBar"),
  errorBar: document.getElementById("errorBar"),
  speechWarning: document.getElementById("speechWarning"),
  readerSection: document.getElementById("readerSection"),
  viewer: document.getElementById("viewer"),
  docName: document.getElementById("docName"),
  newFileBtn: document.getElementById("newFileBtn"),
  prevPageBtn: document.getElementById("prevPageBtn"),
  nextPageBtn: document.getElementById("nextPageBtn"),
  pageInput: document.getElementById("pageInput"),
  pageCount: document.getElementById("pageCount"),
  controlBar: document.getElementById("controlBar"),
  playPauseBtn: document.getElementById("playPauseBtn"),
  playIcon: document.getElementById("playIcon"),
  pauseIcon: document.getElementById("pauseIcon"),
  stopBtn: document.getElementById("stopBtn"),
  prevBtn: document.getElementById("prevBtn"),
  nextBtn: document.getElementById("nextBtn"),
  nowReading: document.getElementById("nowReading"),
  rateSlider: document.getElementById("rateSlider"),
  rateValue: document.getElementById("rateValue"),
  voiceSelect: document.getElementById("voiceSelect"),
  schoolLogo: document.getElementById("schoolLogo"),
  logoFallback: document.getElementById("logoFallback"),
};

/* ---------- Application state ---------- */

const state = {
  pdfDoc: null,          // PDF.js document
  pages: [],             // per-page data: { num, items, charRanges, viewport info, DOM }
  sentences: [],         // flat list of readable chunks across the whole document
  currentSentence: -1,   // index into state.sentences
  isPlaying: false,      // true while speech is actively progressing
  utterance: null,       // the in-flight SpeechSynthesisUtterance
  voices: [],            // available speech voices
  renderScale: 1,        // CSS pixels per PDF unit at current width
  renderedPages: new Set(),
  observer: null,        // IntersectionObserver for lazy page rendering
};

const MAX_CHUNK_CHARS = 280;   // long sentences are split for smoother speech
const RENDER_KEEP_RANGE = 4;   // keep this many pages rendered around the view

/* ============================================================
   Logo fallback: if logo.png is missing, show a monogram badge.
   ============================================================ */

els.schoolLogo.addEventListener("error", () => {
  els.schoolLogo.hidden = true;
  els.logoFallback.hidden = false;
});

/* ============================================================
   Speech support check
   ============================================================ */

const speechSupported = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
if (!speechSupported) {
  els.speechWarning.hidden = false;
}

/* ============================================================
   Voice loading (voices arrive asynchronously in most browsers)
   ============================================================ */

function loadVoices() {
  if (!speechSupported) return;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return;

  state.voices = voices;
  const previous = els.voiceSelect.value;
  els.voiceSelect.innerHTML = "";

  // English voices first — most readable ordering for school use.
  const sorted = [...voices].sort((a, b) => {
    const aEn = a.lang.startsWith("en") ? 0 : 1;
    const bEn = b.lang.startsWith("en") ? 0 : 1;
    return aEn - bEn || a.name.localeCompare(b.name);
  });

  for (const voice of sorted) {
    const opt = document.createElement("option");
    opt.value = voice.name;
    opt.textContent = `${voice.name} (${voice.lang})${voice.default ? " — default" : ""}`;
    els.voiceSelect.appendChild(opt);
  }
  if (previous && sorted.some(v => v.name === previous)) {
    els.voiceSelect.value = previous;
  }
}

if (speechSupported) {
  loadVoices();
  speechSynthesis.addEventListener("voiceschanged", loadVoices);
}

/* ============================================================
   Status + error helpers
   ============================================================ */

function showStatus(message) {
  els.statusBar.textContent = message;
  els.statusBar.hidden = false;
}

function hideStatus() {
  els.statusBar.hidden = true;
}

function showError(message) {
  els.errorBar.textContent = message;
  els.errorBar.hidden = false;
}

function hideError() {
  els.errorBar.hidden = true;
}

/* ============================================================
   File selection (tap, keyboard, drag and drop)
   ============================================================ */

els.dropZone.addEventListener("click", () => els.fileInput.click());
els.dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    els.fileInput.click();
  }
});

els.dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  els.dropZone.classList.add("dragover");
});
els.dropZone.addEventListener("dragleave", () => {
  els.dropZone.classList.remove("dragover");
});
els.dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  els.dropZone.classList.remove("dragover");
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) handleFile(file);
});

els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files && els.fileInput.files[0];
  if (file) handleFile(file);
});

els.newFileBtn.addEventListener("click", () => {
  stopReading();
  resetApp();
});

function resetApp() {
  state.pdfDoc = null;
  state.pages = [];
  state.sentences = [];
  state.currentSentence = -1;
  state.renderedPages.clear();
  if (state.observer) state.observer.disconnect();
  els.viewer.innerHTML = "";
  els.readerSection.hidden = true;
  els.controlBar.hidden = true;
  document.body.classList.remove("has-controls");
  els.uploadCard.hidden = false;
  els.fileInput.value = "";
  hideError();
  hideStatus();
}

/* ============================================================
   Loading a PDF
   ============================================================ */

async function handleFile(file) {
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    showError("That file doesn't look like a PDF. Please choose a .pdf file.");
    return;
  }

  stopReading();
  resetApp();
  els.uploadCard.hidden = true;
  showStatus("Opening PDF…");

  try {
    const buffer = await file.arrayBuffer();
    state.pdfDoc = await pdfjsLib.getDocument({ data: buffer }).promise;
  } catch (err) {
    console.error(err);
    hideStatus();
    els.uploadCard.hidden = false;
    showError("This PDF could not be opened. It may be damaged or password-protected.");
    return;
  }

  els.docName.textContent = file.name;
  els.pageCount.textContent = `/ ${state.pdfDoc.numPages}`;
  els.pageInput.max = state.pdfDoc.numPages;
  els.pageInput.value = 1;

  await extractAllText();
}

/* ============================================================
   Text extraction + sentence building
   ------------------------------------------------------------
   For each page we join PDF.js text items into one string while
   recording each item's character range. Sentences are found in
   that string, and each sentence remembers which items it covers
   so highlighting can target the matching text-layer spans.
   ============================================================ */

async function extractAllText() {
  const numPages = state.pdfDoc.numPages;
  state.pages = [];
  state.sentences = [];

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    showStatus(`Reading text… page ${pageNum} of ${numPages}`);

    const page = await state.pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const baseViewport = page.getViewport({ scale: 1 });

    // Join items into page text, recording each item's char range.
    let pageText = "";
    const charRanges = []; // charRanges[i] = { start, end } for item i
    for (const item of textContent.items) {
      const start = pageText.length;
      pageText += item.str;
      const end = pageText.length;
      charRanges.push({ start, end });
      // Separate items so words on different lines don't merge.
      pageText += item.hasEOL ? "\n" : " ";
    }

    const pageData = {
      num: pageNum,
      items: textContent.items,
      charRanges,
      baseWidth: baseViewport.width,
      baseHeight: baseViewport.height,
      container: null,
      textDivs: [],
    };
    state.pages.push(pageData);

    // Break the page text into readable sentence chunks.
    for (const chunk of splitIntoChunks(pageText)) {
      state.sentences.push({
        page: pageNum,
        text: chunk.text,
        itemIndices: itemsInRange(charRanges, chunk.start, chunk.end),
      });
    }

    // Yield to the UI every few pages so big PDFs don't freeze the tab.
    if (pageNum % 5 === 0) {
      await new Promise(requestAnimationFrame);
    }
  }

  hideStatus();

  // Image-only / scanned PDF check: no usable text anywhere.
  if (state.sentences.length === 0) {
    els.uploadCard.hidden = false;
    showError(
      "This PDF appears to be image-based and does not contain readable text. " +
      "Try a text-based PDF or use OCR first."
    );
    // Still show the document so the user can confirm what it looks like.
  }

  // Show the reader BEFORE building the viewer: page scale is computed
  // from the viewer's width, which is 0 while the section is hidden.
  els.readerSection.hidden = false;
  buildViewer();

  if (state.sentences.length > 0) {
    els.controlBar.hidden = false;
    document.body.classList.add("has-controls");
    state.currentSentence = 0;
    previewSentence(0);
  }
}

/**
 * Split text into sentence-sized chunks, keeping character offsets so
 * each chunk can be mapped back to PDF text items.
 */
function splitIntoChunks(text) {
  const chunks = [];
  // A "sentence" runs until ., !, ? (plus closing quotes/brackets) or end of text.
  const sentenceRegex = /[^.!?]*[.!?]+["')\]]*\s*|[^.!?]+$/g;
  let match;

  while ((match = sentenceRegex.exec(text)) !== null) {
    if (match[0].length === 0) { sentenceRegex.lastIndex++; continue; }
    addChunk(chunks, text, match.index, match.index + match[0].length);
  }
  return chunks;
}

/** Trim a candidate chunk, split it if it is very long, and store it. */
function addChunk(chunks, text, start, end) {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  if (e <= s) return;

  const length = e - s;
  if (length <= MAX_CHUNK_CHARS) {
    chunks.push({ text: text.slice(s, e).replace(/\s+/g, " "), start: s, end: e });
    return;
  }

  // Very long "sentence" (tables, headings run together, etc.):
  // split at the last space before the limit so speech stays natural.
  let breakAt = text.lastIndexOf(" ", s + MAX_CHUNK_CHARS);
  if (breakAt <= s) breakAt = s + MAX_CHUNK_CHARS;
  addChunk(chunks, text, s, breakAt);
  addChunk(chunks, text, breakAt, e);
}

/** Indices of text items whose character ranges overlap [start, end). */
function itemsInRange(charRanges, start, end) {
  const indices = [];
  for (let i = 0; i < charRanges.length; i++) {
    const r = charRanges[i];
    if (r.end > start && r.start < end && r.end > r.start) {
      indices.push(i);
    }
  }
  return indices;
}

/* ============================================================
   Viewer: lazy page rendering with an IntersectionObserver
   ------------------------------------------------------------
   Pages get correctly-sized placeholders immediately; the canvas
   and text layer are only rendered when a page nears the screen.
   This keeps large PDFs fast and memory-friendly.
   ============================================================ */

function buildViewer() {
  els.viewer.innerHTML = "";
  state.renderedPages.clear();

  state.renderScale = computeScale();

  for (const pageData of state.pages) {
    const container = document.createElement("div");
    container.className = "pdf-page";
    container.dataset.page = pageData.num;
    sizeContainer(container, pageData);

    const placeholder = document.createElement("div");
    placeholder.className = "page-placeholder";
    placeholder.textContent = `Page ${pageData.num}`;
    container.appendChild(placeholder);

    pageData.container = container;
    els.viewer.appendChild(container);
  }

  if (state.observer) state.observer.disconnect();
  state.observer = new IntersectionObserver(onPagesVisible, {
    rootMargin: "600px 0px",   // start rendering a bit before pages scroll in
  });
  for (const pageData of state.pages) {
    state.observer.observe(pageData.container);
  }
}

function computeScale() {
  if (!state.pages.length) return 1;
  const available = Math.min(els.viewer.clientWidth || els.viewer.offsetWidth || 800, 900);
  const baseWidth = state.pages[0].baseWidth || 612;
  return Math.min(available / baseWidth, 1.75);
}

function sizeContainer(container, pageData) {
  container.style.width = `${Math.floor(pageData.baseWidth * state.renderScale)}px`;
  container.style.height = `${Math.floor(pageData.baseHeight * state.renderScale)}px`;
}

function onPagesVisible(entries) {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const pageNum = Number(entry.target.dataset.page);
    renderPage(pageNum);
  }
}

/** Render a page's canvas + text layer (no-op if already rendered). */
async function renderPage(pageNum) {
  const pageData = state.pages[pageNum - 1];
  if (!pageData || state.renderedPages.has(pageNum)) return;
  state.renderedPages.add(pageNum);

  try {
    const page = await state.pdfDoc.getPage(pageNum);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: state.renderScale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    const ctx = canvas.getContext("2d");
    await page.render({
      canvasContext: ctx,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    }).promise;

    // Build the text layer: one positioned span per text item.
    const textLayer = document.createElement("div");
    textLayer.className = "text-layer";
    pageData.textDivs = [];

    for (const item of pageData.items) {
      const span = document.createElement("span");
      span.textContent = item.str;

      // Position the span using the item transform mapped into view space.
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const fontHeight = Math.hypot(tx[2], tx[3]);
      span.style.left = `${tx[4]}px`;
      span.style.top = `${tx[5] - fontHeight}px`;
      span.style.fontSize = `${fontHeight}px`;
      span.style.fontFamily = "sans-serif";

      textLayer.appendChild(span);
      pageData.textDivs.push(span);
    }

    pageData.container.innerHTML = "";
    pageData.container.appendChild(canvas);
    pageData.container.appendChild(textLayer);

    // Horizontally scale each span so it covers the item's true width
    // (keeps highlights aligned even when fonts don't match exactly).
    for (let i = 0; i < pageData.items.length; i++) {
      const item = pageData.items[i];
      const span = pageData.textDivs[i];
      const targetWidth = item.width * state.renderScale;
      if (targetWidth > 0 && span.offsetWidth > 0) {
        span.style.transform = `scaleX(${targetWidth / span.offsetWidth})`;
      }
    }

    // If this page holds the current sentence, re-apply its highlight.
    if (state.currentSentence >= 0) {
      const sentence = state.sentences[state.currentSentence];
      if (sentence && sentence.page === pageNum) applyHighlight(sentence);
    }

    cleanupDistantPages(pageNum);
  } catch (err) {
    console.error(`Failed to render page ${pageNum}`, err);
    state.renderedPages.delete(pageNum);
  }
}

/** Free memory by clearing canvases far from the page just rendered. */
function cleanupDistantPages(centerPage) {
  for (const pageNum of [...state.renderedPages]) {
    if (Math.abs(pageNum - centerPage) > RENDER_KEEP_RANGE) {
      const pageData = state.pages[pageNum - 1];
      // Never unrender the page currently being read aloud.
      const current = state.sentences[state.currentSentence];
      if (current && current.page === pageNum) continue;

      state.renderedPages.delete(pageNum);
      pageData.textDivs = [];
      pageData.container.innerHTML = "";
      const placeholder = document.createElement("div");
      placeholder.className = "page-placeholder";
      placeholder.textContent = `Page ${pageNum}`;
      pageData.container.appendChild(placeholder);
    }
  }
}

/* Re-render at the new width after a meaningful resize (e.g., rotating
   a phone or tablet). Debounced so it doesn't thrash. */
let resizeTimer = null;
window.addEventListener("resize", () => {
  if (!state.pdfDoc) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const newScale = computeScale();
    if (Math.abs(newScale - state.renderScale) / state.renderScale < 0.08) return;

    state.renderScale = newScale;
    state.renderedPages.clear();
    for (const pageData of state.pages) {
      sizeContainer(pageData.container, pageData);
      pageData.textDivs = [];
      pageData.container.innerHTML = "";
      const placeholder = document.createElement("div");
      placeholder.className = "page-placeholder";
      placeholder.textContent = `Page ${pageData.num}`;
      pageData.container.appendChild(placeholder);
    }
    // The IntersectionObserver re-renders whatever is on screen.
  }, 400);
});

/* ============================================================
   Page navigation
   ============================================================ */

function visiblePageEstimate() {
  // The page whose container is closest to the top of the viewport.
  let best = 1;
  let bestDist = Infinity;
  for (const pageData of state.pages) {
    const rect = pageData.container.getBoundingClientRect();
    const dist = Math.abs(rect.top);
    if (dist < bestDist) { bestDist = dist; best = pageData.num; }
  }
  return best;
}

function updateVisiblePageIndicator(pageNum) {
  if (document.activeElement !== els.pageInput) {
    els.pageInput.value = pageNum;
  }
}

function goToPage(pageNum) {
  const clamped = Math.min(Math.max(1, pageNum), state.pages.length);
  els.pageInput.value = clamped;
  const container = state.pages[clamped - 1].container;
  container.scrollIntoView({ behavior: "smooth", block: "start" });
}

els.prevPageBtn.addEventListener("click", () => goToPage(visiblePageEstimate() - 1));
els.nextPageBtn.addEventListener("click", () => goToPage(visiblePageEstimate() + 1));
els.pageInput.addEventListener("change", () => goToPage(Number(els.pageInput.value) || 1));

/* Keep the page indicator in sync while the user scrolls. */
let scrollTimer = null;
window.addEventListener("scroll", () => {
  if (!state.pages.length) return;
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => updateVisiblePageIndicator(visiblePageEstimate()), 150);
}, { passive: true });

/* ============================================================
   Highlighting
   ============================================================ */

let highlightedSpans = [];

function clearHighlight() {
  for (const span of highlightedSpans) span.classList.remove("tl-active");
  highlightedSpans = [];
}

async function highlightSentence(index) {
  clearHighlight();
  const sentence = state.sentences[index];
  if (!sentence) return;

  // Make sure the sentence's page is rendered before highlighting it.
  await renderPage(sentence.page);
  applyHighlight(sentence);

  // Bring the active text into view.
  const firstSpan = highlightedSpans[0];
  if (firstSpan) {
    firstSpan.scrollIntoView({ behavior: "smooth", block: "center" });
  } else {
    state.pages[sentence.page - 1].container.scrollIntoView({
      behavior: "smooth", block: "start",
    });
  }
  updateVisiblePageIndicator(sentence.page);
}

function applyHighlight(sentence) {
  const pageData = state.pages[sentence.page - 1];
  if (!pageData.textDivs.length) return;
  for (const i of sentence.itemIndices) {
    const span = pageData.textDivs[i];
    if (span) {
      span.classList.add("tl-active");
      highlightedSpans.push(span);
    }
  }
}

function previewSentence(index) {
  const sentence = state.sentences[index];
  els.nowReading.textContent = sentence ? sentence.text : "";
}

/* ============================================================
   Speech: play / pause / stop / prev / next
   ------------------------------------------------------------
   Each sentence is its own utterance. This sidesteps two common
   browser problems: long utterances getting cut off in Chrome,
   and pause()/resume() being unreliable on Android. "Pause" here
   cancels speech and remembers the sentence; "Resume" re-speaks
   that sentence from its start.
   ============================================================ */

function setPlayingUI(playing) {
  state.isPlaying = playing;
  els.playIcon.hidden = playing;
  els.pauseIcon.hidden = !playing;
  els.playPauseBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
}

async function speakSentence(index) {
  if (!speechSupported) return;
  if (index < 0 || index >= state.sentences.length) {
    // Reached the end of the document.
    stopReading(true);
    return;
  }

  state.currentSentence = index;
  const sentence = state.sentences[index];
  previewSentence(index);
  await highlightSentence(index);

  // Cancel anything still queued, then speak this sentence.
  // Null the reference first: some browsers fire the old utterance's
  // onend synchronously during cancel(), which would double-advance.
  state.utterance = null;
  speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(sentence.text);
  utterance.rate = Number(els.rateSlider.value) || 1;
  const chosen = state.voices.find(v => v.name === els.voiceSelect.value);
  if (chosen) utterance.voice = chosen;

  utterance.onend = () => {
    // Only advance if this utterance is still the active one.
    if (state.utterance === utterance && state.isPlaying) {
      speakSentence(state.currentSentence + 1);
    }
  };
  utterance.onerror = (e) => {
    // "interrupted"/"canceled" are normal when the user pauses or skips.
    if (e.error === "interrupted" || e.error === "canceled") return;
    console.error("Speech error:", e.error);
    showError("Speech stopped unexpectedly. Press play to continue.");
    setPlayingUI(false);
  };

  state.utterance = utterance;
  speechSynthesis.speak(utterance);
}

function playOrResume() {
  if (!speechSupported || !state.sentences.length) return;
  hideError();
  setPlayingUI(true);
  const index = state.currentSentence >= 0 ? state.currentSentence : 0;
  speakSentence(index);
}

function pauseReading() {
  setPlayingUI(false);
  state.utterance = null;
  speechSynthesis.cancel();   // position is kept in state.currentSentence
}

function stopReading(finished = false) {
  setPlayingUI(false);
  state.utterance = null;
  if (speechSupported) speechSynthesis.cancel();
  clearHighlight();
  state.currentSentence = finished ? state.sentences.length - 1 : 0;
  if (state.sentences.length) previewSentence(state.currentSentence);
  if (finished) els.nowReading.textContent = "Finished reading. Press play to start over.";
  if (finished) state.currentSentence = 0;
}

function skipTo(index) {
  const clamped = Math.min(Math.max(0, index), state.sentences.length - 1);
  state.currentSentence = clamped;
  if (state.isPlaying) {
    speakSentence(clamped);
  } else {
    previewSentence(clamped);
    highlightSentence(clamped);
  }
}

els.playPauseBtn.addEventListener("click", () => {
  state.isPlaying ? pauseReading() : playOrResume();
});
els.stopBtn.addEventListener("click", () => stopReading());
els.prevBtn.addEventListener("click", () => skipTo(state.currentSentence - 1));
els.nextBtn.addEventListener("click", () => skipTo(state.currentSentence + 1));

/* Speed changes apply from the next sentence; if reading now,
   restart the current sentence so the change is heard right away. */
els.rateSlider.addEventListener("input", () => {
  els.rateValue.textContent = `${Number(els.rateSlider.value).toFixed(1)}×`;
});
els.rateSlider.addEventListener("change", () => {
  if (state.isPlaying) speakSentence(state.currentSentence);
});
els.voiceSelect.addEventListener("change", () => {
  if (state.isPlaying) speakSentence(state.currentSentence);
});

/* ============================================================
   Keyboard shortcuts (ignored while typing in a field)
   ============================================================ */

document.addEventListener("keydown", (e) => {
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if (els.controlBar.hidden) return;

  if (e.key === " ") {
    e.preventDefault();
    state.isPlaying ? pauseReading() : playOrResume();
  } else if (e.key === "ArrowLeft") {
    skipTo(state.currentSentence - 1);
  } else if (e.key === "ArrowRight") {
    skipTo(state.currentSentence + 1);
  }
});

/* Stop speech if the tab is closed or reloaded so it doesn't
   keep talking into the void. */
window.addEventListener("beforeunload", () => {
  if (speechSupported) speechSynthesis.cancel();
});
