// Login page — served to unauthenticated requests. Standalone (no shared theme):
// it must render even if the app page assembly ever breaks.

export const LOGIN_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Irises · admin</title>
<style>
:root{--bg:#0b0d12;--card:#151923;--line:#252b3a;--acc:#6ea8fe;--err:#ff6b6b;--fg:#e7eaf0;--mut:#8b93a7}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 -apple-system,system-ui,sans-serif;background:radial-gradient(1200px 600px at 50% -10%,#141a2b 0%,var(--bg) 60%);color:var(--fg);display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:2.2rem;width:min(360px,92vw);box-shadow:0 20px 60px rgba(0,0,0,.5)}
h1{font-size:1.15rem;margin:0 0 .3rem}.sub{color:var(--mut);font-size:.85rem;margin-bottom:1.4rem}
input{width:100%;background:#0e1119;color:var(--fg);border:1px solid var(--line);border-radius:10px;padding:.7rem .9rem;font:inherit;margin-bottom:.9rem}
input:focus{outline:none;border-color:var(--acc)}
button{width:100%;background:var(--acc);color:#0b0d12;border:0;border-radius:10px;padding:.7rem;font:inherit;font-weight:700;cursor:pointer}
button:hover{filter:brightness(1.1)}
.err{color:var(--err);font-size:.85rem;min-height:1.2rem;margin:.4rem 0 0}
</style></head><body>
<div class="card">
  <h1>🏡 Irises · Admin Dashboard</h1>
  <div class="sub">Orchestration monitor — enter the admin password.</div>
  <form id="f">
    <input id="pw" type="password" placeholder="password" autofocus autocomplete="current-password">
    <button type="submit">Enter</button>
    <div class="err" id="err"></div>
  </form>
</div>
<script>
document.getElementById('f').onsubmit = async function(ev){
  ev.preventDefault();
  var err = document.getElementById('err'); err.textContent = '';
  try{
    var r = await fetch('/dashboard/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})});
    if(r.ok){ location.reload(); return; }
    var j = await r.json().catch(function(){return {};});
    err.textContent = j.error || 'login failed';
  }catch(e){ err.textContent = 'network error'; }
};
</script></body></html>`;
