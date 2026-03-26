import { Page } from 'playwright';
import { SiteConfig, CheckResult } from '../../types.js';
import { resolveUrl, logger } from '../../utils.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BreakpointIssue {
  page: string;
  url: string;
  viewport: string;  // e.g. "768x1024 (tablet portrait)"
  width: number;
  height: number;
  type: 'horizontal-overflow' | 'element-overflow' | 'text-truncation' | 'overlap' | 'touch-target';
  severity: 'major' | 'minor';
  detail: string;
  element?: string;
}

export interface ResponsiveResult {
  pages_tested: number;
  viewports_tested: number;
  total_issues: number;
  issues: BreakpointIssue[];
  summary: {
    overflow_issues: number;
    touch_target_issues: number;
    by_viewport: Record<string, number>;
  };
  checkResults: CheckResult[];
}

// ── Breakpoints ───────────────────────────────────────────────────────────────

const BREAKPOINTS = [
  { name: 'Mobile (375x812)', width: 375, height: 812 },
  { name: 'Tablet Portrait (768x1024)', width: 768, height: 1024 },
  { name: 'Tablet Landscape (1024x768)', width: 1024, height: 768 },
  { name: 'Small Desktop (1366x768)', width: 1366, height: 768 },
  { name: 'Large Desktop (1920x1080)', width: 1920, height: 1080 },
];

// ── Main check ────────────────────────────────────────────────────────────────

/**
 * Responsive breakpoint audit.
 * Tests key pages at multiple viewport sizes for horizontal overflow,
 * element overflow, and undersized touch targets.
 */
export async function runResponsiveCheck(
  page: Page,
  config: SiteConfig
): Promise<ResponsiveResult> {
  const pages = config.key_pages?.length
    ? config.key_pages.slice(0, 5)
    : [{ name: 'Homepage', path: '/' }];

  const issues: BreakpointIssue[] = [];
  let pagesTestedCount = 0;

  logger.info('Responsive breakpoint check starting');

  for (const pg of pages) {
    const url = resolveUrl(config.url, pg.path);
    pagesTestedCount++;

    for (const bp of BREAKPOINTS) {
      try {
        await page.setViewportSize({ width: bp.width, height: bp.height });

        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: config.timeout_ms || 30000,
        });

        // Allow layout to settle after viewport change
        await page.waitForTimeout(500);

        // ── Check 1: Horizontal overflow ────────────────────────────────
        const overflowData = await page.evaluate(() => {
          const scrollW = document.documentElement.scrollWidth;
          const clientW = document.documentElement.clientWidth;
          return {
            scrollWidth: scrollW,
            clientWidth: clientW,
            hasOverflow: scrollW > clientW,
            overflowPx: scrollW - clientW,
          };
        });

        if (overflowData.hasOverflow) {
          issues.push({
            page: pg.name,
            url,
            viewport: bp.name,
            width: bp.width,
            height: bp.height,
            type: 'horizontal-overflow',
            severity: bp.width <= 768 ? 'major' : 'minor',
            detail: `Page has horizontal scroll — content extends ${overflowData.overflowPx}px beyond viewport (scrollWidth: ${overflowData.scrollWidth}, clientWidth: ${overflowData.clientWidth})`,
          });
        }

        // ── Check 2: Element overflow ───────────────────────────────────
        const overflowingElements = await page.evaluate((viewportWidth: number) => {
          const threshold = viewportWidth + 5;
          const all = document.querySelectorAll('*');
          const results: { tag: string; className: string; right: number }[] = [];

          for (let i = 0; i < all.length && results.length < 20; i++) {
            const el = all[i] as HTMLElement;
            // Skip elements that are not visible
            if (el.offsetWidth === 0 && el.offsetHeight === 0) continue;
            const rect = el.getBoundingClientRect();
            if (rect.right > threshold) {
              results.push({
                tag: el.tagName.toLowerCase(),
                className: (el.className && typeof el.className === 'string')
                  ? el.className.split(/\s+/).slice(0, 3).join(' ')
                  : '',
                right: Math.round(rect.right),
              });
            }
          }
          return results;
        }, bp.width);

        for (const el of overflowingElements) {
          const selector = el.className
            ? `<${el.tag} class="${el.className}">`
            : `<${el.tag}>`;
          issues.push({
            page: pg.name,
            url,
            viewport: bp.name,
            width: bp.width,
            height: bp.height,
            type: 'element-overflow',
            severity: bp.width <= 768 ? 'major' : 'minor',
            detail: `Element extends to ${el.right}px (viewport is ${bp.width}px)`,
            element: selector,
          });
        }

        // ── Check 3: Touch targets (mobile/tablet only) ────────────────
        if (bp.width <= 1024) {
          const smallTargets = await page.evaluate(() => {
            const interactiveSelector = 'a, button, input, select, textarea, [role="button"]';
            const elements = document.querySelectorAll(interactiveSelector);
            const results: { tag: string; className: string; w: number; h: number; text: string }[] = [];

            for (let i = 0; i < elements.length && results.length < 10; i++) {
              const el = elements[i] as HTMLElement;
              const rect = el.getBoundingClientRect();
              // Skip hidden/invisible elements
              if (rect.width === 0 || rect.height === 0) continue;
              // Skip elements fully off-screen
              if (rect.bottom < 0 || rect.top > window.innerHeight * 2) continue;

              if (rect.width < 44 || rect.height < 44) {
                const text = (el.textContent || '').trim().slice(0, 40);
                results.push({
                  tag: el.tagName.toLowerCase(),
                  className: (el.className && typeof el.className === 'string')
                    ? el.className.split(/\s+/).slice(0, 3).join(' ')
                    : '',
                  w: Math.round(rect.width),
                  h: Math.round(rect.height),
                  text,
                });
              }
            }
            return results;
          });

          for (const target of smallTargets) {
            const selector = target.className
              ? `<${target.tag} class="${target.className}">`
              : `<${target.tag}>`;
            const label = target.text ? ` "${target.text}"` : '';
            issues.push({
              page: pg.name,
              url,
              viewport: bp.name,
              width: bp.width,
              height: bp.height,
              type: 'touch-target',
              severity: 'minor',
              detail: `Interactive element${label} is ${target.w}x${target.h}px — minimum recommended is 44x44px`,
              element: selector,
            });
          }
        }

        logger.info(`  ${pg.name} @ ${bp.name}: checked`);
      } catch (err: any) {
        logger.warn(`  ${pg.name} @ ${bp.name}: error — ${err.message.slice(0, 80)}`);
      }
    }
  }

  // Restore default viewport
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
  } catch {
    // Best effort restore
  }

  // ── Build summary ─────────────────────────────────────────────────────────

  const overflowIssues = issues.filter(
    (i) => i.type === 'horizontal-overflow' || i.type === 'element-overflow'
  );
  const touchTargetIssues = issues.filter((i) => i.type === 'touch-target');

  const byViewport: Record<string, number> = {};
  for (const issue of issues) {
    byViewport[issue.viewport] = (byViewport[issue.viewport] || 0) + 1;
  }

  // ── Build checkResults ────────────────────────────────────────────────────

  const checkResults: CheckResult[] = [];

  // Overflow check
  if (overflowIssues.length > 0) {
    const majorOverflows = overflowIssues.filter((i) => i.severity === 'major');
    checkResults.push({
      check: 'Responsive -- Overflow',
      status: majorOverflows.length > 0 ? 'FAIL' : 'WARN',
      detail: `${overflowIssues.length} overflow issue(s) detected across ${Object.keys(byViewport).length} viewport(s)`,
    });
  } else {
    checkResults.push({
      check: 'Responsive -- Overflow',
      status: 'PASS',
      detail: 'No horizontal overflow detected at any breakpoint',
    });
  }

  // Touch target check
  if (touchTargetIssues.length > 0) {
    checkResults.push({
      check: 'Responsive -- Touch Targets',
      status: 'WARN',
      detail: `${touchTargetIssues.length} interactive element(s) below 44x44px minimum on mobile/tablet viewports`,
    });
  } else {
    checkResults.push({
      check: 'Responsive -- Touch Targets',
      status: 'PASS',
      detail: 'All interactive elements meet 44x44px minimum on mobile/tablet',
    });
  }

  // Overall check
  const viewportSummaryParts = Object.entries(byViewport)
    .map(([vp, count]) => `${vp}: ${count}`)
    .join(', ');

  checkResults.push({
    check: 'Responsive -- Overall',
    status: issues.length === 0 ? 'PASS' : issues.some((i) => i.severity === 'major') ? 'FAIL' : 'WARN',
    detail: issues.length === 0
      ? `${pagesTestedCount} page(s) tested across ${BREAKPOINTS.length} viewports — no issues`
      : `${issues.length} issue(s) across viewports: ${viewportSummaryParts}`,
  });

  const result: ResponsiveResult = {
    pages_tested: pagesTestedCount,
    viewports_tested: BREAKPOINTS.length,
    total_issues: issues.length,
    issues,
    summary: {
      overflow_issues: overflowIssues.length,
      touch_target_issues: touchTargetIssues.length,
      by_viewport: byViewport,
    },
    checkResults,
  };

  logger.info(
    `Responsive check complete: ${pagesTestedCount} page(s), ${BREAKPOINTS.length} viewports, ${issues.length} issue(s)`
  );

  return result;
}

// ── Report builder ────────────────────────────────────────────────────────────

export function buildResponsiveReport(result: ResponsiveResult): string {
  const lines: string[] = [];

  lines.push('## Responsive Breakpoint Testing\n');

  // Summary table
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Pages tested | ${result.pages_tested} |`);
  lines.push(`| Viewports tested | ${result.viewports_tested} |`);
  lines.push(`| Total issues | ${result.total_issues} |`);
  lines.push(`| Overflow issues | ${result.summary.overflow_issues} |`);
  lines.push(`| Touch target issues | ${result.summary.touch_target_issues} |`);
  lines.push('');

  if (result.total_issues === 0) {
    lines.push('All pages pass responsive checks across all breakpoints.\n');
    return lines.join('\n');
  }

  // Issues by viewport
  lines.push('### Issues by Viewport\n');
  lines.push('| Viewport | Issues |');
  lines.push('|----------|--------|');
  for (const [viewport, count] of Object.entries(result.summary.by_viewport)) {
    lines.push(`| ${viewport} | ${count} |`);
  }
  lines.push('');

  // Detailed issues table
  lines.push('### Issue Details\n');
  lines.push('| Page | Viewport | Type | Severity | Detail | Element |');
  lines.push('|------|----------|------|----------|--------|---------|');
  for (const issue of result.issues) {
    const element = issue.element ? `\`${issue.element}\`` : '--';
    lines.push(
      `| ${issue.page} | ${issue.viewport} | ${issue.type} | ${issue.severity} | ${issue.detail} | ${element} |`
    );
  }
  lines.push('');

  return lines.join('\n');
}

// ── Layer 2 trigger builder ───────────────────────────────────────────────────

export function buildResponsiveL2Trigger(result: ResponsiveResult): {
  id: string;
  priority: 'high' | 'medium' | 'low';
  description: string;
  data: any;
} | null {
  if (result.total_issues === 0) return null;

  const majorIssues = result.issues.filter((i) => i.severity === 'major');
  const hasOverflow = result.summary.overflow_issues > 0;
  const hasTouchIssues = result.summary.touch_target_issues > 0;

  const priority: 'high' | 'medium' | 'low' =
    majorIssues.length > 0 ? 'high' : hasTouchIssues ? 'medium' : 'low';

  const parts: string[] = [];
  if (hasOverflow) {
    parts.push(`${result.summary.overflow_issues} overflow issue(s)`);
  }
  if (hasTouchIssues) {
    parts.push(`${result.summary.touch_target_issues} undersized touch target(s)`);
  }

  const affectedPages = [...new Set(result.issues.map((i) => i.url))];
  const affectedViewports = [...new Set(result.issues.map((i) => i.viewport))];

  return {
    id: 'responsive-breakpoints',
    priority,
    description: `${result.total_issues} responsive issue(s) detected: ${parts.join(', ')}. Affected viewports: ${affectedViewports.join(', ')}. Investigate layout breaks, overflow causes, and touch target sizing.`,
    data: {
      totalIssues: result.total_issues,
      majorIssues: majorIssues.length,
      overflowIssues: result.summary.overflow_issues,
      touchTargetIssues: result.summary.touch_target_issues,
      byViewport: result.summary.by_viewport,
      affectedPages,
      affectedViewports,
    },
  };
}
