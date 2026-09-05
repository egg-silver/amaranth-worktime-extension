import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('../update.js', import.meta.url), 'utf8')).replace(/^import .*;\n/, '');
async function page({ mode = 'install', stored = true, permission = 'granted', cancel = false } = {}) {
  const elements = new Map();
  const calls = [];
  const handle = {
    name: 'extension',
    queryPermission: async () => permission,
    requestPermission: async () => { calls.push('permission'); return 'granted'; },
  };
  const get = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', hidden: false, disabled: false, addEventListener(type, handler) { this[type] = handler; } });
    return elements.get(id);
  };
  const context = {
    document: { getElementById: get },
    location: { search: mode === 'install' ? '?action=install' : '' },
    URLSearchParams, fetch: () => {},
    window: { addEventListener() {}, showDirectoryPicker: async () => {
      calls.push('pick');
      if (cancel) throw Object.assign(new Error('cancel'), { name: 'AbortError' });
      return handle;
    } },
    navigator: { locks: { request: async (name, options, fn) => fn({}) } },
    chrome: { runtime: { getManifest: () => ({ version: '1.2.0' }), reload: () => calls.push('reload') } },
    savedFolder: async value => { if (value) calls.push('save'); return stored ? handle : undefined; },
    verifyInstalledFolder: async () => calls.push('verify'),
    downloadUpdate: async () => { calls.push('download'); return { version: '1.2.1', files: [] }; },
    applyFiles: async () => calls.push('apply'),
  };
  await vm.runInNewContext(`(async () => { ${source} })()`, context);
  return { get, calls };
}
test('folder settings only saves a folder without downloading', async () => {
  const p = await page({ mode: 'settings', stored: false });
  await p.get('choose').click();
  assert.deepEqual(p.calls, ['pick', 'verify', 'save']);
  assert.equal(p.get('install').hidden, true);
});
test('update with saved permission downloads, applies and reloads automatically', async () => {
  const p = await page();
  assert.deepEqual(p.calls, ['verify', 'download', 'apply', 'reload']);
});
test('update without folder waits for selection then saves and resumes', async () => {
  const p = await page({ stored: false });
  assert.deepEqual(p.calls, []);
  assert.match(p.get('status').textContent, /먼저 지정/);
  await p.get('choose').click();
  assert.deepEqual(p.calls, ['pick', 'verify', 'save', 'verify', 'download', 'apply', 'reload']);
});
test('expired permission requires a click before requesting permission', async () => {
  const p = await page({ permission: 'prompt' });
  assert.deepEqual(p.calls, []);
  assert.equal(p.get('install').textContent, '권한 허용하고 업데이트');
  await p.get('install').click();
  assert.deepEqual(p.calls, ['permission', 'verify', 'download', 'apply', 'reload']);
});
test('cancelled folder selection never downloads or reloads', async () => {
  const p = await page({ stored: false, cancel: true });
  await p.get('choose').click();
  assert.deepEqual(p.calls, ['pick']);
  assert.equal(p.get('choose').disabled, false);
});
