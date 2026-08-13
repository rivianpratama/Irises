// Orchestration view: the agent-flow graph, ported from the original dashboard
// with the structural fixes — explicit follow-latest flag, fingerprinted renders
// (open drawers survive polls), seq-guarded fetches, XOR badge placement, capped
// badge stacks, dynamic viewBox + pan/zoom, liveness-gated animation, error and
// empty states, and drawer/sheet behavior on small screens.

export const ORCH_CSS = `
#view-orch{padding:0}
#orchlayout{flex:1;display:flex;min-height:0}
#side{width:270px;flex:none;border-right:1px solid var(--line);background:var(--panel);overflow-y:auto}
.userhead{padding:.5rem .8rem .25rem;font-size:.72rem;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);position:sticky;top:0;background:var(--panel);z-index:2}
.chat{padding:.55rem .8rem;border-bottom:1px solid #1a1f2c;cursor:pointer}
.chat:hover{background:#161b28}
.chat.sel{background:#1a2233;border-left:3px solid var(--acc);padding-left:calc(.8rem - 3px)}
.chat .row1{display:flex;align-items:center;gap:.4rem}
.chat .src{flex:none}
.chat .name{font-weight:600;font-size:.83rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chat .when{margin-left:auto;color:var(--mut);font-size:.7rem;flex:none}
.chat .trig{color:var(--mut);font-size:.76rem;margin-top:.15rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dot{width:7px;height:7px;border-radius:99px;background:var(--ok);display:inline-block;flex:none}
.dot.cold{background:#3a4356}
#orchmain{flex:1;display:flex;flex-direction:column;min-width:0}
#turnbar{display:flex;gap:.4rem;align-items:center;padding:.45rem .9rem;border-bottom:1px solid var(--line);overflow-x:auto;flex:none;background:var(--panel);scrollbar-width:thin}
.tchip{font-size:.74rem;padding:.2rem .6rem;border-radius:8px;border:1px solid var(--line);color:var(--mut);cursor:pointer;white-space:nowrap}
.tchip.sel{border-color:var(--acc);color:var(--acc)}
.tchip.follow{border-color:var(--ok);color:var(--ok)}
#stage{flex:1;display:flex;min-height:0}
#graphwrap{flex:1;min-width:0;position:relative;overflow:hidden}
#graph{width:100%;height:100%;display:block;touch-action:none;cursor:grab}
#graph.panning{cursor:grabbing}
#graphctl{position:absolute;left:.6rem;bottom:.6rem;display:flex;gap:.3rem;z-index:5}
#graphctl button{font-size:.78rem;padding:.15rem .55rem}
#emptymsg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--mut);flex-direction:column;gap:.6rem;text-align:center;padding:1rem}
#emptymsg.err{color:var(--err)}
#steps{width:330px;flex:none;border-left:1px solid var(--line);background:var(--panel);overflow-y:auto;display:flex;flex-direction:column}
.stepshead{padding:.5rem .8rem;font-size:.72rem;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--panel);z-index:2;flex:none}
#steplist{overflow-y:auto;flex:1}
.trimnote{padding:.4rem .8rem;font-size:.72rem;color:var(--warn);border-bottom:1px solid var(--line);background:#1c1a14}
.step{padding:.45rem .8rem;border-bottom:1px solid #1a1f2c;cursor:pointer;display:flex;gap:.5rem;align-items:baseline}
.step:hover{background:#161b28}
.step.sel{background:#1a2233}
.step .n{flex:none;width:22px;height:22px;border-radius:99px;background:#232a3b;color:var(--fg);font-size:.72rem;display:flex;align-items:center;justify-content:center;align-self:center;font-weight:700}
.step .body{min-width:0;flex:1}
.step .flow{font-size:.8rem;font-weight:600}
.step .meta{color:var(--mut);font-size:.7rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#detail{position:absolute;top:0;right:0;bottom:0;width:min(560px,90%);background:#10131b;border-left:1px solid var(--line);box-shadow:-18px 0 40px rgba(0,0,0,.45);transform:translateX(102%);transition:transform .18s ease;display:flex;flex-direction:column;z-index:10}
#detail.open{transform:none}
#detail .dhead{display:flex;align-items:center;gap:.6rem;padding:.6rem .9rem;border-bottom:1px solid var(--line);flex:none}
#detail .dhead .t{font-weight:700;font-size:.9rem;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#detail .dbody{overflow-y:auto;padding:.7rem .9rem;flex:1}
.node rect{rx:12;stroke-width:1.4}
.node text{fill:var(--fg);font-size:12.5px;font-weight:600}
.node .subtitle{fill:var(--mut);font-size:9.5px;font-weight:400}
.node.dim{opacity:.22}
.node.pulse rect{filter:drop-shadow(0 0 7px currentColor)}
.edge{fill:none;stroke-width:1.7;opacity:.9}
.edge.ret{stroke-dasharray:5 4;opacity:.7}
.edge.selected{stroke-width:3;opacity:1;filter:drop-shadow(0 0 5px currentColor)}
.badge circle{stroke-width:1.2}
.badge text{font-size:9.5px;font-weight:700;fill:#0b0d12}
.badge{cursor:pointer}
.badge.sel circle{stroke:#fff;stroke-width:2}
.badge.more circle{fill:#232a3b}
.badge.more text{fill:var(--fg)}
@keyframes dash{to{stroke-dashoffset:-18}}
.edge.animate{stroke-dasharray:9 9;animation:dash .7s linear infinite}
@media (max-width:1099px){
  #steps{width:280px}
}
@media (max-width:699px){
  #steps{width:auto;border-left:0}
  #detail{width:100%}
}
`;

export const ORCH_HTML = `
<div id="orchlayout">
  <div id="side" class="drawerable"><div id="sidelist"><div class="empty">loading…</div></div></div>
  <div id="orchmain">
    <div id="turnbar"></div>
    <div id="stage">
      <div id="graphwrap">
        <svg id="graph" viewBox="0 0 1160 740" preserveAspectRatio="xMidYMid meet"></svg>
        <div class="empty" id="emptymsg">select a chat</div>
        <div id="graphctl"><button id="zoomin" title="zoom in">+</button><button id="zoomout" title="zoom out">−</button><button id="zoomfit" title="reset view">fit</button></div>
        <div id="detail">
          <div class="dhead"><span class="t" id="dtitle"></span><div class="grow"></div><button id="dclose">close ✕</button></div>
          <div class="dbody" id="dbody"></div>
        </div>
      </div>
      <div id="steps" class="sheet collapsed">
        <div class="grab" id="stepsgrab">steps — tap to open</div>
        <div class="stepshead">transactions <span id="stepcount"></span></div>
        <div id="steplist"></div>
      </div>
    </div>
  </div>
</div>
`;

export const ORCH_JS = `
(function(){
  var M = window.MD;
  var S = {
    chats: [], selKey: null, turns: [], selTurnId: null,
    turn: null, turnLive: false, rawStripped: false,
    selStep: null, selStepTurnId: null,
    follow: true, lastListAt: {}, err: null,
    cam: {x:0, y:0, k:1}, baseH: 740
  };

  // ---------- node catalog ----------
  var NODES = {
    user:     {x:95,  y:260, label:'User',      sub:'web / bridge',    color:'#6ea8fe', icon:'\\uD83D\\uDC64'},
    router:   {x:300, y:260, label:'Router',    sub:'webhook \\u00B7 batch', color:'#9aa5b1', icon:'\\uD83D\\uDEA6'},
    classify: {x:520, y:105, label:'Classifier',sub:'group gate',      color:'#b58cf6', icon:'\\uD83D\\uDD00'},
    convo:    {x:520, y:260, label:'Convo',     sub:'Irises \\u00B7 chat',    color:'#5bd6a0', icon:'\\uD83D\\uDCAC'},
    fallfirm: {x:520, y:565, label:'Fallfirm',  sub:'fallback voicer', color:'#d7a3ff', icon:'\\uD83D\\uDEDF'},
    memory:   {x:745, y:105, label:'Memory',    sub:'tiers \\u00B7 prefs',   color:'#9aa5b1', icon:'\\uD83E\\uDDE0'},
    ops:      {x:745, y:300, label:'Ops',       sub:'research engine', color:'#ffb454', icon:'\\uD83D\\uDD0E'},
    composer: {x:745, y:490, label:'Composer',  sub:'answer voicer',   color:'#ff8fa3', icon:'\\u270D\\uFE0F'}
  };
  var TOOL_X = 980, TOOL_Y0 = 120, TOOL_DY = 72;
  var BADGE_ROW_CAP = 5; // one row of node badges, then a "+N" overflow badge

  function mapEvent(ev){
    var l = ev.label || '', r = ev.role || '';
    var edges = [], node = null;
    function toolEdges(){
      var out = [];
      (ev.toolCalls||[]).forEach(function(tc){ out.push({from:'ops', to:'tool:'+tc.name}); });
      return out;
    }
    if (l==='turn:start'){ edges=[{from:'user',to:'router'}]; }
    else if (l==='classify'||r==='classify'){ edges=[{from:'router',to:'classify'},{from:'classify',to:'router',ret:true}]; }
    else if (l==='convo'){ edges=[{from:'router',to:'convo'}]; if(ev.response!=null) edges.push({from:'convo',to:'user',ret:true}); }
    else if (ev.type==='delegation'){ edges=[{from:'convo',to:'ops'}]; }
    else if (l==='llm:fallback'){ node = roleNode(r); }
    else if (l.indexOf('ops:')===0 || r==='ops'){ node='ops'; edges=toolEdges(); }
    else if (l==='composer'){ edges=[{from:'ops',to:'composer'}]; if(ev.response!=null) edges.push({from:'composer',to:'user',ret:true}); }
    else if (l.indexOf('fallfirm')===0 || l==='voiceInstant' || r==='fallfirm'){ node='fallfirm'; if(ev.response!=null) edges=[{from:'fallfirm',to:'user'}]; }
    else if (l==='dossier_update' || l==='directive_validate'){ node='memory'; }
    else { node='router'; }
    if (!edges.length && !node) node='router';
    return {node:node, edges:edges};
  }
  function roleNode(r){
    if (r && NODES[r]) return r;
    return 'router';
  }
  function agentColor(ev){
    var m = mapEvent(ev);
    var id = m.node || (m.edges.length ? m.edges[0].to : 'router');
    if (id.indexOf('tool:')===0) return '#c9d1d9';
    return (NODES[id]||NODES.router).color;
  }
  function flowLabel(ev){
    var m = mapEvent(ev), names = {};
    Object.keys(NODES).forEach(function(k){ names[k]=NODES[k].label; });
    function nm(id){ return id.indexOf('tool:')===0 ? id.slice(5) : (names[id]||id); }
    if (m.edges.length){ var e=m.edges[0]; var s=nm(e.from)+' \\u2192 '+nm(e.to); if(m.edges.length>1){ var last=m.edges[m.edges.length-1]; if(last.ret) s+=' \\u2938 '+nm(last.to);} return s; }
    return nm(m.node);
  }

  // ---------- shared bits ----------
  function findChat(key){
    for (var i=0;i<S.chats.length;i++) if (S.chats[i].key===key) return S.chats[i];
    return null;
  }
  // A turn only animates when it is genuinely live: live poll on, chat live, turn
  // still open, and activity within the last 2 minutes (cold/persisted turns froze
  // mid-pulse forever in the old dashboard).
  function isLiveTurn(){
    if (!M.state.live || !S.turn || !S.turnLive) return false;
    if (S.turn.open === false) return false;
    var c = findChat(S.selKey);
    if (c && !c.live) return false;
    return (M.now() - S.turn.lastAt) < 120000;
  }
  function showError(msg, retry){
    S.err = msg;
    var el = document.getElementById('emptymsg');
    el.style.display = 'flex';
    el.className = 'empty err';
    el.innerHTML = '<div>'+M.esc(msg)+'</div>';
    if (retry){
      var b = document.createElement('button');
      b.textContent = 'retry';
      b.onclick = retry;
      el.appendChild(b);
    }
    document.getElementById('graph').innerHTML = '';
    closeDetail();
  }

  // ---------- sidebar ----------
  function renderSide(){
    var fp = String(S.selKey) + '|' + S.chats.map(function(c){ return c.key+' '+c.lastAt+' '+c.live+' '+c.turnCount; }).join(',');
    M.renderIf('orch:side', fp, function(){
      var byUser = {};
      S.chats.forEach(function(c){ var u=c.handle||'unknown user'; (byUser[u]=byUser[u]||[]).push(c); });
      var html = '';
      Object.keys(byUser).forEach(function(u){
        html += '<div class="userhead">'+M.esc(u)+'</div>';
        byUser[u].forEach(function(c){
          var name = c.chatId ? ('chat '+c.chatId.slice(0,10)) : u;
          var turns = c.turnCount>1 ? ' \\u00B7 '+c.turnCount+' turns' : '';
          html += '<div class="chat'+(c.key===S.selKey?' sel':'')+'" data-key="'+M.esc(c.key)+'">'
            + '<div class="row1"><span class="src">'+M.srcIcon(c.source)+'</span><span class="dot'+(c.live?'':' cold')+'"></span>'
            + '<span class="name">'+M.esc(name)+'</span><span class="when">'+M.ago(c.lastAt)+'</span></div>'
            + '<div class="trig">'+M.esc(c.trigger||(c.agents||[]).join(' \\u00B7 ')||'\\u2014')+turns+'</div></div>';
        });
      });
      var side = document.getElementById('sidelist');
      var st = side.parentNode.scrollTop;
      side.innerHTML = html || '<div class="empty">no activity yet</div>';
      side.parentNode.scrollTop = st;
    });
  }

  // ---------- turn bar ----------
  function renderTurnBar(){
    var fp = String(S.selTurnId)+'|'+S.follow+'|'+S.turns.map(function(t){ return t.id+' '+t.eventCount+' '+t.lastAt+' '+(t.reply?t.reply.kind:''); }).join(',');
    M.renderIf('orch:bar', fp, function(){
      var bar = document.getElementById('turnbar');
      if (!S.selKey){ bar.innerHTML=''; return; }
      if (!S.turns.length){ bar.innerHTML='<span class="pill">no turns</span>'; return; }
      var html = '<span class="pill">turns ('+S.turns.length+')</span>';
      if (!S.follow) html += '<span class="tchip follow" data-act="follow">\\u25B6 follow latest</span>';
      S.turns.slice().reverse().forEach(function(t){
        // \\u21A9 marks a turn whose user message tapped reply on an earlier one; the title spells out
        // the resolved target + kind (resolved = one of Irises's bubbles, thread = their own thread
        // root, unresolved = target couldn't be identified — a candidate misattribution).
        var rep = '', repTitle = '';
        if (t.reply){
          rep = ' \\u21A9';
          var k = t.reply.kind==='assistant'?'resolved':(t.reply.kind==='own-thread'?'thread':'unresolved');
          repTitle = ' title="\\u21A9 replying to: '+M.esc(String(t.reply.snippet||'(unidentified)'))+' ('+k+')"';
        }
        html += '<span class="tchip'+(t.id===S.selTurnId?' sel':'')+'" data-id="'+M.esc(t.id)+'"'+repTitle+'>'
          + M.srcIcon(t.source)+' '+M.fmtTime(t.startedAt)+' \\u00B7 '+t.eventCount+' ev'+rep+'</span>';
      });
      var c = findChat(S.selKey);
      if (c && c.turnCount > S.turns.length){
        html += '<span class="tchip" data-act="history">older \\u27F6 history</span>';
      }
      bar.innerHTML = html;
    });
  }

  // ---------- graph ----------
  function nodeSvg(id, def, active, pulse){
    var w=132, h=48;
    return '<g class="node'+(active?'':' dim')+(pulse?' pulse':'')+'" data-node="'+M.esc(id)+'" style="color:'+def.color+'">'
      + '<rect x="'+(def.x-w/2)+'" y="'+(def.y-h/2)+'" width="'+w+'" height="'+h+'" rx="12" fill="#171b26" stroke="'+def.color+'"></rect>'
      + '<text x="'+(def.x-w/2+12)+'" y="'+(def.y-2)+'">'+def.icon+' '+M.esc(def.label)+'</text>'
      + '<text class="subtitle" x="'+(def.x-w/2+12)+'" y="'+(def.y+14)+'">'+M.esc(def.sub)+'</text>'
      + '</g>';
  }
  function edgePath(a, b, bend){
    var mx=(a.x+b.x)/2, my=(a.y+b.y)/2;
    var dx=b.x-a.x, dy=b.y-a.y, len=Math.sqrt(dx*dx+dy*dy)||1;
    var nx=-dy/len, ny=dx/len;
    var cx=mx+nx*bend, cy=my+ny*bend;
    return {d:'M '+a.x+' '+a.y+' Q '+cx+' '+cy+' '+b.x+' '+b.y, cx:cx, cy:cy};
  }
  function pointOnQuad(a,c,b,t){
    var mt=1-t;
    return { x: mt*mt*a.x + 2*mt*t*c.x + t*t*b.x, y: mt*mt*a.y + 2*mt*t*c.y + t*t*b.y };
  }
  function applyCam(){
    var svg = document.getElementById('graph');
    var w = 1160/S.cam.k, h = S.baseH/S.cam.k;
    svg.setAttribute('viewBox', S.cam.x+' '+S.cam.y+' '+w+' '+h);
  }
  function renderGraph(){
    var svg = document.getElementById('graph');
    var empty = document.getElementById('emptymsg');
    if (S.err) return;
    if (!S.turn){
      M.renderIf('orch:graph', 'empty|'+String(S.selKey), function(){
        svg.innerHTML='';
        empty.style.display='flex';
        empty.className='empty';
        empty.textContent = S.selKey ? 'no turn data' : 'select a chat on the left';
      });
      return;
    }
    var events = S.turn.events || [];
    var live = isLiveTurn();
    var toolNames = [];
    events.forEach(function(ev){ (ev.toolCalls||[]).forEach(function(tc){ if(toolNames.indexOf(tc.name)<0) toolNames.push(tc.name); }); });
    var H = Math.max(740, TOOL_Y0 + toolNames.length*TOOL_DY + 60);
    var fp = S.turn.id+'|'+events.length+'|'+S.selStep+'|'+live+'|'+H;
    M.renderIf('orch:graph', fp, function(){
      if (S.baseH !== H){ S.baseH = H; applyCam(); }
      empty.style.display='none';

      var nodes = {}; Object.keys(NODES).forEach(function(k){ nodes[k]=NODES[k]; });
      toolNames.forEach(function(nm,i){
        nodes['tool:'+nm]={x:TOOL_X, y:TOOL_Y0+i*TOOL_DY, label:nm.length>14?nm.slice(0,13)+'\\u2026':nm, sub:'tool', color:'#c9d1d9', icon:'\\uD83E\\uDDF0'};
      });

      var active = {}, edgeMap = {}, nodeBadges = {};
      events.forEach(function(ev, idx){
        var m = mapEvent(ev), n = idx+1;
        var placed = false;
        m.edges.forEach(function(e){
          if (!nodes[e.from] || !nodes[e.to]) return;
          active[e.from]=1; active[e.to]=1;
          var k = e.from+'>'+e.to+(e.ret?'~':'');
          if (!edgeMap[k]) edgeMap[k]={from:e.from,to:e.to,ret:!!e.ret,steps:[]};
          edgeMap[k].steps.push({n:n, ev:ev});
          placed = true;
        });
        if (m.node && nodes[m.node]){
          active[m.node]=1;
          // One event -> ONE badge home: edges when it has any, else its node
          // (the old renderer badged Ops tool-call steps in both places).
          if (!placed) (nodeBadges[m.node]=nodeBadges[m.node]||[]).push({n:n, ev:ev});
        }
      });
      active.user = 1;

      var defs = '<defs>'
        + '<marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 1 L 9 5 L 0 9 z" fill="context-stroke"></path></marker>'
        + '</defs>';

      var edgeSvg='', badgeSvg='';
      var lastN = events.length;
      Object.keys(edgeMap).forEach(function(k){
        var e = edgeMap[k], a = nodes[e.from], b = nodes[e.to];
        if (e.from===e.to) return;
        var bend = e.ret ? -34 : (e.from==='user'||e.to==='user' ? 40 : 26);
        var p = edgePath(a,b,bend);
        var color = (nodes[e.to]||{}).color || '#8b93a7';
        var isSel = S.selStep!=null && e.steps.some(function(s){return s.n===S.selStep;});
        var isLatest = e.steps.some(function(s){return s.n===lastN;});
        edgeSvg += '<path class="edge'+(e.ret?' ret':'')+(isSel?' selected':'')+(isLatest&&live?' animate':'')+'" d="'+p.d+'" stroke="'+color+'" marker-end="url(#arr)" style="color:'+color+'"></path>';
        e.steps.forEach(function(s, i){
          var t = 0.5 + (i - (e.steps.length-1)/2) * 0.16;
          t = Math.max(.18, Math.min(.82, t));
          var pt = pointOnQuad(a, {x:p.cx,y:p.cy}, b, t);
          badgeSvg += '<g class="badge'+(S.selStep===s.n?' sel':'')+'" data-step="'+s.n+'">'
            + '<circle cx="'+pt.x+'" cy="'+pt.y+'" r="10.5" fill="'+color+'" stroke="#0b0d12"></circle>'
            + '<text x="'+pt.x+'" y="'+(pt.y+3.4)+'" text-anchor="middle">'+s.n+'</text></g>';
        });
      });

      var nodeSvgStr='';
      Object.keys(nodes).forEach(function(id){
        var badges = nodeBadges[id]||[];
        var pulse = badges.some(function(s){return s.n===lastN;}) && live;
        nodeSvgStr += nodeSvg(id, nodes[id], !!active[id], pulse);
        // Cap the stack at one row + a "+N" overflow badge (uncapped stacks grew
        // straight down into the boxes below on research-heavy turns).
        var def = nodes[id];
        var shown = badges.slice(0, badges.length > BADGE_ROW_CAP ? BADGE_ROW_CAP-1 : BADGE_ROW_CAP);
        shown.forEach(function(s, i){
          var bx=def.x-50+i*25, by=def.y+38;
          badgeSvg += '<g class="badge'+(S.selStep===s.n?' sel':'')+'" data-step="'+s.n+'">'
            + '<circle cx="'+bx+'" cy="'+by+'" r="10.5" fill="'+def.color+'" stroke="#0b0d12"></circle>'
            + '<text x="'+bx+'" y="'+(by+3.4)+'" text-anchor="middle">'+s.n+'</text></g>';
        });
        if (badges.length > shown.length){
          var mx=def.x-50+(BADGE_ROW_CAP-1)*25, my=def.y+38;
          badgeSvg += '<g class="badge more" data-act="steps">'
            + '<circle cx="'+mx+'" cy="'+my+'" r="10.5" stroke="'+def.color+'"></circle>'
            + '<text x="'+mx+'" y="'+(my+3.4)+'" text-anchor="middle">+'+(badges.length-shown.length)+'</text></g>';
        }
      });

      svg.innerHTML = defs + edgeSvg + nodeSvgStr + badgeSvg;
    });
  }

  // ---------- steps ----------
  function stepSummary(ev){
    var bits = [];
    if (ev.model) bits.push(String(ev.model).replace(/^anthropic\\//,'').replace(/^google\\//,''));
    if (ev.latencyMs!=null) bits.push(M.fmtMs(ev.latencyMs));
    if (ev.toolCalls&&ev.toolCalls.length) bits.push(ev.toolCalls.length+' tool call'+(ev.toolCalls.length>1?'s':''));
    if (ev.label==='turn:start' && ev.detail && ev.detail.text) bits.push('\\u201C'+String(ev.detail.text).slice(0,60)+'\\u201D');
    return bits.join(' \\u00B7 ');
  }
  function renderSteps(){
    var list = document.getElementById('steplist');
    var count = document.getElementById('stepcount');
    if (!S.turn){
      M.renderIf('orch:steps', 'none', function(){ list.innerHTML=''; count.textContent=''; });
      applyStepSel();
      return;
    }
    var events = S.turn.events||[];
    var fp = S.turn.id+'|'+events.length;
    M.renderIf('orch:steps', fp, function(){
      count.textContent = '('+events.length+')';
      var html='';
      if (events.length < S.turn.eventCount){
        html += '<div class="trimnote">showing last '+events.length+' of '+S.turn.eventCount+' events (older events trimmed)</div>';
      }
      events.forEach(function(ev, idx){
        var n=idx+1, color=agentColor(ev);
        html += '<div class="step" data-step="'+n+'">'
          + '<div class="n" style="background:'+color+';color:#0b0d12">'+n+'</div>'
          + '<div class="body"><div class="flow">'+M.esc(flowLabel(ev))
          + ' <span class="chip" style="color:'+color+';border-color:'+color+'">'+M.esc(ev.label||ev.type)+'</span></div>'
          + '<div class="meta">'+M.fmtTime(ev.ts)+(stepSummary(ev)?' \\u00B7 '+M.esc(stepSummary(ev)):'')+'</div></div></div>';
      });
      list.innerHTML = html || '<div class="empty">no events</div>';
      var grab = document.getElementById('stepsgrab');
      grab.textContent = events.length+' steps \\u2014 tap to open';
    });
    applyStepSel();
  }
  // Selection is applied via class toggles (no innerHTML), so selecting a step
  // never resets the list's scroll position.
  function applyStepSel(){
    Array.prototype.forEach.call(document.querySelectorAll('#steplist .step'), function(el){
      var n = Number(el.getAttribute('data-step'));
      el.className = 'step'+(S.selStep===n?' sel':'');
    });
  }

  // ---------- detail ----------
  function section(title, val, open){
    if (val==null || val==='') return '';
    var txt = typeof val==='string' ? val : JSON.stringify(val, null, 2);
    return '<details class="sec"'+(open?' open':'')+'><summary>'+M.esc(title)
      + '<button class="copy" data-copy="1">copy</button><span class="cnt">'+txt.length+' ch</span></summary>'
      + '<pre>'+M.esc(txt)+'</pre></details>';
  }
  function closeDetail(){
    document.getElementById('detail').classList.remove('open');
  }
  function renderDetail(){
    var d = document.getElementById('detail');
    // A selection made on turn A must not survive into turn B (the old dashboard
    // silently swapped in a different turn's event when the index existed).
    if (S.selStep!=null && S.turn && S.selStepTurnId !== S.turn.id){ S.selStep = null; }
    if (S.selStep==null || !S.turn){ M.renderIf('orch:detail', 'closed', function(){}); d.classList.remove('open'); return; }
    var ev = (S.turn.events||[])[S.selStep-1];
    if (!ev){ d.classList.remove('open'); return; }
    // TraceEvents are immutable once recorded: while this step stays selected the
    // fingerprint never changes, so polling never rebuilds the drawer (open payload
    // sections, scroll, and text selection all survive).
    var fp = S.turn.id+'|'+S.selStep+'|'+ev.id;
    M.renderIf('orch:detail', fp, function(){
      document.getElementById('dtitle').textContent = '#'+S.selStep+' \\u00B7 '+flowLabel(ev);
      var kv = '<div class="kv">'
        + '<span>type <b>'+M.esc(ev.type)+'</b></span>'
        + (ev.label?'<span>label <b>'+M.esc(ev.label)+'</b></span>':'')
        + (ev.role?'<span>role <b>'+M.esc(ev.role)+'</b></span>':'')
        + (ev.provider?'<span>provider <b>'+M.esc(ev.provider)+'</b></span>':'')
        + (ev.model?'<span>model <b>'+M.esc(ev.model)+'</b></span>':'')
        + (ev.latencyMs!=null?'<span>latency <b>'+M.esc(M.fmtMs(ev.latencyMs))+'</b></span>':'')
        + '<span>time <b>'+M.esc(M.fmtTime(ev.ts))+'</b></span>'
        + (ev.taskId?'<span>task <b>'+M.esc(String(ev.taskId).slice(0,12))+'</b></span>':'')
        + '</div>';
      var rawNote = (ev.raw==null && S.rawStripped)
        ? '<div class="kv"><span>raw wire payload not persisted for historical turns</span></div>' : '';
      var body = kv
        + (ev.raw!=null?section('RAW response (wire, unparsed)', ev.raw, true):rawNote)
        + section(ev.raw!=null?'response text (extracted from raw)':'response (received)', ev.response, ev.raw==null)
        + section('messages (sent)', ev.messages, false)
        + section('system prompt', ev.system, false)
        + (ev.toolCalls&&ev.toolCalls.length?section('tool calls (parsed)', ev.toolCalls, false):'')
        + (ev.detail?section('detail', ev.detail, true):'');
      document.getElementById('dbody').innerHTML = body || '<div class="kv">no payload</div>';
    });
    d.classList.add('open');
  }
  function selectStep(n){
    S.selStep = S.selStep===n ? null : n;
    S.selStepTurnId = S.turn ? S.turn.id : null;
    renderGraph(); applyStepSel(); renderDetail();
  }

  // ---------- data loading ----------
  function selectChat(key, turnId){
    S.selKey = key;
    S.selTurnId = turnId || null;
    S.follow = !turnId;
    S.turn = null; S.turnLive = false; S.rawStripped = false;
    S.selStep = null; S.selStepTurnId = null;
    S.err = null; S.turns = [];
    M.resetFp('orch:graph'); M.resetFp('orch:steps'); M.resetFp('orch:detail'); M.resetFp('orch:bar');
    closeDetail();
    renderSide(); renderTurnBar(); renderGraph(); renderSteps();
    loadTurns(key, true);
  }
  function loadTurns(key, andTurn){
    M.api.latest('orch:turns', '/dashboard/api/turns?key='+encodeURIComponent(key)).then(function(j){
      if (key !== S.selKey) return;
      S.turns = j.turns||[];
      renderTurnBar();
      var latest = S.turns.length ? S.turns[S.turns.length-1] : null;
      if (S.follow){
        // Explicit follow semantics: whenever following, the latest turn is the
        // one on screen (the old viewingLatest heuristic had a dead clause and
        // froze on turn hand-off).
        if (latest) loadTurn(key, latest.id);
        else { S.turn=null; renderGraph(); renderSteps(); renderDetail(); }
      } else if (andTurn && S.selTurnId){
        loadTurn(key, S.selTurnId);
      } else if (!S.follow && S.turn){
        // Late events (taskId-routed) can land on the pinned older turn — reload it
        // when its meta advanced past what we're showing.
        var mine = null;
        S.turns.forEach(function(t){ if(t.id===S.selTurnId) mine=t; });
        if (mine && S.turn.lastAt < mine.lastAt) loadTurn(key, S.selTurnId);
      }
    }).catch(function(err){
      if (M.api.isStale(err)) return;
      if (key !== S.selKey) return;
      showError('couldn\\u2019t load this chat\\u2019s turns', function(){ S.err=null; loadTurns(key, true); });
      M.toast('failed to load turns for the selected chat', 'err');
    });
  }
  function loadTurn(key, id){
    M.api.latest('orch:turn', '/dashboard/api/turn?key='+encodeURIComponent(key)+'&id='+encodeURIComponent(id)).then(function(j){
      if (key !== S.selKey) return;
      if (!j.turn) return;
      S.turn = j.turn;
      S.turnLive = !!j.live;
      S.rawStripped = !!j.rawStripped;
      S.selTurnId = j.turn.id;
      S.err = null;
      renderTurnBar(); renderGraph(); renderSteps(); renderDetail();
    }).catch(function(err){
      if (M.api.isStale(err)) return;
      if (key !== S.selKey) return;
      if (err && err.status === 404){
        showError('this turn is no longer available (evicted from history)', null);
      } else {
        showError('couldn\\u2019t load this turn', function(){ S.err=null; loadTurn(key, id); });
        M.toast('failed to load turn', 'err');
      }
    });
  }
  function refresh(){
    M.api.latest('orch:state', '/dashboard/api/state').then(function(j){
      M.api.pollOk(j);
      S.chats = j.chats||[];
      M.ui.setPill(S.chats.length+' chats \\u00B7 diagnostics '+(j.enabled?'on':'OFF'), j.enabled?'live':'warn');
      renderSide();
      if (!S.selKey){
        if (S.chats.length) M.nav('orch', [S.chats[0].key]);
        return; // selection continues via the route — no fall-through double fetch
      }
      var c = findChat(S.selKey);
      if (c && S.lastListAt[S.selKey] !== c.lastAt){
        S.lastListAt[S.selKey] = c.lastAt;
        loadTurns(S.selKey, false);
      }
      // liveness decay: stop the pulse once the turn goes quiet
      renderGraph();
    }).catch(function(err){
      if (M.api.isStale(err)) return;
      M.api.pollFail();
    });
  }

  // ---------- events (delegated, bound once) ----------
  function wire(){
    document.getElementById('sidelist').addEventListener('click', function(e){
      var el = e.target.closest ? e.target.closest('.chat') : null;
      if (!el) return;
      M.ui.closeDrawers();
      M.nav('orch', [el.getAttribute('data-key')]);
    });
    document.getElementById('turnbar').addEventListener('click', function(e){
      var el = e.target.closest ? e.target.closest('.tchip') : null;
      if (!el || !S.selKey) return;
      var act = el.getAttribute('data-act');
      if (act === 'follow'){ M.nav('orch', [S.selKey]); return; }
      if (act === 'history'){ M.nav('history', [], {key: S.selKey}); return; }
      var id = el.getAttribute('data-id');
      if (!id) return;
      var latest = S.turns.length ? S.turns[S.turns.length-1].id : null;
      if (id === latest) M.nav('orch', [S.selKey]);       // newest chip = follow mode
      else M.nav('orch', [S.selKey, id]);                  // pin an older turn
    });
    document.getElementById('steplist').addEventListener('click', function(e){
      var el = e.target.closest ? e.target.closest('.step') : null;
      if (el) selectStep(Number(el.getAttribute('data-step')));
    });
    document.getElementById('graph').addEventListener('click', function(e){
      var el = e.target.closest ? e.target.closest('.badge') : null;
      if (!el) return;
      if (el.getAttribute('data-act') === 'steps'){
        var steps = document.getElementById('steps');
        if (window.innerWidth <= 699) M.ui.setSheet(steps, 'half');
        return;
      }
      selectStep(Number(el.getAttribute('data-step')));
    });
    document.getElementById('dclose').onclick = function(){ S.selStep=null; renderGraph(); applyStepSel(); renderDetail(); };
    document.getElementById('dbody').addEventListener('click', function(e){
      if (!e.target.getAttribute || !e.target.getAttribute('data-copy')) return;
      e.preventDefault(); e.stopPropagation();
      var det = e.target.closest('details');
      var pre = det ? det.querySelector('pre') : null;
      if (pre) M.copyText(pre.textContent, e.target);
    });
    document.getElementById('stepsgrab').onclick = function(){ M.ui.cycleSheet(document.getElementById('steps')); };

    // pan/zoom: drag + wheel + buttons; camera lives on the svg viewBox attribute,
    // never in innerHTML, so graph rebuilds don't reset it
    var svg = document.getElementById('graph');
    var pan = null;
    svg.addEventListener('pointerdown', function(e){
      if (e.target.closest && e.target.closest('.badge')) return;
      pan = {x:e.clientX, y:e.clientY, cx:S.cam.x, cy:S.cam.y};
      svg.classList.add('panning');
      if (svg.setPointerCapture) try{ svg.setPointerCapture(e.pointerId); }catch(err){}
    });
    svg.addEventListener('pointermove', function(e){
      if (!pan) return;
      var r = svg.getBoundingClientRect();
      var scale = (1160/S.cam.k) / r.width;
      S.cam.x = pan.cx - (e.clientX-pan.x)*scale;
      S.cam.y = pan.cy - (e.clientY-pan.y)*scale;
      applyCam();
    });
    var endPan = function(){ pan=null; svg.classList.remove('panning'); };
    svg.addEventListener('pointerup', endPan);
    svg.addEventListener('pointercancel', endPan);
    svg.addEventListener('wheel', function(e){
      e.preventDefault();
      zoom(e.deltaY < 0 ? 1.2 : 1/1.2);
    }, {passive:false});
    document.getElementById('zoomin').onclick = function(){ zoom(1.3); };
    document.getElementById('zoomout').onclick = function(){ zoom(1/1.3); };
    document.getElementById('zoomfit').onclick = function(){ S.cam={x:0,y:0,k:1}; applyCam(); };
    function zoom(f){
      var k2 = Math.min(6, Math.max(0.4, S.cam.k*f));
      var w1=1160/S.cam.k, h1=S.baseH/S.cam.k, w2=1160/k2, h2=S.baseH/k2;
      S.cam.x += (w1-w2)/2; S.cam.y += (h1-h2)/2; S.cam.k = k2;
      applyCam();
    }
  }

  var wired = false;
  M.views.orch = {
    tickEvery: 4000,
    enter: function(params, query){
      if (!wired){ wired = true; wire(); }
      M.ui.setNavButton(true, function(){ M.ui.openDrawer(document.getElementById('side')); });
      var key = params[0] || null;
      var turnId = params[1] || null;
      if (key && (key !== S.selKey || (turnId||null) !== (S.follow ? null : S.selTurnId))){
        selectChat(key, turnId);
      } else if (!key && S.selKey){
        // bare #/orch: keep current selection
      }
      renderSide(); renderTurnBar(); renderGraph(); renderSteps(); renderDetail();
      this._lastTick = M.now();
      refresh();
    },
    leave: function(){
      M.ui.setNavButton(false, null);
      M.api.bump('orch:state'); M.api.bump('orch:turns'); M.api.bump('orch:turn');
    },
    tick: refresh,
    refresh: function(){
      if (S.selKey){ S.lastListAt[S.selKey] = null; loadTurns(S.selKey, true); }
      refresh();
    }
  };
})();
`;
