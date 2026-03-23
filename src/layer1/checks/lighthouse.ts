import { LighthouseResult, ScoreSet, CoreWebVitals } from '../../types.js';
import { logger } from '../../utils.js';

const API_BASE = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

// Retry delays in ms for exponential backoff on 429
const RETRY_DELAYS = [15_000, 30_000, 60_000];

/**
 * Run PageSpeed Insights API for mobile + desktop.
 * Free tier, no key required (optional key for higher rate limits).
 *
 * Uses exponential backoff on 429 (up to 3 retries) and a gap
 * between mobile/desktop requests to avoid consecutive rate limits.
 */
export async function runLighthouse(url: string): Promise<LighthouseResult> {
  const categories = ['performance', 'accessibility', 'best-practices', 'seo'];

  async function fetchStrategy(strategy: 'mobile' | 'desktop') {
    const catParams = categories.map((c) => `category=${c}`).join('&');
    const apiKey = process.env.PAGESPEED_API_KEY;
    const keyParam = apiKey ? `&key=${apiKey}` : '';
    const fullUrl = `${API_BASE}?url=${encodeURIComponent(url)}&strategy=${strategy}&${catParams}${keyParam}`;

    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try {
        const res = await fetch(fullUrl, { signal: AbortSignal.timeout(120_000) });

        if (res.status === 429 && attempt < RETRY_DELAYS.length) {
          const delay = RETRY_DELAYS[attempt];
          logger.warn(`Lighthouse ${strategy} rate-limited (429), retrying in ${delay / 1000}s... (attempt ${attempt + 1}/${RETRY_DELAYS.length})`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        if (!res.ok) {
          // On final 429, return null instead of throwing — partial results are better than none
          if (res.status === 429) {
            logger.warn(`Lighthouse ${strategy} still rate-limited after ${RETRY_DELAYS.length} retries. Skipping.`);
            logger.warn('Tip: set PAGESPEED_API_KEY in .env for higher rate limits (free at console.developers.google.com)');
            return null;
          }
          throw new Error(`PageSpeed API ${strategy}: HTTP ${res.status}`);
        }

        return await res.json();
      } catch (err: any) {
        if (err.name === 'TimeoutError' && attempt < RETRY_DELAYS.length) {
          logger.warn(`Lighthouse ${strategy} timed out, retrying...`);
          continue;
        }
        throw err;
      }
    }
    return null;
  }

  // Run sequentially with a gap to avoid hitting rate limits
  const mobileData = await fetchStrategy('mobile').catch((e) => {
    logger.warn(`Lighthouse mobile failed: ${e.message}`);
    return null;
  });

  // Wait between requests to reduce 429 risk
  if (mobileData !== null) {
    await new Promise((r) => setTimeout(r, 5000));
  }

  const desktopData = await fetchStrategy('desktop').catch((e) => {
    logger.warn(`Lighthouse desktop failed: ${e.message}`);
    return null;
  });

  const result: LighthouseResult = {
    url,
    mobile: extractScores(mobileData),
    desktop: extractScores(desktopData),
    core_web_vitals: extractCWV(mobileData || desktopData),
  };

  // Log if we got no data at all
  if (!mobileData && !desktopData) {
    logger.warn('Lighthouse: no data from either strategy. All scores will be 0.');
  }

  return result;
}

function extractScores(data: any): ScoreSet {
  if (!data) return { performance: 0, accessibility: 0, best_practices: 0, seo: 0 };
  const cats = data?.lighthouseResult?.categories || {};
  return {
    performance: Math.round((cats.performance?.score || 0) * 100),
    accessibility: Math.round((cats.accessibility?.score || 0) * 100),
    best_practices: Math.round((cats['best-practices']?.score || 0) * 100),
    seo: Math.round((cats.seo?.score || 0) * 100),
  };
}

function extractCWV(data: any): CoreWebVitals {
  if (!data) return { lcp_ms: 0, fid_ms: 0, cls: 0, fcp_ms: 0, ttfb_ms: 0 };
  const audits = data?.lighthouseResult?.audits || {};
  return {
    lcp_ms: Math.round(audits['largest-contentful-paint']?.numericValue || 0),
    fid_ms: Math.round(audits['max-potential-fid']?.numericValue || 0),
    cls: parseFloat((audits['cumulative-layout-shift']?.numericValue || 0).toFixed(3)),
    fcp_ms: Math.round(audits['first-contentful-paint']?.numericValue || 0),
    ttfb_ms: Math.round(audits['server-response-time']?.numericValue || 0),
  };
}
