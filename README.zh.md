# web-search-bailian

为 DeepSeek Harness 的 web 能力 seam(`ctx.web`)提供阿里云百炼(Model Studio)内置联网搜索的
`WebSearchProvider`。让你**用已有的百炼 API Key** 就能给 `web_search` 工具接上真实、可引用的搜索
结果——不需要单独的搜索服务订阅,也不需要 DeepSeek 的 key。

本包派生自官方 `@deepseek-ai/dsh-web-search-deepseek`:凭据解析、"一次操作一份配置快照"规则、
取消语义、错误分类与严格模式全部原样保留,**只替换线格式(wire format)层**。

## 为什么选 DashScope 原生协议

百炼的内置联网搜索有四种调用方式,能力并不对等:

| 能力 | DashScope 原生 | OpenAI Chat Completions | OpenAI Responses | Anthropic 兼容 |
| --- | --- | --- | --- | --- |
| 返回搜索来源 | 支持 | **不支持** | **不支持** | 支持 |
| 可解析的角标引用 | 支持 | **不支持** | **不支持** | 支持 |
| 强制联网搜索 | 支持 | 支持 | **不支持** | 不适用 |
| 搜索策略/时效性/限定站点 | 支持 | 支持 | **不支持** | 不适用 |
| 无需 workspace id 即可访问 | 是 | 是 | 是 | **否** |

Anthropic 兼容正是官方 DeepSeek 提供方所用的协议,百炼在那一层也确实实现了
`web_search_20250305`——**但只在** `https://{WorkspaceId}.{region}.maas.aliyuncs.com/apps/anthropic`
上。不属于该业务空间的 key 会被 `Endpoint.AccessDenied` 拒绝;而不带 workspace 的
`dashscope.aliyuncs.com/apps/anthropic` 会接受工具声明然后**静默忽略**它,返回 0 个
`web_search_tool_result` 块。

Chat Completions 会返回 `[ref_1]` 这类角标但没有来源列表,角标因此是**悬空**的。Responses 能从
`action.sources` 拿到 URL,但没有标题、没有角标,也**无法强制搜索**——而百炼明确说明英文输入可能
根本不触发检索。

所以只有 DashScope 原生协议能满足这个 seam:它返回带标题和 URL 的
`output.search_info.search_results`,支持 `forced_search`,并用 `usage.plugins.search` 作为
"确实检索过"的凭据。

## 需要知道的行为

- **端点由模型推导。** 百炼把多模态模型(`qwen3.8-*`、`qwen3.7-plus|flash`、`qwen3.6-*`、
  `qwen3.5-*`、VL 与 Omni 系列)放在 `multimodal-generation` 端点上;用 `text-generation` 调它们会
  报 `400 url error, please check url`。本提供方自动选对端点,因此你只需要配 `model`。
- **查询会被包装成带日期的中文指令。** 百炼文档说明英文输入可能不触发检索,而没有时钟的模型会把
  "明天"这类相对日期算错。这两个问题都在提供方边界上解决,不丢给调用方。
- **始终强制检索。** 每次都发送 `forced_search: true`:seam 要的就是搜索,凭记忆作答属于失败,
  不是可接受的结果。
- **严格模式。** 响应里没有 `search_info.search_results` 时抛 `WEB_PROVIDER_ERROR`,而不是退化成
  从正文里刮 URL。错误信息会点名两个文档记载的成因:账号级 **15 RPS** 限流(它会**不报错**地跳过
  检索链路),以及只支持 Responses API 联网搜索的模型。
- **不提供 snippet 与发布时间。** 该协议下百炼两者都不返回,而 seam 的 `snippet`/`publishedAt`
  本身是可选字段,因此不做编造。`dsh-tool-web` 渲染时用 `title ?? hostname(url)` 兜底。

## 配置

Settings 命名空间 `web-search-bailian`:

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `apiKey` | — | 字面量密钥。secret 角色;优先用 `apiKeyEnv`。 |
| `apiKeyEnv` | `DASHSCOPE_API_KEY` | 凭据引用,每次搜索解析一次。在 Web 的 Models 页存储或轮换的密钥无需重启即用于下一次调用。 |
| `baseURL` | `https://dashscope.aliyuncs.com` | 端点**源(origin)**。其路径会被忽略,操作路径按模型追加。带 workspace 的 `maas.aliyuncs.com` 源同样可用。 |
| `model` | `qwen3.8-max` | 必须是支持 DashScope 原生协议内置搜索的模型。 |
| `searchStrategy` | `turbo` | `turbo` \| `max` \| `agent`。Qwen3.8 系列不接受 `agent`。 |

**选中**这个提供方与**安装**它是两件事。当可用提供方多于一个且没有显式配置时,`ctx.web` 会抛
`WEB_PROVIDER_AMBIGUOUS`;而官方 DeepSeek 提供方即使没配 key 也会报告自己可用。所以必须显式选一个
——在 profile 的 `cordis.patch.yml` 里:

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: bailian
```

或在启动环境里设 `DSH_WEB_SEARCH_PROVIDER=bailian`。

## 费用

百炼对内置联网搜索单独计费,且**不提供免费额度**。华北2(北京)地域每 1000 次检索:`turbo` 3 元、
`max` 4 元、`agent` 4 元。检索到的网页内容会拼进提示词,因此输入 token 会远高于问题本身——实测单次
搜索约 3.3k 输入 token。限流为每阿里云主账号 15 RPS,所有 API Key 与模型合并计算。

## 相对官方提供方的有意偏离

- **不写会话遥测。** 官方提供方会把精确请求追加到一个由 typert 声明固定 envelope 的会话事件上,且
  该处抛错按设计会阻止派发。本包不拥有这类事件,因此 `recordRequest` 保留在 options 接口里但
  `apply` 不予接线——不确定的 schema 不该有能力让一次搜索失败。
- **没有 invariant 伴生插件。** 官方那个注册的是空 installer;遥测不接线后也没有可供关联的对象。
- **去掉 `maxTokens`/`maxUses`/`apiVersion`,新增 `searchStrategy`。** 前三者是 Anthropic Messages
  的概念,在 DashScope 上没有对应物;策略档位才是本协议上等价的成本/质量旋钮。

## 开发

```sh
npm install
npm run typecheck
npm test
npm run build     # tsc -> lib/types,再由 tsdown -> lib/index.js
```

## 许可

MIT
