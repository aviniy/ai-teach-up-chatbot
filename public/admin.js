const state = {
  token: sessionStorage.getItem("ai-teach-up-admin") || "",
  sessions: []
};

const el = {
  loginPanel: document.querySelector("#login-panel"),
  loginMessage: document.querySelector("#login-message"),
  loginForm: document.querySelector("#login-form"),
  password: document.querySelector("#password"),
  dashboard: document.querySelector("#dashboard"),
  list: document.querySelector("#session-list"),
  empty: document.querySelector("#empty"),
  notice: document.querySelector("#notice"),
  total: document.querySelector("#total-count"),
  active: document.querySelector("#active-count"),
  search: document.querySelector("#search"),
  refresh: document.querySelector("#refresh"),
  logout: document.querySelector("#logout")
};

function showNotice(message) {
  el.notice.textContent = message;
  el.notice.hidden = !message;
}

function authHeaders() {
  return { Authorization: `Bearer ${state.token}`, "Content-Type": "application/json" };
}

function formatTime(value) {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
  }).format(new Date(value));
}

function usageText(session) {
  if (session.limits.maxTurns === 0) {
    return `<strong>${session.turnsUsed}회</strong><small>${session.charsUsed}자 · 제한 없음</small>`;
  }
  const bonus = session.bonusTurns || session.bonusChars
    ? `<small>추가 +${session.bonusTurns}회 · +${session.bonusChars}자</small>` : "";
  return `<strong>${session.turnsUsed} / ${session.limits.maxTurns}회</strong><small>${session.charsUsed} / ${session.limits.maxTotalChars}자</small>${bonus}`;
}

function actionButton(label, action, value = "", className = "") {
  return `<button type="button" class="${className}" data-action="${action}" data-value="${value}">${label}</button>`;
}

function render() {
  const query = el.search.value.trim().toLocaleLowerCase("ko");
  const rows = state.sessions.filter((item) => item.displayName.toLocaleLowerCase("ko").includes(query));
  el.list.innerHTML = rows.map((session) => `
    <tr data-id="${session.id}">
      <td><span class="student-name"></span></td>
      <td><span class="team-badge">${session.modeCode} · ${session.modeLabel}</span></td>
      <td class="usage">${usageText(session)}</td>
      <td><div class="action-set">
        ${actionButton("+1회·60자", "bundle", 1)}${actionButton("+3회·180자", "bundle", 3)}
        ${actionButton("+60자만", "chars", 60)}
      </div></td>
      <td><div class="action-set">${actionButton("사용량 초기화", "reset", "", "reset")}</div></td>
      <td class="timestamp">${formatTime(session.updatedAt)}</td>
    </tr>`).join("");

  for (const row of el.list.querySelectorAll("tr")) {
    const session = rows.find((item) => item.id === row.dataset.id);
    row.querySelector(".student-name").textContent = session.displayName;
  }
  el.empty.hidden = rows.length > 0;
  el.total.textContent = state.sessions.length;
  el.active.textContent = state.sessions.filter((item) => Date.now() - item.updatedAt < 24 * 60 * 60 * 1000).length;
}

async function loadSessions() {
  const response = await fetch("/api/admin/sessions", { headers: authHeaders() });
  if (response.status === 401) return logout();
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "사용 현황을 불러오지 못했습니다.");
  state.sessions = data.sessions;
  render();
}

function showDashboard() {
  el.loginPanel.hidden = true;
  el.dashboard.hidden = false;
  el.refresh.hidden = false;
  el.logout.hidden = false;
}

function logout() {
  state.token = "";
  sessionStorage.removeItem("ai-teach-up-admin");
  el.loginPanel.hidden = false;
  el.dashboard.hidden = true;
  el.refresh.hidden = true;
  el.logout.hidden = true;
  el.password.value = "";
}

el.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: el.password.value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || "로그인하지 못했습니다.");
    state.token = data.token;
    sessionStorage.setItem("ai-teach-up-admin", state.token);
    showDashboard();
    showNotice("");
    await loadSessions();
  } catch (error) {
    el.loginMessage.textContent = error.message;
  }
});

el.list.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const row = button.closest("tr");
  const action = button.dataset.action;
  if (action === "reset" && !window.confirm("이 학생의 사용량과 추가 지급분을 모두 초기화할까요?")) return;
  button.disabled = true;
  try {
    const endpoint = action === "reset" ? "/api/admin/reset" : "/api/admin/grant";
    const body = { sessionId: row.dataset.id };
    if (action === "bundle") {
      body.addTurns = Number(button.dataset.value);
      body.addChars = Number(button.dataset.value) * 60;
    }
    if (action === "chars") body.addChars = Number(button.dataset.value);
    const response = await fetch(endpoint, {
      method: "POST", headers: authHeaders(), body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || "처리하지 못했습니다.");
    showNotice("");
    await loadSessions();
  } catch (error) {
    showNotice(error.message);
  } finally {
    button.disabled = false;
  }
});

el.search.addEventListener("input", render);
el.refresh.addEventListener("click", () => loadSessions().catch((error) => showNotice(error.message)));
el.logout.addEventListener("click", logout);

if (state.token) {
  showDashboard();
  loadSessions().catch(() => logout());
}
