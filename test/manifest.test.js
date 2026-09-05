// manifest 에 선언하지 않은 chrome API 를 코드가 쓰면 서비스 워커가 로드 중 죽는다.
// 실제로 manifest 의 "commands" 키를 지웠을 때 chrome.commands 가 undefined 가 되어
// background.js 전체가 뜨지 않은 적이 있다. 그 회귀를 여기서 잡는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

// 권한 없이도 쓸 수 있는 API.
// tabs·windows 는 생성 같은 기본 동작에 권한이 필요 없다 (url·title 을 읽을 때만 필요).
const ALWAYS_AVAILABLE = new Set([
  'runtime', 'i18n', 'extension', 'permissions', 'tabs', 'windows',
]);

// manifest 의 최상위 키가 있어야 열리는 API
const KEY_GATED = { commands: 'commands', action: 'action', sidePanel: 'side_panel' };

const root = new URL('../', import.meta.url);

/** 확장이 싣는 모든 소스. lib/ 도 빠뜨리면 안 된다 (chrome.cookies 가 여기 있다). */
function sourceFiles() {
  const files = ['background.js', 'popup.js', 'content.js', 'update.js'];
  for (const f of fs.readdirSync(new URL('lib/', root))) {
    if (f.endsWith('.js')) files.push(path.join('lib', f));
  }
  return files;
}

function usedChromeApis(file) {
  const src = fs.readFileSync(new URL(file, root), 'utf8');
  const used = new Set();
  for (const m of src.matchAll(/\bchrome\.([a-zA-Z]+)/g)) used.add(m[1]);
  return used;
}

test('코드가 쓰는 chrome API 가 모두 manifest 에 선언되어 있다', () => {
  const permissions = new Set(manifest.permissions || []);
  const problems = [];

  for (const file of sourceFiles()) {
    for (const api of usedChromeApis(file)) {
      if (ALWAYS_AVAILABLE.has(api)) continue;
      const declaredByPermission = permissions.has(api);
      const gateKey = KEY_GATED[api];
      const declaredByKey = gateKey ? manifest[gateKey] !== undefined : false;
      if (!declaredByPermission && !declaredByKey) {
        problems.push(`${file}: chrome.${api} 를 쓰는데 manifest 에 선언이 없다`);
      }
    }
  }

  assert.deepEqual(problems, []);
});

test('manifest 에 선언한 권한을 실제로 쓴다', () => {
  const all = new Set();
  for (const file of sourceFiles()) {
    for (const api of usedChromeApis(file)) all.add(api);
  }
  // host_permissions 로만 쓰이는 것은 코드에 chrome.X 로 나타나지 않는다
  const notCodeApis = new Set(['alarms', 'notifications']);
  const unused = (manifest.permissions || []).filter((p) => !all.has(p) && !notCodeApis.has(p));
  assert.deepEqual(unused, [], '쓰지 않는 권한은 빼는 편이 낫다');
});
