import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, fetchLatestVersion } from '../lib/update.js';

test('버전 비교는 자리별 숫자로 한다', () => {
  assert.equal(compareVersions('1.1.0', '1.0.1'), 1);
  assert.equal(compareVersions('1.0.1', '1.1.0'), -1);
  assert.equal(compareVersions('1.0.1', '1.0.1'), 0);
  // 문자열 비교라면 '1.10' < '1.9' 가 되어 새 버전을 놓친다
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('2', '1.9.9'), 1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
});

test('알아볼 수 없는 값이 와도 터지지 않는다', () => {
  assert.equal(compareVersions('', '1.0.0'), -1);
  assert.equal(compareVersions('abc', '0.0.0'), 0);
});

test('최신 공개 릴리스 태그를 확인한다', async () => {
  assert.equal(await fetchLatestVersion(async url => {
    assert.equal(url, 'https://api.github.com/repos/egg-silver/amaranth-worktime-extension/releases/latest');
    return Response.json({ tag_name: 'v1.2.0' });
  }), '1.2.0');
  await assert.rejects(fetchLatestVersion(async () => Response.json({ tag_name: 'v1.2.0-beta' })), /버전 형식/);
  await assert.rejects(fetchLatestVersion(async () => new Response('', { status: 404 })), /404/);
});
