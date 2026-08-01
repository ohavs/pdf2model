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
  proposal:null,
  scaleSrc:null,
  projectId:null, name:'תוכנית ללא שם', pdfBytes:null, pdfName:'', dirty:false
};
let uid = 1;
const $ = s => document.querySelector(s);
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

const planEl=$('#plan'), cv=$('#planCv'), ctx=cv.getContext('2d');
const bodyEl=$('#body'), msg=$('#msg'), liveDim=$('#liveDim'), tally=$('#tally');

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const fmt=m=>(m===null||!isFinite(m))?'—':(m>=1?m.toFixed(2)+' מ׳':Math.round(m*100)+' ס״מ');
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
function serialize(){
  return {
    uid:Cloud.uid, name:S.name, pdfName:S.pdfName, pageNum:S.pageNum, mpp:S.mpp,
    dims:S.dims, nodes:S.nodes, walls:S.walls, rooms:S.rooms, openings:S.openings,
    uidSeq:uid, updatedAt:Date.now()
  };
}
function hydrate(d){
  S.name=d.name||'תוכנית ללא שם'; S.pdfName=d.pdfName||''; S.mpp=d.mpp??null;
  S.dims=Object.assign(S.dims,d.dims||{});
  S.nodes=d.nodes||[]; S.walls=d.walls||[]; S.rooms=d.rooms||[]; S.openings=d.openings||[];
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
      b.innerHTML=`<span>${escapeHtml(v.name||'ללא שם')}</span><span class="when">${when(v.updatedAt)}</span>`;
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
    say('פותח…');
    const doc=await Cloud.db.collection('projects').doc(id).get();
    if(!doc.exists){ toast('התוכנית הזאת כבר לא קיימת.'); return; }
    S.projectId=id; hydrate(doc.data());
    const bytes=await Cloud.getPDF(id);
    await openBytes(bytes,S.pdfName||'plan.pdf',doc.data().pageNum||1);
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
    ['#tCal','#tOpt'].forEach(s=>$(s).disabled=false);
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
  const seg=(x1,y1,x2,y2)=>{
    if(sg.length>=VEC_MAX*2) return;
    const ax=m[0]*x1+m[2]*y1+m[4], ay=m[1]*x1+m[3]*y1+m[5];
    const bx=m[0]*x2+m[2]*y2+m[4], by=m[1]*x2+m[3]*y2+m[5];
    if(!isFinite(ax)||!isFinite(ay)||!isFinite(bx)||!isFinite(by)) return;
    if(Math.hypot(bx-ax,by-ay)<1.5) return;
    sg.push(ax,ay,bx,by);
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
    else if(fn===O.constructPath){
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
  for(let i=0;i<sg.length;i+=4){
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
  S.proposal=runs.map(r=>({a:r.a,b:r.b,on:true}));
  acceptProposal(true);
  showAutoBar(g,runs.length);
  setTool('select');
  if(!$('#tRaise').disabled) raise();
  say('המודל מוכן. לחצו על קיר כדי לערוך אותו, או הוסיפו דלתות וחלונות.');
}

function showAutoBar(g,n){
  const bar=$('#autoBar'); if(!bar) return;
  bar.hidden=false;
  $('#autoScale').textContent=g.label;
  $('#autoHow').textContent=g.how==='ratio'?'נקרא מהשרטוט'
    :g.how==='dims'?'חושב מהמידות הרשומות':'נקרא מהשרטוט ואומת מול המידות';
  $('#autoWalls').textContent=n;
  $('#autoWallsWrap').hidden=!n;
}
function hideAutoBar(){ const b=$('#autoBar'); if(b) b.hidden=true; }
$('#autoManual').onclick=()=>{
  hideAutoBar();
  S.mpp=null; S.scaleSrc=null;
  $('#chipScale').classList.add('unset');
  $('#scaleVal').textContent='לא נקבע';
  pushHistory();
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
    S.proposal=runs.map(r=>({a:r.a,b:r.b,on:true}));
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
  const maxGap=1.4/S.mpp;
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

  for(const w of segsOf.concat(bridges)){
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
  pushHistory();
  /* one node per corner, so the accepted runs share endpoints and can close rooms */
  const tol=0.05/S.mpp;
  const at=q=>{
    for(const n of S.nodes) if(dist(n,q)<tol) return n.id;
    const n={id:uid++,x:q.x,y:q.y}; S.nodes.push(n); return n.id;
  };
  for(const w of keep){
    const a=at(w.a), b=at(w.b);
    if(a!==b) S.walls.push({a,b,id:uid++});
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
  refresh(); draw(); touch(); reroom();
}

/* ══ tools ══════════════════════════════════════════════════════════ */
const TOOLS={select:'#tSelect',calibrate:'#tCal',wall:'#tWall',door:'#tDoor',window:'#tWin'};
const PROMPT={
  select:'לחצו על קיר או על פתח כדי לבחור אותו. Backspace מוחק.',
  calibrate:'לחצו על קצה אחד של קיר שאתם יודעים את אורכו, ואז על הקצה השני.',
  wall:'לחצו פינה אחר פינה. Shift לסימון חופשי. Esc מסיים את הרצף.',
  door:'לחצו על קיר שסימנתם כדי להוסיף שם דלת.',
  window:'לחצו על קיר שסימנתם כדי להוסיף שם חלון.'
};
function setTool(t){
  if($(TOOLS[t])?.disabled) return;
  S.tool=t; S.chain=[]; S.cal={a:null,b:null}; S.sel=null; hideLen(); closePops(); liveDim.textContent='';
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
  S.proposal=null; syncProposal();
  S.raised=false; clear3D(); refresh(); draw(); touch();
  say('הסימון נמחק. קנה המידה נשמר.');
};
/* enabled and actually on screen — below 820px the model instruments are removed
   with the model pane, and their shortcuts must go with them */
function live(sel){ const el=$(sel); return !!el&&!el.disabled&&el.offsetParent!==null; }
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

/* ══ snapping / hit ═════════════════════════════════════════════════ */
const keys={shift:false,space:false};
/* The sheet is the ground truth; nothing can be marked off it. A corner placed
   in the surrounding mat measures nothing and produced walls floating outside
   the drawing. */
const onSheet=p=>p.x>=0&&p.y>=0&&p.x<=S.srcW&&p.y<=S.srcH;
const toSheet=p=>({...p,x:clamp(p.x,0,S.srcW),y:clamp(p.y,0,S.srcH)});

function snapPoint(p,anchor){
  const R=13/S.view.z;
  let best=null,bd=R;
  for(const n of S.nodes){ const d=dist(n,p); if(d<bd){bd=d;best={x:n.x,y:n.y,id:n.id,kind:'node'};} }
  if(best) return best;                                  // the user's own corners win
  if(!keys.shift){
    /* 11 screen px, but never further than 15 cm in the real building — zoomed
       out on a 1:100 sheet that radius was reaching a quarter of a metre and
       pulling corners onto the wrong face, which bends the run visibly. */
    const v=vecNear(p,Math.min(11/S.view.z, S.mpp?0.15/S.mpp:Infinity));
    if(v) return v;
  }
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
  if(!S.src||e.target.closest('#lenPop,#zoom,#stageBar,#propBar,#autoBar')) return;
  closePops();
  const r=planEl.getBoundingClientRect(), sp={x:e.clientX-r.left,y:e.clientY-r.top};
  if(e.button===1||keys.space){ panning=true;panStart={...sp,vx:S.view.x,vy:S.view.y};planEl.classList.add('panning');cv.setPointerCapture(e.pointerId);return; }
  if(e.button!==0) return;
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
    pushHistory();
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
    S.chain.push(id); refresh(); draw(); touch(); reroom(); return;
  }
  if(S.tool==='door'||S.tool==='window'){
    const hit=wallAt(p);
    if(!hit){ say('לחצו בדיוק על קיר שסימנתם.'); return; }
    pushHistory();
    const isDoor=S.tool==='door';
    S.openings.push({id:uid++,wall:hit.i,u:clamp(hit.t,.04,.96),kind:isDoor?'door':'window',
      width:isDoor?S.dims.door:S.dims.win, sill:isDoor?0:S.dims.sill,
      head:isDoor?2.10:S.dims.sill+1.20});
    refresh(); draw(); touch(); if(S.raised) build3D(); return;
  }
  if(S.tool==='select'){
    const pi=proposalAt(p);
    if(pi>=0){
      const w=S.proposal[pi]; w.on=!w.on;
      syncProposal(); draw();
      say(w.on?'הקיר חזר להצעה.':'הקיר הוצא מההצעה. לחצו שוב כדי להחזיר.');
      return;
    }
    const oi=openingAt(p);
    if(oi>=0){ S.sel={t:'opening',i:oi}; dragOpening=oi; pushHistory(); cv.setPointerCapture(e.pointerId); draw(); return; }
    const hit=wallAt(p);
    S.sel=hit?{t:'wall',i:hit.i}:null;
    say(S.sel?'נבחר. Backspace מוחק.':PROMPT.select);
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
  S.snap=toSheet(snapPoint(p,anchor));
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
  if(k==='a'&&live('#tAuto')) proposeWalls();
  if(k==='r'&&live('#tRaise')) raise();
  if(k==='e'&&live('#tExp')) togglePop('#exp',$('#tExp'));
  /* a measurement with nothing anchoring it is not a measurement */
  if(k==='escape'){ S.chain=[];S.cal={a:null,b:null};S.sel=null;liveDim.textContent='';hideLen();closePops();
    if(S.proposal) cancelProposal(); else draw(); }
  if(k==='backspace'||k==='delete'){
    if(!S.sel) return; e.preventDefault(); pushHistory();
    if(S.sel.t==='opening') S.openings.splice(S.sel.i,1);
    else{
      S.openings=S.openings.filter(o=>o.wall!==S.sel.i).map(o=>({...o,wall:o.wall>S.sel.i?o.wall-1:o.wall}));
      S.walls.splice(S.sel.i,1);
    }
    S.sel=null; refresh(); draw(); touch(); reroom();
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
  S.rooms=findRooms(); draw(); if(S.raised) build3D();
},60); }

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
  drawRooms(); drawProposal(); drawWalls(); drawOpenings(); drawChain(); drawCal(); drawSnap();
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
    const on=S.sel?.t==='wall'&&S.sel.i===i;
    const txt=fmt(dist(a,b)*S.mpp);
    let ang=Math.atan2(B.y-A.y,B.x-A.x);
    if(ang>Math.PI/2||ang<-Math.PI/2) ang+=Math.PI;
    ctx.save(); ctx.translate((A.x+B.x)/2,(A.y+B.y)/2); ctx.rotate(ang);
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
  else if(S.snap.kind==='vector'){
    ctx.lineWidth=1.8; ctx.beginPath();
    ctx.moveTo(p.x,p.y-6);ctx.lineTo(p.x+6,p.y);ctx.lineTo(p.x,p.y+6);ctx.lineTo(p.x-6,p.y);
    ctx.closePath(); ctx.stroke();
  }
  else if(S.snap.kind==='ortho'){
    ctx.lineWidth=1.4; ctx.beginPath();
    ctx.moveTo(p.x-7,p.y);ctx.lineTo(p.x+7,p.y);ctx.moveTo(p.x,p.y-7);ctx.lineTo(p.x,p.y+7); ctx.stroke();
  }
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
  sun.position.set(9,14,7); sun.castShadow=true; sun.shadow.mapSize.set(2048,2048);
  const d=22,c=sun.shadow.camera; c.left=-d;c.right=d;c.top=d;c.bottom=-d;c.near=.5;c.far=70;
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
      r.forEach((n,i)=>{ i?shape.lineTo(X(n),Z(n)):shape.moveTo(X(n),Z(n)); });
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
  scene.background=new THREE.Color(r?0xBFC6CC:0xCFCABF);
  hemi.intensity=r?.28:.78; sun.intensity=r?2.3:1.15;
  renderer.toneMappingExposure=r?1.05:1;
}
function raise(){
  if(!live('#tRaise')) return;
  $('#stageBar').hidden=false;
  build3D(); S.raised=true; raiseT=0; raising=true;
  requestAnimationFrame(resize3D); refresh();
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
  if(!e.target.closest('#opt,#exp,#tOpt,#tExp')) closePops();
});
sizeCanvas(); draw(); refresh();
new ResizeObserver(()=>{sizeCanvas();draw();resize3D();}).observe(document.body);
Cloud.init();
