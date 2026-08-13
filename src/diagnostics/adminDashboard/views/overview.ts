// Overview: system-health landing view — process state, since-boot counters,
// 24h LLM totals, and the global (chat-less) events that never reach the
// turn store.

export const OVERVIEW_CSS = `
#view-overview .brow{display:flex;align-items:center;gap:.5rem;margin:.22rem 0}
#view-overview .blabel{flex:none;width:96px;font-size:.74rem;color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}
#view-overview .btrack{flex:1;background:#0e1119;border-radius:6px;height:12px;overflow:hidden}
#view-overview .bfill{height:100%;border-radius:6px}
#view-overview .bval{flex:none;width:52px;font-size:.72rem;color:var(--mut)}
.gevent{display:flex;gap:.6rem;font-size:.76rem;padding:.3rem 0;border-bottom:1px solid #1a1f2c;align-items:baseline}
.gevent:last-child{border-bottom:0}
.gevent .gt{color:var(--mut);flex:none}
`;

export const OVERVIEW_HTML = `
<h2 class="vh">System health</h2>
<div class="cards" id="ov-top"></div>
<h3 class="sh">Activity since boot</h3>
<div class="cards" id="ov-counters"></div>
<div class="cards" style="margin-top:.8rem">
  <div class="cardbox" style="grid-column:1/-1"><div class="ct">LLM calls by agent (since boot)</div><div id="ov-roles"></div></div>
</div>
<h3 class="sh">Global events <span style="text-transform:none;letter-spacing:0">(no chat/user attribution — invisible in the graph)</span></h3>
<div class="cardbox" id="ov-global"></div>
`;

export const OVERVIEW_JS = `
(function(){
  var M = window.MD;
  var last = null;

  function card(t, v, s){
    return '<div class="cardbox"><div class="ct">'+M.esc(t)+'</div><div class="cv">'+v+'</div>'+(s?'<div class="cs">'+s+'</div>':'')+'</div>';
  }
  function render(j){
    var upEl = document.getElementById('ov-top');
    var d = j.diagnostics||{};
    var l = j.llm24h||{calls:0,errors:0,fallbacks:0,totalTokens:0};
    var fpSrc = JSON.stringify([d, l, j.counters, j.driver, (j.globalEvents||[]).length ? j.globalEvents[j.globalEvents.length-1].id : 0]);
    M.renderIf('ov:all', fpSrc, function(){
      upEl.innerHTML =
        card('uptime', '<span id="ov-uptime">'+M.esc(M.fmtDur(j.uptimeS))+'</span>', 'driver: '+M.esc(j.driver)+(j.driver==='memory'?' — ephemeral, resets on restart':''))
        + card('diagnostics', d.enabled?'on':'<span style="color:var(--err)">OFF</span>', (d.bufferEvents||0)+' buffered events \\u00B7 '+(d.liveKeys||0)+' live chats')
        + card('LLM (24h)', M.fmtNum(l.calls)+' calls', M.fmtNum(l.totalTokens)+' tokens \\u00B7 '+l.errors+' errors \\u00B7 '+l.fallbacks+' fallbacks');

      var c = j.counters||{};
      document.getElementById('ov-counters').innerHTML =
        card('turns started', String(c.turnsStarted||0), 'user: '+((c.bySource||{}).user||0)+' \\u00B7 email: '+((c.bySource||{}).email||0)+' \\u00B7 automation: '+((c.bySource||{}).automation||0))
        + card('LLM calls', String(c.llmCalls||0), (c.llmErrors||0)+' errors \\u00B7 '+(c.llmFallbacks||0)+' provider fallbacks')
        + card('fallfirm engagements', String(c.fallfirmEngagements||0), 'fallback voicer took the mic')
        + card('fidelity', String(c.fidelitySuppressed||0)+' suppressed', (c.fidelityFlagged||0)+' flagged');

      var roles = Object.keys(c.byRole||{}).map(function(r){ return {label:r, value:c.byRole[r]}; });
      roles.sort(function(a,b){ return b.value-a.value; });
      document.getElementById('ov-roles').innerHTML = M.charts.barRows(roles);

      var ge = j.globalEvents||[];
      document.getElementById('ov-global').innerHTML = ge.length
        ? ge.slice().reverse().map(function(ev){
            return '<div class="gevent"><span class="gt">'+M.esc(M.fmtTime(ev.ts))+'</span>'
              + '<span class="chip" style="color:var(--mut);border-color:var(--line)">'+M.esc(ev.label||ev.type)+'</span>'
              + '<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+M.esc(ev.detail?JSON.stringify(ev.detail):'')+'</span></div>';
          }).join('')
        : '<div class="empty">none in the buffer</div>';
    });
    // uptime ticks every poll even when nothing else changed
    var u = document.getElementById('ov-uptime');
    if (u) u.textContent = M.fmtDur(j.uptimeS);
    M.ui.setPill('diagnostics '+(d.enabled?'on':'OFF'), d.enabled?'live':'warn');
  }
  function load(){
    M.api.latest('overview', '/dashboard/api/overview').then(function(j){
      M.api.pollOk(j);
      last = j;
      render(j);
    }).catch(function(err){
      if (M.api.isStale(err)) return;
      M.api.pollFail();
      if (!last) document.getElementById('ov-top').innerHTML = '<div class="errpanel">couldn\\u2019t load overview</div>';
    });
  }
  M.views.overview = {
    tickEvery: 5000,
    enter: function(){ load(); this._lastTick = M.now(); },
    tick: load
  };
})();
`;
