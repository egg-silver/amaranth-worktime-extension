import { compareVersions } from './update.js';

const API = 'https://api.github.com/repos/egg-silver/amaranth-worktime-extension';
const RAW = 'https://raw.githubusercontent.com/egg-silver/amaranth-worktime-extension';
const ROOT_FILES = new Set(['manifest.json', 'background.js', 'content.js', 'popup.js', 'popup.html', 'popup.css', 'update.html', 'update.js']);

export function isUpdatePath(path) {
  return typeof path === 'string' && !path.split('/').some(p => !p || p === '.' || p === '..' || !/^[\w.-]+$/.test(p))
    && (ROOT_FILES.has(path) || /^(lib|fonts|icons)\//.test(path));
}

export function savedFolder(value) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('gw-worktime-updater', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('settings');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('settings', value === undefined ? 'readonly' : 'readwrite');
      const store = tx.objectStore('settings');
      const op = value === undefined ? store.get('folder') : store.put(value, 'folder');
      tx.oncomplete = () => { db.close(); resolve(op.result); };
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error || new Error('폴더 저장 실패')); };
    };
  });
}

async function fileAt(root, path, create = false) {
  const parts = path.split('/');
  let dir = root;
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create });
  return { dir, name: parts.at(-1), handle: await dir.getFileHandle(parts.at(-1), { create }) };
}
async function write(handle, data) {
  const stream = await handle.createWritable();
  try { await stream.write(data); await stream.close(); }
  catch (error) { await stream.abort().catch(() => {}); throw error; }
}

// Matching manifest contents alone cannot distinguish a second copy of the extension.
export async function verifyInstalledFolder(root, runtime = chrome.runtime, fetcher = fetch) {
  const name = `update-probe-${crypto.randomUUID()}.txt`;
  const token = crypto.randomUUID();
  const handle = await root.getFileHandle(name, { create: true });
  try {
    await write(handle, token);
    const response = await fetcher(runtime.getURL(name), { cache: 'no-store' })
      .catch(() => { throw new Error('현재 실행 중인 확장의 설치 폴더를 선택해 주세요.'); });
    if (!response.ok || await response.text() !== token) throw new Error('현재 실행 중인 확장의 설치 폴더를 선택해 주세요.');
  } finally { await root.removeEntry(name); }
}

export async function downloadUpdate(current, fetcher = fetch, progress = () => {}) {
  async function json(url) {
    const res = await fetcher(url, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`업데이트 다운로드 실패 (HTTP ${res.status})`);
    return res.json();
  }
  // Resolve the published release once, then pin all downloads to its commit.
  const release = await json(`${API}/releases/latest`);
  if (typeof release.tag_name !== 'string') throw new Error('배포 버전을 확인할 수 없어요.');
  const commit = await json(`${API}/commits/${encodeURIComponent(release.tag_name)}`);
  if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw new Error('배포 커밋을 확인할 수 없어요.');
  const listing = await json(`${API}/git/trees/${commit.sha}?recursive=1`);
  if (listing.truncated || !Array.isArray(listing.tree)) throw new Error('배포 파일 목록이 불완전해요.');
  const entries = listing.tree.filter(e => e.type === 'blob' && isUpdatePath(e.path));
  if (entries.length > 500 || entries.some(e => !Number.isSafeInteger(e.size) || e.size < 0 || !/^[a-f0-9]{40}$/.test(e.sha) || (e.mode !== '100644' && e.mode !== '100755')) || entries.reduce((n, e) => n + e.size, 0) > 30 * 1024 * 1024) throw new Error('지원하지 않는 배포 파일 구성이에요.');
  const files = [];
  for (const entry of entries) {
    progress(`다운로드 중… ${files.length + 1}/${entries.length}`);
    const res = await fetcher(`${RAW}/${commit.sha}/${entry.path}`, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`${entry.path} 다운로드 실패 (HTTP ${res.status})`);
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.length !== entry.size) throw new Error(`${entry.path} 크기가 일치하지 않아요.`);
    const header = new TextEncoder().encode(`blob ${data.length}\0`);
    const blob = new Uint8Array(header.length + data.length);
    blob.set(header);
    blob.set(data, header.length);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1', blob)), b => b.toString(16).padStart(2, '0')).join('');
    if (digest !== entry.sha) throw new Error(`${entry.path} 내용 검증에 실패했어요.`);
    files.push({ path: entry.path, data });
  }
  const manifestFile = files.find(f => f.path === 'manifest.json');
  if (!manifestFile) throw new Error('배포 manifest가 없어요.');
  const manifest = JSON.parse(new TextDecoder().decode(manifestFile.data));
  if (manifest.name !== current.name || manifest.manifest_version !== 3 || (manifest.key || '') !== (current.key || '') || !/^\d+(\.\d+){0,3}$/.test(manifest.version)) throw new Error('현재 확장과 호환되지 않는 배포예요.');
  if (compareVersions(manifest.version, current.version) <= 0) throw new Error('현재 버전보다 새로운 공개 릴리스가 없어요.');
  for (const path of ['background.js', 'content.js', 'popup.js', 'popup.html', 'popup.css']) {
    if (!files.some(f => f.path === path)) throw new Error(`배포에 ${path} 파일이 없어요.`);
  }
  return { version: manifest.version, files };
}

export async function applyFiles(root, files, progress = () => {}) {
  if (!files.length || files.some(f => !isUpdatePath(f.path)) || new Set(files.map(f => f.path)).size !== files.length) throw new Error('잘못된 업데이트 파일 목록이에요.');
  // Read every backup before the first mutation. Manifest is committed last.
  const ordered = [...files].sort((a, b) => Number(a.path === 'manifest.json') - Number(b.path === 'manifest.json'));
  const backups = new Map();
  for (const file of ordered) {
    try { backups.set(file.path, new Uint8Array(await (await (await fileAt(root, file.path)).handle.getFile()).arrayBuffer())); }
    catch (error) { if (error.name !== 'NotFoundError') throw error; backups.set(file.path, null); }
  }
  const touched = [];
  try {
    for (const file of ordered) {
      progress(`파일 교체 중… ${touched.length + 1}/${ordered.length}`);
      const target = await fileAt(root, file.path, true);
      touched.push({ ...target, path: file.path });
      await write(target.handle, file.data);
    }
  } catch (error) {
    const failures = [];
    for (const target of touched.reverse()) {
      try {
        const data = backups.get(target.path);
        if (data === null) await target.dir.removeEntry(target.name);
        else await write(target.handle, data);
      } catch { failures.push(target.path); }
    }
    if (failures.length) throw new Error(`파일 복구 실패: ${failures.join(', ')}. 새로고침하지 말고 릴리스 파일을 수동으로 복원해 주세요.`, { cause: error });
    throw new Error(`업데이트 실패. 기존 파일을 복원했어요. ${error.message}`, { cause: error });
  }
}
