# WP QA Agent — Improvements & Feature Roadmap

## Current State

The system runs a two-layer QA process:
- **Layer 1:** Automated checks (page health, Lighthouse, WP API, console/network, broken links, code analysis)
- **Layer 2:** Claude-powered adaptive testing via Playwright MCP (checkout flows, visual assessment, code-driven feature verification)

Reports are generated in Markdown + PDF format.

---

## HIGH IMPACT — Core Testing Capabilities

### 1. Authentication Flow Testing
**Priority:** High | **Effort:** Medium

Currently no login/registration testing. Add:
- [ ] WordPress login/logout flow
- [ ] User registration (if enabled)
- [ ] My Account page validation
- [ ] Password reset flow
- [ ] WooCommerce customer dashboard checks (orders, addresses, downloads)
- [ ] Role-based access testing (customer vs shop manager)

### 2. WooCommerce Order Email Verification
**Priority:** High | **Effort:** Medium

- [ ] Verify order confirmation email template renders (via WP REST API or Mailhog)
- [ ] Check email contains correct product, price, shipping details
- [ ] Test "Processing" and "Completed" email triggers
- [ ] Flag broken email templates discovered by code analysis
- [ ] Verify email sender name and from address are configured

### 3. Search & Filtering Testing
**Priority:** High | **Effort:** Medium

- [ ] Test WordPress search functionality (returns results?)
- [ ] WooCommerce product search (by name, by SKU)
- [ ] Category/attribute filtering on shop pages
- [ ] Price filter and sort-by options
- [ ] Verify "no results" page works and has helpful content
- [ ] Test search with special characters and empty queries
- [ ] Verify search results page SEO (noindex?)

### 4. Payment Gateway Validation
**Priority:** High | **Effort:** Medium

- [ ] Verify each active gateway appears on checkout
- [ ] Test gateway switching (select Klarna -> switch to Vipps -> back)
- [ ] Check test card flows (Stripe test mode, Dintero test mode)
- [ ] Verify gateway error messages render correctly
- [ ] Detect gateway JS loading failures
- [ ] Check gateway-specific checkout field rendering (card number, expiry)

### ~~5. Multi-Language / Multi-Currency Testing~~ ✅ IMPLEMENTED (language detection + hreflang)
*Implemented in `src/layer1/checks/multi-language.ts` — auto-detects WPML, Polylang, TranslatePress, Weglot from plugin list and DOM inspection. Checks hreflang tags on all pages, verifies language switcher presence, validates alternate language URLs return 200, detects default language. Only runs if multilingual plugin detected. Currency testing deferred to Layer 2.*

---

## HIGH IMPACT — Quality & Reliability

### ~~6. Accessibility Audit (WCAG 2.1)~~ ✅ IMPLEMENTED
*Implemented in `src/layer1/checks/accessibility.ts` — WCAG 2.1 checks for alt text, form labels, heading hierarchy, ARIA, focus indicators, touch targets, skip-to-content link.*

### ~~7. SEO Health Check~~ ✅ IMPLEMENTED
*Implemented in `src/layer1/checks/seo-health.ts` — per-page meta title/description validation (missing, empty, length), Open Graph tags (og:title, og:description, og:image, og:url, og:type), Twitter Card tags, canonical URL verification (missing, cross-domain mismatch), heading hierarchy (single H1, no skipped levels), JSON-LD structured data detection, hreflang tag validation (with WPML/Polylang awareness), image alt coverage percentage. Site-level: sitemap.xml/sitemap_index.xml accessibility, robots.txt validation including blocked path detection.*

### ~~8. Security Scanning~~ ✅ IMPLEMENTED + HARDENED
*Implemented in `src/layer1/checks/security.ts` — 27 check categories following OWASP, WordPress Hardening Guide, and PCI-DSS best practices. 35+ exposed file paths (including wp-config variants, .env variants, .svn, backup files, WC logs, form data), 6 directories for listing check, OWASP security headers with HSTS quality and CSP quality evaluation, CORS misconfiguration, XML-RPC with system.multicall amplification detection, user enumeration (REST + author + oEmbed), cookie flags, login security (15+ plugin signatures), PHP execution in uploads, file editor check, default admin username, registration open, REST API namespace exposure, wp-cron.php DoS surface, jQuery CVE check, SRI on third-party scripts, cryptominer detection, suspicious script patterns, debug/database error exposure, WooCommerce-specific security (checkout HTTPS, customer/order data endpoint exposure, downloadable files), WAF/firewall detection.*

### ~~9. Performance Deep-Dive~~ ✅ IMPLEMENTED
*Implemented in `src/layer1/checks/performance.ts` — per-page weight breakdown (HTML/CSS/JS/images/fonts), render-blocking resource count, TTFB per page, third-party script audit (domain, category, size, duration), cache header validation, GZIP/Brotli compression check, font loading strategy analysis (display, format, preloaded).*

---

## MEDIUM IMPACT — WooCommerce Specific

### 10. Product Page Completeness Audit
**Priority:** Medium | **Effort:** Low

- [ ] Products with no image (placeholder showing)
- [ ] Products with no price displayed
- [ ] Products with no description or short description
- [ ] Products with 0 stock but still marked "purchasable"
- [ ] Variable products with no variations configured
- [ ] Gallery image loading and lightbox functionality
- [ ] Related products / upsells rendering
- [ ] Product review form functional (if enabled)
- [ ] SKU displayed (if configured)
- [ ] Product category and tag links work

### 11. Cart Behavior Testing
**Priority:** Medium | **Effort:** Medium

- [ ] Add multiple different products -> verify quantities and subtotals
- [ ] Update quantity -> verify total recalculates (AJAX or page reload)
- [ ] Remove item -> verify cart updates correctly
- [ ] Apply valid coupon code -> verify discount applied
- [ ] Apply invalid coupon -> verify error message shown
- [ ] Apply expired coupon -> verify error message
- [ ] Cart persistence (refresh page -> items still there)
- [ ] Cross-sell / upsell section rendering
- [ ] Minimum order amount validation (if configured)
- [ ] Cart page on mobile layout

### ~~12. Shipping & Tax Validation~~ ✅ IMPLEMENTED
*Implemented in `src/layer1/checks/shipping-tax.ts` — fetches WooCommerce shipping zones and methods via REST API, validates tax settings (enabled, rates configured, display consistency), flags: no shipping zones, empty zones, all methods disabled, free shipping without minimum, single method across all zones, tax enabled with no rates, prices-include-tax vs display mismatch. Layer 2 trigger for checkout flow verification.*

### 13. WooCommerce REST API Comprehensive Check
**Priority:** Medium | **Effort:** Low

- [ ] Products endpoint returns data with correct fields
- [ ] Orders endpoint accessible (with auth)
- [ ] Payment gateways list endpoint
- [ ] Shipping zones and methods configuration
- [ ] Tax rates configured correctly
- [ ] Customer creation via API
- [ ] Product categories and tags endpoints
- [ ] Coupon endpoint validation
- [ ] System status endpoint (detailed health data)

---

## MEDIUM IMPACT — UX & Visual

### 14. Cross-Browser Screenshot Comparison
**Priority:** Medium | **Effort:** Medium

- [ ] Capture screenshots in Chrome, Firefox, WebKit (Playwright supports all 3)
- [ ] Side-by-side comparison of key pages
- [ ] Flag significant layout differences between browsers
- [ ] Mobile browser rendering comparison
- [ ] Generate visual diff images

### ~~15. Responsive Breakpoint Testing~~ ✅ IMPLEMENTED
*Implemented in `src/layer1/checks/responsive-breakpoints.ts` — tests 5 viewports (mobile 375x812, tablet portrait 768x1024, tablet landscape 1024x768, small desktop 1366x768, large desktop 1920x1080). Checks horizontal overflow (scrollWidth vs clientWidth), element overflow detection (bounding rect beyond viewport), touch target sizing on mobile/tablet viewports (44x44px minimum). Issues grouped by viewport with severity.*

### 16. Cookie Consent & GDPR Compliance
**Priority:** Medium (critical for EU sites) | **Effort:** Medium

- [ ] Cookie banner appears on first visit
- [ ] Accept/reject buttons work and dismiss banner
- [ ] Third-party scripts (analytics, Hotjar, ads) blocked until consent
- [ ] Privacy policy page exists, has content, is linked from checkout
- [ ] Cookie policy page exists and lists all cookies used
- [ ] Data request/deletion mechanism (if GDPR plugin active)
- [ ] Cookie preferences can be changed after initial choice
- [ ] Consent is remembered across page navigations

### 17. 404 & Error Page Testing
**Priority:** Medium | **Effort:** Low

- [ ] Navigate to non-existent URL -> verify custom 404 page renders
- [ ] 404 page has navigation back to site (menu, search, links)
- [ ] No generic server error page or PHP warnings shown
- [ ] Search box available on 404 page
- [ ] 404 page matches site design (not a bare template)
- [ ] Verify proper HTTP 404 status code returned (not 200 with error content)

---

## LOWER EFFORT — Quick Wins

### 18. SSL & Certificate Check
**Priority:** Medium | **Effort:** Low

- [ ] SSL certificate validity and expiry date (flag if < 30 days)
- [ ] HSTS header present and correctly configured
- [ ] HTTP -> HTTPS redirect works (301, not 302)
- [ ] Mixed content detection (HTTP images/scripts on HTTPS pages)
- [ ] Certificate chain complete (no intermediate cert issues)
- [ ] TLS version (1.2+ required)

### ~~19. WordPress Core Health~~ ✅ IMPLEMENTED
*Implemented in `src/layer1/checks/wp-core-health.ts` — WP version security check (known vulnerable versions), debug mode detection, error display detection, PHP version from headers + WC system status, memory limit, WP-Cron status, object cache detection (Redis/Memcached), SSL certificate validation, HTTP→HTTPS redirect check, server version exposure.*

### ~~20. Image Optimization Audit~~ ✅ IMPLEMENTED
*Implemented in `src/layer1/checks/image-audit.ts` — oversized image detection (>500KB + natural vs display size comparison), WebP/AVIF format support, lazy loading audit (below-fold images), missing width/height attributes, srcset responsive image check, optimization plugin detection (Imagify, Smush, ShortPixel, EWWW, etc.), total image weight per page.*

### ~~21. Form Validation Testing~~ ✅ IMPLEMENTED + EXTENDED TO FORM QUALITY AUDIT
*Implemented in `src/layer1/checks/form-audit.ts` — placeholder quality audit (label-as-placeholder detection, missing placeholders, Kilowott placeholder map with Norwegian support), WCAG AA contrast ratio computation for placeholder colours, required field indicator detection (* markers, wrapper elements), CRO routing analysis (generic /contact routing without attribution, booking CTA link analysis), mobile CTA button wrapping detection (375px viewport resize), focus colour branding check. Layer 2 extension: 9-step Form Quality Assessment protocol in `src/layer2/instructions.md` covering visual scan, placeholder audit, contrast, required indicators, CTA destination checking, mobile UX, trust signals, and Forms CRO Score out of 10. Kilowott Form Standard baked into `CLAUDE.md` for agent context on every run. Layer 2 trigger fires as `form-quality` investigation (HIGH priority for CRO issues).*

### 22. Cron & Background Task Health
**Priority:** Low | **Effort:** Low

- [ ] WP-Cron is running (not disabled)
- [ ] List scheduled events and their status
- [ ] Flag overdue cron tasks
- [ ] Action Scheduler queue health (WooCommerce background tasks)
- [ ] Check for failed scheduled actions

---

## INFRASTRUCTURE — System Improvements

### 23. Historical Comparison / Regression Testing
**Priority:** High | **Effort:** High

- [ ] Store results per run with timestamps in a persistent format
- [ ] Compare current run vs previous run for same site
- [ ] Flag NEW issues vs previously-known issues
- [ ] Track Lighthouse score trends over time
- [ ] "What changed since last QA run?" section in report
- [ ] Diff view for plugin versions (what was updated/added/removed)
- [ ] Alert on performance regression (score dropped > 10 points)

### 24. Parallel Test Execution
**Priority:** Medium | **Effort:** Medium

- [ ] Run Lighthouse, broken links, and WP API checks in parallel (independent)
- [ ] Parallelize page health checks across pages (batch of 3-5)
- [ ] Concurrent console/network monitoring across pages
- [ ] Would cut Layer 1 runtime by 40-60%

### 25. CI/CD Integration
**Priority:** Medium | **Effort:** Medium

- [ ] GitHub Actions workflow template (`.github/workflows/qa.yml`)
- [ ] Exit code based on severity (exit 0 = PASS, exit 1 = blockers found)
- [ ] JSON summary output for machine parsing
- [ ] Slack notification on CRITICAL status (webhook integration)
- [ ] Microsoft Teams notification support
- [ ] Email report delivery
- [ ] Scheduled nightly/weekly runs via cron
- [ ] PR comment with QA summary (GitHub Actions)

### 26. Test Suite for the Tool Itself
**Priority:** Medium | **Effort:** High

- [ ] Unit tests for each check module (mock HTTP responses)
- [ ] Test report generation with fixture data
- [ ] Test config loading edge cases
- [ ] Integration tests against a local WordPress Docker instance
- [ ] Test PDF generation
- [ ] Test Layer 2 queue building logic
- [ ] CI pipeline running tests on every commit

### 27. Dashboard / Web UI
**Priority:** Low | **Effort:** High

- [ ] Simple HTML dashboard showing latest report per site
- [ ] Issue tracking across runs (resolved/new/recurring)
- [ ] Screenshot gallery with before/after comparison
- [ ] Trend graphs for Lighthouse performance scores
- [ ] Multi-site overview (all sites at a glance)
- [ ] Export to CSV/Excel for client reporting

---

## Implementation Priority Matrix

| # | Feature | Impact | Effort | Suggested Order |
|---|---------|--------|--------|-----------------|
| 3 | Search & Filtering | High | Medium | 1st |
| ~~6~~ | ~~Accessibility Audit~~ | ~~High~~ | ~~Medium~~ | ✅ Done |
| ~~8~~ | ~~Security Scanning~~ | ~~High~~ | ~~Medium~~ | ✅ Done |
| 23 | Historical Comparison | High | High | 4th |
| 10 | Product Page Completeness | Medium | Low | 5th |
| 18 | SSL & Certificate Check | Medium | Low | 6th |
| ~~20~~ | ~~Image Optimization Audit~~ | ~~Medium~~ | ~~Low~~ | ✅ Done |
| 17 | 404 Page Testing | Medium | Low | 8th |
| ~~7~~ | ~~SEO Health Check~~ | ~~High~~ | ~~Medium~~ | ✅ Done |
| ~~9~~ | ~~Performance Deep-Dive~~ | ~~High~~ | ~~Medium~~ | ✅ Done |
| 1 | Auth Flow Testing | High | Medium | 11th |
| 11 | Cart Behavior Testing | Medium | Medium | 12th |
| 4 | Payment Gateway Validation | High | Medium | 13th |
| ~~15~~ | ~~Responsive Breakpoints~~ | ~~Medium~~ | ~~Low~~ | ✅ Done |
| 16 | Cookie/GDPR Compliance | Medium | Medium | 15th |
| ~~12~~ | ~~Shipping & Tax Validation~~ | ~~Medium~~ | ~~Medium~~ | ✅ Done |
| 24 | Parallel Execution | Medium | Medium | 17th |
| 25 | CI/CD Integration | Medium | Medium | 18th |
| 13 | WC REST API Comprehensive | Medium | Low | 19th |
| ~~19~~ | ~~WordPress Core Health~~ | ~~Medium~~ | ~~Low~~ | ✅ Done |
| 22 | Cron & Task Health | Low | Low | 21st |
| 2 | Email Verification | High | Medium | 22nd |
| ~~5~~ | ~~Multi-Language Testing~~ | ~~High~~ | ~~High~~ | ✅ Done |
| ~~21~~ | ~~Form Validation Testing~~ → Form Quality + CRO Audit | ~~Low~~ → **High** | ~~Medium~~ → **Low** | ✅ Done |
| 14 | Cross-Browser Comparison | Medium | Medium | 25th |
| 26 | Test Suite | Medium | High | 26th |
| 27 | Dashboard / Web UI | Low | High | 27th |
