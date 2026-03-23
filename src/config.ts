import fs from 'fs/promises';
import yaml from 'js-yaml';
import path from 'path';
import { SiteConfig } from './types.js';

const DEFAULTS: Partial<SiteConfig> = {
  run_ecommerce_flow: true,
  run_auth_flow: true,
  run_mobile_tests: true,
  mobile_viewport: { width: 375, height: 812 },
  max_links_to_crawl: 30,
  timeout_ms: 30000,
};

export async function loadConfig(configPath: string): Promise<SiteConfig> {
  const abs = path.resolve(configPath);
  const raw = await fs.readFile(abs, 'utf-8');
  const parsed = yaml.load(raw) as Partial<SiteConfig>;

  if (!parsed.url) {
    throw new Error(`Config file ${configPath} missing required "url" field`);
  }
  if (!parsed.name) {
    parsed.name = parsed.url;
  }

  // Merge defaults with parsed config — parsed values take priority
  // key_pages is optional — pages are auto-discovered from site navigation
  return { ...DEFAULTS, ...parsed } as SiteConfig;
}

export function configFromCLI(opts: {
  url: string;
  username?: string;
  password?: string;
  project?: string;
}): SiteConfig {
  return {
    ...DEFAULTS,
    name: opts.url,
    url: opts.url,
    username: opts.username,
    app_password: opts.password,
    project_path: opts.project,
  } as SiteConfig;
}
