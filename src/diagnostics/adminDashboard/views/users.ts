// Users: the roster — every known handle resolved to a profile, with live
// activity and turn counts; each card links into the other dashboard
// dimensions for that user.

export const USERS_CSS = `
.ucard .uname{font-weight:700;font-size:.95rem}
.ucard .uhandle{color:var(--mut);font-size:.78rem;margin-bottom:.4rem}
.ucard .umeta{font-size:.76rem;color:var(--mut);margin:.15rem 0}
.ucard .ulinks{margin-top:.55rem;display:flex;gap:.7rem;flex-wrap:wrap;font-size:.78rem}
.ucard .live{color:var(--ok)}
`;

export const USERS_HTML = `
<h2 class="vh">Users</h2>
<div class="cards" id="users-list"><div class="empty">loading…</div></div>
`;

export const USERS_JS = `
(function(){
  var M = window.MD;
  function render(j){
    var users = j.users||[];
    var fp = users.map(function(u){ return u.handle+' '+u.turnCount+' '+(u.liveActivity?u.liveActivity.lastAt:0); }).join(',');
    M.renderIf('users:list', fp, function(){
      var root = document.getElementById('users-list');
      if (!users.length){ root.innerHTML = '<div class="empty">no users yet</div>'; return; }
      root.innerHTML = users.map(function(u){
        var links = [];
        if (u.liveActivity) links.push('<a href="'+M.buildHash('orch',[u.liveActivity.key])+'">orchestration</a>');
        links.push('<a href="'+M.buildHash('memory',[u.handle])+'">memory</a>');
        links.push('<a href="'+M.buildHash('history',[],{handle:u.handle})+'">history</a>');
        links.push('<a href="'+M.buildHash('llm',[],{since:'24h',handle:u.handle})+'">llm</a>');
        return '<div class="cardbox ucard">'
          + '<div class="uname">'+M.esc(u.name||'unnamed user')+'</div>'
          + '<div class="uhandle">'+M.esc(u.handle)+(u.factCount?(' \\u00B7 '+u.factCount+' fact'+(u.factCount>1?'s':'')):'')+'</div>'
          + (u.liveActivity
              ? '<div class="umeta live">\\u25CF active '+M.esc(M.ago(u.liveActivity.lastAt))+' ago \\u2014 '+M.esc((u.liveActivity.trigger||u.liveActivity.source||'').slice(0,70))+'</div>'
              : (u.lastSeen?('<div class="umeta">last seen '+M.esc(M.ago(u.lastSeen))+' ago</div>'):''))
          + '<div class="umeta">'+u.turnCount+' recorded turns</div>'
          + '<div class="ulinks">'+links.join('')+'</div>'
          + '</div>';
      }).join('');
    });
    M.ui.setPill(users.length+' users', null);
  }
  function load(){
    M.api.latest('users', '/dashboard/api/users').then(function(j){
      M.api.pollOk(j);
      render(j);
    }).catch(function(err){
      if (M.api.isStale(err)) return;
      M.api.pollFail();
      document.getElementById('users-list').innerHTML = '<div class="errpanel">couldn\\u2019t load users<br><button onclick="MD.views.users.tick()">retry</button></div>';
    });
  }
  M.views.users = {
    tickEvery: 30000,
    enter: function(){ this._lastTick = M.now(); load(); },
    leave: function(){ M.api.bump('users'); },
    tick: load
  };
})();
`;
