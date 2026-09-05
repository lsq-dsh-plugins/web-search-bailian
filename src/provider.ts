/**
 * `BailianSearchProvider`: a `WebSearchProvider` backed by Alibaba Cloud Model Studio
 * (Bailian) built-in web search over the DashScope native protocol.
 *
 * Derived from `@deepseek-ai/dsh-web-search-deepseek`: credential resolution, the
 * one-snapshot-per-operation rule, cancellation, and error classification are carried
 * over unchanged; only the wire format differs. As in that provider, a response that
 * carries no search results is an error rather than a prose-scraping fallback.
 * @module web-search-bailian/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {
  DashScopeError,
  DashScopeOutput,
  DashScopeResponse,
} from './types.ts'

/** Stable id this provider registers under. */
export const BAILIAN_PROVIDER_ID = 'bailian'

/**
 * Default endpoint origin. Unlike the Anthropic-compatible provider this derives from,
 * the operation path is appended per model rather than fixed, because Bailian serves
 * multimodal-capable models on a different endpoint than text-only ones.
 */
export const BAILIAN_DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com'

/** Default model: supports built-in search on the DashScope native protocol. */
export const BAILIAN_DEFAULT_MODEL = 'qwen3.8-max'

/**
 * Search strategy tiers, billed per 1000 searches. `turbo` is the cheapest tier that
 * still returns sources; `agent` adds query planning. Qwen3.8-series models do not
 * accept `agent`.
 */
export type SearchStrategy = 'turbo' | 'max' | 'agent'

/** Default search strategy. */
export const BAILIAN_DEFAULT_SEARCH_STRATEGY: SearchStrategy = 'turbo'

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'web-search-bailian/0.1.0'

/**
 * Exact secret-free Bailian request recorded immediately before one search dispatch.
 * The body is opaque here: this package declares no session event of its own, so the
 * shape is not pinned to a typert envelope the way the provider it derives from pins
 * its Anthropic body.
 */
export interface BailianSearchLlmRequest {
  /** Fully resolved DashScope generation endpoint. */
  readonly endpoint: string
  /** Exact JSON body sent to the provider. */
  readonly body: unknown
}

/** Resolved provider options (the plugin's `apply` supplies credential and constant defaults). */
export interface BailianSearchProviderOptions {
  /** Literal Bailian API key; when present it wins over {@link resolveApiKey}. */
  apiKey?: string
  /** Resolve the current Bailian API key for one search operation. */
  resolveApiKey?: () => Promise<string | undefined>
  /** Credential reference named by missing-credential diagnostics. */
  apiKeyEnv?: CredentialRef
  /** Endpoint origin; the DashScope operation path is appended per model. */
  baseURL: string
  /** Bailian model name. */
  model: string
  /** Search strategy tier sent as `search_options.search_strategy`. */
  searchStrategy: SearchStrategy
  /**
   * Send `enable_thinking`. Omit to let the model apply its own default; the parameter
   * is then not transmitted at all, so a model that rejects it is unaffected. Setting
   * `false` measured ~11x faster on `qwen3.8-max` (4.8s vs 52.8s) with a byte-identical
   * source list — a search answer rarely needs deep reasoning.
   */
  enableThinking?: boolean
  /**
   * Record the exact secret-free request immediately before dispatch. Not wired by
   * this package's plugin entry: it owns no session event, and a throw here would
   * prevent dispatch.
   */
  recordRequest?: (request: BailianSearchLlmRequest) => void
}

/**
 * Models Bailian serves on the `multimodal-generation` endpoint. Calling one on
 * `text-generation` fails with `400 url error, please check url`, so the endpoint is
 * derived from the model rather than configured separately.
 *
 * @param model - the configured Bailian model name.
 * @returns true when the model must be called on the multimodal endpoint.
 */
export function isMultimodalModel(model: string): boolean {
  return /^(?:qwen3\.8-|qwen3\.7-(?:plus|flash)|qwen3\.6-|qwen3\.5-|qwen3-vl|qwen2\.5-vl|qwen-vl|qwq-omni|qwen[0-9.]*-omni)/u.test(model)
}

/**
 * Resolve the DashScope generation endpoint for one model.
 *
 * @param baseURL - the endpoint origin (any path it carries is ignored).
 * @param model - the configured model, which selects the service.
 * @returns the absolute generation endpoint.
 */
export function bailianSearchEndpoint(baseURL: string, model: string): string {
  const service = isMultimodalModel(model) ? 'multimodal-generation' : 'text-generation'
  return `${new URL(baseURL).origin}/api/v1/services/aigc/${service}/generation`
}

/**
 * Today's date as `YYYY-MM-DD` in UTC.
 *
 * @param now - the clock to read; injectable for tests.
 * @returns the date portion of the ISO timestamp.
 */
export function todayIsoDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

/**
 * Wrap a query in a dated Chinese instruction. Bailian documents that English input
 * may not trigger a search, and a model with no clock mis-resolves relative dates such
 * as "tomorrow"; both are handled here instead of being left to the caller.
 *
 * @param query - the caller's query, passed through verbatim.
 * @param today - the date to anchor relative expressions against.
 * @returns the prompt text sent as the user turn.
 */
export function buildSearchPrompt(query: string, today: string): string {
  return `今天是 ${today}。请联网搜索后回答：${query}`
}

/** True for the three strategy tiers Bailian bills and accepts. */
export function isSearchStrategy(value: unknown): value is SearchStrategy {
  return value === 'turbo' || value === 'max' || value === 'agent'
}

/**
 * Build the DashScope generation body for one search. The multimodal endpoint takes
 * `content` as an array of parts while text-generation takes a bare string, so the
 * shape follows the same model test that selected the endpoint.
 *
 * @param options - the operation's resolved snapshot.
 * @param request - the query to search for.
 * @returns the JSON-serializable request body.
 */
export function buildRequestBody(
  options: Pick<BailianSearchProviderOptions, 'model' | 'searchStrategy' | 'enableThinking'>,
  request: WebSearchRequest,
): unknown {
  const text = buildSearchPrompt(request.query, todayIsoDate())
  const multimodal = isMultimodalModel(options.model)
  return {
    model: options.model,
    input: {
      messages: [{
        role: 'user',
        content: multimodal ? [{ text }] : text,
      }],
    },
    parameters: {
      result_format: 'message',
      enable_search: true,
      // A thinking model spends most of a search call on reasoning tokens while the
      // returned source list is identical, so the dial is exposed rather than forced:
      // absent means the parameter is not sent at all.
      ...options.enableThinking === undefined ? {} : { enable_thinking: options.enableThinking },
      search_options: {
        // Forced: the seam asks for a search, so letting the model decide would turn
        // an unremarkable query into a memory-only answer with no sources.
        forced_search: true,
        enable_source: true,
        enable_citation: true,
        search_strategy: options.searchStrategy,
      },
    },
  }
}

/**
 * Extract the assistant text from either `content` shape Bailian returns.
 *
 * @param output - the response's `output` object.
 * @returns the concatenated answer text, or an empty string when absent.
 */
export function dashScopeContentText(output: DashScopeOutput | null | undefined): string {
  const content = output?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => typeof part?.text === 'string' ? part.text : '')
      .join('')
  }
  return ''
}

/**
 * Map a DashScope response to a normalized search result. Sources come from
 * `output.search_info.search_results` and are deduped by `url` (one search can surface
 * the same page twice). `title` is mapped when non-blank; Bailian returns no snippet or
 * publication date on this protocol, so neither is invented. The web service owns the
 * final `maxResults` truncation, so `truncated` is always `false` here.
 *
 * @param response - the parsed generation response body.
 * @returns the normalized result with deduped sources and the answer as `content`.
 * @throws {@link WebError} when no search ran.
 */
export function mapDashScopeResponse(response: DashScopeResponse): WebSearchResult {
  const results = response.output?.search_info?.search_results ?? []
  if (results.length === 0) {
    const search = response.usage?.plugins?.search
    throw new WebError(
      'Bailian returned no search_info.search_results, so web search did not run '
      + `(usage.plugins.search=${JSON.stringify(search ?? null)}). The account-level 15 RPS `
      + 'search throttle skips the search chain without reporting an error, and some models '
      + 'support built-in search only through the Responses API.',
      'WEB_PROVIDER_ERROR',
    )
  }

  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const item of results) {
    const url = item.url
    if (url == null || url.length === 0 || seen.has(url)) continue
    seen.add(url)
    const title = item.title?.trim() ?? ''
    sources.push({
      url,
      ...title.length > 0 ? { title } : {},
    })
  }

  const content = dashScopeContentText(response.output)
  return {
    ...content.length > 0 ? { content } : {},
    sources,
    truncated: false,
  }
}

/** The Bailian-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class BailianSearchProvider implements WebSearchProvider {
  readonly id = BAILIAN_PROVIDER_ID

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted once at
   * each operation's entry so one search never mixes two sections. A thunk rather than
   * a value because the plugin's settings section can change between searches, and
   * re-registering the provider to carry a new endpoint would make the seam's selection
   * observable to the user as a flicker.
   */
  constructor(private readonly resolveOptions: () => BailianSearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined)
      && URL.canParse(options.baseURL)
      && isSearchStrategy(options.searchStrategy)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // One snapshot for the whole operation: credential resolution awaits, and a
    // settings write landing inside that await must not send the key resolved
    // from the old section to the endpoint named by the new one.
    const options = this.resolveOptions()
    const apiKey = await this.apiKey(options, signal)
    throwIfSearchAborted(signal)
    const endpoint = bailianSearchEndpoint(options.baseURL, options.model)
    const body = buildRequestBody(options, request)
    options.recordRequest?.({ endpoint, body })
    throwIfSearchAborted(signal)
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      throw new WebError(`Bailian search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `Bailian API error (HTTP ${status})`
      try {
        const parsed = await response.json() as DashScopeError
        // Native protocol: top-level `message`. Compatible gateway: nested `error`.
        const detail = typeof parsed.error === 'string'
          ? parsed.error
          : parsed.error?.message ?? parsed.message ?? undefined
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
        // Otherwise: the HTTP status is already captured in `message` above; a
        // malformed/non-JSON error body (normal for gateway 5xx/429s) can only
        // cost a richer provider message, never the real error.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as DashScopeResponse
      return mapDashScopeResponse(payload)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      if (error instanceof WebError) throw error
      throw new WebError(`Bailian returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  /**
   * Resolve one operation's credential without retaining it on the provider.
   * @param options - the caller's snapshot, so the key and the endpoint it is sent to come from one section.
   * @param signal - abort signal for the surrounding search.
   * @returns the resolved key.
   */
  private async apiKey(options: BailianSearchProviderOptions, signal?: AbortSignal): Promise<string> {
    throwIfSearchAborted(signal)
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
    let resolved: string | undefined
    try {
      resolved = await abortable(options.resolveApiKey?.() ?? Promise.resolve(undefined), signal)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      throw new WebError(
        `Bailian search credential resolution failed: ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
    if (resolved !== undefined && resolved.length > 0) return resolved
    const ref = options.apiKeyEnv ?? 'DASHSCOPE_API_KEY'
    throw new WebError(
      `Bailian search has no API key for "${ref}"; store it through the credentials service`
      + ' (the web Models page writes it), export it in the launching environment, or set a literal'
      + ' "apiKey" in the web-search-bailian config',
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
}

/**
 * Race a same-process asynchronous preflight against caller cancellation. The
 * attached settlement handlers keep observing an uncooperative operation after
 * abort so a later rejection cannot become unhandled.
 */
function abortable(operation: Promise<string | undefined>, signal?: AbortSignal): Promise<string | undefined> {
  if (signal === undefined) return operation
  if (signal.aborted) return Promise.reject(searchAborted(signal))
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      reject(searchAborted(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then((value) => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }, (error: unknown) => {
      signal.removeEventListener('abort', onAbort)
      reject(new Error(String(error).replace(/^Error: /u, ''), { cause: error }))
    })
  })
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfSearchAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw searchAborted(signal)
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError('Bailian search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
