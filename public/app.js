(function(){
'use strict';

/* ---------- config ---------- */
/* Data dibaca server dari Postgres (warehouse) + Sheet per brand, lalu digabung per
   nomor HP. Halaman ini cukup polling /api/state. Tambahkan #cek di URL untuk diagnostik. */
var API='api/state';
var STORE_LS=1500, SPEED=3.4, DWELL=4;  /* SPEED = rem per detik, DWELL = detik berhenti di peringkat 1 */
var SOURCE_LABEL={postgres:'Postgres',sheet:'Sheet',drive:'Sheet brand',jubelio:'Jubelio'};
var LS_KEY='imperfect-live-state-v4';
var reduced=false;
try{reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;}catch(e){}

function $(id){return document.getElementById(id);}
function el(tag,cls,text){var n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;}

/* ---------- formatting ---------- */
var nf=new Intl.NumberFormat('id-ID');
function parts(v){
  v=Math.max(0,v||0);
  if(v>=1e9) return {n:(v/1e9).toFixed(2).replace('.',','),u:'bio'};
  if(v>=1e6) return {n:(v/1e6).toFixed(1).replace('.',','),u:'mio'};
  if(v>=1e3) return {n:String(Math.round(v/1e3)),u:'k'};
  return {n:String(Math.round(v)),u:''};
}
function money(v){var p=parts(v);return 'Rp '+p.n+(p.u==='k'?'k':(p.u?' '+p.u:''));}
function clock(iso){
  try{
    var s=new Intl.DateTimeFormat('id-ID',{hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Asia/Jakarta'}).format(new Date(iso));
    return s.replace('.',':');
  }catch(e){return '';}
}

/* ---------- example data: only on …/#contoh (for design checks), never on the TV ---------- */
function sampleState(){
  var seed=7;
  function rnd(){seed|=0;seed=seed+0x6D2B79F5|0;var t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;}
  function pick(a){return a[Math.floor(rnd()*a.length)];}
  var first=['Dewi','Rina','Budi','Agus','Sari','Putri','Andi','Maya','Fajar','Nadia','Rizky','Intan','Hendra','Lia','Yoga','Tika'];
  var last=['S.','W.','P.','L.','H.','K.','R.'];
  var pre=['0812','0813','0857','0878','0821','0895'];
  function phone(){var s='';while(s.length<4)s+=Math.floor(rnd()*10);return pick(pre)+'-xxxx-'+s;}
  var top=[],i,k;
  for(i=0;i<60;i++){
    var t=1+Math.floor(rnd()*2),e={p:phone(),n:pick(first)+' '+pick(last),q:0,t:t,v:0};
    for(k=0;k<t;k++){e.q+=1+Math.floor(rnd()*3);e.v+=Math.round(150+rnd()*750)*1000;}
    top.push(e);
  }
  for(i=0;i<10;i++){
    var jt=5+Math.floor(rnd()*5),j={p:phone(),n:pick(first)+' '+pick(last),q:0,t:jt,v:0};
    for(k=0;k<jt;k++){j.q+=2+Math.floor(rnd()*9);j.v+=Math.round(6000+rnd()*30000)*1000;}
    top.push(j);
  }
  top.sort(function(a,b){return b.v-a.v;});
  return {sample:true,updatedAt:null,top:top};
}

/* ---------- render: dua kolom ranking yang bergerak ---------- */
var note=$('chip-sample'),act=$('chip-action'),diagChip=$('chip-diag');
var colB=$('col-b'),trkA=$('trk-a'),trkB=$('trk-b');
var current=null,lastSig='',live=null; /* live = last state from the server */
function demo(){return location.hash==='#contoh';}
/* #contoh shows example data; otherwise the real ranking, empty ("Rp 0") until the first sale */
function show(){render(demo()?sampleState():(live||{top:[]}));}
var mobile=false;
try{mobile=window.matchMedia('(max-width:900px)').matches;}catch(e){}
function remPx(){return parseFloat(getComputedStyle(document.documentElement).fontSize)||16;}
function rowEl(r,rank){
  var li=el('div','row'+(rank<=3?' top':'')+(rank===1?' r1':''));
  li.appendChild(el('span','rk',String(rank)));
  var who=el('span','who');
  who.appendChild(el('span','ph',r.p));
  who.appendChild(el('span','nm',r.n||'Pelanggan'));
  li.appendChild(who);
  var val=el('span','val');
  val.appendChild(el('b',null,money(r.v)));
  val.appendChild(el('small',null,r.t+' trx · '+r.q+' pcs'));
  li.appendChild(val);
  return li;
}
/* satu aliran: kolom kiri = jendela awal, kolom kanan = lanjutan persis di bawahnya.
   Baris yang keluar di atas kolom kanan masuk ke bawah kolom kiri, satu irama. */
var flow={on:false,o:0,hold:DWELL,L:0,H:0};
var lastT=0,vel=0,remC=remPx(),RAMP=1.6;
function fillStatic(trk,list,startRank){
  trk.textContent='';trk.style.transform='';
  list.forEach(function(r,i){trk.appendChild(rowEl(r,startRank+i));});
}
/* empty board: numbered placeholder rows keep the board's shape behind the call-out */
function ghostRow(rank){
  var li=el('div','row ghost'+(rank<=3?' top':''));
  li.appendChild(el('span','rk',String(rank)));
  var who=el('span','who'),w=[62,48,70,55,66,44,58,51][rank%8];
  var a=el('span','bar');a.style.width=w+'%';who.appendChild(a);
  var b=el('span','bar sm');b.style.width=Math.round(w*.55)+'%';who.appendChild(b);
  li.appendChild(who);
  var val=el('span','val');
  val.appendChild(el('b',null,'Rp 0'));
  val.appendChild(el('small',null,'0 trx · 0 pcs'));
  li.appendChild(val);
  return li;
}
function layoutEmpty(){
  var rem=remPx(),lists=$('lists'),H=lists.clientHeight;
  var cap=mobile?3:Math.max(1,Math.floor(H/(4.6*rem)));
  flow.on=false;colB.hidden=mobile;
  if(!mobile) lists.style.setProperty('--rowh',(H/cap/rem).toFixed(3)+'rem');
  [trkA,trkB].forEach(function(t,c){
    t.textContent='';t.style.transform='';
    for(var i=1;i<=cap;i++) t.appendChild(ghostRow(c*cap+i));
  });
}
function layout(top){
  var rem=remPx(),lists=$('lists'),H=lists.clientHeight;remC=rem;
  var cap=mobile?1e9:Math.max(1,Math.floor(H/(4.6*rem))),n=top.length;
  flow.on=false;
  if(mobile){fillStatic(trkA,top,1);trkB.textContent='';colB.hidden=true;return;}
  colB.hidden=false;
  var rowPx=H/cap;
  lists.style.setProperty('--rowh',(rowPx/rem).toFixed(3)+'rem');
  if(n<=cap*2||reduced){
    // few jastiper yet: real rows first, the remaining slots as numbered placeholders
    [trkA,trkB].forEach(function(t,c){
      t.textContent='';t.style.transform='';
      for(var i=c*cap;i<(c+1)*cap;i++) t.appendChild(i<n?rowEl(top[i],i+1):ghostRow(i+1));
    });
    return;
  }
  var GAP=2,pass,i;
  [trkA,trkB].forEach(function(t){
    t.textContent='';
    for(pass=0;pass<2;pass++){
      for(i=0;i<n;i++) t.appendChild(rowEl(top[i],i+1));
      for(i=0;i<GAP;i++) t.appendChild(el('div','row spacer'));
    }
  });
  flow.L=(n+GAP)*rowPx;flow.H=H;flow.on=true;
  if(flow.o>=flow.L){flow.o=0;flow.hold=DWELL;}
}
/* gerak halus: kecepatan naik-turun pelan (ease) saat mulai dan saat berhenti di peringkat 1,
   posisi sub-piksel di layer GPU supaya tidak patah-patah */
function tick(t){
  var dt=lastT?Math.min(.05,(t-lastT)/1000):0;lastT=t;
  if(flow.on&&dt>0){
    var vmax=SPEED*remC,acc=vmax/RAMP;
    if(flow.hold>0){flow.hold-=dt;vel=0;}
    else{
      var left=flow.L-flow.o;
      var brake=Math.sqrt(2*acc*Math.max(0,left));
      vel=Math.min(vmax,vel+acc*dt,brake);
      if(vel<1e-3&&left<.5){flow.o=0;flow.hold=DWELL;vel=0;}
      else{flow.o+=vel*dt;if(flow.o>=flow.L-.25){flow.o=0;flow.hold=DWELL;vel=0;}}
    }
    var oa=flow.o%flow.L,ob=(flow.o+flow.H)%flow.L;
    trkA.style.transform='translate3d(0,'+(-oa).toFixed(2)+'px,0)';
    trkB.style.transform='translate3d(0,'+(-ob).toFixed(2)+'px,0)';
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
var rzT=0;
window.addEventListener('resize',function(){clearTimeout(rzT);rzT=setTimeout(function(){
  try{mobile=window.matchMedia('(max-width:900px)').matches;}catch(e){}
  if(current){lastSig='';render(current);}
},200);});

function render(s){
  current=s;
  var top=s.top||[];
  var lead=top[0];
  $('champ-v').textContent=lead?money(lead.v):'Rp 0';
  $('champ-p').textContent=lead?(lead.p+(lead.n?' · '+lead.n:'')):'Menunggu transaksi pertama';
  $('board-sub').textContent='Belanja terbesar per nomor HP · '+nf.format(top.length)+' jastiper';

  // rebuild the columns only when the ranking changed, so a poll does not restart the scroll
  var sig=top.length+'|'+top.map(function(r){return r.p+':'+r.v+':'+r.t;}).join(',');
  if(sig!==lastSig){
    lastSig=sig;
    $('wait').hidden=top.length>0;
    if(!top.length) layoutEmpty();
    else layout(top);
  }

  var isSample=!!s.sample;
  $('chip-live').hidden=isSample;
  if(!isSample&&s.updatedAt) $('live-text').textContent='Live · update '+clock(s.updatedAt);
  note.textContent='Data contoh';note.hidden=!isSample;act.hidden=true;
}
function showNote(text,actionLabel,fn){
  note.textContent=text;note.hidden=false;
  if(actionLabel){act.textContent=actionLabel;act.hidden=false;act.onclick=fn;}else{act.hidden=true;act.onclick=null;}
}

/* ---------- storage: last good state, per browser ---------- */
function loadLocal(){try{var r=localStorage.getItem(LS_KEY);return r?JSON.parse(r):null;}catch(e){return null;}}
function saveLocal(s){try{var c={};for(var k in s)c[k]=s[k];c.top=(s.top||[]).slice(0,STORE_LS);localStorage.setItem(LS_KEY,JSON.stringify(c));}catch(e){}}

/* ---------- status + diagnostics ---------- */
function stamp(iso){
  try{
    var f=new Intl.DateTimeFormat('id-ID',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false,timeZone:'Asia/Jakarta'}).format(new Date(iso)).replace(/\./g,':');
    $('lastup-t').textContent=f+' WIB';
  }catch(e){}
}
function label(name){return SOURCE_LABEL[name]||(name.indexOf('sheet:')===0?'Sheet '+name.slice(6):name);}
function showDiag(snap){
  if(location.hash!=='#cek'){diagChip.hidden=true;return;}
  var src=snap.sources||{},bits=Object.keys(src).map(function(k){
    var s=src[k];
    if(!s.ok&&!s.stale) return label(k)+': '+(s.error||'gagal');
    var t=label(k)+' '+nf.format(s.valid)+' valid · '+s.skipped+' dilewati';
    if(s.skippedLines&&s.skippedLines.length) t+=' (baris '+s.skippedLines.join(', ')+(s.skipped>s.skippedLines.length?', ...':'')+')';
    if(s.info&&s.info.scanning) t+=' · memindai order';
    if(s.info&&s.info.pending) t+=' · '+s.info.pending+' menunggu kontak';
    if(s.info&&s.info.noPhone) t+=' · '+s.info.noPhone+' tanpa HP';
    if(s.info&&s.info.brands!=null) t+=' · '+s.info.brands+' brand';
    if(s.info&&s.info.failed&&s.info.failed.length) t+=' · gagal: '+s.info.failed.map(function(f){return f.brand+' ('+f.error+')';}).join(', ');
    return t+(s.stale?' · lama':'');
  });
  if(snap.state) bits.push('nomor unik '+nf.format(snap.state.totals.buyers));
  diagChip.textContent=bits.join(' | ');diagChip.hidden=false;
}

/* ---------- polling ---------- */
/* Source problems (a brand Sheet missing, the database down) are not shown to the
   audience: the board keeps the last data it has. The team sees them on #cek and /healthz. */
var failed=0,pollMs=30000;
function onSnapshot(snap){
  failed=0;
  if(snap.pollMs) pollMs=Math.max(5000,snap.pollMs);
  var st=snap.state;
  if(!st){
    if(!live){show();showNote('Menunggu data pertama dari server...');}
  }else{
    // an empty ranking is stored too, so cleared test data does not come back from this browser's cache
    live=st;saveLocal(st);show();
    stamp(st.updatedAt);
  }
  showDiag(snap);
}
function onFail(){
  failed++;
  if($('lastup-t').textContent.indexOf('menunggu')===0) $('lastup-t').textContent='belum tersambung ke server';
  if(failed>=3) showNote('Koneksi ke server terputus. Menampilkan data terakhir.');
}
function poll(){
  fetch(API,{cache:'no-store'}).then(function(r){
    if(!r.ok) throw new Error('HTTP '+r.status);
    return r.json();
  }).then(onSnapshot).catch(function(e){console.error(e);onFail();}).then(function(){setTimeout(poll,pollMs);});
}
function boot(){
  live=loadLocal();
  show();
  if(live){showNote('Memuat data terbaru...');if(live.updatedAt) stamp(live.updatedAt);}
  poll();
}
window.addEventListener('hashchange',function(){if(location.hash!=='#cek') diagChip.hidden=true;lastSig='';show();});
boot();
})();
