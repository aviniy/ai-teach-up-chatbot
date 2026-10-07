const state = {
  sessionId: localStorage.getItem("ai-teach-up-session") || "",
  teamModes: [],
  mode: null,
  stage: null,
  limits: { maxPromptChars: 60, maxTurns: 5, maxTotalChars: 300 },
  usage: { turnsUsed: 0, turnsRemaining: 5, charsUsed: 0, charsRemaining: 300 },
  sending: false
};

const elements = {
  form: document.querySelector("#chat-form"),
  prompt: document.querySelector("#prompt"),
  send: document.querySelector("#send-button"),
  reset: document.querySelector("#reset-button"),
  messages: document.querySelector("#messages"),
  notice: document.querySelector("#notice"),
  counter: document.querySelector("#char-counter"),
  counterWrap: document.querySelector(".counter-wrap"),
  promptLimit: document.querySelector("#prompt-limit"),
  turnLimit: document.querySelector("#turn-limit"),
  totalLimit: document.querySelector("#total-limit"),
  turnProgress: document.querySelector("#turn-progress"),
  charProgress: document.querySelector("#char-progress"),
  progressBar: document.querySelector("#progress-bar"),
  apiStatus: document.querySelector("#api-status"),
  teamChooser: document.querySelector("#team-chooser"),
  teamOptions: document.querySelector("#team-options"),
  teamTitle: document.querySelector("#rule-title"),
  teamDescription: document.querySelector("#team-description"),
  stageSwitcher: document.querySelector("#stage-switcher")
};

const segmenter = new Intl.Segmenter("ko", { granularity: "grapheme" });
const countCharacters = (value) => [...segmenter.segment(value.replace(/\r\n?/g, "\n").normalize("NFC"))].length;
const limitLabel = (value, unit) => (value === 0 ? "제한 없음" : `${value}${unit}`);

function selectedMode() {
  return state.teamModes.find((mode) => mode.id === state.mode?.id) || null;
}

function applySession(data) {
  state.sessionId = data.sessionId;
  state.mode = data.mode;
  state.limits = data.limits;
  state.usage = data.usage;
  localStorage.setItem("ai-teach-up-session", state.sessionId);
  const mode = selectedMode();
  if (mode && !mode.allowedStages.includes(state.stage)) state.stage = mode.allowedStages[0];
}

function renderTeamOptions() {
  elements.teamOptions.replaceChildren();
  for (const mode of state.teamModes) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "team-option";
    button.dataset.mode = mode.id;
    const code = document.createElement("span");
    code.className = "team-code";
    code.textContent = mode.code;
    const name = document.createElement("strong");
    name.textContent = mode.label;
    const description = document.createElement("p");
    description.textContent = mode.description;
    const summary = document.createElement("small");
    summary.textContent = mode.limits.maxTurns === 0 ? "횟수·글자 수 제한 없음" : `회당 ${mode.limits.maxPromptChars}자 · 최대 ${mode.limits.maxTurns}회`;
    button.append(code, name, description, summary);
    button.addEventListener("click", () => configureTeam(mode.id));
    elements.teamOptions.append(button);
  }
}

function updateView() {
  const mode = selectedMode();
  const hasMode = Boolean(mode);
  const { limits, usage } = state;
  const promptLength = countCharacters(elements.prompt.value);
  const overPrompt = limits.maxPromptChars > 0 && promptLength > limits.maxPromptChars;
  const overTotal = limits.maxTotalChars > 0 && promptLength > usage.charsRemaining;
  const exhausted = limits.maxTurns > 0 && usage.turnsRemaining === 0;

  elements.teamChooser.hidden = hasMode;
  elements.messages.hidden = !hasMode;
  elements.form.hidden = !hasMode;
  elements.stageSwitcher.hidden = !hasMode;
  elements.teamTitle.textContent = mode ? `${mode.code} · ${mode.label}` : "팀 조건을 선택해 주세요";
  elements.teamDescription.textContent = mode ? mode.description : "선택한 조건은 새 대화 전까지 유지됩니다.";
  elements.promptLimit.textContent = limitLabel(limits.maxPromptChars, "자");
  elements.turnLimit.textContent = limitLabel(limits.maxTurns, "회");
  elements.totalLimit.textContent = limitLabel(limits.maxTotalChars, "자");
  elements.counter.textContent = limits.maxPromptChars === 0 ? `${promptLength}자` : `${promptLength} / ${limits.maxPromptChars}자`;
  elements.counterWrap.classList.toggle("over", overPrompt || overTotal);
  elements.turnProgress.textContent = limits.maxTurns === 0 ? `${usage.turnsUsed}회 사용` : `${usage.turnsUsed} / ${limits.maxTurns}회`;
  elements.charProgress.textContent = limits.maxTotalChars === 0 ? `누적 ${usage.charsUsed}자 · 제한 없음` : `누적 ${usage.charsUsed}자 · ${usage.charsRemaining}자 남음`;
  elements.progressBar.style.width = limits.maxTurns === 0 ? "0%" : `${Math.min(100, (usage.turnsUsed / limits.maxTurns) * 100)}%`;
  elements.send.disabled = !hasMode || state.sending || !elements.prompt.value.trim() || overPrompt || overTotal || exhausted;
  elements.prompt.disabled = exhausted;
  elements.prompt.placeholder = exhausted ? "사용 가능 횟수를 모두 사용했습니다" : "필요한 도움과 확인할 조건을 적어 주세요";

  for (const button of elements.stageSwitcher.querySelectorAll("button")) {
    const allowed = mode?.allowedStages.includes(button.dataset.stage) ?? false;
    button.disabled = !allowed || state.sending;
    button.classList.toggle("active", state.stage === button.dataset.stage);
  }
}

function setStatus(ready) {
  elements.apiStatus.dataset.state = ready ? "ready" : "error";
  elements.apiStatus.lastChild.textContent = ready ? "API 연결 준비됨" : "API 키 설정 필요";
}

function showNotice(message) {
  elements.notice.textContent = message;
  elements.notice.hidden = !message;
}

function addMessage(role, content, temporary = false) {
  const article = document.createElement("article");
  article.className = `message ${role}-message`;
  if (temporary) article.dataset.temporary = "true";
  if (role === "assistant") {
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = "AI";
    article.append(avatar);
  }
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const paragraph = document.createElement("p");
  paragraph.textContent = content;
  bubble.append(paragraph);
  article.append(bubble);
  elements.messages.append(article);
  elements.messages.scrollTop = elements.messages.scrollHeight;
  return article;
}

function addTyping() {
  const article = addMessage("assistant", "", true);
  article.querySelector("p").remove();
  const typing = document.createElement("span");
  typing.className = "typing";
  typing.setAttribute("aria-label", "AI가 답변을 작성하고 있습니다");
  typing.innerHTML = "<i></i><i></i><i></i>";
  article.querySelector(".bubble").append(typing);
  return article;
}

async function configureTeam(mode) {
  elements.teamOptions.querySelectorAll("button").forEach((button) => (button.disabled = true));
  try {
    const response = await fetch("/api/session/configure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId, mode })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || "팀 조건을 설정하지 못했습니다.");
    applySession(data);
    showNotice("");
    updateView();
    elements.prompt.focus();
  } catch (error) {
    showNotice(error.message);
  } finally {
    elements.teamOptions.querySelectorAll("button").forEach((button) => (button.disabled = false));
  }
}

async function initialize() {
  try {
    const query = state.sessionId ? `?sessionId=${encodeURIComponent(state.sessionId)}` : "";
    const response = await fetch(`/api/config${query}`);
    const data = await response.json();
    state.teamModes = data.teamModes;
    applySession(data);
    renderTeamOptions();
    setStatus(data.ready);
  } catch {
    elements.apiStatus.dataset.state = "error";
    elements.apiStatus.lastChild.textContent = "서버 연결 실패";
    showNotice("서버에 연결할 수 없습니다. 실행 상태를 확인해 주세요.");
  }
  updateView();
}

elements.stageSwitcher.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-stage]");
  if (!button || button.disabled) return;
  state.stage = button.dataset.stage;
  updateView();
});

elements.prompt.addEventListener("input", () => {
  showNotice("");
  updateView();
});

elements.prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (!elements.send.disabled) elements.form.requestSubmit();
  }
});

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (elements.send.disabled) return;
  const message = elements.prompt.value;
  addMessage("user", message);
  elements.prompt.value = "";
  state.sending = true;
  showNotice("");
  updateView();
  const typing = addTyping();
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId, stage: state.stage, message })
    });
    const data = await response.json();
    typing.remove();
    if (!response.ok) throw new Error(data?.error?.message || "답변을 생성하지 못했습니다.");
    state.sessionId = data.sessionId;
    localStorage.setItem("ai-teach-up-session", state.sessionId);
    state.usage = data.usage;
    addMessage("assistant", data.answer);
  } catch (error) {
    typing.remove();
    showNotice(error.message);
  } finally {
    state.sending = false;
    updateView();
    elements.prompt.focus();
  }
});

elements.reset.addEventListener("click", async () => {
  elements.reset.disabled = true;
  try {
    const response = await fetch("/api/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId })
    });
    const data = await response.json();
    applySession(data);
    state.stage = null;
    elements.messages.querySelectorAll(".message:not(.intro-message)").forEach((message) => message.remove());
    elements.prompt.value = "";
    showNotice("");
  } catch {
    showNotice("새 대화를 시작하지 못했습니다.");
  } finally {
    elements.reset.disabled = false;
    updateView();
  }
});

document.querySelectorAll("[data-prompt]").forEach((button) => {
  button.addEventListener("click", () => {
    elements.prompt.value = button.dataset.prompt;
    elements.prompt.focus();
    updateView();
  });
});

initialize();

