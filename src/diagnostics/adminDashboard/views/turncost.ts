// Turn cost view: one chat rendered as a phone conversation — the user's messages
// and Irises's actual reply bubbles — with a cost badge between turns showing the
// tokens/$ every agent spent to produce that reply (convo + classify + ops + judge
// + composer + delegated work, task-routed like the Orchestration view groups them).
// Data: /dashboard/api/turncost (turns + per-turn claimed ledger rows, server-side $).
//
// The left picker lists USER CHATS ONLY — pick a user's conversation to inspect.
// Judge (email triage), automation pings, and reflexion/system sweeps are
// agent-internal, not chat history, so they never appear in the rail.

export const TURNCOST_CSS = `
#view-turncost{padding:0}
#tclayout{flex:1;display:flex;min-height:0}
#tcside{width:270px;flex:none;border-right:1px solid var(--line);background:var(--panel);overflow-y:auto}
#tcmain{flex:1;min-width:0;overflow-y:auto;display:flex;justify-content:center;padding:1rem}
.tc-phone{width:min(460px,100%);align-self:flex-start;background:#0e1119;border:1px solid var(--line);border-radius:22px;display:flex;flex-direction:column;overflow:hidden;min-height:200px}
.tc-phead{padding:.55rem .9rem;border-bottom:1px solid var(--line);background:var(--panel);font-size:.85rem;display:flex;gap:.5rem;align-items:center;position:sticky;top:0;z-index:2}
.tc-phead .tc-pname{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tc-msgs{padding:.8rem .7rem 1.1rem;display:flex;flex-direction:column;gap:.22rem}
.tc-turnhead{text-align:center;color:var(--mut);font-size:.68rem;margin:1rem 0 .4rem}
.tc-turnhead:first-child{margin-top:.1rem}
.tc-row{display:flex;margin:.1rem 0}
.tc-row.user{justify-content:flex-end}
.tc-row.irises{justify-content:flex-start}
.tc-bubble{max-width:82%;padding:.42rem .7rem;border-radius:16px;font-size:.84rem;line-height:1.4;white-space:pre-wrap;word-break:break-word}
.tc-row.user .tc-bubble{background:var(--acc);color:#0b0d12;border-bottom-right-radius:5px}
.tc-row.irises .tc-bubble{background:var(--card);border:1px solid var(--line);border-bottom-left-radius:5px}
.tc-bubble.ph{font-style:italic;color:var(--mut)}
.tc-row.user .tc-bubble.ph{background:#20293c;color:var(--mut)}
.tc-agent{font-size:.62rem;color:var(--mut);margin:.02rem .4rem .25rem;text-align:left}
.tc-noreply{text-align:center;color:var(--mut);font-size:.72rem;font-style:italic;margin:.25rem 0}
details.tc-cost{margin:.4rem auto .1rem;text-align:center;max-width:100%}
details.tc-cost>summary{list-style:none;cursor:pointer;display:inline-flex;gap:.45rem;align-items:center;font-size:.7rem;color:var(--mut);border:1px solid var(--line);border-radius:99px;padding:.16rem .7rem;white-space:nowrap}
details.tc-cost>summary::-webkit-details-marker{display:none}
details.tc-cost>summary:hover{border-color:var(--acc)}
details.tc-cost>summary .usd{color:var(--warn);font-weight:700}
details.tc-cost.approx>summary{border-style:dashed}
details.tc-cost>summary .errchip{color:var(--err)}
.tc-bd{margin:.45rem auto 0;font-size:.7rem;border:1px solid var(--line);border-radius:10px;overflow-x:auto;text-align:left;max-width:100%}
.tc-bd table{border-collapse:collapse;width:100%}
.tc-bd th{padding:.28rem .55rem;border-bottom:1px solid var(--line);color:var(--mut);font-weight:600;text-align:left;white-space:nowrap}
.tc-bd td{padding:.25rem .55rem;border-bottom:1px solid #1a1f2c;white-space:nowrap}
.tc-bd tr:last-child td{border-bottom:0}
.tc-bd td.r,.tc-bd th.r{text-align:right}
.tc-unatt{text-align:center;color:var(--mut);font-size:.68rem;margin:1rem 0 .2rem}
@media (max-width:699px){
  #tcmain{padding:0}
  .tc-phone{border-radius:0;border:0;width:100%;min-height:100%}
}
`;

export const TURNCOST_HTML = `
<div id="tclayout">
  <div id="tcside" class="drawerable"><div id="tcsidelist"><div class="empty">loading…</div></div></div>
  <div id="tcmain">
    <div class="tc-phone" id="tcphone" hidden>
      <div class="tc-phead"><span id="tcsrc">💬</span><span class="tc-pname" id="tcname"></span><div class="grow"></div><span class="pill warn" id="tcledger" hidden>no usage ledger</span><span class="pill" id="tctotal" hidden></span></div>
      <div class="tc-msgs" id="tcmsgs"></div>
    </div>
    <div class="empty" id="tcempty">select a chat on the left</div>
  </div>
</div>
`;

export const TURNCOST_JS = `
(function(){
  var M = window.MD;
  var S = { chats: [], selKey: null, data: null, err: null, openCosts: {}, lastListAt: {}, scrolledKey: null };

  // Per-turn costs are often sub-cent: keep more precision than the LLM tab's daily totals.
  function fmtUsd(v){ v = Number(v)||0; return '$' + (v>=10 ? v.toFixed(2) : v>=0.01 ? v.toFixed(3) : v.toFixed(4)); }
  function modelTail(m){ m = String(m||''); var i = m.lastIndexOf('/'); return i>=0 ? m.slice(i+1) : m; }
  function findChat(key){
    for (var i=0;i<S.chats.length;i++) if (S.chats[i].key===key) return S.chats[i];
    return null;
  }
  // Only user-initiated conversations belong in the picker. Gate on whether the user
  // has EVER messaged this chat (userTurnCount), NOT on the newest turn's source: on a
  // real chat the latest turn is often an automation (Autonome proactive send) or a
  // reflexion/system sweep, which used to hide the whole chat. Judge (email) lives on
  // handle:<phone> keys with no chatId, so it still never appears. Fall back to the
  // key as chatId (a non-handle key IS the chatId) and to source==='user' when the
  // pre-migration seed didn't supply a count.
  function chatIdOf(c){ return c.chatId || (String(c.key).indexOf('handle:')===0 ? null : c.key); }
  function userChats(){
    return S.chats.filter(function(c){
      return chatIdOf(c) && ((c.userTurnCount||0) > 0 || c.source === 'user');
    });
  }

  // ---------- sidebar (same roster + markup the Orchestration rail uses) ----------
  function renderSide(){
    var chats = userChats();
    var fp = String(S.selKey) + '|' + chats.map(function(c){ return c.key+' '+c.lastAt+' '+c.live+' '+c.turnCount; }).join(',');
    M.renderIf('tc:side', fp, function(){
      var byUser = {};
      chats.forEach(function(c){ var u=c.handle||'unknown user'; (byUser[u]=byUser[u]||[]).push(c); });
      var html = '';
      Object.keys(byUser).forEach(function(u){
        html += '<div class="userhead">'+M.esc(u)+'</div>';
        byUser[u].forEach(function(c){
          var cid = chatIdOf(c);
          var name = cid ? ('chat '+cid.slice(0,10)) : u;
          var turns = c.turnCount>1 ? ' \\u00B7 '+c.turnCount+' turns' : '';
          // Every entry here is a user conversation (userChats gate), so always show the
          // chat glyph — the representative source may be an automation/system sweep that
          // merely happened to be this chat's newest turn.
          html += '<div class="chat'+(c.key===S.selKey?' sel':'')+'" data-key="'+M.esc(c.key)+'">'
            + '<div class="row1"><span class="src">'+M.srcIcon('user')+'</span><span class="dot'+(c.live?'':' cold')+'"></span>'
            + '<span class="name">'+M.esc(name)+'</span><span class="when">'+M.ago(c.lastAt)+'</span></div>'
            + '<div class="trig">'+M.esc(c.trigger||(c.agents||[]).join(' \\u00B7 ')||'\\u2014')+turns+'</div></div>';
        });
      });
      var side = document.getElementById('tcsidelist');
      var st = side.parentNode.scrollTop;
      side.innerHTML = html || '<div class="empty">no user chats yet</div>';
      side.parentNode.scrollTop = st;
    });
  }

  // ---------- cost badge ----------
  function costSummary(t, usageAvailable){
    var c = t.cost;
    var err = t.errorCount>0 || c.errors>0 ? ' <span class="errchip">\\u26A0 '+(t.errorCount||c.errors)+' err</span>' : '';
    if (!usageAvailable) return '<span>usage ledger unavailable</span>'+err;
    if (c.attribution==='none') return '<span>no usage data</span>'+err;
    var tilde = c.attribution!=='exact' ? '~' : '';
    return '<span>'+tilde+M.fmtNum(c.inputTokens)+' in \\u00B7 '+M.fmtNum(c.outputTokens)+' out</span>'
      + '<span class="usd">'+fmtUsd(c.costUsd)+'</span>'
      + '<span>'+c.calls+' call'+(c.calls===1?'':'s')+'</span>'+err;
  }
  function costBreakdown(c){
    if (!c.byAgent || !c.byAgent.length) return '';
    var rows = '';
    c.byAgent.forEach(function(a){
      rows += '<tr><td>'+(a.exact?'':'~')+M.esc(a.agent)+'</td><td>'+M.esc(modelTail(a.model))+'</td>'
        + '<td class="r">'+M.fmtNum(a.inputTokens)+'</td><td class="r">'+M.fmtNum(a.outputTokens)+'</td>'
        + '<td class="r">'+M.fmtNum(a.cacheReadTokens)+'</td><td class="r">'+fmtUsd(a.costUsd)+'</td>'
        + '<td class="r">'+a.calls+(a.errors?' <span class="errchip">+'+a.errors+'e</span>':'')+'</td></tr>';
    });
    return '<div class="tc-bd"><table><thead><tr><th>agent</th><th>model</th>'
      + '<th class="r">in</th><th class="r">out</th><th class="r">cache</th><th class="r">est $</th><th class="r">calls</th></tr></thead>'
      + '<tbody>'+rows+'</tbody></table></div>';
  }

  // ---------- chat pane ----------
  function renderChat(){
    var phone = document.getElementById('tcphone');
    var empty = document.getElementById('tcempty');
    if (!S.selKey){
      M.renderIf('tc:chat', 'nokey', function(){
        phone.hidden = true; empty.hidden = false;
        empty.className = 'empty'; empty.textContent = 'select a chat on the left';
      });
      return;
    }
    if (S.err){
      M.renderIf('tc:chat', 'err|'+S.err, function(){
        phone.hidden = true; empty.hidden = false;
        empty.className = 'errpanel';
        empty.innerHTML = M.esc(S.err);
        var b = document.createElement('button');
        b.textContent = 'retry';
        b.onclick = function(){ S.err = null; renderChat(); load(); };
        empty.appendChild(document.createElement('br'));
        empty.appendChild(b);
      });
      return;
    }
    if (!S.data){
      M.renderIf('tc:chat', 'loading|'+S.selKey, function(){
        phone.hidden = true; empty.hidden = false;
        empty.className = 'empty'; empty.textContent = 'loading\\u2026';
      });
      return;
    }
    var d = S.data;
    var fp = d.key + '|' + d.usageAvailable + '|' + d.cards.map(function(t){
      var nb = 0; t.bubbles.forEach(function(g){ nb += g.texts.length; });
      return t.id+' '+t.lastAt+' '+t.open+' '+nb+' '+t.cost.calls+' '+t.cost.costUsd.toFixed(6);
    }).join(',') + '|' + (d.unattributed?d.unattributed.calls:0);
    M.renderIf('tc:chat', fp, function(){
      empty.hidden = true; phone.hidden = false;

      var c = findChat(d.key);
      // This pane only ever renders a user conversation — keep the chat glyph regardless
      // of whether the latest turn happened to be an automation/system sweep.
      document.getElementById('tcsrc').textContent = M.srcIcon('user');
      var name = (c && c.handle) ? c.handle : d.key;
      document.getElementById('tcname').textContent = name + (d.key.indexOf('handle:')===0 ? ' (no chat \\u2014 email/judge)' : '');
      document.getElementById('tcledger').hidden = d.usageAvailable;
      var total = 0, tcalls = 0;
      d.cards.forEach(function(t){ total += t.cost.costUsd; tcalls += t.cost.calls; });
      var totalEl = document.getElementById('tctotal');
      totalEl.hidden = !d.usageAvailable;
      totalEl.textContent = '\\u03A3 '+fmtUsd(total)+' \\u00B7 '+tcalls+' calls \\u00B7 '+d.cards.length+' turns';

      var html = '';
      if (!d.cards.length){
        html = '<div class="empty">no turns recorded for this chat</div>';
      }
      d.cards.forEach(function(t){
        html += '<div class="tc-turnhead">'+M.srcIcon(t.source)+' '+M.esc(M.fmtDateTime(t.startedAt))
          + (t.handle && d.key.indexOf('handle:')!==0 ? ' \\u00B7 '+M.esc(t.handle) : '')
          + (t.open ? ' \\u00B7 <span style="color:var(--ok)">still running</span>' : '')
          + '</div>';
        if (t.userText){
          html += '<div class="tc-row user"><div class="tc-bubble">'+M.esc(t.userText)
            + (t.userTextTruncated ? ' <span title="stored trigger is capped at 400 chars">\\u2026\\u26A0</span>' : '')
            + '</div></div>';
        } else {
          html += '<div class="tc-row user"><div class="tc-bubble ph">(no text \\u2014 media/automation trigger)</div></div>';
        }
        if (t.bubbles.length){
          t.bubbles.forEach(function(g){
            g.texts.forEach(function(txt){
              html += '<div class="tc-row irises"><div class="tc-bubble">'+M.esc(txt)+'</div></div>';
            });
            if (g.agent && g.agent!=='convo'){
              html += '<div class="tc-agent">via '+M.esc(g.agent)+'</div>';
            }
          });
        } else {
          html += '<div class="tc-noreply">no reply sent (gated or silent)</div>';
        }
        var open = S.openCosts[t.id] ? ' open' : '';
        html += '<details class="tc-cost'+(t.cost.approx||t.cost.attribution==='mixed'||t.cost.attribution==='window'?' approx':'')+'" data-turn="'+M.esc(t.id)+'"'+open+'>'
          + '<summary>'+costSummary(t, d.usageAvailable)+'</summary>'
          + costBreakdown(t.cost)
          + '</details>';
      });
      if (d.usageAvailable && d.unattributed && d.unattributed.calls>0){
        html += '<div class="tc-unatt">'+d.unattributed.calls+' call'+(d.unattributed.calls===1?'':'s')
          + ' ('+M.fmtNum(d.unattributed.totalTokens)+' tok, '+fmtUsd(d.unattributed.costUsd)+') in this window couldn\\u2019t be tied to a turn</div>';
      }

      var main = document.getElementById('tcmain');
      var atBottom = main.scrollTop + main.clientHeight >= main.scrollHeight - 60;
      var st = main.scrollTop;
      document.getElementById('tcmsgs').innerHTML = html;
      if (S.scrolledKey !== d.key || atBottom){
        S.scrolledKey = d.key;
        main.scrollTop = main.scrollHeight;
      } else {
        main.scrollTop = st;
      }
    });
  }

  // ---------- data ----------
  function selectChat(key){
    S.selKey = key; S.data = null; S.err = null;
    M.resetFp('tc:chat');
    renderSide(); renderChat();
    load();
  }
  function load(){
    if (!S.selKey) return;
    var key = S.selKey;
    M.api.latest('tc:data', '/dashboard/api/turncost?key='+encodeURIComponent(key)).then(function(j){
      if (key !== S.selKey) return;
      S.data = j; S.err = null;
      renderChat();
    }).catch(function(err){
      if (M.api.isStale(err)) return;
      if (key !== S.selKey) return;
      S.err = 'couldn\\u2019t load turn costs for this chat';
      renderChat();
      M.toast('failed to load turn costs', 'err');
    });
  }
  function refresh(){
    M.api.latest('tc:state', '/dashboard/api/state').then(function(j){
      M.api.pollOk(j);
      S.chats = j.chats||[];
      renderSide();
      if (!S.selKey){
        var uc = userChats();
        if (uc.length) M.nav('turncost', [uc[0].key]);
        return;
      }
      // Server caches /api/turncost for 10s — safe to refetch every tick; late
      // task-routed cost keeps arriving after the reply, so don't gate on lastAt.
      load();
    }).catch(function(err){
      if (M.api.isStale(err)) return;
      M.api.pollFail();
    });
  }

  // ---------- events (delegated, bound once) ----------
  function wire(){
    document.getElementById('tcsidelist').addEventListener('click', function(e){
      var el = e.target.closest ? e.target.closest('.chat') : null;
      if (!el) return;
      M.ui.closeDrawers();
      M.nav('turncost', [el.getAttribute('data-key')]);
    });
    // 'toggle' doesn't bubble — capture it so re-renders can restore open badges.
    document.getElementById('tcmsgs').addEventListener('toggle', function(e){
      var el = e.target;
      if (!el || !el.getAttribute || !el.getAttribute('data-turn')) return;
      S.openCosts[el.getAttribute('data-turn')] = el.open;
    }, true);
  }

  var wired = false;
  M.views.turncost = {
    tickEvery: 10000,
    enter: function(params){
      if (!wired){ wired = true; wire(); }
      M.ui.setNavButton(true, function(){ M.ui.openDrawer(document.getElementById('tcside')); });
      var key = params[0] || null;
      if (key && key !== S.selKey) selectChat(key);
      renderSide(); renderChat();
      this._lastTick = M.now();
      refresh();
    },
    leave: function(){
      M.ui.setNavButton(false, null);
      M.api.bump('tc:state'); M.api.bump('tc:data');
    },
    tick: refresh,
    refresh: function(){ refresh(); }
  };
})();
`;
