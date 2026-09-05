import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { applyFiles, downloadUpdate, isUpdatePath, verifyInstalledFolder } from '../lib/folder-update.js';
const bytes = s => new TextEncoder().encode(s);
function filesystem(initial = {}, failPath) {
  const files = new Map(Object.entries(initial).map(([p, s]) => [p, bytes(s)]));
  let failed = false;
  const writes = [];
  function directory(prefix = '') {
    return {
      async getDirectoryHandle(name) { return directory(`${prefix}${name}/`); },
      async removeEntry(name) { files.delete(prefix + name); },
      async getFileHandle(name, { create } = {}) {
        const path = prefix + name;
        if (!files.has(path)) {
          if (!create) throw new DOMException('missing', 'NotFoundError');
          files.set(path, bytes(''));
        }
        return {
          async getFile() { return new Blob([files.get(path)]); },
          async createWritable() {
            let pending;
            return {
              async write(data) {
                if (path === failPath && !failed) { failed = true; throw new Error('disk full'); }
                pending = typeof data === 'string' ? bytes(data) : data;
              },
              async close() { writes.push(path); files.set(path, pending); },
              async abort() {},
            };
          },
        };
      },
    };
  }
  return { root: directory(), files, writes, text: path => new TextDecoder().decode(files.get(path)) };
}
test('rejects traversal and non-extension paths', () => {
  for (const path of ['../manifest.json', 'lib/../foo.js', '/popup.js', 'lib//x', '.git/config', 'README.md', 'lib/a\\b', 'test/update.js']) assert.equal(isUpdatePath(path), false, path);
  for (const path of ['manifest.json', 'lib/folder-update.js', 'fonts/a.woff2', 'update.html']) assert.equal(isUpdatePath(path), true);
});
test('writes manifest last and preserves unrelated files', async () => {
  const fs = filesystem({ 'manifest.json': 'old', 'popup.js': 'old', 'notes.txt': 'keep' });
  await applyFiles(fs.root, [{ path: 'manifest.json', data: bytes('new') }, { path: 'popup.js', data: bytes('new') }]);
  assert.deepEqual(fs.writes, ['popup.js', 'manifest.json']);
  assert.equal(fs.text('notes.txt'), 'keep');
});
test('failure restores overwritten files and removes new files', async () => {
  const fs = filesystem({ 'popup.js': 'old', 'manifest.json': 'old manifest' }, 'manifest.json');
  await assert.rejects(applyFiles(fs.root, [
    { path: 'popup.js', data: bytes('new') },
    { path: 'update.html', data: bytes('new') },
    { path: 'manifest.json', data: bytes('new') },
  ]), /복원했어요/);
  assert.equal(fs.text('popup.js'), 'old');
  assert.equal(fs.text('manifest.json'), 'old manifest');
  assert.equal(fs.files.has('update.html'), false);
});
test('wrong installation directory fails and cleans probe', async () => {
  const fs = filesystem();
  await assert.rejects(verifyInstalledFolder(fs.root, { getURL: p => p }, async () => new Response('wrong')), /설치 폴더/);
  assert.equal(fs.files.size, 0);
});
test('actual directory proof succeeds and cleans probe', async () => {
  const fs = filesystem();
  await verifyInstalledFolder(fs.root, { getURL: p => p }, async p => new Response(fs.files.get(p)));
  assert.equal(fs.files.size, 0);
});
function releaseFixture(version = '1.2.0') {
  const files = new Map(['background.js', 'content.js', 'popup.js', 'popup.html', 'popup.css'].map(p => [p, 'file']));
  files.set('manifest.json', JSON.stringify({ name: 'gw-worktime', manifest_version: 3, version }));
  const sha = 'a'.repeat(40);
  const urls = [];
  return { urls, fetcher: async url => {
    urls.push(url);
    if (url.endsWith('/releases/latest')) return Response.json({ tag_name: 'v1.2.0' });
    if (url.includes('/commits/')) return Response.json({ sha });
    if (url.includes('/git/trees/')) return Response.json({ tree: [...files].map(([path, data]) => ({ path, type: 'blob', mode: '100644', size: bytes(data).length, sha: createHash('sha1').update(`blob ${bytes(data).length}\0`).update(data).digest('hex') })) });
    assert.ok(url.includes(`/${sha}/`));
    return new Response(files.get(url.split('/').at(-1)));
  } };
}
const current = { name: 'gw-worktime', version: '1.1.0' };
test('downloads the published release pinned to a commit', async () => {
  const fixture = releaseFixture();
  const result = await downloadUpdate(current, fixture.fetcher);
  assert.equal(result.version, '1.2.0');
  assert.equal(result.files.length, 6);
});
test('rejects downgrade and failed downloads', async () => {
  await assert.rejects(downloadUpdate(current, releaseFixture('1.0.0').fetcher), /새로운 공개 릴리스/);
  await assert.rejects(downloadUpdate(current, async () => new Response('', { status: 503 })), /503/);
});

test('rejects a same-length corrupted download', async () => {
  const fixture = releaseFixture();
  await assert.rejects(downloadUpdate(current, async url => {
    if (url.includes('raw.githubusercontent.com') && url.endsWith('/popup.js')) return new Response('oops');
    return fixture.fetcher(url);
  }), /내용 검증/);
});

test('unreadable installation probe gives actionable error and cleans up', async () => {
  const fs = filesystem();
  await assert.rejects(verifyInstalledFolder(fs.root, { getURL: p => p }, async () => { throw new TypeError('Failed to fetch'); }), /설치 폴더/);
  assert.equal(fs.files.size, 0);
});
