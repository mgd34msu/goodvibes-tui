import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.ts';
import type { GoodVibesConfig } from '../config/schema.ts';

/**
 * ProfileData - TUI-specific settings stored in a profile.
 * Excludes permissions and API keys — only display/behavior/provider settings.
 */
export interface ProfileData {
  display?: Partial<GoodVibesConfig['display']>;
  provider?: Pick<GoodVibesConfig['provider'], 'model' | 'reasoningEffort'>;
  behavior?: Partial<GoodVibesConfig['behavior']>;
}

/**
 * ProfileInfo - Summary of a saved profile.
 */
export interface ProfileInfo {
  name: string;
  timestamp: number;
  filePath: string;
}

/**
 * ProfileManager - Save and load named TUI config profiles.
 *
 * Profiles are stored as JSON files in ~/.goodvibes/tui/profiles/<name>.json.
 * Only TUI-specific settings (display, provider, behavior categories) are saved;
 * permissions and API keys are never included.
 */
export class ProfileManager {
  private profilesDir: string;
  private lastTimestamp = 0;

  constructor(baseDir?: string) {
    this.profilesDir = baseDir ?? join(homedir(), '.goodvibes', 'tui', 'profiles');
  }

  /**
   * save - Persist a profile under the given name.
   * Overwrites an existing profile with the same name.
   */
  public save(name: string, data: ProfileData): string {
    if (!name || !name.trim()) throw new Error('Profile name cannot be empty');
    mkdirSync(this.profilesDir, { recursive: true });
    const sanitizedName = this.sanitizeName(name);
    const filePath = join(this.profilesDir, `${sanitizedName}.json`);
    const record = {
      name: sanitizedName,
      timestamp: this.nextTimestamp(),
      display: data.display ?? {},
      provider: data.provider ?? {},
      behavior: data.behavior ?? {},
    };
    writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
    logger.debug('ProfileManager: saved profile', { name: sanitizedName, filePath });
    return filePath;
  }

  /**
   * load - Load a profile by name. Returns the profile data or throws if not found.
   */
  public load(name: string): { data: ProfileData; timestamp: number } {
    if (!name || !name.trim()) throw new Error('Profile name cannot be empty');
    const sanitizedName = this.sanitizeName(name);
    const filePath = join(this.profilesDir, `${sanitizedName}.json`);
    if (!existsSync(filePath)) {
      throw new Error(`Profile not found: ${name}`);
    }
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const record = JSON.parse(raw) as Record<string, unknown>;
      return {
        timestamp: Number(record.timestamp ?? 0),
        data: {
          display: (record.display as Partial<GoodVibesConfig['display']>) ?? {},
          provider: record.provider as Pick<GoodVibesConfig['provider'], 'model' | 'reasoningEffort'>,
          behavior: (record.behavior as Partial<GoodVibesConfig['behavior']>) ?? {},
        },
      };
    } catch (e) {
      throw new Error(`Failed to parse profile "${name}": ${(e as Error).message}`);
    }
  }

  /**
   * list - Return all saved profiles sorted by most recent first.
   */
  public list(): ProfileInfo[] {
    if (!existsSync(this.profilesDir)) return [];
    let files: string[];
    try {
      files = readdirSync(this.profilesDir).filter(f => f.endsWith('.json'));
    } catch {
      return [];
    }
    const profiles: ProfileInfo[] = [];
    for (const file of files) {
      const name = file.replace(/\.json$/, '');
      const filePath = join(this.profilesDir, file);
      let timestamp = 0;
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const record = JSON.parse(raw) as Record<string, unknown>;
        timestamp = Number(record.timestamp ?? 0);
      } catch {
        // Skip unreadable files
        continue;
      }
      profiles.push({ name, timestamp, filePath });
    }
    profiles.sort((a, b) => {
      if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
      return b.name.localeCompare(a.name);
    });
    return profiles;
  }

  private nextTimestamp(): number {
    const now = Date.now();
    this.lastTimestamp = now > this.lastTimestamp ? now : this.lastTimestamp + 1;
    return this.lastTimestamp;
  }

  /**
   * delete - Remove a profile by name. Returns true if deleted, false if not found.
   */
  public delete(name: string): boolean {
    if (!name || !name.trim()) return false;
    const sanitizedName = this.sanitizeName(name);
    const filePath = join(this.profilesDir, `${sanitizedName}.json`);
    if (!existsSync(filePath)) return false;
    try {
      unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * sanitizeName - Safe filename from profile name.
   */
  public sanitizeName(name: string): string {
    return name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9_-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      || 'profile';
  }
}

/** Lazy singleton. */
let _instance: ProfileManager | undefined;
export function getProfileManager(): ProfileManager {
  if (!_instance) _instance = new ProfileManager();
  return _instance;
}
