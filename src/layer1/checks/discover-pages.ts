import { Page } from 'playwright';
import { SiteConfig, PageConfig } from '../../types.js';
import { baseUrl, resolveUrl, logger } from '../../utils.js';

/** Standard WooCommerce pages to always check if WC is detected */
const WC_PAGES: PageConfig[] = [
  { name: 'Shop', path: '/shop/' },
  { name: 'Cart', path: '/cart/' },
  { name: 'Checkout', path: '/checkout/' },
  { name: 'My Account', path: '/my-account/' },
];

/** Standard WordPress pages to always check */
const WP_PAGES: PageConfig[] = [
  { name: 'Homepage', path: '/' },
];

/**
 * Auto-discover pages from the site's navigation menus + standard paths.
 * Config key_pages are merged in as additions/overrides.
 */
export async function discoverPages(
  page: Page,
  config: SiteConfig,
  wcDetected: boolean
): Promise<PageConfig[]> {
  const site = baseUrl(config.url);
  const discovered = new Map<string, PageConfig>();

  // 1. Always include homepage
  for (const pg of WP_PAGES) {
    discovered.set(pg.path, pg);
  }

  // 2. Add standard WooCommerce pages if detected
  if (wcDetected) {
    for (const pg of WC_PAGES) {
      discovered.set(pg.path, pg);
    }
  }

  // 3. Crawl the homepage navigation to find real pages
  try {
    await page.goto(site, { waitUntil: 'domcontentloaded', timeout: config.timeout_ms || 30000 });

    const navLinks = await page.$$eval(
      'nav a[href], header a[href], .menu a[href], .nav a[href], #menu a[href], .site-header a[href]',
      (els, siteOrigin) => {
        const seen = new Set<string>();
        return els
          .map((a) => {
            const el = a as HTMLAnchorElement;
            return {
              href: el.href,
              text: el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 60) || '',
            };
          })
          .filter((link) => {
            // Only internal links, no duplicates, no anchors, no files
            if (!link.href.startsWith(siteOrigin)) return false;
            if (seen.has(link.href)) return false;
            if (link.href.includes('#') && link.href.split('#')[0] === siteOrigin) return false;
            if (link.href.match(/\.(pdf|zip|png|jpg|jpeg|gif|svg|mp4|mp3)$/i)) return false;
            if (!link.text || link.text.length < 2) return false;
            seen.add(link.href);
            return true;
          });
      },
      site
    );

    for (const link of navLinks) {
      try {
        const url = new URL(link.href);
        const pathStr = url.pathname.replace(/\/$/, '/') || '/';
        if (!discovered.has(pathStr)) {
          discovered.set(pathStr, {
            name: link.text,
            path: pathStr,
          });
        }
      } catch {
        // Invalid URL
      }
    }

    logger.dim(`Discovered ${navLinks.length} navigation links`);
  } catch (err: any) {
    logger.warn(`Page discovery failed: ${err.message.slice(0, 80)}`);
  }

  // 4. Merge in config key_pages (these override discovered names)
  if (config.key_pages && config.key_pages.length > 0) {
    for (const pg of config.key_pages) {
      discovered.set(pg.path, pg); // overrides any auto-discovered entry
    }
  }

  const pages = Array.from(discovered.values());
  logger.info(`${pages.length} pages to check (${pages.map((p) => p.name).join(', ')})`);

  return pages;
}
