// Client core: the window.MD namespace — hash router, seq-guarded fetch, toast
// stack, fingerprinted rendering, poll scheduler, clipboard fallback, and the
// tiny SVG chart builders. Loaded before every view module.
//
// NOTE: client JS deliberately uses no template literals (no backticks / \${})
// so it nests safely inside this TS template string — enforced by views.test.ts.

export const CORE_JS = `
'use strict';
window.MD = (function(){
  var state = {
    live: true,
    route: {view:'', params:[], query:{}},
    net: {failures:0},
    skewMs: 0
  };
  var views = {};
  var curView = null;

  // ---------- formatting ----------
  function esc(s){ return (s==null?'':String(s)).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function now(){ return Date.now() + state.skewMs; }
  function ago(ts){ var d=now()-ts; if(d<0)d=0; if(d<60e3)return Math.max(1,Math.round(d/1e3))+'s'; if(d<3600e3)return Math.round(d/60e3)+'m'; if(d<86400e3)return Math.round(d/3600e3)+'h'; return Math.round(d/86400e3)+'d'; }
  function fmtTime(ts){ return new Date(ts).toLocaleTimeString(); }
  function fmtDateTime(ts){ return new Date(ts).toLocaleString(); }
  function fmtNum(n){ n=Number(n)||0; if(n>=1e9)return (n/1e9).toFixed(1)+'B'; if(n>=1e6)return (n/1e6).toFixed(1)+'M'; if(n>=1e3)return (n/1e3).toFixed(1)+'k'; return String(n); }
  function fmtMs(n){ if(n==null)return '—'; n=Number(n); if(n>=1000)return (n/1000).toFixed(1)+'s'; return Math.round(n)+'ms'; }
  function fmtDur(s){ s=Math.max(0,Math.floor(s)); var d=Math.floor(s/86400), h=Math.floor(s%86400/3600), m=Math.floor(s%3600/60); if(d)return d+'d '+h+'h'; if(h)return h+'h '+m+'m'; if(m)return m+'m '+(s%60)+'s'; return s+'s'; }
  function pct(x){ return (100*(Number(x)||0)).toFixed(1)+'%'; }
  function srcIcon(s){ return s==='email'?'\\uD83D\\uDCE7':s==='automation'?'\\u23F0':s==='system'?'\\u2699\\uFE0F':'\\uD83D\\uDCAC'; }

  // ---------- toasts ----------
  function toast(msg, kind, retry){
    var root = document.getElementById('toasts');
    if(!root) return;
    var el = document.createElement('div');
    el.className = 'toast'+(kind==='err'?' err':'');
    el.appendChild(document.createTextNode(msg));
    var closer = function(){ if(el.parentNode) el.parentNode.removeChild(el); };
    if(retry){
      var b = document.createElement('button');
      b.textContent = 'retry';
      b.onclick = function(){ closer(); retry(); };
      el.appendChild(b);
    }
    var x = document.createElement('button');
    x.textContent = '\\u2715';
    x.onclick = closer;
    el.appendChild(x);
    root.appendChild(el);
    if(kind!=='err') setTimeout(closer, 4000);
    while(root.children.length>4) root.removeChild(root.firstChild);
  }

  // ---------- network ----------
  var slots = {};
  function apiGet(url){
    return fetch(url).then(function(r){
      if(r.status===401){ location.reload(); throw {handled:true}; }
      if(!r.ok) throw {status:r.status, message:'http '+r.status};
      return r.json();
    });
  }
  // Per-slot monotonic guard: a slow response for a superseded request is dropped
  // (rejects with {stale:true}; callers treat stale as a silent no-op).
  function latest(slot, url){
    var my = (slots[slot] = (slots[slot]||0) + 1);
    return apiGet(url).then(function(j){
      if(my !== slots[slot]) throw {stale:true};
      return j;
    });
  }
  function bumpSlot(slot){ slots[slot] = (slots[slot]||0) + 1; }
  function isStale(err){ return !!(err && (err.stale || err.handled)); }
  function pollOk(j){
    state.net.failures = 0;
    if(j && typeof j.now === 'number') state.skewMs = j.now - Date.now();
    updateNetPill();
  }
  function pollFail(){ state.net.failures++; updateNetPill(); }
  function updateNetPill(){
    var el = document.getElementById('netpill');
    if(!el) return;
    if(state.net.failures>=2){ el.hidden=false; el.textContent='offline \\u2014 retrying'; }
    else el.hidden = true;
  }

  // ---------- fingerprinted rendering ----------
  var fps = {};
  function renderIf(key, fp, fn){
    if(fps[key] === fp) return false;
    fps[key] = fp;
    fn();
    return true;
  }
  function resetFp(prefix){
    Object.keys(fps).forEach(function(k){ if(k.indexOf(prefix)===0) delete fps[k]; });
  }

  // ---------- clipboard ----------
  function copyText(txt, btn){
    function ok(){ if(btn){ var t=btn.textContent; btn.textContent='copied'; setTimeout(function(){btn.textContent=t;},1200); } }
    function fallback(){
      try{
        var ta = document.createElement('textarea');
        ta.value = txt; ta.style.position='fixed'; ta.style.opacity='0';
        document.body.appendChild(ta); ta.select();
        var done = document.execCommand('copy');
        document.body.removeChild(ta);
        if(done) ok(); else toast('copy failed', 'err');
      }catch(e){ toast('copy failed', 'err'); }
    }
    if(navigator.clipboard && window.isSecureContext){
      navigator.clipboard.writeText(txt).then(ok, fallback);
    } else fallback();
  }

  // ---------- router ----------
  function parseHash(){
    var h = location.hash || '';
    h = h.charAt(0)==='#' ? h.slice(1) : h;
    if(h.charAt(0)==='/') h = h.slice(1);
    var query = {};
    var qi = h.indexOf('?');
    if(qi >= 0){
      h.slice(qi+1).split('&').forEach(function(kv){
        if(!kv) return;
        var i = kv.indexOf('=');
        var k = i<0?kv:kv.slice(0,i), v = i<0?'':kv.slice(i+1);
        try{ query[decodeURIComponent(k)] = decodeURIComponent(v); }catch(e){}
      });
      h = h.slice(0, qi);
    }
    var segs = h.split('/').filter(function(s){return !!s;}).map(function(s){ try{ return decodeURIComponent(s); }catch(e){ return s; } });
    return { view: segs[0] || 'overview', params: segs.slice(1), query: query };
  }
  function buildHash(view, params, query){
    var h = '#/' + view;
    (params||[]).forEach(function(p){ if(p!=null && p!=='') h += '/' + encodeURIComponent(p); });
    var qs = [];
    Object.keys(query||{}).forEach(function(k){
      var v = query[k];
      if(v==null || v==='') return;
      qs.push(encodeURIComponent(k)+'='+encodeURIComponent(v));
    });
    if(qs.length) h += '?' + qs.join('&');
    return h;
  }
  function nav(view, params, query){
    var h = buildHash(view, params, query);
    if(location.hash === h){ applyRoute(); } else location.hash = h;
  }
  function applyRoute(){
    var r = parseHash();
    if(!views[r.view]){ r = {view:'overview', params:[], query:{}}; }
    var prev = curView;
    state.route = r;
    if(prev && prev !== r.view && views[prev] && views[prev].leave){ try{ views[prev].leave(); }catch(e){} }
    var secs = document.querySelectorAll('.view');
    Array.prototype.forEach.call(secs, function(s){ s.hidden = (s.id !== 'view-'+r.view); });
    var tabs = document.querySelectorAll('#tabs a');
    Array.prototype.forEach.call(tabs, function(a){
      var v = a.getAttribute('data-view');
      if(v===r.view) a.className='sel'; else a.className='';
    });
    curView = r.view;
    closeDrawers();
    var v = views[r.view];
    if(v && v.enter){ try{ v.enter(r.params, r.query); }catch(e){ toast('view failed to load', 'err'); } }
  }

  // ---------- drawers / sheets ----------
  function backdrop(){ return document.getElementById('backdrop'); }
  function openDrawer(el){
    el.classList.add('open');
    var b = backdrop(); if(b) b.classList.add('open');
  }
  function closeDrawers(){
    Array.prototype.forEach.call(document.querySelectorAll('.drawerable.open'), function(el){ el.classList.remove('open'); });
    var b = backdrop(); if(b) b.classList.remove('open');
  }
  function cycleSheet(el){
    if(el.classList.contains('collapsed')){ el.classList.remove('collapsed'); el.classList.add('half'); }
    else if(el.classList.contains('half')){ el.classList.remove('half'); el.classList.add('full'); }
    else { el.classList.remove('full'); el.classList.add('collapsed'); }
  }
  function setSheet(el, mode){
    el.classList.remove('collapsed','half','full');
    el.classList.add(mode);
  }
  function setNavButton(visible, onClick){
    var b = document.getElementById('navchats');
    if(!b) return;
    b.className = visible ? 'avail' : '';
    b.onclick = onClick || null;
  }

  // ---------- charts (inline SVG / div bars) ----------
  function barRows(items, max){
    var m = max || 0;
    items.forEach(function(it){ if(it.value>m) m=it.value; });
    if(!m) m = 1;
    var html = '';
    items.forEach(function(it){
      var w = Math.max(1, Math.round(100*it.value/m));
      html += '<div class="brow"><div class="blabel" title="'+esc(it.label)+'">'+esc(it.label)+'</div>'
        + '<div class="btrack"><div class="bfill" style="width:'+w+'%;background:'+(it.color||'var(--acc)')+'"></div></div>'
        + '<div class="bval">'+esc(it.display!=null?it.display:fmtNum(it.value))+'</div></div>';
    });
    return html || '<div class="empty">no data</div>';
  }
  function spark(values, w, h, color){
    w = w||600; h = h||60;
    if(!values.length) return '<div class="empty">no data</div>';
    var m = 1;
    values.forEach(function(v){ if(v>m)m=v; });
    var pts = [];
    var step = values.length>1 ? w/(values.length-1) : w;
    values.forEach(function(v,i){ pts.push((i*step).toFixed(1)+','+(h-2-(h-6)*(v/m)).toFixed(1)); });
    return '<svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none" style="width:100%;height:'+h+'px;display:block">'
      + '<polyline fill="none" stroke="'+(color||'var(--acc)')+'" stroke-width="2" points="'+pts.join(' ')+'"></polyline></svg>';
  }
  function timeBars(buckets, w, h, color){
    w = w||600; h = h||80;
    if(!buckets.length) return '<div class="empty">no data</div>';
    var m = 1;
    buckets.forEach(function(b){ if(b.value>m)m=b.value; });
    var bw = Math.max(1, w/buckets.length - 1.5);
    var html = '<svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none" style="width:100%;height:'+h+'px;display:block">';
    buckets.forEach(function(b,i){
      var bh = Math.max(1, (h-4)*(b.value/m));
      html += '<rect x="'+(i*(w/buckets.length)).toFixed(1)+'" y="'+(h-2-bh).toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+bh.toFixed(1)+'" fill="'+(b.color||color||'var(--acc)')+'" opacity=".85"><title>'+esc(b.title||'')+'</title></rect>';
    });
    return html + '</svg>';
  }

  // ---------- poll scheduler ----------
  setInterval(function(){
    if(!state.live || document.hidden) return;
    var v = views[curView];
    if(!v || !v.tick || !v.tickEvery) return;
    var backoff = state.net.failures>=2 ? Math.min(8, Math.pow(2, state.net.failures-1)) : 1;
    var eff = Math.min(30000, v.tickEvery*backoff);
    if(now() - (v._lastTick||0) >= eff){
      v._lastTick = now();
      try{ v.tick(); }catch(e){}
    }
  }, 1000);
  document.addEventListener('visibilitychange', function(){
    if(document.hidden) return;
    var v = views[curView];
    if(v && v.tick){ v._lastTick = now(); try{ v.tick(); }catch(e){} }
  });

  // ---------- header wiring + boot ----------
  function setPill(text, cls){
    var el = document.getElementById('statuspill');
    if(!el) return;
    el.textContent = text;
    el.className = 'pill'+(cls?' '+cls:'');
  }
  function boot(){
    document.getElementById('livebtn').onclick = function(){
      state.live = !state.live;
      this.className = state.live?'on':'';
      this.textContent = state.live?'\\u25CF live':'\\u25CB paused';
      if(state.live){ var v=views[curView]; if(v&&v.tick){ v._lastTick=now(); v.tick(); } }
    };
    document.getElementById('refreshbtn').onclick = function(){
      var v = views[curView];
      if(v){ if(v.refresh) v.refresh(); else if(v.tick){ v._lastTick=now(); v.tick(); } }
    };
    document.getElementById('logoutbtn').onclick = function(){
      fetch('/dashboard/logout',{method:'POST'}).then(
        function(){ location.reload(); },
        function(){ toast('logout failed \\u2014 network error', 'err'); }
      );
    };
    var b = backdrop();
    if(b) b.onclick = closeDrawers;
    window.addEventListener('hashchange', applyRoute);
    applyRoute();
  }

  return {
    state: state, views: views, boot: boot,
    esc: esc, ago: ago, now: now, fmtTime: fmtTime, fmtDateTime: fmtDateTime,
    fmtNum: fmtNum, fmtMs: fmtMs, fmtDur: fmtDur, pct: pct, srcIcon: srcIcon,
    toast: toast, api: {get: apiGet, latest: latest, bump: bumpSlot, isStale: isStale, pollOk: pollOk, pollFail: pollFail},
    renderIf: renderIf, resetFp: resetFp, copyText: copyText,
    nav: nav, buildHash: buildHash, parseHash: parseHash,
    ui: {openDrawer: openDrawer, closeDrawers: closeDrawers, cycleSheet: cycleSheet, setSheet: setSheet, setNavButton: setNavButton, setPill: setPill},
    charts: {barRows: barRows, spark: spark, timeBars: timeBars}
  };
})();
`;
