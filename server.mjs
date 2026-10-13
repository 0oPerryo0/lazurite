import http from 'node:http';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// This folder is self-contained: it ships its own chart payloads (`charts/`), track texture
// (`assets/texture-435.png`) and catalog manifest (`library.json`). Only the audio mappings stay
// workspace-relative, and a missing mapped file simply means no audio — a standalone clone starts.
const home = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(home);
const chartsDir = path.join(home, 'charts');
const textureFile = path.join(home, 'assets', 'texture-435.png');
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.wav':'audio/wav','.mp3':'audio/mpeg','.ogg':'audio/ogg','.m4a':'audio/mp4'};
const chartFiles = new Map();
const media = new Map();
const names = ['Crescent','Lunar','Astral','Bloodlust','Eclipse'];
let audioMap = {};
try { audioMap = JSON.parse(await readFile(path.join(home,'audio-map.json'),'utf8')); } catch {}
let chartNames = [];
try { chartNames = (await readdir(chartsDir)).filter(f=>f.endsWith('.json')).sort(); } catch {}
const library = [];
for (const file of chartNames) {
  const id = file.slice(0,-5), data = JSON.parse(await readFile(path.join(chartsDir,file),'utf8'));
  chartFiles.set(id,path.join(chartsDir,file));
  // Audio mappings stay workspace-relative: they name files outside this folder that are never
  // published. A mapping whose file is absent (a clone without the workspace) yields audioUrl null.
  const mapping=(audioMap.charts||audioMap)[id];
  const mapped = typeof mapping === 'string' ? mapping : mapping?.path;
  let audioUrl = null;
  if (mapped) {
    const absolute = path.resolve(root,mapped), relative = path.relative(root,absolute);
    const insideWorkspace = !path.isAbsolute(relative) && !relative.startsWith('..');
    if (insideWorkspace && types[path.extname(absolute).toLowerCase()]?.startsWith('audio/')) {
      try { if ((await stat(absolute)).isFile()) {media.set(id,absolute);audioUrl='/api/audio/'+encodeURIComponent(id);} } catch {}
    }
  }
  library.push({id,file,title:data[4]||id,artist:data[5]||'Unknown artist',audioFilename:data[7]||'',offset:data[8]||0,
    difficulties:(data[2]||[]).map(d=>({id:d[1],name:names[d[1]]||'Unknown',rating:d[2],noteCount:(d[3]||[]).length})),audioUrl});
}
// The catalog manifest is the same static file the page fetches, generated from charts/ so a
// static host (GitHub Pages) serves it without this server. Written only when it would change.
const libraryJson = JSON.stringify({charts:library,audio:[...media].map(([id])=>({name:id,url:'/api/audio/'+id}))});
let published = null;
try { published = await readFile(path.join(home,'library.json'),'utf8'); } catch {}
if (published !== libraryJson) await writeFile(path.join(home,'library.json'),libraryJson);
// The public surface is exactly these files. Not the whole directory, not the chart .soda
// binaries, not package.json/server.mjs, and no parent paths: `charts/<id>.json` and the single
// texture are matched as whole resolved paths, so `..` traversal cannot select anything else.
const allowed = new Set(['index.html','app.js','styles.css','engine.js','renderer.js','audio.js','hitsounds.js','library.json']);
const publicFile = (pathname) => {
  if (allowed.has(pathname)) return path.join(home,pathname);
  if (/^charts\/[^\/]+\.json$/.test(pathname)) return path.join(home,pathname);
  if (pathname === 'assets/texture-435.png') return textureFile;
  return null;
};
async function sendFile(req,res,file) {
  const data = await readFile(file), contentType = types[path.extname(file).toLowerCase()]||'application/octet-stream';
  let start=0,end=data.length-1,status=200;
  if(req.headers.range) {
    const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1]&&!match[2])) {res.writeHead(416,{'Content-Range':`bytes */${data.length}`});res.end();return;}
    if(!match[1]) start=Math.max(0,data.length-Number(match[2]));
    else {start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
    if(start>end||start>=data.length) {res.writeHead(416,{'Content-Range':`bytes */${data.length}`});res.end();return;}
    status=206;
  }
  const headers={'Content-Type':contentType,'Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'};
  if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${data.length}`;
  res.writeHead(status,headers);res.end(req.method==='HEAD'?undefined:data.subarray(start,end+1));
}
const server=http.createServer(async(req,res)=>{
  try {
    res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    if(!/^((127\.0\.0\.1|localhost)(:\d+)?)$/i.test(req.headers.host||'')){res.writeHead(403);res.end();return;}
    if(req.headers['sec-fetch-site']==='cross-site'&&req.headers['sec-fetch-dest']!=='document'){res.writeHead(403);res.end();return;}
    if (!['GET','HEAD'].includes(req.method)) {res.writeHead(405,{'Allow':'GET, HEAD'});res.end();return;}
    const url=new URL(req.url,'http://localhost');
    let pathname;try{pathname=decodeURIComponent(url.pathname);}catch{res.writeHead(400);res.end('Invalid URL');return;}
    // Local aliases for the static files above (they keep existing tooling working; the page
    // itself uses library.json, charts/<id>.json and assets/texture-435.png).
    if(pathname==='/api/library') {res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-cache'});res.end(libraryJson);return;}
    if(pathname.startsWith('/api/chart/')) {const file=chartFiles.get(pathname.slice(11));if(file)return await sendFile(req,res,file);}
    if(pathname.startsWith('/api/audio/')) {const file=media.get(pathname.slice(11));if(file)return await sendFile(req,res,file);}
    if(pathname==='/api/texture') return await sendFile(req,res,textureFile);
    const name=pathname==='/'?'index.html':pathname.slice(1),file=publicFile(name);
    if(file)return await sendFile(req,res,file);
    res.writeHead(404);res.end('Not found');
  } catch(error) {if(error.code==='ENOENT'){res.writeHead(404);res.end('Not found');return;}console.error(error.message);res.writeHead(500);res.end('Local resource could not be loaded');}
});
const port=Number(process.env.PORT||4174);
server.on('error',error=>{console.error(`Viewer server could not start: ${error.message}. Choose another PORT if it is occupied.`);process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>console.log(`Crystallium chart viewer: http://127.0.0.1:${port} (${library.length} charts from charts/, ${media.size} local audio mappings). Restart after changing audio-map.json.`));
