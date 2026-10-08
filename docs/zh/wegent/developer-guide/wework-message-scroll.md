---
sidebar_position: 19
---

# Wework 消息列表架构与验证

## 架构边界

消息列表采用普通 DOM、正常 top-origin 文档流和单一自动跟随引擎。
Runtime、transcript 分页、消息业务 UI 和 `streamdown@2.5.0` 保持原有职责。
已加载消息全部挂载，不使用消息虚拟范围或 Markdown chunk 窗口化。
这减少了布局协调路径，不意味着已证明任意长度会话的性能或所有频闪问题。

已完成的历史 assistant 消息先批量测量真实高度，再启用 `content-visibility: auto`
和 `contain-intrinsic-block-size: auto <实测高度>`。浏览器可跳过离屏子树的布局和绘制，
但消息 DOM、内容和操作状态仍然存在。最新消息、流式消息和包含焦点的消息不跳过渲染。
`useDeferredMessageRendering` 在消息新增时只测量尚未初始化的历史行；列表宽度变化时
统一失效并重新测量。没有固定高度猜测，也没有按滚动帧运行的测量或位置补偿循环。
这降低深历史滚动成本，不为 DOM、React 节点或内存占用提供上限。

轮次导航在存在 `turnId` 时只按轮次身份匹配已加载消息；不能把尚未加载的轮次
按页内消息索引匹配到另一轮，否则会产生重复 React key、残留按钮和错误跳转。

### Codex 桌面实现核对（2026-10-08）

本机 `/Applications/ChatGPT.app` 的版本为 `26.930.61225`，bundle ID 为
`com.openai.codex`。同一包包含 ChatGPT 与 Codex 本地会话路径；仅检查内部
transcript 的 `map`，不能推出外层没有虚拟化。

静态代码确认 `local-conversation-thread` 和一个 `chatgpt-conversation-page`
接入 `virtualized-turn-list`。其几何模块以实测高度优先、每轮预估高度其次、默认
280px 最后计算总高度；按可见范围加前后各两轮挂载，以轮次身份保持阅读锚点。
`useLayoutEffect` 与共享 `ResizeObserver` 校正测量，最多连续八轮同步校正后让到
下一帧。导航先挂载目标再测量定位，恢复状态含高度缓存和窗口锚点，最新轮次另有
跟随状态机与局部高度更新路径。

部分正文块另用 `content-visibility: auto` 和 240px 初始占位；虚拟列表会把其内部
正文强制为 `visible`，避免嵌套高度估算。Wework 采用离屏渲染思想，但先测量真实
高度，不复制其虚拟列表、底部坐标系或占位常量。这是代码路径核对，不是对 Codex
所有功能开关或快速滚动体验的运行时证明。

| 模块                                           | 职责                                                     |
| ---------------------------------------------- | -------------------------------------------------------- |
| `MessageList`                                  | 按稳定消息 ID 渲染；保留附件、编辑、复制、分叉和工具操作 |
| `ScrollableMessageArea`                        | 内容、footer、历史缺口、导航和回到底部按钮的组合         |
| `useConversationFollow`                        | 直接接入 `use-stick-to-bottom@1.1.6`，唯一自动跟随来源   |
| `useConversationScrollController`              | 用户接管、主动发送、隐藏窗格、有限恢复等业务意图         |
| `MessageTurnNavigation`                        | 已加载目标一次定位；未加载目标通过现有接口加载后定位     |
| `conversationViewportCache`                    | 按会话保存有界语义快照，不保存虚拟条目尺寸               |
| `processingExpansionState`                     | 按会话、消息、稳定 block/tool ID 保存展开状态            |
| `TaskDetailScrollArea` / `TaskDetailScrollbar` | 桌面真实 viewport、自绘滚动条及键盘交互                  |

前七项位于 `packages/collaboration/src/conversation/`；桌面宿主位于
`wework/src/components/layout/`。主窗口、移动布局、临时会话、侧栏、分栏、
Issue 的 `RuntimeExecutionConversation` 和 `BrowserTaskConversationContent`
使用同一共享实现，不保留桌面与 Web 两套滚动引擎。

每个实例只绑定一个真实滚动元素。外部宿主 ref 只选择元素，不改变坐标语义；
滚动范围始终为 `0 ... max(0, scrollHeight - clientHeight)`。
短会话填满视口，长会话自然增长，sticky composer 仍在同一内容流内。
无会话的任务详情布局不变。

## 自动跟随和用户意图

库负责内容及 viewport resize 的自动贴底，首版配置为
`initial: false, resize: 'instant'`。初始化在真实消息 DOM 提交后显式启动；
流式 token 不触发业务层滚动命令。不存在自写 spring、定时追底窗口或永久校正 RAF。

首次定位与持续跟随分开：消息仍以真实 DOM 参与布局，但在容器绑定、数据加载和
阅读锚点恢复完成前不显示。layout effect 通过依赖的 `state.scrollTop` 同步写入
目标位置后才显示正文；首次打开定位最新消息，有阅读快照则恢复锚点偏移。
不能用库的 `scrollToBottom('instant')` 代替首次定位，因为它仍在下一帧写入。
完成首次定位后，内容增长和视口变化继续由库跟随，不重复执行初始化。

| 事件                                   | 行为                                                          |
| -------------------------------------- | ------------------------------------------------------------- |
| 无快照首次打开                         | 等待非空数据和真实 DOM，然后开启跟随                          |
| 主动发送进入本地消息序列               | 通过 `viewportActionsRef.follow()` 开启跟随，不等待服务端回包 |
| 主动 guidance                          | 在提交时声明跟随意图，延迟回包不得再次抢位                    |
| 浏览器宿主发送                         | 在实际请求前声明意图；排队自动执行、暂停及刷新不触发跟随      |
| token、run-start、完成、后台队列更新   | 不推断用户发送，不改变阅读意图                                |
| 回到底部                               | 显式调用库；用户再次接管可取消尚未执行的帧                    |
| 上滚、阅读快捷键、触摸或自绘滚动条操作 | 停止跟随并使未完成定位失效                                    |
| 向下到实际底部                         | 库恢复跟随；near-bottom 本身不能撤销暂停                      |
| 鼠标或键盘展开/折叠                    | 在 DOM 改变前暂停；触发器保持身份，详情正常布局               |
| 隐藏窗格再显示                         | 保留原有意图，只为原先 following 的窗格恢复跟随               |
| 会话切换或卸载                         | 保存快照，取消旧操作并解绑事件、observer 和待执行动画         |

输入框文本导航、Ctrl/Cmd 组合键、工具及代码内部滚动不应误判为外层接管。
自绘滚动条的 Tab 聚焦不构成滚动；Home/End/PageUp/PageDown/上下键维持原语义。

`conversationScrollInput` 只把输入转换为暂停意图，不写滚动坐标。单指向旧消息方向
滑动至少 8 CSS px、且纵向位移大于横向位移时才接管；抖动、横向拖动、向底部滑动、
多指手势和已结束/取消的序列不暂停。键盘在 React 子控件处理之后判断
`defaultPrevented`，并排除 IME、表单控件和可编辑内容；不同窗格只处理自己的输入。
滚轮、键盘或触摸向底部移动时也取消旧的异步定位，但不暂停正常跟随；
“取消导航”和“进入阅读”是两种不同操作。

恢复和轮次导航只计算目标坐标，通过 controller 的 `position(top)` 统一定位。
该命令暂停跟随，并使用依赖公开的 `state.scrollTop` setter 标注程序写入。
即使目标被钳制到实际底部，对应的 scroll 事件也不能把 reading 改回 following。
这里复用同一个引擎的状态，不增加第二套跟随标记或延迟纠偏。

不对整条 conversation 禁用原生滚动锚定。阅读期间普通历史前插和重排交给浏览器，
不能重新增加全局高度差补偿。工具展开没有改变外部几何的高度动画。
稳定布局、无边界钳制时应保持触发器位置；折叠导致内容消失或最大滚动范围缩小时，
合法钳制不应被补偿出空白。宽度变化不承诺保持同一字符的屏幕位置。

## 快照、展开状态和导航

快照版本为 `schemaVersion: 1`：

- `following` 只保存意图，重新打开时定位当前底部。
- `reading` 保存 `messageId`、可用的全局 `messageIndex`、
  `offsetWithinAnchorPx` 和 `viewportWidthPx`。
- 定位粒度是消息，不伪造缺少的 block ID，也不估算换行后的字符位置。
- 未加载目标通过现有 turn loader 加载，再于 DOM 提交后定位。
- 已删除目标选择最近仍加载的消息索引；没有索引时使用第一条消息，不跳到底部。
- 加载失败保留原快照，记录诊断并保留宿主错误状态，不声称恢复成功。
- 空会话加载和空态不覆盖已有阅读快照。

定位是一次有目标的 DOM 滚动。新导航、用户接管、会话切换使旧操作代次失效；
不使用多轮延迟重新对齐。多个可见轮次可同时激活，assistant 内容计入所属轮次。
历史分页和缺口重试继续使用现有 loader。

快照最多 50 个会话，展开状态最多 2000 项。会话淘汰、显式删除和缓存清理同时清除
对应展开状态。展开状态沿用同会话共享语义；活动视口、跟随和异步定位按实例独立，
不会对另一个已打开窗格直接写位置。恢复快照使用该会话最近保存的视口记录。

## 消息更新范围

`MessageRow` 是消息级 memo 边界。绑定消息的编辑、分叉和可视化回调在行内生成，
列表传入稳定回调、默认数组和行级状态，避免末条回答更新时重新执行未变的历史行。
采用默认浅比较；消息对象、宿主回调、服务或运行轮次元数据变化仍会更新对应行。
消息对象必须沿用 Runtime 现有的不可变更新约定。

展开状态按 key 订阅。修改、清理和容量淘汰只通知受影响的 key；已有值的同值写入
不通知。首次显式选择即使等于默认值也会保存，避免重挂载时被不同默认值覆盖。
同 key 的多个已挂载视图保持同步，淘汰会让它们重新读取自己的默认值。

工具详情和文件 diff 的选择使用消息作用域与稳定 block ID，跨流式输出、回合结束和
时间线重排保留。连续文件变更合并时沿用首条变更的 ID，追加 chunk 不重置详情。
显式展开的详情会保持过程区可见；主动折叠过程区或摘要会清理对应详情状态。关闭
单个详情不自动隐藏仍在运行的工具列表，完成后的默认折叠仍服从用户显式选择。
批量折叠只通知受影响的订阅者，每个订阅者在一次批量更新中最多收到一次通知。

这些优化缩小组件执行和订阅通知范围，列表筛选与遍历仍为 O(n)。不以组件执行次数
代替首屏耗时、CPU、内存或物理触控板体验的测量。

## 依赖补丁

`@wegent/collaboration` 精确锁定 `use-stick-to-bottom@1.1.6`。
`pnpm-workspace.yaml` 注册 `patches/use-stick-to-bottom@1.1.6.patch`，
lockfile 同时绑定版本和补丁哈希。补丁位于依赖层，不复制引擎到业务层。

2026-09-23 的接入测试在未修补版本上稳定暴露以下契约缺口：

- viewport 从 300px 缩为 200px、内容不变时，底部留下 101px 缺口；
- viewport 增大造成的边界钳制可能被判为退出跟随；
- 内容缩短可能恢复用户已主动暂停的跟随；
- 仅声明 `overflow-y: auto` 时，上滚识别依赖了错误的 overflow 属性；
- 替换真实滚动元素时，旧元素的监听器没有正确解除。

补丁统一观察内容与 viewport，保留 reading 意图，区分实际边界钳制与用户滚动，
使用 `overflowY` 查找滚动所有者，并修正 ref 清理和待执行 RAF 的取消。
原有动画仍在依赖内；产品采用即时跟随作为正确性基线，不在业务层重复追底。

接入时核对的上游 PR #43 尚未合并，因此没有把它当成已发布修复。
升级时须在候选版本运行相同契约测试，确认不再需要补丁后同时删除补丁和注册；
不能直接追踪上游 main 或 PR 分支。这里记录接入时事实，不保证上游后续状态不变。

## 已删除的旧路径

以下共享实现、桌面转发入口、失效 props 和仅验证旧实现的测试已移除：

- `useBottomOriginVirtualizer`、`bottomOriginScroll`；
- `streamingScrollFollow`；
- `messagePretextLayout` 及虚拟条目尺寸缓存；
- `assistantMarkdownWindowing`、`WindowedMarkdownChunk` 及估算占位；
- 旧 message 级估算占位和虚拟测量注入；当前离屏优化使用真实 DOM 高度。

保留 Streamdown 的受控链接、图片、代码、表格、可视化及流式 DOM 连续性；
`useBufferedStreamingText` 仍只合并帧内更新，不维护落后于权威内容的逐字队列。
共享包移除 TanStack Virtual 和 pretext，桌面移除 pretext。
桌面 TanStack Virtual 仍用于 `MarketplaceCatalogView`、`CategoryBrowseDialog`。

## 回归与证据边界

单测采用受控几何和 ResizeObserver，验证契约而非模拟真实浏览器布局：

| 覆盖                                               | 入口                                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| 依赖 resize、暂停、取消、元素替换、StrictMode      | `wework/src/components/chat/useConversationFollow.test.tsx`                  |
| 初始化、DOM、展开、快照、导航、历史、外部/隐藏窗格 | 同目录 `ScrollableMessageArea.test.tsx`                                      |
| 消息业务和 Markdown DOM 连续性                     | `MessageList.test.tsx`、`AssistantMarkdown.streaming.test.tsx`               |
| 共享调用者、发送、滚动条、缓存                     | Shared conversation、pane session、临时会话、scrollbar 和 runtime cache 测试 |
| 浏览器发送与延迟响应                               | `packages/collaboration/src/issue-detail/BrowserTaskComposer.test.tsx`       |

聚焦命令从仓库根目录执行：

```sh
pnpm --filter wework test src/components/chat/ScrollableMessageArea.test.tsx src/components/chat/useConversationFollow.test.tsx
pnpm --filter @wegent/collaboration test src/issue-detail/BrowserTaskComposer.test.tsx
pnpm --filter @wegent/collaboration build
pnpm --filter wework typecheck
```

E2E 源码同步改为正坐标，保留长代码身份、用户取消、历史重开等场景，
增加全部 Markdown 标题挂载、无占位及滚动前后消息数量不变的断言。

### 滑动性能的量化回归

长会话"滑不滑得动"现在有可断言的数字，入口是桌面 E2E 检查点
`conversation-scroll-performance`。三个前提缺一不可：

- **明确输入路径**：`e2e.wheelGesture` 用 `webContents.sendInputEvent`
  探测原生滚轮，但后台窗口不保证执行原生滚动。性能比较使用相同的
  `scrollSteps`：每步发送滚轮意图、修改位置、等待动画帧。这测量真实
  Electron 中的主线程渲染负载，不等同于触控板或合成器滚动的端到端流畅度。
- **真实帧采样**：`startScrollPerformanceSampling` /
  `stopScrollPerformanceSampling` 按 `requestAnimationFrame` 记录每帧的
  `scrollTop`，并用 `PerformanceObserver` 收集 `longtask`。按手势实际起止
  时间截取样本，手势完成后显式停止；不能按步数乘间隔预估采样长度，
  否则卡顿会让手势超出采样窗口。不要用
  `startScrollStabilitySampling` 得出滑动结论：它按 `setInterval` 计时，并把
  DOM 变更混进同一数组，无法区分掉帧和 MutationObserver 回调。
- **机器无关的断言**：`assertScrollHealth` 保证手势真的滚动了
  （`scrolledPx`）且没有超过 2s 的冻结；`assertScrollScaling` 在同一次运行内
  用同一手势比较"首屏"与"全部加载"两种状态，用比值抵消机器速度，避免把
  绝对值写进 CI。需要硬阈值时设置 `WEWORK_E2E_SCROLL_P95_BUDGET_MS`。

指标含义：`p95FrameGapMs`/`maxFrameGapMs`（帧间隔）、`droppedFrameCount` 与
`droppedFrameRatio`（超过 1.75 个 vsync 的间隔占比）、`longestScrollStallMs`
（输入仍在持续但内容连续不动的时长）、`longTaskTotalMs`（主线程长任务）、
`scrolledPx`（手势实际滚动了多少像素）。

```sh
pnpm --filter wework e2e:desktop -- --segment conversation-scroll-performance
node --test wework/e2e/desktop/modules/scroll-performance.test.mjs
```

数字写在本次运行的 `perf-heavy-conversation.json`：`scroll.measurements`
是每个阶段（首屏、全部加载、向下）的指标，`scroll.comparison.p95Ratio` 是
"全部加载 / 首屏"的帧间隔倍数。
`rendering-extensions` 调用 `streaming-text.scenario.mjs`；
`window-lifecycle` 覆盖重开；由现有 desktop runner 和
`.github/workflows/wework-e2e.yml` 的 checkpoint matrix 调用，没有新增本地专用套件。

**只有用户明确要求才运行 E2E 和 `ai:verify`。**
首轮实施只运行单测与静态检查；用户随后授权的真实 Electron E2E 结果见下方记录。
以下是完整验证计划，不代表每一项均已覆盖，不能用单测代替：

1. 隔离真实 Electron 创建长历史，暂停模型响应后发送，检查等待指示器完整可见、
   稳定后距底部误差不超过 2 CSS px；持续输出期间上滚必须停止追底。
2. 鼠标与 Enter/Space 展开工具、思考、子代理，检查触发器和 DOM 身份；随后立即滚动，
   确认无过期回调抢位。合法边界钳制不要求越界保持原像素。
3. 改变 footer、窗口与侧栏尺寸，分别测试 following 和 reading；
   不把字符级不动当作宽度重排契约。
4. A→B→A、未加载导航、取消、缺口补全、多窗格、关闭后重开；
   检查旧回调不会写新宿主，无消息卸载导致的跨消息选区丢失。
5. macOS 和 Windows 验证滚轮、触控板、滚动条及原生快捷键；
   对 500/1000 条重消息记录首屏、CPU、内存及交互延迟，不提前宣称性能提升。
6. 保留关键帧位置和日志证据，关闭隔离实例并清理测试会话。

### 2026-09-23 首轮实施验证记录

- Wework 聚焦回归：18 个文件、618 个用例通过，包括工具分组追加时的触发器身份、
  展开后不裁切、重新挂载及缓存淘汰。
- `BrowserTaskComposer.test.tsx`：20 个用例通过。
- `WorkbenchProvider.test.tsx` 定向执行主动发送、后台队列和延迟 guidance 三个用例，
  均通过；其余用例不在本次定向执行范围内。合计执行 641 个用例。
- collaboration、Wework 和 frontend TypeScript 检查通过。
- 49 个变更 TypeScript 文件与分支基线比较：ESLint 新增问题为 0。
  共享包 `ProcessingActivity`、`ToolInlineDiff`、`MarkdownServices` 原有的
  6 项 `react-refresh/only-export-components` 报错仍存在；不是完整 lint 零报错。
- 6 个变更 E2E 模块通过 Node 语法检查，但没有执行 E2E、`ai:verify`、
  Windows 交互验证或 500/1000 条消息的性能测量。

### 2026-09-23 授权 E2E 回归记录

环境：macOS arm64、Node 24.18.1、Electron 43.4.1、Codex 0.155.1。
使用当前源码构建的 Electron 应用和真实 executor/Codex，每个检查点隔离应用标识、
用户目录和任务数据；协作共享核心启动真实本地 backend/Redis。
结果为 **11/11 个检查点通过**，不是整个桌面 E2E 矩阵全量通过。

下表目录均位于 `wework/test-results/desktop-e2e/`，保存关键截图和日志：

| 检查点                         | 通过证据目录                     |
| ------------------------------ | -------------------------------- |
| `rendering-extensions`         | `2026-09-23T05-42-19-050Z-74194` |
| `conversation-state`           | `2026-09-23T05-25-54-750Z-573`   |
| `window-lifecycle`             | `2026-09-23T05-43-31-601Z-77557` |
| `environment-panel-scroll`     | `2026-09-23T05-28-37-946Z-15929` |
| `temporary-chat`               | `2026-09-23T05-36-28-780Z-51136` |
| `split-workbench`              | `2026-09-23T05-37-11-410Z-52897` |
| `runtime-task-queue`           | `2026-09-23T05-30-46-592Z-30419` |
| `transcript-sync`              | `2026-09-23T05-30-55-061Z-31111` |
| `running-conversation-history` | `2026-09-23T05-32-00-921Z-42806` |
| `collaboration-shared-core`    | `2026-09-23T05-28-46-399Z-17164` |
| `board-focus-view`             | `2026-09-23T05-38-41-449Z-61972` |

PR `wecode-ai/Wegent#3697`（head `a4ed08454c1816787a6ea5333fd413ff194f29f7`）
仅包含一个 E2E 变更文件，其新增断言已全部接入现有 `rendering-extensions`，
没有移植该 PR 的旧滚动实现。公共步骤在
`wework/e2e/desktop/modules/conversation-disclosure.mjs`：

- 工具详情展开位移不超过 8px，且不能被拉回底部；
- 向上微滚 12px 时，工具行移动 12px（容差 8px）；
- 滚走再回来，输出仍挂载且 `aria-expanded=true`。

`tool-detail-disclosure-metrics.json` 实测展开位移 **0px**、微滚位移 **12px**。
夹具保留 PR 的 20 段后续正文和 200 行工具输出，命令改用 Node 循环，
不依赖 Windows 缺少的 `seq`。

失败驱动的测试修正：

1. 原居中定位使第一轮工具行处于 `scrollTop=0`，两次运行均得到上滚位移 0px。
   几何诊断确认边界钳制后，改用顶部对齐并断言有至少 12px 上滚空间，
   不放宽原位移容差。
2. 临时会话及看板弹层改为正坐标；临时会话仍检查实际距底部误差。
   停止消息仍保留一次，改查顺序和视口位置，不再把 DOM 卸载当作正确性条件。
3. 原生按键主动激活窗口，分栏的非激活光标检查必须先执行。
   弹出窗先显式激活主窗，避免测试后台隔离策略隐藏整个应用。
4. 关闭到托盘保留 renderer；通过真实托盘动作恢复并断言身份不变。
   另行显式重载，继续检查旧控制连接失效和 executor 身份不变。
   同时补齐证据目录参数及正确的 `reloadMainWindow` 控制命令。

本轮未增加产品逻辑补丁。额外执行 5 个滚动/展开单测文件，共 58 个用例通过；
6 个本轮变更 E2E 文件的 Node 语法、Prettier、ESLint 检查及 `git diff --check` 通过。
隔离测试进程已退出；runner 清理临时运行文件并保留诊断证据。

单检查点复现命令（仓库根目录，各平台相同；将名称替换为表中检查点）：

```sh
pnpm --filter wework e2e:desktop --segment rendering-extensions
```

未覆盖：Windows/Linux 原生运行、物理触控板手感、500/1000 条重消息性能量测、
单独的 `ai:verify` 流程和完整 CI 矩阵。1200 项运行中历史通过的是功能测试，
不等于性能基准，也不代表 Web 浏览器宿主已完成端到端验证。

### 2026-09-28 滚动意图与更新范围优化

在上述重写上继续实施，保留普通 DOM 和唯一跟随引擎。先在原实现建立受控几何或
真实 React 组件用例，确认以下问题后修改：

- 非阅读触摸、已处理键盘事件及部分 contenteditable 文本导航误暂停跟随。
- 阅读状态下导航或恢复到物理底部后，程序 scroll 事件误恢复跟随。
- 未加载轮次导航期间，用户已向下追底到 `scrollTop=1100`，旧导航完成后仍写回 `0`。
- 82 条已挂载消息，末条回答更新 3 次，会执行 123 次 UserMessage 和 123 次
  AssistantMessage。行级 memo 后分别为 0 次和 3 次；这是受控组件执行计数。
- 展开状态写入会通知所有 key，已有值的同值写入也广播。

自动验证覆盖输入排除、触摸方向反转、多窗格隔离、初次/延迟恢复、程序滚动与用户
滚动事件合并、三类输入取消异步导航、最新回调/元数据、编辑草稿、展开状态同步与淘汰。
聚焦入口新增 `ConversationPositioning.test.tsx`、`MessageList.rendering.test.tsx`
和 `processingExpansionState.test.tsx`，并扩展 `ScrollableMessageArea.test.tsx`。

结果：12 个聚焦测试文件、289 个不同用例通过；collaboration、Wework、frontend
类型检查通过。本轮涉及文件的 Prettier、ESLint 和 `git diff --check` 通过。
共享文件使用 Wework ESLint 规则通过 stdin 检查，避免 ESLint 10 的 base-path
限制跳过包外源码；这不是仓库全量 lint 结果。

`rendering-extensions` 现有流式场景增加真实 DOM touch 事件回归：在模型输出被暂停时
输入抖动、横向和向底部手势，再释放模型内容并断言仍贴底。测试控制器没有模拟布局
或直接改产品跟随状态。这些是合成输入，不代表物理触摸设备已验收。

本轮未执行 E2E、`ai:verify`、Windows/Linux 原生交互或大历史性能测量；
2026-09-23 的 E2E 记录只证明当时版本，不代替本轮新增断言的执行结果。

## 不变的 Runtime 契约

视口重写不修改消息来源和顺序。规范化 turn 视图按 executor transcript 全局
`messageIndex` 合并；本地已停止回合回到原位置，只有无索引临时回合才以时间戳
作为次级排序依据。Provider transcript 保持自身分页和稳定 ID 去重，
不混入本地已停止回合，也不绕过 Provider 分页。

空闲任务的新目标及首条指令仍通过一次 `runtime.tasks.send` 原子发送。
Codex `thread/goal/set` 自动启动的目标回合不能再额外 `turn/start`。
对应真实回归和 executor 日志检查继续保留，不能用滚动层补偿掩盖重复回合或顺序问题。

## 2026-09-29：思考结束后的历史阅读稳定性

本轮针对“正在阅读历史消息时，下方开始流式正文”的反馈，重写消息展示路径。
删除共享层 `AssistantMessage.tsx`、`blocks/ToolBlocksDisplay.tsx`，由
`AssistantTurn.tsx`、`AssistantTurnTimeline.tsx`、`assistantTimelineEntries.ts` 和
`blocks/ProcessingSegment.tsx` 接管；对外组件接口不变。

旧实现的两个 DOM 问题已通过回归用例复现：首个正文到来时卸载已显示的过程内容；
正文后追加工具事件时，正文切换渲染分支并重建节点。新的时间线按来源 ID 保持节点，
过程区域始终位于相同层级。正文开始流式输出不自动折叠已显示的过程；后续根据用户
反馈调整为整轮成功完成后默认折叠，与重新进入历史会话一致。用户明确选择的展开状态
优先于默认值，并通过原有缓存保存。

验证范围：

- 消息、过程展开、Markdown、滚动控制、主题守卫及共享工具组件的聚焦测试通过。
- 新增用例覆盖过程到正文的节点连续性、正文后追加工具的节点连续性，以及历史阅读
  在首个正文、继续追加、完成期间仍暂停跟随。位置用例使用 JSDOM 受控几何和边界钳制，
  不能代替真实浏览器布局验证。
- E2E 新增 `modules/final-answer-reading.mjs`，由现有 `streaming-text` 场景调用，
  纳入原有 `rendering-extensions` CI 套件：真实历史消息上滚、模型结束思考并分块输出正文、
  采样历史段落位置、检查缺帧与位移、点击回到底部后恢复跟随。
- 本轮未运行 E2E 或真实 Electron，因此尚未确认用户报告的完整视觉闪烁已消失。

## 2026-09-29：首次可见位置与流式节点连续性修复

后续排查确认首次定位存在两处延迟：普通 effect 才绑定滚动容器，库的
`scrollToBottom('instant')` 仍等待下一帧写入。现在先在 layout effect 绑定并同步
定位，正文保留真实布局但在定位完成前不可见；外部祖先 ref 尚未就绪或阅读锚点
需要异步加载时也遵守此约束。随后才交给库持续跟随。加载失败解除隐藏并保留原快照，
不把错误位置保存成新的阅读记录。

长代码块节点替换的根因在时间线投影：`AssistantTurn` 清理了正文尾部空白和插件
结果标记，而投影用未清理的来源文本比较。流式片段末尾的换行或空格使投影反复切换
到不同 key 的分支，连同代码节点一起重建。现在比较和展示使用相同的文本清理规则，
保留来源 key；没有修改语法高亮或放宽代码节点身份断言。

验证用例覆盖内部/外部滚动容器在任何动画帧之前完成定位、加载后恢复阅读锚点、
异步历史加载期间不可见、恢复失败保留快照，以及尾部空白跨片段更新时正文、过程和
代码节点保持身份。真实 Electron 回归通过现有 `rendering-extensions` 注册：
完成长代码响应后切换空会话并重载，清除内存视口记录；在点击原任务前启动逐帧采样，
检查每一个可见帧都在最新位置，再上滚并切换回来检查阅读位置。后续历史阅读用例
逐段核对完整答案，避免用 Markdown 空行匹配 DOM `textContent` 的错误断言。

本次验证：8 个聚焦测试文件共 93 项用例通过，TypeScript、变更文件 ESLint 和格式
检查通过。macOS arm64 隔离 Electron、真实本地 backend/executor/Codex、仅模拟模型
服务的完整 `rendering-extensions` 通过（4 分 22 秒）。首次打开采到 170 个可见帧、
阅读恢复采到 159 个可见帧，均在目标位置；长代码原节点身份断言、历史阅读、工具
展开、停止后的顺序和子智能体场景均执行通过。证据目录：
`wework/test-results/desktop-e2e/2026-09-29T08-17-42-607Z-80609`。
调试中另修正了新增用例的桌面专用 selector 和历史阅读用例的段落文本断言；
此前失败记录保留，没有通过跳过断言或原样重跑掩盖失败。未运行独立 `ai:verify`
或 Windows/Linux 验证。

## 2026-09-29：完成后的默认过程折叠

修复“实时完成后过程仍展开，退出重进却折叠”的不一致。过程展开的默认值不再取首次
挂载时的 `canCollapse`，而是随完成状态变化：消息尚未成功完成或所在活动回合仍在
等待时默认展开；成功完成后默认折叠。共享展开缓存只保存用户操作，已有明确的展开
或收起选择不被完成事件覆盖。过程仍在固定前缀区域内折叠，正文保留原节点。

回归覆盖首次正文、逐步增长、回合完成、退出重进，以及用户手动展开和收起。真实
Electron 场景分别采样流式增长与完成收起两个阶段，模型输出全部正文后等待测试放行
完成事件，确保检查的是终态切换；两段采样均要求历史段落没有消失、位置不跳动，完成
阶段还检查过程高度实际收缩和正文节点身份保留。视口滚动范围确实不足时仍允许浏览器
合法钳制，不引入空白占位或额外高度补偿。

本次 8 个聚焦测试文件的 272 项用例、TypeScript、ESLint 和格式检查通过。macOS
arm64 隔离 Electron 的完整 `rendering-extensions` 通过（4 分 18 秒），覆盖自动
收起、手动展开选择、两种状态的退出重进、流式及完成时的历史位置、正文节点连续性，
并保留长代码、首屏、工具顺序和子智能体回归。工具顺序用例改为等待完成后的默认
折叠，再显式展开检查，避免把首段最终文字误当作回合完成。证据目录：
`wework/test-results/desktop-e2e/2026-09-29T08-35-44-387Z-81860`。
