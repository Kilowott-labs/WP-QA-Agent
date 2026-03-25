/**
 * Form Audit — Layer 1 Check Module
 *
 * Crawls all discovered pages and inspects every <form> for:
 * - Placeholder copy quality (label-as-placeholder, missing, not an example)
 * - Placeholder colour contrast (WCAG AA 4.5:1 minimum)
 * - Required field indicators (* markers)
 * - CTA routing issues (all forms → same URL = CRO risk)
 * - Button wrapping on mobile viewport
 * - Off-brand focus colours
 * - Missing success / error state handling
 *
 * Findings are written to layer1-results.json and surface in the Layer 1 report.
 * High-severity findings trigger a Layer 2 investigation (form-quality).
 */

import { Page } from 'playwright';
import { SiteConfig, CheckResult } from '../../types.js';
import { resolveUrl, logger } from '../../utils.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FormField {
  name: string | null;
  label: string | null;
  placeholder: string | null;
  type: string;
  required: boolean;
  hasRequiredIndicator: boolean;
}

export interface FormIssue {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  code: string;
  message: string;
  field?: string;
  detail?: string;
}

export interface FormResult {
  pageUrl: string;
  pageName: string;
  formIndex: number;
  formAction: string | null;
  formPurpose: string | null;
  fieldCount: number;
  issues: FormIssue[];
  ctaText: string[];
  screenshot?: string;
}

export interface FormAuditResult {
  forms: FormResult[];
  summary: {
    totalForms: number;
    totalIssues: number;
    byCode: Record<string, number>;
    bySeverity: Record<string, number>;
    pagesWithForms: number;
    sameCTADestinationFlag: boolean;
    croRiskPages: string[];
  };
  checkResults: CheckResult[];
}

// ── Kilowott Form Standard — placeholder example map ─────────────────────────

const PLACEHOLDER_EXAMPLES: Record<string, string> = {
  'name': 'e.g. John Smith',
  'full name': 'e.g. John Smith',
  'your name': 'e.g. John Smith',
  'first name': 'e.g. John',
  'last name': 'e.g. Smith',
  'surname': 'e.g. Smith',
  'contact name': 'e.g. John Smith',
  'person name': 'e.g. John Smith',
  'persons name': 'e.g. John Smith',
  'navn': 'f.eks. Ola Nordmann',
  'fornavn': 'f.eks. Ola',
  'etternavn': 'f.eks. Nordmann',
  'ditt navn': 'f.eks. Ola Nordmann',

  'email': 'e.g. hello@company.com',
  'email address': 'e.g. hello@company.com',
  'your email': 'e.g. hello@company.com',
  'e-mail': 'e.g. hello@company.com',
  'e-post': 'f.eks. ola@firma.no',
  'phone': 'e.g. +47 900 00 000',
  'phone number': 'e.g. +47 900 00 000',
  'mobile': 'e.g. +47 900 00 000',
  'telephone': 'e.g. +47 900 00 000',
  'telefon': 'f.eks. +47 900 00 000',

  'company': 'e.g. Acme AS',
  'company name': 'e.g. Acme AS',
  'organisation': 'e.g. Acme AS',
  'organization': 'e.g. Acme AS',
  'firma': 'f.eks. Acme AS',
  'firmanavn': 'f.eks. Acme AS',
  'bedrift': 'f.eks. Acme AS',

  'message': 'Tell us about your project...',
  'your message': 'Tell us about your project...',
  'melding': 'Fortell oss om prosjektet ditt...',
  'din melding': 'Fortell oss om prosjektet ditt...',
  'inquiry': 'What can we help you with?',
  'enquiry': 'What can we help you with?',
  'subject': 'e.g. Booking inquiry for June',
  'notes': 'Any additional notes...',
  'comments': 'Any additional notes...',
  'kommentarer': 'Eventuelle kommentarer...',

  'postal code': 'e.g. 0150',
  'postnummer': 'f.eks. 0150',
  'postcode': 'e.g. 0150',
  'zip': 'e.g. 0150',
  'city': 'e.g. Oslo',
  'by': 'f.eks. Oslo',

  'address': 'e.g. Storgata 1',
  'adresse': 'f.eks. Storgata 1',
};

// ── Relative luminance + contrast ratio helpers ───────────────────────────────

function cssColorToRgb(color: string): [number, number, number] | null {
  // hex
  const clean = color.replace('#', '');
  if (/^[0-9a-fA-F]{3}$/.test(clean)) {
    const [r, g, b] = clean.split('').map((c) => parseInt(c + c, 16));
    return [r, g, b];
  }
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16),
    ];
  }
  // rgb(r, g, b) or rgba(r, g, b, a)
  const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (match) return [parseInt(match[1]), parseInt(match[2]), parseInt(match[3])];
  return null;
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(fg: string, bg: string): number | null {
  const fgRgb = cssColorToRgb(fg);
  const bgRgb = cssColorToRgb(bg);
  if (!fgRgb || !bgRgb) return null;
  const l1 = relativeLuminance(fgRgb);
  const l2 = relativeLuminance(bgRgb);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// ── Text helpers ──────────────────────────────────────────────────────────────

function normaliseText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9æøåäö\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function placeholderMatchesLabel(placeholder: string, label: string): boolean {
  const np = normaliseText(placeholder);
  const nl = normaliseText(label);
  if (!np || !nl) return false;
  if (np === nl) return true;
  if (np.includes(nl) || nl.includes(np)) return true;
  return false;
}

// ── Autocomplete attribute map ────────────────────────────────────────────────
// Maps normalised field labels to expected autocomplete values.

const AUTOCOMPLETE_MAP: Record<string, string> = {
  'name': 'name',
  'full name': 'name',
  'your name': 'name',
  'navn': 'name',
  'ditt navn': 'name',
  'first name': 'given-name',
  'fornavn': 'given-name',
  'last name': 'family-name',
  'surname': 'family-name',
  'etternavn': 'family-name',
  'email': 'email',
  'email address': 'email',
  'your email': 'email',
  'e-mail': 'email',
  'e-post': 'email',
  'phone': 'tel',
  'phone number': 'tel',
  'mobile': 'tel',
  'telephone': 'tel',
  'telefon': 'tel',
  'company': 'organization',
  'company name': 'organization',
  'firma': 'organization',
  'firmanavn': 'organization',
  'address': 'street-address',
  'adresse': 'street-address',
  'postal code': 'postal-code',
  'postnummer': 'postal-code',
  'postcode': 'postal-code',
  'zip': 'postal-code',
  'city': 'address-level2',
  'by': 'address-level2',
  'country': 'country-name',
  'land': 'country-name',
};

// ── Norwegian word lists for language detection ───────────────────────────────

const NORWEGIAN_WORDS = new Set([
  'navn', 'fornavn', 'etternavn', 'e-post', 'telefon', 'melding', 'din',
  'ditt', 'firma', 'bedrift', 'by', 'postnummer', 'adresse', 'land',
  'bestilling', 'kommentarer', 'send', 'velg', 'obligatorisk', 'skriv',
  'fyll', 'kontakt', 'bestill', 'avdeling', 'bilmerke', 'hendelse',
  'dato', 'tidspunkt', 'antall', 'gruppe', 'nasjonalitet',
]);

const ENGLISH_WORDS = new Set([
  'name', 'first', 'last', 'email', 'phone', 'message', 'your',
  'company', 'address', 'city', 'country', 'submit', 'send', 'select',
  'preferred', 'date', 'group', 'size', 'enquiry', 'inquiry',
  'subject', 'notes', 'comments', 'additional', 'information',
]);

function detectLanguage(text: string): 'no' | 'en' | 'unknown' {
  const words = normaliseText(text).split(/\s+/);
  let noCount = 0;
  let enCount = 0;
  for (const w of words) {
    if (NORWEGIAN_WORDS.has(w)) noCount++;
    if (ENGLISH_WORDS.has(w)) enCount++;
  }
  if (noCount > 0 && enCount === 0) return 'no';
  if (enCount > 0 && noCount === 0) return 'en';
  if (noCount > enCount) return 'no';
  if (enCount > noCount) return 'en';
  return 'unknown';
}

// ── Main audit function ────────────────────────────────────────────────────────

export async function runFormAudit(
  page: Page,
  config: SiteConfig
): Promise<FormAuditResult> {
  const pages = config.key_pages?.length
    ? config.key_pages
    : [{ name: 'Homepage', path: '/' }];

  const allFormResults: FormResult[] = [];
  const checkResults: CheckResult[] = [];
  const actionUrlCounts: Record<string, number> = {};

  logger.info(`Form Audit: Checking forms across ${pages.length} pages`);

  for (const pageInfo of pages) {
    const url = resolveUrl(config.url, pageInfo.path);

    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: config.timeout_ms ?? 30000,
      });
      await page.waitForTimeout(1500); // let AJAX-loaded forms settle

      // ── Discover all forms on this page ──────────────────────────────────
      const formCount = await page.locator('form').count();
      if (formCount === 0) continue;

      for (let i = 0; i < formCount; i++) {
        const formLocator = page.locator('form').nth(i);
        const issues: FormIssue[] = [];

        // Form metadata
        const formAction =
          (await formLocator.getAttribute('action').catch(() => null)) ?? null;
        const formClass =
          (await formLocator.getAttribute('class').catch(() => null)) ?? '';
        const ariaLabel =
          (await formLocator.getAttribute('aria-label').catch(() => null)) ??
          null;

        // Skip WP admin / search forms
        const isSearchForm =
          formClass.includes('search-form') ||
          (await formLocator
            .getAttribute('role')
            .then((r) => r === 'search')
            .catch(() => false));
        if (isSearchForm) continue;

        // Track action URL for CRO check
        const resolvedAction = formAction
          ? new URL(formAction, url).pathname
          : new URL(url).pathname;
        actionUrlCounts[resolvedAction] =
          (actionUrlCounts[resolvedAction] ?? 0) + 1;

        // Infer form purpose from nearest heading
        const formHandle = await formLocator.elementHandle().catch(() => null);
        const formPurpose = formHandle
          ? await page
              .evaluate((el: Element) => {
                const heading = el
                  .closest('section, div, article')
                  ?.querySelector('h1, h2, h3, h4');
                return heading?.textContent?.trim() ?? null;
              }, formHandle)
              .catch(() => null)
          : null;

        // CTA buttons
        const ctaText: string[] = [];
        const submitSelector =
          'button[type="submit"], input[type="submit"], button:not([type])';
        const submitCount = await formLocator
          .locator(submitSelector)
          .count();
        for (let s = 0; s < submitCount; s++) {
          const btn = formLocator.locator(submitSelector).nth(s);
          const text = ((await btn.textContent().catch(() => '')) ?? '').trim();
          if (text) ctaText.push(text);
        }

        // ── Inspect all input / textarea fields ──────────────────────────────
        const inputSelector =
          'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea, select';
        const fieldCount = await formLocator.locator(inputSelector).count();

        let formHasRequiredFields = false;
        let formHasAnyRequiredIndicator = false;

        for (let f = 0; f < fieldCount; f++) {
          const field = formLocator.locator(inputSelector).nth(f);

          const placeholder =
            (await field.getAttribute('placeholder').catch(() => null)) ?? null;
          const ariaLabelAttr =
            (await field.getAttribute('aria-label').catch(() => null)) ?? null;
          const nameAttr =
            (await field.getAttribute('name').catch(() => null)) ?? null;
          const idAttr =
            (await field.getAttribute('id').catch(() => null)) ?? null;
          const isRequired = await field
            .evaluate((el) => (el as HTMLInputElement).required)
            .catch(() => false);

          if (isRequired) formHasRequiredFields = true;

          // Resolve label text
          let labelText: string | null = null;
          if (idAttr) {
            labelText = await page
              .evaluate((id: string) => {
                const el = document.querySelector(`label[for="${id}"]`);
                return el?.textContent?.replace(/\*/g, '').trim() ?? null;
              }, idAttr)
              .catch(() => null);
          }
          if (!labelText && ariaLabelAttr) labelText = ariaLabelAttr;
          if (!labelText && nameAttr) labelText = nameAttr.replace(/_/g, ' ');

          const displayLabel = labelText ?? nameAttr ?? `field-${f}`;

          // ── Check: placeholder matches label ──────────────────────────────
          if (
            placeholder &&
            labelText &&
            placeholderMatchesLabel(placeholder, labelText)
          ) {
            const suggested =
              PLACEHOLDER_EXAMPLES[normaliseText(labelText)];
            issues.push({
              severity: 'medium',
              code: 'PLACEHOLDER_MATCHES_LABEL',
              message: `Placeholder for "${displayLabel}" is identical to the field label`,
              field: displayLabel,
              detail: suggested
                ? `Change to: "${suggested}"`
                : 'Use an example value, not the field label',
            });
          }

          // ── Check: missing placeholder ────────────────────────────────────
          const fieldType =
            (await field.getAttribute('type').catch(() => 'text')) ?? 'text';
          const isTextLike = [
            'text',
            'email',
            'tel',
            'url',
            'search',
            'number',
            '',
          ].includes(fieldType);
          const isTextarea = await field
            .evaluate((el) => el.tagName.toLowerCase() === 'textarea')
            .catch(() => false);

          if ((isTextLike || isTextarea) && !placeholder && !ariaLabelAttr) {
            issues.push({
              severity: 'low',
              code: 'MISSING_PLACEHOLDER',
              message: `"${displayLabel}" has no placeholder text`,
              field: displayLabel,
              detail:
                PLACEHOLDER_EXAMPLES[normaliseText(displayLabel ?? '')]
                  ? `Add: "${PLACEHOLDER_EXAMPLES[normaliseText(displayLabel ?? '')]}"`
                  : 'Add an example value placeholder',
            });
          }

          // ── Check: placeholder contrast (WCAG AA 4.5:1) ──────────────────
          if (placeholder) {
            const colors = await field
              .evaluate((el) => {
                const style = window.getComputedStyle(el);
                return {
                  color: style.color,
                  background: style.backgroundColor,
                };
              })
              .catch(() => null);

            if (colors) {
              const placeholderColor = colors.color;
              const ratio = contrastRatio(placeholderColor, colors.background);
              if (ratio !== null && ratio < 4.5) {
                issues.push({
                  severity: ratio < 3.0 ? 'high' : 'medium',
                  code: 'PLACEHOLDER_CONTRAST_FAIL',
                  message: `"${displayLabel}" placeholder fails contrast: ${ratio.toFixed(1)}:1 (need 4.5:1)`,
                  field: displayLabel,
                  detail: `Foreground: ${placeholderColor} on ${colors.background}. Minimum: #767676 on white.`,
                });
              }
            }
          }

          // ── Check: required field without visual indicator ─────────────────
          if (isRequired && idAttr) {
            const hasIndicator = await page
              .evaluate(
                (params: { id: string; formIdx: number }) => {
                  const form =
                    document.querySelectorAll('form')[params.formIdx];
                  if (!form) return false;
                  const label = document.querySelector(
                    `label[for="${params.id}"]`
                  );
                  if (label?.textContent?.includes('*')) return true;
                  const input = document.getElementById(params.id);
                  const wrapper = input?.closest(
                    '.form-group, .form-field, .field-wrapper, .input-wrapper, .gfield, .wpforms-field'
                  );
                  if (wrapper?.textContent?.includes('*')) return true;
                  return false;
                },
                { id: idAttr, formIdx: i }
              )
              .catch(() => false);

            if (hasIndicator) formHasAnyRequiredIndicator = true;
          }

          // ── Check: missing autocomplete attribute ─────────────────────────
          if (isTextLike || isTextarea) {
            const autocompleteAttr =
              (await field.getAttribute('autocomplete').catch(() => null)) ??
              null;
            const expectedAutocomplete =
              AUTOCOMPLETE_MAP[normaliseText(displayLabel)];
            if (expectedAutocomplete && !autocompleteAttr) {
              issues.push({
                severity: 'low',
                code: 'MISSING_AUTOCOMPLETE',
                message: `"${displayLabel}" is missing autocomplete="${expectedAutocomplete}"`,
                field: displayLabel,
                detail:
                  'Adding autocomplete attributes enables browser autofill — reduces mobile friction by 30-40%',
              });
            }
          }

          // ── Check: date field format (mm/dd/yyyy on Norwegian sites) ──────
          if (fieldType === 'text' || fieldType === '') {
            const dateFormatPlaceholder = placeholder ?? '';
            const isDateField =
              dateFormatPlaceholder.match(/mm\/dd\/yyyy/i) ||
              dateFormatPlaceholder.match(/mm\/dd\/yy/i);
            if (isDateField) {
              // Check if the form/page appears to be Norwegian
              const pageLanguage = formPurpose
                ? detectLanguage(formPurpose)
                : 'unknown';
              const labelLang = labelText
                ? detectLanguage(labelText)
                : 'unknown';
              if (pageLanguage === 'no' || labelLang === 'no') {
                issues.push({
                  severity: 'medium',
                  code: 'DATE_FORMAT_WRONG_LOCALE',
                  message: `"${displayLabel}" uses mm/dd/yyyy format on a Norwegian-language form`,
                  field: displayLabel,
                  detail:
                    'Norwegian users expect dd.mm.yyyy format. Change the date input format or use a native date picker with locale support.',
                });
              }
            }
          }
        }

        // ── Check: required fields with no * indicator ──────────────────────
        if (formHasRequiredFields && !formHasAnyRequiredIndicator) {
          issues.push({
            severity: 'medium',
            code: 'MISSING_REQUIRED_INDICATORS',
            message:
              'Form has required fields but no * indicators visible',
            detail:
              'Add * to required field labels and a note at the top: "Fields marked * are required"',
          });
        }

        // ── Check: CTA button text wrapping on mobile ─────────────────────
        if (ctaText.length > 0) {
          await page.setViewportSize({ width: 375, height: 812 });
          await page.waitForTimeout(300);

          for (let s = 0; s < submitCount; s++) {
            const btn = formLocator.locator(submitSelector).nth(s);
            const isWrapping = await btn
              .evaluate((el) => {
                const rect = el.getBoundingClientRect();
                return rect.height > 55;
              })
              .catch(() => false);

            if (isWrapping) {
              issues.push({
                severity: 'medium',
                code: 'CTA_TEXT_WRAPPING',
                message: `Submit button "${ctaText[s] ?? 'button'}" wraps to multiple lines on mobile (375px)`,
                detail:
                  'Reduce button text length, increase button width, or reduce font size on mobile',
              });
            }
          }

          // Restore desktop viewport
          await page.setViewportSize({ width: 1280, height: 800 });
          await page.waitForTimeout(200);
        }

        // ── Check: off-brand focus colour ──────────────────────────────────
        const firstInput = formLocator.locator(inputSelector).first();
        const firstHandle = await firstInput.elementHandle().catch(() => null);
        if (firstHandle) {
          const focusColor = await page
            .evaluate(async (el: Element) => {
              (el as HTMLElement).focus();
              await new Promise((r) => setTimeout(r, 50));
              const style = window.getComputedStyle(el);
              return style.outlineColor || style.borderColor;
            }, firstHandle)
            .catch(() => null);

          if (focusColor) {
            const rgb = cssColorToRgb(focusColor);
            if (rgb) {
              const [r, g, b] = rgb;
              const isBrowserDefaultBlue = r < 10 && g < 10 && b > 200;
              if (isBrowserDefaultBlue) {
                issues.push({
                  severity: 'low',
                  code: 'FOCUS_COLOR_DEFAULT_BLUE',
                  message:
                    'Input focus colour is browser-default blue — not branded',
                  detail:
                    'Set input:focus border-color and outline-color to the brand primary colour',
                });
              }
            }
          }
        }

        // ── Check: GDPR consent checkbox ────────────────────────────────
        const checkboxes = formLocator.locator(
          'input[type="checkbox"]'
        );
        const checkboxCount = await checkboxes.count();
        for (let cb = 0; cb < checkboxCount; cb++) {
          const checkbox = checkboxes.nth(cb);
          const cbId =
            (await checkbox.getAttribute('id').catch(() => null)) ?? null;
          const cbName =
            (await checkbox.getAttribute('name').catch(() => null)) ?? '';

          // Find associated label text
          let cbLabel = '';
          if (cbId) {
            cbLabel =
              (await page
                .evaluate((id: string) => {
                  const el = document.querySelector(`label[for="${id}"]`);
                  return el?.textContent?.trim() ?? '';
                }, cbId)
                .catch(() => '')) ?? '';
          }
          if (!cbLabel) {
            cbLabel =
              ((await checkbox
                .evaluate(
                  (el) =>
                    el.closest('label')?.textContent?.trim() ?? ''
                )
                .catch(() => '')) ?? '');
          }

          const labelLower = (cbLabel + ' ' + cbName).toLowerCase();
          const isConsent =
            labelLower.includes('consent') ||
            labelLower.includes('agree') ||
            labelLower.includes('accept') ||
            labelLower.includes('terms') ||
            labelLower.includes('privacy') ||
            labelLower.includes('gdpr') ||
            labelLower.includes('newsletter') ||
            labelLower.includes('marketing') ||
            labelLower.includes('aksepterer') ||
            labelLower.includes('samtykke') ||
            labelLower.includes('betingelse') ||
            labelLower.includes('personvern') ||
            labelLower.includes('vilkår');

          if (isConsent) {
            // Check if pre-checked (illegal under GDPR for marketing consent)
            const isPreChecked = await checkbox
              .evaluate((el) => (el as HTMLInputElement).checked)
              .catch(() => false);

            if (isPreChecked) {
              issues.push({
                severity: 'high',
                code: 'GDPR_PRECHECKED_CONSENT',
                message: `Consent checkbox is pre-checked: "${cbLabel.slice(0, 60)}"`,
                detail:
                  'Pre-checked consent checkboxes violate GDPR Article 7. Consent must be freely given via an affirmative action. Uncheck by default.',
              });
            }

            // Check if label links to privacy/terms page
            const hasLink = await page
              .evaluate(
                (params: { cbId: string | null; formIdx: number }) => {
                  let label: Element | null = null;
                  if (params.cbId) {
                    label = document.querySelector(
                      `label[for="${params.cbId}"]`
                    );
                  }
                  if (!label) {
                    const form =
                      document.querySelectorAll('form')[params.formIdx];
                    const cbs = form?.querySelectorAll(
                      'input[type="checkbox"]'
                    );
                    const cb = cbs?.[0];
                    label = cb?.closest('label') ?? null;
                  }
                  return label?.querySelector('a') !== null;
                },
                { cbId: cbId, formIdx: i }
              )
              .catch(() => false);

            if (!hasLink) {
              issues.push({
                severity: 'medium',
                code: 'GDPR_CONSENT_NO_LINK',
                message: `Consent checkbox label has no link to privacy/terms page`,
                field: cbLabel.slice(0, 60),
                detail:
                  'The consent label should link directly to the Privacy Policy and/or Terms & Conditions page.',
              });
            }
          }
        }

        // ── Check: dropdown default text quality ────────────────────────────
        const selects = formLocator.locator('select');
        const selectCount = await selects.count();
        for (let s = 0; s < selectCount; s++) {
          const selectEl = selects.nth(s);
          const selectName =
            (await selectEl.getAttribute('name').catch(() => null)) ??
            `select-${s}`;
          const selectId =
            (await selectEl.getAttribute('id').catch(() => null)) ?? null;

          let selectLabel = selectName.replace(/_/g, ' ');
          if (selectId) {
            selectLabel =
              (await page
                .evaluate((id: string) => {
                  const el = document.querySelector(`label[for="${id}"]`);
                  return el?.textContent?.replace(/\*/g, '').trim() ?? null;
                }, selectId)
                .catch(() => null)) ?? selectLabel;
          }

          const firstOption = await selectEl
            .evaluate((el) => {
              const select = el as HTMLSelectElement;
              const first = select.options[0];
              if (!first) return null;
              return {
                text: first.textContent?.trim() ?? '',
                value: first.value,
                disabled: first.disabled,
              };
            })
            .catch(() => null);

          if (firstOption) {
            const optText = firstOption.text.toLowerCase();
            const isEmpty =
              firstOption.value === '' && firstOption.text === '';
            const isGeneric =
              optText === 'select' ||
              optText === 'select...' ||
              optText === 'choose' ||
              optText === 'choose...' ||
              optText === '-- select --' ||
              optText === '---' ||
              optText === 'velg' ||
              optText === 'velg...' ||
              optText === '';

            if (isEmpty || (isGeneric && !firstOption.disabled)) {
              issues.push({
                severity: 'low',
                code: 'DROPDOWN_EMPTY_DEFAULT',
                message: `"${selectLabel}" dropdown has generic/empty default: "${firstOption.text || '(empty)'}"`,
                field: selectLabel,
                detail: `Use a contextual prompt like "Select ${selectLabel.toLowerCase()}..." and disable the placeholder option.`,
              });
            }
          }
        }

        // ── Check: form validation (submit empty, check for error display) ──
        if (formHasRequiredFields && submitCount > 0) {
          // Try clicking submit without filling — check for validation errors
          const submitBtn = formLocator.locator(submitSelector).first();

          // Record current URL to detect page navigation
          const urlBefore = page.url();

          try {
            // Click submit (may trigger HTML5 validation or JS validation)
            await submitBtn.click({ timeout: 3000 }).catch(() => {});
            await page.waitForTimeout(1000);

            // Check if validation errors appeared
            const validationState = await page
              .evaluate((formIdx: number) => {
                const form = document.querySelectorAll('form')[formIdx];
                if (!form) return { hasErrors: false, errorCount: 0, errorTexts: [] as string[] };

                // Check for common error classes / elements
                const errorSelectors = [
                  '.error',
                  '.field-error',
                  '.validation-error',
                  '.form-error',
                  '.wpcf7-not-valid-tip',
                  '.gfield_error',
                  '.wpforms-error',
                  '.is-error',
                  '.has-error',
                  '[role="alert"]',
                  '.woocommerce-error',
                  '.error-message',
                  '.invalid-feedback',
                ];

                let errorCount = 0;
                const errorTexts: string[] = [];
                for (const sel of errorSelectors) {
                  const els = form.querySelectorAll(sel);
                  errorCount += els.length;
                  els.forEach((el) => {
                    const text = el.textContent?.trim();
                    if (text && text.length < 200) errorTexts.push(text);
                  });
                }

                // Also check HTML5 :invalid pseudo-class
                const invalidInputs = form.querySelectorAll(':invalid');
                const html5Invalid = invalidInputs.length;

                return {
                  hasErrors: errorCount > 0,
                  errorCount,
                  html5Invalid,
                  errorTexts: errorTexts.slice(0, 5),
                };
              }, i)
              .catch(() => ({
                hasErrors: false,
                errorCount: 0,
                html5Invalid: 0,
                errorTexts: [] as string[],
              }));

            if (
              !validationState.hasErrors &&
              validationState.html5Invalid === 0
            ) {
              issues.push({
                severity: 'medium',
                code: 'NO_VALIDATION_FEEDBACK',
                message:
                  'Submitting empty required fields shows no visible error messages',
                detail:
                  'Add inline validation messages below each required field. Users need clear feedback on what to fix.',
              });
            }

            // Navigate back if page changed
            if (page.url() !== urlBefore) {
              await page
                .goto(url, {
                  waitUntil: 'domcontentloaded',
                  timeout: 10000,
                })
                .catch(() => {});
            }
          } catch {
            // Validation test failed — don't block the rest of the audit
          }
        }

        // ── Check: multi-language consistency ───────────────────────────────
        // Collect all label and placeholder text, detect mixed languages
        const formTexts = await formLocator
          .evaluate((form: Element) => {
            const labels = Array.from(form.querySelectorAll('label'));
            const inputs = Array.from(
              form.querySelectorAll(
                'input[placeholder], textarea[placeholder]'
              )
            );
            return {
              labelTexts: labels
                .map((l) => l.textContent?.replace(/\*/g, '').trim() ?? '')
                .filter(Boolean),
              placeholderTexts: inputs
                .map(
                  (i) =>
                    (i as HTMLInputElement).placeholder?.trim() ?? ''
                )
                .filter(Boolean),
            };
          })
          .catch(() => ({ labelTexts: [] as string[], placeholderTexts: [] as string[] }));

        if (
          formTexts.labelTexts.length > 1 ||
          formTexts.placeholderTexts.length > 1
        ) {
          const allTexts = [
            ...formTexts.labelTexts,
            ...formTexts.placeholderTexts,
          ];
          const languages = allTexts.map(detectLanguage).filter(
            (l) => l !== 'unknown'
          );
          const hasNorwegian = languages.includes('no');
          const hasEnglish = languages.includes('en');

          if (hasNorwegian && hasEnglish) {
            issues.push({
              severity: 'medium',
              code: 'MIXED_LANGUAGE_FORM',
              message:
                'Form mixes Norwegian and English in labels/placeholders',
              detail:
                'Keep all form text in a single language. Norwegian labels should have Norwegian placeholders (use "f.eks." not "e.g.").',
            });
          }
        }

        allFormResults.push({
          pageUrl: url,
          pageName: pageInfo.name,
          formIndex: i,
          formAction: resolvedAction,
          formPurpose: formPurpose ?? ariaLabel,
          fieldCount,
          issues,
          ctaText,
        });
      }
    } catch (err: any) {
      logger.warn(`Form Audit: Failed to audit forms on ${url}: ${err.message}`);
    }
  }

  // ── CRO check: multiple forms routing to same destination ─────────────────
  const croRiskPages: string[] = [];
  const sameCTADestination = Object.values(actionUrlCounts).some(
    (count) => count >= 3
  );

  if (sameCTADestination) {
    const dominantAction = Object.entries(actionUrlCounts).sort(
      (a, b) => b[1] - a[1]
    )[0];

    allFormResults.forEach((form) => {
      if (form.formAction === dominantAction[0]) {
        form.issues.push({
          severity: 'high',
          code: 'CRO_SAME_DESTINATION',
          message: `All CTAs route to "${dominantAction[0]}" with no attribution — conversion tracking is blind`,
          detail:
            'Add a hidden source_page field pre-populated with the current page name/URL, or embed context-specific forms per page. At minimum add ?source= query params to all CTA links.',
        });
        if (!croRiskPages.includes(form.pageUrl)) {
          croRiskPages.push(form.pageUrl);
        }
      }
    });
  }

  // ── Check: generic /contact redirect (no query params) on CTA links ────────
  try {
    for (const pageInfo of pages.slice(0, 10)) {
      const url = resolveUrl(config.url, pageInfo.path);
      try {
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 15000,
        });

        const bookingLinks = await page
          .evaluate(() => {
            const ctas = Array.from(document.querySelectorAll('a'));
            return ctas
              .filter((a) => {
                const text = (a.textContent ?? '').toLowerCase();
                const isBookingCta =
                  text.includes('book') ||
                  text.includes('contact') ||
                  text.includes('enquire') ||
                  text.includes('inquire') ||
                  text.includes('get in touch') ||
                  text.includes('bestill') ||
                  text.includes('kontakt');
                const href = a.getAttribute('href') ?? '';
                const isContactPage =
                  href.includes('/contact') && !href.includes('?');
                return isBookingCta && isContactPage;
              })
              .map((a) => ({
                text: a.textContent?.trim(),
                href: a.getAttribute('href'),
              }));
          })
          .catch(() => []);

        if (bookingLinks.length > 0) {
          const existing = allFormResults.find(
            (f) => f.pageUrl === url
          );
          const issue: FormIssue = {
            severity: 'high',
            code: 'CRO_NO_ATTRIBUTION_LINK',
            message: `${bookingLinks.length} booking CTA(s) link to /contact with no source attribution`,
            detail: `CTAs: ${bookingLinks.map((l) => `"${l.text}"`).join(', ')}. Add ?source=${encodeURIComponent(pageInfo.name.toLowerCase().replace(/\s+/g, '-'))} to track which page drives conversions.`,
          };
          if (existing) {
            existing.issues.push(issue);
          } else {
            allFormResults.push({
              pageUrl: url,
              pageName: pageInfo.name,
              formIndex: -1,
              formAction: '/contact',
              formPurpose: 'Booking CTA',
              fieldCount: 0,
              issues: [issue],
              ctaText: bookingLinks.map((l) => l.text ?? ''),
            });
          }
          if (!croRiskPages.includes(url)) croRiskPages.push(url);
        }
      } catch {
        /* skip page */
      }
    }
  } catch {
    /* browser error — skip CTA link check */
  }

  // ── Build summary ─────────────────────────────────────────────────────────
  const allIssues = allFormResults.flatMap((f) => f.issues);

  const byCode: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};

  for (const issue of allIssues) {
    byCode[issue.code] = (byCode[issue.code] ?? 0) + 1;
    bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1;
  }

  // ── Build CheckResult entries ─────────────────────────────────────────────
  const criticalOrHigh =
    (bySeverity['critical'] ?? 0) + (bySeverity['high'] ?? 0);
  const medium = bySeverity['medium'] ?? 0;

  checkResults.push({
    check: 'Form Audit — Placeholder Quality',
    status:
      (byCode['PLACEHOLDER_MATCHES_LABEL'] ?? 0) +
        (byCode['MISSING_PLACEHOLDER'] ?? 0) >
      0
        ? 'WARN'
        : 'PASS',
    detail: `${byCode['PLACEHOLDER_MATCHES_LABEL'] ?? 0} labels used as placeholders, ${byCode['MISSING_PLACEHOLDER'] ?? 0} missing placeholders`,
  });

  checkResults.push({
    check: 'Form Audit — Placeholder Contrast',
    status: (byCode['PLACEHOLDER_CONTRAST_FAIL'] ?? 0) > 0 ? 'FAIL' : 'PASS',
    detail: `${byCode['PLACEHOLDER_CONTRAST_FAIL'] ?? 0} contrast failures (WCAG AA 4.5:1 minimum)`,
  });

  checkResults.push({
    check: 'Form Audit — Required Field Indicators',
    status:
      (byCode['MISSING_REQUIRED_INDICATORS'] ?? 0) > 0 ? 'WARN' : 'PASS',
    detail: `${byCode['MISSING_REQUIRED_INDICATORS'] ?? 0} forms missing * markers for required fields`,
  });

  checkResults.push({
    check: 'Form Audit — CRO / Booking Routing',
    status: croRiskPages.length > 0 ? 'FAIL' : 'PASS',
    detail:
      croRiskPages.length > 0
        ? `${croRiskPages.length} pages with CTAs routing to generic /contact (no attribution)`
        : 'All booking CTAs have contextual routing',
  });

  checkResults.push({
    check: 'Form Audit — Mobile CTA Buttons',
    status: (byCode['CTA_TEXT_WRAPPING'] ?? 0) > 0 ? 'WARN' : 'PASS',
    detail: `${byCode['CTA_TEXT_WRAPPING'] ?? 0} submit buttons wrapping on 375px viewport`,
  });

  checkResults.push({
    check: 'Form Audit — Autocomplete Attributes',
    status: (byCode['MISSING_AUTOCOMPLETE'] ?? 0) > 0 ? 'WARN' : 'PASS',
    detail: `${byCode['MISSING_AUTOCOMPLETE'] ?? 0} fields missing autocomplete attribute`,
  });

  checkResults.push({
    check: 'Form Audit — GDPR Consent',
    status: (byCode['GDPR_PRECHECKED_CONSENT'] ?? 0) > 0 ? 'FAIL' : 'PASS',
    detail:
      (byCode['GDPR_PRECHECKED_CONSENT'] ?? 0) > 0
        ? `${byCode['GDPR_PRECHECKED_CONSENT'] ?? 0} pre-checked consent checkboxes (GDPR violation)`
        : `${byCode['GDPR_CONSENT_NO_LINK'] ?? 0} consent labels without policy links`,
  });

  checkResults.push({
    check: 'Form Audit — Validation Feedback',
    status: (byCode['NO_VALIDATION_FEEDBACK'] ?? 0) > 0 ? 'WARN' : 'PASS',
    detail: `${byCode['NO_VALIDATION_FEEDBACK'] ?? 0} forms show no error messages on empty submit`,
  });

  checkResults.push({
    check: 'Form Audit — Language Consistency',
    status: (byCode['MIXED_LANGUAGE_FORM'] ?? 0) > 0 ? 'WARN' : 'PASS',
    detail: `${byCode['MIXED_LANGUAGE_FORM'] ?? 0} forms mixing Norwegian and English`,
  });

  const overallStatus =
    criticalOrHigh > 0 ? 'FAIL' : medium > 0 ? 'WARN' : 'PASS';
  checkResults.push({
    check: 'Form Audit — Overall',
    status: overallStatus,
    detail: `${allFormResults.filter((f) => f.formIndex >= 0).length} forms audited across ${pages.length} pages. ${allIssues.length} issues found.`,
    data: {
      bySeverity,
      byCode,
      formsAudited: allFormResults.length,
    },
  });

  logger.info(`Form Audit: Complete — ${allIssues.length} issues in ${allFormResults.length} forms`);

  return {
    forms: allFormResults,
    summary: {
      totalForms: allFormResults.filter((f) => f.formIndex >= 0).length,
      totalIssues: allIssues.length,
      byCode,
      bySeverity,
      pagesWithForms: new Set(allFormResults.map((f) => f.pageUrl)).size,
      sameCTADestinationFlag: sameCTADestination,
      croRiskPages,
    },
    checkResults,
  };
}

// ── Layer 1 report section builder ───────────────────────────────────────────

export function buildFormAuditReport(result: FormAuditResult): string {
  const { forms, summary } = result;
  const lines: string[] = [];

  lines.push('## Form Audit\n');

  // Summary table
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Forms audited | ${summary.totalForms} |`);
  lines.push(`| Pages with forms | ${summary.pagesWithForms} |`);
  lines.push(`| Total issues | ${summary.totalIssues} |`);
  lines.push(
    `| Critical / High | ${(summary.bySeverity['critical'] ?? 0) + (summary.bySeverity['high'] ?? 0)} |`
  );
  lines.push(`| Medium | ${summary.bySeverity['medium'] ?? 0} |`);
  lines.push(`| Low | ${summary.bySeverity['low'] ?? 0} |`);
  lines.push('');

  if (summary.croRiskPages.length > 0) {
    lines.push(
      `> **CRO Risk:** ${summary.croRiskPages.length} pages have CTAs routing to a generic contact page with no source attribution. This kills conversion tracking.`
    );
    lines.push('');
  }

  if (summary.totalIssues === 0) {
    lines.push('All forms pass the Kilowott Form Standard.\n');
    return lines.join('\n');
  }

  // Group by page
  const byPage = forms.reduce<Record<string, FormResult[]>>((acc, f) => {
    if (f.issues.length === 0) return acc;
    if (!acc[f.pageUrl]) acc[f.pageUrl] = [];
    acc[f.pageUrl].push(f);
    return acc;
  }, {});

  for (const [url, pageForms] of Object.entries(byPage)) {
    const pageName = pageForms[0].pageName;
    lines.push(`### ${pageName}`);
    lines.push(`**URL:** ${url}\n`);

    for (const form of pageForms) {
      if (form.formPurpose) {
        lines.push(`**Form:** ${form.formPurpose}`);
      }
      if (form.fieldCount > 0) {
        lines.push(
          `**Fields:** ${form.fieldCount} | **CTA:** ${form.ctaText.join(', ') || '(none detected)'}`
        );
      }
      lines.push('');

      for (const issue of form.issues) {
        const icon =
          issue.severity === 'critical' || issue.severity === 'high'
            ? '✗'
            : issue.severity === 'medium'
              ? '⚠'
              : 'ℹ';
        lines.push(
          `${icon} **[${issue.severity.toUpperCase()}]** ${issue.message}`
        );
        if (issue.detail) lines.push(`  → *${issue.detail}*`);
      }
      lines.push('');
    }
  }

  // Issue summary by code
  lines.push('### Issue Breakdown\n');
  lines.push('| Issue Type | Count |');
  lines.push('|------------|-------|');

  const codeLabels: Record<string, string> = {
    PLACEHOLDER_MATCHES_LABEL: 'Placeholder = field label',
    MISSING_PLACEHOLDER: 'Missing placeholder',
    PLACEHOLDER_CONTRAST_FAIL: 'Placeholder contrast failure',
    MISSING_REQUIRED_INDICATORS: 'Missing required indicators',
    CTA_TEXT_WRAPPING: 'CTA button wrapping on mobile',
    FOCUS_COLOR_DEFAULT_BLUE: 'Default browser focus colour',
    CRO_SAME_DESTINATION: 'All forms → same destination',
    CRO_NO_ATTRIBUTION_LINK: 'Booking CTAs without attribution',
    MISSING_AUTOCOMPLETE: 'Missing autocomplete attribute',
    DATE_FORMAT_WRONG_LOCALE: 'Wrong date format for locale',
    GDPR_PRECHECKED_CONSENT: 'Pre-checked consent (GDPR violation)',
    GDPR_CONSENT_NO_LINK: 'Consent label missing policy link',
    DROPDOWN_EMPTY_DEFAULT: 'Dropdown with empty/generic default',
    NO_VALIDATION_FEEDBACK: 'No validation error feedback',
    MIXED_LANGUAGE_FORM: 'Mixed languages in form',
  };

  for (const [code, count] of Object.entries(summary.byCode)) {
    lines.push(`| ${codeLabels[code] ?? code} | ${count} |`);
  }
  lines.push('');

  return lines.join('\n');
}

// ── Layer 2 trigger builder ───────────────────────────────────────────────────

export function buildFormAuditL2Trigger(result: FormAuditResult): {
  id: string;
  priority: 'high' | 'medium' | 'low';
  description: string;
  data: any;
} | null {
  const { summary } = result;
  const highCount =
    (summary.bySeverity['critical'] ?? 0) + (summary.bySeverity['high'] ?? 0);

  if (summary.totalIssues === 0) return null;

  return {
    id: 'form-quality',
    priority:
      highCount > 0 || summary.croRiskPages.length > 0 ? 'high' : 'medium',
    description: `${summary.totalIssues} form quality issues detected across ${summary.pagesWithForms} pages. ${summary.croRiskPages.length > 0 ? `CRO risk: booking CTAs on ${summary.croRiskPages.length} pages route to a generic contact page.` : ''} Investigate visual quality, UX, and conversion impact.`,
    data: {
      totalIssues: summary.totalIssues,
      bySeverity: summary.bySeverity,
      byCode: summary.byCode,
      croRiskPages: summary.croRiskPages,
      affectedPages: [
        ...new Set(
          result.forms.flatMap((f) =>
            f.issues.length > 0 ? [f.pageUrl] : []
          )
        ),
      ],
    },
  };
}
