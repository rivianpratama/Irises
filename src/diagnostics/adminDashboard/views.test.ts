import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VIEWS, buildAppPage } from './assemble.js';
import { CORE_JS } from './views/core.js';
import { LOGIN_PAGE } from './views/login.js';

// The app page is one big TS template literal chain: a stray backtick or ${ in
// any client JS string silently truncates or corrupts the WHOLE page. This
// scanner turns that failure mode into a red test.

const JS_STRINGS: Array<[string, string]> = [
  ['core', CORE_JS],
  ...VIEWS.map(v => [`view:${v.id}`, v.js] as [string, string]),
];

test('client JS contains no backticks, no ${, and no </script', () => {
  for (const [name, js] of JS_STRINGS) {
    assert.ok(!js.includes('`'), `${name}: backtick found in client JS`);
    // eslint-disable-next-line no-template-curly-in-string
    assert.ok(!js.includes('${'), `${name}: \${ found in client JS`);
    assert.ok(!/<\/script/i.test(js), `${name}: literal </script found in client JS`);
  }
});

test('every view exports non-empty css/html/js and a unique id', () => {
  const ids = new Set<string>();
  for (const v of VIEWS) {
    assert.ok(v.id && !ids.has(v.id), `duplicate/empty view id: ${v.id}`);
    ids.add(v.id);
    assert.ok(v.css.trim().length > 0, `${v.id}: empty css`);
    assert.ok(v.html.trim().length > 0, `${v.id}: empty html`);
    assert.ok(v.js.trim().length > 0, `${v.id}: empty js`);
  }
});

test('assembled page contains every view section, tab, and the boot call', () => {
  const page = buildAppPage();
  for (const v of VIEWS) {
    assert.ok(page.includes(`id="view-${v.id}"`), `missing section for ${v.id}`);
    assert.ok(page.includes(`data-view="${v.id}"`), `missing tab for ${v.id}`);
  }
  assert.ok(page.includes('MD.boot();'), 'missing boot call');
  assert.ok(page.includes('id="toasts"'), 'missing toast root');
  assert.ok(page.includes('id="backdrop"'), 'missing backdrop');
  // exactly one script block, closed once
  assert.equal(page.split('<script>').length, 2, 'expected exactly one <script> block');
  assert.equal(page.split('</script>').length, 2, 'expected exactly one closing </script>');
});

// The Inner-state view is the operator surface for the three earned-material stores (the read, the
// moments, the hook rhythm). A panel that is defined and never called from render() renders nothing
// and fails no other test in this file, so each one is pinned as DEFINED AND CALLED — two
// occurrences of its name — and the order they appear in is the order a reply builds on them.
test('the Inner state view defines and calls the thesis, moments and rhythm panels', () => {
  const js = VIEWS.find(v => v.id === 'affect')?.js ?? '';
  assert.ok(js, 'no affect view');
  for (const panel of ['thesisPanel', 'momentsPanel', 'rhythmPanel']) {
    assert.ok(js.includes(`function ${panel}(`), `${panel} is not defined`);
    assert.ok(js.split(`${panel}(`).length >= 3, `${panel} is defined but never called from render()`);
  }
  const order = ['dialsPanel(d)', 'thesisPanel(d)', 'momentsPanel(d)', 'rhythmPanel(d)', 'threadsPanel(d)']
    .map(call => js.lastIndexOf(call));
  assert.deepEqual(
    order.slice().sort((a, b) => a - b), order,
    'the three panels render after Relationship climate and before Threads',
  );
  // The two file-backed panels branch on their store's degraded read BEFORE they claim the store is
  // empty (api/affect.ts `ThesisSummary.degraded`, `MomentsFileState`). An unreadable file hands the
  // route the same zero rows an absent one does, and rendering "nothing kept about them yet" over it
  // would be the one confidently inverted answer this page can give.
  assert.ok(js.includes('t.degraded'), 'the thesis panel does not read its degraded flag');
  assert.ok(js.includes('f.degraded'), 'the moments panel does not read its degraded flag');
  assert.ok(js.includes('d.momentsFile'), 'the moments panel does not read the file state at all');
});

test('login page stays standalone and self-closing', () => {
  assert.ok(LOGIN_PAGE.includes('/dashboard/login'));
  assert.equal(LOGIN_PAGE.split('<script>').length, 2);
});
