// Translates followLogic.decide()'s generic (gaze-phrased) status into
// wink-phrased text for the HUD, without touching decide() itself — the
// underlying zone semantics (up/down/snap/idle) are identical, only the
// wording needs to change. Pure and unit-tested on its own so the mapping
// can be verified without a real camera/wink.
export function describeWinkStatus(status, zoneText) {
  switch (zoneText) {
    case 'up':
      return status.text === 'following'
        ? { cls: status.cls, text: 'left wink — scrolling up ↑' }
        : { cls: status.cls, text: 'wink detected — hold…' };
    case 'down':
      return status.text === 'following'
        ? { cls: status.cls, text: 'right wink — scrolling down ↓' }
        : { cls: status.cls, text: 'wink detected — hold…' };
    case 'snap':
      return { cls: status.cls, text: 'wink — jumping to next line…' };
    default:
      // '–' (no fresh point), 'off', or 'read' — no wink is currently held.
      // That's the normal resting state for wink tracking (most of the
      // time you're just reading, not winking), not an error condition.
      return { cls: '', text: 'watching for a wink' };
  }
}
