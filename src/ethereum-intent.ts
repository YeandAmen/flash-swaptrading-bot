import { writeJson } from './persistence.js';
import { readPrivateFile } from './private-file.js';

type Mode = 'spot' | 'mev';
type Target = Mode | 'both';
type Intent = { version: 1; spot: boolean; mev: boolean };
type StartupActions = {
  ready: () => boolean;
  spotArmed: () => boolean;
  mevMode: () => string | undefined;
  armSpot: () => void;
  armMev: () => void;
};

const restorePollMs = 5_000;
const armRetryMs = 30_000;

export class EthereumIntent {
  private desired: Intent = { version: 1, spot: false, mev: false };
  private fault: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly file: string, private readonly restoreEnabled: boolean,
    private readonly report: (message: string) => void) {
    try {
      const saved = JSON.parse(readPrivateFile(file, 256)) as Partial<Intent> | null;
      if (saved?.version !== 1 || typeof saved.spot !== 'boolean' || typeof saved.mev !== 'boolean') {
        throw new Error('Invalid Ethereum live intent');
      }
      this.desired = { version: 1, spot: saved.spot, mev: saved.mev };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.fault = 'Ethereum live intent could not be read. Automatic arming is disabled.';
      }
    }
  }

  set(target: Target, armed: boolean) {
    if (this.fault) {
      if (armed && this.restoreEnabled) throw new Error(this.fault);
      return;
    }
    const next: Intent = {
      version: 1,
      spot: target === 'mev' ? this.desired.spot : armed,
      mev: target === 'spot' ? this.desired.mev : armed,
    };
    if (next.spot === this.desired.spot && next.mev === this.desired.mev) return;
    try {
      writeJson(this.file, next);
      this.desired = next;
    } catch (error) {
      this.fault = 'Ethereum live intent could not be saved. Automatic arming is disabled.';
      this.stop();
      throw new Error(this.fault, { cause: error });
    }
  }

  restore(actions: StartupActions) {
    if (!this.restoreEnabled || this.stopped || this.timer) return;
    if (this.fault) {
      this.report(this.fault);
      return;
    }
    const restored = { spot: false, mev: false };
    const retryAt = { spot: 0, mev: 0 };
    const reported = { spot: '', mev: '' };
    const attempt = (mode: Mode, arm: () => void) => {
      const now = Date.now();
      if (now < retryAt[mode]) return;
      retryAt[mode] = now + armRetryMs;
      try {
        arm();
        reported[mode] = '';
      } catch (error) {
        const message = `Could not restore Ethereum ${mode} live mode: ${String(error).split('\n')[0]}`;
        if (message !== reported[mode]) this.report(message);
        reported[mode] = message;
      }
    };
    const pending = (mode: Mode) => this.desired[mode] && !restored[mode];
    const check = () => {
      this.timer = null;
      if (this.stopped || (!pending('spot') && !pending('mev'))) return;
      if (actions.ready()) {
        if (pending('spot')) {
          if (!actions.spotArmed()) attempt('spot', actions.armSpot);
          restored.spot = actions.spotArmed();
        }
        if (pending('mev')) {
          const mode = actions.mevMode();
          if (mode === 'paper') attempt('mev', actions.armMev);
          restored.mev = actions.mevMode() === 'live';
        }
      }
      if (!this.stopped && (pending('spot') || pending('mev'))) {
        this.timer = setTimeout(check, restorePollMs);
        this.timer.unref();
      }
    };
    check();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
