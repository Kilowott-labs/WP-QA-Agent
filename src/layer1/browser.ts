import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { ConsoleError, NetworkFailure, NetworkRequest } from '../types.js';
import { isThirdParty } from '../utils.js';

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  consoleErrors: ConsoleError[];
  networkFailures: NetworkFailure[];
  networkRequests: NetworkRequest[];
  close: () => Promise<void>;
}

/**
 * Launch a Playwright browser with console + network listeners attached.
 * Every page navigation automatically captures errors and requests.
 */
export async function launchBrowser(siteUrl: string): Promise<BrowserSession> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  const consoleErrors: ConsoleError[] = [];
  const networkFailures: NetworkFailure[] = [];
  const networkRequests: NetworkRequest[] = [];

  // Console listener
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      consoleErrors.push({
        type: msg.type(),
        message: msg.text(),
        url: page.url(),
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Page error listener (uncaught exceptions)
  page.on('pageerror', (err) => {
    consoleErrors.push({
      type: 'exception',
      message: err.message,
      url: page.url(),
      timestamp: new Date().toISOString(),
    });
  });

  // Network request tracking
  const requestTimings = new Map<string, number>();

  page.on('request', (req) => {
    requestTimings.set(req.url(), Date.now());
  });

  page.on('requestfailed', (req) => {
    const failure = req.failure();
    networkFailures.push({
      url: req.url(),
      method: req.method(),
      reason: failure?.errorText || 'Unknown',
    });
  });

  page.on('response', (res) => {
    const startTime = requestTimings.get(res.url()) || Date.now();
    const duration = Date.now() - startTime;
    const status = res.status();

    const nr: NetworkRequest = {
      url: res.url(),
      method: res.request().method(),
      status,
      type: res.request().resourceType(),
      duration_ms: duration,
      is_failed: status >= 400,
      is_third_party: isThirdParty(res.url(), siteUrl),
    };
    networkRequests.push(nr);

    if (status >= 400) {
      networkFailures.push({
        url: res.url(),
        method: res.request().method(),
        status,
        reason: `HTTP ${status}`,
      });
    }
  });

  return {
    browser,
    context,
    page,
    consoleErrors,
    networkFailures,
    networkRequests,
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}

/**
 * Create a mobile viewport context on an existing browser.
 */
export async function createMobileContext(
  browser: Browser,
  siteUrl: string,
  viewport = { width: 375, height: 812 }
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  return { context, page };
}
