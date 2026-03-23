import { SiteConfig, CheckUpdatesResult, PluginUpdateCheck, WPCoreUpdateCheck } from '../types.js';
import { logger, baseUrl, getAuthHeader } from '../utils.js';
import { getPluginsWithUpdates, getAllPlugins } from './plugin-api.js';
import { classifyUpdate } from './semver.js';

/**
 * Check for available plugin and WordPress core updates without making any changes.
 * Returns categorised list of updatable vs manual-review plugins,
 * plus WP core update status.
 */
export async function checkForUpdates(
  config: SiteConfig
): Promise<CheckUpdatesResult> {
  const targetUrl = config.staging_url || config.url;

  if (!config.username || !config.app_password) {
    logger.error('WordPress credentials required to check plugin updates.');
    process.exit(1);
  }

  logger.section(`Checking Updates — ${config.name}`);
  logger.info(`URL: ${targetUrl}`);

  // ── Check WordPress core version ─────────────────────────────────────
  logger.info('Checking WordPress core version...');
  const wpCoreCheck = await checkWPCoreUpdate(config, targetUrl);
  if (wpCoreCheck) {
    if (wpCoreCheck.update_available) {
      logger.warn(`WordPress core: ${wpCoreCheck.current_version} → ${wpCoreCheck.latest_version} (${wpCoreCheck.update_type})`);
      if (wpCoreCheck.auto_updatable) {
        logger.info('  Auto-updatable (minor/patch security release)');
      } else {
        logger.warn('  Major update — manual review recommended');
      }
    } else {
      logger.success(`WordPress core: ${wpCoreCheck.current_version} (up to date)`);
    }
  }

  // Get full plugin list for total count
  let totalPlugins = 0;
  try {
    const all = await getAllPlugins(config, targetUrl);
    totalPlugins = all.length;
  } catch {
    // Non-critical — we just won't have the total count
  }

  // Get plugins with available updates
  const updatable = await getPluginsWithUpdates(config, targetUrl);

  if (updatable.length === 0 && (!wpCoreCheck || !wpCoreCheck.update_available)) {
    logger.success('Everything is up to date.');
    return {
      site: config.name,
      url: targetUrl,
      checked_at: new Date().toISOString(),
      wp_core: wpCoreCheck || undefined,
      plugins_total: totalPlugins,
      plugins_with_updates: [],
      auto_updatable: [],
      manual_review: [],
    };
  }

  // Classify each update
  const checks: PluginUpdateCheck[] = updatable.map((p) => {
    const updateType = classifyUpdate(p.version, p.update_version!);
    const autoUpdatable = updateType !== 'major';

    return {
      plugin: p,
      current_version: p.version,
      available_version: p.update_version!,
      update_type: updateType,
      auto_updatable: autoUpdatable,
      reason: !autoUpdatable
        ? `Major version change (${p.version} → ${p.update_version}) — may contain breaking changes`
        : undefined,
    };
  });

  const auto = checks.filter((c) => c.auto_updatable);
  const manual = checks.filter((c) => !c.auto_updatable);

  // Print results
  if (updatable.length > 0) {
    logger.info(`${updatable.length} plugin(s) have updates available:`);
    logger.info('');

    if (auto.length > 0) {
      logger.info(`Auto-updatable (minor/patch): ${auto.length}`);
      for (const c of auto) {
        logger.success(`  ${c.plugin.name}: ${c.current_version} → ${c.available_version} (${c.update_type})`);
        logger.dim(`    --plugin "${c.plugin.slug}"`);
      }
    }

    if (manual.length > 0) {
      logger.info('');
      logger.warn(`Manual review required (major): ${manual.length}`);
      for (const c of manual) {
        logger.warn(`  ${c.plugin.name}: ${c.current_version} → ${c.available_version} (${c.update_type})`);
        logger.dim(`    --plugin "${c.plugin.slug}"`);
      }
    }
  }

  return {
    site: config.name,
    url: targetUrl,
    checked_at: new Date().toISOString(),
    wp_core: wpCoreCheck || undefined,
    plugins_total: totalPlugins,
    plugins_with_updates: checks,
    auto_updatable: auto,
    manual_review: manual,
  };
}

/**
 * Check if a WordPress core update is available.
 * Detects current version from the site, then checks WordPress.org API for latest.
 */
async function checkWPCoreUpdate(
  config: SiteConfig,
  targetUrl: string
): Promise<WPCoreUpdateCheck | null> {
  const base = baseUrl(targetUrl);
  let currentVersion: string | null = null;

  // Try to detect current WP version from multiple sources
  // 1. HTML meta generator tag
  try {
    const htmlRes = await fetch(base, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'wp-qa-agent/1.0' },
    });
    if (htmlRes.ok) {
      const html = await htmlRes.text();
      const match = html.match(
        /<meta[^>]+name=["']generator["'][^>]+content=["']WordPress\s+([\d.]+)["']/i
      );
      if (match) currentVersion = match[1];
    }
  } catch { /* non-critical */ }

  // 2. WC system status (if auth available and WC detected)
  if (!currentVersion && config.username && config.app_password) {
    try {
      const res = await fetch(`${base}/wp-json/wc/v3/system_status`, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: getAuthHeader(config.username, config.app_password),
        },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.environment?.wp_version) {
          currentVersion = data.environment.wp_version;
        }
      }
    } catch { /* non-critical */ }
  }

  // 3. RSS feed
  if (!currentVersion) {
    try {
      const rssRes = await fetch(`${base}/feed/`, {
        signal: AbortSignal.timeout(10000),
        headers: { 'User-Agent': 'wp-qa-agent/1.0' },
      });
      if (rssRes.ok) {
        const rssText = await rssRes.text();
        const match = rssText.match(
          /<generator>[^<]*wordpress\.org\/?\?v=([\d.]+)<\/generator>/i
        );
        if (match) currentVersion = match[1];
      }
    } catch { /* non-critical */ }
  }

  if (!currentVersion) {
    logger.warn('Could not detect current WordPress version');
    return null;
  }

  // Fetch latest WP version from WordPress.org
  let latestVersion: string | null = null;
  try {
    const res = await fetch('https://api.wordpress.org/core/version-check/1.7/', {
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      latestVersion = data.offers?.[0]?.version || null;
    }
  } catch { /* non-critical */ }

  if (!latestVersion) {
    logger.warn('Could not fetch latest WordPress version from wordpress.org');
    return {
      current_version: currentVersion,
      latest_version: 'unknown',
      update_available: false,
      update_type: 'none',
      auto_updatable: false,
      reason: 'Could not determine latest version',
    };
  }

  const updateAvailable = currentVersion !== latestVersion;
  let updateType: WPCoreUpdateCheck['update_type'] = 'none';
  let autoUpdatable = false;

  if (updateAvailable) {
    updateType = classifyUpdate(currentVersion, latestVersion);
    // WordPress auto-updates minor/patch by default since WP 3.7
    autoUpdatable = updateType !== 'major';
  }

  return {
    current_version: currentVersion,
    latest_version: latestVersion,
    update_available: updateAvailable,
    update_type: updateType,
    auto_updatable: autoUpdatable,
    reason: updateType === 'major'
      ? `Major version change (${currentVersion} → ${latestVersion}) — test on staging first`
      : undefined,
  };
}
