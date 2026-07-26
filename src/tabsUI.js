import { state } from './appState.js';
import { $, applyBand, toast } from './ui.js';
import { setFollowing } from './followController.js';
import { pauseAutoScrollUI } from './autoScrollUI.js';

// Switches which top-level tracking-mode panel is visible (Eye/Wink vs.
// Tempo/auto-scroll), and stops the mode being left.
//
// This used to be a pure visibility toggle, on the reasoning that the start
// buttons already paused each other. They do, but only at the moment you
// press start -- so switching tabs while a mode was running left it running,
// scrolling the page from a panel the user was no longer looking at, with
// its settings no longer on screen to explain why. Picking a tab is an
// explicit choice of mode, so it stops the other one.
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
  // Guarded on actually-running rather than done unconditionally, so this
  // is a no-op on first load (initTabsUI selects a tab before either mode
  // could possibly be going) and so switching tabs while idle stays silent.
  if (activeBtnId !== 'tabTracking' && state.following) {
    setFollowing(false);
    toast('Follow eyes stopped — switched to Tempo');
  }
  if (activeBtnId !== 'tabAutoScroll' && state.autoScroll.playing) {
    pauseAutoScrollUI();
    toast('Auto-scroll paused — switched to Eye/Wink');
  }
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
