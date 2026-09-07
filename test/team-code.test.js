import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMember, encodeMembers, decodeMembers, isValidEmpCd, parseMemberInput } from '../lib/team-code.js';

test('한 사람 코드를 만들고 되읽는다', () => {
  const code = encodeMember('김철수', '20250001');
  assert.ok(code.startsWith('GWA1:'));
  assert.deepEqual(decodeMembers(code), [{ name: '김철수', empCd: '20250001' }]);
});

test('여러 코드를 한꺼번에 붙여넣어도 합쳐진다', () => {
  const text = encodeMember('가', '20250001') + '\n' + encodeMember('나', '20250005');
  const out = decodeMembers(text);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((x) => x.empCd), ['20250001', '20250005']);
});

test('같은 사번은 한 번만', () => {
  const dup = encodeMembers([{ name: 'a', empCd: '20250001' }, { name: 'b', empCd: '20250001' }]);
  assert.equal(decodeMembers(dup).length, 1);
});

test('코드가 아닌 텍스트는 조용히 무시한다', () => {
  assert.deepEqual(decodeMembers('안녕하세요 그냥 텍스트'), []);
  assert.deepEqual(decodeMembers('GWA1:!!!깨진코드'), []);
  assert.deepEqual(decodeMembers(''), []);
});

test('사번 형식 검사', () => {
  assert.equal(isValidEmpCd('20250001'), true);
  assert.equal(isValidEmpCd('12345'), false);    // 너무 짧음
  assert.equal(isValidEmpCd('abc123'), false);
  assert.equal(isValidEmpCd(''), false);
});

test('잘못된 사번은 코드에 담기지 않는다', () => {
  const code = encodeMembers([{ name: '정상', empCd: '20250001' }, { name: '깨짐', empCd: 'abc' }]);
  assert.deepEqual(decodeMembers(code).map((x) => x.name), ['정상']);
});

test('붙여넣기 파서: 사번 여러 개를 한꺼번에', () => {
  const out = parseMemberInput('20250001 20250002 20250003');
  assert.deepEqual(out.map((x) => x.empCd), ['20250001', '20250002', '20250003']);
});

test('붙여넣기 파서: 같은 사번 반복은 한 번만', () => {
  const out = parseMemberInput('20250001 20250001 20250001');
  assert.equal(out.length, 1);
});

test('붙여넣기 파서: 코드와 맨숫자를 섞어도 된다', () => {
  const text = '20250001\n' + encodeMember('김철수', '2099999999');
  const out = parseMemberInput(text);
  assert.equal(out.length, 2);
  assert.equal(out.find((x) => x.empCd === '2099999999').name, '김철수');
});

test('붙여넣기 파서: 짧은 숫자나 잡텍스트는 무시', () => {
  assert.deepEqual(parseMemberInput('안녕 123 20250001').map((x) => x.empCd), ['20250001']);
});

test('붙여넣기 파서: 이름 사번 짝 (줄마다)', () => {
  const out = parseMemberInput('김철수 20250001\n이영희 20250002');
  assert.deepEqual(out, [
    { name: '김철수', empCd: '20250001' },
    { name: '이영희', empCd: '20250002' },
  ]);
});

test('붙여넣기 파서: 이름 사번 짝 (한 줄에 여러 명)', () => {
  const out = parseMemberInput('김철수 20250001 이영희 20250002');
  assert.deepEqual(out.map((x) => x.name), ['김철수', '이영희']);
});

test('붙여넣기 파서: 콤마 구분도 짝으로', () => {
  assert.deepEqual(parseMemberInput('김철수,20250001'), [{ name: '김철수', empCd: '20250001' }]);
});

test('붙여넣기 파서: 이름 있는 사람과 사번만 있는 사람 섞기', () => {
  const out = parseMemberInput('김철수 20250001 2099999999');
  assert.equal(out[0].name, '김철수');
  assert.equal(out[1].name, '2099999999'); // 이름 없이 사번만
});

test('구분자 없이 붙여 넣은 코드도 쪼갠다', () => {
  const one = encodeMember('홍길동B', '20250005');
  assert.deepEqual(parseMemberInput(one + one + one), [{ name: '홍길동B', empCd: '20250005' }]);
});

test('서로 다른 코드를 붙여 넣어도 각각 파싱', () => {
  const a = encodeMember('김철수', '20250001');
  const b = encodeMember('이영희', '20250002');
  assert.deepEqual(parseMemberInput(a + b).map((x) => x.empCd), ['20250001', '20250002']);
});

test('decodeMembers 도 붙은 코드를 쪼갠다', () => {
  const a = encodeMember('a', '20250001');
  const b = encodeMember('b', '20250002');
  assert.equal(decodeMembers(a + b).length, 2);
});

test('이름과 사번이 공백 없이 붙어도 쪼갠다', () => {
  assert.deepEqual(
    parseMemberInput('홍길동20250001홍길동20250001홍길동20250001'),
    [{ name: '홍길동', empCd: '20250001' }]
  );
});

test('붙은 이름+사번, 서로 다른 사람', () => {
  const out = parseMemberInput('홍길동20250001김철수20250002');
  assert.deepEqual(out.map((x) => `${x.name}:${x.empCd}`), ['홍길동:20250001', '김철수:20250002']);
});

test('이름 끝 영문자도 이름에 붙는다', () => {
  assert.deepEqual(parseMemberInput('홍길동B20250001'), [{ name: '홍길동B', empCd: '20250001' }]);
});

test('코드 뒤에 이름이 공백 없이 붙어도 분리', () => {
  const out = parseMemberInput(encodeMember('나', '20250004') + '김철수20250002');
  assert.deepEqual(out.map((x) => x.empCd), ['20250004', '20250002']);
});
