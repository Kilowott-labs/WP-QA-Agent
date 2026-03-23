import {
  SiteConfig,
  WPCoreHealthResult,
  WPCoreHealthFinding,
  WordPressHealthResult,
} from '../../types.js';
import { baseUrl, getAuthHeader, logger } from '../../utils.js';

// Known insecure WordPress versions (major security releases)
const INSECURE_WP_VERSIONS = [
  '6.0', '6.0.1', '6.0.2',
  '5.9', '5.9.1', '5.9.2',
  '5.8', '5.8.1', '5.8.2', '5.8.3',
  '5.7', '5.7.1',
  '5.6', '5.6.1',
  '5.5', '5.5.1', '5.5.2', '5.5.3',
  '5.4', '5.4.1', '5.4.2',
  '5.3', '5.3.1', '5.3.2',
  '5.2', '5.2.1', '5.2.2', '5.2.3', '5.2.4',
  '5.1', '5.1.1',
  '5.0', '5.0.1', '5.0.2', '5.0.3',
  '4.9', '4.9.1', '4.9.2', '4.9.3', '4.9.4', '4.9.5',
];

// PHP versions that are EOL
const PHP_EOL_VERSIONS = ['5.6', '7.0', '7.1', '7.2', '7.3', '7.4', '8.0'];

/**
 * WordPress core health checks: version security, debug mode,
 * PHP version, WP-Cron, object cache, memory, SSL.
 */
export async function checkWPCoreHealth(
  config: SiteConfig,
  wpHealth: WordPressHealthResult
): Promise<WPCoreHealthResult> {
  const base = baseUrl(config.url);
  const hasAuth = !!(config.username && config.app_password);
  const timeout = 15000;
  const findings: WPCoreHealthFinding[] = [];

  const result: WPCoreHealthResult = {
    wp_version: wpHealth.wp_version,
    wp_version_status: 'unknown',
    debug_mode: 'unknown',
    error_display: 'unknown',
    wp_cron_status: 'unknown',
    object_cache: 'unknown',
    multisite: false,
    ssl_certificate: { valid: false },
    https_redirect: false,
    findings: [],
  };

  // ── 1. WordPress version security ───────────────────────────────────
  if (wpHealth.wp_version && wpHealth.wp_version !== 'Unknown') {
    const ver = wpHealth.wp_version;
    if (INSECURE_WP_VERSIONS.includes(ver)) {
      result.wp_version_status = 'insecure';
      findings.push({
        severity: 'critical',
        title: `WordPress ${ver} has known security vulnerabilities`,
        detail: `Version ${ver} is no longer receiving security patches. This is a critical risk.`,
        recommendation: 'Update WordPress to the latest version immediately.',
      });
    } else {
      // Check if it's a recent version
      // We fetch the latest WP version dynamically to avoid hardcoding
      const latestWP = await fetchLatestWPVersion();
      const major = parseFloat(ver);

      if (latestWP && ver === latestWP) {
        result.wp_version_status = 'current';
        findings.push({
          severity: 'info',
          title: `WordPress ${ver} is the latest version`,
          detail: 'Version is current.',
        });
      } else if (latestWP) {
        const latestMajor = parseFloat(latestWP);
        // Within one minor release is acceptable
        if (major >= latestMajor - 0.1) {
          result.wp_version_status = 'current';
          findings.push({
            severity: 'info',
            title: `WordPress ${ver} is reasonably up to date (latest: ${latestWP})`,
            detail: 'Version appears current.',
          });
        } else if (major >= latestMajor - 1.0) {
          result.wp_version_status = 'outdated';
          findings.push({
            severity: 'major',
            title: `WordPress ${ver} is outdated (latest: ${latestWP})`,
            detail: `Version ${ver} may be missing security patches from newer releases.`,
            recommendation: `Update WordPress to ${latestWP}.`,
          });
        } else {
          result.wp_version_status = 'insecure';
          findings.push({
            severity: 'critical',
            title: `WordPress ${ver} is severely outdated (latest: ${latestWP})`,
            detail: `Version ${ver} is very old and likely contains unpatched vulnerabilities.`,
            recommendation: `Update WordPress to ${latestWP} immediately.`,
          });
        }
      } else {
        // Couldn't fetch latest — fall back to rough check
        if (major >= 6.6) {
          result.wp_version_status = 'current';
        } else if (major >= 6.0) {
          result.wp_version_status = 'outdated';
          findings.push({
            severity: 'major',
            title: `WordPress ${ver} may be outdated`,
            detail: `Version ${ver} may be missing security patches.`,
            recommendation: 'Update to the latest WordPress version.',
          });
        } else {
          result.wp_version_status = 'insecure';
          findings.push({
            severity: 'critical',
            title: `WordPress ${ver} is severely outdated`,
            detail: `Version ${ver} is very old and likely contains unpatched vulnerabilities.`,
            recommendation: 'Update WordPress to the latest version immediately.',
          });
        }
      }
    }
  }

  // ── 2. Debug mode / error display detection ─────────────────────────
  try {
    const res = await fetch(base, {
      signal: AbortSignal.timeout(timeout),
      headers: { 'User-Agent': 'wp-qa-agent/1.0' },
    });
    const html = await res.text();

    // Check for PHP notices/warnings in HTML (indicates WP_DEBUG + display_errors)
    const hasPhpErrors =
      html.includes('Notice:') ||
      html.includes('Warning:') ||
      html.includes('Fatal error:') ||
      html.includes('Deprecated:') ||
      html.includes('Parse error:');

    if (hasPhpErrors) {
      result.debug_mode = 'enabled';
      result.error_display = 'enabled';
      findings.push({
        severity: 'critical',
        title: 'PHP errors visible to visitors',
        detail: 'PHP notices, warnings, or errors are displayed in the HTML output. This exposes file paths and internal details.',
        recommendation: 'Set WP_DEBUG to false and display_errors to Off in wp-config.php for production.',
      });
    } else {
      result.error_display = 'disabled';
    }

    // Check for X-Powered-By revealing PHP version
    const poweredBy = res.headers.get('x-powered-by') || '';
    const phpMatch = poweredBy.match(/PHP\/([\d.]+)/);
    if (phpMatch) {
      result.php_version = phpMatch[1];
      findings.push({
        severity: 'minor',
        title: `PHP version exposed in headers: ${phpMatch[1]}`,
        detail: 'X-Powered-By header reveals the PHP version.',
        recommendation: 'Remove X-Powered-By header via php.ini (expose_php = Off).',
      });
    }

    // Check server header
    const server = res.headers.get('server') || '';
    if (server && (server.includes('Apache') || server.includes('nginx'))) {
      const versionMatch = server.match(/(Apache|nginx)\/([\d.]+)/);
      if (versionMatch) {
        findings.push({
          severity: 'minor',
          title: `Server version exposed: ${versionMatch[0]}`,
          detail: `Server header reveals: ${server}`,
          recommendation: 'Hide server version in server configuration.',
        });
      }
    }
  } catch { /* skip */ }

  // ── 3. WC system status (if auth available) — deep health data ──────
  // (Moved before PHP version status check so WC can provide PHP version)
  if (hasAuth && wpHealth.woocommerce_detected) {
    try {
      const authHeaders = {
        'Content-Type': 'application/json',
        Authorization: getAuthHeader(config.username!, config.app_password!),
      };
      const res = await fetch(`${base}/wp-json/wc/v3/system_status`, {
        headers: authHeaders,
        signal: AbortSignal.timeout(timeout),
      });
      if (res.ok) {
        const status = await res.json();

        // Environment data
        const env = status.environment || {};
        if (env.php_version && !result.php_version) {
          result.php_version = env.php_version;
        }
        if (env.wp_memory_limit) {
          result.memory_limit = formatBytes(env.wp_memory_limit);
        }
        if (env.max_upload_size) {
          result.max_upload_size = formatBytes(env.max_upload_size);
        }
        if (env.wp_debug !== undefined) {
          result.debug_mode = env.wp_debug ? 'enabled' : 'disabled';
          if (env.wp_debug) {
            findings.push({
              severity: 'major',
              title: 'WP_DEBUG is enabled',
              detail: 'Debug mode is on. Even if errors aren\'t displayed, debug.log may be growing.',
              recommendation: 'Set WP_DEBUG to false in production wp-config.php.',
            });
          }
        }
        if (env.wp_cron !== undefined) {
          result.wp_cron_status = env.wp_cron === false ? 'disabled' : 'enabled';
          if (env.wp_cron === false) {
            findings.push({
              severity: 'minor',
              title: 'WP-Cron is disabled',
              detail: 'DISABLE_WP_CRON is set to true. Scheduled tasks rely on an external cron job.',
              recommendation: 'Ensure a system cron is configured to hit wp-cron.php regularly.',
            });
          }
        }
        if (env.wp_multisite !== undefined) {
          result.multisite = !!env.wp_multisite;
        }

        // Object cache
        const objectCache = env.object_cache?.type || env.object_cache;
        if (typeof objectCache === 'string') {
          if (objectCache.toLowerCase().includes('redis')) {
            result.object_cache = 'redis';
          } else if (objectCache.toLowerCase().includes('memcache')) {
            result.object_cache = 'memcached';
          }
        }

        // Check memory limit adequacy
        if (env.wp_memory_limit) {
          const limitMB = env.wp_memory_limit / (1024 * 1024);
          if (limitMB < 128) {
            findings.push({
              severity: 'minor',
              title: `WordPress memory limit is low: ${limitMB}MB`,
              detail: 'Memory limit below 128MB may cause issues with large operations.',
              recommendation: 'Increase WP_MEMORY_LIMIT to at least 256M in wp-config.php.',
            });
          }
        }
      }
    } catch { /* skip */ }
  }

  // ── 4. PHP version status ───────────────────────────────────────────
  // (Runs after WC system status so PHP version from WC is available)
  if (result.php_version) {
    const majorMinor = result.php_version.split('.').slice(0, 2).join('.');
    if (PHP_EOL_VERSIONS.includes(majorMinor)) {
      result.php_version_status = 'eol';
      findings.push({
        severity: 'critical',
        title: `PHP ${result.php_version} is End of Life`,
        detail: `PHP ${majorMinor} no longer receives security updates.`,
        recommendation: 'Upgrade to PHP 8.1+ for security and performance.',
      });
    } else if (parseFloat(majorMinor) >= 8.1) {
      result.php_version_status = 'current';
    } else {
      result.php_version_status = 'outdated';
    }
  }

  // ── 5. WP-Cron check (if not already determined) ───────────────────
  if (result.wp_cron_status === 'unknown') {
    try {
      const res = await fetch(`${base}/wp-cron.php`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(timeout),
        headers: { 'User-Agent': 'wp-qa-agent/1.0' },
      });
      if (res.ok || res.status === 204) {
        result.wp_cron_status = 'enabled';
      }
    } catch { /* skip */ }
  }

  // ── 6. Object cache detection (if not already determined) ───────────
  if (result.object_cache === 'unknown' && hasAuth) {
    // Check for common object cache plugins
    const cachePlugins = wpHealth.plugins.filter(
      (p) =>
        p.slug.includes('redis') ||
        p.slug.includes('memcache') ||
        p.slug.includes('object-cache')
    );
    if (cachePlugins.length > 0) {
      const slug = cachePlugins[0].slug.toLowerCase();
      if (slug.includes('redis')) result.object_cache = 'redis';
      else if (slug.includes('memcache')) result.object_cache = 'memcached';
    } else {
      result.object_cache = 'none';
      findings.push({
        severity: 'minor',
        title: 'No object cache detected',
        detail: 'No Redis or Memcached object cache plugin found. Site relies on default file-based caching.',
        recommendation: 'Consider installing Redis or Memcached for improved performance.',
      });
    }
  }

  // ── 7. SSL certificate check ────────────────────────────────────────
  if (config.url.startsWith('https')) {
    result.ssl_certificate = await checkSSL(base);
    if (result.ssl_certificate.valid) {
      if (
        result.ssl_certificate.days_until_expiry !== undefined &&
        result.ssl_certificate.days_until_expiry < 30
      ) {
        findings.push({
          severity: 'major',
          title: `SSL certificate expires in ${result.ssl_certificate.days_until_expiry} days`,
          detail: `Certificate issued by ${result.ssl_certificate.issuer || 'unknown'} expires on ${result.ssl_certificate.expires}.`,
          recommendation: 'Renew the SSL certificate before it expires.',
        });
      }
    } else {
      findings.push({
        severity: 'critical',
        title: 'SSL certificate issue detected',
        detail: 'Could not verify SSL certificate validity.',
        recommendation: 'Check SSL certificate configuration.',
      });
    }
  }

  // ── 8. HTTP → HTTPS redirect ────────────────────────────────────────
  if (config.url.startsWith('https')) {
    try {
      const httpUrl = config.url.replace('https://', 'http://');
      const res = await fetch(httpUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeout),
        headers: { 'User-Agent': 'wp-qa-agent/1.0' },
      });
      const location = res.headers.get('location') || '';
      if (res.status === 301 && location.startsWith('https://')) {
        result.https_redirect = true;
      } else if (res.status === 302 && location.startsWith('https://')) {
        result.https_redirect = true;
        findings.push({
          severity: 'minor',
          title: 'HTTP → HTTPS redirect uses 302 instead of 301',
          detail: 'Temporary redirect (302) should be permanent (301) for SEO and security.',
          recommendation: 'Change HTTP to HTTPS redirect from 302 to 301.',
        });
      } else {
        result.https_redirect = false;
        findings.push({
          severity: 'major',
          title: 'No HTTP → HTTPS redirect',
          detail: 'HTTP version of the site does not redirect to HTTPS.',
          recommendation: 'Configure server to redirect all HTTP traffic to HTTPS with a 301.',
        });
      }
    } catch {
      // Can't reach HTTP version — may be fine (port 80 blocked)
    }
  }

  result.findings = findings;
  return result;
}

async function checkSSL(
  siteUrl: string
): Promise<WPCoreHealthResult['ssl_certificate']> {
  try {
    // Node.js fetch doesn't expose TLS details directly,
    // but we can detect basic SSL issues by attempting a request
    const res = await fetch(siteUrl, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'wp-qa-agent/1.0' },
    });
    // If fetch succeeds on HTTPS, the certificate is valid
    return { valid: true };
  } catch (err: any) {
    if (
      err.message.includes('certificate') ||
      err.message.includes('SSL') ||
      err.message.includes('TLS')
    ) {
      return { valid: false };
    }
    // Other errors (network, timeout) — SSL is probably fine
    return { valid: true };
  }
}

/**
 * Fetch the latest stable WordPress version from the WordPress.org API.
 */
async function fetchLatestWPVersion(): Promise<string | null> {
  try {
    const res = await fetch('https://api.wordpress.org/core/version-check/1.7/', {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    // data.offers[0] is the latest stable release
    return data.offers?.[0]?.version || null;
  } catch {
    return null;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
}
