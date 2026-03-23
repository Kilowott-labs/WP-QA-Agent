import { Page } from 'playwright';
import {
  SiteConfig,
  HealthSnapshot,
  PageHealthResult,
  ConsoleError,
  NetworkFailure,
  WooCommerceJSState,
} from '../types.js';
import { resolveUrl, baseUrl, getAuthHeader, logger } from '../utils.js';

/**
 * Fetch actual WooCommerce page URLs from the WC REST API.
 * WC stores checkout/cart/shop/myaccount page IDs in options,
 * and the system_status endpoint exposes page slugs.
 *
 * Falls back to standard defaults if API is unavailable.
 */
async function getWCPagePaths(
  config: SiteConfig,
  targetUrl: string
): Promise<{ name: string; path: string; isWcCritical: boolean }[]> {
  const defaults = [
    { name: 'Shop', path: '/shop/', isWcCritical: true },
    { name: 'Cart', path: '/cart/', isWcCritical: true },
    { name: 'Checkout', path: '/checkout/', isWcCritical: true },
    { name: 'My Account', path: '/my-account/', isWcCritical: true },
  ];

  if (!config.username || !config.app_password) return defaults;

  const base = baseUrl(targetUrl);
  try {
    const res = await fetch(`${base}/wp-json/wc/v3/system_status`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: getAuthHeader(config.username, config.app_password),
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return defaults;

    const status = await res.json();
    const wcPages = status.pages || [];
    const result: { name: string; path: string; isWcCritical: boolean }[] = [];

    // WC system_status.pages contains: shop, cart, checkout, myaccount, terms
    // Each has: page_name, page_id, page_set, page_exists, page_visible, shortcode, shortcode_required, shortcode_present
    for (const pg of wcPages) {
      const name = pg.page_name || '';
      const slug = pg.page_slug || '';
      if (!slug) continue;

      const path = slug.startsWith('/') ? slug : `/${slug}/`;
      const isCheckoutOrCart =
        name.toLowerCase().includes('checkout') ||
        name.toLowerCase().includes('cart') ||
        (pg.shortcode && (pg.shortcode.includes('checkout') || pg.shortcode.includes('cart')));

      result.push({
        name: name || slug,
        path: path.endsWith('/') ? path : `${path}/`,
        isWcCritical: true,
      });
    }

    if (result.length > 0) {
      logger.info(`  WC pages from API: ${result.map((p) => `${p.name} (${p.path})`).join(', ')}`);
      return result;
    }
  } catch {
    // API not available
  }

  // Fallback: try to detect from the site HTML
  try {
    const base2 = baseUrl(targetUrl);
    const htmlRes = await fetch(base2, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'wp-qa-agent/1.0' },
    });
    if (htmlRes.ok) {
      const html = await htmlRes.text();
      // Look for WC page links in navigation
      const cartMatch = html.match(/href=["']([^"']*(?:cart|varukorg|warenkorb|panier|handlekurv|carrello)[^"']*)["']/i);
      const checkoutMatch = html.match(/href=["']([^"']*(?:checkout|check-out|kassen|kassa|cassa|bestilling|paiement)[^"']*)["']/i);
      const shopMatch = html.match(/href=["']([^"']*(?:shop|butikk|boutique|negozio|tienda)[^"']*)["']/i);
      const accountMatch = html.match(/href=["']([^"']*(?:my-account|min-konto|mon-compte|mein-konto|mi-cuenta)[^"']*)["']/i);

      const detected: { name: string; path: string; isWcCritical: boolean }[] = [];
      if (shopMatch) detected.push({ name: 'Shop', path: new URL(shopMatch[1], targetUrl).pathname, isWcCritical: true });
      if (cartMatch) detected.push({ name: 'Cart', path: new URL(cartMatch[1], targetUrl).pathname, isWcCritical: true });
      if (checkoutMatch) detected.push({ name: 'Checkout', path: new URL(checkoutMatch[1], targetUrl).pathname, isWcCritical: true });
      if (accountMatch) detected.push({ name: 'My Account', path: new URL(accountMatch[1], targetUrl).pathname, isWcCritical: true });

      if (detected.length > 0) {
        logger.info(`  WC pages from HTML: ${detected.map((p) => `${p.name} (${p.path})`).join(', ')}`);
        // Merge with defaults for any missing
        for (const d of defaults) {
          if (!detected.some((p) => p.name === d.name)) {
            detected.push(d);
          }
        }
        return detected;
      }
    }
  } catch { /* non-critical */ }

  return defaults;
}

/**
 * Capture a health snapshot of the site's current state.
 * This is a lightweight version of page-health + console-network checks,
 * optimised for speed (no screenshots, minimal waits).
 *
 * Uses array index slicing to isolate errors from this snapshot only.
 */
export async function captureHealthSnapshot(
  page: Page,
  config: SiteConfig,
  accumulatedErrors: ConsoleError[],
  accumulatedFailures: NetworkFailure[],
  targetUrl: string,
  wcDetected: boolean
): Promise<HealthSnapshot> {
  // Always test critical pages — don't rely on config having them
  const pages: { name: string; path: string; isWcCritical?: boolean }[] = [
    { name: 'Homepage', path: '/' },
    ...(config.key_pages || []).map((p) => ({ ...p, isWcCritical: false })),
  ];

  // Auto-add WooCommerce pages — detected from API, not hardcoded
  if (wcDetected) {
    const wcPages = await getWCPagePaths(config, targetUrl);
    for (const wc of wcPages) {
      if (!pages.some((p) => p.path === wc.path)) {
        pages.push(wc);
      }
    }
  }

  // Deduplicate by path
  const seen = new Set<string>();
  const dedupedPages = pages.filter((p) => {
    if (seen.has(p.path)) return false;
    seen.add(p.path);
    return true;
  });

  // Track which paths are WC critical (for JS state checks)
  const wcCriticalPaths = new Set(
    dedupedPages.filter((p) => (p as any).isWcCritical).map((p) => p.path)
  );

  const timeout = config.timeout_ms || 30000;
  const pageHealth: PageHealthResult[] = [];
  const errorsBefore = accumulatedErrors.length;
  const failuresBefore = accumulatedFailures.length;
  let wcState: WooCommerceJSState | undefined;

  for (const pg of dedupedPages) {
    const url = resolveUrl(targetUrl, pg.path);
    const result: PageHealthResult = {
      page: pg.name,
      url,
      status: 'ERROR',
      load_time_ms: 0,
      ok: false,
    };

    try {
      const start = Date.now();
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout,
      });
      result.load_time_ms = Date.now() - start;
      result.status = response?.status() ?? 'ERROR';
      result.ok =
        typeof result.status === 'number' &&
        result.status >= 200 &&
        result.status < 400;
    } catch (err: any) {
      result.error = err.message;
    }

    pageHealth.push(result);

    // WC JS state on any WC critical page (checkout, cart — whatever the actual URL is)
    if (wcDetected && wcCriticalPaths.has(pg.path) && result.ok) {
      wcState = await checkWCJSState(page);
    }
  }

  // Collect errors from this snapshot only
  const snapshotErrors = accumulatedErrors.slice(errorsBefore);
  const snapshotFailures = accumulatedFailures.slice(failuresBefore);

  return {
    timestamp: new Date().toISOString(),
    page_health: pageHealth,
    console_errors: snapshotErrors,
    network_failures: snapshotFailures,
    wc_js_state: wcState,
  };
}

async function checkWCJSState(page: Page): Promise<WooCommerceJSState> {
  try {
    return await page.evaluate(() => {
      const w = window as any;
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
        cart_hash: undefined,
        wc_errors_visible: document.querySelectorAll('.woocommerce-error li').length,
        custom_checks: {},
      };
    });
  } catch {
    return {
      wc_checkout_params_loaded: false,
      wc_cart_params_loaded: false,
      wc_errors_visible: 0,
      custom_checks: {},
    };
  }
}
