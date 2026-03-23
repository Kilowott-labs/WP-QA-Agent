import { HealthSnapshot, Regression, ConsoleError, NetworkFailure } from '../types.js';

/**
 * Compare a baseline health snapshot with a post-update snapshot.
 * Returns an array of regressions found, classified by severity.
 */
export function compareSnapshots(
  baseline: HealthSnapshot,
  postUpdate: HealthSnapshot
): Regression[] {
  const regressions: Regression[] = [];

  // ── 1. Page 500s: any page that was OK and now returns 500+ ──────────
  for (const afterPage of postUpdate.page_health) {
    const beforePage = baseline.page_health.find((p) => p.url === afterPage.url);
    if (!beforePage) continue;

    if (
      beforePage.ok &&
      !afterPage.ok &&
      typeof afterPage.status === 'number' &&
      afterPage.status >= 500
    ) {
      regressions.push({
        type: 'blocker',
        category: 'page-500',
        detail: `${afterPage.page} (${afterPage.url}) was HTTP ${beforePage.status}, now HTTP ${afterPage.status}`,
        before: beforePage.status,
        after: afterPage.status,
      });
    }
  }

  // ── 2. New console errors on checkout/cart ────────────────────────────
  const checkoutErrors = getNewErrors(
    baseline.console_errors,
    postUpdate.console_errors
  ).filter((e) => isWcCriticalUrl(e.url));

  if (checkoutErrors.length > 0) {
    regressions.push({
      type: 'blocker',
      category: 'console-error-checkout',
      detail: `${checkoutErrors.length} new console error(s) on checkout/cart: ${checkoutErrors.map((e) => e.message.slice(0, 80)).join('; ')}`,
      before: baseline.console_errors.filter((e) => isWcCriticalUrl(e.url)).length,
      after: baseline.console_errors.filter((e) => isWcCriticalUrl(e.url)).length + checkoutErrors.length,
    });
  }

  // ── 3. WooCommerce JS state regression ────────────────────────────────
  if (baseline.wc_js_state && postUpdate.wc_js_state) {
    const before = baseline.wc_js_state;
    const after = postUpdate.wc_js_state;

    const stateChecks: { field: string; was: boolean | undefined; now: boolean | undefined }[] = [
      { field: 'wc_checkout_params', was: before.wc_checkout_params_loaded, now: after.wc_checkout_params_loaded },
      { field: 'wc_cart_params', was: before.wc_cart_params_loaded, now: after.wc_cart_params_loaded },
      { field: 'Stripe', was: before.stripe_loaded, now: after.stripe_loaded },
      { field: 'PayPal', was: before.paypal_loaded, now: after.paypal_loaded },
    ];

    for (const check of stateChecks) {
      if (check.was === true && check.now === false) {
        regressions.push({
          type: 'blocker',
          category: 'wc-js-regression',
          detail: `${check.field} was loaded before update, now missing`,
          before: true,
          after: false,
        });
      }
    }

    // New WC errors visible
    if (after.wc_errors_visible > before.wc_errors_visible) {
      regressions.push({
        type: 'blocker',
        category: 'wc-js-regression',
        detail: `WooCommerce errors increased from ${before.wc_errors_visible} to ${after.wc_errors_visible}`,
        before: before.wc_errors_visible,
        after: after.wc_errors_visible,
      });
    }
  }

  // ── 4. New console errors on other pages (>3 new unique) ─────────────
  const allNewErrors = getNewErrors(
    baseline.console_errors,
    postUpdate.console_errors
  );
  const nonCheckoutNewErrors = allNewErrors.filter((e) => !isWcCriticalUrl(e.url));

  if (nonCheckoutNewErrors.length > 3) {
    regressions.push({
      type: 'major',
      category: 'console-error-other',
      detail: `${nonCheckoutNewErrors.length} new console error(s) on non-checkout pages`,
      before: baseline.console_errors.length,
      after: postUpdate.console_errors.length,
    });
  }

  // ── 5. Load time regression (>2x baseline) ───────────────────────────
  for (const afterPage of postUpdate.page_health) {
    const beforePage = baseline.page_health.find((p) => p.url === afterPage.url);
    if (!beforePage || beforePage.load_time_ms === 0) continue;

    if (afterPage.load_time_ms > beforePage.load_time_ms * 2) {
      regressions.push({
        type: 'major',
        category: 'load-time',
        detail: `${afterPage.page} load time doubled: ${beforePage.load_time_ms}ms → ${afterPage.load_time_ms}ms`,
        before: beforePage.load_time_ms,
        after: afterPage.load_time_ms,
      });
    }
  }

  // ── 6. New network failures ──────────────────────────────────────────
  const newFailures = getNewFailures(
    baseline.network_failures,
    postUpdate.network_failures
  );

  if (newFailures.length > 0) {
    regressions.push({
      type: 'warning',
      category: 'network-failure',
      detail: `${newFailures.length} new network failure(s): ${newFailures.map((f) => `${f.method} ${f.url.slice(0, 60)} → ${f.status || f.reason}`).slice(0, 3).join('; ')}`,
      before: baseline.network_failures.length,
      after: postUpdate.network_failures.length,
    });
  }

  return regressions;
}

/**
 * Find console errors that are new (present in after but not in before).
 * Matches by message text to avoid duplicates from different timestamps.
 */
function getNewErrors(
  before: ConsoleError[],
  after: ConsoleError[]
): ConsoleError[] {
  const beforeMessages = new Set(before.map((e) => e.message));
  return after.filter((e) => !beforeMessages.has(e.message));
}

/**
 * Check if a URL belongs to a WC critical page (checkout, cart).
 * Handles custom slugs, multilingual variants, and dashes.
 */
function isWcCriticalUrl(url: string): boolean {
  const normalized = url.toLowerCase().replace(/-/g, '');
  return /checkout|check out|cart|kassen|kassa|warenkorb|varukorg|panier|handlekurv|carrello|betaling/.test(normalized);
}

/**
 * Find network failures that are new (present in after but not in before).
 * Matches by URL to avoid duplicates.
 */
function getNewFailures(
  before: NetworkFailure[],
  after: NetworkFailure[]
): NetworkFailure[] {
  const beforeUrls = new Set(before.map((f) => f.url));
  return after.filter((f) => !beforeUrls.has(f.url));
}
