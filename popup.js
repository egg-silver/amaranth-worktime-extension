// 표시 전담. 계산은 background 가 끝낸 값을 그대로 쓴다.

import {
  formatDuration,
  formatClock,
  parseDate,
  lunchDeduction,
  normalizeStatus,
  buildTeamCalendar,
  shiftMonth,
  expandLeaves,
  STANDARD_MINUTES,
  LUNCH_START,
  LUNCH_END,
} from './lib/calc.js';
import { isUnread, countUnread, parseCreateDate, alertTitle } from './lib/alerts.js';
import { savedFolder } from './lib/folder-update.js';

const GW_URL = 'https://gw.goorm.io/#/';
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const VIEW_KEY = 'heroView'; // HERO_VIEWS 중 하나

const $ = (id) => document.getElementById(id);

let current = null; // 마지막으로 렌더한 status
let currentFetchedAt = null;
let heroView = 'today';
let tickTimer = null;
// 이번 달 'yyyyMM'. 다음 달로 넘어가지 못하게 막는 기준.
// 서버 응답이 실패해도 [기록] 탭은 쓸 수 있어야 하므로 로컬 시계로 먼저 채운다.
let thisMonth = (() => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
})();
let viewMonth = null; // [기록] 탭이 보고 있는 달

const openGroupware = () => chrome.tabs.create({ url: GW_URL });

function labelDate(ymd) {
  const d = parseDate(ymd);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`;
}

/** 헤더용. '2026. 9. 2. (수)' */
function headerDate(ymd) {
  const d = parseDate(ymd);
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}. (${WEEKDAYS[d.getDay()]})`;
}

/** '방금 전' / 'N분 전' / 시각 */
function relativeTime(ts) {
  if (!ts) return '-';
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return '방금 전 업데이트';
  if (min < 60) return `${min}분 전 업데이트`;
  return `${new Date(ts).toTimeString().slice(0, 5)} 업데이트`;
}

function shortDate(ymd) {
  const d = parseDate(ymd);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function showNotice(text, withAction) {
  $('today-body').hidden = true;
  $('notice').hidden = false;
  $('notice-text').textContent = text;
  $('notice-action').hidden = !withAction;
}

/** 큰 숫자 영역. 클릭이나 Alt+Shift+T 로 오늘 근무 시간과 이번 달 부족한 시간을 오간다. */
/**
 * 히어로에 담을 값. 사람마다 궁금한 게 달라서 눌러 가며 바꾼다.
 * 고른 값은 저장되어 다음에 열 때도 유지된다.
 */
const HERO_VIEWS = ['today', 'leave', 'month'];

function heroContent(status, view) {
  const day = status.dailyMinutes || STANDARD_MINUTES;
  const dayPct = day > 0 ? Math.min(1, status.todayWorked / day) : 0;
  const monthPct = status.progressRatio || 0;
  const dayBar = {
    fill: dayPct,
    left: `${formatDuration(Math.max(0, day - status.todayWorked))} 남음`,
    right: `${formatDuration(day)} 중 ${Math.round(dayPct * 100)}%`,
  };

  if (view === 'leave') {
    // 몇 시에 나갈 수 있는지만 보면 되는 사람
    const at = status.estimatedLeave ?? status.dailyLeave;
    return {
      label: '퇴근 가능 시각',
      value: at != null ? formatClock(at) : status.state === 'done' ? '퇴근 완료' : '출근 전',
      pill: `권장 ${formatDuration(status.todayTarget || day)}`,
      sub:
        status.comeMinutes != null
          ? `${formatClock(status.comeMinutes)} 출근 · 휴게 12–13시 제외`
          : '출근을 찍으면 계산됩니다',
      bar: { ...dayBar, left: `${formatDuration(status.todayWorked)} 근무` },
    };
  }

  if (view === 'month') {
    // 월 단위로 관리하는 사람
    return {
      label: '이번 달 누적',
      value: formatDuration(status.accumulated),
      pill: status.remainingWorkDays > 0 ? `남은 ${status.remainingWorkDays}일` : '',
      sub: `소정 ${formatDuration(status.monthStandard)}${
        status.shortage > 0 ? ` · ${formatDuration(status.shortage)} 부족` : ' · 다 채웠어요'
      }`,
      bar: {
        fill: monthPct,
        left: `${Math.round(monthPct * 100)}% 채움`,
        right: `/ ${formatDuration(status.monthStandard)}`,
      },
    };
  }

  // 기본값 — 지금까지 얼마나 일했나
  let value;
  let sub;
  if (status.state === 'before') {
    value = '출근 전';
    sub = `오늘 권장 ${formatDuration(status.todayTarget || day)}`;
  } else {
    value = formatDuration(status.todayWorked);
    const parts = [`${formatClock(status.comeMinutes)} 출근`];
    if (status.state === 'done' && status.leaveMinutes != null) {
      parts.push(`${formatClock(status.leaveMinutes)} 퇴근`);
    } else if (status.estimatedLeave != null) {
      parts.push(`${formatClock(status.estimatedLeave)} 퇴근 가능`);
    }
    sub = parts.join(' · ');
  }
  const leaveAt = status.estimatedLeave ?? status.dailyLeave;
  return {
    label: '오늘 근무 시간',
    value,
    pill: status.state !== 'done' && leaveAt != null ? `${formatClock(leaveAt)} 퇴근` : '',
    sub,
    bar: dayBar,
  };
}

function renderHero(status) {
  const view = HERO_VIEWS.includes(heroView) ? heroView : HERO_VIEWS[0];
  const c = heroContent(status, view);

  $('hero-label').textContent = c.label;
  $('hero').textContent = c.value;
  $('hero-sub').textContent = c.sub;
  $('hero-pill').textContent = c.pill || '';
  $('bar-fill').style.width = `${Math.round(c.bar.fill * 100)}%`;
  $('bar-left').textContent = c.bar.left;
  $('bar-right').textContent = c.bar.right;
}

function renderToday(rawStatus, fetchedAt, staleNote) {
  const status = normalizeStatus(rawStatus);
  current = status;
  if (fetchedAt !== undefined) currentFetchedAt = fetchedAt;
  $('notice').hidden = true;
  $('today-body').hidden = false;

  const stateEl = $('state');
  stateEl.className = 'state';
  if (status.state === 'working') {
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    if (nowMin >= LUNCH_START && nowMin < LUNCH_END) {
      stateEl.classList.add('is-break');
      $('state-text').textContent = '휴게 중';
    } else {
      stateEl.classList.add('is-working');
      $('state-text').textContent = '근무 중';
    }
  } else if (status.state === 'done') {
    stateEl.classList.add('is-done');
    $('state-text').textContent = '퇴근';
  } else {
    $('state-text').textContent = '출근 전';
  }

  $('date').textContent = headerDate(status.today);

  renderHero(status);

  $('daily-label').textContent = `${formatDuration(status.dailyMinutes)} 기준`;
  $('today-remaining').textContent =
    status.todayRemainingByDaily > 0 ? formatDuration(status.todayRemainingByDaily) : '다 채웠어요';

  const balanceEl = $('balance');
  if (status.balance == null) {
    balanceEl.className = '';
    balanceEl.textContent = '-';
  } else {
    const rounded = Math.round(status.balance);
    balanceEl.className = rounded > 0 ? 'balance-plus' : rounded < 0 ? 'balance-minus' : '';
    balanceEl.textContent =
      rounded === 0 ? '0분' : `${rounded > 0 ? '+' : '−'}${formatDuration(Math.abs(rounded))}`;
  }

  $('shortage').textContent = status.shortage > 0 ? formatDuration(status.shortage) : '다 채웠어요';
  $('remaining').textContent =
    status.monthWorkDays != null
      ? `${status.remainingWorkDays}/${status.monthWorkDays}일`
      : `${status.remainingWorkDays}일`;

  const warn = $('warn');
  const notes = [];
  if (status.missingLeave.length) {
    notes.push(
      `퇴근 미등록 <b>${status.missingLeave.length}일</b> — ${status.missingLeave
        .map(shortDate)
        .join(', ')}`
    );
  }
  if (staleNote) notes.push(staleNote);
  warn.hidden = notes.length === 0;
  if (notes.length) {
    warn.innerHTML = '';
    warn.appendChild(icon('alert'));
    const body = document.createElement('span');
    body.innerHTML = notes.join('<br>');
    warn.appendChild(body);
  }

  const rule = status.workRule;
  $('work-rule').hidden = !rule;
  if (rule) {
    $('rule-name').textContent = rule.typeName && rule.typeName !== rule.name
      ? `${rule.name} (${rule.typeName})`
      : rule.name || '-';
    $('rule-standard').textContent = formatDuration(rule.standardMinutes);
  }

  $('fetched').textContent = relativeTime(currentFetchedAt);
}

function renderLeaves(leaves = []) {
  const section = $('leave-section');
  const list = $('leave-list');
  list.innerHTML = '';
  section.hidden = leaves.length === 0;
  if (!leaves.length) return;

  for (const leave of leaves) {
    const li = document.createElement('li');
    const day = document.createElement('span');
    day.className = 'day';
    const from = leave.start.slice(0, 8);
    const to = (leave.end || leave.start).slice(0, 8);
    day.textContent = from === to ? labelDate(from) : `${labelDate(from)} ~ ${labelDate(to)}`;

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = fullLeaveName(leave.name);

    li.append(day, name);
    list.appendChild(li);
  }
}

/** 달력 칸에 넣을 짧은 시간 표기. 8시간 6분 → '8:06' */
function shortHours(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

/**
 * 근무시간을 농도 4단계로. 색을 여럿 쓰는 대신 한 색의 농도로 읽히게 한다.
 * 기준은 그날 소정 근로시간이다.
 */
function heatLevel(worked, standard) {
  const base = standard > 0 ? standard : STANDARD_MINUTES;
  const ratio = worked / base;
  if (ratio >= 1.1) return 'lv4';
  if (ratio >= 0.95) return 'lv3';
  if (ratio >= 0.6) return 'lv2';
  return 'lv1';
}

/** 달력 칸에 들어갈 짧은 휴가 이름. '오전반차' → '반차' */
function shortLeaveName(name) {
  if (!name) return null;
  if (name.includes('반반차')) return '반반차';
  if (name.includes('반차')) return '반차';
  if (name.length <= 3) return name;
  return name.slice(0, 3);
}

/** 목록에 쓸 이름. 오전·오후를 살린다. '오전반차' → '반차 (오전)' */
function fullLeaveName(name) {
  if (!name) return '';
  const half = name.includes('반반차') ? '반반차' : name.includes('반차') ? '반차' : null;
  if (!half) return name;
  if (name.startsWith('오전')) return `${half} (오전)`;
  if (name.startsWith('오후')) return `${half} (오후)`;
  return half;
}

/** 좁은 칸에 들어갈 공휴일 이름. '대체공휴일(개천절)' → '대체휴일' */
function shortHolidayName(name) {
  if (!name) return null;
  if (name.startsWith('대체')) return '대체휴일';
  const base = name.replace(/연휴$/, '');
  return base.length <= 4 ? base : base.slice(0, 4);
}

/** 소수점 연차를 사람이 읽는 형태로. 11.946 → '11.9' */
function formatDays(n) {
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function renderAnnualLeave(annual) {
  const box = $('leave-balance');
  const remain = $('leave-remain');

  if (!annual) {
    box.hidden = true;
    remain.textContent = '';
    return;
  }

  box.hidden = false;
  $('lb-num').textContent = formatDays(annual.remaining);
  $('lb-used').textContent = `총 ${formatDays(annual.total)}일 중 ${formatDays(annual.used)}일 사용`;

  // 연차는 종류별로 따로 쌓인다. 합계만 보면 무엇이 남았는지 알 수 없다.
  const kinds = [
    ['일반 연차', annual.basic],
    ['보상 휴가', annual.compensation],
    ['대체 휴가', annual.substitute],
  ].filter(([, b]) => b && b.total > 0);

  const list = $('lb-kinds');
  list.innerHTML = '';
  // 한 종류뿐이면 큰 숫자와 같은 말이라 굳이 나누지 않는다.
  list.hidden = kinds.length < 2;
  for (const [label, b] of kinds) {
    const li = document.createElement('li');
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = label;
    const v = document.createElement('span');
    v.className = b.remaining > 0 ? 'v' : 'v is-zero';
    v.textContent = `${formatDays(b.remaining)}일`;
    li.append(k, v);
    list.appendChild(li);
  }

  const old = box.querySelector('.lb-pending');
  if (old) old.remove();
  if (annual.pending > 0) {
    const chip = document.createElement('p');
    chip.className = 'lb-pending';
    chip.textContent = `결재 중 ${formatDays(annual.pending)}일`;
    box.appendChild(chip);
  }

  remain.textContent = `${formatDays(annual.remaining)}일 남음`;
}

/** 칸 하나가 무슨 날인지 한 문장으로. 색만으로 상태를 전하지 않기 위한 것. */
function calCellLabel(cell) {
  const parts = [labelDate(cell.date)];
  if (cell.holidayName) parts.push(cell.holidayName);
  if (cell.leaveName) parts.push(cell.leaveName);
  if (cell.missingLeave) parts.push('퇴근 미등록');
  else if (cell.worked > 0) parts.push(`${formatDuration(cell.worked)} 근무`);
  return parts.join(', ');
}

function renderDayDetail(cell) {
  // 안내 문구는 달력 위에 늘 붙여 둔다. 감췄다 보였다 하면 달력이 위아래로 튄다.
  const box = $('day-detail');
  if (!cell) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'd-date';
  title.textContent = labelDate(cell.date) + (cell.holidayName ? ` · ${cell.holidayName}` : '');
  box.appendChild(title);

  const add = (text, cls = 'd-row') => {
    const row = document.createElement('div');
    row.className = cls;
    row.textContent = text;
    box.appendChild(row);
  };

  if (cell.leaveName) add(cell.leaveName, 'd-leave');
  if (cell.missingLeave) add(`출근 ${formatClock(cell.come)} → 퇴근 미등록`);
  else if (cell.come != null && cell.leaveAt != null) {
    add(`${formatClock(cell.come)} → ${formatClock(cell.leaveAt)}`);
    add(`인정 근무 ${formatDuration(cell.worked)}`);
  } else if (cell.isHoliday || cell.weekend) add(cell.resultName || '휴일');
  else if (cell.isFuture) add('아직 지나지 않은 날이에요');
  else add(cell.resultName || '기록 없음');
}

function renderCalendar(calendar, status) {
  const grid = $('cal-grid');
  grid.innerHTML = '';
  renderDayDetail(null);

  if (!calendar?.weeks) {
    return;
  }

  for (const week of calendar.weeks) {
    for (const cell of week) {
      if (!cell) {
        const blank = document.createElement('div');
        blank.className = 'cal-cell empty';
        grid.appendChild(blank);
        continue;
      }
      // 누를 수 있는 칸은 진짜 button 이어야 키보드로도 쓸 수 있다.
      const el = document.createElement('button');
      el.type = 'button';

      const classes = ['cal-cell'];
      if (cell.weekday === 0) classes.push('sun');
      if (cell.isHoliday) classes.push('holiday');
      if (!cell.isWorkday) classes.push('off');
      if (cell.isToday) classes.push('today');

      // 우선순위: 미등록(예외) > 휴가(가장 알고 싶은 것) > 근무 농도
      if (cell.missingLeave) classes.push('missing');
      else if (cell.leaveName) {
        classes.push('has-leave');
        // 종일이면 꽉 채우고, 반차는 쉬는 시간대 쪽을 채운다 — 오전 반차면 위, 오후면 아래.
        const half = cell.leaveName.includes('반반차')
          ? 'quarter'
          : cell.leaveName.includes('반차')
            ? 'half'
            : null;
        if (half) {
          const when = cell.leaveName.startsWith('오전') ? 'am' : 'pm';
          classes.push(`leave-${half}-${when}`);
        }
      } else if (cell.worked > 0) classes.push(heatLevel(cell.worked, cell.standard));

      el.className = classes.join(' ');
      el.title = [cell.holidayName, cell.leaveName].filter(Boolean).join(' · ');

      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(cell.day);
      el.appendChild(num);

      const hours = document.createElement('span');
      hours.className = 'hours';
      if (cell.missingLeave) hours.textContent = '미등록';
      else if (cell.worked > 0) hours.textContent = shortHours(cell.worked);
      else hours.innerHTML = '&nbsp;';
      el.appendChild(hours);

      // 공휴일 이름을 적어 두면 "왜 이 달 근무일이 20일인지" 가 달력에서 바로 읽힌다.
      if (!cell.leaveName && cell.holidayName) {
        const tag = document.createElement('span');
        tag.className = 'holi-tag';
        tag.textContent = shortHolidayName(cell.holidayName);
        el.appendChild(tag);
      }

      // 휴가는 점이 아니라 이름으로 보여 준다. 무슨 휴가인지가 정보다.
      if (cell.leaveName) {
        const tag = document.createElement('span');
        tag.className = 'leave-tag';
        tag.textContent = shortLeaveName(cell.leaveName);
        el.appendChild(tag);
      }

      const interactive = cell.worked > 0 || cell.missingLeave || cell.leaveName || cell.holidayName;
      if (interactive) {
        el.classList.add('clickable');
        el.setAttribute('aria-pressed', 'false');
        el.setAttribute('aria-label', calCellLabel(cell));
        el.addEventListener('click', () => {
          for (const other of grid.querySelectorAll('[aria-pressed="true"]')) {
            other.setAttribute('aria-pressed', 'false');
          }
          el.setAttribute('aria-pressed', 'true');
          renderDayDetail(cell);
        });
      } else {
        el.disabled = true;
        el.tabIndex = -1;
      }

      grid.appendChild(el);
    }
  }

  // 달력 아래 요약은 두지 않는다. 필요한 수치는 [오늘] 탭에 이미 있다.
}

const monthCache = new Map(); // 'yyyyMM' → { calendar, leaves }

const ICON_PATHS = {
  alert: '<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  cross: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  swap: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
};

/** 이모지 대신 인라인 SVG 아이콘을 만든다. */
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICON_PATHS[name] || '';
  return svg;
}

/**
 * 서비스 워커가 깨어나지 못하거나 도중에 죽으면 sendMessage 는 예외를 던진다.
 * 그대로 두면 화면이 '불러오는 중…' 에서 멈추므로 실패를 값으로 바꿔 돌려준다.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// background.js 의 BUILD 와 같은 값이어야 한다. 파일을 고칠 때 함께 올린다.
const EXPECTED_BUILD = 13;
const STALE_WORKER_MESSAGE =
  '확장을 새로고침해 주세요. chrome://extensions 에서 gw-worktime 카드의 ↻ 를 누르면 됩니다. ' +
  '(팝업은 최신인데 백그라운드가 예전 버전으로 남아 있어요)';

/** 지금 돌고 있는 서비스 워커가 이 팝업과 같은 버전인지 확인한다. */
async function checkWorker() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'ping' });
    if (!res) return 'stale'; // ping 을 모르는 예전 워커
    return res.build === EXPECTED_BUILD ? 'ok' : 'stale';
  } catch (err) {
    return 'dead'; // 워커가 아예 뜨지 않음
  }
}

async function ask(message, attempt = 0) {
  try {
    const res = await chrome.runtime.sendMessage(message);
    if (res) return res;
    // 잠들어 있던 서비스 워커는 첫 메시지를 놓치는 일이 있다. 깨어날 시간을 주고 다시 부른다.
    if (attempt < 2) {
      await wait(150 * (attempt + 1));
      return ask(message, attempt + 1);
    }
    // 응답이 비어 돌아오는 건 대개 예전 워커가 이 메시지를 모르기 때문이다.
    const state = await checkWorker();
    return {
      ok: false,
      reason: 'error',
      message:
        state === 'ok'
          ? '확장이 응답하지 않았어요. 다시 시도해 주세요.'
          : STALE_WORKER_MESSAGE,
    };
  } catch (err) {
    if (attempt < 2) {
      await wait(150 * (attempt + 1));
      return ask(message, attempt + 1);
    }
    return {
      ok: false,
      reason: 'error',
      message: `확장과 통신하지 못했어요 — ${err?.message || err}\n${STALE_WORKER_MESSAGE}`,
    };
  }
}

const REASON_TEXT = {
  'no-identity': '그룹웨어에 한 번 접속해 주세요.',
  auth: '그룹웨어 로그인이 필요해요.',
};

function failureText(res) {
  return REASON_TEXT[res?.reason] || res?.message || '기록을 가져오지 못했어요.';
}

function labelMonth(ym) {
  return `${ym.slice(0, 4)}년 ${Number(ym.slice(4, 6))}월`;
}

async function showMonth(ym) {
  viewMonth = ym;
  $('month-label').textContent = labelMonth(ym);
  // 아직 오지 않은 달은 볼 것이 없다.
  $('next-month').disabled = thisMonth != null && ym >= thisMonth;

  const cached = monthCache.get(ym);
  if (cached) {
    renderLeaves(cached.leaves);
    renderCalendar(cached.calendar, current);
    return;
  }

  $('cal-grid').innerHTML = '';
  $('record-empty').hidden = true;
  $('leave-section').hidden = true;
  renderDayDetail(null);
  $('record-loading').hidden = false;

  const res = await ask({ type: 'getRecords', month: ym });
  if (viewMonth !== ym) return; // 그 사이 사용자가 다른 달로 옮겼다

  $('record-loading').hidden = true;
  if (!res.ok) {
    $('record-empty').hidden = false;
    $('record-empty').textContent = failureText(res);
    return;
  }

  monthCache.set(ym, { calendar: res.calendar, leaves: res.leaves || [] });
  renderLeaves(res.leaves || []);
  renderCalendar(res.calendar, current);
}

let teamMonth = null; // [휴가] 탭이 보고 있는 달
let teamSelected = null; // 고른 날짜
let teamDept = 'mine'; // 'all' | 'mine' | 'group' | 부서명. 기본은 내 부서
let teamGroup = []; // 내가 고른 사람 이름들
let teamRaw = null; // { leaves, holidays, myDept } — 필터를 화면에서 걸기 위해 원본을 들고 있는다
const teamCache = new Map(); // 'yyyyMM' → { leaves, holidays, myDept }
const DEPT_KEY = 'teamDept';
const GROUP_KEY = 'teamGroup';

/** 그날 쉬는 사람을 점으로. 숫자를 읽지 않아도 많고 적음이 보인다. */
function teamPips(cell) {
  const wrap = document.createElement('span');
  wrap.className = 'pips';
  // 점만 찍는다. 정확한 인원은 눌러서 명단으로 본다.
  const MAX = 6;
  for (const person of cell.people.slice(0, MAX)) {
    const pip = document.createElement('i');
    pip.className = 'pip' + (person.isMe ? ' is-me' : '');
    wrap.appendChild(pip);
  }
  return wrap;
}

function renderTeamDay(cell) {
  const list = $('team-list');
  const head = $('team-day');
  const count = $('team-count');
  list.innerHTML = '';

  if (!cell) {
    head.textContent = '날짜를 선택하세요';
    count.textContent = '';
    return;
  }

  head.textContent = labelDate(cell.date) + (cell.holidayName ? ` · ${cell.holidayName}` : '');
  count.textContent = cell.count ? `${cell.count}명` : '';

  if (!cell.count) {
    const li = document.createElement('li');
    const none = document.createElement('span');
    none.className = 'none';
    none.textContent = cell.isWorkday ? '이 날은 휴가가 없어요' : '휴일이에요';
    li.appendChild(none);
    list.appendChild(li);
    return;
  }

  for (const person of cell.people) {
    const li = document.createElement('li');
    if (person.isMe) li.className = 'is-me';

    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = person.person || '이름 없음';

    const dept = document.createElement('span');
    dept.className = 'dept';
    dept.textContent = person.dept || '';

    li.append(who, dept);
    if (person.isMe) {
      const badge = document.createElement('span');
      badge.className = 'me-badge';
      badge.textContent = '나';
      li.appendChild(badge);
    }

    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = fullLeaveName(person.name);
    li.appendChild(kind);

    list.appendChild(li);
  }
}

function renderTeamCalendar(calendar) {
  const grid = $('team-grid');
  grid.innerHTML = '';
  if (!calendar?.weeks) return;

  const cells = calendar.weeks.flat().filter(Boolean);
  let pick =
    cells.find((c) => c.date === teamSelected) ||
    cells.find((c) => c.isToday) ||
    cells.find((c) => c.count > 0) ||
    cells[0];

  for (const week of calendar.weeks) {
    for (const cell of week) {
      if (!cell) {
        const blank = document.createElement('div');
        blank.className = 'cal-cell empty';
        grid.appendChild(blank);
        continue;
      }

      const el = document.createElement('button');
      el.type = 'button';
      const classes = ['cal-cell'];
      if (cell.weekday === 0) classes.push('sun');
      if (cell.isHoliday) classes.push('holiday');
      if (!cell.isWorkday) classes.push('off');
      if (cell.isToday) classes.push('today');
      if (cell.hasMe) classes.push('has-me');
      el.className = classes.join(' ');
      el.setAttribute('aria-pressed', String(cell.date === pick?.date));
      el.setAttribute(
        'aria-label',
        `${labelDate(cell.date)}${cell.count ? `, ${cell.count}명 휴가` : ''}`
      );
      if (cell.holidayName) el.title = cell.holidayName;

      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(cell.day);
      el.appendChild(num);

      if (cell.count) el.appendChild(teamPips(cell));
      else if (cell.holidayName) {
        const tag = document.createElement('span');
        tag.className = 'holi-tag';
        tag.textContent = shortHolidayName(cell.holidayName);
        el.appendChild(tag);
      }

      el.addEventListener('click', () => {
        teamSelected = cell.date;
        for (const other of grid.querySelectorAll('[aria-pressed="true"]')) {
          other.setAttribute('aria-pressed', 'false');
        }
        el.setAttribute('aria-pressed', 'true');
        renderTeamDay(cell);
      });

      grid.appendChild(el);
    }
  }

  renderTeamDay(pick);
}

/** 고른 부서만 남긴다. 'mine' 은 내 부서. */
function filterLeaves(leaves, myDept) {
  if (teamDept === 'all') return leaves;
  if (teamDept === 'group') {
    if (!teamGroup.length) return leaves;
    const set = new Set(teamGroup);
    return leaves.filter((x) => set.has(x.person));
  }
  const want = teamDept === 'mine' ? myDept : teamDept;
  if (!want) return leaves; // 내 부서를 모르면 거르지 않는다
  return leaves.filter((x) => x.dept === want);
}

/** 보기 범위 목록을 만든다. 자주 쓰는 셋은 위로, 부서는 아래에 따로. */
function fillDeptOptions(leaves, myDept) {
  const counts = new Map();
  for (const x of leaves) {
    if (!x.dept) continue;
    counts.set(x.dept, (counts.get(x.dept) || 0) + 1);
  }

  const groupSet = new Set(teamGroup);
  const groupCount = teamGroup.length ? leaves.filter((x) => groupSet.has(x.person)).length : 0;

  const quick = [{ value: 'all', name: '전체 부서', count: leaves.length }];
  if (myDept) quick.push({ value: 'mine', name: `우리 팀 · ${myDept}`, count: counts.get(myDept) || 0 });
  if (teamGroup.length) {
    quick.push({ value: 'group', name: `내 그룹 · ${teamGroup.length}명`, count: groupCount });
  }

  const depts = [...counts]
    .filter(([d]) => d !== myDept)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ value: name, name, count }));

  // 고른 값이 사라졌으면 우리 팀으로. 우리 팀을 모를 때만 전체.
  const known = new Set([...quick, ...depts].map((o) => o.value));
  if (!known.has(teamDept)) teamDept = myDept ? 'mine' : 'all';

  const render = (items, host) => {
    host.innerHTML = '';
    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'scope-item';
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', String(item.value === teamDept));

      const tick = icon('check');
      tick.classList.add('tick');

      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = item.name;

      const ct = document.createElement('span');
      ct.className = 'ct';
      ct.textContent = `${item.count}건`;

      btn.append(tick, nm, ct);
      btn.addEventListener('click', () => {
        teamDept = item.value;
        teamSelected = null;
        chrome.storage.local.set({ [DEPT_KEY]: teamDept });
        closeScopeMenu();
        paintTeam();
      });
      host.appendChild(btn);
    }
  };

  render(quick, $('scope-quick'));
  render(depts, $('scope-list'));

  const chosen = [...quick, ...depts].find((o) => o.value === teamDept);
  $('team-scope-label').textContent = chosen?.name ?? '전체 부서';
  $('team-scope-count').textContent = chosen ? `${chosen.count}건` : '';
}

function closeScopeMenu() {
  $('scope-menu').hidden = true;
  $('team-scope').setAttribute('aria-expanded', 'false');
}

function toggleScopeMenu() {
  const menu = $('scope-menu');
  const open = menu.hidden;
  menu.hidden = !open;
  $('team-scope').setAttribute('aria-expanded', String(open));
}

function paintTeam() {
  if (!teamRaw) return;
  fillDeptOptions(teamRaw.leaves, teamRaw.myDept);
  const { leaves, holidays, myDept } = teamRaw;
  const calendar = buildTeamCalendar({
    ym: teamMonth,
    leaves: filterLeaves(leaves, myDept),
    holidays,
    today: thisMonth === teamMonth ? formatToday() : null,
  });
  renderTeamCalendar(calendar);
}

/** 오늘 'yyyyMMdd'. background 응답 없이도 달력이 오늘을 표시할 수 있게. */
function formatToday() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

let roster = null;      // 전사 명부. 한 번 받아 두고 로컬에서 검색한다.
let rosterError = null;

/** 이 달 휴가 데이터에 등장하는 사람들. 명부를 못 받았을 때의 대비책이다. */
function peopleOf(leaves) {
  const map = new Map();
  for (const x of leaves) {
    if (!x.person) continue;
    const cur = map.get(x.person) || { person: x.person, dept: x.dept || '', isMe: false };
    if (x.isMe) cur.isMe = true;
    if (!cur.dept && x.dept) cur.dept = x.dept;
    map.set(x.person, cur);
  }
  return [...map.values()];
}

/** 편집 목록의 재료. 전사 명부가 있으면 그것을, 없으면 이 달 휴가자만. */
function groupCandidates() {
  const myName = teamRaw?.leaves?.find((x) => x.isMe)?.person || '';
  const base = roster?.length ? roster : peopleOf(teamRaw?.leaves || []);
  const seen = new Set();
  const out = [];
  for (const p of base) {
    if (!p.person || seen.has(p.person)) continue;
    seen.add(p.person);
    out.push({ person: p.person, dept: p.dept || '', isMe: p.isMe || p.person === myName });
  }
  // 내가 맨 위, 그 다음은 부서 → 이름 순
  return out.sort((a, b) => {
    if (a.isMe !== b.isMe) return a.isMe ? -1 : 1;
    return a.dept.localeCompare(b.dept) || a.person.localeCompare(b.person);
  });
}

function renderGroupEditor() {
  const query = $('ge-search').value.trim();
  const all = groupCandidates();
  const picked = new Set(teamGroup);
  // 고른 사람은 검색과 무관하게 남겨 둔다. 해제하려다 놓치지 않게.
  const shown = query
    ? all.filter((p) => p.person.includes(query) || p.dept.includes(query) || picked.has(p.person))
    : all;

  const list = $('ge-list');
  list.innerHTML = '';
  $('ge-loading').hidden = !!(roster || rosterError || all.length);
  $('ge-empty').hidden = shown.length > 0 || !$('ge-loading').hidden;
  $('ge-count').textContent = String(teamGroup.length);

  let lastDept = null;
  for (const person of shown) {
    // 부서가 바뀌면 머리글을 하나 끼운다. 검색 중에는 순서가 뒤섞이니 생략.
    const head = person.isMe ? '나' : person.dept || '부서 없음';
    if (!query && head !== lastDept) {
      const li = document.createElement('li');
      li.className = 'ge-dept';
      li.textContent = head;
      list.appendChild(li);
      lastDept = head;
    }

    const li = document.createElement('li');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'ge-row';
    row.setAttribute('aria-pressed', String(picked.has(person.person)));

    const box = document.createElement('span');
    box.className = 'box';
    box.appendChild(icon('check'));

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = person.person;

    row.append(box, nm);

    if (person.isMe) {
      const me = document.createElement('span');
      me.className = 'me';
      me.textContent = '나';
      row.appendChild(me);
    }

    const dp = document.createElement('span');
    dp.className = 'dp';
    dp.textContent = person.dept;
    row.appendChild(dp);

    row.addEventListener('click', () => {
      const on = row.getAttribute('aria-pressed') === 'true';
      row.setAttribute('aria-pressed', String(!on));
      teamGroup = on
        ? teamGroup.filter((n) => n !== person.person)
        : [...teamGroup, person.person];
      chrome.storage.local.set({ [GROUP_KEY]: teamGroup });
      $('ge-count').textContent = String(teamGroup.length);
    });

    li.appendChild(row);
    list.appendChild(li);
  }
}

/** 전사 명부는 한 번만 받아 온다. 실패해도 이 달 휴가자로는 고를 수 있다. */
async function loadRoster() {
  if (roster || rosterError) return;
  const res = await ask({ type: 'getRoster' });
  if (res?.ok && Array.isArray(res.people)) roster = res.people;
  else rosterError = failureText(res) || '직원 목록을 불러오지 못했어요.';
  renderGroupEditor();
}

function toggleGroupEditor(open) {
  const box = $('group-modal');
  const show = open ?? box.hidden;
  box.hidden = !show;
  if (!show) return;
  $('ge-search').value = '';
  renderGroupEditor();
  $('ge-search').focus();
  loadRoster();
}

async function showTeamMonth(ym) {
  teamMonth = ym;
  $('team-month').textContent = labelMonth(ym);
  $('team-next').disabled = thisMonth != null && ym >= thisMonth;

  const cached = teamCache.get(ym);
  if (cached) {
    $('team-empty').hidden = true;
    teamRaw = cached;
    fillDeptOptions(cached.leaves, cached.myDept);
    paintTeam();
    return;
  }

  $('team-grid').innerHTML = '';
  $('team-list').innerHTML = '';
  $('team-day').textContent = '';
  $('team-count').textContent = '';
  $('team-empty').hidden = true;
  $('team-loading').hidden = false;

  const res = await ask({ type: 'getTeam', month: ym });
  if (teamMonth !== ym) return;

  $('team-loading').hidden = true;
  if (!res.ok) {
    $('team-empty').hidden = false;
    $('team-empty').textContent = failureText(res);
    return;
  }

  const raw = { leaves: res.leaves || [], holidays: res.holidays || [], myDept: res.myDept || null };
  teamCache.set(ym, raw);
  teamRaw = raw;
  fillDeptOptions(raw.leaves, raw.myDept);
  paintTeam();
}

const PANELS = {
  today: 'panel-today',
  records: 'panel-records',
  team: 'panel-team',
  alerts: 'panel-alerts',
  settings: 'panel-settings',
};
const TAB_ORDER = ['today', 'records', 'team', 'alerts'];

function showTab(name) {
  for (const [key, id] of Object.entries(PANELS)) $(id).hidden = key !== name;
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('is-active', tab.dataset.tab === name);
  }
  // 설정은 탭이 아니라 하단 버튼으로 연다. 어디에 있는지 알 수 있게 버튼을 눌린 상태로 둔다.
  const settingsBtn = $('open-settings');
  const inSettings = name === 'settings';
  settingsBtn.classList.toggle('is-on', inSettings);
  $('settings-label').textContent = inSettings ? '설정 닫기' : '설정';
}

function setupTabs() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      showTab(tab.dataset.tab);
      // 오늘 화면을 아직 못 받았어도 기록은 열리게 한다.
      if (tab.dataset.tab === 'records' && viewMonth == null) showMonth(thisMonth);
      if (tab.dataset.tab === 'team' && teamMonth == null) showTeamMonth(thisMonth);
      if (tab.dataset.tab === 'alerts') loadAlerts();
    });
  }
}

// ── 만든 사람 ────────────────────────────────────────
// 사람이 늘면 이 목록에만 추가하면 된다. 같은 role 끼리 묶여서 그려진다.
const CREDITS = [
  { name: 'jean.lee', role: 'founder' },
  { name: 'sammy.kim', role: 'contributor' },
];

function renderCredits() {
  const host = $('credit-list');
  host.innerHTML = '';

  const row = (role, name, cls) => {
    const box = document.createElement('div');
    box.className = cls ? `credit-row ${cls}` : 'credit-row';

    const dt = document.createElement('dt');
    dt.className = 'credit-role';
    dt.textContent = role;

    const dd = document.createElement('dd');
    dd.className = 'credit-name';
    dd.textContent = name;

    box.append(dt, dd);
    host.appendChild(box);
  };

  for (const { name, role } of CREDITS) {
    row(role, name, role === 'founder' ? 'is-founder' : '');
  }
  // 다음 사람 자리. 비워 두면 누가 채우고 싶어진다.
  row('contributor', '?', 'is-open');
}

// ── 버전 확인 ────────────────────────────────────────
// 새 버전 확인 후 사용자 요청으로 저장된 설치 폴더에 적용한다.

function renderUpdate(info) {
  const tag = $('ver-tag');
  const note = $('ver-note');
  const get = $('ver-get');

  $('ver-now').textContent = `v${info?.current ?? chrome.runtime.getManifest().version}`;
  tag.hidden = false;
  tag.className = 'ver-tag';
  get.hidden = true;

  if (!info?.ok) {
    tag.classList.add('is-unknown');
    tag.textContent = '확인 못 함';
    note.textContent = info?.message
      ? `최신 버전을 확인하지 못했어요 — ${info.message}`
      : '최신 버전을 확인하지 못했어요.';
    return;
  }

  if (info.behind) {
    tag.classList.add('is-behind');
    tag.textContent = `새 버전 v${info.latest}`;
    note.textContent = '업데이트를 누르면 저장된 설치 폴더에 적용하고 자동으로 다시 로드합니다. 폴더가 없으면 먼저 지정합니다.';
    get.hidden = false;
    return;
  }

  tag.classList.add('is-latest');
  tag.textContent = '최신';
  const when = info.checkedAt ? new Date(info.checkedAt).toTimeString().slice(0, 5) : null;
  note.textContent = when ? `최신 버전이에요. ${when} 에 확인했어요.` : '최신 버전이에요.';
}

async function loadUpdate(force = false) {
  const btn = $('ver-check');
  btn.disabled = true;
  if (force) $('ver-note').textContent = '확인하는 중…';
  const res = await ask({ type: 'checkUpdate', force });
  btn.disabled = false;
  renderUpdate(res && typeof res === 'object' ? res : null);
}

function toggleHero() {
  const i = HERO_VIEWS.indexOf(heroView);
  heroView = HERO_VIEWS[(i + 1) % HERO_VIEWS.length];
  chrome.storage.local.set({ [VIEW_KEY]: heroView });
  if (current) renderHero(current);
}

function toggleTab() {
  const visible = TAB_ORDER.find((name) => !$(PANELS[name]).hidden) ?? 'today';
  const next = TAB_ORDER[(TAB_ORDER.indexOf(visible) + 1) % TAB_ORDER.length];
  showTab(next);
  if (next === 'records' && viewMonth == null) showMonth(thisMonth);
  if (next === 'alerts') loadAlerts();
}

// ─── 알림 탭 ───────────────────────────────────────────────────────────

let alertsLoaded = false;

function formatAlertTime(createDate) {
  const d = parseCreateDate(createDate);
  if (!d) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return hm;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}. ${hm}`;
}

function renderAlertBadge(unread) {
  const badge = $('alert-badge');
  badge.hidden = unread <= 0;
  badge.textContent = unread > 99 ? '99+' : String(unread);
  $('settings-alert-icon').hidden = unread <= 0;
}

function renderAlertPoll(lastPoll) {
  const el = $('alert-poll');
  el.className = 'note';
  if (!lastPoll) {
    el.textContent = '3분마다 새 알림을 확인해요. 아직 첫 확인 전이에요.';
    return;
  }
  const at = new Date(lastPoll.at).toTimeString().slice(0, 5);
  if (!lastPoll.ok) {
    el.classList.add('is-error');
    el.textContent = `마지막 확인 ${at} · 실패: ${lastPoll.message}`;
    return;
  }
  if (lastPoll.blocked) {
    el.classList.add('is-error');
    el.textContent = `마지막 확인 ${at} · 데스크톱 알림이 차단되어 있어요. 브라우저·OS 알림 설정을 확인하세요.`;
    return;
  }
  const detail = lastPoll.baseline
    ? '기준선 설정'
    : `새 알림 ${lastPoll.notified}건` + (lastPoll.failed ? ` (${lastPoll.failed}건 실패, 다음에 재시도)` : '');
  el.textContent = `3분마다 자동 확인 · 마지막 ${at} · ${detail}`;
}

/** 열기와 읽음 처리를 background 에 함께 맡긴다. 새 창이 열리면 팝업이 바로 닫히기 때문이다. */
function openAlert(alert) {
  chrome.runtime.sendMessage(
    {
      type: 'openAlert',
      url: alert.url || '',
      alertIds: alert.alertId && isUnread(alert) ? [alert.alertId] : [],
    },
    () => void chrome.runtime.lastError
  );
}

function renderAlertList(alerts, moreYn) {
  const list = $('alert-list');
  list.innerHTML = '';
  $('alert-empty').hidden = alerts.length > 0;
  list.hidden = alerts.length === 0;

  let unread = countUnread(alerts);
  const renderCount = () => {
    $('alert-count').textContent = alerts.length
      ? `${alerts.length}건 · 안 읽음 ${unread}건${moreYn ? ' · 더 있음' : ''}`
      : '';
    renderAlertBadge(unread);
  };

  for (const alert of alerts) {
    const li = document.createElement('li');
    const isNew = isUnread(alert);
    if (isNew) li.classList.add('unread');

    // 점은 읽음 처리 전용이다. 새 창을 열지 않으므로 팝업이 유지된 채 그 자리에서 갱신된다.
    const readBtn = document.createElement('button');
    readBtn.type = 'button';
    readBtn.className = 'alert-read';
    readBtn.disabled = !isNew || !alert.alertId;
    readBtn.title = isNew ? (alert.alertId ? '읽음으로 표시' : '읽음 처리 불가') : '읽음';
    readBtn.setAttribute('aria-label', readBtn.title);
    const dot = document.createElement('span');
    dot.className = 'alert-dot';
    readBtn.appendChild(dot);

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'alert-open';
    const title = document.createElement('span');
    title.className = 'alert-title';
    title.textContent = alertTitle(alert);
    const meta = document.createElement('span');
    meta.className = 'alert-meta';
    meta.textContent = [alert.eventType, formatAlertTime(alert.createDate)].filter(Boolean).join(' · ');
    openBtn.append(title, meta);

    if (alert.url) {
      openBtn.addEventListener('click', () => openAlert(alert));
    } else {
      openBtn.disabled = true;
      openBtn.title = '연결된 링크가 없어요.';
    }

    readBtn.addEventListener('click', async () => {
      readBtn.disabled = true;
      readBtn.title = '처리 중…';
      const res = await ask({ type: 'markAlertsRead', alertIds: [alert.alertId] });
      if (res.ok) {
        li.classList.remove('unread');
        readBtn.title = '읽음';
        readBtn.setAttribute('aria-label', '읽음');
        unread = Math.max(0, unread - 1);
        renderCount();
      } else {
        readBtn.disabled = false;
        readBtn.title = '다시 시도';
        // title 은 눈에 띄지 않는다. 왜 안 됐는지 그 자리에 적는다.
        const why = document.createElement('span');
        why.className = 'alert-error';
        why.textContent = res.message || '읽음 처리를 못 했어요.';
        li.querySelector('.alert-error')?.remove();
        li.appendChild(why);
      }
    });

    li.append(readBtn, openBtn);
    list.appendChild(li);
  }
  renderCount();
}

async function loadAlerts({ force = false } = {}) {
  if (alertsLoaded && !force) return;
  $('alert-notice').hidden = true;
  $('alert-loading').hidden = alertsLoaded;

  let res;
  try {
    res = await ask({ type: 'getAlerts', force });
    $('alert-loading').hidden = true;
    if (res.ok) {
      alertsLoaded = true;
      renderAlertList((res.alerts || []).filter(Boolean), res.moreYn);
      renderAlertPoll(res.lastPoll);
      return;
    }
  } catch (err) {
    // 그리다 실패하면 빈 화면으로 남지 않게 사유를 그 자리에 보여준다.
    $('alert-loading').hidden = true;
    res = { ok: false, reason: 'error', message: `화면 그리기 실패: ${err?.message || err}`, lastPoll: res?.lastPoll };
  }

  $('alert-list').hidden = true;
  $('alert-empty').hidden = true;
  $('alert-count').textContent = '';
  renderAlertBadge(0);
  renderAlertPoll(res.lastPoll);
  const notice = $('alert-notice');
  notice.hidden = false;
  $('alert-notice-text').textContent =
    res.reason === 'auth' ? '그룹웨어 로그인이 필요해요.' : failureText(res);
  $('alert-notice-action').hidden = res.reason !== 'auth';
}

async function loadSettingsForm() {
  const stored = (await chrome.storage.local.get(['settings', 'identity'])) || {};
  const minutes = stored.settings?.dailyMinutes ?? STANDARD_MINUTES;
  $('daily-hours').value = String(minutes / 60);
  if (stored.identity?.empCd) $('emp-code').value = stored.identity.empCd;
}

async function saveSettings() {
  const hours = Number($('daily-hours').value);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) return;
  await chrome.runtime.sendMessage({
    type: 'setSettings',
    settings: { dailyMinutes: Math.round(hours * 60) },
  });
  $('settings-saved').hidden = false;
  setTimeout(() => ($('settings-saved').hidden = true), 2000);
  load(); // 새 기준으로 다시 계산
}

async function load({ force = false } = {}) {
  // 예전 서비스 워커가 남아 있으면 무엇을 물어도 엉뚱한 답이 오므로 먼저 걸러 낸다.
  const worker = await checkWorker();
  if (worker !== 'ok') {
    $('state-text').textContent = '새로고침 필요';
    showNotice(STALE_WORKER_MESSAGE, false);
    return;
  }

  const res = await ask({ type: 'getStatus', force });

  if (res.ok) {
    renderToday(res.status, res.fetchedAt);
    renderAnnualLeave(res.annualLeave || null);
    thisMonth = res.month || res.status.today.slice(0, 6);
    monthCache.set(thisMonth, { calendar: res.calendar, leaves: res.leaves || [] });
    showMonth(viewMonth ?? thisMonth);
    return;
  }

  if (res.reason === 'no-identity') {
    $('state-text').textContent = '준비 필요';
    showNotice('그룹웨어에 한 번만 접속해 주세요.\n사번을 확인한 뒤부터는 들어가지 않아도 됩니다.', true);
    return;
  }

  if (res.reason === 'auth') {
    $('state-text').textContent = '로그인 필요';
    showNotice('그룹웨어 로그인이 필요해요.', true);
    return;
  }

  // 실패했지만 직전 결과가 있으면 그거라도 보여준다.
  if (res.stale?.status) {
    const minutes = Math.round((Date.now() - res.stale.fetchedAt) / 60000);
    renderToday(res.stale.status, res.stale.fetchedAt, `새로 가져오지 못했어요 · ${minutes}분 전 정보`);
    renderAnnualLeave(res.stale.annualLeave || null);
    thisMonth = res.stale.month || res.stale.status.today.slice(0, 6);
    monthCache.set(thisMonth, { calendar: res.stale.calendar, leaves: res.stale.leaves || [] });
    showMonth(viewMonth ?? thisMonth);
    return;
  }

  $('state-text').textContent = '오류';
  showNotice(failureText(res), false);
  // 오늘 화면이 안 떠도 기록은 볼 수 있게 해 둔다.
  if (thisMonth) showMonth(viewMonth ?? thisMonth);
}

// 팝업이 열려 있는 동안만 듣는 키. 전역 단축키(manifest commands)는 쓰지 않는다.
document.addEventListener('keydown', (e) => {
  if (!e.altKey || !e.shiftKey) return;
  const key = e.key.toLowerCase();
  if (key === 't') toggleHero();
  if (key === 'e') toggleTab();
});

async function saveEmpCode() {
  const value = $('emp-code').value.trim();
  if (!/^\d{4,20}$/.test(value)) {
    $('emp-code').focus();
    return;
  }
  await ask({ type: 'setIdentity', identity: { empCd: value, coCd: '1000' } });
  monthCache.clear();
  teamCache.clear();
  teamMonth = null;
  await load({ force: true });
  runDiagnose();
}

async function runDiagnose() {
  const btn = $('diagnose');
  const list = $('diagnose-result');
  btn.disabled = true;
  btn.textContent = '확인 중…';
  list.innerHTML = '';
  list.hidden = false;

  const res = await ask({ type: 'diagnose' });
  btn.disabled = false;
  btn.textContent = '연결 진단';

  const steps = res.steps || [{ name: '진단', ok: false, detail: failureText(res) }];
  for (const s of steps) {
    const li = document.createElement('li');
    li.className = s.ok ? 'ok' : 'bad';
    const mark = icon(s.ok ? 'check' : 'cross');
    const step = document.createElement('span');
    step.className = 'step';
    step.textContent = s.name;
    const detail = document.createElement('span');
    detail.className = 'detail';
    detail.textContent = s.detail;
    li.append(mark, step, detail);
    list.appendChild(li);
  }
}

/** 캐시를 비우고 서버에서 다시 가져온다. */
async function refresh() {
  const btn = $('refresh');
  const label = $('refresh-text');
  btn.disabled = true;
  label.textContent = '가져오는 중…';
  monthCache.clear();
  teamCache.clear();
  teamMonth = null;
  try {
    await Promise.all([load({ force: true }), loadAlerts({ force: true })]);
  } finally {
    btn.disabled = false;
    label.textContent = '새로고침';
  }
}

setupTabs();
// 팝업은 포커스를 잃으면 닫힌다. 사이드패널로 옮기면 알림 창을 열어도 그대로 남는다.

$('refresh').addEventListener('click', refresh);
$('prev-month').addEventListener('click', () => showMonth(shiftMonth(viewMonth, -1)));
$('team-edit').addEventListener('click', () => {
  closeScopeMenu();
  toggleGroupEditor(true);
});
$('ge-search').addEventListener('input', renderGroupEditor);
$('ge-clear').addEventListener('click', () => {
  teamGroup = [];
  chrome.storage.local.set({ [GROUP_KEY]: teamGroup });
  renderGroupEditor();
});
document.querySelectorAll('[data-close="group"]').forEach((el) => {
  el.addEventListener('click', () => closeGroupEditor());
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('group-modal').hidden) closeGroupEditor();
});

/** 닫으면서 고른 그룹을 화면에 반영한다. */
function closeGroupEditor() {
  toggleGroupEditor(false);
  // 그룹을 만들었으면 바로 그 그룹으로 보여 준다
  if (teamGroup.length) teamDept = 'group';
  else if (teamDept === 'group') teamDept = 'all';
  chrome.storage.local.set({ [DEPT_KEY]: teamDept });
  teamSelected = null;
  paintTeam();
}

$('ge-done').addEventListener('click', () => closeGroupEditor());

$('team-scope').addEventListener('click', toggleScopeMenu);
// 바깥을 누르면 닫는다
document.addEventListener('click', (e) => {
  if (!$('scope-menu').hidden && !e.target.closest('.team-filter')) closeScopeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('scope-menu').hidden) closeScopeMenu();
});
$('team-prev').addEventListener('click', () => showTeamMonth(shiftMonth(teamMonth, -1)));
$('team-next').addEventListener('click', () => {
  const next = shiftMonth(teamMonth, 1);
  if (thisMonth == null || next <= thisMonth) showTeamMonth(next);
});
$('next-month').addEventListener('click', () => {
  const next = shiftMonth(viewMonth, 1);
  if (thisMonth == null || next <= thisMonth) showMonth(next);
});
$('hero-toggle').addEventListener('click', toggleHero);
$('open-gw').addEventListener('click', openGroupware);
$('notice-action').addEventListener('click', openGroupware);
$('alert-notice-action').addEventListener('click', openGroupware);
renderCredits();

$('ver-folder').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('update.html') });
});
savedFolder()
  .then((handle) => { $('ver-folder-check').hidden = !handle; })
  .catch(() => { $('ver-folder-check').hidden = true; });
$('ver-check').addEventListener('click', () => loadUpdate(true));
$('ver-get').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('update.html?action=install') });
});

$('open-settings').addEventListener('click', () => {
  const opening = $('panel-settings').hidden;
  if (opening) loadUpdate();
  return showTab(opening ? 'settings' : 'today');
});
$('save-settings').addEventListener('click', saveSettings);
$('diagnose').addEventListener('click', runDiagnose);
$('save-emp').addEventListener('click', saveEmpCode);

chrome.storage.local.get([DEPT_KEY, GROUP_KEY]).then((stored) => {
  if (typeof stored[DEPT_KEY] === 'string') teamDept = stored[DEPT_KEY];
  if (Array.isArray(stored[GROUP_KEY])) teamGroup = stored[GROUP_KEY];
});

chrome.storage.local.get(VIEW_KEY).then(({ [VIEW_KEY]: saved }) => {
  if (HERO_VIEWS.includes(saved)) heroView = saved;
  if (current) renderHero(current);
});

loadSettingsForm();
load();
loadAlerts();

// 근무중일 때는 화면의 진행분만 1분마다 다시 그린다. API 는 다시 부르지 않는다.
tickTimer = setInterval(() => {
  if (!current || current.state !== 'working') return;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (current.comeMinutes == null) return;
  current.todayProgress = Math.max(
    0,
    nowMin - current.comeMinutes - lunchDeduction(current.comeMinutes, nowMin)
  );
  current.accumulated = current.confirmed + current.todayProgress;
  current.todayWorked = current.todayProgress;
  current.todayRemainingByDaily = Math.max(0, current.dailyMinutes - current.todayProgress);
  current.shortage = current.monthStandard - current.accumulated;
  current.progressRatio =
    current.monthStandard > 0 ? Math.min(1, current.accumulated / current.monthStandard) : 0;
  renderToday(current);
}, 60_000);

window.addEventListener('unload', () => clearInterval(tickTimer));
