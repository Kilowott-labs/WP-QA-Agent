import { Page } from 'playwright';
import { SiteConfig, BrokenLink } from '../../types.js';
import { baseUrl, resolveUrl, logger } from '../../utils.js';

/**
 * Crawl internal links from key pages and detect 404s / broken links.
 */
export async function findBrokenLinks(
  page: Page,
  config: SiteConfig
): Promise<BrokenLink[]> {
  const site = baseUrl(config.url);
  const maxLinks = config.max_links_to_crawl || 30;
  const timeout = config.timeout_ms || 30000;
  const brokenLinks: BrokenLink[] = [];
  const checked = new Set<string>();
  const linksToCheck: Array<{ url: string; source: string; text: string }> = [];

  // Collect links from key pages
  const seedPages = config.key_pages?.map((p) => resolveUrl(site, p.path)) || [site];

  for (const seedUrl of seedPages) {
    try {
      await page.goto(seedUrl, { waitUntil: 'domcontentloaded', timeout });
      const links = await page.$$eval('a[href]', (els) =>
        els.map((a) => ({
          href: (a as HTMLAnchorElement).href,
          text: (a as HTMLAnchorElement).textContent?.trim().slice(0, 80) || '',
        }))
      );

      for (const link of links) {
        if (
          link.href.startsWith(site) &&
          !checked.has(link.href) &&
          !link.href.includes('#') &&
          !link.href.match(/\.(pdf|zip|png|jpg|jpeg|gif|svg|mp4|mp3)$/i)
        ) {
          linksToCheck.push({ url: link.href, source: seedUrl, text: link.text });
          checked.add(link.href);
        }
        if (linksToCheck.length >= maxLinks) break;
      }
    } catch {
      // Seed page failed — already caught in page-health
    }
    if (linksToCheck.length >= maxLinks) break;
  }

  logger.dim(`Checking ${linksToCheck.length} internal links...`);

  // Check each link with a HEAD request first, fallback to GET
  for (const link of linksToCheck) {
    try {
      let res = await fetch(link.url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
      });

      // Some servers don't support HEAD, retry with GET
      if (res.status === 405) {
        res = await fetch(link.url, {
          method: 'GET',
          redirect: 'follow',
          signal: AbortSignal.timeout(10000),
        });
      }

      if (res.status >= 400) {
        brokenLinks.push({
          source_page: link.source,
          broken_url: link.url,
          status: res.status,
          link_text: link.text,
        });
      }
    } catch (err: any) {
      const reason = err.name === 'TimeoutError' ? 'TIMEOUT' : 'ERROR';
      brokenLinks.push({
        source_page: link.source,
        broken_url: link.url,
        status: reason,
        link_text: link.text,
      });
    }
  }

  return brokenLinks;
}
