// 그룹웨어 페이지에서 사용자 식별 정보를 한 번 건져 온다.
// empCd 와 사원 seq 는 어느 API 응답에도 없고 sessionStorage.userInfo 안에만 있다.

(function () {
  const readIdentity = () => {
    try {
      const raw = sessionStorage.getItem('userInfo');
      if (!raw) return null;
      const info = JSON.parse(raw);
      const uc = info.ucUserInfo || {};
      const empCd = info?.erpUserInfo?.userCode || uc.erpEmpSeq;
      if (!empCd) return null;

      const email = info.user_email || info.user_default_email || '';
      return {
        empCd: String(empCd),
        coCd: String(uc.compSeq || '1000'),
        empName: uc.empName || uc.empRealName || info.user_name || '',
        // 아래는 근태캘린더(휴가) 조회에 쓰인다.
        empSeq: uc.empSeq ? String(uc.empSeq) : null,
        groupSeq: uc.groupSeq ? String(uc.groupSeq) : null,
        deptSeq: uc.deptSeq ? String(uc.deptSeq) : null,
        deptName: uc.deptName || '',
        emailAddr: email.split('@')[0] || '',
        emailDomain: uc.emailDomain || (email.split('@')[1] ?? ''),
      };
    } catch (e) {
      return null;
    }
  };

  const save = (identity) => {
    chrome.runtime.sendMessage({ type: 'setIdentity', identity }, () => void chrome.runtime.lastError);
  };

  const identity = readIdentity();
  if (identity) {
    save(identity);
    return;
  }

  // 로그인 직후에는 아직 저장되기 전일 수 있어 잠깐 기다려 본다.
  let tries = 0;
  const timer = setInterval(() => {
    const found = readIdentity();
    if (found) {
      save(found);
      clearInterval(timer);
    } else if (++tries > 20) {
      clearInterval(timer);
    }
  }, 1000);
})();
