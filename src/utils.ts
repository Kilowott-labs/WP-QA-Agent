import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';

// ── Logger ────────────────────────────────────────────────────────────────

export const logger = {
  info: (msg: string) => console.log(chalk.blue('ℹ'), msg),
  success: (msg: string) => console.log(chalk.green('✓'), msg),
  warn: (msg: string) => console.log(chalk.yellow('⚠'), msg),
  error: (msg: string) => console.log(chalk.red('✗'), msg),
  section: (msg: string) => {
    console.log('');
    console.log(chalk.bold.cyan(`── ${msg} ──`));
  },
  dim: (msg: string) => console.log(chalk.dim(`  ${msg}`)),
};

// ── WordPress Auth ────────────────────────────────────────────────────────

export function getAuthHeader(username: string, appPassword: string): string {
  const encoded = Buffer.from(`${username}:${appPassword}`).toString('base64');
  return `Basic ${encoded}`;
}

// ── URL Helpers ───────────────────────────────────────────────────────────

export function baseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export function resolveUrl(site: string, pathOrUrl: string): string {
  if (pathOrUrl.startsWith('http')) return pathOrUrl;
  return `${baseUrl(site)}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
}

export function isThirdParty(requestUrl: string, siteUrl: string): boolean {
  try {
    const req = new URL(requestUrl);
    const site = new URL(siteUrl);
    return req.hostname !== site.hostname;
  } catch {
    return true;
  }
}

// ── String Helpers ────────────────────────────────────────────────────────

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

// ── File Helpers ──────────────────────────────────────────────────────────

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function writeJson(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export async function readJson<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(raw) as T;
}

// ── Timing ────────────────────────────────────────────────────────────────

export function elapsed(startMs: number): number {
  return Date.now() - startMs;
}

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
