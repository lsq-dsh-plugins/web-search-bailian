import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import WebRuntime from '@deepseek-ai/dsh-web'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import * as bailianPlugin from '../src/index.ts'
import {
  BailianSearchProvider,
  BAILIAN_PROVIDER_ID,
  bailianSearchEndpoint,
  buildSearchPrompt,
  dashScopeContentText,
  isMultimodalModel,
  mapDashScopeResponse,
  todayIsoDate,
} from '../src/provider.ts'
import type { BailianSearchProviderOptions } from '../src/provider.ts'
import type { DashScopeResponse } from '../src/types.ts'

/** Minimal in-memory SettingsProvider so plugin tests get ctx.settings without a file. */
class InMemorySettings extends SettingsProvider {
  readonly writable = true
  private doc: Record<string, unknown> = {}
  protected async load() { return this.doc }
  protected async persist(_ns: string, section: Record<string, unknown>) { this.doc[_ns] = section }
}

/** Construct the provider over a fixed options value; production passes a live thunk. */
const searchProvider = (options: BailianSearchProviderOptions): BailianSearchProvider =>
  new BailianSearchProvider(() => options)

const options: BailianSearchProviderOptions = {
  apiKey: 'bl-key',
  baseURL: 'https://dashscope.test',
  model: 'qwen3.8-max',
  searchStrategy: 'turbo',
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

/** A response carrying two sources and a cited answer, as the native protocol returns. */
function searchResponse(): DashScopeResponse {
  return {
    output: {
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: '杭州明天阴转小雨[1][2]' },
      }],
      search_info: {
        search_results: [
          { index: 1, title: '杭州天气', url: 'https://a.test', site_name: 'A' },
          { index: 2, title: '  天气预报  ', url: 'https://b.test' },
        ],
      },
    },
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      plugins: { search: { count: 1, strategy: 'turbo' } },
    },
    request_id: 'req-1',
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('isMultimodalModel', () => {
  it('routes multimodal-capable series to the multimodal endpoint', () => {
    for (const model of ['qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus', 'qwen3.7-flash', 'qwen3.6-plus', 'qwen3.5-omni-plus']) {
      expect(isMultimodalModel(model), model).toBe(true)
    }
  })

  it('routes text-only models to the text endpoint', () => {
    for (const model of ['qwen3.7-max', 'qwen3-max', 'qwen-max', 'qwen-plus', 'qwen-turbo', 'qwq-plus', 'deepseek-v4-flash', 'glm-5.2', 'kimi-k3']) {
      expect(isMultimodalModel(model), model).toBe(false)
    }
  })
})

describe('bailianSearchEndpoint', () => {
  it('selects multimodal-generation for a multimodal model', () => {
    expect(bailianSearchEndpoint('https://dashscope.test', 'qwen3.8-max'))
      .toBe('https://dashscope.test/api/v1/services/aigc/multimodal-generation/generation')
  })

  it('selects text-generation for a text model', () => {
    expect(bailianSearchEndpoint('https://dashscope.test', 'qwen3.7-max'))
      .toBe('https://dashscope.test/api/v1/services/aigc/text-generation/generation')
  })

  it('ignores any path on the configured base and keeps the origin', () => {
    expect(bailianSearchEndpoint('https://dashscope.test/compatible-mode/v1', 'qwen3.8-max'))
      .toBe('https://dashscope.test/api/v1/services/aigc/multimodal-generation/generation')
  })

  it('preserves a workspace-scoped host', () => {
    expect(bailianSearchEndpoint('https://llm-example.cn-beijing.maas.test', 'qwen3.8-max'))
      .toBe('https://llm-example.cn-beijing.maas.test/api/v1/services/aigc/multimodal-generation/generation')
  })
})

describe('buildSearchPrompt', () => {
  it('anchors the query to today and asks for a search in Chinese', () => {
    expect(buildSearchPrompt('Hangzhou weather', '2026-09-05'))
      .toBe('今天是 2026-09-05。请联网搜索后回答：Hangzhou weather')
  })

  it('passes the query through verbatim', () => {
    expect(buildSearchPrompt('a?b&c', '2026-01-01')).toContain('a?b&c')
  })
})

describe('todayIsoDate', () => {
  it('reads the UTC date portion', () => {
    expect(todayIsoDate(new Date('2026-09-05T23:59:59Z'))).toBe('2026-09-05')
  })
})

describe('dashScopeContentText', () => {
  it('returns a string content verbatim', () => {
    expect(dashScopeContentText({ choices: [{ message: { content: 'plain' } }] })).toBe('plain')
  })

  it('concatenates multimodal content parts', () => {
    expect(dashScopeContentText({ choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] })).toBe('ab')
  })

  it('skips parts without text', () => {
    expect(dashScopeContentText({ choices: [{ message: { content: [{ text: 'a' }, {}] } }] })).toBe('a')
  })

  it('tolerates a missing output, choices, or message', () => {
    expect(dashScopeContentText(undefined)).toBe('')
    expect(dashScopeContentText({})).toBe('')
    expect(dashScopeContentText({ choices: [] })).toBe('')
    expect(dashScopeContentText({ choices: [{}] })).toBe('')
  })
})

describe('mapDashScopeResponse', () => {
  it('maps sources with titles and carries the answer as content', () => {
    expect(mapDashScopeResponse(searchResponse())).toEqual({
      content: '杭州明天阴转小雨[1][2]',
      sources: [
        { url: 'https://a.test', title: '杭州天气' },
        { url: 'https://b.test', title: '天气预报' },
      ],
      truncated: false,
    })
  })

  it('dedupes repeated urls, first occurrence wins', () => {
    const result = mapDashScopeResponse({
      output: {
        search_info: {
          search_results: [
            { url: 'https://a.test', title: 'first' },
            { url: 'https://a.test', title: 'second' },
          ],
        },
      },
    })
    expect(result.sources).toEqual([{ url: 'https://a.test', title: 'first' }])
  })

  it('omits a blank or missing title rather than inventing one', () => {
    const result = mapDashScopeResponse({
      output: {
        search_info: {
          search_results: [
            { url: 'https://a.test', title: '   ' },
            { url: 'https://b.test' },
            { url: 'https://c.test', title: null },
          ],
        },
      },
    })
    expect(result.sources).toEqual([
      { url: 'https://a.test' },
      { url: 'https://b.test' },
      { url: 'https://c.test' },
    ])
  })

  it('skips entries with a missing or empty url', () => {
    const result = mapDashScopeResponse({
      output: {
        search_info: {
          search_results: [{ url: '' }, { title: 'no url' }, { url: 'https://ok.test' }],
        },
      },
    })
    expect(result.sources).toEqual([{ url: 'https://ok.test' }])
  })

  it('omits content when the answer is empty but sources exist', () => {
    const result = mapDashScopeResponse({
      output: {
        choices: [{ message: { content: '' } }],
        search_info: { search_results: [{ url: 'https://a.test' }] },
      },
    })
    expect(result).toEqual({ sources: [{ url: 'https://a.test' }], truncated: false })
  })

  it('reads a multimodal content array', () => {
    const result = mapDashScopeResponse({
      output: {
        choices: [{ message: { content: [{ text: 'part one ' }, { text: 'part two' }] } }],
        search_info: { search_results: [{ url: 'https://a.test' }] },
      },
    })
    expect(result.content).toBe('part one part two')
  })

  it('throws WEB_PROVIDER_ERROR (strict mode) when no search ran', () => {
    expect(() => mapDashScopeResponse({
      output: { choices: [{ message: { content: 'answered from memory' } }] },
    })).toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('throws when search_info carries an empty result list', () => {
    expect(() => mapDashScopeResponse({ output: { search_info: { search_results: [] } } }))
      .toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('names the throttle and the usage evidence in the strict-mode message', () => {
    expect(() => mapDashScopeResponse({ usage: { plugins: { search: { count: 0 } } } }))
      .toThrow(/15 RPS/)
  })

  it('throws when the envelope is empty', () => {
    expect(() => mapDashScopeResponse({})).toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })
})

describe('BailianSearchProvider availability', () => {
  it('is unavailable without a key or resolver', () => {
    expect(searchProvider({ ...options, apiKey: '' }).available()).toBe(false)
  })

  it('is available with a literal key', () => {
    expect(searchProvider(options).available()).toBe(true)
  })

  it('is available with only a resolver', () => {
    expect(searchProvider({ ...options, apiKey: '', resolveApiKey: async () => 'k' }).available()).toBe(true)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(searchProvider({ ...options, baseURL: 'not a url' }).available()).toBe(false)
  })

  it('is misconfigured when the search strategy is not a known tier', () => {
    expect(searchProvider({ ...options, searchStrategy: 'turbo ' as 'turbo' }).available()).toBe(false)
  })
})

describe('BailianSearchProvider request mapping', () => {
  it('posts the DashScope multimodal body with forced search enabled', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-05T08:00:00Z'))
    const fetchMock = vi.fn(async () => jsonResponse(searchResponse()))
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider(options).search({ query: '杭州明天天气' })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://dashscope.test/api/v1/services/aigc/multimodal-generation/generation')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    const headers = init.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer bl-key')
    expect(headers['content-type']).toBe('application/json')
    expect(headers).not.toHaveProperty('x-api-key')
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'qwen3.8-max',
      input: { messages: [{ role: 'user', content: [{ text: '今天是 2026-09-05。请联网搜索后回答：杭州明天天气' }] }] },
      parameters: {
        result_format: 'message',
        enable_search: true,
        search_options: {
          forced_search: true,
          enable_source: true,
          enable_citation: true,
          search_strategy: 'turbo',
        },
      },
    })
  })

  it('sends a bare string content and the text endpoint for a text-only model', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(searchResponse()))
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider({ ...options, model: 'qwen3.7-max', searchStrategy: 'max' })
      .search({ query: 'q' })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://dashscope.test/api/v1/services/aigc/text-generation/generation')
    const body = JSON.parse(init.body as string)
    expect(typeof body.input.messages[0].content).toBe('string')
    expect(body.parameters.search_options.search_strategy).toBe('max')
  })

  it('omits enable_thinking entirely when the option is not configured', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(searchResponse()))
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider(options).search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    // The exact-shape assertion above already pins this; state the intent too: an
    // unsent parameter cannot be rejected by a model that does not accept it.
    expect(Object.keys(body.parameters)).not.toContain('enable_thinking')
  })

  it('sends enable_thinking false when configured, the measured ~11x faster path', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(searchResponse()))
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider({ ...options, enableThinking: false }).search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string).parameters.enable_thinking).toBe(false)
  })

  it('sends enable_thinking true when configured', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(searchResponse()))
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider({ ...options, enableThinking: true }).search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string).parameters.enable_thinking).toBe(true)
  })

  it('records the secret-free request before dispatch when a recorder is supplied', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(searchResponse()))
    const recordRequest = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider({ ...options, recordRequest }).search({ query: 'q' })
    expect(recordRequest).toHaveBeenCalledOnce()
    expect(recordRequest.mock.calls[0]?.[0]).toMatchObject({
      endpoint: 'https://dashscope.test/api/v1/services/aigc/multimodal-generation/generation',
    })
    expect(JSON.stringify(recordRequest.mock.calls[0]?.[0])).not.toContain('bl-key')
    expect(recordRequest.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0] ?? 0)
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(searchResponse()))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await searchProvider(options).search({ query: 'q' }, controller.signal)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })
})

describe('BailianSearchProvider settings changes mid-search', () => {
  it('serves one search from one section even when settings land during credential resolution', async () => {
    const before: BailianSearchProviderOptions = {
      ...options, apiKey: '', baseURL: 'https://before.test', model: 'qwen3.8-max',
    }
    const after: BailianSearchProviderOptions = {
      ...options, apiKey: '', baseURL: 'https://after.test', model: 'qwen3.7-max',
    }
    let current = before
    let commitSettings = (): void => {}
    const resolveApiKey = (): Promise<string> => new Promise<string>((resolve) => {
      commitSettings = (): void => {
        current = after
        resolve('key-from-before')
      }
    })
    const fetchMock = vi.fn(async () => jsonResponse(searchResponse()))
    vi.stubGlobal('fetch', fetchMock)

    const provider = new BailianSearchProvider(() => ({ ...current, resolveApiKey }))
    const search = provider.search({ query: 'q' })
    await vi.waitFor(() => { expect(typeof commitSettings).toBe('function') })
    commitSettings()
    await search

    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string>, body: string }]
    // The key resolved from `before` must never reach `after`'s origin.
    expect(endpoint).toBe('https://before.test/api/v1/services/aigc/multimodal-generation/generation')
    expect(init.headers['authorization']).toBe('Bearer key-from-before')
    expect(JSON.parse(init.body)).toMatchObject({ model: 'qwen3.8-max' })
  })
})

describe('BailianSearchProvider error handling', () => {
  it('does not start credential resolution or dispatch for a pre-aborted call', async () => {
    const resolveApiKey = vi.fn(async () => 'late-key')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    await expect(searchProvider({ ...options, apiKey: '', resolveApiKey })
      .search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(resolveApiKey).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('aborts while an uncooperative credential resolver remains pending', async () => {
    const resolveApiKey = vi.fn(() => new Promise<string>(() => {}))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const search = searchProvider({ ...options, apiKey: '', resolveApiKey })
      .search({ query: 'q' }, controller.signal)
    controller.abort(new Error('deadline'))
    await expect(search).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(resolveApiKey).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resolves credentials under an active cancellation signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(searchResponse()))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await expect(searchProvider({
      ...options, apiKey: '', resolveApiKey: async () => 'resolved-key',
    }).search({ query: 'q' }, controller.signal)).resolves.toMatchObject({ truncated: false })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer resolved-key')
  })

  it('maps a credential resolver rejection to WEB_PROVIDER_ERROR', async () => {
    await expect(searchProvider({
      ...options, apiKey: '', resolveApiKey: () => Promise.reject(new Error('credential backend failed')),
    }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({
        code: 'WEB_PROVIDER_ERROR',
        message: 'Bailian search credential resolution failed: Error: credential backend failed',
      }))
  })

  it('reports an actionable message when no key is configured', async () => {
    await expect(searchProvider({ ...options, apiKey: '' }).search({ query: 'q' }))
      .rejects.toThrow('Bailian search has no API key for "DASHSCOPE_API_KEY"')
  })

  it('observes cancellation triggered synchronously by credential resolution', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(searchProvider({
      ...options,
      apiKey: '',
      resolveApiKey: () => {
        controller.abort(new Error('resolver cancelled caller'))
        return Promise.resolve('unused-key')
      },
    }).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps a native-protocol error body to WEB_PROVIDER_ERROR with its message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(
      { code: 'InvalidParameter', message: 'url error, please check url', request_id: 'r' },
      { status: 400 },
    )))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'url error, please check url' }))
  })

  it('maps a compatible-gateway nested error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(
      { error: { message: 'Model access denied.', type: 'access_denied' } },
      { status: 403 },
    )))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Model access denied.' }))
  })

  it('handles a string-form error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'bad request' }, { status: 400 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'bad request' }))
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream error', { status: 503 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Bailian API error (HTTP 503)' }))
  })

  it('keeps the status-line message when the JSON error body carries no detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 500 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Bailian API error (HTTP 500)' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps a custom abort reason to WEB_ABORTED', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('custom abort reason')) }, { once: true })
      })))
    const search = searchProvider(options).search({ query: 'q' }, controller.signal)
    controller.abort(new Error('timeout reason'))
    await expect(search).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('strict mode flows through search(): a memory-only answer throws WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      output: { choices: [{ message: { content: 'no search happened' } }] },
    })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })
})

describe('web-search-bailian plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(searchResponse())))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: BAILIAN_PROVIDER_ID })
    await ctx.plugin(InMemorySettings)
    const fiber = await ctx.plugin(bailianPlugin, { apiKey: 'bl-key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in bailianPlugin).toBe(false)
  })

  it('survives the real Loader unwrapExports path keeping name/inject/Config', () => {
    // A default export would make `unwrapExports` collapse the namespace and drop
    // `inject: ['web']`. Drive the real Loader path because hand-built namespace
    // mounting cannot expose that failure.
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(bailianPlugin) as Record<string, unknown>
    expect(unwrapped).toBe(bailianPlugin)
    expect(unwrapped.name).toBe('web-search-bailian')
    expect(unwrapped.inject).toEqual(['web', 'settings'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('boots over ctx.web through the unwrapped module without an inject error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(searchResponse())))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: BAILIAN_PROVIDER_ID })
    await ctx.plugin(InMemorySettings)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(bailianPlugin) as Parameters<Context['plugin']>[0]
    const fiber = await ctx.plugin(unwrapped, { apiKey: 'bl-key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ truncated: false })
    await fiber.dispose()
  })

  it('rejects an unknown search strategy at plugin construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: BAILIAN_PROVIDER_ID })
    await ctx.plugin(InMemorySettings)
    await expect(ctx.plugin(bailianPlugin, { apiKey: 'bl-key', searchStrategy: 'fastest' }))
      .rejects.toThrow(/searchStrategy/)
  })

  it('rejects a non-boolean enableThinking at plugin construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: BAILIAN_PROVIDER_ID })
    await ctx.plugin(InMemorySettings)
    await expect(ctx.plugin(bailianPlugin, { apiKey: 'bl-key', enableThinking: 'no' }))
      .rejects.toThrow(/enableThinking/)
  })

  it('plumbs enableThinking from the settings section into the request body', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(searchResponse()))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: BAILIAN_PROVIDER_ID })
    await ctx.plugin(InMemorySettings)
    bailianPlugin.apply(ctx, { apiKey: 'bl-key', enableThinking: false })
    await ctx.web.search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string).parameters.enable_thinking).toBe(false)
    await ctx.fiber.dispose()
  })

  it('falls back to the env key and defaults when config omits them', async () => {
    const prev = process.env.DASHSCOPE_API_KEY
    process.env.DASHSCOPE_API_KEY = 'env-key'
    try {
      const fetchMock = vi.fn(async () => jsonResponse(searchResponse()))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: BAILIAN_PROVIDER_ID })
    await ctx.plugin(InMemorySettings)
      bailianPlugin.apply(ctx, {})
      await ctx.web.search({ query: 'q' })
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')
      expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer env-key')
      expect(JSON.parse(init.body as string)).toMatchObject({ model: 'qwen3.8-max' })
      await ctx.fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.DASHSCOPE_API_KEY
      else process.env.DASHSCOPE_API_KEY = prev
    }
  })

  it('resolves the credential for each search so a stored or rotated key needs no restart', async () => {
    const previous = process.env.DASHSCOPE_API_KEY
    delete process.env.DASHSCOPE_API_KEY
    const dir = await mkdtemp(join(tmpdir(), 'web-search-bailian-credentials-'))
    const fetchMock = vi.fn(async () => jsonResponse(searchResponse()))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: BAILIAN_PROVIDER_ID })
    await ctx.plugin(InMemorySettings)
      await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
      await ctx.plugin(bailianPlugin, { baseURL: 'https://dashscope.test' })

      await expect(ctx.web.search({ query: 'missing' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))

      const ref = credentialRef('DASHSCOPE_API_KEY')
      await ctx.credentials.set(ref, 'stored-key')
      await ctx.web.search({ query: 'stored' })
      await ctx.credentials.set(ref, 'rotated-key')
      await ctx.web.search({ query: 'rotated' })

      const headers = fetchMock.mock.calls
        .map(([, init]) => (init as RequestInit).headers as Record<string, string>)
      expect(headers.map(value => value['authorization']))
        .toEqual(['Bearer stored-key', 'Bearer rotated-key'])
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
      if (previous === undefined) delete process.env.DASHSCOPE_API_KEY
      else process.env.DASHSCOPE_API_KEY = previous
    }
  })

  it('reports an actionable credential error when neither config nor env supplies a key', async () => {
    const prev = process.env.DASHSCOPE_API_KEY
    delete process.env.DASHSCOPE_API_KEY
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: BAILIAN_PROVIDER_ID })
    await ctx.plugin(InMemorySettings)
      await ctx.plugin(bailianPlugin, {})
      let caught: unknown
      try {
        await ctx.web.search({ query: 'q' })
      } catch (error: unknown) {
        caught = error
      }
      expect(caught).toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
      if (!(caught instanceof Error)) throw new Error('search did not throw an Error')
      expect(caught.message).toMatch(/store it through the credentials service.*Models page/s)
    } finally {
      if (prev !== undefined) process.env.DASHSCOPE_API_KEY = prev
    }
  })

  it('coexists with another provider id and is selected explicitly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(searchResponse())))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: BAILIAN_PROVIDER_ID })
    await ctx.plugin(InMemorySettings)
    await ctx.plugin(bailianPlugin, { apiKey: 'bl-key' })
    // A second provider under a different id must not disturb the configured choice.
    ctx.web.registerSearchProvider({
      id: 'other',
      available: () => true,
      search: async () => ({ sources: [], truncated: false }),
    })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ truncated: false })
    await ctx.fiber.dispose()
  })
})
