import { createEmptySample } from './sample.js';

export function synth(index){
  const rate = 44100,
  durations = [.55,
  .36,
  .12,
  .55,
  .2,
  .55,
  .3,
  .22,
  .8,
  1.7,
  1.3,
  .85];
  const names = ['Kick / warm',
  'Snare / dusty',
  'Hi-hat / closed',
  'Hi-hat / open',
  'Rim / dry',
  'Tom / low',
  'Clap / room',
  'Shaker / tight',
  'Bass / C',
  'Chord / minor',
  'Keys / soft',
  'Bell / glass'];
  let seed = 374 + index * 129;
  const noise = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223)>>>0;
    return seed / 2147483648 - 1
  };
  const data = new Float32Array(Math.ceil(rate * durations[index]));
  let phase = 0,
  last = 0;
  for (let i = 0; i < data.length; i++){
    const t = i / rate,
    n = noise();
    let v = 0;
    if (index === 0){
      phase += 2 * Math.PI * (47 + 105 * Math.exp( - t * 32)) / rate;
      v = .8 * Math.sin(phase) * Math.exp( - t * 9) + n * .18 * Math.exp( - t * 140)
    } else if (index === 1)v = (n * .6 + Math.sin(2 * Math.PI * 180 * t) * .24) * Math.exp( - t * 14);
    else if (index === 2 || index === 3){
      const hp = n - last;
      last = n;
      v = hp * .3 * Math.exp( - t * (index === 2 ? 45: 9))
    } else if (index === 4)v = (Math.sin(2 * Math.PI * 1050 * t) + Math.sin(2 * Math.PI * 1750 * t)) * .3 * Math.exp( - t * 40);
    else if (index === 5){
      phase += 2 * Math.PI * (95 + 110 * Math.exp( - t * 30)) / rate;
      v = Math.sin(phase) * .6 * Math.exp( - t * 10)
    } else if (index === 6){
      const env = Math.exp( - t * 15) * (t < .06 ? (.35 + .65 * Math.pow(Math.sin(t * 200), 2)): 1);
      v = n * .55 * env
    } else if (index === 7){
      const hp = n - last;
      last = n;
      v = hp * .25 * Math.exp( - t * 25) * Math.min(1, t * 140)
    } else if (index === 8)v = (Math.sin(2 * Math.PI * 65.406 * t) + .25 * Math.sin(2 * Math.PI * 130.812 * t)) * .55 * Math.exp( - t * 4);
    else if (index === 9)v = [130.812,
    155.563,
    195.998].reduce((a, f) => a + Math.sin(2 * Math.PI * f * t) + .2 * Math.sin(2 * Math.PI * f * 2 * t), 0) * .15 * Math.exp( - t * 2.7) * Math.min(1, t * 30);
    else if (index === 10)v = (Math.sin(2 * Math.PI * 261.626 * t) + .3 * Math.sin(2 * Math.PI * 523.252 * t)) * .5 * Math.exp( - t * 4);
    else v = (Math.sin(2 * Math.PI * 783.991 * t) + .4 * Math.sin(2 * Math.PI * 1967 * t)) * .4 * Math.exp( - t * 5);
    data[i] = v * Math.min(1, i / 80) * Math.min(1, (data.length - i) / 150);
  }
  return {
    ...createEmptySample(),
    name: names[index],
    audio: {
      rate,
      channels: [data]
    }
  };
}
