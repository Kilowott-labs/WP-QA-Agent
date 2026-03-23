import { Page } from 'playwright';
import {
  SiteConfig,
  PerformanceDeepDiveResult,
  PagePerformanceDetail,
  ThirdPartyScript,
  CompressionCheck,
  CacheHeaderCheck,
  FontLoadingCheck,
  NetworkRequest,
} from '../../types.js';
import { resolveUrl, baseUrl, isThirdParty, logger, fmtMs } from '../../utils.js';

/**
 * Performance deep-dive: page weight breakdown, third-party audit,
 * compression, cache headers, font loading, render-blocking resources.
 */
export async function runPerformanceDeepDive(
  page: Page,
  config: SiteConfig,
  collectedRequests: NetworkRequest[]
): Promise<PerformanceDeepDiveResult> {
  const pages = config.key_pages?.length
    ? config.key_pages
    : [{ name: 'Homepage', path: '/' }];

  const pageDetails: PagePerformanceDetail[] = [];
  const allRequests: NetworkRequest[] = [];
  const cacheHeaders: CacheHeaderCheck[] = [];
  const fontResults: FontLoadingCheck[] = [];
  let totalIssues = 0;

  for (const pg of pages) {
    const url = resolveUrl(config.url, pg.path);

    // Clear request tracking for this page
    const requestsBefore = collectedRequests.length;

    try {
      const start = Date.now();

      // Intercept response headers for cache and compression analysis
      const responseHeaders = new Map<string, Headers>();
      const headerListener = (response: any) => {
        try {
          responseHeaders.set(response.url(), response.headers());
        } catch { /* ignore */ }
      };
      page.on('response', headerListener);

      await page.goto(url, {
        waitUntil: 'networkidle',
        timeout: config.timeout_ms || 30000,
      });

      const ttfb = Date.now() - start;
      page.removeListener('response', headerListener);

      // Requests captured during this page load
      const pageRequests = collectedRequests.slice(requestsBefore);
      allRequests.push(...pageRequests);

      // Calculate page weight breakdown
      const detail = calculatePageWeight(pg.name, url, pageRequests, ttfb);
      pageDetails.push(detail);

      // Cache header checks for static assets
      for (const [reqUrl, hdrs] of responseHeaders) {
        const type = categorizeResource(reqUrl);
        if (type === 'other' || type === 'html') continue;

        const cacheControl =
          (hdrs as any)?.['cache-control'] ||
          (hdrs as any)?.get?.('cache-control') ||
          '';
        const hasCache = !!(
          cacheControl &&
          !cacheControl.includes('no-store') &&
          !cacheControl.includes('no-cache')
        );

        if (!hasCache) {
          cacheHeaders.push({
            url: reqUrl,
            cache_control: cacheControl || undefined,
            has_cache: false,
            type,
          });
        }
      }

      // Font loading analysis
      const fonts = await page.evaluate(() => {
        const results: {
          url: string;
          display: string;
          format: string;
          preloaded: boolean;
        }[] = [];

        // Check preloaded fonts
        const preloads = document.querySelectorAll('link[rel="preload"][as="font"]');
        const preloadedUrls = new Set(
          Array.from(preloads).map((l) => (l as HTMLLinkElement).href)
        );

        // Get font-face declarations from stylesheets
        for (const sheet of Array.from(document.styleSheets)) {
          try {
            for (const rule of Array.from(sheet.cssRules || [])) {
              if (rule instanceof CSSFontFaceRule) {
                const src = rule.style.getPropertyValue('src');
                const display =
                  rule.style.getPropertyValue('font-display') || 'auto';
                const urlMatch = src.match(/url\(["']?([^"')]+)["']?\)/);
                if (urlMatch) {
                  const fontUrl = urlMatch[1];
                  const format = fontUrl.match(/\.(woff2?|ttf|otf|eot)/)?.[1] || 'unknown';
                  results.push({
                    url: fontUrl,
                    display,
                    format,
                    preloaded: preloadedUrls.has(fontUrl),
                  });
                }
              }
            }
          } catch { /* cross-origin stylesheet */ }
        }

        return results;
      });

      for (const font of fonts) {
        fontResults.push({
          url: font.url,
          display_strategy: font.display,
          format: font.format,
          is_preloaded: font.preloaded,
        });

        if (font.display === 'auto' || font.display === 'block') {
          totalIssues++;
        }
      }

      // Count render-blocking resources
      const renderBlocking = await page.evaluate(() => {
        let count = 0;
        // Stylesheets without media="print" or async loading
        document
          .querySelectorAll('link[rel="stylesheet"]')
          .forEach((link) => {
            const media = (link as HTMLLinkElement).media;
            if (!media || media === 'all' || media === 'screen') count++;
          });
        // Scripts in head without async/defer
        document
          .querySelectorAll('head script[src]:not([async]):not([defer]):not([type="module"])')
          .forEach(() => count++);
        return count;
      });

      if (detail.total_weight_bytes > 3 * 1024 * 1024) totalIssues++;
      if (detail.js_bytes > 1 * 1024 * 1024) totalIssues++;
      if (renderBlocking > 5) totalIssues++;

      detail.render_blocking_count = renderBlocking;

      logger.dim(
        `perf: ${pg.name} — ${formatBytes(detail.total_weight_bytes)}, ${detail.request_count} reqs, ${renderBlocking} render-blocking`
      );
    } catch (err: any) {
      logger.dim(`perf: ${pg.name} — ERROR: ${err.message.slice(0, 60)}`);
    }
  }

  // ── Third-party script audit ────────────────────────────────────────
  const thirdPartyAudit = buildThirdPartyAudit(allRequests, config.url);

  // ── Compression check ───────────────────────────────────────────────
  const compression = await checkCompression(config.url);

  totalIssues += cacheHeaders.filter((c) => !c.has_cache).length > 3 ? 1 : 0;
  totalIssues += thirdPartyAudit.length > 10 ? 1 : 0;
  totalIssues += !compression.gzip_enabled && !compression.brotli_enabled ? 1 : 0;

  return {
    pages: pageDetails,
    third_party_audit: thirdPartyAudit,
    compression,
    cache_headers: cacheHeaders.slice(0, 20), // Limit to top 20
    font_loading: fontResults,
    total_issues: totalIssues,
  };
}

function calculatePageWeight(
  name: string,
  url: string,
  requests: NetworkRequest[],
  ttfb: number
): PagePerformanceDetail {
  let html = 0,
    css = 0,
    js = 0,
    image = 0,
    font = 0,
    other = 0;

  for (const req of requests) {
    const size = req.size_bytes || estimateSize(req);
    const type = req.type || categorizeResource(req.url);

    switch (type) {
      case 'document':
      case 'html':
        html += size;
        break;
      case 'stylesheet':
      case 'css':
        css += size;
        break;
      case 'script':
      case 'js':
        js += size;
        break;
      case 'image':
      case 'img':
        image += size;
        break;
      case 'font':
        font += size;
        break;
      default:
        other += size;
    }
  }

  return {
    page: name,
    url,
    total_weight_bytes: html + css + js + image + font + other,
    html_bytes: html,
    css_bytes: css,
    js_bytes: js,
    image_bytes: image,
    font_bytes: font,
    other_bytes: other,
    request_count: requests.length,
    render_blocking_count: 0, // Filled after page.evaluate
    ttfb_ms: ttfb,
  };
}

function categorizeResource(url: string): string {
  const lower = url.toLowerCase();
  if (lower.match(/\.(css)(\?|$)/)) return 'css';
  if (lower.match(/\.(js|mjs)(\?|$)/)) return 'js';
  if (lower.match(/\.(jpe?g|png|gif|svg|webp|avif|ico)(\?|$)/)) return 'image';
  if (lower.match(/\.(woff2?|ttf|otf|eot)(\?|$)/)) return 'font';
  if (lower.match(/\.(html?)(\?|$)/)) return 'html';
  return 'other';
}

function estimateSize(req: NetworkRequest): number {
  // Rough estimate if size_bytes isn't available
  const type = categorizeResource(req.url);
  switch (type) {
    case 'image':
      return 50000;
    case 'js':
      return 30000;
    case 'css':
      return 10000;
    case 'font':
      return 40000;
    default:
      return 5000;
  }
}

function buildThirdPartyAudit(
  requests: NetworkRequest[],
  siteUrl: string
): ThirdPartyScript[] {
  const byDomain = new Map<
    string,
    { urls: string[]; size: number; duration: number }
  >();

  for (const req of requests) {
    if (!isThirdParty(req.url, siteUrl)) continue;

    let domain: string;
    try {
      domain = new URL(req.url).hostname;
    } catch {
      continue;
    }

    const entry = byDomain.get(domain) || { urls: [], size: 0, duration: 0 };
    entry.urls.push(req.url);
    entry.size += req.size_bytes || estimateSize(req);
    entry.duration += req.duration_ms;
    byDomain.set(domain, entry);
  }

  return Array.from(byDomain.entries())
    .map(([domain, data]) => ({
      domain,
      urls: data.urls.slice(0, 5), // Limit URLs per domain
      total_size_bytes: data.size,
      total_duration_ms: data.duration,
      category: categorizeThirdParty(domain),
    }))
    .sort((a, b) => b.total_size_bytes - a.total_size_bytes);
}

function categorizeThirdParty(domain: string): string {
  const d = domain.toLowerCase();
  if (d.includes('google-analytics') || d.includes('googletagmanager') || d.includes('analytics'))
    return 'analytics';
  if (d.includes('facebook') || d.includes('fbcdn')) return 'social';
  if (d.includes('twitter') || d.includes('twimg')) return 'social';
  if (d.includes('hotjar') || d.includes('clarity')) return 'analytics';
  if (d.includes('stripe') || d.includes('paypal') || d.includes('klarna'))
    return 'payment';
  if (d.includes('fonts.googleapis') || d.includes('fonts.gstatic'))
    return 'fonts';
  if (d.includes('cdn') || d.includes('cloudflare') || d.includes('cloudfront'))
    return 'cdn';
  if (d.includes('recaptcha') || d.includes('hcaptcha')) return 'security';
  if (d.includes('ads') || d.includes('doubleclick') || d.includes('adservice'))
    return 'advertising';
  return 'other';
}

async function checkCompression(siteUrl: string): Promise<CompressionCheck> {
  const base = baseUrl(siteUrl);
  const result: CompressionCheck = {
    gzip_enabled: false,
    brotli_enabled: false,
    uncompressed_resources: [],
  };

  // Check main page with Accept-Encoding headers
  try {
    const res = await fetch(base, {
      headers: {
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': 'wp-qa-agent/1.0',
      },
      signal: AbortSignal.timeout(15000),
    });
    const encoding = res.headers.get('content-encoding') || '';
    result.gzip_enabled = encoding.includes('gzip');
    result.brotli_enabled = encoding.includes('br');
  } catch { /* skip */ }

  return result;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
