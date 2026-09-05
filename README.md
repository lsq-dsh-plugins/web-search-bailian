# web-search-bailian

An Alibaba Cloud Model Studio (Bailian) backed `WebSearchProvider` for the DeepSeek
Harness web capability seam (`ctx.web`). It gives the `web_search` tool real, citeable
results using a Bailian/DashScope API key you already have — no separate search
subscription and no DeepSeek key.

Derived from the official `@deepseek-ai/dsh-web-search-deepseek`: credential
resolution, the one-snapshot-per-operation rule, cancellation, error classification,
and strict mode are carried over unchanged. Only the wire format differs.

## Why the DashScope native protocol

Bailian exposes built-in web search over four protocols. They are not equivalent:

| Capability | DashScope native | OpenAI Chat Completions | OpenAI Responses | Anthropic compatible |
| --- | --- | --- | --- | --- |
| Return search sources | yes | **no** | **no** | yes |
| Citation markers that resolve | yes | **no** | **no** | yes |
| Force a search | yes | yes | **no** | n/a |
| Search strategy / freshness / site filters | yes | yes | **no** | n/a |
| Endpoint reachable without a workspace id | yes | yes | yes | **no** |

The Anthropic-compatible protocol is the one the official DeepSeek provider speaks, and
Bailian does implement `web_search_20250305` there — but only on
`https://{WorkspaceId}.{region}.maas.aliyuncs.com/apps/anthropic`. A key that does not
belong to that workspace is rejected with `Endpoint.AccessDenied`, and the
workspace-less `dashscope.aliyuncs.com/apps/anthropic` host accepts the tool declaration
and then silently ignores it, returning zero `web_search_tool_result` blocks.

Chat Completions returns citation markers such as `[ref_1]` with no source list, so the
markers are dangling. Responses returns `action.sources` URLs but no titles, no
citation markers, and cannot force a search — which matters because Bailian documents
that English input may not trigger a search at all.

DashScope native is therefore the only protocol that satisfies the seam: it returns
`output.search_info.search_results` with titles and URLs, supports `forced_search`, and
reports `usage.plugins.search` as proof a search ran.

## Behaviour worth knowing

- **Endpoint is derived from the model.** Bailian serves multimodal-capable models
  (`qwen3.8-*`, `qwen3.7-plus|flash`, `qwen3.6-*`, `qwen3.5-*`, VL and Omni) on
  `multimodal-generation`; calling them on `text-generation` fails with
  `400 url error, please check url`. The provider picks the right one, so `model` is the
  only thing to configure.
- **Queries are wrapped in a dated Chinese instruction.** Bailian documents that
  English input may not trigger a search, and models with no clock mis-resolve relative
  dates ("tomorrow"). Both are fixed at the provider boundary rather than left to the
  caller.
- **Searches are forced.** `forced_search: true` is always sent: the seam asked for a
  search, so a memory-only answer is a failure, not an acceptable outcome.
- **Strict mode.** A response with no `search_info.search_results` throws
  `WEB_PROVIDER_ERROR` instead of degrading to prose scraping. The message names the two
  documented causes: the account-level **15 RPS** throttle, which skips the search chain
  *without* returning an error, and models that support search only via Responses API.
- **No snippet or publication date.** Bailian returns neither on this protocol, and the
  seam's `snippet`/`publishedAt` are optional, so nothing is invented. `dsh-tool-web`
  renders `title ?? hostname(url)`.

## Configuration

Settings namespace `web-search-bailian`:

| Key | Default | Notes |
| --- | --- | --- |
| `apiKey` | — | Literal key. Secret role; prefer `apiKeyEnv`. |
| `apiKeyEnv` | `DASHSCOPE_API_KEY` | Credential reference, resolved per search. A key stored or rotated in the web Models page is used for the next call without a restart. |
| `baseURL` | `https://dashscope.aliyuncs.com` | Endpoint **origin**. Any path is ignored; the operation path is appended per model. A workspace-scoped `maas.aliyuncs.com` origin works too. |
| `model` | `qwen3.8-max` | Must support built-in search on the DashScope native protocol. |
| `searchStrategy` | `turbo` | `turbo` \| `max` \| `agent`. Qwen3.8-series models reject `agent`. |

Selecting this provider is separate from installing it. `ctx.web` throws
`WEB_PROVIDER_AMBIGUOUS` when more than one provider is usable and none is configured,
and the official DeepSeek provider reports itself available even without a key. So pick
one explicitly — in the profile's `cordis.patch.yml`:

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: bailian
```

or with `DSH_WEB_SEARCH_PROVIDER=bailian` in the launching environment.

## Cost

Bailian bills built-in search separately from model tokens, and offers no free quota for
it. Per 1000 searches in the Beijing region: `turbo` ¥3, `max` ¥4, `agent` ¥4. Retrieved
page content is concatenated into the prompt, so input tokens rise well above the
question's own length — a single search measured roughly 3.3k input tokens. Rate limit is
15 RPS per Alibaba Cloud account, summed across every API key and model.

## Deliberate deviations from the provider it derives from

- **No session telemetry.** The official provider appends its exact request to a session
  event whose envelope is pinned by a typert declaration, and a throw there prevents
  dispatch by design. This package owns no such event, so `recordRequest` stays in the
  options interface but is not wired by `apply` — an uncertain schema must not be able to
  fail a search.
- **No invariant companion.** The official one registers an empty installer; there is
  nothing to relate a pre-dispatch event to once telemetry is unwired.
- **`maxTokens`/`maxUses`/`apiVersion` dropped, `searchStrategy` added.** The first three
  are Anthropic Messages concepts with no DashScope counterpart; the strategy tier is the
  equivalent cost/quality dial on this protocol.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build     # tsc -> lib/types, then tsdown -> lib/index.js
```

## License

MIT
