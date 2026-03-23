import {
  Layer1Results,
  CodeAnalysis,
  FixableIssue,
} from '../types.js';

/**
 * Extract all actionable, fixable issues from Layer 1 results
 * into a flat, structured list that an AI can act on.
 *
 * Each issue includes enough context for an AI to understand and fix it
 * without reading the full report.
 */
export function extractFixableIssues(results: Layer1Results): FixableIssue[] {
  const issues: FixableIssue[] = [];
  let idCounter = 1;
  const id = () => `FIX-${String(idCounter++).padStart(3, '0')}`;

  // ── Security findings ──────────────────────────────────────────────────
  if (results.security) {
    for (const f of results.security.findings) {
      if (f.severity === 'info') continue;
      issues.push({
        id: id(),
        severity: f.severity === 'critical' ? 'blocker' : f.severity === 'high' ? 'major' : 'minor',
        category: 'security',
        fix_type: inferSecurityFixType(f.title),
        title: f.title,
        problem: f.detail,
        fix: f.recommendation,
        location: results.site.url,
      });
    }
  }

  // ── WP Core Health findings ────────────────────────────────────────────
  if (results.wp_core_health) {
    for (const f of results.wp_core_health.findings) {
      if (f.severity === 'info') continue;
      issues.push({
        id: id(),
        severity: f.severity === 'critical' ? 'blocker' : f.severity === 'major' ? 'major' : 'minor',
        category: 'wordpress',
        fix_type: inferWPFixType(f.title),
        title: f.title,
        problem: f.detail,
        fix: f.recommendation || '',
        location: results.site.url,
      });
    }
  }

  // ── Plugin updates ─────────────────────────────────────────────────────
  for (const p of results.wordpress_health.plugins_needing_update) {
    issues.push({
      id: id(),
      severity: 'major',
      category: 'plugins',
      fix_type: 'plugin',
      title: `Update ${p.name} (${p.version} → ${p.update_version})`,
      problem: `Plugin ${p.name} has an update available.`,
      fix: `Update via WP admin or run: npx qa-agent update --plugin "${p.slug}"`,
      location: `Plugin: ${p.slug}`,
    });
  }

  // ── Inactive plugins ───────────────────────────────────────────────────
  for (const p of results.wordpress_health.inactive_plugins) {
    issues.push({
      id: id(),
      severity: 'minor',
      category: 'plugins',
      fix_type: 'plugin',
      title: `Remove inactive plugin: ${p.name}`,
      problem: `Plugin ${p.name} is installed but inactive. Unused plugins are a security risk.`,
      fix: `Delete via WP admin Plugins page, or remove the plugin directory.`,
      location: `Plugin: ${p.slug}`,
    });
  }

  // ── Outdated WC template overrides ─────────────────────────────────────
  if (results.wordpress_health.wc_template_overrides_outdated) {
    for (const t of results.wordpress_health.wc_template_overrides_outdated) {
      issues.push({
        id: id(),
        severity: 'major',
        category: 'woocommerce',
        fix_type: 'code',
        title: `Outdated WC template override: ${t}`,
        problem: `Theme overrides WooCommerce template ${t} but it's based on an older WC version. May cause layout/functionality issues.`,
        fix: `Compare your theme's woocommerce/${t} with the current WC version and update. Run: npx qa-agent update-templates --file "${t}"`,
        location: `woocommerce/${t}`,
        code_files: [`woocommerce/${t}`],
      });
    }
  }

  // ── Page health failures ───────────────────────────────────────────────
  for (const p of results.page_health) {
    if (p.ok) continue;
    issues.push({
      id: id(),
      severity: 'blocker',
      category: 'functionality',
      fix_type: 'server',
      title: `Page returns ${p.status}: ${p.page}`,
      problem: `${p.url} returns HTTP ${p.status}${p.error ? `: ${p.error}` : ''}`,
      fix: p.status === 404
        ? 'Check if the page exists in WP admin. If it was moved, set up a redirect.'
        : p.status === 500
          ? 'Check PHP error logs for fatal errors. Likely a plugin conflict or PHP error.'
          : `Investigate why ${p.url} returns ${p.status}.`,
      location: p.url,
    });
  }

  // ── Broken links ───────────────────────────────────────────────────────
  if (results.broken_links.length > 0) {
    // Group by source page to avoid hundreds of individual items
    const bySource = new Map<string, typeof results.broken_links>();
    for (const bl of results.broken_links) {
      const key = bl.source_page;
      if (!bySource.has(key)) bySource.set(key, []);
      bySource.get(key)!.push(bl);
    }
    for (const [source, links] of bySource) {
      issues.push({
        id: id(),
        severity: 'minor',
        category: 'content',
        fix_type: 'content',
        title: `${links.length} broken link(s) on ${source.replace(results.site.url, '') || '/'}`,
        problem: links.map((l) => `${l.link_text || 'link'} → ${l.broken_url} (${l.status})`).join('; '),
        fix: 'Update or remove the broken links in the WP editor for this page.',
        location: source,
      });
    }
  }

  // ── Console errors on critical pages ───────────────────────────────────
  for (const cn of results.console_network) {
    if (cn.console_errors.length === 0) continue;
    const isCheckout = cn.page_url.includes('checkout') || cn.page_url.includes('cart');
    issues.push({
      id: id(),
      severity: isCheckout ? 'major' : 'minor',
      category: isCheckout ? 'woocommerce' : 'functionality',
      fix_type: 'code',
      title: `${cn.console_errors.length} JS error(s) on ${cn.page_url.replace(results.site.url, '') || '/'}`,
      problem: cn.console_errors.slice(0, 5).map((e) => `[${e.type}] ${e.message.slice(0, 150)}`).join('\n'),
      fix: 'Debug the JavaScript errors. Check if a plugin or theme script is conflicting.',
      location: cn.page_url,
    });
  }

  // ── WC JS state issues ─────────────────────────────────────────────────
  for (const cn of results.console_network) {
    if (!cn.wc_js_state) continue;
    const s = cn.wc_js_state;
    if (!s.wc_checkout_params_loaded && cn.page_url.includes('checkout')) {
      issues.push({
        id: id(),
        severity: 'blocker',
        category: 'woocommerce',
        fix_type: 'code',
        title: 'wc_checkout_params not loaded on checkout',
        problem: 'WooCommerce checkout parameters JavaScript object is not loaded. This breaks checkout functionality.',
        fix: 'Check if a caching plugin is stripping inline scripts, or if the WC checkout script is dequeued by the theme. Verify woocommerce/assets/js/frontend/checkout.js is enqueued.',
        location: cn.page_url,
      });
    }
    if (s.wc_errors_visible > 0) {
      issues.push({
        id: id(),
        severity: 'major',
        category: 'woocommerce',
        fix_type: 'code',
        title: `${s.wc_errors_visible} WooCommerce error(s) visible on ${cn.page_url.includes('checkout') ? 'checkout' : 'cart'}`,
        problem: `.woocommerce-error elements visible to users.`,
        fix: 'Check the WooCommerce error messages displayed. Common causes: missing required fields, payment gateway misconfiguration, session expiry.',
        location: cn.page_url,
      });
    }
    // Custom checks failures
    for (const [key, value] of Object.entries(s.custom_checks)) {
      if (!value && key.startsWith('field_') && key.endsWith('_exists')) {
        const fieldName = key.replace('field_', '').replace('_exists', '');
        issues.push({
          id: id(),
          severity: 'major',
          category: 'woocommerce',
          fix_type: 'code',
          title: `Custom checkout field "${fieldName}" not found in DOM`,
          problem: `Code analysis detected a custom checkout field "${fieldName}" but it's not rendered on the checkout page.`,
          fix: `Check the hook callback that adds this field. It may be conditional (user logged in, specific product in cart) or the hook priority may be wrong.`,
          location: cn.page_url,
        });
      }
    }
  }

  // ── Accessibility issues ───────────────────────────────────────────────
  if (results.accessibility) {
    const criticalA11y = results.accessibility.issues.filter((i) => i.severity === 'critical');
    for (const issue of criticalA11y.slice(0, 10)) {
      issues.push({
        id: id(),
        severity: 'major',
        category: 'accessibility',
        fix_type: 'code',
        title: `Accessibility: ${issue.type} on ${issue.page}`,
        problem: issue.detail + (issue.element ? ` Element: ${issue.element}` : ''),
        fix: getA11yFix(issue.type),
        location: issue.page,
      });
    }
  }

  // ── Performance issues ─────────────────────────────────────────────────
  if (results.lighthouse) {
    if (results.lighthouse.mobile.performance < 50) {
      issues.push({
        id: id(),
        severity: 'major',
        category: 'performance',
        fix_type: 'server',
        title: `Poor mobile performance (${results.lighthouse.mobile.performance}/100)`,
        problem: `Lighthouse mobile performance score is ${results.lighthouse.mobile.performance}. LCP: ${results.lighthouse.core_web_vitals.lcp_ms}ms, CLS: ${results.lighthouse.core_web_vitals.cls}.`,
        fix: 'Optimize images (use WebP, add dimensions), enable caching, reduce render-blocking resources, minimize JS/CSS.',
        location: results.site.url,
      });
    }
  }

  // ── Code review findings ──────────────────────────────────────────────
  if (results.code_review) {
    for (const f of results.code_review.findings) {
      issues.push({
        id: id(),
        severity: f.severity === 'critical' ? 'blocker' : f.severity === 'high' ? 'major' : 'minor',
        category: inferReviewCategory(f.checklist),
        fix_type: 'code',
        title: `[${f.checklist}] ${f.message}`,
        problem: `${f.file}:${f.line} — ${f.code_snippet}`,
        fix: f.fix,
        location: f.file,
        code_files: [f.file],
      });
    }
  }

  // ── Code analysis issues ───────────────────────────────────────────────
  if (results.code_analysis) {
    for (const issue of results.code_analysis.potential_issues) {
      issues.push({
        id: id(),
        severity: issue.severity === 'critical' ? 'blocker' : issue.severity === 'major' ? 'major' : 'minor',
        category: 'code',
        fix_type: 'code',
        title: `Code issue in ${issue.file}`,
        problem: issue.issue,
        fix: issue.recommendation,
        location: issue.file,
        code_files: [issue.file],
      });
    }
  }

  // ── Error log issues ───────────────────────────────────────────────────
  if (results.error_logs) {
    const fatalGroups = results.error_logs.grouped.filter((g) => g.level === 'fatal');
    for (const g of fatalGroups.slice(0, 5)) {
      issues.push({
        id: id(),
        severity: 'blocker',
        category: 'functionality',
        fix_type: 'code',
        title: `Fatal error: ${g.message.slice(0, 80)}`,
        problem: `${g.message} (occurred ${g.count} times)`,
        fix: g.files[0]
          ? `Fix the error in ${g.files[0]}. Check for missing dependencies, incorrect function calls, or version incompatibilities.`
          : 'Check PHP error logs for the full stack trace.',
        location: g.files[0] || 'unknown',
        code_files: g.files,
      });
    }

    const errorGroups = results.error_logs.grouped.filter((g) => g.level === 'error');
    for (const g of errorGroups.slice(0, 5)) {
      issues.push({
        id: id(),
        severity: 'major',
        category: 'functionality',
        fix_type: 'code',
        title: `PHP error: ${g.message.slice(0, 80)}`,
        problem: `${g.message} (occurred ${g.count} times)`,
        fix: g.files[0]
          ? `Fix the error in ${g.files[0]}.`
          : 'Check error logs for more context.',
        location: g.files[0] || 'unknown',
        code_files: g.files,
      });
    }
  }

  // ── Review browser checks (forms, localStorage, staging URLs) ────────
  for (const cn of results.console_network) {
    if (!cn.review_checks) continue;
    const rc = cn.review_checks;

    if (rc.forms_without_nonce.length > 0) {
      issues.push({
        id: id(),
        severity: 'major',
        category: 'security',
        fix_type: 'code',
        title: `${rc.forms_without_nonce.length} POST form(s) without nonce on ${cn.page_url.replace(results.site.url, '') || '/'}`,
        problem: `Forms submitting via POST without WordPress nonce fields: ${rc.forms_without_nonce.map(f => f.id).join(', ')}. Vulnerable to CSRF attacks.`,
        fix: 'Add wp_nonce_field() to each form and wp_verify_nonce() in the handler',
        location: cn.page_url,
      });
    }

    if (rc.sensitive_localstorage_keys.length > 0) {
      issues.push({
        id: id(),
        severity: 'major',
        category: 'security',
        fix_type: 'code',
        title: `Sensitive data in localStorage: ${rc.sensitive_localstorage_keys.join(', ')}`,
        problem: `localStorage contains keys with sensitive names: ${rc.sensitive_localstorage_keys.join(', ')}. Any JavaScript on the page can access this data.`,
        fix: 'Move sensitive data to server-side sessions or HTTP-only cookies',
        location: cn.page_url,
      });
    }

    if (rc.staging_urls_found.length > 0) {
      issues.push({
        id: id(),
        severity: 'major',
        category: 'code',
        fix_type: 'code',
        title: `Staging URLs in production page source`,
        problem: `Found staging/dev URLs in page source: ${rc.staging_urls_found.join(', ')}`,
        fix: 'Replace hardcoded URLs with home_url() or site_url(). Check for staging domain references in theme options, widgets, or hardcoded links.',
        location: cn.page_url,
      });
    }
  }

  // ── Image optimization ─────────────────────────────────────────────────
  if (results.image_audit && results.image_audit.oversized_images.length > 5) {
    issues.push({
      id: id(),
      severity: 'minor',
      category: 'performance',
      fix_type: 'plugin',
      title: `${results.image_audit.oversized_images.length} oversized images`,
      problem: `${results.image_audit.oversized_images.length} images are larger than needed for their display size, adding unnecessary page weight.`,
      fix: 'Install an image optimization plugin (ShortPixel, Imagify, or Smush) to automatically resize and compress images. Serve WebP format where supported.',
      location: results.site.url,
    });
  }

  return issues;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function inferSecurityFixType(title: string): FixableIssue['fix_type'] {
  if (/header/i.test(title)) return 'server';
  if (/exposed|accessible|directory/i.test(title)) return 'server';
  if (/plugin/i.test(title)) return 'plugin';
  if (/debug|error/i.test(title)) return 'config';
  return 'server';
}

function inferWPFixType(title: string): FixableIssue['fix_type'] {
  if (/version|update|outdated/i.test(title)) return 'config';
  if (/debug|memory|cron/i.test(title)) return 'config';
  if (/ssl|redirect|http/i.test(title)) return 'server';
  if (/cache/i.test(title)) return 'plugin';
  return 'config';
}

function inferReviewCategory(checklist: string): FixableIssue['category'] {
  switch (checklist) {
    case 'php-security': return 'security';
    case 'woocommerce': return 'woocommerce';
    case 'database': return 'performance';
    case 'rest-api': return 'security';
    case 'javascript': return 'security';
    case 'architecture': return 'code';
    default: return 'code';
  }
}

function getA11yFix(type: string): string {
  const fixes: Record<string, string> = {
    'missing-alt': 'Add descriptive alt text to images. For decorative images, use alt="".',
    'contrast': 'Increase color contrast ratio to at least 4.5:1 for normal text, 3:1 for large text.',
    'missing-label': 'Add <label> elements to form inputs, or use aria-label/aria-labelledby.',
    'heading-hierarchy': 'Fix heading levels to follow a logical order (h1 → h2 → h3). Don\'t skip levels.',
    'focus-indicator': 'Add visible focus styles (:focus-visible) to interactive elements.',
    'aria': 'Fix ARIA attributes — ensure roles are valid, required properties are present.',
    'touch-target': 'Increase touch target size to at least 44x44px for mobile.',
    'skip-link': 'Add a "Skip to main content" link as the first focusable element.',
  };
  return fixes[type] || 'Fix the accessibility issue per WCAG 2.1 guidelines.';
}
