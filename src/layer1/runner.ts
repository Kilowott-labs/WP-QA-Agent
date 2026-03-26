import path from 'path';
import {
  SiteConfig,
  Layer1Results,
  Layer2Investigation,
  CheckResult,
  RunOptions,
  CodeAnalysis,
  CodeReviewResult,
} from '../types.js';
import { extractFixableIssues } from '../fix/issue-extractor.js';
import { logger, ensureDir, writeJson, slugify, elapsed, fmtMs } from '../utils.js';
import { launchBrowser } from './browser.js';
import { discoverPages } from './checks/discover-pages.js';
import { checkPageHealth } from './checks/page-health.js';
import { runLighthouse } from './checks/lighthouse.js';
import { checkWordPressHealth } from './checks/wp-api.js';
import { findBrokenLinks } from './checks/broken-links.js';
import { checkConsoleAndNetwork } from './checks/console-network.js';
import { analyseProjectCode } from './checks/code-analysis.js';
import { runAccessibilityAudit } from './checks/accessibility.js';
import { runSecurityScan } from './checks/security.js';
import { runPerformanceDeepDive } from './checks/performance.js';
import { checkWPCoreHealth } from './checks/wp-core-health.js';
import { runImageAudit } from './checks/image-audit.js';
import { analyseErrorLogs } from './checks/error-logs.js';
import { runCodeReview } from './checks/code-review.js';
import { runFormAudit, buildFormAuditL2Trigger } from './checks/form-audit.js';
import { runSeoHealthCheck, buildSeoL2Trigger } from './checks/seo-health.js';
import { runResponsiveCheck, buildResponsiveL2Trigger } from './checks/responsive-breakpoints.js';
import { checkShippingTax, buildShippingTaxL2Trigger } from './checks/shipping-tax.js';
import { runMultiLanguageCheck, buildMultiLanguageL2Trigger } from './checks/multi-language.js';

/**
 * Run all Layer 1 checks and produce structured results + Layer 2 queue.
 */
export async function runLayer1(
  config: SiteConfig,
  options: RunOptions = {}
): Promise<{ results: Layer1Results; outputDir: string }> {
  const startTime = Date.now();
  const datestamp = new Date().toISOString().slice(0, 10);
  const siteSlug = slugify(config.name);
  const outputDir = path.join(
    options.outputDir || './qa-reports',
    `${siteSlug}-${datestamp}`
  );
  const screenshotDir = path.join(outputDir, 'screenshots');

  await ensureDir(outputDir);
  await ensureDir(screenshotDir);

  logger.section(`Layer 1 — QA Checks for ${config.name}`);
  logger.info(`URL: ${config.url}`);
  logger.info(`Mode: ${config.project_path ? 'with-code' : 'url-only'}`);

  const checks: CheckResult[] = [];
  const screenshots: string[] = [];

  // ── Step 1: Code Analysis (if project path provided) ───────────────────
  let codeAnalysis;
  if (config.project_path) {
    logger.section('Code Analysis');
    codeAnalysis = await analyseProjectCode(config.project_path, config);
    logger.info(`Theme: ${codeAnalysis.theme_name}`);
    logger.info(`Custom features: ${codeAnalysis.custom_features_found.length}`);
    logger.info(`Template overrides: ${codeAnalysis.template_overrides.length}`);
    checks.push({
      check: 'Code Analysis',
      status: codeAnalysis.potential_issues.length > 0 ? 'WARN' : 'PASS',
      detail: `${codeAnalysis.potential_issues.length} issues found`,
    });
  }

  // ── Step 1b: Code Review (if project path provided) ──────────────────
  let codeReview;
  if (config.project_path) {
    logger.section('Code Review');
    codeReview = await runCodeReview(config.project_path, codeAnalysis);
    logger.info(`Files scanned: ${codeReview.files_scanned} (${codeReview.php_files_scanned} PHP, ${codeReview.js_files_scanned} JS)`);
    logger.info(`Findings: ${codeReview.total_findings} (${codeReview.summary.critical} critical, ${codeReview.summary.high} high, ${codeReview.summary.medium} medium, ${codeReview.summary.low} low)`);
    logger.info(`Checklists: ${codeReview.checklists_applied.join(', ')}`);
    checks.push({
      check: 'Code Review',
      status: codeReview.summary.critical > 0 ? 'FAIL' : codeReview.summary.high > 0 ? 'WARN' : 'PASS',
      detail: `${codeReview.total_findings} findings (${codeReview.summary.critical} critical, ${codeReview.summary.high} high)`,
    });
  }

  // ── Step 2: WordPress REST API Health ──────────────────────────────────
  logger.section('WordPress REST API Health');
  const wpHealth = await checkWordPressHealth(config);
  logger.info(`REST API: ${wpHealth.rest_api_accessible ? 'accessible' : 'NOT accessible'}`);
  if (wpHealth.rest_api_accessible) {
    logger.info(`Site: ${wpHealth.site_name}`);
    logger.info(`WooCommerce: ${wpHealth.woocommerce_detected ? `v${wpHealth.wc_version || '?'}` : 'not detected'}`);
    logger.info(`Plugins: ${wpHealth.plugins.length} total, ${wpHealth.plugins_needing_update.length} need updates`);
  }
  checks.push({
    check: 'WordPress REST API',
    status: wpHealth.rest_api_accessible ? 'PASS' : 'WARN',
    detail: wpHealth.rest_api_accessible
      ? `${wpHealth.plugins.length} plugins detected`
      : 'REST API not accessible (check URL or auth)',
  });

  // ── Step 3: Lighthouse ─────────────────────────────────────────────────
  let lighthouse;
  if (!options.skipLighthouse) {
    logger.section('Lighthouse Performance Audit');
    lighthouse = await runLighthouse(config.url);
    logger.info(`Mobile: perf=${lighthouse.mobile.performance} a11y=${lighthouse.mobile.accessibility}`);
    logger.info(`Desktop: perf=${lighthouse.desktop.performance} a11y=${lighthouse.desktop.accessibility}`);
    logger.info(`CWV: LCP=${fmtMs(lighthouse.core_web_vitals.lcp_ms)} CLS=${lighthouse.core_web_vitals.cls}`);
    checks.push({
      check: 'Lighthouse',
      status: lighthouse.mobile.performance >= 50 ? 'PASS' : 'WARN',
      detail: `Mobile perf: ${lighthouse.mobile.performance}/100`,
    });
  }

  // ── Step 4: Security Scan (no browser needed) ─────────────────────────
  logger.section('Security Scan');
  const security = await runSecurityScan(config, wpHealth);
  logger.info(`Risk level: ${security.overall_risk}`);
  logger.info(`Findings: ${security.findings.length} (${security.summary.critical} critical, ${security.summary.high} high, ${security.summary.medium} medium)`);
  checks.push({
    check: 'Security Scan',
    status: security.summary.critical > 0 ? 'FAIL' : security.summary.high > 0 ? 'WARN' : 'PASS',
    detail: `${security.findings.length} findings, risk: ${security.overall_risk}`,
  });

  // ── Step 5: WordPress Core Health ─────────────────────────────────────
  logger.section('WordPress Core Health');
  const wpCoreHealth = await checkWPCoreHealth(config, wpHealth);
  logger.info(`WP version: ${wpCoreHealth.wp_version} (${wpCoreHealth.wp_version_status})`);
  if (wpCoreHealth.php_version) logger.info(`PHP: ${wpCoreHealth.php_version} (${wpCoreHealth.php_version_status})`);
  logger.info(`Debug: ${wpCoreHealth.debug_mode}, Cron: ${wpCoreHealth.wp_cron_status}, Cache: ${wpCoreHealth.object_cache}`);
  checks.push({
    check: 'WordPress Core Health',
    status: wpCoreHealth.findings.some(f => f.severity === 'critical') ? 'FAIL' : wpCoreHealth.findings.some(f => f.severity === 'major') ? 'WARN' : 'PASS',
    detail: `${wpCoreHealth.findings.length} findings (v${wpCoreHealth.wp_version}, PHP ${wpCoreHealth.php_version || '?'})`,
  });

  // ── Step 6: Error Log Analysis ───────────────────────────────────────
  logger.section('Error Log Analysis');
  const errorLogs = await analyseErrorLogs(config);
  logger.info(`Sources checked: ${errorLogs.sources_checked.length}, accessible: ${errorLogs.sources_accessible.length}`);
  if (errorLogs.total_entries > 0) {
    logger.info(`Entries: ${errorLogs.total_entries} total (${errorLogs.severity_counts.fatal} fatal, ${errorLogs.severity_counts.error} error, ${errorLogs.severity_counts.warning} warning)`);
    logger.info(`Unique issues: ${errorLogs.grouped.length}, recent (24h): ${errorLogs.recent_entries.length}`);
  } else {
    logger.info('No error log entries found (logs may be inaccessible or empty)');
  }
  checks.push({
    check: 'Error Logs',
    status: errorLogs.severity_counts.fatal > 0 ? 'FAIL' : errorLogs.severity_counts.error > 0 ? 'WARN' : 'PASS',
    detail: errorLogs.total_entries > 0
      ? `${errorLogs.total_entries} entries (${errorLogs.severity_counts.fatal} fatal, ${errorLogs.severity_counts.error} errors, ${errorLogs.severity_counts.warning} warnings)`
      : `No entries found (${errorLogs.sources_checked.length} sources checked)`,
  });

  // ── Step 6b: Shipping & Tax (WooCommerce REST API, no browser) ──────
  let shippingTax: import('./checks/shipping-tax.js').ShippingTaxResult | undefined;
  if (wpHealth.woocommerce_detected && config.username && config.app_password) {
    logger.section('Shipping & Tax Validation');
    shippingTax = await checkShippingTax(config, wpHealth.woocommerce_detected);
    if (shippingTax.api_accessible) {
      logger.info(`Shipping zones: ${shippingTax.shipping_zones.length}, Issues: ${shippingTax.total_issues}`);
    } else {
      logger.warn('WC shipping/tax API not accessible');
    }
    checks.push(...shippingTax.checkResults);
  }

  // ── Step 7-9: Browser-based checks ────────────────────────────────────
  let pageHealth: import('../types.js').PageHealthResult[] = [];
  let brokenLinks: import('../types.js').BrokenLink[] = [];
  let consoleNetwork: import('../types.js').ConsoleNetworkResult[] = [];
  let accessibility: import('../types.js').AccessibilityResult | undefined;
  let performanceDeepDive: import('../types.js').PerformanceDeepDiveResult | undefined;
  let imageAudit: import('../types.js').ImageAuditResult | undefined;
  let formAudit: import('./checks/form-audit.js').FormAuditResult | undefined;
  let seoHealth: import('./checks/seo-health.js').SeoHealthResult | undefined;
  let responsive: import('./checks/responsive-breakpoints.js').ResponsiveResult | undefined;
  let multiLanguage: import('./checks/multi-language.js').MultiLanguageResult | undefined;

  if (!options.skipBrowser) {
    logger.section('Browser-based Checks');
    const session = await launchBrowser(config.url);

    try {
      // Auto-discover pages from navigation + WC defaults + config overrides
      logger.info('Discovering pages...');
      const discoveredPages = await discoverPages(
        session.page,
        config,
        wpHealth.woocommerce_detected
      );
      // Feed discovered pages back into config so all checks use them
      config.key_pages = discoveredPages;

      // Page Health
      logger.info('Checking page health...');
      pageHealth = await checkPageHealth(session.page, config, screenshotDir);
      const failedPages = pageHealth.filter((p) => !p.ok);
      checks.push({
        check: 'Page Health',
        status: failedPages.length === 0 ? 'PASS' : 'FAIL',
        detail: `${pageHealth.length} pages, ${failedPages.length} failed`,
      });
      screenshots.push(
        ...pageHealth.filter((p) => p.screenshot).map((p) => p.screenshot!)
      );

      // Broken Links
      logger.info('Scanning for broken links...');
      brokenLinks = await findBrokenLinks(session.page, config);
      logger.info(`Found ${brokenLinks.length} broken links`);
      checks.push({
        check: 'Broken Links',
        status: brokenLinks.length === 0 ? 'PASS' : 'WARN',
        detail: `${brokenLinks.length} broken links found`,
      });

      // Console & Network — pass code analysis for custom JS checks
      logger.info('Checking console errors & network...');
      consoleNetwork = await checkConsoleAndNetwork(
        session.page,
        config,
        session.consoleErrors,
        session.networkFailures,
        session.networkRequests,
        wpHealth.woocommerce_detected,
        codeAnalysis
      );
      const totalErrors = session.consoleErrors.length;
      const totalFailures = session.networkFailures.length;
      logger.info(`Console errors: ${totalErrors}, Network failures: ${totalFailures}`);
      checks.push({
        check: 'Console & Network',
        status: totalErrors === 0 && totalFailures === 0 ? 'PASS' : 'WARN',
        detail: `${totalErrors} console errors, ${totalFailures} network failures`,
      });
      // Accessibility Audit
      logger.info('Running accessibility audit...');
      accessibility = await runAccessibilityAudit(session.page, config);
      logger.info(`Accessibility: ${accessibility.total_issues} issues across ${accessibility.pages_tested} pages`);
      checks.push({
        check: 'Accessibility (WCAG 2.1)',
        status: accessibility.total_issues === 0 ? 'PASS' : accessibility.issues.some(i => i.severity === 'critical') ? 'FAIL' : 'WARN',
        detail: `${accessibility.total_issues} issues (${accessibility.summary.missing_alt_text} alt, ${accessibility.summary.missing_labels} labels, ${accessibility.summary.heading_issues} headings)`,
      });

      // Performance Deep-Dive
      logger.info('Running performance deep-dive...');
      performanceDeepDive = await runPerformanceDeepDive(session.page, config, session.networkRequests);
      logger.info(`Performance: ${performanceDeepDive.pages.length} pages analysed, ${performanceDeepDive.third_party_audit.length} third-party domains`);
      checks.push({
        check: 'Performance Deep-Dive',
        status: performanceDeepDive.total_issues === 0 ? 'PASS' : 'WARN',
        detail: `${performanceDeepDive.total_issues} issues, ${performanceDeepDive.third_party_audit.length} third-party domains`,
      });

      // Image Optimization Audit
      logger.info('Running image optimization audit...');
      imageAudit = await runImageAudit(session.page, config, session.networkRequests, wpHealth);
      logger.info(`Images: ${imageAudit.total_images} total, ${imageAudit.oversized_images.length} oversized, ${imageAudit.missing_dimensions.length} missing dimensions`);
      checks.push({
        check: 'Image Optimization',
        status: imageAudit.oversized_images.length === 0 && imageAudit.missing_dimensions.length === 0 ? 'PASS' : 'WARN',
        detail: `${imageAudit.oversized_images.length} oversized, ${imageAudit.missing_dimensions.length} missing dimensions, ${imageAudit.lazy_loading.without_lazy_loading} without lazy loading`,
      });

      // Form Audit
      logger.info('Running form audit...');
      formAudit = await runFormAudit(session.page, config);
      logger.info(`Forms: ${formAudit.summary.totalForms} audited, ${formAudit.summary.totalIssues} issues found`);
      checks.push(...formAudit.checkResults);

      // SEO Health Check
      logger.info('Running SEO health check...');
      seoHealth = await runSeoHealthCheck(session.page, config);
      logger.info(`SEO: ${seoHealth.total_issues} issues across ${seoHealth.pages_tested} pages`);
      checks.push(...seoHealth.checkResults);

      // Responsive Breakpoint Testing
      logger.info('Running responsive breakpoint tests...');
      responsive = await runResponsiveCheck(session.page, config);
      logger.info(`Responsive: ${responsive.total_issues} issues across ${responsive.viewports_tested} viewports`);
      checks.push(...responsive.checkResults);

      // Multi-Language Testing
      logger.info('Running multi-language check...');
      multiLanguage = await runMultiLanguageCheck(session.page, config, wpHealth.plugins);
      if (multiLanguage.is_multilingual) {
        logger.info(`Multi-language: ${multiLanguage.plugin_detected}, ${multiLanguage.languages_found.length} languages, ${multiLanguage.total_issues} issues`);
      } else {
        logger.info('Multi-language: not detected (skipped)');
      }
      checks.push(...multiLanguage.checkResults);
    } finally {
      await session.close();
    }
  } else {
    checks.push({
      check: 'Browser Checks',
      status: 'SKIP',
      detail: 'Skipped (--skip-browser)',
    });
  }

  // ── Build Layer 2 investigation queue ──────────────────────────────────
  const layer2Queue = buildLayer2Queue(
    config,
    wpHealth,
    pageHealth,
    brokenLinks,
    consoleNetwork,
    lighthouse,
    codeAnalysis,
    accessibility,
    security,
    wpCoreHealth,
    errorLogs,
    codeReview,
    formAudit,
    seoHealth,
    responsive,
    shippingTax,
    multiLanguage
  );

  logger.section('Layer 2 Queue');
  logger.info(`${layer2Queue.length} investigations queued for Claude`);
  for (const item of layer2Queue) {
    logger.dim(`[${item.priority}] ${item.id}: ${item.trigger.slice(0, 60)}`);
  }

  // ── Assemble results ──────────────────────────────────────────────────
  const results: Layer1Results = {
    site: config,
    tested_at: new Date().toISOString(),
    duration_ms: elapsed(startTime),
    tester_mode: config.project_path ? 'with-code' : 'url-only',
    page_health: pageHealth,
    lighthouse,
    wordpress_health: wpHealth,
    broken_links: brokenLinks,
    console_network: consoleNetwork,
    code_analysis: codeAnalysis,
    accessibility,
    security,
    performance_deep_dive: performanceDeepDive,
    wp_core_health: wpCoreHealth,
    image_audit: imageAudit,
    error_logs: errorLogs,
    code_review: codeReview,
    form_audit: formAudit,
    seo_health: seoHealth,
    responsive,
    shipping_tax: shippingTax,
    multi_language: multiLanguage,
    layer2_queue: layer2Queue,
    screenshots,
    checks,
  };

  // Write results
  const resultsPath = path.join(outputDir, 'layer1-results.json');
  await writeJson(resultsPath, results);

  // Extract fixable issues (structured for AI consumption)
  const fixableIssues = extractFixableIssues(results);
  const fixablePath = path.join(outputDir, 'fixable-issues.json');
  await writeJson(fixablePath, fixableIssues);

  logger.section('Done');
  logger.success(`Layer 1 complete in ${fmtMs(elapsed(startTime))}`);
  logger.info(`Results: ${resultsPath}`);
  if (fixableIssues.length > 0) {
    const blockers = fixableIssues.filter((i) => i.severity === 'blocker').length;
    const majors = fixableIssues.filter((i) => i.severity === 'major').length;
    const minors = fixableIssues.filter((i) => i.severity === 'minor').length;
    logger.info(`Fixable issues: ${fixableIssues.length} (${blockers} blockers, ${majors} major, ${minors} minor)`);
    logger.info(`  Fix prompt: npx qa-agent fix --report ${outputDir}`);
  }

  return { results, outputDir };
}

// ── Queue Builder ─────────────────────────────────────────────────────────

function buildLayer2Queue(
  config: SiteConfig,
  wpHealth: any,
  pageHealth: any[],
  brokenLinks: any[],
  consoleNetwork: any[],
  lighthouse: any,
  codeAnalysis: CodeAnalysis | undefined,
  accessibility: import('../types.js').AccessibilityResult | undefined,
  security: import('../types.js').SecurityResult | undefined,
  wpCoreHealth: import('../types.js').WPCoreHealthResult | undefined,
  errorLogs: import('../types.js').ErrorLogResult | undefined,
  codeReview: CodeReviewResult | undefined,
  formAudit: import('./checks/form-audit.js').FormAuditResult | undefined,
  seoHealth: import('./checks/seo-health.js').SeoHealthResult | undefined,
  responsive: import('./checks/responsive-breakpoints.js').ResponsiveResult | undefined,
  shippingTax: import('./checks/shipping-tax.js').ShippingTaxResult | undefined,
  multiLanguage: import('./checks/multi-language.js').MultiLanguageResult | undefined
): Layer2Investigation[] {
  const queue: Layer2Investigation[] = [];

  // WooCommerce detected → full adaptive checkout flow
  // Enrich with code analysis if available (custom fields, hooks, payment gateways)
  if (wpHealth.woocommerce_detected) {
    let checkoutInstruction =
      'Navigate the shop, add a product to cart, go to checkout. Verify each step visually. Do NOT submit payment. Check for layout issues, missing fields, confusing UX. Report what a real customer would experience.';

    const checkoutContext: Record<string, any> = {
      wc_version: wpHealth.wc_version,
      checkout_js_state: consoleNetwork.find((cn: any) =>
        cn.page_url?.includes('checkout')
      )?.wc_js_state,
    };

    // Enrich with custom checkout fields from code analysis
    if (codeAnalysis?.checkout_field_details && codeAnalysis.checkout_field_details.length > 0) {
      const fieldsWithDetail = codeAnalysis.checkout_field_details.filter((d) => d.fields.length > 0);
      if (fieldsWithDetail.length > 0) {
        const fieldSummary = fieldsWithDetail
          .flatMap((d) => d.fields)
          .map((f) => `"${f.label}" (${f.type}${f.required ? ', required' : ''})`)
          .join(', ');
        checkoutInstruction += `\n\nCUSTOM CHECKOUT FIELDS (from code analysis): ${fieldSummary}. Verify each of these fields is visible and functional. Test required field validation.`;
        checkoutContext.custom_checkout_fields = fieldsWithDetail;
      }
    }

    // Enrich with checkout-related hooks
    if (codeAnalysis?.hook_callbacks && codeAnalysis.hook_callbacks.length > 0) {
      const checkoutHooks = codeAnalysis.hook_callbacks.filter(
        (h) => h.hook.includes('checkout') && h.modifies.length > 0
      );
      if (checkoutHooks.length > 0) {
        const hookSummary = checkoutHooks
          .map((h) => `${h.callback}: ${h.summary}`)
          .join('; ');
        checkoutInstruction += `\n\nCUSTOM CHECKOUT BEHAVIOR (from code): ${hookSummary}. Look for these modifications during the checkout flow.`;
        checkoutContext.checkout_hooks = checkoutHooks.map((h) => ({
          hook: h.hook, callback: h.callback, summary: h.summary, modifies: h.modifies,
        }));
      }
    }

    // Add WC template overrides affecting checkout
    if (codeAnalysis?.template_overrides) {
      const checkoutTemplates = codeAnalysis.template_overrides.filter(
        (t) => t.startsWith('checkout/') || t.startsWith('cart/')
      );
      if (checkoutTemplates.length > 0) {
        checkoutInstruction += `\n\nCUSTOM TEMPLATES: ${checkoutTemplates.join(', ')} — these override default WooCommerce templates. Look for visual differences or issues.`;
        checkoutContext.checkout_template_overrides = checkoutTemplates;
      }
    }

    // Add critical flows from config for extra context
    if (config.critical_flows && config.critical_flows.length > 0) {
      const checkoutFlows = config.critical_flows.filter(
        (f) => /checkout|purchase|payment|cart|order|coupon/i.test(f)
      );
      if (checkoutFlows.length > 0) {
        checkoutInstruction += `\n\nCRITICAL FLOWS (user-declared): ${checkoutFlows.join('; ')}. These are specifically identified as critical — test each one.`;
        checkoutContext.critical_flows = checkoutFlows;
      }
    }

    queue.push({
      id: 'wc-checkout-flow',
      category: 'flow',
      priority: 'high',
      trigger: 'WooCommerce detected — needs full checkout flow test',
      instruction: checkoutInstruction,
      context: checkoutContext,
      pages: ['/shop/', '/cart/', '/checkout/'],
    });
  }

  // Console errors on checkout/cart → investigate
  const checkoutErrors = consoleNetwork.filter(
    (cn: any) =>
      (cn.page_url?.includes('checkout') || cn.page_url?.includes('cart')) &&
      cn.console_errors.length > 0
  );
  if (checkoutErrors.length > 0) {
    queue.push({
      id: 'console-errors-checkout',
      category: 'error-context',
      priority: 'high',
      trigger: `${checkoutErrors.reduce((n: number, c: any) => n + c.console_errors.length, 0)} console errors on checkout/cart pages`,
      instruction:
        'Visit checkout and cart pages. Check if the errors visible in Layer 1 results actually affect functionality. Can a user still complete a purchase? Are payment forms rendering?',
      context: { errors: checkoutErrors },
      pages: checkoutErrors.map((c: any) => c.page_url),
    });
  }

  // Broken pages (non-200) → document what user sees
  const failedPages = pageHealth.filter((p: any) => !p.ok);
  if (failedPages.length > 0) {
    queue.push({
      id: 'broken-pages',
      category: 'visual',
      priority: 'high',
      trigger: `${failedPages.length} pages returned non-200 status`,
      instruction:
        'Visit each broken page and describe what a user would see. Is it a maintenance page, a redirect, or a genuine error? Take screenshots.',
      context: { pages: failedPages },
      pages: failedPages.map((p: any) => p.url),
    });
  }

  // Lighthouse mobile < 50 → assess actual mobile UX
  if (lighthouse && lighthouse.mobile.performance < 50) {
    queue.push({
      id: 'mobile-performance-ux',
      category: 'ux',
      priority: 'high',
      trigger: `Lighthouse mobile performance score: ${lighthouse.mobile.performance}/100`,
      instruction:
        'Open key pages in mobile viewport (375x812). Assess actual user experience: does the page feel slow? Are images loading? Is text readable? Is navigation usable?',
      context: { scores: lighthouse.mobile, cwv: lighthouse.core_web_vitals },
      pages: ['/'],
    });
  }

  // Outdated WC template overrides → check for visual anomalies
  if (
    wpHealth.wc_template_overrides_outdated &&
    wpHealth.wc_template_overrides_outdated.length > 0
  ) {
    queue.push({
      id: 'outdated-wc-templates',
      category: 'anomaly',
      priority: 'medium',
      trigger: `${wpHealth.wc_template_overrides_outdated.length} outdated WooCommerce template overrides`,
      instruction:
        'Visit shop, product, cart, and checkout pages. Look for visual anomalies that could be caused by outdated template overrides: missing sections, broken layouts, unstyled elements.',
      context: { templates: wpHealth.wc_template_overrides_outdated },
      pages: ['/shop/', '/cart/', '/checkout/'],
    });
  }

  // Always: exploratory visual assessment of key pages
  queue.push({
    id: 'visual-assessment',
    category: 'visual',
    priority: 'medium',
    trigger: 'Standard visual QA assessment',
    instruction:
      'Visit the homepage, shop page, and a product page. Look for: broken images, overlapping text, alignment issues, missing content, placeholder text, $0 prices, lorem ipsum, console warnings visible to user. Compare desktop vs mobile. Report anything that looks unprofessional.',
    context: {},
    pages: config.key_pages?.map((p) => p.path) || ['/'],
  });

  // ── Accessibility-driven investigations ──────────────────────────────────
  if (accessibility && accessibility.issues.some(i => i.severity === 'critical')) {
    queue.push({
      id: 'accessibility-critical',
      category: 'ux',
      priority: 'high',
      trigger: `${accessibility.issues.filter(i => i.severity === 'critical').length} critical accessibility issues found`,
      instruction:
        'Navigate key pages and verify critical accessibility issues: missing form labels on checkout, missing alt text on product images, broken keyboard navigation. Test tab order through the checkout form.',
      context: {
        critical_issues: accessibility.issues.filter(i => i.severity === 'critical').slice(0, 10),
      },
      pages: [...new Set(accessibility.issues.filter(i => i.severity === 'critical').map(i => i.page))].slice(0, 5),
    });
  }

  // ── Security-driven investigations ─────────────────────────────────────
  if (security && (security.overall_risk === 'critical' || security.overall_risk === 'high')) {
    queue.push({
      id: 'security-high-risk',
      category: 'anomaly',
      priority: 'high',
      trigger: `Security risk level: ${security.overall_risk} (${security.summary.critical} critical, ${security.summary.high} high findings)`,
      instruction:
        'Verify the most critical security findings: check if exposed files contain sensitive data, verify if directory listings expose files, test if user enumeration is truly exploitable.',
      context: {
        critical_findings: security.findings.filter(f => f.severity === 'critical' || f.severity === 'high'),
      },
      pages: ['/'],
    });
  }

  // ── WP Core Health investigations ──────────────────────────────────────
  if (wpCoreHealth && wpCoreHealth.findings.some(f => f.severity === 'critical')) {
    queue.push({
      id: 'wp-core-critical',
      category: 'anomaly',
      priority: 'high',
      trigger: `${wpCoreHealth.findings.filter(f => f.severity === 'critical').length} critical WordPress core health issues`,
      instruction:
        'Verify critical WordPress health issues: check if PHP errors are visible to users, confirm if debug mode exposes sensitive info, verify the impact of outdated software versions.',
      context: {
        findings: wpCoreHealth.findings.filter(f => f.severity === 'critical'),
      },
      pages: ['/'],
    });
  }

  // ── Error-log-driven investigations ──────────────────────────────────────
  if (errorLogs && errorLogs.severity_counts.fatal > 0) {
    queue.push({
      id: 'error-logs-fatal',
      category: 'error-context',
      priority: 'high',
      trigger: `${errorLogs.severity_counts.fatal} fatal errors found in error logs`,
      instruction:
        'Visit the pages mentioned in the error logs. Check if these fatal errors are affecting the user experience — do pages return 500, show blank content, or have broken features? Document the visible impact.',
      context: {
        fatal_errors: errorLogs.grouped.filter(g => g.level === 'fatal').slice(0, 5),
      },
      pages: ['/'],
    });
  }

  if (errorLogs && errorLogs.sources_accessible.some(s => s.startsWith('HTTP:'))) {
    queue.push({
      id: 'error-logs-exposed',
      category: 'anomaly',
      priority: 'high',
      trigger: `Error log files are publicly accessible via HTTP: ${errorLogs.sources_accessible.filter(s => s.startsWith('HTTP:')).join(', ')}`,
      instruction:
        'Verify that the error log files are actually accessible via browser. These files contain server paths, database details, and other sensitive information. Take a screenshot as evidence.',
      context: {
        accessible_logs: errorLogs.sources_accessible.filter(s => s.startsWith('HTTP:')),
      },
      pages: ['/'],
    });
  }

  // ── Config critical_flows as additional investigations ──────────────────
  if (config.critical_flows && config.critical_flows.length > 0) {
    // Add user-declared critical flows that don't overlap with auto-detected ones
    const nonCheckoutFlows = config.critical_flows.filter(
      (f) => !/checkout|purchase|payment|cart/i.test(f)
    );
    for (const flow of nonCheckoutFlows) {
      queue.push({
        id: `critical-flow-${flow.toLowerCase().replace(/\s+/g, '-').slice(0, 30)}`,
        category: 'flow',
        priority: 'high',
        trigger: `User-declared critical flow: "${flow}"`,
        instruction: `Test this critical user flow: "${flow}". Navigate through each step, verify it works end-to-end. Report any issues that would block a user from completing this flow. Take screenshots at each step.`,
        context: { user_declared: true },
        pages: ['/'],
      });
    }
  }

  // ── Config custom_features as additional investigations ────────────────
  if (config.custom_features && config.custom_features.length > 0) {
    // Only add features not already covered by code-driven investigations
    const uncoveredFeatures = config.custom_features.filter((feature) => {
      const featureLower = feature.toLowerCase();
      return !queue.some((q) => {
        const instrLower = q.instruction.toLowerCase();
        const triggerLower = q.trigger.toLowerCase();
        const keywords = featureLower.split(/\s+/).filter((w) => w.length > 3);
        return keywords.some((kw) => instrLower.includes(kw) || triggerLower.includes(kw));
      });
    });

    if (uncoveredFeatures.length > 0) {
      queue.push({
        id: 'config-custom-features',
        category: 'code-driven',
        priority: 'medium',
        trigger: `${uncoveredFeatures.length} user-declared custom features to verify`,
        instruction: `Verify these custom features work on the live site:\n${uncoveredFeatures.map((f) => `- ${f}`).join('\n')}\n\nFor each feature: find it, interact with it, verify it works. Report any that are missing or broken.`,
        context: { features: uncoveredFeatures },
        pages: ['/'],
      });
    }
  }

  // ── Code-analysis feature map → individual investigations ───────────────
  // Each feature detected from code becomes its own testable queue item.
  // This is the crucial link between code analysis and Layer 2 testing.
  if (codeAnalysis?.feature_map && codeAnalysis.feature_map.length > 0) {
    // Group features by page to avoid too many queue items
    const featuresByPage = new Map<string, typeof codeAnalysis.feature_map>();
    for (const feature of codeAnalysis.feature_map) {
      const pageKey = feature.pages.sort().join(',') || '/';
      if (!featuresByPage.has(pageKey)) featuresByPage.set(pageKey, []);
      featuresByPage.get(pageKey)!.push(feature);
    }

    for (const [pageKey, features] of featuresByPage) {
      // Determine priority: checkout/cart features are high, others medium
      const hasCheckout = features.some((f) => f.type === 'checkout' || f.type === 'cart');
      const priority = hasCheckout ? 'high' : 'medium';

      // Build a detailed instruction listing each feature to test
      const featureList = features
        .map((f) => `- **${f.name}**: ${f.how_to_test}`)
        .join('\n');

      const pageLabel = features[0]?.pages[0]?.replace(/\//g, '') || 'site';
      queue.push({
        id: `feature-map-${pageLabel}`,
        category: 'code-driven',
        priority: priority as 'high' | 'medium',
        trigger: `${features.length} custom feature(s) detected from code analysis on ${pageKey}`,
        instruction: `Code analysis found these custom features. Test EACH one:\n\n${featureList}\n\nFor each feature: navigate to the relevant page, verify it renders correctly, interact with it, and test on mobile. Report any feature that is missing, broken, or visually wrong.`,
        context: {
          features: features.map((f) => ({
            name: f.name,
            type: f.type,
            description: f.description,
            pages: f.pages,
            code_files: f.code_files,
            depends_on: f.depends_on,
          })),
        },
        pages: features[0]?.pages || ['/'],
      });
    }
  }

  // ── Code-analysis-driven investigations (specific categories) ──────────
  if (codeAnalysis) {
    // Custom checkout fields
    if (codeAnalysis.custom_checkout_fields?.length > 0) {
      queue.push({
        id: 'code-custom-checkout-fields',
        category: 'code-driven',
        priority: 'high',
        trigger: `${codeAnalysis.custom_checkout_fields.length} custom checkout field modifications found in theme code`,
        instruction:
          'Navigate to checkout. Look for custom fields beyond standard WooCommerce billing/shipping (e.g., VAT number, company ID, delivery instructions, custom dropdowns). Verify they render, are labeled, and appear functional. Test on mobile too.',
        context: {
          hooks: codeAnalysis.custom_checkout_fields.map((f) => f.hook),
          files: codeAnalysis.custom_checkout_fields.map((f) => f.file),
        },
        pages: ['/checkout/', '/kassen/'],
      });
    }

    // Custom REST endpoints → look for AJAX-powered features
    if (codeAnalysis.rest_endpoints?.length > 0) {
      queue.push({
        id: 'code-rest-endpoints',
        category: 'code-driven',
        priority: 'medium',
        trigger: `${codeAnalysis.rest_endpoints.length} custom REST API endpoints in theme`,
        instruction:
          'Navigate the site looking for AJAX-powered features (live search, filtering, dynamic content). These rely on custom REST endpoints. Interact with them and check if they respond correctly.',
        context: {
          endpoints: codeAnalysis.rest_endpoints.map(
            (e) => `${e.methods} /wp-json/${e.namespace}${e.route}`
          ),
        },
        pages: ['/'],
      });
    }

    // Custom product tabs
    if (codeAnalysis.custom_product_tabs?.length > 0) {
      queue.push({
        id: 'code-custom-product-tabs',
        category: 'code-driven',
        priority: 'medium',
        trigger: 'Custom product tabs found via woocommerce_product_tabs filter',
        instruction:
          'Visit a product page. Check all tabs below the description. Look for custom tabs beyond Description/Additional Info/Reviews. Verify they have content and render correctly.',
        context: { files: codeAnalysis.custom_product_tabs },
        pages: ['/shop/'],
      });
    }

    // Custom page templates
    if (codeAnalysis.page_templates?.length > 0) {
      queue.push({
        id: 'code-page-templates',
        category: 'code-driven',
        priority: 'low',
        trigger: `${codeAnalysis.page_templates.length} custom page templates in theme`,
        instruction:
          'Look for pages that use custom templates (Contact, About, Landing pages). Verify they load without layout issues.',
        context: {
          templates: codeAnalysis.page_templates.map((t) => t.name),
        },
        pages: ['/'],
      });
    }

    // Gutenberg blocks
    if (codeAnalysis.gutenberg_blocks?.length > 0) {
      queue.push({
        id: 'code-gutenberg-blocks',
        category: 'code-driven',
        priority: 'medium',
        trigger: `${codeAnalysis.gutenberg_blocks.length} custom Gutenberg blocks registered`,
        instruction:
          'Browse content pages (homepage, about, landing pages). Look for custom block content — interactive elements, custom layouts, dynamic sections. Verify they render on desktop and mobile.',
        context: { blocks: codeAnalysis.gutenberg_blocks },
        pages: ['/'],
      });
    }

    // Public AJAX handlers
    const noprivAjax = codeAnalysis.ajax_handlers?.filter((h) => h.is_nopriv) || [];
    if (noprivAjax.length > 0) {
      queue.push({
        id: 'code-ajax-features',
        category: 'code-driven',
        priority: 'medium',
        trigger: `${noprivAjax.length} public AJAX handlers found (wp_ajax_nopriv_*)`,
        instruction:
          'Browse the site looking for dynamic/AJAX features: live search, add-to-cart without reload, newsletter signups, filtering. Interact with them and verify they respond.',
        context: { actions: noprivAjax.map((h) => h.action) },
        pages: ['/'],
      });
    }

    // WC template overrides
    if (codeAnalysis.template_overrides?.length > 0) {
      queue.push({
        id: 'code-wc-template-overrides',
        category: 'code-driven',
        priority: 'medium',
        trigger: `${codeAnalysis.template_overrides.length} WooCommerce template overrides in theme`,
        instruction:
          'Visit shop, product, cart, and checkout pages. Look for visual anomalies that could be caused by custom template overrides: missing sections, broken layouts, unstyled elements, elements that look different from standard WooCommerce.',
        context: { templates: codeAnalysis.template_overrides },
        pages: ['/shop/', '/cart/', '/checkout/'],
      });
    }
  }

  // ── Code review-driven investigations ─────────────────────────────────
  if (codeReview && codeReview.summary.critical > 0) {
    const criticalFindings = codeReview.findings.filter(f => f.severity === 'critical');

    // Group by rule type for focused investigations
    const unescaped = criticalFindings.filter(f => f.rule === 'unescaped-output');
    const missingNonce = criticalFindings.filter(f => f.rule === 'missing-nonce-ajax');
    const wcDirectDB = criticalFindings.filter(f => f.rule === 'wc-direct-postmeta' || f.rule === 'wc-direct-db');
    const sqlInjection = criticalFindings.filter(f => f.rule === 'wpdb-no-prepare');
    const hardcodedCreds = criticalFindings.filter(f => f.rule === 'hardcoded-credential');

    if (unescaped.length > 0) {
      queue.push({
        id: 'review-unescaped-output',
        category: 'code-driven',
        priority: 'high',
        trigger: `Code review found ${unescaped.length} unescaped output statements — XSS risk`,
        instruction: `Code review found ${unescaped.length} echo/print statements without proper escaping in ${[...new Set(unescaped.map(f => f.file))].join(', ')}. Visit pages that render content from these files and look for: raw HTML entities showing as text, broken markup, or the ability to inject HTML via form fields or URL parameters. Test the checkout form, search, and any forms with custom fields.`,
        context: { findings: unescaped.map(f => ({ file: f.file, line: f.line, snippet: f.code_snippet })) },
        pages: ['/checkout/', '/'],
      });
    }

    if (missingNonce.length > 0) {
      queue.push({
        id: 'review-missing-nonces',
        category: 'code-driven',
        priority: 'high',
        trigger: `Code review found ${missingNonce.length} AJAX handler(s) without nonce verification`,
        instruction: `Code review found AJAX handlers missing nonce checks: ${missingNonce.map(f => f.code_snippet.slice(0, 60)).join('; ')}. Browse the site and interact with AJAX-powered features. In DevTools Network tab, verify that AJAX POST requests include a nonce parameter. Try submitting forms and triggering dynamic features.`,
        context: { findings: missingNonce.map(f => ({ file: f.file, line: f.line, snippet: f.code_snippet })) },
        pages: ['/'],
      });
    }

    if (wcDirectDB.length > 0) {
      queue.push({
        id: 'review-wc-direct-db',
        category: 'code-driven',
        priority: 'high',
        trigger: `Code review found ${wcDirectDB.length} direct database access to WooCommerce data — bypasses HPOS and CRUD`,
        instruction: `Code review found direct post_meta or wpdb access to WC data instead of CRUD classes. This can cause: stale prices on product pages, incorrect stock counts, or order data inconsistencies. Check product prices match admin values. Verify stock quantities update correctly. Compare order totals in checkout preview vs what the code calculates.`,
        context: { findings: wcDirectDB.map(f => ({ file: f.file, line: f.line, snippet: f.code_snippet })) },
        pages: ['/shop/', '/cart/', '/checkout/'],
      });
    }

    if (sqlInjection.length > 0) {
      queue.push({
        id: 'review-sql-injection',
        category: 'code-driven',
        priority: 'high',
        trigger: `Code review found ${sqlInjection.length} wpdb queries without prepare() — SQL injection risk`,
        instruction: `Code review found database queries using variables without $wpdb->prepare(). If any of these take user input (GET/POST parameters, search queries), they may be exploitable. Test search functionality, filtering, and any URL parameters that might hit these queries. Look for database errors or unexpected results with special characters.`,
        context: { findings: sqlInjection.map(f => ({ file: f.file, line: f.line, snippet: f.code_snippet })) },
        pages: ['/'],
      });
    }

    if (hardcodedCreds.length > 0) {
      queue.push({
        id: 'review-hardcoded-creds',
        category: 'code-driven',
        priority: 'high',
        trigger: `Code review found ${hardcodedCreds.length} possible hardcoded credential(s) in source code`,
        instruction: `Code review found possible API keys or credentials hardcoded in: ${[...new Set(hardcodedCreds.map(f => f.file))].join(', ')}. Check the page source and JavaScript console for exposed API keys. In DevTools Network tab, check if any requests send credentials in plain text. Look for Stripe test keys (sk_test) on production or live keys in client-side JavaScript.`,
        context: { files: [...new Set(hardcodedCreds.map(f => f.file))] },
        pages: ['/checkout/', '/'],
      });
    }
  }

  // ── Browser review check-driven investigations ────────────────────────
  const formsWithoutNonce = consoleNetwork.flatMap(
    (cn: any) => (cn.review_checks?.forms_without_nonce || []).map(
      (f: any) => ({ ...f, page: cn.page_url })
    )
  );
  if (formsWithoutNonce.length > 0) {
    queue.push({
      id: 'review-forms-no-nonce',
      category: 'code-driven',
      priority: 'high',
      trigger: `${formsWithoutNonce.length} POST form(s) found without nonce hidden fields`,
      instruction: `Browser scan found forms that submit via POST but lack WordPress nonce verification fields. These forms are vulnerable to CSRF attacks. Test each form: submit it, then check if the submission is processed without a valid nonce. Forms: ${formsWithoutNonce.map((f: any) => `${f.id} on ${f.page}`).join(', ')}`,
      context: { forms: formsWithoutNonce },
      pages: [...new Set(formsWithoutNonce.map((f: any) => f.page))],
    });
  }

  const stagingUrls = consoleNetwork.flatMap(
    (cn: any) => (cn.review_checks?.staging_urls_found || [])
  );
  if (stagingUrls.length > 0) {
    queue.push({
      id: 'review-staging-urls',
      category: 'anomaly',
      priority: 'high',
      trigger: `Staging/development URLs found in production page source`,
      instruction: `Found staging or localhost URLs in the production page source: ${[...new Set(stagingUrls)].join(', ')}. These may cause mixed content warnings, broken resources, or data leakage. Check if any links, images, or scripts reference staging/dev domains.`,
      context: { urls: [...new Set(stagingUrls)] },
      pages: ['/'],
    });
  }

  const sensitiveStorage = consoleNetwork.flatMap(
    (cn: any) => (cn.review_checks?.sensitive_localstorage_keys || [])
  );
  if (sensitiveStorage.length > 0) {
    queue.push({
      id: 'review-sensitive-storage',
      category: 'anomaly',
      priority: 'medium',
      trigger: `Sensitive data keys found in localStorage: ${[...new Set(sensitiveStorage)].join(', ')}`,
      instruction: `Browser localStorage contains keys that may store sensitive data: ${[...new Set(sensitiveStorage)].join(', ')}. Open DevTools Application tab and inspect the values. Verify no tokens, passwords, or payment data are stored client-side.`,
      context: { keys: [...new Set(sensitiveStorage)] },
      pages: ['/'],
    });
  }

  // Form audit → form-quality investigation
  if (formAudit) {
    const formL2 = buildFormAuditL2Trigger(formAudit);
    if (formL2) {
      queue.push({
        id: formL2.id,
        category: 'ux',
        priority: formL2.priority,
        trigger: formL2.description,
        instruction:
          'Visually assess every form on the site. Check placeholder quality, CTA routing, mobile UX, trust signals, and conversion context. Follow the Form Quality Assessment protocol in Layer 2 instructions. Produce a Forms CRO Score out of 10.',
        context: formL2.data,
        pages: formL2.data.affectedPages || ['/'],
      });
    }
  }

  // SEO issues → seo-issues investigation
  if (seoHealth) {
    const seoL2 = buildSeoL2Trigger(seoHealth);
    if (seoL2) {
      queue.push({
        id: seoL2.id,
        category: 'ux',
        priority: seoL2.priority,
        trigger: seoL2.description,
        instruction:
          'Check SEO elements visually: verify page titles make sense, meta descriptions are compelling, Open Graph previews look correct (use browser dev tools), structured data is valid. Check heading hierarchy on key pages.',
        context: seoL2.data,
        pages: ['/'],
      });
    }
  }

  // Responsive issues → responsive-issues investigation
  if (responsive) {
    const respL2 = buildResponsiveL2Trigger(responsive);
    if (respL2) {
      queue.push({
        id: respL2.id,
        category: 'visual',
        priority: respL2.priority,
        trigger: respL2.description,
        instruction:
          'Test the flagged pages at tablet and mobile viewports. Verify overflow issues are real (not just scrollbar). Check touch targets are usable. Take screenshots at each breakpoint.',
        context: respL2.data,
        pages: respL2.data.affectedPages || ['/'],
      });
    }
  }

  // Shipping/tax issues → shipping-tax-issues investigation
  if (shippingTax) {
    const stL2 = buildShippingTaxL2Trigger(shippingTax);
    if (stL2) {
      queue.push({
        id: stL2.id,
        category: 'flow',
        priority: stL2.priority,
        trigger: stL2.description,
        instruction:
          'Navigate to checkout and verify shipping methods appear correctly. Test address changes to see if shipping options update. Check if tax is calculated and displayed correctly.',
        context: stL2.data,
        pages: ['/checkout/'],
      });
    }
  }

  // Multi-language issues → multi-language-issues investigation
  if (multiLanguage) {
    const mlL2 = buildMultiLanguageL2Trigger(multiLanguage);
    if (mlL2) {
      queue.push({
        id: mlL2.id,
        category: 'ux',
        priority: mlL2.priority,
        trigger: mlL2.description,
        instruction:
          'Test the language switcher. Switch to each available language and verify: navigation updates, content translates, forms have correct placeholders in the target language, checkout works in alternate language.',
        context: mlL2.data,
        pages: ['/'],
      });
    }
  }

  return queue;
}
