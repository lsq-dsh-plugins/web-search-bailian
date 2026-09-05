/**
 * Provider-private wire types for Alibaba Cloud Model Studio (Bailian) built-in web
 * search over the DashScope native protocol.
 *
 * DashScope native is the only Bailian protocol that returns search sources: both
 * OpenAI-compatible modes are documented as not returning `search_info`, so their
 * citation markers cannot be resolved to URLs. These types do not create a dependency
 * on `ctx.llm`.
 * @module web-search-bailian/types
 */

/** One entry of `output.search_info.search_results`. */
export interface DashScopeSearchResultItem {
  /** 1-based citation index the model references as `[n]` in its answer. */
  index?: number | null
  title?: string | null
  url?: string | null
  /** Display name of the publishing site. */
  site_name?: string | null
  icon?: string | null
}

/**
 * `output.search_info`: present only when a search actually ran. Its absence is the
 * documented signal that the model answered from memory (or that the account hit the
 * 15 RPS search throttle, which silently skips the search chain).
 */
export interface DashScopeSearchInfo {
  search_results?: DashScopeSearchResultItem[] | null
}

/** One part of a multimodal-style `content` array. */
export interface DashScopeContentPart {
  text?: string | null
}

/**
 * `output.choices[].message`. `content` is a plain string for text-generation models
 * and an array of parts for multimodal-generation models, so both shapes are accepted.
 */
export interface DashScopeMessage {
  role?: string
  content?: string | DashScopeContentPart[] | null
}

/** One `output.choices[]` entry. */
export interface DashScopeChoice {
  finish_reason?: string | null
  message?: DashScopeMessage | null
}

/** The `output` object of a DashScope generation response. */
export interface DashScopeOutput {
  choices?: DashScopeChoice[] | null
  search_info?: DashScopeSearchInfo | null
}

/** `usage.plugins.search`: the documented proof that one search ran. */
export interface DashScopeSearchUsage {
  count?: number | null
  strategy?: string | null
}

/** Token and plugin accounting for one call. */
export interface DashScopeUsage {
  input_tokens?: number | null
  output_tokens?: number | null
  total_tokens?: number | null
  plugins?: { search?: DashScopeSearchUsage | null } | null
}

/** Bailian's success envelope. */
export interface DashScopeResponse {
  output?: DashScopeOutput | null
  usage?: DashScopeUsage | null
  request_id?: string | null
}

/**
 * Bailian's error envelope. The DashScope native protocol reports `code`/`message` at
 * the top level; the OpenAI-compatible gateway nests them under `error`. Both are
 * accepted so one message-extraction path serves either.
 */
export interface DashScopeError {
  code?: string | null
  message?: string | null
  request_id?: string | null
  error?: { message?: string | null; type?: string | null; code?: string | null } | string | null
}
