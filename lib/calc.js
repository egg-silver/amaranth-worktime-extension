// 근무시간 계산. 순수 함수만 둔다 — 네트워크도 DOM도 모른다.

export const STANDARD_MINUTES = 480; // 하루 소정 근로시간
export const LUNCH_START = 12 * 60; // 12:00
export const LUNCH_END = 13 * 60; // 13:00

/** 'yyyyMMdd' → Date (로컬 자정) */
export function parseDate(ymd) {
  return new Date(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8));
}

/** Date → 'yyyyMMdd' */
export function formatDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

// 스마데(스마트데이): 3주에 한 번, 금요일. 2026-09-11 금요일을 기준으로 21일 주기.
const SMART_ANCHOR = '20260911';

/** 그 날짜가 스마데(금요일 + 21일 주기)인가. */
export function isSmartDay(ymd) {
  const d = parseDate(ymd);
  if (d.getDay() !== 5) return false; // 금요일만
  const diff = Math.round((d - parseDate(SMART_ANCHOR)) / 86400000);
  return (((diff % 21) + 21) % 21) === 0;
}

/** 그 날짜가 속한 주(그 주 금요일)에 스마데가 있나. */
export function weekHasSmartDay(ymd) {
  const d = parseDate(ymd);
  const friday = new Date(d);
  friday.setDate(d.getDate() + (5 - d.getDay())); // 이번 주 금요일 (일=0)
  return isSmartDay(formatDate(friday));
}

/** 'HHmm' 또는 'yyyyMMddHHmm' → 자정 기준 분. 빈 값이면 null */
export function parseTimeToMinutes(t) {
  if (!t) return null;
  const s = String(t);
  const hhmm = s.length > 4 ? s.slice(-4) : s;
  if (!/^\d{4}$/.test(hhmm)) return null; // '----' 같은 자리 채움 값
  return +hhmm.slice(0, 2) * 60 + +hhmm.slice(2, 4);
}

/** 분 → '8시간 20분' */
export function formatDuration(min) {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h && rest) return `${h}시간 ${rest}분`;
  if (h) return `${h}시간`;
  return `${rest}분`;
}

/** 자정 기준 분 → '19:47' (24시를 넘기면 다음날로 감싼다) */
export function formatClock(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 두 구간이 겹치는 분 */
export function overlapMinutes(startA, endA, startB, endB) {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

/** 근무 구간 [start, end) 에서 빠지는 점심시간 */
export function lunchDeduction(start, end) {
  if (start == null || end == null || end <= start) return 0;
  return overlapMinutes(start, end, LUNCH_START, LUNCH_END);
}

/**
 * 출근시각과 순수 근무 목표시간으로 퇴근 가능 시각을 구한다.
 * 점심시간을 지나야 한다면 그만큼 뒤로 밀린다.
 */
export function estimateLeaveTime(comeMinutes, targetWorkMinutes) {
  if (comeMinutes == null) return null;
  let leave = comeMinutes + targetWorkMinutes;
  // 점심을 통과하면 그만큼 밀리고, 밀린 구간이 다시 점심에 걸릴 수 있어 한 번 더 본다.
  for (let i = 0; i < 2; i++) {
    const deduction = lunchDeduction(comeMinutes, leave);
    const next = comeMinutes + targetWorkMinutes + deduction;
    if (next === leave) break;
    leave = next;
  }
  return leave;
}

/** 이번 달의 모든 날짜를 'yyyyMMdd' 배열로 */
export function datesOfMonth(ymd) {
  const d = parseDate(ymd);
  const year = d.getFullYear();
  const month = d.getMonth();
  const last = new Date(year, month + 1, 0).getDate();
  const out = [];
  for (let day = 1; day <= last; day++) out.push(formatDate(new Date(year, month, day)));
  return out;
}

/** 'yyyyMM' → 그 달의 첫날과 마지막날 */
export function monthRange(ym) {
  const year = +ym.slice(0, 4);
  const month = +ym.slice(4, 6);
  const last = new Date(year, month, 0).getDate();
  return { from: `${ym}01`, to: `${ym}${String(last).padStart(2, '0')}` };
}

/** 'yyyyMM' 을 delta 개월 옮긴다 */
export function shiftMonth(ym, delta) {
  const d = new Date(+ym.slice(0, 4), +ym.slice(4, 6) - 1 + delta, 1);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * 휴가 일정을 날짜별로 펼친다. 여러 날짜에 걸친 연차 한 건이 각 날짜에 하나씩 붙는다.
 * start/end 는 'yyyyMMddHHmm' 이다.
 */
export function expandLeaves(leaves = []) {
  const byDate = new Map();
  for (const leave of leaves) {
    const from = leave.start.slice(0, 8);
    const to = (leave.end || leave.start).slice(0, 8);
    if (from.length !== 8) continue;
    let cursor = parseDate(from);
    const last = parseDate(to.length === 8 ? to : from);
    // 방어: 잘못된 구간이 무한 루프가 되지 않게 상한을 둔다.
    for (let i = 0; cursor <= last && i < 400; i++) {
      const key = formatDate(cursor);
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key).push(leave);
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    }
  }
  return byDate;
}

/** 주말이면 true */
export function isWeekend(ymd) {
  const day = parseDate(ymd).getDay();
  return day === 0 || day === 6;
}

const num = (v) => Number(v || 0);

/**
 * 공휴일 목록을 날짜 문자열 배열로 맞춘다.
 * 지금은 {date, name} 으로 오지만 예전 캐시에는 문자열만 들어 있다.
 */
export function holidayDates(holidays = []) {
  return holidays.map((h) => (typeof h === 'string' ? h : h?.date)).filter(Boolean);
}

/** 이번 달 근무일(빨간날을 뺀 월~금) 날짜 목록 */
export function workDatesOfMonth(ymd, holidaySet) {
  return datesOfMonth(ymd).filter((d) => !isWeekend(d) && !holidaySet.has(d));
}

/**
 * 근무일 수가 어떻게 나왔는지 설명할 재료.
 * "평일 22일 − 공휴일 2일 = 20일" 처럼 화면에서 근거를 보여주기 위한 것.
 */
export function workDayBreakdown(ymd, holidaySet) {
  const weekdays = datesOfMonth(ymd).filter((d) => !isWeekend(d));
  const holidayWeekdays = weekdays.filter((d) => holidaySet.has(d));
  return {
    weekdays: weekdays.length,
    holidayWeekdays: holidayWeekdays.length,
    holidayDates: holidayWeekdays,
    workDays: weekdays.length - holidayWeekdays.length,
  };
}

/** 달력의 앞뒤 빈 칸을 이전/다음 달 날짜로 채워 주 단위로 묶는다. */
function weeksWithOutside(ym, cells) {
  const outside = (date, m) => ({
    date,
    day: parseDate(date).getDate(),
    weekday: parseDate(date).getDay(),
    weekend: isWeekend(date),
    ym: m,
    outside: true,
  });

  const firstWeekday = cells[0].weekday;
  const prev = shiftMonth(ym, -1);
  const lead = firstWeekday === 0
    ? []
    : datesOfMonth(`${prev}01`).slice(-firstWeekday).map((d) => outside(d, prev));

  const all = [...lead, ...cells];
  const next = shiftMonth(ym, 1);
  const nextDates = datesOfMonth(`${next}01`);
  let ni = 0;
  while (all.length % 7 !== 0) all.push(outside(nextDates[ni++], next));

  const weeks = [];
  for (let i = 0; i < all.length; i += 7) weeks.push(all.slice(i, i + 7));
  return weeks;
}

/**
 * [기록] 탭 달력. 일요일 시작 주 단위로 묶는다.
 * 각 칸에 그날의 근무·휴가·휴일 정보를 담아 화면이 계산하지 않아도 되게 한다.
 */
export function buildCalendar({ ym, rows = [], holidays = [], leaves = [], today }) {
  const holidayNames = new Map(
    (holidays || []).map((h) => (typeof h === 'string' ? [h, null] : [h.date, h.name]))
  );
  const rowByDate = new Map(rows.filter((r) => r.atDt).map((r) => [r.atDt, r]));
  const leaveByDate = expandLeaves(leaves);
  const num = (v) => Number(v || 0);

  const dates = datesOfMonth(`${ym}01`);
  const cells = dates.map((date) => {
    const row = rowByDate.get(date);
    const leave = leaveByDate.get(date)?.[0] || null;
    const isHoliday = holidayNames.has(date);
    const weekend = isWeekend(date);
    return {
      date,
      day: parseDate(date).getDate(),
      weekday: parseDate(date).getDay(),
      weekend,
      isHoliday,
      holidayName: holidayNames.get(date) || null,
      isWorkday: !weekend && !isHoliday,
      isToday: date === today,
      isFuture: today != null && date > today,
      smartDay: isSmartDay(date),
      worked: row ? num(row.basicworkTm) : null,
      standard: row ? num(row.workGroupStandardWorkTm) : null,
      come: row ? parseTimeToMinutes(row.comeTm) : null,
      leaveAt: row ? parseTimeToMinutes(row.leaveTm) : null,
      // 오늘은 아직 퇴근 전이라 '미등록'이 아니다(진행 중). 지난 날 출근만 있고 퇴근이 없을 때만 미등록.
      missingLeave: !!row?.comeTm && !row?.leaveTm && date !== today,
      leaveName: row?.atNm || leave?.name || null,
      resultName: row?.attresultNm || null,
    };
  });

  // 앞뒤 빈 칸을 이전/다음 달 날짜로 채운다(달력처럼). 누르면 그 달로 이동한다.
  const weeks = weeksWithOutside(ym, cells);

  const workedTotal = cells.reduce((a, c) => a + (c.worked || 0), 0);
  return {
    ym,
    weeks,
    totals: {
      workDays: cells.filter((c) => c.isWorkday).length,
      workedTotal,
      missingLeave: cells.filter((c) => c.missingLeave).map((c) => c.date),
      leaveDays: cells.filter((c) => c.leaveName).length,
    },
  };
}

/**
 * 팀 근태 달력. 날짜마다 그날 쉬는 사람을 모아 둔다.
 * 근무 달력과 달리 내 기록이 아니라 사람 목록이 들어간다.
 */
export function buildTeamCalendar({ ym, leaves = [], holidays = [], today }) {
  const holidayNames = new Map(
    (holidays || []).map((h) => (typeof h === 'string' ? [h, null] : [h.date, h.name]))
  );
  const byDate = expandLeaves(leaves);

  const cells = datesOfMonth(`${ym}01`).map((date) => {
    const people = (byDate.get(date) || []).slice().sort((a, b) => {
      if (a.isMe !== b.isMe) return a.isMe ? -1 : 1; // 내 일정을 맨 앞에
      return String(a.person || '').localeCompare(String(b.person || ''));
    });
    const weekend = isWeekend(date);
    const isHoliday = holidayNames.has(date);
    return {
      date,
      day: parseDate(date).getDate(),
      weekday: parseDate(date).getDay(),
      weekend,
      isHoliday,
      holidayName: holidayNames.get(date) || null,
      isWorkday: !weekend && !isHoliday,
      isToday: date === today,
      smartDay: isSmartDay(date),
      people,
      count: people.length,
      hasMe: people.some((p) => p.isMe),
    };
  });

  const weeks = weeksWithOutside(ym, cells);

  return {
    ym,
    weeks,
    totals: {
      entries: leaves.length,
      busiest: cells.reduce((max, c) => (c.count > (max?.count ?? 0) ? c : max), null),
      myDays: cells.filter((c) => c.hasMe).length,
    },
  };
}

/**
 * 이번 달 근무 현황을 계산한다.
 *
 * @param {object[]} rows       selectTab2 응답 (이번 달, 이미 지난 날들)
 * @param {string[]} holidays   공휴일 'yyyyMMdd' 목록
 * @param {string}   today      오늘 'yyyyMMdd'
 * @param {number}   nowMin     지금 시각 (자정 기준 분)
 * @param {string}   comeTm     오늘 출근 시각 ('yyyyMMddHHmm' 또는 '')
 * @param {string}   leaveTm    오늘 퇴근 시각 ('yyyyMMddHHmm' 또는 '')
 * @param {number}   dailyHours 하루 소정 근로시간(분). 설정에서 바꿀 수 있다
 */
export function computeStatus({
  rows = [],
  holidays = [],
  today,
  nowMin,
  comeTm = '',
  leaveTm = '',
  dailyMinutes = STANDARD_MINUTES,
}) {
  const holidaySet = new Set(holidayDates(holidays));
  const monthRows = rows.filter((r) => r.atDt && r.atDt.slice(0, 6) === today.slice(0, 6));

  // 근태 API 는 요청한 날짜를 모두 행으로 돌려주고, 아직 오지 않은 날은 빈 껍데기로 채운다.
  // 행이 있다는 것만으로 "기록된 날" 로 보면 오늘이 늘 퇴근 처리되고 남은 근무일이 0 이 된다.
  const isFilled = (r) => num(r.workGroupStandardWorkTm) > 0 || !!r.comeTm;
  const recorded = new Set(monthRows.filter(isFilled).map((r) => r.atDt));

  // 이번 달 전체 근무일. "남은 2일 / 전체 20일" 의 분모가 된다.
  const monthWorkDates = workDatesOfMonth(today, holidaySet);
  // 그 숫자가 어떻게 나왔는지 화면에서 설명하기 위한 재료.
  const breakdown = workDayBreakdown(today, holidaySet);

  // 아직 근태 행이 만들어지지 않은 날 = 오늘 이후. 여기에 남은 소정을 채워 넣는다.
  const remainingWorkDates = monthWorkDates.filter((d) => d >= today && !recorded.has(d));

  const recordedStandard = monthRows.reduce((a, r) => a + num(r.workGroupStandardWorkTm), 0);
  const monthStandard = recordedStandard + remainingWorkDates.length * dailyMinutes;
  const confirmed = monthRows.reduce((a, r) => a + num(r.basicworkTm), 0);

  const comeMin = parseTimeToMinutes(comeTm);
  const leaveMin = parseTimeToMinutes(leaveTm);
  const todayRecorded = recorded.has(today);

  // 오늘이 아직 확정되지 않았을 때만 진행분을 얹는다 (이중 계산 방지).
  let todayProgress = 0;
  if (!todayRecorded && comeMin != null) {
    const end = leaveMin != null ? leaveMin : nowMin;
    todayProgress = Math.max(0, end - comeMin - lunchDeduction(comeMin, end));
  }
  // 오늘이 이미 확정됐다면 그 행의 인정 시간이 오늘 일한 시간이다.
  const todayWorked = todayRecorded
    ? num(monthRows.find((r) => r.atDt === today)?.basicworkTm)
    : todayProgress;

  const accumulated = confirmed + todayProgress;
  // 오늘 일한 시간을 뺀 누적. 토글로 '오늘 제외' 를 볼 때 쓴다.
  const accumulatedExclToday = Math.max(0, accumulated - todayWorked);
  const remainingWorkDays = remainingWorkDates.length;

  // 지난 날들에서 소정보다 더(덜) 일한 누적. 양수면 적립, 음수면 빚.
  const pastRows = monthRows.filter((r) => r.atDt !== today);
  const balance = pastRows.reduce(
    (a, r) => a + (num(r.workGroupStandardWorkTm) > 0 ? num(r.basicworkTm) - num(r.workGroupStandardWorkTm) : num(r.basicworkTm)),
    0
  );

  // 오늘의 소정. 오늘을 초과·부족에 포함할 때 비교 기준이 된다.
  const todayRow = monthRows.find((r) => r.atDt === today);
  const todayStandard = todayRecorded
    ? num(todayRow?.workGroupStandardWorkTm) || dailyMinutes
    : monthWorkDates.includes(today)
      ? dailyMinutes
      : 0;
  // 초과·부족: 기본(balance)은 오늘 제외(지난 날들). 오늘 포함은 오늘 실적을 더한다.
  const balanceInclToday = balance + todayWorked - todayStandard;

  // 퇴근 시각은 시간이 흐른다고 흔들리면 안 되므로, 진행분을 빼기 전 부족분으로 목표를 잡는다.
  // confirmed 에 지난 날의 초과근무가 이미 반영되어 있어 그만큼 오늘 목표가 줄어든다.
  // 하루 권장 평균: 앞으로 하루에 얼마씩 하면 소정에 맞나.
  // 오늘이 아직 진행 중이고 이미 소정(8시간)을 넘겼으면, 그 초과분만큼 남은 날 부담이 준다.
  // (아직 소정을 못 채운 진행 중 오늘은 반영하지 않는다 — 오늘은 아직 안 끝났으니.)
  const inProgressSurplus = todayRecorded ? 0 : Math.max(0, todayWorked - todayStandard);
  const shortageBeforeToday = Math.max(0, monthStandard - confirmed - inProgressSurplus);
  const todayTarget = remainingWorkDays > 0 ? shortageBeforeToday / remainingWorkDays : 0;
  const estimatedLeave =
    !todayRecorded && comeMin != null && remainingWorkDays > 0
      ? estimateLeaveTime(comeMin, todayTarget)
      : null;

  // 하루 소정(기본 8시간)만 놓고 볼 때 오늘 남은 시간과 그 기준의 퇴근 시각.
  const todayRemainingByDaily = Math.max(0, dailyMinutes - todayWorked);
  const dailyLeave =
    !todayRecorded && comeMin != null ? estimateLeaveTime(comeMin, dailyMinutes) : null;

  const missingLeave = monthRows
    .filter((r) => r.comeTm && !r.leaveTm && num(r.workGroupStandardWorkTm) > 0)
    .map((r) => r.atDt);

  let state = 'before'; // before | working | done
  if (todayRecorded || leaveMin != null) state = 'done';
  else if (comeMin != null) state = 'working';

  // 적용 중인 근무규칙. 가장 최근 기록에서 가져온다.
  const latest = monthRows.filter((r) => r.worktimeNm).sort((a, b) => b.atDt.localeCompare(a.atDt))[0];
  const workRule = latest
    ? {
        name: latest.worktimeNm || latest.groupNm || null,
        typeName: latest.workTpNm || null,
        standardMinutes: num(latest.standardworkTm) || dailyMinutes,
        since: latest.atDt,
      }
    : null;

  return {
    state,
    today,
    dailyMinutes,
    workRule,
    monthStandard,
    accumulated,
    confirmed,
    todayProgress,
    todayWorked,
    todayRemainingByDaily,
    dailyLeave,
    balance,
    shortage: monthStandard - accumulated,
    // 오늘 포함/제외 각각의 값. 팝업 토글이 골라 쓴다.
    accumulatedInclToday: accumulated,
    accumulatedExclToday,
    shortageInclToday: monthStandard - accumulated,
    shortageExclToday: monthStandard - accumulatedExclToday,
    progressRatioInclToday: monthStandard > 0 ? Math.min(1, accumulated / monthStandard) : 0,
    progressRatioExclToday: monthStandard > 0 ? Math.min(1, accumulatedExclToday / monthStandard) : 0,
    balanceInclToday,
    balanceExclToday: balance,
    remainingWorkDays,
    monthWorkDays: monthWorkDates.length,
    workDayBreakdown: breakdown,
    todayTarget,
    todayTargetExclToday: todayTarget,
    todayTargetInclToday: remainingWorkDays > 0 ? Math.max(0, monthStandard - accumulated) / remainingWorkDays : 0,
    estimatedLeave,
    comeMinutes: comeMin,
    leaveMinutes: leaveMin,
    missingLeave,
    progressRatio: monthStandard > 0 ? Math.min(1, accumulated / monthStandard) : 0,
  };
}

/**
 * 예전 버전이 저장해 둔 status 에는 나중에 추가된 필드가 없다.
 * 그대로 그리면 'NaN분 기준' 이나 잘못된 '다 채웠어요' 가 나오므로 여기서 메운다.
 * 되살릴 수 없는 값(전체 근무일, 초과·부족)은 null 로 두어 화면에서 '-' 로 표시한다.
 */
export function normalizeStatus(status) {
  const dailyMinutes = Number.isFinite(status.dailyMinutes) ? status.dailyMinutes : STANDARD_MINUTES;
  const todayWorked = Number.isFinite(status.todayWorked)
    ? status.todayWorked
    : status.todayProgress || 0;
  return {
    ...status,
    dailyMinutes,
    todayWorked,
    todayRemainingByDaily: Number.isFinite(status.todayRemainingByDaily)
      ? status.todayRemainingByDaily
      : Math.max(0, dailyMinutes - todayWorked),
    monthWorkDays: Number.isFinite(status.monthWorkDays) ? status.monthWorkDays : null,
    balance: Number.isFinite(status.balance) ? status.balance : null,
    // 예전 캐시엔 오늘 제외 값이 없을 수 있다. 있으면 그대로, 없으면 포함 값으로 대체.
    accumulatedInclToday: Number.isFinite(status.accumulatedInclToday) ? status.accumulatedInclToday : status.accumulated,
    accumulatedExclToday: Number.isFinite(status.accumulatedExclToday) ? status.accumulatedExclToday : status.accumulated,
    shortageInclToday: Number.isFinite(status.shortageInclToday) ? status.shortageInclToday : status.shortage,
    shortageExclToday: Number.isFinite(status.shortageExclToday) ? status.shortageExclToday : status.shortage,
    progressRatioInclToday: Number.isFinite(status.progressRatioInclToday) ? status.progressRatioInclToday : status.progressRatio,
    progressRatioExclToday: Number.isFinite(status.progressRatioExclToday) ? status.progressRatioExclToday : status.progressRatio,
    balanceInclToday: Number.isFinite(status.balanceInclToday) ? status.balanceInclToday : status.balance,
    balanceExclToday: Number.isFinite(status.balanceExclToday) ? status.balanceExclToday : status.balance,
    todayTargetInclToday: Number.isFinite(status.todayTargetInclToday) ? status.todayTargetInclToday : status.todayTarget,
    todayTargetExclToday: Number.isFinite(status.todayTargetExclToday) ? status.todayTargetExclToday : status.todayTarget,
    workRule: status.workRule || null,
  };
}

