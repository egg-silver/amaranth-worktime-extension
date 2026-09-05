import test from 'node:test';
import assert from 'node:assert/strict';

// lib/api.js 는 모듈 최상단에서 chrome 을 쓰지 않지만, 안전하게 최소 스텁을 둔다.
globalThis.chrome ??= { cookies: { get: async () => null } };

const { fetchCompanyInfo, markAlertsRead } = await import('../lib/api.js');

const credentials = { token: 'grp|2073|secret', signKey: 'k' };

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const { status = 200, json } = handler(url, init) || {};
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json) };
  };
  return calls;
}

test('이미 로그인된 세션(resultCode 200)에서도 회사 정보를 읽어 온다', async () => {
  stubFetch(() => ({
    json: {
      resultCode: 200,
      resultMsg: '이미 로그인된 사용자입니다.',
      resultData: {
        sessionInfo: {
          ucUserInfo: {
            compSeq: '1000',
            bizSeq: '1000',
            deptSeq: '2025',
            emailAdd: 'sammy.kim',
            emailDomain: 'goorm.io',
          },
        },
      },
    },
  }));

  const info = await fetchCompanyInfo(credentials);
  assert.deepEqual(info, {
    compSeq: '1000',
    bizSeq: '1000',
    deptSeq: '2025',
    emailAddr: 'sammy.kim',
    emailDomain: 'goorm.io',
  });
});

test('세션 정보라도 진짜 오류 코드는 그대로 던진다', async () => {
  stubFetch(() => ({ json: { resultCode: 601, resultMsg: '허용된 쿠키 인증 URL이 아닙니다.' } }));
  await assert.rejects(() => fetchCompanyInfo(credentials), /허용된 쿠키 인증 URL/);
});

test('다른 API 는 여전히 resultCode 0 만 성공으로 본다', async () => {
  stubFetch(() => ({ json: { resultCode: 200, resultMsg: '이미 로그인된 사용자입니다.' } }));
  await assert.rejects(
    () => markAlertsRead(credentials, { compSeq: '1000' }, ['abc']),
    /이미 로그인된 사용자입니다/
  );
});

test('읽음 처리는 event02A03 에 alertIds 를 담아 보낸다', async () => {
  const calls = stubFetch(() => ({ json: { resultCode: 0, resultData: { alertIds: [] } } }));
  await markAlertsRead(credentials, { compSeq: '1000', bizSeq: '1000' }, ['id-1', null, 'id-2']);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://gw.goorm.io/event/event02A03');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'include');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    header: { groupSeq: 'grp', empSeq: '2073', pid: '', tid: '' },
    body: { companyInfo: { compSeq: '1000', bizSeq: '1000' }, alertIds: ['id-1', 'id-2'] },
  });
});
