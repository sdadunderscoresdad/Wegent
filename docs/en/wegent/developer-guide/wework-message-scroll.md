---
sidebar_position: 19
---

# Wework Conversation Architecture and Verification

## Ownership

The timeline uses mounted DOM, normal top-origin flow, and one automatic follower.
Runtime, transcript pagination, message business UI, and `streamdown@2.5.0` retain
their responsibilities. Every loaded message stays mounted; virtual ranges
and Markdown windowing are removed. This reduces
coordination, but does not prove unlimited-history performance or fix every flicker.

Completed historical assistant messages are measured in a batch before enabling
`content-visibility: auto` and `contain-intrinsic-block-size: auto <measured height>`.
The browser can skip offscreen layout and paint while DOM, content, and action state
remain mounted. Latest, streaming, and focused messages keep normal rendering.
`useDeferredMessageRendering` measures only newly eligible rows on message updates,
and invalidates all heights when the list width changes. It uses no fixed height
guess and no per-scroll measurement or position-compensation loop. This reduces
deep-history scrolling cost; it does not bound DOM, React nodes, or memory.

Navigation with a `turnId` resolves loaded messages by turn identity. An unloaded
turn must not match another turn by a page-local message index: that creates duplicate
React keys, stale buttons, and incorrect jumps.

### Codex desktop audit (2026-10-08)

The local `/Applications/ChatGPT.app` is version `26.930.61225`, bundle ID
`com.openai.codex`. It contains both ChatGPT and local Codex conversation paths;
an inner transcript's `map` does not establish whether its parent virtualizes it.

Static code connects `local-conversation-thread` and one `chatgpt-conversation-page`
to `virtualized-turn-list`. Its geometry prioritizes measured heights, then per-turn
estimates, then a 280px default. It renders the visible range plus two turns on each
side and preserves reading anchors by turn identity. Layout effects and a shared
`ResizeObserver` correct measurements, yielding after eight synchronous correction
passes. Navigation mounts and measures its target before positioning; restoration
includes height caches and a window anchor. Latest-turn follow state and local
height updates have dedicated paths.

Some body blocks also use `content-visibility: auto` with a 240px initial placeholder.
The virtual list forces nested body content to `visible` to avoid layered estimates.
Wework adopts offscreen rendering with measured heights, without copying that virtual
list, bottom-origin coordinates, or placeholder constants. This is a code-path audit,
not runtime proof of every Codex feature flag or fast-scroll behavior.

| Module                                         | Responsibility                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| `MessageList`                                  | Stable IDs, attachments, editing, copying, forking, and tool actions   |
| `ScrollableMessageArea`                        | Content, footers, history gaps, navigation, return-to-bottom           |
| `useConversationFollow`                        | Direct integration with the sole follower, `use-stick-to-bottom@1.1.6` |
| `useConversationScrollController`              | Reader takeover, explicit sends, hidden panes, finite restoration      |
| `MessageTurnNavigation`                        | One-shot positioning and existing loaders for missing targets          |
| `conversationViewportCache`                    | Bounded semantic snapshots, not virtual measurements                   |
| `processingExpansionState`                     | Conversation/message/stable block or tool disclosure identity          |
| `TaskDetailScrollArea` / `TaskDetailScrollbar` | Desktop viewport, scrollbar, and keyboard behavior                     |

The first seven modules live in `packages/collaboration/src/conversation/`;
desktop hosts live in `wework/src/components/layout/`. Main/mobile layouts,
temporary chats, side/split panes, `RuntimeExecutionConversation`, and
`BrowserTaskConversationContent` consume the same implementation.

Each instance binds one actual scrolling element. An external ref chooses the
element, never the coordinate system. The range is
`0 ... max(0, scrollHeight - clientHeight)`. Short conversations fill the viewport;
long ones grow naturally, with the sticky composer in the same flow.
Task details without conversations retain their layout.

## Following and intent

The dependency owns content and viewport resize following, initially configured
with `initial: false, resize: 'instant'`. Initialization waits for nonempty
message DOM. Tokens never issue business scroll commands. There is no custom
spring, settling retry window, or permanent correction RAF.

| Event                                           | Behavior                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------- |
| First open without a snapshot                   | Wait for messages and DOM, then follow                                          |
| Explicit local message append                   | Call `viewportActionsRef.follow()` before server acceptance                     |
| Explicit guidance                               | Declare intent at submission; delayed acceptance never follows again            |
| Browser send                                    | Declare intent before dispatch; queue pumping, pause, and refresh do not follow |
| Tokens, run-start, completion, background queue | Do not infer user sends or replace reading intent                               |
| Return-to-bottom                                | Call the dependency; reader input cancels pending frames                        |
| Upward input, reading keys, touch, scrollbar    | Stop following and invalidate positioning                                       |
| Downward scroll to actual bottom                | Resume through the dependency; near-bottom alone is insufficient                |
| Mouse/keyboard disclosure                       | Pause before layout changes; preserve trigger identity and flow                 |
| Hide/show                                       | Preserve intent; resume only previously following panes                         |
| Switch/unmount                                  | Save snapshots, cancel stale operations, release observers/listeners/frames     |

Composer text navigation, Ctrl/Cmd combinations, and nested tool/code scrolling
must not become outer takeover. Tabbing to a scrollbar does not scroll;
Home/End/PageUp/PageDown/arrow controls retain their semantics.

`conversationScrollInput` translates input into pause intent without writing
coordinates. A single finger must move at least 8 CSS px toward older messages,
with vertical displacement greater than horizontal displacement. Jitter,
horizontal drags, movement toward the bottom, multitouch, and ended/cancelled
sequences do not pause. Keyboard handling runs after React child handlers so it
can respect `defaultPrevented`, and excludes IME, form controls, and editable
content. Each pane handles only its own input.
Wheel, keyboard, and touch input toward the bottom also cancel stale asynchronous
positioning without pausing normal follow. Cancelling navigation and entering
reading mode are separate operations.

Restoration and turn navigation calculate a target and use the controller's
`position(top)` command. It pauses follow and writes through the dependency's
public `state.scrollTop` setter, which marks programmatic movement. A target
clamped to the bottom therefore cannot turn reading into following through its
scroll event. This reuses the engine's state without another follow flag or
delayed correction.

Do not globally disable native anchoring. Ordinary reading-mode insertion/reflow
relies on the browser, not global height compensation. Disclosure has no
external-height animation. Stable layouts without clamping should preserve the
trigger position. Removed content or shrinking ranges may legitimately clamp;
never create blank space to compensate. Width reflow does not promise
character-level position preservation.

## Snapshots and navigation

Initial placement is separate from continuous following. Message DOM participates
in layout but remains invisible until viewport binding, transcript loading, and
reading-anchor restoration finish. A layout effect writes the target synchronously
through the dependency's `state.scrollTop` before revealing the transcript: the
latest message on first open, or the saved reading offset on return. The library's
`scrollToBottom('instant')` still writes on a later frame and cannot provide initial
placement. Subsequent content and viewport resizing remain owned by library follow.

Snapshots use `schemaVersion: 1`:

- `following` saves intent and reopens at the current bottom.
- `reading` saves `messageId`, available global `messageIndex`,
  `offsetWithinAnchorPx`, and `viewportWidthPx`.
- Anchors are message-level; no fabricated block IDs or text-height estimates.
- Missing targets load through existing turn APIs before DOM positioning.
- Deleted targets choose the nearest loaded message index, or the first message
  without an index; they never unconditionally jump to the bottom.
- Load failure retains the original snapshot and emits diagnostics while host
  errors remain visible; it is not successful restoration.
- Empty/loading panes do not overwrite existing reading snapshots.

Positioning is finite. New navigation, reader takeover, and session switches
invalidate old operation generations; there are no delayed alignment retries.
Multiple visible turns may be active, and assistant content belongs to its owning
turn. Pagination and gap retries retain existing loaders.

The cache holds at most 50 conversations and disclosure storage at most 2000
entries. Eviction and explicit clearing also remove associated disclosure state.
Disclosure remains shared for the same conversation; active viewports and
positioning are instance-local. Restoration uses the most recently saved
conversation snapshot without moving another open pane.

## Message update scope

`MessageRow` is the message-level memo boundary. Message-bound edit, fork, and
visualization callbacks are created inside each row. The list passes stable
callbacks, default arrays, and row-specific flags so streaming the latest answer
does not execute unchanged history rows again. Default shallow comparison still
updates a row when its message, host callbacks, services, or runtime-turn metadata
changes. Message objects follow the Runtime's existing immutable update contract.

Expansion listeners subscribe by key. Writes, clearing, and capacity eviction
notify only affected keys; writing an already stored value does not notify.
An explicit first choice is persisted even if it equals the current default.
Mounted views sharing a key stay synchronized, and eviction makes them read their
own defaults again.

This reduces component execution and subscription notifications. List filtering
and traversal remain O(n). Component counts are not measurements of startup time,
CPU, memory, or physical touchpad behavior.

## Dependency patch

`@wegent/collaboration` directly pins `use-stick-to-bottom@1.1.6`.
`pnpm-workspace.yaml` registers `patches/use-stick-to-bottom@1.1.6.patch`;
the lockfile pins its hash. The fix stays in the dependency.

Integration fixtures on September 23, 2026 deterministically exposed:

- A viewport-only shrink from 300px to 200px leaving a 101px bottom gap.
- Viewport growth clamping interpreted as escaping follow.
- Content shrink resuming explicitly paused reading.
- Upward-wheel detection using the wrong property for `overflow-y: auto`.
- Replaced scrolling elements retaining old listeners.

The patch observes both elements through one handler, preserves reading intent,
distinguishes boundary clamping from input, uses `overflowY` for ownership, and
fixes ref cleanup and RAF cancellation. The upstream animation remains inside the
dependency; the product baseline uses instant following without duplicate
business-layer scrolling.

Upstream PR #43 was unmerged when checked, not a released fix. Validate candidate
releases against the same contract tests before upgrading and removing patch and
registration. Do not track main or PR branches. This records integration-time
facts rather than asserting future upstream status.

## Removed paths

Removed implementations, forwarding exports, obsolete props, and
implementation-only tests include:

- `useBottomOriginVirtualizer`, `bottomOriginScroll`;
- `streamingScrollFollow`;
- `messagePretextLayout` and virtual measurement caches;
- `assistantMarkdownWindowing`, `WindowedMarkdownChunk`, estimated placeholders;
- old message-level estimated placeholders and virtual measurement injection;
  current offscreen rendering uses measured DOM heights.

Streamdown retains controlled links, images, code, tables, visualizations, and
streaming DOM continuity. `useBufferedStreamingText` coalesces frame updates,
without a character queue behind authoritative content.
Shared collaboration removes TanStack Virtual and pretext; desktop removes pretext.
Desktop still needs TanStack Virtual for `MarketplaceCatalogView` and
`CategoryBrowseDialog`.

## Verification and limits

Unit tests use controlled geometry and ResizeObserver, not real browser layout:

| Coverage                                                                               | Entry                                                                             |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Dependency resizing, pause, cancellation, element replacement, StrictMode              | `wework/src/components/chat/useConversationFollow.test.tsx`                       |
| Initialization, DOM, disclosure, snapshots, navigation, history, external/hidden panes | `ScrollableMessageArea.test.tsx` in the same directory                            |
| Business rendering and Markdown continuity                                             | `MessageList.test.tsx`, `AssistantMarkdown.streaming.test.tsx`                    |
| Consumers, sends, scrollbar, eviction                                                  | Shared conversation, pane-session, temporary-chat, scrollbar, runtime-cache tests |
| Browser intent and delayed acceptance                                                  | `packages/collaboration/src/issue-detail/BrowserTaskComposer.test.tsx`            |

Run focused checks from the repository root:

```sh
pnpm --filter wework test src/components/chat/ScrollableMessageArea.test.tsx src/components/chat/useConversationFollow.test.tsx
pnpm --filter @wegent/collaboration test src/issue-detail/BrowserTaskComposer.test.tsx
pnpm --filter @wegent/collaboration build
pnpm --filter wework typecheck
```

E2E source now uses positive coordinates and retains long-code identity,
cancellation, and reopened-history scenarios. New assertions check every Markdown
heading stays mounted, no placeholders, and unchanged mounted-message counts
after scrolling. `rendering-extensions` runs `streaming-text.scenario.mjs`;
`window-lifecycle` covers reopening. The existing runner and
`.github/workflows/wework-e2e.yml` checkpoint matrix cover both.

### Quantified scroll regression

"Does a long conversation still scroll smoothly" now has assertable numbers. The
desktop E2E checkpoint is `conversation-scroll-performance`, and it needs all
three of these:

- **Explicit input path.** `e2e.wheelGesture` probes native wheel delivery with
  `webContents.sendInputEvent`; background windows do not reliably scroll natively.
  Comparisons use the same `scrollSteps` path: dispatch wheel intent, update the
  position, and await an animation frame per step. This measures main-thread
  rendering in real Electron, not end-to-end trackpad or compositor smoothness.
- **Real frame sampling.** `startScrollPerformanceSampling` and
  `stopScrollPerformanceSampling` record `scrollTop` per `requestAnimationFrame` and
  collect `longtask` entries through `PerformanceObserver`. Filter by actual gesture
  timestamps and stop explicitly after completion: estimating duration from step
  count and interval truncates slow gestures. Do not draw scroll
  conclusions from `startScrollStabilitySampling`: it ticks on `setInterval` and
  mixes DOM mutations into the same array, so a dropped frame and a
  MutationObserver callback are indistinguishable there.
- **Machine-independent assertions.** `assertScrollHealth` proves the gesture
  actually scrolled (`scrolledPx`) and that nothing froze for more than two
  seconds. `assertScrollScaling` runs the same gesture over the initial page and
  the fully loaded history inside one run and compares the ratio, which cancels
  out machine speed instead of writing an absolute number into CI. Set
  `WEWORK_E2E_SCROLL_P95_BUDGET_MS` when a hard budget is needed.

Metrics: `p95FrameGapMs`/`maxFrameGapMs`, `droppedFrameCount` and
`droppedFrameRatio` (intervals beyond 1.75 vsyncs), `longestScrollStallMs` (input
still arriving while the content did not move), `longTaskTotalMs`, and
`scrolledPx`.

```sh
pnpm --filter wework e2e:desktop -- --segment conversation-scroll-performance
node --test wework/e2e/desktop/modules/scroll-performance.test.mjs
```

The numbers land in that run's `perf-heavy-conversation.json`: `scroll.measurements`
holds each phase (initial page, fully loaded, downward) and
`scroll.comparison.p95Ratio` is the fully-loaded-to-initial-page frame-gap ratio.

**E2E and `ai:verify` require explicit authorization.** Initial implementation ran
unit/static checks only; the subsequently authorized real-Electron results are
recorded below. This complete verification plan is not a claim of full coverage:

1. Create long history in isolated Electron, hold output, then send. Verify the
   waiting indicator is fully visible, stable bottom error is at most 2 CSS px,
   and upward input cancels following during streaming.
2. Expand tools/thinking/subagents by mouse and Enter/Space; check trigger and DOM
   identity. Scroll immediately afterward and check stale callbacks. Legitimate
   clamping is not a pixel-lock violation.
3. Resize footers, windows, and side panels in both modes. Do not require
   character-level locking across width reflow.
4. Exercise A→B→A, missing-turn navigation, cancellation, gaps, multiple panes,
   and reopen; check stale callbacks and cross-message selection continuity.
5. Verify macOS/Windows wheel, trackpad, scrollbar, and native keys. Measure first
   display, CPU, memory, and interaction latency with 500/1000 heavy messages
   before claiming performance improvements.
6. Retain frame-position/log evidence, stop isolated instances, clean up sessions.

### September 23, 2026 implementation verification

- Wework focused regression: 18 files and 618 passing tests, including stable
  disclosure triggers as groups grow, unclipped details, remounting, and eviction.
- `BrowserTaskComposer.test.tsx`: 20 passing tests.
- Three selected `WorkbenchProvider.test.tsx` cases passed: explicit sending,
  background queue dispatch, and delayed guidance. Other cases were outside this
  focused run. Total executed: 641 tests.
- Collaboration, Wework, and frontend TypeScript checks passed.
- Comparing 49 changed TypeScript files against the branch baseline produced no
  new ESLint findings. Six pre-existing `react-refresh/only-export-components`
  errors remain in shared `ProcessingActivity`, `ToolInlineDiff`, and
  `MarkdownServices`; this is not a completely clean lint run.
- Six changed E2E modules passed Node syntax checks. E2E, `ai:verify`, Windows
  interaction, and 500/1000-message performance checks were not run.

### September 23, 2026 authorized E2E regression

Environment: macOS arm64, Node 24.18.1, Electron 43.4.1, Codex 0.155.1.
The Electron application was built from current source with real executor/Codex.
Each checkpoint isolated its application identity, home and task data;
collaboration shared core started a real local backend/Redis.
**11/11 selected checkpoints passed**, not the entire desktop E2E matrix.

Evidence directories below are under `wework/test-results/desktop-e2e/` and
retain critical screenshots and logs:

| Checkpoint                     | Passing evidence directory       |
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

PR `wecode-ai/Wegent#3697` (head `a4ed08454c1816787a6ea5333fd413ff194f29f7`)
changed one E2E file. All its added assertions now run through the existing
`rendering-extensions` checkpoint, without importing its old scrolling
implementation. Shared steps live in
`wework/e2e/desktop/modules/conversation-disclosure.mjs`:

- Opening tool details moves the trigger at most 8px and does not jump to bottom.
- A 12px upward nudge moves the trigger by 12px, within 8px.
- Scrolling away and back retains the output and `aria-expanded=true`.

`tool-detail-disclosure-metrics.json` measured **0px** opening displacement and
**12px** nudge displacement. The fixture preserves the PR's 20 trailing paragraphs
and 200 output lines, using a Node loop instead of the non-Windows `seq` command.

Failure-driven test corrections:

1. Centering the first-turn tool left `scrollTop=0`; two runs measured 0px upward
   movement. Geometry diagnostics confirmed top-boundary clamping. Start alignment
   and an explicit minimum 12px upward-range precondition preserve the original
   displacement tolerance.
2. Temporary chat and board popup assertions now use positive coordinates;
   temporary chat still checks actual bottom error. The stopped turn stays mounted
   exactly once: verify ordering and viewport geometry instead of unmounting.
3. Native keyboard input activates the window, so split-pane inactive-caret checks
   run first. Popout verification explicitly activates the main window before
   presentation to avoid the test background policy hiding the application.
4. Closing to tray preserves the renderer. A real tray activation restores it
   without replacing its identity. A separate explicit reload still verifies stale
   control-client retirement and unchanged executor identity. Evidence-directory
   wiring and the `reloadMainWindow` control command were also corrected.

This round added no product-logic patch. Five focused scroll/disclosure unit files
passed all 58 tests. The six E2E files changed this round passed Node syntax,
Prettier and ESLint checks; `git diff --check` passed. Isolated test processes
exited, and the runner removed temporary runtime artifacts while retaining evidence.

Reproduce any checkpoint from the repository root using the same command on each
platform, substituting its name from the table:

```sh
pnpm --filter wework e2e:desktop --segment rendering-extensions
```

Not covered: native Windows/Linux runs, physical trackpad feel, 500/1000-heavy-message
performance measurements, standalone `ai:verify`, or the full CI matrix. The
1200-item running-history test is functional coverage, not a performance benchmark
or an end-to-end verification of the Web browser host.

### 2026-09-28 intent and update-scope optimization

This iteration retains normal DOM and one follow engine. Controlled-geometry or
real React component tests reproduced the following before implementation:

- Non-reading touch input, consumed keyboard events, and some contenteditable
  text navigation incorrectly paused follow.
- Programmatic navigation/restoration to the physical bottom resumed following.
- A pending history navigation moved the viewport from `scrollTop=1100` back to
  `0` after the reader had already scrolled down and resumed following.
- Three updates to the final answer in 82 mounted messages executed UserMessage
  123 times and AssistantMessage 123 times. With the row memo boundary, the counts
  are 0 and 3 respectively. These are controlled component-execution counts.
- Expansion writes notified unrelated keys, including writes of existing values.

Automated coverage includes input exclusions, touch reversal, pane isolation,
initial/delayed restoration, coalesced programmatic/user scroll events, cancellation
of asynchronous navigation by three input types, fresh callbacks/metadata, edit
drafts, and expansion synchronization/eviction. New focused entries are
`ConversationPositioning.test.tsx`, `MessageList.rendering.test.tsx`, and
`processingExpansionState.test.tsx`; `ScrollableMessageArea.test.tsx` is extended.

Results: 289 distinct cases across 12 focused test files passed. Type checks passed
for collaboration, Wework, and frontend. Prettier, scoped ESLint, and
`git diff --check` passed. Shared files were checked through stdin using Wework's
ESLint rules to avoid ESLint 10 skipping files outside its base path. This is not
a repository-wide lint result.

The existing `rendering-extensions` streaming scenario now sends real DOM touch
events for jitter, horizontal movement, and movement toward the bottom while
model output is held. After releasing output, it asserts continued bottom follow.
The controller does not mock layout or modify product follow state. Synthetic
input is not physical-device acceptance.

This iteration did not execute E2E, `ai:verify`, native Windows/Linux interaction,
or large-history performance measurements. The 2026-09-23 E2E record applies to
that version and does not validate these new assertions.

## Unchanged Runtime contracts

Normalized turns still merge by executor transcript global `messageIndex`;
locally stopped turns return to their original positions. Only temporary,
unindexed turns use timestamps as secondary ordering. Provider transcripts retain
their own pagination and stable-ID deduplication, without injected stopped turns.

Idle-task goals and the first instruction still use one atomic
`runtime.tasks.send`. Codex `thread/goal/set` automatically starts the goal turn;
do not add `turn/start`. Retain existing real regressions and executor-log checks:
scrolling must not conceal duplicate turns or ordering failures.

## 2026-09-29: reading history when final output begins

Replaced shared `AssistantMessage.tsx` and `blocks/ToolBlocksDisplay.tsx` with
`AssistantTurn.tsx`, `AssistantTurnTimeline.tsx`, `assistantTimelineEntries.ts`, and
`blocks/ProcessingSegment.tsx`, retaining the public component interfaces.

Regression tests reproduced two DOM defects: the first final token unmounted visible processing
content, and a tool arriving after final text moved that text into another rendering branch.
The new timeline retains source-keyed entries and a persistent process region. Starting final
text does not automatically collapse visible processing. Subsequent user feedback changed the
default to collapse on successful turn completion, matching reopened history. Explicit disclosure
choices override the default and continue using the existing cache.

Focused message, disclosure, Markdown, scrolling, theme guard, and shared tool tests passed.
The new regression covers process/answer node continuity, late tool insertion, and paused history
reading across the first token, subsequent growth, and completion. Its position assertions use
controlled JSDOM geometry and modeled boundary clamping, not a real layout engine.

`modules/final-answer-reading.mjs` is called from the existing `streaming-text` scenario in the
CI-covered `rendering-extensions` suite. It reads real history while a model fixture changes from
thinking to incremental final output, samples historical paragraph positions, checks missing
samples and displacement, then explicitly resumes following. E2E and real Electron verification
were not run this round; elimination of the reported visual flicker remains unverified there.

## 2026-09-29: initial visible position and streaming node continuity

Follow-up investigation found two initial-placement delays: viewport binding ran
in a passive effect, and `scrollToBottom('instant')` still deferred its write to
the next frame. Binding and placement now run in layout effects, keeping real
transcript layout invisible until positioning finishes. This also covers ancestor
refs that are not yet assigned and asynchronous reading-anchor loads. Continuous
following remains owned by the dependency. A failed restoration reveals content
without overwriting the original reading snapshot.

The code-node replacement originated in timeline projection. `AssistantTurn`
removed trailing whitespace and plugin result markers, while projection compared
unprocessed source text. A chunk ending in whitespace switched branches and keys,
remounting the answer and its code nodes. Comparison and rendering now use the
same text cleanup while preserving source keys. Syntax highlighting and the
existing code-node identity assertion remain unchanged.

Focused cases cover internal/external viewport placement before any animation
frame, delayed transcript and reading-anchor loads, failed restoration, and stable
answer/process/code nodes across whitespace at chunk boundaries. The real Electron
regression is registered in `rendering-extensions`: finish a long code response,
switch to an empty conversation, reload to clear in-memory viewport records, and
start frame sampling before opening the original task. Every visible frame must
show the latest position; scrolling up and reopening must restore the reading
position. The subsequent history-reading regression checks the complete answer
paragraph by paragraph, avoiding a comparison of Markdown blank lines against DOM
`textContent`.

Validation: 93 cases across eight focused test files passed, along with TypeScript,
changed-file ESLint, and formatting checks. The complete `rendering-extensions`
checkpoint passed in 4m 22s using isolated Electron on macOS arm64, a real local
backend/executor/Codex, and only model services mocked. All 170 visible first-open
frames and 159 reading-restoration frames were at their target positions. The
original long-code identity assertion, history reading, tool disclosure, stopped
turn ordering, and subagent scenarios all passed. Evidence:
`wework/test-results/desktop-e2e/2026-09-29T08-17-42-607Z-80609`.
Debugging also corrected the new test's desktop-specific selector and the history
test's paragraph-text assertion. Earlier failure artifacts were retained; no
assertions were skipped and failures were not hidden by unchanged retries.
Standalone `ai:verify` and Windows/Linux verification were not run.

## 2026-09-29: default processing collapse on completion

Fixed the mismatch between an expanded live completion and collapsed reopened
history. The default no longer captures `canCollapse` at mount: it stays expanded
until the message succeeds and its active turn finishes, then defaults to collapsed.
The shared store continues to record only explicit user choices, which completion
cannot overwrite. Collapse stays in the fixed processing prefix without replacing
answer nodes.

Regression cases cover the first final token, growth, completion, reopening, and
explicit expand/collapse choices. Real Electron coverage separately samples stream
growth and completion collapse. The model fixture holds completion after emitting
all answer text, allowing the test to inspect each lifecycle phase. Both samples
require the historical paragraph to remain present and stationary; completion must
also shrink the process region and retain answer node identity. Genuine reductions
in the available scroll range may still clamp natively, without blank placeholders
or another height-compensation engine.

Validation passed: 272 cases in eight focused test files, TypeScript, ESLint, and
formatting. The complete macOS arm64 isolated-Electron `rendering-extensions`
checkpoint passed in 4m 18s, including automatic collapse, explicit expansion,
reopening both states, history position during streaming/completion, and answer
node continuity. Long-code, initial-position, tool-order, and subagent coverage
also passed. The tool-order fixture now waits for completion's collapsed default
before explicitly expanding, rather than treating final text as turn completion.
Evidence: `wework/test-results/desktop-e2e/2026-09-29T08-35-44-387Z-81860`.
