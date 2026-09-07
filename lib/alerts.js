// 알림 항목을 다루는 순수 함수. 화면과 background 가 같이 쓴다.

/** 읽음 여부. readDate 는 항목별 값이고 비어 있으면 안 읽은 것이다. */
export function isUnread(alert) {
  return !/^\d{14}/.test(String(alert.readDate || ""));
}

export function countUnread(alerts) {
  return alerts.reduce((n, alert) => (isUnread(alert) ? n + 1 : n), 0);
}

/** isUnread 가 인식하는 14자리 시각 문자열. */
export function readStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** 서버 응답을 기다리지 않고 목록에서 해당 알림을 읽음으로 표시한다. */
export function markLocallyRead(alerts, alertIds, stamp = readStamp()) {
  const ids = new Set((alertIds || []).filter(Boolean).map(String));
  if (!ids.size) return alerts || [];
  return (alerts || []).map((alert) =>
    alert?.alertId && ids.has(String(alert.alertId))
      ? { ...alert, readDate: stamp }
      : alert,
  );
}

/** 목록에 있는 안 읽은 알림을 전부 읽음으로 표시한다. */
export function markAllLocallyRead(alerts, stamp = readStamp()) {
  return (alerts || []).map((alert) =>
    alert && isUnread(alert) ? { ...alert, readDate: stamp } : alert,
  );
}

/**
 * 방금 읽음 처리한 id 는 서버 목록이 아직 안 읽음이어도 읽음으로 유지한다.
 * 서버가 따라잡았거나 목록에서 사라진 id 는 pending 에서 뺀다.
 */
export function overlayLocalReads(alerts, keptIds) {
  const list = alerts || [];
  const pending = (keptIds || []).filter((id) => {
    const found = list.find((a) => String(a?.alertId) === String(id));
    return found && isUnread(found);
  });
  return { alerts: markLocallyRead(list, pending), pending };
}

/** '20260805120305592' → Date. 형식이 다르면 null. */
export function parseCreateDate(s) {
  const v = String(s || "");
  if (!/^\d{12}/.test(v)) return null;
  return new Date(
    +v.slice(0, 4),
    +v.slice(4, 6) - 1,
    +v.slice(6, 8),
    +v.slice(8, 10),
    +v.slice(10, 12),
  );
}

/**
 * 신규 판정 기준값. alertId 가 없는 응답이 오면 내용 조합으로 대체한다.
 * 전부 비어 있으면 서로 구별할 수 없으므로 null 을 준다.
 */
export function alertIdentity(alert) {
  if (alert.alertId) return String(alert.alertId);
  const message = alert.message || {};
  const parts = [
    alert.eventType,
    alert.createDate,
    message.alertTitle,
    message.alertContent,
    alert.url,
  ].map((p) => (p == null ? "" : String(p)));
  // 구분자는 본문에 나올 수 없는 NUL 을 써서 필드 경계가 밀리지 않게 한다.
  return parts.some((p) => p !== "") ? parts.join("\u0000") : null;
}

export function alertTitle(alert) {
  return alert.message?.alertTitle || "(제목 없음)";
}

export function alertContent(alert) {
  return alert.message?.alertContent || "";
}
