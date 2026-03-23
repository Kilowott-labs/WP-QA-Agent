import { SiteConfig, WordPressHealthResult, PluginInfo } from '../../types.js';
import { getAuthHeader, baseUrl, logger } from '../../utils.js';

const PREMIUM_SLUGS = [
  'woocommerce-subscriptions', 'woocommerce-memberships',
  'gravityforms', 'advanced-custom-fields-pro', 'acf-pro',
  'elementor-pro', 'wpml', 'polylang-pro', 'yoast-seo-premium',
  'wp-rocket', 'imagify', 'wpforms-lite',
];

/**
 * Check WordPress health via REST API:
 * site info, WooCommerce detection, plugins, template overrides.
 */
export async function checkWordPressHealth(
  config: SiteConfig
): Promise<WordPressHealthResult> {
  const base = baseUrl(config.url);
  const publicHeaders: HeadersInit = { 'Content-Type': 'application/json' };
  const hasAuth = !!(config.username && config.app_password);
  const authHeaders: HeadersInit = hasAuth
    ? { 'Content-Type': 'application/json', 'Authorization': getAuthHeader(config.username!, config.app_password!) }
    : publicHeaders;

  const result: WordPressHealthResult = {
    site_name: '',
    wp_version: 'Unknown',
    woocommerce_detected: false,
    plugins: [],
    plugins_needing_update: [],
    inactive_plugins: [],
    rest_api_accessible: false,
  };

  // ── Detect WP version from HTML meta generator tag ────────────────────
  // This works without auth on most WordPress sites (unless the tag is stripped)
  try {
    const htmlRes = await fetch(base, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'wp-qa-agent/1.0' },
    });
    if (htmlRes.ok) {
      const html = await htmlRes.text();
      // <meta name="generator" content="WordPress 6.7.2" />
      const generatorMatch = html.match(
        /<meta[^>]+name=["']generator["'][^>]+content=["']WordPress\s+([\d.]+)["']/i
      );
      if (generatorMatch) {
        result.wp_version = generatorMatch[1];
        logger.info(`  WP version detected from meta tag: ${result.wp_version}`);
      }
    }
  } catch { /* non-critical — we'll try other methods */ }

  // ── If meta tag didn't work, try RSS feed ─────────────────────────────
  if (result.wp_version === 'Unknown') {
    try {
      const rssRes = await fetch(`${base}/feed/`, {
        signal: AbortSignal.timeout(10000),
        headers: { 'User-Agent': 'wp-qa-agent/1.0' },
      });
      if (rssRes.ok) {
        const rssText = await rssRes.text();
        // <generator>https://wordpress.org/?v=6.7.2</generator>
        const rssMatch = rssText.match(
          /<generator>[^<]*wordpress\.org\/?\?v=([\d.]+)<\/generator>/i
        );
        if (rssMatch) {
          result.wp_version = rssMatch[1];
          logger.info(`  WP version detected from RSS feed: ${result.wp_version}`);
        }
      }
    } catch { /* non-critical */ }
  }

  // Test REST API accessibility — always use public headers first
  // (auth headers can cause 401 on the index endpoint if credentials are wrong)
  try {
    const res = await fetch(`${base}/wp-json/`, {
      headers: publicHeaders,
      signal: AbortSignal.timeout(30000),
    });
    if (res.ok) {
      result.rest_api_accessible = true;
      const data = await res.json();
      result.site_name = data.name || '';

      const namespaces: string[] = data.namespaces || [];
      result.woocommerce_detected = namespaces.some(
        (ns: string) => ns.startsWith('wc/') || ns.startsWith('woocommerce')
      );
    } else {
      logger.warn(`REST API returned HTTP ${res.status}`);
    }
  } catch (err: any) {
    result.rest_api_accessible = false;
    logger.warn(`REST API error: ${err.message}`);
    return result;
  }

  // Validate auth credentials if provided
  if (hasAuth) {
    try {
      const authTest = await fetch(`${base}/wp-json/wp/v2/users/me`, {
        headers: authHeaders,
        signal: AbortSignal.timeout(15000),
      });
      if (!authTest.ok) {
        logger.warn(`Authentication failed (HTTP ${authTest.status}) — check username and app_password`);
        logger.warn('Continuing without auth (plugin list and WC status will be unavailable)');
        return result;
      }
      const user = await authTest.json();
      logger.info(`Authenticated as: ${user.name} (${user.roles?.join(', ') || 'unknown role'})`);
    } catch (err: any) {
      logger.warn(`Auth check failed: ${err.message}`);
    }
  }

  // Get plugin list (requires auth)
  if (hasAuth) {
    try {
      const res = await fetch(`${base}/wp-json/wp/v2/plugins`, {
        headers: authHeaders,
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const plugins = await res.json();
        result.plugins = plugins.map(
          (p: any): PluginInfo => ({
            name: p.name,
            slug: p.plugin,
            version: p.version,
            status: p.status,
            update_available: !!p.update,
            update_version: p.update?.version,
            is_premium: PREMIUM_SLUGS.some((s) =>
              p.plugin.toLowerCase().includes(s)
            ),
          })
        );

        result.plugins_needing_update = result.plugins.filter(
          (p) => p.update_available
        );
        result.inactive_plugins = result.plugins.filter(
          (p) => p.status === 'inactive'
        );

        const wc = result.plugins.find((p) =>
          p.slug.includes('woocommerce/woocommerce')
        );
        if (wc) result.wc_version = wc.version;
      }
    } catch {
      logger.warn('Could not fetch plugin list (auth may be incorrect)');
    }

    // WooCommerce system status: template overrides + plugin update cross-reference
    if (result.woocommerce_detected) {
      try {
        const res = await fetch(`${base}/wp-json/wc/v3/system_status`, {
          headers: authHeaders,
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
          const status = await res.json();

          // Extract WP version from WC system status if not yet detected
          if (result.wp_version === 'Unknown' && status.environment?.wp_version) {
            result.wp_version = status.environment.wp_version;
            logger.info(`  WP version detected from WC system status: ${result.wp_version}`);
          }

          if (status.theme?.has_outdated_templates) {
            result.wc_template_overrides_outdated =
              status.theme?.overrides
                ?.filter((t: any) => t.outdated)
                .map((t: any) => t.file) || [];
          }

          // Cross-reference plugin updates from WC system status.
          // The WP REST API /wp/v2/plugins depends on the update_plugins
          // transient which may be expired, causing it to miss available
          // updates. The WC system status endpoint reports version_latest
          // independently, so we use it as a reliable fallback.
          const wcPlugins: any[] = [
            ...(status.active_plugins || []),
            ...(status.inactive_plugins || []),
          ];
          if (wcPlugins.length > 0 && result.plugins.length > 0) {
            for (const wcP of wcPlugins) {
              if (!wcP.version || !wcP.version_latest) continue;
              if (wcP.version === wcP.version_latest) continue;

              // Find matching plugin in our list by name or slug
              const match = result.plugins.find(
                (p) =>
                  p.name === wcP.name ||
                  p.slug.includes(wcP.plugin?.replace(/\.php$/, '') || '___')
              );
              if (match && !match.update_available) {
                match.update_available = true;
                match.update_version = wcP.version_latest;
                logger.info(
                  `  Plugin update detected via WC system status: ${match.name} ${match.version} → ${wcP.version_latest}`
                );
              }
            }

            // Rebuild the needing-update list after cross-reference
            result.plugins_needing_update = result.plugins.filter(
              (p) => p.update_available
            );
          }
        }
      } catch {
        // WC system status not accessible
      }
    }
  }

  return result;
}
