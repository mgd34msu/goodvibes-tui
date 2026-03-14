import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * ActivityLogger — Persistent debug logger for GoodVibes.
 * Writes to .goodvibes/logs/activity.md
 */
class ActivityLogger {
  private logPath: string;

  constructor() {
    const logDir = join(process.cwd(), '.goodvibes/logs');
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    this.logPath = join(logDir, 'activity.md');
  }

  private write(level: string, message: string, data?: any) {
    const timestamp = new Date().toISOString();
    let entry = `[${timestamp}] [${level}] ${message}\n`;
    if (data) {
      entry += '```json\n' + JSON.stringify(data, null, 2) + '\n```\n';
    }
    appendFileSync(this.logPath, entry);
  }

  info(message: string, data?: any) { this.write('INFO', message, data); }
  error(message: string, data?: any) { this.write('ERROR', message, data); }
  debug(message: string, data?: any) { this.write('DEBUG', message, data); }
}

export const logger = new ActivityLogger();
