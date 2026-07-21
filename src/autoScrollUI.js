import { state } from './appState.js';
import { $, toast, setStatus, syncAutoScrollButton } from './ui.js';
import { analyzeScore } from './scoreAnalysis.js';
import { startAutoScroll, pauseAutoScroll, stopAutoScroll, currentTempoLabel, rebuildScheduleLive } from './autoScrollController.js';
import { startLiveTempo, stopLiveTempo } from './liveTempo.js';
import { setFollowing } from './followController.js';

export function initAutoScrollUI() {
  $('beatsPerMeasure').addEventListener('input', () => {
    const v = parseInt($('beatsPerMeasure').value, 10);
    state.autoScroll.beatsPerMeasure = v;
    $('beatsPerMeasureV').textContent = $('beatsPerMeasure').value;
    // Keep the active section's own remembered value in sync, so switching
    // sections and back restores what was set for each one.
    const sec = state.autoScroll.sections[state.autoScroll.activeSectionIndex];
    if (sec) sec.beatsPerMeasure = v;
    rebuildScheduleLive();
  });
  $('beatsPerMeasureV').textContent = $('beatsPerMeasure').value;

  $('bpmInput').addEventListener('input', () => {
    const v = parseInt($('bpmInput').value, 10);
    state.autoScroll.bpm = v;
    $('bpmV').textContent = $('bpmInput').value + ' bpm';
    const sec = state.autoScroll.sections[state.autoScroll.activeSectionIndex];
    if (sec) sec.bpm = v;
    rebuildScheduleLive();
    refreshTempoLabel();
  });
  $('bpmV').textContent = $('bpmInput').value + ' bpm';

  $('tempoPct').addEventListener('input', () => {
    state.autoScroll.tempoPct = parseFloat($('tempoPct').value) / 100;
    $('tempoPctV').textContent = $('tempoPct').value + '%';
    refreshTempoLabel();
  });
  $('tempoPctV').textContent = $('tempoPct').value + '%';

  $('analyzeScoreBtn').onclick = async () => {
    if (!state.pdfDoc) { toast('Load a PDF first'); return; }
    stopAutoScroll();
    $('autoScrollStart').disabled = true; // force-disabled during the async analysis itself
    $('analyzeScoreBtn').disabled = true;
    let result;
    try {
      result = await analyzeScore();
    } finally {
      $('analyzeScoreBtn').disabled = false;
    }
    renderSummary(result);
    syncAutoScrollButton();
    toast(result.systemCount ? `Analyzed ${result.systemCount} systems` : 'No systems found');
  };

  // One button, toggling Start <-> Pause (same pattern as the Follow-eyes
  // button) -- its label/enabled state is kept in sync by
  // syncAutoScrollButton(), called from every place playback state changes.
  $('autoScrollStart').onclick = () => {
    if (state.autoScroll.playing) {
      pauseAutoScrollUI();
      setStatus('', 'auto-scroll paused');
      return;
    }
    if (!startAutoScroll()) return;
    // Eye/wink tracking and Auto-scroll are alternatives, not used
    // together — both drive window.scrollTo() on their own rAF loop.
    if (state.following) {
      setFollowing(false);
      toast('Follow eyes paused — switched to Auto-scroll');
    }
    refreshTempoLabel();
  };

  $('sectionsSelect').addEventListener('change', () => {
    selectSection(parseInt($('sectionsSelect').value, 10));
  });

  $('liveTempoToggle').onclick = async () => {
    const as = state.autoScroll;
    if (!as.liveTempoEnabled) {
      as.liveTempoEnabled = true;
      $('liveTempoToggle').classList.add('on');
      await startLiveTempo();
      // startLiveTempo() flips liveTempoEnabled back off itself if mic
      // access failed — reflect that back into the button state.
      if (!as.liveTempoEnabled) $('liveTempoToggle').classList.remove('on');
    } else {
      as.liveTempoEnabled = false;
      $('liveTempoToggle').classList.remove('on');
      stopLiveTempo();
    }
  };

  if (state.autoScroll.analyzed) renderSummary({ systemCount: state.autoScroll.systemBands.length, warnings: [] });
  syncAutoScrollButton();
}

// Pauses auto-scroll — a thin, named wrapper kept for the call site in
// main.js (switching to Follow eyes while auto-scroll is playing), which
// reads more clearly as "pause the UI" than "call the controller function
// directly." pauseAutoScroll() itself already keeps the Start/Pause button
// in sync (see ui.js's syncAutoScrollButton()).
export function pauseAutoScrollUI() {
  pauseAutoScroll();
}

function refreshTempoLabel() {
  $('tempoText').textContent = currentTempoLabel();
}

function renderSummary(result) {
  $('autoScrollSummary').textContent = result.systemCount
    ? `Found ${result.systemCount} systems.`
    : 'No systems found.';
  $('autoScrollWarnings').innerHTML = result.warnings.map((w) => '<li>' + w + '</li>').join('');

  // More than one section means this PDF is a full score plus individual
  // parts (or similar) -- see lib/scoreSections.js. A single section is by
  // far the common case (this app's core audience is single-staff band
  // parts), so the picker stays hidden and nothing about the UI changes.
  if (state.autoScroll.sections.length > 1) {
    $('sectionsBox').classList.remove('hidden');
    selectSection(0); // also renders the sections list + measures list
  } else {
    $('sectionsBox').classList.add('hidden');
    renderMeasuresList();
  }
}

// Swaps a section's own remembered systemBands/measuresPerSystem/tempo/
// time-signature into the live top-level state.autoScroll fields -- see
// appState.js's comment on `sections` for why this is a reference swap,
// not a copy: autoScrollController.js only ever reads the top-level
// fields, so nothing there needs to know sections exist.
function selectSection(idx) {
  const as = state.autoScroll;
  const sec = as.sections[idx];
  if (!sec) return;

  as.activeSectionIndex = idx;
  as.systemBands = sec.systemBands;
  as.measuresPerSystem = sec.measuresPerSystem;
  as.beatsPerMeasure = sec.beatsPerMeasure;
  as.bpm = sec.bpm;

  $('beatsPerMeasure').value = sec.beatsPerMeasure;
  $('beatsPerMeasureV').textContent = String(sec.beatsPerMeasure);
  $('bpmInput').value = sec.bpm;
  $('bpmV').textContent = sec.bpm + ' bpm';
  refreshTempoLabel();

  // the active range just changed -- any in-progress schedule is stale.
  // stopAutoScroll() also re-syncs the Start/Pause button, using the
  // measuresPerSystem/analyzed values already updated above.
  stopAutoScroll();

  renderSectionsList();
  renderMeasuresList();

  const first = sec.systemBands[0];
  if (first) window.scrollTo(0, Math.max(0, first.center - window.innerHeight / 2));
}

function renderSectionsList() {
  const as = state.autoScroll;
  const select = $('sectionsSelect');
  select.innerHTML = '';
  as.sections.forEach((sec, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `${sec.name} (${sec.systemBands.length} systems)`;
    select.appendChild(opt);
  });
  select.value = String(as.activeSectionIndex);

  const activeSec = as.sections[as.activeSectionIndex];
  $('sectionMeta').textContent = activeSec && activeSec.tempoMarking ? `Tempo marking detected: ${activeSec.tempoMarking}` : '';

  renderTimeSigSuggestion(activeSec);
}

// Best-effort time-signature suggestion (see timeSigDetection.js) --
// offered, never applied: shape-matched digits, not read text like the
// name/tempo above, so it needs the user's explicit confirmation before it
// touches anything.
function renderTimeSigSuggestion(sec) {
  const container = $('sectionTimeSigSuggestion');
  container.innerHTML = '';
  if (!sec || !sec.detectedTimeSig) return;
  const ts = sec.detectedTimeSig;
  const btn = document.createElement('button');
  btn.textContent = `🔍 Time signature: ${ts.beatsPerMeasure}/${ts.noteValue} detected — use this?`;
  btn.onclick = () => {
    sec.beatsPerMeasure = ts.beatsPerMeasure;
    const as = state.autoScroll;
    if (sec === as.sections[as.activeSectionIndex]) {
      as.beatsPerMeasure = ts.beatsPerMeasure;
      $('beatsPerMeasure').value = ts.beatsPerMeasure;
      $('beatsPerMeasureV').textContent = String(ts.beatsPerMeasure);
    }
    container.innerHTML = '';
  };
  container.appendChild(btn);
}

function renderMeasuresList() {
  const list = $('measuresList');
  list.innerHTML = '';
  state.autoScroll.measuresPerSystem.forEach((m, i) => {
    const row = document.createElement('div');
    row.className = 'measureRow';
    row.innerHTML = `<span>System ${i + 1}</span><input type="number" min="1" max="64" value="${m}" data-idx="${i}" />`;
    list.appendChild(row);
  });
  list.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('change', () => {
      const idx = parseInt(inp.dataset.idx, 10);
      const v = Math.max(1, parseInt(inp.value, 10) || 1);
      state.autoScroll.measuresPerSystem[idx] = v;
      inp.value = v;
    });
  });
}
