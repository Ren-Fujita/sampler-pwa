import { clamp } from './sample.js';

const DEFAULT_VOLUME = .75;
const MUTED_WAVES = 'M17 9l5 6m0-6-5 6';
const AUDIBLE_WAVES = 'M17 8c3 2 3 6 0 8m3-11c5 4 5 10 0 14';

// Audio and saving are synchronous callbacks here; the control adds no timer or ramp.
export function createMasterVolume({ getElements, applyGain, onChange }) {
  let value = DEFAULT_VOLUME;
  let lastAudibleValue = DEFAULT_VOLUME;

  function restore(next) {
    const level = Number(next);
    if (!Number.isFinite(level))return false;
    value = clamp(level, 0, 1);
    if (value > 0)lastAudibleValue = value;
    return true;
  }

  function applyToAudio() {
    applyGain(value);
  }

  function render() {
    const { input, output, mute, waves } = getElements();
    const percent = value * 100;
    const label = Math.round(percent) + '%';
    const muted = value === 0;
    // Keep fractional input and fill values; only visible/spoken text is rounded.
    input.value = percent;
    input.style.setProperty('--fill', percent + '%');
    input.setAttribute('aria-valuetext', label);
    output.textContent = label;
    mute.classList.toggle('muted', muted);
    mute.setAttribute('aria-pressed', String(muted));
    mute.setAttribute('aria-label', muted ? 'ミュートを解除' : 'ミュート');
    waves.setAttribute('d', muted ? MUTED_WAVES : AUDIBLE_WAVES);
  }

  function set(next) {
    if (!restore(next))return;
    applyToAudio();
    render();
    onChange();
  }

  function toggleMute() {
    set(value === 0 ? lastAudibleValue : 0);
  }

  function onKeyDown(event) {
    if (event.altKey || event.ctrlKey || event.metaKey)return;
    let percent = Math.round(value * 100);
    switch (event.key) {
      case 'ArrowUp': case 'ArrowRight': percent += 1; break;
      case 'ArrowDown': case 'ArrowLeft': percent -= 1; break;
      case 'PageUp': percent += 10; break;
      case 'PageDown': percent -= 10; break;
      case 'Home': percent = 0; break;
      case 'End': percent = 100; break;
      default: return;
    }
    event.preventDefault();
    set(percent / 100);
  }

  function bind() {
    const { input, mute } = getElements();
    input.oninput = event => set(Number(event.target.value) / 100);
    input.onkeydown = onKeyDown;
    mute.onclick = toggleMute;
  }

  return {
    get value() { return value; },
    set, toggleMute, render, bind, applyToAudio,
    // Restoring settings updates state only; callers control when audio/UI/save run.
    restore
  };
}
