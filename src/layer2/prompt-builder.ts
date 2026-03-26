import fs from 'fs/promises';
import path from 'path';
import { Layer1Results } from '../types.js';

/**
 * Build the Layer 2 prompt from Layer 1 results.
 * This prompt is given to Claude Code with Playwright MCP to run adaptive testing.
 */
export async function buildLayer2Prompt(
  results: Layer1Results,
  outputDir: string
): Promise<string> {
  // Read static instructions
  const instructionsPath = path.join(
    path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')),
    'instructions.md'
  );
  let instructions: string;
  try {
    instructions = await fs.readFile(instructionsPath, 'utf-8');
  } catch {
    // Fallback: try relative to outputDir
    instructions = await fs.readFile(
      path.join(process.cwd(), 'src', 'layer2', 'instructions.md'),
      'utf-8'
    );
  }

  const screenshotDir = path.join(outputDir, 'screenshots');
  const findingsPath = path.join(outputDir, 'layer2-findings.json');

  const lines: string[] = [];
  const w = (...args: string[]) => lines.push(args.join(''));

  w(instructions);
  w('');
  w('---');
  w('');
  w('# Site Under Test');
  w('');
  w(`- **Name:** ${results.site.name}`);
  w(`- **URL:** ${results.site.url}`);
  if (results.site.description) {
    w(`- **Description:** ${results.site.description}`);
  }
  w(`- **WooCommerce:** ${results.wordpress_health.woocommerce_detected ? `Yes (v${results.wordpress_health.wc_version || '?'})` : 'No'}`);
  w('');

  if (results.site.known_issues && results.site.known_issues.length > 0) {
    w('## Known Issues (do not flag these)');
    w('');
    for (const ki of results.site.known_issues) {
      w(`- ${ki}`);
    }
    w('');
  }

  // Layer 1 summary for context
  w('# Layer 1 Summary');
  w('');
  w('| Check | Status | Detail |');
  w('|-------|--------|--------|');
  for (const c of results.checks) {
    w(`| ${c.check} | ${c.status} | ${c.detail || ''} |`);
  }
  w('');

  // Key findings from Layer 1
  const failedPages = results.page_health.filter((p) => !p.ok);
  if (failedPages.length > 0) {
    w('## Failed Pages');
    for (const p of failedPages) {
      w(`- ${p.page} (${p.url}): status ${p.status}${p.error ? ` — ${p.error}` : ''}`);
    }
    w('');
  }

  if (results.broken_links.length > 0) {
    w(`## Broken Links: ${results.broken_links.length} found`);
    w('');
  }

  // Console errors summary
  const totalErrors = results.console_network.reduce(
    (n, cn) => n + cn.console_errors.length, 0
  );
  if (totalErrors > 0) {
    w(`## Console Errors: ${totalErrors} total`);
    for (const cn of results.console_network) {
      if (cn.console_errors.length > 0) {
        w(`- ${cn.page_url}: ${cn.console_errors.length} errors`);
      }
    }
    w('');
  }

  // WC JS state — including custom checks from code analysis
  const wcStates = results.console_network.filter((cn) => cn.wc_js_state);
  if (wcStates.length > 0) {
    w('## WooCommerce JS State');
    for (const cn of wcStates) {
      const s = cn.wc_js_state!;
      w(`- ${cn.page_url}:`);
      w(`  - checkout_params: ${s.wc_checkout_params_loaded}`);
      w(`  - cart_params: ${s.wc_cart_params_loaded}`);
      if (s.stripe_loaded !== undefined) w(`  - stripe: ${s.stripe_loaded}`);
      if (s.paypal_loaded !== undefined) w(`  - paypal: ${s.paypal_loaded}`);
      if (s.wc_errors_visible > 0) w(`  - ⚠️ ${s.wc_errors_visible} errors visible`);
      // Custom checks from code analysis
      const customEntries = Object.entries(s.custom_checks || {});
      if (customEntries.length > 0) {
        w(`  - Custom checks (from code analysis):`);
        for (const [key, value] of customEntries) {
          const icon = value ? '✅' : '❌';
          w(`    - ${icon} ${key}: ${value}`);
        }
      }
    }
    w('');
  }

  // Critical flows from config
  if (results.site.critical_flows && results.site.critical_flows.length > 0) {
    w('## Critical Flows (user-declared)');
    w('');
    w('These flows are specifically identified as critical by the site owner:');
    for (const flow of results.site.critical_flows) {
      w(`- **${flow}**`);
    }
    w('');
  }

  // Error log context for Layer 2
  if (results.error_logs && results.error_logs.total_entries > 0) {
    const el = results.error_logs;
    w('## Error Log Summary');
    w('');
    w(`${el.total_entries} entries found (${el.severity_counts.fatal} fatal, ${el.severity_counts.error} errors, ${el.severity_counts.warning} warnings).`);
    if (el.sources_accessible.some(s => s.startsWith('HTTP:'))) {
      w('**WARNING:** Log files are publicly accessible via HTTP — investigate as a security issue.');
    }
    if (el.grouped.length > 0) {
      w('');
      w('Top issues:');
      for (const g of el.grouped.slice(0, 10)) {
        w(`- [${g.level}] (×${g.count}) ${g.message.slice(0, 120)}`);
      }
    }
    w('');
  }

  // Code analysis context for Layer 2
  if (results.code_analysis) {
    const ca = results.code_analysis;
    w('## Code Analysis Context');
    w('');
    w(`Theme: **${ca.theme_name}** — scanned from local project code at \`${ca.project_path}\`.`);
    w('');
    w('> **IMPORTANT: Before testing, READ THE ACTUAL CODE YOURSELF.**');
    w(`> The automated scanner found the patterns below, but you must read the source files`);
    w(`> at \`${ca.project_path}\` to understand the full business logic.`);
    w(`> Start with \`functions.php\`, then WooCommerce overrides, then custom JS files.`);
    w(`> Your own understanding of the code is MORE VALUABLE than this automated summary.`);
    w('');

    if (ca.custom_checkout_fields?.length > 0) {
      w('### Custom Checkout Modifications');
      for (const f of ca.custom_checkout_fields) {
        w(`- Hook: \`${f.hook}\` in \`${f.file}\``);
      }
      w('');
    }

    if (ca.rest_endpoints?.length > 0) {
      w('### Custom REST Endpoints');
      for (const ep of ca.rest_endpoints) {
        w(`- \`${ep.methods} /wp-json/${ep.namespace}${ep.route}\``);
      }
      w('');
    }

    if (ca.ajax_handlers?.length > 0) {
      w('### AJAX Handlers');
      for (const h of ca.ajax_handlers) {
        w(`- \`${h.action}\`${h.is_nopriv ? ' (public)' : ' (logged-in only)'} — \`${h.file}\``);
      }
      w('');
    }

    if (ca.custom_product_tabs?.length > 0) {
      w(`### Custom Product Tabs: ${ca.custom_product_tabs.length} found`);
      w('');
    }

    if (ca.gutenberg_blocks?.length > 0) {
      w(`### Custom Gutenberg Blocks: ${ca.gutenberg_blocks.join(', ')}`);
      w('');
    }

    if (ca.page_templates?.length > 0) {
      w('### Custom Page Templates');
      for (const t of ca.page_templates) {
        w(`- "${t.name}" (\`${t.file}\`)`);
      }
      w('');
    }

    if (ca.template_overrides?.length > 0) {
      w(`### WooCommerce Template Overrides: ${ca.template_overrides.length}`);
      for (const t of ca.template_overrides.slice(0, 15)) {
        w(`- \`${t}\``);
      }
      if (ca.template_overrides.length > 15) {
        w(`- ... and ${ca.template_overrides.length - 15} more`);
      }
      w('');
    }

    if (ca.active_hooks.length > 0) {
      w(`### WooCommerce Hooks: ${ca.active_hooks.length} custom hooks`);
      const checkoutHooks = ca.active_hooks.filter((h) => h.includes('checkout'));
      const cartHooks = ca.active_hooks.filter((h) => h.includes('cart'));
      const productHooks = ca.active_hooks.filter((h) => h.includes('product'));
      if (checkoutHooks.length) w(`- Checkout: ${checkoutHooks.join(', ')}`);
      if (cartHooks.length) w(`- Cart: ${cartHooks.join(', ')}`);
      if (productHooks.length) w(`- Product: ${productHooks.join(', ')}`);
      w('');
    }

    if (ca.enqueued_scripts?.length > 0) {
      const conditional = ca.enqueued_scripts.filter((s) => s.is_conditional);
      w(`### Theme Scripts: ${ca.enqueued_scripts.length} enqueued`);
      if (conditional.length > 0) {
        w(`(${conditional.length} conditionally loaded on specific pages)`);
      }
      w('');
    }

    if (ca.potential_issues?.length > 0) {
      w(`### Code Issues: ${ca.potential_issues.length} potential problems found`);
      for (const issue of ca.potential_issues.slice(0, 10)) {
        w(`- [${issue.severity}] \`${issue.file}\`: ${issue.issue}`);
      }
      w('');
    }

    // Feature map — THE MOST IMPORTANT SECTION
    if (ca.feature_map?.length > 0) {
      w('## ⚠️ MANDATORY Feature Checklist — Test Every Item');
      w('');
      w(`**${ca.feature_map.length} custom features** detected from source code analysis.`);
      w('Each feature below MUST be tested. These are in the investigation queue as `feature-map-*` items.');
      w('');
      let featureIdx = 1;
      for (const f of ca.feature_map) {
        w(`### ${featureIdx}. ${f.name}`);
        w(`- **Type:** ${f.type} | **Pages:** ${f.pages.join(', ')}`);
        w(`- **What it does:** ${f.description}`);
        w(`- **How to test:** ${f.how_to_test}`);
        if (f.depends_on && f.depends_on.length > 0) {
          w(`- **Depends on:** ${f.depends_on.join(', ')}`);
        }
        w('');
        featureIdx++;
      }
    }

    // Checkout field details
    if (ca.checkout_field_details?.length > 0) {
      const withFields = ca.checkout_field_details.filter((d) => d.fields.length > 0);
      if (withFields.length > 0) {
        w('### Checkout Fields (from code)');
        w('');
        for (const cf of withFields) {
          w(`**${cf.hook}**${cf.condition ? ` (${cf.condition})` : ''}:`);
          for (const f of cf.fields) {
            w(`- \`${f.name}\`: ${f.type}, label="${f.label}"${f.required ? ' (REQUIRED)' : ''}${f.validation ? `, validates: ${f.validation}` : ''}`);
          }
          w('');
        }
      }
    }
  }

  // Code review findings context
  if (results.code_review && results.code_review.total_findings > 0) {
    const cr = results.code_review;
    w('## Code Review Findings');
    w('');
    w(`Automated code review scanned ${cr.files_scanned} files against ${cr.checklists_applied.join(', ')} checklists.`);
    w(`Found: ${cr.summary.critical} critical, ${cr.summary.high} high, ${cr.summary.medium} medium, ${cr.summary.low} low.`);
    w('');
    // Show critical/high findings — these inform Layer 2 testing
    const important = cr.findings.filter(f => f.severity === 'critical' || f.severity === 'high');
    if (important.length > 0) {
      w('**Critical and high findings to verify during testing:**');
      w('');
      for (const f of important.slice(0, 10)) {
        w(`- **[${f.checklist}] ${f.rule}** in \`${f.file}:${f.line}\`: ${f.message}`);
      }
      if (important.length > 10) {
        w(`- ... and ${important.length - 10} more (see layer1-report.md)`);
      }
      w('');
      w('When testing the site, look for visible impact of these code issues (e.g., unescaped output showing HTML entities, broken forms missing nonce verification, payment failures from WC CRUD misuse).');
      w('');
    }
  }

  // Form audit context for Layer 2
  if (results.form_audit && results.form_audit.summary.totalIssues > 0) {
    const fa = results.form_audit;
    w('## Form Audit Summary (Layer 1)');
    w('');
    w(`Forms audited: ${fa.summary.totalForms} across ${fa.summary.pagesWithForms} pages. ${fa.summary.totalIssues} issues found.`);
    if (fa.summary.croRiskPages.length > 0) {
      w(`**CRO Risk:** ${fa.summary.croRiskPages.length} pages route CTAs to generic /contact with no attribution.`);
      w(`Pages: ${fa.summary.croRiskPages.join(', ')}`);
    }
    w('');
    w('Issues by type:');
    for (const [code, count] of Object.entries(fa.summary.byCode)) {
      w(`- ${code}: ${count}`);
    }
    w('');
    w('**Layer 2 action:** Visually assess each form, test mobile UX, check CTA destinations, and produce a Forms CRO Score out of 10.');
    w('');
  }

  // The investigation queue
  w('# Investigation Queue');
  w('');
  w('Process these in order of priority (high → medium → low):');
  w('');

  const sorted = [...results.layer2_queue].sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.priority] - order[b.priority];
  });

  for (const item of sorted) {
    w(`## [${item.priority.toUpperCase()}] ${item.id}`);
    w(`**Category:** ${item.category}`);
    w(`**Trigger:** ${item.trigger}`);
    w(`**Instruction:** ${item.instruction}`);
    w(`**Pages:** ${item.pages.join(', ')}`);
    if (Object.keys(item.context).length > 0) {
      w(`**Context:** \`${JSON.stringify(item.context).slice(0, 200)}\``);
    }
    w('');
  }

  // Output instructions
  w('---');
  w('');
  w('# Output');
  w('');
  w(`Save screenshots to: \`${screenshotDir}\``);
  w(`Save findings to: \`${findingsPath}\``);
  w('');
  w('After completing all investigations, write your findings JSON file.');
  w('Then run: `npx qa-agent merge --report ' + outputDir + '`');

  return lines.join('\n');
}

/**
 * Generate per-agent context files for the subagent-based QA flow.
 * Each file contains ONLY the context relevant to that specialist agent,
 * keeping their input tokens small.
 */
export async function buildAgentContextFiles(
  results: Layer1Results,
  outputDir: string
): Promise<Record<string, string>> {
  const contexts: Record<string, string> = {};
  const site = results.site;
  const siteHeader = `Site: ${site.name}\nURL: ${site.url}\n`;
  const screenshotDir = path.join(outputDir, 'screenshots');
  const knownIssues = site.known_issues?.length
    ? `\nKnown issues (skip these): ${site.known_issues.join('; ')}\n`
    : '';

  // ── Checkout flow context ───────────────────────────────────────────
  const checkoutLines: string[] = [siteHeader, knownIssues];
  checkoutLines.push(`WooCommerce: ${results.wordpress_health.woocommerce_detected ? `v${results.wordpress_health.wc_version}` : 'not detected'}`);
  const checkoutCN = results.console_network.find(cn => cn.page_url?.includes('checkout'));
  if (checkoutCN?.wc_js_state) {
    const s = checkoutCN.wc_js_state;
    checkoutLines.push(`\nCheckout JS state: checkout_params=${s.wc_checkout_params_loaded}, cart_params=${s.wc_cart_params_loaded}, stripe=${s.stripe_loaded ?? 'n/a'}, paypal=${s.paypal_loaded ?? 'n/a'}, errors_visible=${s.wc_errors_visible}`);
  }
  if (results.code_analysis?.checkout_field_details) {
    const fields = results.code_analysis.checkout_field_details
      .flatMap(d => d.fields)
      .map(f => `"${f.label}" (${f.type}${f.required ? ', required' : ''})`)
      .join(', ');
    if (fields) checkoutLines.push(`\nCustom checkout fields: ${fields}`);
  }
  checkoutLines.push(`\nScreenshot dir: ${screenshotDir}`);
  contexts['checkout'] = checkoutLines.join('\n');

  // ── Visual assessment context ───────────────────────────────────────
  const visualLines: string[] = [siteHeader, knownIssues];
  const failedPages = results.page_health.filter(p => !p.ok);
  if (failedPages.length > 0) {
    visualLines.push(`\nFailed pages: ${failedPages.map(p => `${p.page} (${p.status})`).join(', ')}`);
  }
  const keyPages = site.key_pages?.map(p => p.path).join(', ') || '/';
  visualLines.push(`\nKey pages to visit: ${keyPages}`);
  visualLines.push(`\nScreenshot dir: ${screenshotDir}`);
  contexts['visual'] = visualLines.join('\n');

  // ── Forms context ──────────────────────────────────────────────────
  const formLines: string[] = [siteHeader, knownIssues];
  if (results.form_audit) {
    const fa = results.form_audit;
    formLines.push(`\nLayer 1 form audit found ${fa.summary.totalIssues} issues across ${fa.summary.totalForms} forms on ${fa.summary.pagesWithForms} pages.`);
    formLines.push(`Issues by type: ${Object.entries(fa.summary.byCode).map(([k,v]) => `${k}=${v}`).join(', ')}`);
    if (fa.summary.croRiskPages.length > 0) {
      formLines.push(`CRO risk pages: ${fa.summary.croRiskPages.join(', ')}`);
    }
    // List pages with forms
    const formPages = [...new Set(fa.forms.map(f => f.pageUrl))];
    formLines.push(`\nPages with forms: ${formPages.join(', ')}`);
  }
  formLines.push(`\nScreenshot dir: ${screenshotDir}`);
  contexts['forms'] = formLines.join('\n');

  // ── Mobile context ─────────────────────────────────────────────────
  const mobileLines: string[] = [siteHeader, knownIssues];
  mobileLines.push(`\nKey pages to test: ${keyPages}`);
  if (results.responsive && results.responsive.total_issues > 0) {
    mobileLines.push(`\nLayer 1 responsive check found ${results.responsive.total_issues} issues.`);
    const byVp = results.responsive.summary.by_viewport;
    for (const [vp, count] of Object.entries(byVp)) {
      if (count > 0) mobileLines.push(`  ${vp}: ${count} issues`);
    }
  }
  if (results.lighthouse) {
    mobileLines.push(`\nLighthouse mobile performance: ${results.lighthouse.mobile.performance}/100`);
  }
  mobileLines.push(`\nScreenshot dir: ${screenshotDir}`);
  contexts['mobile'] = mobileLines.join('\n');

  // ── Code features context ──────────────────────────────────────────
  if (results.code_analysis) {
    const ca = results.code_analysis;
    const featureLines: string[] = [siteHeader, knownIssues];
    if (ca.feature_map?.length > 0) {
      featureLines.push(`\n${ca.feature_map.length} custom features to verify:\n`);
      for (const f of ca.feature_map) {
        featureLines.push(`- ${f.name} (${f.type}): ${f.description}`);
        featureLines.push(`  Pages: ${f.pages.join(', ')}`);
        featureLines.push(`  Test: ${f.how_to_test}`);
      }
    }
    if (ca.template_overrides.length > 0) {
      featureLines.push(`\nWC template overrides: ${ca.template_overrides.join(', ')}`);
    }
    if (ca.rest_endpoints?.length > 0) {
      featureLines.push(`\nREST endpoints: ${ca.rest_endpoints.map(e => `${e.methods} /wp-json/${e.namespace}${e.route}`).join(', ')}`);
    }
    featureLines.push(`\nScreenshot dir: ${screenshotDir}`);
    contexts['code-features'] = featureLines.join('\n');
  }

  // ── Write context files to disk ────────────────────────────────────
  for (const [name, content] of Object.entries(contexts)) {
    const filePath = path.join(outputDir, `agent-context-${name}.md`);
    await fs.writeFile(filePath, content, 'utf-8');
  }

  return contexts;
}
