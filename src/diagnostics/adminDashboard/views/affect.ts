// Inner state: read-only per-user view of what colours a reply without ever being said — the mood
// she carried into the last turn and the trail behind it, the weeks-scale climate dials inside their
// code-owned bounds, the thread inventory as counts and labels, and the last twenty `turn:trace`
// receipts (section sizes, the transcript's share of the prompt, every gate's verdict, the affect
// drift). One picker, four panels, no writes.
//
// The shaping is all server-side and tested (api/affect.ts); this file only renders what that hands
// back. Client JS carries no backticks and no ${ — views.test.ts scans for both.

export const AFFECT_CSS = `
#view-affect{padding:0;display:flex;flex-direction:column;min-height:0}
#aff-head{padding:.7rem 1rem .2rem;flex:none}
#aff-body{flex:1;min-width:0;overflow-y:auto;padding:0 1rem 1.2rem}
#aff-pick{max-width:22rem}
.dial{display:grid;grid-template-columns:6.5rem 1fr 9rem;align-items:center;gap:.6rem;font-size:.78rem;margin:.35rem 0}
.dial .track{position:relative;height:.55rem;border:1px solid var(--line);border-radius:99px;background:var(--card)}
.dial .fill{position:absolute;top:0;bottom:0;left:0;border-radius:99px;background:var(--acc);opacity:.55}
.dial .mark{position:absolute;top:-.18rem;bottom:-.18rem;width:2px;background:var(--mut)}
.dial .bounds{color:var(--mut);font-size:.7rem}
.gauges{color:var(--mut)}
.gauges b{color:var(--fg);font-weight:600}
.tinybar{display:inline-block;width:3.2rem;height:.4rem;border:1px solid var(--line);border-radius:99px;vertical-align:middle;position:relative}
.tinybar i{position:absolute;top:0;bottom:0;left:0;border-radius:99px;background:var(--ok);opacity:.6}
`;

export const AFFECT_HTML = `
<div id="aff-head">
  <div class="memhead"><h2 class="vh" id="aff-title">Inner state</h2><span class="pill" id="aff-who">no user</span></div>
  <select id="aff-pick"></select>
</div>
<div id="aff-body"><div class="empty">pick a user to read their inner state</div></div>
`;

export const AFFECT_JS = `
(function(){
  var M = window.MD;
  var S = {handle:null, users:[], data:null};

  function renderPick(){
    var fp = String(S.handle)+'|'+S.users.map(function(u){return u.handle;}).join(',');
    M.renderIf('aff:pick', fp, function(){
      var pick = document.getElementById('aff-pick');
      pick.innerHTML = '<option value="">pick a user\\u2026</option>' + S.users.map(function(u){
        return '<option value="'+M.esc(u.handle)+'"'+(u.handle===S.handle?' selected':'')+'>'+M.esc(u.name||u.handle)+' ('+M.esc(u.handle)+')</option>';
      }).join('');
    });
  }

  function gaugeCell(v){
    if (v==null) return '<span class="gauges">\\u2014</span>';
    return '<span class="tinybar"><i style="width:'+Math.max(0,Math.min(100,v))+'%"></i></span> <b>'+v+'</b>';
  }
  function shiftChip(s){
    if (!s) return '';
    var col = s==='lifted' ? 'var(--ok)' : (s==='dipped' ? 'var(--warn)' : (s==='broke' ? 'var(--err)' : 'var(--mut)'));
    return '<span class="chip" style="color:'+col+';border-color:'+col+'">'+M.esc(s)+'</span>';
  }

  function moodPanel(d){
    if (!d.mood) return '<div class="empty">no affect row yet \\u2014 she has not taken a turn with this person</div>';
    var m = d.mood, g = m.gauges||{};
    return '<div class="kv">'
      + '<span>mood <b>'+M.esc(m.label)+'</b> ('+M.esc(m.core)+', '+m.level+'/100)</span>'
      + '<span>'+shiftChip(m.shift)+'</span>'
      + '<span>intent <b>'+M.esc(m.intent)+'</b></span>'
      + '<span>'+M.esc(M.ago(m.at))+' ago</span>'
      + '</div>'
      + '<div class="kv gauges"><span>warmth <b>'+g.warmth+'</b></span><span>patience <b>'+g.patience+'</b></span>'
      + '<span>social battery <b>'+g.social_battery+'</b></span><span>anxiety <b>'+g.anxiety+'</b></span>'
      + '<span>rapport <b>'+g.rapport+'</b></span></div>'
      + (m.metaPrompt ? '<div class="prewrap">'+M.esc(m.metaPrompt)+'</div>' : '');
  }

  function trailPanel(d){
    var rows = d.trail||[];
    if (!rows.length) return '<div class="empty">no trail yet</div>';
    return '<div class="tablewrap"><table class="t"><thead><tr>'
      + '<th>when</th><th>felt</th><th>level</th><th>shift</th><th>warmth</th><th>anxiety</th><th>social</th><th>rapport</th>'
      + '</tr></thead><tbody>' + rows.map(function(p){
        return '<tr><td>'+M.esc(M.ago(p.at))+' ago</td>'
          + '<td><b>'+M.esc(p.label)+'</b> <span class="gauges">'+M.esc(p.core)+'</span></td>'
          + '<td>'+p.level+'</td><td>'+(shiftChip(p.shift)||'<span class="gauges">\\u2014</span>')+'</td>'
          + '<td>'+gaugeCell(p.warmth)+'</td><td>'+gaugeCell(p.anxiety)+'</td>'
          + '<td>'+gaugeCell(p.social_battery)+'</td><td>'+gaugeCell(p.rapport)+'</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function dialsPanel(d){
    var rows = d.dials||[];
    var span = function(r, v){ return Math.max(0, Math.min(100, 100*(v - r.floor)/Math.max(1, r.ceiling - r.floor))).toFixed(1); };
    var body = rows.map(function(r){
      return '<div class="dial"><span>'+M.esc(r.key)+' <b>'+r.value+'</b></span>'
        + '<span class="track"><i class="fill" style="width:'+span(r,r.value)+'%"></i>'
        + '<i class="mark" style="left:'+span(r,r.dflt)+'%" title="default"></i></span>'
        + '<span class="bounds">'+r.floor+'\\u2013'+r.ceiling+' \\u00B7 spent '+r.spent+'/'+r.cap+'</span></div>';
    }).join('');
    var c = d.climate||{};
    return body + '<div class="kv"><span>evals <b>'+(c.evalCount||0)+'</b></span>'
      + '<span>last '+(c.lastEvalAt ? M.esc(M.ago(c.lastEvalAt))+' ago' : 'never')+'</span>'
      + '<span class="gauges">the bar spans the dial\\u2019s own floor and ceiling; the notch is its default</span></div>';
  }

  function countsHtml(c){
    var keys = Object.keys(c.byStatus||{});
    return '<b>'+c.total+'</b>' + (keys.length ? ' \\u00B7 ' + keys.map(function(k){
      return M.esc(k)+' '+c.byStatus[k];
    }).join(', ') : '');
  }
  function threadsPanel(d){
    var t = d.threads||{themes:{total:0,byStatus:{}},loops:{total:0,byStatus:{}},labels:[]};
    var head = '<div class="kv"><span>themes '+countsHtml(t.themes)+'</span><span>loops '+countsHtml(t.loops)+'</span>'
      + '<span>turns since an offer <b>'+t.turnsSinceOffer+'</b></span>'
      + '<span>harvested <b>'+t.harvestCount+'</b>'+(t.lastHarvestAt?' ('+M.esc(M.ago(t.lastHarvestAt))+' ago)':'')+'</span>'
      + '<span>last ping '+(t.lastPingAt ? M.esc(M.ago(t.lastPingAt))+' ago' : 'never')+'</span>'
      + '<span>pending '+(t.pending ? M.esc(t.pending.material)+' \\u00B7 '+M.esc(t.pending.phase) : '\\u2014')+'</span></div>';
    var labels = (t.labels||[]).length
      ? '<div class="tablewrap"><table class="t"><thead><tr><th>what</th><th>kind</th><th>status</th><th>evidence</th><th>last seen</th></tr></thead><tbody>'
        + t.labels.map(function(l){
          return '<tr><td><span class="chip" style="color:var(--acc);border-color:var(--acc)">'+M.esc(l.material)+'</span>'+M.esc(l.label)+'</td>'
            + '<td>'+M.esc(l.kind||'\\u2014')+'</td><td>'+M.esc(l.status)+'</td>'
            + '<td>'+(l.evidenceCount==null?'\\u2014':l.evidenceCount)+'</td>'
            + '<td>'+M.esc(M.ago(l.lastSeenAt))+' ago</td></tr>';
        }).join('') + '</tbody></table></div>'
      : '<div class="empty">nothing in the inventory</div>';
    return head + labels;
  }

  function sectionsSummary(r){
    var top = (r.sections||[]).slice().sort(function(a,b){ return b.chars-a.chars; }).slice(0,4);
    return top.map(function(s){ return M.esc(s.name)+' '+M.fmtNum(s.chars); }).join(', ') || '\\u2014';
  }
  function gatesSummary(r){
    var parts = [];
    if (r.threads) parts.push('threads: '+M.esc(r.threads));
    (r.memory||[]).forEach(function(b){
      parts.push(M.esc(b.block)+' '+M.esc(b.verdict)+(b.dropped ? ' (-'+b.dropped+')' : ''));
    });
    if (r.routingGate) parts.push('gate: '+M.esc(r.routingGate));
    var line = parts.join(' \\u00B7 ') || '\\u2014';
    // What the turn-focus block actually printed as touching this message — empty is the reading
    // that matters: a full memory stack with nothing in it about what they just said.
    return line + '<br><span class="gauges">' + ((r.hits||[]).length ? 'shown: '+M.esc(r.hits.join(', ')) : 'nothing touched the turn') + '</span>';
  }
  function driftSummary(r){
    if (!r.drift) return '<span class="gauges">none ran</span>';
    var applied = Object.keys(r.drift.applied||{}).map(function(k){
      var v = r.drift.applied[k];
      return M.esc(k)+' '+(v>0?'+':'')+v;
    });
    var out = applied.length ? applied.join(', ') : 'no gauge moved';
    if ((r.drift.capped||[]).length) out += ' \\u00B7 capped: '+M.esc(r.drift.capped.join(', '));
    if ((r.drift.atBound||[]).length) out += ' \\u00B7 at bound: '+M.esc(r.drift.atBound.join(', '));
    if (r.drift.brokeDowngraded) out += ' \\u00B7 broke downgraded';
    return out;
  }
  function tracesPanel(d){
    var rows = d.traces||[];
    if (!rows.length) return '<div class="empty">no turn:trace receipts for this chat yet (TURN_TRACE_ENABLED off, or no turn since the last prune)</div>';
    // The floor rides in the payload (api/affect.ts) rather than being retyped here, so the mark
    // moves with promptPolicy.ts instead of drifting away from it.
    var floor = (d.floors && d.floors.transcriptShare) || 0;
    return '<div class="tablewrap"><table class="t"><thead><tr>'
      + '<th>when</th><th>prompt</th><th>transcript</th><th>cache</th><th>biggest sections</th><th>gates</th><th>drift</th><th>reply</th>'
      + '</tr></thead><tbody>' + rows.map(function(r){
        var thin = r.transcriptShare < floor;
        return '<tr><td>'+M.esc(M.ago(r.at))+' ago</td>'
          + '<td>'+M.fmtNum(r.systemChars)+' ch<br><span class="gauges">persona '+M.fmtNum(r.personaChars)+' \\u00B7 block '+M.fmtNum(r.dynChars)+'</span></td>'
          + '<td'+(thin?' style="color:var(--warn)"':'')+'>'+M.pct(r.transcriptShare)+'<br><span class="gauges">'+r.transcriptRows+' rows \\u00B7 '+M.fmtNum(r.messagesChars)+' ch</span></td>'
          + '<td>'+r.cacheBreakpoints+'</td>'
          + '<td>'+sectionsSummary(r)+'</td>'
          + '<td>'+gatesSummary(r)+'</td>'
          + '<td>'+shiftChip(r.shift)+driftSummary(r)+'</td>'
          + '<td>'+(r.silent ? '<span class="pill warn">silent</span>' : (r.bubbles.count==null?'\\u2014':r.bubbles.count+' bubbles'))
          + (r.bubbles.overLaw ? ' <span class="pill err">over law '+r.bubbles.overLaw+'</span>' : '')
          + (r.wasEnvelope ? '' : ' <span class="pill err">not envelope</span>')
          + (r.affectSource==='defaulted' ? ' <span class="pill warn">status defaulted</span>' : '')
          + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function render(){
    var el = document.getElementById('aff-body');
    document.getElementById('aff-who').textContent = S.handle || 'no user';
    if (!S.handle){ el.innerHTML = '<div class="empty">pick a user to read their inner state</div>'; return; }
    if (!S.data){ el.innerHTML = '<div class="empty">loading\\u2026</div>'; return; }
    var d = S.data;
    el.innerHTML = '<h3 class="sh">Right now</h3>' + moodPanel(d)
      + '<h3 class="sh">Mood trail (last '+(d.trail||[]).length+')</h3>' + trailPanel(d)
      + '<h3 class="sh">Relationship climate</h3>' + dialsPanel(d)
      + '<h3 class="sh">Threads</h3>' + threadsPanel(d)
      + '<h3 class="sh">Last turns, as the receipt saw them</h3>' + tracesPanel(d);
  }

  function loadUsers(){
    M.api.latest('aff:users', '/dashboard/api/users').then(function(j){
      S.users = j.users||[];
      renderPick();
    }).catch(function(err){ if (!M.api.isStale(err)) M.toast('failed to load users', 'err'); });
  }
  function loadState(){
    if (!S.handle) return;
    var h = S.handle;
    S.data = null;
    render();
    M.api.latest('aff:data', '/dashboard/api/affect?handle='+encodeURIComponent(h)).then(function(j){
      if (h !== S.handle) return;
      S.data = j;
      render();
    }).catch(function(err){
      if (M.api.isStale(err) || h !== S.handle) return;
      document.getElementById('aff-body').innerHTML =
        '<div class="errpanel">couldn\\u2019t load inner state for '+M.esc(h)+'<br><button onclick="MD.views.affect.refresh()">retry</button></div>';
    });
  }
  var wired = false;
  function wire(){
    document.getElementById('aff-pick').onchange = function(){
      if (this.value) M.nav('affect', [this.value], {});
    };
  }
  M.views.affect = {
    enter: function(params){
      if (!wired){ wired = true; wire(); }
      var prev = S.handle;
      S.handle = params[0] || null;
      M.ui.setPill(S.handle ? ('inner state \\u00B7 '+S.handle) : 'inner state', null);
      loadUsers();
      if (S.handle && S.handle !== prev) loadState();
      else render();
    },
    leave: function(){ M.api.bump('aff:users'); M.api.bump('aff:data'); },
    refresh: function(){ loadUsers(); loadState(); }
  };
})();
`;
