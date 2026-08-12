// Memory inspector: read-only per-user view of the three memory tiers
// (short 24h / medium ledger / long doc + revisions) plus Reflexion state.
// Desktop: user rail + content pane; phones: a native select above the tabs.

export const MEMORY_CSS = `
#view-memory{padding:0;display:flex;flex-direction:row;min-height:0}
#mem-rail{width:240px;flex:none;border-right:1px solid var(--line);background:var(--panel);overflow-y:auto}
#mem-rail .chat .name{max-width:150px}
#mem-body{flex:1;min-width:0;overflow-y:auto;padding:1rem}
#mem-pick{display:none;width:100%;margin-bottom:.8rem}
#mem-tabs{display:flex;gap:.3rem;margin:.6rem 0 .9rem;overflow-x:auto;scrollbar-width:none}
#mem-tabs button{white-space:nowrap}
#mem-tabs button.sel{border-color:var(--acc);color:var(--acc)}
.memhead{display:flex;align-items:baseline;gap:.7rem;flex-wrap:wrap}
.memhead h2{margin:0}
.mementry{border:1px solid var(--line);border-radius:10px;margin:.5rem 0;overflow:hidden}
.mementry .mh{display:flex;gap:.5rem;align-items:baseline;padding:.45rem .7rem;background:var(--card);font-size:.76rem;color:var(--mut);flex-wrap:wrap}
.mementry .mh b{color:var(--fg)}
.mementry .mb{padding:.5rem .7rem;font-size:.8rem;white-space:pre-wrap;word-break:break-word}
.mementry.superseded,.mementry.retracted{opacity:.55}
.statustag{font-size:.66rem;padding:.03rem .4rem;border-radius:6px;border:1px solid var(--line)}
.statustag.active{color:var(--ok);border-color:var(--ok)}
.statustag.retracted{color:var(--err);border-color:var(--err)}
@media (max-width:699px){
  #mem-rail{display:none}
  #mem-pick{display:block}
}
`;

export const MEMORY_HTML = `
<div id="mem-rail"><div id="mem-raillist"><div class="empty">loading…</div></div></div>
<div id="mem-body">
  <select id="mem-pick"></select>
  <div id="mem-content"><div class="empty">pick a user to inspect their memory</div></div>
</div>
`;

export const MEMORY_JS = `
(function(){
  var M = window.MD;
  var S = {handle:null, tier:'short', users:[], data:null};
  var TIERS = [
    {id:'short', label:'Short (24h)'},
    {id:'medium', label:'Medium ledger'},
    {id:'long', label:'Long-term doc'},
    {id:'reflexion', label:'Reflexion'}
  ];

  function renderRail(){
    var fp = String(S.handle)+'|'+S.users.map(function(u){return u.handle;}).join(',');
    M.renderIf('mem:rail', fp, function(){
      var html = S.users.map(function(u){
        return '<div class="chat'+(u.handle===S.handle?' sel':'')+'" data-handle="'+M.esc(u.handle)+'">'
          + '<div class="row1"><span class="name">'+M.esc(u.name||u.handle)+'</span></div>'
          + '<div class="trig">'+M.esc(u.handle)+'</div></div>';
      }).join('');
      document.getElementById('mem-raillist').innerHTML = html || '<div class="empty">no users</div>';
      var pick = document.getElementById('mem-pick');
      pick.innerHTML = '<option value="">pick a user\\u2026</option>' + S.users.map(function(u){
        return '<option value="'+M.esc(u.handle)+'"'+(u.handle===S.handle?' selected':'')+'>'+M.esc(u.name||u.handle)+' ('+M.esc(u.handle)+')</option>';
      }).join('');
    });
  }
  function entryHtml(head, body, cls){
    return '<div class="mementry'+(cls?' '+cls:'')+'"><div class="mh">'+head+'</div>'
      + (body!=null?('<div class="mb">'+M.esc(body)+'</div>'):'')+'</div>';
  }
  function renderTier(){
    var el = document.getElementById('mem-content');
    if (!S.handle){ el.innerHTML = '<div class="empty">pick a user to inspect their memory</div>'; return; }
    if (!S.data){ el.innerHTML = '<div class="empty">loading\\u2026</div>'; return; }
    var d = S.data;
    var head = '<div class="memhead"><h2 class="vh">'+M.esc((d.profile&&d.profile.name)||S.handle)+'</h2>'
      + '<span class="pill">'+M.esc(S.handle)+'</span>'
      + (d.prefs&&d.prefs.gmail_address?('<span class="pill">'+M.esc(d.prefs.gmail_address)+'</span>'):'')
      + (d.prefs&&d.prefs.timezone?('<span class="pill">'+M.esc(d.prefs.timezone)+'</span>'):'')
      + '<a href="'+M.buildHash('history',[],{handle:S.handle})+'" class="pill">turn history \\u2192</a>'
      + '</div>';
    var tabs = '<div id="mem-tabs">'+TIERS.map(function(t){
      return '<button data-tier="'+t.id+'" class="'+(t.id===S.tier?'sel':'')+'">'+t.label+'</button>';
    }).join('')+'</div>';

    var body = '';
    if (S.tier==='short'){
      var items = d.short||[];
      body = items.length ? items.map(function(e){
        var ttl = e.expiresAt - M.now();
        return entryHtml(
          '<span class="chip" style="color:var(--acc);border-color:var(--acc)">'+M.esc(e.kind)+'</span>'
          + (e.request?('<b>'+M.esc(String(e.request).slice(0,90))+'</b>'):'')
          + '<span style="margin-left:auto">'+M.esc(M.ago(e.createdAt))+' ago \\u00B7 expires in '+M.esc(ttl>0?M.fmtDur(ttl/1000):'0s')+'</span>',
          e.content);
      }).join('') : '<div class="empty">nothing in the 24h tier</div>';
    } else if (S.tier==='medium'){
      var meds = d.medium||[];
      body = meds.length ? meds.map(function(e){
        return entryHtml(
          '<span class="chip" style="color:var(--warn);border-color:var(--warn)">'+M.esc(e.kind)+'</span>'
          + (e.key?('<b>'+M.esc(e.key)+'</b>'):'')
          + '<span class="statustag '+M.esc(e.status)+'">'+M.esc(e.status)+'</span>'
          + '<span>src: '+M.esc(e.source)+'</span>'
          + '<span style="margin-left:auto">'+M.esc(M.fmtDateTime(e.updatedAt))+'</span>',
          e.body, e.status!=='active'?e.status:'');
      }).join('') : '<div class="empty">no medium-tier entries</div>';
    } else if (S.tier==='long'){
      var doc = d.long && d.long.doc;
      body = doc
        ? '<div class="kv"><span>version <b>'+doc.version+'</b></span></div><div class="prewrap">'+M.esc(doc.docMd||'(empty)')+'</div>'
        : '<div class="empty">no long-term doc yet</div>';
      var revs = (d.long&&d.long.revisions)||[];
      if (revs.length){
        body += '<h3 class="sh">Revisions</h3>' + revs.map(function(r){
          return '<details class="sec"><summary>v'+r.version+' \\u00B7 '+M.esc(r.writtenBy)+' \\u00B7 '+M.esc(M.fmtDateTime(r.createdAt))
            + '<span class="cnt">'+(r.docMd||'').length+' ch</span></summary><pre>'+M.esc(r.docMd||'')+'</pre></details>';
        }).join('');
      }
      if (d.dossierMd){
        body += '<h3 class="sh">Legacy dossier</h3><div class="prewrap">'+M.esc(d.dossierMd)+'</div>';
      }
    } else if (S.tier==='reflexion'){
      var r = d.reflexion;
      body = r
        ? '<div class="kv">'
          + '<span>last daily <b>'+(r.lastDailyAt?M.esc(M.fmtDateTime(r.lastDailyAt)):'never')+'</b></span>'
          + '<span>last run <b>'+(r.lastRunAt?M.esc(M.fmtDateTime(r.lastRunAt)):'never')+'</b></span>'
          + '<span>migrated <b>'+(r.migratedAt?M.esc(M.fmtDateTime(r.migratedAt)):'not yet')+'</b></span>'
          + '</div>'
          + '<h3 class="sh">Self-prompt</h3><div class="prewrap">'+M.esc(r.selfPromptMd||'(empty)')+'</div>'
          + ((r.selfPromptRevs||[]).length
            ? '<h3 class="sh">Self-prompt revisions</h3>'+r.selfPromptRevs.map(function(rev){
                return '<details class="sec"><summary>'+M.esc(M.fmtDateTime(rev.at))+' \\u00B7 '+M.esc(rev.note||'')
                  + '<span class="cnt">'+(rev.md||'').length+' ch</span></summary><pre>'+M.esc(rev.md||'')+'</pre></details>';
              }).join('')
            : '')
        : '<div class="empty">no reflexion state for this user</div>';
    }
    el.innerHTML = head + tabs + body;
    Array.prototype.forEach.call(el.querySelectorAll('#mem-tabs button'), function(b){
      b.onclick = function(){ M.nav('memory', [S.handle], {tier: b.getAttribute('data-tier')}); };
    });
  }
  function loadUsers(){
    M.api.latest('mem:users', '/dashboard/api/users').then(function(j){
      S.users = j.users||[];
      renderRail();
    }).catch(function(err){ if (!M.api.isStale(err)) M.toast('failed to load users', 'err'); });
  }
  function loadMemory(){
    if (!S.handle) return;
    var h = S.handle;
    S.data = null;
    renderTier();
    M.api.latest('mem:data', '/dashboard/api/memory?handle='+encodeURIComponent(h)).then(function(j){
      if (h !== S.handle) return;
      S.data = j;
      renderTier();
    }).catch(function(err){
      if (M.api.isStale(err) || h !== S.handle) return;
      document.getElementById('mem-content').innerHTML =
        '<div class="errpanel">couldn\\u2019t load memory for '+M.esc(h)+'<br><button onclick="MD.views.memory.refresh()">retry</button></div>';
    });
  }
  var wired = false;
  function wire(){
    document.getElementById('mem-raillist').addEventListener('click', function(e){
      var el = e.target.closest ? e.target.closest('.chat') : null;
      if (el) M.nav('memory', [el.getAttribute('data-handle')], {tier: S.tier});
    });
    document.getElementById('mem-pick').onchange = function(){
      if (this.value) M.nav('memory', [this.value], {tier: S.tier});
    };
  }
  M.views.memory = {
    enter: function(params, query){
      if (!wired){ wired = true; wire(); }
      var prevHandle = S.handle;
      S.handle = params[0] || null;
      S.tier = query.tier && ['short','medium','long','reflexion'].indexOf(query.tier)>=0 ? query.tier : 'short';
      M.ui.setPill(S.handle ? ('memory \\u00B7 '+S.handle) : 'memory', null);
      loadUsers();
      if (S.handle && S.handle !== prevHandle) loadMemory();
      else renderTier();
    },
    leave: function(){ M.api.bump('mem:users'); M.api.bump('mem:data'); },
    refresh: function(){ loadUsers(); loadMemory(); }
  };
})();
`;
