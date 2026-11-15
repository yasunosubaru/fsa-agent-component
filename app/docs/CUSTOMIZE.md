# AgentDeck 定制指南

这份文档说明如何给三个 agent 做定制：加 MCP 服务、加技能、加指令文件。
所有内容都在应用内可查，不需要外部链接。

---

## 一、能定制什么

AgentDeck 里的三个 agent 都通过 **MCP（Model Context Protocol）** 扩展。
这是它们共有的、官方支持的接口，所以定制的第一入口就是 MCP。

| 目标 | 配置文件 | 格式 | 应用能否代写 |
|---|---|---|---|
| Claude Code | `%LOCALAPPDATA%\Claude-3p\claude_desktop_config.json` | JSON，`mcpServers` 对象 | ✅ 可以（会先备份） |
| Codex | `%USERPROFILE%\.codex\config.toml` | TOML，`[mcp_servers.<名字>]` 表 | ❌ 只给文本 |
| OpenCode | `%USERPROFILE%\.config\opencode\opencode.jsonc` | JSONC，`mcp.servers.<名字>` | ❌ 只给文本 |
| 沙盒内 agents | `%LOCALAPPDATA%\DockerSandboxes\sandboxes\state\agent-skills` | 目录，每个技能一个文件夹 | ❌ 只给文本 |

为什么只有 Claude 能代写：

- **Codex 的 `config.toml` 由 Codex 自己维护**。往别的程序拥有的文件里追加内容，出问题时很难查。
- **OpenCode 的配置是 JSONC，带手写注释**。程序化改写会静默删掉那些注释。
- **技能目录是文件结构**，不是配置文件。

后面三个应用只给出应该写的文本，由你决定怎么放进去。

最后一行是关键：沙盒把这个目录**只读挂载**到每个 agent kit 的 skills 路径，
所以放一份技能，三个 agent 在沙盒里都能看到。

---

## 二、最小可用的 MCP 定义

一个 MCP 服务需要四个字段：

```json
{
  "name": "workspace-files",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "${WORKSPACE}"],
  "env": {}
}
```

- `transport` 用 `stdio`。三种配置格式都支持它，而 HTTP/SSE 的支持程度各家不同。
-  `${WORKSPACE}` 和 `${USER_HOME}` 会被自动替换成真实路径。
- `env` 用来传密钥等环境变量，不要写进 `args`（会出现在进程列表里）。

上面的例子用的是官方 `server-filesystem`，它不需要密钥、不需要网络，
所以第一次就能跑通 —— 模板跑不通就学不到东西。

---

## 三、四个目标各自长什么样

同一个定义，写进四个地方会长成不同形状。这一节就是对照表。

### Claude Code

```json
{
  "mcpServers": {
    "workspace-files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\work"]
    }
  }
}
```

### Codex

```toml
[mcp_servers.workspace-files]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "C:\\work"]
```

Codex 还支持另外两层扩展，按需使用：

```toml
[marketplaces.my-plugins]
source_type = "local"
source = 'C:\path\to\my-plugins'

[plugins."my-plugin@my-plugins"]
enabled = true
```

`marketplaces` 声明插件来源，`plugins` 逐个开关。这两层比 MCP 更重，
适合要打包一整套工具的场景。

### OpenCode

```jsonc
{
  "mcp": {
    "servers": {
      "workspace-files": {
        "type": "local",
        "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "C:\\work"],
        "disabled": false
      }
    }
  }
}
```

三个注意点，都是实测出来的：

- 多一层 `servers`：是 `mcp.servers.<名字>`，不是 `mcp.<名字>`。
- 开关叫 `disabled: false`，不是 `enabled: true`。
- 文件是 `.jsonc` 而不是 `.json`，里面可能有手写注释，改的时候别用会自动重排格式的工具。

### 沙盒内（三个 agent 共用）

放一份技能目录，沙盒会挂给每个 agent：

```
agent-skills/
  my-skill/
    SKILL.md
```

`SKILL.md` 的结构：

```markdown
---
name: my-skill
description: 什么时候该用这个技能（这句话决定 agent 会不会触发它）
---

# my-skill

写清楚三件事：
1. 触发条件 —— 什么情况下用
2. 步骤 —— 具体怎么做
3. 约束 —— 什么不能做
```

`description` 是最重要的一行：agent 靠它判断该不该用这个技能。
写得含糊，技能就永远不会被触发。

---

## 四、为特定工作定制

把上面的机制组合起来，就是「为某种工作定制」。

### 例一：给数据分析工作定制

1. **MCP 服务**：加一个能读写数据目录的文件服务
2. **技能**：写 `data-analysis/SKILL.md`，规定"先看数据形状再做统计"
3. **指令文件**：在工作目录放 `AGENTS.md`（OpenCode 读）或 `CLAUDE.md`（Claude Code 读）

### 例二：给某个业务系统定制

1. **MCP 服务**：写一个自己实现的 MCP server，封装业务 API
2. **环境变量**：密钥走 `env` 字段
3. **技能**：把业务流程写成技能文档

自建 MCP server 的模式（Node.js，最小可运行）：

```js
#!/usr/bin/env node
// 一个只暴露一个工具的 MCP server。
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const server = new Server(
  { name: 'my-business', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler('tools/list', async () => ({
  tools: [{
    name: 'lookup_order',
    description: '按订单号查询状态',
    inputSchema: {
      type: 'object',
      properties: { order_id: { type: 'string' } },
      required: ['order_id'],
    },
  }],
}));

server.setRequestHandler('tools/call', async (req) => {
  if (req.params.name !== 'lookup_order') throw new Error('unknown tool');
  const { order_id } = req.params.arguments;
  // 这里换成真实调用。密钥从 env 读，不要硬编码。
  return { content: [{ type: 'text', text: `order ${order_id}: ok` }] };
});

await server.connect(new StdioServerTransport());
```

装好依赖后，在 MCP 定义里把 `command` 指向这个脚本即可。

---

## 五、安全边界

定制能力越强，越要注意这几点：

1. **MCP server 拿到的是完整文件权限**。
   官方 `server-filesystem` 只认你传给它的目录，但自建 server 不受此限制。
   给它最小够用的目录，不要传盘符根目录。

2. **密钥走 `env`，不要走 `args`**。
   `args` 会出现在进程列表和日志里；`env` 不会。

3. **沙盒内的技能目录是只读的**。
   这是刻意的：agent 不能改自己的技能定义。

4. **改配置前会自动备份**。
   应用写 JSON 配置时会在同目录留一份带时间戳的 `.bak-` 副本。
   需要回滚就把它改回来。

5. **TOML 和技能目录不自动写入**。
   Codex 的 `config.toml` 由 Codex 自己维护，技能目录是纯文件结构。
   应用对这两个目标只给出应该写的文本，由你决定放进去。
   理由是：往别的程序拥有的文件里追加内容，出问题时很难查。

---

## 六、命令在哪执行

这份文档的定制项分两层：

- **配置层**（MCP、技能、指令文件）：在宿主机生效，agent 启动时读取。
- **执行层**（agent 真正跑的命令）：可以放进沙盒。

沙盒页面的「命令执行记录」显示的每一条，都带执行凭证：
内核版本、PID 命名空间、网络命名空间、Windows 盘是否可见、运行用户。
凭证对不上就说明那条命令没在沙盒里跑 —— 这是可验证的，不是声明。

沙盒页面还有「沙盒内实时进程」：直接读内核的 `/proc`，每 2.5 秒刷新一次。
里面能看到 `dockerd`、`containerd`、以及 agent 正在跑的命令。
这些进程只存在于微虚拟机内，宿主的任务管理器里找不到它们 —— 这本身就是隔离的证据。
所以「暂停」按钮在两个意义上都必要：省沙盒的 CPU，也让你能看清某一瞬间的真实状态。

要把 agent 放进沙盒，用沙盒页面的「在沙盒中运行 agent」：
每个 agent 有自己的沙盒（`agent-claude` / `agent-codex` / `agent-opencode`），
镜像由 Docker Sandboxes 的官方 kit 提供。

---

## 七、检查清单

加完定制后，按这个顺序确认：

- [ ] 配置文件是合法 JSON/TOML（应用写入时会校验，手动改时要自己确认）
- [ ] `description` 写清楚了触发条件，不是一句"这个技能很有用"
- [ ] 密钥在 `env` 里，不在 `args` 里
- [ ] 传给文件服务的目录是最小范围，不是盘符根
- [ ] 在 agent 里试一次，确认它真的调用了新加的能力
- [ ] 需要回滚时，找同目录的 `.bak-` 文件
