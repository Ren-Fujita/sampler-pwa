const waveCache = new WeakMap();

export function getWavePeaks(audio, width) {
  let sizes = waveCache.get(audio);
  if (!sizes){
    sizes = new Map();
    waveCache.set(audio, sizes);
  }
  if (sizes.has(width))return sizes.get(width);
  const length = audio.channels[0].length;
  const peaks = new Float32Array(width * 2);
  for (let x = 0; x < width; x++){
    let low = 0, high = 0;
    const start = Math.floor(x * length / width);
    const end = Math.min(length, Math.max(start + 1, Math.floor((x + 1) * length / width)));
    const skip = Math.max(1, Math.ceil((end - start) / 96));
    for (const channel of audio.channels){
      for (let index = start; index < end; index += skip){
        const value = channel[index] || 0;
        low = Math.min(low, value);
        high = Math.max(high, value);
      }
    }
    peaks[x * 2] = low;
    peaks[x * 2 + 1] = high;
  }
  // Retain at most two resolutions per sound: editor and header.
  if (sizes.size >= 2)sizes.delete(sizes.keys().next().value);
  sizes.set(width, peaks);
  return peaks;
}
export function drawWavePeaks(graphics, peaks, width, height, { start, end, activeColor, inactiveColor, pixelOffset = 0, level = 1 }) {
  const startPixel = start * width;
  const endPixel = end * width;
  const center = height / 2;
  const amplitude = height * .42 * level;
  // Each color needs one path, regardless of the file's length or the canvas width.
  for (const outside of [true, false]){
    graphics.beginPath();
    graphics.strokeStyle = outside ? inactiveColor : activeColor;
    for (let x = 0; x < width; x++){
      if ((x < startPixel || x > endPixel) !== outside)continue;
      graphics.moveTo(x + pixelOffset, center - peaks[x * 2 + 1] * amplitude);
      graphics.lineTo(x + pixelOffset, center - peaks[x * 2] * amplitude);
    }
    graphics.stroke();
  }
}
