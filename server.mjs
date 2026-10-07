import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createTeamModes, parseLimit, publicUsage, validatePrompt, validateStage } from "./lib.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
loadEnv(join(root, ".env"));

const config = {
  port: parseLimit(process.env.PORT, 3210) || 3210,
  apiKey: (process.env.BAZE_API_KEY || process.env.FACTCHAT_API_KEY || "").trim(),
  baseUrl: (process.env.BAZE_BASE_URL || process.env.FACTCHAT_BASE_URL || "https://factchat-cloud.mindlogic.ai/v1/gateway").replace(/\/+$/, ""),
  model: process.env.BAZE_MODEL || process.env.FACTCHAT_MODEL || "gpt-5.6-terra",
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
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_SESSIONS = 1000;

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function createSession() {
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
    if (oldest) sessions.delete(oldest[0]);
  }
  const id = randomUUID();
  const session = { id, mode: null, turnsUsed: 0, charsUsed: 0, messages: [], updatedAt: Date.now(), pending: false };
  sessions.set(id, session);
  return session;
}

function sessionMode(session) {
  return session.mode ? teamModes[session.mode] : null;
}

function sessionPayload(session) {
  const mode = sessionMode(session);
  const limits = mode?.limits ?? config.limits;
  return {
    sessionId: session.id,
    mode: mode ? { id: mode.id, code: mode.code, label: mode.label, allowedStages: mode.allowedStages } : null,
    limits,
    usage: publicUsage(session, limits)
  };
}

function getSession(id) {
  const session = typeof id === "string" ? sessions.get(id) : null;
  if (!session || Date.now() - session.updatedAt > SESSION_TTL_MS) {
    if (session) sessions.delete(session.id);
    return createSession();
  }
  session.updatedAt = Date.now();
  return session;
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

async function handleChat(request, response) {
  const body = await readJson(request);
  const session = getSession(body.sessionId);

  if (session.pending) {
    return sendJson(response, 409, { error: { code: "REQUEST_IN_PROGRESS", message: "이전 답변을 생성하고 있습니다." } });
  }

  const mode = sessionMode(session);
  const stageChecked = validateStage(mode, body.stage);
  if (!stageChecked.ok) return sendJson(response, stageChecked.status, { sessionId: session.id, error: stageChecked });

  const checked = validatePrompt(body.message, session, mode.limits);
  if (!checked.ok) return sendJson(response, checked.status, { sessionId: session.id, error: checked });

  if (!config.apiKey || config.apiKey.includes("여기에_")) {
    return sendJson(response, 503, {
      sessionId: session.id,
      error: { code: "API_KEY_MISSING", message: "서버에 FactChat API 키가 설정되지 않았습니다." }
    });
  }

  session.pending = true;
  try {
    const upstream = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: "system",
            content: `${config.systemPrompt}\n현재 사용 조건은 ${mode.code} ${mode.label}이고, 활동 구간은 ${body.stage === "initial" ? "초기 준비" : "반론 준비"}입니다.`
          },
          ...session.messages,
          { role: "user", content: checked.normalized }
        ],
        temperature: 0.4
      }),
      signal: AbortSignal.timeout(60_000)
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const upstreamMessage = data?.error?.message || `FactChat API 오류 (${upstream.status})`;
      return sendJson(response, upstream.status >= 500 ? 502 : upstream.status, {
        sessionId: session.id,
        error: { code: "UPSTREAM_ERROR", message: upstreamMessage }
      });
    }

    const answer = data?.choices?.[0]?.message?.content;
    if (typeof answer !== "string" || !answer.trim()) {
      return sendJson(response, 502, {
        sessionId: session.id,
        error: { code: "EMPTY_UPSTREAM_RESPONSE", message: "AI가 읽을 수 있는 답변을 반환하지 않았습니다." }
      });
    }

    session.messages.push(
      { role: "user", content: checked.normalized },
      { role: "assistant", content: answer }
    );
    session.turnsUsed += 1;
    session.charsUsed += checked.length;
    session.updatedAt = Date.now();

    return sendJson(response, 200, {
      sessionId: session.id,
      answer,
      usage: publicUsage(session, mode.limits)
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError";
    return sendJson(response, 502, {
      sessionId: session.id,
      error: {
        code: timedOut ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNAVAILABLE",
        message: timedOut ? "AI 응답 시간이 초과되었습니다. 횟수는 차감되지 않았습니다." : "AI 서버에 연결하지 못했습니다. 횟수는 차감되지 않았습니다."
      }
    });
  } finally {
    session.pending = false;
  }
}

async function serveStatic(request, response) {
  const rawPath = new URL(request.url, "http://localhost").pathname;
  const requested = rawPath === "/" ? "index.html" : decodeURIComponent(rawPath.slice(1));
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
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
    const { pathname } = new URL(request.url, "http://localhost");
    if (request.method === "GET" && pathname === "/api/config") {
      const session = getSession(new URL(request.url, "http://localhost").searchParams.get("sessionId"));
      return sendJson(response, 200, {
        ...sessionPayload(session),
        model: config.model,
        ready: Boolean(config.apiKey && !config.apiKey.includes("여기에_")),
        teamModes: Object.values(teamModes)
      });
    }
    if (request.method === "POST" && pathname === "/api/session/configure") {
      const body = await readJson(request);
      const session = getSession(body.sessionId);
      const mode = teamModes[body.mode];
      if (!mode) return sendJson(response, 400, { error: { code: "INVALID_TEAM", message: "올바른 팀 조건을 선택해 주세요." } });
      if (session.mode && session.mode !== mode.id) {
        return sendJson(response, 409, { error: { code: "TEAM_LOCKED", message: "팀 조건은 새 대화를 시작한 뒤 다시 선택할 수 있습니다." } });
      }
      session.mode = mode.id;
      session.updatedAt = Date.now();
      return sendJson(response, 200, sessionPayload(session));
    }
    if (request.method === "POST" && pathname === "/api/chat") return await handleChat(request, response);
    if (request.method === "POST" && pathname === "/api/reset") {
      const body = await readJson(request);
      if (typeof body.sessionId === "string") sessions.delete(body.sessionId);
      const session = createSession();
      return sendJson(response, 200, sessionPayload(session));
    }
    if (request.method === "GET" && pathname === "/health") {
      return sendJson(response, 200, { ok: true, model: config.model, configured: Boolean(config.apiKey) });
    }
    if (request.method === "GET") return await serveStatic(request, response);
    return sendJson(response, 405, { error: { message: "허용되지 않은 요청입니다." } });
  } catch (error) {
    sendJson(response, error.status || 500, { error: { message: error.message || "서버 오류가 발생했습니다." } });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.updatedAt > SESSION_TTL_MS) sessions.delete(id);
  }
}, 30 * 60 * 1000).unref();

server.listen(config.port, "127.0.0.1", () => {
  console.log(`AI Teach-Up 챗봇: http://localhost:${config.port}`);
  console.log(`모델: ${config.model} · B/C팀 ${config.limits.maxPromptChars}자·${config.limits.maxTurns}회 · D팀 무제한`);
});
