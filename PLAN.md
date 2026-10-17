# dsh-retro 开源引流计划

只谈怎么让陌生人愿意点进来、装得上、看懂。这次不改代码。

核对日期：2026-10-17。`npm test` 在 Node v22.14.0 上 32 项全过。

## 1. 这个插件是干什么的

装进 DeepSeek Harness（dsh）之后，它在旁边听会话：每回合用了哪些工具、成没成功、用户有没有说「不对/重来」，折成一份统计，写到本地文件。任务收尾时，模型可以调用 `retro_review`，交一份结构化复盘（做了什么、踩了什么坑、有没有值得变成 skill 的做法）。

这些候选会进一个账本。人（或模型）再调用 `skill_promote`，过命名、探针、裁判三道门，才会写成 `~/.dsh/skills/<名字>.md`，下次会话就能被 skill 工具看到。表现变差时，遥测可以把这个 skill 标成降级，并把文件挪到 `skills-archive/`。

默认是关的。不记工具参数，也不记对话正文。推给 OpenViking 只是顺便试一下，推不进去就只留在本地文件。

## 2. 别人现在装不上、跑不起来的地方

依赖不是问题：`package.json` 没有 `dependencies`，宿主逻辑是纯 Node。卡人的是安装步骤和「装上等于没装」。

1. **安装说明不是 dsh 的安装命令，还把路径写死了。** `README.md` 第 24–31 行让人去改「profile 的 package.json」，依赖写成 `link:~/dsh-retro`（第 28 行）。克隆到别的目录就断；profile 目录在哪、叫什么，全文没写。官方装法是 `dsh plugin --profile web add "github:作者/仓库"`（见 [插件文档](https://deepseekdocs.com/docs/user-guide/plugins)）。仓库其实已经具备这条命令要的标志：`package.json` 第 13–16 行有 `dsh.bundle`，`cordis.patch.yml` 也在。README 没告诉人。

2. **装上默认什么都不做。** `cordis.patch.yml` 第 11 行 `enabled: false`；`lib/index.js` 第 586 行默认值同样是 false，第 627–629 行直接 return，不监听事件、不注册工具。日志只有一句 `installed but disabled`。不改配置，重启十次也看不到复盘文件。

3. **「怎么打开」写得对不上，也没有成功标准。** `README.md` 第 33–39 行的片段是 `- id: dsh-retro` 加 `config`。插件自带的 `cordis.patch.yml` 第 7–19 行是另一种写法（`- insert:`，还带 `name`）。两份摆在一起，陌生人不知道贴哪、贴对没有。全文没有「看到这行日志就算成功」：成功日志在 `lib/index.js` 第 1154 行，README 没引用。

4. **Node 版本声明比代码更严，可能把能跑的环境拒掉。** `package.json` 第 37–38 行：`^22.19.0 || >=24`。本机 Node v22.14.0 跑完全部 32 项测试，一项没挂。dsh 的 profile 如果开了 engine-strict，`dsh plugin add` 会在安装阶段失败，而不是插件本身跑不起来。

5. **没有一份可以丢进去就看见结果的样例。** 最快的离线路径是往 `inbox/` 丢一个复盘 JSON，启动时会扫一次（`lib/index.js` 第 1137–1140 行）。仓库里没有这个样例文件，字段得自己从第 91–103 行和第 705–746 行翻。不聊天、不调模型，就没法在 5 分钟内看见 `retros/` 里多出一个文件。

6. **设置页只在 web 上，而且现在画出来是坏的。** `package.json` 第 18 行 `dsh.client.platform` 是 `web`，桌面端 / TUI 没有这块卡片。卡片数据用 `fetch('/retro/state')`（`lib/client.js` 第 17、90 行），同一段代码第 149–155 行已经拿到了 `connection.api`，却没用来拼请求地址。API 如果不在页面同一个源上，卡片就是「读取失败」。计数那几行（第 110–115 行）把 `<b>` 写进了 React 文本，页面上会原样出现 `<b>0</b>`，不是加粗数字。降级状态没有对应样式（徽章样式只到第 74–77 行的 pending / promoted / rejected）。

7. **GitHub 上看不到许可证。** `package.json` 第 40 行写了 `MIT`，仓库根目录没有 `LICENSE` 文件。GitHub API 返回的 `license` 是 `null`。有人会因为这个直接不克隆。

8. **前置条件没写。** 需要先有能跑的 dsh，并且 profile 里有 `tools` 服务（`lib/index.js` 第 12 行 `inject = ['tools']`）。README 只在第 27 行用括号提了一句「以 web profile 为例」。

`npm test` 本身不用装 dsh 就能跑（`README.md` 第 105–109 行）。这是今天唯一一条 5 分钟走得通的路，但它证明不了插件在宿主里能工作，不适合当引流演示。

## 3. 改进清单（先让人装上）

工作量是一个人专心做的小时数，不含等评审。

### P0 陌生人 5 分钟内装上并看到一个文件

1. **重写安装段。** 改 `README.md` 第 24–39 行。第一条命令用 `dsh plugin --profile web add "github:tangzheng202202/dsh-retro"`。第二条给一份和 `cordis.patch.yml` 对得上的开启片段（`enabled: true`），并写明贴到哪个文件。第三条写成功标志：重启后日志出现 `[dsh-retro] started: root=...`（对应 `lib/index.js` 第 1154 行）。默认保持关闭，这是对的，安全；但「打开」必须是安装的第 2 步，不然 5 分钟目标完不成。改完用一次真实的 `dsh plugin add` 走通，不要只改文字。约 **1.5 小时**。

2. **加一个 inbox 样例。** 新建 `examples/retro.sample.json`（taskType、outcome、summary、一条 skillCandidate）。README 写：开启插件后把这个文件丢进 `$DSH_HOME/storages/dsh-retro/inbox/`，重启，`retros/` 里出现一份，`candidates.json` 里出现一条 pending。这样不烧模型 token 也能验收。约 **1 小时**。

3. **放宽 engines。** `package.json` 第 37–38 行改成实际跑过的范围，至少覆盖 Node 22.14（本机已验证）。README 写一行「Node 22 或 24，22.19 不是必须」。约 **0.5 小时**。

4. **修设置页两个会让演示穿帮的问题。** `lib/client.js` 第 110–115 行改成真正的元素，不要把 `<b>` 当字符串；第 90 行的 `fetch` 改走第 154 行已经注入的 `api`，别写死站点根路径。顺手给 deprecated 补一个徽章样式（第 74–77 行）。约 **2 小时**。

### P1 README，让人愿意点 Star

5. **首页改成先讲人话，再讲结构。** 现在开头（`README.md` 第 1–8 行）是「方向 A1 原型 / L3 / worthRetro」，路人看不懂。换成第 1 节那种四句话。下面留三个图位，建议路径：`assets/01-install.gif`（一条命令到日志出现）、`assets/02-files.png`（`retros/` 和 `candidates.json`）、`assets/03-panel.png`（设置页卡片，等第 4 条修好再拍）。`docs/publish/images/` 里那 6 张是合成海报，可以暂时链上，但图注要写「示意图，不是产品截图」，不要冒充实机。根目录再加 `screenshots.json`，列出这些图的仓库内路径（列表的 PR 模板现在要求截图放在插件自己的仓库里，见第 4 节）。约 **2 小时**，不含录 GIF。

6. **改掉和代码对不上的句子，免得收录时被当成夸大。** 宣传稿写「27 项测试」：`docs/deep-dive.md` 第 94 行、`docs/publish/deep-dive.md` 第 94 行、`docs/publish/article.html` 第 117 行、`docs/publish/shots-html/06-github.html` 第 26 行。实际是 32 项（含 B 系列，2026-10-17 跑过）。`package.json` 第 3 行还写「方向 A1 原型」，A2 到 B 都已经在代码里。`README.md` 第 154 行 A3 仍是未勾选，但 `skill_probe` 和 judge 门在 `lib/index.js` 第 914–934 行、第 968–1008 行，测试在 `tests/a3.test.mjs`。勾选前先想清楚：现在的 A3 是「没探针/没裁判就不让晋升」，不是无人值守自动晋升。措辞要和代码一致。约 **1 小时**。

### P2 许可证和能抄的例子

7. **加 `LICENSE`。** 用 MIT，和 `package.json` 第 40 行一致。版权人写仓库主人。约 **0.2 小时**。

8. **给 GitHub 仓库加 topic `dsh-plugin`。** 这是网页上的仓库设置，不用改代码。现在 topics 是空的（2026-10-17 查 `repos/tangzheng202202/dsh-retro`）。约 **0.1 小时**。

9. **README 加一小节「复制就能调用」。** 一组 `retro_review` 参数，一组 `skill_promote` 参数。judge 的 evidence 必须带上候选名或 taskType，否则会被拒（`lib/index.js` 第 926–933 行）。不写这个，别人晋升一次就失败，会以为插件是坏的。约 **1 小时**。

### P3 收录之后再做

10. **向 awesome-dsh-plugin 投稿。** 等 P0 和 topic 落地再提，见第 4 节。约 **1 小时**（含把描述改到不夸张）。

11. **发 npm（可选，列表不强制）。** `package.json` 补 `repository` 字段，指向 `https://github.com/tangzheng202202/dsh-retro`，否则列表不会把下载量和仓库对上。约 **2 小时**。

12. **加一个 GitHub Action 跑 `npm test`。** 仓库现在没有 `.github/`。主页上的绿勾对 Star 有用，对「装得上」没用，所以排后面。约 **1 小时**。

P0 四项加起来大约 5 小时。做完就可以拍第 5 节的视频，也可以去投稿。

## 4. awesome-dsh-plugin 要什么，我们还差什么

网上有两份同名列表，规则不一样。引流以 org 这份为准，别投错仓库。

### 主列表：awesome-dsh-plugin/awesome-dsh-plugin

- 贡献说明：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md>
- PR 模板：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/.github/pull_request_template.md>
- 机器检查：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/scripts/check-submission.mjs>

投稿方式：在对方仓库加**一个**文件 `data/plugins/<owner>__<repo>.yml`，不要手改 README。一个 PR 最多 3 条。字段大致是 `url`、`name`、`category`、`description.en`（中文可选）。

硬性要求（文档 + CI 对得上的部分）：

- `package.json` 里有 `dsh.bundle`。只写 `dsh.client` 会被拒。本仓库有，`package.json` 第 13–16 行。
- 是真代码，不是空 README。有。
- 仓库创建满 1 天。本仓库创建于 2026-08-17，已过。
- 仓库打上 topic `dsh-plugin`。**现在没有。**
- 描述只说功能，不写「最好 / 第一」这类词，而且必须和代码对得上。数字、命令、API 名都会被对着源码看。
- 分类从列表里选。建议 `skill`：路人能感知的是「复盘里长出 skill，过门之后写进技能目录」。`memory` 沾边，但 OpenViking 推送自己在 `README.md` 第 97–102 行就承认经常推不进去，别把记忆当主卖点。分类选歪了维护者会改，不会因此拒。

文档和 CI 有一处打架，以脚本为准：`contributing.md` 仍写「提交数 ≥ 10」。`scripts/check-submission.mjs` 开头写明，提交数门槛在 2026-09-03 取消了（#4196），只留「满 1 天」。本仓库现在 4 个提交。不要为了凑 10 个去空提交。若评审拿旧文档问，把脚本里那段注释指给他。

推荐但不是门槛：发 npm；截图；官方 `@deepseek-ai/*` 包放 `peerDependencies` 而不是 `dependencies`。本仓库没有这类 npm 依赖，最后一条目前不用做。

截图也有两套说法。`contributing.md` 写把图加进**列表仓库**的 `data/screenshots.json`，且必须是 GitHub 上的 https 图。PR 模板写截图放在**插件自己的仓库**：`package.json` 旁边一个 `screenshots.json`。两套都做最稳：自己仓库放 `screenshots.json` 和 `assets/`，投稿说明里附上 raw 链接。现在两套都没有。README 里一张图都没有，市场爬虫抽不到图。

建议投稿描述（先写在计划里，投稿时再贴）：

- en: `Records DSH session turn traces and structured retros, then writes a skill file after lint, probe, and judge checks. Capture stays off until enabled is set to true.`
- zh: `记录 DSH 会话的回合轨迹和结构化复盘，候选 skill 通过 lint、探针和裁判后写成技能文件。采集默认关闭，要设 enabled: true。`

不要写「自进化操作系统」「自动晋升」。默认关闭如果不写进描述，维护者会认为装上没做描述里的事。

2026-10-17 在这个列表仓库里用 GitHub code search 搜 `dsh-retro`，没有命中。还没被收录。

我们还差：

- topic `dsh-plugin`（没有就进不了「可被发现」的集合）
- 一份投稿 YAML（还没提 PR）
- 描述不能沿用现在的 GitHub 简介。现简介是：`DeepSeek Harness self-evolving retro plugin: A1 capture / A2 skill promotion / A3 judge-probe gate / A4 telemetry + web client`。A1–A4 是内部里程碑名，路人和审核都对不上代码行为
- 安装说明改成 `dsh plugin add` 之后再请人审。审核会打开仓库试「装上是不是那么回事」
- 截图（推荐）
- LICENSE 文件（这份列表不强制，但 GitHub 许可证为空，审核做「源码里有没有蹊跷」时观感差）

### 另一份：bruc3van/awesome-dsh-plugin

说明在 <https://github.com/bruc3van/awesome-dsh-plugin/blob/main/CONTRIBUTING.md>。这不是上面那个仓库。它靠 topic 爬虫进待审核队列，核实后才上目录，作者不用往 `data/plugins/*.yml` 塞文件（那种路径在它的 CI 里会被拒绝）。

它要求：公开、有 `dsh-plugin` topic、填写了 GitHub 简介、确实是 dsh 插件、说明不夸大。许可证缺失要主动讲。作者自荐区还要求 **star > 10**，本仓库现在 0 star，自荐通道走不了。正录可以等 topic 打上之后进每日队列。同一天也在这个仓库搜了 `dsh-retro`，没有命中。

## 5. 30–60 秒演示怎么拍

等 P0 做完再拍。现在拍只能拍到「手改别人家的 package.json」，不像能装的插件。全程录实机，session id 打码。不要用 `docs/publish/images/` 里的合成图充录像。

按这个顺序，总长大约 50 秒：

1. **0–5 秒。** 黑底一行字：「任务做完，留下复盘，过了门才变成技能。」不要 logo 墙。
2. **5–15 秒。** 终端。一条 `dsh plugin add`，贴上 `enabled: true`，重启。镜头停在日志 `[dsh-retro] started`。这是「装上了」的证据。
3. **15–28 秒。** 把 `examples/retro.sample.json` 丢进 `inbox/`，再切到 `retros/` 和 `candidates.json`，待审那一行用鼠标圈住。不在这 60 秒里现场跟模型聊天，来不及，也容易翻车。
4. **28–40 秒。** 会话里只发一条已经写好的 `skill_promote`（evidence 里带 skill 名）。切到 `~/.dsh/skills/<name>.md` 被写出来，再切技能列表里出现同名条目。字幕：「写入即可发现，不用重启。」
5. **40–50 秒。** 设置页「复盘与技能晋升」卡片，数字是正常的，不是 `<b>0</b>`。停 2 秒。
6. **50–58 秒。** 定格仓库地址 `github.com/tangzheng202202/dsh-retro`，下面一行小字：「默认关闭，开启后才采集。不记录对话正文。」

竖屏如果要发公众号，第 3 步和第 5 步留着，第 4 步可以剪掉，压到 30 秒出头。

## 6. 公开风险检查

只看了仓库里会跟着 git 走的文件（含 `docs/publish/dsh-retro-article-package.zip` 里的 9 个文件）和提交作者。**没有发现密钥、token、私钥、手机号、邮箱、内网 IP，也没有某台电脑的绝对路径。** 下面这些是公开身份或假地址，不是泄露，列出来免得以后误删。

| 位置 | 是什么 | 要不要处理 |
|---|---|---|
| `docs/publish/shots-html/06-github.html` 第 18 行 | `https://github.com/tangzheng202202/dsh-retro` | 作者自己的公开仓库，留着 |
| `docs/publish/article.html` 第 116 行 | 同上 | 同上 |
| `docs/deep-dive.md` 第 94 行、`docs/publish/deep-dive.md` 第 94 行 | 同上，无协议头 | 同上 |
| `docs/publish/shots-html/03-turn-trace.html` 第 20 行 | `session-8f32****（已打码）` | 已经打码 |
| `docs/publish/images/*.png` | 6 张合成海报，不是实机截图；图 3 的 session id 也是打码样式 | 可以公开。别把它当「用户数据已经脱敏」的证明，因为本来就不是实数据 |
| `lib/index.js` 第 490、538 行 | 用来拦截「像密钥的字符串」的正则 | 不是真密钥 |
| `lib/index.js` 第 1102 行 | `http://dsh-retro.local`，只为了用 `URL` 解析路径 | 不是内部服务地址 |
| `lib/index.js` 第 604–606、632、936 行 | `~/.dsh`、`storages/dsh-retro`、`skills` | dsh 的约定目录，可用 `DSH_HOME` 和 `storageDir` / `skillsDir` 改 |
| git 作者 | `tangzheng202202 <tangzheng202202@users.noreply.github.com>` | GitHub 的 noreply 邮箱，不在工作区文件里 |

zip 里是 `article.html`、`deep-dive.md` 和那 6 张图，没有多出来的文件。

结论：以现在的内容公开，没有需要先擦掉的秘密。换组织名或仓库名时，记得改第 18 / 94 / 116 行那几处写死的 GitHub 地址。
