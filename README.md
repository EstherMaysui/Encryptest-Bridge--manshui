# Encryptest Bridge - manshui

这是一个用于替代传统 JSRPC 注入方式的本地桥接方案。

它的核心思路是：

- 使用 **Edge 插件** 连接本地服务
- 由插件在目标网页主环境中执行 `window.encryptest(data)`
- 通过 **Flask + WebSocket** 将调用结果返回给本地 Python 脚本
- 同时在插件侧边栏里可视化展示当前请求参数、执行状态和加密结果

适合这样的场景：

- 网页中已经存在 `window.encryptest`
- 不想再手动往控制台里注入 JSRPC 环境
- 希望由本地 Python 脚本直接调用网页中的加密函数
- 希望有一个可视化界面查看最近的请求和结果

---

## 项目结构

```text
jsrpc替代方案-manshui/
├─ bridge_server.py
├─ 调用实例.py
├─ 全局注册函数.txt
└─ edge-encrypt-extension/
   ├─ manifest.json
   ├─ background.js
   ├─ sidepanel.html
   ├─ sidepanel.css
   └─ sidepanel.js
```

说明：

- `bridge_server.py`：本地 Flask 服务，负责 HTTP 接口和与插件的 WebSocket 通信
- `调用实例.py`：最小 Python 调用示例
- `全局注册函数.txt`：网页里 `window.encryptest` 的参考示例
- `edge-encrypt-extension/`：Edge 插件目录

---

## 工作流程

整体流程如下：

```text
Python 脚本
   ↓ HTTP POST /encrypt
bridge_server.py
   ↓ WebSocket
Edge 插件 background.js
   ↓ executeScript(world: MAIN)
目标网页 window.encryptest(data)
   ↓
插件返回执行结果
   ↓
Flask 返回给 Python
```

插件侧边栏还会展示：

- 当前连接状态
- 当前运行中的任务数
- 队列长度
- 最近任务参数
- 最近加密结果
- 错误信息

---

## 运行环境

建议环境：

- Windows
- Python 3.10+
- Microsoft Edge

Python 依赖：

```bash
pip install flask flask-sock requests
```

---

## 第一步：启动本地服务

在项目根目录执行：

```bash
python bridge_server.py
```

默认监听地址：

- HTTP：`http://127.0.0.1:18080`
- WebSocket：`ws://127.0.0.1:18080/ws`

当前已实现接口：

### 1. 健康检查

```http
GET /health
```

返回插件是否已连接、本地状态等信息。

### 2. 获取最近任务

```http
GET /tasks
```

可选参数：

- `limit`：默认 `50`

### 3. 查询单个任务

```http
GET /task/<request_id>
```

### 4. 发起加密请求

```http
POST /encrypt
Content-Type: application/json
```

请求体示例：

```json
{
  "data": "123456",
  "trace_id": "demo-1",
  "timeout": 20
}
```

返回示例：

```json
{
  "ok": true,
  "request_id": "xxxxxx",
  "status": "success",
  "result": "加密结果",
  "error": null
}
```

---

## 第二步：加载 Edge 插件

插件目录：

```text
edge-encrypt-extension
```

加载步骤：

1. 打开 `edge://extensions/`
2. 打开“开发人员模式”
3. 点击“加载解压缩的扩展”
4. 选择 `edge-encrypt-extension` 文件夹

插件加载后，会自动连接：

```text
ws://127.0.0.1:18080/ws
```

如果连接成功，可以访问：

```text
http://127.0.0.1:18080/health
```

检查返回中的：

```json
"extension_connected": true
```

---

## 第三步：打开目标网页

确保目标网页中已经存在：

```js
window.encryptest
```

你可以在网页控制台先验证：

```js
typeof window.encryptest
```

如果返回：

```js
"function"
```

说明插件可以调用它。

如果网页里没有这个函数，那么插件执行时会返回：

```text
window.encryptest 不是函数
```

---

## 第四步：使用插件侧边栏

当前插件包含一个侧边栏界面，标题为：

```text
Encryptest Bridge -manshui
```

侧边栏支持查看：

- 连接状态
- 运行中数量
- 队列长度
- 并发数
- 目标匹配规则
- 最近任务记录
- 参数、结果、错误信息

还支持：

### 1. 手动测试

在侧边栏中输入参数后，点击：

```text
执行 encryptest
```

即可直接调用目标网页中的：

```js
window.encryptest(data)
```

### 2. 设置目标匹配规则

如果不希望总是调用当前激活标签页，可以在侧边栏里填写匹配规则，例如：

```text
*://*.example.com/*
```

这样插件会优先匹配符合规则的页面。

### 3. 设置并发数

插件中已经预留并发设置。

不过建议初期先保持：

```text
1
```

因为不同网页中的 `encryptest` 可能依赖全局状态，高并发执行时有可能串数据。

---

## Python 调用示例

参考文件：

- [调用实例.py](file:///c:/Users/李/Desktop/liren工具箱/JSRPC/jsrpc替代方案-manshui/调用实例.py)

示例代码：

```python
import requests

resp = requests.post(
    "http://127.0.0.1:18080/encrypt",
    json={
        "data": "123456",
        "trace_id": "demo-1"
    },
    timeout=30
)

print(resp.json())
```

如果你想传对象，也可以这样：

```python
import requests

resp = requests.post(
    "http://127.0.0.1:18080/encrypt",
    json={
        "data": {
            "username": "admin",
            "password": "123456"
        },
        "trace_id": "login-encrypt"
    },
    timeout=30
)

print(resp.json())
```

---

## 网页函数示例

如果你只是本地测试，可以参考：

- [全局注册函数.txt](file:///c:/Users/李/Desktop/liren工具箱/JSRPC/jsrpc替代方案-manshui/全局注册函数.txt)

网页中常见形式是：

```js
window.encryptest = function(password) {
    return CryptoJS.AES.encrypt(password, key, {
        iv: iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
    }).toString();
};
```

插件调用的就是类似这样的全局函数。

---

## 当前初版能力

当前版本已经具备：

- Flask HTTP 服务
- 插件与 Flask 的 WebSocket 通信
- 调用目标网页的 `window.encryptest(data)`
- 返回执行结果给 Python
- 侧边栏展示最近任务
- 队列机制
- 基础并发数设置
- 手动测试入口

---

## 当前限制

这是初版，当前有一些限制：

### 1. 默认只适合本地使用

当前服务监听：

```text
127.0.0.1:18080
```

没有做鉴权，不建议暴露到公网。

### 2. 并发能力是基础版

虽然插件中已经有并发数设置，但建议先保持为 1。

### 3. 队列主要在插件内存中维护

浏览器扩展重载后，未完成任务不会恢复。

### 4. 插件必须能访问目标网页主环境

当前使用的是：

```js
chrome.scripting.executeScript({ world: "MAIN" })
```

这是为了确保能调用网页自己的 `window.encryptest`。

### 5. 目前没有参数脱敏

侧边栏里显示的是完整参数和结果。如果你处理的是敏感数据，建议下一版增加脱敏显示。

---

## 常见排查

### 1. `/health` 显示插件未连接

检查：

- Flask 服务是否已启动
- 插件是否已加载
- Edge 插件是否报错

### 2. 调用时报 `window.encryptest 不是函数`

检查当前网页：

```js
typeof window.encryptest
```

如果不是 `function`，说明目标页没有这个函数，或者函数不在页面主环境里。

### 3. 调用超时

可能原因：

- 网页执行逻辑卡住
- 当前标签页不是目标页
- 目标匹配规则写错
- 插件已连接但执行失败未及时返回

### 4. Python 请求失败

检查：

- `bridge_server.py` 是否正在运行
- 请求地址是否为 `http://127.0.0.1:18080/encrypt`
- 请求体里是否包含 `data`

---

## 后续可继续增强的方向

后面可以继续补：

- `.gitignore`
- 请求历史分页
- 参数与结果脱敏显示
- 异步任务接口
- 自动重试
- 域名白名单
- 调用日志导出
- 更完善的并发控制
- 指定固定标签页执行

---

## 相关文件

- [bridge_server.py](file:///c:/Users/李/Desktop/liren工具箱/JSRPC/jsrpc替代方案-manshui/bridge_server.py)
- [manifest.json](file:///c:/Users/李/Desktop/liren工具箱/JSRPC/jsrpc替代方案-manshui/edge-encrypt-extension/manifest.json)
- [background.js](file:///c:/Users/李/Desktop/liren工具箱/JSRPC/jsrpc替代方案-manshui/edge-encrypt-extension/background.js)
- [sidepanel.html](file:///c:/Users/李/Desktop/liren工具箱/JSRPC/jsrpc替代方案-manshui/edge-encrypt-extension/sidepanel.html)
- [sidepanel.css](file:///c:/Users/李/Desktop/liren工具箱/JSRPC/jsrpc替代方案-manshui/edge-encrypt-extension/sidepanel.css)
- [sidepanel.js](file:///c:/Users/李/Desktop/liren工具箱/JSRPC/jsrpc替代方案-manshui/edge-encrypt-extension/sidepanel.js)
- [调用实例.py](file:///c:/Users/李/Desktop/liren工具箱/JSRPC/jsrpc替代方案-manshui/调用实例.py)
- [全局注册函数.txt](file:///c:/Users/李/Desktop/liren工具箱/JSRPC/jsrpc替代方案-manshui/全局注册函数.txt)
