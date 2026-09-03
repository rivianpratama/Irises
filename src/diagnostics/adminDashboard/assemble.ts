import { THEME_CSS } from './views/theme.js';
import { CORE_JS } from './views/core.js';
import { ORCH_CSS, ORCH_HTML, ORCH_JS } from './views/orchestration.js';
import { TURNCOST_CSS, TURNCOST_HTML, TURNCOST_JS } from './views/turncost.js';
import { OVERVIEW_CSS, OVERVIEW_HTML, OVERVIEW_JS } from './views/overview.js';
import { LLM_CSS, LLM_HTML, LLM_JS } from './views/llm.js';
import { ERRORS_CSS, ERRORS_HTML, ERRORS_JS } from './views/errors.js';
import { USERS_CSS, USERS_HTML, USERS_JS } from './views/users.js';
import { HISTORY_CSS, HISTORY_HTML, HISTORY_JS } from './views/history.js';
import { MEMORY_CSS, MEMORY_HTML, MEMORY_JS } from './views/memory.js';
import { AFFECT_CSS, AFFECT_HTML, AFFECT_JS } from './views/affect.js';

// Assembles the single-page app served at /dashboard from the per-view template
// modules: one <style>, one section per view, one <script> (core first, then
// each view's IIFE, then boot). No bundler — plain string concatenation at boot.

export interface ViewDef {
  id: string;
  label: string;
  nopad: boolean;   // view manages its own layout (no padding, no outer scroll)
  css: string;
  html: string;
  js: string;
}

export const VIEWS: ViewDef[] = [
  { id: 'overview', label: 'Overview',      nopad: false, css: OVERVIEW_CSS, html: OVERVIEW_HTML, js: OVERVIEW_JS },
  { id: 'orch',     label: 'Orchestration', nopad: true,  css: ORCH_CSS,     html: ORCH_HTML,     js: ORCH_JS },
  { id: 'turncost', label: 'Turn cost',     nopad: true,  css: TURNCOST_CSS, html: TURNCOST_HTML, js: TURNCOST_JS },
  { id: 'llm',      label: 'LLM',           nopad: false, css: LLM_CSS,      html: LLM_HTML,      js: LLM_JS },
  { id: 'errors',   label: 'Errors',        nopad: false, css: ERRORS_CSS,   html: ERRORS_HTML,   js: ERRORS_JS },
  { id: 'users',    label: 'Users',         nopad: false, css: USERS_CSS,    html: USERS_HTML,    js: USERS_JS },
  { id: 'history',  label: 'History',       nopad: false, css: HISTORY_CSS,  html: HISTORY_HTML,  js: HISTORY_JS },
  { id: 'memory',   label: 'Memory',        nopad: true,  css: MEMORY_CSS,   html: MEMORY_HTML,   js: MEMORY_JS },
  { id: 'affect',   label: 'Inner state',   nopad: true,  css: AFFECT_CSS,   html: AFFECT_HTML,   js: AFFECT_JS },
];

export function buildAppPage(): string {
  const tabs = VIEWS.map(v => `<a href="#/${v.id}" data-view="${v.id}">${v.label}</a>`).join('');
  const sections = VIEWS.map(v =>
    `<section class="view${v.nopad ? ' nopad' : ''}" id="view-${v.id}" hidden>${v.html}</section>`
  ).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Irises · admin</title>
<style>
${THEME_CSS}
${VIEWS.map(v => v.css).join('\n')}
</style></head><body>
<header>
  <button id="navchats" title="chats">☰</button>
  <h1>🏡 <span class="htext">Irises</span></h1>
  <nav id="tabs">${tabs}</nav>
  <span class="pill" id="statuspill">loading…</span>
  <span class="pill err" id="netpill" hidden></span>
  <div class="grow"></div>
  <button id="livebtn" class="on">● live</button>
  <button id="refreshbtn">refresh</button>
  <button id="logoutbtn">logout</button>
</header>
<div id="viewroot">
${sections}
</div>
<div id="toasts"></div>
<div id="backdrop" class="backdrop"></div>
<script>
${CORE_JS}
${VIEWS.map(v => v.js).join('\n')}
MD.boot();
</script></body></html>`;
}
