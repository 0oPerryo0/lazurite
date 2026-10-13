/** Local synthesized preview clicks, not recovered game audio or scoring. */
export class HitSoundPlayer {
  constructor({contextFactory}={}) {
    this.factory=contextFactory||(()=>{const C=globalThis.AudioContext||globalThis.webkitAudioContext;return C?new C():null;});
    this.context=null;this.enabled=true;this.volume=0.7;this.times=[];this.index=0;this.last=null;this.voices=new Set();this.count=0;
  }
  setChart(chart){this.times=(chart?.notes||[]).map(n=>Number(n.points?.[0]?.time)).filter(Number.isFinite).sort((a,b)=>a-b);this.reset(0);}
  reset(time){this.stop();this.last=Number(time)||0;let lo=0,hi=this.times.length;while(lo<hi){const m=(lo+hi)>>1;if(this.times[m]<=this.last)lo=m+1;else hi=m;}this.index=lo;}
  unlock(){try{this.context??=this.factory();const promise=this.context?.resume();promise?.catch(()=>{});}catch{/* Audio unavailable: viewer still works. */}}
  stop(){for(const voice of this.voices){try{voice.stop();}catch{}}this.voices.clear();}
  update(time,playing,rate=1){
    if(!Number.isFinite(time))return 0;
    if(this.last===null||!playing||time<this.last||time-this.last>Math.max(0.5,rate*0.25)){this.reset(time);return 0;}
    let hits=0;while(this.index<this.times.length&&this.times[this.index]<=time){this.index++;hits++;}
    this.last=time;
    // Coincident notes use a single normalized click, avoiding clipping from large chords.
    if(hits&&this.enabled&&this.volume>0)this.tap(hits);
    return hits;
  }
  tap(hits=1){
    const ctx=this.context;if(!ctx||ctx.state!=='running')return;
    const oscillator=ctx.createOscillator(),gain=ctx.createGain(),now=ctx.currentTime;
    oscillator.type='triangle';oscillator.frequency.setValueAtTime(1600,now);oscillator.frequency.exponentialRampToValueAtTime(650,now+0.028);
    gain.gain.setValueAtTime(Math.min(0.3,0.16*Math.sqrt(hits))*this.volume,now);gain.gain.exponentialRampToValueAtTime(0.0001,now+0.035);
    oscillator.connect(gain);gain.connect(ctx.destination);this.voices.add(oscillator);this.count+=hits;
    oscillator.onended=()=>{this.voices.delete(oscillator);oscillator.disconnect();gain.disconnect();};oscillator.start(now);oscillator.stop(now+0.04);
  }
}
