# /qa-agent — Autonomous WordPress QA Agent

Run a full QA audit on a WordPress/WooCommerce site. Uses a coordinator
pattern: Layer 1 runs automated checks via CLI (zero tokens), then
specialist agents test the site in the browser with minimal context each.

## Usage

```
/qa-agent <url>
/qa-agent <url> --skip-browser
/qa-agent <url> --skip-lighthouse
```

Credentials, project path, and settings are auto-loaded from the matching
config file in `configs/`.

## Arguments

`$ARGUMENTS` contains whatever the user typed after `/qa-agent`.
Extract: URL (required), optional flags (`--skip-browser`, `--skip-lighthouse`).

---

## Execution Steps

### Step 0 — Check config and summarize codebase

**Check if a config file exists for this URL:**

```bash
ls configs/*.yml
```

Read each config file. If one matches the URL:
- Note `project_path`, `username`, `app_password`, `known_issues`

**If `project_path` is set**, spawn the `qa-code-summarizer` agent to read
and summarize the codebase. This is MUCH cheaper than reading every file
yourself — the agent returns a concise summary.

```
Use the qa-code-summarizer agent:
"Read the WordPress project at [project_path] and return a structured
summary of custom features, hooks, template overrides, and integrations."
```

Save the summary — you'll pass relevant parts to specialist agents later.

If no config matches or no `project_path`, proceed without code context.

---

### Step 1 — Run Layer 1 (automated checks, zero tokens)

```bash
npx qa-agent run --url "<the-url>" [--skip-browser] [--skip-lighthouse]
```

Wait for completion. Note the output directory path.

This produces the report files AND per-agent context files:
- `layer1-results.json`, `layer1-report.md`, `layer2-prompt.md`
- `agent-context-checkout.md` — context for checkout agent
- `agent-context-visual.md` — context for visual agent
- `agent-context-forms.md` — context for forms agent
- `agent-context-mobile.md` — context for mobile agent
- `agent-context-code-features.md` — context for code features agent (if project_path)

---

### Step 2 — Dispatch specialist agents sequentially

Read the Layer 1 results briefly to understand what needs testing.
Then dispatch specialist agents. Each gets ONLY its relevant context file.

**IMPORTANT: Playwright MCP is single-browser, so browser agents must run
one at a time. Dispatch them sequentially, not in parallel.**

**For each agent, read its context file and pass it in the prompt.**

#### Agent 1: Checkout Flow (if WooCommerce detected)

```
Use the qa-checkout-flow agent:
"Test the WooCommerce checkout flow on [url].
Context: [paste content of agent-context-checkout.md]"
```

#### Agent 2: Visual Assessment

```
Use the qa-visual agent:
"Assess visual quality of [url].
Context: [paste content of agent-context-visual.md]"
```

#### Agent 3: Form Quality (if forms found)

```
Use the qa-forms agent:
"Test form quality and CRO on [url].
Context: [paste content of agent-context-forms.md]"
```

#### Agent 4: Mobile UX

```
Use the qa-mobile agent:
"Test mobile responsiveness of [url].
Context: [paste content of agent-context-mobile.md]"
```

#### Agent 5: Code Features (if project_path and features detected)

```
Use the qa-code-features agent:
"Verify custom features on [url].
Context: [paste content of agent-context-code-features.md]
Codebase summary: [paste the summary from Step 0]"
```

**Skip agents that don't apply:**
- Skip checkout if WooCommerce not detected
- Skip code-features if no project_path or no features in code analysis
- Skip forms if no forms were found in Layer 1

---

### Step 3 — Collect and merge findings

Collect the JSON output from each agent. Combine them into a single
`layer2-findings.json` file in the output directory:

```json
{
  "tested_at": "ISO timestamp",
  "investigations": [
    // paste each agent's output as an investigation entry
  ],
  "additional_findings": []
}
```

Write this file, then run the merge:

```bash
npx qa-agent merge --report <output-directory>
```

---

### Step 4 — Present results

Read `final-report.md` and present to the user:
- Overall status (PASS / WARNING / CRITICAL)
- Blocker and major issues with descriptions
- Summary of what was tested
- Report and PDF file locations

---

## Why This Architecture

- **Layer 1 (CLI)** = zero AI tokens, runs all 18 automated checks
- **Code summarizer (Sonnet)** = reads codebase once, returns ~500 lines vs ~5000 raw
- **Specialist agents (Sonnet)** = each gets only its slice of context (~200 lines vs ~3000)
- **Coordinator (you, Opus)** = stays lean, only orchestrates and merges
- **Result:** Same quality, ~60-70% fewer tokens, faster

## Rules

- Do NOT read raw project code files yourself — use the qa-code-summarizer agent
- Do NOT read the full layer2-prompt.md — use the agent-context-*.md files instead
- Do NOT submit payment forms or create real orders
- Each specialist agent takes its own screenshots
- If an agent fails, note it and continue with the others
- The merged report is what the user sees — agent outputs are internal
