export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const createEmptySample = () => ({
  name: 'Empty',
  start: 0,
  end: 1,
  pitch: 0,
  gain: 1,
  loop: false,
  gate: false,
  reverse: false,
  audio: null
});
export const soundName = p => p.name.trim() || '名称未設定';
export function audioDuration(p){
  return p.audio ? p.audio.channels[0].length / p.audio.rate: 0
}
export function formatTime(seconds){
  if (seconds < 60)return seconds.toFixed(2) + ' s';
  return Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0')
}
export function formatPreciseTime(seconds){
  return seconds.toFixed(3) + ' s';
}
export function clipDuration(p){
  return audioDuration(p) * (p.end - p.start) / Math.pow(2, p.pitch / 12)
}
