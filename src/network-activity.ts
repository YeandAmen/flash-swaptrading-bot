import { redactDiagnostic } from './diagnostics.js';

type Level = 'info' | 'warn' | 'trade' | 'error';
type Activity = { t: number; level: Level; message: string; link?: string };
const scanWindowMinutes = 30;
const scanWindowMs = scanWindowMinutes * 60_000;

export class NetworkActivity {
  private readonly entries: Activity[] = [];
  private scans: { at: number; routes: number }[] = [];

  record(level: Level, message: string, link?: string, t = Date.now()) {
    const safe = redactDiagnostic(message).split('\n')[0].slice(0, 280);
    const last = this.entries[0];
    if (last?.level === level && last.message === safe && last.link === link) return;
    this.entries.unshift({ t, level, message: safe, link });
    this.entries.length = Math.min(this.entries.length, 30);
  }

  view() { return this.entries.slice(); }

  recordScan(routes: number, at = Date.now()) {
    this.scans = this.scans.filter((scan) => scan.at > at - scanWindowMs);
    this.scans.push({ at, routes });
  }

  scanWindow(now = Date.now()) {
    const recent = this.scans.filter((scan) => scan.at > now - scanWindowMs);
    return { minutes: scanWindowMinutes, scans: recent.length, routes: recent.reduce((total, scan) => total + scan.routes, 0) };
  }
}
