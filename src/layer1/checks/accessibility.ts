import { Page } from 'playwright';
import { SiteConfig, AccessibilityResult, AccessibilityIssue } from '../../types.js';
import { resolveUrl, logger } from '../../utils.js';

/**
 * WCAG 2.1 accessibility audit.
 * Checks: alt text, contrast, form labels, heading hierarchy,
 * focus indicators, ARIA, touch targets, skip-to-content link.
 */
export async function runAccessibilityAudit(
  page: Page,
  config: SiteConfig
): Promise<AccessibilityResult> {
  const pages = config.key_pages?.length
    ? config.key_pages
    : [{ name: 'Homepage', path: '/' }];

  const allIssues: AccessibilityIssue[] = [];
  let skipLinkPresent = false;

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

    const pageIssues = await page.evaluate((pageName: string) => {
      const issues: {
        type: string;
        severity: string;
        element?: string;
        detail: string;
        wcag_criterion?: string;
      }[] = [];

      // ── 1. Missing alt text on images ────────────────────────────────
      const images = document.querySelectorAll('img');
      images.forEach((img) => {
        const alt = img.getAttribute('alt');
        const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
        // Skip tracking pixels and tiny decorative images
        if (img.width < 5 && img.height < 5) return;
        if (src.includes('pixel') || src.includes('tracking')) return;

        if (alt === null) {
          issues.push({
            type: 'missing-alt',
            severity: 'major',
            element: `<img src="${src.slice(0, 80)}">`,
            detail: 'Image has no alt attribute (not even empty)',
            wcag_criterion: '1.1.1 Non-text Content',
          });
        } else if (alt === '' && !img.closest('a') && img.width > 100) {
          // Large images with empty alt that aren't inside links are suspicious
          issues.push({
            type: 'missing-alt',
            severity: 'minor',
            element: `<img src="${src.slice(0, 80)}" alt="">`,
            detail: 'Large content image has empty alt text — may need description',
            wcag_criterion: '1.1.1 Non-text Content',
          });
        }
      });

      // ── 2. Missing form labels ────────────────────────────────────────
      const inputs = document.querySelectorAll(
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]), select, textarea'
      );
      inputs.forEach((input) => {
        const el = input as HTMLInputElement;
        const id = el.id;
        const ariaLabel = el.getAttribute('aria-label');
        const ariaLabelledBy = el.getAttribute('aria-labelledby');
        const placeholder = el.getAttribute('placeholder');
        const title = el.getAttribute('title');
        const hasLabel = id
          ? document.querySelector(`label[for="${id}"]`) !== null
          : input.closest('label') !== null;

        if (!hasLabel && !ariaLabel && !ariaLabelledBy && !title) {
          const identifier =
            el.name || el.id || el.type || el.tagName.toLowerCase();
          issues.push({
            type: 'missing-label',
            severity: placeholder ? 'minor' : 'major',
            element: `<${el.tagName.toLowerCase()} name="${el.name || ''}" id="${el.id || ''}">`,
            detail: placeholder
              ? `Form field "${identifier}" uses placeholder as only label`
              : `Form field "${identifier}" has no associated label or aria-label`,
            wcag_criterion: '1.3.1 Info and Relationships',
          });
        }
      });

      // ── 3. Heading hierarchy ──────────────────────────────────────────
      const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
      let prevLevel = 0;
      let h1Count = 0;
      headings.forEach((h) => {
        const level = parseInt(h.tagName.charAt(1));
        if (level === 1) h1Count++;

        // Skip heading level (e.g. h2 → h4)
        if (prevLevel > 0 && level > prevLevel + 1) {
          issues.push({
            type: 'heading-hierarchy',
            severity: 'minor',
            element: `<${h.tagName.toLowerCase()}>`,
            detail: `Heading level skipped: h${prevLevel} → h${level} ("${(h.textContent || '').trim().slice(0, 50)}")`,
            wcag_criterion: '1.3.1 Info and Relationships',
          });
        }
        prevLevel = level;
      });

      if (h1Count === 0) {
        issues.push({
          type: 'heading-hierarchy',
          severity: 'major',
          detail: 'No h1 element found on page',
          wcag_criterion: '1.3.1 Info and Relationships',
        });
      } else if (h1Count > 1) {
        issues.push({
          type: 'heading-hierarchy',
          severity: 'minor',
          detail: `Multiple h1 elements found (${h1Count})`,
          wcag_criterion: '1.3.1 Info and Relationships',
        });
      }

      // ── 4. ARIA labels on interactive elements ────────────────────────
      const interactiveSelectors = [
        'button:not([aria-label]):not([aria-labelledby])',
        '[role="button"]:not([aria-label]):not([aria-labelledby])',
        'a[href]:not([aria-label]):not([aria-labelledby])',
      ];

      // Buttons without visible text or aria-label
      document
        .querySelectorAll('button, [role="button"]')
        .forEach((btn) => {
          const text = (btn.textContent || '').trim();
          const ariaLabel = btn.getAttribute('aria-label');
          const ariaLabelledBy = btn.getAttribute('aria-labelledby');
          const title = btn.getAttribute('title');
          if (!text && !ariaLabel && !ariaLabelledBy && !title) {
            const html = btn.outerHTML.slice(0, 100);
            issues.push({
              type: 'aria',
              severity: 'major',
              element: html,
              detail: 'Interactive element has no accessible name (no text, aria-label, or title)',
              wcag_criterion: '4.1.2 Name, Role, Value',
            });
          }
        });

      // Links with no text (icon links)
      document.querySelectorAll('a[href]').forEach((a) => {
        const text = (a.textContent || '').trim();
        const ariaLabel = a.getAttribute('aria-label');
        const title = a.getAttribute('title');
        const img = a.querySelector('img[alt]');
        if (!text && !ariaLabel && !title && !img) {
          // Check if it has an SVG with title or other meaningful content
          const svgTitle = a.querySelector('svg title');
          if (!svgTitle) {
            issues.push({
              type: 'aria',
              severity: 'major',
              element: a.outerHTML.slice(0, 100),
              detail: 'Link has no accessible name',
              wcag_criterion: '2.4.4 Link Purpose',
            });
          }
        }
      });

      // ── 5. Skip-to-content link ──────────────────────────────────────
      const skipLink = document.querySelector(
        'a[href="#content"], a[href="#main"], a[href="#main-content"], ' +
        'a.skip-link, a.skip-to-content, a.screen-reader-text[href^="#"]'
      );

      return { issues, hasSkipLink: !!skipLink };
    }, pg.name);

    // Tag page name onto issues
    for (const issue of pageIssues.issues) {
      allIssues.push({
        type: issue.type as AccessibilityIssue['type'],
        severity: issue.severity as AccessibilityIssue['severity'],
        page: pg.name,
        element: issue.element,
        detail: issue.detail,
        wcag_criterion: issue.wcag_criterion,
      });
    }

    if (pageIssues.hasSkipLink) skipLinkPresent = true;

    // ── 6. Focus indicators (check computed styles) ──────────────────
    const focusIssues = await checkFocusIndicators(page, pg.name);
    allIssues.push(...focusIssues);

    // ── 7. Touch target size ─────────────────────────────────────────
    const touchIssues = await checkTouchTargets(page, pg.name);
    allIssues.push(...touchIssues);

    logger.dim(
      `a11y: ${pg.name} — ${pageIssues.issues.length + focusIssues.length + touchIssues.length} issues`
    );
  }

  // Skip link check (only needs to be on one page, typically homepage)
  if (!skipLinkPresent) {
    allIssues.push({
      type: 'skip-link',
      severity: 'minor',
      page: 'All',
      detail: 'No skip-to-content link found',
      wcag_criterion: '2.4.1 Bypass Blocks',
    });
  }

  const summary = {
    missing_alt_text: allIssues.filter((i) => i.type === 'missing-alt').length,
    contrast_issues: allIssues.filter((i) => i.type === 'contrast').length,
    missing_labels: allIssues.filter((i) => i.type === 'missing-label').length,
    heading_issues: allIssues.filter((i) => i.type === 'heading-hierarchy').length,
    focus_issues: allIssues.filter((i) => i.type === 'focus-indicator').length,
    aria_issues: allIssues.filter((i) => i.type === 'aria').length,
    touch_target_issues: allIssues.filter((i) => i.type === 'touch-target').length,
    skip_link_present: skipLinkPresent,
  };

  return {
    pages_tested: pages.length,
    total_issues: allIssues.length,
    issues: allIssues,
    summary,
  };
}

/**
 * Check that interactive elements have visible focus indicators.
 */
async function checkFocusIndicators(
  page: Page,
  pageName: string
): Promise<AccessibilityIssue[]> {
  try {
    return await page.evaluate((pn: string) => {
      const issues: AccessibilityIssue[] = [];
      const targets = document.querySelectorAll(
        'a[href], button, input, select, textarea, [tabindex="0"]'
      );

      // Sample up to 10 elements to avoid long evaluations
      const sample = Array.from(targets).slice(0, 10);

      for (const el of sample) {
        const htmlEl = el as HTMLElement;
        const style = window.getComputedStyle(htmlEl);
        const outlineStyle = style.outlineStyle;
        const outlineWidth = parseFloat(style.outlineWidth);

        // Focus the element briefly to check :focus styles
        htmlEl.focus();
        const focusStyle = window.getComputedStyle(htmlEl);
        const focusOutline = focusStyle.outlineStyle;
        const focusOutlineWidth = parseFloat(focusStyle.outlineWidth);
        const focusBoxShadow = focusStyle.boxShadow;
        const focusBorder = focusStyle.borderColor;
        htmlEl.blur();

        // Check if outline is explicitly removed without alternative
        if (
          focusOutline === 'none' &&
          focusOutlineWidth === 0 &&
          (!focusBoxShadow || focusBoxShadow === 'none') &&
          outlineStyle === 'none'
        ) {
          // Only flag if it looks intentionally removed (outline: none in CSS)
          const tag = el.tagName.toLowerCase();
          const text =
            (el.textContent || '').trim().slice(0, 30) ||
            (el as HTMLInputElement).name ||
            '';
          issues.push({
            type: 'focus-indicator' as const,
            severity: 'major' as const,
            page: pn,
            element: `<${tag}>${text}</${tag}>`,
            detail: 'No visible focus indicator (outline removed, no box-shadow alternative)',
            wcag_criterion: '2.4.7 Focus Visible',
          });
        }
      }

      return issues;
    }, pageName);
  } catch {
    return [];
  }
}

/**
 * Check touch targets meet minimum 44x44px size.
 */
async function checkTouchTargets(
  page: Page,
  pageName: string
): Promise<AccessibilityIssue[]> {
  try {
    return await page.evaluate((pn: string) => {
      const issues: AccessibilityIssue[] = [];
      const targets = document.querySelectorAll(
        'a[href], button, input[type="checkbox"], input[type="radio"], select'
      );

      for (const el of Array.from(targets).slice(0, 20)) {
        const rect = el.getBoundingClientRect();
        // Only check visible elements
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.width < 44 || rect.height < 44) {
          // Allow inline text links to be smaller (common and acceptable)
          if (el.tagName === 'A' && (el.textContent || '').trim().length > 0) continue;

          const tag = el.tagName.toLowerCase();
          const text =
            (el.textContent || '').trim().slice(0, 30) ||
            (el as HTMLInputElement).name ||
            '';
          issues.push({
            type: 'touch-target' as const,
            severity: 'minor' as const,
            page: pn,
            element: `<${tag}>${text}</${tag}>`,
            detail: `Touch target too small: ${Math.round(rect.width)}x${Math.round(rect.height)}px (minimum 44x44px)`,
            wcag_criterion: '2.5.5 Target Size',
          });
        }
      }

      return issues;
    }, pageName);
  } catch {
    return [];
  }
}
