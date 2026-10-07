const segmenter = new Intl.Segmenter("ko", { granularity: "grapheme" });

export function normalizeInput(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").normalize("NFC");
}

export function countCharacters(value) {
  return [...segmenter.segment(normalizeInput(value))].length;
}

export function parseLimit(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function createTeamModes(limitedLimits) {
  return {
    partial: {
      id: "partial",
      code: "B",
      label: "일부 사용팀",
      description: "초기 준비와 반론 준비에서 합계 5회 사용",
      allowedStages: ["initial", "rebuttal"],
      limits: { ...limitedLimits }
    },
    rebuttal: {
      id: "rebuttal",
      code: "C",
      label: "반론 전용팀",
      description: "반론 준비 구간에서만 최대 5회 사용",
      allowedStages: ["rebuttal"],
      limits: { ...limitedLimits }
    },
    free: {
      id: "free",
      code: "D",
      label: "자유 사용팀",
      description: "초기 준비와 반론 준비에서 제한 없이 사용",
      allowedStages: ["initial", "rebuttal"],
      limits: { maxPromptChars: 0, maxTurns: 0, maxTotalChars: 0 }
    }
  };
}

export function validateStage(mode, stage) {
  if (!mode) {
    return { ok: false, status: 400, code: "TEAM_NOT_SELECTED", message: "먼저 팀 조건을 선택해 주세요." };
  }
  if (!mode.allowedStages.includes(stage)) {
    return {
      ok: false,
      status: 403,
      code: "STAGE_NOT_ALLOWED",
      message: `${mode.label}은(는) 현재 구간에서 AI를 사용할 수 없습니다.`
    };
  }
  return { ok: true };
}

export function validatePrompt(message, session, limits) {
  const normalized = normalizeInput(message);
  const length = countCharacters(normalized);

  if (!normalized.trim()) {
    return { ok: false, status: 400, code: "EMPTY_PROMPT", message: "질문을 입력해 주세요." };
  }

  if (/\p{C}/u.test(normalized.replace(/\n|\t/g, ""))) {
    return {
      ok: false,
      status: 400,
      code: "UNSUPPORTED_CHARACTERS",
      message: "보이지 않는 제어 문자는 사용할 수 없습니다. 일반 텍스트로 입력해 주세요."
    };
  }

  if (limits.maxPromptChars > 0 && length > limits.maxPromptChars) {
    return {
      ok: false,
      status: 400,
      code: "PROMPT_LIMIT_EXCEEDED",
      message: `한 번에 ${limits.maxPromptChars}자까지 입력할 수 있습니다.`,
      details: { length, max: limits.maxPromptChars }
    };
  }

  if (limits.maxTurns > 0 && session.turnsUsed >= limits.maxTurns) {
    return {
      ok: false,
      status: 429,
      code: "TURN_LIMIT_EXCEEDED",
      message: `이 대화의 사용 가능 횟수 ${limits.maxTurns}회를 모두 사용했습니다.`
    };
  }

  if (limits.maxTotalChars > 0 && session.charsUsed + length > limits.maxTotalChars) {
    return {
      ok: false,
      status: 400,
      code: "TOTAL_CHAR_LIMIT_EXCEEDED",
      message: `누적 입력 한도 ${limits.maxTotalChars}자를 초과합니다.`,
      details: { length, remaining: Math.max(0, limits.maxTotalChars - session.charsUsed) }
    };
  }

  return { ok: true, normalized, length };
}

export function publicUsage(session, limits) {
  return {
    turnsUsed: session.turnsUsed,
    turnsRemaining: limits.maxTurns === 0 ? null : Math.max(0, limits.maxTurns - session.turnsUsed),
    charsUsed: session.charsUsed,
    charsRemaining: limits.maxTotalChars === 0 ? null : Math.max(0, limits.maxTotalChars - session.charsUsed)
  };
}
