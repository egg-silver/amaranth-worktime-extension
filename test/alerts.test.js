import test from "node:test";
import assert from "node:assert/strict";
import {
  isUnread,
  countUnread,
  parseCreateDate,
  alertIdentity,
  alertTitle,
  readStamp,
  markLocallyRead,
  markAllLocallyRead,
  overlayLocalReads,
} from "../lib/alerts.js";

test("readDate 가 14자리 시각이면 읽은 알림이다", () => {
  assert.equal(isUnread({ readDate: "20260805120305592" }), false);
  assert.equal(isUnread({ readDate: "" }), true);
  assert.equal(isUnread({}), true);
  assert.equal(
    countUnread([{ readDate: "" }, { readDate: "20260805120305" }, {}]),
    2,
  );
});

test("createDate 문자열을 Date 로 바꾼다", () => {
  const d = parseCreateDate("20260805120305592");
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 7);
  assert.equal(d.getDate(), 5);
  assert.equal(d.getHours(), 12);
  assert.equal(d.getMinutes(), 3);
  assert.equal(parseCreateDate("abc"), null);
  assert.equal(parseCreateDate(""), null);
});

test("alertId 가 있으면 그것을, 없으면 내용 조합을 식별자로 쓴다", () => {
  assert.equal(alertIdentity({ alertId: 123 }), "123");
  const a = alertIdentity({
    eventType: "A",
    createDate: "1",
    message: { alertTitle: "t" },
  });
  const b = alertIdentity({
    eventType: "A",
    createDate: "1",
    message: { alertTitle: "t" },
  });
  const c = alertIdentity({
    eventType: "A",
    createDate: "2",
    message: { alertTitle: "t" },
  });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(alertIdentity({}), null);
});

test("제목이 없으면 대체 문구를 쓴다", () => {
  assert.equal(
    alertTitle({ message: { alertTitle: "결재 요청" } }),
    "결재 요청",
  );
  assert.equal(alertTitle({}), "(제목 없음)");
});

test("readStamp 는 isUnread 가 읽은 것으로 보는 14자리다", () => {
  const stamp = readStamp(new Date(2026, 7, 5, 12, 3, 5));
  assert.equal(stamp, "20260805120305");
  assert.equal(isUnread({ readDate: stamp }), false);
});

test("지정한 alertId 만 로컬에서 읽음으로 바꾼다", () => {
  const alerts = [
    { alertId: "a", readDate: "" },
    { alertId: "b", readDate: "" },
  ];
  const next = markLocallyRead(alerts, ["b"], "20260805120305");
  assert.equal(isUnread(next[0]), true);
  assert.equal(isUnread(next[1]), false);
  assert.equal(next[1].readDate, "20260805120305");
  assert.equal(alerts[1].readDate, "");
});

test("서버가 아직 안 읽음이어도 방금 읽은 id 는 유지한다", () => {
  const { alerts, pending } = overlayLocalReads(
    [
      { alertId: "a", readDate: "" },
      { alertId: "b", readDate: "20260805120305" },
      { alertId: "c", readDate: "" },
    ],
    ["a", "b", "gone"],
  );
  assert.deepEqual(pending, ["a"]);
  assert.equal(isUnread(alerts[0]), false);
  assert.equal(isUnread(alerts[1]), false);
  assert.equal(isUnread(alerts[2]), true);
});

test("모두 읽음은 id 없는 항목까지 읽음으로 바꾼다", () => {
  const alerts = [
    { alertId: "a", readDate: "" },
    { readDate: "" },
    { alertId: "b", readDate: "20260805120305" },
  ];
  const next = markAllLocallyRead(alerts, "20260805120400");
  assert.equal(isUnread(next[0]), false);
  assert.equal(isUnread(next[1]), false);
  assert.equal(next[2].readDate, "20260805120305");
  assert.equal(alerts[0].readDate, "");
});
