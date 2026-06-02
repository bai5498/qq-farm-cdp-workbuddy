这是一个偏工程实验性质的项目。和"农场脚本"本身相比，更值得看的其实是两件事：

- 如何把非标准小游戏调试链路补成可用的 CDP / RPC
- 如何把游戏内能力层、外部网关、网页控制台拆开

项目目前已经同时支持两条路线：

- 微信小游戏调试环境：`CDP + 自动注入 button.js`
- QQ 小程序本地资源环境：`WebSocket 宿主 + QQ bundle`

hook 代码感谢 [evi0s/WMPFDebugger](https://github.com/evi0s/WMPFDebugger)

> **⚠️ 原创声明**
>
> 本项目原始作者为 **[linguo2625469](https://github.com/linguo2625469)**，原始仓库地址：<https://github.com/linguo2625469/qq-farm-cdp-auto>
>
> 本 fork 仅在原项目基础上进行了 **Bug 修复和稳定性改进**，未改变项目核心架构和功能。所有原创设计、代码和文档的著作权归原作者所有。
>
> Bug 修复内容详见 [修复日志](#修复日志)。

# 农场自动化控制台

## 30 秒快速开始

安装依赖：

```bash
npm install
```

微信路线：

```bash
npm run start:wx
```

QQ 路线：

```bash
npm run start:qq
```

启动后打开控制页：

- 默认地址：<http://127.0.0.1:8787/>

如果是 QQ 路线：

1. 进入控制页“运行时”页签
2. 若已知 `appid`，直接填入页面里的 “QQ 小程序 AppID”
3. 点击“保存 QQ Bundle”导出 bundle，或点击“一键打补丁” 自动查找最新 QQ 资源目录并把 bundle 写入 `game.js`
4. 再启动 QQ 小程序

## 当前架构

### 微信 / CDP

- `wmpf/` 把小游戏调试协议补成可用的 CDP
- `public/index.html` 通过网关拿状态、预览、输入事件
- 上下文就绪后自动注入 [`button.js`](button.js)
- 自动农场通过 `gameCtl.*` 执行业务动作

### QQ / WebSocket

- `button.js` 仍然只负责游戏内能力层
- [`qq-host.js`](qq-host.js) 是小程序内常驻宿主
- 网关通过 `/miniapp` WebSocket 和宿主 RPC 通信
- QQ bundle = `button.js + qq-host.js`
- 可在网页中直接导出 bundle，或直接给 `game.js` 打补丁

## 项目目录

| 路径 | 说明 |
|------|------|
| [`wmpf/`](wmpf) | 微信小游戏调试桥、Frida hook、CDP 代理。 |
| [`src/`](src) | 网关、自动农场编排、QQ WS / CDP transport、bundle 生成。 |
| [`public/`](public) | 网页控制台。 |
| [`button.js`](button.js) | 游戏内能力层，暴露 `gameCtl.*`。 |
| [`qq-host.js`](qq-host.js) | QQ 小程序宿主模板。 |
| [`scripts/patch-qq-miniapp.cjs`](scripts/patch-qq-miniapp.cjs) | 命令行生成 / 打补丁工具。 |
| [`docs/qq-ws-automation-plan.md`](docs/qq-ws-automation-plan.md) | QQ WebSocket 自动化改造计划。 |

## 环境要求

- Windows
- Node.js >= 22
- 微信路线需要可用的微信 PC 版调试环境
- QQ 路线需要能访问本地 `game.js` 资源文件

说明：

- `frida` 安装慢、编译慢、卡住，多半是本机环境问题，不是本项目逻辑问题
- 支持的微信版本可看 [`wmpf/frida/config`](wmpf/frida/config)

## 环境变量

正常情况无需设置环境变量 使用对应命令启动即可 AI代码有点杂乱 后续会优化


## 控制页说明

控制页现在是运行时感知的，不再把 QQ 路线硬套成 CDP。

主要页签：

- `自动农场`
  - 自己农场定时一键收获、浇水、除草、杀虫
  - 好友列表扫描、进好友农场偷菜
  - 可配置轮询间隔、每轮好友数、进场等待、动作等待、回家、出错停止、自动种植
- `运行时`
  - 显示当前到底走 `微信 CDP` 还是 `QQ WS`
  - 显示 QQ 宿主最近日志
  - 支持填写 `appid` 自动查找最新 QQ 小程序 `game.js`
  - 可直接“保存 QQ Bundle”
  - 新版qqnt，可直接“一键打补丁”
- `画面预览`
  - 仅 CDP 路线可用
  - 仅支持点击
- `好友农场`
  - 获取好友列表
  - 直接进入指定好友农场
- `消息日志`
  - 控制页收发消息和自动农场日志

## QQ 路线使用方式

### 方式 1：网页导出 bundle

适合不想记命令的人。

1. `npm run start:qq`
2. 打开控制页
3. 进入“运行时”页签
4. 点击“保存 QQ Bundle”
5. 把导出的内容放进 QQ 小程序 `game.js`

说明：

- 浏览器支持 `showSaveFilePicker` 时，会弹系统保存框
- 不支持时，会走普通文件下载

### 方式 2：网页一键打补丁(推荐 傻瓜式)

前提：

- 你是新版qqnt
- 或已配置 `FARM_QQ_GAME_JS`

1. `npm run start:qq`
2. 打开控制页
3. 进入“运行时”页签
4. 若未配置默认值，先填写 `QQ 小程序 AppID`
5. 点击“一键打补丁”

补丁行为：

- 首次写入时会生成 `game.js.qq-farm.bak`
- 重复执行会替换旧标记区块，不会无限追加
- 若未显式配置 `FARM_QQ_GAME_JS`，会扫描 `%APPDATA%\\QQEX\\miniapp\\temps\\miniapp_src` 下 `appid_*` 目录，并选取最近更新的一份 `game.js`

### 方式 3：命令行生成 / 打补丁

仅当你想绕过网页时使用。

只生成 bundle：

```bash
npm run qq:bundle
```

直接补丁：

```bash
npm run qq:patch
```

## 微信路线使用方式

1. `npm run start:wx`
2. 打开目标小游戏
3. 打开控制页
4. 等待上下文就绪
5. 页面会自动注入 `button.js`

说明：

- 微信路线下，画面预览、点击、拖动都走 CDP
- 若出现 `CDP timeout`，一般先检查启动顺序 必须先运行脚本 再打开/重进小程序  并且关闭小程序后需重新运行脚本

## 已实现功能

- 微信 CDP 路线自动探测上下文并自动注入 `button.js`
- QQ WebSocket 宿主链路
- QQ bundle 生成
- QQ `game.js` 一键打补丁
- QQ `appid -> 最新版本目录 -> game.js` 自动发现
- 自动农场调度：
  - 自己农场一键收获 / 浇水 / 除草 / 杀虫 / 种植
  - 好友列表刷新、进入好友农场、一键偷菜
  - 自动回家
  - 自动种植
- 好友列表获取与进入指定好友农场
- 运行时状态页
- CDP 画面预览与网页点击 / 拖动输入
- 消息日志与自动农场最近日志展示

## 默认端口

| 服务 | 默认值 |
|------|------|
| 微信调试 WebSocket | `9421` |
| CDP 代理 | `62000` |
| 网关 HTTP | `8787` |
| 网关控制 WebSocket | `/ws` |
| QQ 宿主 WebSocket | `/miniapp` |

## 常见说明

### 为什么 QQ 和微信不是同一条底层链路

不是故意拆开，而是宿主条件不同：

- 微信这边本来就有调试链路，适合走 CDP
- QQ 这边能直接改资源文件，适合走“常驻宿主 + 本机 WebSocket”

所以统一的是“启动入口”和“网页控制台”，不是强行把两端伪装成同一种底层协议。

### 为什么 QQ 预览还没有网页实时画面

当前网页实时预览还是 CDP 能力。QQ 路线现在先解决的是自动化控制链路和工程化补丁，没把画面采集也接到宿主里。

## 免责声明

- 本仓库仅供学习、研究与安全测试
- 作者与贡献者与腾讯、QQ、微信及其小游戏无关联
- 对第三方软件进行注入、调试或自动化，可能违反协议并导致封号、限制功能或其他后果
- 一切风险由使用者自行承担

## 许可证

本项目使用 [GNU GPL v3.0](LICENSE)。

## 修复日志

### 2026-06-02 功能修复（1 项）

#### 🟠 High

| Bug | 文件 | 描述 |
|-----|------|------|
| 升级弹窗阻塞自动化流程 | auto-farm-executor.js | 收获后等级提升弹出升级弹窗，`BlockInputEvents` 遮罩层阻止所有后续游戏操作，导致 `getFriendList` 超时、自动化停止 |

**修复方案：**

新增 `tryDismissOverlay()` 辅助函数，调用已有的 `gameCtl.dismissActiveOverlay` 评分检测+关闭机制。静默执行，不抛异常，无弹窗时什么都不做。

在以下 5 个关键操作点插入弹窗检测：

| 调用点 | 说明 |
|--------|------|
| 一键操作后 | 收获/浇水/除草/杀虫后 |
| 批量操作后 | `runBatchLandCareTask`（自己农场） |
| 施肥操作后 | `fertilizeLands` 后 |
| 好友收获后 | 偷菜后 |
| 好友帮忙后 | `runBatchLandCareTask`（好友农场） |

### 2026-05-27 Bug 修复（18 项）

#### 🔴 Critical

| Bug | 文件 | 描述 |
|-----|------|------|
| autoFarmPlantSource 传错参数 | auto-farm-manager.js | `normalizeAutoPlantSource(src.autoFarmPlantMode)` → `normalizeAutoPlantSource(src.autoFarmPlantSource, src.autoFarmPlantMode)`，种子来源配置此前永远不生效 |

#### 🟠 High

| Bug | 文件 | 描述 |
|-----|------|------|
| gameCtlReadyChanged 事件未 emit | qq-ws-session.js | 收到事件后只更新内部状态，未 `this.emit()`，导致 gateway 监听器为死代码（自动补丁、自动启动全部失效） |
| toPositiveNumber(0) 返回 null | utils.js | `n > 0` 改为 `n >= 0`，landId=0 的地块此前被跳过 |
| 模板字面量注入风险 | gateway.js / game-ctl-utils.js | 脚本内容含反引号或 `${}` 会破坏模板，改为字符串拼接 |

#### 🟡 Medium

| Bug | 文件 | 描述 |
|-----|------|------|
| 施肥 "all" 策略逻辑错误 | auto-farm-executor.js | 空地也被选中，移除 `|| grid.interactable === true` |
| opts 运算符优先级 | auto-farm-executor.js | 加括号修正，fertilizeMinLevel 改用 `!= null` |
| loadFarmConfig 竞态 | gateway.js | 保存 configLoadedPromise，start/runOnce 时 await |
| CDP 双重重连冲突 | gateway.js | gateway 创建 CdpSession 时设 `reconnectEnabled: false` |
| 错误被静默吞没 | cdp-wmpf-session.js | `catch(() => {})` → `catch(e => console.debug(...))` |

#### 🟢 Low

| Bug | 文件 | 描述 |
|-----|------|------|
| 魔术数字 | preview-manager.js | `1` → `WebSocket.OPEN` |
| PNG quality 误传 | preview-manager.js | JPEG 时才传 quality 参数 |
| 重复 toInt 函数 | preview-manager.js | 删除本地定义，改为 `require("./utils")` |
| 重复 normalizeFriendStrategy | auto-farm-plant-config.js | 抽到共享模块，删除 executor+manager 重复定义 |
| payload\|\|null | qq-ws-session.js | 改为 `??` 运算符，保留合法 falsy 值 |
| 冗余 path.join | qq-bundle.js | `path.join(path.join(...))` → `path.join(...)` |
| 冗余导出 | game-ctl-utils.js / qq-bundle.js | 移除未使用的 wrapCallExpression / sha1Hex / trimToString |

#### Web UI 改进

- 开始/停止自动化按钮颜色根据运行状态自动切换
- 底部区域改为修复日志展示


