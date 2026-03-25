# /qa-agent — Autonomous WordPress QA Agent

Run a full QA audit on a WordPress/WooCommerce site. This command runs
a codebase deep-dive, Layer 1 automated checks, Layer 2 adaptive browser
testing, and produces a final merged report — all autonomously.

## Usage

```
/qa-agent <url>
/qa-agent <url> --skip-browser
/qa-agent <url> --skip-lighthouse
```

That's it. Just the URL. Credentials, project path, and all other settings
are auto-loaded from the matching config file in `configs/`.

## How auto-detection works

When you provide a URL, the CLI automatically searches `configs/*.yml` for a
config file whose `url` field matches. If found, it uses that config — which
includes credentials, project path, custom features, critical flows, and all
other settings. No need to pass `--config`, `--username`, `--password`, or
`--project` every time.

If no matching config is found, it runs with just the URL (Mode B).

## Arguments

The argument `$ARGUMENTS` contains whatever the user typed after `/qa-agent`.
Parse it to extract:
- A URL (required)
- Optional `--skip-browser` to skip browser tests (faster, API-only)
- Optional `--skip-lighthouse` to skip Lighthouse performance audit
- Optional extra flags to pass through to the CLI

---

## Execution Steps

### Step 0 — Check for config file and read project code

**BEFORE running anything, check if a config file exists for this URL:**

```bash
ls configs/*.yml
```

Read each config file and check if its `url` field matches the URL the user
provided. If a matching config exists:
- Note the `project_path` value (if set — this enables code analysis)
- Note the credentials (`username`, `app_password`)
- Note `custom_features`, `critical_flows`, `known_issues` if listed

**If `project_path` is set in the config, do a codebase deep-dive NOW
(before running Layer 1). Do NOT skip this.** The automated code-analysis
scanner catches patterns via regex, but YOUR reading catches intent,
business logic, and edge cases that patterns miss.

**What to read:**

1. **`functions.php`** — hooks, filters, custom post types, shortcodes,
   third-party integrations
2. **`woocommerce/` directory** (if exists) — template overrides, custom
   checkout fields, cart modifications, payment gateway integrations
3. **Custom plugin files** — REST endpoints, AJAX handlers
4. **JavaScript files** (non-minified) — interactive features, AJAX calls
5. **`style.css` or `theme.json`** — design system
6. **`composer.json`, `package.json`** — dependencies

**Build a mental checklist** of every custom feature, WooCommerce
modification, third-party integration, and custom form. Keep this in mind
for all subsequent steps.

If no config file matches OR no `project_path` is set, skip the codebase
reading and proceed to Step 1 in URL-only mode.

---

### Step 1 — Run Layer 1 (automated checks)

Run the CLI to execute all Layer 1 checks. **Always pass `--url` only.**
The CLI auto-detects the matching config file and loads credentials,
project path, and all other settings automatically. Do NOT manually pass
`--config`, `--username`, `--password`, or `--project` unless the user
explicitly provided them as overrides.

```bash
npx qa-agent run --url "<the-url>" [--skip-browser] [--skip-lighthouse]
```

The CLI will print `Auto-detected config: configs/xxx.yml` if it found a
matching config. If you see this, the project path, credentials, and all
settings are loaded — code analysis will run automatically.

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
