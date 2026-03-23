import { Page } from 'playwright';
import {
  SiteConfig,
  CodeAnalysis,
  ConsoleNetworkResult,
  ConsoleError,
  NetworkFailure,
  NetworkRequest,
  WooCommerceJSState,
  ReviewBrowserChecks,
} from '../../types.js';
import { resolveUrl, logger } from '../../utils.js';

/**
 * Navigate to critical pages and capture console errors,
 * network failures, and WooCommerce JS state via page.evaluate().
 *
 * When codeAnalysis is provided, generates dynamic custom_checks
 * based on detected JS features (payment gateways, custom scripts, etc.)
 */
export async function checkConsoleAndNetwork(
  page: Page,
  config: SiteConfig,
  collectedErrors: ConsoleError[],
  collectedFailures: NetworkFailure[],
  collectedRequests: NetworkRequest[],
  wcDetected: boolean,
  codeAnalysis?: CodeAnalysis
): Promise<ConsoleNetworkResult[]> {
  const results: ConsoleNetworkResult[] = [];
  const timeout = config.timeout_ms || 30000;

  // Critical pages to specifically instrument
  const criticalPaths = ['/checkout/', '/cart/', '/'];
  const pages =
    config.key_pages?.map((p) => ({ name: p.name, path: p.path })) || [];

  // Add critical WC pages if not already in key_pages
  if (wcDetected) {
    for (const cp of criticalPaths) {
      if (!pages.some((p) => p.path === cp)) {
        pages.push({ name: cp.replace(/\//g, '') || 'Homepage', path: cp });
      }
    }
  }

  for (const pg of pages) {
    const url = resolveUrl(config.url, pg.path);

    // Snapshot console/network arrays before this navigation
    const errorsBefore = collectedErrors.length;
    const failuresBefore = collectedFailures.length;
    const requestsBefore = collectedRequests.length;

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout });
    } catch {
      // Timeout on networkidle is common — page still loaded
    }

    // Errors/requests from this page
    const pageErrors = collectedErrors.slice(errorsBefore);
    const pageFailures = collectedFailures.slice(failuresBefore);
    const pageRequests = collectedRequests.slice(requestsBefore);

    // WooCommerce JS state checks — enriched with code-analysis-driven custom checks
    // Match broadly: path or page name containing checkout/cart variants (multilingual, custom slugs)
    let wcState: WooCommerceJSState | undefined;
    const pathAndName = `${pg.path} ${pg.name}`.toLowerCase().replace(/-/g, '');
    const isWcCriticalPage = /checkout|cart|kassen|kassa|warenkorb|varukorg|panier|handlekurv|carrello/.test(pathAndName);
    if (wcDetected && isWcCriticalPage) {
      wcState = await checkWCJSState(page, codeAnalysis);
    }

    // Review-standard browser checks (nonces, localStorage, staging URLs, AJAX nonces)
    const reviewChecks = await runReviewBrowserChecks(page, config.url, pageRequests);

    results.push({
      page_url: url,
      console_errors: pageErrors,
      network_failures: pageFailures,
      network_requests: pageRequests,
      wc_js_state: wcState,
      review_checks: reviewChecks,
    });
  }

  return results;
}

/**
 * Run WooCommerce JavaScript checks in the browser context.
 *
 * When codeAnalysis is provided, generates custom checks based on:
 * - Detected payment gateways from JS file analysis
 * - Custom checkout fields (checks if their DOM elements exist)
 * - Enqueued script handles (checks if globals are loaded)
 */
async function checkWCJSState(
  page: Page,
  codeAnalysis?: CodeAnalysis
): Promise<WooCommerceJSState> {
  // Build dynamic custom check expressions from code analysis
  const customCheckExpressions: Record<string, string> = {};
  if (codeAnalysis) {
    // Check custom checkout field elements exist in DOM
    for (const cf of codeAnalysis.checkout_field_details || []) {
      for (const field of cf.fields) {
        customCheckExpressions[`field_${field.name}_exists`] =
          `!!document.querySelector('#${field.name}, [name="${field.name}"], [id*="${field.name}"]')`;
      }
    }

    // Check for payment gateway globals from JS analysis
    const jsFeatures = new Set(
      (codeAnalysis.js_source_files || []).flatMap((f) => f.features)
    );
    if (jsFeatures.has('payment-gateway')) {
      customCheckExpressions['klarna_loaded'] = `typeof window.Klarna !== 'undefined'`;
      customCheckExpressions['braintree_loaded'] = `typeof window.braintree !== 'undefined'`;
      customCheckExpressions['square_loaded'] = `typeof window.SqPaymentForm !== 'undefined'`;
    }
    if (jsFeatures.has('wc-integration')) {
      customCheckExpressions['woocommerce_params_loaded'] =
        `typeof window.woocommerce_params !== 'undefined'`;
    }

    // Check enqueued scripts with conditional loading on checkout
    for (const script of codeAnalysis.enqueued_scripts || []) {
      if (script.is_conditional && /checkout|cart|payment/i.test(script.handle)) {
        customCheckExpressions[`script_${script.handle}_loaded`] =
          `!!document.querySelector('script[id*="${script.handle}"]')`;
      }
    }
  }

  try {
    return await page.evaluate((customChecks) => {
      const w = window as any;

      // Run dynamic custom checks
      const customResults: Record<string, boolean> = {};
      for (const [key, expr] of Object.entries(customChecks)) {
        try {
          customResults[key] = !!eval(expr);
        } catch {
          customResults[key] = false;
        }
      }

      return {
        wc_checkout_params_loaded: typeof w.wc_checkout_params !== 'undefined',
        wc_cart_params_loaded: typeof w.wc_cart_params !== 'undefined',
        stripe_loaded: typeof w.Stripe !== 'undefined',
        paypal_loaded: typeof w.paypal !== 'undefined',
        checkout_url:
          typeof w.wc_checkout_params !== 'undefined'
            ? w.wc_checkout_params.checkout_url
            : undefined,
        ajax_url:
          typeof w.wc_checkout_params !== 'undefined'
            ? w.wc_checkout_params.ajax_url
            : typeof w.woocommerce_params !== 'undefined'
              ? w.woocommerce_params.ajax_url
              : undefined,
        cart_hash: typeof w.wc_cart_fragments_params !== 'undefined'
          ? w.wc_cart_fragments_params.cart_hash_key
          : undefined,
        wc_errors_visible: document.querySelectorAll('.woocommerce-error li').length,
        custom_checks: customResults,
      };
    }, customCheckExpressions);
  } catch (err: any) {
    logger.warn(`WC JS state check failed: ${err.message}`);
    return {
      wc_checkout_params_loaded: false,
      wc_cart_params_loaded: false,
      wc_errors_visible: 0,
      custom_checks: {},
    };
  }
}

/**
 * Review-standard browser checks from php-security.md, javascript.md, architecture.md.
 * These detect issues that are visible in the browser DOM/JS during live testing.
 */
async function runReviewBrowserChecks(
  page: Page,
  siteUrl: string,
  pageRequests: NetworkRequest[]
): Promise<ReviewBrowserChecks> {
  const result: ReviewBrowserChecks = {
    forms_without_nonce: [],
    sensitive_localstorage_keys: [],
    staging_urls_found: [],
    ajax_requests_without_nonce: [],
  };

  try {
    const domChecks = await page.evaluate((siteOrigin: string) => {
      // 1. Check all forms for nonce hidden fields (php-security.md)
      const formsWithoutNonce: Array<{ action: string; id: string; method: string }> = [];
      const forms = document.querySelectorAll('form');
      for (const form of forms) {
        // Skip search forms and comment forms (typically no nonce needed for GET)
        const method = (form.getAttribute('method') || 'get').toLowerCase();
        if (method === 'get') continue;

        // Check for nonce field
        const hasNonce = !!form.querySelector(
          'input[name*="nonce"], input[name*="_wpnonce"], input[name*="wp_nonce"]'
        );
        if (!hasNonce) {
          formsWithoutNonce.push({
            action: form.getAttribute('action') || '',
            id: form.getAttribute('id') || form.getAttribute('class') || '(unnamed)',
            method,
          });
        }
      }

      // 2. Check localStorage for sensitive data (javascript.md)
      const sensitiveKeys: string[] = [];
      const sensitivePatterns = /token|password|secret|api_key|apikey|auth|credit|card|payment|billing|session/i;
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && sensitivePatterns.test(key)) {
            sensitiveKeys.push(key);
          }
        }
      } catch { /* localStorage may be blocked */ }

      // 3. Check page source for staging URLs (architecture.md)
      const stagingUrls: string[] = [];
      const html = document.documentElement.outerHTML;
      const stagingPatterns = [
        /https?:\/\/staging\.[^\s"'<>]+/g,
        /https?:\/\/dev\.[^\s"'<>]+/g,
        /https?:\/\/localhost[:\d]*[^\s"'<>]*/g,
        /https?:\/\/127\.0\.0\.1[:\d]*[^\s"'<>]*/g,
      ];
      // Only flag if the current site is NOT a staging/dev site itself
      const isProduction = !siteOrigin.match(/staging\.|dev\.|localhost|127\.0\.0\.1/);
      if (isProduction) {
        for (const pattern of stagingPatterns) {
          const matches = html.match(pattern);
          if (matches) {
            // Deduplicate and limit
            for (const m of [...new Set(matches)].slice(0, 5)) {
              stagingUrls.push(m);
            }
          }
        }
      }

      return { formsWithoutNonce, sensitiveKeys, stagingUrls };
    }, siteUrl);

    result.forms_without_nonce = domChecks.formsWithoutNonce;
    result.sensitive_localstorage_keys = domChecks.sensitiveKeys;
    result.staging_urls_found = domChecks.stagingUrls;

    // 4. Check AJAX requests for missing nonce (php-security.md)
    // Look at POST requests to admin-ajax.php that don't have nonce in the URL
    for (const req of pageRequests) {
      if (
        req.url.includes('admin-ajax.php') &&
        req.method === 'POST' &&
        !req.url.includes('nonce') &&
        !req.url.includes('_wpnonce')
      ) {
        // Can't inspect POST body from here, but flag the request URL
        result.ajax_requests_without_nonce.push(req.url);
      }
    }
  } catch (err: any) {
    logger.warn(`Review browser checks failed: ${err.message}`);
  }

  return result;
}
