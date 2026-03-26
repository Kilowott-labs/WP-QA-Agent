import { SiteConfig, CheckResult } from '../../types.js';
import { getAuthHeader, logger } from '../../utils.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ShippingZone {
  id: number;
  name: string;
  methods: ShippingMethod[];
}

export interface ShippingMethod {
  id: number;
  title: string;
  method_id: string;  // e.g. 'flat_rate', 'free_shipping', 'local_pickup'
  enabled: boolean;
  cost?: string;
  min_amount?: string;  // for free shipping threshold
}

export interface TaxInfo {
  enabled: boolean;
  calc_based_on: string;
  prices_include_tax: boolean;
  tax_classes: string[];
  tax_rates_count: number;
  display_in_shop: string;
  display_in_cart: string;
}

export interface ShippingTaxIssue {
  type: 'shipping' | 'tax';
  severity: 'major' | 'minor';
  detail: string;
  recommendation: string;
}

export interface ShippingTaxResult {
  shipping_zones: ShippingZone[];
  tax_info: TaxInfo | null;
  issues: ShippingTaxIssue[];
  total_issues: number;
  api_accessible: boolean;
  checkResults: CheckResult[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function emptyResult(): ShippingTaxResult {
  return {
    shipping_zones: [],
    tax_info: null,
    issues: [],
    total_issues: 0,
    api_accessible: false,
    checkResults: [],
  };
}

/**
 * Extract a setting value from the WC settings array format.
 * WC settings endpoints return arrays of { id, value, ... } objects.
 */
function settingValue(settings: any[], id: string): any {
  const entry = settings.find((s: any) => s.id === id);
  return entry?.value;
}

// ── Main check ────────────────────────────────────────────────────────────────

/**
 * Check WooCommerce shipping zone configuration and tax settings via REST API.
 * Returns structured results with issues flagged and CheckResult entries.
 */
export async function checkShippingTax(
  config: SiteConfig,
  wcDetected: boolean
): Promise<ShippingTaxResult> {
  const result = emptyResult();

  // Early exit if WooCommerce is not detected
  if (!wcDetected) {
    result.checkResults.push({
      check: 'Shipping & Tax -- Overall',
      status: 'SKIP',
      detail: 'WooCommerce not detected — shipping and tax checks skipped.',
    });
    return result;
  }

  // Early exit if credentials are missing (WC REST API requires auth)
  if (!config.username || !config.app_password) {
    result.checkResults.push({
      check: 'Shipping & Tax -- Overall',
      status: 'SKIP',
      detail: 'No credentials provided — cannot access WC REST API for shipping/tax checks.',
    });
    return result;
  }

  const base = config.url.replace(/\/+$/, '');
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    'Authorization': getAuthHeader(config.username, config.app_password),
  };
  const timeout = config.timeout_ms || 30000;

  let apiCallsSucceeded = 0;
  let apiCallsFailed = 0;

  // ── Fetch shipping zones ────────────────────────────────────────────────

  try {
    const zonesRes = await fetch(`${base}/wp-json/wc/v3/shipping/zones`, {
      headers,
      signal: AbortSignal.timeout(timeout),
    });

    if (zonesRes.ok) {
      apiCallsSucceeded++;
      const zonesData: any[] = await zonesRes.json();

      for (const zone of zonesData) {
        const shippingZone: ShippingZone = {
          id: zone.id,
          name: zone.name || `Zone ${zone.id}`,
          methods: [],
        };

        // Fetch methods for this zone
        try {
          const methodsRes = await fetch(
            `${base}/wp-json/wc/v3/shipping/zones/${zone.id}/methods`,
            { headers, signal: AbortSignal.timeout(timeout) }
          );

          if (methodsRes.ok) {
            const methodsData: any[] = await methodsRes.json();
            shippingZone.methods = methodsData.map((m: any) => ({
              id: m.instance_id ?? m.id,
              title: m.title || m.method_title || 'Untitled',
              method_id: m.method_id || 'unknown',
              enabled: m.enabled !== false,
              cost: m.settings?.cost?.value,
              min_amount: m.settings?.min_amount?.value,
            }));
          }
        } catch {
          logger.warn(`Could not fetch methods for shipping zone "${shippingZone.name}"`);
        }

        result.shipping_zones.push(shippingZone);
      }
    } else {
      apiCallsFailed++;
      logger.warn(`Shipping zones endpoint returned HTTP ${zonesRes.status}`);
    }
  } catch (err: any) {
    apiCallsFailed++;
    logger.warn(`Shipping zones fetch failed: ${err.message}`);
  }

  // ── Fetch tax settings ──────────────────────────────────────────────────

  let taxSettings: any[] = [];
  try {
    const taxSettingsRes = await fetch(`${base}/wp-json/wc/v3/settings/tax`, {
      headers,
      signal: AbortSignal.timeout(timeout),
    });

    if (taxSettingsRes.ok) {
      apiCallsSucceeded++;
      taxSettings = await taxSettingsRes.json();

      const enabled = settingValue(taxSettings, 'woocommerce_calc_taxes') === 'yes';
      const calcBasedOn = settingValue(taxSettings, 'woocommerce_tax_based_on') || 'shipping';
      const pricesIncludeTax = settingValue(taxSettings, 'woocommerce_prices_include_tax') === 'yes';
      const displayInShop = settingValue(taxSettings, 'woocommerce_tax_display_shop') || 'excl';
      const displayInCart = settingValue(taxSettings, 'woocommerce_tax_display_cart') || 'excl';

      // Extract tax classes
      const taxClassSetting = settingValue(taxSettings, 'woocommerce_tax_classes');
      const taxClasses: string[] = [];
      if (typeof taxClassSetting === 'string' && taxClassSetting.trim()) {
        taxClasses.push(...taxClassSetting.split('\n').map((c: string) => c.trim()).filter(Boolean));
      }
      // Standard rate is always present
      taxClasses.unshift('Standard');

      result.tax_info = {
        enabled,
        calc_based_on: calcBasedOn,
        prices_include_tax: pricesIncludeTax,
        tax_classes: taxClasses,
        tax_rates_count: 0, // filled below
        display_in_shop: displayInShop,
        display_in_cart: displayInCart,
      };
    } else {
      apiCallsFailed++;
      logger.warn(`Tax settings endpoint returned HTTP ${taxSettingsRes.status}`);
    }
  } catch (err: any) {
    apiCallsFailed++;
    logger.warn(`Tax settings fetch failed: ${err.message}`);
  }

  // ── Fetch tax rates count ───────────────────────────────────────────────

  if (result.tax_info) {
    try {
      const taxRatesRes = await fetch(`${base}/wp-json/wc/v3/taxes`, {
        headers,
        signal: AbortSignal.timeout(timeout),
      });

      if (taxRatesRes.ok) {
        apiCallsSucceeded++;
        const taxRates: any[] = await taxRatesRes.json();
        result.tax_info.tax_rates_count = taxRates.length;
      } else {
        apiCallsFailed++;
      }
    } catch {
      apiCallsFailed++;
      logger.warn('Could not fetch tax rates list');
    }
  }

  // ── Check if any API calls succeeded ────────────────────────────────────

  if (apiCallsSucceeded === 0) {
    result.api_accessible = false;
    result.checkResults.push({
      check: 'Shipping & Tax -- Overall',
      status: 'ERROR',
      detail: 'All WooCommerce shipping/tax API calls failed. Credentials may lack permission or endpoints are disabled.',
    });
    return result;
  }

  result.api_accessible = true;

  // ── Analyse shipping issues ─────────────────────────────────────────────

  analyseShippingIssues(result);
  analyseTaxIssues(result);

  result.total_issues = result.issues.length;

  // ── Build CheckResult entries ───────────────────────────────────────────

  const shippingIssues = result.issues.filter((i) => i.type === 'shipping');
  const taxIssues = result.issues.filter((i) => i.type === 'tax');
  const hasMajorShipping = shippingIssues.some((i) => i.severity === 'major');
  const hasMajorTax = taxIssues.some((i) => i.severity === 'major');

  result.checkResults.push({
    check: 'Shipping & Tax -- Shipping Zones',
    status: hasMajorShipping ? 'FAIL' : shippingIssues.length > 0 ? 'WARN' : 'PASS',
    detail: shippingIssues.length > 0
      ? `${shippingIssues.length} shipping issue(s): ${shippingIssues.map((i) => i.detail).join('; ')}`
      : `${result.shipping_zones.length} shipping zone(s) configured correctly.`,
  });

  result.checkResults.push({
    check: 'Shipping & Tax -- Tax Configuration',
    status: hasMajorTax ? 'FAIL' : taxIssues.length > 0 ? 'WARN' : result.tax_info ? 'PASS' : 'SKIP',
    detail: taxIssues.length > 0
      ? `${taxIssues.length} tax issue(s): ${taxIssues.map((i) => i.detail).join('; ')}`
      : result.tax_info
        ? `Tax ${result.tax_info.enabled ? 'enabled' : 'disabled'}, ${result.tax_info.tax_rates_count} rate(s) configured.`
        : 'Tax settings could not be retrieved.',
  });

  const overallHasMajor = hasMajorShipping || hasMajorTax;
  result.checkResults.push({
    check: 'Shipping & Tax -- Overall',
    status: overallHasMajor ? 'FAIL' : result.total_issues > 0 ? 'WARN' : 'PASS',
    detail: result.total_issues === 0
      ? 'Shipping and tax configuration looks correct.'
      : `${result.total_issues} issue(s) found in shipping/tax configuration.`,
  });

  return result;
}

// ── Issue analysis ────────────────────────────────────────────────────────────

function analyseShippingIssues(result: ShippingTaxResult): void {
  const { shipping_zones, issues } = result;

  // No shipping zones configured at all
  if (shipping_zones.length === 0) {
    issues.push({
      type: 'shipping',
      severity: 'major',
      detail: 'No shipping zones configured.',
      recommendation: 'Add at least one shipping zone with a shipping method so customers can complete checkout.',
    });
    return;
  }

  // Check each zone
  for (const zone of shipping_zones) {
    // Zone with no methods
    if (zone.methods.length === 0) {
      issues.push({
        type: 'shipping',
        severity: 'major',
        detail: `Shipping zone "${zone.name}" has no shipping methods.`,
        recommendation: `Add at least one shipping method (flat rate, free shipping, or local pickup) to zone "${zone.name}".`,
      });
      continue;
    }

    // All methods disabled in this zone
    const enabledMethods = zone.methods.filter((m) => m.enabled);
    if (enabledMethods.length === 0) {
      issues.push({
        type: 'shipping',
        severity: 'major',
        detail: `All shipping methods in zone "${zone.name}" are disabled.`,
        recommendation: `Enable at least one shipping method in zone "${zone.name}" so customers in that region can check out.`,
      });
      continue;
    }

    // Free shipping with no minimum amount
    for (const method of enabledMethods) {
      if (method.method_id === 'free_shipping') {
        const minAmount = method.min_amount;
        if (!minAmount || minAmount === '' || minAmount === '0') {
          issues.push({
            type: 'shipping',
            severity: 'minor',
            detail: `Free shipping in zone "${zone.name}" has no minimum order amount.`,
            recommendation: 'Consider setting a minimum order amount for free shipping to protect margins, or confirm this is intentional.',
          });
        }
      }
    }
  }

  // Only one shipping method across all zones (no customer choice)
  const totalEnabledMethods = shipping_zones.reduce(
    (count, zone) => count + zone.methods.filter((m) => m.enabled).length,
    0
  );
  if (totalEnabledMethods === 1 && shipping_zones.length > 0) {
    issues.push({
      type: 'shipping',
      severity: 'minor',
      detail: 'Only one shipping method is enabled across all zones -- customers have no choice at checkout.',
      recommendation: 'Consider offering at least two shipping options (e.g. standard and express) to improve conversion.',
    });
  }
}

function analyseTaxIssues(result: ShippingTaxResult): void {
  const { tax_info, issues } = result;

  if (!tax_info) return;

  // Tax not enabled -- not necessarily an issue, just skip analysis
  if (!tax_info.enabled) return;

  // Tax enabled but no rates configured
  if (tax_info.tax_rates_count === 0) {
    issues.push({
      type: 'tax',
      severity: 'major',
      detail: 'Tax calculation is enabled but no tax rates are configured.',
      recommendation: 'Add tax rates for relevant regions, or disable tax calculation if not needed.',
    });
  }

  // Display inconsistency between shop and cart
  if (tax_info.display_in_shop !== tax_info.display_in_cart) {
    issues.push({
      type: 'tax',
      severity: 'minor',
      detail: `Tax display is inconsistent: showing "${tax_info.display_in_shop}" tax in shop but "${tax_info.display_in_cart}" tax in cart.`,
      recommendation: 'Use the same tax display setting in both shop and cart to avoid confusing customers about pricing.',
    });
  }

  // Prices include tax but display says "excluding" (or vice versa)
  if (tax_info.prices_include_tax && tax_info.display_in_shop === 'excl') {
    issues.push({
      type: 'tax',
      severity: 'minor',
      detail: 'Prices are entered including tax, but shop displays prices excluding tax.',
      recommendation: 'This can cause rounding discrepancies. Consider matching the display setting to how prices are entered, or verify the displayed prices are correct.',
    });
  }
  if (!tax_info.prices_include_tax && tax_info.display_in_shop === 'incl') {
    issues.push({
      type: 'tax',
      severity: 'minor',
      detail: 'Prices are entered excluding tax, but shop displays prices including tax.',
      recommendation: 'This can cause rounding discrepancies. Consider matching the display setting to how prices are entered, or verify the displayed prices are correct.',
    });
  }
}

// ── Report builder ────────────────────────────────────────────────────────────

export function buildShippingTaxReport(result: ShippingTaxResult): string {
  const lines: string[] = [];

  lines.push('## Shipping & Tax\n');

  if (!result.api_accessible && result.checkResults.length > 0) {
    const overall = result.checkResults.find((c) => c.check.includes('Overall'));
    lines.push(overall?.detail || 'Shipping and tax data could not be retrieved.');
    lines.push('');
    return lines.join('\n');
  }

  // ── Shipping zones table ────────────────────────────────────────────────

  lines.push('### Shipping Zones\n');

  if (result.shipping_zones.length === 0) {
    lines.push('No shipping zones configured.\n');
  } else {
    lines.push('| Zone | Method | Type | Enabled | Cost |');
    lines.push('|------|--------|------|---------|------|');

    for (const zone of result.shipping_zones) {
      if (zone.methods.length === 0) {
        lines.push(`| ${zone.name} | (none) | -- | -- | -- |`);
      } else {
        for (const method of zone.methods) {
          const enabledStr = method.enabled ? 'Yes' : 'No';
          const costStr = method.cost || (method.method_id === 'free_shipping' ? 'Free' : '--');
          lines.push(`| ${zone.name} | ${method.title} | ${method.method_id} | ${enabledStr} | ${costStr} |`);
        }
      }
    }
    lines.push('');
  }

  // ── Tax configuration summary ───────────────────────────────────────────

  lines.push('### Tax Configuration\n');

  if (!result.tax_info) {
    lines.push('Tax settings could not be retrieved.\n');
  } else {
    const tax = result.tax_info;
    lines.push('| Setting | Value |');
    lines.push('|---------|-------|');
    lines.push(`| Tax enabled | ${tax.enabled ? 'Yes' : 'No'} |`);

    if (tax.enabled) {
      lines.push(`| Calculated based on | ${tax.calc_based_on} |`);
      lines.push(`| Prices entered with tax | ${tax.prices_include_tax ? 'Yes' : 'No'} |`);
      lines.push(`| Display in shop | ${tax.display_in_shop} |`);
      lines.push(`| Display in cart | ${tax.display_in_cart} |`);
      lines.push(`| Tax classes | ${tax.tax_classes.join(', ')} |`);
      lines.push(`| Tax rates configured | ${tax.tax_rates_count} |`);
    }
    lines.push('');
  }

  // ── Issues list ─────────────────────────────────────────────────────────

  if (result.issues.length > 0) {
    lines.push('### Issues\n');

    const majorIssues = result.issues.filter((i) => i.severity === 'major');
    const minorIssues = result.issues.filter((i) => i.severity === 'minor');

    if (majorIssues.length > 0) {
      lines.push(`**Major (${majorIssues.length}):**\n`);
      for (const issue of majorIssues) {
        lines.push(`- [${issue.type.toUpperCase()}] ${issue.detail}`);
        lines.push(`  Recommendation: ${issue.recommendation}`);
      }
      lines.push('');
    }

    if (minorIssues.length > 0) {
      lines.push(`**Minor (${minorIssues.length}):**\n`);
      for (const issue of minorIssues) {
        lines.push(`- [${issue.type.toUpperCase()}] ${issue.detail}`);
        lines.push(`  Recommendation: ${issue.recommendation}`);
      }
      lines.push('');
    }
  } else if (result.api_accessible) {
    lines.push('No shipping or tax configuration issues detected.\n');
  }

  return lines.join('\n');
}

// ── Layer 2 trigger builder ───────────────────────────────────────────────────

export function buildShippingTaxL2Trigger(result: ShippingTaxResult): {
  id: string;
  priority: 'high' | 'medium' | 'low';
  description: string;
  data: any;
} | null {
  const majorIssues = result.issues.filter((i) => i.severity === 'major');

  if (majorIssues.length === 0) return null;

  const shippingMajor = majorIssues.filter((i) => i.type === 'shipping');
  const taxMajor = majorIssues.filter((i) => i.type === 'tax');

  const parts: string[] = [];
  if (shippingMajor.length > 0) {
    parts.push(`${shippingMajor.length} major shipping issue(s)`);
  }
  if (taxMajor.length > 0) {
    parts.push(`${taxMajor.length} major tax issue(s)`);
  }

  return {
    id: 'shipping-tax-issues',
    priority: 'high',
    description: `${parts.join(' and ')} detected. ${majorIssues.map((i) => i.detail).join(' ')} Investigate checkout flow to confirm customers can complete purchases.`,
    data: {
      totalIssues: result.total_issues,
      majorIssues: majorIssues.map((i) => ({
        type: i.type,
        detail: i.detail,
        recommendation: i.recommendation,
      })),
      shippingZoneCount: result.shipping_zones.length,
      taxEnabled: result.tax_info?.enabled ?? null,
      taxRatesCount: result.tax_info?.tax_rates_count ?? null,
    },
  };
}
