import { STORAGE_VERSION, SLOT_COUNT, BANK_COUNT, PAD_COUNT } from './config.js';
import { clamp } from './sample.js';

export function createEmptyPatterns() {
  return Array.from({ length: BANK_COUNT }, () =>
    Array.from({ length: PAD_COUNT }, () => Array(16).fill(false)));
}

export function parseSessionSettings(s, fallbackPatterns = createEmptyPatterns()){
  if (!s || s.version !== STORAGE_VERSION || !Array.isArray(s.pads) || s.pads.length !== SLOT_COUNT)throw Error('このプロジェクト形式には対応していません。');
  const metadata = Array.from(s.pads, p => {
    if (!p || typeof p.name !== 'string')throw Error('パッド情報が壊れています。');
    const pad = {
      name: p.name.slice(0, 80),
      start: clamp(Number(p.start) || 0, 0, 1 - 1e-9),
      end: clamp(Number(p.end) || 1, 1e-9, 1),
      pitch: clamp(Number(p.pitch) || 0, - 24, 24),
      gain: clamp(Number(p.gain) || 0, 0, 1.5),
      loop: !!p.loop,
      gate: !!p.gate,
      reverse: false
    };
    if (pad.end <= pad.start)pad.end = Math.min(1, pad.start + .001);
    return pad;
  });
  return {
    version: STORAGE_VERSION,
    pads: metadata,
    bank: clamp(Math.trunc(Number(s.bank) || 0), 0, BANK_COUNT - 1),
    selected: clamp(Math.trunc(Number(s.selected) || 0), 0, PAD_COUNT - 1),
    tempo: clamp(Number(s.tempo) || 90, 40, 240),
    swing: clamp(Number(s.swing) || 0, 0, 60),
    master: clamp(Number(s.master) || 0, 0, 1),
    showPlaybackWaveform: typeof s.showPlaybackWaveform === 'boolean' ? s.showPlaybackWaveform : true,
    fx: 'off',
    fxValues: Array.isArray(s.fxValues) && s.fxValues.length === 3 ? s.fxValues.map(v => clamp(Number(v) || 0, 0, 1)) : [.65, .2, .6],
    patterns: Array.isArray(s.patterns) && s.patterns.length === BANK_COUNT ? s.patterns.map(b =>
      Array.from({ length: PAD_COUNT }, (_, p) => Array.from({ length: 16 }, (_, n) => !!b?.[p]?.[n]))) : fallbackPatterns
  };
}
