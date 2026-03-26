import { Page } from 'playwright';
import { SiteConfig, CheckResult } from '../../types.js';
import { resolveUrl, logger } from '../../utils.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SeoIssue {
  page: string;
  url: string;
  type: string;
  severity: 'critical' | 'major' | 'minor';
  detail: string;
  recommendation: string;
}

export interface SeoHealthResult {
  pages_tested: number;
  total_issues: number;
  issues: SeoIssue[];
  summary: {
    missing_meta_title: number;
    missing_meta_description: number;
    missing_og_tags: number;
    missing_canonical: number;
    heading_issues: number;
    missing_structured_data: number;
    missing_hreflang: number;
    image_alt_coverage: number;  // percentage 0-100
  };
  sitemap_accessible: boolean;
  robots_txt_accessible: boolean;
  checkResults: CheckResult[];
}

// ── Main Check ────────────────────────────────────────────────────────────────

export async function runSeoHealthCheck(
  page: Page,
  config: SiteConfig
): Promise<SeoHealthResult> {
  const pages = config.key_pages?.length
    ? config.key_pages
    : [{ name: 'Homepage', path: '/' }];

  const allIssues: SeoIssue[] = [];
  const summaryCounters = {
    missing_meta_title: 0,
    missing_meta_description: 0,
    missing_og_tags: 0,
    missing_canonical: 0,
    heading_issues: 0,
    missing_structured_data: 0,
    missing_hreflang: 0,
  };
  let totalImages = 0;
  let imagesWithAlt = 0;
  let hasMetaTagIssues = false;
  let hasLengthIssues = false;
  let hasOgIssues = false;
  let hasHeadingIssues = false;

  for (const pg of pages) {
    const url = resolveUrl(config.url, pg.path);

    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: config.timeout_ms || 30000,
      });
    } catch {
      continue;
    }

    const pageData = await page.evaluate((siteUrl: string) => {
      const result: {
        title: string;
        titleLength: number;
        metaDescription: string;
        metaDescriptionLength: number;
        ogTags: Record<string, boolean>;
        twitterTags: Record<string, boolean>;
        canonicalUrl: string | null;
        h1Count: number;
        headingSkips: { from: number; to: number; text: string }[];
        hasStructuredData: boolean;
        structuredDataCount: number;
        hasHreflang: boolean;
        hasMultilingualIndicator: boolean;
        totalImages: number;
        imagesWithAlt: number;
      } = {
        title: '',
        titleLength: 0,
        metaDescription: '',
        metaDescriptionLength: 0,
        ogTags: {},
        twitterTags: {},
        canonicalUrl: null,
        h1Count: 0,
        headingSkips: [],
        hasStructuredData: false,
        structuredDataCount: 0,
        hasHreflang: false,
        hasMultilingualIndicator: false,
        totalImages: 0,
        imagesWithAlt: 0,
      };

      // 1. Meta title
      result.title = document.title || '';
      result.titleLength = result.title.length;

      // 2. Meta description
      const descEl = document.querySelector('meta[name="description"]');
      result.metaDescription = descEl ? (descEl.getAttribute('content') || '') : '';
      result.metaDescriptionLength = result.metaDescription.length;

      // 3. Open Graph tags
      const ogRequired = ['og:title', 'og:description', 'og:image', 'og:url', 'og:type'];
      for (const tag of ogRequired) {
        const el = document.querySelector(`meta[property="${tag}"]`);
        result.ogTags[tag] = !!(el && el.getAttribute('content'));
      }

      // 4. Twitter Card tags
      const twitterRequired = ['twitter:card', 'twitter:title', 'twitter:description'];
      for (const tag of twitterRequired) {
        const el = document.querySelector(`meta[name="${tag}"]`);
        result.twitterTags[tag] = !!(el && el.getAttribute('content'));
      }

      // 5. Canonical URL
      const canonicalEl = document.querySelector('link[rel="canonical"]');
      result.canonicalUrl = canonicalEl ? (canonicalEl.getAttribute('href') || null) : null;

      // 6. Heading structure
      const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
      let prevLevel = 0;
      headings.forEach((h) => {
        const level = parseInt(h.tagName.charAt(1));
        if (level === 1) result.h1Count++;
        if (prevLevel > 0 && level > prevLevel + 1) {
          result.headingSkips.push({
            from: prevLevel,
            to: level,
            text: (h.textContent || '').trim().slice(0, 60),
          });
        }
        prevLevel = level;
      });

      // 7. Structured data
      const ldJsonScripts = document.querySelectorAll('script[type="application/ld+json"]');
      result.hasStructuredData = ldJsonScripts.length > 0;
      result.structuredDataCount = ldJsonScripts.length;

      // 8. Hreflang
      const hreflangLinks = document.querySelectorAll('link[rel="alternate"][hreflang]');
      result.hasHreflang = hreflangLinks.length > 0;
      // Check for multilingual plugin indicators on body
      const bodyClasses = document.body?.className || '';
      result.hasMultilingualIndicator =
        bodyClasses.includes('wpml') ||
        bodyClasses.includes('polylang') ||
        bodyClasses.includes('pll-') ||
        !!document.querySelector('.wpml-ls') ||
        !!document.querySelector('.pll-switcher') ||
        !!document.querySelector('[data-polylang]');

      // 9. Image alt coverage
      const images = document.querySelectorAll('img');
      images.forEach((img) => {
        // Skip tracking pixels and tiny images
        if (img.width < 5 && img.height < 5) return;
        const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
        if (src.includes('pixel') || src.includes('tracking')) return;
        result.totalImages++;
        const alt = img.getAttribute('alt');
        if (alt !== null && alt.trim().length > 0) {
          result.imagesWithAlt++;
        }
      });

      return result;
    }, config.url);

    // Accumulate image counts across pages
    totalImages += pageData.totalImages;
    imagesWithAlt += pageData.imagesWithAlt;

    // ── Process title issues ────────────────────────────────────────────────

    if (!pageData.title || pageData.titleLength === 0) {
      allIssues.push({
        page: pg.name,
        url,
        type: 'missing-title',
        severity: 'critical',
        detail: 'Page has no meta title',
        recommendation: 'Add a unique, descriptive <title> tag between 10-60 characters.',
      });
      summaryCounters.missing_meta_title++;
      hasMetaTagIssues = true;
    } else if (pageData.titleLength > 60) {
      allIssues.push({
        page: pg.name,
        url,
        type: 'title-length',
        severity: 'minor',
        detail: `Meta title is ${pageData.titleLength} characters (over 60 char limit). Title: "${pageData.title.slice(0, 70)}..."`,
        recommendation: 'Shorten the title to 60 characters or fewer to avoid truncation in search results.',
      });
      hasLengthIssues = true;
    } else if (pageData.titleLength < 10) {
      allIssues.push({
        page: pg.name,
        url,
        type: 'title-length',
        severity: 'major',
        detail: `Meta title is only ${pageData.titleLength} characters (under 10 char minimum). Title: "${pageData.title}"`,
        recommendation: 'Expand the title to at least 10 characters with a descriptive, keyword-relevant title.',
      });
      hasLengthIssues = true;
    }

    // ── Process meta description issues ─────────────────────────────────────

    if (!pageData.metaDescription || pageData.metaDescriptionLength === 0) {
      allIssues.push({
        page: pg.name,
        url,
        type: 'missing-meta-description',
        severity: 'major',
        detail: 'Page has no meta description',
        recommendation: 'Add a meta description between 50-160 characters summarising the page content.',
      });
      summaryCounters.missing_meta_description++;
      hasMetaTagIssues = true;
    } else if (pageData.metaDescriptionLength > 160) {
      allIssues.push({
        page: pg.name,
        url,
        type: 'meta-description-length',
        severity: 'minor',
        detail: `Meta description is ${pageData.metaDescriptionLength} characters (over 160 char limit)`,
        recommendation: 'Shorten the meta description to 160 characters or fewer to avoid truncation.',
      });
      hasLengthIssues = true;
    } else if (pageData.metaDescriptionLength < 50) {
      allIssues.push({
        page: pg.name,
        url,
        type: 'meta-description-length',
        severity: 'minor',
        detail: `Meta description is only ${pageData.metaDescriptionLength} characters (under 50 char minimum)`,
        recommendation: 'Expand the meta description to at least 50 characters for better search result display.',
      });
      hasLengthIssues = true;
    }

    // ── Process Open Graph issues ───────────────────────────────────────────

    const missingOg = Object.entries(pageData.ogTags)
      .filter(([, present]) => !present)
      .map(([tag]) => tag);

    if (missingOg.length > 0) {
      allIssues.push({
        page: pg.name,
        url,
        type: 'missing-og-tags',
        severity: 'major',
        detail: `Missing Open Graph tags: ${missingOg.join(', ')}`,
        recommendation: 'Add the missing OG tags for proper social media sharing previews.',
      });
      summaryCounters.missing_og_tags++;
      hasOgIssues = true;
    }

    // ── Process Twitter Card issues ─────────────────────────────────────────

    const missingTwitter = Object.entries(pageData.twitterTags)
      .filter(([, present]) => !present)
      .map(([tag]) => tag);

    if (missingTwitter.length > 0) {
      allIssues.push({
        page: pg.name,
        url,
        type: 'missing-twitter-card',
        severity: 'minor',
        detail: `Missing Twitter Card tags: ${missingTwitter.join(', ')}`,
        recommendation: 'Add Twitter Card meta tags for better Twitter/X sharing previews.',
      });
    }

    // ── Process canonical URL issues ────────────────────────────────────────

    if (!pageData.canonicalUrl) {
      allIssues.push({
        page: pg.name,
        url,
        type: 'missing-canonical',
        severity: 'major',
        detail: 'Page has no canonical URL',
        recommendation: 'Add a <link rel="canonical"> tag pointing to the preferred URL for this page.',
      });
      summaryCounters.missing_canonical++;
    } else {
      // Check if canonical points to a different domain
      try {
        const canonicalDomain = new URL(pageData.canonicalUrl).hostname;
        const siteDomain = new URL(config.url).hostname;
        if (canonicalDomain !== siteDomain) {
          allIssues.push({
            page: pg.name,
            url,
            type: 'canonical-mismatch',
            severity: 'critical',
            detail: `Canonical URL points to a different domain: ${pageData.canonicalUrl}`,
            recommendation: 'Fix the canonical URL to point to the correct domain. A cross-domain canonical signals search engines to index the other domain instead.',
          });
        }
      } catch {
        // Relative canonical or invalid URL - minor issue
        allIssues.push({
          page: pg.name,
          url,
          type: 'canonical-invalid',
          severity: 'minor',
          detail: `Canonical URL may be invalid: ${pageData.canonicalUrl}`,
          recommendation: 'Use a fully qualified absolute URL for the canonical tag.',
        });
      }
    }

    // ── Process heading structure issues ─────────────────────────────────────

    if (pageData.h1Count === 0) {
      allIssues.push({
        page: pg.name,
        url,
        type: 'missing-h1',
        severity: 'major',
        detail: 'No h1 element found on page',
        recommendation: 'Add exactly one h1 tag that describes the primary content of the page.',
      });
      summaryCounters.heading_issues++;
      hasHeadingIssues = true;
    } else if (pageData.h1Count > 1) {
      allIssues.push({
        page: pg.name,
        url,
        type: 'multiple-h1',
        severity: 'minor',
        detail: `Multiple h1 elements found (${pageData.h1Count})`,
        recommendation: 'Use only one h1 per page. Demote additional h1 tags to h2 or lower.',
      });
      summaryCounters.heading_issues++;
      hasHeadingIssues = true;
    }

    for (const skip of pageData.headingSkips) {
      allIssues.push({
        page: pg.name,
        url,
        type: 'heading-skip',
        severity: 'minor',
        detail: `Heading level skipped: h${skip.from} -> h${skip.to} ("${skip.text}")`,
        recommendation: `Use sequential heading levels. Change the h${skip.to} to h${skip.from + 1} or add an intermediate heading.`,
      });
      summaryCounters.heading_issues++;
      hasHeadingIssues = true;
    }

    // ── Process structured data issues ──────────────────────────────────────

    if (!pageData.hasStructuredData) {
      allIssues.push({
        page: pg.name,
        url,
        type: 'missing-structured-data',
        severity: 'minor',
        detail: 'No JSON-LD structured data found on page',
        recommendation: 'Add schema.org structured data (JSON-LD) for better rich snippet display in search results.',
      });
      summaryCounters.missing_structured_data++;
    }

    // ── Process hreflang issues ─────────────────────────────────────────────

    if (!pageData.hasHreflang && pageData.hasMultilingualIndicator) {
      allIssues.push({
        page: pg.name,
        url,
        type: 'missing-hreflang',
        severity: 'major',
        detail: 'Multilingual plugin detected (WPML/Polylang) but no hreflang tags found',
        recommendation: 'Configure the multilingual plugin to output hreflang tags, or add them manually for each language variant.',
      });
      summaryCounters.missing_hreflang++;
    }

    logger.dim(
      `seo: ${pg.name} -- ${allIssues.filter((i) => i.page === pg.name).length} issues`
    );
  }

  // ── Site-level checks (once, not per page) ────────────────────────────────

  const siteBase = config.url.replace(/\/+$/, '');
  const sitemapAccessible = await checkSitemap(siteBase, config.timeout_ms || 30000);
  const robotsResult = await checkRobotsTxt(siteBase, config.timeout_ms || 30000);

  if (!sitemapAccessible) {
    allIssues.push({
      page: 'Site-wide',
      url: `${siteBase}/sitemap.xml`,
      type: 'missing-sitemap',
      severity: 'major',
      detail: 'No accessible XML sitemap found at /sitemap.xml or /sitemap_index.xml',
      recommendation: 'Generate and submit an XML sitemap. Most SEO plugins (Yoast, Rank Math) do this automatically.',
    });
  }

  if (!robotsResult.accessible) {
    allIssues.push({
      page: 'Site-wide',
      url: `${siteBase}/robots.txt`,
      type: 'missing-robots',
      severity: 'minor',
      detail: 'No robots.txt file found',
      recommendation: 'Create a robots.txt file to guide search engine crawlers.',
    });
  }

  if (robotsResult.blocksImportant) {
    allIssues.push({
      page: 'Site-wide',
      url: `${siteBase}/robots.txt`,
      type: 'robots-blocking',
      severity: 'critical',
      detail: `robots.txt may be blocking important paths: ${robotsResult.blockedPaths.join(', ')}`,
      recommendation: 'Review robots.txt and remove Disallow rules for pages that should be indexed.',
    });
  }

  // ── Compute image alt coverage ────────────────────────────────────────────

  const altCoverage = totalImages > 0
    ? Math.round((imagesWithAlt / totalImages) * 100)
    : 100;

  if (altCoverage < 80 && totalImages > 0) {
    allIssues.push({
      page: 'Site-wide',
      url: config.url,
      type: 'low-alt-coverage',
      severity: altCoverage < 50 ? 'major' : 'minor',
      detail: `Image alt text coverage is ${altCoverage}% (${imagesWithAlt}/${totalImages} images have alt text)`,
      recommendation: 'Add descriptive alt text to all content images for accessibility and SEO.',
    });
  }

  // ── Build CheckResult array ───────────────────────────────────────────────

  const checkResults: CheckResult[] = [];

  // SEO -- Meta Tags
  if (hasMetaTagIssues) {
    checkResults.push({
      check: 'SEO -- Meta Tags',
      status: 'FAIL',
      detail: `${summaryCounters.missing_meta_title} pages missing title, ${summaryCounters.missing_meta_description} pages missing description`,
    });
  } else if (hasLengthIssues) {
    checkResults.push({
      check: 'SEO -- Meta Tags',
      status: 'WARN',
      detail: 'All pages have meta tags but some have length issues',
    });
  } else {
    checkResults.push({
      check: 'SEO -- Meta Tags',
      status: 'PASS',
      detail: 'All pages have properly configured meta title and description',
    });
  }

  // SEO -- Open Graph
  if (hasOgIssues) {
    checkResults.push({
      check: 'SEO -- Open Graph',
      status: 'WARN',
      detail: `${summaryCounters.missing_og_tags} page(s) missing Open Graph tags`,
    });
  } else {
    checkResults.push({
      check: 'SEO -- Open Graph',
      status: 'PASS',
      detail: 'All pages have Open Graph tags configured',
    });
  }

  // SEO -- Headings
  if (hasHeadingIssues) {
    checkResults.push({
      check: 'SEO -- Headings',
      status: 'WARN',
      detail: `${summaryCounters.heading_issues} heading issue(s) found`,
    });
  } else {
    checkResults.push({
      check: 'SEO -- Headings',
      status: 'PASS',
      detail: 'Heading structure is correct on all pages',
    });
  }

  // SEO -- Sitemap & Robots
  if (!sitemapAccessible) {
    checkResults.push({
      check: 'SEO -- Sitemap & Robots',
      status: 'FAIL',
      detail: `Sitemap: ${sitemapAccessible ? 'accessible' : 'not found'}, Robots.txt: ${robotsResult.accessible ? 'accessible' : 'not found'}`,
    });
  } else if (!robotsResult.accessible || robotsResult.blocksImportant) {
    checkResults.push({
      check: 'SEO -- Sitemap & Robots',
      status: 'WARN',
      detail: `Sitemap: accessible, Robots.txt: ${!robotsResult.accessible ? 'not found' : 'blocks important paths'}`,
    });
  } else {
    checkResults.push({
      check: 'SEO -- Sitemap & Robots',
      status: 'PASS',
      detail: 'Sitemap and robots.txt are both accessible and properly configured',
    });
  }

  // SEO -- Overall
  const criticalCount = allIssues.filter((i) => i.severity === 'critical').length;
  const majorCount = allIssues.filter((i) => i.severity === 'major').length;

  let overallStatus: 'PASS' | 'FAIL' | 'WARN' = 'PASS';
  let overallDetail = 'No significant SEO issues found';

  if (criticalCount > 0) {
    overallStatus = 'FAIL';
    overallDetail = `${criticalCount} critical and ${majorCount} major SEO issue(s) found`;
  } else if (majorCount > 0) {
    overallStatus = 'WARN';
    overallDetail = `${majorCount} major SEO issue(s) found`;
  } else if (allIssues.length > 0) {
    overallStatus = 'WARN';
    overallDetail = `${allIssues.length} minor SEO issue(s) found`;
  }

  checkResults.push({
    check: 'SEO -- Overall',
    status: overallStatus,
    detail: overallDetail,
  });

  const result: SeoHealthResult = {
    pages_tested: pages.length,
    total_issues: allIssues.length,
    issues: allIssues,
    summary: {
      ...summaryCounters,
      image_alt_coverage: altCoverage,
    },
    sitemap_accessible: sitemapAccessible,
    robots_txt_accessible: robotsResult.accessible,
    checkResults,
  };

  logger.info(`SEO health: ${pages.length} pages tested, ${allIssues.length} issues found`);

  return result;
}

// ── Sitemap Check ─────────────────────────────────────────────────────────────

async function checkSitemap(
  siteBase: string,
  timeoutMs: number
): Promise<boolean> {
  const urls = [
    `${siteBase}/sitemap.xml`,
    `${siteBase}/sitemap_index.xml`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      if (res.ok) return true;
    } catch {
      // Continue to next URL
    }
  }

  return false;
}

// ── Robots.txt Check ──────────────────────────────────────────────────────────

interface RobotsResult {
  accessible: boolean;
  blocksImportant: boolean;
  blockedPaths: string[];
}

async function checkRobotsTxt(
  siteBase: string,
  timeoutMs: number
): Promise<RobotsResult> {
  const result: RobotsResult = {
    accessible: false,
    blocksImportant: false,
    blockedPaths: [],
  };

  try {
    const res = await fetch(`${siteBase}/robots.txt`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });

    if (!res.ok) return result;
    result.accessible = true;

    const text = await res.text();
    const lines = text.split('\n');

    // Important paths that should not be disallowed
    const importantPaths = ['/', '/shop', '/cart', '/checkout', '/my-account', '/product'];
    const blockedPaths: string[] = [];

    let inAllUserAgent = false;

    for (const rawLine of lines) {
      const line = rawLine.trim().toLowerCase();

      if (line.startsWith('user-agent:')) {
        const agent = line.replace('user-agent:', '').trim();
        inAllUserAgent = agent === '*';
      }

      if (line.startsWith('disallow:') && inAllUserAgent) {
        const disallowed = line.replace('disallow:', '').trim();
        if (!disallowed) continue;

        for (const important of importantPaths) {
          // Check if the disallow rule would block an important path
          if (disallowed === important || disallowed === `${important}/`) {
            blockedPaths.push(disallowed);
          }
          // A blanket Disallow: / blocks everything
          if (disallowed === '/') {
            blockedPaths.push('/ (blocks entire site)');
          }
        }
      }
    }

    if (blockedPaths.length > 0) {
      result.blocksImportant = true;
      result.blockedPaths = [...new Set(blockedPaths)];
    }
  } catch {
    // robots.txt not accessible
  }

  return result;
}

// ── Report Builder ────────────────────────────────────────────────────────────

export function buildSeoHealthReport(result: SeoHealthResult): string {
  const lines: string[] = [];

  lines.push('## SEO Health Check');
  lines.push('');

  // Summary table
  lines.push('### Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Pages tested | ${result.pages_tested} |`);
  lines.push(`| Total issues | ${result.total_issues} |`);
  lines.push(`| Missing meta title | ${result.summary.missing_meta_title} |`);
  lines.push(`| Missing meta description | ${result.summary.missing_meta_description} |`);
  lines.push(`| Missing OG tags | ${result.summary.missing_og_tags} |`);
  lines.push(`| Missing canonical | ${result.summary.missing_canonical} |`);
  lines.push(`| Heading issues | ${result.summary.heading_issues} |`);
  lines.push(`| Missing structured data | ${result.summary.missing_structured_data} |`);
  lines.push(`| Missing hreflang | ${result.summary.missing_hreflang} |`);
  lines.push(`| Image alt coverage | ${result.summary.image_alt_coverage}% |`);
  lines.push(`| Sitemap accessible | ${result.sitemap_accessible ? 'Yes' : 'No'} |`);
  lines.push(`| Robots.txt accessible | ${result.robots_txt_accessible ? 'Yes' : 'No'} |`);
  lines.push('');

  // Issues grouped by severity
  const critical = result.issues.filter((i) => i.severity === 'critical');
  const major = result.issues.filter((i) => i.severity === 'major');
  const minor = result.issues.filter((i) => i.severity === 'minor');

  if (critical.length > 0) {
    lines.push('### Critical Issues');
    lines.push('');
    for (const issue of critical) {
      lines.push(`- **[${issue.page}]** ${issue.detail}`);
      lines.push(`  - URL: ${issue.url}`);
      lines.push(`  - Fix: ${issue.recommendation}`);
    }
    lines.push('');
  }

  if (major.length > 0) {
    lines.push('### Major Issues');
    lines.push('');
    for (const issue of major) {
      lines.push(`- **[${issue.page}]** ${issue.detail}`);
      lines.push(`  - URL: ${issue.url}`);
      lines.push(`  - Fix: ${issue.recommendation}`);
    }
    lines.push('');
  }

  if (minor.length > 0) {
    lines.push('### Minor Issues');
    lines.push('');
    for (const issue of minor) {
      lines.push(`- **[${issue.page}]** ${issue.detail}`);
      lines.push(`  - URL: ${issue.url}`);
      lines.push(`  - Fix: ${issue.recommendation}`);
    }
    lines.push('');
  }

  if (result.total_issues === 0) {
    lines.push('No SEO issues found. All checks passed.');
    lines.push('');
  }

  // Sitemap and robots status
  lines.push('### Sitemap & Robots.txt');
  lines.push('');
  lines.push(`- Sitemap: ${result.sitemap_accessible ? 'Accessible' : 'Not found'}`);
  lines.push(`- Robots.txt: ${result.robots_txt_accessible ? 'Accessible' : 'Not found'}`);
  lines.push('');

  return lines.join('\n');
}

// ── Layer 2 Trigger Builder ───────────────────────────────────────────────────

export function buildSeoL2Trigger(
  result: SeoHealthResult
): { id: string; priority: 'high' | 'medium' | 'low'; description: string; data: any } | null {
  if (result.total_issues === 0) return null;

  const criticalCount = result.issues.filter((i) => i.severity === 'critical').length;
  const majorCount = result.issues.filter((i) => i.severity === 'major').length;

  let priority: 'high' | 'medium' | 'low';
  if (criticalCount > 0) {
    priority = 'high';
  } else if (majorCount > 0) {
    priority = 'medium';
  } else {
    priority = 'low';
  }

  return {
    id: 'seo-issues',
    priority,
    description: `${result.total_issues} SEO issue(s) found across ${result.pages_tested} page(s): ${criticalCount} critical, ${majorCount} major, ${result.total_issues - criticalCount - majorCount} minor`,
    data: {
      issues: result.issues,
      summary: result.summary,
      sitemap_accessible: result.sitemap_accessible,
      robots_txt_accessible: result.robots_txt_accessible,
    },
  };
}
