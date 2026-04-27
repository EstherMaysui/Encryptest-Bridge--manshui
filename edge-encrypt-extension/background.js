const BRIDGE_URL = "ws://127.0.0.1:18080/ws";
const MAX_HISTORY = 100;
let socket = null;
let reconnectTimer = null;
let queue = [];
let runningCount = 0;
let concurrency = 1;
let connectionState = "disconnected";
let lastHeartbeatAt = null;
let history = [];
let targetPattern = "";

function now() {
  return Date.now() / 1000;
}

function cloneTask(task) {
  return JSON.parse(JSON.stringify(task));
}

async function loadState() {
  const saved = await chrome.storage.local.get(["history", "concurrency", "targetPattern"]);
  history = Array.isArray(saved.history) ? saved.history : [];
  concurrency = Number.isInteger(saved.concurrency) && saved.concurrency > 0 ? saved.concurrency : 1;
  targetPattern = typeof saved.targetPattern === "string" ? saved.targetPattern : "";
}

async function persistState() {
  await chrome.storage.local.set({
    history,
    concurrency,
    targetPattern
  });
}

function trimHistory() {
  if (history.length > MAX_HISTORY) {
    history = history.slice(0, MAX_HISTORY);
  }
}

async function broadcastState() {
  const payload = {
    type: "state_update",
    connectionState,
    queue,
    runningCount,
    concurrency,
    history,
    targetPattern,
    lastHeartbeatAt
  };
  try {
    await chrome.runtime.sendMessage(payload);
  } catch (error) {
  }
}

async function upsertHistoryTask(task) {
  const index = history.findIndex((item) => item.request_id === task.request_id);
  if (index >= 0) {
    history[index] = { ...history[index], ...cloneTask(task) };
  } else {
    history.unshift(cloneTask(task));
  }
  trimHistory();
  await persistState();
  await broadcastState();
}

async function setConnectionState(nextState) {
  connectionState = nextState;
  await broadcastState();
}

async function getTargetTab() {
  let tabs = [];
  if (targetPattern) {
    tabs = await chrome.tabs.query({ url: targetPattern });
  }
  if (!tabs.length) {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  const targetTab = tabs.find((tab) => typeof tab.id === "number");
  if (!targetTab) {
    throw new Error("没有找到目标标签页");
  }
  return targetTab;
}

async function inspectTarget() {
  try {
    const tab = await getTargetTab();
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: () => ({
        href: location.href,
        title: document.title,
        hasEncryptest: typeof window.encryptest === "function"
      })
    });
    return result[0]?.result || null;
  } catch (error) {
    return {
      error: error.message || String(error)
    };
  }
}

async function sendHello() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  const target = await inspectTarget();
  socket.send(JSON.stringify({
    type: "hello",
    client: "edge-extension",
    version: "0.1.0",
    target,
    queue: queue.length,
    running: runningCount,
    concurrency
  }));
}

async function sendHeartbeat() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  lastHeartbeatAt = now();
  const target = await inspectTarget();
  socket.send(JSON.stringify({
    type: "heartbeat",
    target,
    queue: queue.length,
    running: runningCount,
    concurrency,
    time: lastHeartbeatAt
  }));
  await broadcastState();
}

async function executeEncrypt(task) {
  const tab = await getTargetTab();
  const startedAt = now();
  await upsertHistoryTask({ ...task, status: "running", started_at: startedAt });
  socket.send(JSON.stringify({
    type: "task_update",
    request_id: task.request_id,
    status: "running",
    started_at: startedAt
  }));

  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: async (input) => {
        if (typeof window.encryptest !== "function") {
          throw new Error("window.encryptest 不是函数");
        }
        return await window.encryptest(input);
      },
      args: [task.data]
    });

    const finishedAt = now();
    const response = {
      type: "task_result",
      request_id: task.request_id,
      status: "success",
      result: result[0]?.result,
      finished_at: finishedAt
    };
    socket.send(JSON.stringify(response));
    await upsertHistoryTask({
      ...task,
      status: "success",
      result: result[0]?.result,
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: Math.round((finishedAt - startedAt) * 1000)
    });
  } catch (error) {
    const finishedAt = now();
    const message = error?.message || String(error);
    socket.send(JSON.stringify({
      type: "task_result",
      request_id: task.request_id,
      status: "error",
      error: message,
      finished_at: finishedAt
    }));
    await upsertHistoryTask({
      ...task,
      status: "error",
      error: message,
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: Math.round((finishedAt - startedAt) * 1000)
    });
  }
}

async function processQueue() {
  while (runningCount < concurrency && queue.length > 0) {
    const task = queue.shift();
    runningCount += 1;
    await broadcastState();
    executeEncrypt(task)
      .finally(async () => {
        runningCount -= 1;
        await broadcastState();
        await processQueue();
      });
  }
}

async function handleBridgeMessage(rawMessage) {
  let payload;
  try {
    payload = JSON.parse(rawMessage);
  } catch (error) {
    return;
  }

  if (payload.type !== "encrypt_request") {
    return;
  }

  const task = {
    request_id: payload.request_id,
    trace_id: payload.trace_id,
    data: payload.data,
    status: "queued",
    created_at: payload.created_at || now()
  };

  queue.push(task);
  await upsertHistoryTask(task);
  await processQueue();
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  socket = new WebSocket(BRIDGE_URL);
  setConnectionState("connecting");

  socket.onopen = async () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    await setConnectionState("connected");
    await sendHello();
  };

  socket.onmessage = async (event) => {
    await handleBridgeMessage(event.data);
  };

  socket.onclose = async () => {
    socket = null;
    await setConnectionState("disconnected");
    reconnectTimer = setTimeout(connect, 1500);
  };

  socket.onerror = async () => {
    await setConnectionState("error");
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onStartup.addListener(async () => {
  await loadState();
  connect();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "get_state") {
    sendResponse({
      connectionState,
      queue,
      runningCount,
      concurrency,
      history,
      targetPattern,
      lastHeartbeatAt
    });
    return true;
  }

  if (message?.type === "set_concurrency") {
    concurrency = Math.max(1, Number(message.value) || 1);
    persistState().then(() => processQueue()).then(() => broadcastState());
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "set_target_pattern") {
    targetPattern = typeof message.value === "string" ? message.value : "";
    persistState().then(() => broadcastState());
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "clear_history") {
    history = [];
    persistState().then(() => broadcastState());
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "manual_encrypt") {
    const manualTask = {
      request_id: `manual-${Date.now()}`,
      trace_id: "manual",
      data: message.data,
      status: "queued",
      created_at: now()
    };
    queue.push(manualTask);
    upsertHistoryTask(manualTask).then(() => processQueue());
    sendResponse({ ok: true, request_id: manualTask.request_id });
    return true;
  }

  if (message?.type === "ping_bridge") {
    sendHeartbeat().then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  return false;
});

loadState().then(() => {
  connect();
  setInterval(() => {
    sendHeartbeat();
  }, 5000);
});
