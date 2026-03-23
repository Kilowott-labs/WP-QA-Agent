# WP QA Agent — Features & Capabilities

## Overview

A two-layer QA testing agent for WordPress and WooCommerce sites.
Layer 1 runs automated checks; Layer 2 triggers Claude-powered adaptive testing via Playwright MCP.

**Two operating modes:**
- **Mode A (with-code):** Reads local WordPress project codebase first, then tests the live/staging site with full context
- **Mode B (url-only):** Tests a site using only a URL and optional credentials

---

## CLI Commands

### `wp-qa run` — Main QA Execution

Runs all Layer 1 checks + generates Layer 2 investigation prompt for Claude.

```bash
# Quick run with just a URL
wp-qa run --url https://mysite.com

# Full run with config file
wp-qa run --config configs/my-site.yml

# With WordPress credentials (unlocks plugin list, WC system status)
wp-qa run --url https://mysite.com --username qa-agent --password AbCdEf123456

# With local code analysis (Mode A)
wp-qa run --config configs/my-site.yml --project /path/to/wordpress

# Skip slow checks
wp-qa run --url https://mysite.com --skip-browser    # API + Lighthouse only
wp-qa run --url https://mysite.com --skip-lighthouse  # Browser checks only
```

**Options:**
| Flag | Description |
|------|-------------|
| `-c, --config <path>` | Site config YAML file |
| `-u, --url <url>` | Site URL (quick run) |
| `--username <user>` | WordPress username |
| `--password <pass>` | WordPress application password |
| `--project <path>` | Local WordPress project path (Mode A) |
| `--skip-browser` | Skip browser-based checks |
| `--skip-lighthouse` | Skip Lighthouse audit |
| `--output <path>` | Output directory (default: `./qa-reports`) |

**Output files:**
- `layer1-results.json` — Raw structured data
- `layer1-report.md` — Detailed data report
- `final-report.md` / `final-report.pdf` — Merged report
- `layer2-prompt.md` — Investigation prompt for Claude
- `screenshots/` — Page screenshots

---

### `wp-qa update` — Plugin Updates with Verification

Updates plugins on a staging site, one at a time, with automated regression detection.

```bash
# Update all minor/patch plugins on staging
wp-qa update --config configs/my-site.yml

# Dry run — show what would happen
wp-qa update --config configs/my-site.yml --dry-run

# Update one specific plugin
wp-qa update --config configs/my-site.yml --plugin akismet/akismet.php

# Quick run without config file
wp-qa update --url https://mysite.com --staging-url https://staging.mysite.com \
  --username qa-agent --password AbCdEf123456
```

**Options:**
| Flag | Description |
|------|-------------|
| `-c, --config <path>` | Site config YAML file |
| `-u, --url <url>` | Site URL |
| `--staging-url <url>` | Staging URL (required — never updates production) |
| `--username <user>` | WordPress username |
| `--password <pass>` | WordPress application password |
| `--plugin <slug>` | Update specific plugin only |
| `--dry-run` | Show plan without making changes |
| `--output <path>` | Output directory |

**Safety mechanisms:**
- Refuses to run without `staging_url`
- Major version updates (e.g. 3.x → 4.x) are flagged and skipped
- One plugin at a time with full health verification between each
- Blocker regression → deactivate plugin + alert + halt all further updates
- Baseline evolves after each successful update

**Exit codes:** `0` = success, `1` = failures, `2` = deactivations

---

### `wp-qa update-templates` — Update Outdated WooCommerce Template Overrides

Updates WooCommerce template overrides in the theme when the WC plugin has been updated and templates are outdated. Works on local files — you review and push to staging yourself.

```bash
# Full smart merge (PHP/HTML changes + version bump)
wp-qa update-templates --config configs/my-site.yml

# Version tag only — no PHP/HTML changes
wp-qa update-templates --config configs/my-site.yml --version-only

# Update a single template
wp-qa update-templates --config configs/my-site.yml --file cart/cart-empty.php

# Combine flags
wp-qa update-templates --config configs/my-site.yml --file cart/cart.php --version-only

# Dry run — show what would change without writing files
wp-qa update-templates --config configs/my-site.yml --dry-run

# Override project path from CLI
wp-qa update-templates --url https://mysite.com --username qa --password AbCdEf \
  --project /path/to/theme
```

**Options:**
| Flag | Description |
|------|-------------|
| `-c, --config <path>` | Site config YAML file |
| `-u, --url <url>` | Site URL (for WC system status API) |
| `--username <user>` | WordPress username |
| `--password <pass>` | WordPress application password |
| `--project <path>` | Local WordPress project path (overrides config) |
| `--file <path>` | Update a single template only (e.g. `cart/cart.php`, partial match supported) |
| `--version-only` | Only update `@version` tag, skip PHP/HTML smart merge |
| `--dry-run` | Show plan without making changes |
| `--output <path>` | Output directory |

**How it works:**
1. Reads WC system status API to get outdated template overrides with version info + WC version
2. Detects outdated templates by comparing version strings (doesn't rely on WC's unreliable `outdated` flag)
3. Auto-detects whether `project_path` is a WP root or theme-only directory
4. Gets WC's current template for comparison:
   - **If local WC plugin exists** (full WP install): reads from `plugins/woocommerce/templates/`
   - **If theme-only repo** (most common): fetches from WooCommerce GitHub repository for the exact WC version running on the site
5. For each outdated template, either:
   - **`--version-only`**: bumps the `@version` tag only, leaves all code untouched
   - **Default (smart merge)**: uses LCS alignment to merge WC's changes while preserving theme customizations
6. Produces a report with all changes made and what needs manual attention

**Safety:**
- Always creates backups before modifying any file (in `{output}/backups/`)
- `--version-only` mode for safe version-tag-only updates
- `--file` flag to test on a single template before running all
- `--dry-run` to preview without writing
- Restores from backup if write fails
- Works with theme-only repos (no need for full WP install locally)

---

### `wp-qa check-updates` — List Available Updates (Read-Only)

Lists plugins with available updates, categorised as auto-updatable or manual-review.

```bash
wp-qa check-updates --config configs/my-site.yml
wp-qa check-updates --url https://mysite.com --username qa --password AbCdEf
```

---

### `wp-qa merge` — Combine Layer 1 + Layer 2 Reports

After Claude completes Layer 2 investigations and writes `layer2-findings.json`, merge into final report.

```bash
wp-qa merge --report ./qa-reports/my-site-2026-03-20
```

---

### `wp-qa init` — Create Site Config Template

```bash
wp-qa init --url https://mysite.com --name "My Site" -o configs/my-site.yml
```

---

## Layer 1: Automated Checks

All run automatically during `wp-qa run`. Each produces structured data for the report.

### 1. Page Discovery (`discover-pages.ts`)
- Crawls site navigation to find all testable pages
- Adds standard WooCommerce pages if detected (/shop/, /cart/, /checkout/, /my-account/)
- Merges with `key_pages` from config

### 2. Page Health (`page-health.ts`)
- HTTP status code for each page
- Load time to DOMContentLoaded
- `must_contain` / `must_not_contain` text validation
- Redirect detection
- Screenshots of every page

### 3. Broken Links (`broken-links.ts`)
- Crawls internal links from key pages (up to `max_links_to_crawl`)
- HEAD request with GET fallback
- Reports source page, broken URL, status code, link text

### 4. Lighthouse Performance (`lighthouse.ts`)
- Google PageSpeed Insights API (free, no key needed)
- Mobile + desktop scores: Performance, Accessibility, Best Practices, SEO
- Core Web Vitals: LCP, FID, CLS, FCP, TTFB

### 5. WordPress REST API Health (`wp-api.ts`)
- REST API accessibility check
- Site name, WordPress version detection
- Full plugin list: name, version, status, available updates
- WooCommerce detection and version
- Outdated WooCommerce template overrides
- Authentication validation
- Cross-references plugin updates via WC system status endpoint

### 6. WordPress Core Health (`wp-core-health.ts`)
- WordPress version security (known-insecure version list)
- PHP version detection (via headers + WC system status) and EOL check
- Debug mode detection (`WP_DEBUG` enabled in production)
- Error display detection (PHP notices visible to visitors)
- WP-Cron status (enabled/disabled)
- Object cache detection (Redis/Memcached/none)
- Memory limit and max upload size
- Multisite detection
- SSL certificate validation (valid, issuer, expiry, days until expiry)
- HTTP → HTTPS redirect check (301 vs 302)
- Server version exposure

### 7. Security Scan — Hardened (`security.ts`)
Comprehensive WordPress/WooCommerce security audit following OWASP, WordPress Hardening Guide, and PCI-DSS best practices. 27 check categories:

**File exposure (35+ paths checked):**
- wp-config.php (+ .bak, .old, .save, .txt, ~ variants), .env (+ .production, .local), .git/config, .git/HEAD, .svn/entries, .htaccess, .htpasswd
- debug.log, error_log, phpinfo.php, info.php, wp-admin/install.php, readme.html, license.txt, wp-config-sample.php
- Backup files: .sql, .zip, .tar.gz database dumps in web root
- WooCommerce logs (wc-logs/), form submission data (wpforms/, gravity_forms/), backup directories
- wp-admin/maint/repair.php, wp-cli.yml, composer.json, package.json

**Directory listing:** 6 directories checked including woocommerce_uploads/ and cache/

**Security headers (OWASP recommended):**
- X-Frame-Options, Content-Security-Policy, X-Content-Type-Options, Strict-Transport-Security, Referrer-Policy, Permissions-Policy
- **HSTS quality:** max-age adequacy (flags < 6 months), includeSubDomains presence
- **CSP quality:** detects unsafe-inline without nonces/hashes, unsafe-eval usage
- **CORS misconfiguration:** wildcard Access-Control-Allow-Origin detection

**Information disclosure:**
- WordPress version in meta tag + WooCommerce version + Yoast SEO comment
- Asset version strings in URLs (?ver=)
- Server software version in headers (Apache/nginx version)
- X-Powered-By header (PHP version)
- Debug HTML comments (SQL queries, timing, memory usage)
- Database error messages visible to visitors
- PHP errors (fatal/warning/notice) visible in HTML output

**Authentication & access:**
- **XML-RPC:** detects system.multicall (brute-force amplification) and pingback.ping (DDoS relay)
- **User enumeration:** REST API (/wp-json/wp/v2/users), author archives (/?author=1), oEmbed endpoint
- **Login security:** brute-force protection detection (15+ plugin signatures), login page over HTTP, hidden login page detection
- **Default "admin" username** existence check
- **Registration open** check (verifies default role appropriateness)
- **Cookie flags:** Secure, HttpOnly, SameSite on WordPress auth cookies
- **Theme/plugin file editor** accessible (DISALLOW_FILE_EDIT not set)
- **Application Passwords** enabled status
- **REST API namespace exposure** (counts publicly accessible namespaces)

**WordPress-specific:**
- **PHP execution in uploads** directory (malicious file upload risk)
- **wp-cron.php** public accessibility (DoS surface)
- **Mixed content** (HTTP resources on HTTPS pages)
- **jQuery version** (flags versions below 3.5.0 with known XSS CVEs)
- **Subresource Integrity** (SRI) usage on third-party scripts
- **Cryptominer detection** (CoinHive, CryptoLoot, and 7+ known mining scripts)
- **Suspicious script patterns** (eval(atob()), document.write(unescape()), URL shortener redirects)

**WooCommerce-specific (PCI-DSS awareness):**
- Checkout page HTTPS enforcement
- Checkout form action URL security
- Customer data endpoint exposure (unauthenticated /wc/v3/customers)
- Order data endpoint exposure (unauthenticated /wc/v3/orders)
- Downloadable files directory exposure (woocommerce_uploads/)

**Defence detection:**
- **WAF/Firewall:** detects Wordfence, Sucuri, Cloudflare, Akamai, iThemes Security, Shield, WP Cerber, BulletProof, Jetpack
- Flags when no security plugin or WAF is detected

Findings rated: critical / high / medium / low / info

### 8. Error Log Analysis (`error-logs.ts`)
Fetches and parses WordPress/PHP error logs from multiple sources:

**Remote (via HTTP):**
- Checks 7 common log paths: /wp-content/debug.log, /debug.log, /error_log, /wp-content/error_log, /php_error.log, /logs/error.log, /logs/php-error.log
- Uses HTTP Range header to fetch only the last 512KB of large files
- Validates content is actually a log file (not a custom 404 HTML page)

**Local (Mode A — with project path):**
- Scans 6 local log file locations within the project directory
- Reads last 512KB for large files (tail read)

**Parsing:**
- Handles WordPress debug.log format: `[DD-Mon-YYYY HH:MM:SS UTC] PHP Warning: ...`
- Handles PHP error_log format: `PHP Fatal error: ... in /path/file.php on line 123`
- Extracts: severity level, message, file path, line number, timestamp, stack trace
- Classifies: fatal, error, warning, notice, deprecated, parse error

**Analysis:**
- Groups identical errors by normalised message (deduplication)
- Sorts by severity then frequency
- Identifies recent entries (last 24 hours)
- Severity counts breakdown
- Flags publicly accessible log files as security issues

**Layer 2 triggers:**
- Fatal errors → high-priority investigation of user-facing impact
- HTTP-accessible logs → high-priority security investigation

### 8. Accessibility Audit — WCAG 2.1 (`accessibility.ts`)
- **Missing alt text** on images (distinguishes decorative vs content images)
- **Form labels:** checks `<label for>`, `aria-label`, `aria-labelledby`, `title`
- **Heading hierarchy:** no skipped levels, single H1 per page
- **ARIA:** buttons/links without accessible names
- **Focus indicators:** checks for visible `:focus` styles (outline or box-shadow)
- **Touch targets:** interactive elements below 44x44px
- **Skip-to-content link** presence
- Each issue mapped to specific WCAG 2.1 criterion

### 9. Performance Deep-Dive (`performance.ts`)
- **Per-page weight breakdown:** HTML, CSS, JS, images, fonts, other (in bytes)
- **Request count** and **render-blocking resource count** per page
- **TTFB** per page
- **Third-party script audit:** grouped by domain, categorised (analytics, payment, social, CDN, advertising, fonts, security), with total size and duration
- **Compression:** GZIP and Brotli enabled/disabled
- **Cache headers:** identifies static resources missing Cache-Control
- **Font loading:** display strategy (swap/block/auto), format, preloaded status

### 10. Image Optimization Audit (`image-audit.ts`)
- **Oversized images:** files > 500KB + natural dimensions much larger than display
- **Missing width/height attributes** (causes CLS)
- **Lazy loading:** below-fold images with/without `loading="lazy"` or lazy-load classes
- **Modern format support:** WebP and AVIF detection (in HTML and Accept headers)
- **Responsive images:** srcset presence/absence
- **Total image weight** per page
- **Optimization plugin detection:** Imagify, Smush, ShortPixel, EWWW, Optimole, WebP Express, WP Rocket, and more

### 11. Console & Network Monitoring (`console-network.ts`)
- JavaScript console errors and warnings per page
- Uncaught exceptions
- Network request failures (4xx/5xx, timeouts)
- **WooCommerce JS state** on checkout/cart:
  - `wc_checkout_params` loaded
  - `wc_cart_params` loaded
  - Stripe / PayPal gateway loaded
  - Checkout URL and AJAX URL
  - Visible WooCommerce error count

### 12. Code Analysis — Mode A only (`code-analysis.ts`)
Deep scan of local WordPress project codebase in two passes:

**Pass 1 — Pattern detection:**
- Theme name and structure
- Custom post types, taxonomies, shortcodes
- WooCommerce hooks (`add_action/add_filter` on `woocommerce_*`)
- WooCommerce template overrides
- Custom checkout fields, product tabs, product fields
- REST API endpoints registered in theme
- AJAX handlers (public and authenticated)
- Custom page templates, Gutenberg blocks, custom widgets
- Enqueued scripts with feature detection (AJAX, Stripe, cart, animations)
- Custom email templates
- composer.json / package.json dependencies
- theme.json data (colors, fonts, templates)
- Security issues (unsanitized input)

**Pass 2 — Enriched detail extraction (for accurate test cases):**
- **Custom post type details:** labels, supports (title/editor/thumbnail/etc.), has_archive, public/private
- **Taxonomy details:** labels, hierarchical, associated post types
- **Shortcode details:** callback function body analysis, accepted attributes, whether it renders HTML, queries DB
- **Checkout field details:** actual field names, types (text/select/checkbox), labels, required/optional, validation rules, conditional logic (e.g. "only for logged-in users")
- **Hook callback analysis:** reads the function body of important WC hooks to determine what they do in plain English (e.g. "adds CSS class", "removes field", "modifies price display")
- **Feature map:** generates human-readable test instructions for every detected feature, with specific pages to test, what to look for, and which code files are involved

---

## Layer 2: Claude-Powered Investigations

Built automatically from Layer 1 findings. Claude reads the prompt and executes via Playwright MCP.

**Investigation types triggered by Layer 1:**

| Trigger | ID | Priority |
|---------|----|----------|
| WooCommerce detected | `wc-checkout-flow` | High |
| Console errors on checkout/cart | `console-errors-checkout` | High |
| Pages returning non-200 | `broken-pages` | High |
| Lighthouse mobile < 50 | `mobile-performance-ux` | High |
| Critical a11y issues | `accessibility-critical` | High |
| High-risk security findings | `security-high-risk` | High |
| Critical WP core health issues | `wp-core-critical` | High |
| Outdated WC templates | `outdated-wc-templates` | Medium |
| Custom checkout fields in code | `code-custom-checkout-fields` | High |
| Custom REST endpoints in code | `code-rest-endpoints` | Medium |
| Custom product tabs in code | `code-custom-product-tabs` | Medium |
| Custom page templates in code | `code-page-templates` | Low |
| Custom Gutenberg blocks in code | `code-gutenberg-blocks` | Medium |
| Public AJAX handlers in code | `code-ajax-features` | Medium |
| WC template overrides in code | `code-wc-template-overrides` | Medium |
| Fatal errors in error logs | `error-logs-fatal` | High |
| Error logs publicly accessible | `error-logs-exposed` | High |
| Always | `visual-assessment` | Medium |

---

## Plugin Update System

### Update Flow

```
1. Get list of plugins with updates (REST API)
2. Classify each: major → skip, minor/patch → auto-update
3. Launch browser session
4. Capture baseline health snapshot
5. For each plugin:
   a. Trigger update via REST API
   b. Verify version changed
   c. Capture post-update health snapshot
   d. Compare against baseline for regressions
   e. Blocker? → Deactivate plugin + halt
   f. Pass? → Evolve baseline, next plugin
6. Generate report
```

### Regression Detection Thresholds

| Signal | Type | Action |
|--------|------|--------|
| Key page returns 500 | Blocker | Deactivate + halt |
| New console errors on checkout/cart | Blocker | Deactivate + halt |
| WC JS state broken (was loaded → missing) | Blocker | Deactivate + halt |
| WC errors increased | Blocker | Deactivate + halt |
| New console errors on other pages (>3) | Major | Alert, continue |
| Load time > 2x baseline | Major | Alert, continue |
| New network failures | Warning | Log, continue |

---

## WooCommerce Template Override Updates

When WooCommerce is updated, theme template overrides (in `{theme}/woocommerce/`) can become outdated. The `update-templates` command handles this safely.

### Two modes

**`--version-only` mode:**
Only updates the `@version` tag in the template header. No PHP or HTML changes. Fastest and safest — use when you know WC's structural changes don't affect your customizations.

**Default (smart merge) mode:**
Uses LCS (Longest Common Subsequence) to align the theme override with WC's current template line-by-line, then produces a merged result:

**Auto-applied (reported in changelog):**
- `@version` tag update
- WC code additions (new PHP blocks, HTML elements, hooks, conditionals) — inserted at the correct position based on surrounding context
- WC structural updates where the theme hadn't customized that section

**Preserved automatically:**
- All theme customizations (custom CSS classes, HTML changes, PHP logic, custom fields)
- Theme-specific additions that don't exist in WC's template

**Flagged for manual review:**
- Conflicts where both theme and WC changed the same section — theme's version is kept, WC's version is reported in a `.changelog.txt` file with both sides shown for easy comparison

### Path detection
The `project_path` config can point to either:
- **Theme directory** (most common — e.g. `/projects/wp-theme/`) — reads overrides from `woocommerce/`, fetches WC templates from GitHub if no local plugins folder
- **WordPress root** (e.g. `/var/www/html/`) — auto-finds theme in `wp-content/themes/`, reads WC templates from `wp-content/plugins/woocommerce/templates/` if available

When the WC plugin isn't available locally (theme-only repo), templates are fetched from the WooCommerce GitHub repository using the exact WC version reported by the site's REST API.

### Output
- Backup of every modified template (in `{output}/backups/`)
- `.changelog.txt` per template — lists every auto-applied WC change and every conflict with both sides shown
- Markdown report with per-template summary (what was applied, what needs review)
- JSON results for programmatic consumption

---

## Report Output

### Layer 1 Report Sections
1. Summary table (all checks with PASS/FAIL/WARN/SKIP)
2. WordPress Health (REST API, plugins, WC status, template overrides)
3. Lighthouse Performance (mobile/desktop scores, Core Web Vitals)
4. Page Health (status, load time per page)
5. Broken Links (source, URL, status, link text)
6. Console Errors & Network Failures (per page)
7. WooCommerce JS State (per page)
8. Security Scan (risk level, headers, exposed files, findings by severity)
9. WordPress Core Health (version, PHP, debug, cache, SSL, HTTPS redirect)
10. Accessibility Audit (issue counts by type, WCAG criteria, per-page details)
11. Performance Deep-Dive (page weight, third-party scripts, compression, cache, fonts)
12. Image Optimization (oversized, missing dimensions, lazy loading, formats)
13. Error Log Analysis (severity breakdown, top issues, recent errors, accessible logs)
14. Code Analysis (features detected, hooks, endpoints, templates, issues)
15. Layer 2 Investigation Queue

### Update Report Sections
1. Summary (updated/skipped/failed/deactivated counts)
2. Successfully Updated (version changes, regressions if any)
3. Deactivated Plugins (blocker details, before/after comparison)
4. Failed Updates (error messages)
5. Skipped Major Updates (manual review list)

### Output Formats
- Markdown (`.md`)
- PDF (`.pdf`) — auto-generated via Playwright
- JSON (`.json`) — raw structured data

---

## Project Structure

```
src/
├── cli.ts                    CLI entry point (5 commands)
├── config.ts                 YAML config loader
├── types.ts                  All TypeScript interfaces
├── utils.ts                  Logger, auth, URL, file, timing helpers
├── pdf.ts                    Markdown → PDF conversion
│
├── layer1/
│   ├── runner.ts             Orchestrator: runs all checks, builds L2 queue
│   ├── browser.ts            Playwright browser setup + listeners
│   ├── report.ts             L1 Markdown report generator
│   └── checks/
│       ├── discover-pages.ts     Page discovery from navigation
│       ├── page-health.ts        HTTP status + load time + screenshots
│       ├── broken-links.ts       Internal link 404 detection
│       ├── lighthouse.ts         PageSpeed Insights API
│       ├── wp-api.ts             WordPress REST API health
│       ├── wp-core-health.ts     WP version, PHP, debug, cache, SSL
│       ├── security.ts           Exposed files, headers, XML-RPC, users
│       ├── accessibility.ts      WCAG 2.1 audit
│       ├── performance.ts        Page weight, third-party, compression
│       ├── image-audit.ts        Oversized images, lazy loading, formats
│       ├── console-network.ts    Console errors, network, WC JS state
│       ├── error-logs.ts         Error log fetching, parsing, analysis
│       └── code-analysis.ts      Local project code scan (Mode A)
│
├── layer2/
│   ├── prompt-builder.ts     Builds Claude investigation prompt
│   ├── report-merger.ts      Merges L1 + L2 into final report
│   └── instructions.md       Static instructions for Claude
│
└── updates/
    ├── runner.ts             Plugin update orchestrator
    ├── plugin-api.ts         WP REST API: update, verify, deactivate
    ├── health-snapshot.ts    Site health state capture
    ├── compare.ts            Regression detection
    ├── check-updates.ts      Read-only update checker
    ├── semver.ts             Version classification
    ├── report.ts             Update report generator
    └── wc-templates.ts       WooCommerce template override updater
```

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js v22+ |
| Language | TypeScript |
| Browser automation | Playwright (direct dependency) |
| CLI framework | Commander.js |
| Config format | YAML (js-yaml) |
| Performance audit | Google PageSpeed Insights API (free) |
| Report output | Markdown + PDF |
| PDF generation | Playwright (HTML → PDF) |
| WordPress integration | WordPress REST API |
| Layer 2 AI | Claude Code via Playwright MCP |
