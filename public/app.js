(function(){
'use strict';

/* ---------- config ---------- */
/* Data dibaca server dari Postgres + Google Sheet, lalu digabung per nomor HP.
   Halaman ini cukup polling /api/state. Tambahkan #cek di URL untuk diagnostik. */
var API='api/state';
var TIERS=[
  {at:100e6,prize:'Apple Watch Series 10',short:'Apple Watch'},
  {at:200e6,prize:'LG 400L Multi Door Inverter',short:'LG 400L'},
  {at:300e6,prize:'iPhone 16',short:'iPhone 16'},
  {at:400e6,prize:'Yamaha Aerox / Grand Filano',short:'Motor Yamaha'}
];
var TOP_N=20, TILE_VALUE=10e6, TILES=40;
var TICK_SEC_PER_ROW=2.4; // scroll speed of the board: seconds per row
var SOURCE_LABEL={postgres:'Postgres',sheet:'Sheet',jubelio:'Jubelio'};
var LS_KEY='imperfect-live-state-v3';
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

/* ---------- example data (labelled on screen) ---------- */
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
  return {sample:true,updatedAt:null,top:top.slice(0,30)};
}

/* ---------- static DOM: tiles and cards ---------- */
var tiles=[],cardEls=[];
(function build(){
  var bar=$('bar'),cards=$('cards');
  TIERS.forEach(function(tier){
    var seg=el('div','seg');
    for(var i=0;i<TILES/TIERS.length;i++){var tl=el('i','tile');seg.appendChild(tl);tiles.push(tl);}
    bar.appendChild(seg);
    var c=el('div','card locked');
    c.appendChild(el('div','at',(tier.at/1e6)+' mio'));
    c.appendChild(el('div','prize',tier.prize));
    var st=el('div','state','Terkunci');c.appendChild(st);
    cards.appendChild(c);cardEls.push({root:c,state:st});
  });
})();

/* ---------- render ---------- */
var shown=0,raf=0,current=null;
var note=$('chip-sample'),act=$('chip-action'),diagChip=$('chip-diag');
function paintHero(v){var p=parts(v);$('hero-num').textContent=p.n;$('hero-unit').textContent=p.u==='k'?'rb':p.u;$('hero-unit').hidden=!p.u;}
function animateTo(target){
  cancelAnimationFrame(raf);
  var from=shown,t0=performance.now(),dur=reduced?0:1100;
  function step(t){
    var k=dur?Math.min(1,(t-t0)/dur):1,e=1-Math.pow(1-k,3);
    shown=from+(target-from)*e;paintHero(shown);
    if(k<1) raf=requestAnimationFrame(step);
  }
  raf=requestAnimationFrame(step);
}
function tierIdx(v){var u=-1;TIERS.forEach(function(x,i){if(v>=x.at)u=i;});return u;}
function render(s){
  current=s;
  var top=s.top||[];
  var lead=top[0],leadV=lead?lead.v:0;

  animateTo(leadV);

  tiles.forEach(function(tl,k){
    var f=Math.max(0,Math.min(1,leadV/TILE_VALUE-k));
    tl.style.setProperty('--f',(f*100).toFixed(1)+'%');
  });

  var nextIdx=-1;
  TIERS.forEach(function(tier,i){
    var c=cardEls[i];
    var n=top.filter(function(r){return tierIdx(r.v)===i;}).length,open=n>0,reached=leadV>=tier.at;
    if(!reached&&nextIdx<0) nextIdx=i;
    c.root.className='card '+(open?'open':(i===nextIdx?'next':'locked'));
    c.state.textContent=open?(n+' jastiper dapat ini'):(reached?'Belum ada jastiper':i===nextIdx?'Tinggal '+money(tier.at-leadV):'Terkunci');
  });

  var tt=$('target-text');tt.textContent='';
  if(!lead){
    tt.appendChild(document.createTextNode('Belanja '));
    tt.appendChild(el('b',null,money(TIERS[0].at)));
    tt.appendChild(document.createTextNode(' dalam satu nomor HP untuk dapat '));
    tt.appendChild(el('b',null,TIERS[0].prize));
    tt.appendChild(document.createTextNode('.'));
  }else if(nextIdx<0){
    tt.appendChild(el('b',null,'Level tertinggi sudah tercapai.'));
    tt.appendChild(document.createTextNode(' Tiap jastiper dapat 1 hadiah sesuai levelnya.'));
  }else{
    tt.appendChild(el('b',null,lead.p));
    tt.appendChild(document.createTextNode(' tinggal '));
    tt.appendChild(el('b',null,money(TIERS[nextIdx].at-leadV)));
    tt.appendChild(document.createTextNode(' lagi untuk '));
    tt.appendChild(el('b',null,TIERS[nextIdx].prize));
    tt.appendChild(document.createTextNode('.'));
  }

  var head=$('rows-top'),rows=$('rows');head.textContent='';rows.textContent='';
  var show=top.slice(0,TOP_N);
  if(!show.length){
    head.appendChild(el('li','empty','Belum ada transaksi. Jadi yang pertama masuk papan ini.'));
  }
  show.forEach(function(r,i){
    var u=tierIdx(r.v),floor=u>=0?TIERS[u].at:0,nxt=TIERS[u+1];
    var pct=nxt?Math.max(0,Math.min(100,(r.v-floor)/(nxt.at-floor)*100)):100;
    var li=el('li','row'+(i===0?' first':'')+(u>=0?' got':''));
    li.style.setProperty('--p',pct.toFixed(1)+'%');
    li.appendChild(el('span','rk',String(i+1)));
    var who=el('span','who');
    who.appendChild(el('span','ph',r.p));
    who.appendChild(el('span','nm',r.n||'Pelanggan'));
    li.appendChild(who);
    var val=el('span','val');
    val.appendChild(el('b',null,money(r.v)));
    val.appendChild(el('small',null,u>=0?'Dapat '+TIERS[u].short:Math.floor(pct)+'% ke '+TIERS[0].short));
    li.appendChild(val);
    (i===0?head:rows).appendChild(li);
  });
  layoutTicker();

  var isSample=!!s.sample;
  $('chip-live').hidden=isSample;
  if(!isSample&&s.updatedAt) $('live-text').textContent='Live · update '+clock(s.updatedAt);
  note.textContent='Data contoh';note.hidden=!isSample;act.hidden=true;
}
/* ---------- board ticker: #2-#20 scroll upward in a loop ---------- */
/* Driven by requestAnimationFrame with the offset kept across renders, so a
   data refresh every poll does not make the list jump back to the top. */
var tick={off:0,half:0,last:0,raf:0};
function layoutTicker(){
  var box=$('ticker'),list=$('rows'),loop=$('rows-loop');
  loop.textContent='';loop.hidden=true;
  var over=!reduced&&list.children.length>0&&list.offsetHeight>box.clientHeight+1;
  box.classList.toggle('still',!over);
  if(!over){cancelAnimationFrame(tick.raf);tick.raf=0;tick.off=0;$('track').style.transform='';return;}
  // second copy right under the first, so the end flows straight back into #2
  loop.innerHTML=list.innerHTML;loop.hidden=false;
  tick.half=list.offsetHeight;
  tick.off%=tick.half;
  if(!tick.raf){tick.last=0;tick.raf=requestAnimationFrame(step);}
}
function step(t){
  var list=$('rows'),row=list.firstElementChild;
  if(tick.last&&row){
    var dt=Math.min(100,t-tick.last); // a hidden tab resumes where it was
    tick.off=(tick.off+dt/1000*row.offsetHeight/TICK_SEC_PER_ROW)%tick.half;
    $('track').style.transform='translateY('+(-tick.off).toFixed(2)+'px)';
  }
  tick.last=t;tick.raf=requestAnimationFrame(step);
}
var resizeT=0;
window.addEventListener('resize',function(){clearTimeout(resizeT);resizeT=setTimeout(layoutTicker,150);});

function showNote(text,actionLabel,fn){
  note.textContent=text;note.hidden=false;
  if(actionLabel){act.textContent=actionLabel;act.hidden=false;act.onclick=fn;}else{act.hidden=true;act.onclick=null;}
}

/* ---------- storage: last good state, per browser ---------- */
function loadLocal(){try{var r=localStorage.getItem(LS_KEY);return r?JSON.parse(r):null;}catch(e){return null;}}
function saveLocal(s){try{localStorage.setItem(LS_KEY,JSON.stringify(s));}catch(e){}}

/* ---------- status + diagnostics ---------- */
function stamp(iso){
  try{
    var f=new Intl.DateTimeFormat('id-ID',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false,timeZone:'Asia/Jakarta'}).format(new Date(iso)).replace(/\./g,':');
    $('lastup-t').textContent=f+' WIB';
  }catch(e){}
}
function label(name){return SOURCE_LABEL[name]||name;}
function sourceNote(sources){
  var bad=Object.keys(sources||{}).filter(function(k){return !sources[k].ok;});
  if(!bad.length) return '';
  return bad.map(label).join(' & ')+' gagal dibaca. Menampilkan data terakhir.';
}
function showDiag(snap){
  if(location.hash!=='#cek'){diagChip.hidden=true;return;}
  var src=snap.sources||{},bits=Object.keys(src).map(function(k){
    var s=src[k];
    if(!s.ok&&!s.stale) return label(k)+': '+(s.error||'gagal');
    var t=label(k)+' '+nf.format(s.valid)+' valid · '+s.skipped+' dilewati';
    if(s.skippedLines&&s.skippedLines.length) t+=' (baris '+s.skippedLines.join(', ')+(s.skipped>s.skippedLines.length?', ...':'')+')';
    return t+(s.stale?' · lama':'');
  });
  if(snap.state) bits.push('nomor unik '+nf.format(snap.state.totals.buyers));
  diagChip.textContent=bits.join(' | ');diagChip.hidden=false;
}

/* ---------- polling ---------- */
var failed=0,pollMs=30000;
function onSnapshot(snap){
  failed=0;
  if(snap.pollMs) pollMs=Math.max(5000,snap.pollMs);
  var st=snap.state,warn=sourceNote(snap.sources);
  if(!st){
    if(!current||current.sample) render(sampleState());
    showNote(warn||'Menunggu data pertama dari server...');
  }else if(!st.top.length){
    render(sampleState());
    showNote('Belum ada transaksi. Menampilkan data contoh.');
    stamp(st.updatedAt);
  }else{
    saveLocal(st);
    render(st);
    stamp(st.updatedAt);
    if(warn) showNote(warn);
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
  var local=loadLocal();
  render(local||sampleState());
  if(local){showNote('Memuat data terbaru...');if(local.updatedAt) stamp(local.updatedAt);}
  poll();
}
window.addEventListener('hashchange',function(){if(location.hash!=='#cek') diagChip.hidden=true;});
boot();
})();
