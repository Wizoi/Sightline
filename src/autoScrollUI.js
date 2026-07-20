import { state } from './appState.js';
import { $, toast, setStatus } from './ui.js';
import { analyzeScore } from './scoreAnalysis.js';
import { startAutoScroll, pauseAutoScroll, stopAutoScroll, currentTempoLabel } from './autoScrollController.js';
import { startLiveTempo, stopLiveTempo } from './liveTempo.js';

export function initAutoScrollUI() {
  $('beatsPerMeasure').addEventListener('input', () => {
    state.autoScroll.beatsPerMeasure = parseInt($('beatsPerMeasure').value, 10);
    $('beatsPerMeasureV').textContent = $('beatsPerMeasure').value;
  });
  $('beatsPerMeasureV').textContent = $('beatsPerMeasure').value;

  $('bpmInput').addEventListener('input', () => {
    state.autoScroll.bpm = parseInt($('bpmInput').value, 10);
    $('bpmV').textContent = $('bpmInput').value + ' bpm';
    refreshTempoLabel();
  });
  $('bpmV').textContent = $('bpmInput').value + ' bpm';

  $('tempoPct').addEventListener('input', () => {
    state.autoScroll.tempoPct = parseFloat($('tempoPct').value) / 100;
    $('tempoPctV').textContent = $('tempoPct').value + '%';
    refreshTempoLabel();
  });
  $('tempoPctV').textContent = $('tempoPct').value + '%';

  $('analyzeScoreBtn').onclick = () => {
    if (!state.pdfDoc) { toast('Load a PDF first'); return; }
    stopAutoScroll();
    $('autoScrollStart').disabled = true;
    $('autoScrollPause').disabled = true;
    const result = analyzeScore();
    renderSummary(result);
    $('autoScrollStart').disabled = !state.autoScroll.analyzed;
    toast(result.systemCount ? `Analyzed ${result.systemCount} systems` : 'No systems found');
  };

  $('autoScrollStart').onclick = () => {
    if (!startAutoScroll()) return;
    $('autoScrollStart').disabled = true;
    $('autoScrollPause').disabled = false;
    refreshTempoLabel();
  };
  $('autoScrollPause').onclick = () => {
    pauseAutoScroll();
    $('autoScrollStart').disabled = false;
    $('autoScrollPause').disabled = true;
    setStatus('', 'auto-scroll paused');
  };

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
}

function refreshTempoLabel() {
  $('tempoText').textContent = currentTempoLabel();
}

function renderSummary(result) {
  $('autoScrollSummary').textContent = result.systemCount
    ? `Found ${result.systemCount} systems.`
    : 'No systems found.';
  $('autoScrollWarnings').innerHTML = result.warnings.map((w) => '<li>' + w + '</li>').join('');
  renderMeasuresList();
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
