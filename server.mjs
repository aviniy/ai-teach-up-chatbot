import http from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  countCharacters,
  createTeamModes,
  parseLimit,
  publicUsage,
  validatePrompt,
  validateStage
} from "./lib.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
loadEnv(join(root, ".env"));

const config = {
  port: parseLimit(process.env.PORT, 3210) || 3210,
  apiKey: (process.env.BAZE_API_KEY || process.env.FACTCHAT_API_KEY || "").trim(),
  baseUrl: (process.env.BAZE_BASE_URL || process.env.FACTCHAT_BASE_URL || "https://factchat-cloud.mindlogic.ai/v1/gateway").replace(/\/+$/, ""),
  model: process.env.BAZE_MODEL || process.env.FACTCHAT_MODEL || "gpt-5.6-terra",
  adminPassword: (process.env.ADMIN_PASSWORD || "").trim(),
  systemPrompt:
    process.env.SYSTEM_PROMPT ||
    "당신은 중학생 토론 활동을 돕는 AI입니다. 제공된 맥락 안에서 간결하게 답하고, 불확실한 사실을 지어내지 마세요. 최종 판단은 학생이 하도록 근거와 한계를 구분해 설명하세요.",
  limits: {
    maxPromptChars: parseLimit(process.env.MAX_PROMPT_CHARS, 60),
    maxTurns: parseLimit(process.env.MAX_TURNS, 5),
    maxTotalChars: parseLimit(process.env.MAX_TOTAL_CHARS, 300)
  }
};

const teamModes = createTeamModes(config.limits);
const sessions = new Map();
const adminTokens = new Map();
const dataDirectory = join(root, "data");
const sessionFile = join(dataDirectory, "sessions.json");
const MAX_SESSIONS = 2000;
let persistQueue = Promise.resolve();

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

function loadSessions() {
  if (!existsSync(sessionFile)) return;
  try {
    const rows = JSON.parse(readFileSync(sessionFile, "utf8"));
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!row?.id || !row?.mode || !teamModes[row.mode]) continue;
      sessions.set(row.id, {
        id: row.id,
        displayName: String(row.displayName || "학생"),
        mode: row.mode,
        turnsUsed: Number(row.turnsUsed) || 0,
        charsUsed: Number(row.charsUsed) || 0,
        bonusTurns: Number(row.bonusTurns) || 0,
        bonusChars: Number(row.bonusChars) || 0,
        messages: Array.isArray(row.messages) ? row.messages.slice(-16) : [],
        updatedAt: Number(row.updatedAt) || Date.now(),
        pending: false
      });
    }
  } catch (error) {
    console.error("저장된 세션을 불러오지 못했습니다.", error.message);
  }
}

async function persistSessions() {
  await mkdir(dataDirectory, { recursive: true });
  const temp = join(dataDirectory, "sessions.tmp.json");
  const rows = [...sessions.values()].filter((session) => session.mode).map(({ pending, ...session }) => session);
  await writeFile(temp, JSON.stringify(rows, null, 2), "utf8");
  await rename(temp, sessionFile);
}

function queuePersist() {
  persistQueue = persistQueue.then(persistSessions).catch((error) => console.error("세션 저장 실패:", error.message));
  return persistQueue;
}

function createSession(id = randomUUID()) {
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.values()].filter((item) => !item.pending).sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (oldest) sessions.delete(oldest.id);
  }
  const session = {
    id,
    displayName: "",
    mode: null,
    turnsUsed: 0,
    charsUsed: 0,
    bonusTurns: 0,
    bonusChars: 0,
    messages: [],
    updatedAt: Date.now(),
    pending: false
  };
  sessions.set(id, session);
  return session;
}

function getSession(id) {
  return typeof id === "string" && sessions.has(id) ? sessions.get(id) : createSession();
}

function sessionMode(session) {
  return session.mode ? teamModes[session.mode] : null;
}

function effectiveLimits(session) {
  const mode = sessionMode(session);
  if (!mode) return config.limits;
  if (mode.limits.maxTurns === 0) return mode.limits;
  return {
    maxPromptChars: mode.limits.maxPromptChars,
    maxTurns: mode.limits.maxTurns + session.bonusTurns,
    maxTotalChars: mode.limits.maxTotalChars + session.bonusChars
  };
}

function sessionPayload(session) {
  const mode = sessionMode(session);
  const limits = effectiveLimits(session);
  return {
    sessionId: session.id,
    displayName: session.displayName,
    mode: mode ? { id: mode.id, code: mode.code, label: mode.label, allowedStages: mode.allowedStages } : null,
    limits,
    usage: publicUsage(session, limits)
  };
}

function validateDisplayName(value) {
  const displayName = String(value ?? "").trim().normalize("NFC");
  if (!displayName || countCharacters(displayName) > 40 || /\p{C}/u.test(displayName)) return null;
  return displayName;
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32 * 1024) throw Object.assign(new Error("요청 본문이 너무 큽니다."), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("올바른 JSON 요청이 아닙니다."), { status: 400 });
  }
}

function passwordMatches(value) {
  const expected = createHash("sha256").update(config.adminPassword).digest();
  const actual = createHash("sha256").update(String(value || "")).digest();
  return timingSafeEqual(expected, actual);
}

function authorizeAdmin(request) {
  const header = request.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const expiresAt = adminTokens.get(token);
  if (!expiresAt || expiresAt < Date.now()) {
    if (token) adminTokens.delete(token);
    return false;
  }
  return true;
}

async function handleAdmin(request, response, pathname) {
  if (request.method === "POST" && pathname === "/api/admin/login") {
    const body = await readJson(request);
    if (!config.adminPassword) return sendJson(response, 503, { error: { message: "관리자 비밀번호가 설정되지 않았습니다." } });
    if (!passwordMatches(body.password)) return sendJson(response, 401, { error: { message: "비밀번호가 올바르지 않습니다." } });
    const token = randomBytes(32).toString("base64url");
    adminTokens.set(token, Date.now() + 8 * 60 * 60 * 1000);
    return sendJson(response, 200, { token });
  }

  if (!authorizeAdmin(request)) return sendJson(response, 401, { error: { message: "관리자 로그인이 필요합니다." } });

  if (request.method === "GET" && pathname === "/api/admin/sessions") {
    const list = [...sessions.values()]
      .filter((session) => session.mode)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((session) => {
        const mode = sessionMode(session);
        return {
          id: session.id,
          displayName: session.displayName,
          modeCode: mode.code,
          modeLabel: mode.label,
          turnsUsed: session.turnsUsed,
          charsUsed: session.charsUsed,
          bonusTurns: session.bonusTurns,
          bonusChars: session.bonusChars,
          limits: effectiveLimits(session),
          updatedAt: session.updatedAt
        };
      });
    return sendJson(response, 200, { sessions: list });
  }

  const body = await readJson(request);
  const session = sessions.get(body.sessionId);
  if (!session?.mode) return sendJson(response, 404, { error: { message: "학생 세션을 찾지 못했습니다." } });

  if (request.method === "POST" && pathname === "/api/admin/grant") {
    const addTurns = Number(body.addTurns || 0);
    const addChars = Number(body.addChars || 0);
    if (!Number.isInteger(addTurns) || !Number.isInteger(addChars) || addTurns < 0 || addTurns > 10 || addChars < 0 || addChars > 600 || (!addTurns && !addChars)) {
      return sendJson(response, 400, { error: { message: "추가 지급 값이 올바르지 않습니다." } });
    }
    session.bonusTurns += addTurns;
    session.bonusChars += addChars;
    session.updatedAt = Date.now();
    await queuePersist();
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === "POST" && pathname === "/api/admin/reset") {
    session.turnsUsed = 0;
    session.charsUsed = 0;
    session.bonusTurns = 0;
    session.bonusChars = 0;
    session.messages = [];
    session.pending = false;
    session.updatedAt = Date.now();
    await queuePersist();
    return sendJson(response, 200, { ok: true });
  }

  return sendJson(response, 404, { error: { message: "페이지를 찾을 수 없습니다." } });
}

async function handleChat(request, response) {
  const body = await readJson(request);
  const session = sessions.get(body.sessionId);
  if (!session?.mode) return sendJson(response, 404, { error: { message: "학생 정보와 팀 조건을 다시 선택해 주세요." } });
  if (session.pending) return sendJson(response, 409, { error: { message: "이전 답변을 생성하고 있습니다." } });

  const mode = sessionMode(session);
  const limits = effectiveLimits(session);
  const stageChecked = validateStage(mode, body.stage);
  if (!stageChecked.ok) return sendJson(response, stageChecked.status, { sessionId: session.id, error: stageChecked });
  const checked = validatePrompt(body.message, session, limits);
  if (!checked.ok) return sendJson(response, checked.status, { sessionId: session.id, error: checked });
  if (!config.apiKey || config.apiKey.includes("여기에_")) {
    return sendJson(response, 503, { error: { message: "서버에 FactChat API 키가 설정되지 않았습니다." } });
  }

  session.pending = true;
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
    if (!upstream.ok) return sendJson(response, upstream.status >= 500 ? 502 : upstream.status, { error: { message: data?.error?.message || `AI API 오류 (${upstream.status})` } });
    const answer = data?.choices?.[0]?.message?.content;
    if (typeof answer !== "string" || !answer.trim()) return sendJson(response, 502, { error: { message: "AI가 읽을 수 있는 답변을 반환하지 않았습니다." } });

    session.messages.push({ role: "user", content: checked.normalized }, { role: "assistant", content: answer.slice(0, 5000) });
    session.messages = session.messages.slice(-16);
    session.turnsUsed += 1;
    session.charsUsed += checked.length;
    session.updatedAt = Date.now();
    await queuePersist();
    return sendJson(response, 200, { sessionId: session.id, answer, usage: publicUsage(session, limits) });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError";
    return sendJson(response, 502, { error: { message: timedOut ? "AI 응답 시간이 초과되었습니다. 횟수는 차감되지 않았습니다." : "AI 서버에 연결하지 못했습니다. 횟수는 차감되지 않았습니다." } });
  } finally {
    session.pending = false;
  }
}

async function serveStatic(request, response) {
  const rawPath = new URL(request.url, "http://localhost").pathname;
  const route = rawPath === "/" ? "index.html" : rawPath === "/admin" || rawPath === "/admin/" ? "admin.html" : decodeURIComponent(rawPath.slice(1));
  const safePath = normalize(route).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(root, "public", safePath);
  const publicRoot = join(root, "public");
  if (!filePath.startsWith(publicRoot)) return sendJson(response, 403, { error: { message: "접근할 수 없습니다." } });
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml"
  }[extname(filePath)] || "application/octet-stream";
  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mime,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    });
    response.end(content);
  } catch {
    sendJson(response, 404, { error: { message: "페이지를 찾을 수 없습니다." } });
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    const { pathname } = url;
    if (pathname.startsWith("/api/admin/")) return await handleAdmin(request, response, pathname);
    if (request.method === "GET" && pathname === "/api/config") {
      const session = getSession(url.searchParams.get("sessionId"));
      return sendJson(response, 200, {
        ...sessionPayload(session), model: config.model,
        ready: Boolean(config.apiKey && !config.apiKey.includes("여기에_")),
        teamModes: Object.values(teamModes)
      });
    }
    if (request.method === "POST" && pathname === "/api/session/configure") {
      const body = await readJson(request);
      const session = getSession(body.sessionId);
      const mode = teamModes[body.mode];
      const displayName = validateDisplayName(body.displayName);
      if (!mode) return sendJson(response, 400, { error: { message: "올바른 팀 조건을 선택해 주세요." } });
      if (!displayName) return sendJson(response, 400, { error: { message: "학생 이름 또는 번호를 40자 이내로 입력해 주세요." } });
      if (session.mode && session.mode !== mode.id) return sendJson(response, 409, { error: { message: "팀 조건은 새 대화를 시작한 뒤 다시 선택할 수 있습니다." } });
      session.displayName = displayName;
      session.mode = mode.id;
      session.updatedAt = Date.now();
      await queuePersist();
      return sendJson(response, 200, sessionPayload(session));
    }
    if (request.method === "POST" && pathname === "/api/chat") return await handleChat(request, response);
    if (request.method === "POST" && pathname === "/api/reset") {
      const body = await readJson(request);
      if (typeof body.sessionId === "string") sessions.delete(body.sessionId);
      await queuePersist();
      return sendJson(response, 200, sessionPayload(createSession()));
    }
    if (request.method === "GET" && pathname === "/health") {
      return sendJson(response, 200, { ok: true, model: config.model, configured: Boolean(config.apiKey), storage: "local" });
    }
    if (request.method === "GET") return await serveStatic(request, response);
    return sendJson(response, 405, { error: { message: "허용되지 않은 요청입니다." } });
  } catch (error) {
    console.error(error);
    sendJson(response, error.status || 500, { error: { message: error.message || "서버 오류가 발생했습니다." } });
  }
});

loadSessions();
server.listen(config.port, "127.0.0.1", () => {
  console.log(`AI Teach-Up 챗봇: http://localhost:${config.port}`);
  console.log(`관리자 페이지: http://localhost:${config.port}/admin`);
  console.log(`모델: ${config.model} · B/C팀 ${config.limits.maxPromptChars}자·${config.limits.maxTurns}회 · D팀 무제한`);
});
