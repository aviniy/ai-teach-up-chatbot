const INDEX_HTML = "__INDEX_HTML_JSON__";
const STYLES_CSS = "__STYLES_CSS_JSON__";
const APP_JS = "__APP_JS_JSON__";
const ADMIN_HTML = "__ADMIN_HTML_JSON__";
const ADMIN_CSS = "__ADMIN_CSS_JSON__";
const ADMIN_JS = "__ADMIN_JS_JSON__";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_HISTORY_MESSAGES = 16;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    adminPassword: String(env.ADMIN_PASSWORD || ""),
    systemPrompt: String(env.SYSTEM_PROMPT || "당신은 중학생 토론 활동을 돕는 AI입니다. 제공된 맥락 안에서 간결하게 답하고, 불확실한 사실을 지어내지 마세요. 최종 판단은 학생이 하도록 근거와 한계를 구분해 설명하세요."),
    limits,
    teamModes: createTeamModes(limits)
  };
}

function newSession(id = crypto.randomUUID()) {
  const now = Date.now();
  return {
    id, displayName: "", mode: null, turnsUsed: 0, charsUsed: 0,
    bonusTurns: 0, bonusChars: 0, messages: [], pending: false,
    createdAt: now, updatedAt: now
  };
}

function rowToSession(row) {
  let messages = [];
  try {
    const parsed = JSON.parse(row.messages || "[]");
    if (Array.isArray(parsed)) messages = parsed;
  } catch {}
  return {
    id: row.id,
    displayName: row.display_name,
    mode: row.mode,
    turnsUsed: Number(row.turns_used) || 0,
    charsUsed: Number(row.chars_used) || 0,
    bonusTurns: Number(row.bonus_turns) || 0,
    bonusChars: Number(row.bonus_chars) || 0,
    messages,
    pending: Boolean(row.pending),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

async function findSession(db, id) {
  if (!UUID_PATTERN.test(String(id || ""))) return null;
  const row = await db.prepare(`
    SELECT id, display_name, mode, turns_used, chars_used, bonus_turns, bonus_chars,
           messages, pending, created_at, updated_at
    FROM sessions WHERE id = ?
  `).bind(id).first();
  return row ? rowToSession(row) : null;
}

function sessionMode(session, config) {
  return session.mode ? config.teamModes[session.mode] : null;
}

function effectiveLimits(session, config) {
  const mode = sessionMode(session, config);
  if (!mode) return config.limits;
  if (mode.limits.maxTurns === 0) return mode.limits;
  return {
    maxPromptChars: mode.limits.maxPromptChars,
    maxTurns: mode.limits.maxTurns + session.bonusTurns,
    maxTotalChars: mode.limits.maxTotalChars + session.bonusChars
  };
}

function publicUsage(session, limits) {
  return {
    turnsUsed: session.turnsUsed,
    turnsRemaining: limits.maxTurns === 0 ? null : Math.max(0, limits.maxTurns - session.turnsUsed),
    charsUsed: session.charsUsed,
    charsRemaining: limits.maxTotalChars === 0 ? null : Math.max(0, limits.maxTotalChars - session.charsUsed)
  };
}

function sessionPayload(session, config) {
  const mode = sessionMode(session, config);
  const limits = effectiveLimits(session, config);
  return {
    sessionId: session.id,
    displayName: session.displayName,
    mode: mode ? { id: mode.id, code: mode.code, label: mode.label, allowedStages: mode.allowedStages } : null,
    limits,
    usage: publicUsage(session, limits)
  };
}

function validateDisplayName(value) {
  const displayName = normalizeInput(value).trim();
  const length = countCharacters(displayName);
  if (!displayName) return { ok: false, message: "학생 이름 또는 번호를 입력해 주세요." };
  if (length > 40 || /\p{C}/u.test(displayName)) return { ok: false, message: "학생 이름 또는 번호는 40자 이내로 입력해 주세요." };
  return { ok: true, displayName };
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

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function signingKey(secret) {
  if (secret.length < 24) throw new Error("SESSION_SIGNING_SECRET is not configured");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function createAdminToken(secret) {
  const payload = base64Url(encoder.encode(JSON.stringify({ role: "admin", exp: Date.now() + 8 * 60 * 60 * 1000 })));
  const signature = await crypto.subtle.sign("HMAC", await signingKey(secret), encoder.encode(payload));
  return `${payload}.${base64Url(new Uint8Array(signature))}`;
}

async function verifyAdminToken(request, secret) {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token.includes(".")) return false;
  try {
    const [payload, signature] = token.split(".");
    const valid = await crypto.subtle.verify("HMAC", await signingKey(secret), fromBase64Url(signature), encoder.encode(payload));
    if (!valid) return false;
    const claims = JSON.parse(decoder.decode(fromBase64Url(payload)));
    return claims.role === "admin" && Number(claims.exp) > Date.now();
  } catch {
    return false;
  }
}

async function safeEqual(left, right) {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(String(left))),
    crypto.subtle.digest("SHA-256", encoder.encode(String(right)))
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let difference = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) difference |= (x[i] || 0) ^ (y[i] || 0);
  return difference === 0;
}

async function requireAdmin(request, config) {
  if (!config.adminPassword || !await verifyAdminToken(request, config.signingSecret)) {
    return json({ error: { code: "ADMIN_UNAUTHORIZED", message: "관리자 로그인이 필요합니다." } }, 401);
  }
  return null;
}

async function handleAdminApi(request, env, url, config) {
  if (request.method === "POST" && url.pathname === "/api/admin/login") {
    const body = await readJson(request);
    if (!config.adminPassword || !await safeEqual(body.password, config.adminPassword)) {
      return json({ error: { code: "INVALID_PASSWORD", message: "비밀번호가 올바르지 않습니다." } }, 401);
    }
    return json({ token: await createAdminToken(config.signingSecret) });
  }

  const unauthorized = await requireAdmin(request, config);
  if (unauthorized) return unauthorized;

  if (request.method === "GET" && url.pathname === "/api/admin/sessions") {
    const result = await env.DB.prepare(`
      SELECT id, display_name, mode, turns_used, chars_used, bonus_turns, bonus_chars,
             created_at, updated_at
      FROM sessions ORDER BY updated_at DESC LIMIT 500
    `).all();
    const sessions = (result.results || []).map((row) => {
      const session = rowToSession({ ...row, messages: "[]", pending: 0 });
      const mode = sessionMode(session, config);
      return {
        id: session.id,
        displayName: session.displayName,
        modeCode: mode?.code || "-",
        modeLabel: mode?.label || "알 수 없음",
        turnsUsed: session.turnsUsed,
        charsUsed: session.charsUsed,
        bonusTurns: session.bonusTurns,
        bonusChars: session.bonusChars,
        limits: effectiveLimits(session, config),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt
      };
    });
    return json({ sessions });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/grant") {
    const body = await readJson(request);
    const addTurns = Number(body.addTurns || 0);
    const addChars = Number(body.addChars || 0);
    if (!UUID_PATTERN.test(String(body.sessionId || "")) || !Number.isInteger(addTurns) || !Number.isInteger(addChars) || addTurns < 0 || addTurns > 10 || addChars < 0 || addChars > 600 || (addTurns === 0 && addChars === 0)) {
      return json({ error: { code: "INVALID_GRANT", message: "추가 지급 값이 올바르지 않습니다." } }, 400);
    }
    const result = await env.DB.prepare(`
      UPDATE sessions
      SET bonus_turns = bonus_turns + ?, bonus_chars = bonus_chars + ?, updated_at = ?
      WHERE id = ?
    `).bind(addTurns, addChars, Date.now(), body.sessionId).run();
    if ((result.meta?.changes || 0) === 0) return json({ error: { message: "학생 세션을 찾지 못했습니다." } }, 404);
    return json({ ok: true });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/reset") {
    const body = await readJson(request);
    if (!UUID_PATTERN.test(String(body.sessionId || ""))) return json({ error: { message: "학생 세션을 찾지 못했습니다." } }, 404);
    const result = await env.DB.prepare(`
      UPDATE sessions
      SET turns_used = 0, chars_used = 0, bonus_turns = 0, bonus_chars = 0,
          messages = '[]', pending = 0, updated_at = ?
      WHERE id = ?
    `).bind(Date.now(), body.sessionId).run();
    if ((result.meta?.changes || 0) === 0) return json({ error: { message: "학생 세션을 찾지 못했습니다." } }, 404);
    return json({ ok: true });
  }

  return json({ error: { message: "페이지를 찾을 수 없습니다." } }, 404);
}

async function handleStudentApi(request, env, url, config) {
  if (request.method === "GET" && url.pathname === "/api/config") {
    const stored = await findSession(env.DB, url.searchParams.get("sessionId"));
    const session = stored || newSession();
    return json({
      ...sessionPayload(session, config),
      model: config.model,
      ready: Boolean(config.apiKey && env.DB),
      teamModes: Object.values(config.teamModes)
    });
  }

  if (request.method === "POST" && url.pathname === "/api/session/configure") {
    const body = await readJson(request);
    const mode = config.teamModes[body.mode];
    if (!mode) return json({ error: { code: "INVALID_TEAM", message: "올바른 팀 조건을 선택해 주세요." } }, 400);
    const named = validateDisplayName(body.displayName);
    if (!named.ok) return json({ error: { code: "INVALID_NAME", message: named.message } }, 400);
    let session = await findSession(env.DB, body.sessionId);
    if (session?.mode && session.mode !== mode.id) {
      return json({ error: { code: "TEAM_LOCKED", message: "팀 조건은 새 대화를 시작한 뒤 다시 선택할 수 있습니다." } }, 409);
    }
    const now = Date.now();
    if (!session) {
      session = newSession(UUID_PATTERN.test(String(body.sessionId || "")) ? body.sessionId : undefined);
      session.displayName = named.displayName;
      session.mode = mode.id;
      await env.DB.prepare(`
        INSERT INTO sessions (
          id, display_name, mode, turns_used, chars_used, bonus_turns, bonus_chars,
          messages, pending, created_at, updated_at
        ) VALUES (?, ?, ?, 0, 0, 0, 0, '[]', 0, ?, ?)
      `).bind(session.id, session.displayName, session.mode, now, now).run();
    } else {
      session.displayName = named.displayName;
      session.mode = mode.id;
      session.updatedAt = now;
      await env.DB.prepare("UPDATE sessions SET display_name = ?, mode = ?, updated_at = ? WHERE id = ?")
        .bind(session.displayName, session.mode, now, session.id).run();
    }
    return json(sessionPayload(session, config));
  }

  if (request.method === "POST" && url.pathname === "/api/reset") {
    const body = await readJson(request);
    if (UUID_PATTERN.test(String(body.sessionId || ""))) {
      await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(body.sessionId).run();
    }
    return json(sessionPayload(newSession(), config));
  }

  if (request.method === "POST" && url.pathname === "/api/chat") {
    const body = await readJson(request);
    const session = await findSession(env.DB, body.sessionId);
    if (!session) return json({ error: { code: "SESSION_NOT_FOUND", message: "학생 정보와 팀 조건을 다시 선택해 주세요." } }, 404);
    const mode = sessionMode(session, config);
    const limits = effectiveLimits(session, config);
    const stageChecked = validateStage(mode, body.stage);
    if (!stageChecked.ok) return json({ sessionId: session.id, error: stageChecked }, stageChecked.status);
    const checked = validatePrompt(body.message, session, limits);
    if (!checked.ok) return json({ sessionId: session.id, error: checked }, checked.status);
    if (!config.apiKey) return json({ error: { code: "API_KEY_MISSING", message: "서버에 API 키가 설정되지 않았습니다." } }, 503);

    const lock = await env.DB.prepare("UPDATE sessions SET pending = 1 WHERE id = ? AND pending = 0").bind(session.id).run();
    if ((lock.meta?.changes || 0) === 0) return json({ error: { code: "REQUEST_IN_PROGRESS", message: "이전 답변을 생성하고 있습니다." } }, 409);

    let completed = false;
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
      await env.DB.prepare(`
        UPDATE sessions
        SET messages = ?, turns_used = ?, chars_used = ?, pending = 0, updated_at = ?
        WHERE id = ?
      `).bind(JSON.stringify(session.messages), session.turnsUsed, session.charsUsed, session.updatedAt, session.id).run();
      completed = true;
      return json({ sessionId: session.id, answer, usage: publicUsage(session, limits) });
    } catch (error) {
      const timedOut = error?.name === "TimeoutError";
      return json({
        error: {
          code: timedOut ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNAVAILABLE",
          message: timedOut ? "AI 응답 시간이 초과되었습니다. 횟수는 차감되지 않았습니다." : "AI 서버에 연결하지 못했습니다. 횟수는 차감되지 않았습니다."
        }
      }, 502);
    } finally {
      if (!completed) {
        await env.DB.prepare("UPDATE sessions SET pending = 0 WHERE id = ?").bind(session.id).run().catch(() => {});
      }
    }
  }

  return json({ error: { message: "페이지를 찾을 수 없습니다." } }, 404);
}

async function handleApi(request, env, url) {
  const config = configFrom(env);
  if (!config.signingSecret || !env.DB) return json({ error: { message: "서버 설정이 완료되지 않았습니다." } }, 503);
  if (url.pathname.startsWith("/api/admin/")) return handleAdminApi(request, env, url, config);
  return handleStudentApi(request, env, url, config);
}

function staticResponse(pathname) {
  const asset = pathname === "/" || pathname === "/index.html"
    ? [INDEX_HTML, "text/html; charset=utf-8"]
    : pathname === "/styles.css" ? [STYLES_CSS, "text/css; charset=utf-8"]
    : pathname === "/app.js" ? [APP_JS, "text/javascript; charset=utf-8"]
    : pathname === "/admin" || pathname === "/admin/" || pathname === "/admin.html" ? [ADMIN_HTML, "text/html; charset=utf-8"]
    : pathname === "/admin.css" ? [ADMIN_CSS, "text/css; charset=utf-8"]
    : pathname === "/admin.js" ? [ADMIN_JS, "text/javascript; charset=utf-8"] : null;
  if (!asset) return null;
  return new Response(asset[0], {
    headers: {
      "Content-Type": asset[1],
      "Cache-Control": pathname === "/" || pathname.startsWith("/admin") ? "no-cache" : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": pathname.startsWith("/admin") ? "noindex, nofollow" : "index, follow"
    }
  });
}

export default {
  async fetch(request, env, ctx) {
    void ctx;
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env, url);
      if (request.method === "GET" && url.pathname === "/health") {
        const config = configFrom(env);
        return json({ ok: true, model: config.model, configured: Boolean(config.apiKey && config.signingSecret && env.DB) });
      }
      if (request.method === "GET") return staticResponse(url.pathname) || new Response("Not found", { status: 404 });
      return json({ error: { message: "허용되지 않은 요청입니다." } }, 405);
    } catch (error) {
      console.error("Request failed", error);
      const storageUnavailable = String(error?.message || "").includes("no such table");
      return json({
        error: { message: storageUnavailable ? "사용 기록 저장소를 준비하고 있습니다. 잠시 후 다시 시도해 주세요." : error?.message || "서버 오류가 발생했습니다." }
      }, storageUnavailable ? 503 : error?.status || 500);
    }
  }
};
