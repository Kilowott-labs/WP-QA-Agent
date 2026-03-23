import { Page } from 'playwright';
import { SiteConfig, PageHealthResult, PageConfig } from '../../types.js';
import { resolveUrl, fmtMs, logger } from '../../utils.js';
import path from 'path';

/**
 * Check HTTP status + load time for key pages.
 * Pages come from discover-pages.ts (already set on config.key_pages by runner).
 * Falls back to just homepage if nothing was discovered.
 */
export async function checkPageHealth(
  page: Page,
  config: SiteConfig,
  screenshotDir: string
): Promise<PageHealthResult[]> {
  const pages = config.key_pages && config.key_pages.length > 0
    ? config.key_pages
    : [{ name: 'Homepage', path: '/' }];

  const results: PageHealthResult[] = [];

  for (const pg of pages) {
    const url = resolveUrl(config.url, pg.path);
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
        timeout: config.timeout_ms || 30000,
      });
      result.load_time_ms = Date.now() - start;
      result.status = response?.status() ?? 'ERROR';
      result.ok =
        typeof result.status === 'number' &&
        result.status >= 200 &&
        result.status < 400;

      // Check redirect
      if (page.url() !== url) {
        result.redirect_url = page.url();
      }

      // Must-contain checks
      if (pg.must_contain && pg.must_contain.length > 0) {
        const text = await page.textContent('body').catch(() => '');
        for (const expected of pg.must_contain) {
          if (!text?.includes(expected)) {
            result.ok = false;
            result.error = `Missing expected text: "${expected}"`;
          }
        }
      }

      // Must-not-contain checks
      if (pg.must_not_contain && pg.must_not_contain.length > 0) {
        const text = await page.textContent('body').catch(() => '');
        for (const unwanted of pg.must_not_contain) {
          if (text?.includes(unwanted)) {
            result.ok = false;
            result.error = `Found unwanted text: "${unwanted}"`;
          }
        }
      }

      // Take screenshot
      const ssName = `page-${pg.name.toLowerCase().replace(/\s+/g, '-')}.png`;
      const ssPath = path.join(screenshotDir, ssName);
      await page.screenshot({ path: ssPath, fullPage: false });
      result.screenshot = ssPath;

      logger.dim(
        `${result.ok ? '✓' : '✗'} ${pg.name}: ${result.status} (${fmtMs(result.load_time_ms)})`
      );
    } catch (err: any) {
      result.error = err.message;
      logger.dim(`✗ ${pg.name}: ERROR — ${err.message.slice(0, 80)}`);
    }

    results.push(result);
  }

  return results;
}
