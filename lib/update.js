// 새 버전이 나왔는지 확인한다. 크롬 웹스토어에 올린 확장이 아니라
// 자동 업데이트가 안 되므로, 알려 주고 받으러 갈 곳만 안내한다.

const REPO = 'egg-silver/amaranth-worktime-extension';
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;

/**
 * '1.2.10' 같은 점 구분 버전을 비교한다.
 * a 가 b 보다 높으면 1, 낮으면 -1, 같으면 0.
 */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * 최신 공개 릴리스의 v숫자 태그에서 버전을 읽는다.
 * 배포되지 않은 브랜치 버전은 업데이트로 알리지 않는다.
 */
export async function fetchLatestVersion(fetcher = fetch) {
  const res = await fetcher(LATEST_RELEASE_URL, { cache: 'no-cache', signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`버전 확인 실패 (HTTP ${res.status})`);
  const { tag_name } = await res.json();
  const version = typeof tag_name === 'string' ? tag_name.replace(/^v/, '') : '';
  if (!/^\d+(\.\d+)*$/.test(String(version || ''))) {
    throw new Error('버전 형식을 알아볼 수 없어요.');
  }
  return String(version);
}
