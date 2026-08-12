// Errors: the agent-wide error log (src/diagnostics/errorLog.ts → error_log) as a filterable
// list. Repeats are folded by fingerprint, so a row is one FAILURE with an occurrence count
// rather than one line per occurrence. Rows carrying a chat/handle deep-link into the
// orchestration view for the turn that broke.

// Taxonomy for the select options — kept in sync with migration 0014 / the reportError contract.
const SOURCES = [
  'convo', 'ops', 'judge', 'autonome', 'reflexion', 'mm', 'fallfirm', 'pipeline',
  'db', 'llm', 'webhook', 'linq', 'process', 'budget', 'diagnostics', 'memory',
];
const CATEGORIES = [
  'llm_error', 'truncation', 'timeout', 'tool_failure', 'send_failure', 'db_error',
  'process_crash', 'voicing_failure', 'surfacing_failure', 'classifier_failure',
  'transcription_failure', 'automation_failure', 'turn_failure', 'retry_exhausted',
  'llm_fallback', 'degraded', 'budget', 'floor_engaged', 'push_dropped', 'other',
];
const options = (values: string[], anyLabel: string): string =>
  `<option value="">${anyLabel}</option>` + values.map(v => `<option value="${v}">${v}</option>`).join('');

export const ERRORS_CSS = `
#err-filters{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:.8rem}
#err-summary{display:flex;gap:.4rem;align-items:center;flex-wrap:wrap;margin-bottom:.8rem;min-height:1.4rem}
#err-summary .toppill{cursor:pointer;max-width:min(420px,90vw);overflow:hidden;text-overflow:ellipsis}
#err-summary .toppill:hover{border-color:var(--acc);color:var(--fg)}
/* fatal outranks error: filled, not outlined, so a crash can't be mistaken for a warn */
#view-errors .pill.sev-fatal{background:var(--err);border-color:var(--err);color:#0b0d12;font-weight:700}
#view-errors td.msg{white-space:normal;min-width:240px;max-width:520px}
#view-errors td.cnt{text-align:right;font-variant-numeric:tabular-nums}
#view-errors .when{color:var(--mut);font-size:.7rem;margin-left:.3rem}
#view-errors tr.det>td{white-space:normal;background:#0e1119}
`;

export const ERRORS_HTML = `
<h2 class="vh">Errors</h2>
<div id="err-filters">
  <select id="err-sev">
    <option value="">any severity</option>
    <option value="warn">warn</option>
    <option value="error">error</option>
    <option value="fatal">fatal</option>
  </select>
  <select id="err-source">${options(SOURCES, 'any source')}</select>
  <select id="err-category">${options(CATEGORIES, 'any category')}</select>
  <select id="err-window">
    <option value="1h">last hour</option>
    <option value="24h" selected>last 24h</option>
    <option value="7d">last 7 days</option>
    <option value="30d">last 30 days</option>
  </select>
  <input type="text" id="err-q" placeholder="search message" style="width:200px">
  <span class="pill" id="err-note" hidden></span>
</div>
<div id="err-summary"></div>
<div class="tablewrap"><table class="t" id="err-table"><thead><tr>
<th>when</th><th>sev</th><th>source</th><th>category</th><th>message</th><th>who</th><th>count</th>
</tr></thead><tbody><tr><td colspan="7"><div class="empty">loading…</div></td></tr></tbody></table></div>
`;

export const ERRORS_JS = `
(function(){
  var M = window.MD;
  var cur = {severity:'', source:'', category:'', since:'24h', q:''};
  var rows = [], sum = null, drv = '', debounce = null, open = {};

  function sevCls(sev){ return sev==='warn' ? 'warn' : (sev==='fatal' ? 'sev-fatal' : 'err'); }
  function sevPill(sev){ return '<span class="pill '+sevCls(sev)+'">'+M.esc(sev)+'</span>'; }
  function cut(s, n){ s = (s==null?'':String(s)); return s.length>n ? s.slice(0,n)+'\\u2026' : s; }
  function filtered(){ return !!(cur.severity||cur.source||cur.category||cur.q); }

  // Turn key convention (diagnostics/turns.ts): chatId when there is a chat, else handle:<handle>.
  function whoCell(r){
    var key = r.chatId || (r.handle ? 'handle:'+r.handle : '');
    if (!key) return '\\u2014';
    return '<a href="'+M.buildHash('orch',[key])+'" title="open the orchestration view for this chat">'
      + M.esc(cut(r.handle || r.chatId, 22)) + '</a>';
  }
  function detailText(r){
    var meta = {
      fingerprint: r.fingerprint, count: r.count,
      first: new Date(r.firstAt || r.createdAt).toISOString(),
      last: new Date(r.lastAt || r.createdAt).toISOString(),
      chatId: r.chatId, handle: r.handle, taskId: r.taskId
    };
    var txt = r.message + '\\n\\n' + JSON.stringify(meta, null, 2);
    txt += '\\n\\n' + (r.detail ? JSON.stringify(r.detail, null, 2) : 'no detail recorded');
    return txt;
  }
  function rowHtml(r){
    var ts = r.lastAt || r.createdAt;
    var html = '<tr class="rowlink" data-id="'+M.esc(r.id)+'">'
      + '<td>'+M.esc(M.fmtDateTime(ts))+'<span class="when">'+M.esc(M.ago(ts))+'</span></td>'
      + '<td>'+sevPill(r.severity)+'</td>'
      + '<td>'+M.esc(r.source)+'</td>'
      + '<td>'+M.esc(r.category)+'</td>'
      + '<td class="msg" title="'+M.esc(r.message)+'">'+M.esc(cut(r.message,160))+'</td>'
      + '<td>'+whoCell(r)+'</td>'
      + '<td class="cnt">'+(r.count>1?('<b>'+M.esc(r.count)+'</b>'):'1')+'</td></tr>';
    if (open[r.id]) html += '<tr class="det"><td colspan="7"><div class="prewrap">'+M.esc(detailText(r))+'</div></td></tr>';
    return html;
  }
  function renderSummary(){
    var stats = (sum && sum.stats) || [], top = (sum && sum.top) || [];
    var bySev = {}, total = 0;
    stats.forEach(function(s){ if (s.dimension==='severity'){ bySev[s.value] = s.events; total += s.events; } });
    var html = '<span class="pill">'+M.fmtNum(total)+' occurrence'+(total===1?'':'s')+' \\u00B7 '+M.esc(cur.since)+'</span>';
    ['fatal','error','warn'].forEach(function(k){
      if (!bySev[k]) return;
      html += '<span class="pill '+sevCls(k)+'">'+k+' '+M.fmtNum(bySev[k])+'</span>';
    });
    // Top recurring fingerprints: click one to filter the table down to its source + category.
    top.slice(0,3).forEach(function(t){
      html += '<span class="pill toppill" data-src="'+M.esc(t.source)+'" data-cat="'+M.esc(t.category)+'"'
        + ' title="'+M.esc(t.message)+'">\\u00D7'+M.fmtNum(t.events)+' '+M.esc(t.source)+'/'+M.esc(t.category)
        + ': '+M.esc(cut(t.message,56))+'</span>';
    });
    // Rows but no aggregates = the error_log RPCs aren't in the database yet (migration 0014).
    if (!total && rows.length) html += '<span class="pill warn">summary aggregates unavailable</span>';
    document.getElementById('err-summary').innerHTML = html;
  }
  function renderTable(){
    var tb = document.querySelector('#err-table tbody');
    tb.innerHTML = rows.length ? rows.map(rowHtml).join('')
      : '<tr><td colspan="7"><div class="empty">no errors '
        + (filtered() ? 'match these filters' : 'in this window \\u2014 nothing has failed')
        + '</div></td></tr>';
    var note = document.getElementById('err-note');
    if (drv === 'memory'){
      note.hidden = false;
      note.textContent = 'memory backend \\u2014 in-process ring, cleared on restart';
    } else note.hidden = true;
    M.ui.setPill(rows.length+' error rows \\u00B7 '+cur.since, rows.length?'err':null);
  }
  function render(){
    var fp = JSON.stringify([cur, drv, Object.keys(open),
      rows.map(function(r){ return [r.id, r.count, r.lastAt]; }),
      (sum && sum.stats) || [], (sum && sum.top) || []]);
    M.renderIf('errors:all', fp, function(){ renderSummary(); renderTable(); });
  }
  function qs(){
    var p = ['since='+encodeURIComponent(cur.since)];
    if (cur.severity) p.push('severity='+encodeURIComponent(cur.severity));
    if (cur.source) p.push('source='+encodeURIComponent(cur.source));
    if (cur.category) p.push('category='+encodeURIComponent(cur.category));
    if (cur.q) p.push('q='+encodeURIComponent(cur.q));
    return '?'+p.join('&');
  }
  function load(){
    M.api.latest('errors', '/dashboard/api/errors'+qs()).then(function(j){
      M.api.pollOk(j);
      drv = j.driver || '';
      rows = j.errors || [];
      render();
    }).catch(function(err){
      if (M.api.isStale(err)) return;
      M.api.pollFail();
      // Drop the fingerprint too, or the next good poll renders nothing over this panel.
      M.resetFp('errors:');
      document.querySelector('#err-table tbody').innerHTML =
        '<tr><td colspan="7"><div class="errpanel">couldn\\u2019t load errors'
        + '<br><button onclick="MD.views.errors.refresh()">retry</button></div></td></tr>';
    });
    M.api.latest('errors:sum', '/dashboard/api/errors/summary?since='+encodeURIComponent(cur.since))
      .then(function(j){ sum = j; render(); })
      .catch(function(err){ if (!M.api.isStale(err)){ sum = null; render(); } });
  }
  function pushRoute(){
    M.nav('errors', [], {severity:cur.severity, source:cur.source, category:cur.category, since:cur.since, q:cur.q});
  }
  function syncControls(){
    document.getElementById('err-sev').value = cur.severity;
    document.getElementById('err-source').value = cur.source;
    document.getElementById('err-category').value = cur.category;
    document.getElementById('err-window').value = cur.since;
    document.getElementById('err-q').value = cur.q;
  }
  var wired = false;
  function wire(){
    document.getElementById('err-sev').onchange = function(){ cur.severity=this.value; pushRoute(); };
    document.getElementById('err-source').onchange = function(){ cur.source=this.value; pushRoute(); };
    document.getElementById('err-category').onchange = function(){ cur.category=this.value; pushRoute(); };
    document.getElementById('err-window').onchange = function(){ cur.since=this.value; pushRoute(); };
    document.getElementById('err-q').oninput = function(){
      var v = this.value;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(function(){ cur.q=v; pushRoute(); }, 300);
    };
    document.querySelector('#err-table tbody').addEventListener('click', function(e){
      if (!e.target.closest) return;
      if (e.target.closest('a')) return;              // the deep link wins over the row toggle
      var tr = e.target.closest('tr.rowlink');
      if (!tr) return;
      var id = tr.getAttribute('data-id');
      if (open[id]) delete open[id]; else open[id] = 1;
      render();
    });
    document.getElementById('err-summary').addEventListener('click', function(e){
      var p = e.target.closest ? e.target.closest('.toppill') : null;
      if (!p) return;
      cur.source = p.getAttribute('data-src') || '';
      cur.category = p.getAttribute('data-cat') || '';
      cur.severity = '';
      pushRoute();
    });
  }
  M.views.errors = {
    tickEvery: 15000,
    enter: function(params, query){
      if (!wired){ wired = true; wire(); }
      cur.severity = query.severity || '';
      cur.source = query.source || '';
      cur.category = query.category || '';
      cur.since = query.since || '24h';
      cur.q = query.q || '';
      open = {};
      syncControls();
      M.resetFp('errors:');
      this._lastTick = M.now();
      load();
    },
    leave: function(){ M.api.bump('errors'); M.api.bump('errors:sum'); },
    refresh: load,
    tick: load
  };
})();
`;
