function formatJson(value) {
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return String(value);
  }
}

function taskItemClass(task) {
  return `task-item ${task.status || "queued"}`;
}

function renderTasks(tasks) {
  const taskList = document.getElementById("taskList");
  if (!tasks.length) {
    taskList.innerHTML = "<div class=\"task-item\">暂无任务</div>";
    return;
  }

  taskList.innerHTML = tasks.map((task) => `
    <div class="${taskItemClass(task)}">
      <div class="task-meta">
        <span>${task.status || "queued"}</span>
        <span>${task.request_id || "-"}</span>
      </div>
      <div class="task-meta">
        <span>trace: ${task.trace_id || "-"}</span>
        <span>${task.duration_ms || 0} ms</span>
      </div>
      <div class="task-block">
        <strong>参数</strong>
        <pre>${escapeHtml(formatJson(task.data))}</pre>
      </div>
      <div class="task-block">
        <strong>结果</strong>
        <pre>${escapeHtml(formatJson(task.result))}</pre>
      </div>
      <div class="task-block">
        <strong>错误</strong>
        <pre>${escapeHtml(formatJson(task.error))}</pre>
      </div>
    </div>
  `).join("");
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function applyState(state) {
  document.getElementById("connectionState").textContent = state.connectionState || "unknown";
  document.getElementById("runningCount").textContent = String(state.runningCount || 0);
  document.getElementById("queueCount").textContent = String((state.queue || []).length || 0);
  document.getElementById("concurrencyInput").value = String(state.concurrency || 1);
  document.getElementById("targetPatternInput").value = state.targetPattern || "";
  renderTasks(state.history || []);
}

function parseManualInput() {
  const raw = document.getElementById("manualInput").value;
  if (!raw) {
    return "";
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    return raw;
  }
}

async function refreshState() {
  const state = await chrome.runtime.sendMessage({ type: "get_state" });
  applyState(state);
}

document.getElementById("refreshBtn").addEventListener("click", refreshState);

document.getElementById("saveSettingsBtn").addEventListener("click", async () => {
  const concurrency = Number(document.getElementById("concurrencyInput").value || 1);
  const targetPattern = document.getElementById("targetPatternInput").value || "";
  await chrome.runtime.sendMessage({ type: "set_concurrency", value: concurrency });
  await chrome.runtime.sendMessage({ type: "set_target_pattern", value: targetPattern });
  await refreshState();
});

document.getElementById("clearHistoryBtn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "clear_history" });
  await refreshState();
});

document.getElementById("manualRunBtn").addEventListener("click", async () => {
  const data = parseManualInput();
  await chrome.runtime.sendMessage({ type: "manual_encrypt", data });
  await refreshState();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "state_update") {
    applyState(message);
  }
});

refreshState();
