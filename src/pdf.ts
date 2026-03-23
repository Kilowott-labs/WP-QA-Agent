import fs from 'fs/promises';
import path from 'path';
import { chromium } from 'playwright';
import { marked } from 'marked';
import { logger } from './utils.js';

/**
 * Convert a Markdown file to a styled PDF using Playwright.
 * Returns the path to the generated PDF.
 */
export async function markdownToPdf(mdPath: string): Promise<string> {
  const mdContent = await fs.readFile(mdPath, 'utf-8');
  const pdfPath = mdPath.replace(/\.md$/, '.pdf');

  logger.info(`Generating PDF: ${path.basename(pdfPath)}`);

  // Convert Markdown → HTML
  const htmlBody = await marked(mdContent, { gfm: true, breaks: true });

  // Wrap in a styled HTML document
  const html = buildHtmlDocument(htmlBody);

  // Use Playwright to render and print to PDF
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
      printBackground: true,
    });
  } finally {
    await browser.close();
  }

  logger.success(`PDF saved: ${pdfPath}`);
  return pdfPath;
}

function buildHtmlDocument(body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  @page { margin: 0; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 11px;
    line-height: 1.6;
    color: #1a1a1a;
    max-width: 100%;
    padding: 0;
  }

  h1 {
    font-size: 22px;
    border-bottom: 2px solid #2c3e50;
    padding-bottom: 8px;
    margin-top: 28px;
    color: #1a1a1a;
  }

  h2 {
    font-size: 17px;
    border-bottom: 1px solid #bdc3c7;
    padding-bottom: 5px;
    margin-top: 24px;
    color: #2c3e50;
  }

  h3 {
    font-size: 14px;
    margin-top: 18px;
    color: #34495e;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0;
    font-size: 10.5px;
  }

  th, td {
    border: 1px solid #ddd;
    padding: 6px 10px;
    text-align: left;
  }

  th {
    background: #f0f3f5;
    font-weight: 600;
    color: #2c3e50;
  }

  tr:nth-child(even) { background: #f9fafb; }

  code {
    background: #f0f3f5;
    padding: 1px 5px;
    border-radius: 3px;
    font-family: 'SF Mono', Monaco, 'Cascadia Code', Consolas, monospace;
    font-size: 10px;
    color: #c0392b;
  }

  pre {
    background: #f0f3f5;
    padding: 12px;
    border-radius: 4px;
    overflow-x: auto;
    font-size: 10px;
  }

  pre code {
    background: none;
    padding: 0;
    color: inherit;
  }

  ul, ol { padding-left: 20px; }
  li { margin: 3px 0; }

  blockquote {
    border-left: 3px solid #3498db;
    margin: 12px 0;
    padding: 6px 15px;
    background: #f0f7ff;
    color: #2c3e50;
  }

  strong { color: #1a1a1a; }

  a { color: #2980b9; text-decoration: none; }

  hr {
    border: none;
    border-top: 1px solid #ddd;
    margin: 20px 0;
  }

  /* Status indicators */
  p, li {
    break-inside: avoid;
  }

  h1, h2, h3 {
    break-after: avoid;
  }
</style>
</head>
<body>
${body}
</body>
</html>`;
}
