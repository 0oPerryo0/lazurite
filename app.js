import {parseChart,compileChart} from './engine.js';
import {PlayfieldRenderer} from './renderer.js';
import {PlaybackClock} from './audio.js';
import {HitSoundPlayer} from './hitsounds.js';

// Pure selection/navigation helpers are also used by the dependency-free Node tests.
export const catalogColumns=Object.freeze([{id:0,name:'Crescent',className:'crescent'},{id:1,name:'Lunar',className:'lunar'},{id:2,name:'Astral',className:'astral'},{id:3,name:'Bloodlust',className:'bloodlust'}]);
export function chartHash(songId,difficultyId){return '#/chart/'+encodeURIComponent(songId)+'/'+difficultyId;}
export const settingsHref='#settings';
export function resolveRoute(hash,library){
  if(!hash||hash==='#'||hash==='#songs')return {view:'catalog'};
  if(hash===settingsHref)return {view:'settings'};
  const match=/^#\/chart\/([^/]+)\/(\d+)$/.exec(hash);
  if(!match)return {view:'catalog',error:'That chart link is invalid. Choose a difficulty below.'};
  let id;try{id=decodeURIComponent(match[1]);}catch{return {view:'catalog',error:'That chart link is invalid. Choose a difficulty below.'};}
  const song=library.find(s=>s.id===id),difficultyId=Number(match[2]);
  if(!song||!song.difficulties.some(d=>d.id===difficultyId))return {view:'catalog',error:'That song or difficulty is unavailable. Choose a recovered record below.'};
  return {view:'viewer',song,difficultyId};
}
export function filterCatalog(library,query){const q=String(query||'').trim().toLocaleLowerCase();return library.filter(s=>(s.title+' '+s.artist+' '+s.id).toLocaleLowerCase().includes(q));}
export function catalogCounts(songs){return {songs:songs.length,difficulties:songs.reduce((n,s)=>n+s.difficulties.length,0)};}
export function resourceVariant(song,library){const duplicate=library.filter(s=>s.title===song.title).length>1;return duplicate?(song.difficulties.every(d=>d.id>3)?'Additional resource variant':'Standard resource variant'):'';}
// The viewer's chart title, used both when a chart is opened and when the settings screen returns
// to a parked chart (whose document title was replaced by the settings screen's own title).
// The catalog's document title; it matches index.html's static <title> so crawlers see one name.
export const catalogDocumentTitle='Lazurite · Crystallium chart viewer';
export function chartDocumentTitle(song,difficulty){return song&&difficulty?`${song.title} · ${difficulty.name} · Lazurite`:'Lazurite';}
// Same title, derived straight from a deep-link route so it can be restored before the chart JSON
// has arrived (the route already names the record; the parsed chart JSON is not required).
export function chartDocumentTitleForRoute(hash,library){
  const match=/^#\/chart\/([^/]+)\/(\d+)$/.exec(String(hash||''));
  if(!match)return 'Lazurite';
  let id;try{id=decodeURIComponent(match[1]);}catch{return 'Lazurite';}
  const song=(library||[]).find(s=>s.id===id);
  return chartDocumentTitle(song,song?.difficulties.find(d=>d.id===Number(match[2])));
}

// Local, browser-only display preference. Unreadable, malformed or throwing storage (a
// disabled/full localStorage, hand-edited JSON, a JSON scalar or a wrong-typed field) all
// fall back to the default, so a bad value can never break startup. Nothing is uploaded.
export const settingsStorageKey='crystallium.settings.v1';
export const defaultSettings=Object.freeze({showOverlappingSlides:false});
export function readShowOverlappingSlides(storage){
  try{
    const raw=(storage||globalThis.localStorage)?.getItem(settingsStorageKey);
    if(typeof raw!=='string'||raw==='')return defaultSettings.showOverlappingSlides;
    const parsed=JSON.parse(raw);
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return defaultSettings.showOverlappingSlides;
    const stored=parsed.showOverlappingSlides;
    return typeof stored==='boolean'?stored:defaultSettings.showOverlappingSlides;
  }catch{return defaultSettings.showOverlappingSlides;}
}
export function writeShowOverlappingSlides(storage,checked){
  try{(storage||globalThis.localStorage)?.setItem(settingsStorageKey,JSON.stringify({showOverlappingSlides:checked===true}));return true;}catch{return false;}
}

// The published folder is its own root: a static host (including a GitHub Pages project site under
// /<repo>/) serves the catalog and charts as plain files next to the page. These URLs are resolved
// relative to this module, so the same build works from a domain root and from a sub-path. The
// local `server.mjs` serves the very same files at these paths; its API aliases stay for existing
// tooling but nothing here depends on them.
export const libraryPath='./library.json';
export function chartPath(songId){return './charts/'+encodeURIComponent(songId)+'.json';}

// Called inside the serialized audio queue. A stale load may resume its captured
// wasPlaying state, so pause both before loading and on every stale completion.
export async function loadGuardedAudio(clock,url,options,isCurrent){
  if(!isCurrent())return false;
  clock.pause();await clock.load(url,options);
  if(!isCurrent()){clock.pause();return false;}
  return true;
}

// Puts playback to sleep for a non-viewer screen WITHOUT touching the load generation or an
// in-flight request: stop the clock, the pending auto-play intent, any timeline scrub and the
// click sounds, so a chart that is still loading can settle into a hidden viewer (paused) and be
// reused on return. This is the settings-pause half of the park semantics; abandoning a chart
// still uses the app's own cancel (generation bump + fetch abort).
export function pausePlaybackForHiddenViewer({clock,hitsounds}={}){
  clock?.pause?.();
  hitsounds?.stop?.();
  return {desiredPlaying:false,scrubbing:false,playing:!!clock?.playing};
}
export async function startApp(){
  const $=id=>document.getElementById(id);
  const renderer=new PlayfieldRenderer($('playfield'));
  const hitsounds=new HitSoundPlayer();
  for(const [kind,color] of Object.entries({tap:renderer.color.tap.fill,slide:renderer.color.slide.fill,bullet:renderer.color.bullet.fill,void:'#bac3da'}))document.querySelector('.legend.'+kind).style.background=color;
  const clock=new PlaybackClock({endBehavior:'continue',volume:Number($('music-volume').value)});
  hitsounds.volume=Number($('hit-volume').value);
  let library=[],current=null,compiled=null,selectedId=null,loadGeneration=0,customAudio=null,objectUrl=null,scrubbing=false,lastPlaying=null,desiredPlaying=false,lastAudioBadge=null;
  let viewerActive=false,activeRoute=null,lastCatalogHash=null,chartRequest=null,audioQueue=Promise.resolve(),catalogPosition={top:0,left:0,focus:null};
  // Settings is a third screen, never a second viewer: `viewerActive` goes false so the frame
  // loop, renderer, hit sounds and keyboard shortcuts are all inactive while it is open. The
  // chart session is parked in `settingsSession` (a paused snapshot) and resumed on return.
  let settingsOpen=false,settingsSession=null,settingsReturn=null,lastSettingsLink=null;
  function queueAudio(task){const next=audioQueue.then(task,task);audioQueue=next.catch(()=>{});return next;}
  const typeNames=['Tap','Slide','Bullet','Void','Dash'];
  const status=text=>{$('status').textContent=text;};
  function formatTime(seconds,precise=false){const raw=Math.max(0,Number(seconds)||0),t=precise?Math.round(raw*1000)/1000:raw,minutes=Math.floor(t/60),s=t%60;return String(minutes).padStart(2,'0')+':'+(precise?s.toFixed(3).padStart(6,'0'):String(Math.floor(s)).padStart(2,'0'));}
  function button(label,cls,fn){const b=document.createElement('button');b.type='button';b.className=cls;b.textContent=label;b.addEventListener('click',fn);return b;}
  function difficultyLink(song,d,catalog=false){
    const a=document.createElement('a');a.href=chartHash(song.id,d.id);a.dataset.songId=song.id;a.dataset.difficultyId=String(d.id);a.className=catalog?'catalog-difficulty '+(catalogColumns.find(c=>c.id===d.id)?.className||'eclipse'):'difficulty';
    a.setAttribute('aria-label',`${song.title}, ${d.name}, level ${d.rating}, ${d.noteCount.toLocaleString()} notes, resource ${song.id}`);
    const name=document.createElement('span');name.className='difficulty-name';name.textContent=d.name;
    const rating=document.createElement('b');rating.className='difficulty-rating';const level=document.createElement('small');level.textContent='Lv. ';rating.append(level,document.createTextNode(String(d.rating)));
    const notes=document.createElement('span');notes.className='difficulty-notes';notes.textContent=d.noteCount.toLocaleString()+' notes';a.append(name,rating,notes);
    a.addEventListener('click',event=>{if(event.button!==0||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;event.preventDefault();if(catalog)catalogPosition.focus=a;navigate(a.hash,catalog?a:null);});
    return a;
  }
  function showLibrary(){
    const songs=filterCatalog(library,$('search').value),counts=catalogCounts(songs);$('song-list').replaceChildren();
    $('result-count').textContent=`${counts.songs} ${counts.songs===1?'song':'songs'} · ${counts.difficulties} ${counts.difficulties===1?'difficulty':'difficulties'} shown`;
    $('clear-search').disabled=!$('search').value;$('no-results').hidden=songs.length>0;
    for(const song of songs){
      const row=document.createElement('tr');row.className='song-row';row.dataset.songId=song.id;
      const info=document.createElement('td');info.className='song-info';const title=document.createElement('strong');title.className='song-title';title.textContent=song.title;
      const artist=document.createElement('span');artist.className='song-artist';artist.textContent=song.artist;
      const resource=document.createElement('span');resource.className='song-resource';const variant=resourceVariant(song,library);if(variant){const label=document.createElement('span');label.className='variant-label';label.textContent=variant+' · ';resource.append(label);}resource.append(document.createTextNode(song.id));const shortId=document.createElement('span');shortId.className='resource-short';shortId.textContent='ID '+song.id.slice(-12);resource.append(shortId);info.append(title,artist,resource);
      const additional=song.difficulties.filter(d=>!catalogColumns.some(c=>c.id===d.id));if(additional.length){const extra=document.createElement('div');extra.className='additional-difficulty';const label=document.createElement('span');label.textContent='Additional recovered difficulty';extra.append(label,...additional.map(d=>difficultyLink(song,d,true)));info.append(extra);}
      row.append(info);
      for(const column of catalogColumns){const cell=document.createElement('td'),d=song.difficulties.find(d=>d.id===column.id);if(d){cell.className='difficulty-cell '+column.className;cell.append(difficultyLink(song,d,true));}else{const missing=document.createElement('span');missing.className='missing-difficulty';missing.textContent='—';missing.setAttribute('aria-label',column.name+' unavailable');cell.append(missing);}row.append(cell);}
      $('song-list').append(row);
    }
  }
  function cancelPlayback(){
    ++loadGeneration;chartRequest?.abort();chartRequest=null;desiredPlaying=false;clock.pause();hitsounds.stop();scrubbing=false;$('play').disabled=true;
  }
  // A chart session stays "live" while it is visible OR parked behind the settings screen, so a
  // request that started from the viewer can settle while settings is open. Abandoning the chart
  // (catalog, a different chart, or the app's own cancelPlayback) bumps the generation instead.
  function chartSessionLive(){return viewerActive||settingsOpen;}
  // Music may start again only when the viewer is actually visible; the settings screen never
  // auto-plays, no matter which async chart/audio continuation settles during the visit.
  function canAutoPlay(){return viewerActive&&!settingsOpen;}
  // The preference is restored before the first frame, so the checkbox reflects stored state
  // and the viewer renders from the same value. A malformed stored value stays unchecked.
  function showSettingsControls(){$('show-overlapping-slides').checked=readShowOverlappingSlides();}
  function showSettings(){
    settingsOpen=true;
    $('catalog-view').hidden=true;$('viewer-view').hidden=true;$('settings-view').hidden=false;
    $('inspect-toggle').hidden=true;$('count').hidden=true;document.title='Settings · Lazurite';
    $('settings-origin').textContent=settingsReturn&&settingsReturn!=='#songs'?'Back returns to the chart you opened; it stays paused.':'Back returns to the catalog.';
    requestAnimationFrame(()=>{if(settingsOpen&&!$('settings-view').hidden)$('settings-title').focus({preventScroll:true});});
  }
  // Opening settings PARKS the viewer session instead of ending it: the load generation and any
  // in-flight chart/audio request are left untouched, so a partially loaded chart can finish
  // while settings is open. `viewerActive=false` makes the frame loop, renderer, hit sounds and
  // viewer keyboard shortcuts inactive; playback and clicks are paused here, and every async
  // continuation that could resume them is gated on the chart session still being visible (see
  // `chartSessionLive`), so nothing is ever auto-started by this flow.
  //   - Chart not compiled yet: the pending request finishes into a hidden viewer, paused.
  //   - Chart already compiled: the same compiled data, clock time, audio, selection, volumes,
  //     rate and scroll speed are kept for return; no music plays while settings is open.
  function pauseForSettings(){
    const parked=pausePlaybackForHiddenViewer({clock,hitsounds});
    desiredPlaying=parked.desiredPlaying;scrubbing=parked.scrubbing;
  }
  // `event` is the click event when a settings link was activated; reading the clicked link here
  // keeps it available for return focus after JS navigation moves focus for the chart request.
  function captureSettingsSession(event){
    const viewerSession=viewerActive&&activeRoute?activeRoute:null;
    settingsReturn=viewerSession||'#songs';
    settingsSession=viewerSession?{route:viewerSession,time:clock.time,song:current}:null;
    const settingsFallback=$('settings-link');
    const active=document.activeElement;
    lastSettingsLink=event?.currentTarget||(active?.matches?.('a[href="#settings"]')?active:settingsFallback);
    if(!viewerSession){     // catalog origin: remember where the catalog was for the return trip
      catalogPosition.top=window.scrollY;catalogPosition.left=$('catalog-scroll').scrollLeft;
      catalogPosition.focus=active?.closest?.('a.catalog-difficulty')||catalogPosition.focus;
    }
    viewerActive=false;               // settings is not the viewer: no frame/render/hitsounds/keyboard
    pauseForSettings();
  }
  // One entry path for every way in: a catalogue/viewer link, a direct #settings load, or a
  // Back/Forward into it. A recognized route without a captured session (direct link or history
  // navigation) simply returns to the catalog.
  function openSettings(event){
    if(settingsOpen)return;
    captureSettingsSession(event);
    showSettings();
    if(location.hash!==settingsHref)history.pushState(null,'',settingsHref);
  }
  // Returns to the origin route. A catalog origin did not take the viewer path at all, so
  // `showCatalog`'s wasViewer branch cannot restore the scroll position or link focus here; this
  // restores the captured catalog state for both cases.
  function closeSettings(){
    const returnKey=settingsReturn||'#songs';settingsReturn=null;settingsOpen=false;
    const wasViewer=viewerActive;
    lastCatalogHash=null;
    if(location.hash!==returnKey)history.pushState(null,'',returnKey);
    applyRoute(null);
    if(!wasViewer&&!viewerActive&&!settingsOpen)requestAnimationFrame(()=>{
      if(viewerActive||settingsOpen)return;
      $('catalog-scroll').scrollLeft=catalogPosition.left;
      (catalogPosition.focus?.isConnected?catalogPosition.focus:$('settings-link')).focus({preventScroll:true});
      window.scrollTo(0,catalogPosition.top);
    });
  }
  // Return to the parked chart WITHOUT rebuilding it: the same compiled data, clock time, audio
  // source, volumes, rate, scroll speed and selection. Playback stays paused — returning from
  // settings never resumes music, even if the chart was playing before. Redeeming a still-pending
  // request is the point of the park: the tab title is restored from the route straight away (the
  // record is already named by the route, so it does not wait for the chart JSON), while Play stays
  // disabled and loadSong's own continuation fills in the parsed metadata when the request settles.
  function resumeSettingsSession(){
    const session=settingsSession;settingsSession=null;
    viewerActive=true;settingsOpen=false;
    $('catalog-view').hidden=true;$('settings-view').hidden=true;$('viewer-view').hidden=false;$('inspect-toggle').hidden=false;
    $('count').hidden=false;desiredPlaying=false;clock.pause();hitsounds.stop();
    if(session&&Number.isFinite(session.time))clock.seek(Math.max(0,Math.min(compiled?.duration??session.time,session.time)));
    hitsounds.reset(clock.time);
    const parkedRoute=session?.route||null;
    requestAnimationFrame(()=>{
      if(!viewerActive||settingsOpen)return;
      renderer.resize();
      // Restore the parked chart's tab title from the route itself, so returning before the chart
      // JSON settles does not leave "Settings · Lazurite" behind. Only for the exact parked
      // route: any other navigation owns the title through openViewer/loadSong.
      if(parkedRoute&&activeRoute===parkedRoute)document.title=chartDocumentTitleForRoute(parkedRoute,library);
      const target=lastSettingsLink?.isConnected?lastSettingsLink:$('title');
      if(target.focus)target.focus({preventScroll:true});
      lastSettingsLink=null;
    });
  }
  function showCatalog(message=''){
    const wasViewer=viewerActive;cancelPlayback();viewerActive=false;activeRoute=null;current=null;compiled=null;selectedId=null;hitsounds.setChart(null);
    settingsOpen=false;settingsSession=null;settingsReturn=null;$('settings-view').hidden=true;$('count').hidden=false;
    if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl=null;}customAudio=null;$('audio-file').value='';
    $('viewer-view').hidden=true;$('inspect-toggle').hidden=true;$('catalog-view').hidden=false;
    $('catalog-message').textContent=message;$('catalog-message').hidden=!message;document.title=catalogDocumentTitle;
    // Clear a completed or in-flight audio source only after its serialized load settles.
    const generation=loadGeneration;queueAudio(async()=>{if(generation!==loadGeneration||viewerActive)return;await clock.load(null);clock.pause();});
    if(wasViewer)requestAnimationFrame(()=>{if(viewerActive)return;$('catalog-scroll').scrollLeft=catalogPosition.left;(catalogPosition.focus?.isConnected?catalogPosition.focus:$('search')).focus({preventScroll:true});window.scrollTo(0,catalogPosition.top);});
  }
  function openViewer(song,id,sourceFocus){
    // A new chart always leaves the settings screen: its layout must be re-measured while visible.
    settingsOpen=false;$('settings-view').hidden=true;$('count').hidden=false;
    if(!viewerActive){catalogPosition.top=window.scrollY;catalogPosition.left=$('catalog-scroll').scrollLeft;catalogPosition.focus=sourceFocus||($('catalog-view').contains(document.activeElement)?document.activeElement:catalogPosition.focus);}
    viewerActive=true;$('catalog-view').hidden=true;$('viewer-view').hidden=false;$('inspect-toggle').hidden=false;
    const d=song.difficulties.find(d=>d.id===id);$('breadcrumb').textContent=`Songs / ${song.title} / ${d.name} · Lv. ${d.rating}`;$('resource-id').textContent=song.id;
    $('title').textContent=song.title;$('artist').textContent=song.artist;$('note-count').textContent='—';$('empty-state').hidden=true;$('difficulties').replaceChildren();
    for(const difficulty of song.difficulties){const a=difficultyLink(song,difficulty);a.classList.toggle('active',difficulty.id===id);if(difficulty.id===id)a.setAttribute('aria-current','true');$('difficulties').append(a);}
    document.title=chartDocumentTitle(song,d);
    // Hidden canvases have no layout size: resize only AFTER the viewer becomes visible.
    const openedRoute=chartHash(song.id,id);requestAnimationFrame(()=>{if(!viewerActive||activeRoute!==openedRoute)return;renderer.resize();window.scrollTo(0,0);$('title').focus({preventScroll:true});});
  }
  function navigate(hash,sourceFocus=null){lastCatalogHash=null;if(location.hash!==hash)history.pushState(null,'',hash);applyRoute(sourceFocus);}
  function applyRoute(sourceFocus=null){
    const route=resolveRoute(location.hash,library);
    if(route.view==='settings'){
      // One entry path for every way in: a catalog/viewer link, a direct #settings load, or a
      // Back/Forward into it. A direct link has no viewer session, so Back returns to the catalog.
      if(!settingsOpen){if(!settingsReturn)settingsReturn='#songs';openSettings(null);}
      lastCatalogHash=settingsHref;return;
    }
    if(route.view==='catalog'){settingsOpen=false;$('settings-view').hidden=true;$('count').hidden=false;if(!viewerActive&&lastCatalogHash===location.hash&&!route.error)return;if(route.error)history.replaceState(null,'','#songs');lastCatalogHash=location.hash;showCatalog(route.error);return;}
    lastCatalogHash=null;const key=chartHash(route.song.id,route.difficultyId);
    // The parked chart is reclaimed even when its fetch has NOT settled yet: the pending request
    // belongs to this same route, so reusing it (rather than cancelling and re-fetching) is the
    // point of the park. `resumeSettingsSession` keeps the loading title and disabled Play until
    // that request's own continuation produces the compiled chart.
    if(settingsSession&&settingsSession.route===key&&current===route.song){activeRoute=key;resumeSettingsSession();return;}
    if(viewerActive&&activeRoute===key&&!settingsOpen)return;
    settingsSession=null;settingsOpen=false;$('settings-view').hidden=true;activeRoute=key;openViewer(route.song,route.difficultyId,sourceFocus);loadSong(route.song,route.difficultyId);
  }
  // Entering settings parks the session without bumping the generation, so a chart request that
  // started from the viewer is still allowed to finish while settings is open: `chartSessionLive`
  // accepts both the visible viewer and the settings screen. Readiness (play disabled, empty
  // difficulty) is applied then; `canAutoPlay` refuses every path that could start music while
  // settings is open. The generation check still rejects superseded loads.
  async function loadSong(song,id){
    cancelPlayback();const generation=loadGeneration;current=song;compiled=null;selectedId=null;customAudio=null;renderer.setChart(null);hitsounds.setChart(null);clock.seek(0);
    if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl=null;}$('audio-file').value='';$('note-detail').hidden=true;$('selection-hint').hidden=false;$('events').replaceChildren();$('event-count').textContent='';status('Loading '+song.title+'…');
    const sessionCurrent=()=>generation===loadGeneration&&chartSessionLive();
    chartRequest=new AbortController();
    try{
      const response=await fetch(chartPath(song.id),{signal:chartRequest.signal});if(!response.ok)throw new Error('Chart request failed');const raw=await response.json();if(!sessionCurrent())return;
      const chart=parseChart(raw,song.id);compiled=compileChart(chart,id);renderer.setChart(compiled);hitsounds.setChart(compiled);$('title').textContent=chart.title;$('artist').textContent=chart.artist;$('note-count').textContent=compiled.notes.length.toLocaleString();$('offset').value=String(chart.offset||0);$('duration').textContent=formatTime(compiled.duration);$('seek').max=String(compiled.duration||1);$('empty-state').hidden=compiled.notes.length>0;showEvents();showSelection();
      const chartOffset=chart.offset||0;await queueAudio(async()=>{if(!await loadGuardedAudio(clock,song.audioUrl,{offset:chartOffset},sessionCurrent))return;clock.setRate(Number($('rate').value));clock.setVolume(Number($('music-volume').value));});
      if(!sessionCurrent())return;$('audio-status').textContent=clock.status.mode==='audio'?'LOCAL AUDIO':'SILENT PREVIEW';$('audio-help').textContent=(song.audioFilename?'Expected: '+song.audioFilename+'. ':'')+'Audio stays local; attach a matching file if needed.';$('play').disabled=compiled.notes.length===0;status(compiled.notes.length?`Ready · ${compiled.notes.length.toLocaleString()} chart objects. ${clock.status.mode==='audio'?'Candidate local audio loaded (alignment unverified).':'No usable audio; chart can run silently.'}`:'Empty difficulty preserved from the resource. Playback is disabled.');
    }catch(error){if(!sessionCurrent()||error.name==='AbortError')return;status('Chart could not be loaded: '+error.message);console.error(error);}
  }
  function showEvents(){const events=(compiled?.events||[]).filter(e=>e.kind!=='note'&&e.kind!=='measureLine');$('event-count').textContent=String(events.length);$('events').replaceChildren();for(const event of events.slice(0,300)){const t=Number(event.time??compiled.timeAt(event.beat??0));const label=event.type??event.kind??'event';const b=button('','event',()=>seek(t));const kind=document.createElement('span');kind.textContent=String(label)+' · '+String(event.bpm??event.factor??event.value??event.group??'');const stamp=document.createElement('span');stamp.textContent=formatTime(t);b.append(kind,stamp);$('events').append(b);}if(events.length>300){const p=document.createElement('p');p.className='helper';p.textContent='Showing the first 300 events.';$('events').append(p);}}
  function showSelection(){const n=compiled?.notes.find(n=>n.id===selectedId);$('selection-hint').hidden=!!n;$('note-detail').hidden=!n;if(n)$('note-detail').textContent=JSON.stringify({id:n.id,type:typeNames[n.type]||n.type,group:n.group,scrollMod:n.scrollMod,direction:n.direction,points:n.points},null,2);}
  function seek(t){if(!canAutoPlay()||!compiled)return;clock.seek(Math.max(0,Math.min(compiled.duration,Number(t)||0)));hitsounds.reset(clock.time);}
  async function togglePlay(){if(!canAutoPlay()||!compiled?.notes.length||$('play').disabled)return;const generation=loadGeneration;try{desiredPlaying=!desiredPlaying;if(!desiredPlaying){clock.pause();hitsounds.stop();}else{hitsounds.unlock();if(clock.time>=compiled.duration)clock.seek(0);hitsounds.reset(clock.time);await clock.play();if(generation!==loadGeneration||!canAutoPlay()||!desiredPlaying)clock.pause();if(generation!==loadGeneration)return;}}catch(error){if(generation!==loadGeneration||!canAutoPlay())return;status('Playback unavailable: '+error.message);}}
  $('search').addEventListener('input',showLibrary);$('clear-search').addEventListener('click',()=>{$('search').value='';showLibrary();$('search').focus();});$('back-to-songs').addEventListener('click',()=>navigate('#songs'));
  window.addEventListener('hashchange',()=>{if(library.length)applyRoute();});window.addEventListener('popstate',()=>{if(library.length)applyRoute();});
  $('play').addEventListener('click',togglePlay);$('restart').addEventListener('click',()=>seek(0));$('forward').addEventListener('click',()=>seek(clock.time+5));$('seek').addEventListener('input',()=>seek($('seek').value));$('rate').addEventListener('change',()=>clock.setRate(Number($('rate').value)));$('music-volume').addEventListener('input',()=>clock.setVolume(Number($('music-volume').value)));$('hit-volume').addEventListener('input',()=>{hitsounds.volume=Number($('hit-volume').value);if(hitsounds.volume===0)hitsounds.stop();});$('scroll').addEventListener('input',()=>{$('scroll-value').textContent=Number($('scroll').value).toFixed(2)+'×';});$('jump-button').addEventListener('click',()=>seek($('jump').value));$('jump').addEventListener('keydown',e=>{if(e.key==='Enter')seek(e.target.value);});
  $('inspect-toggle').addEventListener('click',()=>{const hidden=document.querySelector('.desk').classList.toggle('inspector-hidden');$('inspector').hidden=hidden;$('inspect-toggle').setAttribute('aria-expanded',String(!hidden));renderer.resize();});
  async function reloadAudio(){if(!viewerActive||!compiled)return;const generation=loadGeneration,url=customAudio||current.audioUrl,offset=Number($('offset').value)||0;clock.pause();hitsounds.stop();await queueAudio(async()=>{if(!await loadGuardedAudio(clock,url,{offset},()=>generation===loadGeneration&&chartSessionLive()))return;clock.setRate(Number($('rate').value));clock.setVolume(Number($('music-volume').value));if(desiredPlaying&&canAutoPlay())await clock.play();if(generation!==loadGeneration||!canAutoPlay()||!desiredPlaying)clock.pause();});}
  $('offset').addEventListener('change',()=>reloadAudio().catch(e=>{if(viewerActive)status(e.message);}));
  $('audio-file').addEventListener('change',async()=>{const file=$('audio-file').files[0];if(!file||!viewerActive||!compiled)return;const generation=loadGeneration;if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=URL.createObjectURL(file);customAudio=objectUrl;try{await reloadAudio();if(generation!==loadGeneration||!viewerActive)return;$('audio-status').textContent=clock.status.mode==='audio'?'ATTACHED LOCAL AUDIO':'SILENT PREVIEW';$('audio-help').textContent=file.name+' · locally attached, mapping not verified';status(clock.status.mode==='audio'?'Local audio attached. Adjust the offset if needed.':'Audio could not be decoded; silent preview remains available.');}catch(error){if(generation!==loadGeneration||!viewerActive)return;status('Audio could not be loaded: '+error.message);}});
  $('playfield').addEventListener('click',event=>{if(!viewerActive||!compiled)return;const rect=$('playfield').getBoundingClientRect();selectedId=renderer.pick(event.clientX-rect.left,event.clientY-rect.top);showSelection();});
  $('seek').addEventListener('pointerdown',()=>{if(viewerActive)scrubbing=true;});window.addEventListener('pointerup',()=>{scrubbing=false;});window.addEventListener('blur',()=>{scrubbing=false;});$('seek').addEventListener('pointercancel',()=>{scrubbing=false;});$('seek').addEventListener('keydown',e=>{if(canAutoPlay()&&(e.key==='ArrowLeft'||e.key==='ArrowRight')){e.preventDefault();seek(clock.time+(e.key==='ArrowRight'?1:-1));}});
  document.addEventListener('keydown',e=>{if(!canAutoPlay()||e.repeat||e.altKey||e.ctrlKey||e.metaKey)return;if(e.target.closest('input,select,textarea,button,a'))return;if(e.code==='Space'){e.preventDefault();togglePlay();}else if(e.code==='ArrowLeft'){e.preventDefault();seek(clock.time-5);}else if(e.code==='ArrowRight'){e.preventDefault();seek(clock.time+5);}});
  $('playfield').addEventListener('keydown',e=>{if(!canAutoPlay()||!compiled?.notes.length||!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();e.stopPropagation();desiredPlaying=false;clock.pause();hitsounds.stop();const i=compiled.notes.findIndex(n=>n.id===selectedId);const next=Math.max(0,Math.min(compiled.notes.length-1,i+(e.key==='ArrowRight'?1:-1)));const note=compiled.notes[next];selectedId=note.id;seek(note.points[0].time);showSelection();});
  window.addEventListener('resize',()=>{if(viewerActive)renderer.resize();});$('hit-sounds').addEventListener('change',()=>{hitsounds.enabled=$('hit-sounds').checked;if(hitsounds.enabled&&viewerActive)hitsounds.unlock();else hitsounds.stop();});
  // Settings screen: a dedicated third route reachable from the catalog and the viewer, with an
  // explicit back control that returns to the exact originating hash. The preference is local
  // to this browser only (no upload, no account) and a malformed stored value reads as unchecked.
  showSettingsControls();
  $('show-overlapping-slides').addEventListener('change',()=>writeShowOverlappingSlides(undefined,$('show-overlapping-slides').checked));
  $('settings-link').addEventListener('click',event=>{if(event.button!==0||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;event.preventDefault();openSettings(event);});
  $('settings-back').addEventListener('click',()=>closeSettings());
  function frame(){
    if(!viewerActive){requestAnimationFrame(frame);return;}
    const t=clock.time;hitsounds.update(t,clock.playing,clock.rate);const badge=clock.status.mode==='audio'?(customAudio?'ATTACHED LOCAL AUDIO':'LOCAL AUDIO'):'SILENT PREVIEW';if(lastAudioBadge!==badge){lastAudioBadge=badge;$('audio-status').textContent=badge;}if(compiled&&t>=compiled.duration&&clock.playing){desiredPlaying=false;clock.pause();hitsounds.stop();clock.seek(compiled.duration);}$('time').textContent=formatTime(t,true);if(!scrubbing)$('seek').value=String(Math.max(0,t));$('seek').setAttribute('aria-valuetext',formatTime(t,true));if(compiled){$('beat').textContent=compiled.beatAt(t).toFixed(2);$('bpm').textContent=String(Math.round(compiled.bpmAt(t)*100)/100);}const playing=clock.playing;if(lastPlaying!==playing){lastPlaying=playing;$('play').querySelector('span').textContent=playing?'Pause':'Play';$('play').setAttribute('aria-label',playing?'Pause chart':'Play chart');$('play').querySelector('path').setAttribute('d',playing?'M7 5h4v14H7ZM14 5h4v14h-4Z':'m8 5 11 7-11 7Z');}renderer.render(t,{scrollSpeed:Number($('scroll').value),overlays:$('overlays').checked,selectedId,showOverlappingSlides:$('show-overlapping-slides').checked});requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  try{const response=await fetch(libraryPath);if(!response.ok)throw new Error('Catalog unavailable');const data=await response.json();library=data.charts;const counts=catalogCounts(library);$('count').textContent=`${counts.songs} songs · ${counts.difficulties} difficulties`;showLibrary();if(!library.length){$('catalog-message').textContent='No chart resources were found.';$('catalog-message').hidden=false;}else applyRoute();}catch(error){$('catalog-message').textContent='Collection could not be loaded: '+error.message;$('catalog-message').hidden=false;console.error(error);}
}
if(typeof document!=='undefined')startApp();
