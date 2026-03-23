# QA Agent — WordPress/WooCommerce QA Testing Tool

Autonomous QA testing agent for WordPress and WooCommerce sites. Runs automated checks + AI-powered browser testing and produces a structured QA report.

Works in two modes:
- **Mode A (with project code)** — Reads your local WordPress codebase first, understands custom features, then tests the live site with full context
- **Mode B (URL only)** — Tests any site given just a URL and optional credentials

---

## Quick Start

### 1. Clone and setup

```bash
git clone https://bitbucket.org/ninestack/wp-qa-agent.git
cd wp-qa-agent
```

**Windows:** Double-click `setup.bat` — it handles everything interactively.

**Manual setup:**
```bash
npm install
npx playwright install chromium
npx tsc
cp .env.example .env
```

### 2. Run a QA audit

**With Claude Code (recommended — fully autonomous):**
```bash
claude
# then type:
/qa-agent https://staging.your-site.com
```

**CLI directly:**
```bash
npx qa-agent run --url https://staging.your-site.com
```

**With WordPress credentials (unlocks plugin checks + WooCommerce health):**
```bash
npx qa-agent run --url https://staging.your-site.com \
  --username qa-user --password your-app-password
```

**With local project code (enables code analysis + code review):**
```bash
npx qa-agent run --url https://staging.your-site.com \
  --project /path/to/your/wordpress/theme
```

**With a site config file:**
```bash
npx qa-agent run --config configs/my-site.yml
```

### 3. Reports

Reports are saved to `qa-reports/<site>-<date>/`:

```
qa-reports/my-site-2026-03-23/
├── final-report.md          # The report you read
├── final-report.pdf         # Same in PDF
├── layer1-report.md         # Detailed automated check data
├── layer1-results.json      # Raw structured data
├── fixable-issues.json      # Issues structured for AI fix prompts
├── layer2-prompt.md         # Investigation prompt for Layer 2
├── layer2-findings.json     # Layer 2 browser test results
└── screenshots/             # Screenshots from browser tests
```

---

## How It Works

### Layer 1 — Automated Checks (runs via CLI)

| Check | What it does |
|-------|-------------|
| **Security Scan** | 100+ checks: exposed files, headers, XSS patterns, XML-RPC, user enumeration, cookies, CORS, malware, WAF detection |
| **Code Review** | Scans PHP/JS against review standards: escaping, nonces, SQL injection, WC CRUD usage, hardcoded credentials |
| **Code Analysis** | Deep scan of theme: custom post types, hooks, REST endpoints, checkout fields, template overrides, feature detection |
| **WordPress Health** | REST API, plugin versions, update availability, WooCommerce detection |
| **Lighthouse** | Google PageSpeed scores (mobile + desktop), Core Web Vitals |
| **Page Health** | HTTP status codes, load times, redirects for all discovered pages |
| **Broken Links** | Crawls site and finds 404s |
| **Console & Network** | Browser console errors, network failures, WooCommerce JS state |
| **Accessibility** | WCAG 2.1 AA: alt text, labels, headings, contrast, focus, touch targets |
| **Performance** | Page weight, render-blocking resources, third-party scripts, caching, compression |
| **WP Core Health** | WP/PHP version status, debug mode, SSL, HTTPS redirect, object cache, cron |
| **Image Audit** | Oversized images, missing dimensions, lazy loading, WebP/AVIF support |
| **Error Logs** | Fetches debug.log/error_log, groups errors by severity |

### Layer 2 — AI-Powered Browser Testing (runs via Claude Code)

Claude reads your project code to understand custom features, then opens a real browser to test:

- Full WooCommerce checkout flow (shop → product → cart → checkout)
- Custom features detected from code (size guides, custom fields, payment integrations)
- Visual assessment (broken images, overlapping text, placeholder content)
- Mobile responsiveness (375x812 viewport)
- Form validation and AJAX interactions
- Error impact assessment (do console errors actually affect users?)

---

## WordPress Credentials

To unlock full plugin and WooCommerce health checks, create an Application Password:

1. Go to **WP Admin → Users → Your Profile**
2. Scroll to **Application Passwords**
3. Enter name: `QA Agent`
4. Click **Add New Application Password**
5. Copy the generated password

Use it with `--username` and `--password`, or add to your site config YAML.

---

## Site Config Files

For sites you test regularly, create a YAML config in `configs/`:

```yaml
name: "My Client Site"
url: "https://staging.example.com"
username: "qa-agent"
app_password: "xxxx xxxx xxxx xxxx xxxx xxxx"

# Local project path for code analysis (Mode A)
project_path: "/path/to/wordpress/theme"

description: |
  E-commerce site selling outdoor equipment.
  Main concern: checkout completion rate on mobile.

custom_features:
  - "Custom size guide calculator on product pages"
  - "Multi-currency support (NOK/EUR)"

critical_flows:
  - "Guest checkout with Stripe"
  - "Apply coupon code at checkout"

known_issues:
  - "Homepage hero image is intentionally large"

max_links_to_crawl: 30
timeout_ms: 30000
```

See `configs/example-site.yml` for a full example.

---

## All CLI Commands

| Command | Description |
|---------|-------------|
| `npx qa-agent run` | Run full QA audit |
| `npx qa-agent check-updates` | Check for plugin updates (read-only) |
| `npx qa-agent update` | Update plugins with regression detection |
| `npx qa-agent update-templates` | Update outdated WooCommerce template overrides |
| `npx qa-agent fix --report <dir>` | Generate AI fix prompts from QA findings |
| `npx qa-agent merge --report <dir>` | Re-merge Layer 1 + Layer 2 into final report |
| `npx qa-agent setup` | Install helper MU-plugin for plugin updates |
| `npx qa-agent init` | Create a new site config file |

### Run options

```
--url <url>              Site URL
--config <path>          Path to site config YAML
--username <user>        WordPress username
--password <pass>        WordPress application password
--project <path>         Local WordPress project path
--skip-browser           Skip browser tests (API + Lighthouse only)
--skip-lighthouse        Skip Lighthouse audit
--output <path>          Output directory (default: ./qa-reports)
```

---

## Environment Variables

Set in `.env`:

| Variable | Required | Description |
|----------|----------|-------------|
| `PAGESPEED_API_KEY` | Optional | Google PageSpeed API key — improves Lighthouse rate limits. Get free at [Google Console](https://console.developers.google.com) |
| `QA_OUTPUT_DIR` | Optional | Report output directory (default: `./qa-reports`) |
| `QA_SCREENSHOT_DIR` | Optional | Screenshot directory (default: `./screenshots`) |

---

## Requirements

- **Node.js** v18+ (v22 recommended)
- **Claude Code** — for `/qa-agent` autonomous mode and Layer 2 testing
- **Playwright** — installed automatically by setup.bat / `npx playwright install chromium`

---

## Project Structure

```
wp-qa-agent/
├── .claude/
│   ├── commands/qa-agent.md    # /qa-agent slash command
│   └── settings.json           # Playwright MCP permissions
├── src/
│   ├── cli.ts                  # CLI entry point
│   ├── types.ts                # All TypeScript interfaces
│   ├── layer1/
│   │   ├── runner.ts           # Layer 1 orchestrator
│   │   ├── report.ts           # Report generator
│   │   └── checks/             # 13 check modules
│   ├── layer2/
│   │   ├── instructions.md     # Layer 2 testing instructions
│   │   ├── prompt-builder.ts   # Generates Layer 2 prompt
│   │   └── report-merger.ts    # Merges L1 + L2 reports
│   ├── fix/                    # Fix prompt generator
│   └── updates/                # Plugin update system
├── configs/                    # Site config YAML files
├── setup.bat                   # One-click Windows setup
├── package.json
└── tsconfig.json
```
