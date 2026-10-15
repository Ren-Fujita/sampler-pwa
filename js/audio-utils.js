export function createChain(context, destination, master){
  const input = context.createGain(),
  output = context.createGain(),
  volume = context.createGain(),
  limiter = context.createDynamicsCompressor();
  limiter.threshold.value = - 5;
  limiter.knee.value = 8;
  limiter.ratio.value = 8;
  limiter.attack.value = .003;
  limiter.release.value = .1;
  input.connect(output).connect(limiter).connect(volume).connect(destination);
  volume.gain.value = master;
  return {
    input,
    output,
    master: volume
  }
}
export function configurePlaybackSession(){
  try{
    const session = navigator.audioSession;
    if (session){
      if (session.type !== 'playback')session.type = 'playback';
      return session.type === 'playback'
    }
  }catch{
  }
  return false
}
