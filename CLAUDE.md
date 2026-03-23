# WordPress / WooCommerce QA Agent — Build Brief

## What We Are Building

A fully autonomous QA testing agent for WordPress and WooCommerce websites.
A developer or PM runs this agent against any WordPress site (staging or live)
and receives a structured QA report equivalent to what a human QA engineer
would produce — covering technical issues, broken flows, performance problems,
UI issues, plugin health, and WooCommerce-specific functionality.

The agent works in two modes:

**Mode A — With project code (best results)**
The agent reads the local WordPress project codebase first to understand
custom features, then tests the live/staging site with full context.

**Mode B — URL only (no code access)**
The agent tests a site it has never seen before using only a URL and
optional WordPress credentials. Still produces a thorough report.

---

## Tech Stack

- **Runtime:** Node.js v22+
- **Language:** TypeScript (preferred) or JavaScript
- **Browser automation:** Playwright via MCP server (@playwright/mcp) — drives user flows
- **Browser internals:** Chrome DevTools MCP (chrome-devtools-mcp) — inspects what's happening underneath
- **WordPress integration:** WordPress REST API (no SSH required)
- **AI for analysis:** Google Gemini 2.0 Pro for report synthesis
- **Performance auditing:** Google PageSpeed Insights API (free, no key needed) + DevTools performance traces
- **CLI interface:** Commander.js
- **Report output:** Markdown + JSON
- **Config:** YAML or JSON per-site config files

### Two-MCP Browser Strategy

These two MCP servers run simultaneously during every browser flow test:

```
PLAYWRIGHT MCP (@playwright/mcp)       DEVTOOLS MCP (chrome-devtools-mcp)
────────────────────────────────────   ────────────────────────────────────
Drives user interactions               Watches what's happening underneath
Navigate, click, type, scroll          Network request capture with full detail
Fill and submit forms                  Console errors with source-mapped stack traces
Take screenshots at each step          JavaScript execution in browser context
Simulate mobile viewports              Performance trace recording
"What the user does"                   "What the browser is doing"
```

Every flow test produces TWO layers of data:
- Layer 1 (Playwright): did the step pass/fail, screenshot evidence
- Layer 2 (DevTools): what console errors fired, which network requests failed,
  what JS variables confirm feature is working, performance data

This is what separates a basic automated checker from something that thinks
like a developer looking at the browser console.

---

## Project Structure to Build

```
wp-qa-agent/
├── CLAUDE.md                    ← This file
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
│
├── src/
│   ├── index.ts                 ← CLI entry point
│   ├── agent.ts                 ← Main orchestrator
│   │
│   ├── checks/
│   │   ├── page-health.ts       ← HTTP status + load time checks
│   │   ├── lighthouse.ts        ← PageSpeed Insights integration
│   │   ├── broken-links.ts      ← Crawl and find 404s
│   │   ├── wordpress-api.ts     ← Plugin status, WC health via REST API
│   │   └── error-logs.ts        ← Error log fetching if available
│   │
│   ├── flows/
│   │   ├── ecommerce-flow.ts    ← Full WooCommerce purchase flow
│   │   ├── auth-flow.ts         ← Login, registration, my account
│   │   ├── search-flow.ts       ← Product search and filtering
│   │   └── mobile-flow.ts       ← Mobile viewport tests
│   │
│   ├── browser/
│   │   ├── playwright-runner.ts ← Playwright MCP: drives user interactions
│   │   ├── devtools-runner.ts   ← DevTools MCP: inspects browser internals
│   │   ├── screenshot.ts        ← Screenshot capture and storage
│   │   └── console-capture.ts   ← JS error and network failure capture
│   │
│   ├── analysis/
│   │   ├── gemini.ts            ← Gemini API integration
│   │   ├── code-reader.ts       ← Read local WP project for context
│   │   └── report-generator.ts  ← Compile findings into report
│   │
│   ├── types/
│   │   └── index.ts             ← All TypeScript interfaces
│   │
│   └── utils/
│       ├── wordpress-auth.ts    ← Application Password auth helper
│       ├── config-loader.ts     ← Load site config files
│       └── logger.ts            ← Structured logging
│
├── configs/
│   └── example-site.yml         ← Example site configuration
│
├── qa-reports/                  ← Generated reports saved here
│
└── screenshots/                 ← Screenshots saved here
```

---

## All TypeScript Interfaces

Build these first in `src/types/index.ts`:

```typescript
export interface SiteConfig {
  name: string
  url: string
  staging_url?: string
  username?: string
  app_password?: string
  description?: string
  project_path?: string  // Local path to WordPress project code

  // What to test
  custom_features?: string[]
  critical_flows?: string[]
  key_pages?: PageConfig[]
  known_issues?: string[]  // Won't flag these as new issues

  // Test settings
  run_ecommerce_flow?: boolean  // default: true if WooCommerce detected
  run_auth_flow?: boolean       // default: true
  run_mobile_tests?: boolean    // default: true
  mobile_viewport?: { width: number; height: number }  // default: 375x812
  max_links_to_crawl?: number   // default: 30
  timeout_ms?: number           // default: 30000
}

export interface PageConfig {
  name: string
  path: string
  expected_status?: number  // default: 200
  must_contain?: string[]   // Text that must appear on page
  must_not_contain?: string[] // Text that must NOT appear
}

export interface CheckResult {
  check: string
  status: 'PASS' | 'FAIL' | 'WARN' | 'ERROR' | 'SKIP'
  detail?: string
  url?: string
  data?: any
}

export interface PageHealthResult {
  page: string
  url: string
  status: number | 'ERROR'
  load_time_ms: number
  ok: boolean
  error?: string
  redirect_url?: string
}

export interface LighthouseResult {
  url: string
  mobile: ScoreSet
  desktop: ScoreSet
  core_web_vitals: CoreWebVitals
}

export interface ScoreSet {
  performance: number
  accessibility: number
  best_practices: number
  seo: number
}

export interface CoreWebVitals {
  lcp_ms: number    // Largest Contentful Paint
  fid_ms: number    // First Input Delay
  cls: number       // Cumulative Layout Shift
  fcp_ms: number    // First Contentful Paint
  ttfb_ms: number   // Time to First Byte
}

export interface WordPressHealthResult {
  site_name: string
  wp_version: string
  woocommerce_detected: boolean
  wc_version?: string
  plugins: PluginInfo[]
  plugins_needing_update: PluginInfo[]
  inactive_plugins: PluginInfo[]
  wc_template_overrides_outdated?: string[]
  rest_api_accessible: boolean
}

export interface PluginInfo {
  name: string
  slug: string
  version: string
  status: 'active' | 'inactive'
  update_available?: boolean
  update_version?: string
  is_premium?: boolean  // Has a license key requirement
}

export interface BrokenLink {
  source_page: string
  broken_url: string
  status: number | 'TIMEOUT' | 'ERROR'
  link_text?: string
}

export interface FlowResult {
  flow_name: string
  steps: FlowStep[]
  passed: boolean
  console_errors: ConsoleError[]          // Basic (from Playwright)
  network_failures: NetworkFailure[]       // Basic (from Playwright)
  devtools_data?: DevToolsFlowData         // Rich data from DevTools MCP
  screenshots: string[]
}

export interface FlowStep {
  step: string
  status: 'PASS' | 'FAIL' | 'SKIP'
  detail?: string
  screenshot?: string
  duration_ms?: number
}

export interface ConsoleError {
  type: string
  message: string
  url: string
  timestamp: string
}

export interface NetworkFailure {
  url: string
  method: string
  status?: number
  reason?: string
}

// ── DevTools MCP specific types ───────────────────────────────────────────────

export interface DevToolsSession {
  page_url: string
  started_at: string
  ended_at: string
}

export interface ConsoleErrorDetailed extends ConsoleError {
  source_file?: string      // Source-mapped file name
  source_line?: number      // Source-mapped line number
  stack_trace?: string[]    // Full source-mapped stack
  count: number             // How many times this error fired
}

export interface NetworkRequest {
  url: string
  method: string
  status: number
  type: string              // xhr, fetch, script, stylesheet, image, etc.
  duration_ms: number
  size_bytes?: number
  is_failed: boolean
  error_reason?: string     // e.g. "net::ERR_FAILED", "net::ERR_ABORTED"
  is_third_party: boolean   // Different domain than the site under test
  is_blocking?: boolean     // Render-blocking resource
}

export interface PerformanceTrace {
  page_url: string
  total_blocking_time_ms: number
  time_to_interactive_ms: number
  largest_contentful_paint_ms: number
  cumulative_layout_shift: number
  slow_resources: SlowResource[]
  long_tasks: LongTask[]
  render_blocking_resources: string[]
}

export interface SlowResource {
  url: string
  duration_ms: number
  type: string
  size_bytes?: number
}

export interface LongTask {
  duration_ms: number
  start_time_ms: number
  attribution?: string  // Which script caused the long task
}

export interface WooCommerceJSState {
  // Results of JS checks run via DevTools in browser context
  wc_checkout_params_loaded: boolean
  wc_cart_params_loaded: boolean
  stripe_loaded?: boolean
  paypal_loaded?: boolean
  checkout_url?: string
  ajax_url?: string
  cart_hash?: string
  wc_errors_visible: number  // Count of .woocommerce-error elements
  custom_checks: Record<string, boolean>  // From CLAUDE.md custom feature checks
}

export interface DevToolsFlowData {
  session: DevToolsSession
  console_errors: ConsoleErrorDetailed[]
  network_requests: NetworkRequest[]
  network_failures: NetworkRequest[]
  performance_trace?: PerformanceTrace
  wc_js_state?: WooCommerceJSState
  js_executions: JSExecutionResult[]
}

export interface JSExecutionResult {
  expression: string
  result: any
  error?: string
  purpose: string  // Human-readable description of what this check validates
}

export interface CodeAnalysis {
  project_path: string
  theme_name: string
  custom_features_found: string[]
  template_overrides: string[]
  active_hooks: string[]
  potential_issues: CodeIssue[]
  test_recommendations: string[]
}

export interface CodeIssue {
  severity: 'critical' | 'major' | 'minor'
  file: string
  issue: string
  recommendation: string
}

export interface QAReport {
  site: string
  url: string
  tested_at: string
  duration_ms: number
  tester_mode: 'with-code' | 'url-only'

  overall_status: 'PASS' | 'WARNING' | 'CRITICAL'
  summary: string

  blocker_issues: Issue[]
  major_issues: Issue[]
  minor_issues: Issue[]
  code_concerns: Issue[]
  passed_checks: string[]

  lighthouse: LighthouseResult
  page_health: PageHealthResult[]
  wordpress_health: WordPressHealthResult
  flow_results: FlowResult[]
  broken_links: BrokenLink[]
  code_analysis?: CodeAnalysis

  // DevTools-specific aggregated data
  total_console_errors: number
  total_network_failures: number
  critical_js_errors: ConsoleErrorDetailed[]   // Errors on checkout/critical pages
  payment_gateway_status: 'loaded' | 'failed' | 'unknown'
  performance_traces: PerformanceTrace[]

  recommendations: string[]
  screenshots_taken: string[]
  raw_data_file: string
}

export interface Issue {
  id: string
  title: string
  description: string
  location?: string
  how_to_fix?: string
  severity: 'blocker' | 'major' | 'minor'
  category: 'performance' | 'functionality' | 'ui' | 'security' |
            'content' | 'seo' | 'accessibility' | 'code' | 'plugins'
}
```

---

## Site Config File Format

`configs/example-site.yml`:

```yaml
name: "Example WooCommerce Store"
url: "https://staging.example.com"
username: "qa-agent"
app_password: "AbCdEfGhIjKlMnOpQrStUvWx"

# Optional: path to local WordPress project
# project_path: "/Users/developer/projects/example-client"

description: |
  Norwegian ecommerce store selling outdoor equipment.
  Key revenue: product sales via WooCommerce.
  Main concern: checkout completion rate on mobile.

custom_features:
  - "Custom size guide calculator on product pages"
  - "Wishlist functionality via plugin"
  - "Multi-currency support (NOK/EUR)"
  - "Company VAT field on checkout for B2B customers"

critical_flows:
  - "Guest checkout with Stripe"
  - "User registration and first purchase"
  - "Product search and filter by category"
  - "Apply coupon code at checkout"

key_pages:
  - name: "Homepage"
    path: "/"
  - name: "Shop"
    path: "/shop/"
  - name: "Cart"
    path: "/cart/"
  - name: "Checkout"
    path: "/checkout/"
  - name: "My Account"
    path: "/my-account/"
  - name: "Contact"
    path: "/contact/"

known_issues:
  - "Homepage hero image is intentionally large (client decision)"
  - "IE11 not supported — skip IE-specific issues"

run_ecommerce_flow: true
run_auth_flow: true
run_mobile_tests: true
mobile_viewport:
  width: 375
  height: 812

max_links_to_crawl: 40
timeout_ms: 30000
```

---

## CLI Interface

`src/index.ts` — the entry point:

```typescript
#!/usr/bin/env node
import { Command } from 'commander'
import { runQAAgent } from './agent'
import { loadConfig } from './utils/config-loader'
import path from 'path'

const program = new Command()

program
  .name('wp-qa')
  .description('WordPress/WooCommerce QA Agent')
  .version('1.0.0')

program
  .command('run')
  .description('Run a full QA check')
  .option('-c, --config <path>', 'Path to site config YAML file')
  .option('-u, --url <url>', 'Site URL (quick run without config file)')
  .option('--username <username>', 'WordPress username')
  .option('--password <password>', 'WordPress application password')
  .option('--project <path>', 'Local WordPress project path')
  .option('--describe <text>', 'Plain English description of what to test')
  .option('--no-browser', 'Skip browser-based flow tests (faster)')
  .option('--no-lighthouse', 'Skip Lighthouse performance tests')
  .option('--mobile-only', 'Only run mobile viewport tests')
  .option('--output <path>', 'Output directory for reports', './qa-reports')
  .action(async (options) => {
    let config

    if (options.config) {
      config = await loadConfig(options.config)
    } else if (options.url) {
      config = {
        name: options.url,
        url: options.url,
        username: options.username,
        app_password: options.password,
        project_path: options.project,
        description: options.describe,
      }
    } else {
      console.error('Error: provide either --config or --url')
      process.exit(1)
    }

    await runQAAgent(config, {
      skipBrowser: options.noBrowser,
      skipLighthouse: options.noLighthouse,
      mobileOnly: options.mobileOnly,
      outputDir: options.output,
    })
  })

program
  .command('init')
  .description('Create a new site config file interactively')
  .action(async () => {
    // Interactive config creation
    // Ask for site URL, credentials, features
    // Save to configs/[site-name].yml
    console.log('Creating new site config...')
    // Implementation: use readline for interactive prompts
  })

program.parse()
```

---

## Main Orchestrator

`src/agent.ts`:

```typescript
import { SiteConfig, QAReport } from './types'
import { checkPageHealth } from './checks/page-health'
import { runLighthouse } from './checks/lighthouse'
import { findBrokenLinks } from './checks/broken-links'
import { checkWordPressHealth } from './checks/wordpress-api'
import { runEcommerceFlow } from './flows/ecommerce-flow'
import { runAuthFlow } from './flows/auth-flow'
import { runMobileFlow } from './flows/mobile-flow'
import { analyseProjectCode } from './analysis/code-reader'
import { generateReport } from './analysis/report-generator'
import { synthesiseWithGemini } from './analysis/gemini'
import { logger } from './utils/logger'
import fs from 'fs/promises'
import path from 'path'

interface RunOptions {
  skipBrowser?: boolean
  skipLighthouse?: boolean
  mobileOnly?: boolean
  outputDir?: string
}

export async function runQAAgent(
  config: SiteConfig,
  options: RunOptions = {}
): Promise<QAReport> {
  const startTime = Date.now()
  const outputDir = options.outputDir || './qa-reports'
  const screenshotDir = './screenshots'

  await fs.mkdir(outputDir, { recursive: true })
  await fs.mkdir(screenshotDir, { recursive: true })

  logger.info(`\n${'='.repeat(60)}`)
  logger.info(`QA Agent starting for: ${config.name}`)
  logger.info(`URL: ${config.url}`)
  logger.info(`Mode: ${config.project_path ? 'with-code' : 'url-only'}`)
  logger.info(`${'='.repeat(60)}\n`)

  const rawData: any = { config, started_at: new Date().toISOString() }

  // ── STEP 1: Read project code if available ────────────────────────────────
  let codeAnalysis
  if (config.project_path) {
    logger.info('📁 Reading project codebase...')
    codeAnalysis = await analyseProjectCode(config.project_path, config)
    rawData.code_analysis = codeAnalysis
    logger.info(`   Found ${codeAnalysis.custom_features_found.length} custom features`)
    logger.info(`   Found ${codeAnalysis.template_overrides.length} WC template overrides`)
  }

  // ── STEP 2: WordPress health check (REST API) ─────────────────────────────
  logger.info('\n🔌 Checking WordPress health via REST API...')
  const wpHealth = await checkWordPressHealth(config)
  rawData.wordpress_health = wpHealth
  logger.info(`   WordPress ${wpHealth.wp_version}`)
  logger.info(`   ${wpHealth.plugins.length} plugins, ${wpHealth.plugins_needing_update.length} need updates`)
  logger.info(`   WooCommerce: ${wpHealth.woocommerce_detected ? wpHealth.wc_version : 'not detected'}`)

  // ── STEP 3: Page health checks ────────────────────────────────────────────
  logger.info('\n🔗 Checking page health...')
  const pageHealth = await checkPageHealth(config)
  rawData.page_health = pageHealth
  const failedPages = pageHealth.filter(p => !p.ok)
  logger.info(`   ${pageHealth.length} pages checked, ${failedPages.length} failed`)

  // ── STEP 4: Lighthouse performance audit ──────────────────────────────────
  let lighthouseResult
  if (!options.skipLighthouse) {
    logger.info('\n⚡ Running Lighthouse audit...')
    lighthouseResult = await runLighthouse(config.url)
    rawData.lighthouse = lighthouseResult
    logger.info(`   Mobile: ${lighthouseResult.mobile.performance}/100`)
    logger.info(`   Desktop: ${lighthouseResult.desktop.performance}/100`)
  }

  // ── STEP 5: Broken link detection ────────────────────────────────────────
  logger.info('\n🕷️  Scanning for broken links...')
  const brokenLinks = await findBrokenLinks(config)
  rawData.broken_links = brokenLinks
  logger.info(`   ${brokenLinks.length} broken links found`)

  // ── STEP 6: Browser flow tests (Playwright via MCP) ──────────────────────
  const flowResults = []

  if (!options.skipBrowser) {
    // Ecommerce flow
    if (config.run_ecommerce_flow !== false && wpHealth.woocommerce_detected) {
      logger.info('\n🛒 Running WooCommerce ecommerce flow...')
      const ecomFlow = await runEcommerceFlow(config, screenshotDir)
      flowResults.push(ecomFlow)
      const passedSteps = ecomFlow.steps.filter(s => s.status === 'PASS').length
      logger.info(`   ${passedSteps}/${ecomFlow.steps.length} steps passed`)
      if (ecomFlow.console_errors.length > 0) {
        logger.warn(`   ⚠️  ${ecomFlow.console_errors.length} console errors captured`)
      }
    }

    // Auth flow
    if (config.run_auth_flow !== false) {
      logger.info('\n👤 Running authentication flow...')
      const authFlow = await runAuthFlow(config, screenshotDir)
      flowResults.push(authFlow)
    }

    // Mobile flow
    if (config.run_mobile_tests !== false || options.mobileOnly) {
      logger.info('\n📱 Running mobile viewport tests...')
      const mobileFlow = await runMobileFlow(config, screenshotDir)
      flowResults.push(mobileFlow)
    }
  }

  rawData.flow_results = flowResults

  // ── STEP 7: AI synthesis ──────────────────────────────────────────────────
  logger.info('\n🤖 Synthesising findings with Gemini...')
  const aiAnalysis = await synthesiseWithGemini(rawData, config, codeAnalysis)

  // ── STEP 8: Generate final report ─────────────────────────────────────────
  logger.info('\n📄 Generating report...')
  const report = await generateReport({
    config,
    rawData,
    aiAnalysis,
    codeAnalysis,
    startTime,
    outputDir,
  })

  // Save raw data for debugging
  const rawFile = path.join(outputDir, `${Date.now()}-raw.json`)
  await fs.writeFile(rawFile, JSON.stringify(rawData, null, 2))
  report.raw_data_file = rawFile

  // Print summary to terminal
  printSummary(report)

  return report
}

function printSummary(report: QAReport) {
  const statusEmoji = {
    PASS: '✅',
    WARNING: '⚠️',
    CRITICAL: '🚨'
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`${statusEmoji[report.overall_status]} OVERALL STATUS: ${report.overall_status}`)
  console.log(`${'='.repeat(60)}`)
  console.log(`\n${report.summary}\n`)

  if (report.blocker_issues.length > 0) {
    console.log(`🚨 BLOCKER ISSUES (${report.blocker_issues.length}):`)
    report.blocker_issues.forEach(i => console.log(`  • ${i.title}`))
  }

  if (report.major_issues.length > 0) {
    console.log(`\n⚠️  MAJOR ISSUES (${report.major_issues.length}):`)
    report.major_issues.forEach(i => console.log(`  • ${i.title}`))
  }

  console.log(`\n📋 Full report: ${report.raw_data_file.replace('-raw.json', '-report.md')}`)
  console.log(`⏱️  Duration: ${Math.round(report.duration_ms / 1000)}s\n`)
}
```

---

## Key Implementation Details

### WordPress REST API Check (`src/checks/wordpress-api.ts`)

```typescript
import { SiteConfig, WordPressHealthResult, PluginInfo } from '../types'
import { getAuthHeader } from '../utils/wordpress-auth'

export async function checkWordPressHealth(
  config: SiteConfig
): Promise<WordPressHealthResult> {
  const baseUrl = config.url.replace(/\/$/, '')
  const headers: HeadersInit = { 'Content-Type': 'application/json' }

  if (config.username && config.app_password) {
    headers['Authorization'] = getAuthHeader(config.username, config.app_password)
  }

  const result: WordPressHealthResult = {
    site_name: '',
    wp_version: 'Unknown',
    woocommerce_detected: false,
    plugins: [],
    plugins_needing_update: [],
    inactive_plugins: [],
    rest_api_accessible: false,
  }

  // Test REST API accessibility
  try {
    const siteRes = await fetch(`${baseUrl}/wp-json/`, { headers })
    if (siteRes.ok) {
      result.rest_api_accessible = true
      const siteData = await siteRes.json()
      result.site_name = siteData.name || ''

      // Detect WooCommerce from namespaces
      const namespaces: string[] = siteData.namespaces || []
      result.woocommerce_detected = namespaces.some(ns =>
        ns.startsWith('wc/') || ns.startsWith('woocommerce')
      )
    }
  } catch (e) {
    result.rest_api_accessible = false
    return result
  }

  // Get plugin list (requires auth)
  if (config.username && config.app_password) {
    try {
      const pluginRes = await fetch(`${baseUrl}/wp-json/wp/v2/plugins`, { headers })
      if (pluginRes.ok) {
        const plugins = await pluginRes.json()

        result.plugins = plugins.map((p: any): PluginInfo => ({
          name: p.name,
          slug: p.plugin,
          version: p.version,
          status: p.status,
          update_available: !!p.update,
          update_version: p.update?.version,
          // Flag common premium plugins by slug pattern
          is_premium: isPremiumPlugin(p.plugin),
        }))

        result.plugins_needing_update = result.plugins.filter(p => p.update_available)
        result.inactive_plugins = result.plugins.filter(p => p.status === 'inactive')

        // Get WooCommerce version
        const wcPlugin = result.plugins.find(p =>
          p.slug.includes('woocommerce/woocommerce')
        )
        if (wcPlugin) {
          result.wc_version = wcPlugin.version
        }
      }
    } catch (e) {
      // Plugins endpoint failed — auth may be wrong
    }

    // Check WooCommerce template overrides
    if (result.woocommerce_detected) {
      try {
        const wcStatus = await fetch(
          `${baseUrl}/wp-json/wc/v3/system_status`,
          { headers: { ...headers, 'Authorization': getAuthHeader(config.username, config.app_password) }}
        )
        if (wcStatus.ok) {
          const status = await wcStatus.json()
          const outdatedTemplates = status.theme?.has_outdated_templates
          if (outdatedTemplates) {
            result.wc_template_overrides_outdated =
              status.theme?.overrides?.filter((t: any) => t.outdated).map((t: any) => t.file) || []
          }
        }
      } catch (e) {
        // WC system status not accessible
      }
    }
  }

  return result
}

function isPremiumPlugin(slug: string): boolean {
  const premiumSlugs = [
    'woocommerce-subscriptions', 'woocommerce-memberships',
    'gravityforms', 'advanced-custom-fields-pro', 'acf-pro',
    'elementor-pro', 'wpml', 'polylang-pro', 'yoast-seo-premium',
    'wp-rocket', 'imagify', 'searchie', 'wpforms-lite'
  ]
  return premiumSlugs.some(premium => slug.toLowerCase().includes(premium))
}
```

### Lighthouse Check (`src/checks/lighthouse.ts`)

```typescript
import { LighthouseResult } from '../types'

export async function runLighthouse(url: string): Promise<LighthouseResult> {
  const apiBase = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed'
  const categories = ['performance', 'accessibility', 'best-practices', 'seo']

  async function fetchForStrategy(strategy: 'mobile' | 'desktop') {
    const params = new URLSearchParams({
      url,
      strategy,
      ...Object.fromEntries(categories.map(c => [`category`, c]))
    })
    // Note: URLSearchParams doesn't handle duplicate keys well
    // Build URL manually for multiple category params
    const catParams = categories.map(c => `category=${c}`).join('&')
    const fullUrl = `${apiBase}?url=${encodeURIComponent(url)}&strategy=${strategy}&${catParams}`

    const res = await fetch(fullUrl, { signal: AbortSignal.timeout(60000) })
    if (!res.ok) throw new Error(`PageSpeed API returned ${res.status}`)
    return res.json()
  }

  const [mobileData, desktopData] = await Promise.all([
    fetchForStrategy('mobile').catch(() => null),
    fetchForStrategy('desktop').catch(() => null),
  ])

  const extractScores = (data: any) => {
    if (!data) return { performance: 0, accessibility: 0, best_practices: 0, seo: 0 }
    const cats = data?.lighthouseResult?.categories || {}
    return {
      performance:    Math.round((cats.performance?.score || 0) * 100),
      accessibility:  Math.round((cats.accessibility?.score || 0) * 100),
      best_practices: Math.round((cats['best-practices']?.score || 0) * 100),
      seo:            Math.round((cats.seo?.score || 0) * 100),
    }
  }

  const extractCWV = (data: any) => {
    const audits = data?.lighthouseResult?.audits || {}
    return {
      lcp_ms:  Math.round((audits['largest-contentful-paint']?.numericValue || 0)),
      fid_ms:  Math.round((audits['max-potential-fid']?.numericValue || 0)),
      cls:     parseFloat((audits['cumulative-layout-shift']?.numericValue || 0).toFixed(3)),
      fcp_ms:  Math.round((audits['first-contentful-paint']?.numericValue || 0)),
      ttfb_ms: Math.round((audits['server-response-time']?.numericValue || 0)),
    }
  }

  return {
    url,
    mobile:          extractScores(mobileData),
    desktop:         extractScores(desktopData),
    core_web_vitals: extractCWV(mobileData),
  }
}
```

### Ecommerce Flow (`src/flows/ecommerce-flow.ts`)

This uses Playwright MCP. Claude Code controls the browser through natural
language MCP tool calls:

```typescript
import { SiteConfig, FlowResult, FlowStep, ConsoleError, NetworkFailure } from '../types'
import path from 'path'

export async function runEcommerceFlow(
  config: SiteConfig,
  screenshotDir: string
): Promise<FlowResult> {
  // This function is called by Claude Code which has Playwright MCP available
  // The actual browser control happens through MCP tool calls in the agent
  // This file defines the flow structure and step definitions

  const result: FlowResult = {
    flow_name: 'WooCommerce Ecommerce Flow',
    steps: [],
    passed: false,
    console_errors: [],
    network_failures: [],
    screenshots: [],
  }

  // Steps are defined as structured instructions for Claude Code to execute
  // via Playwright MCP. Claude reads these and executes each step.
  const flowSteps = [
    {
      id: 'homepage',
      instruction: `Navigate to ${config.url} and verify it loads correctly.
        Check for: page title, navigation menu, no error messages visible.`,
      screenshot: 'flow-01-homepage.png',
    },
    {
      id: 'shop_browse',
      instruction: `Navigate to the shop page (try /shop/ or find the shop link).
        Verify products are visible. Note how many products are shown.
        Check for: product images loading, prices visible, add to cart buttons.`,
      screenshot: 'flow-02-shop.png',
    },
    {
      id: 'product_page',
      instruction: `Click on the first product to open its product page.
        Verify: product title, price, description visible.
        Check: add to cart button present, product images loading.
        Note any custom features like size guides, colour swatches, quantity fields.`,
      screenshot: 'flow-03-product.png',
    },
    {
      id: 'add_to_cart',
      instruction: `Click the Add to Cart button.
        Verify: cart count updates in header, success notice appears.
        If product has variations (size/colour), select the first available option first.`,
      screenshot: 'flow-04-add-to-cart.png',
    },
    {
      id: 'view_cart',
      instruction: `Navigate to /cart/.
        Verify: the product we added is in the cart, quantity shown, price shown.
        Check: update cart button, remove item option, proceed to checkout button.
        Note: any upsells or cross-sells shown.`,
      screenshot: 'flow-05-cart.png',
    },
    {
      id: 'checkout',
      instruction: `Click Proceed to Checkout or navigate to /checkout/.
        Verify: checkout form loads with billing fields.
        Check: first name, last name, email, address fields visible.
        Check: payment gateway section visible (Stripe, PayPal, or other).
        Check: order summary visible on right side.
        DO NOT submit the form.`,
      screenshot: 'flow-06-checkout.png',
    },
    {
      id: 'checkout_mobile',
      instruction: `Resize viewport to 375x812 (iPhone size).
        Navigate to /checkout/ again.
        Verify: form is still usable on mobile, fields not cut off.
        Check: payment section visible when scrolling down.
        Note any layout issues.`,
      screenshot: 'flow-07-checkout-mobile.png',
    },
  ]

  // Note to Claude Code: execute each step using Playwright MCP tools
  // Capture console errors and network failures throughout
  // Take screenshots at each step
  // Record pass/fail for each step with specific observations

  return result
}
```

### Gemini Synthesis (`src/analysis/gemini.ts`)

```typescript
import { SiteConfig, CodeAnalysis } from '../types'

const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-pro:generateContent'

export async function synthesiseWithGemini(
  rawData: any,
  config: SiteConfig,
  codeAnalysis?: CodeAnalysis
): Promise<string> {
  if (!GEMINI_API_KEY) {
    return 'Gemini API key not configured. Raw data available in output file.'
  }

  const codeContext = codeAnalysis ? `
CODE ANALYSIS (from local project):
- Theme: ${codeAnalysis.theme_name}
- Custom features found: ${codeAnalysis.custom_features_found.join(', ')}
- Template overrides: ${codeAnalysis.template_overrides.join(', ')}
- Potential code issues: ${JSON.stringify(codeAnalysis.potential_issues, null, 2)}
- Test recommendations from code: ${codeAnalysis.test_recommendations.join(', ')}
` : ''

  const knownIssues = config.known_issues?.length
    ? `\nKNOWN ISSUES (do not flag these): ${config.known_issues.join(', ')}`
    : ''

  const prompt = `
You are a senior QA engineer for WordPress/WooCommerce websites.
Review this complete QA audit data and produce a structured report.

SITE: ${config.name} (${config.url})
DESCRIPTION: ${config.description || 'WordPress/WooCommerce site'}
${knownIssues}
${codeContext}

RAW AUDIT DATA:
${JSON.stringify(rawData, null, 2)}

Produce a QA report in this exact JSON structure:
{
  "overall_status": "PASS|WARNING|CRITICAL",
  "summary": "2-3 sentence executive summary",
  "blocker_issues": [
    {
      "id": "unique-id",
      "title": "Short title",
      "description": "What is happening and where",
      "location": "URL or file or feature",
      "how_to_fix": "Specific actionable fix",
      "severity": "blocker",
      "category": "functionality|performance|ui|security|content|seo|accessibility|code|plugins"
    }
  ],
  "major_issues": [...same structure...],
  "minor_issues": [...same structure...],
  "code_concerns": [...same structure...],
  "passed_checks": ["list of things that are working correctly"],
  "recommendations": ["Top 5 prioritised actions for this week"],
  "performance_verdict": "Plain English performance assessment",
  "ecommerce_verdict": "Assessment of whether checkout flow is functional"
}

Rules:
- Blocker = user cannot complete a purchase or core action
- Major = significant problem affecting experience but not fully blocking
- Minor = nice to have, cosmetic, low impact
- Be specific — include actual URLs, line numbers, plugin names where you know them
- If Lighthouse mobile performance is under 50, that is a major issue
- If checkout returns non-200, that is a blocker
- Flag any console JS errors on checkout as at minimum major issues
- WooCommerce template overrides that are outdated are major issues
- Plugins needing security updates are major issues
- Inactive plugins are minor issues (recommend reviewing/removing)
- Return ONLY valid JSON, no markdown, no preamble
`

  const response = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 8000,
        temperature: 0.1,
        responseMimeType: 'application/json',
      }
    })
  })

  const data = await response.json()
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '{}'
}
```

---

## Environment Variables

`.env.example`:
```bash
# Google Gemini API Key (get free key at aistudio.google.com)
GEMINI_API_KEY=your-gemini-api-key-here

# Optional: Google PageSpeed API key (increases rate limits)
# Without this key, PageSpeed API works but with lower rate limits
# Get free key at console.developers.google.com
PAGESPEED_API_KEY=

# Output settings
QA_OUTPUT_DIR=./qa-reports
QA_SCREENSHOT_DIR=./screenshots
```

---

## Package.json

```json
{
  "name": "wp-qa-agent",
  "version": "1.0.0",
  "description": "WordPress/WooCommerce QA Agent",
  "main": "dist/index.js",
  "bin": {
    "wp-qa": "dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "ts-node src/index.ts",
    "start": "node dist/index.js",
    "qa": "ts-node src/index.ts run"
  },
  "dependencies": {
    "commander": "^12.0.0",
    "js-yaml": "^4.1.0",
    "dotenv": "^16.0.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "@types/node": "^20.0.0",
    "@types/js-yaml": "^4.0.0",
    "ts-node": "^10.0.0"
  }
}
```

Note: Playwright is used via MCP server, not as a direct npm dependency.
The @playwright/mcp package is installed globally, not in package.json.

---

## .claude/settings.json (MCP Configuration)

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp", "--headless"],
      "env": {}
    },
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest", "--headless"],
      "env": {}
    }
  }
}
```

**What each MCP server provides:**

Playwright MCP tools used in this project:
- `playwright_navigate` — go to a URL
- `playwright_click` — click an element by text/role/selector
- `playwright_fill` — type into a form field
- `playwright_screenshot` — capture screenshot
- `playwright_get_text` — read visible page content
- `playwright_select_option` — choose from dropdowns
- `playwright_hover` — hover over elements
- `playwright_resize` — change viewport for mobile testing

Chrome DevTools MCP tools used in this project:
- `chrome_navigate` — navigate and wait for network idle
- `chrome_get_console_logs` — get all console messages with source maps
- `chrome_get_network_requests` — full request/response log
- `chrome_execute_script` — run JavaScript in page context
- `chrome_start_performance_trace` — begin recording performance
- `chrome_stop_performance_trace` — end recording, get trace data
- `chrome_get_page_errors` — specifically JS errors with stack traces
- `chrome_screenshot` — screenshot with DevTools annotations possible

---

## .gitignore

```
node_modules/
dist/
.env
qa-reports/
screenshots/
*.log
configs/*.yml  # Don't commit site configs with credentials
!configs/example-site.yml  # Keep example
```

---

## Build Instructions for Claude Code

When building this project, follow this sequence:

### Phase 1 — Foundation (build first)
1. Create project structure and package.json
2. Install dependencies
3. Build all TypeScript interfaces in `src/types/index.ts`
4. Build utility functions:
   - `src/utils/wordpress-auth.ts` — Base64 auth header builder
   - `src/utils/config-loader.ts` — YAML config loader
   - `src/utils/logger.ts` — Coloured terminal logger
5. Build `src/checks/wordpress-api.ts`
6. Build `src/checks/page-health.ts`
7. Build `src/checks/lighthouse.ts`
8. Build `src/checks/broken-links.ts`

### Phase 2 — Browser Flows (build second)
9. Build `src/browser/playwright-runner.ts`
   Provides helper functions for Playwright MCP tool calls.
   Handles user-level interactions: navigate, click, fill, screenshot.
   The actual MCP tool calls happen through Claude Code's native MCP integration.

10. Build `src/browser/devtools-runner.ts`
    Provides helper functions for DevTools MCP tool calls.
    Handles browser internals: console capture, network monitor,
    JS execution, performance trace start/stop.

    Key functions to implement:
    - `startNetworkMonitor(pageUrl)` — begin capturing all requests
    - `stopNetworkMonitor()` → `NetworkRequest[]` — return captured requests
    - `getConsoleErrors()` → `ConsoleErrorDetailed[]` — errors with source maps
    - `executeWCChecks(siteUrl)` → `WooCommerceJSState` — run all WC JS checks
    - `startPerformanceTrace()` — begin trace recording
    - `stopPerformanceTrace()` → `PerformanceTrace` — end and return data
    - `runJSCheck(expression, purpose)` → `JSExecutionResult`

    WooCommerce JS checks to run in browser context (via chrome_execute_script):
    ```javascript
    // Check WC core scripts loaded
    typeof wc_checkout_params !== 'undefined'
    typeof wc_cart_params !== 'undefined'
    typeof woocommerce_params !== 'undefined'

    // Check payment gateways loaded
    typeof Stripe !== 'undefined'
    typeof paypal !== 'undefined'

    // Check for visible WC errors on page
    document.querySelectorAll('.woocommerce-error li').length

    // Check checkout endpoint is correct
    typeof wc_checkout_params !== 'undefined' && wc_checkout_params.checkout_url

    // Check AJAX URL is set
    typeof wc_checkout_params !== 'undefined' && wc_checkout_params.ajax_url

    // Check cart is not empty (on checkout page)
    typeof wc_cart_params !== 'undefined' && parseInt(wc_cart_params.cart_count) > 0
    ```

11. Build `src/flows/ecommerce-flow.ts`
12. Build `src/flows/auth-flow.ts`
13. Build `src/flows/mobile-flow.ts`

### Phase 3 — Intelligence (build third)
14. Build `src/analysis/code-reader.ts`
    Reads a local WordPress project and extracts:
    - Theme name and structure
    - Custom post types registered
    - WooCommerce template overrides
    - Custom hooks and filters
    - Plugin-specific customisations
15. Build `src/analysis/gemini.ts`
16. Build `src/analysis/report-generator.ts`
    Compiles all raw data + AI analysis into a Markdown report

### Phase 4 — CLI and Orchestration (build last)
17. Build `src/agent.ts` — main orchestrator
18. Build `src/index.ts` — CLI entry point
19. Build `src/index.ts` — `init` command for interactive config creation

### After building — test immediately
```bash
# Install dependencies
npm install

# Install Playwright MCP globally
npm install -g @playwright/mcp
npx playwright install chromium

# Install Chrome DevTools MCP globally
npm install -g chrome-devtools-mcp

# OR add directly via Claude Code CLI (recommended — auto-configures)
claude mcp add chrome-devtools npx chrome-devtools-mcp@latest

# Create .env
cp .env.example .env
# Add your GEMINI_API_KEY

# Test against a site — no browser (fastest, good first check)
npx ts-node src/index.ts run --url https://demo.woocommerce.com --no-browser

# Full test with Playwright flows only (no DevTools)
npx ts-node src/index.ts run --url https://demo.woocommerce.com --no-devtools

# Full test with both MCPs (the complete experience)
npx ts-node src/index.ts run --url https://demo.woocommerce.com
```

---

## How The Two MCPs Work Together

### Playwright MCP — User Layer

Claude Code does NOT import Playwright as a library. Instead:

1. The `.claude/settings.json` registers the Playwright MCP server
2. Claude Code calls Playwright MCP tools to drive user interactions:
   - `playwright_navigate` — go to a URL
   - `playwright_click` — click by visible text, role, or selector
   - `playwright_fill` — type into form fields
   - `playwright_screenshot` — capture the screen
   - `playwright_get_text` — read visible page content
3. Claude Code interprets what it sees and adapts to the actual UI
4. No CSS selectors are pre-configured — Claude reads the page
   the same way a human QA engineer would

This means the agent works on ANY WordPress theme without setup.

### Chrome DevTools MCP — Browser Internals Layer

Running simultaneously with Playwright, DevTools MCP gives Claude
direct access to the browser's internal state:

1. **Before each flow starts:**
   - Start network monitor to capture all requests
   - Note current console error count as baseline

2. **During each flow step:**
   - Playwright drives the interaction
   - DevTools silently captures everything happening underneath

3. **After checkout page loads specifically:**
   - `chrome_execute_script` → run WooCommerce JS state checks
   - Verify `wc_checkout_params` loaded correctly
   - Verify payment gateway script (Stripe/PayPal) initialised
   - Count any `.woocommerce-error` elements
   - Check `wc_checkout_params.checkout_url` is correct

4. **After complete flow:**
   - `chrome_get_console_logs` → all errors with source-mapped stack traces
   - `chrome_get_network_requests` → full request log, filter failures
   - `chrome_stop_performance_trace` → frame-by-frame performance data

### The Combined Flow Pattern

```
FOR EACH BROWSER FLOW:

  [DevTools MCP] startNetworkMonitor()
  [DevTools MCP] startPerformanceTrace()  (on checkout flow only)

  [Playwright MCP] navigate to page
  [Playwright MCP] perform user interactions
  [Playwright MCP] take screenshot

  [DevTools MCP] getConsoleErrors() → with source maps
  [DevTools MCP] getNetworkFailures() → filter by status/error
  [DevTools MCP] executeWCChecks() → verify WC JS state

  IF checkout page:
    [DevTools MCP] stopPerformanceTrace() → timing data
    [DevTools MCP] runJSCheck('typeof Stripe !== undefined') → payment gateway
    [DevTools MCP] runJSCheck('wc_checkout_params.checkout_url') → endpoint

  Combine Playwright result + DevTools data → FlowResult with DevToolsFlowData
```

### What This Produces for the Report

Without DevTools MCP:
> *Checkout: PASS — page loaded, form visible, payment section present*

With DevTools MCP:
> *Checkout: WARNING — page loaded and form visible, but:*
> *• 3 console errors during load (wc-cart-fragments.js:42 — AJAX call*
>   *to /?wc-ajax=get_refreshed_fragments returned 403)*
> *• Stripe script took 2.8s to load (blocking checkout render)*
> *• 1 failed network request to analytics.google.com (non-critical)*
> *• wc_checkout_params.checkout_url confirmed correct*
> *• Stripe initialised successfully after delay*
> *→ Recommend investigating cart fragments 403 — likely a caching*
>   *plugin blocking the AJAX endpoint*

---

## Code Reader Implementation

`src/analysis/code-reader.ts` must:

1. Walk the WordPress project directory
2. Read `functions.php` — extract registered post types, hooks, shortcodes
3. Read `woocommerce/` directory — list all template overrides
4. Read plugin files in `wp-content/plugins/` — identify custom plugins vs
   third-party ones
5. Scan for common patterns:
   - `add_action('woocommerce_*')` — custom WC hooks
   - `register_post_type()` — custom post types
   - `wc_get_template()` or `woocommerce_locate_template` — template usage
   - API integrations (look for API keys or endpoint URLs in code)
   - Custom checkout fields (`woocommerce_checkout_fields` filter)
6. Read `theme.json` if it exists — extract design tokens
7. Check composer.json / package.json for dependencies
8. Generate a structured summary that becomes Gemini context

Important: Do NOT load entire files into context. Read key sections only.
Use grep/find patterns to extract relevant code snippets.

---

## Report Generator

`src/analysis/report-generator.ts` produces a Markdown file:

```markdown
# QA Report — [Site Name]
Generated: [timestamp]
Duration: [seconds]
Tester: wp-qa-agent v1.0.0

## Overall Status: [PASS/WARNING/CRITICAL]

[Executive summary paragraph]

---

## 🚨 Blocker Issues ([count])

### 1. [Issue title]
**Category:** [category]
**Location:** [URL or file]
**What's happening:** [description]
**How to fix:** [specific fix]

[... more issues ...]

---

## ⚠️ Major Issues ([count])
[... same structure ...]

---

## 💡 Minor Issues ([count])
[... same structure ...]

---

## 🔌 Plugin Health
| Plugin | Current | Available | Status |
|--------|---------|-----------|--------|
[... table of plugins with updates ...]

Inactive plugins to review: [list]

---

## ⚡ Performance
| Metric | Mobile | Desktop | Target |
|--------|--------|---------|--------|
| Performance | [score] | [score] | >70 |
| LCP | [ms] | - | <2500ms |
[... etc ...]

Performance Trace (from DevTools MCP — checkout page):
- Total Blocking Time: [ms]
- Time to Interactive: [ms]
- Render-blocking resources: [list]
- Slow resources: [list with times]
- Long tasks detected: [count] ([longest] ms)

[Performance verdict]

---

## 🛒 WooCommerce
[Ecommerce verdict]

Flow test results:
[... step by step results ...]

WooCommerce JS State (verified via DevTools):
- wc_checkout_params: [loaded/missing]
- wc_cart_params: [loaded/missing]
- Payment gateway (Stripe/PayPal): [loaded/failed/not-detected]
- Checkout URL: [url or error]
- Cart errors visible on checkout: [count]

---

## 🌐 Network Analysis (from DevTools MCP)
Total requests: [count]
Failed requests: [count]
Third-party failures: [list]
Slowest requests:
| URL | Duration | Type | Impact |
|-----|----------|------|--------|
[... top 5 slowest ...]

---

## 🖥️ Console Errors (from DevTools MCP — source mapped)
[count] unique errors detected

### Critical (on checkout/cart pages):
| Error | File | Line | Count | Impact |
|-------|------|------|-------|--------|
[... errors with source maps ...]

### Other pages:
[... grouped by page ...]

---

## 📱 Mobile
[Mobile test results and screenshots]

---

## 💻 Code Analysis
[If project code was available]
[Custom features tested]
[Template overrides found]
[Code concerns]

---

## ✅ Checks Passed
[List of everything working correctly]

---

## Top 5 Recommendations This Week
1. [Most important]
2. [Second most important]
[... etc ...]

---

## Test Details
- Pages checked: [count]
- Links crawled: [count]
- Screenshots taken: [count]
- Console errors captured: [count] ([count] with source maps via DevTools)
- Network requests captured: [count] ([count] failed)
- Performance traces recorded: [count]
- JS checks executed in browser: [count]
```

---

## Usage Examples

Once built, usage is:

```bash
# Quick check — just a URL
wp-qa run --url https://yoursite.com

# Full check with credentials
wp-qa run \
  --url https://yoursite.com \
  --username qa-agent \
  --password AbCdEfGhIjKlMnOpQrStUvWx

# Full check with local project code
wp-qa run \
  --config configs/my-client.yml \
  --project /path/to/wordpress/project

# Fast check — skip browser flows
wp-qa run --url https://yoursite.com --no-browser

# Create a new site config
wp-qa init
```

---

## What This Produces

Every run generates in `qa-reports/`:

```
qa-reports/
├── 2026-03-17-client-name-report.md    ← Human-readable Markdown report
├── 2026-03-17-client-name-raw.json     ← Full raw data for debugging
└── screenshots/
    ├── flow-01-homepage.png
    ├── flow-02-shop.png
    ├── flow-03-product.png
    ├── flow-04-add-to-cart.png
    ├── flow-05-cart.png
    ├── flow-06-checkout.png
    └── flow-07-checkout-mobile.png
```

---

## Important Notes for Claude Code

1. **Two MCPs, two layers.** Playwright MCP drives user interactions.
   DevTools MCP observes browser internals simultaneously. Never use
   DevTools MCP to drive navigation — use it only to inspect/monitor.
   Never use Playwright MCP to inspect console or network — use DevTools.

2. **The Playwright MCP integration.** When executing browser flows,
   use the MCP playwright tools naturally — navigate to URLs, click
   elements by their visible text or role, take screenshots.
   Do not try to import Playwright as a Node module.

3. **The DevTools MCP integration.** Use chrome DevTools MCP tools
   to run JavaScript checks, capture console logs with source maps,
   and monitor network requests. Key tools:
   - Always start network monitoring BEFORE Playwright navigates
   - Run JS checks AFTER Playwright confirms page has loaded
   - Take performance traces on the checkout flow specifically
   - Source-mapped errors are far more useful than raw ones — always
     use DevTools for error capture, not Playwright console events

4. **WooCommerce JS checks are critical.** A checkout page can visually
   look fine (Playwright passes) but be broken underneath because
   `wc_checkout_params` didn't load or Stripe failed to initialise.
   Always run the WC JS state checks via DevTools on the checkout page.
   These are blocker-level issues if they fail.

5. **For the code reader**, prioritise reading key files over reading
   everything. functions.php, woocommerce/ directory, and any custom
   plugin files are most valuable. Avoid loading minified JS/CSS files.

6. **The Gemini API call is the expensive step** — make it once with
   all data compiled (including all DevTools data), not multiple times
   for each check. Pass ALL DevTools findings including source-mapped
   errors, network failures, and WC JS state to Gemini for synthesis.

7. **Error handling is critical throughout.** If DevTools MCP fails to
   connect (Chrome not available in headless mode), fall back gracefully
   to Playwright-only mode and note in report that source-mapped errors
   and network details are unavailable. Never crash the entire run.

8. **The flow test files define INTENT not implementation.** Claude Code
   reads the step descriptions and executes them via Playwright MCP,
   adapting to the actual UI it encounters. DevTools MCP runs in the
   background throughout — it doesn't need step-by-step instructions,
   just start it before the flow and query it after.
