# Web 与 QQ 抢会话：市面做法盘点与本插件路线

> 调研时间：2026-10-29。对象：AstrBot、LangBot、MaiBot、OpenClaw，以及 npm 上 7 个 dsh IM 插件
> （`dsh-qq-onebot`、`dsh-qq-plugin`、`dsh-qqbot-bridge`、`@aiwayds/dsh-feishu`、
> `@luzhengyangtx/dsh-telegram-duty`、`dsh-discord-bot`、`dsh-im-hub`）。
> 结论只针对 dsh 0.2.1-rc.2 的会话/写句柄模型。
>
> **2026-10-29 已落地**：`busyStrategy` 默认 `fork`（`fork | wait | rotate`），
> `forkHeldSession` 用 `buildForkSeed` + `agents.create({ seed, inheritedEventCount })`
> 从原会话完整事件前缀分叉；`rotateOwnedSession` 不再做记忆蒸馏/交接；
> `forkMaxEvents` 默认 4000。`wait` 仍保留，`rotate` 只作 fork 失败后的兜底。

## 0. 结论先行

- 市面上**没有人去"抢赢"写句柄**。成熟做法是：会话只有一个写者，其他前端要么**附着到同一个活 agent**，
  要么**只读围观**，要么**显式切换控制目标**；抢不到就排队/只读，**不会自动新建一个空会话**。
- dsh 插件圈的主流做法非常一致：`agents.get()` 复用活 agent → 冷会话才 `resume` 一次 → 仍冲突就只读或
  如实报忙；`@aiwayds/dsh-feishu`、`dsh-qqbot-bridge`、`dsh-discord-bot`、`dsh-im-hub` 都不在锁冲突后
  `create` 空会话。`dsh-qq-onebot` 是例外：它没有专门识别 `SessionAlreadyOwnedError`，所有恢复路径都失败时
  会换一个 fresh id（等于丢上下文）。
- 本插件的 `wait` 比 `rotate` 更接近主流（不双写、不立刻换号），但 5 分钟后仍会走到 `rotate`；
  而 `rotate` 是少数派，上下文交接又依赖长期记忆（默认关闭），所以"抽象"是真实存在的。
- 最小、最贴合本插件安全模型的改法：把 `rotate` 换成 **fork**——用 dsh 原生的
  `buildForkSeed` + `agents.create(seed)` 从旧会话的完整事件前缀开一个新会话。它不抢写句柄、不丢上下文，
  而且新 agent 仍然走本插件的 `setup`（工具守卫、人格、模型都在）。

## 1. 问题本质

dsh 的 session 是**单写者 + 活 agent**：

- 写句柄是排他的（`SessionAlreadyOwnedError`）。dsh WebUI 打开一个会话就会
  `sessionController.promote` → `agents.resume`，读完历史快照后**长期持有写句柄**；关标签页不等于立刻释放。
- 一个 session 同时只有一个 driver 在跑轮次；第二个写者即使拿到句柄，也会和第一个抢事件日志。
- 上下文归属只有一份：谁写谁说了算，另一边看到的是旧快照。

所以"Web 和 QQ 抢会话"其实是三件事叠在一起：

1. **写句柄**：谁持有 `SessionHandle('write')`；
2. **轮次**：谁在驱动 `turn`，消息要不要排队；
3. **上下文**：换了一个 session id 之后，新 agent 还记不记得刚才聊到哪。

本插件当前的处理是：

```
QQ 消息 → openAgent()
  ├─ tryResumeComposition()  200/400/800ms 退避
  ├─ 仍 held → busyStrategy=wait：提示 + 每 5s 探一次，最多 busyWaitMs（默认 5 分钟）
  └─ 超时 → rotateOwnedSession()
        ├─ finishGeneration('rotate')：尽力蒸馏进长期记忆
        └─ 新 session id → create
```

`rotate` 的问题不是"换会话"本身，而是：

- 换会话的**触发条件**是"界面占着"，不是"上下文满了"；
- 交接内容是**摘要 + 最后 N 条**，不是原文；`memoryEnabled` 默认 `false` 时连摘要都没有；
- 新会话的 `parentSession` 关系没有建立，WebUI 左栏只看到一个陌生的新会话；
- 用户什么也没做错，却要承担"等 5 分钟"或"丢上下文"。

## 2. 市面做法

### A. 各端独立会话：Web 是管理台，不是聊天端

**AstrBot** 是最典型的。它把"会话"和"对话"分开：

- 会话 = 一个消息窗口，用 UMO 标识：`{platform_id}:{message_type}:{session_id}`，例如
  `aiocqhttp_default:FriendMessage:905617992`。
- 对话 = 会话里的多条历史，可新建、切换、删除；WebUI 的「对话」页是**检索/预览/导出/删除**，
  不是往 QQ 会话里发消息的入口。
- 内置 ChatUI 是另一个平台 `webchat`，UMO 形如
  `webchat:FriendMessage:webchat!<用户名>!<uuid>`，与 QQ 的 UMO **天然隔离**。
- 想跨端连续，靠的是"人格/配置文件/知识库"这类配置层，不是共享同一个会话。

来源：[WebUI 文档](https://docs.astrbot.app/use/webui.html)、
[`chatConfigBinding.ts`](https://github.com/AstrBotDevs/AstrBot/blob/afa43fc0/dashboard/src/utils/chatConfigBinding.ts)、
[`conversation_mgr.py`](https://github.com/AstrBotDevs/AstrBot/blob/09ab45fc/astrbot/core/conversation_mgr.py)。

**LangBot** 同样按 session 隔离，并且明确限制**同一会话同时只处理一个请求**：
`concurrency.session: 1`（见[系统环境设置](https://docs.langbot.app/zh/deploy/settings)）。
它的 Web 内嵌聊天还专门按**浏览器 tab 的 UUID** 隔离，避免同一个 pipeline 的访客互相看到消息
（[PR #2335](https://github.com/langbot-app/LangBot/pull/2335)）。

**MaiBot** 的 WebUI 里，「麦麦聊天」是本地会话（和麦麦对话、虚拟身份对话），
「麦麦的聊天流」是真实群聊/私聊的**只读观察**时间线；两者不是同一个会话
（[聊天记录和统计](https://docs.mai-mai.org/manual/webui/chat-stats)）。

dsh 生态里，`dsh-im-hub` 的描述最直白：「每个聊天一个 agent 会话，同一聊天串行处理（不交错），
空闲超时后自动释放」；`dsh-qq-onebot` 默认也是「一个 QQ 会话 = 一个持久 Agent 会话」。

**代价**：跨端不连续。你在 Web 里聊的内容，QQ 侧不知道；反之亦然。这是绝大多数产品的选择——
因为它们把 Web 当管理台，而不是第二个聊天客户端。

### B. 网关持有会话，客户端附着：同一个 agent，多个前端

**OpenClaw** 是这条路的标杆：

- Gateway 拥有 session rows、transcript history、routing metadata、active runs；
  Control UI、mobile、ACP、`openclaw tui`、`openclaw attach` 都只是**投影**这份状态，
  不保存独立副本。
- 一个会话可以同时开在多个客户端里；客户端只负责选择 session key、读写 Gateway 协议。
- 轮次由 Gateway 的 session controller 串行化；队列有 `steer` / `followup` / `collect` / `interrupt`
  四种模式，同一会话同时只有一个 turn 被选中。
- 分支用 leaf/entry 模型：发送时带 `expectedLeafEntryId`，如果另一个客户端先切了分支，
  Control UI 会把消息**停在待审阅状态并刷新**，而不是硬发到新分支上。

来源：[Session synchronization and attachment](https://docs.openclaw.ai/concepts/session-attachment)、
[Session management](https://docs.openclaw.ai/sessions)、
[Session controller](https://docs.openclaw.ai/concepts/session-controller)、
[Command queue](https://docs.openclaw.ai/concepts/queue)。

dsh 插件里的对应做法是 **`agents.get()` 优先**：

- `@aiwayds/dsh-feishu` 的 binder 开宗明义 "attach, never create"：
  会话已有活 agent（TUI 正在驱动，或上一次 bot resume 还活着）→ `ctx.agents.get()` 拿回**同一个
  Agent 引用**，后续消息进它的 inbox；bot **不拥有**这个 agent，也**不 dispose**。
  只有不 live 时才 `resume`，并且 `agents.create` 只出现在用户显式 `/new` 一处。
- `dsh-qqbot-bridge` 的接管核心注释：**优先 `agents.get` 复用 live agent**（同进程同一实例，不触锁）；
  仅在其缺席时才 `agents.resume`，且**只尝试一次、绝不重试、绝不降级 create**。
- `dsh-discord-bot`：已在运行的 agent 直接用，冷的才 resume；"绝不会同时跑两个代理"。
- `dsh-qq-onebot`：`agents.get` 命中就 `{ owned: false, dispose: null }`，不 dispose 宿主的 agent。

**代价**：附着者拿到的是**对方的组合**——工具集、人格、模型、prompt section 都是创建者装好的。
对没有自定义权限模型的插件无所谓；对本插件就是红线（见 §4）。

### C. 显式选择/切换：把"控制目标"交给用户

这类做法不自动决定"该用哪个会话"，而是让用户选：

- `dsh-qq-plugin`：一个 QQ 对话背后可以是任意多个 DSH 会话，`/list`、`/switch`、`/new`、`/current`；
  列表编号会过期，所以每行带 6 位 id，引用那条消息再回编号可以避免切错。
- `dsh-qqbot-bridge`：`/切换` 选工作区、`/会话` 选会话；一个 openid 同时只有一个控制目标，
  换目标要显式操作。
- `@aiwayds/dsh-feishu`：`/resume` 交互式会话选择卡（下拉 + 进入），`/new` 开新会话并继承
  cwd/模型/推理档位。
- `@luzhengyangtx/dsh-telegram-duty`：默认进**专属"值班会话"**；`/sessions` 列出工作区会话，
  点编号定向；`#编号` 只发一条；`/duty` 回默认；`/away` / `/back` 在"手机值守"和"本地 Web"之间切换。

**代价**：多一步用户操作；但不会静默丢上下文，也不会替用户做"换会话"的决定。

### D. 冲突降级只读：看得到，但先不写

`@aiwayds/dsh-feishu` 把 `SessionAlreadyOwnedError` 处理得最完整：

- bind 失败 → `degradeToRemoteWatch`：用持久日志做**只读**视图，每一轮的最终回复仍然会推到手机
  （轮询延迟）；
- 排队的 follow-up 会在对方释放后**自动尝试接管**（`maybePromoteRemoteInner`：先停只读，
  再 bind；bind 本身就是接管探针）；
- 它还带一个"坏日志一键修复"：注释里明确写损坏"多为历史双写者写入所致"，
  修复前把原件备份为 `.corrupt-bak`。

`dsh-qqbot-bridge` 的选择更简单：锁住就回执 `locked`（"会话正被其它界面占用"），
**绝不 `resume().catch(() => create())`**。

**代价**：只能看不能发；但绝不破坏对方的日志，也绝不产生"空会话"。

### E. 分叉/分支：从同一个前缀开新会话

这是和本插件最相关、也最少被国内插件使用的一类。

- **OpenClaw** 有 branch/leaf 模型：同一份 transcript 可以有多个分支，客户端发送时带
  `expectedLeafEntryId` 做乐观并发；历史读取跟随 active branch，被放弃的 rewrite branch 不渲染。
- **dsh 原生**就支持 fork：`ctx.sessions.fork(source, boundary?, childSessionId?)` 从**活会话**的
  精确事件前缀复制一个子会话；`buildForkSeed(events, boundary)` 在复制的前缀后放 inherited marker，
  给未闭合的 step/turn 补 `forked` 原因的 closers，`inheritedEventCount` 只数复制的前缀。
- `dsh-discord-bot` 的 `/dsh rewind` 用它做"从较早的提示接续，开成新的工作阶段"。
  它的注释有一个关键坑：**不要直接调 `sessions.fork()`**——那会在 store 里创建一个 live 子会话，
  而 `agents.create` 必须拥有自己驱动的会话，**不能收养**一个已经建好的；所以它改为
  `events.slice(0, boundary + 1)` + `agents.create({ seed })`。

来源：`node_modules/@deepseek-ai/dsh-session/README.md` 的 "Fork a session" 一节；
`dsh-discord-bot` 的 `lib/run.js` 中 `rewindSession` 注释。

**代价**：fork 会把旧历史整段复制进新会话，第一次请求的 prefill 成本更高；分叉后两边各自继续，
不会自动合并。但它是**精确上下文**，不是摘要。

### F. 摘要交接：有损，适合兜底

- `dsh-qq-onebot` 的 `context-guard` 在上下文压力达到阈值时换会话：先让模型写一张"便签"
  （它刻意叫"便签"不叫"交接"，因为"交接"听起来像遗书），再拼上最后 N 句原话作为 seed；
  没有便签就退回最后 N 条原文。触发条件是 **token 压力**，不是 WebUI 占用。
- 本插件的 `memory/handoff.ts` 是同一类：摘要 + 最后 N 条 + "别问我们刚才说到哪"的提示。
  它只在 `memoryEnabled` 且 `memory.ready` 时工作，默认关闭。

**代价**：有损、依赖 LLM/记忆开关、可能把旧摘要和新原文混在一起。适合作为 fork 失败时的兜底，
不适合作为主路径。

### 一张表

| 方案 | 代表 | 冲突时行为 | 上下文 | 本插件安全组合 | 用户操作 |
|---|---|---|---|---|---|
| A 各端独立 | AstrBot / LangBot / MaiBot / dsh-im-hub | 根本不共享，不存在冲突 | 跨端不连续 | 不受影响 | 无 |
| B 网关附着 | OpenClaw / feishu / qqbot-bridge / discord | `agents.get` 复用活 agent；冷才 resume | 同一份，连续 | **会被对方的组合覆盖** | 无 |
| C 显式切换 | qq-plugin / qqbot-bridge / feishu / duty | 用户选目标，选不中不切 | 连续 | 取决于目标 | 要选 |
| D 只读围观 | feishu / qqbot-bridge | 锁住就只读/报忙，等释放再接管 | 连续（延迟） | 不受影响 | 等 |
| E 分叉 | OpenClaw / dsh fork / discord rewind | 从同一前缀开新会话 | **精确连续** | **新会话可走自己的 setup** | 无 |
| F 摘要交接 | qq-onebot / 本插件 memory | 换新会话 + 摘要 | 有损 | 新会话可走自己的 setup | 无 |

## 3. 三条共识

1. **不双写，不拿空会话兜底。** `@aiwayds/dsh-feishu`、`dsh-qqbot-bridge`、`dsh-discord-bot`、
   `dsh-im-hub` 都不在 `SessionAlreadyOwnedError` 之后 `create` 一个空白会话；feishu 甚至专门修双写
   造成的坏日志。`dsh-qq-onebot` 是例外（见 §0）。双写的代价不是"这一轮丢了"，而是"整个会话日志要修"。
2. **attach 优先，resume 一次，锁住就只读/排队。** `agents.get()` 是同进程最便宜、最安全的路径；
   `resume` 只对冷会话做一次；失败就如实告诉用户，而不是替用户换会话。
3. **会话身份与 UI 解耦，轮次串行是标配。** 一个聊天可以有多个会话（qq-plugin），
   一个会话可以被多个前端附着（OpenClaw）；同一会话的轮次用队列串行（LangBot `session: 1`、
   dsh-im-hub "同一聊天串行"）。

## 4. 为什么本插件不能直接抄 attach

本插件的 `restrictTools` 不是装饰：

- `registerToolGuard` 在 `setupAgent` 里挂到 **agent 作用域**的 `tools/pre-execute` 瀑布上；
- 普通用户只放行 `userTools` + `CHAT_TOOLS`，管理员才全量；`blockedTools` 连管理员都禁；
- 宿主创建的 agent 没有这段 setup。直接 `agents.get()` 接管，QQ 入口就会绕过工具权限——
  这正是 `AGENTS.md` 里"不要改成接管宿主已有 agent"的原因。

人格/模型也是同理：`setupAgent` 里挂 `persona`、`installModelSelection`、`agentPresets.mount`，
宿主 agent 都没有。

理论上可以"附着后再补装"：

- `agent.ctx` 是 agent 作用域上下文，文档说它的贡献 "agent-local, unwind on disposal"；
- `ctx.tools.guard()` 在普通上下文注册是**全局**的，在 `agent.ctx` 注册只作用于该 agent；
- `installModelSelection(agent.ctx, ...)` 也是往 agent ctx 挂 listener。

但要满足两个前提，当前都没有验证：

1. agent 发布之后还允许往 `agent.ctx` 注册（文档只说了 disposal 后拒绝，没说发布后）；
2. 守卫能区分"这一轮是 QQ 发起的"还是"WebUI 发起的"——`currentTurnIsAdmin` 是桥的字段，
   WebUI 在同一会话里发消息时它仍会是上一个 QQ 用户的身份，可能误伤 WebUI 的轮次。

所以 attach 是**方向**，不是**这一步**。在验证这两点之前，fork 是更稳的中间路线。

## 5. 推荐：fork-on-conflict

### 5.1 行为

```
QQ 消息 → openAgent()
  ├─ tryResumeComposition()  200/400/800ms 退避
  ├─ 仍 held 且 busyStrategy=fork
  │    ├─ 读旧会话事件（同进程 sessions.get；跨进程 persistence.open(read)）
  │    ├─ buildForkSeed(events, boundary)
  │    ├─ 新 id + agents.create({ seed, inheritedEventCount, meta.parentSession })
  │    └─ 通知："已从当前会话分叉，旧会话保留"
  ├─ busyStrategy=wait：先等 busyWaitMs，等不到再 fork
  └─ fork 失败 → rotate（不再做记忆蒸馏/交接）
```

关键点：

- **不等 5 分钟**。界面占着就立刻分叉；用户下一句话马上有回应。
- **不蒸馏旧世代**。旧会话可能还在 WebUI 里继续聊，提前蒸馏会把它截断；fork 已经有原文。
- **新 agent 仍然走本插件 setup**。工具守卫、人格、模型、群成员列表、记忆卡片都在。
- **旧会话原样保留**。WebUI 里继续聊、继续看；两边从分叉点各自往前走。

### 5.2 API 草图

```ts
import { buildForkSeed, SessionId } from '@deepseek-ai/dsh-session';

private async forkHeldSession(base: AgentComposition): Promise<AgentHandle | undefined> {
  const previous = this.sessionId;
  const live = this.services.sessions.get(SessionId(previous));

  // 同进程：宿主 WebUI 持有写句柄时，Session 仍然是 live 的，直接读快照。
  // 跨进程：read 句柄不取所有权，可以在对方持有 write 时打开。
  const { events, header } = live !== undefined
    ? { events: readSessionEvents(live), header: live.header }
    : await this.readPersistedSession(previous);
  if (events.length === 0) return undefined;

  // 最后一条事件即可：buildForkSeed 会给未闭合的 step/turn 补 forked closers。
  // 用 seq 而不是数组下标：dsh 保证 seq 从 0 连续，但写 seq 更不容易在边界上出错。
  const boundary = events[events.length - 1]!.seq;
  const seed = buildForkSeed(events, boundary);
  const nextId = `${this.baseSessionId}-fork-${Date.now()}`;

  const handle = await this.services.agents.create({
    sessionId: SessionId(nextId),
    meta: {
      cwd: header.cwd ?? this.agentCwd,
      parentSession: SessionId(previous),
      isSeeded: true,
      ...(header.agentPreset !== undefined ? { agentPreset: header.agentPreset } : {}),
    },
    inheritedEventCount: boundary + 1,
    seed,
    ...(base.agentOptions !== undefined ? { agentOptions: base.agentOptions } : {}),
    setup: base.setup,
  });

  this.sessionId = nextId;
  this.persistSessionId();
  // 记忆层：fork 的原文已经覆盖了上一段，别再注入一份摘要。
  // `markHanded` 是建议新增的方法（内部就是 store.setHandedGeneration）；
  // 也可以让 takeHandoff 识别 header.parentSession 后跳过。
  this.options.memory?.markHanded?.(this.key, nextId);
  return handle;
}
```

跨进程读取：

```ts
const persistence = this.services.getPersistence?.();
const handle = await persistence.open(SessionId(previous), 'read');
try {
  const { events } = await handle.read();
  return { events, header: handle.header };
} finally {
  await handle.close();
}
```

### 5.3 细节与坑

- **boundary 选哪**：最后一条事件最省事，`buildForkSeed` 会闭合 open turn；如果希望"只保留到上一轮
  结束"，从后往前找 `turn/end`，用它的 `seq` 做 boundary。两种都能通过 seed 校验。
- **旧会话正在跑一轮**：fork 会把这一轮截断，并用 `forked` 原因的 closers 收尾（模型会看到一条
  未完成的助手消息）。要么接受它（QQ 侧马上能回），要么先 `await liveAgent.whenIdle()` 并设一个
  短上限（例如 2s）再 fork；不要无限等——那又回到了 `wait` 的老问题。
- **`meta.cwd`**：用旧 `header.cwd`，不要硬换成当前 `agentCwd`。否则 fork 出来的会话和旧会话的
  工作目录语义不一致，`attachToGroup` 也可能对不上。旧 cwd 已被删除时回退到 `agentCwd`；
  两者都不可用就走 `wait` / `rotate`。
- **`agentPreset`**：旧 header 有 preset 就记下来，并让 `setupAgent` 按它挂载；否则 fork 后工具集
  可能从"旧会话的 preset"变成"当前配置的 preset"，模型会突然多/少一批工具。
- **记忆层**：fork 后新 sessionId 第一次 `takeHandoff` 会以为"换世代了"，可能再注入一份摘要 +
  tail，和 fork 的原文重复。要么在 fork 后把 `handed:<chatKey>` 标成新 id，要么让 `takeHandoff`
  识别 `header.parentSession` 并跳过。**不要**在 fork 时调 `finishGeneration('rotate')`。
- **通知文案**：`HELD_ROTATED_NOTICE` 是"原会话一直被占用，已开启新会话"；fork 应该换成
  "已从当前会话分叉（完整保留上下文），旧会话仍可在界面查看"。
- **`/status`**：`disposition()` 看的是当前 `sessionId`，fork 后自然是 `ours`；可以额外显示
  "forked from `<旧 id>`"，方便排查。
- **失败回退**：读不到事件、日志过大、`agents.create` 的 seed 校验失败，`fork` 策略回退到
  `rotate`；`wait` 策略则是先等、再 fork、最后 rotate。都记一条 warn，不要因为 fork 失败就把消息丢了。
- **上限**：`forkMaxEvents`（默认 4000，0 = 不限制）；超过就走 rotate（不再做摘要 handoff）。全量 fork 的 prefill
  成本是真实的，尤其是几万条事件的群聊。
- **不要用 `sessions.fork()` 直接建**：它创建的是 store 里的 live 子会话，`agents.create` 不能收养
  （discord bot 的注释已经踩过）。用 `buildForkSeed` + `agents.create({ seed })`。
- **旧宿主兼容**：没有 `buildForkSeed` / `sessionPersistence.read` 的版本，fork 不可用，直接走旧路径。

### 5.4 接点清单

| 位置 | 改动 |
|---|---|
| `src/bridge/reclaim.ts` | `BUSY_STRATEGIES` 加 `'fork'`；`normalizeBusyStrategy`；`DEFAULT_BUSY_STRATEGY` 可改为 `'fork'`；新增 `FORKED_NOTICE` |
| `src/bridge/chat.ts` | `openAgent` 的 `held` 分支；`forkHeldSession`；`readPersistedSession`；`persistSessionId`；`attachToGroup` |
| `src/dsh.ts` | `SessionPersistenceLike` 补 `read()` / `header`；`AgentComposition.meta` 补 `parentSession` / `isSeeded` / `agentPreset` |
| `src/config.ts` | `busyStrategy` 描述加 `fork`；可加 `forkMaxEvents` |
| `src/memory/service.ts` | `markHanded(chatKey, sessionId)`（或 `takeHandoff` 识别 parentSession） |
| `cordis.patch.yml` / `README.md` / `AGENTS.md` | 文案与默认值 |
| 测试 | `reclaim.test.ts` 的策略归一；`chat.test.ts` 的 fork 分支（fake sessions/persistence/agents）；`memory` 的跳过逻辑 |

## 6. 风险与验证

1. **seed 校验**：`seq` 必须从 0 连续；`inheritedEventCount` 必须等于复制的前缀长度；
   `buildForkSeed` 会放 `session/end-seed` marker。不要手搓 seed，直接用 `buildForkSeed`。
   已在当前仓库的 dsh 0.2.1-rc.2 上冒烟验证：`buildForkSeed` 可导入，对以 `turn/start` 结尾的前缀
   会补出 `session/end-seed` + `turn/end`（`forked` 原因）。
2. **上下文窗口**：fork 的是全量历史，第一次请求可能直接顶到窗口上限；dsh 的 compaction 会处理，
   但最好有 `forkMaxEvents` 上限，超限走摘要。
3. **分叉后不互通**：WebUI 旧会话看不到 QQ 新会话的后续；这是单写者的必然。文案要说清，
   `/status` 要能看出"当前是从哪个会话分叉的"。
4. **左栏分组**：`parentSession` + `isSeeded` 可能让新会话在 UI 里显示成子会话/分支；
   `attachToGroup` 仍按 cwd 挂工作区，需要实际看一眼。
5. **双写损坏**：feishu 的 `.corrupt-bak` 是前车之鉴。fork 只读旧日志，不碰旧写句柄；
   绝不要为了"接管"去动持久化的 `writers` 表。
6. **attach 的未来**：如果以后要走到"同一个 agent 多前端"，先验证
   `agent.ctx` 发布后能否注册、以及全局 `tools.guard()` 的轮次归属；在那之前 fork 是更安全的中间态。

## 7. 参考

- AstrBot：[WebUI](https://docs.astrbot.app/use/webui.html)、
  [ChatUI UMO 构造](https://github.com/AstrBotDevs/AstrBot/blob/afa43fc0/dashboard/src/utils/chatConfigBinding.ts)、
  [会话/对话管理器](https://github.com/AstrBotDevs/AstrBot/blob/09ab45fc/astrbot/core/conversation_mgr.py)
- LangBot：[系统设置（`concurrency.session`）](https://docs.langbot.app/zh/deploy/settings)、
  [Web 内嵌会话隔离 PR](https://github.com/langbot-app/LangBot/pull/2335)
- MaiBot：[聊天记录和统计（本地会话 vs 观察聊天流）](https://docs.mai-mai.org/manual/webui/chat-stats)
- OpenClaw：[Session attachment](https://docs.openclaw.ai/concepts/session-attachment)、
  [Session management](https://docs.openclaw.ai/sessions)、
  [Session controller](https://docs.openclaw.ai/concepts/session-controller)、
  [Command queue](https://docs.openclaw.ai/concepts/queue)
- dsh 插件：
  [`dsh-qq-onebot`](https://www.npmjs.com/package/dsh-qq-onebot)、
  [`dsh-qq-plugin`](https://www.npmjs.com/package/dsh-qq-plugin)、
  [`dsh-qqbot-bridge`](https://www.npmjs.com/package/dsh-qqbot-bridge)、
  [`@aiwayds/dsh-feishu`](https://www.npmjs.com/package/@aiwayds/dsh-feishu)、
  [`@luzhengyangtx/dsh-telegram-duty`](https://www.npmjs.com/package/@luzhengyangtx/dsh-telegram-duty)、
  [`dsh-discord-bot`](https://www.npmjs.com/package/dsh-discord-bot)、
  [`dsh-im-hub`](https://www.npmjs.com/package/dsh-im-hub)
- dsh 原生 fork：`node_modules/@deepseek-ai/dsh-session/README.md` 的 "Fork a session"；
  `@deepseek-ai/dsh-agent` 的 `CreateAgentOptions.seed` / `inheritedEventCount`；
  `@deepseek-ai/dsh-session-persistence` 的 `SessionHandle.read()`（read 不取所有权，可在对方
  hold write 时打开）
