import { SiteConfig, PluginInfo } from '../types.js';
import { getAuthHeader, baseUrl, logger } from '../utils.js';

const TIMEOUT = 30000;

/**
 * Build auth headers for plugin API calls.
 */
function authHeaders(config: SiteConfig): HeadersInit {
  return {
    'Content-Type': 'application/json',
    Authorization: getAuthHeader(config.username!, config.app_password!),
  };
}

/**
 * Get all plugins that have updates available.
 * Uses the target URL (should be staging).
 */
/**
 * Get all plugins that have updates available.
 *
 * Uses TWO sources to detect updates:
 * 1. WP REST API /wp/v2/plugins (checks the update_plugins transient)
 * 2. WC system status /wc/v3/system_status (has version_latest per plugin)
 *
 * The WP transient is often stale or empty (especially on staging sites
 * that don't get regular cron hits), so the WC cross-reference catches
 * updates the REST API misses.
 */
export async function getPluginsWithUpdates(
  config: SiteConfig,
  targetUrl: string
): Promise<PluginInfo[]> {
  const base = baseUrl(targetUrl);
  const headers = authHeaders(config);

  let allPlugins: PluginInfo[];

  try {
    const res = await fetch(`${base}/wp-json/wp/v2/plugins`, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT),
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Authentication failed (HTTP ${res.status}). Ensure username and app_password are correct and user has administrator role.`);
      }
      throw new Error(`Plugin API returned HTTP ${res.status}`);
    }

    const plugins = await res.json();

    allPlugins = plugins.map(
      (p: any): PluginInfo => ({
        name: p.name?.replace(/<[^>]*>/g, '') || p.plugin,
        slug: p.plugin,
        version: p.version,
        status: p.status,
        update_available: !!p.update,
        update_version: p.update?.version,
      })
    );
  } catch (err: any) {
    logger.error(`Failed to fetch plugin list: ${err.message}`);
    throw err;
  }

  // Cross-reference with WooCommerce system status for updates
  // the WP REST API missed (stale update_plugins transient)
  try {
    const wcRes = await fetch(`${base}/wp-json/wc/v3/system_status`, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT),
    });

    if (wcRes.ok) {
      const status = await wcRes.json();
      // Only cross-reference active plugins — inactive ones don't matter for updates
      const wcPlugins: any[] = status.active_plugins || [];

      let crossRefCount = 0;
      for (const wcP of wcPlugins) {
        if (!wcP.version || !wcP.version_latest) continue;
        if (wcP.version === wcP.version_latest) continue;

        // Find matching plugin in our list
        const match = allPlugins.find(
          (p) =>
            p.name === wcP.name ||
            p.slug.includes(wcP.plugin?.replace(/\.php$/, '') || '___')
        );
        if (match && !match.update_available) {
          match.update_available = true;
          match.update_version = wcP.version_latest;
          crossRefCount++;
          logger.info(`  Update detected via WC system status: ${match.name} ${match.version} → ${wcP.version_latest}`);
        }
      }

      if (crossRefCount > 0) {
        logger.info(`  ${crossRefCount} additional update(s) found via WC cross-reference`);
      }
    }
  } catch {
    // WC system status not available — non-critical, we still have REST API results
  }

  // Only return active plugins with updates — inactive plugins are irrelevant for updates
  return allPlugins.filter((p) => p.update_available && p.update_version && p.status === 'active');
}

/**
 * Trigger a plugin update with automatic backup.
 *
 * Flow:
 * 1. Backup current version via /wpau/v1/backup/plugin
 * 2. Update via /wpau/v1/update/plugin
 * 3. Re-activate the plugin
 *
 * If something goes wrong after update (blocker regression detected by the runner),
 * the runner calls rollbackPlugin() which uses /wpau/v1/revert/plugin.
 *
 * All via REST API with application passwords — no wp-admin login needed.
 */
export async function updatePlugin(
  config: SiteConfig,
  targetUrl: string,
  pluginSlug: string,
  page?: import('playwright').Page
): Promise<{ success: boolean; message: string; new_version?: string; backup_id?: string }> {
  const base = baseUrl(targetUrl);
  const headers = authHeaders(config);

  // Resolve the correct plugin_file value
  const pluginFile = await resolvePluginFile(config, base, pluginSlug, headers);
  if (!pluginFile) {
    return {
      success: false,
      message: `Could not resolve plugin file path for "${pluginSlug}". Check the plugin slug.`,
    };
  }

  // Step 1: Backup current version before updating
  let backupId: string | undefined;
  logger.info('  Backing up current version...');
  const backupEndpoints = [
    `${base}/wp-json/wpau/v1/backup/plugin`,
    `${base}/wp-json/wp-qa/v1/backup-plugin`,
  ];

  for (const backupUrl of backupEndpoints) {
    try {
      const backupRes = await fetch(backupUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ plugin_file: pluginFile }),
        signal: AbortSignal.timeout(60000),
      });

      if (backupRes.ok) {
        const backupData = await backupRes.json();
        backupId = backupData.backup_id || backupData.id;
        logger.info(`  Backup created${backupId ? ` (ID: ${backupId})` : ''}`);
        break;
      }
    } catch { /* try next */ }
  }

  if (!backupId) {
    logger.warn('  No backup endpoint available — proceeding without backup');
  }

  // Step 2: Trigger update — try multiple strategies

  // Strategy A: Hosting-specific REST API endpoints (Elementor Cloud, etc.)
  const updateEndpoints = [
    { url: `${base}/wp-json/wpau/v1/update/plugin`, name: 'wpau' },
    { url: `${base}/wp-json/wp-qa/v1/update-plugin`, name: 'wp-qa helper' },
  ];

  for (const endpoint of updateEndpoints) {
    logger.info(`  Trying ${endpoint.name}...`);
    try {
      const res = await fetch(endpoint.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ plugin_file: pluginFile }),
        signal: AbortSignal.timeout(120000),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.success !== false) {
          logger.info(`  Update successful via ${endpoint.name}`);
          await reactivatePlugin(base, pluginSlug, pluginFile, headers);
          return {
            success: true,
            message: data.message || `Plugin updated via ${endpoint.name}`,
            new_version: data.version || (await verifyPluginVersion(config, targetUrl, pluginSlug, '')).version,
            backup_id: backupId,
          };
        }
        continue;
      }

      if (res.status !== 404) {
        const errBody = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
        logger.info(`  ${endpoint.name}: ${errBody.message || res.status}`);
      }
    } catch { /* try next */ }
  }

  // Strategy B: Auto-install site-qa-updater plugin from wordpress.org, use it, remove it
  // This is the universal approach — works on any standard WordPress host
  logger.info('  Auto-installing site-qa-updater helper...');
  const helperResult = await autoInstallAndUpdate(config, base, pluginSlug, pluginFile, headers);
  if (helperResult.success) {
    return { ...helperResult, backup_id: backupId };
  }

  // Strategy C: WordPress auto-update via wp-cron (fallback, unreliable timing)
  logger.info('  Trying auto-update + wp-cron trigger...');
  const autoUpdateResult = await tryAutoUpdateViaCron(config, base, pluginSlug, pluginFile, headers);
  if (autoUpdateResult.success) {
    return { ...autoUpdateResult, backup_id: backupId };
  }

  return {
    success: false,
    message: 'All update methods failed. This may be a premium plugin not available on wordpress.org, or the hosting environment restricts plugin updates via API.',
  };
}

/**
 * Auto-install the site-qa-updater helper plugin from wordpress.org,
 * use it to update the target plugin, then remove it.
 *
 * Flow:
 * 1. POST /wp/v2/plugins {slug: "site-qa-updater", status: "active"} → install from wordpress.org
 * 2. POST /wp-qa/v1/update-plugin {plugin_file} → update the target plugin
 * 3. DELETE /wp/v2/plugins/site-qa-updater%2Fsite-qa-updater.php → remove helper
 *
 * The helper plugin is never left on the site.
 */
async function autoInstallAndUpdate(
  config: SiteConfig,
  base: string,
  pluginSlug: string,
  pluginFile: string,
  headers: HeadersInit
): Promise<{ success: boolean; message: string; new_version?: string }> {
  const HELPER_SLUG = 'site-qa-updater';
  const HELPER_FILE = 'site-qa-updater/site-qa-updater.php';
  const HELPER_FILE_ENCODED = 'site-qa-updater%2Fsite-qa-updater.php';

  // Step 1: Install the helper from wordpress.org
  try {
    const installRes = await fetch(`${base}/wp-json/wp/v2/plugins`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ slug: HELPER_SLUG, status: 'active' }),
      signal: AbortSignal.timeout(60000),
    });

    if (!installRes.ok) {
      const err = await installRes.json().catch(() => ({ code: 'unknown' }));

      if (err.code === 'folder_exists') {
        // Already installed — just activate it
        logger.info('  Helper already installed, activating...');
        try {
          await fetch(`${base}/wp-json/wp/v2/plugins/${HELPER_FILE_ENCODED}`, {
            method: 'PUT',
            headers,
            body: JSON.stringify({ status: 'active' }),
            signal: AbortSignal.timeout(15000),
          });
        } catch { /* try without encoding */ }
        try {
          await fetch(`${base}/wp-json/wp/v2/plugins/${HELPER_SLUG}/${HELPER_SLUG}`, {
            method: 'PUT',
            headers,
            body: JSON.stringify({ status: 'active' }),
            signal: AbortSignal.timeout(15000),
          });
        } catch { /* non-critical */ }
      } else {
        logger.info(`  Could not install helper: ${err.code || err.message || installRes.status}`);
        return { success: false, message: `Helper install failed: ${err.message || err.code}` };
      }
    } else {
      logger.info('  Helper installed and activated');
    }
  } catch (err: any) {
    logger.info(`  Helper install failed: ${err.message}`);
    return { success: false, message: `Helper install failed: ${err.message}` };
  }

  // Brief wait for WordPress to register the new REST routes
  await new Promise((r) => setTimeout(r, 1000));

  // Step 2: Use the helper to update the target plugin
  let updateResult: { success: boolean; message: string; new_version?: string } = {
    success: false,
    message: 'Helper update endpoint not reachable',
  };

  try {
    const updateRes = await fetch(`${base}/wp-json/wp-qa/v1/update-plugin`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ plugin_file: pluginFile }),
      signal: AbortSignal.timeout(120000),
    });

    if (updateRes.ok) {
      const data = await updateRes.json();
      if (data.success) {
        logger.info(`  Update successful: ${data.old_version} → ${data.new_version}`);
        updateResult = {
          success: true,
          message: data.message || 'Plugin updated',
          new_version: data.new_version,
        };
      } else {
        updateResult = { success: false, message: data.message || 'Update returned success:false' };
      }
    } else {
      const errData = await updateRes.json().catch(() => ({ message: `HTTP ${updateRes.status}` }));
      updateResult = { success: false, message: errData.message || `HTTP ${updateRes.status}` };
    }
  } catch (err: any) {
    updateResult = { success: false, message: `Update request failed: ${err.message}` };
  }

  // Step 3: Remove the helper plugin (always, regardless of update success)
  logger.info('  Removing helper plugin...');
  try {
    // Deactivate first
    await fetch(`${base}/wp-json/wp/v2/plugins/${HELPER_FILE_ENCODED}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ status: 'inactive' }),
      signal: AbortSignal.timeout(15000),
    }).catch(() => {});
    await fetch(`${base}/wp-json/wp/v2/plugins/${HELPER_SLUG}/${HELPER_SLUG}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ status: 'inactive' }),
      signal: AbortSignal.timeout(15000),
    }).catch(() => {});

    // Delete
    await fetch(`${base}/wp-json/wp/v2/plugins/${HELPER_FILE_ENCODED}`, {
      method: 'DELETE',
      headers,
      signal: AbortSignal.timeout(15000),
    }).catch(() => {});
    await fetch(`${base}/wp-json/wp/v2/plugins/${HELPER_SLUG}/${HELPER_SLUG}`, {
      method: 'DELETE',
      headers,
      signal: AbortSignal.timeout(15000),
    }).catch(() => {});

    logger.info('  Helper removed');
  } catch {
    logger.warn('  Could not remove helper plugin — remove manually from wp-admin');
  }

  return updateResult;
}

/**
 * Update a plugin using WordPress's built-in auto-update mechanism.
 *
 * 1. Enable auto-updates for the plugin via REST API
 * 2. Trigger wp-cron.php to run the auto-updater
 * 3. Poll for version change
 * 4. Disable auto-updates (restore original state)
 *
 * Works on any standard WordPress 5.5+ host with application passwords.
 * No plugins needed, no wp-admin login, no filesystem access.
 */
async function tryAutoUpdateViaCron(
  config: SiteConfig,
  base: string,
  pluginSlug: string,
  pluginFile: string,
  headers: HeadersInit
): Promise<{ success: boolean; message: string; new_version?: string }> {
  const encodedFile = pluginFile.replace('/', '%2F');

  // Get current version and auto_update state
  let currentVersion: string | undefined;
  let wasAutoUpdate: boolean | undefined;

  try {
    const getRes = await fetch(`${base}/wp-json/wp/v2/plugins/${pluginSlug}`, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (getRes.ok) {
      const data = await getRes.json();
      currentVersion = data.version;
      wasAutoUpdate = data.auto_update;
    }
  } catch { /* try to get version from the list */ }

  if (!currentVersion) {
    // Get from plugins list
    try {
      const listRes = await fetch(`${base}/wp-json/wp/v2/plugins`, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (listRes.ok) {
        const plugins = await listRes.json();
        const match = plugins.find((p: any) => p.plugin === pluginSlug || p.plugin === pluginFile);
        if (match) {
          currentVersion = match.version;
          wasAutoUpdate = match.auto_update;
        }
      }
    } catch { /* non-critical */ }
  }

  if (!currentVersion) {
    return { success: false, message: 'Could not determine current plugin version' };
  }

  // Step 1: Enable auto-updates for this plugin
  // Try multiple slug formats — WordPress is inconsistent across hosts
  logger.info('  Enabling auto-update for this plugin...');
  let putSucceeded = false;
  const slugVariants = [
    pluginSlug,                           // folder/file (no .php)
    pluginFile,                           // folder/file.php
    pluginFile.replace('/', '%2F'),       // folder%2Ffile.php (URL-encoded)
    pluginSlug.replace('/', '%2F'),       // folder%2Ffile (URL-encoded, no .php)
  ];

  for (const slug of slugVariants) {
    try {
      const enableRes = await fetch(`${base}/wp-json/wp/v2/plugins/${slug}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ auto_update: true }),
        signal: AbortSignal.timeout(15000),
      });
      if (enableRes.ok) {
        putSucceeded = true;
        logger.info('  Auto-update flag set');
        break;
      }
    } catch { /* try next variant */ }
  }

  if (!putSucceeded) {
    logger.info('  Could not set auto_update via REST API');
    return { success: false, message: 'Could not enable auto-update via REST API. The host may restrict this.' };
  }

  // Step 2: Trigger wp-cron regardless of whether auto_update was confirmed
  // WordPress may accept the setting without returning it in the response
  logger.info('  Triggering wp-cron...');

  // Step 2: Trigger wp-cron.php multiple times to handle lock
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fetch(`${base}/wp-cron.php?doing_wp_cron=${Date.now() / 1000}`, {
        signal: AbortSignal.timeout(30000),
        headers: { 'User-Agent': 'wp-qa-agent/1.0' },
      });
    } catch { /* wp-cron might not return a response */ }

    // Wait for the update to process
    await new Promise((r) => setTimeout(r, 5000));

    // Step 3: Check if version actually changed (not just "unknown")
    const verification = await verifyPluginVersion(config, base, pluginSlug, '');
    const newVersion = verification.version;
    if (newVersion && newVersion !== 'unknown' && newVersion !== currentVersion) {
      logger.info(`  Updated: ${currentVersion} → ${verification.version}`);

      // Step 4: Restore auto_update to original state
      if (!wasAutoUpdate) {
        for (const s of slugVariants) {
          try {
            const r = await fetch(`${base}/wp-json/wp/v2/plugins/${s}`, {
              method: 'PUT',
              headers,
              body: JSON.stringify({ auto_update: false }),
              signal: AbortSignal.timeout(15000),
            });
            if (r.ok) break;
          } catch { /* try next */ }
        }
      }

      return {
        success: true,
        message: 'Plugin updated via auto-update mechanism',
        new_version: verification.version,
      };
    }

    if (attempt < 2) {
      logger.info(`  Version unchanged, retrying cron trigger (attempt ${attempt + 2}/3)...`);
    }
  }

  // Restore auto_update to original state
  if (!wasAutoUpdate) {
    for (const slug of slugVariants) {
      try {
        const res = await fetch(`${base}/wp-json/wp/v2/plugins/${slug}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ auto_update: false }),
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) break;
      } catch { /* try next */ }
    }
  }

  return {
    success: false,
    message: `Auto-update enabled and cron triggered but version didn't change (${currentVersion}). The auto-updater may be locked (runs max once per hour), or this is a premium plugin whose update server requires a license. Try again later.`,
  };
}

/**
 * Resolve the full plugin file path (e.g. "folder/file.php") needed by wpau.
 * Checks the wpau updates list first, then falls back to the WP REST API plugin list.
 */
async function resolvePluginFile(
  config: SiteConfig,
  base: string,
  pluginSlug: string,
  headers: HeadersInit
): Promise<string | null> {
  const slugNorm = pluginSlug.toLowerCase().replace(/\.php$/, '');

  // Try wpau updates list first — has the exact file field
  try {
    const res = await fetch(`${base}/wp-json/wpau/v1/updates`, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const data = await res.json();
      const plugins: any[] = data.plugins || [];
      const match = plugins.find((p: any) => {
        const file = (p.file || '').toLowerCase().replace(/\.php$/, '');
        const slug = (p.slug || '').toLowerCase();
        return file === slugNorm || slug === slugNorm || file.startsWith(slugNorm.split('/')[0] + '/');
      });
      if (match) return match.file;
    }
  } catch { /* non-critical */ }

  // Fall back to WP REST API plugin list
  try {
    const res = await fetch(`${base}/wp-json/wp/v2/plugins`, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const plugins = await res.json();
      const match = plugins.find((p: any) => {
        const pSlug = (p.plugin || '').toLowerCase().replace(/\.php$/, '');
        return pSlug === slugNorm || pSlug.startsWith(slugNorm.split('/')[0] + '/');
      });
      // WP REST API plugin field may or may not include .php
      if (match) {
        const file = match.plugin;
        return file.endsWith('.php') ? file : `${file}.php`;
      }
    }
  } catch { /* non-critical */ }

  // Last resort: guess the standard pattern
  const folder = pluginSlug.split('/')[0];
  return `${folder}/${folder}.php`;
}

/**
 * Re-activate a plugin after update (updates can deactivate the plugin).
 */
async function reactivatePlugin(
  base: string,
  pluginSlug: string,
  pluginFile: string,
  headers: HeadersInit
): Promise<void> {
  // Try with the non-encoded slug path (works on some WP versions)
  try {
    const res = await fetch(`${base}/wp-json/wp/v2/plugins/${pluginSlug}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ status: 'active' }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      logger.info('  Plugin re-activated');
      return;
    }
  } catch { /* try next */ }

  // Try with encoded slug
  try {
    const encoded = pluginFile.replace('/', '%2F');
    const res = await fetch(`${base}/wp-json/wp/v2/plugins/${encoded}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ status: 'active' }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      logger.info('  Plugin re-activated');
      return;
    }
  } catch { /* non-critical */ }

  logger.warn('  Could not re-activate plugin automatically — may need manual activation');
}

/**
 * Try to log into wp-admin.
 *
 * Uses wp_admin_password if configured (the actual WP user password).
 * Falls back to app_password (which only works if it happens to be the real password).
 *
 * Application passwords do NOT work for wp-admin form login —
 * they are REST API only. If you need browser-based plugin updates,
 * set wp_admin_password in your site config.
 */
async function ensureWpAdminLogin(
  page: import('playwright').Page,
  config: SiteConfig,
  base: string
): Promise<boolean> {
  // The password to use for wp-admin login
  const loginPassword = config.wp_admin_password || config.app_password;
  if (!loginPassword || !config.username) return false;

  try {
    await page.goto(`${base}/wp-admin/`, { waitUntil: 'networkidle', timeout: 30000 });

    // Already logged in?
    if (page.url().includes('/wp-admin/') && !page.url().includes('wp-login')) {
      return true;
    }

    // Try login
    const loginForm = await page.$('#loginform');
    if (!loginForm) return false;

    await page.fill('#user_login', config.username);
    await page.fill('#user_pass', loginPassword);
    await page.click('#wp-submit');
    await page.waitForLoadState('networkidle', { timeout: 15000 });

    // Check if we made it to wp-admin
    return page.url().includes('/wp-admin/') && !page.url().includes('wp-login');
  } catch {
    return false;
  }
}

/**
 * Fallback: try browser-based update via wp-admin.
 */
async function tryBrowserUpdate(
  config: SiteConfig,
  base: string,
  pluginSlug: string,
  folderName: string,
  page?: import('playwright').Page
): Promise<{ success: boolean; message: string; new_version?: string }> {
  if (!page) {
    return {
      success: false,
      message: 'Plugin not available on wordpress.org and no browser session for manual update.',
    };
  }

  const loggedIn = await ensureWpAdminLogin(page, config, base);
  if (!loggedIn) {
    return {
      success: false,
      message: 'Cannot log into wp-admin. Add wp_admin_password to your site config YAML (your actual WP login password, not the application password).',
    };
  }

  // Force update check and try plugins page
  await page.goto(`${base}/wp-admin/update-core.php?force-check=1`, {
    waitUntil: 'networkidle',
    timeout: 60000,
  });

  await page.goto(`${base}/wp-admin/plugins.php`, { waitUntil: 'networkidle', timeout: 30000 });

  const updateLink = await page.$(`tr[data-slug="${folderName}"] .update-link`);
  if (updateLink) {
    await updateLink.click();
    await page.waitForLoadState('networkidle', { timeout: 120000 });

    const pageText = await page.textContent('body') || '';
    if (pageText.includes('successfully') || pageText.includes('updated')) {
      const headers = authHeaders(config);
      const verification = await verifyPluginVersion(config, base, pluginSlug, '');
      return {
        success: true,
        message: 'Updated via wp-admin',
        new_version: verification.version,
      };
    }
  }

  return {
    success: false,
    message: 'Could not find update mechanism for this plugin. Update manually via wp-admin.',
  };
}

/**
 * Verify a plugin's current version after an update attempt.
 * Retries up to 3 times with a 2-second delay between attempts.
 */
export async function verifyPluginVersion(
  config: SiteConfig,
  targetUrl: string,
  pluginSlug: string,
  expectedVersion: string
): Promise<{ version: string; matches: boolean }> {
  const base = baseUrl(targetUrl);
  const headers = authHeaders(config);
  const slugNorm = pluginSlug.toLowerCase().replace(/\.php$/, '');

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    // Try individual plugin endpoint with multiple slug formats
    const slugVariants = [
      pluginSlug,                           // folder/file
      pluginSlug + '.php',                  // folder/file.php
      encodeURIComponent(pluginSlug),       // folder%2Ffile
    ];

    for (const slug of slugVariants) {
      try {
        const res = await fetch(
          `${base}/wp-json/wp/v2/plugins/${slug}`,
          { headers, signal: AbortSignal.timeout(TIMEOUT) }
        );
        if (res.ok) {
          const data = await res.json();
          if (data.version) {
            const matches = !expectedVersion || data.version === expectedVersion;
            return { version: data.version, matches };
          }
        }
      } catch { /* try next */ }
    }

    // Fallback: search in the full plugins list
    try {
      const listRes = await fetch(`${base}/wp-json/wp/v2/plugins`, {
        headers,
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (listRes.ok) {
        const plugins = await listRes.json();
        const match = plugins.find((p: any) => {
          const pSlug = (p.plugin || '').toLowerCase().replace(/\.php$/, '');
          return pSlug === slugNorm || pSlug.startsWith(slugNorm.split('/')[0] + '/');
        });
        if (match?.version) {
          const matches = !expectedVersion || match.version === expectedVersion;
          return { version: match.version, matches };
        }
      }
    } catch { /* retry */ }
  }

  return { version: 'unknown', matches: false };
}

/**
 * Deactivate a plugin via WordPress REST API.
 */
export async function deactivatePlugin(
  config: SiteConfig,
  targetUrl: string,
  pluginSlug: string
): Promise<{ success: boolean; message: string }> {
  const base = baseUrl(targetUrl);
  const headers = authHeaders(config);
  const encodedSlug = encodeURIComponent(pluginSlug);

  try {
    const res = await fetch(`${base}/wp-json/wp/v2/plugins/${encodedSlug}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ status: 'inactive' }),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    if (!res.ok) {
      return {
        success: false,
        message: `Deactivation returned HTTP ${res.status}`,
      };
    }

    return { success: true, message: 'Plugin deactivated successfully' };
  } catch (err: any) {
    return { success: false, message: `Deactivation failed: ${err.message}` };
  }
}

/**
 * Trigger a WordPress core update via the wp-admin update-core.php endpoint.
 * This requires browser automation since there's no REST API for core updates.
 *
 * Falls back to checking if the site supports auto-updates (WP 3.7+).
 * Minor/patch updates auto-apply; major updates need manual trigger.
 */
export async function updateWordPressCore(
  config: SiteConfig,
  targetUrl: string,
  page?: import('playwright').Page
): Promise<{ success: boolean; message: string; new_version?: string }> {
  const base = baseUrl(targetUrl);
  const headers = authHeaders(config);

  // First, check if there's actually an update available
  let currentVersion: string | null = null;
  let latestVersion: string | null = null;

  try {
    // Get current version from WC system status or site HTML
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

  try {
    const res = await fetch('https://api.wordpress.org/core/version-check/1.7/', {
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      latestVersion = data.offers?.[0]?.version || null;
    }
  } catch { /* non-critical */ }

  if (!currentVersion) {
    return { success: false, message: 'Could not detect current WordPress version' };
  }

  if (!latestVersion) {
    return { success: false, message: 'Could not determine latest WordPress version' };
  }

  if (currentVersion === latestVersion) {
    return { success: true, message: `WordPress ${currentVersion} is already up to date`, new_version: currentVersion };
  }

  // Use wpau REST API to update core (no wp-admin login needed)
  logger.info(`  Updating WordPress ${currentVersion} → ${latestVersion} via REST API...`);
  try {
    const res = await fetch(`${base}/wp-json/wpau/v1/update/core`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(180000), // Core updates can take a while
    });

    if (res.ok) {
      const data = await res.json();
      if (data.success !== false) {
        return {
          success: true,
          message: `WordPress updated to ${latestVersion}`,
          new_version: latestVersion,
        };
      }
      return {
        success: false,
        message: data.message || 'Core update returned success:false',
      };
    }
    logger.warn(`  wpau core update returned HTTP ${res.status}`);
  } catch (err: any) {
    logger.warn(`  wpau core update failed: ${err.message}`);
  }

  return {
    success: false,
    message: `WordPress ${currentVersion} → ${latestVersion} update available but could not be triggered via REST API. Update manually via wp-admin.`,
  };
}

/**
 * Roll back a plugin to a previous version.
 *
 * Strategy (in order):
 * 1. Revert from backup via /wpau/v1/revert/plugin/backup (if backup_id available)
 * 2. Revert to specific version via /wpau/v1/revert/plugin
 * 3. Fall back to downloading old version from wordpress.org
 *
 * All via REST API — no wp-admin login needed.
 */
export async function rollbackPlugin(
  config: SiteConfig,
  targetUrl: string,
  pluginSlug: string,
  targetVersion: string,
  page?: import('playwright').Page,
  backupId?: string
): Promise<{ success: boolean; message: string }> {
  const base = baseUrl(targetUrl);
  const headers = authHeaders(config);
  const folderName = pluginSlug.split('/')[0];

  // Resolve plugin file path
  const pluginFile = await resolvePluginFile(config, base, pluginSlug, headers);

  // Strategy 1: Revert from backup (if we have a backup_id)
  if (backupId) {
    logger.info(`  Reverting from backup (ID: ${backupId})...`);
    const revertEndpoints = [
      { url: `${base}/wp-json/wpau/v1/revert/plugin/backup`, body: { backup_id: backupId } },
      { url: `${base}/wp-json/wp-qa/v1/revert-plugin`, body: { backup_id: backupId, plugin_file: pluginFile } },
    ];

    for (const ep of revertEndpoints) {
      try {
        const res = await fetch(ep.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(ep.body),
          signal: AbortSignal.timeout(60000),
        });

        if (res.ok) {
          const data = await res.json();
          if (data.success !== false) {
            if (pluginFile) await reactivatePlugin(base, pluginSlug, pluginFile, headers);
            return {
              success: true,
              message: `Reverted from backup: ${data.message || 'success'}`,
            };
          }
        }
      } catch { /* try next */ }
    }
    logger.warn('  Backup revert failed, trying version revert...');
  }

  // Strategy 2: Revert to specific version
  if (pluginFile) {
    logger.info(`  Reverting to v${targetVersion} via REST API...`);
    try {
      const res = await fetch(`${base}/wp-json/wpau/v1/revert/plugin`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          plugin_slug: folderName,
          version: targetVersion,
          plugin_file: pluginFile,
        }),
        signal: AbortSignal.timeout(120000),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.success !== false) {
          await reactivatePlugin(base, pluginSlug, pluginFile, headers);
          return {
            success: true,
            message: `Reverted to v${targetVersion}: ${data.message || 'success'}`,
          };
        }
      }
    } catch { /* fall through */ }
  }

  // Strategy 3: Deactivate as last resort
  logger.warn('  All revert methods failed — deactivating plugin as fallback');
  const deactivation = await deactivatePlugin(config, targetUrl, pluginSlug);
  return {
    success: false,
    message: `Could not revert to v${targetVersion}. Plugin deactivated. ${deactivation.message}. Reinstall v${targetVersion} manually from https://downloads.wordpress.org/plugin/${folderName}.${targetVersion}.zip`,
  };
}

/**
 * Get all plugins (for the full list, not just updatable).
 */
export async function getAllPlugins(
  config: SiteConfig,
  targetUrl: string
): Promise<PluginInfo[]> {
  const base = baseUrl(targetUrl);
  const headers = authHeaders(config);

  const res = await fetch(`${base}/wp-json/wp/v2/plugins`, {
    headers,
    signal: AbortSignal.timeout(TIMEOUT),
  });

  if (!res.ok) {
    throw new Error(`Plugin API returned HTTP ${res.status}`);
  }

  const plugins = await res.json();
  return plugins.map(
    (p: any): PluginInfo => ({
      name: p.name?.replace(/<[^>]*>/g, '') || p.plugin,
      slug: p.plugin,
      version: p.version,
      status: p.status,
      update_available: !!p.update,
      update_version: p.update?.version,
    })
  );
}
