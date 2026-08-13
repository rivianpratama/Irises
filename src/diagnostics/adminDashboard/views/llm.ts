// LLM analytics: windowed aggregates over the durable token_usage ledger —
// totals, error/fallback rates, hourly series, per role/provider/model stats,
// and the slowest calls.

export const LLM_CSS = `
#llm-controls{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:.8rem}
#llm-cap-banner{margin:.2rem 0 .9rem;padding:.6rem .85rem;border-radius:8px;font-size:.82rem;line-height:1.45}
#llm-cap-banner.tripped{background:rgba(255,72,72,.12);border:1px solid var(--err);color:var(--err)}
#llm-cap-banner.near{background:rgba(240,180,40,.12);border:1px solid var(--warn);color:var(--warn)}
#view-llm .brow{display:flex;align-items:center;gap:.5rem;margin:.22rem 0}
#view-llm .blabel{flex:none;width:150px;font-size:.74rem;color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}
#view-llm .btrack{flex:1;background:#0e1119;border-radius:6px;height:12px;overflow:hidden}
#view-llm .bfill{height:100%;border-radius:6px}
#view-llm .bval{flex:none;width:56px;font-size:.72rem;color:var(--mut)}
`;

export const LLM_HTML = `
<h2 class="vh">LLM analytics</h2>
<div id="llm-cap-banner" hidden></div>
<div id="llm-controls">
  <select id="llm-window">
    <option value="1h">last hour</option>
    <option value="24h" selected>last 24h</option>
    <option value="7d">last 7 days</option>
    <option value="30d">last 30 days</option>
  </select>
  <input id="llm-handle" placeholder="filter by handle" style="width:170px">
  <span class="pill" id="llm-note" hidden></span>
</div>
<h3 class="sh">Today (UTC)</h3>
<div class="cards" id="llm-today"></div>
<h3 class="sh">Window</h3>
<div class="cards" id="llm-cards"></div>
<div class="cards" style="margin-top:.8rem">
  <div class="cardbox" style="grid-column:1/-1"><div class="ct">calls per hour <span id="llm-hourly-note"></span></div><div id="llm-hourly"></div></div>
</div>
<h3 class="sh">By role / provider / model</h3>
<div class="tablewrap"><table class="t" id="llm-roles"><thead><tr>
<th>role</th><th>provider</th><th>model</th><th>calls</th><th>errors</th><th>fallbacks</th><th>avg</th><th>p95</th><th>tokens</th><th>est. cost</th>
</tr></thead><tbody></tbody></table></div>
<h3 class="sh">Slowest calls</h3>
<div class="tablewrap"><table class="t" id="llm-slow"><thead><tr>
<th>when</th><th>role</th><th>label</th><th>provider</th><th>model</th><th>latency</th><th>tokens</th><th>est. cost</th><th>handle</th>
</tr></thead><tbody></tbody></table></div>
<h3 class="sh">Recent errors <span id="llm-errors-note"></span></h3>
<div class="tablewrap"><table class="t" id="llm-errors"><thead><tr>
<th>when</th><th>role</th><th>label</th><th>provider</th><th>model</th><th>latency</th><th>error</th><th>handle</th>
</tr></thead><tbody></tbody></table></div>
`;

export const LLM_JS = `
(function(){
  var M = window.MD;
  var cur = {since:'24h', handle:''};
  var debounce = null;

  function card(t, v, s){
    return '<div class="cardbox"><div class="ct">'+M.esc(t)+'</div><div class="cv">'+v+'</div>'+(s?'<div class="cs">'+s+'</div>':'')+'</div>';
  }
  function fmtUsd(v){ return '$'+(v>=10 ? v.toFixed(2) : v.toFixed(3)); }
  // Per-call $ estimate. A single call runs from a few cents down to tiny fractions of a cent, so
  // this shows finer precision than fmtUsd and floors the display at a tenth of a cent instead of
  // printing a misleading '$0.000'. Escape the '<' at the call site (M.esc) — it lands in innerHTML.
  function fmtUsdCall(v){
    if (!v) return '$0';
    if (v>=1) return '$'+v.toFixed(2);
    if (v>=0.001) return '$'+v.toFixed(3);
    return '<$0.001';
  }
  // Credit balance can go negative (account overdrawn), so keep the sign: '-$0.16', not '$-0.160'.
  function fmtSignedUsd(v){ return (v<0?'-$':'$')+Math.abs(v).toFixed(2); }
  // OpenRouter credit runway. Omitted entirely when the API had no key / was unreachable (null),
  // so the card only appears when we actually know the balance. Red once it dips below the warn
  // floor — a heads-up before the out-of-credits 402s start (see fallbackPolicy.ts).
  function creditsCard(cr){
    if (!cr) return '';
    var rem = cr.remainingUsd||0;
    var txt = fmtSignedUsd(rem);
    var hot = rem < (cr.warnUsd||5);
    return card('OpenRouter credits', hot?('<span style="color:var(--err)">'+txt+'</span>'):txt, 'balance \\u00B7 warn < '+fmtSignedUsd(cr.warnUsd||5));
  }
  // tokens vs a daily cap: red once the kill switch is within 20% of tripping.
  function capStyle(tokens, cap){
    if (!cap) return {text: M.fmtNum(tokens)+' \\u00B7 no cap', hot: false};
    var pct = Math.round(100*tokens/cap);
    return {text: M.fmtNum(tokens)+' / '+M.fmtNum(cap)+' ('+pct+'%)', hot: pct >= 80};
  }
  // ms until the next UTC midnight — when every daily token cap resets (see budget.ts utcDayKey).
  function msToUtcMidnight(){
    var n = new Date();
    return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()+1, 0, 0, 0, 0) - n.getTime();
  }
  function fmtDur(ms){
    var m = Math.max(0, Math.floor(ms/60000)), h = Math.floor(m/60);
    return h>0 ? (h+'h '+(m%60)+'m') : (m+'m');
  }
  // Loud banner when a daily kill switch is TRIPPED (calls on that scope are blocked until UTC
  // midnight) or APPROACHING. Rendered every poll (outside the render-fingerprint gate) so the reset
  // countdown keeps ticking even after a trip freezes the token totals that feed the fingerprint.
  function renderCapBanner(today){
    var el = document.getElementById('llm-cap-banner');
    if (!el) return;
    var caps = today.caps||{};
    var checks = [
      {name:'global (every role)', tok: today.totalTokens||0, cap: caps.global},
      {name:'ops', tok: today.opsTokens||0, cap: caps.ops}
    ].filter(function(c){ return c.cap; });
    var tripped = checks.filter(function(c){ return c.tok >= c.cap; });
    var near = checks.filter(function(c){ return c.tok < c.cap && c.tok >= c.cap*0.8; });
    if (tripped.length){
      var names = tripped.map(function(c){ return M.esc(c.name)+' ('+M.fmtNum(c.tok)+'/'+M.fmtNum(c.cap)+')'; }).join('; ');
      el.hidden = false; el.className = 'tripped';
      el.innerHTML = '<b>\\u26D4 daily token cap exhausted</b> \\u2014 '+names+'. '
        + 'LLM calls on the affected scope are blocked until the cap resets at UTC midnight (in '+fmtDur(msToUtcMidnight())+'). '
        + 'The cap is a smoke alarm \\u2014 investigate the spike (per role/model below) before raising LLM_DAILY_TOKEN_CAP / OPS_DAILY_TOKEN_CAP.';
      return;
    }
    if (near.length){
      var names2 = near.map(function(c){ return M.esc(c.name)+' ('+Math.round(100*c.tok/c.cap)+'%)'; }).join('; ');
      el.hidden = false; el.className = 'near';
      el.innerHTML = '<b>\\u26A0 approaching daily token cap</b> \\u2014 '+names2+'. At 100% the breaker blocks that scope until the UTC-midnight reset (in '+fmtDur(msToUtcMidnight())+').';
      return;
    }
    el.hidden = true; el.className = '';
  }
  function renderToday(today, openrouter){
    var roles = (today.roles||[]).slice(0,4).map(function(r){
      return M.esc(r.role)+' '+fmtUsd(r.estCostUsd||0);
    }).join(' \\u00B7 ') || 'no calls yet';
    var caps = today.caps||{};
    var ops = capStyle(today.opsTokens||0, caps.ops);
    var all = capStyle(today.totalTokens||0, caps.global);
    document.getElementById('llm-today').innerHTML =
      card('est. spend today', fmtUsd(today.estCostUsd||0), roles)
      + card('ops tokens vs daily cap', ops.hot?('<span style="color:var(--err)">'+ops.text+'</span>'):ops.text, 'ops')
      + card('all tokens vs daily cap', all.hot?('<span style="color:var(--err)">'+all.text+'</span>'):all.text, 'every role')
      + creditsCard(openrouter);
  }
  function render(j){
    // Outside the fingerprint gate: recompute the live reset countdown every poll even when a trip
    // has frozen the token totals (no new calls → j.today stops changing → renderIf would skip).
    renderCapBanner(j.today||{});
    var fp = JSON.stringify([j.since, j.totals, j.today, j.openrouter, (j.hourly||[]).length, (j.slowest||[]).length, (j.errors||[]).length, (j.roleStats||[]).length, cur.handle]);
    M.renderIf('llm:all', fp, function(){
      var t = j.totals||{};
      renderToday(j.today||{}, j.openrouter);
      document.getElementById('llm-cards').innerHTML =
        card('calls ('+M.esc(j.since)+')', M.fmtNum(t.calls||0), M.fmtNum(t.inputTokens||0)+' in \\u00B7 '+M.fmtNum(t.outputTokens||0)+' out')
        + card('est. cost ('+M.esc(j.since)+')', fmtUsd(t.estCostUsd||0), 'tokens \\u00D7 model price')
        + card('total tokens', M.fmtNum(t.totalTokens||0), 'incl. cache')
        + card('error rate', M.pct((j.errorRate||{}).rate||0), (t.errors||0)+' failed calls')
        + card('fallback rate', M.pct((j.fallbackRate||{}).rate||0), (t.fallbacks||0)+' served by the fallback lane');

      var note = document.getElementById('llm-note');
      if (j.driver === 'memory'){ note.hidden=false; note.textContent='ephemeral backend — ledger resets on restart'; }
      else note.hidden = true;

      var hourly = j.hourly||[];
      document.getElementById('llm-hourly').innerHTML = M.charts.timeBars(hourly.map(function(b){
        return {value:b.calls, title:new Date(b.bucket).toLocaleString()+' \\u2014 '+b.calls+' calls, '+b.errors+' errors', color:b.errors>0?'var(--warn)':'var(--acc)'};
      }), 600, 80);
      document.getElementById('llm-hourly-note').textContent = hourly.length ? '' : '(no data in window)';

      var rb = document.querySelector('#llm-roles tbody');
      var rows = j.roleStats||[];
      rb.innerHTML = rows.length ? rows.map(function(r){
        return '<tr><td>'+M.esc(r.role)+'</td><td>'+M.esc(r.provider)+'</td><td>'+M.esc(r.model)+'</td>'
          + '<td>'+M.fmtNum(r.calls)+'</td>'
          + '<td>'+(r.errors?('<span style="color:var(--err)">'+r.errors+'</span>'):'0')+'</td>'
          + '<td>'+(r.fallbacks?('<span style="color:var(--warn)">'+r.fallbacks+'</span>'):'0')+'</td>'
          + '<td>'+M.esc(M.fmtMs(r.avgLatencyMs))+'</td><td>'+M.esc(M.fmtMs(r.p95LatencyMs))+'</td>'
          + '<td>'+M.fmtNum(r.totalTokens)+'</td>'
          + '<td>'+M.esc(fmtUsd(r.estCostUsd||0))+'</td></tr>';
      }).join('') : '<tr><td colspan="10"><div class="empty">no calls in this window</div></td></tr>';

      var sb = document.querySelector('#llm-slow tbody');
      var slow = j.slowest||[];
      sb.innerHTML = slow.length ? slow.map(function(r){
        return '<tr><td>'+M.esc(M.fmtDateTime(r.createdAt))+'</td><td>'+M.esc(r.role)+'</td><td>'+M.esc(r.label||'\\u2014')+'</td>'
          + '<td>'+M.esc(r.provider)+'</td><td>'+M.esc(r.model)+'</td>'
          + '<td><b>'+M.esc(M.fmtMs(r.latencyMs))+'</b></td><td>'+M.fmtNum(r.totalTokens)+'</td>'
          + '<td>'+M.esc(fmtUsdCall(r.estCostUsd||0))+'</td>'
          + '<td>'+(r.handle?('<a href="'+M.buildHash('memory',[r.handle])+'">'+M.esc(r.handle)+'</a>'):'\\u2014')+'</td></tr>';
      }).join('') : '<tr><td colspan="9"><div class="empty">no latency data yet</div></td></tr>';

      // Recent errors: durable status='error' rows (see recordLlmError). Full message in the cell's
      // title attribute; the cell shows a truncated, HTML-escaped preview in the error color.
      var eb = document.querySelector('#llm-errors tbody');
      var errs = j.errors||[];
      document.getElementById('llm-errors-note').textContent = errs.length ? ('('+errs.length+')') : '';
      eb.innerHTML = errs.length ? errs.map(function(r){
        var msg = r.error||'\\u2014';
        var short = msg.length > 90 ? msg.slice(0,90)+'\\u2026' : msg;
        return '<tr><td>'+M.esc(M.fmtDateTime(r.createdAt))+'</td><td>'+M.esc(r.role)+'</td><td>'+M.esc(r.label||'\\u2014')+'</td>'
          + '<td>'+M.esc(r.provider)+'</td><td>'+M.esc(r.model)+'</td>'
          + '<td>'+M.esc(M.fmtMs(r.latencyMs))+'</td>'
          + '<td title="'+M.esc(msg)+'"><span style="color:var(--err)">'+M.esc(short)+'</span></td>'
          + '<td>'+(r.handle?('<a href="'+M.buildHash('memory',[r.handle])+'">'+M.esc(r.handle)+'</a>'):'\\u2014')+'</td></tr>';
      }).join('') : '<tr><td colspan="8"><div class="empty">no errors in this window</div></td></tr>';
    });
    M.ui.setPill('analytics \\u00B7 '+j.since, null);
  }
  function load(){
    var url = '/dashboard/api/analytics?since='+encodeURIComponent(cur.since)
      + (cur.handle?('&handle='+encodeURIComponent(cur.handle)):'');
    M.api.latest('llm', url).then(function(j){
      M.api.pollOk(j);
      render(j);
    }).catch(function(err){
      if (M.api.isStale(err)) return;
      M.api.pollFail();
      M.toast('failed to load analytics', 'err');
    });
  }
  function syncControls(){
    document.getElementById('llm-window').value = cur.since;
    document.getElementById('llm-handle').value = cur.handle;
  }
  var wired = false;
  function wire(){
    document.getElementById('llm-window').onchange = function(){
      M.nav('llm', [], {since: this.value, handle: cur.handle});
    };
    document.getElementById('llm-handle').oninput = function(){
      var v = this.value;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(function(){ M.nav('llm', [], {since: cur.since, handle: v}); }, 300);
    };
  }
  M.views.llm = {
    tickEvery: 15000,
    enter: function(params, query){
      if (!wired){ wired = true; wire(); }
      cur.since = query.since || '24h';
      cur.handle = query.handle || '';
      syncControls();
      M.resetFp('llm:');
      this._lastTick = M.now();
      load();
    },
    leave: function(){ M.api.bump('llm'); },
    tick: load
  };
})();
`;
