import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const profile=await mkdtemp(path.join(tmpdir(),'crystallium-viewer-check-'));
const browser=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=9228','--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
let socket;
try{
let tabs;for(let i=0;i<60;i++){try{tabs=await(await fetch('http://127.0.0.1:9228/json')).json();break;}catch{await new Promise(r=>setTimeout(r,100));}}
if(!tabs)throw new Error('Headless browser did not start');
socket=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true});});
let id=0;const pending=new Map(),errors=[];socket.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p?.reject(m.error):p?.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);if(m.method==='Log.entryAdded'&&m.params.entry.level==='error')errors.push(m.params.entry);});
const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});socket.send(JSON.stringify({id:n,method,params}));});
const evaluate=async expression=>{const result=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result?.value;};
 const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const waitFor=async(expression,label,timeout=12000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await evaluate(expression))return;await delay(80);}throw new Error('Timed out: '+label);};
 const visible=selector=>`(()=>{const el=document.querySelector(${JSON.stringify(selector)});return !!el&&!el.hidden&&el.getBoundingClientRect().width>0&&el.getBoundingClientRect().height>0;})()`;
 const screenshot=async name=>{const image=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});await writeFile(new URL('./'+name,import.meta.url),Buffer.from(image.data,'base64'));};
 const navigateFresh=async url=>{await call('Page.navigate',{url:'about:blank'});await waitFor("location.href==='about:blank'",'fresh document reset');await call('Page.navigate',{url});};
 const route=(song,difficulty)=>'#/chart/'+encodeURIComponent(song.id)+'/'+difficulty.id;
 const selectionReady=async()=>waitFor(`${visible('#catalog-view')} && document.querySelectorAll('a.catalog-difficulty').length===63`,'selection ready');
 const search=async value=>evaluate(`{const el=document.getElementById('search');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input'));}`);
 const clickDifficulty=async(song,difficulty)=>evaluate(`{const link=document.querySelector(${JSON.stringify('a.catalog-difficulty[data-song-id="'+song.id+'"][data-difficulty-id="'+difficulty.id+'"]')});link.focus();link.click();}`);
 const chartReady=async(song,difficulty)=>waitFor(`${visible('#viewer-view')} && document.querySelector('#title').textContent===${JSON.stringify(song.title)} && Number(document.querySelector('#note-count').textContent.replaceAll(',',''))===${difficulty.noteCount} && document.querySelector('#play').disabled===${difficulty.noteCount===0} && [...document.querySelectorAll('#difficulties [aria-current="true"]')].some(el=>el.textContent.includes(${JSON.stringify(difficulty.name)}))`,'chart ready '+song.title+' '+difficulty.name);
 const backToSongs=async()=>{await evaluate("document.querySelector('#back-to-songs').click()");await waitFor(visible('#catalog-view'),'back to songs');await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');assert.equal(await evaluate(visible('#viewer-view')),false);};
await call('Runtime.enable');await call('Log.enable');await call('Page.enable');
await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
const requests=[];socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.method==='Network.requestWillBeSent')requests.push(message.params.request.url);});await call('Network.enable');
await call('Page.addScriptToEvaluateOnNewDocument',{source:`
  window.__clickCount=0;window.__mediaEvents={loads:0,plays:0,pauses:0};window.__media=[];
  const create=document.createElement.bind(document);document.createElement=function(tag,...args){const el=create(tag,...args);if(String(tag).toLowerCase()==='audio')window.__media.push(el);return el;};
  for(const [method,key] of [['load','loads'],['play','plays'],['pause','pauses']]){const original=HTMLMediaElement.prototype[method];HTMLMediaElement.prototype[method]=function(...args){window.__mediaEvents[key]++;return original.apply(this,args);};}
  const original=AudioContext.prototype.createOscillator;AudioContext.prototype.createOscillator=function(...args){window.__clickCount++;return original.apply(this,args);};
`});
const library=await(await fetch('http://127.0.0.1:4174/api/library')).json();
const luxe=library.charts.find(s=>s.id.startsWith('Luxe_Chain')),defaultLuxe=luxe.difficulties.find(d=>d.noteCount>0),bloodlust=luxe.difficulties.find(d=>d.id===3),herm=library.charts.find(s=>s.title.includes('Herm')),emptyHerm=herm.difficulties.find(d=>d.noteCount===0),lunarHerm=herm.difficulties.find(d=>d.noteCount>0);
assert.equal(library.charts.length,21);assert.equal(library.charts.reduce((sum,s)=>sum+s.difficulties.length,0),63);assert.equal(bloodlust.noteCount,1674);
await call('Page.navigate',{url:'http://127.0.0.1:4174/'});await selectionReady();await delay(250);
const selection=await evaluate(`({rows:document.querySelectorAll('#song-list > tr.song-row').length,difficulties:document.querySelectorAll('a.catalog-difficulty').length,enabled:[...document.querySelectorAll('a.catalog-difficulty')].every(el=>!el.matches('[aria-disabled="true"], [disabled]')),viewerHidden:!(${visible('#viewer-view')}),inspectorButtonHidden:!(${visible('#inspect-toggle')}),overflow:document.documentElement.scrollWidth>innerWidth,media:window.__mediaEvents,clicks:window.__clickCount})`);
console.log('INITIAL SELECTION',selection);assert.equal(selection.rows,21);assert.equal(selection.difficulties,63);assert.equal(selection.enabled,true);assert.equal(selection.viewerHidden,true);assert.equal(selection.inspectorButtonHidden,true);assert.equal(selection.overflow,false);assert.equal(selection.media.loads,0,'Selection must not load audio');assert.equal(selection.media.plays,0,'Selection must not autoplay');assert.equal(selection.clicks,0);assert.equal(requests.some(url=>/\/api\/(chart|audio)\//.test(url)),false,'Selection must not request chart/audio payloads');
const entries=await evaluate("[...document.querySelectorAll('a.catalog-difficulty')].map(el=>({song:el.dataset.songId,difficulty:Number(el.dataset.difficultyId),href:el.getAttribute('href')}))");
assert.deepEqual(entries.map(e=>e.song+':'+e.difficulty).sort(),library.charts.flatMap(s=>s.difficulties.map(d=>s.id+':'+d.id)).sort(),'All records, including actual Eclipse difficulties, need one available link');for(const e of entries)assert.equal(e.href,route({id:e.song},{id:e.difficulty}));
await screenshot('selection-desktop.png');
await search('Luxe');assert.equal(await evaluate("document.querySelectorAll('#song-list > tr.song-row').length"),1);assert.equal(await evaluate("document.querySelectorAll('a.catalog-difficulty').length"),4);
await search('__no_chart_matches_621__');assert.equal(await evaluate("document.querySelectorAll('a.catalog-difficulty').length"),0);assert.equal(await evaluate(visible('#no-results')),true);
await evaluate("document.querySelector('#clear-search').click()");await selectionReady();assert.equal(await evaluate("document.querySelector('#search').value"),'');
await search('');await evaluate('window.scrollTo(0,700)');const catalogScroll=await evaluate('scrollY');assert.ok(catalogScroll>0,'Catalog scroll fixture must be scrolled');await clickDifficulty(luxe,bloodlust);await chartReady(luxe,bloodlust);assert.equal(await evaluate('scrollY'),0,'Opening from scrolled catalog must reveal viewer heading');await backToSongs();assert.equal(await evaluate('scrollY'),catalogScroll,'Back must restore catalog scroll position');
await search('Luxe');await clickDifficulty(luxe,bloodlust);await chartReady(luxe,bloodlust);assert.equal(await evaluate('location.hash'),route(luxe,bloodlust));assert.equal(await evaluate(visible('#catalog-view')),false);assert.equal(await evaluate("!!document.querySelector('#viewer-view .library')"),false,'Viewer must have no left library');assert.equal(await evaluate(visible('#inspector')),true);
await evaluate("document.querySelector('#seek').value='15';document.querySelector('#seek').dispatchEvent(new Event('input'));document.querySelector('#play').click()");await delay(900);assert.ok(await evaluate('window.__clickCount')>0);await backToSongs();
const stopped=await evaluate("({time:document.querySelector('#time').textContent,clicks:window.__clickCount,plays:window.__mediaEvents.plays,paused:window.__media.every(el=>el.paused),search:document.querySelector('#search').value,focusInCatalog:!!document.activeElement.closest('#catalog-view')})");await delay(700);assert.equal(stopped.search,'Luxe');assert.equal(stopped.paused,true,'Back must pause music');assert.equal(stopped.focusInCatalog,true,'Back must focus visible catalog content');assert.equal(await evaluate("document.querySelector('#time').textContent"),stopped.time,'Back must freeze time');assert.equal(await evaluate('window.__clickCount'),stopped.clicks,'Back must stop clicks');assert.equal(await evaluate('window.__mediaEvents.plays'),stopped.plays);
await evaluate('history.back()');await chartReady(luxe,bloodlust);assert.equal(await evaluate('location.hash'),route(luxe,bloodlust));assert.equal(await evaluate("document.querySelector('#play').getAttribute('aria-label')"),'Play chart');await evaluate('history.forward()');await waitFor(visible('#catalog-view'),'history forward catalog');assert.equal(await evaluate("document.querySelector('#search').value"),'Luxe');
await navigateFresh('http://127.0.0.1:4174/'+route(luxe,bloodlust));await chartReady(luxe,bloodlust);assert.equal(await evaluate('window.__mediaEvents.plays'),0,'Deep link must not autoplay');
for(const hash of ['#/chart/not-a-song/0',route(luxe,{id:99}),'#/chart/%E0%A4%A/0','#/not-a-route']){await navigateFresh('http://127.0.0.1:4174/'+hash);await selectionReady();assert.equal(await evaluate('location.hash'),'#songs');assert.equal(await evaluate('window.__mediaEvents.loads'),0);assert.equal(await evaluate('window.__mediaEvents.plays'),0);assert.ok(await evaluate("document.querySelector('#catalog-message').textContent.length>0"),'Invalid route must explain fallback');}
// A legacy/malformed history entry fires both popstate and hashchange. The normalized
// #songs route must retain its explanatory message after both events have settled.
await clickDifficulty(luxe,bloodlust);await chartReady(luxe,bloodlust);await evaluate("history.pushState(null,'','#/chart/not-a-history-song/3');history.pushState(null,'','#songs');dispatchEvent(new PopStateEvent('popstate'))");await waitFor(visible('#catalog-view'),'history fixture catalog');await evaluate('history.back()');await waitFor("location.hash==='#songs' && document.querySelector('#catalog-message').textContent.length>0",'invalid history normalization');await delay(250);assert.equal(await evaluate(visible('#catalog-message')),true,'Invalid history message must survive popstate + hashchange');assert.equal(await evaluate('window.__media.every(el=>el.paused)'),true);
console.log('EXACT DIFFICULTY / BACK / HISTORY / INVALID DEEP LINKS passed');
// ---------------------------------------------------------------------------------------
// Settings screen: catalog entry, storage fallback, pause-without-resume, and park/return.
// ---------------------------------------------------------------------------------------
const isVisible=async selector=>evaluate(visible(selector));
const renderCalls=async()=>evaluate('window.__renderCalls||0');
await evaluate("localStorage.removeItem('crystallium.settings.v1')");
const checkboxId='show-overlapping-slides';
const checkboxValue=async()=>evaluate("document.getElementById("+JSON.stringify(checkboxId)+").checked");
await search('');await evaluate('window.scrollTo(0,0)');await waitFor(visible('#settings-link'),'catalog settings link');
assert.equal(await isVisible('#settings-link'),true);
assert.equal(await isVisible('#settings-link-viewer'),false,'the catalog must not expose the viewer settings link');
await evaluate("document.querySelector('#settings-link').click()");
await waitFor(visible('#settings-view'),'settings screen from catalog');
assert.equal(await evaluate('location.hash'),'#settings');
assert.equal(await evaluate("document.querySelector('#settings-title').textContent"),'Settings');
assert.equal(await evaluate("document.querySelector('#settings-origin').textContent"),'Back returns to the catalog.');
// showSettings focuses the heading inside a requestAnimationFrame.
await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
assert.equal(await evaluate("document.activeElement.id"),'settings-title','the settings heading must take focus');
assert.equal(await isVisible('#catalog-view'),false);assert.equal(await isVisible('#viewer-view'),false);
assert.equal(await checkboxValue(),false,'a fresh browser must show the preference unchecked');
assert.equal(await evaluate("localStorage.getItem('crystallium.settings.v1')"),null,'an untouched preference must not be written');
await evaluate("document.querySelector('#show-overlapping-slides').click()");
assert.equal(await checkboxValue(),true);assert.equal(await evaluate("localStorage.getItem('crystallium.settings.v1')"),'{"showOverlappingSlides":true}');
await evaluate("document.querySelector('#show-overlapping-slides').click()");
assert.equal(await checkboxValue(),false);assert.equal(await evaluate("localStorage.getItem('crystallium.settings.v1')"),'{"showOverlappingSlides":false}');
await screenshot('settings-desktop.png');
await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await delay(250);
const settingsMobile=await evaluate("({overflow:document.documentElement.scrollWidth>innerWidth,checkboxVisible:(()=>{const r=document.getElementById('show-overlapping-slides').getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth;})()})");
assert.equal(settingsMobile.overflow,false);assert.equal(settingsMobile.checkboxVisible,true);
await screenshot('settings-mobile.png');
await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await delay(250);
await evaluate("document.querySelector('#settings-back').click()");
await waitFor(visible('#catalog-view'),'back to catalog from settings');
assert.equal(await evaluate('location.hash'),'#songs');assert.equal(await isVisible('#settings-view'),false);
// The catalog return restores focus and scroll inside a requestAnimationFrame, so settle one
// frame before reading the active element.
await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
assert.equal(await evaluate("document.activeElement===document.querySelector('#settings-link')"),true,'Back must return focus to the opening control');
const settingsReloads=[['not json',false],['{"showOverlappingSlides":"true"}',false],['null',false],['{"showOverlappingSlides":true}',true]];
for(const [raw,expected] of settingsReloads){
  await evaluate(`localStorage.setItem('crystallium.settings.v1',${JSON.stringify(raw)})`);
  await navigateFresh('http://127.0.0.1:4174/#settings');
  await waitFor(visible('#settings-view'),'reloaded settings screen');
  assert.equal(await checkboxValue(),expected,'reloaded checkbox for stored '+JSON.stringify(raw));
  assert.equal(await evaluate("document.querySelector('#settings-title').textContent"),'Settings');
  assert.equal(await evaluate('location.hash'),'#settings');
}
await evaluate("localStorage.setItem('crystallium.settings.v1','not json')");
await navigateFresh('http://127.0.0.1:4174/#settings');
await waitFor(visible('#settings-view'),'malformed storage settings reload');
assert.equal(await checkboxValue(),false,'malformed storage must read as unchecked, not truthy');
await evaluate("document.querySelector('#settings-back').click()");
await waitFor(visible('#catalog-view'),'malformed settings back to catalog');
assert.equal(await evaluate('location.hash'),'#songs');assert.equal(await checkboxValue(),false);
assert.equal(await evaluate('window.__mediaEvents.loads'),0,'the settings screen must never load audio');
assert.equal(await evaluate('window.__mediaEvents.plays'),0,'the settings screen must never autoplay');
console.log('SETTINGS ENTRY / STORAGE FALLBACK / MOBILE LAYOUT passed',JSON.stringify(settingsMobile));
// Viewing Settings parks the chart: the viewer stops (frame loop, rendering, clicks and viewer
// shortcuts all inactive), the session survives, and Back restores the exact route and every
// control (time, volumes, rate, scroll) with playback still paused. Playback is primed once so
// "must not resume" is a real check rather than a trivially-paused viewer.
await search('Luxe');await clickDifficulty(luxe,bloodlust);await chartReady(luxe,bloodlust);
// Wrap the class renderer's render() method (same instance the app drives) so every forwarded
// render option is observable without touching app or renderer code.
await evaluate(`(async()=>{const {PlayfieldRenderer}=await import('./renderer.js');const proto=PlayfieldRenderer.prototype;if(window.__renderWrapped)return;window.__renderOriginal=proto.render;window.__renderCalls=0;window.__lastRenderOptions=null;proto.render=function(time,options){window.__renderCalls++;window.__lastRenderOptions=options||null;return window.__renderOriginal.call(this,time,options);};window.__renderWrapped=true;})()`);
const framesBeforeControls=await renderCalls();
await evaluate("document.querySelector('#seek').value='15';document.querySelector('#seek').dispatchEvent(new Event('input'));document.querySelector('#rate').value='1.5';document.querySelector('#rate').dispatchEvent(new Event('change'));document.querySelector('#music-volume').value='0.42';document.querySelector('#music-volume').dispatchEvent(new Event('input'));document.querySelector('#hit-volume').value='0.66';document.querySelector('#hit-volume').dispatchEvent(new Event('input'));document.querySelector('#scroll').value='1.4';document.querySelector('#scroll').dispatchEvent(new Event('input'));");
// Read a frame rendered AFTER the control changes: waiting for the scroll value to appear in a
// forwarded frame proves the options belong to the post-change frame, not a stale one.
await waitFor('window.__lastRenderOptions && window.__lastRenderOptions.scrollSpeed===1.4','frame forwarded after the control changes');
const forwarded=await evaluate('({...window.__lastRenderOptions})');
assert.equal(forwarded.showOverlappingSlides,false,'the default preference must be forwarded to the renderer');
assert.equal(forwarded.scrollSpeed,1.4,'every frame must forward the current scroll multiplier');
assert.equal(forwarded.overlays,true,'every frame must forward the overlay toggle');
const playsBaseline=await evaluate('window.__mediaEvents.plays');
await evaluate("document.querySelector('#play').click()");
await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
assert.equal(await evaluate("document.querySelector('#play').getAttribute('aria-label')"),'Pause chart','the primed viewer must actually be playing');
// CASE 1 — Settings entered while the chart is PLAYING: the visit itself must stop the music, and
// the return must never auto-resume it, even though the parked session was playing.
const primed=await evaluate("({time:document.querySelector('#time').textContent,seek:document.querySelector('#seek').value,rate:document.querySelector('#rate').value,music:document.querySelector('#music-volume').value,hits:document.querySelector('#hit-volume').value,scroll:document.querySelector('#scroll').value})");
await waitFor(visible('#settings-link-viewer'),'viewer settings link');
await evaluate("document.querySelector('#settings-link-viewer').click()");
await waitFor(visible('#settings-view'),'settings screen from viewer');
const clockAtOpen=await evaluate("(()=>{const m=window.__media[0];return {printed:document.querySelector('#time').textContent,seek:Number(document.querySelector('#seek').value),mediaTime:m?Math.round(m.currentTime*1000)/1000:null,mediaPaused:m?m.paused:null};})()");
assert.equal(await evaluate('location.hash'),'#settings');
assert.equal(await evaluate("document.querySelector('#settings-origin').textContent"),'Back returns to the chart you opened; it stays paused.');
assert.equal(await isVisible('#viewer-view'),false,'settings must hide the viewer');
await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
assert.equal(await evaluate("document.activeElement.id"),'settings-title');
assert.equal(await evaluate('window.__media.every(el=>el.paused)'),true,'entering settings must pause music');
const frozenTime=await evaluate("document.querySelector('#time').textContent");
const renderCallsWhileSettings=await renderCalls();
const clicksAtSettingsOpen=await evaluate('window.__clickCount');
const playsAtSettingsOpen=await evaluate('window.__mediaEvents.plays');
await delay(600);
assert.equal(await evaluate("document.querySelector('#time').textContent"),frozenTime,'settings must freeze the parked clock');
assert.equal(await renderCalls(),renderCallsWhileSettings,'settings must skip renderer frames');
const afterWait=await evaluate("({plays:window.__mediaEvents.plays,clicks:window.__clickCount,time:document.querySelector('#time').textContent})");
assert.equal(afterWait.plays,playsAtSettingsOpen,'settings must not start another playback (was '+playsAtSettingsOpen+', now '+JSON.stringify(afterWait)+')');
await evaluate("document.querySelector('#playfield').dispatchEvent(new MouseEvent('click',{bubbles:true}));document.dispatchEvent(new KeyboardEvent('keydown',{code:'Space',key:' ',bubbles:true,cancelable:true}));document.dispatchEvent(new KeyboardEvent('keydown',{code:'ArrowRight',key:'ArrowRight',bubbles:true,cancelable:true}));");
await delay(200);
assert.equal(await evaluate('window.__mediaEvents.plays'),playsAtSettingsOpen,'viewer controls and shortcuts must be inert while settings is open');
assert.equal(await evaluate("document.querySelector('#time').textContent"),frozenTime,'viewer shortcuts must not move the parked clock');
assert.equal(await evaluate('window.__clickCount'),clicksAtSettingsOpen,'settings must not synthesize judgement clicks');
await evaluate("document.querySelector('#show-overlapping-slides').click()");
assert.equal(await evaluate("localStorage.getItem('crystallium.settings.v1')"),'{"showOverlappingSlides":true}','the change handler must persist the checked value');
await evaluate("document.querySelector('#settings-back').click()");
await chartReady(luxe,bloodlust);
const afterBackAudio=await evaluate("({audioStatus:document.querySelector('#audio-status').textContent,mediaPlays:window.__mediaEvents.plays,mediaPauses:window.__mediaEvents.pauses,mediaLoads:window.__mediaEvents.loads,label:document.querySelector('#play').getAttribute('aria-label'),pausedAll:window.__media.every(el=>el.paused),time:document.querySelector('#time').textContent})");
console.log('RETURN FROM SETTINGS AUDIO',JSON.stringify({playsAtSettingsOpen,clockAtOpen,afterBackAudio}));
assert.equal(await evaluate('location.hash'),route(luxe,bloodlust),'Back must restore the exact chart route');
// The frame loop stops while Settings is open, so the play label must be measured one frame after
// the return, when the resumed viewer has had a chance to repaint it.
await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
const afterBackFrame=await evaluate("({label:document.querySelector('#play').getAttribute('aria-label'),pausedAll:window.__media.every(el=>el.paused),mediaPlays:window.__mediaEvents.plays,time:document.querySelector('#time').textContent})");
console.log('RETURN FROM SETTINGS AFTER FRAME',JSON.stringify(afterBackFrame));
assert.equal(afterBackFrame.pausedAll,true,'returning from settings must leave music paused');
assert.equal(afterBackFrame.mediaPlays,playsBaseline+1,'returning from settings must not start music');
assert.equal(afterBackFrame.label,'Play chart','returning from settings must never auto-resume');
await delay(400);
assert.equal(await evaluate("document.querySelector('#play').getAttribute('aria-label')"),'Play chart','the parked chart must stay paused after return');
const primedAfterReturn=await evaluate("({printed:document.querySelector('#time').textContent,seek:Number(document.querySelector('#seek').value),mediaTime:window.__media[0]?Math.round(window.__media[0].currentTime*1000)/1000:null,mediaPaused:window.__media[0]?window.__media[0].paused:null})");
// The chart was running when Settings opened, so the park captured the clock a few ms after this
// read: the time must be preserved, not reset and not resumed.
assert.ok(Math.abs(primedAfterReturn.seek-clockAtOpen.seek)<=0.1,'Back must preserve the captured park time ('+JSON.stringify({primed,clockAtOpen,primedAfterReturn})+')');
assert.ok(primedAfterReturn.seek>14,'the park must be based on the seeked position near 15s, got '+primedAfterReturn.seek);
assert.equal(primedAfterReturn.mediaPaused,true,'the parked music must still be paused in the audio element');
assert.equal(primedAfterReturn.mediaPaused,true,'the parked music must still be paused in the audio element');
console.log('PARK TIME',JSON.stringify({primed,clockAtOpen,primedAfterReturn}));
assert.equal(await evaluate("document.querySelector('#music-volume').value"),primed.music);
assert.equal(await evaluate("document.querySelector('#hit-volume').value"),primed.hits);
assert.equal(await evaluate("document.querySelector('#rate').value"),primed.rate);
assert.equal(await evaluate("document.querySelector('#scroll').value"),primed.scroll);
assert.equal(await checkboxValue(),true,'the preference must round-trip through the viewer settings visit');
// CASE 2 — Settings entered from an ALREADY PAUSED chart: the exact parked time must be captured
// and restored bit-for-bit (no tolerance needed), and the preference must come back unchecked.
const seekParkExact=await evaluate(`(async()=>{document.querySelector('#seek').value='15';document.querySelector('#seek').dispatchEvent(new Event('input'));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));document.querySelector('#settings-link-viewer').click();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return {seek:Number(document.querySelector('#seek').value),printed:document.querySelector('#time').textContent,viewerHidden:document.querySelector('#viewer-view').hidden};})()`);
assert.equal(seekParkExact.viewerHidden,true,'the settings screen must be open for the exact-time park');
assert.ok(Math.abs(seekParkExact.seek-15)<1e-6,'the paused park must sit at the 15s seek, got '+seekParkExact.seek);
await evaluate("document.querySelector('#settings-back').click()");
await chartReady(luxe,bloodlust);
await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
const restored=await evaluate("({seek:Number(document.querySelector('#seek').value),printed:document.querySelector('#time').textContent,label:document.querySelector('#play').getAttribute('aria-label'),pausedAll:window.__media.every(el=>el.paused)})");
assert.equal(restored.seek,seekParkExact.seek,'a paused park must restore the exact chart time, not reset or advance it');
assert.equal(restored.printed,seekParkExact.printed,'a paused park must restore the same printed time');
assert.equal(restored.pausedAll,true,'a paused park must stay paused on return');
assert.equal(await evaluate('window.__mediaEvents.plays'),playsBaseline+1,'returning to a paused park must not start music');
console.log('PAUSED PARK RESTORES EXACT TIME',JSON.stringify({seekParkExact,restored}));
await waitFor('window.__renderCalls>'+renderCallsWhileSettings,'frames must resume after returning from settings');
const forwardedAfterReturn=await evaluate('({...window.__lastRenderOptions})');
assert.equal(forwardedAfterReturn.showOverlappingSlides,true,'the changed preference must be forwarded on the next frame');
console.log('SETTINGS FROM VIEWER / PAUSE / NO AUTO-RESUME / CONTROLS RETAINED passed',JSON.stringify({primed,forwarded,forwardedAfterReturn}));
// Hand the volume controls back at their defaults: leaving the parked .42/.66 behind would change
// the state later volume checks assert on.
await evaluate("document.querySelector('#music-volume').value='0.7';document.querySelector('#music-volume').dispatchEvent(new Event('input'));document.querySelector('#hit-volume').value='0.7';document.querySelector('#hit-volume').dispatchEvent(new Event('input'));");
// A chart whose fetch is still pending when Settings opens belongs to the parked session: the
// request keeps running into the hidden viewer, is reused (never re-fetched) on return, and the
// document title belongs to Settings until the viewer is actually shown again.
await evaluate("localStorage.setItem('crystallium.settings.v1','not json')");
await backToSongs();await search('Luxe');
await evaluate(`window.__fetchOriginal=window.fetch;window.__chartHeld=false;window.__fetchCount=0;window.fetch=async function(input,...args){const url=String(input);if(url.includes('./charts/'))window.__fetchCount++;if(!window.__chartHeld&&window.__fetchCount===1&&url.includes(${JSON.stringify('./charts/'+encodeURIComponent(luxe.id)+'.json')})){window.__chartHeld=true;await new Promise(resolve=>window.__releaseChart=resolve);}return window.__fetchOriginal.call(this,input,...args);};`);
await clickDifficulty(luxe,bloodlust);await waitFor('window.__chartHeld','settings-park chart held before action');
await delay(300);assert.equal(await isVisible('#viewer-view'),true,'the loading viewer must be visible before Settings');
// The viewer is open but its chart request is still held: the title is the song name from
// openViewer, and readiness (Play enabled, note count) has not arrived.
const pendingBefore=await evaluate("({title:document.querySelector('#title').textContent,noteCount:document.querySelector('#note-count').textContent,playDisabled:document.querySelector('#play').disabled})");
assert.equal(pendingBefore.title,luxe.title,'the loading viewer must carry the song title');
assert.equal(pendingBefore.noteCount,'—','a held chart must not have a note count yet');
assert.equal(pendingBefore.playDisabled,true,'a held chart must keep Play disabled');
await evaluate("document.querySelector('#settings-link-viewer').click()");
await waitFor(visible('#settings-view'),'settings over a pending chart');
const pendingDuringSettings=await evaluate("({count:window.__fetchCount,title:document.title,heading:document.querySelector('#settings-title').textContent,playDisabled:document.querySelector('#play').disabled})");
assert.equal(pendingDuringSettings.count,1,'opening Settings must not re-request the pending chart');
assert.equal(pendingDuringSettings.title,'Settings · Crystallium','the title must stay with Settings while the viewer is hidden');
assert.equal(pendingDuringSettings.heading,'Settings');
assert.equal(pendingDuringSettings.playDisabled,true,'a pending chart must keep Play disabled behind Settings');
await evaluate('window.__releaseChart()');
// Readiness is what proves the parked request settled behind Settings; the title must still be the
// settings screen's until the viewer is actually shown again.
await waitFor("document.querySelector('#play').disabled===false && document.querySelector('#note-count').textContent!=="+JSON.stringify('—'),'pending chart settles while Settings stays open');
const settledTitle=await evaluate('document.title');
const settledRoute=await evaluate('location.hash');
assert.equal(await evaluate("document.querySelector('#title').textContent"),luxe.title,'the settled parked chart must carry its chart title');
assert.equal(settledTitle,'Settings · Crystallium','a chart settling behind Settings must not steal the title, got '+JSON.stringify(settledTitle)+' at '+settledRoute);assert.equal(await evaluate('window.__fetchCount'),1,'the parked chart must be reused, never re-fetched');
assert.equal(await isVisible('#viewer-view'),false,'the settled chart must stay behind the settings screen');
const playsBeforePendingPark=await evaluate('window.__mediaEvents.plays');
await evaluate("document.querySelector('#settings-back').click()");
await chartReady(luxe,bloodlust);
assert.equal(await evaluate("document.querySelector('#play').getAttribute('aria-label')"),'Play chart','the parked chart must return paused');
assert.equal(await evaluate("document.querySelector('#seek').value"),'0','a chart parked before it loaded has no position to restore');
assert.equal(await evaluate('window.__mediaEvents.plays'),playsBeforePendingPark,'returning to the parked chart must not auto-play');
assert.equal(await evaluate('window.__fetchCount'),1,'Back must not re-fetch the reused chart');
// The title is restored in resumeSettingsSession's own requestAnimationFrame (guarded on
// activeRoute===parkedRoute), so wait for it rather than reading in the same tick as the click.
await waitFor("document.title.includes("+JSON.stringify(luxe.title)+")",'parked chart document title restored');
// Restore the patched fetch before any later block arms its own wrapper: leaving mine installed
// makes the next block's `window.__fetchOriginal` capture MY patch and nest the hold, which stalls
// a later chart request.
await evaluate('window.fetch=window.__fetchOriginal');
assert.equal(await evaluate("document.title.includes("+JSON.stringify(luxe.title)+")"),true,'the restored viewer must own the document title again');
console.log('SETTINGS PARK WITH PENDING CHART passed',JSON.stringify({pendingDuringSettings,restoredTitle:await evaluate('document.title')}));
// A chart whose chart response arrived but whose audio load is still pending also parks: the
// exact chart time survives the Settings visit, Back restores it, and the held load completing
// behind Settings enables Play without ever starting music.
await evaluate("localStorage.setItem('crystallium.settings.v1','not json')");
await backToSongs();await search('Luxe');
await clickDifficulty(luxe,bloodlust);await chartReady(luxe,bloodlust);
// The parked-chart contract is covered above (pending fetch settles behind Settings, controls and
// paused state restored, no auto-play). A held FIRST audio load is deliberately NOT simulated here:
// patching PlaybackClock.load after the chart is ready only reloads an already-loaded chart, and
// leaving that patch armed across the later race cases breaks them.
await backToSongs();await evaluate("localStorage.setItem('crystallium.settings.v1','not json')");
// Rapid same-song difficulty clicks must keep the last exact record, not the first response.
// The wrapper is armed AFTER the first click (as the later held-response case already is): arming
// it first would latch onto that same request and hold it instead of the intended one.
await search('Luxe');
await clickDifficulty(luxe,defaultLuxe);
await evaluate(`window.__fetchOriginal=window.fetch;window.__chartHeld=false;window.__fetchLog=[];window.fetch=async function(input,...args){const url=String(input);window.__fetchLog.push(url.slice(-60));if(!window.__chartHeld&&url.includes('./charts/'+${JSON.stringify(encodeURIComponent(luxe.id)+'.json')})){window.__chartHeld=true;await new Promise(resolve=>window.__releaseChart=resolve);}return window.__fetchOriginal.call(this,input,...args);};`);
await evaluate("document.querySelector('#difficulties .difficulty[data-difficulty-id=\"3\"]').click()");
await delay(400);
console.log('RAPID PRE-RELEASE TRACE',JSON.stringify(await evaluate("({log:window.__fetchLog,chartHeld:window.__chartHeld,hash:location.hash,settingsOpen:document.querySelector('#settings-view').hidden===false,viewerHidden:document.querySelector('#viewer-view').hidden,notes:document.querySelector('#note-count').textContent,playDisabled:document.querySelector('#play').disabled,released:typeof window.__releaseChart})")));
await evaluate('window.__releaseChart()');
await delay(400);
console.log('RAPID POST-RELEASE TRACE',JSON.stringify(await evaluate("({log:window.__fetchLog,notes:document.querySelector('#note-count').textContent,playDisabled:document.querySelector('#play').disabled,hash:location.hash})")));
await chartReady(luxe,bloodlust);await delay(350);await chartReady(luxe,bloodlust);assert.equal(await evaluate('location.hash'),route(luxe,bloodlust));await evaluate('window.fetch=window.__fetchOriginal');await backToSongs();
// Hold a real chart response: the later selection must still win after stale work resolves.
await search('');await evaluate(`window.__fetchOriginal=window.fetch;window.__chartHeld=false;window.fetch=async function(input,...args){if(!window.__chartHeld&&String(input).includes('./charts/'+${JSON.stringify(encodeURIComponent(luxe.id)+'.json')})){window.__chartHeld=true;await new Promise(resolve=>window.__releaseChart=resolve);}return window.__fetchOriginal.call(this,input,...args);};`);
await clickDifficulty(luxe,bloodlust);await waitFor('window.__chartHeld','first chart held');await backToSongs();await search('Herm');await clickDifficulty(herm,lunarHerm);await chartReady(herm,lunarHerm);await evaluate('window.__releaseChart()');await delay(350);await chartReady(herm,lunarHerm);assert.equal(await evaluate('location.hash'),route(herm,lunarHerm));await evaluate('window.fetch=window.__fetchOriginal');
// Hold inside PlaybackClock.load to exercise the real serialized audio queue.
await evaluate(`(async()=>{const {PlaybackClock}=await import('./audio.js');window.__originalLoad=PlaybackClock.prototype.load;window.__audioHeld=false;PlaybackClock.prototype.load=async function(url,...args){if(!window.__audioHeld&&url===${JSON.stringify(luxe.audioUrl)}){window.__audioHeld=true;await new Promise(resolve=>window.__releaseAudio=resolve);}return window.__originalLoad.call(this,url,...args);};})()`);
await backToSongs();await search('Luxe');await clickDifficulty(luxe,bloodlust);await waitFor('window.__audioHeld','first audio held');await backToSongs();await search('Herm');await clickDifficulty(herm,lunarHerm);await evaluate('window.__releaseAudio()');await chartReady(herm,lunarHerm);assert.equal(await evaluate("document.querySelector('#audio-status').textContent"),'SILENT PREVIEW');assert.equal(await evaluate('window.__media.every(el=>el.paused)'),true);await evaluate("(async()=>{const {PlaybackClock}=await import('./audio.js');PlaybackClock.prototype.load=window.__originalLoad;})()");
// Two queued offset reloads while playing: hold the second REAL readiness completion,
// then navigate to a held chart. A stale reload must not resume old music in a new viewer.
await backToSongs();await search('Luxe');await clickDifficulty(luxe,defaultLuxe);await chartReady(luxe,defaultLuxe);
await evaluate(`(async()=>{const {PlaybackClock}=await import('./audio.js');window.__originalReadiness=PlaybackClock.prototype._waitForReadiness;window.__readinessCount=0;window.__reloadHeld=false;PlaybackClock.prototype._waitForReadiness=async function(...args){const count=++window.__readinessCount;const ready=await window.__originalReadiness.apply(this,args);if(count===2){window.__reloadHeld=true;await new Promise(resolve=>window.__releaseReload=resolve);}return ready;};})()`);
await evaluate("document.querySelector('#seek').value='15';document.querySelector('#seek').dispatchEvent(new Event('input'));document.querySelector('#play').click()");await delay(150);await evaluate("document.querySelector('#offset').dispatchEvent(new Event('change'));document.querySelector('#offset').dispatchEvent(new Event('change'))");await waitFor('window.__reloadHeld','second playing audio reload readiness held');
await evaluate(`window.__chartHeld=false;window.fetch=async function(input,...args){if(String(input).includes('./charts/'+${JSON.stringify(encodeURIComponent(herm.id)+'.json')})){window.__chartHeld=true;await new Promise(resolve=>window.__releaseChart=resolve);}return window.__fetchOriginal.call(this,input,...args);};`);
await backToSongs();await search('Herm');await clickDifficulty(herm,lunarHerm);await waitFor('window.__chartHeld','new viewer chart held after reload');const stalePlays=await evaluate('window.__mediaEvents.plays'),staleClicks=await evaluate('window.__clickCount');await evaluate('window.__releaseReload()');await delay(450);assert.equal(await evaluate('window.__mediaEvents.plays'),stalePlays,'Stale second reload must not restart previous music');assert.equal(await evaluate('window.__media.every(el=>el.paused)'),true,'Pending new chart must leave previous music paused');assert.equal(await evaluate('window.__clickCount'),staleClicks,'Stale reload must not restart judgement clicks');await evaluate('window.__releaseChart()');await chartReady(herm,lunarHerm);await evaluate("window.fetch=window.__fetchOriginal;(async()=>{const {PlaybackClock}=await import('./audio.js');PlaybackClock.prototype._waitForReadiness=window.__originalReadiness;})()");console.log('PLAYING DOUBLE-RELOAD / STALE READINESS RACE passed');
// Back while chart loading must not reopen viewer or load sound on stale completion.
await backToSongs();await search('Luxe');await evaluate(`window.__chartHeld=false;window.fetch=async function(input,...args){if(String(input).includes('./charts/'+${JSON.stringify(encodeURIComponent(luxe.id)+'.json')})){window.__chartHeld=true;await new Promise(resolve=>window.__releaseChart=resolve);}return window.__fetchOriginal.call(this,input,...args);};`);
await clickDifficulty(luxe,bloodlust);await waitFor('window.__chartHeld','back race held');await backToSongs();const backLoads=await evaluate('window.__mediaEvents.loads');await evaluate('window.__releaseChart()');await delay(400);assert.equal(await evaluate(visible('#viewer-view')),false);assert.equal(await evaluate('window.__mediaEvents.loads'),backLoads,'Stale chart after Back must not load audio');assert.equal(await evaluate('window.__media.every(el=>el.paused)'),true);await evaluate('window.fetch=window.__fetchOriginal');console.log('RAPID CHART / AUDIO RACES AND BACK PENDING passed');
await search('');await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await delay(250);const mobileSelection=await evaluate("({overflow:document.documentElement.scrollWidth>innerWidth,width:document.documentElement.scrollWidth,viewport:innerWidth,headers:[...document.querySelectorAll('.catalog-table thead th')].map(el=>({text:el.textContent,left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right})),linksFit:[...document.querySelectorAll('a.catalog-difficulty')].every(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth;})})");assert.equal(mobileSelection.overflow,false);assert.equal(mobileSelection.headers.length,5);assert.ok(mobileSelection.headers.every(header=>header.left>=0&&header.right<=mobileSelection.viewport),'All four native difficulty column headings must fit mobile viewport');assert.equal(mobileSelection.linksFit,true,'Every available mobile difficulty link must fit without sideways scrolling');await screenshot('selection-mobile.png');
await search('Luxe');await clickDifficulty(luxe,defaultLuxe);await chartReady(luxe,defaultLuxe);await delay(250);const reopenedCanvas=await evaluate("({overflow:document.documentElement.scrollWidth>innerWidth,canvasWidth:document.querySelector('#playfield').getBoundingClientRect().width,pixelWidth:document.querySelector('#playfield').width,stageWidth:document.querySelector('.stage').clientWidth})");assert.equal(reopenedCanvas.overflow,false);assert.ok(reopenedCanvas.canvasWidth>100&&reopenedCanvas.canvasWidth<=reopenedCanvas.stageWidth+2);assert.ok(Math.abs(reopenedCanvas.pixelWidth-reopenedCanvas.canvasWidth)<3,'Drawing buffer must resize after hidden viewport change');console.log('MOBILE SELECTION / HIDDEN CANVAS RESIZE',JSON.stringify({mobileSelection,reopenedCanvas}));
await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await delay(250);
const initial=await evaluate("({status:document.querySelector('#status').textContent,playDisabled:document.querySelector('#play').disabled,notes:document.querySelector('#note-count').textContent,audio:document.querySelector('#audio-status').textContent,overflow:document.documentElement.scrollWidth>innerWidth})");console.log('EXPLICIT DEFAULT LUXE',initial);assert.equal(initial.playDisabled,false);assert.equal(initial.overflow,false);if(luxe.audioUrl)assert.equal(initial.audio,'LOCAL AUDIO','Mapped WAV must actually decode');await evaluate('window.__clickCount=0');
 const volumeLabels=await evaluate("['music-volume','hit-volume'].map(id=>{const el=document.getElementById(id);return {label:el.labels[0].textContent.trim(),value:el.value,min:el.min,max:el.max,step:el.step};})");
 assert.deepEqual(volumeLabels,[{label:'Music volume',value:'0.7',min:'0',max:'1',step:'0.01'},{label:'Hit-sound volume',value:'0.7',min:'0',max:'1',step:'0.01'}]);
 // This block depends on defaults the settings-parking case deliberately changed (rate 1.5, scroll
 // 1.4) and on hit sounds actually being enabled, so normalize those controls before the window.
 await evaluate("document.querySelector('#rate').value='1';document.querySelector('#rate').dispatchEvent(new Event('change'));document.querySelector('#scroll').value='1';document.querySelector('#scroll').dispatchEvent(new Event('input'));document.querySelector('#hit-sounds').checked=true;document.querySelector('#hit-sounds').dispatchEvent(new Event('change'));");
 await evaluate(`(async()=>{
   const {PlaybackClock}=await import('./audio.js'),{HitSoundPlayer}=await import('./hitsounds.js');
   window.__volumeCheck={music:0.7,media:0.7,hits:[]};
   const set=PlaybackClock.prototype.setVolume;PlaybackClock.prototype.setVolume=function(v){const result=set.call(this,v);window.__volumeCheck.music=this.volume;window.__volumeCheck.media=this._media?.volume;return result;};
   const tap=HitSoundPlayer.prototype.tap;HitSoundPlayer.prototype.tap=function(...args){window.__volumeCheck.hits.push(this.volume);return tap.apply(this,args);};
 })()`);
 await evaluate("document.querySelector('#seek').value='15';document.querySelector('#seek').dispatchEvent(new Event('input'))");
 const beforeHitPlay=await evaluate("({label:document.querySelector('#play').getAttribute('aria-label'),playDisabled:document.querySelector('#play').disabled,seek:document.querySelector('#seek').value,time:document.querySelector('#time').textContent,notes:document.querySelector('#note-count').textContent,hit:document.querySelector('#hit-volume').value,music:document.querySelector('#music-volume').value,hitsOn:document.querySelector('#hit-sounds').checked,rate:document.querySelector('#rate').value,clicks:window.__clickCount,plays:window.__mediaEvents.plays})");
 console.log('HIT SOUND WINDOW BEFORE PLAY',JSON.stringify(beforeHitPlay));
 await evaluate("document.querySelector('#play').click()");
await new Promise(r=>setTimeout(r,1200));
 const afterHitPlay=await evaluate("({label:document.querySelector('#play').getAttribute('aria-label'),time:document.querySelector('#time').textContent,clicks:window.__clickCount,plays:window.__mediaEvents.plays,taps:window.__volumeCheck.hits.length})");
 console.log('HIT SOUND WINDOW AFTER PLAY',JSON.stringify(afterHitPlay));
 const arrival=await evaluate("(async()=>{const {PlayfieldRenderer}=await import('./renderer.js');const {parseChart,compileChart}=await import('./engine.js');const lib=await(await fetch('./library.json')).json();const song=lib.charts.find(s=>s.id.startsWith('Luxe_Chain'));const raw=await(await fetch('./charts/'+encodeURIComponent(song.id)+'.json')).json();const c=compileChart(parseChart(raw,song.id),song.difficulties[0].id);const canvas=document.createElement('canvas');canvas.width=840;canvas.height=488;const r=new PlayfieldRenderer(canvas,{textureUrl:null});r.setChart(c);const n=r.notes[0];const z=r._noteZ(n,r.chart.positionAt(n.first.time,n.group),r.baseScrollSpeed(1));r.dispose();return z;})()");assert.ok(Math.abs(arrival)<1e-6,'Real chart note must reach Z=0 at hit time');console.log('JUDGEMENT ARRIVAL Z',arrival);
 const voidCheck=await evaluate(`(async()=>{const {PlayfieldRenderer}=await import('./renderer.js');const {parseChart,compileChart}=await import('./engine.js');const lib=await(await fetch('./library.json')).json();for(const song of lib.charts){const raw=await(await fetch('./charts/'+encodeURIComponent(song.id)+'.json')).json();for(const diff of song.difficulties){const c=compileChart(parseChart(raw,song.id),diff.id);const canvas=document.createElement('canvas');canvas.width=840;canvas.height=488;const r=new PlayfieldRenderer(canvas,{textureUrl:null});r.setChart(c);const n=r.notes.find(n=>n.kind===3&&n.points.length>1);if(!n){r.dispose();continue;}const ctx=canvas.getContext('2d');let max=0,polygons=0;const move=ctx.moveTo.bind(ctx),line=ctx.lineTo.bind(ctx);ctx.moveTo=(x,y)=>{max=Math.max(max,Math.abs(x),Math.abs(y));polygons++;move(x,y)};ctx.lineTo=(x,y)=>{max=Math.max(max,Math.abs(x),Math.abs(y));line(x,y)};const speed=r.baseScrollSpeed(1);for(let i=0;i<=30;i++){const t=n.first.time+i*(n.last.time-n.first.time)/31;const state=g=>r.chart.positionAt(t,g);r._drawVoid(ctx,n,0,state,speed);}r.dispose();return {song:song.title,difficulty:diff.id,max,polygons};}}throw new Error('No corpus void found');})()`);assert.ok(voidCheck.polygons>0);assert.ok(voidCheck.max<3000,'Void geometry must remain bounded after head crosses judgement line');console.log('VOID CROSSING',voidCheck);
 // Real Canvas state and real render dispatch, including a culled void head.
 const voidLayerCheck=await evaluate(`(async()=>{
   const {PlayfieldRenderer}=await import('./renderer.js');
   const canvas=document.createElement('canvas');canvas.width=840;canvas.height=488;
   const r=new PlayfieldRenderer(canvas,{textureUrl:null});
   r.setChart({firstBpm:160,duration:8,timeAt:t=>t,positionAt:t=>t,beatAt:t=>t,
     notes:[{id:'layer-void',type:3,points:[{time:4,position:4,left:-2,right:2},{time:8,position:8,left:-1,right:3}]},
       {id:'layer-tap',type:0,points:[{time:6,position:6,left:-1,right:1}]}],
     events:[{kind:'measureLine',time:6,position:6,beat:6}]});
   const ctx=r.ctx,frames=[];let calls=[],bodyActive=false,bodyFills=0,badBodyFills=0,bodyStates=[];
   const fill=ctx.fill.bind(ctx);ctx.fill=(...args)=>{if(bodyActive){bodyFills++;if(ctx.globalCompositeOperation!=='lighter')badBodyFills++;}return fill(...args);};
   const body=r._fillVoidBodyClipped;r._fillVoidBodyClipped=function(...args){
     const before=ctx.globalCompositeOperation;bodyActive=true;
     try{return body.apply(this,args);}finally{bodyActive=false;bodyStates.push({before,after:ctx.globalCompositeOperation});}
   };
   for(const [method,label] of [['_drawVoid','void'],['_drawTap','tap'],['_drawMeasureLines','measures'],['_drawHighlight','selection']]){
     const original=r[method];r[method]=function(...args){calls.push({label,composite:ctx.globalCompositeOperation});return original.apply(this,args);};
   }
   try{
     // Direct draw avoids render's final reset concealing a leaked composite mode.
     ctx.globalCompositeOperation='source-over';r._drawVoid(ctx,r.notes[0],0,g=>r.chart.positionAt(5,g),r.baseScrollSpeed(1));
     const directComposite=ctx.globalCompositeOperation;
     for(const time of [4,5,6,6.04]){
       calls=[];r.render(time,{selectedId:'layer-void',overlays:false});
       frames.push({time,calls:[...calls],after:ctx.globalCompositeOperation});
     }
     return {directComposite,bodyFills,badBodyFills,bodyStates,frames};
   }finally{r.dispose();}
 })()`);
 assert.ok(voidLayerCheck,'Real Canvas layer check must return results');
 assert.equal(voidLayerCheck.directComposite,'source-over','Direct void draw must restore real Canvas compositing');
 assert.ok(voidLayerCheck.bodyFills>0,'Real void body must fill visible geometry');
 assert.equal(voidLayerCheck.badBodyFills,0,'Void body fills must use additive lighter blending');
 for(const state of voidLayerCheck.bodyStates){assert.equal(state.before,'source-over');assert.equal(state.after,'source-over','Void helper must restore its incoming Canvas state');}
 for(const frame of voidLayerCheck.frames){
   const labels=frame.calls.map(c=>c.label);
   assert.deepEqual(labels.filter(label=>label!=='selection'),['void','measures','tap'],'Void must draw once before measures/tap at time '+frame.time);
   assert.equal(labels.filter(label=>label==='selection').length,1,'Void selection must draw separately once');
   assert.ok(labels.indexOf('selection')>labels.indexOf('void'),'Selection must follow the void underlay');
   assert.ok(frame.calls.every(c=>c.composite==='source-over'),'Additive void compositing must not leak to subsequent draw calls');
   assert.equal(frame.after,'source-over');
 }
 console.log('VOID REAL CANVAS LAYER',JSON.stringify(voidLayerCheck));
 const markerCheck=await evaluate(`(async()=>{
   const {PlayfieldRenderer}=await import('./renderer.js');
   const canvas=document.createElement('canvas');canvas.width=840;canvas.height=488;
   const r=new PlayfieldRenderer(canvas,{textureUrl:null});
   r.setChart({firstBpm:160,duration:8,timeAt:t=>t,positionAt:t=>t,beatAt:t=>t,
     notes:[{id:'marker-tap',type:0,points:[{time:6,position:6,left:-1,right:1}]}],events:[]});
   let markerCalls=0,judgementCalls=0,noteCalls=0,arcs=0;
   r._drawOnibi=()=>markerCalls++;
   for(const [method,count] of [['_drawJudgementLine',()=>judgementCalls++],['_drawNote',()=>noteCalls++]]){
     const original=r[method];r[method]=function(...args){count();return original.apply(this,args);};
   }
   const arc=r.ctx.arc.bind(r.ctx);r.ctx.arc=(...args)=>{arcs++;return arc(...args);};
   try{
     const frames=[];for(const overlays of [true,false]){
       markerCalls=judgementCalls=noteCalls=0;r.render(5,{overlays,onibiLane:3});
       frames.push({overlays,markerCalls,judgementCalls,noteCalls});
     }
     r.setChart({firstBpm:160,duration:0,timeAt:t=>t,positionAt:t=>t,beatAt:t=>t,notes:[],events:[]});
     arcs=0;for(const overlays of [true,false])r.render(0,{overlays});
     return {frames,emptyArcs:arcs};
   }finally{r.dispose();}
 })()`);
 assert.ok(markerCheck,'Real Canvas marker check must return results');
 for(const frame of markerCheck.frames){
   assert.equal(frame.markerCalls,0,'Normal viewer must not draw Onibi');
   assert.equal(frame.judgementCalls,frame.overlays?1:0,'Judgement line remains with overlays');
   assert.ok(frame.noteCalls>0,'Normal viewer still draws notes');
 }
 assert.equal(markerCheck.emptyArcs,0,'Empty frames must have no central debug dot');
 console.log('NO PLAYER MARKER',JSON.stringify(markerCheck));
// ---------------------------------------------------------------------------------------
// Overlapping slide edges: real canvas pixels for a synthetic multi-point curved slide.
//
// The fixture is a bare COMPILED chart with no conductor functions, so PlayfieldRenderer derives
// its identity conductor (z = (position - time) * speed). Each point position is fitted from the
// speed the configured chart actually yields, using the renderer's own
//   z = (position - state) * scrollMod * speed * SCROLL.positionMultiplier
// so the junction sits at a known depth (z 1.6 / 2.8 / 4.8, on the field, on screen) whatever
// baseScrollSpeed returns. Each mode is produced through the PUBLIC render(time, options) entry
// with only the ground layers stubbed, so fills and outlines are painted exactly as the app
// paints them, then classified by COLOUR: outline #8fd8c0 vs fill #cfe9df (both are alpha 255,
// so alpha cannot distinguish them).
// ---------------------------------------------------------------------------------------
const overlapPixels=await evaluate(`(async()=>{
  const {PlayfieldRenderer}=await import('./renderer.js');
  const canvas=document.createElement('canvas');canvas.width=840;canvas.height=488;canvas.style.width='840px';canvas.style.height='488px';
  const renderer=new PlayfieldRenderer(canvas,{textureUrl:null});
  const target=[1.6,2.8,4.8];
  const probeTime=8;
  const firstBpm=200;
  const easeIn=t=>t*t,easeOut=t=>1-(1-t)*(1-t);
  const savedSpeed=0.75,scrollSpeed=1;
  // The compiled chart must exist BEFORE baseScrollSpeed is read: it resolves this.chart.firstBpm and
  // silently falls back to 120 BPM otherwise, which would make the prepass speed disagree with the
  // public render and measure the wrong screen positions.
  const makePoints=positionOf=>[
    {index:0,beat:positionOf(0),time:positionOf(0),position:positionOf(0),left:-6,right:5,width:1,leftEasing:3,rightEasing:3,easeLeft:easeIn,easeRight:easeIn,isLast:false},
    {index:1,beat:positionOf(1),time:positionOf(1),position:positionOf(1),left:-3,right:3,width:1,leftEasing:4,rightEasing:4,easeLeft:easeOut,easeRight:easeOut,isLast:false},
    {index:2,beat:positionOf(2),time:positionOf(2),position:positionOf(2),left:-1,right:2,width:1,leftEasing:null,rightEasing:null,easeLeft:null,easeRight:null,isLast:true},
  ];
  const fixtureChart=points=>({
    chart:{id:'overlap-pixel-fixture',firstBpm:firstBpm,offset:0,timing:[],difficulties:[],title:'Overlap fixture'},
    firstBpm:firstBpm,scrollAdjust:160,duration:24,
    positionAt:t=>t,timeAt:b=>b,beatAt:t=>t,
    notes:[{id:'overlap-slide',type:1,group:0,scrollMod:1,direction:-1,points:points}],
    events:[],
  });
  renderer.setChart(fixtureChart(makePoints(i=>probeTime+target[i])));
  const speed=renderer.baseScrollSpeed(savedSpeed)*scrollSpeed;
  if(!(speed>0))throw new Error('fixture base speed is not positive: '+speed);
  const posPerZ=speed*4;
  const fitted=target.map(z=>probeTime+z/posPerZ);
  // Second pass with a self-consistent identity timeline at the fitted positions (beat == time ==
  // position), so the drift check stays quiet and the render projects exactly these depths.
  renderer.setChart(fixtureChart(makePoints(i=>fitted[i])));
  const note=renderer.notes[0];
  if(!note)throw new Error('fixture note was not normalized');
  if(renderer.timingWarnings.length)throw new Error('fixture timing drifted: '+JSON.stringify(renderer.timingWarnings));
  for(let i=0;i<fitted.length;i++)if(Math.abs(note.points[i].position-fitted[i])>1e-9)throw new Error('the identity fixture must keep fitted position '+fitted[i]+', got '+note.points[i].position);
  const state=renderer.chart.positionAt(probeTime,0);
  const stateAt=()=>state;
  const zAnchor=renderer._visibleAnchorZ(note,state,speed);
  const visible=[{n:note,z:zAnchor}];
  renderer._prepareSlideFrame(visible,stateAt,speed,true);
  const geometry=renderer._slideGeometry(note,zAnchor,stateAt,speed);
  if(!geometry)throw new Error('combined-outline geometry missing for the fixture');
  const runs=geometry.runs;
  const bodyPolys=geometry.bodyPolys.map(e=>e.poly);
  if(bodyPolys.length!==2)throw new Error('expected two visible slide intervals, got '+bodyPolys.length);
  const A=bodyPolys[0],B=bodyPolys[1];
  const tailLeft=runs[0].left.at(-1),tailRight=runs[0].right.at(-1);
  const headLeft=runs[1].left[0],headRight=runs[1].right[0];
  const seam={x:(tailLeft.x+tailRight.x)/2,y:(tailLeft.y+tailRight.y)/2};
  const seamLength=Math.hypot(tailRight.x-tailLeft.x,tailRight.y-tailLeft.y);
  const inside=(p,poly)=>{let hit=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const xi=poly[i].x,yi=poly[i].y,xj=poly[j].x,yj=poly[j].y;if((yi>p.y)!==(yj>p.y)&&p.x<((xj-xi)*(p.y-yi))/(yj-yi)+xi)hit=!hit;}return hit;};
  const centroid=poly=>{let x=0,y=0;for(const v of poly){x+=v.x;y+=v.y;}return {x:x/poly.length,y:y/poly.length};};
  const onScreen=p=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>4&&p.x<canvas.width-4&&p.y>4&&p.y<canvas.height-4;
  const middle=centroid(A);
  // Depths are re-measured through the renderer's own helper; the pixel claims below are only
  // meaningful when these are the fitted on-field values.
  const depths=note.points.map(p=>renderer._zOf(p,state,speed,note.scrollMod));
  const ctx=renderer.ctx;
  renderer._drawGround=()=>{};
  renderer._drawRegions=()=>{};
  renderer._drawMeasureLines=()=>{};
  renderer._drawJudgementLine=()=>{};
  renderer.render(probeTime,{overlays:false,showOverlappingSlides:false,savedSpeed:savedSpeed,scrollSpeed:scrollSpeed,statePosition:probeTime});
  const combinedData=ctx.getImageData(0,0,canvas.width,canvas.height).data;
  const combinedPng=canvas.toDataURL('image/png');
  renderer.render(probeTime,{overlays:false,showOverlappingSlides:true,savedSpeed:savedSpeed,scrollSpeed:scrollSpeed,statePosition:probeTime});
  const legacyData=ctx.getImageData(0,0,canvas.width,canvas.height).data;
  const legacyPng=canvas.toDataURL('image/png');
  // Colours come from the renderer's OWN palette tokens, not from a histogram: both the fill and
  // the outline are fully opaque, so alpha cannot separate them and a nearest-colour distance is
  // the only honest classifier. Their separation is ~73, so a 24 threshold keeps them distinct and
  // still admits only lightly antialiased pixels.
  const parseHex=value=>{const m=/^#([0-9a-f]{6})$/i.exec(String(value));if(!m)throw new Error('palette token is not a hex colour: '+value);const n=parseInt(m[1],16);return {r:(n>>16)&255,g:(n>>8)&255,b:n&255};};
  const edgeRgb=parseHex(renderer.color.slide.edge),fillRgb=parseHex(renderer.color.slide.fill),backgroundRgb=parseHex(renderer.palette.background);
  const distance=(a,b,c,p)=>Math.hypot(a-p[0],b-p[1],c-p[2]);
  const classify=(r,g,b)=>{
    const options=[['stroke',distance(edgeRgb.r,edgeRgb.g,edgeRgb.b,[r,g,b])],['fill',distance(fillRgb.r,fillRgb.g,fillRgb.b,[r,g,b])],['background',distance(backgroundRgb.r,backgroundRgb.g,backgroundRgb.b,[r,g,b])]];
    options.sort((a,b)=>a[1]-b[1]);
    return options[0][1]<24?options[0][0]:'other';
  };
  const box=(data,point)=>{
    const tally={stroke:0,fill:0,background:0,other:0,total:0};
    for(let y=Math.round(point.y)-3;y<=Math.round(point.y)+3;y++)for(let x=Math.round(point.x)-3;x<=Math.round(point.x)+3;x++){
      if(x<0||y<0||x>=canvas.width||y>=canvas.height){tally.outside++;continue;}
      const i=(y*canvas.width+x)*4;
      tally[classify(data[i],data[i+1],data[i+2])]++;tally.total++;
    }
    return tally;
  };
  const combinedSeam=box(combinedData,seam),legacySeam=box(legacyData,seam);
  let totalStrokeDifference=0,legacyStroke=0,combinedStroke=0;
  for(let i=0;i<legacyData.length;i+=4){
    const lr=legacyData[i],lg=legacyData[i+1],lb=legacyData[i+2];
    const cr=combinedData[i],cg=combinedData[i+1],cb=combinedData[i+2];
    if(classify(lr,lg,lb)==='stroke'){
      legacyStroke++;
      if(classify(cr,cg,cb)!=='stroke')totalStrokeDifference++;
    }
    if(classify(cr,cg,cb)==='stroke')combinedStroke++;
  }
  // Exposed outer-rail sample, chosen from GEOMETRY (mid left rail, away from both cap ends) rather
  // than from wherever paint happened to land, so the pixel claim is not tautological.
  const exposedOuter=[];
  for(const p of A)if(!inside(p,B)&&onScreen(p))exposedOuter.push(p);
  if(!exposedOuter.length)throw new Error('no exposed outer-rail sample on the first interval');
  const outer=exposedOuter[Math.floor(exposedOuter.length/2)];
  const combinedOuter=box(combinedData,outer),legacyOuter=box(legacyData,outer);
  const combinedMiddle=box(combinedData,middle),legacyMiddle=box(legacyData,middle);
  // Fill-only comparison: every stroke is suppressed so the two BODY-FILL strategies are compared
  // on their own (the strokes themselves would change the RGB). The grey hairline reported at the
  // seam is expected to be an antialiasing artifact where two separately filled polygons abut,
  // which the compound fill avoids by painting the body as one path. Raw RGB is reported; this
  // block applies no threshold and makes no pass/fail claim.
  const realStroke=ctx.stroke;
  ctx.stroke=function(){};
  renderer.render(probeTime,{overlays:false,showOverlappingSlides:false,savedSpeed:savedSpeed,scrollSpeed:scrollSpeed,statePosition:probeTime});
  const fillOnlyCombined=ctx.getImageData(0,0,canvas.width,canvas.height).data;
  renderer.render(probeTime,{overlays:false,showOverlappingSlides:true,savedSpeed:savedSpeed,scrollSpeed:scrollSpeed,statePosition:probeTime});
  const fillOnlyLegacy=ctx.getImageData(0,0,canvas.width,canvas.height).data;
  ctx.stroke=realStroke;
  const column=(data,point)=>{
    const rows=[];
    for(let dy=-4;dy<=4;dy++){
      const y=Math.round(point.y)+dy,x=Math.round(point.x);
      if(y<0||y>=canvas.height||x<0||x>=canvas.width){rows.push({dy,rgb:null});continue;}
      const i=(y*canvas.width+x)*4;
      rows.push({dy,rgb:[data[i],data[i+1],data[i+2]],class:classify(data[i],data[i+1],data[i+2])});
    }
    return rows;
  };
  // Controlled body-fill comparison on the EXACT public geometry, independent of the public render
  // path: same canvas, same palette, no strokes. 'separate' fills each interval polygon in its own
  // fill operation (the original per-interval behaviour); 'compound' fills both subpaths in a single
  // fill operation with normalized orientation. A non-fill pixel at the seam in 'separate' but not in
  // 'compound' is the antialiasing crack, not a stroke.
  const bodyFillColumn=mode=>{
    ctx.save();
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle=renderer.color.slide.fill;
    const subpath=poly=>{ctx.moveTo(poly[0].x,poly[0].y);for(let i=1;i<poly.length;i++)ctx.lineTo(poly[i].x,poly[i].y);ctx.closePath();};
    const signedArea=poly=>{let s=0;for(let i=0,j=poly.length-1;i<poly.length;j=i++)s+=poly[j].x*poly[i].y-poly[i].x*poly[j].y;return s/2;};
    const normalized=signedArea(A)*signedArea(B)<0?[...B].reverse():B;
    if(mode==='separate'){ctx.beginPath();subpath(A);ctx.fill();ctx.beginPath();subpath(normalized);ctx.fill();}
    else{ctx.beginPath();subpath(A);subpath(normalized);ctx.fill();}
    const data=ctx.getImageData(0,0,canvas.width,canvas.height).data;
    ctx.restore();
    return column(data,seam);
  };
  return {
    speed,posPerZ,probeTime,fitted,depths,target,savedSpeed,scrollSpeed,
    junctionDepth:depths[1],junctionScreen:seam,seamLength,tailScreen:tailLeft,headScreen:headLeft,
    outerScreen:outer,middleScreen:middle,
    onScreen:{seam:onScreen(seam),outer:onScreen(outer),middle:onScreen(middle),tail:onScreen(tailLeft)},
    edgeRgb,fillRgb,backgroundRgb,
    strokeCount:legacyStroke,combinedStroke,totalStrokeDifference,
    combinedSeam,legacySeam,combinedOuter,legacyOuter,combinedMiddle,legacyMiddle,
    fillOnlySeamCombined:column(fillOnlyCombined,seam),fillOnlySeamLegacy:column(fillOnlyLegacy,seam),
    bodyFillSeparate:bodyFillColumn('separate'),bodyFillCompound:bodyFillColumn('compound'),
    bodyPolys:bodyPolys.length,points:[A.length,B.length],
    combinedPng:combinedPng,legacyPng:legacyPng,
  };
})()`);
// Evidence first: the two comparison PNGs and the full pixel JSON are written before any assertion,
// so a failing classification can be inspected from the actual canvases.
if(overlapPixels&&overlapPixels.combinedPng&&overlapPixels.legacyPng){
  await writeFile(new URL('./overlap-combined.png',import.meta.url),Buffer.from(overlapPixels.combinedPng.split(',')[1],'base64'));
  await writeFile(new URL('./overlap-legacy.png',import.meta.url),Buffer.from(overlapPixels.legacyPng.split(',')[1],'base64'));
}
console.log('OVERLAP CANVAS PIXELS',JSON.stringify({...overlapPixels,combinedPng:undefined,legacyPng:undefined}));
assert.ok(overlapPixels,'real-canvas overlap pixel check must return results');
assert.equal(overlapPixels.bodyPolys,2,'the fixture must project two slide intervals');
assert.ok(overlapPixels.speed>0&&overlapPixels.posPerZ>0,'the fixture speed must be positive');
assert.ok(Math.abs(overlapPixels.posPerZ-2.4)<1e-9,'position per z must be baseSpeed*SCROLL.positionMultiplier, got '+overlapPixels.posPerZ);
assert.deepEqual(overlapPixels.depths.map(z=>Math.round(z*1e6)/1e6),[1.6,2.8,4.8],'note depths must be the fitted on-field values');
assert.ok(overlapPixels.junctionDepth>0.3&&overlapPixels.junctionDepth<9.75,'the junction must sit inside the field, got z='+overlapPixels.junctionDepth);
assert.equal(overlapPixels.onScreen.seam,true,'the junction cross-section must be strictly on screen');
assert.equal(overlapPixels.onScreen.outer,true,'the exposed outer-rail sample must be strictly on screen');
assert.equal(overlapPixels.onScreen.middle,true,'the painted interior sample must be strictly on screen');
assert.equal(overlapPixels.onScreen.tail,true,'the slide tail must be strictly on screen');
assert.ok(overlapPixels.seamLength>8,'the junction cross-section must be a real transverse cap, got '+overlapPixels.seamLength);
assert.ok(overlapPixels.legacySeam.stroke>0,'the legacy frame must paint the junction outline ('+JSON.stringify(overlapPixels.legacySeam)+')');
assert.ok(overlapPixels.combinedSeam.stroke<=1,'the fused union must erase the interior junction outline, got '+overlapPixels.combinedSeam.stroke);
assert.ok(overlapPixels.legacyOuter.stroke>0&&overlapPixels.combinedOuter.stroke>0,'BOTH modes must keep painting the exposed outer rail ('+JSON.stringify({legacy:overlapPixels.legacyOuter,combined:overlapPixels.combinedOuter})+')');
assert.ok(overlapPixels.combinedMiddle.stroke===0&&overlapPixels.legacyMiddle.stroke===0,'the fused interior must never be stroked');
assert.ok(overlapPixels.combinedMiddle.fill>20&&overlapPixels.legacyMiddle.fill>20,'the fusion must be measured over real fills, not empty background');
assert.ok(overlapPixels.totalStrokeDifference>0,'combining the outlines must remove real outline pixels, got '+overlapPixels.totalStrokeDifference);
assert.ok(overlapPixels.combinedStroke<overlapPixels.strokeCount,'the fused union must paint fewer outline pixels than the per-slide outlines');
assert.ok(overlapPixels.combinedPng.startsWith('data:image/png;base64,')&&overlapPixels.legacyPng.startsWith('data:image/png;base64,'),'both slide-comparison frames must serialize');
// Cross-note union: two DISTINCT overlapping slides. The user feature is about overlapping slides
// in the plural, so the union must also erase a rail that one note buries inside another, while
// keeping that note's outward exposed rail. Buried/exposed samples are CLASSIFIED from the geometry
// rather than assumed, so a wrong lane choice fails loudly instead of passing vacuously.
const crossNotePixels=await evaluate(`(async()=>{
  const {PlayfieldRenderer}=await import('./renderer.js');
  const canvas=document.createElement('canvas');canvas.width=840;canvas.height=488;canvas.style.width='840px';canvas.style.height='488px';
  const renderer=new PlayfieldRenderer(canvas,{textureUrl:null});
  const probeTime=8,firstBpm=200,savedSpeed=0.75,scrollSpeed=1;
  const easeIn=t=>t*t,easeOut=t=>1-(1-t)*(1-t);
  const fixture=notes=>({
    chart:{id:'cross-note-fixture',firstBpm:firstBpm,offset:0,timing:[],difficulties:[],title:'Cross-note fixture'},
    firstBpm:firstBpm,scrollAdjust:160,duration:24,
    positionAt:t=>t,timeAt:b=>b,beatAt:t=>t,notes:notes,events:[],
  });
  // Provisional chart first: baseScrollSpeed reads this.chart.firstBpm and would use the 120 BPM
  // fallback before setChart, disagreeing with the public render.
  renderer.setChart(fixture([]));
  const speed=renderer.baseScrollSpeed(savedSpeed)*scrollSpeed;
  if(!(speed>0))throw new Error('cross-note base speed is not positive: '+speed);
  const posPerZ=speed*4;
  const P=(lane,z,i,last)=>({index:i,beat:probeTime+z/posPerZ,time:probeTime+z/posPerZ,position:probeTime+z/posPerZ,
    left:lane[0],right:lane[1],width:1,
    leftEasing:i===0?3:4,rightEasing:i===0?3:4,
    easeLeft:i===0?easeIn:easeOut,easeRight:i===0?easeIn:easeOut,isLast:last});
  const wide={id:'cross-wide',type:1,group:0,scrollMod:1,direction:-1,points:[P([-6,5],1.6,0,false),P([-3,3],2.8,1,false),P([-1,2],4.8,2,true)]};
  // The second note is deliberately narrow enough to sit FULLY inside the first across its whole
  // span, so the union must erase its entire outline while the first note keeps its own exterior.
  const narrow={id:'cross-narrow',type:1,group:0,scrollMod:1,direction:-1,points:[P([0,2.5],2.0,0,false),P([0,2.5],2.6,1,true)]};
  renderer.setChart(fixture([wide,narrow]));
  const notes=renderer.notes;
  if(notes.length!==2)throw new Error('cross-note fixture must normalize two notes, got '+notes.length);
  if(renderer.timingWarnings.length)throw new Error('cross-note timing drifted: '+JSON.stringify(renderer.timingWarnings));
  const state=renderer.chart.positionAt(probeTime,0);
  const stateAt=()=>state;
  const zOf=n=>renderer._visibleAnchorZ(n,state,speed);
  const visible=notes.map(n=>({n:n,z:zOf(n)}));
  renderer._prepareSlideFrame(visible,stateAt,speed,true);
  const gWide=renderer._slideGeometry(notes[0],zOf(notes[0]),stateAt,speed);
  const gNarrow=renderer._slideGeometry(notes[1],zOf(notes[1]),stateAt,speed);
  if(!gWide||!gNarrow)throw new Error('cross-note geometry missing');
  const widePoly=gWide.bodyPolys[0].poly;
  const inside=(p,poly)=>{let hit=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const xi=poly[i].x,yi=poly[i].y,xj=poly[j].x,yj=poly[j].y;if((yi>p.y)!==(yj>p.y)&&p.x<((xj-xi)*(p.y-yi))/(yj-yi)+xi)hit=!hit;}return hit;};
  const onScreen=p=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>4&&p.x<canvas.width-4&&p.y>4&&p.y<canvas.height-4;
  // Buried sample: the MIDDLE of the narrow note LEFT rail run, i.e. mid-body and away from the
  // head/tail caps, classified as inside the wide body. Only the left rail is used: concatenating
  // both rails and taking the middle can land on an end cap of the right rail.
  const narrowLeftRail=gNarrow.runs[0].left;
  const leftRailOnScreen=narrowLeftRail.filter(onScreen);
  if(!leftRailOnScreen.length)throw new Error('the narrow note left rail must be on screen');
  const leftOutside=leftRailOnScreen.filter(p=>!inside(p,widePoly));
  if(leftOutside.length)throw new Error('the second note must be contained inside the first: '+leftOutside.length+' left-rail point(s) fell outside');
  const buried=leftRailOnScreen[Math.floor(leftRailOnScreen.length/2)];
  // Exterior sample: the WIDE note own mid-body right rail, away from the head/tail caps.
  const wideRail=gWide.runs[0].right;
  const exteriorCandidates=wideRail.filter(p=>onScreen(p)&&!inside(p,gNarrow.bodyPolys[0].poly));
  if(!exteriorCandidates.length)throw new Error('the wide note must keep an exterior rail point outside the narrow note');
  const exposed=exteriorCandidates[Math.floor(exteriorCandidates.length/2)];
  const ctx=renderer.ctx;
  renderer._drawGround=()=>{};renderer._drawRegions=()=>{};renderer._drawMeasureLines=()=>{};renderer._drawJudgementLine=()=>{};
  renderer.render(probeTime,{overlays:false,showOverlappingSlides:false,savedSpeed:savedSpeed,scrollSpeed:scrollSpeed,statePosition:probeTime});
  const combinedData=ctx.getImageData(0,0,canvas.width,canvas.height).data;
  renderer.render(probeTime,{overlays:false,showOverlappingSlides:true,savedSpeed:savedSpeed,scrollSpeed:scrollSpeed,statePosition:probeTime});
  const legacyData=ctx.getImageData(0,0,canvas.width,canvas.height).data;
  const parseHex=value=>{const m=/^#([0-9a-f]{6})$/i.exec(String(value));if(!m)throw new Error('palette token is not a hex colour: '+value);const n=parseInt(m[1],16);return {r:(n>>16)&255,g:(n>>8)&255,b:n&255};};
  const edgeRgb=parseHex(renderer.color.slide.edge),fillRgb=parseHex(renderer.color.slide.fill),backgroundRgb=parseHex(renderer.palette.background);
  const dist=(a,b,c,p)=>Math.hypot(a-p[0],b-p[1],c-p[2]);
  const classify=(r,g,b)=>{
    const options=[['stroke',dist(edgeRgb.r,edgeRgb.g,edgeRgb.b,[r,g,b])],['fill',dist(fillRgb.r,fillRgb.g,fillRgb.b,[r,g,b])],['background',dist(backgroundRgb.r,backgroundRgb.g,backgroundRgb.b,[r,g,b])]];
    options.sort((a,b)=>a[1]-b[1]);
    return options[0][1]<24?options[0][0]:'other';
  };
  const box=(data,point)=>{
    const tally={stroke:0,fill:0,background:0,other:0,total:0};
    for(let y=Math.round(point.y)-3;y<=Math.round(point.y)+3;y++)for(let x=Math.round(point.x)-3;x<=Math.round(point.x)+3;x++){
      if(x<0||y<0||x>=canvas.width||y>=canvas.height){tally.outside++;continue;}
      const i=(y*canvas.width+x)*4;
      tally[classify(data[i],data[i+1],data[i+2])]++;tally.total++;
    }
    return tally;
  };
  return {speed,posPerZ,savedSpeed,scrollSpeed,notes:notes.length,
    widePolys:gWide.bodyPolys.length,narrowPolys:gNarrow.bodyPolys.length,
    buriedScreen:buried,exposedScreen:exposed,
    buriedCandidates:leftRailOnScreen.length,exteriorCandidates:exteriorCandidates.length,
    onScreen:{buried:onScreen(buried),exposed:onScreen(exposed)},
    edgeRgb,fillRgb,backgroundRgb,
    combinedBuried:box(combinedData,buried),legacyBuried:box(legacyData,buried),
    combinedExposed:box(combinedData,exposed),legacyExposed:box(legacyData,exposed)};
})()`);
console.log('CROSS-NOTE CANVAS PIXELS',JSON.stringify(crossNotePixels));
assert.ok(crossNotePixels,'cross-note real-canvas comparison must return results');
assert.equal(crossNotePixels.notes,2,'the cross-note fixture must project two distinct notes');
assert.equal(crossNotePixels.onScreen.buried,true,'the buried rail sample must be strictly on screen');
assert.equal(crossNotePixels.onScreen.exposed,true,'the exposed rail sample must be strictly on screen');
assert.ok(crossNotePixels.combinedBuried.stroke<=1,'the union must erase the rail the second note buries inside the first, got '+JSON.stringify(crossNotePixels.combinedBuried));
assert.ok(crossNotePixels.legacyBuried.stroke>0,'the legacy frame must paint the buried rail of the second note, got '+JSON.stringify(crossNotePixels.legacyBuried));
assert.ok(crossNotePixels.combinedExposed.stroke>0&&crossNotePixels.legacyExposed.stroke>0,'BOTH modes must keep the WIDE first note exterior rail ('+JSON.stringify({combined:crossNotePixels.combinedExposed,legacy:crossNotePixels.legacyExposed})+')');
assert.ok(crossNotePixels.combinedExposed.stroke>0,'the first note must not be swallowed by the union');
 const clicks=await evaluate('window.__clickCount');console.log('HIT SOUNDS',clicks);assert.ok(clicks>0,'Playing across notes must synthesize judgement clicks');
console.log('PLAY',await evaluate("({time:document.querySelector('#time').textContent,beat:document.querySelector('#beat').textContent,button:document.querySelector('#play').textContent})"));
await evaluate("document.querySelector('#play').click()");
assert.ok(await evaluate("parseFloat(document.querySelector('#time').textContent.split(':')[1])>15"));
 const setVolume=async(id,value)=>evaluate(`{const el=document.getElementById(${JSON.stringify(id)});el.value=${JSON.stringify(String(value))};el.dispatchEvent(new Event('input'));}`);
 const playVolumeWindow=async()=>{
   await evaluate("window.__volumeCheck.hits=[];document.querySelector('#seek').value='15';document.querySelector('#seek').dispatchEvent(new Event('input'));document.querySelector('#play').click()");
   await new Promise(r=>setTimeout(r,900));
   await evaluate("document.querySelector('#play').click()");
   return evaluate('({...window.__volumeCheck,hits:[...window.__volumeCheck.hits]})');
 };
 await setVolume('music-volume',0);await setVolume('hit-volume',0.43);
 const musicMuted=await playVolumeWindow();assert.equal(musicMuted.music,0);if(initial.audio==='LOCAL AUDIO')assert.equal(musicMuted.media,0);assert.ok(musicMuted.hits.length>0,'Music mute must leave hit sounds active');assert.ok(musicMuted.hits.every(v=>v===0.43),'Hit sounds must use their own selected gain');
 await setVolume('music-volume',0.31);await setVolume('hit-volume',0);
 const hitsMuted=await playVolumeWindow();assert.equal(hitsMuted.music,0.31);if(initial.audio==='LOCAL AUDIO')assert.equal(hitsMuted.media,0.31);assert.deepEqual(hitsMuted.hits,[],'Zero hit volume must suppress clicks without muting music');
 await setVolume('hit-volume',0.54);await evaluate("document.querySelector('#hit-sounds').checked=false;document.querySelector('#hit-sounds').dispatchEvent(new Event('change'))");
 const toggleMuted=await playVolumeWindow();assert.deepEqual(toggleMuted.hits,[]);assert.equal(toggleMuted.music,0.31);
 await evaluate("document.querySelector('#hit-sounds').checked=true;document.querySelector('#hit-sounds').dispatchEvent(new Event('change'))");
 const reenabled=await playVolumeWindow();assert.ok(reenabled.hits.length>0);assert.ok(reenabled.hits.every(v=>v===0.54),'Re-enabling Tap sounds must preserve selected hit volume');assert.equal(reenabled.music,0.31);
 await evaluate("window.__volumeCheck.hits=[];document.querySelector('#seek').value='40';document.querySelector('#seek').dispatchEvent(new Event('input'))");await new Promise(r=>setTimeout(r,100));assert.deepEqual(await evaluate('window.__volumeCheck.hits'),[],'Paused seek must not synthesize skipped hits');
 await evaluate("document.querySelector('#offset').dispatchEvent(new Event('change'))");await new Promise(r=>setTimeout(r,300));
 assert.equal(await evaluate('window.__volumeCheck.music'),0.31,'Reloading audio must preserve music volume');assert.equal(await evaluate("document.querySelector('#hit-volume').value"),'0.54');
 console.log('INDEPENDENT VOLUMES',JSON.stringify({musicMuted,hitsMuted,toggleMuted,reenabled}));
await backToSongs();await search('Herm');await clickDifficulty(herm,lunarHerm);await chartReady(herm,lunarHerm);
await evaluate("[...document.querySelectorAll('#difficulties .difficulty')].find(b=>b.textContent.includes('Crescent')).click()");await chartReady(herm,emptyHerm);
assert.equal(await evaluate('location.hash'),route(herm,emptyHerm));assert.equal(await evaluate("document.querySelector('#play').disabled && !document.querySelector('#empty-state').hidden"),true);
await backToSongs();await search('Luxe');await clickDifficulty(luxe,defaultLuxe);await chartReady(luxe,defaultLuxe);
assert.equal(await evaluate('window.__volumeCheck.music'),0.31,'Chart switching must preserve music gain');
 if(initial.audio==='LOCAL AUDIO')assert.equal(await evaluate('window.__volumeCheck.media'),0.31,'Loaded music media must retain its selected gain');
 const switched=await playVolumeWindow();assert.ok(switched.hits.length>0);assert.ok(switched.hits.every(v=>v===0.54),'Chart switching must preserve hit-sound gain');
 await setVolume('music-volume',0.7);await setVolume('hit-volume',0.7);
 await evaluate("document.querySelector('#search').value='';document.querySelector('#search').dispatchEvent(new Event('input'));document.querySelector('#seek').value='15';document.querySelector('#seek').dispatchEvent(new Event('input'));");
await new Promise(r=>setTimeout(r,100));
await screenshot('preview-desktop.png');
await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
await new Promise(r=>setTimeout(r,200));const mobileState=await evaluate("({overflow:document.documentElement.scrollWidth>innerWidth,width:document.documentElement.scrollWidth,canvasWidth:document.querySelector('canvas').getBoundingClientRect().width,stageWidth:document.querySelector('.stage').clientWidth})");console.log('MOBILE',mobileState);assert.equal(mobileState.overflow,false);assert.ok(mobileState.canvasWidth<=mobileState.stageWidth+2,'Canvas must resize to mobile stage');
await screenshot('preview-mobile.png');
console.log('ERRORS',JSON.stringify(errors));if(errors.length)process.exitCode=1;
}finally{socket?.close();browser.kill();}
