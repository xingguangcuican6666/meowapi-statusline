# meowapi-statusline

在 Claude Code 状态栏显示订阅额度用量（5h / 7d），供 **API-key / 自建网关** 会话使用。

```
5h ▰▰▱▱▱ 42% ↻4h43m │ 7d ▱▱▱▱▱ 6% ↻6d23h
```

## 为什么需要它

Claude Code 只在 **claude.ai 订阅登录**（token 带 `user:inference` scope）时才解析
`anthropic-ratelimit-unified-*` 响应头并画出原生额度条。用 `ANTHROPIC_AUTH_TOKEN` /
`ANTHROPIC_API_KEY` 指向自建网关的会话被硬门槛挡在外面，永远看不到额度。

`statusLine` 是用户级配置、不受订阅状态限制，所以本包从网关的
`GET /api/oauth/usage` 读取同一份快照，自己画。

## 安装

```bash
# 方式一：npx，无需预装
# settings.json 里把 command 写成：npx -y meowapi-statusline

# 方式二：全局安装
npm i -g meowapi-statusline

# 方式三：不经过 registry
npm pack && npm i -g ./meowapi-statusline-1.0.0.tgz
```

要求 Node.js **≥ 18.17**（使用内置 `fetch` 与 `AbortSignal.timeout`，无第三方依赖）。

## 配置

把 `meowapi-statusline --print-config` 的输出合进 `~/.claude/settings.json`：

```json
{
  "statusLine": {
    "type": "command",
    "command": "meowapi-statusline",
    "padding": 0,
    "refreshInterval": 20
  }
}
```

`refreshInterval` 单位是秒，最小 1。默认 20 与脚本的 18s 请求超时错开，避免上一轮
还没结束下一轮又起。

### 凭据

按顺序查找，取第一个有值的：

| 项 | 来源 |
| --- | --- |
| base URL | `CC_QUOTA_BASE_URL` → `ANTHROPIC_BASE_URL` → `~/.claude/settings.json` 的 `env` |
| token | `CC_QUOTA_TOKEN` → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → 同上 `env` |

之所以回退读 `settings.json`：状态栏子进程不保证继承启动 REPL 时的环境变量。

base URL 末尾带不带 `/api` 都能识别：

| 输入 | 请求地址 |
| --- | --- |
| `https://gw.example.com` | `https://gw.example.com/api/oauth/usage` |
| `https://gw.example.com/api` | `https://gw.example.com/api/oauth/usage` |

## 行为

- **失败冻结，不清空。** Claude Code 会用子进程 stdout 整条替换状态栏，空串也算新结果。
  所以请求失败时回放上一次成功的行，让数字静止而不是消失。
- **成功缓存 20s，失败缓存 5s。** 失败后下一轮就重试，不会贴上过期值一分钟。
- **超时 18s。** 经 Cloudflare 的冷请求实测 2.4s，更紧的超时会把正常延迟变成随机丢条。
- **任何异常都 exit 0 且不写 stderr。** 状态栏不能成为对话失败的原因。

## 数据格式

`GET /api/oauth/usage` 返回 Anthropic `/usage` 的形状：

```json
{
  "five_hour":  { "utilization": 42.5, "resets_at": 1794865740 },
  "seven_day":  { "utilization": 6.36, "resets_at": 1795433010 }
}
```

- `utilization` 是 0–100 百分比。为了兼容按 Anthropic 原始口径返回 0–1 小数的代理，
  值 ≤ 1 且 > 0 时按小数处理。
- `resets_at` 是 unix 秒。只有当它落在窗口长度**之内**时才会显示倒计时：滚动窗口的
  网关每次请求都会把锚点往后推，于是 `resets_at` 恒等于「现在 + 一整个窗口」，
  那个数字永远不会减小。这种值会被判定为窗口长度而非重置时刻，直接不显示转换。
- 可选字段 `seven_day_opus` / `seven_day_sonnet` 存在时额外画独立条。

## 开发

```bash
node --test test/          # 11 个用例，覆盖冻结路径与单位换算
node bin/cli.js --print-config
```

## 许可

AGPL-3.0-or-later，见 [LICENSE](LICENSE)。