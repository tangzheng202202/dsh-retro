# 让 Agent 学会进化：DeepSeek Harness 自进化实践全记录

> 从「用工具」到「造工具给自己用」——一次把 DSH 的复盘、技能晋升、门禁、遥测全部落地成真实代码的深度实践。

## 一、为什么是 Harness，而不是模型

大模型的能力边界由权重决定，但**上限之外的增量，几乎全在系统层**：工具、记忆、技能、验证回路、长任务编排。
DeepSeek Harness（DSH）的架构事实是「一切皆插件，没有特权内核」——模型适配器、工具注册表、会话日志、agent loop 本身都是可替换的插件。
这意味着扩展它不是 fork 内核，而是写插件挂到 seams 上；卸载即撤销，零残留。
它天然为自我修改设计，因为扩展点是可逆副作用——一个 agent 完全可以让系统自己写插件、挂载、测试、回滚。

所以第一原则：**不要把它当聊天工具，要当可持续演化的操作系统来养**。

## 二、应用哲学：六个抓手

1. **过程资产**：会话日志是仅追加事件流 + token 度量 + OTel 遥测——工具调用轨迹、纠错、验证结果，全是可回流的高价值数据。
2. **验证闭环**：能力上限不在模型，在反馈速度。每次修改要有可执行验证门（测试、自检、独立评审）。
3. **并行委托**：subagent/workflow 扇出独立工作，主线程只做编排与验证。
4. **记忆**：决策、偏好、踩坑、架构事实的沉淀，让每个会话站在前面所有会话的肩膀上。
5. **技能沉淀**：任务做完自动提炼 skill，同类任务下次直接加载而不是重新推理。
6. **长任务心跳**：任务停滞或宿主重启后自动唤醒续跑，从「交互工具」跃迁到「自主 agent」。

## 三、自进化路径：五层阶梯

| 层级 | 名称 | 完成标志 | 关键机制 |
|---|---|---|---|
| L0 | 静态助手 | 单轮问答 | 无 |
| L1 | 工具型 agent | 能闭环执行任务 | 工具注册、沙箱、验证 |
| L2 | 记忆型 agent | 跨会话复用经验 | OpenViking、会话持久化 |
| L3 | 复盘型 agent | 任务结束自动产出经验 | turn/end 事件 → 提炼 → 写记忆/skill |
| L4 | 自改进 agent | 修改自己的 skill/prompt 过验证门生效 | git + 测试 + 裁判评审 + 回滚 |
| L5 | 元进化 | 进化出进化能力本身 | 评估器独立于执行器，多 agent 竞争 |

**双飞轮**：本机能进化的是外脑资产（skill/插件/记忆/预设），权重进化在训练侧；但 DSH 产生的高质量轨迹数据可以回流训练——harness 是模型进化的数据工厂，模型是 harness 的大脑。

## 四、落地实录：A1→A4 全部真实宿主验证

### A1 复盘采集层（dsh-retro 插件）

- **事件折叠**：监听 session/event，把 turn/step/tool/user/assistant 事件流折叠成结构化轨迹（工具名/成败/错误码/时长/纠正计数——不记参数、不记正文）。
- **存储**：turns/*.jsonl（每回合轨迹）+ sessions/*.json（会话摘要 + worthRetro 判定）+ retros/*.json（结构化复盘）。
- **retro_review 工具**：长任务收尾时提交 taskType/outcome/patterns/pitfalls/skillCandidates/memoryFacts。
- **真实验证**：重启宿主后，日志出现启动行；turn 轨迹落盘（9 步 8 次工具调用）；system prompt 注入验证靠解压 zstd 会话日志 grep request/header——7 个 header 命中收尾约定。

### A2 skill 候选 inbox + 晋升门

- retro 里的 skillCandidates 自动收割进 candidates.json 账本（去重、状态机 pending→promoted/rejected，带完整出处）。
- skill_promote 过 lint 门后写入 ~/.dsh/skills/<name>.md（frontmatter: name/description/whenToUse）。
- **关键发现**：DSH 的 skill provider 用 Chokidar 监听技能目录——写入文件后 skill catalog 实时更新，**无需重启**。真实宿主验证：晋升 4 个 skill，4 次都出现在下一轮会话的可用技能列表里。

### A3 probe/judge 门禁

- lint（机械）→ probe（skill_probe 回填真实试跑结果，failed 阻止晋升）→ judge（独立裁判意见必填：verdict=pass + evidence≥20 字符）。
- 真实宿主验证：无 judge 调用被拒 → 带 judge 晋升 → 账本记录 judge/probe 完整审计链。

### A4 遥测闭环 + 自动降级

- retro_telemetry 工具：按 skill 覆盖的 taskType 聚合晋升前后会话质量（工具失败率/用户纠错率），verdict=healthy/deprecated/insufficient。
- 自动降级：verdict=deprecated 的 skill 标记为 deprecated 状态（不删文件，可追溯）。
- **诚实局限**：DSH 暂无「skill 被模型加载」事件，A4 用代理指标；当前样本少，verdict 多为 insufficient，随任务积累才有统计意义。

### Web Client 面板
- 宿主 ctx.inject(['webServer']) 注册 /retro/state 路由；client 半用 __ModuleLoader__.load + slots.inject 挂设置页卡片；审批写操作留在会话内由 agent 执行。

## 五、关键架构发现

1. **skill 实时发现**：Chokidar 监听技能目录，写入即可被 skill 工具加载，自进化闭环的「发布」环节零延迟。
2. **热更新路径**：client 改动刷新页面即可；host 实验用 dsh-tool-cordis 的 cordis_run/cordis_stop 动态加载（进程内存，不写盘）；开发期有 cordis-plugin-hmr；正式落地攒批重启。
3. **进程级真相**：宿主单进程，正式插件代码启动时加载——多次验证要攒批，一次重启。
4. **自进化安全边界**：三层门禁（lint→probe→judge）、账本全追溯、降级只标记不删除、prompt 注入用「收尾约定」而非强制。

## 六、踩坑集（工程师视角）

1. 大段 heredoc 经工具传输会挂起——改用 write 工具 + String.raw 直接写文件。
2. 工具 execute 的 exec 是第二参数，不是 args.__exec——一个签名错误让 session 归属全错。
3. 编辑锚点差一个分号导致改动被静默跳过——锚点用长上下文 + 测试验证行为而非只查语法。
4. lint 判定「短描述」时人工数中文字符出错——用脚本算 length 或写覆盖阈值的单测。
5. bash 历史扩展：双引号里的 $! 触发 event not found——set +H。
6. 前台 git commit 在工具环境挂起——nohup 后台执行绕过，同样适用 gh repo create。
7. 插件定时器不 unref 会拖住 node --test 永不退出。

## 七、自进化的边界与下一步

**边界**：能进化的不是权重，是外脑资产；进化必须可测试、可回滚、可积累。门禁体系（lint→probe→judge）就是「自我修改」的护栏——裁判与门规本身不可被进化。

**下一步**：
- A4 数据积累：把 retro_review 变成习惯，样本量上来后 healthy/deprecated 判定才有意义；
- 真实 skill 加载事件：若 tool-skill 暴露加载钩子，遥测可从代理指标升级为真实使用统计；
- 进化门控 B 系列：canary 测试门 → 独立 LLM 裁判 → 自动回滚；
- 轨迹数据管道：把 session 日志导出为结构化训练数据，连接训练侧飞轮。

---

代码：github.com/tangzheng202202/dsh-retro （零依赖、27 项测试）