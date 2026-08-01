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
  chain:[], cursor:null, snap:null, guides:[], hoverWall:-1, sel:null,
  dims:{wall:.20, ceil:2.70, door:.90, win:1.20, sill:.90},
  raised:false, mode:'model', cam:'orbit',
  proposal:null,
  scaleSrc:null,
  projectId:null, name:'תוכנית ללא שם', pdfBytes:null, pdfName:'', dirty:false
};
let uid = 1;
/* Which magnets are live. Declared here with the rest of the state because
   the settings popover is wired long before the engine that reads them. */
const SNAP = {
  node:1, corner:1, mid:1, inter:1, perp:1, ext:1, par:1, angle:1, grid:0,
  angleStep:15, gridCm:10,
};
const SNAP_NAME = {
  node:'פינה שלכם', corner:'פינה בשרטוט', mid:'אמצע קיר', inter:'חיתוך',
  perp:'ניצב', ext:'המשך קיר', par:'מקביל', angle:'זווית', grid:'רשת',
};
try{
  const saved=JSON.parse(localStorage.getItem('pdf2model.snap')||'null');
  if(saved&&typeof saved==='object') Object.assign(SNAP,saved);
}catch(e){}
function saveSnapPrefs(){
  try{ localStorage.setItem('pdf2model.snap',JSON.stringify(SNAP)); }catch(e){}
}

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

const planEl=$('#plan'), cv=$('#planCv'), ctx=cv.getContext('2d');
const bodyEl=$('#body'), msg=$('#msg'), liveDim=$('#liveDim'), tally=$('#tally'), snapState=$('#snapState');

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const fmt=m=>(m===null||!isFinite(m))?'—':(m>=1?m.toFixed(2)+' מ׳':Math.round(m*100)+' ס״מ');
const say=t=>{msg.textContent=t;};
const toScreen=p=>({x:p.x*S.view.z+S.view.x,y:p.y*S.view.z+S.view.y});
const toSrc=p=>({x:(p.x-S.view.x)/S.view.z,y:(p.y-S.view.y)/S.view.z});
const node=id=>S.nodes.find(n=>n.id===id);
/* Identity, not position. Openings used to point at a wall by its index in the
   array, so deleting one wall renumbered every opening after it and any code
   holding an index was quietly pointing at the wrong thing. Everything is
   addressed by id now; an index is only ever a loop variable. */
const wallById=id=>S.walls.find(w=>w.id===id);
const openingById=id=>S.openings.find(o=>o.id===id);

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
      $('#privacyLine').textContent='או גררו את הקובץ לכאן. שום דבר לא יוצא מהדפדפן.';
      setSave('מקומי בלבד','');
      return;
    }
    try{
      firebase.initializeApp(cfg);
      this.db=firebase.firestore(); this.st=firebase.storage();
      const cred=await firebase.auth().signInAnonymously();
      this.uid=cred.user.uid; this.on=true;
      $('#privacyLine').textContent='או גררו את הקובץ לכאן. התוכניות שלכם פרטיות לדפדפן הזה.';
      setSave('מוכן','');
      listProjects();
    }catch(e){
      console.error('[cloud]',e);
      setSave('לא מקוון','warn');
      /* sign-in failed, so nothing is going anywhere — say so rather than leaving
         the line that implies the plan is being stored */
      $('#privacyLine').textContent='או גררו את הקובץ לכאן. שום דבר לא יוצא מהדפדפן.';
      toast('ההתחברות לענן נכשלה. אפשר להמשיך לעבוד — פשוט שום דבר לא יישמר.');
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
/* Firestore rejects two things this model produces naturally, and both were
   silently killing every save — which is why nothing could be reopened: the
   list was empty because nothing had ever been written.

   1. undefined. Detection builds walls with a measured thickness, but a wall
      that came from the manual tool has none, so `t` arrived as undefined.
   2. an array directly inside an array. Rooms are polygons — arrays of points
      inside an array of rooms — which Firestore will not store at all.

   Rooms are derived from the walls anyway, so they are recomputed on load
   rather than persisted, and everything else is stripped of undefined. */
const noUndef = v => {
  if (Array.isArray(v)) return v.map(noUndef);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k in v) if (v[k] !== undefined) o[k] = noUndef(v[k]);
    return o;
  }
  return v === undefined ? null : v;
};
function serialize(){
  return noUndef({
    uid:Cloud.uid, name:S.name, pdfName:S.pdfName, pageNum:S.pageNum, mpp:S.mpp,
    dims:S.dims, nodes:S.nodes, walls:S.walls, openings:S.openings,
    uidSeq:uid, updatedAt:Date.now()
  });
}
function hydrate(d){
  S.name=d.name||'תוכנית ללא שם'; S.pdfName=d.pdfName||''; S.mpp=d.mpp??null;
  S.dims=Object.assign(S.dims,d.dims||{});
  S.nodes=d.nodes||[]; S.walls=d.walls||[]; S.openings=d.openings||[];
  /* plans saved before openings carried a wall id still point by index */
  S.openings=S.openings.map(o=>{
    if(o.wallId!=null) return o;
    const w=S.walls[o.wall];
    return w?{...o,wallId:w.id,wall:undefined}:null;
  }).filter(Boolean);
  /* rooms are derived, never stored — recompute them from the walls */
  S.rooms=[];
  uid=d.uidSeq||1000;
  $('#pname').value=S.name;
  ['oWall','oCeil','oDoor','oWin','oSill'].forEach(id=>{
    const k={oWall:'wall',oCeil:'ceil',oDoor:'door',oWin:'win',oSill:'sill'}[id];
    $('#'+id).value=S.dims[k];
  });
  if(S.mpp){
    $('#chipScale').classList.remove('unset');
    $('#scaleVal').textContent=(1/S.mpp).toFixed(1)+' px = 1 מ׳';
    ['#tWall','#tDoor','#tWin'].forEach(s=>$(s).disabled=false);
  }
}

let saveT;
function touch(){
  S.dirty=true;
  if(!Cloud.on||!S.projectId) return;
  setSave('לא נשמר','busy');
  clearTimeout(saveT); saveT=setTimeout(save,1200);
}
async function save(){
  if(!Cloud.on||!S.projectId) return;
  try{
    setSave('שומר…','busy');
    await Cloud.doc().set(serialize(),{merge:true});
    S.dirty=false;
    setSave('נשמר '+new Date().toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'}),'ok');
  }catch(e){ console.error(e); setSave('השמירה נכשלה','warn'); }
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
      b.innerHTML=`<span class="nm">${escapeHtml(v.name||'ללא שם')}</span><span class="when">${when(v.updatedAt)}</span>`;
      b.onclick=()=>openProject(d.id);
      const row=document.createElement('div'); row.className='rec-row';
      const del=document.createElement('button');
      del.className='rec-del'; del.type='button';
      del.setAttribute('aria-label','מחיקת '+(v.name||'התוכנית'));
      del.innerHTML='<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4"/></svg>';
      del.onclick=e=>{ e.stopPropagation(); deleteProject(d.id,v.name||'התוכנית'); };
      row.appendChild(b); row.appendChild(del);
      list.appendChild(row);
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
async function deleteProject(id,name){
  if(!Cloud.on) return;
  if(!confirm('למחוק את "'+name+'"? אי אפשר לשחזר.')) return;
  try{
    await Cloud.db.collection('projects').doc(id).delete();
    try{ await Cloud.st.ref(`plans/${Cloud.uid}/${id}.pdf`).delete(); }
    catch(e){ console.warn('[del pdf]',e); }   // the doc is gone either way
    if(S.projectId===id) S.projectId=null;
    toast('התוכנית נמחקה.');
    listProjects();
  }catch(e){ console.error(e); toast('לא הצלחנו למחוק את התוכנית.'); }
}

async function openProject(id){
  try{
    say('פותח…');
    const doc=await Cloud.db.collection('projects').doc(id).get();
    if(!doc.exists){ toast('התוכנית הזאת כבר לא קיימת.'); return; }
    S.projectId=id; hydrate(doc.data());
    const bytes=await Cloud.getPDF(id);
    await openBytes(bytes,S.pdfName||'plan.pdf',doc.data().pageNum||1);
    S.rooms=findRooms();
    if(S.walls.length>=3&&S.mpp) raise();
    refresh(); draw();
    setSave('Saved','ok');
    say(S.mpp?'אפשר להמשיך לסמן.':'קבעו קנה מידה כדי להתחיל.');
  }catch(e){ console.error(e); toast('לא הצלחנו לפתוח את התוכנית הזאת.'); }
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
  if(f) loadFile(f); else if(e.dataTransfer.files.length) toast('זה לא קובץ PDF. פתחו תוכנית בפורמט PDF.');
});

async function loadFile(file){
  if(file.size>25*1024*1024){ toast('הקובץ גדול מ־25 מגה. ייצאו גרסה קלה יותר מתוכנת ה־PDF שלכם.'); return; }
  say('קורא את '+file.name+'…');
  const bytes=await file.arrayBuffer();
  S.name=file.name.replace(/\.pdf$/i,'');
  $('#pname').value=S.name;
  const ok=await openBytes(bytes,file.name,1);
  if(!ok) return;
  if(Cloud.on){
    try{
      S.projectId=await Cloud.createId();
      setSave('שומר…','busy');
      await Cloud.putPDF(bytes,file.name);
      await save();
    }catch(e){ console.error(e); setSave('השמירה נכשלה','warn'); toast('התוכנית נפתחה, אבל לא הצלחנו לשמור אותה בענן.'); }
  }
}

async function openBytes(bytes,name,page){
  if(!window.pdfjsLib){ toast('מנוע ה־PDF לא נטען. בדקו את החיבור ורעננו את הדף.'); return false; }
  try{
    S.pdfBytes=bytes.slice(0); S.pdfName=name;
    S.doc=await pdfjsLib.getDocument({data:bytes.slice(0)}).promise;
    S.numPages=S.doc.numPages;
    $('#pager').hidden=S.numPages<2;
    $('#pname').hidden=false; $('#newBtn').hidden=false;
    await renderPage(clamp(page,1,S.numPages));
    $('#empty').style.display='none';
    $('#chipScale').hidden=false;
    ['#tCal','#tOpt','#tSnap'].forEach(s=>$(s).disabled=false);
    $('#tAuto').disabled=!S.mpp;
    setTool(S.mpp?'wall':'calibrate');
    refresh();
    return true;
  }catch(err){
    console.error(err);
    toast('לא הצלחנו לפתוח את הקובץ. ייתכן שהוא מוגן בסיסמה או פגום.');
    say('פתחו קובץ PDF כדי להתחיל.');
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
  /* read the page's own linework in the background — the sheet is already up */
  clearVectors(); vecState();
  VEC.pageScale=vp.scale;
  const token=VEC.token, page=S.page;
  Promise.all([readVectors(page,vp,token),readText(page,vp,token)]).then(()=>{
    if(token!==VEC.token) return;
    vecState(); draw();
    if(!S.mpp) autoBuild();
  });
}
$('#prevPg').onclick=()=>{ if(S.pageNum>1){renderPage(S.pageNum-1);touch();} };
$('#nextPg').onclick=()=>{ if(S.pageNum<S.numPages){renderPage(S.pageNum+1);touch();} };

$('#pname').oninput=e=>{ S.name=e.target.value||'תוכנית ללא שם'; touch(); };
$('#pname').onkeydown=e=>{ if(e.key==='Enter') e.target.blur(); };

/* ══ vector geometry ════════════════════════════════════════════════
   A drawing that still carries real paths already knows where its own corners
   are. We read them out of the operator list and offer them to the snap, so a
   traced corner lands on the architect's line instead of on a pixel the user
   aimed at. Nothing here draws a wall or decides what anything means — it only
   surfaces points the drawing already contains, and Shift ignores them. */
const VEC={pts:null,grid:null,segs:null,text:null,pageScale:0,cell:8,token:0};
const VEC_MAX=90000;

const matMul=(a,b)=>[
  a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
  a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
  a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];

function clearVectors(){ VEC.pts=null; VEC.grid=null; VEC.segs=null; VEC.text=null; VEC.token++; }

async function readVectors(page,vp,token){
  if(!window.pdfjsLib||!pdfjsLib.OPS) return;
  let ol;
  try{ ol=await page.getOperatorList(); }
  catch(e){ console.warn('[vector]',e); return; }
  if(token!==VEC.token) return;

  const O=pdfjsLib.OPS, W=vp.width, H=vp.height;
  let m=vp.transform.slice();
  const stack=[], xs=[], ys=[], sg=[];
  /* segments as well as endpoints: a wall is a pair of parallel faces, and you
     cannot see a pair from endpoints alone. */
  let pathFrom=0;
  const seg=(x1,y1,x2,y2)=>{
    if(sg.length>=VEC_MAX*2) return;
    const ax=m[0]*x1+m[2]*y1+m[4], ay=m[1]*x1+m[3]*y1+m[5];
    const bx=m[0]*x2+m[2]*y2+m[4], by=m[1]*x2+m[3]*y2+m[5];
    if(!isFinite(ax)||!isFinite(ay)||!isFinite(bx)||!isFinite(by)) return;
    if(Math.hypot(bx-ax,by-ay)<1.5) return;
    sg.push(ax,ay,bx,by,0);          // 5th value: 1 once we learn the path was filled
  };
  const put=(x,y)=>{
    if(xs.length>=VEC_MAX) return;
    const px=m[0]*x+m[2]*y+m[4], py=m[1]*x+m[3]*y+m[5];
    if(!isFinite(px)||!isFinite(py)) return;
    if(px<-8||py<-8||px>W+8||py>H+8) return;   // off the sheet
    xs.push(px); ys.push(py);
  };

  for(let i=0;i<ol.fnArray.length;i++){
    const fn=ol.fnArray[i], a=ol.argsArray[i];
    if(fn===O.save) stack.push(m.slice());
    else if(fn===O.restore){ if(stack.length) m=stack.pop(); }
    else if(fn===O.transform) m=matMul(m,a);
    else if(fn===O.paintFormXObjectBegin){ stack.push(m.slice()); if(a&&a[0]) m=matMul(m,a[0]); }
    else if(fn===O.paintFormXObjectEnd){ if(stack.length) m=stack.pop(); }
    else if(fn===O.fill||fn===O.eoFill||fn===O.fillStroke||fn===O.eoFillStroke){
      /* Wall poché is filled; a window symbol, a door swing and furniture are
         stroked. Knowing which is which is the only way to see that a wall stops
         at an opening — the glazing lines sit exactly where the faces would be. */
      for(let k=pathFrom;k<sg.length;k+=5) sg[k+4]=1;
    }
    else if(fn===O.constructPath){
      pathFrom=sg.length;
      const ops=a[0], co=a[1];
      let k=0, sx=0, sy=0, cx=0, cy=0, open=false;
      for(let j=0;j<ops.length;j++){
        const op=ops[j];
        if(op===O.moveTo){ sx=cx=co[k++]; sy=cy=co[k++]; put(cx,cy); open=true; }
        else if(op===O.lineTo){
          const nx=co[k++], ny=co[k++];
          put(nx,ny); if(open) seg(cx,cy,nx,ny);
          cx=nx; cy=ny;
        }
        else if(op===O.curveTo){ k+=4; cx=co[k++]; cy=co[k++]; put(cx,cy); }
        else if(op===O.curveTo2||op===O.curveTo3){ k+=2; cx=co[k++]; cy=co[k++]; put(cx,cy); }
        else if(op===O.closePath){ if(open) seg(cx,cy,sx,sy); cx=sx; cy=sy; }
        else if(op===O.rectangle){
          const x=co[k++], y=co[k++], w=co[k++], h=co[k++];
          put(x,y); put(x+w,y); put(x+w,y+h); put(x,y+h);
          seg(x,y,x+w,y); seg(x+w,y,x+w,y+h); seg(x+w,y+h,x,y+h); seg(x,y+h,x,y);
          cx=sx=x; cy=sy=y; open=true;
        }
      }
    }
    if(xs.length>=VEC_MAX) break;
  }
  if(token!==VEC.token) return;

  /* dedupe to half a source pixel, then bucket for lookup */
  const seen=new Set(), pts=[];
  for(let i=0;i<xs.length;i++){
    const key=Math.round(xs[i]*2)+','+Math.round(ys[i]*2);
    if(seen.has(key)) continue;
    seen.add(key); pts.push(xs[i],ys[i]);
  }
  const grid=new Map();
  for(let i=0;i<pts.length;i+=2){
    const key=Math.floor(pts[i]/VEC.cell)+','+Math.floor(pts[i+1]/VEC.cell);
    const b=grid.get(key); if(b) b.push(i); else grid.set(key,[i]);
  }
  VEC.pts=pts; VEC.grid=grid; VEC.segs=sg;
}

function vecNear(p,R){
  if(!VEC.grid) return null;
  const c=VEC.cell, span=Math.ceil(R/c);
  const gx=Math.floor(p.x/c), gy=Math.floor(p.y/c);
  let best=null, bd=R*R;
  for(let i=-span;i<=span;i++)for(let j=-span;j<=span;j++){
    const b=VEC.grid.get((gx+i)+','+(gy+j)); if(!b) continue;
    for(const k of b){
      const dx=VEC.pts[k]-p.x, dy=VEC.pts[k+1]-p.y, d=dx*dx+dy*dy;
      if(d<bd){ bd=d; best={x:VEC.pts[k],y:VEC.pts[k+1],kind:'vector'}; }
    }
  }
  return best;
}

/* ══ reading the scale off the drawing ══════════════════════════════
   A plan states its own scale. Ours reads it two independent ways and only
   trusts the answer when it can defend it:

     A. the printed ratio — "1:100", "קנ״מ 1:50" — which with the page's own
        physical size gives an exact answer, no measuring involved;
     B. the dimension strings the architect lettered, each matched to the
        dimension line it annotates, taking the median of what they agree on.

   This is reading, not guessing, and it is never silent: what was read and how
   is on screen, and one click replaces it with a hand calibration. */
async function readText(page,vp,token){
  try{
    const tc=await page.getTextContent();
    if(token!==VEC.token) return;
    const T=vp.transform, out=[];
    for(const it of tc.items){
      const s=(it.str||'').trim(); if(!s) continue;
      const m=it.transform;
      const x=T[0]*m[4]+T[2]*m[5]+T[4], y=T[1]*m[4]+T[3]*m[5]+T[5];
      const h=Math.hypot(T[1]*m[3],T[3]*m[3])||8;
      const dx=T[0]*m[0]+T[2]*m[1], dy=T[1]*m[0]+T[3]*m[1];
      const ang=Math.atan2(dy,dx);
      const w=(it.width||0)*Math.hypot(T[0],T[1]);
      out.push({s,x,y,w,h,ang,cx:x+Math.cos(ang)*w/2,cy:y+Math.sin(ang)*w/2});
    }
    VEC.text=out;
  }catch(e){ console.warn('[text]',e); }
}

/* A. the ratio the drawing prints on itself */
function scaleFromRatio(){
  if(!VEC.text||!VEC.pageScale) return null;
  const KEY=/(קנ|קנה\s*מידה|scale|scl)/i;
  let best=null;
  for(const t of VEC.text){
    const m=t.s.match(/\b1\s*[:\/]\s*(\d{1,4})\b/);
    if(!m) continue;
    const R=+m[1];
    if(R<10||R>1000) continue;
    const near=KEY.test(t.s)?2:1;
    if(!best||near>best.near) best={R,near,src:t.s};
  }
  if(!best) return null;
  /* one pdf point is 25.4/72 mm of paper; at 1:R that is R times as much building */
  const mpp=(25.4/72)/VEC.pageScale*best.R/1000;
  return {mpp,how:'ratio',label:'1:'+best.R,detail:best.src};
}

/* B. the dimension strings, each against the line it annotates */
function scaleFromDimensions(){
  if(!VEC.text||!VEC.segs) return null;
  const nums=[];
  for(const t of VEC.text){
    const m=t.s.match(/^([0-9]{1,3}(?:[.,][0-9]{1,2})?|[0-9]{2,5})$/);
    if(!m) continue;
    const v=parseFloat(m[1].replace(',','.'));
    if(!isFinite(v)||v<=0) continue;
    nums.push({...t,v,dec:/[.,]/.test(m[1])});
  }
  if(nums.length<3) return null;

  const ests=[];
  for(const n of nums){
    const R=Math.max(n.h*2.6,14);
    let bestSeg=null,bd=R;
    for(let i=0;i<VEC.segs.length;i+=4){
      const x1=VEC.segs[i],y1=VEC.segs[i+1],x2=VEC.segs[i+2],y2=VEC.segs[i+3];
      const L=Math.hypot(x2-x1,y2-y1);
      if(L<n.w*0.8) continue;                       // a tick is not a dimension line
      let a=Math.atan2(y2-y1,x2-x1)-n.ang;
      a=Math.atan2(Math.sin(a),Math.cos(a));
      if(Math.abs(Math.sin(a))>0.12) continue;      // must run with the lettering
      const d=Math.hypot((x1+x2)/2-n.cx,(y1+y2)/2-n.cy);
      if(d<bd){ bd=d; bestSeg=L; }
    }
    if(bestSeg) ests.push({r:n.v/bestSeg,dec:n.dec,v:n.v});
  }
  if(ests.length<3) return null;

  const rs=ests.map(e=>e.r).sort((a,b)=>a-b);
  const med=rs[rs.length>>1];
  /* how many agree with the median within 2%? that is the confidence */
  const agree=rs.filter(r=>Math.abs(r-med)/med<0.02).length;
  if(agree<3) return null;

  /* metres or centimetres: pick whichever puts the sheet at a believable size */
  const plausible=v=>v*S.srcW>3&&v*S.srcW<400;
  const asM=med, asCm=med/100;
  const decimals=ests.filter(e=>e.dec).length;
  let mpp=null,unit='';
  if(plausible(asM)&&(decimals>ests.length/2||!plausible(asCm))){ mpp=asM; unit='מ׳'; }
  else if(plausible(asCm)){ mpp=asCm; unit='ס״מ'; }
  if(!mpp) return null;
  return {mpp,how:'dims',label:agree+' מידות רשומות',detail:'ביחידות '+unit,agree};
}

function inferScale(){
  const a=scaleFromRatio(), b=scaleFromDimensions();
  if(a&&b){
    const off=Math.abs(a.mpp-b.mpp)/a.mpp;
    if(off<0.03) return {...a,how:'both',label:a.label,detail:'מאושר מול '+b.label};
    return a;                       // the printed ratio is exact; prefer it
  }
  return a||b||null;
}

/* ══ wall detection ═════════════════════════════════════════════════
   A wall on a drawing is two parallel faces a plausible thickness apart. We
   look for exactly that, and for nothing else — no learning, no guessing at
   what a symbol means. What comes out is a PROPOSAL: it is drawn as a dashed
   overlay, every run can be switched off, and not one line becomes geometry
   until the user accepts it. Nothing is ever presented as measured fact that
   the user did not agree to. */
const DET={minLen:0.80, tMin:0.05, tMax:0.42, angTol:0.030, overlap:0.60, joinTol:0.25};

function detectWalls(){
  if(!VEC.segs||!S.mpp) return [];
  const px=v=>v/S.mpp;                       // metres → source pixels
  const minLen=px(DET.minLen), tMin=px(DET.tMin), tMax=px(DET.tMax);
  const sg=VEC.segs;

  /* keep the long, straight faces and index them by direction */
  const segs=[];
  for(let i=0;i<sg.length;i+=5){
    const x1=sg[i],y1=sg[i+1],x2=sg[i+2],y2=sg[i+3];
    const dx=x2-x1, dy=y2-y1, L=Math.hypot(dx,dy);
    if(L<minLen) continue;
    let th=Math.atan2(dy,dx); if(th<0) th+=Math.PI; if(th>=Math.PI-1e-9) th=0;
    segs.push({i:segs.length,x1,y1,x2,y2,th,L,ux:dx/L,uy:dy/L});
    if(segs.length>6000) break;
  }
  if(segs.length<2) return [];

  const buckets=new Map();
  const key=th=>Math.round(th/DET.angTol);
  for(const s of segs){
    const k=key(s.th);
    for(const kk of [k-1,k,k+1]){ const b=buckets.get(kk); if(b) b.push(s); else buckets.set(kk,[s]); }
  }

  /* a pair of parallel faces, close enough and overlapping enough, is a wall */
  const cands=[];
  const seen=new Set();
  for(const [,list] of buckets){
    for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length;j++){
      const a=list[i], b=list[j];
      let d=Math.abs(a.th-b.th); d=Math.min(d,Math.PI-d);
      if(d>DET.angTol*1.5) continue;
      /* perpendicular gap between the two lines */
      const nx=-a.uy, ny=a.ux;
      const gap=Math.abs((b.x1-a.x1)*nx+(b.y1-a.y1)*ny);
      if(gap<tMin||gap>tMax) continue;
      /* projected overlap along the shared direction */
      const t=p=>(p.x-a.x1)*a.ux+(p.y-a.y1)*a.uy;
      const a0=0, a1=a.L;
      let b0=t({x:b.x1,y:b.y1}), b1=t({x:b.x2,y:b.y2});
      if(b0>b1){ const s2=b0; b0=b1; b1=s2; }
      const lo=Math.max(a0,b0), hi=Math.min(a1,b1);
      const ov=hi-lo;
      if(ov<minLen||ov<DET.overlap*Math.min(a.L,b.L)) continue;
      const id=Math.min(a.i,b.i)+':'+Math.max(a.i,b.i); if(seen.has(id)) continue; seen.add(id);
      /* centreline: the overlapping span, pushed half the gap toward b */
      const side=((b.x1-a.x1)*nx+(b.y1-a.y1)*ny)>0?1:-1;
      const ox=nx*side*gap/2, oy=ny*side*gap/2;
      cands.push({
        a:{x:a.x1+a.ux*lo+ox, y:a.y1+a.uy*lo+oy},
        b:{x:a.x1+a.ux*hi+ox, y:a.y1+a.uy*hi+oy},
        th:a.th, t:gap*S.mpp
      });
    }
  }
  cands.sort((a,b)=>dist(b.a,b.b)-dist(a.a,a.b));
  return joinRuns(weldRuns(mergeCollinear(cands,px(0.12)),px(0.85)),px(0.10));
}

/* two candidates on the same line that overlap or nearly touch are one wall */
function mergeCollinear(cands,tol){
  const out=[];
  for(const c of cands){
    let merged=false;
    for(const o of out){
      const ux=Math.cos(o.th), uy=Math.sin(o.th);
      let d=Math.abs(o.th-c.th); d=Math.min(d,Math.PI-d);
      if(d>DET.angTol*1.5) continue;
      const nx=-uy, ny=ux;
      if(Math.abs((c.a.x-o.a.x)*nx+(c.a.y-o.a.y)*ny)>tol) continue;
      const t=p=>(p.x-o.a.x)*ux+(p.y-o.a.y)*uy;
      const oe=t(o.b), ca=t(c.a), cb=t(c.b);
      const lo=Math.min(0,oe,ca,cb), hi=Math.max(0,oe,ca,cb);
      if(Math.min(ca,cb)>Math.max(0,oe)+tol||Math.max(ca,cb)<Math.min(0,oe)-tol) continue;
      const bx=o.a.x, by=o.a.y;
      o.a={x:bx+ux*lo,y:by+uy*lo}; o.b={x:bx+ux*hi,y:by+uy*hi};
      o.t=Math.max(o.t,c.t); merged=true; break;
    }
    if(!merged) out.push({...c});
  }
  return out;
}

/* Weld the network. Two wall centrelines that ought to meet almost never do:
   each one stops at the FACE of the wall it runs into, half a thickness short,
   and a corner between two 25cm walls leaves both ends 12cm from where the
   corner actually is. Averaging those endpoints put the corner in the wrong
   place and left the graph a forest — 26 loose ends out of 27 nodes, and not a
   single room closed.

   So do the geometry instead: intersect the two infinite lines. That point IS
   the corner. Extend a run to reach it, trim a run that overshoots it, and split
   a run the point lands in the middle of, which is a tee. */
function weldRuns(runs,reach){
  const touch=(idx,t,P)=>{
    const R=runs[idx];
    if(t<=0.02){ if(dist(R.a,P)<1) return false; R.a={...P}; return true; }
    if(t>=0.98){ if(dist(R.b,P)<1) return false; R.b={...P}; return true; }
    if(dist(R.a,P)<2||dist(R.b,P)<2) return false;
    runs.push({a:{...P},b:{...R.b},th:R.th,th2:R.th,t:R.t});
    R.b={...P};
    return true;
  };
  for(let pass=0;pass<6;pass++){
    let changed=false;
    for(let i=0;i<runs.length&&runs.length<500;i++){
      for(let j=i+1;j<runs.length&&runs.length<500;j++){
        const A=runs[i], B=runs[j];
        const ax=A.b.x-A.a.x, ay=A.b.y-A.a.y, bx=B.b.x-B.a.x, by=B.b.y-B.a.y;
        const LA=Math.hypot(ax,ay), LB=Math.hypot(bx,by);
        if(LA<1||LB<1) continue;
        const den=ax*by-ay*bx;
        if(Math.abs(den)/(LA*LB)<0.34) continue;        // under ~20°, they are parallel
        const dx=B.a.x-A.a.x, dy=B.a.y-A.a.y;
        const t=(dx*by-dy*bx)/den, u=(dx*ay-dy*ax)/den;
        const rA=reach/LA, rB=reach/LB;
        if(t<-rA||t>1+rA||u<-rB||u>1+rB) continue;
        const P={x:A.a.x+ax*t,y:A.a.y+ay*t};
        if(touch(i,t,P)) changed=true;
        if(touch(j,u,P)) changed=true;
      }
    }
    if(!changed) break;
  }
  return runs.filter(r=>dist(r.a,r.b)>2);
}

/* pull endpoints that nearly meet onto one shared corner, so the runs connect */
function joinRuns(runs,tol){
  const ends=[];
  runs.forEach((r,i)=>{ ends.push({r:i,k:'a',p:r.a}); ends.push({r:i,k:'b',p:r.b}); });
  const used=new Array(ends.length).fill(false);
  for(let i=0;i<ends.length;i++){
    if(used[i]) continue;
    const group=[i];
    for(let j=i+1;j<ends.length;j++){
      if(used[j]||ends[j].r===ends[i].r) continue;
      if(dist(ends[i].p,ends[j].p)<tol){ group.push(j); used[j]=true; }
    }
    if(group.length<2) continue;
    let sx=0,sy=0;
    for(const g of group){ sx+=ends[g].p.x; sy+=ends[g].p.y; }
    const c={x:sx/group.length,y:sy/group.length};
    for(const g of group) runs[ends[g].r][ends[g].k]={...c};
  }
  return runs.filter(r=>dist(r.a,r.b)>1);
}

/* ══ the automatic path ═════════════════════════════════════════════
   Import a plan and the model stands. Everything the software worked out for
   itself stays on screen and stays replaceable — the scale it read, from where,
   and how many walls it found. When it cannot read the drawing it says so and
   asks, which is the old flow, unchanged. */
function autoBuild(){
  const g=inferScale();
  if(!g){
    setTool('calibrate');
    say('לא הצלחתי לקרוא את קנה המידה מהשרטוט. סמנו קיר אחד שאתם יודעים את אורכו.');
    refresh();
    return;
  }
  S.mpp=g.mpp; S.scaleSrc=g;
  $('#chipScale').classList.remove('unset');
  $('#scaleVal').textContent=(1/S.mpp).toFixed(1)+' px = 1 מ׳';
  ['#tWall','#tDoor','#tWin','#tAuto'].forEach(x=>$(x).disabled=false);

  const runs=(VEC.segs&&VEC.segs.length)?detectWalls():[];
  if(!runs.length){
    setTool('wall'); showAutoBar(g,0);
    say('קראתי את קנה המידה, אבל לא זיהיתי קירות. סמנו אותם — הפינות נצמדות לשרטוט.');
    refresh();
    return;
  }
  S.proposal=runs.map(r=>({a:r.a,b:r.b,t:r.t,on:true}));
  acceptProposal(true);
  showAutoBar(g,runs.length,S.openings.length);
  setTool('select');
  if(!$('#tRaise').disabled) raise();
  say('המודל מוכן. לחצו על קיר כדי לתפוס אותו בידיות, גררו פינה כדי למתוח, החצים מזיזים בס״מ.');
}

function showAutoBar(g,n,op){
  const bar=$('#autoBar'); if(!bar) return;
  bar.hidden=false;
  $('#autoScale').textContent=g.label;
  $('#autoHow').textContent=g.how==='ratio'?'נקרא מהשרטוט'
    :g.how==='dims'?'חושב מהמידות הרשומות':'נקרא מהשרטוט ואומת מול המידות';
  $('#autoWalls').textContent=n;
  $('#autoWallsWrap').hidden=!n;
  $('#autoOpen').textContent=op||0;
  $('#autoOpenWrap').hidden=!op;
}
function hideAutoBar(){ const b=$('#autoBar'); if(b) b.hidden=true; }
$('#autoManual').onclick=()=>{
  hideAutoBar();
  S.mpp=null; S.scaleSrc=null;
  $('#chipScale').classList.add('unset');
  $('#scaleVal').textContent='לא נקבע';
  pushHistory('חזרה לכיול ידני');
  S.nodes=[];S.walls=[];S.rooms=[];S.openings=[];S.chain=[];S.sel=null;S.proposal=null;
  S.raised=false; clear3D(); syncProposal();
  ['#tWall','#tDoor','#tWin','#tAuto'].forEach(x=>$(x).disabled=true);
  setTool('calibrate'); refresh(); draw();
  say('סמנו קיר אחד שאתם יודעים את אורכו, ואז הזינו את האורך.');
};
$('#autoDismiss').onclick=hideAutoBar;

/* ══ proposal ═══════════════════════════════════════════════════════ */
function proposeWalls(){
  if(!S.mpp){ toast('קודם קבעו קנה מידה — בלי קנה מידה אי אפשר לדעת מה עובי קיר.'); return; }
  if(!VEC.segs||!VEC.segs.length){
    toast('בעמוד הזה אין קווים וקטוריים לזהות. סמנו את הקירות ידנית.');
    return;
  }
  say('מזהה קירות…');
  setTimeout(()=>{
    const runs=detectWalls();
    if(!runs.length){
      S.proposal=null; syncProposal(); draw();
      toast('לא זוהו קירות בעמוד הזה. סמנו אותם ידנית.');
      say(PROMPT[S.tool]);
      return;
    }
    S.proposal=runs.map(r=>({a:r.a,b:r.b,t:r.t,on:true}));
    setTool('select'); syncProposal(); draw();
    say('בדקו את ההצעה. לחיצה על קיר מוציאה או מחזירה אותו.');
  },30);
}

function syncProposal(){
  const bar=$('#propBar'), p=S.proposal;
  bar.hidden=!p;
  if(!p) return;
  const on=p.filter(w=>w.on).length;
  $('#propCount').textContent=on;
  $('#propAccept').disabled=!on;
}

/* Rooms by flood fill, not by graph topology.

   Chasing planar faces through the wall graph never worked and was never going
   to: detected centrelines come out fragmented, a corner is two runs that stop
   short of each other, and one sub-centimetre gap anywhere turns a room into
   part of the outside. Measured on a clean 1:50 sheet — 26 loose ends out of 27
   nodes, one face.

   So stop reasoning about topology. Paint the walls into a grid, flood the
   outside from the border, and whatever is left enclosed is a room. A gap
   narrower than the wall thickness cannot leak, which is exactly the tolerance
   a drawing needs. Out comes a polygon per room, which is what floors, and
   later furniture, actually want. */
function findRooms(){
  if(!S.mpp||!S.walls.length) return [];
  const cell=Math.max(2,(0.06/S.mpp));
  let minX=1e9,minY=1e9,maxX=-1e9,maxY=-1e9;
  for(const w of S.walls){
    const a=node(w.a),b=node(w.b); if(!a||!b) continue;
    minX=Math.min(minX,a.x,b.x); maxX=Math.max(maxX,a.x,b.x);
    minY=Math.min(minY,a.y,b.y); maxY=Math.max(maxY,a.y,b.y);
  }
  if(minX>maxX) return [];
  const pad=cell*4;
  minX-=pad; minY-=pad; maxX+=pad; maxY+=pad;
  const W=Math.ceil((maxX-minX)/cell), H=Math.ceil((maxY-minY)/cell);
  if(W<6||H<6||W*H>700000) return [];

  const wall=new Uint8Array(W*H);

  /* Rooms are separated by walls, but a wall has a doorway in it, and at floor
     level a doorway joins the two rooms into one region — so the fill leaked
     through every door and returned the whole flat as a single room. Bridge the
     gaps that are door-shaped: collinear, nearly touching, under 1.4 m. Only in
     this grid; the model keeps its real openings. */
  const segsOf=[];
  for(const w of S.walls){
    const a=node(w.a),b=node(w.b); if(!a||!b) continue;
    segsOf.push({a,b,t:w.t,L:dist(a,b),th:Math.atan2(b.y-a.y,b.x-a.x)});
  }
  const bridges=[];
  const maxGap=1.9/S.mpp;
  for(let i=0;i<segsOf.length;i++)for(let j=i+1;j<segsOf.length;j++){
    const A=segsOf[i], B=segsOf[j];
    let d=Math.abs(A.th-B.th); d=Math.min(d,Math.PI-d);
    if(d>0.18) continue;
    const ux=Math.cos(A.th), uy=Math.sin(A.th), nx=-uy, ny=ux;
    if(Math.abs((B.a.x-A.a.x)*nx+(B.a.y-A.a.y)*ny)>0.18/S.mpp) continue;
    let best=null,bd=maxGap;
    for(const p of [A.a,A.b])for(const q of [B.a,B.b]){
      const g=dist(p,q);
      if(g>0.02/S.mpp&&g<bd){ bd=g; best=[p,q]; }
    }
    if(best) bridges.push({a:best[0],b:best[1],t:Math.max(A.t||0,B.t||0)});
  }

  /* The other way a room leaks: a wall stops short of the wall it runs into,
     because the piece between the last doorway and the corner was too small to
     detect. Measured on the test sheet — every wall present, but the partitions
     only 64-81% covered, and the shortfall is exactly the door holes and the
     stubs beside them. So from any free end, march along the wall's own line and
     if it meets a crossing wall within 2 m, close the gap. Only a run that
     actually lands on another wall is extended; one ending in open space is
     left alone, so a peninsula does not sprout. Grid only — the model keeps its
     real geometry and its real openings. */
  const near=(p,B)=>{
    const vx=B.b.x-B.a.x, vy=B.b.y-B.a.y, L2=vx*vx+vy*vy; if(!L2) return 1e9;
    const t=clamp(((p.x-B.a.x)*vx+(p.y-B.a.y)*vy)/L2,0,1);
    return Math.hypot(p.x-(B.a.x+vx*t),p.y-(B.a.y+vy*t));
  };
  const reach=2.0/S.mpp, joined=0.14/S.mpp;
  const extend=[];
  for(const A of segsOf){
    for(const [end,other] of [[A.a,A.b],[A.b,A.a]]){
      let touching=false;
      for(const B of segsOf){ if(B!==A&&near(end,B)<joined){ touching=true; break; } }
      if(touching) continue;
      const L=Math.hypot(end.x-other.x,end.y-other.y); if(L<1) continue;
      const ux=(end.x-other.x)/L, uy=(end.y-other.y)/L;
      let best=null;
      for(const B of segsOf){
        if(B===A) continue;
        let d=Math.abs(A.th-B.th); d=Math.min(d,Math.PI-d);
        if(d<0.35) continue;                                  // must genuinely cross
        const bx=B.b.x-B.a.x, by=B.b.y-B.a.y;
        const den=ux*by-uy*bx; if(Math.abs(den)<1e-9) continue;
        const dx=B.a.x-end.x, dy=B.a.y-end.y;
        const tr=(dx*by-dy*bx)/den, ts=(dx*uy-dy*ux)/den;
        if(tr<=0||tr>reach||ts<-0.03||ts>1.03) continue;
        if(!best||tr<best) best=tr;
      }
      if(best) extend.push({a:{...end},b:{x:end.x+ux*best,y:end.y+uy*best},t:A.t});
    }
  }

  for(const w of segsOf.concat(bridges,extend)){
    const a=w.a,b=w.b;
    const th=Math.max(S.dims.wall,(w.t||0))/S.mpp;
    const half=Math.max(1,Math.round(th/cell/2));
    const x0=(a.x-minX)/cell,y0=(a.y-minY)/cell,x1=(b.x-minX)/cell,y1=(b.y-minY)/cell;
    const n=Math.max(1,Math.ceil(Math.hypot(x1-x0,y1-y0)));
    /* eslint-disable-next-line */
    for(let i=0;i<=n;i++){
      const gx=Math.round(x0+(x1-x0)*i/n), gy=Math.round(y0+(y1-y0)*i/n);
      for(let dy=-half;dy<=half;dy++)for(let dx=-half;dx<=half;dx++){
        const X=gx+dx,Y=gy+dy;
        if(X>=0&&Y>=0&&X<W&&Y<H) wall[Y*W+X]=1;
      }
    }
  }

  /* everything reachable from the border without crossing a wall is outside */
  const mark=new Int32Array(W*H).fill(0);
  const stack=[];
  const push=(x,y)=>{ const k=y*W+x; if(x<0||y<0||x>=W||y>=H||wall[k]||mark[k]) return; mark[k]=-1; stack.push(k); };
  for(let x=0;x<W;x++){ push(x,0); push(x,H-1); }
  for(let y=0;y<H;y++){ push(0,y); push(W-1,y); }
  while(stack.length){
    const k=stack.pop(), x=k%W, y=(k-x)/W;
    push(x+1,y); push(x-1,y); push(x,y+1); push(x,y-1);
  }

  /* what is left enclosed, grouped */
  const rooms=[]; let label=0;
  const minCells=Math.max(12,Math.round(1.5/(S.mpp*S.mpp)/(cell*cell)));
  for(let k0=0;k0<W*H;k0++){
    if(wall[k0]||mark[k0]) continue;
    label++; const cells=[]; const st=[k0]; mark[k0]=label;
    while(st.length){
      const k=st.pop(); cells.push(k);
      const x=k%W, y=(k-x)/W;
      const nb=[[x+1,y],[x-1,y],[x,y+1],[x,y-1]];
      for(const [nx,ny] of nb){
        if(nx<0||ny<0||nx>=W||ny>=H) continue;
        const kk=ny*W+nx;
        if(wall[kk]||mark[kk]) continue;
        mark[kk]=label; st.push(kk);
      }
    }
    if(cells.length<minCells) continue;
    const poly=traceMask(mark,W,H,label,cell,minX,minY);
    if(poly&&poly.length>=3) rooms.push(poly);
  }
  rooms.sort((a,b)=>Math.abs(polyArea(b))-Math.abs(polyArea(a)));
  return rooms.slice(0,40);
}

const polyArea=p=>{ let A=0; for(let i=0;i<p.length;i++){ const a=p[i],b=p[(i+1)%p.length]; A+=a.x*b.y-b.x*a.y; } return A/2; };

/* boundary of a labelled region: collect the grid edges that face outward,
   chain them into a loop, then straighten the staircase */
function traceMask(mark,W,H,label,cell,ox,oy){
  const edges=new Map();
  const key=(x,y)=>x+','+y;
  const addEdge=(x1,y1,x2,y2)=>{
    const k=key(x1,y1), l=edges.get(k);
    if(l) l.push([x2,y2]); else edges.set(k,[[x2,y2]]);
  };
  const inR=(x,y)=>x>=0&&y>=0&&x<W&&y<H&&mark[y*W+x]===label;
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    if(mark[y*W+x]!==label) continue;
    if(!inR(x,y-1)) addEdge(x,y,x+1,y);
    if(!inR(x+1,y)) addEdge(x+1,y,x+1,y+1);
    if(!inR(x,y+1)) addEdge(x+1,y+1,x,y+1);
    if(!inR(x-1,y)) addEdge(x,y+1,x,y);
  }
  if(!edges.size) return null;
  let start=null; for(const k of edges.keys()){ start=k; break; }
  const loop=[]; let cur=start, guard=0;
  while(guard++<200000){
    const nx=edges.get(cur);
    if(!nx||!nx.length) break;
    const [x2,y2]=nx.shift();
    if(!nx.length) edges.delete(cur);
    const [cx,cy]=cur.split(',').map(Number);
    loop.push({x:ox+cx*cell,y:oy+cy*cell});
    cur=key(x2,y2);
    if(cur===start) break;
  }
  if(loop.length<4) return null;
  return simplify(loop,cell*1.6);
}

/* Douglas–Peucker, closed */
function simplify(pts,tol){
  const dp=(a,b,list)=>{
    if(b<=a+1) return [];
    let bi=-1, bd=tol;
    const P=list[a], Q=list[b];
    const dx=Q.x-P.x, dy=Q.y-P.y, L=Math.hypot(dx,dy)||1;
    for(let i=a+1;i<b;i++){
      const d=Math.abs((list[i].x-P.x)*dy-(list[i].y-P.y)*dx)/L;
      if(d>bd){ bd=d; bi=i; }
    }
    if(bi<0) return [];
    return [...dp(a,bi,list),list[bi],...dp(bi,b,list)];
  };
  const out=[pts[0],...dp(0,pts.length-1,pts),pts[pts.length-1]];
  const clean=[];
  for(const p of out) if(!clean.length||Math.hypot(p.x-clean[clean.length-1].x,p.y-clean[clean.length-1].y)>tol*0.4) clean.push(p);
  if(clean.length>2&&Math.hypot(clean[0].x-clean[clean.length-1].x,clean[0].y-clean[clean.length-1].y)<tol) clean.pop();
  return clean;
}

function acceptProposal(quiet){
  const p=S.proposal; if(!p) return;
  const keep=p.filter(w=>w.on);
  if(!keep.length) return;
  pushHistory('קבלת הקירות שזוהו');
  /* one node per corner, so the accepted runs share endpoints and can close rooms */
  const tol=0.05/S.mpp;
  const at=q=>{
    for(const n of S.nodes) if(dist(n,q)<tol) return n.id;
    const n={id:uid++,x:q.x,y:q.y}; S.nodes.push(n); return n.id;
  };
  for(const w of keep){
    const a=at(w.a), b=at(w.b);
    /* The detector measured this run's thickness off the drawing's own poché.
       That measurement was being thrown away here, so a 25cm envelope and a
       10cm partition came out of the model identically. */
    const t=w.t>0?clamp(w.t,0.05,0.6):undefined;
    if(a!==b) S.walls.push(t?{a,b,t,id:uid++}:{a,b,id:uid++});
  }
  S.rooms=findRooms();
  if(!S.openings.length){
    const a=mergeAcrossOpenings();       // rebuilds S.walls, so rooms come after
    S.rooms=findRooms();
    const b=detectOpenings();
    const seen=new Set();
    S.openings=[...a,...b].filter(o=>{
      const k=o.wallId+':'+Math.round(o.u*40); if(seen.has(k)) return false; seen.add(k); return true;
    });
  }
  reroom();
  S.proposal=null; syncProposal();
  refresh(); draw(); touch(); if(S.raised) build3D();
  if(quiet===true) return;
  say('הקירות התקבלו. אפשר לערוך אותם, לחתוך פתחים, או להרים.');
  toast(keep.length+' קירות נוספו. הם שלכם עכשיו — אפשר לגרור, למחוק ולהוסיף.');
}

function cancelProposal(){
  S.proposal=null; syncProposal(); draw(); say(PROMPT[S.tool]);
}

function proposalAt(p){
  if(!S.proposal) return -1;
  const R=10/S.view.z;
  for(let i=S.proposal.length-1;i>=0;i--){
    const w=S.proposal[i];
    const vx=w.b.x-w.a.x, vy=w.b.y-w.a.y, L2=vx*vx+vy*vy; if(!L2) continue;
    const t=clamp(((p.x-w.a.x)*vx+(p.y-w.a.y)*vy)/L2,0,1);
    if(Math.hypot(p.x-(w.a.x+vx*t),p.y-(w.a.y+vy*t))<R) return i;
  }
  return -1;
}

function drawProposal(){
  if(!S.proposal) return;
  const tPx=(S.dims.wall/S.mpp)*S.view.z;
  ctx.save();
  for(const w of S.proposal){
    const A=toScreen(w.a), B=toScreen(w.b);
    const line=()=>{ ctx.beginPath(); ctx.moveTo(A.x,A.y); ctx.lineTo(B.x,B.y); ctx.stroke(); };
    ctx.lineCap='butt';
    if(w.on){
      /* a pale band the thickness of the proposed wall, so it reads on black
         poché as well as on white paper, then the dashed centreline on top */
      ctx.setLineDash([]);
      ctx.strokeStyle='rgba(255,255,255,.85)'; ctx.lineWidth=Math.max(3,tPx); line();
      ctx.strokeStyle='rgba(34,32,29,.22)'; ctx.lineWidth=Math.max(3,tPx); line();
      ctx.strokeStyle='#FFFFFF'; ctx.lineWidth=3.4; line();
      ctx.strokeStyle='#22201D'; ctx.lineWidth=1.5; ctx.setLineDash([7,4]); line();
    }else{
      ctx.setLineDash([]);
      ctx.strokeStyle='rgba(255,255,255,.75)'; ctx.lineWidth=3.2; line();
      ctx.strokeStyle='#A5352A'; ctx.lineWidth=1.2; ctx.setLineDash([3,4]); line();
    }
  }
  ctx.setLineDash([]);
  ctx.restore();
}

function vecState(){
  const el=$('#vecState'); if(!el) return;
  const n=VEC.pts?VEC.pts.length/2:0;
  el.textContent=n?'הפינות נצמדות לשרטוט':'';
}

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

/* ══ history ════════════════════════════════════════════════════════
   Every edit is a command with a name, so undo can say what it is undoing and
   redo exists at all. The state it captures is still a snapshot of the geometry
   — cheap at this size, and it cannot drift out of step with a hand-written
   inverse the way a delta can. What changed is the shape of the stack: two of
   them, each entry labelled, and a redo that survives until the next edit. */
const Hist = {
  undo:[], redo:[], max:120,
  snap(){ return JSON.stringify({n:S.nodes,w:S.walls,o:S.openings,c:S.chain}); },
  apply(str){
    const p=JSON.parse(str);
    const was=Sel.items.slice();
    S.nodes=p.n; S.walls=p.w; S.openings=p.o; S.chain=p.c||[]; Sel.clear();
    /* undoing a length change should not also cost you the wall you were
       working on — keep whatever the restored state still contains */
    for(const it of was){
      const alive = it.t==='wall'?wallById(it.id)
                  : it.t==='opening'?openingById(it.id)
                  : node(it.id);
      if(alive) Sel.add(it.t,it.id);
    }
  },
  /* call BEFORE mutating, with what the user would call the action */
  push(label){
    this.undo.push({label,state:this.snap()});
    if(this.undo.length>this.max) this.undo.shift();
    this.redo.length=0;
    sync();
  },
  canUndo(){ return this.undo.length>0; },
  canRedo(){ return this.redo.length>0; },
  stepBack(){
    const e=this.undo.pop(); if(!e) return null;
    this.redo.push({label:e.label,state:this.snap()});
    this.apply(e.state);
    return e.label;
  },
  stepFwd(){
    const e=this.redo.pop(); if(!e) return null;
    this.undo.push({label:e.label,state:this.snap()});
    this.apply(e.state);
    return e.label;
  },
};
function sync(){
  const u=$('#tUndo'), r=$('#tRedo');
  if(u){ u.disabled=!Hist.canUndo();
    u.dataset.tip=Hist.canUndo()?('ביטול '+Hist.undo[Hist.undo.length-1].label):'ביטול'; }
  if(r){ r.disabled=!Hist.canRedo();
    r.dataset.tip=Hist.canRedo()?('ביצוע מחדש '+Hist.redo[Hist.redo.length-1].label):'ביצוע מחדש'; }
}
/* A run of arrow presses is one move. It stays open until something else
   happens — another edit, an undo, a change of selection or of tool — which is
   a rule the user can hold in their head, unlike a timer. */
let nudgeRun=false;
function endNudgeRun(){ nudgeRun=false; }
function pushHistory(label){ if(label!=='הזזה') nudgeRun=false; Hist.push(label||'שינוי'); }
function afterHistory(label,dir){
  S.rooms=findRooms();
  refresh(); draw(); touch(); if(S.raised) build3D(); sync(); renderProps();
  if(label) say((dir==='undo'?'בוטל: ':'בוצע מחדש: ')+label);
}
function undo(){ endNudgeRun(); const l=Hist.stepBack(); if(l!==null) afterHistory(l,'undo'); }
function redo(){ endNudgeRun(); const l=Hist.stepFwd(); if(l!==null) afterHistory(l,'redo'); }

/* ══ tools ══════════════════════════════════════════════════════════ */
const TOOLS={select:'#tSelect',calibrate:'#tCal',wall:'#tWall',door:'#tDoor',window:'#tWin'};
const PROMPT={
  select:'לחצו לבחירה, Shift להוספה, גרירה על רקע ריק לבחירת אזור. Backspace מוחק, החצים מזיזים.',
  calibrate:'לחצו על קצה אחד של קיר שאתם יודעים את אורכו, ואז על הקצה השני.',
  wall:'לחצו פינה אחר פינה. Shift לסימון חופשי. Esc מסיים את הרצף.',
  door:'לחצו על קיר שסימנתם כדי להוסיף שם דלת.',
  window:'לחצו על קיר שסימנתם כדי להוסיף שם חלון.'
};
function setTool(t){
  if($(TOOLS[t])?.disabled) return;
  S.tool=t; S.chain=[]; S.cal={a:null,b:null}; Sel.clear(); hideLen(); closePops(); liveDim.textContent=''; clearGuides();
  for(const k in TOOLS) $(TOOLS[k]).setAttribute('aria-pressed',String(k===t));
  planEl.classList.toggle('sel',t==='select');
  say(PROMPT[t]); renderProps(); draw();
}
$('#tSelect').onclick=()=>setTool('select');
$('#tCal').onclick=()=>setTool('calibrate');
$('#tWall').onclick=()=>setTool('wall');
$('#tDoor').onclick=()=>setTool('door');
$('#tWin').onclick=()=>setTool('window');
$('#tUndo').onclick=undo;
$('#tRedo').onclick=redo;
$('#tClear').onclick=()=>{
  if(!S.walls.length&&!S.openings.length) return;
  pushHistory('ניקוי הסימון'); S.nodes=[];S.walls=[];S.rooms=[];S.openings=[];S.chain=[];Sel.clear();
  S.proposal=null; syncProposal();
  S.raised=false; clear3D(); refresh(); draw(); touch();
  say('הסימון נמחק. קנה המידה נשמר.');
};
/* enabled and actually on screen — below 820px the model instruments are removed
   with the model pane, and their shortcuts must go with them */
function live(sel){ const el=$(sel); return !!el&&!el.disabled&&el.offsetParent!==null; }
function closePops(){ ['#opt','#exp','#snapPop'].forEach(x=>$(x).classList.remove('on')); }
function togglePop(sel,btn){
  const p=$(sel), was=p.classList.contains('on');
  closePops();
  if(!was){
    p.classList.add('on');
    /* anchored to its instrument, but never hanging off the top or bottom of
       the window — the magnets list is tall enough to reach both */
    p.style.top='0px';
    const h=p.offsetHeight, r=btn.getBoundingClientRect();
    p.style.top=clamp(r.top-44,8,Math.max(8,innerHeight-h-38))+'px';
  }
}
$('#tOpt').onclick=e=>togglePop('#opt',e.currentTarget);
$('#tExp').onclick=e=>togglePop('#exp',e.currentTarget);
$('#tSnap').onclick=e=>togglePop('#snapPop',e.currentTarget);

/* the magnets, reflected both ways: the boxes show what the engine will do,
   and changing one takes effect on the next move — no apply button */
function syncSnapUI(){
  $$('#snapPop input[data-snap]').forEach(b=>{ b.checked=!!SNAP[b.dataset.snap]; });
  $('#sGrid').value=SNAP.gridCm; $('#sAngle').value=SNAP.angleStep;
}
$$('#snapPop input[data-snap]').forEach(b=>{
  b.addEventListener('change',()=>{
    SNAP[b.dataset.snap]=b.checked?1:0; saveSnapPrefs();
    const on=$$('#snapPop input[data-snap]').filter(x=>x.checked).length;
    say(on?('פעילים '+on+' מגנטים.'):'כל המגנטים כבויים. נקודות ייפלו בדיוק במקום הלחיצה.');
    clearGuides(); draw();
  });
});
$('#sGrid').addEventListener('change',e=>{
  SNAP.gridCm=clamp(+e.target.value||10,1,100); e.target.value=SNAP.gridCm; saveSnapPrefs(); });
$('#sAngle').addEventListener('change',e=>{
  SNAP.angleStep=clamp(+e.target.value||15,1,90); e.target.value=SNAP.angleStep; saveSnapPrefs(); });
syncSnapUI();
['oWall','oCeil','oDoor','oWin','oSill'].forEach(id=>{
  $('#'+id).oninput=e=>{
    const k={oWall:'wall',oCeil:'ceil',oDoor:'door',oWin:'win',oSill:'sill'}[id];
    const v=parseFloat(e.target.value); if(isFinite(v)) S.dims[k]=v;
    draw(); touch(); if(S.raised) build3D();
  };
});
$('#tRaise').onclick=raise;

const tip=$('#tip');
const hideTip=()=>tip.classList.remove('on');
document.querySelectorAll('.tool[data-tip]').forEach(b=>{
  const show=()=>{
    if(b.disabled) return;
    const r=b.getBoundingClientRect();
    tip.innerHTML=b.dataset.tip+(b.dataset.kb?'<span class="kb">'+b.dataset.kb+'</span>':'');
    tip.classList.add('on');
    tip.style.top=(r.top+r.height/2-11)+'px';
    tip.style.left=(r.left-tip.offsetWidth-7)+'px';
  };
  b.addEventListener('mouseenter',show); b.addEventListener('focus',show);
  b.addEventListener('mouseleave',hideTip); b.addEventListener('blur',hideTip);
  /* a tip that outlives its click lands on top of the popover it just opened */
  b.addEventListener('click',hideTip);
});

/* ══ selection ══════════════════════════════════════════════════════
   A set, not a single thing. Shift adds and removes, a drag on empty space
   sweeps a marquee, and everything downstream — handles, the properties panel,
   nudging, deletion — reads the same set. S.sel stays as the "primary" for the
   code that only ever cared about one, and is always the last thing picked. */
const Sel = {
  items:[],                                  // [{t:'wall'|'opening'|'node', id}]
  has(t,id){ return this.items.some(x=>x.t===t&&x.id===id); },
  clear(){ this.items.length=0; S.sel=null; endNudgeRun(); },
  set(t,id){ this.items=[{t,id}]; S.sel={t,id}; endNudgeRun(); },
  add(t,id){ if(!this.has(t,id)) this.items.push({t,id}); S.sel={t,id}; endNudgeRun(); },
  toggle(t,id){
    const i=this.items.findIndex(x=>x.t===t&&x.id===id);
    if(i>=0){ this.items.splice(i,1); S.sel=this.items[this.items.length-1]||null; endNudgeRun(); }
    else this.add(t,id);
  },
  walls(){ return this.items.filter(x=>x.t==='wall').map(x=>wallById(x.id)).filter(Boolean); },
  openings(){ return this.items.filter(x=>x.t==='opening').map(x=>openingById(x.id)).filter(Boolean); },
  nodes(){ return this.items.filter(x=>x.t==='node').map(x=>node(x.id)).filter(Boolean); },
  get size(){ return this.items.length; },
  describe(){
    const w=this.walls().length, o=this.openings().length, n=this.nodes().length;
    const bits=[];
    if(w) bits.push(w+(w>1?' קירות':' קיר'));
    if(o) bits.push(o+(o>1?' פתחים':' פתח'));
    if(n) bits.push(n+(n>1?' פינות':' פינה'));
    return bits.join(' · ');
  },
};

/* the handles a selection puts on the sheet */
function handlesFor(){
  const out=[];
  for(const w of Sel.walls()){
    const a=node(w.a), b=node(w.b); if(!a||!b) continue;
    out.push({k:'end',wall:w.id,which:'a',x:a.x,y:a.y,nodeId:w.a});
    out.push({k:'end',wall:w.id,which:'b',x:b.x,y:b.y,nodeId:w.b});
    out.push({k:'mid',wall:w.id,x:(a.x+b.x)/2,y:(a.y+b.y)/2});
  }
  for(const o of Sel.openings()){
    const w=wallById(o.wallId); if(!w) continue;
    const a=node(w.a), b=node(w.b); if(!a||!b) continue;
    const L=dist(a,b)||1, ux=(b.x-a.x)/L, uy=(b.y-a.y)/L;
    const c={x:a.x+(b.x-a.x)*o.u,y:a.y+(b.y-a.y)*o.u};
    const half=(o.width/S.mpp)/2;
    const ang=Math.atan2(uy,ux);
    out.push({k:'openEdge',open:o.id,side:-1,ang,x:c.x-ux*half,y:c.y-uy*half});
    out.push({k:'openEdge',open:o.id,side:1, ang,x:c.x+ux*half,y:c.y+uy*half});
  }
  return out;
}
function handleAt(p){
  const R=9/S.view.z;
  const hs=handlesFor();
  for(let i=hs.length-1;i>=0;i--) if(dist(hs[i],p)<R) return hs[i];
  return null;
}

/* ══ snapping / hit ═════════════════════════════════════════════════ */
const keys={shift:false,space:false,alt:false};
/* The sheet is the ground truth; nothing can be marked off it. A corner placed
   in the surrounding mat measures nothing and produced walls floating outside
   the drawing. */
const onSheet=p=>p.x>=0&&p.y>=0&&p.x<=S.srcW&&p.y<=S.srcH;
const toSheet=p=>({...p,x:clamp(p.x,0,S.srcW),y:clamp(p.y,0,S.srcH)});

/* `skip` is the corner already under the pointer. Without it a dragged corner
   snaps to itself on the first move and never leaves the spot. */
/* ══ the snap engine ════════════════════════════════════════════════
   Nine ways a point can be magnetic, in one resolver. Points beat lines: a
   corner is a stronger claim than "somewhere along this direction", and when
   two line constraints cross near the pointer their intersection wins over
   either alone — which is how you land a wall exactly on the extension of one
   wall and the perpendicular of another.

   Everything the software infers is suppressible. Alt drops all of it and
   leaves the raw pointer; Shift, which the tracing tool has always used for
   this, leaves the user's own corners and drops the rest.

   Every snap also reports a guide — the line that explains it — because a
   point that jumps without saying why is not a tool, it is a surprise. */
const R_PT=13, R_LINE=8;                   // screen px, so the feel is the same at any zoom

/* p projected onto the infinite line through a in direction u (unit) */
function projLine(p,a,u){
  const t=(p.x-a.x)*u.x+(p.y-a.y)*u.y;
  return {x:a.x+u.x*t,y:a.y+u.y*t,t};
}
function unit(a,b){ const L=Math.hypot(b.x-a.x,b.y-a.y)||1; return {x:(b.x-a.x)/L,y:(b.y-a.y)/L,L}; }
function crossLines(a,ua,b,ub){
  const d=ua.x*ub.y-ua.y*ub.x;
  if(Math.abs(d)<1e-9) return null;                 // parallel explains nothing
  const t=((b.x-a.x)*ub.y-(b.y-a.y)*ub.x)/d;
  return {x:a.x+ua.x*t,y:a.y+ua.y*t};
}
/* the walls as geometry, skipping the ones the pointer is currently dragging —
   a wall cannot be its own reference while it is moving */
function snapSegs(skipWalls){
  const out=[];
  for(const w of S.walls){
    if(skipWalls&&skipWalls.includes(w.id)) continue;
    const a=node(w.a), b=node(w.b); if(!a||!b) continue;
    if(dist(a,b)<1e-6) continue;
    out.push({id:w.id,a:{x:a.x,y:a.y},b:{x:b.x,y:b.y},u:unit(a,b)});
  }
  return out;
}

function resolveSnap(p,opt){
  opt=opt||{};
  const anchor=opt.anchor||null, skip=opt.skipNodes||null, skipW=opt.skipWalls||null;
  const raw={x:p.x,y:p.y,kind:null,guides:[]};
  if(keys.alt) return raw;
  /* A radius in screen pixels alone is a trap: zoomed out to fit an A3 sheet,
     13px is nearly half a metre in the building, and a corner that jumps 45cm
     to a magnet has destroyed the drawing rather than helped it. Every snap is
     capped in real length as well — the same rule the drawing-corner snap
     already had, applied to all of them. */
  const z=S.view.z;
  const Rp=Math.min(R_PT/z, S.mpp?0.25/S.mpp:Infinity);
  const Rl=Math.min(R_LINE/z, S.mpp?0.15/S.mpp:Infinity);
  const soft=!keys.shift;                    // Shift keeps only the user's own corners

  /* ── tier A: points ─────────────────────────────────────────────── */
  let pt=null, pd=Rp;
  const takePt=(c,kind,guides)=>{ const d=dist(c,p); if(d<pd){ pd=d; pt={x:c.x,y:c.y,kind,guides:guides||[],id:c.id}; } };

  if(SNAP.node) for(const n of S.nodes){
    if(skip&&skip.includes(n.id)) continue;
    takePt(n,'node');
  }
  if(pt) return pt;                          // the user's own corners always win

  if(!soft) return raw;

  const segs=(SNAP.mid||SNAP.inter||SNAP.perp||SNAP.ext||SNAP.par)?snapSegs(skipW):[];

  if(SNAP.corner){
    /* 11 screen px, but never further than 15 cm in the real building — zoomed
       out on a 1:100 sheet that radius was reaching a quarter of a metre and
       pulling corners onto the wrong face, which bends the run visibly. */
    const v=vecNear(p,Math.min(11/z, S.mpp?0.15/S.mpp:Infinity));
    if(v) takePt(v,'corner');
  }
  if(SNAP.mid) for(const s of segs) takePt({x:(s.a.x+s.b.x)/2,y:(s.a.y+s.b.y)/2},'mid');
  if(SNAP.inter) for(let i=0;i<segs.length;i++) for(let j=i+1;j<segs.length;j++){
    const c=crossLines(segs[i].a,segs[i].u,segs[j].a,segs[j].u);
    if(c&&dist(c,p)<pd) takePt(c,'inter',[guideThrough(segs[i],c),guideThrough(segs[j],c)]);
  }
  if(pt) return pt;

  /* ── tier B: lines ──────────────────────────────────────────────── */
  const lines=[];
  const addLine=(a,u,kind,ref)=>{
    const q=projLine(p,a,u);
    const d=Math.hypot(q.x-p.x,q.y-p.y);
    if(d<Rl) lines.push({a,u,kind,ref,q,d});
  };
  if(SNAP.ext) for(const s of segs){
    const q=projLine(p,s.a,s.u);
    if(q.t>-Rl&&q.t<s.u.L+Rl) continue;             // that is the wall itself, not its extension
    addLine(s.a,s.u,'ext',s);
  }
  if(anchor){
    if(SNAP.perp) for(const s of segs){
      const n={x:-s.u.y,y:s.u.x};
      addLine(anchor,n,'perp',s);                    // the line through the anchor at 90° to that wall
    }
    if(SNAP.par) for(const s of segs) addLine(anchor,s.u,'par',s);
    if(SNAP.angle){
      const step=Math.PI*SNAP.angleStep/180;
      const ang=Math.atan2(p.y-anchor.y,p.x-anchor.x);
      const sn=Math.round(ang/step)*step;
      addLine(anchor,{x:Math.cos(sn),y:Math.sin(sn)},'angle',{deg:Math.round(sn*180/Math.PI)});
    }
  }
  if(SNAP.perp&&!anchor) for(const s of segs){
    /* with no anchor a perpendicular still means something: the foot of the
       pointer on the wall, which is the nearest point on it */
    const q=projLine(p,s.a,s.u);
    if(q.t<0||q.t>s.u.L) continue;
    if(Math.hypot(q.x-p.x,q.y-p.y)<Rl) lines.push({a:s.a,u:s.u,kind:'onwall',ref:s,q,d:Math.hypot(q.x-p.x,q.y-p.y)});
  }

  if(lines.length){
    /* Nearest wins; among constraints at the same distance the one derived
       from real geometry beats the one derived from a direction, because
       "the extension of that wall" says more than "90° from here". */
    const rank={ext:0,onwall:1,perp:2,par:3,angle:4};
    lines.sort((a,b)=> (a.d-b.d) || (rank[a.kind]-rank[b.kind]));
    /* Several constraints are often the same line — perpendicular to a wall and
       parallel to the wall at right angles to it are one line, and a pair of
       identical lines has no crossing to offer. Keep one of each. */
    const keep=[];
    for(const l of lines){
      if(keep.some(k=>Math.abs(k.u.x*l.u.y-k.u.y*l.u.x)<1e-9 &&
                      Math.abs((l.a.x-k.a.x)*k.u.y-(l.a.y-k.a.y)*k.u.x)<0.02)) continue;
      keep.push(l);
    }
    lines.length=0; lines.push(...keep);
    /* two constraints that cross near the pointer beat either one alone */
    for(let i=1;i<lines.length;i++){
      const c=crossLines(lines[0].a,lines[0].u,lines[i].a,lines[i].u);
      if(c&&dist(c,p)<Rp*1.2)
        return {x:c.x,y:c.y,kind:lines[0].kind+'+'+lines[i].kind,
                guides:[guideFor(lines[0],c),guideFor(lines[i],c),
                        refGuide(lines[0]),refGuide(lines[i])].filter(Boolean)};
    }
    const l=lines[0];
    return {x:l.q.x,y:l.q.y,kind:l.kind,ref:l.ref,
            guides:[guideFor(l,l.q),refGuide(l)].filter(Boolean)};
  }

  /* ── tier C: the grid, only when nothing else spoke ──────────────── */
  if(SNAP.grid&&S.mpp){
    const step=(SNAP.gridCm/100)/S.mpp;
    const g={x:Math.round(p.x/step)*step,y:Math.round(p.y/step)*step};
    if(dist(g,p)<Rl) return {x:g.x,y:g.y,kind:'grid',guides:[]};
  }
  return raw;
}
/* a guide is the line that explains the snap, clipped to something readable */
function guideThrough(seg,c){
  const reach=Math.max(seg.u.L,60/S.view.z);
  return {kind:'ext',a:{x:c.x-seg.u.x*reach,y:c.y-seg.u.y*reach},
                     b:{x:c.x+seg.u.x*reach,y:c.y+seg.u.y*reach}};
}
function guideFor(l,c){
  if(l.kind==='ext'||l.kind==='onwall'){
    const s=l.ref, near=dist(s.a,c)<dist(s.b,c)?s.a:s.b;
    return {kind:l.kind,a:near,b:c};
  }
  /* An anchor guide that stops at the snapped point is the same line the wall
     preview already draws, so it explains nothing. Run it past the point: what
     the user needs to see is the line the point is sitting on. */
  const over=34/S.view.z;
  const u=unit(l.a,c);
  return {kind:l.kind,a:l.a,b:{x:c.x+u.x*over,y:c.y+u.y*over}};
}
/* Perpendicular and parallel are claims about a particular wall. Marking that
   wall is the difference between "there is a line here" and "this line answers
   to that wall". */
function refGuide(l){
  if((l.kind!=='perp'&&l.kind!=='par')||!l.ref||!l.ref.a) return null;
  return {kind:'ref',a:l.ref.a,b:l.ref.b};
}

function clearGuides(){ S.guides=[]; S.snap=null; if(snapState) snapState.textContent=''; }

/* the old name, kept because tracing and calibration call it everywhere */
function snapPoint(p,anchor,skip,skipWalls){
  const r=resolveSnap(p,{anchor,skipNodes:skip,skipWalls});
  S.guides=r.guides||[];
  return r;
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
    if(Math.hypot(p.x-(a.x+vx*t),p.y-(a.y+vy*t))<R) return {wall:w,t};
  }
  return null;
}
function openingAt(p){
  const R=11/S.view.z;
  for(let i=S.openings.length-1;i>=0;i--){
    const o=S.openings[i], w=wallById(o.wallId); if(!w) continue;
    const a=node(w.a), b=node(w.b); if(!a||!b) continue;
    if(dist({x:a.x+(b.x-a.x)*o.u,y:a.y+(b.y-a.y)*o.u},p)<R) return o;
  }
  return null;
}


/* ══ properties ═════════════════════════════════════════════════════
   Everything the selection measures, as a number you can replace. Dragging is
   fast and typing is exact, and this is where exact lives: a wall is 3.60 m
   because you said 3.60, not because the pointer landed there.

   A field never fights the canvas. It shows what the selection is now, and it
   only writes back when you commit — Enter, Tab or blur. */
const propsEl=$('#props'), propsFields=$('#propsFields');

/* which end of a wall a length or angle edit should move. A corner shared with
   another wall is a joint; move the free end and the joint survives. */
function freeEnd(w){
  const shared=id=>S.walls.some(x=>x.id!==w.id&&(x.a===id||x.b===id));
  const aFree=!shared(w.a), bFree=!shared(w.b);
  if(bFree) return {fixed:w.a,move:w.b};
  if(aFree) return {fixed:w.b,move:w.a};
  return {fixed:w.a,move:w.b,joint:true};
}
function wallLength(w){ const a=node(w.a),b=node(w.b); return a&&b&&S.mpp?dist(a,b)*S.mpp:null; }
function wallAngle(w){
  const a=node(w.a),b=node(w.b); if(!a||!b) return null;
  /* degrees anticlockwise from east, the way a protractor reads — the sheet's
     y runs down, so the sign flips */
  let d=-Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI;
  d=((d%360)+360)%360; return +d.toFixed(2);
}
/* Marks are bounded by the sheet, so a typed number that would put a corner
   off the paper has to be refused rather than quietly clamped — clamping a
   rotation shortens the wall as well as missing the angle, and the user is
   left looking at two numbers they did not ask for. */
function setWallLength(w,metres){
  const a=node(w.a),b=node(w.b); if(!a||!b||!S.mpp) return false;
  const L=clamp(metres,0.05,200)/S.mpp;
  const e=freeEnd(w), fix=node(e.fixed), mov=node(e.move); if(!fix||!mov) return false;
  const u=unit(fix,mov);
  const q={x:fix.x+u.x*L,y:fix.y+u.y*L};
  if(!onSheet(q)) return 'off';
  mov.x=q.x; mov.y=q.y; return true;
}
function setWallAngle(w,deg){
  const e=freeEnd(w), fix=node(e.fixed), mov=node(e.move); if(!fix||!mov) return false;
  const L=dist(fix,mov); const r=-deg*Math.PI/180;
  const q={x:fix.x+Math.cos(r)*L,y:fix.y+Math.sin(r)*L};
  if(!onSheet(q)) return 'off';
  mov.x=q.x; mov.y=q.y; return true;
}
function openingOffset(o){
  const w=wallById(o.wallId); if(!w||!S.mpp) return null;
  const a=node(w.a),b=node(w.b); if(!a||!b) return null;
  return dist(a,b)*o.u*S.mpp;
}
function setOpeningOffset(o,metres){
  const w=wallById(o.wallId); if(!w||!S.mpp) return false;
  const a=node(w.a),b=node(w.b); if(!a||!b) return false;
  const L=dist(a,b)*S.mpp; if(L<=0) return false;
  o.u=clamp(metres/L,.04,.96); return true;
}

/* one value across a selection: the number if they agree, null if they do not */
function common(list,get){
  let v=null;
  for(const x of list){
    const q=get(x); if(q==null) return null;
    const r=Math.round(q*1e4)/1e4;
    if(v===null) v=r; else if(v!==r) return null;
  }
  return v;
}
function field(id,label,unit,value,step,min,max,disabled){
  const mixed=value===null;
  return '<div class="f"><label for="'+id+'">'+label+'</label><span class="val">'+
    '<input type="number" id="'+id+'" step="'+step+'" min="'+min+'" max="'+max+'"'+
    (mixed?' placeholder="—" class="mixed" data-was=""':' value="'+value+'" data-was="'+value+'"')+
    (disabled?' disabled':'')+'><span class="u">'+unit+'</span></span></div>';
}

let propsBusy=false;                     // do not rewrite a field the user is typing in
function renderProps(){
  const walls=Sel.walls(), opens=Sel.openings();
  if(!Sel.size||S.tool!=='select'||!S.mpp){ propsEl.classList.remove('on'); return; }
  if(propsBusy) return;
  propsEl.classList.add('on');
  const n=Sel.size;
  $('#propsCount').textContent=n>1?String(n):'';
  let html='', hint='';
  if(walls.length&&!opens.length){
    $('#propsTitle').textContent=walls.length>1?'קירות':'קיר';
    const one=walls.length===1?walls[0]:null;
    html+=field('pLen','אורך','מ׳',one?+(wallLength(one)||0).toFixed(3):null,'0.01','0.05','200',!one);
    html+=field('pAng','זווית','°',one?wallAngle(one):null,'0.1','0','360',!one);
    html+=field('pThk','עובי','מ׳',common(walls,w=>w.t||S.dims.wall),'0.01','0.03','1',false);
    if(one){
      const e=freeEnd(one);
      hint=e.joint?'שני הקצוות מחוברים לקירות אחרים — שינוי אורך יזיז את הקצה השני ויגרור אותם.'
                  :'שינוי אורך או זווית מזיז את הקצה החופשי.';
    }else hint='עובי משותף לכל הקירות שנבחרו.';
  }else if(opens.length&&!walls.length){
    $('#propsTitle').textContent=opens.length>1?'פתחים':'פתח';
    const one=opens.length===1?opens[0]:null;
    const kind=common(opens,o=>o.kind==='door'?1:0);
    html+='<div class="f"><label>סוג</label><div class="seg" id="pKind">'+
      '<button type="button" data-kind="door" aria-pressed="'+(kind===1)+'">דלת</button>'+
      '<button type="button" data-kind="window" aria-pressed="'+(kind===0)+'">חלון</button></div></div>';
    html+=field('pW','רוחב','מ׳',common(opens,o=>o.width),'0.05','0.3','6',false);
    html+=field('pOff','מרחק מהקצה','מ׳',one?+(openingOffset(one)||0).toFixed(3):null,'0.05','0','200',!one);
    html+=field('pSill','גובה אדן','מ׳',common(opens,o=>o.sill),'0.05','0','2',false);
    html+=field('pHead','גובה עליון','מ׳',common(opens,o=>o.head),'0.05','0.6','4',false);
    hint='דלת יושבת על הרצפה; אדן נמדד מעליה.';
  }else{
    $('#propsTitle').textContent='בחירה';
    html+=field('pThk','עובי קירות','מ׳',common(walls,w=>w.t||S.dims.wall),'0.01','0.03','1',!walls.length);
    html+=field('pW','רוחב פתחים','מ׳',common(opens,o=>o.width),'0.05','0.3','6',!opens.length);
    hint=Sel.describe();
  }
  propsFields.innerHTML=html;
  $('#propsHint').textContent=hint;
  wireProps();
}

/* a field commits on Enter, Tab or blur — never on every keystroke, because
   "3" on the way to "3.6" is a wall you did not ask for */
function wireProps(){
  $$('#propsFields input').forEach(inp=>{
    inp.addEventListener('focus',()=>{ propsBusy=true; });
    inp.addEventListener('blur',()=>{ propsBusy=false; commitProp(inp); });
    inp.addEventListener('keydown',e=>{
      e.stopPropagation();
      if(e.key==='Enter'){ e.preventDefault(); commitProp(inp); inp.select(); }
      if(e.key==='Escape'){ e.preventDefault(); propsBusy=false; inp.blur(); renderProps(); }
    });
  });
  const seg=$('#pKind');
  if(seg) seg.querySelectorAll('button').forEach(b=>{
    b.onclick=()=>{
      const k=b.dataset.kind;
      pushHistory('שינוי סוג פתח');
      for(const o of Sel.openings()){
        o.kind=k;
        if(k==='door'){ o.sill=0; o.head=Math.max(o.head,1.8); }
        else if(o.sill<=0) o.sill=S.dims.sill;
      }
      afterProp(Sel.openings().map(o=>o.wallId));
    };
  });
}
function commitProp(inp){
  const v=parseFloat(inp.value);
  if(!isFinite(v)) return;
  /* the number it was rendered with — retyping it is not an edit, and without
     this every focus-and-click-away leaves a junk step on the undo stack */
  const was=parseFloat(inp.dataset.was);
  if(isFinite(was)&&Math.abs(was-v)<1e-9) return;
  inp.dataset.was=String(v);
  const walls=Sel.walls(), opens=Sel.openings();
  let label='', touched=[];
  if(inp.id==='pLen'&&walls.length===1){
    label='שינוי אורך קיר'; pushHistory(label);
    const r=setWallLength(walls[0],v);
    if(r!==true) { Hist.undo.pop(); sync(); refuseProp(inp,r); return; }
    touched=S.walls.filter(w=>w.a===walls[0].a||w.b===walls[0].a||w.a===walls[0].b||w.b===walls[0].b).map(w=>w.id);
  }else if(inp.id==='pAng'&&walls.length===1){
    label='שינוי זווית קיר'; pushHistory(label);
    const r=setWallAngle(walls[0],v);
    if(r!==true) { Hist.undo.pop(); sync(); refuseProp(inp,r); return; }
    touched=S.walls.filter(w=>w.a===walls[0].a||w.b===walls[0].a||w.a===walls[0].b||w.b===walls[0].b).map(w=>w.id);
  }else if(inp.id==='pThk'&&walls.length){
    label='שינוי עובי קיר'; pushHistory(label);
    const t=clamp(v,0.03,1); for(const w of walls) w.t=t;
    touched=walls.map(w=>w.id);
  }else if(inp.id==='pW'&&opens.length){
    label='שינוי רוחב פתח'; pushHistory(label);
    for(const o of opens){
      const w=wallById(o.wallId), a=w&&node(w.a), b=w&&node(w.b);
      const L=a&&b?dist(a,b)*S.mpp:6;
      o.width=clamp(v,0.3,Math.min(6,L*0.98));
    }
    touched=opens.map(o=>o.wallId);
  }else if(inp.id==='pOff'&&opens.length===1){
    label='הזזת פתח'; pushHistory(label);
    if(!setOpeningOffset(opens[0],v)) { Hist.undo.pop(); sync(); refuseProp(inp); return; }
    touched=[opens[0].wallId];
  }else if(inp.id==='pSill'&&opens.length){
    label='שינוי גובה אדן'; pushHistory(label);
    for(const o of opens){ o.sill=clamp(v,0,2); if(o.head<o.sill+0.3) o.head=o.sill+0.3; }
    touched=opens.map(o=>o.wallId);
  }else if(inp.id==='pHead'&&opens.length){
    label='שינוי גובה פתח'; pushHistory(label);
    for(const o of opens){ o.head=clamp(v,0.6,4); if(o.sill>o.head-0.3) o.sill=Math.max(0,o.head-0.3); }
    touched=opens.map(o=>o.wallId);
  }else return;
  afterProp(touched,label);
}
function refuseProp(inp,why){
  say(why==='off'?'הערך הזה מוציא את הקיר אל מחוץ לגיליון. אפשר להזיז את הקצה השני קודם.'
                 :'הערך הזה לא אפשרי כאן.');
  propsBusy=false; renderProps();
}
function afterProp(touched,label){
  const ids=[...new Set((touched||[]).filter(x=>x!=null))];
  if(S.raised&&ids.length){ if(!syncWalls(ids)) build3D(); }
  else if(S.raised) build3D();
  reroom(); refresh(); draw(); touch(); sync();
  renderProps();
  if(label) say(label+' — בוצע. Ctrl+Z מחזיר.');
}
$('#propsDel').onclick=()=>deleteSelection();

/* ══ typing over a drag ═════════════════════════════════════════════
   The CAD move: start the drag so the direction is decided by the hand, then
   type the number so the size is decided exactly. Enter commits it. */
let typed=null;
const typeInEl=$('#typeIn'), typeValEl=$('#typeVal'), typeUnitEl=$('#typeUnit');
function typeTarget(){
  if(!drag) return null;
  if(drag.k==='openEdge') return {what:'width',unit:'מ׳',label:'רוחב פתח'};
  if(drag.k==='end') return {what:'length',unit:'מ׳',label:'אורך קיר'};
  return {what:'move',unit:'מ׳',label:'מרחק'};
}
function showTyped(){
  const t=typeTarget(); if(!t||typed===null){ typeInEl.classList.remove('on'); return; }
  typeValEl.textContent=typed===''?'0':typed;
  typeUnitEl.textContent=t.unit;
  const p=toScreen(S.snap||S.cursor||{x:0,y:0});
  typeInEl.style.insetInlineEnd='';
  typeInEl.style.left=clamp(p.x+16,8,planEl.clientWidth-110)+'px';
  typeInEl.style.top=clamp(p.y-38,8,planEl.clientHeight-44)+'px';
  typeInEl.classList.add('on');
}
function applyTyped(){
  const t=typeTarget(), v=parseFloat(typed);
  if(!t||!isFinite(v)||!S.mpp){ cancelTyped(); return; }
  if(t.what==='width'){
    const o=openingById(drag.open);
    if(o){ const w=wallById(o.wallId), a=w&&node(w.a), b=w&&node(w.b);
      const L=a&&b?dist(a,b)*S.mpp:6;
      o.width=clamp(v,0.3,Math.min(6,L*0.98)); }
  }else if(t.what==='length'){
    const w=wallById(drag.wall);
    if(w){
      /* the hand already chose the direction; the number chooses the distance */
      const fix=node(w.a===drag.nodeId?w.b:w.a), mov=node(drag.nodeId);
      if(fix&&mov){
        const u=unit(fix,mov);
        const q=toSheet({x:fix.x+u.x*(v/S.mpp),y:fix.y+u.y*(v/S.mpp)});
        mov.x=q.x; mov.y=q.y;
      }
    }
  }else{
    const w=wallById(drag.wall);
    if(w&&drag.start){
      const a=node(w.a), b=node(w.b);
      const u=unit(drag.start,S.cursor||drag.start);
      const mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
      const q={x:drag.start.x+u.x*(v/S.mpp),y:drag.start.y+u.y*(v/S.mpp)};
      const dx=q.x-mid.x, dy=q.y-mid.y;
      a.x+=dx;a.y+=dy;b.x+=dx;b.y+=dy;
    }
  }
  drag.moved=true;
  const ids=drag.k==='openEdge'?[openingById(drag.open)?.wallId]
    :S.walls.filter(w=>w.a===drag.nodeId||w.b===drag.nodeId||w.id===drag.wall).map(w=>w.id);
  if(S.raised) syncWalls(ids.filter(Boolean));
  cancelTyped();
  const d=drag; drag=null;
  touch(); reroom(); refresh(); sync(); clearGuides();
  liveDim.textContent=''; draw();
  say(t.label+' נקבע ל־'+fmt(v)+'.');
}
function cancelTyped(){ typed=null; typeInEl.classList.remove('on'); }

/* ══ pointer ════════════════════════════════════════════════════════ */
let panning=false, panStart=null, dragOpening=null, liveSync=0;
let drag=null, marquee=null;

function sayPick(){
  const d=Sel.describe();
  say(d?('נבחרו '+d+'. Backspace מוחק, החצים מזיזים.'):PROMPT.select);
  renderProps();
}

/* Dragging a handle. An endpoint takes every wall that shares that corner with
   it, which is the whole point of a shared corner. */
function dragHandle(p){
  const moving=drag.k==='openEdge'?[] :
    S.walls.filter(w=>w.a===drag.nodeId||w.b===drag.nodeId||w.id===drag.wall).map(w=>w.id);
  let anchor=null;
  if(drag.k==='end'){
    const w=wallById(drag.wall);
    if(w) anchor=node(w.a===drag.nodeId?w.b:w.a)||null;
  }
  const s2=toSheet(snapPoint(p,anchor,drag.k==='end'?[drag.nodeId]:null,moving));
  drag.moved=true;
  if(drag.k==='end'){
    const n=node(drag.nodeId);
    if(n){ n.x=s2.x; n.y=s2.y; }
  }else if(drag.k==='mid'){
    const w=wallById(drag.wall); if(!w) return;
    const a=node(w.a), b=node(w.b); if(!a||!b) return;
    const dx=s2.x-(a.x+b.x)/2, dy=s2.y-(a.y+b.y)/2;
    a.x+=dx; a.y+=dy; b.x+=dx; b.y+=dy;
  }else if(drag.k==='openEdge'){
    const o=openingById(drag.open); if(!o) return;
    const w=wallById(o.wallId); if(!w) return;
    const a=node(w.a), b=node(w.b); if(!a||!b) return;
    const L=dist(a,b)||1;
    const t=clamp(((p.x-a.x)*(b.x-a.x)+(p.y-a.y)*(b.y-a.y))/(L*L),0,1);
    const half=Math.abs(t-o.u)*L*S.mpp;
    o.width=clamp(half*2,0.3,Math.min(6,L*S.mpp*0.98));
  }
  const ids=drag.k==='openEdge'
    ? [openingById(drag.open)?.wallId]
    : S.walls.filter(w=>w.a===drag.nodeId||w.b===drag.nodeId||w.id===drag.wall).map(w=>w.id);
  if(S.raised) syncWalls(ids.filter(Boolean));
  liveDim.textContent=dragReadout();
  S.snap=s2; saySnap(anchor);
  draw();
}
function dragReadout(){
  if(!drag) return '';
  if(drag.k==='openEdge'){ const o=openingById(drag.open); return o?fmt(o.width):''; }
  const w=wallById(drag.wall); if(!w) return '';
  const a=node(w.a), b=node(w.b);
  return a&&b&&S.mpp?fmt(dist(a,b)*S.mpp):'';
}

planEl.addEventListener('pointerdown',e=>{
  /* Everything that floats over the sheet has to be excluded here, or a click
     into it reaches the canvas underneath and clears the very selection the
     panel is describing. */
  if(!S.src||e.target.closest('#lenPop,#zoom,#stageBar,#propBar,#autoBar,#props,#typeIn')) return;
  closePops();
  const r=planEl.getBoundingClientRect(), sp={x:e.clientX-r.left,y:e.clientY-r.top};
  if(e.button===1||keys.space){ panning=true;panStart={...sp,vx:S.view.x,vy:S.view.y};planEl.classList.add('panning');cv.setPointerCapture(e.pointerId);return; }
  if(e.button!==0) return;
  keys.shift=e.shiftKey; keys.alt=e.altKey;
  const p=toSrc(sp);

  if(!onSheet(p)&&(S.tool==='calibrate'||S.tool==='wall')){
    say('אפשר לסמן רק בתוך גיליון התוכנית.'); return;
  }
  if(S.tool==='calibrate'){
    const s=toSheet(snapPoint(p,S.cal.a));
    if(!S.cal.a){ S.cal.a={x:s.x,y:s.y}; say('עכשיו לחצו על הקצה השני.'); }
    else { S.cal.b={x:s.x,y:s.y}; askLength(); }
    draw(); return;
  }
  if(S.tool==='wall'){
    const anchor=S.chain.length?node(S.chain[S.chain.length-1]):null;
    const s=toSheet(snapPoint(p,anchor));
    pushHistory('סימון קיר');
    const id=addNode(s);
    if(S.chain.length){
      const prev=S.chain[S.chain.length-1];
      if(prev!==id) S.walls.push({a:prev,b:id,id:uid++});
      if(id===S.chain[0]&&S.chain.length>2){
        S.chain=[]; liveDim.textContent=''; reroom();
        say('החדר נסגר. סמנו רצף נוסף, או הרימו.');
        refresh(); draw(); touch(); if(S.raised) build3D(); return;
      }
    }
    S.chain.push(id); refresh(); draw(); touch();
    if(S.raised&&!syncWalls()) build3D();
    reroom(); return;
  }
  if(S.tool==='door'||S.tool==='window'){
    const hit=wallAt(p);
    if(!hit){ say('לחצו בדיוק על קיר שסימנתם.'); return; }
    pushHistory(S.tool==='door'?'הוספת דלת':'הוספת חלון');
    const isDoor=S.tool==='door';
    S.openings.push({id:uid++,wallId:hit.wall.id,u:clamp(hit.t,.04,.96),kind:isDoor?'door':'window',
      width:isDoor?S.dims.door:S.dims.win, sill:isDoor?0:S.dims.sill,
      head:isDoor?2.10:S.dims.sill+1.20});
    refresh(); draw(); touch(); if(S.raised) build3D(); return;
  }
  if(S.tool==='select'){
    /* a handle beats everything under it — except Shift, which is the selection
       modifier throughout and must stay able to drop what it just added */
    const h=keys.shift?null:handleAt(p);
    if(h){
      pushHistory(h.k==='openEdge'?'שינוי רוחב פתח':(h.k==='mid'?'הזזת קיר':'הזזת פינה'));
      drag={...h,start:{...p},moved:false};
      cv.setPointerCapture(e.pointerId);
      return;
    }
    const pi=proposalAt(p);
    if(pi>=0){
      const w=S.proposal[pi]; w.on=!w.on;
      syncProposal(); draw();
      say(w.on?'הקיר חזר להצעה.':'הקיר הוצא מההצעה. לחצו שוב כדי להחזיר.');
      return;
    }
    const op=openingAt(p);
    if(op){
      keys.shift?Sel.toggle('opening',op.id):(Sel.has('opening',op.id)||Sel.set('opening',op.id));
      if(!keys.shift&&Sel.has('opening',op.id)){
        dragOpening={id:op.id,moved:false}; pushHistory('הזזת פתח'); cv.setPointerCapture(e.pointerId);
      }
      sayPick(); draw(); return;
    }
    const hit=wallAt(p);
    if(hit){
      keys.shift?Sel.toggle('wall',hit.wall.id):(Sel.has('wall',hit.wall.id)||Sel.set('wall',hit.wall.id));
      sayPick(); draw(); return;
    }
    /* empty ground: sweep a marquee */
    if(!keys.shift) Sel.clear();
    marquee={a:{...p},b:{...p}};
    cv.setPointerCapture(e.pointerId);
    sayPick(); draw(); return;
  }
});

planEl.addEventListener('pointermove',e=>{
  if(!S.src) return;
  const r=planEl.getBoundingClientRect(), sp={x:e.clientX-r.left,y:e.clientY-r.top};
  if(panning){ S.view.x=panStart.vx+(sp.x-panStart.x); S.view.y=panStart.vy+(sp.y-panStart.y); draw(); return; }
  const p=toSrc(sp); S.cursor=p; keys.shift=e.shiftKey; keys.alt=e.altKey;

  if(marquee){ marquee.b={...p}; draw(); return; }
  if(drag){ dragHandle(p); return; }

  if(dragOpening){
    const o=openingById(dragOpening.id); const w=o&&wallById(o.wallId);
    if(!o||!w){ dragOpening=null; return; }
    const a=node(w.a), b=node(w.b); if(!a||!b) return;
    const vx=b.x-a.x, vy=b.y-a.y, L2=vx*vx+vy*vy;
    const u=clamp(((p.x-a.x)*vx+(p.y-a.y)*vy)/L2,.04,.96);
    if(Math.abs(u-o.u)>1e-6) dragOpening.moved=true;
    o.u=u;
    draw();
    if(S.raised&&!liveSync){ liveSync=requestAnimationFrame(()=>{ liveSync=0; syncWalls([o.wallId]); }); }
    return;
  }
  const anchor=S.tool==='wall'&&S.chain.length?node(S.chain[S.chain.length-1]):(S.tool==='calibrate'?S.cal.a:null);
  S.snap=toSheet(snapPoint(p,anchor));
  S.hoverWall=(S.tool==='door'||S.tool==='window'||S.tool==='select')?(wallAt(p)?.wall.id??null):null;
  if(S.tool==='select'){
    const h=Sel.size?handleAt(p):null;
    planEl.classList.toggle('grabbable',!!h);
    if(h) S.hoverWall=null;              // the handle owns the cursor, not the wall under it
  }else planEl.classList.remove('grabbable');
  liveDim.textContent = anchor ? (S.mpp?fmt(dist(anchor,S.snap)*S.mpp):Math.round(dist(anchor,S.snap))+' px') : '';
  saySnap(anchor);
  draw();
});

addEventListener('pointerup',()=>{
  if(marquee){
    const m=marquee; marquee=null;
    const x0=Math.min(m.a.x,m.b.x), x1=Math.max(m.a.x,m.b.x);
    const y0=Math.min(m.a.y,m.b.y), y1=Math.max(m.a.y,m.b.y);
    if(Math.abs(x1-x0)>4/S.view.z||Math.abs(y1-y0)>4/S.view.z){
      const inBox=q=>q.x>=x0&&q.x<=x1&&q.y>=y0&&q.y<=y1;
      for(const w of S.walls){
        const a=node(w.a), b=node(w.b);
        if(a&&b&&inBox(a)&&inBox(b)) Sel.add('wall',w.id);
      }
      for(const o of S.openings){
        const w=wallById(o.wallId); if(!w) continue;
        const a=node(w.a), b=node(w.b); if(!a||!b) continue;
        if(inBox({x:a.x+(b.x-a.x)*o.u,y:a.y+(b.y-a.y)*o.u})) Sel.add('opening',o.id);
      }
    }
    sayPick(); draw(); return;
  }
  if(drag){
    const d=drag; drag=null;
    if(!d.moved) Hist.undo.pop();        // a click that moved nothing is not an edit
    else { touch(); reroom(); }
    sync(); liveDim.textContent=''; clearGuides(); cancelTyped(); renderProps(); draw(); return;
  }
  if(panning){panning=false;planEl.classList.remove('panning');}
  if(dragOpening){
    const d=dragOpening; dragOpening=null;
    const o=openingById(d.id);
    if(!d.moved) Hist.undo.pop();       // picking a pane up and putting it down is not an edit
    else { touch(); if(S.raised&&o) syncWalls([o.wallId]); }
    sync(); }
});
planEl.addEventListener('dblclick',()=>{ if(S.tool==='wall'){S.chain=[];draw();} });
planEl.addEventListener('contextmenu',e=>{ if(S.tool==='wall'){e.preventDefault();S.chain=[];draw();} });

addEventListener('keydown',e=>{
  if(e.target.tagName==='INPUT'){ if(e.key==='Escape') e.target.blur(); return; }
  /* Mid-drag, digits are a measurement, not a shortcut. The hand has already
     chosen the direction; the keyboard chooses the size. */
  if(drag&&/^[0-9.]$/.test(e.key)){
    e.preventDefault(); typed=(typed||'')+e.key; showTyped(); return;
  }
  if(drag&&typed!==null){
    if(e.key==='Backspace'){ e.preventDefault(); typed=typed.slice(0,-1); showTyped(); return; }
    if(e.key==='Enter'){ e.preventDefault(); applyTyped(); return; }
    if(e.key==='Escape'){ e.preventDefault(); cancelTyped(); draw(); return; }
  }
  if(e.key==='Shift') keys.shift=true;
  if(e.key==='Alt'){ keys.alt=true; e.preventDefault(); }
  if(e.code==='Space'){ keys.space=true; e.preventDefault(); }
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'){ e.preventDefault(); e.shiftKey?redo():undo(); return; }
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='y'){ e.preventDefault(); redo(); return; }
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='s'){ e.preventDefault(); save(); return; }
  const k=e.key.toLowerCase();
  if(k==='v') setTool('select');
  if(k==='s') setTool('calibrate');
  if(k==='w') setTool('wall');
  if(k==='d') setTool('door');
  if(k==='n') setTool('window');
  if(k==='a'&&live('#tAuto')) proposeWalls();
  if(k==='r'&&live('#tRaise')) raise();
  if(k==='e'&&live('#tExp')) togglePop('#exp',$('#tExp'));
  if(k==='m'&&live('#tSnap')) togglePop('#snapPop',$('#tSnap'));
  /* a measurement with nothing anchoring it is not a measurement */
  if(k==='escape'){ S.chain=[];S.cal={a:null,b:null};Sel.clear();liveDim.textContent='';clearGuides();hideLen();closePops();
    cancelTyped(); renderProps();
    if(S.proposal) cancelProposal(); else draw(); }
  if(k==='backspace'||k==='delete'){
    if(!Sel.size) return; e.preventDefault(); deleteSelection();
  }
  if(e.key.startsWith('Arrow')&&Sel.size&&S.tool==='select'){ e.preventDefault(); nudge(e); }
});

function deleteSelection(){
  if(!Sel.size) return;
  const wIds=new Set(Sel.walls().map(w=>w.id)), oIds=new Set(Sel.openings().map(o=>o.id));
  pushHistory(deleteLabel(wIds.size,oIds.size));
  S.openings=S.openings.filter(o=>!oIds.has(o.id)&&!wIds.has(o.wallId));
  S.walls=S.walls.filter(w=>!wIds.has(w.id));
  Sel.clear(); refresh(); draw(); touch();
  if(S.raised&&!syncWalls()) build3D();
  reroom(); sync(); renderProps();
  say('נמחק. Ctrl+Z מחזיר.');
}
function deleteLabel(w,o){
  if(w&&o) return 'מחיקת '+(w+o)+' פריטים';
  if(w) return w>1?('מחיקת '+w+' קירות'):'מחיקת קיר';
  return o>1?('מחיקת '+o+' פתחים'):'מחיקת פתח';
}

/* Arrow-nudging, which the status line has been promising. One centimetre a
   press, ten with Shift, and a run of presses collapses into a single undo step
   — thirty taps to slide a wall is one move, not thirty. */
function nudge(e){
  const dir={ArrowUp:[0,-1],ArrowDown:[0,1],ArrowLeft:[-1,0],ArrowRight:[1,0]}[e.key];
  if(!dir) return;
  const cm=e.shiftKey?0.10:0.01;
  const step=S.mpp?cm/S.mpp:(e.shiftKey?10:1);       // sheet units
  if(!nudgeRun) pushHistory('הזזה');
  nudgeRun=true;

  /* collect the corners first — a corner two selected walls share must not move twice */
  const ids=new Set();
  for(const w of Sel.walls()){ ids.add(w.a); ids.add(w.b); }
  for(const w of Sel.nodes()) ids.add(w.id);
  for(const id of ids){
    const n=node(id); if(!n) continue;
    const q=toSheet({x:n.x+dir[0]*step,y:n.y+dir[1]*step});
    n.x=q.x; n.y=q.y;
  }
  /* an opening moves along its own wall, because that is the only way it can */
  for(const o of Sel.openings()){
    const w=wallById(o.wallId); if(!w||ids.has(w.a)||ids.has(w.b)) continue;   // it already travelled with its wall
    const a=node(w.a), b=node(w.b); if(!a||!b) continue;
    const L=dist(a,b)||1;
    const along=(dir[0]*(b.x-a.x)+dir[1]*(b.y-a.y))/L;
    o.u=clamp(o.u+along*step/L,.04,.96);
  }
  const touched=[...new Set([...Sel.walls().map(w=>w.id),...Sel.openings().map(o=>o.wallId),
    ...S.walls.filter(w=>ids.has(w.a)||ids.has(w.b)).map(w=>w.id)])];
  if(S.raised) syncWalls(touched);
  refresh(); draw(); touch(); reroom(); sync(); renderProps();
  const d=Sel.walls()[0];
  if(d){ const a=node(d.a), b=node(d.b);
    if(a&&b&&S.mpp) liveDim.textContent=fmt(dist(a,b)*S.mpp); }
}
addEventListener('keyup',e=>{ if(e.key==='Shift')keys.shift=false; if(e.key==='Alt')keys.alt=false;
  if(e.code==='Space')keys.space=false; });
/* Alt hands focus to the browser chrome on some platforms and the keyup never
   arrives, which would leave snapping off with nothing on screen saying so */
addEventListener('blur',()=>{ keys.shift=keys.alt=keys.space=false; });
addEventListener('beforeunload',e=>{ if(S.dirty&&Cloud.on){ e.preventDefault(); e.returnValue=''; } });

/* ══ calibration ════════════════════════════════════════════════════ */
function askLength(){
  const pop=$('#lenPop'), m=toScreen({x:(S.cal.a.x+S.cal.b.x)/2,y:(S.cal.a.y+S.cal.b.y)/2});
  pop.classList.add('on');
  pop.style.left=clamp(m.x-70,8,planEl.clientWidth-170)+'px';
  pop.style.top=clamp(m.y-72,8,planEl.clientHeight-90)+'px';
  const inp=$('#lenIn'); inp.value=''; inp.focus();
  say('מה האורך האמיתי של הקו הזה?');
}
function hideLen(){ $('#lenPop').classList.remove('on'); }

/* Metric either way — most people read a plan's dimension strings in
   centimetres, which is how this one is printed. The choice is remembered. */
let calUnit=localStorage.getItem('p2m.unit')==='cm'?'cm':'m';
function setUnit(u){
  calUnit=u; localStorage.setItem('p2m.unit',u);
  $('#unitM').setAttribute('aria-pressed',String(u==='m'));
  $('#unitCm').setAttribute('aria-pressed',String(u==='cm'));
  const inp=$('#lenIn');
  inp.step=u==='cm'?'1':'0.01';
  inp.placeholder=u==='cm'?'420':'4.20';
  inp.focus();
}
$('#unitM').onclick=()=>setUnit('m');
$('#unitCm').onclick=()=>setUnit('cm');
setUnit(calUnit);

function applyLength(){
  const raw=parseFloat($('#lenIn').value);
  const m=calUnit==='cm'?raw/100:raw;
  if(!isFinite(m)||m<=0){
    $('#lenIn').focus();
    say(calUnit==='cm'?'הזינו אורך בסנטימטרים, למשל 420':'הזינו אורך במטרים, למשל 4.20');
    return;
  }
  const px=dist(S.cal.a,S.cal.b);
  if(px<3){ say('הקו הזה קצר מדי כדי למדוד ממנו. סמנו קו ארוך יותר.'); return; }
  S.mpp=m/px;
  $('#chipScale').classList.remove('unset');
  $('#scaleVal').textContent=(1/S.mpp).toFixed(1)+' px = 1 מ׳';
  hideLen(); S.cal={a:null,b:null};
  ['#tWall','#tDoor','#tWin'].forEach(s=>$(s).disabled=false);
  setTool('wall'); touch();
  $('#tAuto').disabled=false;
  say('קנה המידה נקבע. עכשיו סמנו את הקירות — לחצו פינה אחר פינה.');
  refresh();
  if(VEC.segs&&VEC.segs.length) proposeWalls();
}
$('#lenOk').onclick=applyLength;
$('#lenIn').onkeydown=e=>{ if(e.key==='Enter'){e.preventDefault();applyLength();} };

const NEED_WALLS=3;

let reroomT;
function reroom(){ clearTimeout(reroomT); reroomT=setTimeout(()=>{
  const before=S.rooms.length;
  S.rooms=findRooms(); draw();
  /* floors and furniture follow the rooms, so a change there is the one case
     that still needs the full build */
  if(S.raised&&(before!==S.rooms.length||before>0)) build3D();
},90); }

function refresh(){
  const n=S.walls.length, ready=!!(S.mpp&&n>=NEED_WALLS);
  $('#tRaise').disabled=!ready;
  $('#tClear').disabled=!(n||S.openings.length);
  $('#tExp').disabled=!S.raised;
  tally.textContent=n?(n+' קירות'+(S.openings.length?' · '+S.openings.length+' פתחים':'')):'';

  /* The model pane is on screen from the first frame, so what is still missing
     is readable at all times. It used to be collapsed to zero width until the
     model already existed, which hid the one sentence explaining how to get one. */
  const raiseNow=$('#tRaise'), stageRaise=$('#stageRaise');
  raiseNow.classList.toggle('ready',ready&&!S.raised);
  $('#swapModel').disabled=!S.raised;
  if(!S.raised){
    const pct=Math.min(100,Math.round(n/NEED_WALLS*100));
    $('#meterFill').style.width=pct+'%';
    $('#meterCount').textContent=Math.min(n,NEED_WALLS)+' / '+NEED_WALLS;
    $('#stageMeter').hidden=!S.mpp;
    stageRaise.hidden=!ready;
    $('#stageTitle').textContent=ready?'הכול מוכן':'כאן יעמוד המודל';
    $('#stageHint').textContent=
      !S.src   ? 'פתחו קובץ PDF כדי להתחיל.' :
      !S.mpp   ? 'קודם קבעו קנה מידה — סמנו קיר אחד שאתם יודעים את אורכו.' :
      ready    ? 'לחצו כדי להעמיד את הקירות. אפשר להמשיך לסמן גם אחר כך.' :
                 'סמנו לפחות שלושה קירות. לחצו פינה אחר פינה על התוכנית.';
  }
}
$('#stageRaise').onclick=raise;

/* phone: one pane at a time */
function setMobileView(v){
  document.body.classList.toggle('m-model',v==='model');
  $('#swapPlan').setAttribute('aria-pressed',String(v!=='model'));
  $('#swapModel').setAttribute('aria-pressed',String(v==='model'));
  requestAnimationFrame(()=>{ sizeCanvas(); draw(); resize3D(); });
}
$('#swapPlan').onclick=()=>setMobileView('plan');
$('#swapModel').onclick=()=>setMobileView('model');
$('#tAuto').onclick=proposeWalls;
$('#propAccept').onclick=()=>acceptProposal();
$('#propCancel').onclick=cancelProposal;
$('#propRedo').onclick=proposeWalls;

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
  if(S.walls.length||S.proposal){ ctx.fillStyle='rgba(255,255,255,.42)'; ctx.fillRect(x,y,S.srcW*z,S.srcH*z); }
  drawRooms(); drawProposal(); drawWalls(); drawOpenings(); drawChain(); drawCal();
  drawGuides(); drawHandles(); drawMarquee(); drawSnap();
}
/* Handles are the selection made grabbable, so they are --rule like every other
   selection mark. Three shapes, one per verb: a square on a corner you can move,
   a disc at mid-span that slides the whole wall, a bar across each edge of an
   opening that widens it. Nothing is drawn that cannot be grabbed — every shape
   here sits exactly where handleAt() will find it. */
function drawHandles(){
  if(S.tool!=='select'||!Sel.size) return;
  const hs=handlesFor(); if(!hs.length) return;
  ctx.save(); ctx.lineJoin='miter';
  for(const h of hs){
    const p=toScreen(h);
    const live=drag&&drag.k===h.k&&drag.open===h.open&&drag.wall===h.wall&&
               drag.which===h.which&&drag.side===h.side;
    ctx.save(); ctx.translate(p.x,p.y);
    if(h.k==='openEdge') ctx.rotate(h.ang+Math.PI/2);
    ctx.beginPath();
    if(h.k==='end') ctx.rect(-4.5,-4.5,9,9);
    else if(h.k==='mid') ctx.arc(0,0,4.4,0,Math.PI*2);
    else ctx.rect(-1.9,-7,3.8,14);
    /* a white halo before the graphite ring: the handle sits on a wall that is
       already --rule, and yellow on yellow is not a handle. */
    ctx.strokeStyle='#FFFFFF'; ctx.lineWidth=3.4; ctx.stroke();
    ctx.fillStyle=live?'#FFFFFF':'#E8B923'; ctx.fill();
    ctx.strokeStyle='#23211E'; ctx.lineWidth=1.4; ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}
function drawMarquee(){
  if(!marquee) return;
  const A=toScreen(marquee.a), B=toScreen(marquee.b);
  const x=Math.min(A.x,B.x), y=Math.min(A.y,B.y);
  const w=Math.abs(B.x-A.x), h=Math.abs(B.y-A.y);
  if(w<2&&h<2) return;
  ctx.save();
  ctx.fillStyle='rgba(232,185,35,.14)'; ctx.fillRect(x,y,w,h);
  ctx.strokeStyle='#23211E'; ctx.lineWidth=1; ctx.setLineDash([4,3]);
  ctx.strokeRect(x+.5,y+.5,w,h);
  ctx.restore();
}
function drawRooms(){
  if(!S.rooms.length) return;
  /* graphite wash, not --rule: the yellow is reserved for the active instrument,
     the selection, the live measurement and the unset-scale chip. */
  ctx.save(); ctx.fillStyle='rgba(35,33,30,.07)';
  for(const r of S.rooms){
    ctx.beginPath();
    r.forEach((n,i)=>{ const p=toScreen(n); i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y); });
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}
const wallThick=w=>(w&&w.t>0?w.t:S.dims.wall);
function drawWalls(){
  const tPx=S.mpp?(S.dims.wall/S.mpp)*S.view.z:6;
  S.walls.forEach((w,i)=>{
    const a=node(w.a), b=node(w.b); if(!a||!b) return;
    const A=toScreen(a), B=toScreen(b);
    const on=Sel.has('wall',w.id), hov=S.hoverWall===w.id;
    ctx.save(); ctx.lineCap='butt';
    ctx.strokeStyle=on?'#E8B923':(hov?'#4A453D':'#23211E');
    ctx.lineWidth=Math.max(2.5,S.mpp?(wallThick(w)/S.mpp)*S.view.z:6);
    ctx.beginPath(); ctx.moveTo(A.x,A.y); ctx.lineTo(B.x,B.y); ctx.stroke();
    ctx.restore();
  });
  /* corner handles before the dimension strings — a corner that lands mid-span
     was punching a hole through the number. */
  const used=new Set(); S.walls.forEach(w=>{used.add(w.a);used.add(w.b);});
  ctx.save();
  for(const n of S.nodes){
    if(!used.has(n.id)) continue;
    const p=toScreen(n);
    ctx.fillStyle='#FFFFFF'; ctx.strokeStyle='#23211E'; ctx.lineWidth=1.4;
    ctx.beginPath(); ctx.rect(p.x-2.5,p.y-2.5,5,5); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
  if(!S.mpp||S.view.z<=0.12) return;
  S.walls.forEach((w,i)=>{
    const a=node(w.a), b=node(w.b); if(!a||!b) return;
    const A=toScreen(a), B=toScreen(b);
    const on=Sel.has('wall',w.id);
    const txt=fmt(dist(a,b)*S.mpp);
    let ang=Math.atan2(B.y-A.y,B.x-A.x);
    if(ang>Math.PI/2||ang<-Math.PI/2) ang+=Math.PI;
    ctx.save(); ctx.translate((A.x+B.x)/2,(A.y+B.y)/2); ctx.rotate(ang);
    /* a selected wall grows a handle at exactly this point, so the number steps
       off the line — which is where a dimension is lettered on a real drawing
       anyway. Unselected, it stays on the wall where it reads best. */
    if(on) ctx.translate(0,-Math.max(tPx/2+10,14));
    ctx.font='500 11px "Archivo Narrow", sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    const tw=ctx.measureText(txt).width;
    /* a number wider than its own wall is noise, not a measurement */
    if(tw+8>Math.hypot(B.x-A.x,B.y-A.y)){ ctx.restore(); return; }
    ctx.fillStyle=on?'#E8B923':'#FFFFFF'; ctx.fillRect(-tw/2-3,-8,tw+6,15);
    ctx.fillStyle='#23211E'; ctx.fillText(txt,0,0);
    ctx.restore();
  });
}
function drawOpenings(){
  S.openings.forEach((o,i)=>{
    const w=wallById(o.wallId); if(!w) return;
    const a=node(w.a), b=node(w.b); if(!a||!b) return;
    const A=toScreen(a), B=toScreen(b);
    const ang=Math.atan2(B.y-A.y,B.x-A.x);
    const tPx=S.mpp?(wallThick(w)/S.mpp)*S.view.z:6;
    const wPx=S.mpp?(o.width/S.mpp)*S.view.z:16, th=Math.max(3,tPx);
    const on=Sel.has('opening',o.id);
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
/* The name of what caught, plus the angle when there is one — a magnet that
   does not say what it grabbed is indistinguishable from a bug. */
function saySnap(anchor){
  const k=S.snap&&S.snap.kind;
  if(!k){ snapState.textContent=''; return; }
  const names=String(k).split('+').map(x=>SNAP_NAME[x]||(x==='onwall'?'על הקיר':x));
  let t=names.join(' + ');
  if(anchor&&S.snap){
    const d=Math.round(Math.atan2(S.snap.y-anchor.y,S.snap.x-anchor.x)*180/Math.PI);
    if(String(k).includes('angle')) t+=' '+((d%360)+360)%360+'°';
  }
  snapState.textContent=t;
}
/* Guides are graphite hairlines, not --rule: the yellow marks the point that
   was caught, and a guide is the reason, not the result. */
function drawGuides(){
  if(!S.guides||!S.guides.length) return;
  ctx.save();
  for(const g of S.guides){
    const A=toScreen(g.a), B=toScreen(g.b);
    if(g.kind==='ref'){
      /* the wall the claim answers to, bracketed rather than overdrawn */
      const dx=B.x-A.x, dy=B.y-A.y, L=Math.hypot(dx,dy)||1, nx=-dy/L, ny=dx/L;
      ctx.strokeStyle='rgba(35,33,30,.5)'; ctx.lineWidth=1.4; ctx.setLineDash([]);
      ctx.beginPath();
      [[A,1],[B,-1]].forEach(([P,s])=>{
        ctx.moveTo(P.x+nx*7,P.y+ny*7); ctx.lineTo(P.x-nx*7,P.y-ny*7);
        ctx.moveTo(P.x+nx*7,P.y+ny*7); ctx.lineTo(P.x+nx*7+s*dx/L*10,P.y+ny*7+s*dy/L*10);
        ctx.moveTo(P.x-nx*7,P.y-ny*7); ctx.lineTo(P.x-nx*7+s*dx/L*10,P.y-ny*7+s*dy/L*10);
      });
      ctx.stroke();
      continue;
    }
    ctx.strokeStyle='rgba(35,33,30,.55)'; ctx.lineWidth=1; ctx.setLineDash([5,4]);
    ctx.beginPath(); ctx.moveTo(A.x,A.y); ctx.lineTo(B.x,B.y); ctx.stroke();
  }
  ctx.restore();
}
function drawSnap(){
  if(!S.snap||(S.tool==='select'&&!drag)) return;
  const p=toScreen(S.snap);
  ctx.save(); ctx.strokeStyle='#E8B923';
  const k=String(S.snap.kind);
  ctx.lineWidth=1.8; ctx.lineJoin='miter';
  const M={
    node(){ ctx.lineWidth=2; ctx.strokeRect(p.x-5,p.y-5,10,10); },
    corner(){ ctx.beginPath();
      ctx.moveTo(p.x,p.y-6);ctx.lineTo(p.x+6,p.y);ctx.lineTo(p.x,p.y+6);ctx.lineTo(p.x-6,p.y);
      ctx.closePath(); ctx.stroke(); },
    mid(){ ctx.beginPath();
      ctx.moveTo(p.x-6,p.y+4);ctx.lineTo(p.x+6,p.y+4);ctx.lineTo(p.x,p.y-6);
      ctx.closePath(); ctx.stroke(); },
    inter(){ ctx.lineWidth=2; ctx.beginPath();
      ctx.moveTo(p.x-6,p.y-6);ctx.lineTo(p.x+6,p.y+6);
      ctx.moveTo(p.x+6,p.y-6);ctx.lineTo(p.x-6,p.y+6); ctx.stroke(); },
    perp(){ ctx.beginPath();                       // the draughtsman's right angle
      ctx.moveTo(p.x-6,p.y-6);ctx.lineTo(p.x-6,p.y+6);ctx.lineTo(p.x+6,p.y+6);
      ctx.moveTo(p.x-6,p.y+2);ctx.lineTo(p.x-2,p.y+2);ctx.lineTo(p.x-2,p.y+6); ctx.stroke(); },
    ext(){ ctx.beginPath();
      ctx.moveTo(p.x-6,p.y-6);ctx.lineTo(p.x-6,p.y+6);
      ctx.moveTo(p.x-1,p.y);ctx.lineTo(p.x+7,p.y);
      ctx.moveTo(p.x+3,p.y-4);ctx.lineTo(p.x+7,p.y);ctx.lineTo(p.x+3,p.y+4); ctx.stroke(); },
    par(){ ctx.beginPath();
      ctx.moveTo(p.x-6,p.y+5);ctx.lineTo(p.x+2,p.y-5);
      ctx.moveTo(p.x-2,p.y+5);ctx.lineTo(p.x+6,p.y-5); ctx.stroke(); },
    angle(){ ctx.lineWidth=1.4; ctx.beginPath();
      ctx.moveTo(p.x-7,p.y);ctx.lineTo(p.x+7,p.y);ctx.moveTo(p.x,p.y-7);ctx.lineTo(p.x,p.y+7); ctx.stroke(); },
    grid(){ ctx.beginPath(); ctx.arc(p.x,p.y,2.6,0,Math.PI*2); ctx.fillStyle='#E8B923'; ctx.fill(); },
    onwall(){ ctx.beginPath(); ctx.arc(p.x,p.y,5,0,Math.PI*2); ctx.stroke(); },
  };
  /* a compound snap draws both marks, offset, because it satisfied both */
  const parts=k.split('+');
  parts.forEach((part,i)=>{
    const f=M[part]; if(!f) return;
    ctx.save(); if(i) ctx.translate(0,-13); f(); ctx.restore();
  });
  ctx.restore();
}

/* ══ 3d ═════════════════════════════════════════════════════════════ */
const stage=$('#stage');
let renderer,scene,camera,shell,envRT,sun,hemi,raiseT=0,raising=false;
let eye=null, orbitHome=null;
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
  sun.position.set(15,13,9); sun.castShadow=true; sun.shadow.mapSize.set(2048,2048);
  const d=34,c=sun.shadow.camera; c.left=-d;c.right=d;c.top=d;c.bottom=-d;c.near=.5;c.far=120;
  sun.shadow.bias=-0.0006; sun.shadow.normalBias=.02; scene.add(sun);
  buildEnv(); bindOrbit(); resize3D();
  (function loop(){ requestAnimationFrame(loop); tick(); })();
}
/* Sky gradient for the image-based light. It is baked into a canvas texture on a
   plain MeshBasicMaterial rather than drawn by a ShaderMaterial: a raw ShaderMaterial
   run through PMREMGenerator.fromScene resolves to a black environment map, which
   turned every surface in Render mode black. Values are linear, not sRGB — the PMREM
   pass renders with LinearEncoding and no tone mapping. */
function skyTexture(){
  const c=document.createElement('canvas'); c.width=8; c.height=256;
  const g=c.getContext('2d'), grd=g.createLinearGradient(0,0,0,256);
  grd.addColorStop(0,'rgb(158,179,209)');    // zenith   .62 .70 .82
  grd.addColorStop(.5,'rgb(235,230,219)');   // horizon  .92 .90 .86
  grd.addColorStop(1,'rgb(77,71,64)');       // ground   .30 .28 .25
  g.fillStyle=grd; g.fillRect(0,0,8,256);
  return new THREE.CanvasTexture(c);
}
function buildEnv(){
  const s=new THREE.Scene();
  s.add(new THREE.Mesh(new THREE.SphereGeometry(60,24,16),
    new THREE.MeshBasicMaterial({map:skyTexture(),side:THREE.BackSide})));
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
  if(S.cam==='eye'){
    /* stand at the target and look out from it. Orbiting a point a couple of
       metres ahead just filled the frame with whatever wall was behind it. */
    camera.position.set(orbit.tx,1.62,orbit.tz);
    camera.lookAt(
      orbit.tx-Math.cos(orbit.az)*Math.cos(orbit.el)*4,
      1.62-Math.sin(orbit.el)*4,
      orbit.tz-Math.sin(orbit.az)*Math.cos(orbit.el)*4);
  }else{
    camera.position.set(
      orbit.tx+Math.cos(orbit.az)*Math.cos(orbit.el)*orbit.r,
      orbit.ty+Math.sin(orbit.el)*orbit.r,
      orbit.tz+Math.sin(orbit.az)*Math.cos(orbit.el)*orbit.r);
    camera.lookAt(orbit.tx,orbit.ty*.55+.9,orbit.tz);
  }
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
  eye=null; orbitHome=null;
  if(shell&&scene){ scene.remove(shell); disposeTree(shell); shell=null; }
  $('#stageEmpty').style.display='';
  $('#stageBar').hidden=true;
  bodyEl.classList.remove('wide3d');
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
function tex(c,rep,linear){
  const t=new THREE.CanvasTexture(c);
  t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(rep,rep);
  t.anisotropy=renderer?renderer.capabilities.getMaxAnisotropy():1;
  /* a colour map is sRGB. Left at the default LinearEncoding every texture came
     out pale and desaturated once the renderer converted the frame back. */
  if(!linear) t.encoding=THREE.sRGBEncoding;
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
  MAT.floor=new THREE.MeshStandardMaterial({map:tex(floorC,3),roughnessMap:tex(floorR,3,true),roughness:.62,metalness:0,envMapIntensity:.8});
  MAT.wall=new THREE.MeshStandardMaterial({map:tex(wallC,5),roughnessMap:tex(wallR,5,true),roughness:.93,metalness:0,envMapIntensity:.55});
  MAT.glass=new THREE.MeshStandardMaterial({color:0xD7E3E8,roughness:.06,metalness:0,transparent:true,opacity:.24,envMapIntensity:2.2});
  MAT.boardW=new THREE.MeshStandardMaterial({color:0xCFC8BA,roughness:.94,metalness:0});
  MAT.boardF=new THREE.MeshStandardMaterial({color:0xB4AB99,roughness:.96,metalness:0});
  MAT.built=true;
}

/* ══ doors and windows, from the gaps ═══════════════════════════════
   An opening is not drawn on a plan — it is drawn by ABSENCE. The wall poché
   simply stops, and a swing arc or a pair of thin lines fills the hole. So we
   do not look for door symbols; we measure where each wall's own faces are
   missing, which the coverage analysis already showed lines up exactly with the
   openings. What it is follows from where it is and how wide: an interior gap
   is a door, a wide gap on an outside wall is a window, a narrow one is the
   front door. */
/* A door is door-width. A hole wider than that in an outside wall is a window;
   wider than that inside is a passage, which is a door with no leaf. Anything
   past 2.5 m is a wall the detector missed, not an opening — calling it a door
   would put a 2.7 m hole in the model and claim it was measured. */
function openingKind(wm,ext){
  if(wm<0.6||wm>2.55) return null;
  if(wm<=1.25) return 'door';
  return ext?'window':'door';
}

function wallIsExterior(a,b){
  if(!S.rooms.length) return true;
  const mx=(a.x+b.x)/2, my=(a.y+b.y)/2;
  const L=dist(a,b)||1;
  const nx=-(b.y-a.y)/L, ny=(b.x-a.x)/L;
  const off=(S.dims.wall*1.4)/S.mpp;
  let inside=0;
  for(const sgn of [-1,1]){
    const p={x:mx+nx*off*sgn,y:my+ny*off*sgn};
    if(S.rooms.some(r=>inPoly(p,r))) inside++;
  }
  return inside<2;
}

/* The detector splits a wall AT its doorway, so the hole ends up between two
   wall records rather than inside one and there is nothing left to find. Put
   the wall back together across gaps that are opening-shaped, and remember the
   gap as the opening. One continuous wall with a hole in it is also what the
   model wants to build. */
function mergeAcrossOpenings(){
  const segs=S.walls.map(w=>{const a=node(w.a),b=node(w.b);return a&&b?{a:{...a},b:{...b},t:w.t}:null;}).filter(Boolean);
  const minW=0.60/S.mpp, maxW=2.55/S.mpp;
  const holes=[];
  let merged=true, guard=0;
  while(merged&&guard++<40){
    merged=false;
    outer:
    for(let i=0;i<segs.length;i++)for(let j=i+1;j<segs.length;j++){
      const A=segs[i], B=segs[j];
      const la=dist(A.a,A.b), lb=dist(B.a,B.b); if(la<1||lb<1) continue;
      const ux=(A.b.x-A.a.x)/la, uy=(A.b.y-A.a.y)/la, nx=-uy, ny=ux;
      const bu=(B.b.x-B.a.x)/lb, bv=(B.b.y-B.a.y)/lb;
      if(Math.abs(ux*bv-uy*bu)>0.1) continue;                       // not collinear
      if(Math.abs((B.a.x-A.a.x)*nx+(B.a.y-A.a.y)*ny)>0.14/S.mpp) continue;
      const t=p=>(p.x-A.a.x)*ux+(p.y-A.a.y)*uy;
      const b0=Math.min(t(B.a),t(B.b)), b1=Math.max(t(B.a),t(B.b));
      const gap=b0>la?b0-la:(b1<0?-b1:-1);
      if(gap<minW||gap>maxW) continue;
      const lo=Math.min(0,b0), hi=Math.max(la,b1);
      const P=q=>({x:A.a.x+ux*q,y:A.a.y+uy*q});
      const gs=b0>la?la:b1, ge=b0>la?b0:0;
      holes.push({from:P(Math.min(gs,ge)),to:P(Math.max(gs,ge)),line:{a:P(lo),b:P(hi)}});
      segs[i]={a:P(lo),b:P(hi),t:Math.max(A.t||0,B.t||0)};
      segs.splice(j,1);
      merged=true;
      break outer;
    }
  }
  /* rebuild the wall list from the merged runs */
  S.nodes=[]; S.walls=[]; uid=1;
  const tol=0.05/S.mpp;
  const at=q=>{ for(const n of S.nodes) if(dist(n,q)<tol) return n.id;
    const n={id:uid++,x:q.x,y:q.y}; S.nodes.push(n); return n.id; };
  for(const g of segs){ const a=at(g.a), b=at(g.b); if(a!==b) S.walls.push({a,b,t:g.t,id:uid++}); }

  /* attach each remembered gap to the wall it now sits in */
  const out=[];
  for(const h of holes){
    const mid={x:(h.from.x+h.to.x)/2,y:(h.from.y+h.to.y)/2};
    let bi=-1,bd=0.4/S.mpp;
    for(let i=0;i<S.walls.length;i++){
      const a=node(S.walls[i].a), b=node(S.walls[i].b);
      const vx=b.x-a.x, vy=b.y-a.y, L2=vx*vx+vy*vy; if(!L2) continue;
      const t=clamp(((mid.x-a.x)*vx+(mid.y-a.y)*vy)/L2,0,1);
      const d=Math.hypot(mid.x-(a.x+vx*t),mid.y-(a.y+vy*t));
      if(d<bd){ bd=d; bi=i; }
    }
    if(bi<0) continue;
    const a=node(S.walls[bi].a), b=node(S.walls[bi].b), L=dist(a,b);
    const u=clamp((((mid.x-a.x)*(b.x-a.x)+(mid.y-a.y)*(b.y-a.y))/(L*L)),.04,.96);
    const wm=dist(h.from,h.to)*S.mpp;
    const kind=openingKind(wm,wallIsExterior(a,b));
    if(!kind) continue;
    out.push({id:uid++,wallId:S.walls[bi].id,u,kind,width:wm,
      sill:kind==='door'?0:S.dims.sill,
      head:kind==='door'?2.10:S.dims.sill+1.20});
  }
  return out;
}

function detectOpenings(){
  if(!VEC.segs||!S.mpp||!S.walls.length) return [];
  const out=[];
  const minW=0.60/S.mpp, maxW=2.55/S.mpp, edge=0.22/S.mpp;
  for(let wi=0;wi<S.walls.length;wi++){
    const w=S.walls[wi], a=node(w.a), b=node(w.b);
    if(!a||!b) continue;
    const L=dist(a,b); if(L<1.2/S.mpp) continue;
    const ux=(b.x-a.x)/L, uy=(b.y-a.y)/L, nx=-uy, ny=ux;
    const band=Math.max(S.dims.wall,(w.t||0))*0.85/S.mpp;

    const gather=filledOnly=>{
    const spans=[];
    for(let i=0;i<VEC.segs.length;i+=5){
      if(filledOnly&&!VEC.segs[i+4]) continue;
      const x1=VEC.segs[i],y1=VEC.segs[i+1],x2=VEC.segs[i+2],y2=VEC.segs[i+3];
      const sl=Math.hypot(x2-x1,y2-y1); if(sl<0.25/S.mpp) continue;
      const sx=(x2-x1)/sl, sy=(y2-y1)/sl;
      if(Math.abs(sx*nx+sy*ny)>0.14) continue;                 // must run with the wall
      const o1=(x1-a.x)*nx+(y1-a.y)*ny, o2=(x2-a.x)*nx+(y2-a.y)*ny;
      if(Math.abs(o1)>band||Math.abs(o2)>band) continue;       // must be one of its faces
      let t1=(x1-a.x)*ux+(y1-a.y)*uy, t2=(x2-a.x)*ux+(y2-a.y)*uy;
      if(t1>t2){ const s=t1; t1=t2; t2=s; }
      spans.push([Math.max(0,t1),Math.min(L,t2)]);
    }
    spans.sort((p,q)=>p[0]-q[0]);
    const merged=[];
    for(const s of spans){
      const last=merged[merged.length-1];
      if(last&&s[0]<=last[1]+2) last[1]=Math.max(last[1],s[1]);
      else merged.push([s[0],s[1]]);
    }
    return merged;
    };
    /* prefer the filled poché; fall back to every parallel line on a drawing
       that hatches its walls instead of filling them */
    let merged=gather(true);
    const cover=m=>m.reduce((n,[x,y])=>n+(y-x),0);
    if(cover(merged)<L*0.3) merged=gather(false);
    if(merged.length<2) continue;
    const ext=wallIsExterior(a,b);
    for(let i=0;i<merged.length-1;i++){
      const g0=merged[i][1], g1=merged[i+1][0], gw=g1-g0;
      if(gw<minW||gw>maxW) continue;
      if(g0<edge||g1>L-edge) continue;                          // that is a corner, not a hole
      const u=(g0+g1)/2/L;
      const wm=gw*S.mpp;
      const kind=openingKind(wm,ext);
      if(!kind) continue;
      out.push({id:uid++,wallId:w.id,u:clamp(u,.04,.96),kind,
        width:wm,
        sill:kind==='door'?0:S.dims.sill,
        head:kind==='door'?2.10:S.dims.sill+1.20});
    }
  }
  /* one opening per place — overlapping gaps on the same wall are one hole */
  const keep=[];
  for(const o of out){
    const ow=wallById(o.wallId);
    if(!ow) continue;
    if(keep.some(k=>k.wallId===o.wallId&&Math.abs(k.u-o.u)*dist(node(ow.a),node(ow.b))*S.mpp<0.3)) continue;
    keep.push(o);
  }
  return keep;
}

/* ══ what each room is ══════════════════════════════════════════════
   The architect already labelled every room. We read those labels and match
   each to the polygon it sits inside, which is what decides the floor, the
   paint and the furniture. Nothing is inferred from shape or size — if the
   drawing does not name a room, it stays unfurnished rather than guessed at. */
const ROOM_KINDS=[
  ['bath',   /רחצה|אמבט|שירות|מקלח|אסלה|שרותים|bath|toilet|wc|shower|ensuite/i],
  ['kitchen',/מטבח|kitchen|kitchenette/i],
  ['bed',    /שינה|ילדים|הורים|bed\s*room|bedroom|master/i],
  ['living', /סלון|מגורים|משפחה|אורחים|living|family|lounge|salon/i],
  ['dining', /אוכל|פינת אוכל|dining/i],
  ['office', /עבודה|משרד|מחשב|ספריה|office|study|work/i],
  ['balcony',/מרפסת|גזוזטרה|balcony|terrace|patio|deck/i],
  ['store',  /מחסן|ארון|כביסה|מזווה|storage|closet|laundry|pantry|utility/i],
  ['stair',  /מדרגות|גרם|stair/i],
  ['hall',   /מסדרון|פרוזדור|כניסה|הול|לובי|hall|corridor|entry|foyer|lobby/i],
];
const OUTDOOR=/לא מקורה|פתוח|open|uncovered/i;

function inPoly(p,poly){
  let inside=false;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++){
    const a=poly[i], b=poly[j];
    if((a.y>p.y)!==(b.y>p.y) && p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x) inside=!inside;
  }
  return inside;
}

function roomInfo(){
  const out=[];
  for(const poly of S.rooms){
    let A=0,cx=0,cy=0;
    for(let i=0;i<poly.length;i++){
      const a=poly[i], b=poly[(i+1)%poly.length], cr=a.x*b.y-b.x*a.y;
      A+=cr; cx+=(a.x+b.x)*cr; cy+=(a.y+b.y)*cr;
    }
    A/=2; if(Math.abs(A)<1) continue;
    const c={x:cx/(6*A),y:cy/(6*A)};
    const xs=poly.map(p=>p.x), ys=poly.map(p=>p.y);
    const bb={x0:Math.min(...xs),x1:Math.max(...xs),y0:Math.min(...ys),y1:Math.max(...ys)};
    let kind=null, label='', outdoor=false;
    if(VEC.text){
      for(const t of VEC.text){
        if(!inPoly({x:t.cx,y:t.cy},poly)) continue;
        if(/^[\d.,+\-]+$/.test(t.s)) continue;          // a dimension is not a name
        for(const [k,re] of ROOM_KINDS) if(re.test(t.s)){ kind=kind||k; label=label||t.s; }
        if(OUTDOOR.test(t.s)) outdoor=true;
      }
    }
    out.push({poly,area:Math.abs(A)*S.mpp*S.mpp,c,bb,kind,label,outdoor,
      w:(bb.x1-bb.x0)*S.mpp,d:(bb.y1-bb.y0)*S.mpp});
  }
  return out;
}

/* ══ materials ══════════════════════════════════════════════════════ */
function planksTex(base,plank,grain){
  return noiseCanvas(512,512,(x,y)=>{
    const row=Math.floor(y/plank), gx=(x+row*97)%512;
    const g=Math.sin(gx*.31+row*2.7)*.5+Math.sin(gx*1.9+row)*.24+(Math.random()-.5)*grain;
    const seam=(y%plank<1.6||gx%118<1.1)?-.3:0;
    const b=.72+g*.11+seam;
    return [clamp(base[0]*b,0,255),clamp(base[1]*b,0,255),clamp(base[2]*b,0,255)];
  });
}
function tilesTex(base,size,grout){
  return noiseCanvas(512,512,(x,y)=>{
    const gx=x%size, gy=y%size;
    const line=(gx<grout||gy<grout);
    const v=line?.74:(.97+(Math.random()-.5)*.05);
    return [clamp(base[0]*v,0,255),clamp(base[1]*v,0,255),clamp(base[2]*v,0,255)];
  });
}
function grassTex(){
  return noiseCanvas(256,256,()=>{
    const v=.72+Math.random()*.4;
    return [clamp(104*v,0,255),clamp(132*v,0,255),clamp(66*v,0,255)];
  });
}
function flatTex(rgb,jitter){
  return noiseCanvas(64,64,()=>{
    const v=1+(Math.random()-.5)*jitter;
    return [clamp(rgb[0]*v,0,255),clamp(rgb[1]*v,0,255),clamp(rgb[2]*v,0,255)];
  });
}
const MSTD=(o)=>new THREE.MeshStandardMaterial(o);
function floorMaterial(kind,outdoor){
  if(!MAT.floors) MAT.floors={};
  const key=(kind||'none')+(outdoor?'-out':'');
  if(MAT.floors[key]) return MAT.floors[key];
  let m;
  if(outdoor||kind==='balcony')      m=MSTD({map:tex(tilesTex([196,190,178],86,4),4),roughness:.86,metalness:0});
  else if(kind==='bath')             m=MSTD({map:tex(tilesTex([206,214,216],64,5),5),roughness:.34,metalness:0,envMapIntensity:1.2});
  else if(kind==='kitchen')          m=MSTD({map:tex(tilesTex([170,163,152],96,5),4),roughness:.46,metalness:0,envMapIntensity:.9});
  else if(kind==='stair'||kind==='store') m=MSTD({map:tex(flatTex([176,170,160],.1),3),roughness:.9,metalness:0});
  else                               m=MSTD({map:tex(planksTex([186,142,96],58,.18),3.2),roughness:.58,metalness:0,envMapIntensity:.8});
  MAT.floors[key]=m; return m;
}

/* ══ furniture ══════════════════════════════════════════════════════
   Built from boxes, procedurally, because a furniture library is a download and
   this has to work offline in a browser. It is blocking and scale, not styling:
   a bed that is 1.6 x 2.0 tells you the room takes a double, which is the
   question people actually open a plan to answer. */
function box(w,h,d,mat,x,y,z,ry){
  const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);
  m.position.set(x,y+h/2,z); if(ry) m.rotation.y=ry;
  m.castShadow=true; m.receiveShadow=true;
  m.userData={h,y0:y+h/2};
  return m;
}
function furnMats(modelMode){
  if(!MAT.fu||MAT.fuMode!==modelMode){
    const B=c=>MSTD({color:modelMode?0xCFC8BA:c,roughness:.78,metalness:0});
    MAT.fu={
      wood:B(0x8A6844), soft:B(0x9AA3A8), soft2:B(0x7C8790), white:B(0xF2F0EC),
      dark:B(0x4A4741), metal:modelMode?B(0xCFC8BA):MSTD({color:0xB9BDC2,roughness:.32,metalness:.75}),
      cloth:B(0xB9AE99), green:B(0x5C7A4A),
    };
    MAT.fuMode=modelMode;
  }
  return MAT.fu;
}

function furnishRoom(g,r,H,modelMode){
  const F=furnMats(modelMode);
  const w=r.w, d=r.d, big=Math.max(w,d), horiz=w>=d;
  const put=(mesh)=>g.add(mesh);
  const R=horiz?0:Math.PI/2;                 // long axis of the room
  const L=big, S2=Math.min(w,d);
  if(S2<1.1||r.area<2) return;
  const px=(u,v)=>horiz?[u,v]:[v,u];         // along, across → x,z

  if(r.kind==='bed'&&S2>2.0){
    const bw=r.area>13?1.6:1.2, bl=2.0;
    const [bx,bz]=px(-L/2+bl/2+.15,0);
    put(box(horiz?bl:bw,.32,horiz?bw:bl,F.cloth,bx,0,bz));
    put(box(horiz?.12:bw+.2,.75,horiz?bw+.2:.12,F.wood,...(horiz?[-L/2+.1,0,bz]:[bz,0,-L/2+.1])));
    for(const s of [-1,1]){
      const [nx,nz]=px(-L/2+bl+.4,s*(bw/2+.35));
      if(Math.abs(s*(bw/2+.35))<S2/2-.3) put(box(.42,.45,.42,F.wood,nx,0,nz));
    }
    if(L>3.4){ const [wx,wz]=px(L/2-.35,0); put(box(horiz?.6:Math.min(2.2,S2-.6),2.1,horiz?Math.min(2.2,S2-.6):.6,F.wood,wx,0,wz)); }
  }
  else if(r.kind==='living'||r.kind==='dining'){
    const sl=Math.min(2.4,S2-.8);
    const [sx,sz]=px(-L/2+.55,0);
    put(box(horiz?.9:sl,.42,horiz?sl:.9,F.soft,sx,0,sz));
    put(box(horiz?.24:sl,.78,horiz?sl:.24,F.soft2,...(horiz?[-L/2+.25,0,sz]:[sz,0,-L/2+.25])));
    const [tx,tz]=px(-L/2+1.7,0);
    put(box(horiz?.6:1.1,.38,horiz?1.1:.6,F.wood,tx,0,tz));
    const [rx,rz]=px(-L/2+1.5,0);
    const rug=new THREE.Mesh(new THREE.BoxGeometry(horiz?2.2:Math.min(2.8,S2-.4),.012,horiz?Math.min(2.8,S2-.4):2.2),F.cloth);
    rug.position.set(rx,.008,rz); rug.receiveShadow=true; rug.userData={h:.012,y0:.008}; put(rug);
    if(L>4.2){ const [vx,vz]=px(L/2-.35,0); put(box(horiz?.42:1.8,.5,horiz?1.8:.42,F.dark,vx,0,vz));
      put(box(horiz?.08:1.25,.72,horiz?1.25:.08,F.dark,...(horiz?[L/2-.3,.62,vz]:[vz,.62,L/2-.3]))); }
    if(r.area>18){
      const [dx2,dz]=px(L/2-1.6,0);
      put(box(horiz?1.5:.95,.74,horiz?.95:1.5,F.wood,dx2,0,dz));
      for(let i=-1;i<=1;i+=2)for(let k=-1;k<=1;k+=2){
        const [cx2,cz]=px(L/2-1.6+i*.55,k*.72);
        if(Math.abs(k*.72)<S2/2-.35) put(box(.42,.46,.42,F.wood,cx2,0,cz));
      }
    }
  }
  else if(r.kind==='kitchen'){
    const run=Math.min(L-.4,3.6);
    const [kx,kz]=px(-L/2+run/2+.2,-(S2/2-.32));
    put(box(horiz?run:.62,.9,horiz?.62:run,F.white,kx,0,kz));
    put(box(horiz?run:.66,.06,horiz?.66:run,F.dark,kx,.9,kz));
    const [ux,uz]=px(-L/2+run/2+.2,-(S2/2-.2));
    put(box(horiz?run*.8:.36,.7,horiz?.36:run*.8,F.white,ux,1.5,uz));
    if(S2>3.2){ const [ix,iz]=px(0,.4); put(box(horiz?1.6:.8,.9,horiz?.8:1.6,F.white,ix,0,iz));
      put(box(horiz?1.7:.9,.06,horiz?.9:1.7,F.dark,ix,.9,iz)); }
  }
  else if(r.kind==='bath'){
    if(big>2.0){ const [bx,bz]=px(-L/2+.9,-(S2/2-.4));
      put(box(horiz?1.7:.75,.52,horiz?.75:1.7,F.white,bx,0,bz)); }
    const [sx,sz]=px(L/2-.35,-(S2/2-.28));
    put(box(horiz?.6:.5,.85,horiz?.5:.6,F.white,sx,0,sz));
    const [wx,wz]=px(L/2-.35,S2/2-.3);
    put(box(.4,.42,.6,F.white,wx,0,wz));
  }
  else if(r.kind==='office'){
    const [dx2,dz]=px(-L/2+.9,-(S2/2-.35));
    put(box(horiz?1.5:.7,.74,horiz?.7:1.5,F.wood,dx2,0,dz));
    const [cx2,cz]=px(-L/2+.9,-(S2/2-1.1));
    put(box(.5,.5,.5,F.dark,cx2,0,cz));
  }
  else if(r.kind==='store'){
    put(box(Math.min(w-.3,1.2),2.0,Math.min(d-.3,.6),F.wood,0,0,0));
  }
  else if(r.kind==='balcony'||r.outdoor){
    if(r.area>4){ put(box(.9,.72,.9,F.wood,0,0,0));
      put(box(.42,.44,.42,F.wood,.85,0,.3)); }
  }
}

/* ══ the site ═══════════════════════════════════════════════════════ */
function buildSite(group,spanX,spanZ,modelMode){
  if(modelMode) return;                       // the study model sits on nothing
  const F=furnMats(false);
  const R=Math.max(spanX,spanZ);
  const ground=new THREE.Mesh(new THREE.PlaneGeometry(R*8,R*8),
    MSTD({map:tex(grassTex(),Math.max(12,R*1.6)),roughness:.97,metalness:0}));
  ground.rotation.x=-Math.PI/2; ground.position.y=-.06; ground.receiveShadow=true;
  group.add(ground);

  /* a paved apron so the building is not planted straight into the lawn */
  const apron=new THREE.Mesh(new THREE.PlaneGeometry(spanX+2.6,spanZ+2.6),
    MSTD({map:tex(tilesTex([190,185,175],110,5),Math.max(4,R/3)),roughness:.9,metalness:0}));
  apron.rotation.x=-Math.PI/2; apron.position.y=-.03; apron.receiveShadow=true;
  group.add(apron);

  const trunk=new THREE.CylinderGeometry(.12,.17,1.5,7);
  const crown=new THREE.SphereGeometry(1,9,7);
  const bark=MSTD({color:0x6B5340,roughness:.95,metalness:0});
  let seed=1337;
  const rnd=()=>{ seed=(seed*1103515245+12345)&0x7fffffff; return seed/0x7fffffff; };
  for(let i=0;i<14;i++){
    const ang=rnd()*Math.PI*2, rad=Math.max(spanX,spanZ)*(.75+rnd()*.9);
    const x=Math.cos(ang)*rad, z=Math.sin(ang)*rad;
    if(Math.abs(x)<spanX/2+2.2&&Math.abs(z)<spanZ/2+2.2) continue;
    const sc=.8+rnd()*.9;
    const t=new THREE.Mesh(trunk,bark);
    t.position.set(x,.75*sc,z); t.scale.setScalar(sc); t.castShadow=true; group.add(t);
    const c=new THREE.Mesh(crown,MSTD({color:new THREE.Color().setHSL(.26+rnd()*.06,.34,.26+rnd()*.1),roughness:.93,metalness:0}));
    c.position.set(x,(1.5+.9*sc)*sc,z); c.scale.set(1.25*sc,1.5*sc,1.25*sc); c.castShadow=true; group.add(c);
  }
  for(let i=0;i<18;i++){
    const ang=rnd()*Math.PI*2, rad=Math.max(spanX,spanZ)*(.6+rnd()*.4);
    const x=Math.cos(ang)*rad, z=Math.sin(ang)*rad;
    if(Math.abs(x)<spanX/2+1.6&&Math.abs(z)<spanZ/2+1.6) continue;
    const b=new THREE.Mesh(crown,F.green);
    b.position.set(x,.28,z); b.scale.set(.5+rnd()*.4,.4,.5+rnd()*.4); b.castShadow=true; group.add(b);
  }
}


/* One wall's geometry, on its own, so an edit can rebuild just that wall
   instead of the entire model plus its furniture and its trees. */
function buildWall(w,parent){
  const c=parent.userData.ctx; if(!c) return null;
  const {cx,cy,m,H,T,modelMode,matW}=c;
  const X=p=>(p.x-cx)*m, Z=p=>(p.y-cy)*m;
  const a=node(w.a), b=node(w.b); if(!a||!b) return null;
  const ax=X(a),az=Z(a),bx=X(b),bz=Z(b);
  const L=Math.hypot(bx-ax,bz-az); if(L<.01) return null;
  const g=new THREE.Group();
  g.position.set((ax+bx)/2,0,(az+bz)/2);
  g.rotation.y=-Math.atan2(bz-az,bx-ax);
  const ops=S.openings.filter(o=>o.wallId===w.id)
    .map(o=>({s:clamp(o.u*L-o.width/2,0,L),e:clamp(o.u*L+o.width/2,0,L),o}))
    .sort((p,q)=>p.s-q.s);
  /* the wall's own thickness when the drawing gave it one, so an exterior
     envelope does not come out the same as an interior partition */
  const TW=w.t>0?clamp(w.t,.03,1):T;
  const box=(len,hgt,y0,x0,mat)=>{
    if(len<=.004||hgt<=.004) return;
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(len,hgt,TW),mat);
    mesh.position.set(x0-L/2+len/2,y0+hgt/2,0);
    mesh.castShadow=true; mesh.receiveShadow=true;
    mesh.userData={h:hgt,y0:y0+hgt/2};
    g.add(mesh);
  };
  let cur=0;
  for(const {s:s0,e:e0,o} of ops){
    if(s0>cur) box(s0-cur,H,0,cur,matW);
    const head=Math.min(o.head,H);
    if(o.sill>.004) box(e0-s0,o.sill,0,s0,matW);
    if(head<H-.004) box(e0-s0,H-head,head,s0,matW);
    if(o.kind==='window'&&!modelMode){
      const gl=new THREE.Mesh(new THREE.BoxGeometry(e0-s0,head-o.sill,TW*.16),MAT.glass);
      gl.position.set(s0-L/2+(e0-s0)/2,o.sill+(head-o.sill)/2,0);
      gl.userData={h:head-o.sill,y0:o.sill+(head-o.sill)/2};
      g.add(gl);
    }
    cur=e0;
  }
  if(cur<L) box(L-cur,H,0,cur,matW);
  g.userData.wallId=w.id;
  parent.add(g);
  parent.userData.wallGroups.set(w.id,g);
  if(S.raised) applyRiseTo(g,1);
  return g;
}

/* Rebuild only the walls named, leaving floors, furniture and the site alone.
   A wall drag used to rebuild every tree on the site on every pointer move. */
function syncWalls(ids){
  if(!shell||!shell.userData.ctx) return false;
  const map=shell.userData.wallGroups; if(!map) return false;
  const set=ids?new Set(ids):new Set(S.walls.map(w=>w.id));
  for(const id of set){
    const old=map.get(id);
    if(old){ shell.remove(old); disposeTree(old); map.delete(id); }
    const w=wallById(id);
    if(w) buildWall(w,shell);
  }
  /* anything that vanished from the model */
  for(const [id,g] of [...map]) if(!wallById(id)){ shell.remove(g); disposeTree(g); map.delete(id); }
  return true;
}
function applyRiseTo(g,e){
  g.traverse(o=>{ if(o.userData.h===undefined) return;
    o.scale.y=Math.max(1e-4,e); o.position.y=o.userData.y0*e; });
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

  const info=S.rooms.length?roomInfo():[];
  /* A base slab under the whole footprint, always. Where a room was not
     detected there would otherwise be a hole straight through to the paving
     outside, which reads as a bug rather than as a gap in the detection. */
  {
    const base=new THREE.Mesh(
      new THREE.BoxGeometry((maxX-minX)*m+T,.04,(maxY-minY)*m+T),
      modelMode?matF:floorMaterial(null,false));
    base.position.y=-.02; base.receiveShadow=true; shell.add(base);
  }
  if(info.length){
    for(const r of info){
      const shape=new THREE.Shape();
      /* build in (x,-z) and rotate -90 so the slab's normal ends up pointing UP.
         rotateX(+90) sent it down: every floor in the model was being viewed
         from behind and culled, which is why the paving showed through. */
      r.poly.forEach((n,i)=>{ i?shape.lineTo(X(n),-Z(n)):shape.moveTo(X(n),-Z(n)); });
      const g=new THREE.ShapeGeometry(shape); g.rotateX(-Math.PI/2);
      const mat=modelMode?matF:floorMaterial(r.kind,r.outdoor);
      const f=new THREE.Mesh(g,mat); f.position.y=.006; f.receiveShadow=true; shell.add(f);
      /* furniture sits in the room's own frame, so it can be placed against walls */
      if(!r.outdoor||r.kind==='balcony'){
        const rg=new THREE.Group();
        rg.position.set((r.c.x-cx)*m,0,(r.c.y-cy)*m);
        furnishRoom(rg,r,H,modelMode);
        if(rg.children.length) shell.add(rg);
      }
    }
  }else{
    const f=new THREE.Mesh(new THREE.BoxGeometry((maxX-minX)*m+T,.04,(maxY-minY)*m+T),matF);
    f.position.y=-.02; f.receiveShadow=true; shell.add(f);
  }

  /* the frame every incremental rebuild works in. Kept fixed while editing so a
     drag cannot make the whole model jump; it is recomputed on a full build. */
  shell.userData.ctx={cx,cy,m,H,T,modelMode,matW,matF};
  shell.userData.wallGroups=new Map();

  S.walls.forEach(w=>buildWall(w,shell));

  /* where eye level puts you: the middle of the largest room the user closed,
     falling back to the middle of the plan when nothing is closed yet */
  eye=null;
  let bestA=0;
  for(const r of S.rooms){
    const p=r.map(n=>({x:X(n),z:Z(n)}));
    if(p.length<3) continue;
    let A=0,sx=0,sz=0;
    for(let i=0;i<p.length;i++){
      const a=p[i], b=p[(i+1)%p.length], cr=a.x*b.z-b.x*a.z;
      A+=cr; sx+=(a.x+b.x)*cr; sz+=(a.z+b.z)*cr;
    }
    A/=2;
    if(Math.abs(A)<=bestA||Math.abs(A)<=0.5) continue;
    bestA=Math.abs(A);
    const xs=p.map(q=>q.x), zs=p.map(q=>q.z);
    const bw=Math.max(...xs)-Math.min(...xs), bd=Math.max(...zs)-Math.min(...zs);
    eye=spotIn(sx/(6*A),sz/(6*A),bw,bd);
  }
  if(!eye) eye=spotIn(0,0,(maxX-minX)*m,(maxY-minY)*m);

  buildSite(shell,(maxX-minX)*m,(maxY-minY)*m,modelMode);

  if(!S.raised){
    frameModel((maxX-minX)*m,(maxY-minY)*m,H);
    orbit.ty=H*.55; orbit.tx=0; orbit.tz=0;
  }
  applyEnv(); applyRise(S.raised?1:0);
  $('#stageEmpty').style.display='none';
}
/* Stand back along the room's longer axis and look down it. Standing in the middle
   of a room and facing an arbitrary direction just fills the frame with the nearest
   wall — the view has to be composed down the length of the space. az is the orbit
   azimuth; the camera looks along its negative. */
function spotIn(cx,cz,w,d){
  return w>=d ? {x:cx-w*.34, z:cz, az:Math.PI}
              : {x:cx, z:cz-d*.34, az:-Math.PI/2};
}

/* Pull back far enough that the whole plan fits the pane. The stage is a tall,
   narrow column, so the horizontal half-angle — not the camera's vertical fov —
   is usually what decides the distance; sizing off the plan's longest side alone
   opened every model as a close-up of one wall. Fits the eight corners of the
   bounding box at the opening orbit angles rather than its bounding sphere, which
   is far too loose for a shape this flat. */
function frameModel(w,d,h){
  const r=stage.getBoundingClientRect();
  const aspect=(r.width>8&&r.height>8)?r.width/r.height:(camera.aspect||1);
  const vHalf=camera.fov*Math.PI/360;
  const hHalf=Math.atan(Math.tan(vHalf)*aspect);
  const ty=h*.55, look={x:0,y:ty*.55+.9,z:0};
  /* camera basis at the opening orbit angles, unit distance */
  const f={x:Math.cos(orbit.az)*Math.cos(orbit.el),y:Math.sin(orbit.el),z:Math.sin(orbit.az)*Math.cos(orbit.el)};
  const up={x:0,y:1,z:0};
  const rt={x:f.z*up.y-f.y*up.z,y:f.x*up.z-f.z*up.x,z:f.y*up.x-f.x*up.y};
  const rl=Math.hypot(rt.x,rt.y,rt.z); rt.x/=rl; rt.y/=rl; rt.z/=rl;
  const u={x:rt.y*f.z-rt.z*f.y,y:rt.z*f.x-rt.x*f.z,z:rt.x*f.y-rt.y*f.x};
  let need=4;
  for(const sx of[-1,1])for(const sy of[0,1])for(const sz of[-1,1]){
    const p={x:sx*w/2-look.x,y:sy*h-look.y,z:sz*d/2-look.z};
    const along=-(p.x*f.x+p.y*f.y+p.z*f.z);           // depth toward the camera
    const px=p.x*rt.x+p.y*rt.y+p.z*rt.z;
    const py=p.x*u.x+p.y*u.y+p.z*u.z;
    need=Math.max(need,along+Math.abs(px)/Math.tan(hHalf),along+Math.abs(py)/Math.tan(vHalf));
  }
  orbit.r=clamp(need*1.08,4,180);
}
function applyEnv(){
  const r=S.mode==='render';
  scene.environment=r?envRT.texture:null;
  scene.background=new THREE.Color(r?0xAFC4D8:0xCFCABF);
  scene.fog=r?new THREE.Fog(0xAFC4D8,60,320):null;
  hemi.intensity=r?.42:.78;
  hemi.color.setHex(r?0xBBD3EC:0xffffff);
  hemi.groundColor.setHex(r?0x6E7355:0x9a927f);
  sun.color.setHex(r?0xFFF2DC:0xffffff);
  sun.intensity=r?1.85:1.15;
  renderer.toneMappingExposure=r?.92:1;
}
function raise(){
  /* the precondition, not the button's visibility — on a phone the instrument
     is hidden until you are in the model view, which you reach BY raising */
  if($('#tRaise').disabled) return;
  $('#stageBar').hidden=false;
  build3D(); S.raised=true; raiseT=0; raising=true;
  requestAnimationFrame(resize3D); refresh();
  if(matchMedia('(max-width:900px)').matches) setMobileView('model');
  say('גררו כדי להסתובב. עברו לרנדור כשהצורה נכונה.');
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
  if(S.cam===c) return;
  S.cam=c;
  $('#vOrbit').setAttribute('aria-pressed',String(c==='orbit'));
  $('#vEye').setAttribute('aria-pressed',String(c==='eye'));
  if(c==='eye'){
    /* stand in a room rather than at the model's origin, which on a plan with
       interior walls is often inside one of them */
    orbitHome={tx:orbit.tx,tz:orbit.tz,r:orbit.r,el:orbit.el,az:orbit.az};
    const e=eye||{x:0,z:0,az:Math.PI};
    orbit.tx=e.x; orbit.tz=e.z; orbit.az=e.az; orbit.el=.02;
    orbit.r=3;   /* not a distance here, only the pan speed reference */
    if(camera){ camera.fov=70; camera.updateProjectionMatrix(); }  /* an interior lens */
  }else{
    if(orbitHome){ Object.assign(orbit,orbitHome); orbitHome=null; }
    orbit.el=Math.max(orbit.el,.35); orbit.r=Math.max(orbit.r,7);
    if(camera){ camera.fov=48; camera.updateProjectionMatrix(); }
  }
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
  toast('התמונה נשמרה.');
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
  toast('קובץ OBJ נשמר. נפתח ב־SketchUp, ב־Blender וב־Rhino.');
};

$('#xJson').onclick=()=>{
  closePops();
  const data=JSON.stringify(serialize(),null,2);
  download(URL.createObjectURL(new Blob([data],{type:'application/json'})),slug()+'.json');
  toast('נתוני הסימון נשמרו.');
};

/* ══ boot ═══════════════════════════════════════════════════════════ */
document.addEventListener('click',e=>{
  if(!e.target.closest('#opt,#exp,#snapPop,#tOpt,#tExp,#tSnap')) closePops();
});
sizeCanvas(); draw(); refresh(); sync();
new ResizeObserver(()=>{sizeCanvas();draw();resize3D();}).observe(document.body);
Cloud.init();
