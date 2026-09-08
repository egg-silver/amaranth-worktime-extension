// 팀원 출근 공유 코드. 서버가 없으니 사람이 코드를 주고받아 등록한다.
//
// 코드 = 'GWA1:' + base64url(JSON({ m: [{ n: 이름, e: 근태사번 }, ...] }))
// 한 명짜리도 같은 형식이라, 붙여넣기는 여러 줄·여러 코드를 한꺼번에 받아 합친다.

const PREFIX = 'GWA1:';

// 근태 사번은 숫자만. 형식이 어긋나면 등록을 막아 엉뚱한 조회를 예방한다.
export function isValidEmpCd(v) {
  return /^\d{6,12}$/.test(String(v || '').trim());
}

function toBase64Url(str) {
  const b64 = typeof btoa === 'function'
    ? btoa(unescape(encodeURIComponent(str)))
    : Buffer.from(str, 'utf8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const str = typeof atob === 'function'
    ? decodeURIComponent(escape(atob(b64)))
    : Buffer.from(b64, 'base64').toString('utf8');
  return str;
}

/** 사람 목록 → 코드 하나. */
export function encodeMembers(members) {
  const m = (members || [])
    .filter((x) => x && isValidEmpCd(x.empCd))
    .map((x) => ({ n: String(x.name || '').slice(0, 20), e: String(x.empCd).trim() }));
  return PREFIX + toBase64Url(JSON.stringify({ m }));
}

/** 한 사람 → 코드 하나. 공유 버튼이 쓴다. */
export function encodeMember(name, empCd) {
  return encodeMembers([{ name, empCd }]);
}

/**
 * 붙여넣은 텍스트에서 사람을 뽑는다. 여러 코드가 섞여 있어도 된다.
 * 코드가 아니면 조용히 건너뛴다. 반환은 { name, empCd } 배열.
 */
export function decodeMembers(text) {
  const out = [];
  const seen = new Set();
  // 구분자 없이 GWA1:...GWA1:... 로 붙여 넣어도 쪼갠다.
  // base64url 에는 ':' 가 없으므로 'GWA1:' 앞에 공백을 넣으면 경계가 정확하다.
  const tokens = String(text || '').replace(/GWA1:/g, ' GWA1:').split(/[\s,]+/).filter(Boolean);
  for (const tok of tokens) {
    if (!tok.startsWith(PREFIX)) continue;
    let parsed;
    try {
      parsed = JSON.parse(fromBase64Url(tok.slice(PREFIX.length)));
    } catch {
      continue;
    }
    for (const item of parsed?.m || []) {
      const empCd = String(item?.e || '').trim();
      if (!isValidEmpCd(empCd) || seen.has(empCd)) continue;
      seen.add(empCd);
      out.push({ name: String(item?.n || '').slice(0, 20) || empCd, empCd });
    }
  }
  return out;
}


/**
 * 붙여넣기 상자 통합 파서. 공유 코드(GWA1:)와 맨숫자 사번을 섞어 넣어도 된다.
 *   "20250001 20250001 GWA1:xxxx" → 중복 없이 합쳐서 [{name, empCd}]
 * 코드에는 이름이 들어 있고, 맨숫자는 이름을 모르니 사번을 이름 자리에 둔다.
 */
export function parseMemberInput(text) {
  const out = [];
  const seen = new Set();
  const push = (name, empCd) => {
    const cd = String(empCd).trim();
    if (!isValidEmpCd(cd) || seen.has(cd)) return;
    seen.add(cd);
    out.push({ name: String(name || '').slice(0, 20) || cd, empCd: cd });
  };

  let pendingName = null;
  const consume = (tok) => {
    if (!tok) return;
    if (tok.startsWith(PREFIX)) {
      pendingName = null;
      for (const m of decodeMembers(tok)) push(m.name, m.empCd);
    } else if (isValidEmpCd(tok)) {
      push(pendingName, tok); // 앞에 이름이 있었으면 그 이름으로
      pendingName = null;
    } else {
      pendingName = tok; // 숫자가 아니면 다음 사번에 붙일 이름 후보
    }
  };

  // 이름·사번이 붙어 있으면 글자↔숫자 경계에서 쪼갠다. "홍길동20250001" → "홍길동" "20250001"
  const splitGlued = (t) =>
    t.replace(/(\D)(\d)/g, '$1 $2').replace(/(\d)(\D)/g, '$1 $2').split(/\s+/).filter(Boolean);

  // 구분자 없이 붙인 코드부터 떼어 낸다. base64url 엔 ':' 가 없어 경계가 정확하다.
  const spaced = String(text || '').replace(/GWA1:/g, ' GWA1:');
  for (const rawTok of spaced.split(/[\s,\t]+/).filter(Boolean)) {
    if (rawTok.startsWith(PREFIX)) {
      // 코드 뒤에 이름·사번이 공백 없이 붙었을 수 있다. payload(base64url)까지만 코드로.
      const m = rawTok.match(/^(GWA1:[A-Za-z0-9_-]+)([\s\S]*)$/);
      if (m) {
        consume(m[1]);
        for (const p of splitGlued(m[2])) consume(p);
      }
      continue;
    }
    for (const p of splitGlued(rawTok)) consume(p);
  }
  return out;
}

/**
 * 사번 → 이름 역추적. 사번 앞 8자리가 입사일이고, 조직도에 각자 입사일이 있다.
 * 그 날 입사한 사람이 딱 한 명이면 그 이름을, 겹치거나 없으면 null 을 준다.
 * roster: [{ person, joinDate }]
 */
export function nameForEmpCd(empCd, roster) {
  const jd = String(empCd || '').slice(0, 8);
  if (!/^\d{8}$/.test(jd)) return null;
  const matches = (roster || []).filter((p) => p.joinDate === jd);
  return matches.length === 1 ? matches[0].person : null;
}

/**
 * 사번이 실제로 있을 법한지. 사번 앞 8자리(입사일)가 조직도에 있는 날짜면 통과.
 * 뒤 2자리(순번)까지는 조직도로 확인할 수 없어, 입사일 존재만으로 오타·가짜를 거른다.
 * 조직도가 없으면(roster 비어 있으면) 막지 않는다(true).
 */
export function empCdPlausible(empCd, roster) {
  if (!roster || !roster.length) return true;
  const jd = String(empCd || '').slice(0, 8);
  if (!/^\d{8}$/.test(jd)) return false;
  return roster.some((p) => p.joinDate === jd);
}
