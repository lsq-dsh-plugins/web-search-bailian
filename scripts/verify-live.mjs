/**
 * Live end-to-end check of the built provider against Bailian.
 *
 * Reads the API key from the environment, so no credential is stored in this file:
 *   DASHSCOPE_API_KEY=... node scripts/verify-live.mjs "your query"
 *
 * Optional overrides: BAILIAN_SEARCH_BASE_URL, BAILIAN_SEARCH_MODEL,
 * BAILIAN_SEARCH_STRATEGY.
 */
import { BailianSearchProvider } from '../lib/index.js'

const apiKey = process.env.DASHSCOPE_API_KEY
if (apiKey === undefined || apiKey.length === 0) {
  console.error('DASHSCOPE_API_KEY is not set')
  process.exit(2)
}

const query = process.argv[2] ?? '杭州明天天气如何'
const model = process.env.BAILIAN_SEARCH_MODEL ?? 'qwen3.8-max'
const strategy = process.env.BAILIAN_SEARCH_STRATEGY ?? 'turbo'

const provider = new BailianSearchProvider(() => ({
  apiKey,
  baseURL: process.env.BAILIAN_SEARCH_BASE_URL ?? 'https://dashscope.aliyuncs.com',
  model,
  searchStrategy: strategy,
  // Measured ~11x faster on qwen3.8-max (4.8s vs 52.8s) with the same source list.
  enableThinking: process.env.BAILIAN_ENABLE_THINKING === 'true' ? true
    : process.env.BAILIAN_ENABLE_THINKING === 'false' ? false : undefined,
}))

console.log(`provider id: ${provider.id} | available: ${provider.available()}`)
console.log(`model: ${model} | strategy: ${strategy} | query: ${query}`)

const started = Date.now()
const result = await provider.search({ query })
const elapsed = Date.now() - started

console.log(`\n=== ${elapsed}ms | sources: ${result.sources.length} | truncated: ${result.truncated} ===`)
for (const source of result.sources) {
  console.log(`  - ${source.title ?? '(no title)'}`)
  console.log(`    ${source.url}`)
}
console.log('\n=== content ===')
console.log(result.content ?? '(none)')
