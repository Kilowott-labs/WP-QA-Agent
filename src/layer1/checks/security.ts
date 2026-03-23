import {
  SiteConfig,
  SecurityResult,
  SecurityFinding,
  SecurityHeaders,
  ExposedFile,
  WordPressHealthResult,
} from '../../types.js';
import { baseUrl, logger } from '../../utils.js';

// Helper: fetch with standard timeout + user-agent
async function secureFetch(
  url: string,
  opts: RequestInit & { timeout?: number } = {}
): Promise<Response> {
  const { timeout: ms = 15000, ...rest } = opts;
  return fetch(url, {
    ...rest,
    signal: AbortSignal.timeout(ms),
    headers: { 'User-Agent': 'wp-qa-agent/1.0', ...(rest.headers as Record<string, string>) },
  });
}

/**
 * Comprehensive WordPress/WooCommerce security scan.
 *
 * Checks follow OWASP, WordPress Hardening Guide, and WooCommerce security best practices:
 *  1. Exposed sensitive files & backups
 *  2. Directory listing
 *  3. Security headers (OWASP recommended)
 *  4. WordPress version disclosure
 *  5. Mixed content
 *  6. XML-RPC attack surface
 *  7. User enumeration (REST + author archives + oEmbed)
 *  8. Cookie security flags
 *  9. Login brute-force protection
 * 10. PHP execution in uploads
 * 11. Backup file exposure (.sql, .zip, .tar.gz)
 * 12. Theme/plugin file editor accessible
 * 13. Default "admin" username
 * 14. Registration open check
 * 15. Application passwords / REST auth exposure
 * 16. CORS misconfiguration
 * 17. Cryptominer / suspicious script detection
 * 18. jQuery version (known CVEs)
 * 19. wp-cron.php DDoS surface
 * 20. WooCommerce-specific (checkout HTTPS, customer data endpoints)
 * 21. HSTS preload & max-age adequacy
 * 22. CSP evaluation
 * 23. Debug info in HTML comments
 * 24. Database error exposure
 * 25. WAF/Firewall detection
 * 26. Subresource Integrity (SRI) usage
 * 27. Server information leakage
 */
export async function runSecurityScan(
  config: SiteConfig,
  wpHealth?: WordPressHealthResult
): Promise<SecurityResult> {
  const base = baseUrl(config.url);
  const findings: SecurityFinding[] = [];
  const exposedFiles: ExposedFile[] = [];

  // ── 1. Exposed sensitive files ──────────────────────────────────────
  const sensitiveFiles = [
    { path: '/wp-config.php', risk: 'Database credentials exposed', critical: true },
    { path: '/wp-config.php.bak', risk: 'Database credentials in backup', critical: true },
    { path: '/wp-config.php.old', risk: 'Database credentials in backup', critical: true },
    { path: '/wp-config.php.save', risk: 'Database credentials in backup', critical: true },
    { path: '/wp-config.php~', risk: 'Database credentials in editor backup', critical: true },
    { path: '/wp-config.txt', risk: 'Database credentials in text copy', critical: true },
    { path: '/.env', risk: 'Environment variables exposed', critical: true },
    { path: '/.env.production', risk: 'Production env variables exposed', critical: true },
    { path: '/.env.local', risk: 'Local env variables exposed', critical: true },
    { path: '/.git/config', risk: 'Git repository exposed — may contain secrets', critical: true },
    { path: '/.git/HEAD', risk: 'Git repository exposed', critical: false },
    { path: '/.svn/entries', risk: 'SVN repository exposed', critical: true },
    { path: '/debug.log', risk: 'Debug log with error details and paths exposed', critical: false },
    { path: '/wp-content/debug.log', risk: 'Debug log with error details exposed', critical: false },
    { path: '/error_log', risk: 'Error log exposed', critical: false },
    { path: '/phpinfo.php', risk: 'Full PHP configuration exposed', critical: true },
    { path: '/info.php', risk: 'PHP info page exposed', critical: true },
    { path: '/wp-admin/install.php', risk: 'WordPress installer accessible', critical: false },
    { path: '/readme.html', risk: 'WordPress version exposed', critical: false },
    { path: '/license.txt', risk: 'WordPress version may be inferred', critical: false },
    { path: '/wp-config-sample.php', risk: 'Sample config file still accessible', critical: false },
    { path: '/wp-includes/version.php', risk: 'WordPress version file exposed', critical: false },
    { path: '/.htaccess', risk: 'Server configuration exposed', critical: false },
    { path: '/.htpasswd', risk: 'Password file exposed', critical: true },
    { path: '/wp-content/uploads/wc-logs/', risk: 'WooCommerce logs directory exposed', critical: false },
    { path: '/wp-content/uploads/wpforms/', risk: 'Form submission data exposed', critical: true },
    { path: '/wp-content/uploads/gravity_forms/', risk: 'Gravity Forms data exposed', critical: true },
    { path: '/wp-content/upgrade/', risk: 'Upgrade temp files exposed', critical: false },
    { path: '/wp-content/backup-db/', risk: 'Database backup directory exposed', critical: true },
    { path: '/wp-content/backups/', risk: 'Backup directory exposed', critical: true },
    { path: '/wp-admin/maint/repair.php', risk: 'Database repair tool accessible', critical: false },
    { path: '/wp-cli.yml', risk: 'WP-CLI config exposed', critical: false },
    { path: '/composer.json', risk: 'PHP dependencies exposed', critical: false },
    { path: '/composer.lock', risk: 'Exact dependency versions exposed', critical: false },
    { path: '/package.json', risk: 'Node.js dependencies exposed', critical: false },
  ];

  await runExposedFileChecks(base, sensitiveFiles, findings, exposedFiles);

  // ── 2. Backup file exposure ─────────────────────────────────────────
  const backupFiles = [
    { path: '/backup.sql', risk: 'Database dump exposed' },
    { path: '/db.sql', risk: 'Database dump exposed' },
    { path: '/database.sql', risk: 'Database dump exposed' },
    { path: '/dump.sql', risk: 'Database dump exposed' },
    { path: '/backup.zip', risk: 'Full site backup exposed' },
    { path: '/backup.tar.gz', risk: 'Full site backup exposed' },
    { path: '/site.zip', risk: 'Full site backup exposed' },
    { path: '/wp-content/backup.zip', risk: 'Content backup exposed' },
  ];

  for (const file of backupFiles) {
    try {
      const res = await secureFetch(`${base}${file.path}`, { method: 'HEAD', redirect: 'manual' });
      if (res.status === 200) {
        const contentType = res.headers.get('content-type') || '';
        // Verify it's not a custom 404 page
        if (!contentType.includes('text/html')) {
          exposedFiles.push({ path: file.path, status: res.status, risk: file.risk });
          findings.push({
            id: `backup-exposed-${file.path.replace(/[^a-z0-9]/g, '-')}`,
            severity: 'critical',
            title: `Backup file exposed: ${file.path}`,
            detail: `${base}${file.path} is accessible. ${file.risk}. This could leak the entire database or site contents.`,
            recommendation: `Remove ${file.path} from the web root immediately and block access via server config.`,
          });
        }
      }
    } catch { /* skip */ }
  }

  // ── 3. Directory listing ────────────────────────────────────────────
  const directories = [
    '/wp-content/uploads/',
    '/wp-content/plugins/',
    '/wp-content/themes/',
    '/wp-includes/',
    '/wp-content/uploads/woocommerce_uploads/',
    '/wp-content/cache/',
  ];

  for (const dir of directories) {
    try {
      const res = await secureFetch(`${base}${dir}`);
      if (res.ok) {
        const text = await res.text();
        if (text.includes('Index of') || text.includes('Directory listing') || text.includes('<title>Index of')) {
          findings.push({
            id: `dir-listing-${dir.replace(/[^a-z0-9]/g, '-')}`,
            severity: 'medium',
            title: `Directory listing enabled: ${dir}`,
            detail: `${base}${dir} exposes file listing. Attackers can enumerate files and discover sensitive data.`,
            recommendation: 'Add "Options -Indexes" to .htaccess or configure server to disable directory browsing.',
          });
        }
      }
    } catch { /* skip */ }
  }

  // ── 4. Security headers ─────────────────────────────────────────────
  let headers: SecurityHeaders = {};
  let homepageHtml = '';
  try {
    const res = await secureFetch(base);
    homepageHtml = await res.text();

    headers = {
      x_frame_options: res.headers.get('x-frame-options') || undefined,
      content_security_policy: res.headers.get('content-security-policy') || undefined,
      x_content_type_options: res.headers.get('x-content-type-options') || undefined,
      strict_transport_security: res.headers.get('strict-transport-security') || undefined,
      x_xss_protection: res.headers.get('x-xss-protection') || undefined,
      referrer_policy: res.headers.get('referrer-policy') || undefined,
      permissions_policy: res.headers.get('permissions-policy') || undefined,
    };

    checkSecurityHeaders(headers, base, findings);

    // HSTS quality check
    if (headers.strict_transport_security && base.startsWith('https')) {
      checkHSTSQuality(headers.strict_transport_security, findings);
    }

    // CSP quality check
    if (headers.content_security_policy) {
      checkCSPQuality(headers.content_security_policy, findings);
    }

    // CORS check
    const corsHeader = res.headers.get('access-control-allow-origin');
    if (corsHeader === '*') {
      findings.push({
        id: 'cors-wildcard',
        severity: 'medium',
        title: 'CORS allows all origins (Access-Control-Allow-Origin: *)',
        detail: 'Any website can make cross-origin requests to this site. This may expose user data or enable CSRF-like attacks.',
        recommendation: 'Restrict Access-Control-Allow-Origin to specific trusted domains.',
      });
    }

    // Server info leakage
    const server = res.headers.get('server') || '';
    const poweredBy = res.headers.get('x-powered-by') || '';
    if (poweredBy) {
      findings.push({
        id: 'x-powered-by-exposed',
        severity: 'low',
        title: `X-Powered-By header exposes technology: ${poweredBy}`,
        detail: 'Server technology information is visible in response headers.',
        recommendation: 'Remove X-Powered-By header. In PHP: expose_php = Off in php.ini.',
      });
    }
    if (server.match(/(Apache|nginx|LiteSpeed|IIS)\/([\d.]+)/)) {
      findings.push({
        id: 'server-version-exposed',
        severity: 'low',
        title: `Server software version exposed: ${server}`,
        detail: 'Specific server version helps attackers target known vulnerabilities.',
        recommendation: 'Configure server to hide version (ServerTokens Prod for Apache, server_tokens off for nginx).',
      });
    }

    // ── 5. WordPress version detection in HTML ──────────────────────
    checkVersionExposure(homepageHtml, findings);

    // ── 6. Mixed content detection ──────────────────────────────────
    if (base.startsWith('https')) {
      checkMixedContent(homepageHtml, findings);
    }

    // ── Debug info in HTML comments ─────────────────────────────────
    checkDebugInHTML(homepageHtml, findings);

    // ── Database error exposure ─────────────────────────────────────
    checkDatabaseErrors(homepageHtml, findings);

    // ── Cryptominer / suspicious scripts ────────────────────────────
    checkSuspiciousScripts(homepageHtml, findings);

    // ── jQuery version check ────────────────────────────────────────
    checkjQueryVersion(homepageHtml, base, findings);

    // ── Subresource Integrity ───────────────────────────────────────
    checkSRI(homepageHtml, findings);

  } catch (err: any) {
    logger.warn(`Security header check failed: ${err.message}`);
  }

  // ── 7. XML-RPC ──────────────────────────────────────────────────────
  await checkXMLRPC(base, findings, exposedFiles);

  // ── 8. User enumeration ─────────────────────────────────────────────
  await checkUserEnumeration(base, findings, exposedFiles);

  // ── 9. Cookie security flags ────────────────────────────────────────
  await checkCookieSecurity(base, findings);

  // ── 10. Login page security ─────────────────────────────────────────
  await checkLoginSecurity(base, findings);

  // ── 11. PHP execution in uploads ────────────────────────────────────
  await checkPHPInUploads(base, findings);

  // ── 12. Theme/plugin file editor ────────────────────────────────────
  await checkFileEditor(base, findings);

  // ── 13. Default admin username ──────────────────────────────────────
  await checkDefaultAdmin(base, findings);

  // ── 14. Registration open ───────────────────────────────────────────
  await checkRegistration(base, findings);

  // ── 15. REST API exposure ───────────────────────────────────────────
  await checkRESTAPIExposure(base, findings);

  // ── 16. wp-cron.php ─────────────────────────────────────────────────
  await checkWPCron(base, findings);

  // ── 17. WooCommerce-specific security ───────────────────────────────
  if (wpHealth?.woocommerce_detected) {
    await checkWooCommerceSecurity(base, config, findings);
  }

  // ── 18. WAF/Firewall detection ──────────────────────────────────────
  checkWAFDetection(homepageHtml, wpHealth, findings);

  // ── 19. Review-standard: dated backup files (architecture.md) ──────
  await checkDatedBackupFiles(base, findings, exposedFiles);

  // ── 20. Review-standard: REST endpoint permission probing (rest-api.md)
  await checkRESTPermissions(base, findings);

  // ── Compute summary ─────────────────────────────────────────────────
  const summary = {
    critical: findings.filter((f) => f.severity === 'critical').length,
    high: findings.filter((f) => f.severity === 'high').length,
    medium: findings.filter((f) => f.severity === 'medium').length,
    low: findings.filter((f) => f.severity === 'low').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };

  const overall_risk: SecurityResult['overall_risk'] =
    summary.critical > 0
      ? 'critical'
      : summary.high > 0
        ? 'high'
        : summary.medium > 2
          ? 'medium'
          : 'low';

  return { overall_risk, findings, headers, exposed_files: exposedFiles, summary };
}

// ── Sub-checks ─────────────────────────────────────────────────────────────

async function runExposedFileChecks(
  base: string,
  files: { path: string; risk: string; critical: boolean }[],
  findings: SecurityFinding[],
  exposedFiles: ExposedFile[]
) {
  // Skip XML-RPC and users endpoint — handled separately
  const skip = new Set(['/xmlrpc.php', '/wp-json/wp/v2/users']);

  for (const file of files) {
    if (skip.has(file.path)) continue;
    try {
      const res = await secureFetch(`${base}${file.path}`, { method: 'GET', redirect: 'manual' });
      if (res.status === 200) {
        exposedFiles.push({ path: file.path, status: res.status, risk: file.risk });
        findings.push({
          id: `exposed-${file.path.replace(/[^a-z0-9]/g, '-')}`,
          severity: file.critical ? 'critical' : 'low',
          title: `Exposed file: ${file.path}`,
          detail: `${base}${file.path} returned HTTP 200. ${file.risk}.`,
          recommendation: `Block access to ${file.path} via server configuration.`,
        });
      }
    } catch { /* skip */ }
  }
}

function checkSecurityHeaders(
  headers: SecurityHeaders,
  base: string,
  findings: SecurityFinding[]
) {
  if (!headers.x_frame_options && !headers.content_security_policy) {
    findings.push({
      id: 'missing-x-frame-options',
      severity: 'medium',
      title: 'Missing X-Frame-Options / CSP frame-ancestors',
      detail: 'Site can be embedded in iframes on other domains, enabling clickjacking attacks.',
      recommendation: "Add X-Frame-Options: SAMEORIGIN or Content-Security-Policy: frame-ancestors 'self'.",
    });
  }

  if (!headers.content_security_policy) {
    findings.push({
      id: 'missing-csp',
      severity: 'medium',
      title: 'No Content-Security-Policy header',
      detail: 'Without CSP, the site is more vulnerable to XSS and data injection attacks.',
      recommendation: 'Implement a Content-Security-Policy header. Start with report-only mode.',
    });
  }

  if (!headers.x_content_type_options) {
    findings.push({
      id: 'missing-x-content-type-options',
      severity: 'low',
      title: 'Missing X-Content-Type-Options header',
      detail: 'Browser may MIME-sniff responses, potentially executing malicious content.',
      recommendation: 'Add X-Content-Type-Options: nosniff.',
    });
  }

  if (!headers.strict_transport_security && base.startsWith('https')) {
    findings.push({
      id: 'missing-hsts',
      severity: 'medium',
      title: 'Missing Strict-Transport-Security (HSTS) header',
      detail: 'Without HSTS, users can be downgraded to HTTP via MITM attacks.',
      recommendation: 'Add Strict-Transport-Security: max-age=31536000; includeSubDomains.',
    });
  }

  if (!headers.referrer_policy) {
    findings.push({
      id: 'missing-referrer-policy',
      severity: 'low',
      title: 'Missing Referrer-Policy header',
      detail: 'Without Referrer-Policy, the full URL (including query params) may leak to third parties.',
      recommendation: 'Add Referrer-Policy: strict-origin-when-cross-origin.',
    });
  }

  if (!headers.permissions_policy) {
    findings.push({
      id: 'missing-permissions-policy',
      severity: 'low',
      title: 'Missing Permissions-Policy header',
      detail: 'Without Permissions-Policy, embedded content can access sensitive APIs (camera, mic, geolocation).',
      recommendation: 'Add Permissions-Policy header to restrict API access.',
    });
  }
}

function checkHSTSQuality(hsts: string, findings: SecurityFinding[]) {
  const maxAgeMatch = hsts.match(/max-age=(\d+)/);
  if (maxAgeMatch) {
    const maxAge = parseInt(maxAgeMatch[1], 10);
    if (maxAge < 15768000) { // Less than 6 months
      findings.push({
        id: 'hsts-short-max-age',
        severity: 'low',
        title: `HSTS max-age is short (${maxAge}s = ${Math.round(maxAge / 86400)} days)`,
        detail: 'HSTS max-age should be at least 1 year (31536000 seconds) for effective protection.',
        recommendation: 'Increase HSTS max-age to 31536000 (1 year) or more.',
      });
    }
  }
  if (!hsts.includes('includeSubDomains')) {
    findings.push({
      id: 'hsts-no-subdomains',
      severity: 'info',
      title: 'HSTS does not include subdomains',
      detail: 'Subdomains are not covered by the HSTS policy and can be MITM attacked.',
      recommendation: 'Add includeSubDomains to HSTS header if all subdomains support HTTPS.',
    });
  }
}

function checkCSPQuality(csp: string, findings: SecurityFinding[]) {
  if (csp.includes("'unsafe-inline'") && !csp.includes('nonce-') && !csp.includes('sha256-')) {
    findings.push({
      id: 'csp-unsafe-inline',
      severity: 'low',
      title: "CSP allows 'unsafe-inline' without nonce/hash",
      detail: "unsafe-inline in script-src weakens XSS protection significantly. Use nonces or hashes instead.",
      recommendation: "Replace 'unsafe-inline' with nonce-based or hash-based CSP for script-src.",
    });
  }
  if (csp.includes("'unsafe-eval'")) {
    findings.push({
      id: 'csp-unsafe-eval',
      severity: 'low',
      title: "CSP allows 'unsafe-eval'",
      detail: "unsafe-eval permits eval(), Function(), and similar dynamic code execution, weakening XSS protection.",
      recommendation: "Remove 'unsafe-eval' from CSP if possible. Some WP plugins may require it.",
    });
  }
}

function checkVersionExposure(html: string, findings: SecurityFinding[]) {
  const wpVersionMeta = html.match(
    /<meta\s+name=["']generator["']\s+content=["']WordPress\s+([\d.]+)["']/i
  );
  if (wpVersionMeta) {
    findings.push({
      id: 'wp-version-exposed-meta',
      severity: 'low',
      title: `WordPress version exposed in meta tag: ${wpVersionMeta[1]}`,
      detail: 'The WordPress version is visible in the HTML source via the generator meta tag.',
      recommendation: "Remove the generator meta tag via: remove_action('wp_head', 'wp_generator').",
    });
  }

  // WooCommerce generator meta
  const wcVersionMeta = html.match(
    /<meta\s+name=["']generator["']\s+content=["']WooCommerce\s+([\d.]+)["']/i
  );
  if (wcVersionMeta) {
    findings.push({
      id: 'wc-version-exposed-meta',
      severity: 'low',
      title: `WooCommerce version exposed in meta tag: ${wcVersionMeta[1]}`,
      detail: 'The WooCommerce version is visible in the HTML source.',
      recommendation: "Remove via: remove_action('wp_head', 'wc_generator_tag').",
    });
  }

  // Yoast / plugin generator tags
  const yoastMeta = html.match(/<!-- This site is optimized with the Yoast SEO (?:Premium )?plugin v([\d.]+)/);
  if (yoastMeta) {
    findings.push({
      id: 'yoast-version-exposed',
      severity: 'info',
      title: `Yoast SEO version exposed in HTML comment: ${yoastMeta[1]}`,
      detail: 'Plugin version visible in HTML comments.',
      recommendation: 'Disable the Yoast comment via filter: add_filter("wpseo_debug_markers", "__return_false").',
    });
  }

  // Asset version strings
  const versionParams = html.match(/\?ver=(\d+\.\d+[\d.]*)/g);
  if (versionParams && versionParams.length > 5) {
    findings.push({
      id: 'version-strings-in-urls',
      severity: 'info',
      title: 'Version strings in asset URLs',
      detail: `${versionParams.length} assets expose version numbers via ?ver= parameter.`,
      recommendation: 'Remove version query strings from static assets.',
    });
  }
}

function checkMixedContent(html: string, findings: SecurityFinding[]) {
  const httpResources = html.match(/(?:src|href|action)=["']http:\/\/[^"']+["']/gi);
  if (httpResources && httpResources.length > 0) {
    findings.push({
      id: 'mixed-content',
      severity: 'medium',
      title: `Mixed content: ${httpResources.length} HTTP resource(s) on HTTPS page`,
      detail: `Insecure resources found: ${httpResources.slice(0, 3).join(', ')}`,
      recommendation: 'Update all resource URLs to HTTPS or use protocol-relative URLs.',
    });
  }
}

function checkDebugInHTML(html: string, findings: SecurityFinding[]) {
  // PHP errors visible
  if (/\b(Fatal error|Parse error):\s/.test(html)) {
    findings.push({
      id: 'php-fatal-visible',
      severity: 'critical',
      title: 'PHP fatal/parse errors visible in HTML output',
      detail: 'PHP errors are displayed to visitors, exposing file paths and internal details.',
      recommendation: 'Set display_errors = Off in php.ini and WP_DEBUG_DISPLAY = false in wp-config.php.',
    });
  } else if (/\b(Warning|Notice|Deprecated):\s/.test(html) && /\.php\s+on\s+line\s+\d+/.test(html)) {
    findings.push({
      id: 'php-warnings-visible',
      severity: 'high',
      title: 'PHP warnings/notices visible in HTML output',
      detail: 'PHP warnings expose file paths and internal code structure to visitors.',
      recommendation: 'Set display_errors = Off and WP_DEBUG_DISPLAY = false in production.',
    });
  }

  // Debug HTML comments
  const debugComments = html.match(/<!--\s*(debug|sql query|query time|page generated|memory usage)/gi);
  if (debugComments && debugComments.length > 0) {
    findings.push({
      id: 'debug-html-comments',
      severity: 'low',
      title: 'Debug information in HTML comments',
      detail: `Found ${debugComments.length} debug comment(s) in HTML source (SQL queries, timing, memory usage).`,
      recommendation: 'Remove debug comments from production output.',
    });
  }
}

function checkDatabaseErrors(html: string, findings: SecurityFinding[]) {
  const dbErrors = html.match(/WordPress database error|Error establishing a database connection|MySQL server has gone away/i);
  if (dbErrors) {
    findings.push({
      id: 'database-error-visible',
      severity: 'high',
      title: 'Database error message visible to visitors',
      detail: 'Database error messages are exposed, which may reveal table names or query structure.',
      recommendation: 'Configure WordPress to handle database errors gracefully. Check db-error.php.',
    });
  }
}

function checkSuspiciousScripts(html: string, findings: SecurityFinding[]) {
  // Cryptominer scripts
  const miners = ['coinhive.com', 'coin-hive.com', 'cryptoloot.pro', 'coinimp.com', 'jsecoin.com',
    'cryptonight.wasm', 'CoinHive.Anonymous', 'minero.cc', 'webmine.pro'];
  for (const miner of miners) {
    if (html.includes(miner)) {
      findings.push({
        id: 'cryptominer-detected',
        severity: 'critical',
        title: `Cryptominer script detected: ${miner}`,
        detail: 'A cryptocurrency mining script is present on the page. This may indicate a compromise.',
        recommendation: 'Remove the mining script immediately and investigate for broader compromise.',
      });
      break;
    }
  }

  // Suspicious redirects / injected scripts
  const suspiciousPatterns = [
    { pattern: /eval\s*\(\s*atob\s*\(/, id: 'eval-atob', title: 'Suspicious eval(atob()) pattern', detail: 'Base64-encoded JavaScript execution detected — common malware technique.' },
    { pattern: /document\.write\s*\(\s*unescape\s*\(/, id: 'document-write-unescape', title: 'Suspicious document.write(unescape()) pattern', detail: 'Obfuscated script injection detected.' },
    { pattern: /\bwindow\.location\s*=\s*["'][^"']*(?:bit\.ly|tinyurl|goo\.gl)/i, id: 'redirect-shortener', title: 'Suspicious redirect to URL shortener', detail: 'Page redirects to a URL shortener, which may indicate malicious injection.' },
  ];
  for (const { pattern, id, title, detail } of suspiciousPatterns) {
    if (pattern.test(html)) {
      findings.push({
        id: `suspicious-${id}`,
        severity: 'high',
        title,
        detail,
        recommendation: 'Investigate the script source. This may indicate a site compromise.',
      });
    }
  }
}

function checkjQueryVersion(html: string, base: string, findings: SecurityFinding[]) {
  // Check for jQuery version in script URLs
  const jqueryMatch = html.match(/jquery(?:\.min)?\.js\?ver=([\d.]+)/);
  if (jqueryMatch) {
    const ver = jqueryMatch[1];
    const major = parseInt(ver.split('.')[0], 10);
    const minor = parseInt(ver.split('.')[1] || '0', 10);
    // jQuery < 3.5.0 has known XSS vulnerabilities (CVE-2020-11022, CVE-2020-11023)
    if (major < 3 || (major === 3 && minor < 5)) {
      findings.push({
        id: 'jquery-vulnerable-version',
        severity: 'medium',
        title: `jQuery ${ver} has known XSS vulnerabilities`,
        detail: `jQuery versions below 3.5.0 are vulnerable to XSS (CVE-2020-11022, CVE-2020-11023).`,
        recommendation: 'Update WordPress (jQuery is bundled) or use wp_dequeue_script to load a patched version.',
      });
    }
  }
}

function checkSRI(html: string, findings: SecurityFinding[]) {
  // Check if third-party scripts use SRI
  const thirdPartyScripts = html.match(/<script[^>]*src=["']https?:\/\/(?!(?:www\.)?[^/"']*(?:wordpress\.org|w\.org))[^"']+["'][^>]*>/gi) || [];
  const withIntegrity = thirdPartyScripts.filter(s => s.includes('integrity='));
  if (thirdPartyScripts.length > 3 && withIntegrity.length === 0) {
    findings.push({
      id: 'no-sri-on-third-party',
      severity: 'low',
      title: `${thirdPartyScripts.length} third-party scripts without Subresource Integrity`,
      detail: 'Third-party scripts are loaded without SRI hashes, making the site vulnerable to CDN/third-party compromise.',
      recommendation: 'Add integrity="sha384-..." and crossorigin="anonymous" to third-party script tags.',
    });
  }
}

async function checkXMLRPC(
  base: string, findings: SecurityFinding[], exposedFiles: ExposedFile[]
) {
  try {
    const res = await secureFetch(`${base}/xmlrpc.php`, { method: 'GET', redirect: 'manual' });
    if (res.status === 200 || res.status === 405) {
      exposedFiles.push({ path: '/xmlrpc.php', status: res.status, risk: 'XML-RPC endpoint accessible' });

      // Try to detect if system.multicall is available (amplification attack)
      try {
        const postRes = await secureFetch(`${base}/xmlrpc.php`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/xml' },
          body: '<?xml version="1.0"?><methodCall><methodName>system.listMethods</methodName></methodCall>',
        });
        const text = await postRes.text();
        const hasMulticall = text.includes('system.multicall');
        const hasPingback = text.includes('pingback.ping');

        findings.push({
          id: 'xmlrpc-enabled',
          severity: hasMulticall ? 'high' : 'medium',
          title: `XML-RPC enabled${hasMulticall ? ' with system.multicall (amplification risk)' : ''}`,
          detail: `${base}/xmlrpc.php is accessible.${hasMulticall ? ' system.multicall allows brute-force amplification — one HTTP request can test hundreds of passwords.' : ''}${hasPingback ? ' pingback.ping enables DDoS relay attacks.' : ''}`,
          recommendation: 'Disable XML-RPC via plugin (Disable XML-RPC) or block in .htaccess unless Jetpack requires it.',
        });
      } catch {
        findings.push({
          id: 'xmlrpc-enabled',
          severity: 'medium',
          title: 'XML-RPC endpoint is accessible',
          detail: `${base}/xmlrpc.php returned HTTP ${res.status}. XML-RPC can be exploited for brute-force amplification and DDoS.`,
          recommendation: 'Disable XML-RPC via plugin or .htaccess if not needed.',
        });
      }
    }
  } catch { /* skip */ }
}

async function checkUserEnumeration(
  base: string, findings: SecurityFinding[], exposedFiles: ExposedFile[]
) {
  // REST API users
  try {
    const res = await secureFetch(`${base}/wp-json/wp/v2/users`, { redirect: 'manual' });
    if (res.status === 200) {
      try {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          exposedFiles.push({ path: '/wp-json/wp/v2/users', status: 200, risk: 'User enumeration via REST API' });
          const usernames = data.map((u: any) => u.slug).slice(0, 5);
          findings.push({
            id: 'user-enumeration-rest',
            severity: 'medium',
            title: 'User enumeration possible via REST API',
            detail: `Usernames exposed: ${usernames.join(', ')}. Attackers can use these for targeted brute-force.`,
            recommendation: 'Restrict /wp-json/wp/v2/users to authenticated requests only.',
          });
        }
      } catch { /* not JSON */ }
    }
  } catch { /* skip */ }

  // Author archives
  try {
    const res = await secureFetch(`${base}/?author=1`, { redirect: 'manual' });
    const location = res.headers.get('location') || '';
    if (res.status === 301 && location.includes('/author/')) {
      const username = location.match(/\/author\/([^/]+)/)?.[1];
      findings.push({
        id: 'user-enumeration-author',
        severity: 'low',
        title: 'User enumeration via author archives',
        detail: `/?author=1 redirects to /author/${username || '?'}/. Usernames are discoverable.`,
        recommendation: 'Disable author archives or use a security plugin to prevent enumeration.',
      });
    }
  } catch { /* skip */ }

  // oEmbed endpoint
  try {
    const res = await secureFetch(`${base}/wp-json/oembed/1.0/embed?url=${encodeURIComponent(base)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.author_name) {
        findings.push({
          id: 'user-enumeration-oembed',
          severity: 'info',
          title: `Author name exposed via oEmbed: "${data.author_name}"`,
          detail: 'The oEmbed endpoint reveals the author/admin username.',
          recommendation: 'Filter oEmbed responses to remove author information.',
        });
      }
    }
  } catch { /* skip */ }
}

async function checkCookieSecurity(base: string, findings: SecurityFinding[]) {
  try {
    const res = await secureFetch(`${base}/wp-login.php`, { redirect: 'manual' });
    const setCookies = res.headers.getSetCookie?.() || [];
    for (const cookie of setCookies) {
      const name = cookie.split('=')[0];
      if (!name.includes('wordpress') && !name.includes('wp-')) continue;

      const lower = cookie.toLowerCase();
      if (base.startsWith('https') && !lower.includes('secure')) {
        findings.push({
          id: `cookie-no-secure-${name}`,
          severity: 'medium',
          title: `Cookie "${name}" missing Secure flag`,
          detail: 'Authentication cookie can be transmitted over insecure HTTP connections.',
          recommendation: 'Set Secure flag on all authentication cookies.',
        });
      }
      if (!lower.includes('httponly')) {
        findings.push({
          id: `cookie-no-httponly-${name}`,
          severity: 'medium',
          title: `Cookie "${name}" missing HttpOnly flag`,
          detail: 'Cookie is accessible to JavaScript, making it vulnerable to XSS theft.',
          recommendation: 'Set HttpOnly flag on authentication cookies.',
        });
      }
      if (!lower.includes('samesite')) {
        findings.push({
          id: `cookie-no-samesite-${name}`,
          severity: 'low',
          title: `Cookie "${name}" missing SameSite attribute`,
          detail: 'Cookie may be sent with cross-site requests, enabling CSRF.',
          recommendation: 'Set SameSite=Lax or SameSite=Strict on cookies.',
        });
      }
    }
  } catch { /* skip */ }
}

async function checkLoginSecurity(base: string, findings: SecurityFinding[]) {
  try {
    const res = await secureFetch(`${base}/wp-login.php`);
    if (res.ok) {
      const html = await res.text();

      // Brute-force protection
      const protectionIndicators = [
        'recaptcha', 'hcaptcha', 'turnstile', 'limit-login', 'wps-hide-login',
        'two-factor', '2fa', 'wordfence', 'sucuri', 'ithemes-security',
        'all-in-one-wp-security', 'loginizer', 'shield-security', 'jetpack-sso',
      ];
      const hasProtection = protectionIndicators.some(p => html.toLowerCase().includes(p));

      if (!hasProtection) {
        findings.push({
          id: 'login-no-brute-force-protection',
          severity: 'medium',
          title: 'No brute-force protection detected on login page',
          detail: 'wp-login.php is accessible without CAPTCHA or rate limiting.',
          recommendation: 'Install a security plugin with login protection (Wordfence, Limit Login Attempts, etc.).',
        });
      }

      // Login page over HTTP
      if (!res.url.startsWith('https') && base.startsWith('https')) {
        findings.push({
          id: 'login-not-https',
          severity: 'high',
          title: 'Login page loaded over HTTP instead of HTTPS',
          detail: 'Login credentials are transmitted in plaintext.',
          recommendation: 'Ensure WordPress Address and Site Address use https:// in Settings > General.',
        });
      }

      // Password autocomplete
      if (!html.includes('autocomplete="off"') && !html.includes("autocomplete='off'")) {
        // This is informational — modern browsers ignore autocomplete=off for passwords anyway
        // But some security audits flag it
      }
    } else if (res.status === 404 || res.status === 403) {
      // Login page hidden — good practice
      findings.push({
        id: 'login-page-hidden',
        severity: 'info',
        title: 'Login page is hidden or relocated',
        detail: `wp-login.php returned ${res.status}. Login URL has been changed — good security practice.`,
        recommendation: 'No action needed. This is a recommended security measure.',
      });
    }
  } catch { /* skip */ }
}

async function checkPHPInUploads(base: string, findings: SecurityFinding[]) {
  // Check if PHP files can be executed in uploads directory
  // We check by looking for a known test pattern — not by uploading anything
  try {
    const res = await secureFetch(`${base}/wp-content/uploads/`, { redirect: 'manual' });
    // If we get a PHP-rendered response for a directory, PHP execution might be possible
    // A more reliable check: look for .php files in uploads directory listing
    if (res.ok) {
      const text = await res.text();
      if (text.includes('.php') && (text.includes('Index of') || text.includes('Directory listing'))) {
        findings.push({
          id: 'php-in-uploads',
          severity: 'high',
          title: 'PHP files found in uploads directory',
          detail: 'The uploads directory contains .php files and has directory listing enabled. Uploaded PHP files may be executable.',
          recommendation: 'Block PHP execution in uploads: add "php_flag engine off" in wp-content/uploads/.htaccess or use nginx location rules.',
        });
      }
    }
  } catch { /* skip */ }
}

async function checkFileEditor(base: string, findings: SecurityFinding[]) {
  // Check if theme/plugin editor is accessible (indicates DISALLOW_FILE_EDIT is not set)
  try {
    const res = await secureFetch(`${base}/wp-admin/theme-editor.php`, { redirect: 'manual' });
    // If we get a redirect to wp-login.php, the editor exists (just needs auth)
    // If we get 403, it might be blocked
    const location = res.headers.get('location') || '';
    if (res.status === 302 && location.includes('wp-login.php')) {
      // Editor exists and requires login — this means DISALLOW_FILE_EDIT is not set
      findings.push({
        id: 'file-editor-enabled',
        severity: 'medium',
        title: 'Theme/plugin file editor is enabled',
        detail: 'The WordPress file editor allows anyone with admin access to edit PHP files directly from the dashboard. If an admin account is compromised, attackers can inject malicious code.',
        recommendation: "Add define('DISALLOW_FILE_EDIT', true); to wp-config.php.",
      });
    }
  } catch { /* skip */ }
}

async function checkDefaultAdmin(base: string, findings: SecurityFinding[]) {
  // Check if "admin" user exists via REST API
  try {
    const res = await secureFetch(`${base}/wp-json/wp/v2/users?slug=admin`, { redirect: 'manual' });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        findings.push({
          id: 'default-admin-username',
          severity: 'medium',
          title: 'Default "admin" username exists',
          detail: 'The "admin" username is the first target in brute-force attacks. Its existence makes the site a more attractive target.',
          recommendation: 'Create a new admin account with a unique username, transfer all content, then delete the "admin" account.',
        });
      }
    }
  } catch { /* skip */ }
}

async function checkRegistration(base: string, findings: SecurityFinding[]) {
  try {
    const res = await secureFetch(`${base}/wp-login.php?action=register`, { redirect: 'manual' });
    if (res.ok) {
      const html = await res.text();
      if (html.includes('id="registerform"') || html.includes('Register')) {
        findings.push({
          id: 'registration-open',
          severity: 'info',
          title: 'User registration is open',
          detail: 'Anyone can register an account. Verify this is intentional and that the default role is appropriate.',
          recommendation: 'If registration is not needed, disable it in Settings > General. Ensure default role is "Subscriber" not "Editor" or higher.',
        });
      }
    }
  } catch { /* skip */ }
}

async function checkRESTAPIExposure(base: string, findings: SecurityFinding[]) {
  try {
    const res = await secureFetch(`${base}/wp-json/`);
    if (res.ok) {
      const data = await res.json();
      const namespaces: string[] = data.namespaces || [];

      // Check for application passwords support
      if (data.authentication?.['application-passwords']) {
        findings.push({
          id: 'application-passwords-enabled',
          severity: 'info',
          title: 'Application Passwords are enabled',
          detail: 'WordPress Application Passwords are active. These provide REST API authentication but can be a risk without 2FA.',
          recommendation: 'Ensure 2FA is enabled for all admin accounts and regularly audit Application Passwords.',
        });
      }

      // Check exposed namespaces for sensitive data
      const sensitiveNamespaces = namespaces.filter(ns =>
        ns.match(/^(wp\/v2|wc\/v[123]|wc-analytics|jetpack|yoast|wpml|acf)/)
      );
      if (sensitiveNamespaces.length > 5) {
        findings.push({
          id: 'rest-api-many-namespaces',
          severity: 'info',
          title: `REST API exposes ${sensitiveNamespaces.length} namespaces`,
          detail: `Namespaces: ${sensitiveNamespaces.join(', ')}. Each namespace may expose data or functionality.`,
          recommendation: 'Review REST API access. Consider restricting unauthenticated access to sensitive namespaces.',
        });
      }
    }
  } catch { /* skip */ }
}

async function checkWPCron(base: string, findings: SecurityFinding[]) {
  try {
    const res = await secureFetch(`${base}/wp-cron.php`, { method: 'HEAD' });
    if (res.ok || res.status === 204) {
      findings.push({
        id: 'wp-cron-public',
        severity: 'low',
        title: 'wp-cron.php is publicly accessible',
        detail: 'wp-cron.php can be triggered by anyone. In high-traffic scenarios, this can be abused for DoS or waste server resources.',
        recommendation: "Set define('DISABLE_WP_CRON', true); in wp-config.php and use a system cron job instead.",
      });
    }
  } catch { /* skip */ }
}

async function checkWooCommerceSecurity(
  base: string, config: SiteConfig, findings: SecurityFinding[]
) {
  // 1. Checkout page over HTTPS
  try {
    const checkoutRes = await secureFetch(`${base}/checkout/`, { redirect: 'manual' });
    if (checkoutRes.ok) {
      const html = await checkoutRes.text();

      // Check for payment form security
      if (html.includes('payment_method') || html.includes('wc-checkout')) {
        if (!base.startsWith('https')) {
          findings.push({
            id: 'wc-checkout-not-https',
            severity: 'critical',
            title: 'WooCommerce checkout page is not on HTTPS',
            detail: 'Payment and personal data is transmitted without encryption. This violates PCI-DSS requirements.',
            recommendation: 'Enable HTTPS for the entire site, especially checkout.',
          });
        }

        // Check if the form action uses HTTPS
        const formActions = html.match(/action=["']http:\/\/[^"']+["']/gi);
        if (formActions && base.startsWith('https')) {
          findings.push({
            id: 'wc-checkout-form-http',
            severity: 'high',
            title: 'Checkout form submits to HTTP (not HTTPS)',
            detail: 'Payment form data will be sent over an insecure connection.',
            recommendation: 'Update WordPress Address to use HTTPS in Settings > General.',
          });
        }
      }
    }
  } catch { /* skip */ }

  // 2. Customer data endpoints
  try {
    const res = await secureFetch(`${base}/wp-json/wc/v3/customers`, { redirect: 'manual' });
    if (res.ok) {
      // Should require authentication — if it returns 200 without auth, data is exposed
      findings.push({
        id: 'wc-customers-exposed',
        severity: 'critical',
        title: 'WooCommerce customer data accessible without authentication',
        detail: 'The /wp-json/wc/v3/customers endpoint returns customer data without requiring authentication.',
        recommendation: 'This is likely a misconfigured REST API. Check WooCommerce API settings and auth requirements.',
      });
    }
  } catch { /* skip */ }

  // 3. Order data exposure
  try {
    const res = await secureFetch(`${base}/wp-json/wc/v3/orders`, { redirect: 'manual' });
    if (res.ok) {
      findings.push({
        id: 'wc-orders-exposed',
        severity: 'critical',
        title: 'WooCommerce order data accessible without authentication',
        detail: 'The /wp-json/wc/v3/orders endpoint returns order data without requiring authentication.',
        recommendation: 'Check WooCommerce REST API authentication. This should never be publicly accessible.',
      });
    }
  } catch { /* skip */ }

  // 4. WC AJAX endpoints
  try {
    const res = await secureFetch(`${base}/?wc-ajax=get_refreshed_fragments`);
    if (res.ok) {
      // This is normal, but check if it leaks excessive data
      const data = await res.json();
      if (data.cart_hash && data.fragments) {
        // Normal WC behavior — but flag if no CSRF protection detected
      }
    }
  } catch { /* skip */ }

  // 5. Downloadable file security
  try {
    const res = await secureFetch(`${base}/wp-content/uploads/woocommerce_uploads/`, { redirect: 'manual' });
    if (res.ok) {
      const text = await res.text();
      if (text.includes('Index of') || text.includes('.pdf') || text.includes('.zip')) {
        findings.push({
          id: 'wc-downloadable-files-exposed',
          severity: 'high',
          title: 'WooCommerce downloadable files directory is accessible',
          detail: 'Paid downloadable products may be directly accessible without purchase.',
          recommendation: 'Add .htaccess rules to block direct access to woocommerce_uploads directory.',
        });
      }
    }
  } catch { /* skip */ }
}

function checkWAFDetection(
  html: string,
  wpHealth: WordPressHealthResult | undefined,
  findings: SecurityFinding[]
) {
  // Check for known security plugins/WAFs
  const securityPlugins = wpHealth?.plugins.filter(p => {
    const slug = p.slug.toLowerCase();
    return slug.includes('wordfence') || slug.includes('sucuri') ||
      slug.includes('ithemes-security') || slug.includes('better-wp-security') ||
      slug.includes('all-in-one-wp-security') || slug.includes('shield-security') ||
      slug.includes('wp-cerber') || slug.includes('bulletproof-security') ||
      slug.includes('anti-malware') || slug.includes('jetpack');
  }) || [];

  // Check HTML for WAF indicators
  const wafIndicators = [
    { pattern: /wordfence/i, name: 'Wordfence' },
    { pattern: /sucuri/i, name: 'Sucuri' },
    { pattern: /cloudflare/i, name: 'Cloudflare' },
    { pattern: /akamai/i, name: 'Akamai' },
  ];

  const detectedWAFs: string[] = [];
  for (const { pattern, name } of wafIndicators) {
    if (pattern.test(html)) detectedWAFs.push(name);
  }
  for (const p of securityPlugins) {
    if (!detectedWAFs.includes(p.name)) detectedWAFs.push(p.name);
  }

  if (detectedWAFs.length > 0) {
    findings.push({
      id: 'waf-detected',
      severity: 'info',
      title: `Security plugin/WAF detected: ${detectedWAFs.join(', ')}`,
      detail: 'A web application firewall or security plugin is active, providing additional protection.',
      recommendation: 'Ensure the WAF/security plugin is kept updated and properly configured.',
    });
  } else if (securityPlugins.length === 0) {
    findings.push({
      id: 'no-security-plugin',
      severity: 'medium',
      title: 'No security plugin or WAF detected',
      detail: 'No dedicated WordPress security plugin was found. The site relies on server-level and WordPress core security only.',
      recommendation: 'Consider installing a security plugin like Wordfence, Sucuri, or iThemes Security for additional protection layers.',
    });
  }
}

// ── Review-standard: dated backup files (architecture.md) ─────────────────

async function checkDatedBackupFiles(
  base: string,
  findings: SecurityFinding[],
  exposedFiles: ExposedFile[]
) {
  // Check for common backup file patterns with date suffixes
  const backupPaths = [
    '/wp-content/themes/',
    '/wp-content/plugins/',
  ];
  const backupSuffixes = ['.bak', '.old', '.orig', '.save', '.tmp', '~'];

  // Check for common theme function files with backup extensions
  const criticalFiles = [
    'functions.php', 'wp-config.php', 'header.php', 'footer.php',
  ];

  for (const file of criticalFiles) {
    for (const suffix of backupSuffixes) {
      const testPath = `/wp-content/themes/${file}${suffix}`;
      try {
        const res = await fetch(`${base}${testPath}`, {
          method: 'HEAD',
          redirect: 'manual',
          signal: AbortSignal.timeout(5000),
        });
        if (res.status === 200) {
          exposedFiles.push({ path: testPath, status: 200, risk: `Backup of ${file} exposed` });
          findings.push({
            id: `backup-file-${file}${suffix}`.replace(/[^a-z0-9-]/g, '-'),
            severity: file === 'wp-config.php' ? 'critical' : 'high',
            title: `Backup file exposed: ${testPath}`,
            detail: `A backup copy of ${file} is publicly accessible. It may contain sensitive code, credentials, or database connection details.`,
            recommendation: `Delete ${testPath} from the server. Configure your web server to block access to backup file extensions.`,
          });
        }
      } catch { /* timeout or network error */ }
    }
  }
}

// ── Review-standard: REST endpoint permission probing (rest-api.md) ────────

async function checkRESTPermissions(
  base: string,
  findings: SecurityFinding[]
) {
  // Discover custom namespaces first
  let namespaces: string[] = [];
  try {
    const res = await fetch(`${base}/wp-json/`, {
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      namespaces = (data.namespaces || []).filter(
        (ns: string) => !ns.startsWith('wp/') && !ns.startsWith('oembed') && !ns.startsWith('wc/')
      );
    }
  } catch { /* REST API not accessible */ }

  // For each custom namespace, check if routes are accessible without auth
  for (const ns of namespaces.slice(0, 5)) {
    try {
      const res = await fetch(`${base}/wp-json/${ns}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json();
        const routes = Object.keys(data.routes || {});

        // Try accessing the first few routes without auth
        for (const route of routes.slice(0, 3)) {
          if (route === `/${ns}`) continue; // Skip root
          try {
            const routeRes = await fetch(`${base}/wp-json${route}`, {
              signal: AbortSignal.timeout(5000),
            });
            if (routeRes.ok) {
              const routeData = await routeRes.json();
              // If we get data back without auth, it might be intentional (public) or a problem
              const hasData = Array.isArray(routeData) ? routeData.length > 0 : Object.keys(routeData).length > 0;
              if (hasData) {
                findings.push({
                  id: `rest-open-${ns}-${route}`.replace(/[^a-z0-9-]/g, '-').slice(0, 60),
                  severity: 'medium',
                  title: `Custom REST endpoint accessible without auth: ${route}`,
                  detail: `The endpoint /wp-json${route} returns data without authentication. Verify this is intentional and no sensitive data is exposed.`,
                  recommendation: 'Add proper permission_callback with capability checks. If intentional, document why public access is needed.',
                });
              }
            }
          } catch { /* timeout */ }
        }
      }
    } catch { /* namespace not accessible */ }
  }
}
