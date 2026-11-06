// Script that searches for a file on another host, run via `ssh host node -` (read-only, writes nothing there).
// Input: variable Q (base64 JSON) prepended to the script. Prints "QTLSP-FOUND {path,root}" or "QTLSP-NONE".
// Breadth-first scan: hinted folders (Orca workspaces on that host), previously used folders, then home;
// only files with a matching size are hashed (sha1, CRLF -> LF, BOM stripped).
export const PROBE_SCRIPT = String.raw`
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const A=JSON.parse(Buffer.from(Q,'base64').toString());
const sizes=new Set(A.sizes),SK=new Set(A.skip),ext=new RegExp(A.ext,'i');
const roots=[...A.hints,...A.roots];
const stateFile=/^state-(python|cpp|qml)-code-intelligence\.json$/.test(A.stateFile||'')?A.stateFile:'state.json';
try{const st=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.orca-qt-lsp',stateFile),'utf8'));roots.push(...(st.roots||[]))}catch{}
const win=process.platform==='win32';
const cli=win?path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'Programs','orca','resources','bin','orca.exe'):process.platform==='darwin'?'/Applications/Orca.app/Contents/Resources/bin/orca':'';
try{if(!cli||!fs.existsSync(cli))throw 0;const o=require('child_process').execFileSync(cli,['worktree','list','--json'],{encoding:'utf8',timeout:8000,stdio:['ignore','pipe','ignore'],maxBuffer:64<<20,windowsHide:true});
 for(const w of (JSON.parse(o).result||{}).worktrees||[])if(!w.hostId||w.hostId==='local')roots.push(w.path)}catch{}
roots.push(os.homedir());
if(win){for(const d of 'CDEFGH')roots.push(d+':\\')}else{for(const d of ['/data','/srv','/opt','/workspace','/work','/projects'])roots.push(d)}
const sha=f=>crypto.createHash('sha1').update(fs.readFileSync(f,'utf8').replace(/^﻿/,'').replace(/\r\n/g,'\n')).digest('hex');
const t0=Date.now(),seen=new Set();
for(const r of roots){if(!r||!fs.existsSync(r))continue;let level=[r];
 for(let d=0;level.length&&d<=14;d++){const next=[];
  for(const dir of level){if(seen.has(dir))continue;seen.add(dir);
   if(Date.now()-t0>A.ms){console.log('QTLSP-NONE timeout');process.exit(0)}
   let es;try{es=fs.readdirSync(dir,{withFileTypes:true})}catch{continue}
   for(const e of es){const n=e.name;
    if(e.isDirectory()){if(!SK.has(n)&&!n.startsWith('.')&&!/^(build|out|cmake-build-)/i.test(n))next.push(path.join(dir,n));continue}
    if(!e.isFile()||!ext.test(n))continue;const f=path.join(dir,n);let s;try{s=fs.statSync(f).size}catch{continue}
    if(sizes.has(s)){try{if(sha(f)===A.hash){console.log('QTLSP-FOUND '+JSON.stringify({path:f,root:r}));process.exit(0)}}catch{}}}}
  level=next}}
console.log('QTLSP-NONE');
`

export interface ProbeQuery { hash: string; sizes: number[]; ext: string; hints: string[]; roots: string[]; skip: string[]; ms: number }

/** File extensions per language (regex as a string) and folders skipped while searching. */
export const EXT_RE: Record<string, string> = {
  python: '\\.(py|pyi|pyw)$',
  qml: '\\.qml$',
  cpp: '\\.(cpp|cc|cxx|c\\+\\+|c|h|hpp|hh|hxx|inl|ipp|tpp|tcc|ixx|cppm)$'
}
export const PROBE_SKIP = ['node_modules', '__pycache__', 'venv', 'env', 'dist', 'site-packages', 'Library', 'Applications', 'AppData',
  'Movies', 'Music', 'Pictures', 'Downloads', '$Recycle.Bin', 'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', 'snap', 'proc', 'sys']
