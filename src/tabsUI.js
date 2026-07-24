import { $, applyBand } from './ui.js';

// Switches which top-level tracking-mode panel is visible (Eye/Wink vs.
// Tempo/auto-scroll). Purely a visibility toggle -- it does not start,
// stop, or pause either mode; autoScrollUI.js/main.js already handle that
// mutual exclusion at the point the user actually starts one or the other.
const TABS = [
  { btn: 'tabTracking', panel: 'trackingPanel' },
  { btn: 'tabAutoScroll', panel: 'autoScrollPanel' },
];

function selectTab(activeBtnId) {
  TABS.forEach(({ btn, panel }) => {
    const active = btn === activeBtnId;
    $(btn).classList.toggle('active', active);
    $(btn).setAttribute('aria-selected', String(active));
    $(panel).classList.toggle('hidden', !active);
  });
  // The reading band is an Eye/Wink-tracking concept -- applyBand() itself
  // checks which tab is active, so just re-running it here keeps it in
  // sync the instant the user switches tabs, not just on the next
  // unrelated slider/setting change.
  applyBand();
}

export function initTabsUI() {
  TABS.forEach(({ btn }) => { $(btn).onclick = () => selectTab(btn); });
  // Eye/Wink is the default tracking type and what the README's quick start
  // leads with -- a first-time load should show that panel (and the reading
  // band), not Tempo/auto-scroll.
  selectTab('tabTracking');
}
