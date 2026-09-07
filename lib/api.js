// 그룹웨어 API 호출. 서명 생성과 fetch만 담당한다.

const ORIGIN = 'https://gw.goorm.io';

export class AuthError extends Error {}

async function getCookie(name) {
  const c = await chrome.cookies.get({ url: ORIGIN, name });
  return c ? decodeURIComponent(c.value) : null;
}

/** 쿠키에서 인증 재료를 꺼낸다. 하나라도 없으면 로그인이 필요한 상태다. */
export async function readCredentials() {
  const [token, signKey] = await Promise.all([getCookie('oAuthToken'), getCookie('signKey')]);
  if (!token || !signKey) throw new AuthError('그룹웨어 로그인이 필요합니다.');
  return { token, signKey };
}

function randomTransactionId() {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * wehago-sign = Base64(HmacSHA256(token + transactionId + timestamp + pathname, signKey))
 * 프론트엔드 번들에서 확인한 규칙이다. pathname 에 쿼리스트링은 넣지 않는다.
 */
async function sign({ signKey, token, transactionId, timestamp, pathname }) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(signKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const buf = await crypto.subtle.sign('HMAC', key, enc.encode(token + transactionId + timestamp + pathname));
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

/**
 * 서명을 붙여 POST 한다.
 *
 * 쿠키 동봉 여부는 API 마다 다르다. 근태 API 는 쿠키가 실리면 서버가
 * 601(허용된 쿠키 인증 URL이 아님)로 거절하고, 알림 API 는 쿠키를 함께 보내야 한다.
 */
async function request(pathname, { body, credentials, sendCookies = false, headers = {}, okResultCodes = [0] }) {
  const { token, signKey } = credentials;
  const transactionId = randomTransactionId();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await sign({ signKey, token, transactionId, timestamp, pathname });

  const res = await fetch(ORIGIN + pathname, {
    method: 'POST',
    credentials: sendCookies ? 'include' : 'omit',
    headers: {
      authorization: `Bearer ${token}`,
      timestamp,
      'transaction-id': transactionId,
      'wehago-sign': signature,
      ...headers,
    },
    body,
  });

  if (res.status === 401 || res.status === 403) throw new AuthError('그룹웨어 세션이 만료되었습니다.');
  if (!res.ok) throw new Error(`${pathname} 호출 실패 (HTTP ${res.status})`);

  // 필수 파라미터가 빠져도 에러 대신 200 + 빈 본문이 온다.
  const text = await res.text();
  if (!text) throw new Error(`${pathname} 응답이 비어 있습니다`);

  const json = JSON.parse(text);
  const ok = okResultCodes.some((code) => String(code) === String(json.resultCode));
  if (!ok) {
    throw new Error(json.resultMsg || `${pathname} 응답 오류`);
  }
  return json.resultData;
}

/** 근태 API. JSON 본문, 쿠키 없이. */
export function post(pathname, body, credentials, extraHeaders = {}) {
  return request(pathname, {
    body: JSON.stringify(body),
    credentials,
    headers: { 'content-type': 'application/json', 'access-domain': ORIGIN, ...extraHeaders },
  });
}

/** 알림 API. JSON 본문, 쿠키 동봉. */
function postWithCookies(pathname, body, credentials) {
  return request(pathname, {
    body: JSON.stringify(body),
    credentials,
    sendCookies: true,
    headers: { 'content-type': 'application/json' },
  });
}

/** 세션 정보 API. form-urlencoded 본문, 쿠키 동봉. */
function postForm(pathname, params, credentials, okResultCodes) {
  return request(pathname, {
    body: new URLSearchParams(params).toString(),
    credentials,
    sendCookies: true,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    okResultCodes,
  });
}

/** oAuthToken 은 'groupSeq|empSeq|비밀값' 형식이다. */
function seqsFromToken(token) {
  const [groupSeq, empSeq] = String(token).split('|');
  if (!groupSeq || !empSeq) throw new AuthError('oAuthToken 형식을 해석할 수 없습니다.');
  return { groupSeq, empSeq };
}

/** 오늘 출퇴근 시각 */
export function fetchTodayCommute(credentials, { empCd, coCd, workDt }) {
  return post(
    '/human/common/judgeTimeManagement/getTodayComeLeaveInfo',
    { empCd, coCd, workDt },
    credentials
  );
}

/** 'yyyyMMdd' 두 개 사이의 모든 날짜 */
function dateList(from, to) {
  const mk = (s) => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  const pad = (n) => String(n).padStart(2, '0');
  const out = [];
  for (let d = mk(from), end = mk(to); d <= end; d.setDate(d.getDate() + 1)) {
    out.push(`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`);
  }
  return out;
}

// 이 API 는 값이 없는 시각을 빈 문자열이 아니라 '----' 로 준다.
const cleanTime = (v) => (!v || v === '----' ? '' : String(v));

/**
 * 기간 내 일자별 근무 기록.
 *
 * 개인 근무시간 조회(HPD0210) 화면이 쓰는 경로다. 인사 관리 모듈의
 * `/human/hrd0410/selectTab2` 로도 같은 값을 얻을 수 있지만 그쪽은
 * 관리 권한이 있어야 해서, 권한 없는 사람에게는 동작하지 않는다.
 *
 * 요청한 날짜는 모두 행으로 돌아오지만 아직 오지 않은 날은 빈 껍데기다
 * (소정·인정 모두 0). 그래서 이번 달 남은 근무일은 따로 계산해야 한다.
 */
export async function fetchWorkRows(credentials, { empCd, coCd, from, to }) {
  const rows = await post(
    '/personal/hpd0210/getWorkTimeList',
    { coCd, empCd, atDtList: dateList(from, to) },
    credentials,
    { 'menu-code': 'HPD0210' }
  );

  // 화면과 계산이 쓰는 이름으로 맞춰 둔다.
  return (rows || []).map((r) => ({
    atDt: r.atDt,
    comeTm: cleanTime(r.comeTm),
    leaveTm: cleanTime(r.leaveTm),
    basicworkTm: r.basicworkTm,
    workGroupStandardWorkTm: r.selfCommuteStandardWorkTm,
    standardworkTm: r.selfCommuteStandardWorkTm,
    exceptworkTm: r.exceptworkTm,
    attresultNm: r.attresultNm === '-' ? null : r.attresultNm,
    atNm: r.atNm,
    worktimeNm: r.workNm,
    workTpNm: r.workNm,
  }));
}

/**
 * 근태캘린더에서 본인 휴가 일정만 골라 온다.
 * 이 API 는 부서 전체 일정을 돌려주므로 partSeq 로 직접 걸러야 한다.
 * selectTab2 와 달리 앞으로 예정된 휴가도 들어 있다.
 */
/** 근태캘린더 원본을 그대로 가져온다. 부서 전체 일정이 내려온다. */
async function fetchAttendanceCalendar(credentials, identity, { from, to }) {
  // oAuthToken 이 'groupSeq|empSeq|랜덤' 형식이라 식별 정보가 없어도 여기서 뽑을 수 있다.
  const [tokenGroupSeq, tokenEmpSeq] = String(credentials.token).split('|');
  const empSeq = identity.empSeq || tokenEmpSeq;
  const groupSeq = identity.groupSeq || tokenGroupSeq;
  if (!empSeq || !groupSeq) return { empSeq: null, list: [] };

  const data = await post(
    '/schres/sc111A03',
    {
      // deptSeq 와 이메일은 비어 있어도 서버가 받아준다.
      companyInfo: {
        compSeq: identity.coCd,
        groupSeq,
        deptSeq: identity.deptSeq || '',
        emailAddr: identity.emailAddr || '',
        emailDomain: identity.emailDomain || '',
      },
      startDate: from,
      endDate: to,
      mySchYn: 'N',
      calList: [],
      tcalList: [],
      acalList: ['1'], // 근태캘린더
      searchEmpSeq: '',
      excelYn: null,
      abUID: '',
      sortDate: 'Y',
      langCode: 'kr',
    },
    credentials
  );

  return { empSeq, list: data?.resultList || [] };
}

function toLeave(x) {
  return {
    start: String(x.startDate || ''),
    end: String(x.endDate || ''),
    name: x.atNm || (x.schTitle || '').replace(/[[\]]/g, '').trim() || '휴가',
    code: x.atCd || null,
    allDay: x.alldayYn === 'Y',
  };
}

/**
 * 본인 휴가만. 이 API 는 부서 전체를 돌려주므로 partSeq 로 직접 걸러야 한다.
 * 근무 기록과 달리 앞으로 예정된 휴가도 들어 있다.
 */
export async function fetchLeaves(credentials, identity, range) {
  const { empSeq, list } = await fetchAttendanceCalendar(credentials, identity, range);
  if (!empSeq) return [];
  return list
    .filter((x) => String(x.partSeq) === String(empSeq))
    .map(toLeave)
    .sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * 팀 전체 근태 일정. 그룹웨어 일정 화면에서 보던 것과 같은 목록이다.
 * 이름과 부서가 함께 오므로 누가 언제 쉬는지 알 수 있다.
 */
export async function fetchTeamLeaves(credentials, identity, range) {
  const { empSeq, list } = await fetchAttendanceCalendar(credentials, identity, range);
  return list
    .map((x) => ({
      ...toLeave(x),
      person: x.partName || '',
      dept: x.createDeptName || '',
      isMe: empSeq != null && String(x.partSeq) === String(empSeq),
    }))
    .sort((a, b) => a.start.localeCompare(b.start) || a.person.localeCompare(b.person));
}

/**
 * 연차 현황. 회계연도 기준으로 총·사용·잔여 일수를 준다.
 * 소수점이 나온다 (입사 첫 해의 비례 연차 등).
 */
export async function fetchAnnualLeave(credentials, { empCd, coCd, date }) {
  const data = await post(
    '/human/common/annualleave/getAnnualLeaveInfoOfEmployee',
    { coCd, empCd, startDate: date, endDate: date, startTm: '0000', endTm: '0000' },
    credentials
  );
  if (!data) return null;

  // 연차는 일반·보상·대체로 나뉘어 관리된다. 합계만 보면 무엇이 남았는지 알 수 없다.
  const detail = data.annualLeaveDetail || {};
  const n = (v) => Number(v ?? 0);
  const bucket = (prefix) => {
    const total = n(detail[`${prefix}TotalCnt`]);
    const used = n(detail[`${prefix}UsedCnt`]);
    const pending = n(detail[`${prefix}ProgressCnt`]);
    return { total, used, pending, remaining: total - used - pending };
  };

  return {
    year: data.year || null,
    total: n(data.totalCnt),
    used: n(data.usedCnt),
    remaining: n(data.unusedCnt),
    pending: n(data.progressCnt), // 신청했지만 아직 처리 전
    basic: bucket('basic'), // 일반 연차
    compensation: bucket('compensation'), // 보상 휴가
    substitute: bucket('substitute'), // 대체 휴가
    periodFrom: data.applyStartDate || null,
    periodTo: data.applyEndDate || null,
  };
}

/** 법정공휴일 + 회사 지정 휴일. 달력에 이름을 띄우려고 제목도 함께 가져온다. */
export async function fetchHolidays(credentials, { coCd, from, to }) {
  const data = await post(
    '/gw/APIHandler/gw114A14',
    { startDate: from, endDate: to, compSeq: coCd },
    credentials
  );
  return (data || []).map((h) => ({ date: h.h_day, name: h.title || null }));
}

/**
 * 알림 목록. 최신순으로 온다. 긴급 알림(specialAlertList)이 앞에 붙는다.
 * timeStamp 는 페이징 커서다. 빠지면 서버가 빈 본문을 준다.
 */
export async function fetchAlerts(credentials, { pageSize = 20 } = {}) {
  const { groupSeq, empSeq } = seqsFromToken(credentials.token);
  const data = await postWithCookies(
    '/event/event02A01',
    {
      header: { groupSeq, empSeq },
      body: {
        reqType: '2',
        reqSubType: 'N',
        pageSize: String(pageSize),
        newYn: 'N',
        mentionYn: 'N',
        langCode: 'kr',
        eventType: '',
        searchType: 'received',
        timeStamp: Date.now(),
      },
    },
    credentials
  );
  return {
    moreYn: data?.moreYn === 'Y',
    alerts: [
      ...(Array.isArray(data?.specialAlertList) ? data.specialAlertList : []),
      ...(Array.isArray(data?.alertList) ? data.alertList : []),
    ],
  };
}

/**
 * 읽음 처리에 필요한 회사 정보. 세션 정보 API 에서만 얻을 수 있다.
 * 응답은 emailAdd, 읽음 처리 요청은 emailAddr 로 필드명이 다르다.
 *
 * 이미 로그인된 세션에서는 resultCode 가 0 이 아니라 200("이미 로그인된 사용자입니다")
 * 으로 온다. 그래도 sessionInfo 는 정상적으로 들어 있으므로 성공으로 받는다.
 * 이걸 오류로 처리하면 읽음 처리가 회사 정보 단계에서 통째로 막힌다.
 */
export async function fetchCompanyInfo(credentials) {
  const data = await postForm('/gw/gw050A02', { a10Domain: ORIGIN }, credentials, [0, 200]);
  const uc = data?.sessionInfo?.ucUserInfo;
  if (!uc) throw new Error('세션 정보에서 사용자 정보를 찾을 수 없습니다.');
  return {
    compSeq: uc.compSeq,
    bizSeq: uc.bizSeq,
    deptSeq: uc.deptSeq,
    emailAddr: uc.emailAdd,
    emailDomain: uc.emailDomain,
  };
}

/** 지정한 알림을 읽은 것으로 표시한다. */
export async function markAlertsRead(credentials, companyInfo, alertIds) {
  const ids = alertIds.filter(Boolean);
  if (!ids.length) return;
  const { groupSeq, empSeq } = seqsFromToken(credentials.token);
  await postWithCookies(
    '/event/event02A03',
    { header: { groupSeq, empSeq, pid: '', tid: '' }, body: { companyInfo, alertIds: ids } },
    credentials
  );
}

/**
 * 전사 직원 명부. 조직도 API 를 검색 모드로 부르되 검색어를 비워 두면
 * 회사 전체가 한 번에 온다. 겸직이면 부서 수만큼 행이 오므로 empSeq 로 합친다.
 */
export async function fetchRoster(credentials) {
  const rows = await post(
    '/gw/APIHandler/gw102A02',
    {
      orderText: '',
      orgGubun: 'd',
      popupType: 'main',
      selectedType: 'search',
      searchDiv: 'all',
      selectedId: '1000',
      searchText: '',
      isBdayOption: '2',
      isJoinDayOption: '0',
      isOrganizationDisplayOption: '5|0|1|3|',
      isGridListDisplayOption: '0',
      isLoginIdOption: '0',
    },
    credentials
  );

  const byEmp = new Map();
  for (const r of rows || []) {
    if (!r.empName) continue;
    const key = String(r.empSeq);
    const cur = byEmp.get(key) || { empSeq: key, person: r.empName, dept: '', depts: [], duty: '' };
    if (r.deptName && !cur.depts.includes(r.deptName)) cur.depts.push(r.deptName);
    if (!cur.duty && r.dutyName) cur.duty = r.dutyName;
    byEmp.set(key, cur);
  }

  return [...byEmp.values()]
    .map((x) => ({ ...x, dept: x.depts[0] || '' }))
    .sort((a, b) => a.dept.localeCompare(b.dept) || a.person.localeCompare(b.person));
}
