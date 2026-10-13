import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {catalogColumns,chartHash,resolveRoute,filterCatalog,catalogCounts,resourceVariant,loadGuardedAudio,pausePlaybackForHiddenViewer,chartDocumentTitle,chartDocumentTitleForRoute,settingsHref,settingsStorageKey,defaultSettings,readShowOverlappingSlides,writeShowOverlappingSlides,libraryPath,chartPath} from './app.js';
const names=['Crescent','Lunar','Astral','Bloodlust','Eclipse'];
const library=[];
for(const file of await readdir(new URL('./charts/',import.meta.url))){
  if(!file.endsWith('.json'))continue;
  const raw=JSON.parse(await readFile(new URL('./charts/'+file,import.meta.url),'utf8'));
  library.push({id:file.slice(0,-5),title:raw[4],artist:raw[5],difficulties:raw[2].map(d=>({id:d[1],name:names[d[1]],rating:d[2],noteCount:d[3].length}))});
}
test('catalog preserves all21 resources and63 real difficulty records',()=>{assert.deepEqual(catalogCounts(library),{songs:21,difficulties:63});assert.deepEqual(catalogColumns.map(c=>[c.id,c.name]),[[0,'Crescent'],[1,'Lunar'],[2,'Astral'],[3,'Bloodlust']]);const extra=library.flatMap(s=>s.difficulties.filter(d=>!catalogColumns.some(c=>c.id===d.id)));assert.equal(extra.length,2);assert.ok(extra.every(d=>d.name==='Eclipse'));});
test('every actual difficulty round-trips through its exact deep link',()=>{for(const song of library)for(const difficulty of song.difficulties){const route=resolveRoute(chartHash(song.id,difficulty.id),library);assert.equal(route.view,'viewer');assert.equal(route.song,song);assert.equal(route.difficultyId,difficulty.id);}});
test('tutorial labels use actual id rather than array position',()=>{for(const prefix of ['Advanced_Tutorial','Training_1','Training_2','Training_3']){const song=library.find(s=>s.id.startsWith(prefix));assert.equal(song.difficulties[0].id,1);assert.equal(resolveRoute(chartHash(song.id,0),library).view,'catalog');assert.equal(resolveRoute(chartHash(song.id,1),library).view,'viewer');}});
test('empty Hermóðr remains a selectable Crescent level5 record',()=>{const song=library.find(s=>s.title==='Hermóðr'),d=song.difficulties.find(d=>d.id===0);assert.equal(d.noteCount,0);assert.equal(d.rating,5);assert.equal(resolveRoute(chartHash(song.id,0),library).view,'viewer');});
test('duplicate titles are retained and distinguishable by resource variant/id',()=>{const songs=filterCatalog(library,'Forgotten Mission');assert.equal(songs.length,2);assert.equal(new Set(songs.map(s=>s.id)).size,2);assert.deepEqual(songs.map(s=>resourceVariant(s,library)).sort(),['Additional resource variant','Standard resource variant']);assert.equal(songs.reduce((n,s)=>n+s.difficulties.length,0),5);});
test('search is case-insensitive across title, artist and exact resource id',()=>{assert.equal(filterCatalog(library,'lUxE cHaIn').length,1);assert.equal(filterCatalog(library,' LUNDY ').length,1);assert.equal(filterCatalog(library,'黒魔').length,2);assert.equal(filterCatalog(library,'Hermóðr').length,1);assert.equal(filterCatalog(library,'Training_1_cf15de000072').length,1);assert.equal(filterCatalog(library,'NOT A REAL SONG').length,0);assert.equal(filterCatalog(library,' ').length,21);});
test('serialized audio reload pauses captured playback and stale completion even inside a new viewer',async()=>{
  let generation=1,finish,wasPlaying;const clock={playing:true,pause(){this.playing=false;},load(){wasPlaying=this.playing;return new Promise(resolve=>{finish=()=>{this.playing=true;resolve();};});}};
  const pending=loadGuardedAudio(clock,'old.wav',{},()=>generation===1);assert.equal(wasPlaying,false);generation=2;finish();assert.equal(await pending,false);assert.equal(clock.playing,false);
  let calls=0;assert.equal(await loadGuardedAudio({pause(){calls++;},load(){calls++;}},'never.wav',{},()=>false),false);assert.equal(calls,0);
});
test('current guarded audio load stays paused for caller-controlled playback',async()=>{const clock={playing:true,pause(){this.playing=false;},async load(){assert.equal(this.playing,false);}};assert.equal(await loadGuardedAudio(clock,'current.wav',{},()=>true),true);assert.equal(clock.playing,false);});
test('catalog aliases require no auto-selected chart',()=>{for(const hash of ['', '#', '#songs'])assert.deepEqual(resolveRoute(hash,library),{view:'catalog'});});
test('settings is its own third-screen hash route, not a chart or catalog alias',()=>{assert.equal(settingsHref,'#settings');assert.deepEqual(resolveRoute('#settings',library),{view:'settings'});for(const hash of ['#Settings','#setting','#settings/','#settings ','#/settings','#/chart/settings/0']){const route=resolveRoute(hash,library);assert.equal(route.view,'catalog',hash);assert.ok(route.error,hash);}});
test('returning from settings restores the viewer document title for the parked record',()=>{const song=library[0],difficulty=song.difficulties[0];assert.equal(chartDocumentTitle(song,difficulty),`${song.title} · ${difficulty.name} · Crystallium`);assert.ok(chartDocumentTitle(song,difficulty).endsWith(' · Crystallium'),'must not leave the settings title behind');assert.equal(chartDocumentTitle(null,null),'Crystallium · Chart desk');});
test('a parked route names its own title before the chart JSON arrives',()=>{
  const song=library.find(s=>s.difficulties.length>1);
  for(const difficulty of song.difficulties)
    assert.equal(chartDocumentTitleForRoute(chartHash(song.id,difficulty.id),library),`${song.title} · ${difficulty.name} · Crystallium`,'route '+chartHash(song.id,difficulty.id));
  // A route that does not resolve to a real record must never leave the settings title behind.
  for(const hash of ['#songs','#settings','#/chart/nope/0',chartHash(song.id,99),'#/chart/%ZZ/0',''])
    assert.equal(chartDocumentTitleForRoute(hash,library),'Crystallium · Chart desk','route '+hash);
  assert.equal(chartDocumentTitleForRoute(chartHash('試験 / #?',3),[{id:'試験 / #?',title:'T',difficulties:[{id:3,name:'Astral'}]}]),'T · Astral · Crystallium');
});
test('overlapping-slide preference defaults to unchecked for absent or invalid storage',()=>{
  assert.deepEqual(defaultSettings,{showOverlappingSlides:false});
  for(const raw of [null,'','not json','{',']','null','true','0','[]','{}','{"showOverlappingSlides":"true"}','{"showOverlappingSlides":1}','{"showOverlappingSlides":null}','{"other":true}','{"showOverlappingSlides":false,"extra":1}'])
    assert.equal(readShowOverlappingSlides({getItem:()=>raw}),false,'raw='+String(raw));
  const thrower={getItem(){throw new Error('storage disabled');}};
  assert.equal(readShowOverlappingSlides(thrower),false);
  assert.equal(readShowOverlappingSlides({getItem(){throw new Error('denied');}}),false);
  assert.equal(writeShowOverlappingSlides({setItem(){throw new Error('quota');}},true),false);
});
test('settings visit pauses playback, clicks and auto-play intent without cancelling the load',()=>{
  const clock={playing:true,pauses:0,time:42.5,duration:90,pause(){this.playing=false;this.pauses++;}};
  let stops=0;const hitsounds={stop(){stops++;}};
  const result=pausePlaybackForHiddenViewer({clock,desiredPlaying:true,hitsounds});
  assert.equal(result.desiredPlaying,false,'the auto-play intent must be cleared');
  assert.equal(result.scrubbing,false,'a parked scrub must not eat later timeline updates');
  assert.equal(result.playing,false,'the clock must be paused, not reset');
  assert.equal(clock.pauses,1);
  assert.equal(stops,1,'clicks must stop');
  assert.equal(clock.time,42.5,'parking must not rewind or re-seek the chart');
  assert.equal(clock.duration,90);
  // The helper never touches a load generation or an abort handle: the parked session survives.
  assert.deepEqual(Object.keys(result).sort(),['desiredPlaying','playing','scrubbing']);
  assert.doesNotThrow(()=>pausePlaybackForHiddenViewer({}));
});

test('overlapping-slide preference round-trips explicit true and false',()=>{
  const store=new Map(),storage={getItem:key=>store.has(key)?store.get(key):null,setItem:(key,value)=>store.set(key,String(value))};
  assert.equal(readShowOverlappingSlides(storage),false,'a fresh browser must show unchecked');
  assert.equal(writeShowOverlappingSlides(storage,true),true);
  assert.equal(store.get(settingsStorageKey),'{"showOverlappingSlides":true}');
  assert.equal(readShowOverlappingSlides(storage),true);
  assert.equal(writeShowOverlappingSlides(storage,false),true);
  assert.equal(readShowOverlappingSlides(storage),false);
  assert.equal(writeShowOverlappingSlides(storage,'not-a-boolean'),true);
  assert.equal(readShowOverlappingSlides(storage),false,'a non-boolean write must persist unchecked, not truthy');
});
test('invalid deep links fall back to catalog with a helpful message',()=>{const valid=library.find(s=>s.id.startsWith('Luxe_Chain'));for(const hash of ['#oops','#/chart/absent/0',chartHash(valid.id,99),'#/chart/%ZZ/0',chartHash(valid.id,-1),'#/chart/'+valid.id+'/NaN','#/chart/'+valid.id+'/0/extra']){const route=resolveRoute(hash,library);assert.equal(route.view,'catalog',hash);assert.ok(route.error,hash);}});
test('hash codec supports non-ASCII, slash and hash in resource ids',()=>{const song={id:'試験 / #?',difficulties:[{id:3}]};const route=resolveRoute(chartHash(song.id,3),[song]);assert.equal(route.song,song);assert.equal(route.difficultyId,3);});
test('catalog and chart URLs are page-relative static files, never /api routes',()=>{
  assert.equal(libraryPath,'./library.json');
  assert.equal(chartPath('Luxe_Chain_e854fcacafe7'),'./charts/Luxe_Chain_e854fcacafe7.json');
  assert.equal(chartPath('試験 / #?'),'./charts/'+encodeURIComponent('試験 / #?')+'.json','the id is URL-encoded per path segment');
  for(const url of [libraryPath,chartPath(library[0].id)])assert.ok(!url.startsWith('/'),url+' must not depend on a domain root');
});
test('catalog/viewer markup and hidden CSS provide the validator contract',async()=>{const html=await readFile(new URL('./index.html',import.meta.url),'utf8'),css=await readFile(new URL('./styles.css',import.meta.url),'utf8');assert.match(html,/<div id="viewer-view" hidden>/);assert.match(html,/<tbody id="song-list">/);for(const id of ['catalog-view','no-results','catalog-message','clear-search','catalog-scroll','back-to-songs','breadcrumb','resource-id','music-volume','hit-volume','inspector'])assert.ok(html.includes('id="'+id+'"'),id);assert.match(css,/\[hidden\]\{display:none!important\}/);assert.match(css,/\.catalog-scroll\{[^}]*overflow-x:auto/);});
test('settings markup keeps the third screen out of the viewer and labels the checkbox',async()=>{const html=await readFile(new URL('./index.html',import.meta.url),'utf8'),css=await readFile(new URL('./styles.css',import.meta.url),'utf8');assert.match(html,/<section id="settings-view"[^>]* hidden>/);assert.match(html,/<h1 id="settings-title" tabindex="-1">Settings<\/h1>/);for(const id of ['settings-view','settings-link','settings-link-viewer','settings-back','settings-title','settings-origin','show-overlapping-slides'])assert.ok(html.includes('id="'+id+'"'),id);assert.equal((html.match(/id="settings-link"/g)||[]).length,1);assert.match(html,/<input id="show-overlapping-slides" type="checkbox">/,'the preference must default to unchecked in the markup');assert.match(html,/for="show-overlapping-slides"><input id="show-overlapping-slides"[^>]*><span>Show overlapping slide edges<\/span>/);assert.match(html,/Checked: every overlapping slide draws its own visible outline\. Unchecked: overlapping slides combine into one shape and only the outer edges are drawn\./);assert.match(html,/<a id="settings-link"[^>]*href="#settings"/);assert.match(html,/<a id="settings-link-viewer"[^>]*href="#settings"/);assert.match(css,/\.settings-body\{[^}]*max-width:760px/);assert.match(css,/@media\(max-width:800px\)\{[^@]*?\.settings-form\{padding:18px\}/);assert.match(css,/@media\(max-width:480px\)\{[^@]*?\.settings-navigation\{flex-direction:column/);});
