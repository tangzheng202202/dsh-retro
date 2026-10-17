# dsh-retro — DeepSeek Harness 复盘插件（方向 A1 原型）

事件驱动的**任务复盘采集层**：把 session 事件流自动折叠成结构化轨迹，并提供
`retro_review` 工具让模型在任务收尾时提交结构化复盘，供后续"复盘 → 技能沉淀 →
进化门控"（方向 A/B）使用。

> 定位：这是自进化路径 L3（复盘型 agent）的第一块地基。零 npm 依赖，默认
> **enabled:false**，装上不动作。

## 心智模型

    session 事件流
      │  ctx.on('session/event')
      ▼
    SessionTracker（纯内存折叠：工具成败/纠正/todo/轮次/时长）
      │
      ├─ turn/end ──► turns/2026-08.jsonl（每回合轨迹，仅统计，无参数/正文）
      ├─ flush/disposed ──► sessions/<id>.json（会话摘要 + worthRetro 判定）
      ▼
    模型任务收尾 → retro_review 工具 ──► retros/<id>.json（结构化复盘）
                                           │
                                           └─ memoryFacts ──(尽力)──► OpenViking

## 安装

先有一个能跑的 dsh（下面用 web profile）。插件是纯 JS，没有构建步骤。Node.js 18 或更高（`package.json` 的 `engines`）。运行时代码只用到更早就有的 `node:` 导入和 `??=`，但仓库的 `npm test` 走 `node --test`，这是 Node 18 才有的；16 没有跑过，所以不把 engines 写成 16。

从 GitHub 装：

```sh
dsh plugin --profile web add "github:tangzheng202202/dsh-retro#main"
```

在本机改代码时，用你自己的克隆目录，不要照抄别人的家目录路径：

```sh
dsh plugin --profile web add link:/你的克隆目录
```

装完要重启 `dsh web` 才生效。

### 默认是关的，这样打开

不改配置的话，插件只打一行 `installed but disabled`，不监听会话、不注册工具、不写文件。这是故意的：没点头之前不采集。

dsh 的补丁是按 `id` 找到这一行，然后**整段换掉** `config`，不是按键合并。`name` 写了就必须是 `dsh-retro`，写错会被跳过。没写到的配置项会回到插件代码里的默认值。

把下面这段加进 `$DSH_HOME/cordis.patch.yml`（没改过 `DSH_HOME` 的话就是 `~/.dsh/cordis.patch.yml`）。只想作用于 web profile 时，写到 `$DSH_HOME/profiles/web/cordis.patch.yml`。文件不存在就新建。

```yaml
- id: dsh-retro
  name: dsh-retro
  config:
    enabled: true
    remind: true
```

`remind: true` 会在 system prompt 里加一句收尾约定，让模型自己去调 `retro_review`。不想注入提示就删掉这一行，或写成 `false`。

然后：

```sh
dsh web --dump-config | grep dsh-retro
```

输出里应能看到 `enabled: true`。重启 `dsh web`。

成功的日志是：

```text
[dsh-retro] started: root=... remind=on viking=on inbox=on
```

还是 `installed but disabled`，就是开关没合上。

### 一分钟确认它在写文件

开启并重启后，存储目录会出现（默认 `$DSH_HOME/storages/dsh-retro`，也就是 `~/.dsh/storages/dsh-retro`）。往 `inbox/` 放一个 `.json`，例如 `hello.json`：

```json
{
  "sessionId": "hello",
  "taskType": "plugin-dev",
  "outcome": "success",
  "summary": "装上 dsh-retro 之后，确认复盘文件落了盘。",
  "skillCandidates": [
    {
      "name": "check-retro-files",
      "trigger": "刚装上 dsh-retro，想确认有没有写盘",
      "instructions": "打开 storages/dsh-retro/retros，看有没有新的 json 文件。",
      "confidence": 0.5
    }
  ]
}
```

再重启一次（或最多等约 60 秒，inbox 会轮询）。`retros/` 里出现一个新的 json，就说明采集开了。

`candidates.json` 要再等下一次启动才会从已有的 retros 收割：启动时先收割、再扫 inbox。不想多等一次，就在会话里让模型调用 `retro_review`，那次提交会马上收割。

### Install (English)

You need a working `dsh web` profile and Node.js 18+. There is no build step.

```sh
dsh plugin --profile web add "github:tangzheng202202/dsh-retro#main"
```

Local checkout (use your own path):

```sh
dsh plugin --profile web add link:/path/to/your/clone
```

Capture stays **off** until you opt in. A patch replaces the whole `config` object; `name` must be `dsh-retro` if you set it. Add this to `$DSH_HOME/cordis.patch.yml` (or the web profile's `cordis.patch.yml`), then restart `dsh web`:

```yaml
- id: dsh-retro
  name: dsh-retro
  config:
    enabled: true
    remind: true
```

`dsh web --dump-config` should show `enabled: true`. The log line `[dsh-retro] started:` means it is on. `installed but disabled` means it is still off. Drop a `.json` retro into `$DSH_HOME/storages/dsh-retro/inbox/` and restart once; a new file under `retros/` means capture is writing.

## 截图

实机 GIF 和截图还没放进仓库。拍好之后放到下面三个路径，这里会直接显示：

![一条安装命令，直到日志出现 started](assets/01-install.gif)

![开启后 retros 目录里的复盘文件](assets/02-files.png)

![设置页「复盘与技能晋升」卡片](assets/03-panel.png)

`docs/publish/images/` 里的图是文章用的示意图，不是这个插件的产品截图。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关。关闭时插件完全不动作 |
| `storageDir` | `''` | 存储根目录；空 = `$DSH_HOME/storages/dsh-retro` |
| `minToolsForTurnTrace` | `1` | 单回合工具调用数 ≥ 该值才写 turn-trace |
| `minToolsForRetro` | `2` | 会话工具总数 ≥ 该值 → worthRetro |
| `minTurnsForRetro` | `3` | 会话轮次数 ≥ 该值 → worthRetro |
| `remind` | `false` | 向 system prompt 追加 retro_review 收尾约定 |
| `pushToViking` | `true` | retro 的 memoryFacts 尽力推给 OpenViking |
| `inbox` | `true` | 轮询 inbox/ 目录，摄入外部投递的复盘 JSON |
| `inboxIntervalMs` | `60000` | inbox 轮询间隔 |

## 存储布局

    storages/dsh-retro/
    ├── turns/2026-08.jsonl      # 每回合轨迹（追加，JSONL）
    ├── sessions/<sessionId>.json # 会话摘要（含 worthRetro）
    ├── retros/<sessionId>-<ts>-<rand>.json  # 结构化复盘
    ├── inbox/                   # 外部投递入口（丢 JSON 进去即可）
    └── processed/               # 已摄入的投递

**隐私设计**：不记录工具参数、不记录对话正文；只记工具名/成败/错误码/次数/时长
和"纠正信号计数"（基于短消息里的纠错词启发式）。

## retro_review 工具

长任务收尾时由模型调用，字段：

- `taskType`（必填）、`outcome`（必填：success/partial/failed/abandoned）
- `summary`：一段话总结
- `patterns`：可复用做法
- `pitfalls`：`{symptom, cause, fix}`
- `skillCandidates`：`{name, trigger, instructions, confidence}`
- `memoryFacts`：应进入长期记忆的事实

返回 `{retroId, storedAt, pushedToViking, vikingNote}`。


## A2：skill 候选 inbox + 晋升门

retro_review 提交的 `skillCandidates` 会被自动收割进 `candidates.json` 账本（按 name 去重，
状态机：pending → promoted / rejected）。三个工具完成审批闭环：

- `retro_inbox`：列出候选（可按状态过滤）
- `skill_promote`：过 **lint 门**（kebab-case 命名 / 描述与指令完整 / 无密钥特征）→ 写入
  `~/.dsh/skills/<name>.md`（flat skill，frontmatter 含 name/description/whenToUse）→ 记账 promoted。
  skills 目录被 DSH 的 skill provider 监听，**写入后无需重启即可被 `skill` 工具发现**；
  同名冲突默认拒绝（`overwrite:true` 可覆盖），重复晋升拒绝。
- `skill_reject`：拒绝（或 `restore:true` 恢复 pending）。

> 与 task-board 的关系：task-board 数据在浏览器 localStorage，宿主插件无法直接写入，
> 因此 A2 用宿主侧 `candidates.json` 账本作为审批队列（agent 在会话内审批，与 GUI 同屏可见）。
> 若要可视化面板，后续可加 web client 半（读宿主 API 渲染候选卡片）。

## 与 OpenViking 的关系（诚实说明）

内存插件把 `openvikingMemory` 服务放在**隔离组（isolate）**里，跨插件不可见，
所以 retro_review 通常只能"尽力推送"并返回提示；可靠路径是：
**memoryFacts 先落本地 retros/ 文件，再由模型调用 `viking_remember` 工具写入**。
这也是 A1 之后方向 A2（skill inbox + 晋升门）的输入格式。

## 测试

    npm test

- `tests/core.test.mjs`：纯逻辑（纠正启发式、消毒、tracker、阈值）
- `tests/plugin.test.mjs`：fake ctx 端到端（事件流 → 轨迹/摘要/复盘落盘、inbox 摄入）


## Web Client 半：候选面板（设置页卡片）

- `lib/client.js`：设置页插件卡片「复盘与技能晋升」——候选账本统计（pending/promoted/
  rejected/retros/turns）+ 候选列表（状态/裁判/探针/来源/备注）+ 刷新按钮。
- 数据来自宿主路由 `GET /retro/state`（`ctx.inject(['webServer'])` 注册，零额外依赖）。
- `/retro` 整段前缀先走 `connection.admit`，和 dsh web 的 `/api` 一样：没有登录 cookie 是 401，Host/Origin 不被信任是 403，已登录但不是 owner 也是 403。未通过不读盘。响应里不带存储目录绝对路径。设置页是同源请求，会带上已经登录的 cookie。
- 审批写操作留在会话内由 agent 执行（judge 门需要裁判意见，浏览器面板只读），
  面板上的提示文案会引导用户这么做。
- 加载机制：`dsh.client.platform: web` + `exports["./client"]`，由 web UI 的
  ModuleLoader 按 image-studio 同款范式加载。

## A4：skill 遥测闭环 + 自动降级（代理指标）

**诚实说明**：DSH 目前没有"skill 被模型加载"事件（tool-skill 无加载钩子），所以 A4 用
**代理指标**——skill 覆盖的 taskType（来源复盘记录）在晋升前后的会话质量对比：

- 指标：工具失败率（failed/total）、用户纠错率（corrections/userMessages）
- verdict 三态：`healthy`（晋升后 ≥3 个样本且未恶化）/ `deprecated`（失败率或纠错率
  超晋升前基线 ×1.2）/ `insufficient`（样本不足）
- **自动降级**：`retro_review` 提交后自动刷新遥测，verdict=deprecated 的已晋升 skill
  被置为 `deprecated` 状态并记录降级原因（note）——skill 文件不删除，只是标记
- `retro_telemetry` 工具：生成回报表（按 taskType 过滤可选）；`/retro/state` 与
  client 面板展示 verdict 徽章与 deprecated 计数
- 局限：当前会话摘要样本少，多数 verdict 会是 insufficient；随着任务积累数据才有效。
  未来若 tool-skill 暴露加载事件，可升级为真实使用遥测。

## B 系列：进化门控（日志 / canary / 裁判一致性 / 自动回滚）

- **B0 决策日志**：`evolution.log.jsonl` 记录每一次 promote / reject / auto-rollback /
  canary 失败——「改了什么都查得回来」，全可追溯。
- **B1 canary 冒烟门**：晋升写入后立即读回校验（frontmatter 分隔符 / name /
  description / 无密钥），失败则拒绝晋升并归档失败文件。
- **B2 裁判一致性校验**：judge.evidence 必须引用候选名或 taskType，防「模板化裁判」
  （`judgeConsistency:false` 可关，向后兼容）。
- **B3 自动回滚**：遥测 verdict=deprecated 时，skill 文件自动移入
  `~/.dsh/skills-archive/`（skill provider 不再发现，可恢复）+ 记日志。
  判定含**绝对红线**：无基线时失败率/纠错率 ≥50% 且样本≥3 也触发降级。

配置：`evolutionLog` / `autoRollback` / `judgeConsistency`（默认全开）。
## 里程碑

- [x] A0/A1：自动触发 + 结构化复盘落盘（本原型）
- [x] A2：skill inbox + lint 晋升门（retro_inbox / skill_promote / skill_reject）
- [ ] A3：probe/judge 自动晋升
- [x] A4：skill 遥测闭环 + 自动降级（retro_telemetry + 代理指标 + deprecated 标记）
- [x] B 系列：进化门控（B0 日志 / B1 canary / B2 裁判一致性 / B3 自动回滚）