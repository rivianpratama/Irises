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

test('login page stays standalone and self-closing', () => {
  assert.ok(LOGIN_PAGE.includes('/dashboard/login'));
  assert.equal(LOGIN_PAGE.split('<script>').length, 2);
});
