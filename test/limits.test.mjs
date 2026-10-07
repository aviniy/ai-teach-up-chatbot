import test from "node:test";
import assert from "node:assert/strict";
import { countCharacters, createTeamModes, parseLimit, publicUsage, validatePrompt, validateStage } from "../lib.mjs";

const limits = { maxPromptChars: 60, maxTurns: 5, maxTotalChars: 300 };
const fresh = () => ({ turnsUsed: 0, charsUsed: 0 });

test("한글, 공백, 문장부호와 줄바꿈을 글자로 센다", () => {
  assert.equal(countCharacters("가 나!\n"), 5);
});

test("결합 이모지는 화면에 보이는 한 글자로 센다", () => {
  assert.equal(countCharacters("👨‍👩‍👧‍👦"), 1);
});

test("요청당 글자 제한을 적용한다", () => {
  const result = validatePrompt("가".repeat(61), fresh(), limits);
  assert.equal(result.ok, false);
  assert.equal(result.code, "PROMPT_LIMIT_EXCEEDED");
});

test("성공한 사용 횟수와 누적 글자 제한을 적용한다", () => {
  assert.equal(validatePrompt("질문", { turnsUsed: 5, charsUsed: 20 }, limits).code, "TURN_LIMIT_EXCEEDED");
  assert.equal(validatePrompt("123456", { turnsUsed: 4, charsUsed: 295 }, limits).code, "TOTAL_CHAR_LIMIT_EXCEEDED");
});

test("0 제한은 무제한으로 처리한다", () => {
  const unlimited = { maxPromptChars: 0, maxTurns: 0, maxTotalChars: 0 };
  assert.equal(validatePrompt("가".repeat(1000), { turnsUsed: 999, charsUsed: 9999 }, unlimited).ok, true);
  assert.equal(publicUsage({ turnsUsed: 2, charsUsed: 30 }, unlimited).turnsRemaining, null);
});

test("환경변수 숫자 파싱은 잘못된 값을 기본값으로 돌린다", () => {
  assert.equal(parseLimit("12", 5), 12);
  assert.equal(parseLimit("-1", 5), 5);
  assert.equal(parseLimit("abc", 5), 5);
});

test("팀별 제한과 허용 구간을 구분한다", () => {
  const modes = createTeamModes(limits);
  assert.equal(modes.partial.limits.maxTurns, 5);
  assert.deepEqual(modes.rebuttal.allowedStages, ["rebuttal"]);
  assert.equal(modes.free.limits.maxTurns, 0);
  assert.equal(validateStage(modes.rebuttal, "initial").code, "STAGE_NOT_ALLOWED");
  assert.equal(validateStage(modes.rebuttal, "rebuttal").ok, true);
});
