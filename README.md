# dsh-session-media

> DeepSeek Harness 的**会话档案层**：让模型在任意新会话里，知道这个项目之前发生过什么——包括那些会话里带的图片和文档。

## 它解决什么

新会话默认是失忆的。这个插件补三件事：

| 能力 | 说明 |
|---|---|
| **自动记忆** | 每个工作区一份 Markdown，每轮注入系统提示。改文件下一轮就生效，不用重启 |
| **历史检索** | 跨所有会话搜你和我**双方**说过的话，支持多关键词 AND 与时间范围 |
| **附件取出** | 列出某个会话里的图片/文档，给出本地原始路径，可批量导出 |

## 与已有插件的关系

**不是竞争品，是补位。**

| 插件 | 覆盖 | 本插件 |
|---|---|---|
| `dsh-memory` | 事实记忆（SQLite FTS5） | ❌ 不做 |
| `dsh-session-recall` | 会话检索（官方 `ctx.sessionQuery` + FTS5，毫秒级） | ❌ 不追 |
| **本插件** | 附件检索 + 记忆自动注入 | ✅ 独占 |

检索引擎是本插件最弱的一环（关键词线性扫描，冷启约 12 秒）。**如果你要的是高性能检索，装 `dsh-session-recall`；如果你要的是"把会话里的图捞出来"，用这个。**

## 工具

| 工具 | 作用 |
|---|---|
| `session_search(keyword, limit?, sinceDays?)` | 跨会话检索。空格分隔多个词表示 AND |
| `session_read(sessionId, maxChars?)` | 读某会话全文 |
| `session_media(sessionId?, kind?, sinceDays?, limit?, extractTo?)` | 列出附件；`extractTo` 可复制原始文件到目录 |
| `memory_doctor(top?, fix?)` | 体检：索引版本/条数/体积/高频会话/附件统计/告警；`fix` 可清理并重建 |

外加一个系统提示段 `plugin:memory`（order 210）。

## 安装

本插件没有走市场，手工接入（与 `dsh-agent-picker` 同法）：

1. 放进任意目录，例如 `C:\AgentTools\plugins\dsh-session-media`
2. 在 `profiles/web/package.json` 的 `dependencies` 加
   ```json
   "dsh-session-media": "file:C:/AgentTools/plugins/dsh-session-media"
   ```
3. 同一个文件的 `dsh.profile.bundles` 末尾加 `"dsh-session-media"`
4. 在 `profiles/web` 下跑 `pnpm install`
5. 重启 DSH Desktop

> `file:` 依赖是**拷贝**不是软链：改完源码要重新 install，或直接覆盖 `profiles/web/node_modules/<包名>/index.js`。
> **HMR 不换已加载模块**，改代码必须重启。

## 配置

全部可选，默认零配置可用。

| 键 | 默认 | 含义 |
|---|---|---|
| `memoryDir` | 自动探测 | 记忆文件所在目录 |
| `files` | `[]` | 显式指定记忆文件；空则用 `candidateFiles` |
| `candidateFiles` | `['环境笔记.md','MEMORY.md','CLAUDE.md']` | 依次尝试 |
| `order` | `210` | 提示段顺序 |
| `maxChars` | `12000` | 注入上限，超出按「保头 60% + 保尾 40%」截断 |
| `cacheMaxEntries` | `5000` | 索引缓存条数上限 |
| `cacheMaxChars` | `50000000` | 索引缓存字符上限 |
| `evictMinAgeDays` | `90` | 淘汰起始年龄门槛 |
| `evictFloorDays` | `14` | 门槛下限（降到这还无解就**不淘汰**） |
| `saveIntervalMs` | `60000` | 索引落盘节流 |

## 限制（请先读这段）

1. **只用关键词检索**，没有语义/向量能力。
2. **依赖会话存档格式**（`session.v3/v4.jsonl.zstd`，多帧 zstd 拼接）。遇到未知版本会跳过并告警，但**不会自动适配**。
3. **不处理图片内容**——只给路径，理解靠模型自己看。
4. **索引写入前会脱敏**：疑似凭据（`sk-`、`ghp_`、`npm_`、`AKIA` 等前缀，以及 `token=` / `password:` 形式）会打码。但这是尽力而为，不能替代你自己确认工作区里没有敏感信息。
5. 中文优先。界面文案与提示为中文。

## 测试

```bash
node cismoke.mjs            # CI 冒烟：不依赖真实会话，8 项
node selftest.mjs           # 本机完整：17 项，含淘汰策略与媒体路径校验
node selftest.mjs --no-evict  # 跳过会临时改写索引的淘汰用例
```

`selftest.mjs` 需要本机已有会话存档，适合开发时跑；`cismoke.mjs` 适合 CI。

## 发布说明

npm 上 `dsh-memory` 与 `dsh-session-recall` **都已被占用**。公开发布请改名为 `dsh-session-media`（已确认可用），需同步修改三处：

1. `package.json` 的 `name`
2. `cordis.patch.yml` 的 `id` / `name`
3. `profiles/web/package.json` 的依赖键与 `dsh.profile.bundles`

## 许可

MIT