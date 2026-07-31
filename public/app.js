/* pdf2model — plan sheet to standing model.
   Everything runs in the browser. Firebase stores the PDF and the tracing so the
   work survives a refresh; with no config present the app still works, locally. */
"use strict";

/* ══ state ══════════════════════════════════════════════════════════ */
const S = {
  doc:null, page:null, pageNum:1, numPages:0,
  src:null, srcW:0, srcH:0,
  view:{x:0,y:0,z:1},
  mpp:null,
  tool:'select',
  cal:{a:null,b:null},
  nodes:[], walls:[], rooms:[], openings:[],
  chain:[], cursor:null, snap:null, hoverWall:-1, sel:null,
  dims:{wall:.20, ceil:2.70, door:.90, win:1.20, sill:.90},
  history:[],
  raised:false, mode:'model', cam:'orbit',
  projectId:null, name:'Untitled plan', pdfBytes:null, pdfName:'', dirty:false
};
let uid = 1;
const $ = s => document.querySelector(s);
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

const planEl=$('#plan'), cv=$('#planCv'), ctx=cv.getContext('2d');
const bodyEl=$('#body'), msg=$('#msg'), liveDim=$('#liveDim'), tally=$('#tally');

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const fmt=m=>(m===null||!isFinite(m))?'—':(m>=1?m.toFixed(2)+' m':Math.round(m*100)+' cm');
const say=t=>{msg.textContent=t;};
const toScreen=p=>({x:p.x*S.view.z+S.view.x,y:p.y*S.view.z+S.view.y});
const toSrc=p=>({x:(p.x-S.view.x)/S.view.z,y:(p.y-S.view.y)/S.view.z});
const node=id=>S.nodes.find(n=>n.id===id);

let toastT;
function toast(t){
  const el=$('#toast'); el.textContent=t; el.classList.add('on');
  clearTimeout(toastT); toastT=setTimeout(()=>el.classList.remove('on'),3400);
}

/* ══ cloud ══════════════════════════════════════════════════════════ */
const Cloud = {
  on:false, uid:null, db:null, st:null,
  async init(){
    const cfg=window.FIREBASE_CONFIG;
    if(!cfg||!cfg.apiKey||cfg.apiKey.startsWith('PASTE')){
      $('#privacyLine').textContent='Or drop the file anywhere here. Nothing leaves your browser.';
      setSave('Local only','');
      return;
    }
    try{
      firebase.initializeApp(cfg);
      this.db=firebase.firestore(); this.st=firebase.storage();
      const cred=await firebase.auth().signInAnonymously();
      this.uid=cred.user.uid; this.on=true;
      $('#privacyLine').textContent='Or drop the file anywhere here. Your plans are private to this browser.';
      setSave('Ready','');
      listProjects();
    }catch(e){
      console.error('[cloud]',e);
      setSave('Offline','warn');
      toast('Cloud sign-in failed. You can keep working — nothing will be saved.');
    }
  },
  doc(){ return this.db.collection('projects').doc(S.projectId); },
  async createId(){ return this.db.collection('projects').doc().id; },
  async putPDF(bytes,name){
    const ref=this.st.ref(`plans/${this.uid}/${S.projectId}.pdf`);
    await ref.put(new Blob([bytes],{type:'application/pdf'}),{contentType:'application/pdf',customMetadata:{name}});
  },
  async getPDF(id){
    const url=await this.st.ref(`plans/${this.uid}/${id}.pdf`).getDownloadURL();
    const r=await fetch(url); return await r.arrayBuffer();
  }
};

function setSave(t,cls){
  const el=$('#saveState'); el.hidden=false; el.textContent=t;
  el.className=cls||'';
}
function serialize(){
  return {
    uid:Cloud.uid, name:S.name, pdfName:S.pdfName, pageNum:S.pageNum, mpp:S.mpp,
    dims:S.dims, nodes:S.nodes, walls:S.walls, rooms:S.rooms, openings:S.openings,
    uidSeq:uid, updatedAt:Date.now()
  };
}
function hydrate(d){
  S.name=d.name||'Untitled plan'; S.pdfName=d.pdfName||''; S.mpp=d.mpp??null;
  S.dims=Object.assign(S.dims,d.dims||{});
  S.nodes=d.nodes||[]; S.walls=d.walls||[]; S.rooms=d.rooms||[]; S.openings=d.openings||[];
  uid=d.uidSeq||1000;
  $('#pname').value=S.name;
  ['oWall','oCeil','oDoor','oWin','oSill'].forEach(id=>{
    const k={oWall:'wall',oCeil:'ceil',oDoor:'door',oWin:'win',oSill:'sill'}[id];
    $('#'+id).value=S.dims[k];
  });
  if(S.mpp){
    $('#scaleChip').classList.remove('unset');
    $('#scaleVal').textContent=(1/S.mpp).toFixed(1)+' px = 1 m';
    ['#tWall','#tDoor','#tWin'].forEach(s=>$(s).disabled=false);
  }
}

let saveT;
function touch(){
  S.dirty=true;
  if(!Cloud.on||!S.projectId) return;
  setSave('Unsaved','busy');
  clearTimeout(saveT); saveT=setTimeout(save,1200);
}
async function save(){
  if(!Cloud.on||!S.projectId) return;
  try{
    setSave('Saving…','busy');
    await Cloud.doc().set(serialize(),{merge:true});
    S.dirty=false;
    setSave('Saved '+new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}),'ok');
  }catch(e){ console.error(e); setSave('Save failed','warn'); }
}
async function listProjects(){
  if(!Cloud.on) return;
  try{
    const q=await Cloud.db.collection('projects').where('uid','==',Cloud.uid)
      .orderBy('updatedAt','desc').limit(6).get();
    const list=$('#recentList'); list.innerHTML='';
    if(q.empty){ $('#recent').hidden=true; return; }
    $('#recent').hidden=false;
    q.forEach(d=>{
      const v=d.data(), b=document.createElement('button');
      b.className='rec';
      b.innerHTML=`<span>${escapeHtml(v.name||'Untitled')}</span><span class="when">${when(v.updatedAt)}</span>`;
      b.onclick=()=>openProject(d.id);
      list.appendChild(b);
    });
  }catch(e){ console.warn('[list]',e); }
}
const escapeHtml=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function when(ts){
  if(!ts) return '';
  const d=(Date.now()-ts)/86400000;
  if(d<1) return new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  if(d<7) return Math.floor(d)+'d ago';
  return new Date(ts).toLocaleDateString([],{day:'numeric',month:'short'});
}
async function openProject(id){
  try{
    say('Opening…');
    const doc=await Cloud.db.collection('projects').doc(id).get();
    if(!doc.exists){ toast('That plan is gone.'); return; }
    S.projectId=id; hydrate(doc.data());
    const bytes=await Cloud.getPDF(id);
    await openBytes(bytes,S.pdfName||'plan.pdf',doc.data().pageNum||1);
    refresh(); draw();
    setSave('Saved','ok');
    say(S.mpp?'Carry on tracing.':'Set the scale to begin.');
  }catch(e){ console.error(e); toast('Could not open that plan.'); }
}

/* ══ pdf ════════════════════════════════════════════════════════════ */
if(window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

$('#openBtn').onclick=$('#openBtn2').onclick=()=>$('#file').click();
$('#file').onchange=e=>{ if(e.target.files[0]) loadFile(e.target.files[0]); };
$('#newBtn').onclick=()=>location.reload();

['dragenter','dragover'].forEach(t=>planEl.addEventListener(t,e=>{e.preventDefault();$('#drop').classList.add('over');}));
['dragleave','drop'].forEach(t=>planEl.addEventListener(t,e=>{e.preventDefault();$('#drop').classList.remove('over');}));
planEl.addEventListener('drop',e=>{
  const f=[...e.dataTransfer.files].find(f=>f.type==='application/pdf');
  if(f) loadFile(f); else if(e.dataTransfer.files.length) toast('That is not a PDF. Open a PDF plan.');
});

async function loadFile(file){
  if(file.size>25*1024*1024){ toast('That PDF is over 25 MB. Export a lighter one from your PDF viewer.'); return; }
  say('Reading '+file.name+'…');
  const bytes=await file.arrayBuffer();
  S.name=file.name.replace(/\.pdf$/i,'');
  $('#pname').value=S.name;
  const ok=await openBytes(bytes,file.name,1);
  if(!ok) return;
  if(Cloud.on){
    try{
      S.projectId=await Cloud.createId();
      setSave('Saving…','busy');
      await Cloud.putPDF(bytes,file.name);
      await save();
    }catch(e){ console.error(e); setSave('Save failed','warn'); toast('The plan opened, but could not be saved to the cloud.'); }
  }
}

async function openBytes(bytes,name,page){
  if(!window.pdfjsLib){ toast('PDF engine did not load. Check your connection and reload.'); return false; }
  try{
    S.pdfBytes=bytes.slice(0); S.pdfName=name;
    S.doc=await pdfjsLib.getDocument({data:bytes.slice(0)}).promise;
    S.numPages=S.doc.numPages;
    $('#pager').hidden=S.numPages<2;
    $('#pname').hidden=false; $('#newBtn').hidden=false;
    await renderPage(clamp(page,1,S.numPages));
    $('#empty').style.display='none';
    $('#scaleChip').hidden=false;
    ['#tCal','#tOpt'].forEach(s=>$(s).disabled=false);
    setTool(S.mpp?'wall':'calibrate');
    return true;
  }catch(err){
    console.error(err);
    toast('That PDF could not be opened. It may be password-protected or damaged.');
    say('Open a PDF to begin.');
    return false;
  }
}

async function renderPage(n){
  S.pageNum=n;
  S.page=await S.doc.getPage(n);
  const base=S.page.getViewport({scale:1});
  const scale=clamp(2400/Math.max(base.width,base.height),1,4);
  const vp=S.page.getViewport({scale});
  const off=document.createElement('canvas');
  off.width=Math.round(vp.width); off.height=Math.round(vp.height);
  await S.page.render({canvasContext:off.getContext('2d'),viewport:vp}).promise;
  S.src=off; S.srcW=off.width; S.srcH=off.height;
  $('#pgLabel').textContent=n+' / '+S.numPages;
  $('#prevPg').disabled=n<=1; $('#nextPg').disabled=n>=S.numPages;
  fit(); draw();
}
$('#prevPg').onclick=()=>{ if(S.pageNum>1){renderPage(S.pageNum-1);touch();} };
$('#nextPg').onclick=()=>{ if(S.pageNum<S.numPages){renderPage(S.pageNum+1);touch();} };

$('#pname').oninput=e=>{ S.name=e.target.value||'Untitled plan'; touch(); };
$('#pname').onkeydown=e=>{ if(e.key==='Enter') e.target.blur(); };

/* ══ view ═══════════════════════════════════════════════════════════ */
function sizeCanvas(){
  const r=planEl.getBoundingClientRect(), dpr=devicePixelRatio||1;
  cv.width=Math.round(r.width*dpr); cv.height=Math.round(r.height*dpr);
  cv.style.width=r.width+'px'; cv.style.height=r.height+'px';
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
function fit(){
  if(!S.src) return;
  const r=planEl.getBoundingClientRect(), pad=44;
  const z=Math.min((r.width-pad*2)/S.srcW,(r.height-pad*2)/S.srcH);
  S.view.z=z; S.view.x=(r.width-S.srcW*z)/2; S.view.y=(r.height-S.srcH*z)/2;
}
function zoomAt(f,cx,cy){
  const r=planEl.getBoundingClientRect();
  cx=cx??r.width/2; cy=cy??r.height/2;
  const nz=clamp(S.view.z*f,.05,14), k=nz/S.view.z;
  S.view.x=cx-(cx-S.view.x)*k; S.view.y=cy-(cy-S.view.y)*k; S.view.z=nz; draw();
}
$('#zIn').onclick=()=>zoomAt(1.25); $('#zOut').onclick=()=>zoomAt(.8);
$('#zFit').onclick=()=>{fit();draw();};
planEl.addEventListener('wheel',e=>{
  if(!S.src) return; e.preventDefault();
  const r=planEl.getBoundingClientRect();
  zoomAt(e.deltaY<0?1.1:1/1.1,e.clientX-r.left,e.clientY-r.top);
},{passive:false});

/* ══ history ════════════════════════════════════════════════════════ */
function pushHistory(){
  S.history.push(JSON.stringify({n:S.nodes,w:S.walls,r:S.rooms,o:S.openings,c:S.chain}));
  if(S.history.length>60) S.history.shift();
  $('#tUndo').disabled=false;
}
function undo(){
  if(!S.history.length) return;
  const p=JSON.parse(S.history.pop());
  S.nodes=p.n; S.walls=p.w; S.rooms=p.r; S.openings=p.o; S.chain=p.c; S.sel=null;
  if(!S.history.length) $('#tUndo').disabled=true;
  refresh(); draw(); touch(); if(S.raised) build3D();
}

/* ══ tools ══════════════════════════════════════════════════════════ */
const TOOLS={select:'#tSelect',calibrate:'#tCal',wall:'#tWall',door:'#tDoor',window:'#tWin'};
const PROMPT={
  select:'Click a wall or an opening to select it. Backspace removes it.',
  calibrate:'Click one end of a wall you know, then the other.',
  wall:'Click each corner. Hold Shift to break the square snap. Esc ends the run.',
  door:'Click a wall where the door goes.',
  window:'Click a wall where the window goes.'
};
function setTool(t){
  if($(TOOLS[t])?.disabled) return;
  S.tool=t; S.chain=[]; S.cal={a:null,b:null}; S.sel=null; hideLen(); closePops();
  for(const k in TOOLS) $(TOOLS[k]).setAttribute('aria-pressed',String(k===t));
  planEl.classList.toggle('sel',t==='select');
  say(PROMPT[t]); draw();
}
$('#tSelect').onclick=()=>setTool('select');
$('#tCal').onclick=()=>setTool('calibrate');
$('#tWall').onclick=()=>setTool('wall');
$('#tDoor').onclick=()=>setTool('door');
$('#tWin').onclick=()=>setTool('window');
$('#tUndo').onclick=undo;
$('#tClear').onclick=()=>{
  if(!S.walls.length&&!S.openings.length) return;
  pushHistory(); S.nodes=[];S.walls=[];S.rooms=[];S.openings=[];S.chain=[];S.sel=null;
  S.raised=false; clear3D(); refresh(); draw(); touch();
  say('Tracing cleared. The scale is kept.');
};
function closePops(){ $('#opt').classList.remove('on'); $('#exp').classList.remove('on'); }
function togglePop(sel,btn){
  const p=$(sel), was=p.classList.contains('on');
  closePops();
  if(!was){ p.classList.add('on'); p.style.top=(btn.getBoundingClientRect().top-44)+'px'; }
}
$('#tOpt').onclick=e=>togglePop('#opt',e.currentTarget);
$('#tExp').onclick=e=>togglePop('#exp',e.currentTarget);
['oWall','oCeil','oDoor','oWin','oSill'].forEach(id=>{
  $('#'+id).oninput=e=>{
    const k={oWall:'wall',oCeil:'ceil',oDoor:'door',oWin:'win',oSill:'sill'}[id];
    const v=parseFloat(e.target.value); if(isFinite(v)) S.dims[k]=v;
    draw(); touch(); if(S.raised) build3D();
  };
});
$('#tRaise').onclick=raise;

const tip=$('#tip');
document.querySelectorAll('.tool[data-tip]').forEach(b=>{
  const show=()=>{
    const r=b.getBoundingClientRect();
    tip.innerHTML=b.dataset.tip+(b.dataset.kb?'<span class="kb">'+b.dataset.kb+'</span>':'');
    tip.classList.add('on');
    tip.style.top=(r.top+r.height/2-11)+'px';
    tip.style.left=(r.left-tip.offsetWidth-7)+'px';
  };
  b.addEventListener('mouseenter',show); b.addEventListener('focus',show);
  b.addEventListener('mouseleave',()=>tip.classList.remove('on'));
  b.addEventListener('blur',()=>tip.classList.remove('on'));
});

/* ══ snapping / hit ═════════════════════════════════════════════════ */
const keys={shift:false,space:false};
function snapPoint(p,anchor){
  const R=13/S.view.z;
  let best=null,bd=R;
  for(const n of S.nodes){ const d=dist(n,p); if(d<bd){bd=d;best={x:n.x,y:n.y,id:n.id,kind:'node'};} }
  if(best) return best;
  if(anchor&&!keys.shift){
    const dx=p.x-anchor.x, dy=p.y-anchor.y, L=Math.hypot(dx,dy);
    if(L>1){
      const step=Math.PI/4, ang=Math.atan2(dy,dx), sn=Math.round(ang/step)*step;
      if(Math.abs(ang-sn)<0.13) return {x:anchor.x+Math.cos(sn)*L,y:anchor.y+Math.sin(sn)*L,kind:'ortho'};
    }
  }
  return {x:p.x,y:p.y,kind:null};
}
function addNode(p){
  if(p.id!==undefined) return p.id;
  const n={id:uid++,x:p.x,y:p.y}; S.nodes.push(n); return n.id;
}
function wallAt(p){
  const R=10/S.view.z;
  for(let i=S.walls.length-1;i>=0;i--){
    const w=S.walls[i], a=node(w.a), b=node(w.b); if(!a||!b) continue;
    const vx=b.x-a.x, vy=b.y-a.y, L2=vx*vx+vy*vy; if(!L2) continue;
    const t=clamp(((p.x-a.x)*vx+(p.y-a.y)*vy)/L2,0,1);
    if(Math.hypot(p.x-(a.x+vx*t),p.y-(a.y+vy*t))<R) return {i,t};
  }
  return null;
}
function openingAt(p){
  const R=11/S.view.z;
  for(let i=S.openings.length-1;i>=0;i--){
    const o=S.openings[i], w=S.walls[o.wall]; if(!w) continue;
    const a=node(w.a), b=node(w.b); if(!a||!b) continue;
    if(dist({x:a.x+(b.x-a.x)*o.u,y:a.y+(b.y-a.y)*o.u},p)<R) return i;
  }
  return -1;
}

/* ══ pointer ════════════════════════════════════════════════════════ */
let panning=false, panStart=null, dragOpening=-1;

planEl.addEventListener('pointerdown',e=>{
  if(!S.src||e.target.closest('#lenPop,#zoom,#stageBar')) return;
  closePops();
  const r=planEl.getBoundingClientRect(), sp={x:e.clientX-r.left,y:e.clientY-r.top};
  if(e.button===1||keys.space){ panning=true;panStart={...sp,vx:S.view.x,vy:S.view.y};planEl.classList.add('panning');cv.setPointerCapture(e.pointerId);return; }
  if(e.button!==0) return;
  const p=toSrc(sp);

  if(S.tool==='calibrate'){
    const s=snapPoint(p,S.cal.a);
    if(!S.cal.a){ S.cal.a={x:s.x,y:s.y}; say('Now click the other end.'); }
    else { S.cal.b={x:s.x,y:s.y}; askLength(); }
    draw(); return;
  }
  if(S.tool==='wall'){
    const anchor=S.chain.length?node(S.chain[S.chain.length-1]):null;
    const s=snapPoint(p,anchor);
    pushHistory();
    const id=addNode(s);
    if(S.chain.length){
      const prev=S.chain[S.chain.length-1];
      if(prev!==id) S.walls.push({a:prev,b:id,id:uid++});
      if(id===S.chain[0]&&S.chain.length>2){
        S.rooms.push([...S.chain]); S.chain=[];
        say('Room closed. Trace another run, or raise it.');
        refresh(); draw(); touch(); return;
      }
    }
    S.chain.push(id); refresh(); draw(); touch(); return;
  }
  if(S.tool==='door'||S.tool==='window'){
    const hit=wallAt(p);
    if(!hit){ say('Click directly on a wall.'); return; }
    pushHistory();
    const isDoor=S.tool==='door';
    S.openings.push({id:uid++,wall:hit.i,u:clamp(hit.t,.04,.96),kind:isDoor?'door':'window',
      width:isDoor?S.dims.door:S.dims.win, sill:isDoor?0:S.dims.sill,
      head:isDoor?2.10:S.dims.sill+1.20});
    refresh(); draw(); touch(); if(S.raised) build3D(); return;
  }
  if(S.tool==='select'){
    const oi=openingAt(p);
    if(oi>=0){ S.sel={t:'opening',i:oi}; dragOpening=oi; pushHistory(); cv.setPointerCapture(e.pointerId); draw(); return; }
    const hit=wallAt(p);
    S.sel=hit?{t:'wall',i:hit.i}:null;
    say(S.sel?'Selected. Backspace removes it.':PROMPT.select);
    draw(); return;
  }
});

planEl.addEventListener('pointermove',e=>{
  if(!S.src) return;
  const r=planEl.getBoundingClientRect(), sp={x:e.clientX-r.left,y:e.clientY-r.top};
  if(panning){ S.view.x=panStart.vx+(sp.x-panStart.x); S.view.y=panStart.vy+(sp.y-panStart.y); draw(); return; }
  const p=toSrc(sp); S.cursor=p;

  if(dragOpening>=0){
    const o=S.openings[dragOpening], w=S.walls[o.wall], a=node(w.a), b=node(w.b);
    const vx=b.x-a.x, vy=b.y-a.y, L2=vx*vx+vy*vy;
    o.u=clamp(((p.x-a.x)*vx+(p.y-a.y)*vy)/L2,.04,.96);
    draw(); return;
  }
  const anchor=S.tool==='wall'&&S.chain.length?node(S.chain[S.chain.length-1]):(S.tool==='calibrate'?S.cal.a:null);
  S.snap=snapPoint(p,anchor);
  S.hoverWall=(S.tool==='door'||S.tool==='window'||S.tool==='select')?(wallAt(p)?.i??-1):-1;
  liveDim.textContent = anchor ? (S.mpp?fmt(dist(anchor,S.snap)*S.mpp):Math.round(dist(anchor,S.snap))+' px') : '';
  draw();
});

addEventListener('pointerup',()=>{
  if(panning){panning=false;planEl.classList.remove('panning');}
  if(dragOpening>=0){ dragOpening=-1; touch(); if(S.raised) build3D(); }
});
planEl.addEventListener('dblclick',()=>{ if(S.tool==='wall'){S.chain=[];draw();} });
planEl.addEventListener('contextmenu',e=>{ if(S.tool==='wall'){e.preventDefault();S.chain=[];draw();} });

addEventListener('keydown',e=>{
  if(e.target.tagName==='INPUT'){ if(e.key==='Escape') e.target.blur(); return; }
  if(e.key==='Shift') keys.shift=true;
  if(e.code==='Space'){ keys.space=true; e.preventDefault(); }
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'){ e.preventDefault(); undo(); return; }
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='s'){ e.preventDefault(); save(); return; }
  const k=e.key.toLowerCase();
  if(k==='v') setTool('select');
  if(k==='s') setTool('calibrate');
  if(k==='w') setTool('wall');
  if(k==='d') setTool('door');
  if(k==='n') setTool('window');
  if(k==='r'&&!$('#tRaise').disabled) raise();
  if(k==='e'&&!$('#tExp').disabled) togglePop('#exp',$('#tExp'));
  if(k==='escape'){ S.chain=[];S.cal={a:null,b:null};S.sel=null;hideLen();closePops();draw(); }
  if(k==='backspace'||k==='delete'){
    if(!S.sel) return; e.preventDefault(); pushHistory();
    if(S.sel.t==='opening') S.openings.splice(S.sel.i,1);
    else{
      S.openings=S.openings.filter(o=>o.wall!==S.sel.i).map(o=>({...o,wall:o.wall>S.sel.i?o.wall-1:o.wall}));
      S.walls.splice(S.sel.i,1);
    }
    S.sel=null; refresh(); draw(); touch(); if(S.raised) build3D();
  }
});
addEventListener('keyup',e=>{ if(e.key==='Shift')keys.shift=false; if(e.code==='Space')keys.space=false; });
addEventListener('beforeunload',e=>{ if(S.dirty&&Cloud.on){ e.preventDefault(); e.returnValue=''; } });

/* ══ calibration ════════════════════════════════════════════════════ */
function askLength(){
  const pop=$('#lenPop'), m=toScreen({x:(S.cal.a.x+S.cal.b.x)/2,y:(S.cal.a.y+S.cal.b.y)/2});
  pop.classList.add('on');
  pop.style.left=clamp(m.x-70,8,planEl.clientWidth-170)+'px';
  pop.style.top=clamp(m.y-72,8,planEl.clientHeight-90)+'px';
  const inp=$('#lenIn'); inp.value=''; inp.focus();
  say('How long is that in real life?');
}
function hideLen(){ $('#lenPop').classList.remove('on'); }
function applyLength(){
  const m=parseFloat($('#lenIn').value);
  if(!isFinite(m)||m<=0){ $('#lenIn').focus(); say('Enter a length in metres, e.g. 4.20'); return; }
  const px=dist(S.cal.a,S.cal.b);
  if(px<3){ say('That line is too short to measure from. Draw a longer one.'); return; }
  S.mpp=m/px;
  $('#scaleChip').classList.remove('unset');
  $('#scaleVal').textContent=(1/S.mpp).toFixed(1)+' px = 1 m';
  hideLen(); S.cal={a:null,b:null};
  ['#tWall','#tDoor','#tWin'].forEach(s=>$(s).disabled=false);
  setTool('wall'); touch();
  say('Scale locked. Now trace the walls — click each corner.');
  refresh();
}
$('#lenOk').onclick=applyLength;
$('#lenIn').onkeydown=e=>{ if(e.key==='Enter'){e.preventDefault();applyLength();} };

function refresh(){
  const n=S.walls.length;
  $('#tRaise').disabled=!(S.mpp&&n>=3);
  $('#tClear').disabled=!(n||S.openings.length);
  $('#tExp').disabled=!S.raised;
  tally.textContent=n?(n+' wall'+(n>1?'s':'')+(S.openings.length?' · '+S.openings.length+' opening'+(S.openings.length>1?'s':''):'')):'';
}

/* ══ 2d ═════════════════════════════════════════════════════════════ */
function draw(){
  if(!cv.width) sizeCanvas();
  const w=cv.width/(devicePixelRatio||1), h=cv.height/(devicePixelRatio||1);
  ctx.clearRect(0,0,w,h);
  if(!S.src) return;
  const {x,y,z}=S.view;
  ctx.save();
  ctx.shadowColor='rgba(0,0,0,.34)'; ctx.shadowBlur=26; ctx.shadowOffsetY=8;
  ctx.fillStyle='#fff'; ctx.fillRect(x,y,S.srcW*z,S.srcH*z);
  ctx.restore();
  ctx.imageSmoothingQuality='high';
  ctx.drawImage(S.src,x,y,S.srcW*z,S.srcH*z);
  if(S.walls.length){ ctx.fillStyle='rgba(255,255,255,.34)'; ctx.fillRect(x,y,S.srcW*z,S.srcH*z); }
  drawRooms(); drawWalls(); drawOpenings(); drawChain(); drawCal(); drawSnap();
}
function drawRooms(){
  if(!S.rooms.length) return;
  ctx.save(); ctx.fillStyle='rgba(232,185,35,.13)';
  for(const r of S.rooms){
    ctx.beginPath();
    r.forEach((id,i)=>{ const n=node(id); if(!n)return; const p=toScreen(n); i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y); });
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}
function drawWalls(){
  const tPx=S.mpp?(S.dims.wall/S.mpp)*S.view.z:6;
  S.walls.forEach((w,i)=>{
    const a=node(w.a), b=node(w.b); if(!a||!b) return;
    const A=toScreen(a), B=toScreen(b);
    const on=S.sel?.t==='wall'&&S.sel.i===i, hov=S.hoverWall===i;
    ctx.save(); ctx.lineCap='butt';
    ctx.strokeStyle=on?'#E8B923':(hov?'#4A453D':'#23211E');
    ctx.lineWidth=Math.max(2.5,tPx);
    ctx.beginPath(); ctx.moveTo(A.x,A.y); ctx.lineTo(B.x,B.y); ctx.stroke();
    ctx.restore();
    if(S.mpp&&S.view.z>0.12){
      const txt=fmt(dist(a,b)*S.mpp);
      let ang=Math.atan2(B.y-A.y,B.x-A.x);
      if(ang>Math.PI/2||ang<-Math.PI/2) ang+=Math.PI;
      ctx.save(); ctx.translate((A.x+B.x)/2,(A.y+B.y)/2); ctx.rotate(ang);
      ctx.font='500 11px "Archivo Narrow", sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
      const tw=ctx.measureText(txt).width;
      ctx.fillStyle=on?'#E8B923':'#FFFFFF'; ctx.fillRect(-tw/2-3,-8,tw+6,15);
      ctx.fillStyle='#23211E'; ctx.fillText(txt,0,0);
      ctx.restore();
    }
  });
  const used=new Set(); S.walls.forEach(w=>{used.add(w.a);used.add(w.b);});
  ctx.save();
  for(const n of S.nodes){
    if(!used.has(n.id)) continue;
    const p=toScreen(n);
    ctx.fillStyle='#FFFFFF'; ctx.strokeStyle='#23211E'; ctx.lineWidth=1.4;
    ctx.beginPath(); ctx.rect(p.x-2.5,p.y-2.5,5,5); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}
function drawOpenings(){
  const tPx=S.mpp?(S.dims.wall/S.mpp)*S.view.z:6;
  S.openings.forEach((o,i)=>{
    const w=S.walls[o.wall]; if(!w) return;
    const a=node(w.a), b=node(w.b); if(!a||!b) return;
    const A=toScreen(a), B=toScreen(b);
    const ang=Math.atan2(B.y-A.y,B.x-A.x);
    const wPx=S.mpp?(o.width/S.mpp)*S.view.z:16, th=Math.max(3,tPx);
    const on=S.sel?.t==='opening'&&S.sel.i===i;
    ctx.save();
    ctx.translate(A.x+(B.x-A.x)*o.u, A.y+(B.y-A.y)*o.u); ctx.rotate(ang);
    ctx.fillStyle='#FFFFFF'; ctx.fillRect(-wPx/2,-th/2,wPx,th);
    ctx.strokeStyle=on?'#E8B923':'#23211E'; ctx.lineWidth=on?2:1.2;
    ctx.strokeRect(-wPx/2,-th/2,wPx,th);
    if(o.kind==='door'){
      ctx.beginPath(); ctx.arc(-wPx/2,-th/2,wPx,0,-Math.PI/2,true);
      ctx.strokeStyle=on?'#E8B923':'#8A8478'; ctx.lineWidth=1.1; ctx.setLineDash([3,2]); ctx.stroke(); ctx.setLineDash([]);
    }else{
      ctx.beginPath(); ctx.moveTo(-wPx/2,0); ctx.lineTo(wPx/2,0);
      ctx.strokeStyle=on?'#E8B923':'#23211E'; ctx.lineWidth=1.1; ctx.stroke();
    }
    ctx.restore();
  });
}
function drawChain(){
  if(S.tool!=='wall'||!S.chain.length||!S.snap) return;
  const a=node(S.chain[S.chain.length-1]); if(!a) return;
  const A=toScreen(a), B=toScreen(S.snap);
  ctx.save(); ctx.globalAlpha=.75; ctx.strokeStyle='#E8B923';
  ctx.lineWidth=Math.max(2.5,S.mpp?(S.dims.wall/S.mpp)*S.view.z:6);
  ctx.beginPath(); ctx.moveTo(A.x,A.y); ctx.lineTo(B.x,B.y); ctx.stroke(); ctx.restore();
}
function drawCal(){
  if(S.tool!=='calibrate'||!S.cal.a) return;
  const b=S.cal.b||S.snap; if(!b) return;
  const A=toScreen(S.cal.a), B=toScreen(b);
  ctx.save(); ctx.strokeStyle='#E8B923'; ctx.lineWidth=2.5;
  ctx.beginPath(); ctx.moveTo(A.x,A.y); ctx.lineTo(B.x,B.y); ctx.stroke();
  const ang=Math.atan2(B.y-A.y,B.x-A.x)+Math.PI/2;
  [A,B].forEach(P=>{
    ctx.beginPath();
    ctx.moveTo(P.x+Math.cos(ang)*7,P.y+Math.sin(ang)*7);
    ctx.lineTo(P.x-Math.cos(ang)*7,P.y-Math.sin(ang)*7); ctx.stroke();
  });
  ctx.restore();
}
function drawSnap(){
  if(!S.snap||S.tool==='select') return;
  const p=toScreen(S.snap);
  ctx.save(); ctx.strokeStyle='#E8B923';
  if(S.snap.kind==='node'){ ctx.lineWidth=2; ctx.strokeRect(p.x-5,p.y-5,10,10); }
  else if(S.snap.kind==='ortho'){
    ctx.lineWidth=1.4; ctx.beginPath();
    ctx.moveTo(p.x-7,p.y);ctx.lineTo(p.x+7,p.y);ctx.moveTo(p.x,p.y-7);ctx.lineTo(p.x,p.y+7); ctx.stroke();
  }
  ctx.restore();
}

/* ══ 3d ═════════════════════════════════════════════════════════════ */
const stage=$('#stage');
let renderer,scene,camera,shell,envRT,sun,hemi,raiseT=0,raising=false;
const orbit={az:-0.75,el:0.62,r:14,tx:0,ty:0,tz:0};

function init3D(){
  if(renderer) return;
  renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  renderer.shadowMap.enabled=true; renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  renderer.outputEncoding=THREE.sRGBEncoding;
  renderer.toneMapping=THREE.ACESFilmicToneMapping; renderer.toneMappingExposure=1;
  stage.appendChild(renderer.domElement);
  scene=new THREE.Scene();
  camera=new THREE.PerspectiveCamera(48,1,0.05,600);
  hemi=new THREE.HemisphereLight(0xffffff,0x9a927f,.7); scene.add(hemi);
  sun=new THREE.DirectionalLight(0xffffff,1.6);
  sun.position.set(9,14,7); sun.castShadow=true; sun.shadow.mapSize.set(2048,2048);
  const d=22,c=sun.shadow.camera; c.left=-d;c.right=d;c.top=d;c.bottom=-d;c.near=.5;c.far=70;
  sun.shadow.bias=-0.0006; sun.shadow.normalBias=.02; scene.add(sun);
  buildEnv(); bindOrbit(); resize3D();
  (function loop(){ requestAnimationFrame(loop); tick(); })();
}
function buildEnv(){
  const s=new THREE.Scene();
  s.add(new THREE.Mesh(new THREE.SphereGeometry(60,24,16),new THREE.ShaderMaterial({
    side:THREE.BackSide,
    vertexShader:'varying vec3 vP;void main(){vP=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader:`varying vec3 vP;void main(){float h=normalize(vP).y*.5+.5;
      vec3 top=vec3(.62,.70,.82),hor=vec3(.92,.90,.86),bot=vec3(.30,.28,.25);
      vec3 c=h>.5?mix(hor,top,(h-.5)*2.):mix(bot,hor,h*2.);gl_FragColor=vec4(c,1.);}`
  })));
  const lamp=new THREE.Mesh(new THREE.PlaneGeometry(26,20),new THREE.MeshBasicMaterial({color:0xffffff}));
  lamp.position.set(-24,11,16); lamp.lookAt(0,2,0); s.add(lamp);
  const pm=new THREE.PMREMGenerator(renderer); pm.compileEquirectangularShader();
  envRT=pm.fromScene(s,.04); pm.dispose();
}
function resize3D(){
  if(!renderer) return;
  const r=stage.getBoundingClientRect();
  if(r.width<8||r.height<8) return;
  renderer.setSize(r.width,r.height,false);
  camera.aspect=r.width/r.height; camera.updateProjectionMatrix();
}
function bindOrbit(){
  const el=renderer.domElement;
  let drag=false,last=null,btn=0;
  el.addEventListener('pointerdown',e=>{drag=true;btn=e.button;last={x:e.clientX,y:e.clientY};el.setPointerCapture(e.pointerId);});
  el.addEventListener('pointermove',e=>{
    if(!drag) return;
    const dx=e.clientX-last.x, dy=e.clientY-last.y; last={x:e.clientX,y:e.clientY};
    if(btn===2||e.shiftKey){
      const s=orbit.r*.0016;
      orbit.tx-=Math.cos(orbit.az)*dx*s; orbit.tz-=Math.sin(orbit.az)*dx*s; orbit.ty+=dy*s;
    }else{
      orbit.az-=dx*.006;
      orbit.el=clamp(orbit.el-dy*.006,S.cam==='eye'?-.55:.03,1.45);
    }
  });
  el.addEventListener('contextmenu',e=>e.preventDefault());
  addEventListener('pointerup',()=>drag=false);
  el.addEventListener('wheel',e=>{e.preventDefault();orbit.r=clamp(orbit.r*(e.deltaY>0?1.11:1/1.11),1.1,180);},{passive:false});
}
function tick(){
  if(!renderer) return;
  if(shell&&raising){
    raiseT=Math.min(1,raiseT+(REDUCED?1:.028));
    applyRise(1-Math.pow(1-raiseT,3.2));
    if(raiseT>=1) raising=false;
  }
  const cy=S.cam==='eye'?1.62:orbit.ty;
  camera.position.set(
    orbit.tx+Math.cos(orbit.az)*Math.cos(orbit.el)*orbit.r,
    cy+Math.sin(orbit.el)*orbit.r,
    orbit.tz+Math.sin(orbit.az)*Math.cos(orbit.el)*orbit.r);
  camera.lookAt(orbit.tx,cy*.55+.9,orbit.tz);
  renderer.render(scene,camera);
}
function applyRise(e){
  if(!shell) return;
  shell.traverse(o=>{
    if(o.userData.h===undefined) return;
    o.scale.y=Math.max(1e-4,e); o.position.y=o.userData.y0*e;
  });
}
function clear3D(){
  if(shell&&scene){ scene.remove(shell); disposeTree(shell); shell=null; }
  $('#stageEmpty').style.display='';
  bodyEl.classList.add('no3d'); bodyEl.classList.remove('wide3d');
}
function disposeTree(o){
  o.traverse(c=>{ if(c.geometry)c.geometry.dispose(); });
}

/* procedural PBR — no external textures to fetch */
function noiseCanvas(w,h,f){
  const c=document.createElement('canvas'); c.width=w;c.height=h;
  const g=c.getContext('2d'), img=g.createImageData(w,h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){ const i=(y*w+x)*4,v=f(x,y);
    img.data[i]=v[0];img.data[i+1]=v[1];img.data[i+2]=v[2];img.data[i+3]=255; }
  g.putImageData(img,0,0); return c;
}
function tex(c,rep){
  const t=new THREE.CanvasTexture(c);
  t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(rep,rep);
  t.anisotropy=renderer?renderer.capabilities.getMaxAnisotropy():1;
  return t;
}
const MAT={};
function buildMaterials(){
  if(MAT.built) return;
  const A=512;
  const floorC=noiseCanvas(A,A,(x,y)=>{
    const plank=Math.floor(y/64), gx=(x+plank*37)%A;
    const grain=Math.sin(gx*.28+plank*2.1)*.5+Math.sin(gx*1.7+plank)*.22+(Math.random()-.5)*.16;
    const b=.63+grain*.1+((y%64<1.4)?-.34:0);
    return [clamp(196*b,0,255),clamp(158*b,0,255),clamp(112*b,0,255)];
  });
  const floorR=noiseCanvas(A,A,(x,y)=>{const v=132+((y%64<1.4)?42:0)+(Math.random()-.5)*22;return [v,v,v];});
  const B=256;
  const wallC=noiseCanvas(B,B,()=>{const v=232+(Math.random()-.5)*7;return [v,v-1,v-4];});
  const wallR=noiseCanvas(B,B,()=>{const v=214+(Math.random()-.5)*20;return [v,v,v];});
  MAT.floor=new THREE.MeshStandardMaterial({map:tex(floorC,3),roughnessMap:tex(floorR,3),roughness:.62,metalness:0,envMapIntensity:.8});
  MAT.wall=new THREE.MeshStandardMaterial({map:tex(wallC,5),roughnessMap:tex(wallR,5),roughness:.93,metalness:0,envMapIntensity:.55});
  MAT.glass=new THREE.MeshStandardMaterial({color:0xD7E3E8,roughness:.06,metalness:0,transparent:true,opacity:.24,envMapIntensity:2.2});
  MAT.boardW=new THREE.MeshStandardMaterial({color:0xCFC8BA,roughness:.94,metalness:0});
  MAT.boardF=new THREE.MeshStandardMaterial({color:0xB4AB99,roughness:.96,metalness:0});
  MAT.built=true;
}

function build3D(){
  init3D(); buildMaterials();
  if(shell){ scene.remove(shell); disposeTree(shell); }
  shell=new THREE.Group(); scene.add(shell);
  const m=S.mpp, H=S.dims.ceil, T=S.dims.wall, modelMode=S.mode==='model';
  const matW=modelMode?MAT.boardW:MAT.wall, matF=modelMode?MAT.boardF:MAT.floor;

  const used=new Set(); S.walls.forEach(w=>{used.add(w.a);used.add(w.b);});
  const pts=S.nodes.filter(n=>used.has(n.id)); if(!pts.length) return;
  let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9;
  pts.forEach(p=>{minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);});
  const cx=(minX+maxX)/2, cy=(minY+maxY)/2;
  const X=p=>(p.x-cx)*m, Z=p=>(p.y-cy)*m;

  if(S.rooms.length){
    for(const r of S.rooms){
      const shape=new THREE.Shape();
      r.forEach((id,i)=>{const n=node(id); if(!n)return; i?shape.lineTo(X(n),Z(n)):shape.moveTo(X(n),Z(n));});
      const g=new THREE.ShapeGeometry(shape); g.rotateX(Math.PI/2);
      const f=new THREE.Mesh(g,matF); f.position.y=.002; f.receiveShadow=true; shell.add(f);
    }
  }else{
    const f=new THREE.Mesh(new THREE.BoxGeometry((maxX-minX)*m+T,.04,(maxY-minY)*m+T),matF);
    f.position.y=-.02; f.receiveShadow=true; shell.add(f);
  }

  S.walls.forEach((w,wi)=>{
    const a=node(w.a), b=node(w.b); if(!a||!b) return;
    const ax=X(a),az=Z(a),bx=X(b),bz=Z(b);
    const L=Math.hypot(bx-ax,bz-az); if(L<.01) return;
    const g=new THREE.Group();
    g.position.set((ax+bx)/2,0,(az+bz)/2);
    g.rotation.y=-Math.atan2(bz-az,bx-ax);
    const ops=S.openings.filter(o=>o.wall===wi)
      .map(o=>({s:clamp(o.u*L-o.width/2,0,L),e:clamp(o.u*L+o.width/2,0,L),o}))
      .sort((p,q)=>p.s-q.s);
    const box=(len,hgt,y0,x0,mat)=>{
      if(len<=.004||hgt<=.004) return;
      const mesh=new THREE.Mesh(new THREE.BoxGeometry(len,hgt,T),mat);
      mesh.position.set(x0-L/2+len/2,y0+hgt/2,0);
      mesh.castShadow=true; mesh.receiveShadow=true;
      mesh.userData={h:hgt,y0:y0+hgt/2};
      g.add(mesh);
    };
    let cur=0;
    for(const {s,e,o} of ops){
      if(s>cur) box(s-cur,H,0,cur,matW);
      const head=Math.min(o.head,H);
      if(o.sill>.004) box(e-s,o.sill,0,s,matW);
      if(head<H-.004) box(e-s,H-head,head,s,matW);
      if(o.kind==='window'&&!modelMode){
        const gl=new THREE.Mesh(new THREE.BoxGeometry(e-s,head-o.sill,T*.16),MAT.glass);
        gl.position.set(s-L/2+(e-s)/2,o.sill+(head-o.sill)/2,0);
        gl.userData={h:head-o.sill,y0:o.sill+(head-o.sill)/2};
        g.add(gl);
      }
      cur=e;
    }
    if(cur<L) box(L-cur,H,0,cur,matW);
    shell.add(g);
  });

  if(!S.raised){
    orbit.r=Math.max(4,Math.max((maxX-minX)*m,(maxY-minY)*m)*1.35);
    orbit.ty=H*.55; orbit.tx=0; orbit.tz=0;
  }
  applyEnv(); applyRise(S.raised?1:0);
  $('#stageEmpty').style.display='none';
}
function applyEnv(){
  const r=S.mode==='render';
  scene.environment=r?envRT.texture:null;
  scene.background=new THREE.Color(r?0xBFC6CC:0xCFCABF);
  hemi.intensity=r?.28:.78; sun.intensity=r?2.3:1.15;
  renderer.toneMappingExposure=r?1.05:1;
}
function raise(){
  if($('#tRaise').disabled) return;
  bodyEl.classList.remove('no3d');
  build3D(); S.raised=true; raiseT=0; raising=true;
  requestAnimationFrame(resize3D); refresh();
  say('Drag to orbit. Switch to Render when the shape is right.');
}
$('#mModel').onclick=()=>setMode('model');
$('#mRender').onclick=()=>setMode('render');
function setMode(m){
  S.mode=m;
  $('#mModel').setAttribute('aria-pressed',String(m==='model'));
  $('#mRender').setAttribute('aria-pressed',String(m==='render'));
  if(S.raised){ build3D(); applyRise(1); }
}
$('#vOrbit').onclick=()=>setCam('orbit');
$('#vEye').onclick=()=>setCam('eye');
function setCam(c){
  S.cam=c;
  $('#vOrbit').setAttribute('aria-pressed',String(c==='orbit'));
  $('#vEye').setAttribute('aria-pressed',String(c==='eye'));
  if(c==='eye'){ orbit.r=Math.min(orbit.r,3.2); orbit.el=.02; }
  else{ orbit.el=Math.max(orbit.el,.35); orbit.r=Math.max(orbit.r,7); }
}
$('#expand').onclick=()=>{ bodyEl.classList.toggle('wide3d'); requestAnimationFrame(resize3D); };

/* ══ export ═════════════════════════════════════════════════════════ */
function download(url,name){
  const a=document.createElement('a'); a.href=url; a.download=name; a.click();
  setTimeout(()=>URL.revokeObjectURL(url),4000);
}
const slug=()=>(S.name||'plan').replace(/[^\w\u0590-\u05FF -]/g,'').trim().replace(/\s+/g,'-')||'plan';

$('#xPng').onclick=()=>{
  if(!renderer) return;
  closePops();
  const pr=renderer.getPixelRatio(), r=stage.getBoundingClientRect();
  renderer.setPixelRatio(Math.min(3,pr*2));
  renderer.setSize(r.width,r.height,false);
  renderer.render(scene,camera);
  const url=renderer.domElement.toDataURL('image/png');
  renderer.setPixelRatio(pr); resize3D();
  download(url,slug()+'.png');
  toast('Image saved.');
};

$('#xObj').onclick=()=>{
  if(!shell) return;
  closePops();
  shell.updateMatrixWorld(true);
  const V=[],N=[],F=[]; let off=1;
  const p=new THREE.Vector3(), n=new THREE.Vector3();
  shell.traverse(o=>{
    if(!o.isMesh||!o.geometry) return;
    const g=o.geometry, pos=g.attributes.position, nor=g.attributes.normal, idx=g.index;
    if(!pos) return;
    const nm=new THREE.Matrix3().getNormalMatrix(o.matrixWorld);
    for(let i=0;i<pos.count;i++){
      p.fromBufferAttribute(pos,i).applyMatrix4(o.matrixWorld);
      V.push(`v ${p.x.toFixed(4)} ${p.y.toFixed(4)} ${p.z.toFixed(4)}`);
      if(nor){ n.fromBufferAttribute(nor,i).applyMatrix3(nm).normalize();
        N.push(`vn ${n.x.toFixed(4)} ${n.y.toFixed(4)} ${n.z.toFixed(4)}`); }
    }
    const tri=(a,b,c)=>F.push(`f ${a+off}//${a+off} ${b+off}//${b+off} ${c+off}//${c+off}`);
    if(idx) for(let i=0;i<idx.count;i+=3) tri(idx.getX(i),idx.getX(i+1),idx.getX(i+2));
    else for(let i=0;i<pos.count;i+=3) tri(i,i+1,i+2);
    off+=pos.count;
  });
  const body=['# pdf2model — '+S.name,'# metres, Y up','g '+slug(),...V,...N,...F].join('\n');
  download(URL.createObjectURL(new Blob([body],{type:'text/plain'})),slug()+'.obj');
  toast('OBJ saved. Opens in SketchUp, Blender, Rhino.');
};

$('#xJson').onclick=()=>{
  closePops();
  const data=JSON.stringify(serialize(),null,2);
  download(URL.createObjectURL(new Blob([data],{type:'application/json'})),slug()+'.json');
  toast('Tracing data saved.');
};

/* ══ boot ═══════════════════════════════════════════════════════════ */
document.addEventListener('click',e=>{
  if(!e.target.closest('#opt,#exp,#tOpt,#tExp')) closePops();
});
sizeCanvas(); draw(); refresh();
new ResizeObserver(()=>{sizeCanvas();draw();resize3D();}).observe(document.body);
Cloud.init();
