// 인증 → API 호출 → 계산까지. 화면은 모른다.

import {
  readCredentials,
  fetchTodayCommute,
  fetchWorkRows,
  fetchHolidays,
  fetchLeaves,
  fetchTeamLeaves,
  fetchAnnualLeave,
  fetchAlerts,
  fetchCompanyInfo,
  fetchRoster,
  markAlertsRead,
  AuthError,
} from './lib/api.js';
import { alertIdentity, alertTitle, alertContent, countUnread, isUnread } from './lib/alerts.js';
import { fetchLatestVersion, compareVersions, RELEASES_URL } from './lib/update.js';
import { setUnreadDot } from './lib/icon.js';
import {
  computeStatus,
  buildCalendar,
  buildTeamCalendar,
  formatDate,
  monthRange,
  shiftMonth,
  STANDARD_MINUTES,
} from './lib/calc.js';

const CACHE_TTL_MS = 30 * 60 * 1000; // 일자별 기록과 공휴일은 자주 바뀌지 않는다
const IDENTITY_KEY = 'identity';
const RESULT_KEY = 'lastResult';
const SETTINGS_KEY = 'settings';

// status 의 필드가 늘어나면 올린다. 예전 스키마로 저장된 결과를 그리면
// 없는 필드가 NaN 이나 잘못된 값으로 새어 나온다.
const SCHEMA_VERSION = 8;

const DEFAULT_SETTINGS = { dailyMinutes: STANDARD_MINUTES };

async function getSettings() {
  const { [SETTINGS_KEY]: saved } = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(saved || {}) };
}

async function getIdentity() {
  const { [IDENTITY_KEY]: identity } = await chrome.storage.local.get(IDENTITY_KEY);
  return identity || null;
}

async function readCache(key) {
  const { [key]: entry } = await chrome.storage.local.get(key);
  if (!entry || Date.now() - entry.savedAt > CACHE_TTL_MS) return null;
  return entry.value;
}

async function writeCache(key, value) {
  await chrome.storage.local.set({ [key]: { value, savedAt: Date.now() } });
}

/** 한 달치 원본 데이터를 모은다. 이미 받아둔 게 있으면 그것을 쓴다. */
async function fetchMonth(credentials, identity, ym) {
  const { from, to } = monthRange(ym);
  const keys = { rows: `rows:${ym}`, holidays: `holidays:${ym}`, leaves: `leaves:${ym}` };

  const [cachedRows, cachedHolidays, cachedLeaves] = await Promise.all([
    readCache(keys.rows),
    readCache(keys.holidays),
    readCache(keys.leaves),
  ]);

  const [rows, holidays, leaves] = await Promise.all([
    cachedRows ?? fetchWorkRows(credentials, { empCd: identity.empCd, coCd: identity.coCd, from, to }),
    cachedHolidays ?? fetchHolidays(credentials, { coCd: identity.coCd, from, to }),
    // 휴가 조회는 부가 기능이다. 실패해도 나머지 화면은 살아 있어야 한다.
    cachedLeaves ?? fetchLeaves(credentials, identity, { from, to }).catch(() => []),
  ]);

  if (!cachedRows) await writeCache(keys.rows, rows || []);
  if (!cachedHolidays) await writeCache(keys.holidays, holidays || []);
  if (!cachedLeaves) await writeCache(keys.leaves, leaves || []);

  return { rows: rows || [], holidays: holidays || [], leaves: leaves || [] };
}

/** 이번 달 데이터를 모아 계산한다. */
async function loadStatus() {
  const identity = await getIdentity();
  if (!identity?.empCd) {
    return { ok: false, reason: 'no-identity', message: '사번을 아직 못 읽었어요.' };
  }

  const credentials = await readCredentials();
  const settings = await getSettings();

  const now = new Date();
  const today = formatDate(now);
  const ym = today.slice(0, 6);

  const [commute, month, annualLeave] = await Promise.all([
    // 오늘 출퇴근은 캐시하지 않는다. 출근을 막 찍고 여는 경우가 많다.
    fetchTodayCommute(credentials, { empCd: identity.empCd, coCd: identity.coCd, workDt: today }),
    fetchMonth(credentials, identity, ym),
    // 연차는 부가 정보다. 실패해도 근무시간 화면은 그대로 뜬다.
    fetchAnnualLeave(credentials, { empCd: identity.empCd, coCd: identity.coCd, date: today }).catch(
      () => null
    ),
  ]);

  const status = computeStatus({
    rows: month.rows,
    holidays: month.holidays,
    today,
    nowMin: now.getHours() * 60 + now.getMinutes(),
    comeTm: commute?.comeTm || '',
    leaveTm: commute?.leaveTm || '',
    dailyMinutes: settings.dailyMinutes,
  });

  return {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    status,
    settings,
    month: ym,
    calendar: buildCalendar({ ym, rows: month.rows, holidays: month.holidays, leaves: month.leaves, today }),
    leaves: month.leaves,
    annualLeave,
    fetchedAt: Date.now(),
  };
}

/** [기록] 탭에서 다른 달을 볼 때. 계산은 하지 않고 목록만 만든다. */
async function loadRecords(ym) {
  const identity = await getIdentity();
  if (!identity?.empCd) {
    return { ok: false, reason: 'no-identity', message: '사번을 아직 못 읽었어요.' };
  }

  const credentials = await readCredentials();
  const month = await fetchMonth(credentials, identity, ym);
  const today = formatDate(new Date());

  return {
    ok: true,
    month: ym,
    calendar: buildCalendar({ ym, rows: month.rows, holidays: month.holidays, leaves: month.leaves, today }),
    leaves: month.leaves,
    fetchedAt: Date.now(),
  };
}

/** [근태] 탭. 팀 전체 휴가 일정을 달력으로 만든다. */
const ROSTER_KEY = 'roster';
const ROSTER_TTL_MS = 12 * 60 * 60 * 1000; // 조직 개편은 드물다. 하루 두 번이면 충분.

/** 전사 직원 명부. 그룹 편집 목록의 재료다. */
async function loadRoster({ force } = {}) {
  if (!force) {
    const { [ROSTER_KEY]: entry } = await chrome.storage.local.get(ROSTER_KEY);
    if (entry && Date.now() - entry.savedAt < ROSTER_TTL_MS) {
      return { ok: true, people: entry.value, fetchedAt: entry.savedAt };
    }
  }

  const credentials = await readCredentials();
  const people = await fetchRoster(credentials);
  const savedAt = Date.now();
  await chrome.storage.local.set({ [ROSTER_KEY]: { value: people, savedAt } });
  return { ok: true, people, fetchedAt: savedAt };
}

async function loadTeam(ym) {
  const identity = await getIdentity();
  if (!identity?.empCd) {
    return { ok: false, reason: 'no-identity', message: '사번을 아직 못 읽었어요.' };
  }

  const credentials = await readCredentials();
  const { from, to } = monthRange(ym);
  const keys = { team: `team:${ym}`, holidays: `holidays:${ym}` };

  const [cachedTeam, cachedHolidays] = await Promise.all([
    readCache(keys.team),
    readCache(keys.holidays),
  ]);

  const [leaves, holidays] = await Promise.all([
    cachedTeam ?? fetchTeamLeaves(credentials, identity, { from, to }),
    cachedHolidays ?? fetchHolidays(credentials, { coCd: identity.coCd, from, to }),
  ]);

  if (!cachedTeam) await writeCache(keys.team, leaves || []);
  if (!cachedHolidays) await writeCache(keys.holidays, holidays || []);

  return {
    ok: true,
    month: ym,
    calendar: buildTeamCalendar({
      ym,
      leaves: leaves || [],
      holidays: holidays || [],
      today: formatDate(new Date()),
    }),
    // 부서 필터는 화면에서 걸러 쓴다. 매번 서버에 다시 묻지 않기 위해서다.
    leaves: leaves || [],
    holidays: holidays || [],
    myDept: identity.deptName || null,
    fetchedAt: Date.now(),
  };
}

function failure(err, stale) {
  return {
    ok: false,
    reason: err instanceof AuthError ? 'auth' : 'error',
    message: err?.message || String(err) || '알 수 없는 오류',
    stale: stale || null,
  };
}

/**
 * 어디서 막혔는지 한 줄씩 확인한다. 콘솔을 열지 않고도 원인을 알 수 있게
 * 각 단계의 성공 여부와 실패 사유를 그대로 담아 돌려준다.
 */
async function diagnose() {
  const steps = [];
  const record = async (name, fn) => {
    try {
      const detail = await fn();
      steps.push({ name, ok: true, detail });
      return true;
    } catch (err) {
      steps.push({ name, ok: false, detail: err?.message || String(err) });
      return false;
    }
  };

  const identity = await getIdentity();
  steps.push({
    name: '사번 확인',
    ok: !!identity?.empCd,
    detail: identity?.empCd ? `empCd 있음 · coCd ${identity.coCd}` : '없음 — 그룹웨어에 한 번 접속하세요',
  });

  let credentials = null;
  await record('쿠키 읽기', async () => {
    credentials = await readCredentials();
    return 'oAuthToken · signKey 확보';
  });

  if (!credentials || !identity?.empCd) return { ok: true, steps };

  const now = new Date();
  const today = formatDate(now);
  const ym = today.slice(0, 6);
  const prev = monthRange(shiftMonth(ym, -1));

  await record('오늘 출퇴근', async () => {
    const r = await fetchTodayCommute(credentials, {
      empCd: identity.empCd,
      coCd: identity.coCd,
      workDt: today,
    });
    return `출근 ${r?.comeTm || '미등록'} · 퇴근 ${r?.leaveTm || '미등록'}`;
  });

  await record('지난달 기록', async () => {
    const rows = await fetchWorkRows(credentials, {
      empCd: identity.empCd,
      coCd: identity.coCd,
      from: prev.from,
      to: prev.to,
    });
    return `${prev.from.slice(0, 6)} · ${rows?.length ?? 0}행`;
  });

  await record('공휴일', async () => {
    const h = await fetchHolidays(credentials, { coCd: identity.coCd, from: prev.from, to: prev.to });
    return `${h?.length ?? 0}건`;
  });

  await record('휴가 일정', async () => {
    const l = await fetchLeaves(credentials, identity, { from: prev.from, to: prev.to });
    return `${l?.length ?? 0}건`;
  });

  return { ok: true, steps };
}

async function handleGetStatus({ force } = {}) {
  try {
    if (force) {
      const ym = formatDate(new Date()).slice(0, 6);
      await chrome.storage.local.remove([`rows:${ym}`, `holidays:${ym}`, `leaves:${ym}`, `team:${ym}`]);
    }
    const result = await loadStatus();
    if (result.ok) await chrome.storage.local.set({ [RESULT_KEY]: result });
    return result;
  } catch (err) {
    // 실패해도 직전 결과가 있으면 함께 넘겨서 팝업이 빈 화면이 되지 않게 한다.
    // 단 스키마가 다르면 버린다 — 없는 필드가 NaN 으로 화면에 새어 나온다.
    const { [RESULT_KEY]: last } = await chrome.storage.local.get(RESULT_KEY);
    return failure(err, last?.schemaVersion === SCHEMA_VERSION ? last : null);
  }
}

async function handleGetRecords({ month }) {
  try {
    return await loadRecords(month);
  } catch (err) {
    return failure(err, null);
  }
}


// ─── 알림 ─────────────────────────────────────────────────────────────
// 3분마다 알림 목록을 확인하고, 처음 본 알림만 데스크톱 알림으로 띄운다.
//
// 저장 정책
// - storage.local 은 디스크에 평문으로 남는다. 브라우저 재시작 후에도 중복 통지를
//   막아야 하는 값만 두고, 그마저도 원본 alertId 대신 해시로 저장한다.
// - 나머지(알림 상세 경로, 폴링 상태, 회사 정보)는 디스크에 남지 않는 storage.session 에 둔다.

const ALERT_ALARM = 'poll-alerts';
const ALERT_PERIOD_MINUTES = 3;
const ALERT_PAGE_SIZE = 20;

const SEEN_KEY = 'seenAlertHashes'; // storage.local — 이미 통지한 알림 식별자의 해시 (최신순)
const SEEN_MAX = 300;
const NOTI_TARGETS_KEY = 'notificationTargets'; // storage.session — notificationId → 알림 상세
const NOTI_PREFIX = 'gw-worktime:alert:';
const NOTI_MAX = 100;
const LAST_POLL_KEY = 'lastAlertPoll'; // storage.session — 팝업에 보여줄 마지막 폴링 결과
const COMPANY_INFO_KEY = 'companyInfo'; // storage.session — 읽음 처리에 필요한 회사 정보
const ALERTS_CACHE_KEY = 'lastAlerts'; // storage.session — 팝업이 바로 그릴 마지막 목록

async function getSession(key, fallback) {
  const stored = await chrome.storage.session.get(key);
  return key in stored && stored[key] != null ? stored[key] : fallback;
}

/**
 * chrome.alarms.create 는 같은 이름의 알람을 새로 만들어 타이머를 처음부터 다시 돌린다.
 * 서비스 워커가 깨어날 때마다 무조건 만들면 3분 안에 확장을 건드릴 때마다 폴링이 밀린다.
 */
async function ensureAlertAlarm() {
  const existing = await chrome.alarms.get(ALERT_ALARM);
  if (existing && existing.periodInMinutes === ALERT_PERIOD_MINUTES) return;
  await chrome.alarms.create(ALERT_ALARM, {
    periodInMinutes: ALERT_PERIOD_MINUTES,
    delayInMinutes: ALERT_PERIOD_MINUTES,
  });
}

/** 식별자를 그대로 디스크에 남기지 않기 위한 단방향 축약. 동일성 판정에는 96비트로 충분하다. */
async function digest(value) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function notificationsAllowed() {
  try {
    return (await chrome.notifications.getPermissionLevel()) === 'granted';
  } catch {
    return true;
  }
}

/** 알림 상세는 그룹웨어의 '/#/popup?...' 상대 경로로 온다. */
function openAlertWindow(path) {
  if (!path) return;
  chrome.windows.create({ url: 'https://gw.goorm.io' + path, type: 'popup', width: 1100, height: 850 });
}

async function notify(alert, hash) {
  const notificationId = NOTI_PREFIX + hash;
  await chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: alertTitle(alert),
    message: alertContent(alert),
    contextMessage: alert.eventType || '',
    // macOS 는 배너 유지 여부를 시스템 알림 스타일이 결정하므로 이 값이 무시될 수 있다.
    requireInteraction: true,
  });

  if (!alert.url && !alert.alertId) return;
  const targets = await getSession(NOTI_TARGETS_KEY, {});
  targets[notificationId] = { url: alert.url || '', alertId: alert.alertId || '' };
  const keys = Object.keys(targets);
  for (const key of keys.slice(0, Math.max(0, keys.length - NOTI_MAX))) delete targets[key];
  await chrome.storage.session.set({ [NOTI_TARGETS_KEY]: targets });
}

async function recordPoll(result) {
  const lastPoll = { at: Date.now(), ...result };
  await chrome.storage.session.set({ [LAST_POLL_KEY]: lastPoll });
  return lastPoll;
}

async function pollAlerts() {
  try {
    const credentials = await readCredentials();
    const { alerts, moreYn } = await fetchAlerts(credentials, { pageSize: ALERT_PAGE_SIZE });

    await chrome.storage.session.set({ [ALERTS_CACHE_KEY]: { alerts, moreYn, fetchedAt: Date.now() } });
    await setUnreadDot(countUnread(alerts));

    const hashes = await Promise.all(
      alerts.map(async (a) => {
        const id = alertIdentity(a);
        return id ? digest(id) : null;
      })
    );
    const present = hashes.filter(Boolean);

    // 첫 폴링은 기준선만 잡는다. 안 그러면 기존 알림이 한꺼번에 쏟아진다.
    const { [SEEN_KEY]: seenHashes } = await chrome.storage.local.get(SEEN_KEY);
    if (!Array.isArray(seenHashes)) {
      await chrome.storage.local.set({ [SEEN_KEY]: present.slice(0, SEEN_MAX) });
      return recordPoll({ ok: true, total: alerts.length, notified: 0, baseline: true });
    }

    const seen = new Set(seenHashes);
    const fresh = [];
    alerts.forEach((alert, i) => {
      if (hashes[i] && !seen.has(hashes[i])) fresh.push({ alert, hash: hashes[i] });
    });

    // 목록은 최신순이므로 뒤에서부터 띄워 오래된 알림이 먼저 쌓이게 한다.
    const failed = new Set();
    for (const { alert, hash } of [...fresh].reverse()) {
      try {
        await notify(alert, hash);
      } catch (err) {
        // 실패한 건은 seen 에 넣지 않아 다음 주기에 다시 시도된다.
        failed.add(hash);
        console.warn('[gw-worktime] 알림 생성 실패:', err?.message || err);
      }
    }

    await chrome.storage.local.set({
      [SEEN_KEY]: [...new Set([...present.filter((h) => !failed.has(h)), ...seenHashes])].slice(0, SEEN_MAX),
    });

    return recordPoll({
      ok: true,
      total: alerts.length,
      notified: fresh.length - failed.size,
      ...(failed.size ? { failed: failed.size } : {}),
      ...(fresh.length && !(await notificationsAllowed()) ? { blocked: true } : {}),
    });
  } catch (err) {
    // 로그아웃 상태는 정상이다. 폴링을 멈추지 않고 다음 주기에 다시 시도한다.
    await setUnreadDot(0);
    await chrome.storage.session.remove(ALERTS_CACHE_KEY);
    return recordPoll({ ok: false, reason: err instanceof AuthError ? 'auth' : 'error', message: err?.message || String(err) });
  }
}

/** 팝업의 [알림] 탭. 캐시가 있으면 먼저 주고, 없거나 강제면 새로 받는다. */
async function handleGetAlerts({ force } = {}) {
  const cached = force ? null : await getSession(ALERTS_CACHE_KEY, null);
  const lastPoll = await getSession(LAST_POLL_KEY, null);
  if (cached) return { ok: true, ...cached, lastPoll };

  const result = await pollAlerts();
  if (!result.ok) return { ok: false, reason: result.reason, message: result.message, lastPoll: result };
  const fresh = await getSession(ALERTS_CACHE_KEY, { alerts: [], moreYn: false, fetchedAt: Date.now() });
  return { ok: true, ...fresh, lastPoll: result };
}

async function getCompanyInfo(credentials) {
  const cached = await getSession(COMPANY_INFO_KEY, null);
  if (cached) return cached;
  const info = await fetchCompanyInfo(credentials);
  await chrome.storage.session.set({ [COMPANY_INFO_KEY]: info });
  return info;
}

/** 읽음 처리 후 목록과 아이콘을 바로 맞춘다. 다음 폴링까지 두면 읽은 알림에 점이 남는다. */
async function markRead(alertIds) {
  const ids = (alertIds || []).filter(Boolean);
  // id 가 없으면 서버에 보낼 것이 없다. 조용히 성공으로 처리하면
  // 화면만 읽음으로 바뀌고 서버는 그대로라 다시 열면 되돌아온다.
  if (!ids.length) {
    return { ok: false, message: '이 알림에는 읽음 처리에 쓸 id 가 없어요.' };
  }

  try {
    const credentials = await readCredentials();
    await markAlertsRead(credentials, await getCompanyInfo(credentials), ids);
  } catch (err) {
    return { ok: false, message: err?.message || String(err) };
  }

  // 여기까지 왔으면 서버에는 이미 반영됐다.
  // 목록 갱신은 곁다리이므로 실패해도 읽음 처리를 실패로 되돌리지 않는다.
  try {
    await pollAlerts();
  } catch (err) {
    return { ok: true, staleList: true };
  }
  return { ok: true };
}


// ─── 새 버전 확인 ─────────────────────────────────────────────────────
// 웹스토어가 아니라 zip 으로 나눠 쓰는 확장이라 크롬이 알아서 갱신해 주지 않는다.
// 12시간마다 최신 공개 릴리스를 보고, 새 버전이면 한 번만 알려 준다.

const UPDATE_ALARM = 'check-update';
const UPDATE_PERIOD_MINUTES = 12 * 60;
const UPDATE_KEY = 'updateCheck';        // storage.local — 마지막 확인 결과
const UPDATE_NOTIFIED_KEY = 'updateNotified'; // storage.local — 이미 알린 버전
const UPDATE_NOTI_ID = 'gw-worktime:update';

function currentVersion() {
  return chrome.runtime.getManifest().version;
}

async function ensureUpdateAlarm() {
  const existing = await chrome.alarms.get(UPDATE_ALARM);
  if (existing && existing.periodInMinutes === UPDATE_PERIOD_MINUTES) return;
  await chrome.alarms.create(UPDATE_ALARM, {
    periodInMinutes: UPDATE_PERIOD_MINUTES,
    delayInMinutes: 1,
  });
}

/**
 * 새 버전이 있는지 확인한다.
 * 네트워크가 막혀 있어도 확장 전체가 흔들리지 않게 실패를 값으로 돌려준다.
 */
async function checkUpdate({ notify: shouldNotify = false } = {}) {
  const current = currentVersion();
  let latest;
  try {
    latest = await fetchLatestVersion();
  } catch (err) {
    const result = { ok: false, current, url: RELEASES_URL, message: err?.message || String(err) };
    await chrome.storage.local.set({ [UPDATE_KEY]: { ...result, checkedAt: Date.now() } });
    return result;
  }

  const behind = compareVersions(latest, current) > 0;
  const result = { ok: true, current, latest, behind, url: RELEASES_URL, checkedAt: Date.now() };
  await chrome.storage.local.set({ [UPDATE_KEY]: result });

  if (shouldNotify && behind) await notifyUpdate(latest);
  return result;
}

/** 같은 버전을 두 번 알리지 않는다. */
async function notifyUpdate(latest) {
  const { [UPDATE_NOTIFIED_KEY]: already } = await chrome.storage.local.get(UPDATE_NOTIFIED_KEY);
  if (already === latest) return;
  if (!(await notificationsAllowed())) return;

  await chrome.notifications.create(UPDATE_NOTI_ID, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `새 버전 ${latest} 이 나왔어요`,
    message: '눌러서 업데이트. 설치 폴더에 적용한 뒤 자동으로 다시 로드합니다.',
    contextMessage: `지금 쓰는 버전 ${currentVersion()}`,
    requireInteraction: true,
  });
  await chrome.storage.local.set({ [UPDATE_NOTIFIED_KEY]: latest });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALERT_ALARM) pollAlerts();
  if (alarm.name === UPDATE_ALARM) checkUpdate({ notify: true });
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (notificationId === UPDATE_NOTI_ID) {
    chrome.tabs.create({ url: chrome.runtime.getURL('update.html?action=install') });
    chrome.notifications.clear(notificationId);
    return;
  }
  const targets = await getSession(NOTI_TARGETS_KEY, {});
  const target = targets[notificationId];
  if (target) openAlertWindow(target.url);
  chrome.notifications.clear(notificationId);
  delete targets[notificationId];
  await chrome.storage.session.set({ [NOTI_TARGETS_KEY]: targets });
  if (target?.alertId) await markRead([target.alertId]);
});

chrome.notifications.onClosed.addListener(async (notificationId) => {
  const targets = await getSession(NOTI_TARGETS_KEY, {});
  if (!(notificationId in targets)) return;
  delete targets[notificationId];
  await chrome.storage.session.set({ [NOTI_TARGETS_KEY]: targets });
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlertAlarm();
  ensureUpdateAlarm();
  pollAlerts();
});

// 서비스 워커가 깨어날 때 알람이 없으면(업데이트 직후 등) 다시 걸어 둔다.
ensureAlertAlarm();
ensureUpdateAlarm();

// 팝업이 "지금 돌고 있는 서비스 워커가 최신인지" 확인하는 용도.
// 팝업 파일은 열 때마다 다시 읽히지만 서비스 워커는 확장을 새로고침해야 바뀌기 때문에,
// 이 응답이 없으면 예전 워커가 남아 있다는 뜻이다.
const BUILD = 13;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'ping') {
    sendResponse({ ok: true, build: BUILD });
    return true;
  }
  if (message?.type === 'getStatus') {
    handleGetStatus(message).then(sendResponse);
    return true; // 비동기 응답
  }
  if (message?.type === 'getRecords' && message.month) {
    handleGetRecords(message).then(sendResponse);
    return true;
  }
  if (message?.type === 'getTeam' && message.month) {
    loadTeam(message.month)
      .then(sendResponse)
      .catch((err) => sendResponse(failure(err, null)));
    return true;
  }
  if (message?.type === 'checkUpdate') {
    // 팝업이 열 때마다 부르므로, 강제가 아니면 저장된 결과를 쓴다.
    (message.force
      ? checkUpdate()
      : chrome.storage.local.get(UPDATE_KEY).then(({ [UPDATE_KEY]: saved }) =>
          saved && Date.now() - saved.checkedAt < UPDATE_PERIOD_MINUTES * 60 * 1000
            ? saved
            : checkUpdate()
        )
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, current: currentVersion(), url: RELEASES_URL, message: String(err) }));
    return true;
  }
  if (message?.type === 'getRoster') {
    loadRoster({ force: message.force })
      .then(sendResponse)
      .catch((err) => sendResponse(failure(err, null)));
    return true;
  }
  if (message?.type === 'getAlerts') {
    handleGetAlerts(message)
      .then(sendResponse)
      .catch((err) => sendResponse(failure(err, null)));
    return true;
  }
  if (message?.type === 'pollAlerts') {
    pollAlerts().then(sendResponse);
    return true;
  }
  if (message?.type === 'markAlertsRead' && Array.isArray(message.alertIds)) {
    markRead(message.alertIds).then(sendResponse);
    return true;
  }
  // 창을 여는 순간 팝업이 닫히므로 읽음 처리까지 여기서 한다.
  // 응답을 먼저 돌려주고 끝내면 서비스 워커가 잠들어 읽음 처리가 서버에 닿지 않을 수 있다.
  // 끝날 때까지 채널을 열어 둬서 워커를 붙잡는다.
  if (message?.type === 'openAlert') {
    openAlertWindow(message.url);
    const ids = Array.isArray(message.alertIds) ? message.alertIds : [];
    if (!ids.length) {
      sendResponse({ ok: true });
      return false;
    }
    markRead(ids)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, message: err?.message || String(err) }));
    return true;
  }
  if (message?.type === 'diagnose') {
    diagnose()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, message: err?.message || String(err) }));
    return true;
  }
  if (message?.type === 'setIdentity' && message.identity?.empCd) {
    // 그룹웨어에서 읽어 온 값이 우선이지만, 사용자가 직접 넣은 사번도 지우지 않는다.
    getIdentity()
      .then((current) => chrome.storage.local.set({ [IDENTITY_KEY]: { ...current, ...message.identity } }))
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === 'setSettings') {
    getSettings()
      .then((current) => chrome.storage.local.set({ [SETTINGS_KEY]: { ...current, ...message.settings } }))
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

// 툴바 아이콘은 팝업을 쓰고, 사이드패널은 사용자가 따로 열 수 있게 열어 둔다.
chrome.runtime.onInstalled.addListener(() => {
  // sidePanel 은 크롬 버전에 따라 없을 수 있다. 여기서 터지면 설치 훅 전체가 죽는다.
  try {
    chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false })?.catch?.(() => {});
  } catch (e) {
    /* 사이드패널은 부가 기능이라 없어도 그만이다 */
  }
  // 확장을 새로 로드하면 예전 스키마의 캐시는 버린다.
  chrome.storage.local.remove(RESULT_KEY);
  ensureAlertAlarm();
  ensureUpdateAlarm();
  pollAlerts();
  checkUpdate();
});
