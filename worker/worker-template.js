const INDEX_HTML = "__INDEX_HTML_JSON__";
const STYLES_CSS = "__STYLES_CSS_JSON__";
const APP_JS = "__APP_JS_JSON__";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_HISTORY_MESSAGES = 16;

function parseLimit(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeInput(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").normalize("NFC");
}

function countCharacters(value) {
  return [...new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(normalizeInput(value))].length;
}

function createTeamModes(limitedLimits) {
  return {
    partial: {
      id: "partial", code: "B", label: "일부 사용팀",
      description: "초기 준비와 반론 준비에서 합계 5회 사용",
      allowedStages: ["initial", "rebuttal"], limits: { ...limitedLimits }
    },
    rebuttal: {
      id: "rebuttal", code: "C", label: "반론 전용팀",
      description: "반론 준비 구간에서만 최대 5회 사용",
      allowedStages: ["rebuttal"], limits: { ...limitedLimits }
    },
    free: {
      id: "free", code: "D", label: "자유 사용팀",
      description: "초기 준비와 반론 준비에서 제한 없이 사용",
      allowedStages: ["initial", "rebuttal"],
      limits: { maxPromptChars: 0, maxTurns: 0, maxTotalChars: 0 }
    }
  };
}

function configFrom(env) {
  const limits = {
    maxPromptChars: parseLimit(env.MAX_PROMPT_CHARS, 60),
    maxTurns: parseLimit(env.MAX_TURNS, 5),
    maxTotalChars: parseLimit(env.MAX_TOTAL_CHARS, 300)
  };
  return {
    apiKey: String(env.BAZE_API_KEY || env.FACTCHAT_API_KEY || "").trim(),
    baseUrl: String(env.BAZE_BASE_URL || "https://factchat-cloud.mindlogic.ai/v1/gateway").replace(/\/+$/, ""),
    model: String(env.BAZE_MODEL || "gpt-5.6-terra"),
    signingSecret: String(env.SESSION_SIGNING_SECRET || ""),
    systemPrompt: String(env.SYSTEM_PROMPT || "당신은 중학생 토론 활동을 돕는 AI입니다. 제공된 맥락 안에서 간결하게 답하고, 불확실한 사실을 지어내지 마세요. 최종 판단은 학생이 하도록 근거와 한계를 구분해 설명하세요."),
    limits,
    teamModes: createTeamModes(limits)
  };
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function signingKey(secret) {
  if (secret.length < 24) throw new Error("SESSION_SIGNING_SECRET is not configured");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function encodeSession(session, secret) {
  const payload = base64Url(encoder.encode(JSON.stringify(session)));
  const signature = await crypto.subtle.sign("HMAC", await signingKey(secret), encoder.encode(payload));
  return `${payload}.${base64Url(new Uint8Array(signature))}`;
}

async function decodeSession(token, secret) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  try {
    const [payload, signature] = token.split(".");
    const valid = await crypto.subtle.verify("HMAC", await signingKey(secret), fromBase64Url(signature), encoder.encode(payload));
    if (!valid) return null;
    const session = JSON.parse(decoder.decode(fromBase64Url(payload)));
    if (!session?.id || Date.now() - Number(session.updatedAt) > SESSION_TTL_MS) return null;
    return session;
  } catch {
    return null;
  }
}

function newSession() {
  return { id: crypto.randomUUID(), mode: null, turnsUsed: 0, charsUsed: 0, messages: [], updatedAt: Date.now() };
}

async function getSession(token, config) {
  const session = await decodeSession(token, config.signingSecret);
  if (!session) return newSession();
  session.updatedAt = Date.now();
  return session;
}

function sessionMode(session, config) {
  return session.mode ? config.teamModes[session.mode] : null;
}

function publicUsage(session, limits) {
  return {
    turnsUsed: session.turnsUsed,
    turnsRemaining: limits.maxTurns === 0 ? null : Math.max(0, limits.maxTurns - session.turnsUsed),
    charsUsed: session.charsUsed,
    charsRemaining: limits.maxTotalChars === 0 ? null : Math.max(0, limits.maxTotalChars - session.charsUsed)
  };
}

async function sessionPayload(session, config) {
  const mode = sessionMode(session, config);
  const limits = mode?.limits ?? config.limits;
  return {
    sessionId: await encodeSession(session, config.signingSecret),
    mode: mode ? { id: mode.id, code: mode.code, label: mode.label, allowedStages: mode.allowedStages } : null,
    limits,
    usage: publicUsage(session, limits)
  };
}

function validateStage(mode, stage) {
  if (!mode) return { ok: false, status: 400, code: "TEAM_NOT_SELECTED", message: "먼저 팀 조건을 선택해 주세요." };
  if (!mode.allowedStages.includes(stage)) {
    return { ok: false, status: 403, code: "STAGE_NOT_ALLOWED", message: `${mode.label}은(는) 현재 구간에서 AI를 사용할 수 없습니다.` };
  }
  return { ok: true };
}

function validatePrompt(message, session, limits) {
  const normalized = normalizeInput(message);
  const length = countCharacters(normalized);
  if (!normalized.trim()) return { ok: false, status: 400, code: "EMPTY_PROMPT", message: "질문을 입력해 주세요." };
  if (/\p{C}/u.test(normalized.replace(/\n|\t/g, ""))) {
    return { ok: false, status: 400, code: "UNSUPPORTED_CHARACTERS", message: "보이지 않는 제어 문자는 사용할 수 없습니다. 일반 텍스트로 입력해 주세요." };
  }
  if (limits.maxPromptChars > 0 && length > limits.maxPromptChars) {
    return { ok: false, status: 400, code: "PROMPT_LIMIT_EXCEEDED", message: `한 번에 ${limits.maxPromptChars}자까지 입력할 수 있습니다.` };
  }
  if (limits.maxTurns > 0 && session.turnsUsed >= limits.maxTurns) {
    return { ok: false, status: 429, code: "TURN_LIMIT_EXCEEDED", message: `이 대화의 사용 가능 횟수 ${limits.maxTurns}회를 모두 사용했습니다.` };
  }
  if (limits.maxTotalChars > 0 && session.charsUsed + length > limits.maxTotalChars) {
    return { ok: false, status: 400, code: "TOTAL_CHAR_LIMIT_EXCEEDED", message: `누적 입력 한도 ${limits.maxTotalChars}자를 초과합니다.` };
  }
  return { ok: true, normalized, length };
}

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
  });
}

async function readJson(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 32 * 1024) throw Object.assign(new Error("요청 본문이 너무 큽니다."), { status: 413 });
  try {
    return await request.json();
  } catch {
    throw Object.assign(new Error("올바른 JSON 요청이 아닙니다."), { status: 400 });
  }
}

async function handleApi(request, env, url) {
  const config = configFrom(env);
  if (!config.signingSecret) return json({ error: { message: "서버 설정이 완료되지 않았습니다." } }, 503);

  if (request.method === "GET" && url.pathname === "/api/config") {
    const session = await getSession(url.searchParams.get("sessionId"), config);
    return json({
      ...(await sessionPayload(session, config)), model: config.model,
      ready: Boolean(config.apiKey), teamModes: Object.values(config.teamModes)
    });
  }

  if (request.method === "POST" && url.pathname === "/api/session/configure") {
    const body = await readJson(request);
    const session = await getSession(body.sessionId, config);
    const mode = config.teamModes[body.mode];
    if (!mode) return json({ error: { code: "INVALID_TEAM", message: "올바른 팀 조건을 선택해 주세요." } }, 400);
    if (session.mode && session.mode !== mode.id) {
      return json({ error: { code: "TEAM_LOCKED", message: "팀 조건은 새 대화를 시작한 뒤 다시 선택할 수 있습니다." } }, 409);
    }
    session.mode = mode.id;
    session.updatedAt = Date.now();
    return json(await sessionPayload(session, config));
  }

  if (request.method === "POST" && url.pathname === "/api/reset") {
    await readJson(request);
    return json(await sessionPayload(newSession(), config));
  }

  if (request.method === "POST" && url.pathname === "/api/chat") {
    const body = await readJson(request);
    const session = await getSession(body.sessionId, config);
    const mode = sessionMode(session, config);
    const stageChecked = validateStage(mode, body.stage);
    if (!stageChecked.ok) return json({ sessionId: await encodeSession(session, config.signingSecret), error: stageChecked }, stageChecked.status);
    const checked = validatePrompt(body.message, session, mode.limits);
    if (!checked.ok) return json({ sessionId: await encodeSession(session, config.signingSecret), error: checked }, checked.status);
    if (!config.apiKey) return json({ error: { code: "API_KEY_MISSING", message: "서버에 API 키가 설정되지 않았습니다." } }, 503);

    try {
      const upstream = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: "system", content: `${config.systemPrompt}\n현재 사용 조건은 ${mode.code} ${mode.label}이고, 활동 구간은 ${body.stage === "initial" ? "초기 준비" : "반론 준비"}입니다.` },
            ...session.messages,
            { role: "user", content: checked.normalized }
          ],
          temperature: 0.4,
          max_tokens: 600
        }),
        signal: AbortSignal.timeout(60_000)
      });
      const data = await upstream.json().catch(() => ({}));
      if (!upstream.ok) {
        const message = data?.error?.message || `AI API 오류 (${upstream.status})`;
        return json({ error: { code: "UPSTREAM_ERROR", message } }, upstream.status >= 500 ? 502 : upstream.status);
      }
      const answer = data?.choices?.[0]?.message?.content;
      if (typeof answer !== "string" || !answer.trim()) {
        return json({ error: { code: "EMPTY_UPSTREAM_RESPONSE", message: "AI가 읽을 수 있는 답변을 반환하지 않았습니다." } }, 502);
      }
      session.messages.push(
        { role: "user", content: checked.normalized },
        { role: "assistant", content: answer.slice(0, 5000) }
      );
      session.messages = session.messages.slice(-MAX_HISTORY_MESSAGES);
      session.turnsUsed += 1;
      session.charsUsed += checked.length;
      session.updatedAt = Date.now();
      return json({
        sessionId: await encodeSession(session, config.signingSecret),
        answer,
        usage: publicUsage(session, mode.limits)
      });
    } catch (error) {
      const timedOut = error?.name === "TimeoutError";
      return json({
        error: {
          code: timedOut ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNAVAILABLE",
          message: timedOut ? "AI 응답 시간이 초과되었습니다. 횟수는 차감되지 않았습니다." : "AI 서버에 연결하지 못했습니다. 횟수는 차감되지 않았습니다."
        }
      }, 502);
    }
  }

  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true, model: config.model, configured: Boolean(config.apiKey && config.signingSecret) });
  }

  return json({ error: { message: "페이지를 찾을 수 없습니다." } }, 404);
}

function staticResponse(pathname) {
  const asset = pathname === "/" || pathname === "/index.html"
    ? [INDEX_HTML, "text/html; charset=utf-8"]
    : pathname === "/styles.css" ? [STYLES_CSS, "text/css; charset=utf-8"]
    : pathname === "/app.js" ? [APP_JS, "text/javascript; charset=utf-8"] : null;
  if (!asset) return null;
  return new Response(asset[0], {
    headers: {
      "Content-Type": asset[1],
      "Cache-Control": pathname === "/" ? "no-cache" : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer"
    }
  });
}

export default {
  async fetch(request, env, ctx) {
    void ctx;
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/") || url.pathname === "/health") return await handleApi(request, env, url);
      if (request.method === "GET") return staticResponse(url.pathname) || new Response("Not found", { status: 404 });
      return json({ error: { message: "허용되지 않은 요청입니다." } }, 405);
    } catch (error) {
      console.error("Request failed", error);
      return json({ error: { message: error?.message || "서버 오류가 발생했습니다." } }, error?.status || 500);
    }
  }
};
