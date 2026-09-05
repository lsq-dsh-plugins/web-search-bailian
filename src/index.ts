/**
 * Register a Bailian-backed provider in `ctx.web`. It calls Alibaba Cloud Model Studio's
 * DashScope native generation endpoint with built-in web search enabled.
 *
 * The provider reuses an existing Bailian/DashScope API key — the same credential the
 * chat-completions adapter uses — because built-in search is a model capability on that
 * platform rather than a separately keyed service. It does NOT reuse the compatible-mode
 * base URL: search is dispatched to the DashScope native protocol, which is the only one
 * that returns search sources.
 * @module web-search-bailian
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-web'
import {
  BailianSearchProvider,
  BAILIAN_DEFAULT_BASE_URL,
  BAILIAN_DEFAULT_MODEL,
  BAILIAN_DEFAULT_SEARCH_STRATEGY,
} from './provider.ts'
import type { BailianSearchProviderOptions, SearchStrategy } from './provider.ts'

export {
  BailianSearchProvider,
  BAILIAN_DEFAULT_BASE_URL,
  BAILIAN_DEFAULT_MODEL,
  BAILIAN_DEFAULT_SEARCH_STRATEGY,
  BAILIAN_PROVIDER_ID,
  bailianSearchEndpoint,
  buildRequestBody,
  buildSearchPrompt,
  dashScopeContentText,
  isMultimodalModel,
  isSearchStrategy,
  mapDashScopeResponse,
  todayIsoDate,
} from './provider.ts'
export type { BailianSearchLlmRequest, BailianSearchProviderOptions, SearchStrategy } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-bailian'

/** The web seam this provider registers into. */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'DASHSCOPE_API_KEY'

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Literal Bailian API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey?: string
  /** Credential reference resolved for each search; defaults to `DASHSCOPE_API_KEY`. */
  apiKeyEnv?: string
  /** Endpoint origin; the DashScope operation path is appended per model. */
  baseURL?: string
  /** Bailian model name. Defaults to `qwen3.8-max`. */
  model?: string
  /** Search strategy tier. Defaults to `turbo`. Qwen3.8-series models reject `agent`. */
  searchStrategy?: SearchStrategy
  /**
   * Send `enable_thinking`. Omit to leave the parameter unsent; `false` is roughly an
   * order of magnitude faster on thinking models with the same source list.
   */
  enableThinking?: boolean
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  // Declared here rather than only at the use site: a configuration surface
  // renders the resolved section, so a default the schema does not carry reads
  // there as no value at all.
  baseURL: z.string(),
  model: z.string().default(BAILIAN_DEFAULT_MODEL),
  searchStrategy: z.union(['turbo', 'max', 'agent'] as const).default(BAILIAN_DEFAULT_SEARCH_STRATEGY),
  enableThinking: z.boolean(),
})

/**
 * Environment variable naming this provider's endpoint origin. Distinct from any
 * chat-completions base: search is dispatched to the DashScope native protocol, so one
 * variable cannot serve both.
 */
const SEARCH_BASE_URL_ENV = 'BAILIAN_SEARCH_BASE_URL'

/** Settings namespace carrying this provider's endpoint, model, and key reference. */
export const WEB_SEARCH_BAILIAN_SETTINGS_NAMESPACE = settingsNamespace('web-search-bailian')

/**
 * Project one resolved section into the options the provider serves its next
 * search with. Environment fallbacks stay here rather than in the provider:
 * every value it reads is already fully defaulted.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the currently authoritative section.
 * @returns options for one search.
 */
function resolveOptions(ctx: Context, config: Config): BailianSearchProviderOptions {
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
  const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0
    ? config.apiKey
    : undefined
  return {
    ...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      // Without the seam the environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    apiKeyEnv,
    baseURL: config.baseURL
      ?? launchEnvironmentOf(ctx).get(SEARCH_BASE_URL_ENV)?.value
      ?? BAILIAN_DEFAULT_BASE_URL,
    model: config.model ?? BAILIAN_DEFAULT_MODEL,
    searchStrategy: config.searchStrategy ?? BAILIAN_DEFAULT_SEARCH_STRATEGY,
    ...config.enableThinking === undefined ? {} : { enableThinking: config.enableThinking },
  }
}

/** Register the Bailian search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  installSettingsSection(ctx, WEB_SEARCH_BAILIAN_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source
    },
    // The registration carries no resolved value: the provider projects the
    // section per search, so a committed change needs no re-registration.
    onChange: () => {},
  })
  ctx.web.registerSearchProvider(new BailianSearchProvider(() => resolveOptions(ctx, current())))
}
