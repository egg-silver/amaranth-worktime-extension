import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeStatus,
  normalizeStatus,
  monthRange,
  shiftMonth,
  expandLeaves,
  buildCalendar,
  buildTeamCalendar,
  workDayBreakdown,
  estimateLeaveTime,
  lunchDeduction,
  formatClock,
  formatDuration,
  parseTimeToMinutes,
  isSmartDay,
  weekHasSmartDay,
} from '../lib/calc.js';

const row = (atDt, opts = {}) => ({
  atDt,
  comeTm: '',
  leaveTm: '',
  basicworkTm: '0',
  workGroupStandardWorkTm: '0',
  attresultNm: '휴일',
  atNm: null,
  ...opts,
});

const workday = (atDt, come, leave, worked) =>
  row(atDt, {
    comeTm: come,
    leaveTm: leave,
    basicworkTm: String(worked),
    workGroupStandardWorkTm: '480',
    attresultNm: '정상근무',
  });

test('점심시간은 근무 구간과 겹치는 만큼만 빠진다', () => {
  assert.equal(lunchDeduction(9 * 60, 18 * 60), 60); // 하루 종일
  assert.equal(lunchDeduction(9 * 60, 11 * 60), 0); // 점심 전 퇴근
  assert.equal(lunchDeduction(13 * 60, 18 * 60), 0); // 점심 후 출근
  assert.equal(lunchDeduction(12 * 60 + 30, 18 * 60), 30); // 점심 중간 출근
  assert.equal(lunchDeduction(9 * 60, 12 * 60 + 20), 20); // 점심 중간 퇴근
});

test('퇴근 가능 시각은 점심을 지나면 그만큼 밀린다', () => {
  // 09:00 출근 + 8시간 근무 → 점심 60분 포함해 18:00
  assert.equal(formatClock(estimateLeaveTime(9 * 60, 480)), '18:00');
  // 13:30 출근 + 4시간 → 점심을 지나지 않으므로 그대로 17:30
  assert.equal(formatClock(estimateLeaveTime(13 * 60 + 30, 240)), '17:30');
  // 11:30 출근 + 2시간 → 점심 60분이 끼어 14:30
  assert.equal(formatClock(estimateLeaveTime(11 * 60 + 30, 120)), '14:30');
  // 09:00 출근 + 2시간 → 점심 전에 끝나므로 11:00
  assert.equal(formatClock(estimateLeaveTime(9 * 60, 120)), '11:00');
});

test('끝난 달은 서버 확정값만으로 집계한다', () => {
  // 2026년 8월: 평일 20일(8/17 대체휴일 제외) × 480분 = 9600분.
  // 그중 4일은 퇴근을 찍지 않아 0분으로 잡히는 상황을 만든다.
  const rows = [];
  const holidayDates = ['20260801', '20260802', '20260808', '20260809', '20260815',
                        '20260816', '20260817', '20260822', '20260823', '20260829', '20260830'];
  for (let d = 1; d <= 31; d++) {
    const ymd = `202608${String(d).padStart(2, '0')}`;
    if (holidayDates.includes(ymd)) rows.push(row(ymd));
    else rows.push(workday(ymd, '0900', '1800', 0));
  }
  // 인정 근무시간 합이 7680분이 되도록 배분 (20일 중 4일은 퇴근 미등록으로 0)
  const workRows = rows.filter((r) => r.workGroupStandardWorkTm === '480');
  assert.equal(workRows.length, 20);
  workRows.slice(0, 4).forEach((r) => {
    r.leaveTm = '';
    r.basicworkTm = '0';
  });
  workRows.slice(4).forEach((r, i) => {
    r.basicworkTm = String(i === 0 ? 7680 - 15 * 480 : 480);
  });

  const status = computeStatus({
    rows,
    holidays: ['20260815', '20260817'],
    today: '20260831',
    nowMin: 23 * 60,
    comeTm: '',
    leaveTm: '',
  });

  assert.equal(status.monthStandard, 9600, '월 소정 160시간');
  assert.equal(status.accumulated, 7680, '인정 근무 128시간');
  assert.equal(status.remainingWorkDays, 0, '8/31까지 모두 기록됨');
  assert.equal(status.missingLeave.length, 4, '퇴근 미등록 4일');
});

test('빈 껍데기 행이 섞여 와도 오늘을 퇴근으로 보지 않는다', () => {
  // 근태 API 는 요청한 날짜를 전부 행으로 준다. 아직 오지 않은 날은 값이 0 인 빈 행이다.
  // 이 행들을 '기록된 날' 로 세면 오늘이 퇴근 처리되고 남은 근무일이 0 이 된다.
  const rows = [];
  for (let d = 1; d <= 30; d++) {
    const ymd = `202609${String(d).padStart(2, '0')}`;
    rows.push(d === 1 ? workday(ymd, '1027', '1819', 412) : row(ymd)); // 9/1 만 실제 기록
  }

  const status = computeStatus({
    rows,
    holidays: ['20260924', '20260925', '20260926'],
    today: '20260902',
    nowMin: 14 * 60,
    comeTm: '202609021024', // 오늘 출근은 했고 퇴근은 아직
    leaveTm: '',
  });

  assert.equal(status.state, 'working', '빈 행 때문에 퇴근으로 보면 안 된다');
  assert.ok(status.remainingWorkDays > 0, '남은 근무일이 0 이 되면 안 된다');
  assert.equal(status.remainingWorkDays, 19, '9월 근무일 20일 중 9/1 을 뺀 나머지');
  assert.equal(status.monthStandard, 480 + 19 * 480, '기록된 하루 + 남은 19일');
  assert.equal(status.todayProgress, 156, '10:24~14:00 = 216분에서 점심 60분 차감');
  assert.ok(status.estimatedLeave != null, '퇴근 가능 시각이 나와야 한다');
});

test('진행 중인 달은 남은 평일에 소정을 채워 넣는다', () => {
  // 9/1 화요일, 아직 아무 기록도 없는 상태.
  // 9월 평일은 22일. 추석 연휴 9/24~26 중 26일은 토요일이라 이미 주말로 빠지므로
  // 실제로 더 빠지는 건 24·25 이틀 → 남은 근무일 20일.
  const status = computeStatus({
    rows: [],
    holidays: ['20260924', '20260925', '20260926'],
    today: '20260901',
    nowMin: 14 * 60 + 27, // 14:27
    comeTm: '202609011027', // 10:27 출근
    leaveTm: '',
  });

  assert.equal(status.remainingWorkDays, 20);
  assert.equal(status.monthStandard, 20 * 480);
  assert.equal(status.state, 'working');
  // 10:27~14:27 = 240분에서 점심 60분 차감
  assert.equal(status.todayProgress, 180);
  assert.equal(status.accumulated, 180);
  // 오늘 목표는 진행분을 빼기 전 부족분 기준이어야 시간이 흘러도 흔들리지 않는다
  assert.equal(status.todayTarget, 480);
  assert.equal(formatClock(status.estimatedLeave), '19:27');
});

test('오늘 퇴근을 찍으면 진행분 대신 서버 확정값이 쓰인다', () => {
  const rows = [workday('20260902', '0900', '1800', 480)];
  const status = computeStatus({
    rows,
    holidays: [],
    today: '20260902',
    nowMin: 19 * 60,
    comeTm: '202609020900',
    leaveTm: '202609021800',
  });

  assert.equal(status.state, 'done');
  assert.equal(status.todayProgress, 0, '이중 계산 방지');
  assert.equal(status.accumulated, 480);
  assert.equal(status.estimatedLeave, null);
});

test('출근 전이면 진행분이 0이고 근무중이 아니다', () => {
  const status = computeStatus({
    rows: [],
    holidays: [],
    today: '20260902',
    nowMin: 8 * 60,
    comeTm: '',
    leaveTm: '',
  });
  assert.equal(status.state, 'before');
  assert.equal(status.todayProgress, 0);
  assert.equal(status.estimatedLeave, null);
});

test('남은 근무일은 이번 달 전체 근무일과 함께 나온다', () => {
  // 9월 평일 22일 − 추석 평일 2일(9/24 목, 9/25 금) = 20일.
  // 9/26은 토요일이라 애초에 평일이 아니어서 더 빠지지 않는다.
  const status = computeStatus({
    rows: [],
    holidays: ['20260924', '20260925', '20260926'],
    today: '20260901',
    nowMin: 9 * 60,
    comeTm: '',
    leaveTm: '',
  });
  assert.equal(status.monthWorkDays, 20);
  assert.equal(status.remainingWorkDays, 20);

  // 달 중간이면 지나간 근무일만큼 남은 날이 줄어든다.
  const rows = ['20260901', '20260902', '20260903'].map((d) => workday(d, '0900', '1800', 480));
  const mid = computeStatus({
    rows,
    holidays: ['20260924', '20260925', '20260926'],
    today: '20260904',
    nowMin: 9 * 60,
    comeTm: '',
    leaveTm: '',
  });
  assert.equal(mid.monthWorkDays, 20);
  assert.equal(mid.remainingWorkDays, 17);
});

test('하루 8시간 기준으로 오늘 남은 시간을 낸다', () => {
  const status = computeStatus({
    rows: [],
    holidays: [],
    today: '20260902',
    nowMin: 15 * 60, // 15:00
    comeTm: '202609020900', // 09:00 출근
    leaveTm: '',
  });
  // 09:00~15:00 = 360분, 점심 60분 빼면 300분 근무
  assert.equal(status.todayWorked, 300);
  assert.equal(status.todayRemainingByDaily, 180); // 480 − 300
  assert.equal(formatClock(status.dailyLeave), '18:00'); // 8시간 채우는 시각
});

test('다른 날 더 일한 시간이 오늘 목표에서 빠진다', () => {
  // 9/1~9/2 이틀 동안 소정 480분씩인데 각각 600분씩 일했다 → 240분 적립.
  const rows = [workday('20260901', '0900', '2000', 600), workday('20260902', '0900', '2000', 600)];
  const status = computeStatus({
    rows,
    holidays: [],
    today: '20260903',
    nowMin: 10 * 60,
    comeTm: '202609030900',
    leaveTm: '',
  });

  assert.equal(status.balance, 240, '이틀치 초과 4시간');

  // 초과가 없었다면 오늘 목표는 정확히 소정 8시간이어야 한다.
  const flat = computeStatus({
    rows: rows.map((r) => ({ ...r, basicworkTm: '480' })),
    holidays: [],
    today: '20260903',
    nowMin: 10 * 60,
    comeTm: '202609030900',
    leaveTm: '',
  });
  assert.equal(Math.round(flat.todayTarget), 480);

  // 적립분이 있으면 그만큼 남은 날에 나눠 덜 일해도 된다.
  assert.ok(status.todayTarget < flat.todayTarget, '초과분만큼 오늘 목표가 줄어야 한다');
  assert.equal(
    Math.round(flat.todayTarget - status.todayTarget),
    Math.round(240 / status.remainingWorkDays)
  );
});

test('하루 근무시간 설정을 바꾸면 기준이 함께 바뀐다', () => {
  const status = computeStatus({
    rows: [],
    holidays: [],
    today: '20260902',
    nowMin: 15 * 60,
    comeTm: '202609020900',
    leaveTm: '',
    dailyMinutes: 420, // 7시간
  });
  assert.equal(status.dailyMinutes, 420);
  assert.equal(status.todayRemainingByDaily, 120); // 420 − 300
  assert.equal(status.monthStandard, status.remainingWorkDays * 420);
});

test('달력은 요일에 맞춰 칸을 채운다', () => {
  // 2026년 9월 1일은 화요일 → 첫 주의 일·월 자리는 비어 있어야 한다.
  const cal = buildCalendar({
    ym: '202609',
    rows: [],
    holidays: [{ date: '20260924', name: '추석연휴' }],
    leaves: [],
    today: '20260902',
  });

  // 9/1 이 화요일 → 앞의 일·월 칸은 이전 달(8월) 날짜로 채워진다.
  assert.equal(cal.weeks[0][0].outside, true, '앞칸은 이전 달');
  assert.equal(cal.weeks[0][0].ym, '202608');
  assert.equal(cal.weeks[0][1].outside, true);
  assert.equal(cal.weeks[0][2].day, 1);
  assert.equal(cal.weeks[0][2].outside, undefined);
  assert.equal(cal.weeks[0][2].weekday, 2);

  // 모든 주는 7칸. 이 달 날짜(outside 아님)는 30개다.
  assert.ok(cal.weeks.every((w) => w.length === 7));
  assert.equal(cal.weeks.flat().filter((c) => c && !c.outside).length, 30);

  const sep24 = cal.weeks.flat().find((c) => c?.date === '20260924');
  assert.equal(sep24.isHoliday, true);
  assert.equal(sep24.holidayName, '추석연휴');
  assert.equal(sep24.isWorkday, false, '공휴일은 근무일이 아니다');

  const today = cal.weeks.flat().find((c) => c?.isToday);
  assert.equal(today.date, '20260902');
});

test('달력 칸에 근무·휴가·미등록이 담긴다', () => {
  const cal = buildCalendar({
    ym: '202609',
    rows: [
      workday('20260901', '0914', '1820', 486),
      workday('20260902', '1002', '', 0), // 퇴근 미등록
      { ...workday('20260903', '1328', '1816', 526), atNm: '오전반차' },
    ],
    holidays: [],
    leaves: [{ start: '202609210900', end: '202609231800', name: '연차' }],
    today: '20260904',
  });

  const cells = Object.fromEntries(cal.weeks.flat().filter(Boolean).map((c) => [c.date, c]));
  assert.equal(cells['20260901'].worked, 486);
  assert.equal(cells['20260902'].missingLeave, true);
  assert.equal(cells['20260903'].leaveName, '오전반차');
  assert.equal(cells['20260922'].leaveName, '연차', '기록이 없어도 캘린더 휴가가 붙는다');
  assert.equal(cells['20260905'].isWorkday, false, '토요일');

  assert.deepEqual(cal.totals.missingLeave, ['20260902']);
  assert.equal(cal.totals.workedTotal, 486 + 526);
});

test('근무일 수의 근거를 설명할 수 있다', () => {
  // 사용자가 "9월 근무일은 22일 아니냐" 고 물었을 때 답이 되는 값들.
  const bd = workDayBreakdown('20260901', new Set(['20260924', '20260925', '20260926']));
  assert.equal(bd.weekdays, 22, '9월 월~금은 22일');
  assert.equal(bd.holidayWeekdays, 2, '추석 3일 중 평일은 24·25 이틀 (26일은 토요일)');
  assert.equal(bd.workDays, 20);
  assert.deepEqual(bd.holidayDates, ['20260924', '20260925']);
});

test('예전 스키마로 저장된 결과를 그려도 NaN 이 새어 나오지 않는다', () => {
  // v1 시절 status. dailyMinutes / todayWorked / todayRemainingByDaily / monthWorkDays / balance 가 없다.
  const legacy = {
    state: 'working',
    today: '20260902',
    monthStandard: 9600,
    accumulated: 300,
    confirmed: 0,
    todayProgress: 300,
    shortage: 9300,
    remainingWorkDays: 20,
    todayTarget: 480,
    estimatedLeave: 1080,
    comeMinutes: 540,
    leaveMinutes: null,
    missingLeave: [],
    progressRatio: 0.03,
  };

  const s = normalizeStatus(legacy);
  assert.equal(s.dailyMinutes, 480, '기본 8시간으로 메운다');
  assert.equal(s.todayWorked, 300, '진행분에서 가져온다');
  assert.equal(s.todayRemainingByDaily, 180, '480 − 300. 0 이 되어 다 채웠다고 하면 안 된다');
  assert.ok(!Number.isNaN(s.todayRemainingByDaily));
  assert.equal(s.monthWorkDays, null, '되살릴 수 없으므로 화면에서 감춘다');
  assert.equal(s.balance, null);
  assert.equal(s.workRule, null);
});

test('정상 status 는 normalize 를 거쳐도 값이 바뀌지 않는다', () => {
  const s = computeStatus({
    rows: [],
    holidays: [],
    today: '20260902',
    nowMin: 15 * 60,
    comeTm: '202609020900',
    leaveTm: '',
  });
  assert.deepEqual(normalizeStatus(s), s);
});

test('월 범위와 월 이동', () => {
  assert.deepEqual(monthRange('202609'), { from: '20260901', to: '20260930' });
  assert.deepEqual(monthRange('202602'), { from: '20260201', to: '20260228' });
  assert.deepEqual(monthRange('202812'), { from: '20281201', to: '20281231' });

  assert.equal(shiftMonth('202609', -1), '202608');
  assert.equal(shiftMonth('202601', -1), '202512', '해를 넘어간다');
  assert.equal(shiftMonth('202612', 1), '202701');
});

test('여러 날에 걸친 휴가는 날짜별로 펼쳐진다', () => {
  const byDate = expandLeaves([
    { start: '202609210900', end: '202609231800', name: '연차', allDay: true },
    { start: '202609010900', end: '202609011400', name: '오전반차', allDay: false },
  ]);

  assert.deepEqual([...byDate.keys()].sort(), ['20260901', '20260921', '20260922', '20260923']);
  assert.equal(byDate.get('20260922')[0].name, '연차');
  assert.equal(byDate.get('20260901')[0].name, '오전반차');
});

test('휴가 데이터가 망가져 있어도 멈추지 않는다', () => {
  const byDate = expandLeaves([
    { start: '', end: '', name: '이상한 값' },
    { start: '202609050900', end: '202608010900', name: '끝이 시작보다 빠름' },
  ]);
  assert.equal(byDate.size, 0);
});

test('시각·시간 포맷', () => {
  assert.equal(parseTimeToMinutes('202609011027'), 627);
  assert.equal(parseTimeToMinutes(''), null);
  assert.equal(formatClock(627), '10:27');
  assert.equal(formatDuration(500), '8시간 20분');
  assert.equal(formatDuration(480), '8시간');
  assert.equal(formatDuration(20), '20분');
});

test('팀 근태 달력은 날짜마다 쉬는 사람을 모은다', () => {
  const leave = (start, end, person, name, isMe) => ({
    start, end, person, name, dept: '테스트팀', isMe: !!isMe, allDay: true,
  });
  const cal = buildTeamCalendar({
    ym: '202609',
    leaves: [
      leave('202609040900', '202609041400', '홍길동', '오전반차'),
      leave('202609040900', '202609041800', '김철수', '연차'),
      leave('202609040830', '202609041330', '나', '오전반차', true),
      leave('202609210900', '202609231800', '이영희', '연차'), // 사흘짜리
    ],
    holidays: [{ date: '20260924', name: '추석연휴' }],
    today: '20260904',
  });

  const cells = Object.fromEntries(cal.weeks.flat().filter(Boolean).map((c) => [c.date, c]));

  assert.equal(cells['20260904'].count, 3);
  assert.equal(cells['20260904'].hasMe, true);
  assert.equal(cells['20260904'].people[0].person, '나', '내 일정이 맨 앞에 온다');
  assert.equal(cells['20260904'].isToday, true);

  // 여러 날에 걸친 연차는 각 날짜에 하나씩 붙는다
  for (const d of ['20260921', '20260922', '20260923']) {
    assert.equal(cells[d].count, 1, `${d} 에 연차가 있어야 한다`);
    assert.equal(cells[d].people[0].person, '이영희');
  }

  assert.equal(cells['20260905'].count, 0, '휴가 없는 날');
  assert.equal(cells['20260924'].isWorkday, false, '공휴일은 근무일이 아니다');

  assert.equal(cal.totals.entries, 4);
  assert.equal(cal.totals.busiest.date, '20260904');
  assert.equal(cal.totals.busiest.count, 3);
  assert.equal(cal.totals.myDays, 1);
});

test('팀 근태 달력도 요일에 맞춰 칸을 채운다', () => {
  const cal = buildTeamCalendar({ ym: '202609', leaves: [], holidays: [], today: '20260904' });
  assert.equal(cal.weeks[0][0].outside, true, '앞칸은 이전 달');
  assert.equal(cal.weeks[0][2].day, 1);
  assert.ok(cal.weeks.every((w) => w.length === 7));
  assert.equal(cal.weeks.flat().filter((c) => c && !c.outside).length, 30);
  assert.equal(cal.totals.entries, 0);
  assert.equal(cal.totals.busiest, null, '휴가가 없으면 가장 많은 날도 없다');
});

test('스마데는 3주 주기 금요일이다', () => {
  assert.equal(isSmartDay('20260911'), true);   // 기준 금요일
  assert.equal(isSmartDay('20261002'), true);   // +21일 금요일
  assert.equal(isSmartDay('20260821'), true);   // -21일 금요일
  assert.equal(isSmartDay('20260918'), false);  // 다음 주 금요일(주기 아님)
  assert.equal(isSmartDay('20260910'), false);  // 목요일
});

test('그 주에 스마데가 있는지', () => {
  assert.equal(weekHasSmartDay('20260907'), true);  // 09-07(월) 주의 금요일 09-11 = 스마데
  assert.equal(weekHasSmartDay('20260911'), true);  // 금요일 당일
  assert.equal(weekHasSmartDay('20260914'), false); // 다음 주
});
