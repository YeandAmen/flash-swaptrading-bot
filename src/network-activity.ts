import { redactDiagnostic } from './diagnostics.js';

type Level = 'info' | 'warn' | 'trade' | 'error';
type Activity = { t: number; level: Level; message: string; link?: string };

export class NetworkActivity {
  private readonly entries: Activity[] = [];

  record(level: Level, message: string, link?: string, t = Date.now()) {
    const safe = redactDiagnostic(message).split('\n')[0].slice(0, 280);
    const last = this.entries[0];
    if (last?.level === level && last.message === safe && last.link === link) return;
    this.entries.unshift({ t, level, message: safe, link });
    this.entries.length = Math.min(this.entries.length, 30);
  }

  view() { return this.entries.slice(); }
}
