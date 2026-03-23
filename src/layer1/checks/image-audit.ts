import { Page } from 'playwright';
import {
  SiteConfig,
  ImageAuditResult,
  OversizedImage,
  MissingDimensionImage,
  NetworkRequest,
  WordPressHealthResult,
} from '../../types.js';
import { resolveUrl, logger } from '../../utils.js';

/**
 * Image optimization audit: oversized images, missing dimensions,
 * lazy loading, WebP/AVIF support, responsive images, total weight.
 */
export async function runImageAudit(
  page: Page,
  config: SiteConfig,
  collectedRequests: NetworkRequest[],
  wpHealth: WordPressHealthResult
): Promise<ImageAuditResult> {
  const pages = config.key_pages?.length
    ? config.key_pages
    : [{ name: 'Homepage', path: '/' }];

  const oversized: OversizedImage[] = [];
  const missingDimensions: MissingDimensionImage[] = [];
  let totalImages = 0;
  let totalBelowFold = 0;
  let withLazy = 0;
  let withoutLazy = 0;
  let totalWithSrcset = 0;
  let totalWithoutSrcset = 0;
  let totalImageBytes = 0;
  let servingModernFormats = false;

  for (const pg of pages) {
    const url = resolveUrl(config.url, pg.path);

    try {
      // Track image requests for this page
      const requestsBefore = collectedRequests.length;

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: config.timeout_ms || 30000,
      });
      // Wait a bit for lazy-loaded images to set up
      await page.waitForTimeout(1000);

      const pageImageRequests = collectedRequests
        .slice(requestsBefore)
        .filter(
          (r) =>
            r.type === 'image' ||
            r.url.match(/\.(jpe?g|png|gif|webp|avif|svg|ico)(\?|$)/i)
        );

      for (const req of pageImageRequests) {
        const size = req.size_bytes || 0;
        totalImageBytes += size;
        if (req.url.match(/\.(webp|avif)(\?|$)/i)) {
          servingModernFormats = true;
        }
      }

      // Evaluate DOM for image audit
      const imageData = await page.evaluate(
        ({ pageName, viewportHeight }: { pageName: string; viewportHeight: number }) => {
          const results = {
            images: [] as {
              src: string;
              naturalWidth: number;
              naturalHeight: number;
              displayWidth: number;
              displayHeight: number;
              hasWidth: boolean;
              hasHeight: boolean;
              hasLazy: boolean;
              hasSrcset: boolean;
              isBelowFold: boolean;
              isVisible: boolean;
            }[],
          };

          const imgs = document.querySelectorAll('img');
          imgs.forEach((img) => {
            const src =
              img.getAttribute('src') ||
              img.getAttribute('data-src') ||
              img.getAttribute('data-lazy-src') ||
              '';

            // Skip tracking pixels, data URIs, and SVG placeholders
            if (!src || src.startsWith('data:') || src.includes('pixel')) return;
            if (img.width < 2 && img.height < 2) return;

            const rect = img.getBoundingClientRect();
            const isVisible = rect.width > 0 && rect.height > 0;
            const isBelowFold = rect.top > viewportHeight;

            results.images.push({
              src: src.slice(0, 200),
              naturalWidth: img.naturalWidth,
              naturalHeight: img.naturalHeight,
              displayWidth: Math.round(rect.width),
              displayHeight: Math.round(rect.height),
              hasWidth: img.hasAttribute('width'),
              hasHeight: img.hasAttribute('height'),
              hasLazy:
                img.getAttribute('loading') === 'lazy' ||
                img.hasAttribute('data-src') ||
                img.hasAttribute('data-lazy-src') ||
                img.classList.contains('lazyload') ||
                img.classList.contains('lazy'),
              hasSrcset: img.hasAttribute('srcset'),
              isBelowFold,
              isVisible,
            });
          });

          return results;
        },
        { pageName: pg.name, viewportHeight: 800 }
      );

      totalImages += imageData.images.length;

      for (const img of imageData.images) {
        // Missing dimensions
        if (!img.hasWidth && !img.hasHeight && img.isVisible) {
          missingDimensions.push({
            url: img.src,
            page: pg.name,
            missing: 'both',
          });
        } else if (!img.hasWidth && img.isVisible) {
          missingDimensions.push({
            url: img.src,
            page: pg.name,
            missing: 'width',
          });
        } else if (!img.hasHeight && img.isVisible) {
          missingDimensions.push({
            url: img.src,
            page: pg.name,
            missing: 'height',
          });
        }

        // Lazy loading check (below-fold images)
        if (img.isBelowFold) {
          totalBelowFold++;
          if (img.hasLazy) {
            withLazy++;
          } else {
            withoutLazy++;
          }
        }

        // Responsive images
        if (img.isVisible && img.displayWidth > 50) {
          if (img.hasSrcset) {
            totalWithSrcset++;
          } else {
            totalWithoutSrcset++;
          }
        }

        // Oversized detection: natural size much larger than display size
        if (
          img.naturalWidth > 0 &&
          img.displayWidth > 0 &&
          img.naturalWidth > img.displayWidth * 2
        ) {
          // Find the actual size from network requests
          const matchingReq = pageImageRequests.find((r) =>
            img.src && r.url.includes(img.src.split('?')[0].split('/').pop() || '___')
          );
          const sizeBytes = matchingReq?.size_bytes || 0;

          if (sizeBytes > 100 * 1024 || img.naturalWidth > img.displayWidth * 3) {
            oversized.push({
              url: img.src,
              page: pg.name,
              size_bytes: sizeBytes,
              natural_width: img.naturalWidth,
              natural_height: img.naturalHeight,
              display_width: img.displayWidth,
              display_height: img.displayHeight,
            });
          }
        }
      }

      // Also flag any image request > 500KB
      for (const req of pageImageRequests) {
        if ((req.size_bytes || 0) > 500 * 1024) {
          const alreadyFound = oversized.some(
            (o) => req.url.includes(o.url.split('/').pop() || '___')
          );
          if (!alreadyFound) {
            oversized.push({
              url: req.url,
              page: pg.name,
              size_bytes: req.size_bytes || 0,
            });
          }
        }
      }

      logger.dim(
        `img: ${pg.name} — ${imageData.images.length} images, ${oversized.filter((o) => o.page === pg.name).length} oversized`
      );
    } catch (err: any) {
      logger.dim(`img: ${pg.name} — ERROR: ${err.message.slice(0, 60)}`);
    }
  }

  // ── WebP/AVIF support check ─────────────────────────────────────────
  const formatSupport = await checkFormatSupport(config.url);

  // ── Detect image optimization plugin ────────────────────────────────
  const { detected, name } = detectOptimizationPlugin(wpHealth);

  return {
    pages_scanned: pages.length,
    total_images: totalImages,
    oversized_images: oversized,
    missing_dimensions: missingDimensions,
    lazy_loading: {
      total_below_fold: totalBelowFold,
      with_lazy_loading: withLazy,
      without_lazy_loading: withoutLazy,
    },
    format_support: {
      webp_supported: formatSupport.webp,
      avif_supported: formatSupport.avif,
      serving_modern_formats: servingModernFormats,
    },
    responsive_images: {
      total: totalWithSrcset + totalWithoutSrcset,
      with_srcset: totalWithSrcset,
      without_srcset: totalWithoutSrcset,
    },
    total_image_weight_bytes: totalImageBytes,
    optimization_plugin_detected: detected,
    optimization_plugin_name: name,
  };
}

async function checkFormatSupport(
  siteUrl: string
): Promise<{ webp: boolean; avif: boolean }> {
  const result = { webp: false, avif: false };

  try {
    // Check if server serves WebP when Accept header includes it
    const res = await fetch(siteUrl, {
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'User-Agent': 'wp-qa-agent/1.0',
      },
      signal: AbortSignal.timeout(10000),
    });
    const html = await res.text();

    // Check for WebP/AVIF in any image URLs in the HTML
    if (html.includes('.webp')) result.webp = true;
    if (html.includes('.avif')) result.avif = true;

    // Check for picture elements with source type="image/webp"
    if (html.includes('image/webp')) result.webp = true;
    if (html.includes('image/avif')) result.avif = true;
  } catch { /* skip */ }

  return result;
}

function detectOptimizationPlugin(
  wpHealth: WordPressHealthResult
): { detected: boolean; name?: string } {
  const optimizationPlugins = [
    { pattern: 'imagify', name: 'Imagify' },
    { pattern: 'smush', name: 'Smush' },
    { pattern: 'shortpixel', name: 'ShortPixel' },
    { pattern: 'ewww', name: 'EWWW Image Optimizer' },
    { pattern: 'optimole', name: 'Optimole' },
    { pattern: 'kraken', name: 'Kraken.io' },
    { pattern: 'tinypng', name: 'TinyPNG' },
    { pattern: 'compress', name: 'Compress JPEG & PNG' },
    { pattern: 'webp-express', name: 'WebP Express' },
    { pattern: 'webp-converter', name: 'WebP Converter' },
    { pattern: 'perfmatters', name: 'Perfmatters' },
    { pattern: 'wp-rocket', name: 'WP Rocket' },
  ];

  for (const plugin of optimizationPlugins) {
    const found = wpHealth.plugins.find(
      (p) =>
        p.slug.toLowerCase().includes(plugin.pattern) &&
        p.status === 'active'
    );
    if (found) {
      return { detected: true, name: plugin.name };
    }
  }

  return { detected: false };
}
