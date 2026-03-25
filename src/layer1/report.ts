import fs from 'fs/promises';
import path from 'path';
import { Layer1Results } from '../types.js';
import { fmtMs } from '../utils.js';
import { markdownToPdf } from '../pdf.js';
import { buildFormAuditReport } from './checks/form-audit.js';

function fmtBytes(bytes: number): string {
  if (bytes === 0) return '0B';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Generate a Markdown report from Layer 1 results.
 */
export async function generateLayer1Report(
  results: Layer1Results,
  outputDir: string
): Promise<string> {
  const lines: string[] = [];
  const w = (...args: string[]) => lines.push(args.join(''));

  w(`# Layer 1 QA Report — ${results.site.name}`);
  w(`Generated: ${results.tested_at}`);
  w(`Duration: ${fmtMs(results.duration_ms)}`);
  w(`Mode: ${results.tester_mode}`);
  w('');

  // ── Summary ──────────────────────────────────────────────────────────
  w('## Summary');
  w('');
  w('| Check | Status | Detail |');
  w('|-------|--------|--------|');
  for (const c of results.checks) {
    const icon = { PASS: '✅', FAIL: '❌', WARN: '⚠️', ERROR: '🔴', SKIP: '⏭️' }[c.status];
    w(`| ${c.check} | ${icon} ${c.status} | ${c.detail || ''} |`);
  }
  w('');

  // ── WordPress Health ─────────────────────────────────────────────────
  w('## WordPress Health');
  w('');
  const wp = results.wordpress_health;
  w(`- **REST API:** ${wp.rest_api_accessible ? 'Accessible' : 'Not accessible'}`);
  w(`- **Site Name:** ${wp.site_name || 'N/A'}`);
  w(`- **WooCommerce:** ${wp.woocommerce_detected ? `Detected (v${wp.wc_version || '?'})` : 'Not detected'}`);
  w(`- **Plugins:** ${wp.plugins.length} total`);
  w('');

  if (wp.plugins_needing_update.length > 0) {
    w('### Plugins Needing Updates');
    w('');
    w('| Plugin | Current | Available |');
    w('|--------|---------|-----------|');
    for (const p of wp.plugins_needing_update) {
      w(`| ${p.name} | ${p.version} | ${p.update_version || '?'} |`);
    }
    w('');
  }

  if (wp.inactive_plugins.length > 0) {
    w('### Inactive Plugins');
    w('');
    for (const p of wp.inactive_plugins) {
      w(`- ${p.name} (v${p.version})`);
    }
    w('');
  }

  if (wp.wc_template_overrides_outdated && wp.wc_template_overrides_outdated.length > 0) {
    w('### Outdated WooCommerce Template Overrides');
    w('');
    for (const t of wp.wc_template_overrides_outdated) {
      w(`- \`${t}\``);
    }
    w('');
  }

  // ── Lighthouse ───────────────────────────────────────────────────────
  if (results.lighthouse) {
    const lh = results.lighthouse;
    w('## Lighthouse Performance');
    w('');
    w('| Metric | Mobile | Desktop |');
    w('|--------|--------|---------|');
    w(`| Performance | ${lh.mobile.performance} | ${lh.desktop.performance} |`);
    w(`| Accessibility | ${lh.mobile.accessibility} | ${lh.desktop.accessibility} |`);
    w(`| Best Practices | ${lh.mobile.best_practices} | ${lh.desktop.best_practices} |`);
    w(`| SEO | ${lh.mobile.seo} | ${lh.desktop.seo} |`);
    w('');
    w('### Core Web Vitals (Mobile)');
    w('');
    const cwv = lh.core_web_vitals;
    w(`| Metric | Value | Target |`);
    w(`|--------|-------|--------|`);
    w(`| LCP | ${fmtMs(cwv.lcp_ms)} | < 2500ms |`);
    w(`| FID | ${fmtMs(cwv.fid_ms)} | < 100ms |`);
    w(`| CLS | ${cwv.cls} | < 0.1 |`);
    w(`| FCP | ${fmtMs(cwv.fcp_ms)} | < 1800ms |`);
    w(`| TTFB | ${fmtMs(cwv.ttfb_ms)} | < 800ms |`);
    w('');
  }

  // ── Page Health ──────────────────────────────────────────────────────
  if (results.page_health.length > 0) {
    w('## Page Health');
    w('');
    w('| Page | Status | Load Time | OK |');
    w('|------|--------|-----------|----|');
    for (const p of results.page_health) {
      const icon = p.ok ? '✅' : '❌';
      w(`| ${p.page} | ${p.status} | ${fmtMs(p.load_time_ms)} | ${icon} |`);
    }
    w('');
  }

  // ── Broken Links ─────────────────────────────────────────────────────
  if (results.broken_links.length > 0) {
    w('## Broken Links');
    w('');
    w('| Source | Broken URL | Status | Link Text |');
    w('|-------|-----------|--------|-----------|');
    for (const bl of results.broken_links) {
      const shortSource = bl.source_page.replace(results.site.url, '');
      const shortUrl = bl.broken_url.replace(results.site.url, '');
      w(`| ${shortSource} | ${shortUrl} | ${bl.status} | ${bl.link_text || ''} |`);
    }
    w('');
  }

  // ── Console & Network ────────────────────────────────────────────────
  const totalErrors = results.console_network.reduce(
    (n, cn) => n + cn.console_errors.length,
    0
  );
  const totalFailures = results.console_network.reduce(
    (n, cn) => n + cn.network_failures.length,
    0
  );

  if (totalErrors > 0 || totalFailures > 0) {
    w('## Console Errors & Network Failures');
    w('');
    w(`Total console errors: ${totalErrors}`);
    w(`Total network failures: ${totalFailures}`);
    w('');

    for (const cn of results.console_network) {
      if (cn.console_errors.length === 0 && cn.network_failures.length === 0) continue;
      const shortUrl = cn.page_url.replace(results.site.url, '') || '/';
      w(`### ${shortUrl}`);
      w('');
      if (cn.console_errors.length > 0) {
        w('**Console Errors:**');
        for (const e of cn.console_errors.slice(0, 10)) {
          w(`- \`[${e.type}]\` ${e.message.slice(0, 120)}`);
        }
        w('');
      }
      if (cn.network_failures.length > 0) {
        w('**Network Failures:**');
        for (const f of cn.network_failures.slice(0, 10)) {
          w(`- \`${f.method} ${f.url.slice(0, 80)}\` → ${f.status || f.reason}`);
        }
        w('');
      }
    }
  }

  // ── WooCommerce JS State ─────────────────────────────────────────────
  const wcStates = results.console_network
    .filter((cn) => cn.wc_js_state)
    .map((cn) => ({ url: cn.page_url, state: cn.wc_js_state! }));

  if (wcStates.length > 0) {
    w('## WooCommerce JS State');
    w('');
    for (const { url, state } of wcStates) {
      const shortUrl = url.replace(results.site.url, '') || '/';
      w(`### ${shortUrl}`);
      w('');
      w(`- wc_checkout_params: ${state.wc_checkout_params_loaded ? '✅ loaded' : '❌ missing'}`);
      w(`- wc_cart_params: ${state.wc_cart_params_loaded ? '✅ loaded' : '❌ missing'}`);
      if (state.stripe_loaded !== undefined)
        w(`- Stripe: ${state.stripe_loaded ? '✅ loaded' : '❌ not loaded'}`);
      if (state.paypal_loaded !== undefined)
        w(`- PayPal: ${state.paypal_loaded ? '✅ loaded' : '❌ not loaded'}`);
      if (state.checkout_url) w(`- Checkout URL: ${state.checkout_url}`);
      if (state.wc_errors_visible > 0)
        w(`- ⚠️ **${state.wc_errors_visible} WooCommerce errors visible on page**`);
      // Custom checks from code analysis
      const customEntries = Object.entries(state.custom_checks || {});
      if (customEntries.length > 0) {
        w('- **Code-analysis custom checks:**');
        for (const [key, value] of customEntries) {
          w(`  - ${value ? '✅' : '❌'} \`${key}\`: ${value}`);
        }
      }
      w('');
    }
  }

  // ── Security Scan ───────────────────────────────────────────────────
  if (results.security) {
    const sec = results.security;
    w('## Security Scan');
    w('');
    w(`**Overall Risk:** ${sec.overall_risk.toUpperCase()}`);
    w(`**Findings:** ${sec.findings.length} (${sec.summary.critical} critical, ${sec.summary.high} high, ${sec.summary.medium} medium, ${sec.summary.low} low, ${sec.summary.info} info)`);
    w('');

    // Security headers
    w('### Security Headers');
    w('');
    w('| Header | Value |');
    w('|--------|-------|');
    const h = sec.headers;
    w(`| X-Frame-Options | ${h.x_frame_options || '❌ Missing'} |`);
    w(`| Content-Security-Policy | ${h.content_security_policy ? '✅ Present' : '❌ Missing'} |`);
    w(`| X-Content-Type-Options | ${h.x_content_type_options || '❌ Missing'} |`);
    w(`| Strict-Transport-Security | ${h.strict_transport_security ? '✅ Present' : '❌ Missing'} |`);
    w(`| Referrer-Policy | ${h.referrer_policy || '❌ Missing'} |`);
    w(`| Permissions-Policy | ${h.permissions_policy ? '✅ Present' : '❌ Missing'} |`);
    w('');

    // Exposed files
    if (sec.exposed_files.length > 0) {
      w('### Exposed Files');
      w('');
      w('| Path | Status | Risk |');
      w('|------|--------|------|');
      for (const ef of sec.exposed_files) {
        w(`| \`${ef.path}\` | ${ef.status} | ${ef.risk} |`);
      }
      w('');
    }

    // Findings by severity
    const criticalFindings = sec.findings.filter(f => f.severity === 'critical' || f.severity === 'high');
    const mediumFindings = sec.findings.filter(f => f.severity === 'medium');
    const lowFindings = sec.findings.filter(f => f.severity === 'low' || f.severity === 'info');

    if (criticalFindings.length > 0) {
      w('### Critical & High Findings');
      w('');
      for (const f of criticalFindings) {
        w(`- **[${f.severity.toUpperCase()}]** ${f.title}`);
        w(`  ${f.detail}`);
        w(`  *Fix:* ${f.recommendation}`);
      }
      w('');
    }

    if (mediumFindings.length > 0) {
      w('### Medium Findings');
      w('');
      for (const f of mediumFindings) {
        w(`- **${f.title}**: ${f.detail}`);
        w(`  *Fix:* ${f.recommendation}`);
      }
      w('');
    }

    if (lowFindings.length > 0) {
      w('### Low / Info Findings');
      w('');
      for (const f of lowFindings) {
        w(`- ${f.title}: ${f.detail}`);
      }
      w('');
    }
  }

  // ── WordPress Core Health ──────────────────────────────────────────
  if (results.wp_core_health) {
    const wch = results.wp_core_health;
    w('## WordPress Core Health');
    w('');
    w('| Metric | Value | Status |');
    w('|--------|-------|--------|');
    w(`| WordPress Version | ${wch.wp_version} | ${wch.wp_version_status === 'current' ? '✅' : wch.wp_version_status === 'insecure' ? '🚨' : '⚠️'} ${wch.wp_version_status} |`);
    if (wch.php_version) {
      w(`| PHP Version | ${wch.php_version} | ${wch.php_version_status === 'current' ? '✅' : wch.php_version_status === 'eol' ? '🚨' : '⚠️'} ${wch.php_version_status} |`);
    }
    w(`| Debug Mode | ${wch.debug_mode} | ${wch.debug_mode === 'disabled' ? '✅' : wch.debug_mode === 'enabled' ? '🚨' : '❓'} |`);
    w(`| Error Display | ${wch.error_display} | ${wch.error_display === 'disabled' ? '✅' : wch.error_display === 'enabled' ? '🚨' : '❓'} |`);
    w(`| WP-Cron | ${wch.wp_cron_status} | ${wch.wp_cron_status === 'enabled' ? '✅' : wch.wp_cron_status === 'disabled' ? '⚠️' : '❓'} |`);
    w(`| Object Cache | ${wch.object_cache} | ${wch.object_cache === 'redis' || wch.object_cache === 'memcached' ? '✅' : '⚠️'} |`);
    if (wch.memory_limit) w(`| Memory Limit | ${wch.memory_limit} | |`);
    if (wch.max_upload_size) w(`| Max Upload | ${wch.max_upload_size} | |`);
    w(`| Multisite | ${wch.multisite ? 'Yes' : 'No'} | |`);
    w(`| SSL Valid | ${wch.ssl_certificate.valid ? '✅ Yes' : '❌ No'} | ${wch.ssl_certificate.days_until_expiry !== undefined ? `Expires in ${wch.ssl_certificate.days_until_expiry} days` : ''} |`);
    w(`| HTTPS Redirect | ${wch.https_redirect ? '✅ Yes' : '❌ No'} | |`);
    w('');

    if (wch.findings.length > 0) {
      w('### Core Health Findings');
      w('');
      for (const f of wch.findings) {
        const icon = { critical: '🚨', major: '⚠️', minor: '💡', info: 'ℹ️' }[f.severity];
        w(`- ${icon} **[${f.severity}]** ${f.title}`);
        w(`  ${f.detail}`);
        if (f.recommendation) w(`  *Fix:* ${f.recommendation}`);
      }
      w('');
    }
  }

  // ── Accessibility Audit ────────────────────────────────────────────
  if (results.accessibility) {
    const a11y = results.accessibility;
    w('## Accessibility Audit (WCAG 2.1)');
    w('');
    w(`Pages tested: ${a11y.pages_tested} | Total issues: ${a11y.total_issues}`);
    w('');

    w('| Category | Count |');
    w('|----------|-------|');
    w(`| Missing alt text | ${a11y.summary.missing_alt_text} |`);
    w(`| Contrast issues | ${a11y.summary.contrast_issues} |`);
    w(`| Missing form labels | ${a11y.summary.missing_labels} |`);
    w(`| Heading hierarchy | ${a11y.summary.heading_issues} |`);
    w(`| Focus indicators | ${a11y.summary.focus_issues} |`);
    w(`| ARIA issues | ${a11y.summary.aria_issues} |`);
    w(`| Touch targets | ${a11y.summary.touch_target_issues} |`);
    w(`| Skip-to-content link | ${a11y.summary.skip_link_present ? '✅ Present' : '❌ Missing'} |`);
    w('');

    const criticalA11y = a11y.issues.filter(i => i.severity === 'critical');
    const majorA11y = a11y.issues.filter(i => i.severity === 'major');
    const minorA11y = a11y.issues.filter(i => i.severity === 'minor');

    if (criticalA11y.length > 0) {
      w('### Critical Issues');
      w('');
      for (const issue of criticalA11y) {
        w(`- **${issue.page}** [${issue.wcag_criterion || issue.type}]: ${issue.detail}`);
        if (issue.element) w(`  Element: \`${issue.element}\``);
      }
      w('');
    }

    if (majorA11y.length > 0) {
      w('### Major Issues');
      w('');
      for (const issue of majorA11y.slice(0, 20)) {
        w(`- **${issue.page}** [${issue.wcag_criterion || issue.type}]: ${issue.detail}`);
        if (issue.element) w(`  Element: \`${issue.element}\``);
      }
      if (majorA11y.length > 20) w(`*...and ${majorA11y.length - 20} more major issues*`);
      w('');
    }

    if (minorA11y.length > 0) {
      w('### Minor Issues');
      w('');
      for (const issue of minorA11y.slice(0, 15)) {
        w(`- **${issue.page}** [${issue.type}]: ${issue.detail}`);
      }
      if (minorA11y.length > 15) w(`*...and ${minorA11y.length - 15} more minor issues*`);
      w('');
    }
  }

  // ── Performance Deep-Dive ──────────────────────────────────────────
  if (results.performance_deep_dive) {
    const perf = results.performance_deep_dive;
    w('## Performance Deep-Dive');
    w('');

    // Page weight table
    if (perf.pages.length > 0) {
      w('### Page Weight Breakdown');
      w('');
      w('| Page | Total | HTML | CSS | JS | Images | Fonts | Requests | Render-Blocking | TTFB |');
      w('|------|-------|------|-----|-----|--------|-------|----------|-----------------|------|');
      for (const p of perf.pages) {
        w(`| ${p.page} | ${fmtBytes(p.total_weight_bytes)} | ${fmtBytes(p.html_bytes)} | ${fmtBytes(p.css_bytes)} | ${fmtBytes(p.js_bytes)} | ${fmtBytes(p.image_bytes)} | ${fmtBytes(p.font_bytes)} | ${p.request_count} | ${p.render_blocking_count} | ${fmtMs(p.ttfb_ms)} |`);
      }
      w('');
    }

    // Third-party audit
    if (perf.third_party_audit.length > 0) {
      w('### Third-Party Scripts');
      w('');
      w('| Domain | Category | Requests | Size | Duration |');
      w('|--------|----------|----------|------|----------|');
      for (const tp of perf.third_party_audit.slice(0, 15)) {
        w(`| ${tp.domain} | ${tp.category} | ${tp.urls.length} | ${fmtBytes(tp.total_size_bytes)} | ${fmtMs(tp.total_duration_ms)} |`);
      }
      w('');
    }

    // Compression
    w('### Compression');
    w('');
    w(`- GZIP: ${perf.compression.gzip_enabled ? '✅ Enabled' : '❌ Disabled'}`);
    w(`- Brotli: ${perf.compression.brotli_enabled ? '✅ Enabled' : '❌ Disabled'}`);
    if (perf.compression.uncompressed_resources.length > 0) {
      w(`- Uncompressed resources: ${perf.compression.uncompressed_resources.length}`);
    }
    w('');

    // Cache headers
    const uncached = perf.cache_headers.filter(c => !c.has_cache);
    if (uncached.length > 0) {
      w('### Resources Missing Cache Headers');
      w('');
      for (const c of uncached.slice(0, 10)) {
        const shortUrl = c.url.length > 80 ? c.url.slice(0, 77) + '...' : c.url;
        w(`- \`${shortUrl}\` (${c.type})`);
      }
      if (uncached.length > 10) w(`*...and ${uncached.length - 10} more*`);
      w('');
    }

    // Font loading
    if (perf.font_loading.length > 0) {
      w('### Font Loading');
      w('');
      w('| Font | Format | Display | Preloaded |');
      w('|------|--------|---------|-----------|');
      for (const f of perf.font_loading) {
        const shortUrl = f.url.split('/').pop() || f.url;
        w(`| ${shortUrl} | ${f.format} | ${f.display_strategy} | ${f.is_preloaded ? '✅' : '❌'} |`);
      }
      w('');
    }
  }

  // ── Image Optimization Audit ───────────────────────────────────────
  if (results.image_audit) {
    const img = results.image_audit;
    w('## Image Optimization Audit');
    w('');
    w(`Pages scanned: ${img.pages_scanned} | Total images: ${img.total_images} | Total weight: ${fmtBytes(img.total_image_weight_bytes)}`);
    w('');

    w('| Metric | Value |');
    w('|--------|-------|');
    w(`| Oversized images | ${img.oversized_images.length} |`);
    w(`| Missing dimensions | ${img.missing_dimensions.length} |`);
    w(`| Below-fold without lazy loading | ${img.lazy_loading.without_lazy_loading} / ${img.lazy_loading.total_below_fold} |`);
    w(`| Without srcset | ${img.responsive_images.without_srcset} / ${img.responsive_images.total} |`);
    w(`| WebP supported | ${img.format_support.webp_supported ? '✅' : '❌'} |`);
    w(`| AVIF supported | ${img.format_support.avif_supported ? '✅' : '❌'} |`);
    w(`| Serving modern formats | ${img.format_support.serving_modern_formats ? '✅' : '❌'} |`);
    w(`| Optimization plugin | ${img.optimization_plugin_detected ? `✅ ${img.optimization_plugin_name}` : '❌ None detected'} |`);
    w('');

    if (img.oversized_images.length > 0) {
      w('### Oversized Images');
      w('');
      w('| Page | URL | Size | Natural | Display |');
      w('|------|-----|------|---------|---------|');
      for (const oi of img.oversized_images.slice(0, 15)) {
        const shortUrl = oi.url.length > 60 ? '...' + oi.url.slice(-57) : oi.url;
        const natural = oi.natural_width ? `${oi.natural_width}x${oi.natural_height}` : '?';
        const display = oi.display_width ? `${oi.display_width}x${oi.display_height}` : '?';
        w(`| ${oi.page} | ${shortUrl} | ${fmtBytes(oi.size_bytes)} | ${natural} | ${display} |`);
      }
      if (img.oversized_images.length > 15) w(`*...and ${img.oversized_images.length - 15} more*`);
      w('');
    }

    if (img.missing_dimensions.length > 0) {
      w('### Images Missing Dimensions');
      w('');
      for (const md of img.missing_dimensions.slice(0, 10)) {
        const shortUrl = md.url.length > 60 ? '...' + md.url.slice(-57) : md.url;
        w(`- **${md.page}**: \`${shortUrl}\` — missing ${md.missing}`);
      }
      if (img.missing_dimensions.length > 10) w(`*...and ${img.missing_dimensions.length - 10} more*`);
      w('');
    }
  }

  // ── Error Log Analysis ───────────────────────────────────────────────
  if (results.error_logs && results.error_logs.total_entries > 0) {
    const el = results.error_logs;
    w('## Error Log Analysis');
    w('');
    w(`Sources checked: ${el.sources_checked.length} | Accessible: ${el.sources_accessible.length} | Total entries: ${el.total_entries}`);
    w('');

    // Severity breakdown
    w('| Level | Count |');
    w('|-------|-------|');
    if (el.severity_counts.fatal > 0) w(`| Fatal | ${el.severity_counts.fatal} |`);
    if (el.severity_counts.error > 0) w(`| Error | ${el.severity_counts.error} |`);
    if (el.severity_counts.warning > 0) w(`| Warning | ${el.severity_counts.warning} |`);
    if (el.severity_counts.notice > 0) w(`| Notice | ${el.severity_counts.notice} |`);
    if (el.severity_counts.deprecated > 0) w(`| Deprecated | ${el.severity_counts.deprecated} |`);
    if (el.severity_counts.parse > 0) w(`| Parse Error | ${el.severity_counts.parse} |`);
    w('');

    // Accessible log sources (security concern if HTTP)
    const httpSources = el.sources_accessible.filter(s => s.startsWith('HTTP:'));
    if (httpSources.length > 0) {
      w('### ⚠️ Publicly Accessible Logs');
      w('');
      w('These log files are accessible via HTTP and may expose sensitive information:');
      for (const src of httpSources) {
        w(`- \`${src.replace('HTTP: ', '')}\``);
      }
      w('');
    }

    // Top issues (grouped)
    if (el.grouped.length > 0) {
      w('### Top Issues (by frequency)');
      w('');
      w('| Level | Count | Message | File |');
      w('|-------|-------|---------|------|');
      for (const g of el.grouped.slice(0, 20)) {
        const icon = { fatal: '🚨', error: '❌', warning: '⚠️', notice: '💡', deprecated: '📦', parse: '🚨', other: 'ℹ️' }[g.level];
        const shortMsg = g.message.length > 80 ? g.message.slice(0, 77) + '...' : g.message;
        const file = g.files[0] ? g.files[0].split('/').pop() : '';
        w(`| ${icon} ${g.level} | ${g.count} | ${shortMsg} | ${file} |`);
      }
      if (el.grouped.length > 20) w(`*...and ${el.grouped.length - 20} more unique issues*`);
      w('');
    }

    // Recent entries (last 24h)
    if (el.recent_entries.length > 0) {
      w(`### Recent Errors (last 24h): ${el.recent_entries.length}`);
      w('');
      for (const e of el.recent_entries.slice(0, 10)) {
        const icon = { fatal: '🚨', error: '❌', warning: '⚠️', notice: '💡', deprecated: '📦', parse: '🚨', other: 'ℹ️' }[e.level];
        w(`- ${icon} **${e.level}** ${e.message.slice(0, 100)}`);
        if (e.file) w(`  File: \`${e.file}\`${e.line ? `:${e.line}` : ''}`);
      }
      if (el.recent_entries.length > 10) w(`*...and ${el.recent_entries.length - 10} more recent entries*`);
      w('');
    }
  }

  // ── Code Analysis ────────────────────────────────────────────────────
  if (results.code_analysis) {
    const ca = results.code_analysis;
    w('## Code Analysis');
    w('');
    w(`- **Theme:** ${ca.theme_name}`);
    w(`- **Mode:** with-code (full theme scan)`);
    w('');

    // Summary table
    w('| Feature | Count |');
    w('|---------|-------|');
    w(`| Custom features | ${ca.custom_features_found.length} |`);
    w(`| WC template overrides | ${ca.template_overrides.length} |`);
    w(`| WooCommerce hooks | ${ca.active_hooks.length} |`);
    w(`| REST endpoints | ${ca.rest_endpoints?.length || 0} |`);
    w(`| AJAX handlers | ${ca.ajax_handlers?.length || 0} |`);
    w(`| Custom checkout fields | ${ca.custom_checkout_fields?.length || 0} |`);
    w(`| Custom product tabs | ${ca.custom_product_tabs?.length || 0} |`);
    w(`| Page templates | ${ca.page_templates?.length || 0} |`);
    w(`| Gutenberg blocks | ${ca.gutenberg_blocks?.length || 0} |`);
    w(`| Custom widgets | ${ca.custom_widgets?.length || 0} |`);
    w(`| Custom post types | ${ca.custom_post_types?.length || 0} |`);
    w(`| Shortcodes | ${ca.shortcodes?.length || 0} |`);
    w(`| JS source files | ${ca.js_source_files?.length || 0} |`);
    w(`| Code issues | ${ca.potential_issues.length} |`);
    w('');

    if (ca.custom_features_found.length > 0) {
      w('### Detected Features');
      for (const f of ca.custom_features_found) w(`- ${f}`);
      w('');
    }

    if (ca.rest_endpoints && ca.rest_endpoints.length > 0) {
      w('### REST API Endpoints');
      for (const ep of ca.rest_endpoints) {
        w(`- \`${ep.methods} /wp-json/${ep.namespace}${ep.route}\` — \`${ep.file}\``);
      }
      w('');
    }

    if (ca.ajax_handlers && ca.ajax_handlers.length > 0) {
      w('### AJAX Handlers');
      for (const h of ca.ajax_handlers) {
        w(`- \`${h.action}\`${h.is_nopriv ? ' (public)' : ''} — \`${h.file}\``);
      }
      w('');
    }

    if (ca.custom_checkout_fields && ca.custom_checkout_fields.length > 0) {
      w('### Custom Checkout Modifications');
      for (const f of ca.custom_checkout_fields) {
        w(`- \`${f.hook}\` — \`${f.file}\``);
      }
      w('');
    }

    if (ca.template_overrides.length > 0) {
      w('### WooCommerce Template Overrides');
      for (const t of ca.template_overrides) w(`- \`${t}\``);
      w('');
    }

    if (ca.page_templates && ca.page_templates.length > 0) {
      w('### Custom Page Templates');
      for (const t of ca.page_templates) w(`- "${t.name}" — \`${t.file}\``);
      w('');
    }

    if (ca.active_hooks.length > 0) {
      w('### WooCommerce Hooks');
      const checkoutHooks = ca.active_hooks.filter((h) => h.includes('checkout'));
      const cartHooks = ca.active_hooks.filter((h) => h.includes('cart'));
      const productHooks = ca.active_hooks.filter((h) => h.includes('product'));
      const otherHooks = ca.active_hooks.filter(
        (h) => !h.includes('checkout') && !h.includes('cart') && !h.includes('product')
      );
      if (checkoutHooks.length) w(`- **Checkout:** ${checkoutHooks.join(', ')}`);
      if (cartHooks.length) w(`- **Cart:** ${cartHooks.join(', ')}`);
      if (productHooks.length) w(`- **Product:** ${productHooks.join(', ')}`);
      if (otherHooks.length) w(`- **Other:** ${otherHooks.join(', ')}`);
      w('');
    }

    if (ca.potential_issues.length > 0) {
      w('### Code Issues');
      w('');
      for (const issue of ca.potential_issues) {
        w(`- **[${issue.severity}]** \`${issue.file}\`: ${issue.issue}`);
        w(`  - Fix: ${issue.recommendation}`);
      }
      w('');
    }

    if (ca.test_recommendations.length > 0) {
      w('### Test Recommendations');
      for (const r of ca.test_recommendations) w(`- ${r}`);
      w('');
    }

    // Feature map — enriched test-case-ready descriptions
    if (ca.feature_map && ca.feature_map.length > 0) {
      w('### Feature Map');
      w('');
      w('Detected features with specific test instructions:');
      w('');
      for (const f of ca.feature_map) {
        w(`#### ${f.name}`);
        w(`**Type:** ${f.type} | **Pages:** ${f.pages.join(', ')}`);
        w(`**What it does:** ${f.description}`);
        w(`**How to test:** ${f.how_to_test}`);
        if (f.depends_on && f.depends_on.length > 0) {
          w(`**Depends on:** ${f.depends_on.join(', ')}`);
        }
        w('');
      }
    }

    // Enriched checkout field details
    if (ca.checkout_field_details && ca.checkout_field_details.length > 0) {
      const withFields = ca.checkout_field_details.filter((d) => d.fields.length > 0);
      if (withFields.length > 0) {
        w('### Checkout Field Details');
        w('');
        for (const cf of withFields) {
          w(`**${cf.hook}** (${cf.file})`);
          if (cf.condition) w(`Condition: ${cf.condition}`);
          w('');
          w('| Field | Type | Label | Required |');
          w('|-------|------|-------|----------|');
          for (const f of cf.fields) {
            w(`| \`${f.name}\` | ${f.type} | ${f.label} | ${f.required ? '✅' : '❌'} |`);
          }
          w('');
        }
      }
    }

    // Enriched post type details
    if (ca.post_type_details && ca.post_type_details.length > 0) {
      const custom = ca.post_type_details.filter((d) => !['post', 'page', 'product', 'attachment'].includes(d.slug));
      if (custom.length > 0) {
        w('### Custom Post Type Details');
        w('');
        w('| Slug | Label | Archive | Public | Supports |');
        w('|------|-------|---------|--------|----------|');
        for (const cpt of custom) {
          w(`| \`${cpt.slug}\` | ${cpt.label || cpt.slug} | ${cpt.has_archive ? '✅' : '❌'} | ${cpt.public ? '✅' : '❌'} | ${cpt.supports.join(', ')} |`);
        }
        w('');
      }
    }

    // Enriched shortcode details
    if (ca.shortcode_details && ca.shortcode_details.length > 0) {
      w('### Shortcode Details');
      w('');
      for (const sc of ca.shortcode_details) {
        w(`- **[${sc.tag}]** — ${sc.description}`);
        if (sc.accepted_attributes.length > 0) {
          w(`  Attributes: ${sc.accepted_attributes.join(', ')}`);
        }
      }
      w('');
    }
  }

  // ── Code Review ──────────────────────────────────────────────────────
  if (results.code_review && results.code_review.total_findings > 0) {
    const cr = results.code_review;
    w('## Code Review');
    w('');
    w(`Files scanned: ${cr.files_scanned} (${cr.php_files_scanned} PHP, ${cr.js_files_scanned} JS)`);
    w(`Checklists applied: ${cr.checklists_applied.join(', ')}`);
    w('');
    w(`| Severity | Count |`);
    w(`|----------|-------|`);
    w(`| 🔴 Critical | ${cr.summary.critical} |`);
    w(`| 🟠 High | ${cr.summary.high} |`);
    w(`| 🟡 Medium | ${cr.summary.medium} |`);
    w(`| 🔵 Low | ${cr.summary.low} |`);
    w('');

    // Group by checklist
    const byChecklist = new Map<string, typeof cr.findings>();
    for (const f of cr.findings) {
      if (!byChecklist.has(f.checklist)) byChecklist.set(f.checklist, []);
      byChecklist.get(f.checklist)!.push(f);
    }

    const sevIcon: Record<string, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' };

    for (const [checklist, findings] of byChecklist) {
      w(`### ${checklist}`);
      w('');
      for (const f of findings.slice(0, 20)) {
        w(`- ${sevIcon[f.severity]} **${f.message}**`);
        w(`  \`${f.file}:${f.line}\` — \`${f.code_snippet.slice(0, 100)}\``);
        w(`  Fix: ${f.fix}`);
      }
      if (findings.length > 20) {
        w(`- ... and ${findings.length - 20} more findings in this checklist`);
      }
      w('');
    }
  }

  // ── Form Audit ──────────────────────────────────────────────────────
  if (results.form_audit) {
    w(buildFormAuditReport(results.form_audit));
  }

  // ── Layer 2 Queue ────────────────────────────────────────────────────
  if (results.layer2_queue.length > 0) {
    w('## Layer 2 Investigation Queue');
    w('');
    w('These items require Claude-powered adaptive testing:');
    w('');
    for (const item of results.layer2_queue) {
      const icon = { high: '🔴', medium: '🟡', low: '🟢' }[item.priority];
      w(`### ${icon} ${item.id}`);
      w(`**Trigger:** ${item.trigger}`);
      w(`**Instruction:** ${item.instruction}`);
      w(`**Pages:** ${item.pages.join(', ')}`);
      w('');
    }
  }

  // ── Write file ───────────────────────────────────────────────────────
  const markdown = lines.join('\n');
  const reportPath = path.join(outputDir, 'layer1-report.md');
  await fs.writeFile(reportPath, markdown, 'utf-8');

  // Generate PDF version
  try {
    await markdownToPdf(reportPath);
  } catch (err: any) {
    // PDF generation is best-effort — don't fail the run
    // (e.g. Chromium may not be available in some environments)
  }

  return reportPath;
}
