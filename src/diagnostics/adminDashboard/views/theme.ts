// Shared CSS: palette, shell chrome, and the responsive primitives every view
// composes (.cards grid, .tablewrap, .drawer, .sheet, toasts). Two breakpoints:
// tablet ≤1099px, phone ≤699px. View-specific rules live in each view module.

export const THEME_CSS = `
:root{--bg:#0b0d12;--panel:#12151d;--card:#171b26;--line:#252b3a;--fg:#e7eaf0;--mut:#8b93a7;--acc:#6ea8fe;--ok:#5bd6a0;--warn:#ffb454;--err:#ff6b6b}
*{box-sizing:border-box}html,body{height:100%}
/* the hidden attribute must beat any author display rule (display:flex/block on sections, buttons) */
[hidden]{display:none !important}
body{margin:0;font:13.5px/1.5 -apple-system,system-ui,sans-serif;background:var(--bg);color:var(--fg);display:flex;flex-direction:column;overflow:hidden;height:100dvh}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
header{display:flex;align-items:center;gap:.6rem;padding:.5rem 1rem;border-bottom:1px solid var(--line);background:var(--panel);flex:none;flex-wrap:wrap}
header h1{font-size:.95rem;margin:0;white-space:nowrap}
header .grow{flex:1}
#tabs{display:flex;gap:.15rem;overflow-x:auto;scrollbar-width:none;max-width:100%}
#tabs::-webkit-scrollbar{display:none}
#tabs a{padding:.28rem .65rem;border-radius:8px;color:var(--mut);font-size:.8rem;white-space:nowrap;border:1px solid transparent}
#tabs a:hover{color:var(--fg);text-decoration:none}
#tabs a.sel{color:var(--acc);border-color:var(--acc);background:#151d2e}
.pill{font-size:.72rem;padding:.15rem .55rem;border-radius:99px;border:1px solid var(--line);color:var(--mut);white-space:nowrap}
.pill.live{color:var(--ok);border-color:var(--ok)}
.pill.err{color:var(--err);border-color:var(--err)}
.pill.warn{color:var(--warn);border-color:var(--warn)}
button{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:.3rem .7rem;font:inherit;font-size:.8rem;cursor:pointer}
button:hover{border-color:var(--acc)}
button.on{border-color:var(--ok);color:var(--ok)}
button:disabled{opacity:.5;cursor:default}
input,select{background:#0e1119;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:.3rem .6rem;font:inherit;font-size:.8rem}
input:focus,select:focus{outline:none;border-color:var(--acc)}
#viewroot{flex:1;min-height:0;display:flex;flex-direction:column}
.view{flex:1;min-height:0;overflow-y:auto;padding:1rem}
.view.nopad{padding:0;overflow:hidden;display:flex;flex-direction:column}
h2.vh{font-size:.9rem;margin:.2rem 0 .8rem}
h3.sh{font-size:.78rem;margin:1.1rem 0 .5rem;color:var(--mut);letter-spacing:.06em;text-transform:uppercase}
/* cards */
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:.8rem}
.cardbox{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:.8rem .95rem;min-width:0}
.cardbox .ct{font-size:.72rem;color:var(--mut);letter-spacing:.05em;text-transform:uppercase;margin-bottom:.35rem}
.cardbox .cv{font-size:1.35rem;font-weight:700}
.cardbox .cs{font-size:.75rem;color:var(--mut);margin-top:.2rem}
/* tables */
.tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--line);border-radius:10px}
table.t{border-collapse:collapse;width:100%;min-width:560px;font-size:.78rem}
table.t th{position:sticky;top:0;background:var(--panel);text-align:left;padding:.45rem .6rem;color:var(--mut);font-weight:600;border-bottom:1px solid var(--line);white-space:nowrap;z-index:1}
table.t td{padding:.4rem .6rem;border-bottom:1px solid #1a1f2c;white-space:nowrap;vertical-align:top}
table.t tr:last-child td{border-bottom:0}
table.t tr.rowlink{cursor:pointer}
table.t tr.rowlink:hover td{background:#161b28}
/* chips + kv + sections (payload drawers) */
.chip{display:inline-block;font-size:.66rem;padding:.03rem .4rem;border-radius:6px;border:1px solid;margin-right:.3rem;vertical-align:1px}
.kv{display:flex;flex-wrap:wrap;gap:.35rem .9rem;font-size:.76rem;color:var(--mut);margin-bottom:.6rem}
.kv b{color:var(--fg);font-weight:600}
details.sec{border:1px solid var(--line);border-radius:10px;margin:.45rem 0;overflow:hidden}
details.sec>summary{cursor:pointer;padding:.45rem .7rem;background:var(--card);font-weight:600;font-size:.8rem;list-style:none;display:flex;align-items:center}
details.sec>summary .cnt{margin-left:auto;color:var(--mut);font-weight:400;font-size:.72rem}
details.sec pre{margin:0;padding:.55rem .7rem;background:#0b0e14;overflow:auto;white-space:pre-wrap;word-break:break-word;max-height:26rem;font-size:.76rem;line-height:1.45}
.copy{margin-left:.5rem;font-size:.66rem;padding:.05rem .4rem}
.prewrap{white-space:pre-wrap;word-break:break-word;font-size:.8rem;background:#0b0e14;border:1px solid var(--line);border-radius:10px;padding:.7rem .8rem;max-height:30rem;overflow:auto}
.empty{color:var(--mut);text-align:center;padding:2.2rem 1rem}
.errpanel{color:var(--err);text-align:center;padding:2rem 1rem}
.errpanel button{margin-top:.6rem;display:inline-block}
/* drawer (off-canvas left panel) + backdrop */
.backdrop{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:40;opacity:0;pointer-events:none;transition:opacity .18s}
.backdrop.open{opacity:1;pointer-events:auto}
.drawerable{}
@media (max-width:1099px){
  .drawerable{position:fixed;left:0;top:0;bottom:0;width:min(320px,85vw);z-index:50;transform:translateX(-102%);transition:transform .18s ease;box-shadow:18px 0 40px rgba(0,0,0,.45)}
  .drawerable.open{transform:none}
}
/* bottom sheet */
.sheet{background:var(--panel);border-top:1px solid var(--line)}
@media (max-width:699px){
  .sheet{position:fixed;left:0;right:0;bottom:0;z-index:45;border-radius:14px 14px 0 0;box-shadow:0 -14px 40px rgba(0,0,0,.5);display:flex;flex-direction:column;padding-bottom:env(safe-area-inset-bottom)}
  .sheet.collapsed{height:44px;overflow:hidden}
  .sheet.half{height:45dvh}
  .sheet.full{height:88dvh}
  .sheet .grab{flex:none;padding:.5rem .9rem;display:flex;align-items:center;gap:.5rem;cursor:pointer;font-size:.78rem;color:var(--mut)}
  .sheet .grab::before{content:"";width:36px;height:4px;border-radius:2px;background:var(--line);position:absolute;left:50%;transform:translateX(-50%);top:6px}
}
@media (min-width:700px){.sheet .grab{display:none}}
/* toasts */
#toasts{position:fixed;bottom:1rem;left:50%;transform:translateX(-50%);z-index:100;display:flex;flex-direction:column;gap:.4rem;align-items:center;pointer-events:none;padding-bottom:env(safe-area-inset-bottom)}
.toast{pointer-events:auto;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.5rem .9rem;font-size:.8rem;box-shadow:0 10px 30px rgba(0,0,0,.5);display:flex;gap:.7rem;align-items:center;max-width:min(480px,92vw)}
.toast.err{border-color:var(--err);color:var(--err)}
.toast button{font-size:.7rem;padding:.1rem .5rem}
/* header adjustments on small screens */
#navchats{display:none}
@media (max-width:1099px){
  header{gap:.45rem}
  #navchats.avail{display:inline-block}
}
@media (max-width:699px){
  header h1 .htext{display:none}
  .view{padding:.7rem}
}
`;
