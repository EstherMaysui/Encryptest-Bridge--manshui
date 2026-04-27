from __future__ import annotations

import json
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from flask import Flask, jsonify, request
from flask_sock import Sock

app = Flask(__name__)
sock = Sock(app)

TARGET_PATTERN = ""
DEFAULT_TIMEOUT_SECONDS = 20
MAX_HISTORY = 200


@dataclass
class TaskRecord:
    request_id: str
    data: Any
    trace_id: str | None = None
    status: str = "queued"
    result: Any = None
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    duration_ms: int | None = None


class TaskState:
    def __init__(self) -> None:
        self.tasks: dict[str, TaskRecord] = {}
        self.task_events: dict[str, threading.Event] = {}
        self.extension_socket = None
        self.extension_connected_at: float | None = None
        self.extension_last_seen_at: float | None = None
        self.extension_info: dict[str, Any] = {}
        self.lock = threading.RLock()

    def create_task(self, data: Any, trace_id: str | None) -> tuple[TaskRecord, threading.Event]:
        request_id = str(uuid.uuid4())
        task = TaskRecord(request_id=request_id, data=data, trace_id=trace_id)
        event = threading.Event()
        with self.lock:
            self.tasks[request_id] = task
            self.task_events[request_id] = event
            self._trim_history_locked()
        return task, event

    def update_task(self, request_id: str, **kwargs: Any) -> TaskRecord | None:
        with self.lock:
            task = self.tasks.get(request_id)
            if not task:
                return None
            for key, value in kwargs.items():
                setattr(task, key, value)
            if task.started_at and task.finished_at:
                task.duration_ms = int((task.finished_at - task.started_at) * 1000)
            event = self.task_events.get(request_id)
            if event and task.status in {"success", "error", "timeout"}:
                event.set()
            return task

    def get_task(self, request_id: str) -> TaskRecord | None:
        with self.lock:
            return self.tasks.get(request_id)

    def list_tasks(self) -> list[TaskRecord]:
        with self.lock:
            return sorted(self.tasks.values(), key=lambda item: item.created_at, reverse=True)

    def set_extension_socket(self, ws) -> None:
        with self.lock:
            self.extension_socket = ws
            self.extension_connected_at = time.time()
            self.extension_last_seen_at = time.time()

    def clear_extension_socket(self, ws) -> None:
        with self.lock:
            if self.extension_socket is ws:
                self.extension_socket = None

    def mark_extension_seen(self, info: dict[str, Any] | None = None) -> None:
        with self.lock:
            self.extension_last_seen_at = time.time()
            if info is not None:
                self.extension_info = info

    def send_to_extension(self, payload: dict[str, Any]) -> None:
        with self.lock:
            ws = self.extension_socket
        if ws is None:
            raise RuntimeError("Edge 插件尚未连接")
        ws.send(json.dumps(payload, ensure_ascii=False))

    def _trim_history_locked(self) -> None:
        if len(self.tasks) <= MAX_HISTORY:
            return
        ordered = sorted(self.tasks.values(), key=lambda item: item.created_at, reverse=True)
        keep_ids = {task.request_id for task in ordered[:MAX_HISTORY]}
        remove_ids = [task_id for task_id in self.tasks if task_id not in keep_ids]
        for task_id in remove_ids:
            self.tasks.pop(task_id, None)
            self.task_events.pop(task_id, None)


state = TaskState()


def serialize_task(task: TaskRecord) -> dict[str, Any]:
    return {
        "request_id": task.request_id,
        "trace_id": task.trace_id,
        "status": task.status,
        "data": task.data,
        "result": task.result,
        "error": task.error,
        "created_at": task.created_at,
        "started_at": task.started_at,
        "finished_at": task.finished_at,
        "duration_ms": task.duration_ms,
    }


@sock.route("/ws")
def extension_ws(ws):
    state.set_extension_socket(ws)
    try:
        while True:
            message = ws.receive()
            if message is None:
                break
            try:
                payload = json.loads(message)
            except json.JSONDecodeError:
                continue

            message_type = payload.get("type")
            if message_type == "hello":
                state.mark_extension_seen({
                    "client": payload.get("client"),
                    "version": payload.get("version"),
                    "target": payload.get("target"),
                    "queue": payload.get("queue"),
                    "running": payload.get("running"),
                    "concurrency": payload.get("concurrency"),
                })
                continue

            if message_type == "heartbeat":
                state.mark_extension_seen({
                    "target": payload.get("target"),
                    "queue": payload.get("queue"),
                    "running": payload.get("running"),
                    "concurrency": payload.get("concurrency"),
                })
                continue

            request_id = payload.get("request_id")
            if not request_id:
                continue

            if message_type == "task_update":
                state.update_task(
                    request_id,
                    status=payload.get("status", "running"),
                    started_at=payload.get("started_at") or time.time(),
                    error=payload.get("error"),
                )
                state.mark_extension_seen()
                continue

            if message_type == "task_result":
                status = payload.get("status", "success")
                state.update_task(
                    request_id,
                    status=status,
                    result=payload.get("result"),
                    error=payload.get("error"),
                    finished_at=payload.get("finished_at") or time.time(),
                )
                state.mark_extension_seen()
    finally:
        state.clear_extension_socket(ws)


@app.get("/health")
def health():
    return jsonify({
        "ok": True,
        "extension_connected": state.extension_socket is not None,
        "extension_connected_at": state.extension_connected_at,
        "extension_last_seen_at": state.extension_last_seen_at,
        "target_pattern": TARGET_PATTERN,
        "extension_info": state.extension_info,
    })


@app.get("/tasks")
def list_tasks():
    limit = int(request.args.get("limit", 50))
    tasks = [serialize_task(task) for task in state.list_tasks()[:limit]]
    return jsonify({
        "ok": True,
        "tasks": tasks,
    })


@app.get("/task/<request_id>")
def get_task(request_id: str):
    task = state.get_task(request_id)
    if not task:
        return jsonify({"ok": False, "error": "任务不存在"}), 404
    return jsonify({"ok": True, "task": serialize_task(task)})


@app.post("/encrypt")
def encrypt():
    body = request.get_json(silent=True) or {}
    if "data" not in body:
        return jsonify({"ok": False, "error": "缺少 data 参数"}), 400

    trace_id = body.get("trace_id")
    timeout = float(body.get("timeout", DEFAULT_TIMEOUT_SECONDS))
    task, event = state.create_task(body.get("data"), trace_id)

    payload = {
        "type": "encrypt_request",
        "request_id": task.request_id,
        "trace_id": trace_id,
        "data": task.data,
        "created_at": task.created_at,
        "target_pattern": TARGET_PATTERN,
    }

    try:
        state.send_to_extension(payload)
    except Exception as exc:
        state.update_task(task.request_id, status="error", error=str(exc), finished_at=time.time())
        return jsonify({
            "ok": False,
            "request_id": task.request_id,
            "error": str(exc),
        }), 500

    completed = event.wait(timeout=timeout)
    current_task = state.get_task(task.request_id)
    if not completed and current_task and current_task.status not in {"success", "error"}:
        state.update_task(task.request_id, status="timeout", error="调用超时", finished_at=time.time())
        current_task = state.get_task(task.request_id)

    response_task = current_task or task
    ok = response_task.status == "success"
    status_code = 200 if ok else 500
    if response_task.status == "timeout":
        status_code = 504

    return jsonify({
        "ok": ok,
        "request_id": response_task.request_id,
        "status": response_task.status,
        "result": response_task.result,
        "error": response_task.error,
    }), status_code


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=18080, threaded=True)
