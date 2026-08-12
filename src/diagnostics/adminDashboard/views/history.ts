// Turn history + search: all persisted turns, filterable across chats (search
// mode) or paginated per chat (key mode). Rows deep-link into the orchestration
// view pinned to that turn.

export const HISTORY_CSS = `
#hist-filters{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:.8rem}
#hist-filters input[type=text]{min-width:0}
#hist-more{margin:.8rem auto;display:block}
.errcount{color:var(--err);font-weight:700}
`;

export const HISTORY_HTML = `
<h2 class="vh">Turn history</h2>
<div id="hist-filters">
  <input type="text" id="hist-q" placeholder="search trigger / handle / key" style="width:220px">
  <input type="text" id="hist-handle" placeholder="handle" style="width:140px">
  <select id="hist-source">
    <option value="">any source</option>
    <option value="user">user</option>
    <option value="email">email</option>
    <option value="automation">automation</option>
    <option value="system">system</option>
  </select>
  <label class="pill" style="cursor:pointer"><input type="checkbox" id="hist-deep" style="vertical-align:-2px"> deep (payloads)</label>
  <span class="pill" id="hist-keypill" hidden></span>
</div>
<div class="tablewrap"><table class="t" id="hist-table"><thead><tr>
<th>when</th><th>source</th><th>handle</th><th>trigger</th><th>agents</th><th>events</th><th>errors</th>
</tr></thead><tbody><tr><td colspan="7"><div class="empty">loading…</div></td></tr></tbody></table></div>
<button id="hist-more" hidden>load more</button>
`;

export const HISTORY_JS = `
(function(){
  var M = window.MD;
  var cur = {key:'', q:'', handle:'', source:'', deep:false};
  var rows = [], nextBefore = null, debounce = null;

  function rowHtml(t){
    var trig = t.trigger || (t.agents||[]).join(' \\u00B7 ') || '\\u2014';
    return '<tr class="rowlink" data-key="'+M.esc(t.key)+'" data-id="'+M.esc(t.id)+'">'
      + '<td>'+M.esc(M.fmtDateTime(t.startedAt))+'</td>'
      + '<td>'+M.srcIcon(t.source)+' '+M.esc(t.source)+'</td>'
      + '<td>'+M.esc(t.handle||'\\u2014')+'</td>'
      + '<td style="white-space:normal;min-width:220px;max-width:440px">'+M.esc(String(trig).slice(0,160))+'</td>'
      + '<td>'+M.esc((t.agents||[]).slice(0,4).join(', '))+((t.agents||[]).length>4?'\\u2026':'')+'</td>'
      + '<td>'+t.eventCount+'</td>'
      + '<td>'+(t.errorCount?('<span class="errcount">'+t.errorCount+'</span>'):'0')+'</td></tr>';
  }
  function render(){
    var tb = document.querySelector('#hist-table tbody');
    tb.innerHTML = rows.length ? rows.map(rowHtml).join('')
      : '<tr><td colspan="7"><div class="empty">no turns match'+(cur.key||cur.q||cur.handle?'':' yet \\u2014 turns persist as activity happens')+'</div></td></tr>';
    var more = document.getElementById('hist-more');
    more.hidden = !(cur.key && nextBefore);
    var kp = document.getElementById('hist-keypill');
    if (cur.key){ kp.hidden=false; kp.textContent='chat: '+cur.key.slice(0,18)+' \\u2715'; }
    else kp.hidden = true;
    M.ui.setPill(rows.length+' turns', null);
  }
  function load(append){
    var p;
    if (cur.key){
      var url = '/dashboard/api/history?key='+encodeURIComponent(cur.key)+'&limit=30'
        + (append && nextBefore ? ('&before='+nextBefore) : '');
      p = M.api.latest('hist', url).then(function(j){
        M.api.pollOk(j);
        rows = append ? rows.concat(j.turns||[]) : (j.turns||[]);
        nextBefore = j.nextBefore || null;
        render();
      });
    } else {
      var qs = [];
      if (cur.q) qs.push('q='+encodeURIComponent(cur.q));
      if (cur.handle) qs.push('handle='+encodeURIComponent(cur.handle));
      if (cur.source) qs.push('source='+encodeURIComponent(cur.source));
      if (cur.deep && cur.q) qs.push('deep=1');
      p = M.api.latest('hist', '/dashboard/api/search'+(qs.length?('?'+qs.join('&')):'')).then(function(j){
        rows = j.results||[];
        nextBefore = null;
        render();
      });
    }
    p.catch(function(err){
      if (M.api.isStale(err)) return;
      M.api.pollFail();
      document.querySelector('#hist-table tbody').innerHTML =
        '<tr><td colspan="7"><div class="errpanel">search failed<br><button onclick="MD.views.history.refresh()">retry</button></div></td></tr>';
    });
  }
  function pushRoute(){
    M.nav('history', [], {key:cur.key, q:cur.q, handle:cur.handle, source:cur.source, deep:cur.deep?'1':''});
  }
  var wired = false;
  function wire(){
    document.getElementById('hist-q').oninput = function(){
      var v = this.value;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(function(){ cur.q=v; cur.key=''; pushRoute(); }, 300);
    };
    document.getElementById('hist-handle').oninput = function(){
      var v = this.value;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(function(){ cur.handle=v; cur.key=''; pushRoute(); }, 300);
    };
    document.getElementById('hist-source').onchange = function(){ cur.source=this.value; cur.key=''; pushRoute(); };
    document.getElementById('hist-deep').onchange = function(){ cur.deep=this.checked; if(cur.q) pushRoute(); };
    document.getElementById('hist-keypill').onclick = function(){ cur.key=''; pushRoute(); };
    document.getElementById('hist-more').onclick = function(){ load(true); };
    document.querySelector('#hist-table tbody').addEventListener('click', function(e){
      var tr = e.target.closest ? e.target.closest('tr.rowlink') : null;
      if (!tr) return;
      M.nav('orch', [tr.getAttribute('data-key'), tr.getAttribute('data-id')]);
    });
  }
  function syncControls(){
    document.getElementById('hist-q').value = cur.q;
    document.getElementById('hist-handle').value = cur.handle;
    document.getElementById('hist-source').value = cur.source;
    document.getElementById('hist-deep').checked = cur.deep;
  }
  M.views.history = {
    enter: function(params, query){
      if (!wired){ wired = true; wire(); }
      cur.key = query.key || '';
      cur.q = query.q || '';
      cur.handle = query.handle || '';
      cur.source = query.source || '';
      cur.deep = query.deep === '1';
      syncControls();
      load(false);
    },
    leave: function(){ M.api.bump('hist'); },
    refresh: function(){ load(false); }
  };
})();
`;
