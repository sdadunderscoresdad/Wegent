---
sidebar_position: 22
---

# 本地数据目录

Wework 的本地运行时数据统一存放在用户主目录下的 `~/.wework`，不再使用
`~/.wecode/wegent-executor` 或 `~/.wegent-executor`。

## 目录结构

默认 Executor Home 为 `~/.wework`，主要内容包括：

- `codex/`：Wework 独立的 Codex home（可通过 `WEGENT_CODEX_HOME` 覆盖）。
- `workspace/projects/`、`workspace/worktrees/`：本地项目与托管工作树。
- `workspace/chats/`：本地任务会话。
- `workspace/attachments/draft/`：本地附件草稿。
- `capabilities/bundled-marketplaces/`：内置插件市场缓存。
- `logs/`：Executor 日志（例如 `logs/executor.log`）。
- `runtime/`：运行时桥接等进程内状态。
- `device-config.json`、`device_id`：本机设备标识。

`WEGENT_EXECUTOR_HOME` 环境变量可以覆盖默认 Executor Home。显式设置该变量时，
适用于隔离会话、测试和自定义部署。

## Codex Home 迁移的判定

迁移旧 Codex Home 到工作台目录前，工作台会通过 Executor 的
`--workbench-codex-migration-check` 做一次只读判定，确认搬移不会让已保存的凭证失效。
Codex 的 keyring 账号由 Codex Home 的规范路径派生，路径变化会让这些凭证无法解密：

- 只有可确认的证据才阻止搬移：`secrets/` 下的加密凭证文件存在、配置显式使用
  keyring 登录存储，或配置了 `ema-idp:` 企业身份。这类 Home 保持原路径，不参与迁移。
- 配置未设置时按 Codex 默认值处理（登录凭证保存在 Home 内的文件里），不再按平台默认值
  推断，因此 Windows 与 macOS 的判定结果一致。
- 读取元数据或配置失败只记录为告警，不再作为阻止搬移的理由。检查结果同时返回
  `reasons`、`warnings` 和可读的 `reason`、`warning`，桌面把判定结果写入启动日志。

判定为不可迁移时，桌面仍然正常启动：这台机器的 Codex Home 保持原路径，
`WEGENT_CODEX_HOME` 指向旧路径，其余数据（Executor Home、capabilities、Claude Home、
workspace）照常迁移到工作台目录，下一次启动会重新判定。

迁移旧 Codex Home 时，相对符号链接扫描使用目录枚举提供的类型信息，
只递归目录并校验符号链接，不额外读取普通文件的元数据。因此，后台 Git 操作在枚举
后删除临时锁文件不会阻止启动；无法解析的相对符号链接仍会阻止迁移。

## 自动清理与保留策略

Wework 启动后会立即在后台执行一次存储维护，之后每 30 分钟重复执行。维护过程只处理
Wework 明确拥有的临时数据，不会按时间删除用户项目或仍需恢复的托管工作树：

- `app-runtime/wework-<pid>-<timestamp>/`：隔离 Executor 实例超过 14 天且确认不活跃后
  删除。持有 `.instance.lock` 的实例始终保留；兼容旧版本无锁目录时，还会检查目录名中的
  PID，避免删除仍在运行的实例。旧版 `wework-dev-*` 目录遵循相同规则。
- `logs/` 中超过 14 天的日志，以及反馈暂存和内置浏览器临时目录中超过 24 小时的文件，
  会按批次清理；当前进程日志和符号链接不会删除。
- `codex/.tmp/marketplaces/.staging/` 中超过 7 天的
  `marketplace-add-*`、`marketplace-upgrade-*` 中间目录会删除。该规则同时覆盖
  `~/.wework/codex` 和 `~/.wework/apps/<namespace>/codex`，不会删除已安装的
  marketplace。

`workspace/worktrees/` 是任务数据，不属于临时缓存。其清理由归档任务和 Worktree 保留
设置驱动，并在删除前保存 Git 快照；存储维护线程不会直接删除这些目录。
