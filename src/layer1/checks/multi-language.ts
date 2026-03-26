import { Page } from 'playwright';
import { SiteConfig, CheckResult } from '../../types.js';
import { resolveUrl, getAuthHeader, logger } from '../../utils.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface LanguageInfo {
  code: string;       // e.g. 'en', 'no', 'fr'
  name: string;       // e.g. 'English', 'Norsk'
  url?: string;       // language-specific URL if found
  is_default: boolean;
}

export interface MultiLangIssue {
  page: string;
  url: string;
  severity: 'major' | 'minor';
  type: string;
  detail: string;
  recommendation: string;
}

export interface MultiLanguageResult {
  plugin_detected: string | null;  // 'wpml' | 'polylang' | 'translatepress' | 'weglot' | null
  languages_found: LanguageInfo[];
  is_multilingual: boolean;
  pages_tested: number;
  total_issues: number;
  issues: MultiLangIssue[];
  summary: {
    missing_hreflang: number;
    missing_translations: number;
    switcher_issues: number;
  };
  checkResults: CheckResult[];
}

// ── Known plugin slugs mapped to canonical names ─────────────────────────

const PLUGIN_MATCHERS: Array<{ pattern: string; name: string }> = [
  { pattern: 'wpml', name: 'wpml' },
  { pattern: 'sitepress', name: 'wpml' },
  { pattern: 'polylang', name: 'polylang' },
  { pattern: 'translatepress', name: 'translatepress' },
  { pattern: 'weglot', name: 'weglot' },
];

// ── Switcher selectors per plugin ────────────────────────────────────────

const SWITCHER_SELECTORS: Record<string, string[]> = {
  wpml: ['.wpml-ls', '#wpml-ls', '[class*="wpml-ls"]'],
  polylang: ['.polylang-switcher', '.pll-switcher', '[class*="polylang"]', '.lang-item'],
  translatepress: ['#trp-floater-ls', '.trp-language-switcher', '[class*="trp-"]'],
  weglot: ['.weglot-container', '.weglot_switcher', '#weglot-switcher', '[class*="weglot"]'],
};

// ── Body class patterns per plugin ───────────────────────────────────────

const BODY_CLASS_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /\bwpml\b/i, name: 'wpml' },
  { pattern: /\bpolylang\b/i, name: 'polylang' },
  { pattern: /\btrp-/i, name: 'translatepress' },
  { pattern: /\bweglot\b/i, name: 'weglot' },
];

// ── Language code to human name mapping ──────────────────────────────────

const LANG_NAMES: Record<string, string> = {
  en: 'English', no: 'Norsk', nb: 'Norsk Bokmal', nn: 'Norsk Nynorsk',
  sv: 'Svenska', da: 'Dansk', fi: 'Suomi', de: 'Deutsch', fr: 'Francais',
  es: 'Espanol', it: 'Italiano', pt: 'Portugues', nl: 'Nederlands',
  pl: 'Polski', ru: 'Russian', ja: 'Japanese', zh: 'Chinese',
  ko: 'Korean', ar: 'Arabic', hi: 'Hindi', tr: 'Turkish',
};

function langName(code: string): string {
  const base = code.split('-')[0].toLowerCase();
  return LANG_NAMES[base] || code.toUpperCase();
}

// ── Safe fetch with timeout ──────────────────────────────────────────────

async function safeFetch(
  url: string,
  method: 'HEAD' | 'GET' = 'HEAD',
  timeoutMs = 10000
): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetch(url, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'wp-qa-agent/1.0' },
      redirect: 'follow',
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

// ── Main check ───────────────────────────────────────────────────────────

export async function runMultiLanguageCheck(
  page: Page,
  config: SiteConfig,
  pluginList: Array<{ slug: string; status: string }>
): Promise<MultiLanguageResult> {
  const result: MultiLanguageResult = {
    plugin_detected: null,
    languages_found: [],
    is_multilingual: false,
    pages_tested: 0,
    total_issues: 0,
    issues: [],
    summary: {
      missing_hreflang: 0,
      missing_translations: 0,
      switcher_issues: 0,
    },
    checkResults: [],
  };

  logger.info('Checking for multilingual plugins...');

  // ── Step 1: Detect from plugin list ────────────────────────────────────

  const activePlugins = pluginList.filter(p => p.status === 'active');

  for (const plugin of activePlugins) {
    const slugLower = plugin.slug.toLowerCase();
    for (const matcher of PLUGIN_MATCHERS) {
      if (slugLower.includes(matcher.pattern)) {
        result.plugin_detected = matcher.name;
        break;
      }
    }
    if (result.plugin_detected) break;
  }

  if (result.plugin_detected) {
    logger.info(`Multilingual plugin detected from plugin list: ${result.plugin_detected}`);
  }

  // ── Step 2: If no plugin found, check homepage DOM ─────────────────────

  if (!result.plugin_detected) {
    logger.info('No multilingual plugin found in plugin list, checking homepage DOM...');

    try {
      const homeUrl = resolveUrl(config.url, '/');
      await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

      // Check body classes
      const bodyClass = await page.evaluate(() => {
        const body = document.querySelector('body');
        return body ? body.className : '';
      });

      for (const bp of BODY_CLASS_PATTERNS) {
        if (bp.pattern.test(bodyClass)) {
          result.plugin_detected = bp.name;
          logger.info(`Multilingual plugin detected from body class: ${bp.name}`);
          break;
        }
      }

      // Check hreflang tags
      if (!result.plugin_detected) {
        const hreflangCount = await page.evaluate(() => {
          return document.querySelectorAll('link[rel="alternate"][hreflang]').length;
        });
        if (hreflangCount > 0) {
          result.plugin_detected = 'unknown';
          logger.info(`Hreflang tags found (${hreflangCount}), multilingual site detected`);
        }
      }

      // Check language switcher elements
      if (!result.plugin_detected) {
        for (const [pluginName, selectors] of Object.entries(SWITCHER_SELECTORS)) {
          for (const selector of selectors) {
            const found = await page.evaluate(
              (sel: string) => document.querySelector(sel) !== null,
              selector
            );
            if (found) {
              result.plugin_detected = pluginName;
              logger.info(`Language switcher element found for: ${pluginName}`);
              break;
            }
          }
          if (result.plugin_detected) break;
        }
      }
    } catch (err) {
      logger.warn(`Failed to check homepage DOM for multilingual signs: ${String(err)}`);
    }
  }

  // ── Step 3: If still not multilingual, return early ────────────────────

  if (!result.plugin_detected) {
    result.is_multilingual = false;
    result.checkResults.push({
      check: 'Multi-Language -- Detection',
      status: 'SKIP',
      detail: 'No multilingual plugin or configuration detected on this site.',
    });
    logger.info('Site is not multilingual. Skipping language checks.');
    return result;
  }

  result.is_multilingual = true;

  // ── Step 4: Test pages for hreflang, switcher, translations ────────────

  const pagesToTest = buildPageList(config).slice(0, 5);
  result.pages_tested = pagesToTest.length;

  let pagesWithHreflang = 0;
  let pagesWithSwitcher = 0;
  const allLanguages = new Map<string, LanguageInfo>();

  for (const testPage of pagesToTest) {
    const fullUrl = resolveUrl(config.url, testPage.path);
    logger.info(`Testing multilingual on: ${testPage.name} (${fullUrl})`);

    try {
      await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

      // ── 4a. Hreflang tags ──────────────────────────────────────────────

      const hreflangData = await page.evaluate(() => {
        const tags = document.querySelectorAll('link[rel="alternate"][hreflang]');
        return Array.from(tags).map(tag => ({
          lang: tag.getAttribute('hreflang') || '',
          href: tag.getAttribute('href') || '',
        }));
      });

      if (hreflangData.length > 0) {
        pagesWithHreflang++;
        for (const tag of hreflangData) {
          if (tag.lang && tag.lang !== 'x-default') {
            const existing = allLanguages.get(tag.lang);
            if (!existing) {
              allLanguages.set(tag.lang, {
                code: tag.lang,
                name: langName(tag.lang),
                url: tag.href || undefined,
                is_default: false,
              });
            }
          }
        }
      } else {
        result.summary.missing_hreflang++;
        result.issues.push({
          page: testPage.name,
          url: fullUrl,
          severity: 'major',
          type: 'missing_hreflang',
          detail: `No hreflang tags found on ${testPage.name}. Search engines cannot associate language versions.`,
          recommendation: 'Add <link rel="alternate" hreflang="..."> tags for each language version of this page.',
        });
      }

      // ── 4b. Language switcher ──────────────────────────────────────────

      const switcherSelectors = result.plugin_detected && result.plugin_detected !== 'unknown'
        ? SWITCHER_SELECTORS[result.plugin_detected] || []
        : Object.values(SWITCHER_SELECTORS).flat();

      let switcherFound = false;
      for (const selector of switcherSelectors) {
        const exists = await page.evaluate(
          (sel: string) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden';
          },
          selector
        );
        if (exists) {
          switcherFound = true;
          break;
        }
      }

      if (switcherFound) {
        pagesWithSwitcher++;
      } else {
        result.summary.switcher_issues++;
        result.issues.push({
          page: testPage.name,
          url: fullUrl,
          severity: 'minor',
          type: 'missing_switcher',
          detail: `No visible language switcher found on ${testPage.name}. Users cannot change language from this page.`,
          recommendation: 'Ensure the language switcher widget or menu item is visible on all pages.',
        });
      }

      // ── 4c. Default language from html[lang] ──────────────────────────

      const htmlLang = await page.evaluate(() => {
        const html = document.documentElement;
        return html.getAttribute('lang') || '';
      });

      if (htmlLang) {
        const baseLang = htmlLang.split('-')[0].toLowerCase();
        const existing = allLanguages.get(htmlLang) || allLanguages.get(baseLang);
        if (existing) {
          existing.is_default = true;
        } else {
          allLanguages.set(baseLang, {
            code: baseLang,
            name: langName(baseLang),
            url: fullUrl,
            is_default: true,
          });
        }
      }
    } catch (err) {
      logger.warn(`Failed to test ${testPage.name}: ${String(err)}`);
    }
  }

  // ── Step 5: Verify alternate language URLs respond with 200 ────────────

  const hreflangUrls: Array<{ lang: string; url: string }> = [];
  for (const lang of allLanguages.values()) {
    if (lang.url) {
      hreflangUrls.push({ lang: lang.code, url: lang.url });
    }
  }

  if (hreflangUrls.length > 0) {
    logger.info(`Verifying ${hreflangUrls.length} alternate language URLs...`);

    for (const entry of hreflangUrls) {
      const { ok, status } = await safeFetch(entry.url);
      if (!ok) {
        result.summary.missing_translations++;
        result.issues.push({
          page: `hreflang (${entry.lang})`,
          url: entry.url,
          severity: 'major',
          type: 'broken_translation',
          detail: `Alternate URL for language "${entry.lang}" returned status ${status || 'connection error'}. The hreflang tag points to a page that does not load.`,
          recommendation: `Verify the translation exists for language "${entry.lang}" at ${entry.url}. Remove or fix the hreflang tag if the page does not exist.`,
        });
      }
    }
  }

  // ── Compile results ────────────────────────────────────────────────────

  result.languages_found = Array.from(allLanguages.values());
  result.total_issues = result.issues.length;

  // ── Build checkResults ─────────────────────────────────────────────────

  result.checkResults.push({
    check: 'Multi-Language -- Detection',
    status: 'PASS',
    detail: `Multilingual plugin detected: ${result.plugin_detected}. Found ${result.languages_found.length} language(s).`,
  });

  if (result.summary.missing_hreflang > 0) {
    result.checkResults.push({
      check: 'Multi-Language -- Hreflang Tags',
      status: 'WARN',
      detail: `${result.summary.missing_hreflang} of ${result.pages_tested} tested pages are missing hreflang tags.`,
    });
  } else if (result.pages_tested > 0) {
    result.checkResults.push({
      check: 'Multi-Language -- Hreflang Tags',
      status: 'PASS',
      detail: `All ${result.pages_tested} tested pages have hreflang tags.`,
    });
  }

  if (result.summary.switcher_issues > 0) {
    result.checkResults.push({
      check: 'Multi-Language -- Language Switcher',
      status: 'WARN',
      detail: `${result.summary.switcher_issues} of ${result.pages_tested} tested pages are missing a visible language switcher.`,
    });
  } else if (result.pages_tested > 0) {
    result.checkResults.push({
      check: 'Multi-Language -- Language Switcher',
      status: 'PASS',
      detail: 'Language switcher is visible on all tested pages.',
    });
  }

  // Overall
  if (result.total_issues === 0) {
    result.checkResults.push({
      check: 'Multi-Language -- Overall',
      status: 'PASS',
      detail: `Multilingual setup (${result.plugin_detected}) looks correct. ${result.languages_found.length} languages, no issues found.`,
    });
  } else {
    const hasMajor = result.issues.some(i => i.severity === 'major');
    result.checkResults.push({
      check: 'Multi-Language -- Overall',
      status: hasMajor ? 'WARN' : 'PASS',
      detail: `${result.total_issues} issue(s) found across ${result.pages_tested} pages (${result.summary.missing_hreflang} hreflang, ${result.summary.missing_translations} translation, ${result.summary.switcher_issues} switcher).`,
    });
  }

  logger.info(`Multi-language check complete: ${result.total_issues} issue(s) found`);
  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function buildPageList(config: SiteConfig): Array<{ name: string; path: string }> {
  if (config.key_pages && config.key_pages.length > 0) {
    return config.key_pages.map(p => ({ name: p.name, path: p.path }));
  }
  return [
    { name: 'Homepage', path: '/' },
    { name: 'Shop', path: '/shop/' },
    { name: 'Cart', path: '/cart/' },
    { name: 'Checkout', path: '/checkout/' },
    { name: 'My Account', path: '/my-account/' },
  ];
}

// ── Report builder ───────────────────────────────────────────────────────

export function buildMultiLanguageReport(result: MultiLanguageResult): string {
  const lines: string[] = [];
  lines.push('## Multi-Language');
  lines.push('');

  if (!result.is_multilingual) {
    lines.push('No multilingual plugin or configuration detected on this site.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push(`**Plugin detected:** ${result.plugin_detected}`);
  lines.push(`**Pages tested:** ${result.pages_tested}`);
  lines.push(`**Total issues:** ${result.total_issues}`);
  lines.push('');

  // Languages table
  if (result.languages_found.length > 0) {
    lines.push('### Languages Found');
    lines.push('');
    lines.push('| Code | Name | Default | URL |');
    lines.push('|------|------|---------|-----|');
    for (const lang of result.languages_found) {
      const defaultMark = lang.is_default ? 'Yes' : '';
      const urlDisplay = lang.url || '--';
      lines.push(`| ${lang.code} | ${lang.name} | ${defaultMark} | ${urlDisplay} |`);
    }
    lines.push('');
  }

  // Summary
  lines.push('### Summary');
  lines.push('');
  lines.push(`- Missing hreflang tags: ${result.summary.missing_hreflang}`);
  lines.push(`- Broken/missing translations: ${result.summary.missing_translations}`);
  lines.push(`- Language switcher issues: ${result.summary.switcher_issues}`);
  lines.push('');

  // Issues
  if (result.issues.length > 0) {
    lines.push('### Issues');
    lines.push('');
    for (const issue of result.issues) {
      const sevLabel = issue.severity === 'major' ? '[MAJOR]' : '[MINOR]';
      lines.push(`**${sevLabel} ${issue.type}** -- ${issue.page}`);
      lines.push(`  URL: ${issue.url}`);
      lines.push(`  ${issue.detail}`);
      lines.push(`  Recommendation: ${issue.recommendation}`);
      lines.push('');
    }
  } else {
    lines.push('No issues found. Multilingual setup is correctly configured.');
    lines.push('');
  }

  return lines.join('\n');
}

// ── Layer 2 trigger builder ──────────────────────────────────────────────

export function buildMultiLanguageL2Trigger(
  result: MultiLanguageResult
): { id: string; priority: 'high' | 'medium' | 'low'; description: string; data: any } | null {
  if (!result.is_multilingual || result.total_issues === 0) {
    return null;
  }

  const hasMajor = result.issues.some(i => i.severity === 'major');

  return {
    id: 'multi-language-issues',
    priority: hasMajor ? 'high' : 'medium',
    description: `${result.total_issues} multilingual issue(s) detected (plugin: ${result.plugin_detected}). ${result.summary.missing_hreflang} missing hreflang, ${result.summary.missing_translations} broken translations, ${result.summary.switcher_issues} switcher problems.`,
    data: {
      plugin: result.plugin_detected,
      languages: result.languages_found,
      issues: result.issues,
      summary: result.summary,
    },
  };
}
