# /qa-agent — Autonomous WordPress QA Agent

Run a full QA audit on a WordPress/WooCommerce site. This command runs
a codebase deep-dive, Layer 1 automated checks, Layer 2 adaptive browser
testing, and produces a final merged report — all autonomously.

## Usage

```
/qa-agent <url>
/qa-agent <url> --username <user> --password <app-password>
/qa-agent --config configs/my-site.yml
/qa-agent <url> --project /path/to/local/wordpress
```

## Arguments

The argument `$ARGUMENTS` contains whatever the user typed after `/qa-agent`.
Parse it to extract:
- A URL (required unless --config is used)
- Optional `--username` and `--password` for WordPress REST API access
- Optional `--config` path to a YAML config file
- Optional `--project` path to a local WordPress project for code review
- Optional `--skip-browser` to skip browser tests (faster, API-only)
- Optional `--skip-lighthouse` to skip Lighthouse performance audit

---

## Execution Steps

### Step 0 — Codebase Deep-Dive (CRITICAL — do this FIRST)

**This step is MANDATORY when `--project` is provided or when a `project_path`
is set in the config YAML. Do NOT skip this step. It is the foundation for
intelligent testing.**

Before running ANY automated checks, you must explore and understand the
WordPress project codebase yourself. The automated code-analysis scanner
catches patterns via regex, but YOUR reading catches intent, business logic,
and edge cases that patterns miss.

**What to do:**

1. **Read the theme's `functions.php`** — this is the entry point. Understand:
   - What hooks and filters are registered
   - What custom post types, taxonomies, shortcodes exist
   - What third-party integrations are set up (payment gateways, APIs, CRMs)
   - What admin customizations are made

2. **Read WooCommerce customizations** — if `woocommerce/` directory exists in the theme:
   - Which templates are overridden and WHY (read the actual template code)
   - Custom checkout fields, cart modifications, product display changes
   - Payment gateway integrations and custom order workflows

3. **Read custom plugin files** — if the project has custom plugins:
   - What each plugin does (read the main plugin file header + key functions)
   - REST API endpoints registered
   - AJAX handlers and what they power

4. **Read JavaScript files** — non-minified `.js` files in the theme:
   - What interactive features exist (sliders, filters, live search, maps)
   - What AJAX/fetch calls are made and to which endpoints
   - Payment gateway frontend integrations

5. **Read `style.css` or `theme.json`** — understand the design system

6. **Check for `.env.example`, `composer.json`, `package.json`** — understand dependencies

**Output of this step:** Build a mental checklist of:
- Every custom feature that needs testing
- Every WooCommerce modification that could break checkout
- Every third-party integration that could fail
- Every custom form or interactive element
- Business-critical flows specific to THIS site

**Keep this checklist in mind for ALL subsequent steps.** When Layer 2
investigations reference "code-driven" items, your deep understanding
of the code should inform HOW you test — not just WHAT you test.

---

### Step 1 — Run Layer 1 (automated checks)

Run the CLI command to execute all Layer 1 checks. Include `--project` if
a project path was provided:

```bash
npx qa-agent run <parsed arguments here>
```

This produces:
- `qa-reports/<site>-<date>/layer1-results.json` — raw data
- `qa-reports/<site>-<date>/layer1-report.md` — detailed report
- `qa-reports/<site>-<date>/layer2-prompt.md` — Layer 2 investigation prompt
- `qa-reports/<site>-<date>/final-report.md` — initial report (L1 only)
- `qa-reports/<site>-<date>/fixable-issues.json` — structured issues

Wait for it to complete. Note the output directory path from the CLI output.

---

### Step 2 — Read Layer 2 prompt and cross-reference with your codebase knowledge

Read the generated `layer2-prompt.md` file from the output directory.

**IMPORTANT:** Cross-reference the investigation queue with your Step 0 codebase
knowledge. The automated scanner may have missed features you found. If you
identified custom features, integrations, or critical flows in Step 0 that
are NOT in the Layer 2 queue, add them to your personal testing checklist.

For example, if you read a custom payment gateway integration in functions.php
but the Layer 2 queue only has a generic "wc-checkout-flow" item, you should
specifically test that payment gateway during the checkout flow.

---

### Step 3 — Execute Layer 2 investigations

Process the investigation queue from the Layer 2 prompt PLUS any additional
items from your Step 0 codebase analysis. For each investigation:

1. Use the **Playwright MCP** browser tools to navigate the site
2. Follow the investigation instructions
3. **Apply your codebase knowledge** — you know what the code does, now verify
   the live site matches. If functions.php registers a custom checkout field,
   verify it appears on checkout. If a template override changes the cart layout,
   verify the cart looks correct.
4. Take screenshots at key moments using `browser_take_screenshot`
5. Record findings for each investigation

**Browser tools to use:**
- `browser_navigate` — go to a URL
- `browser_click` — click elements
- `browser_fill_form` — fill form fields
- `browser_take_screenshot` — capture screenshots
- `browser_snapshot` — read page accessibility tree (use this to understand page structure)
- `browser_resize` — change viewport for mobile testing (375x812)

**Investigation priority order:** Process `high` priority items first, then `medium`, then `low`.

**For WooCommerce checkout flow:**
1. Navigate to /shop/ and find a product
2. Click on a product to view details
3. Check for custom elements you found in code (size guides, swatches, custom tabs)
4. Add to cart — verify cart updates
5. Go to /cart/ — verify the item and any cart customizations from code
6. Proceed to /checkout/ — verify form loads
7. Check: billing fields, custom fields from code, payment section, order summary
8. Verify payment gateway scripts loaded (check what you found in JS analysis)
9. **DO NOT submit the order**
10. Test the same flow on mobile viewport (375x812)

**For code-driven investigations specifically:**
- You READ the code in Step 0 — now you're verifying the code WORKS
- If code registers a custom post type "portfolio", visit the archive page
- If code adds a custom checkout field "vat_number", verify it appears on checkout
- If code enqueues a script conditionally on product pages, verify it loads there
- If code hooks into `woocommerce_before_cart`, verify the cart page shows that content

**For each investigation, record:**
- `id` — the investigation ID from the queue (or "custom-<name>" for items you added)
- `status` — "pass", "fail", or "warning"
- `summary` — one-line summary of what you found
- `details` — detailed description
- `screenshots` — list of screenshot file names
- `issues` — array of any issues found

---

### Step 4 — Save Layer 2 findings

Write your findings to `layer2-findings.json` in the output directory:

```json
{
  "tested_at": "ISO timestamp",
  "investigations": [
    {
      "id": "investigation-id",
      "status": "pass|fail|warning",
      "summary": "One-line summary",
      "details": "Detailed description",
      "screenshots": ["screenshot-names"],
      "issues": [
        {
          "severity": "blocker|major|minor",
          "title": "Issue title",
          "description": "What's wrong",
          "location": "URL or element",
          "how_to_fix": "Recommendation"
        }
      ]
    }
  ],
  "additional_findings": [
    "Anything notable not in the queue"
  ]
}
```

---

### Step 5 — Merge final report

Run the merge command to combine Layer 1 + Layer 2 into the final report:

```bash
npx qa-agent merge --report <output-directory>
```

---

### Step 6 — Present results

After the merge completes, read and present the final report to the user:
- Read `final-report.md` from the output directory
- Highlight the overall status (PASS / WARNING / CRITICAL)
- List blocker and major issues with clear descriptions
- Summarize what was tested (page count, flow tests, features verified)
- Note the report and PDF file locations

---

## Rules

- **Step 0 is NOT optional** — when project code is available, ALWAYS read it first
- Do NOT submit payment forms or create real orders
- Take screenshots for every finding and at every step of flow tests
- If Playwright fails to connect, fall back to Layer 1 only and note it
- If a page takes too long (>30s), skip it and move to the next investigation
- Focus on what matters to end users and business outcomes
- Be specific — include URLs, element descriptions, exact text
- Save all screenshots to the `screenshots/` subdirectory in the report folder
- When testing features found in code, note in your findings whether the feature
  is "verified working", "present but broken", or "missing from live site"
