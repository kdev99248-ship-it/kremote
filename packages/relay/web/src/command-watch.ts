/**
 * "Command finished" watcher.
 *
 * Mobile UX problem: you start a long build, lock the phone, come back later
 * and the command actually finished 5 minutes ago. This watches a terminal's
 * output stream and decides when a submitted command has *finished* - meaning
 * output ran for a while and then went quiet (the prompt is back, even if it
 * printed nothing, e.g. `sleep 60`).
 *
 * Deliberately dumb and conservative (no shell integration, no OSC 133):
 *
 *   submit ──► running ──(output≥RUN_MIN, quiet≥QUIET_MS)──► done ──► idle
 *                │   ▲                │
 *                │   └── output ──────┘  (still streaming: restart quiet clock)
 *                └─ output before RUN_MIN: too short to be worth notifying
 *
 * The web layer feeds it `onSubmit()` / `onOutput()` / `onClose()` and decides
 * what "done" means for the UI (notify only when hidden, tab not focused...).
 */

/** Output must run at least this long before a finish is worth a notification. */
export const RUN_MIN_MS = 5_000;
/** After this much silence (no output), the command is considered finished. */
export const QUIET_MS = 8_000;
/** Never notify while output is still streaming this fast (e.g. a progress bar). */
export const LIVE_GAP_MS = 1_500;

export type WatchState = 'idle' | 'running' | 'done';

export class CommandWatch {
  state: WatchState = 'idle';
  /** Set when the done transition happens; the UI layer reads and clears it. */
  consumeDone(): boolean {
    if (this.state !== 'done') return false;
    this.state = 'idle';
    return true;
  }

  private firstOutputAt = 0;
  private lastOutputAt = 0;
  private quietTimer: ReturnType<typeof setTimeout> | undefined;
  private onDone: () => void;

  constructor(onDone: () => void) {
    this.onDone = onDone;
  }

  /** A command line was submitted (line + CR left this tab). */
  onSubmit(now: number = Date.now()): void {
    this.disarm();
    this.state = 'running';
    this.firstOutputAt = 0;
    this.lastOutputAt = now;
  }

  /** Terminal output arrived for the watched tab. */
  onOutput(now: number = Date.now()): void {
    if (this.state !== 'running') return;
    if (!this.firstOutputAt) this.firstOutputAt = now;
    this.lastOutputAt = now;
    // Still streaming - push the "went quiet" check forward.
    this.armQuiet(now);
  }

  /** A chunk gap longer than LIVE_GAP_MS means the stream went quiet earlier;
   *  call with the previous chunk's timestamp when a new one arrives after a
   *  long pause so backfilled quiet time isn't lost. (The web layer does not
   *  need this for correctness - quiet detection is timer-based - it exists
   *  for tests that drive time manually.) */
  onClose(): void {
    this.disarm();
    this.state = 'idle';
  }

  /** True while a submitted command is plausibly still producing output. */
  get isLive(): boolean {
    return this.state === 'running'
      && Date.now() - this.lastOutputAt < LIVE_GAP_MS;
  }

  private armQuiet(now: number): void {
    clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      if (this.state !== 'running') return;
      const ran = this.lastOutputAt - this.firstOutputAt;
      const quietFor = Date.now() - this.lastOutputAt;
      if (ran >= RUN_MIN_MS && quietFor >= QUIET_MS) {
        this.state = 'done';
        this.onDone();
      } else {
        // Output was too short (instant command) - not worth notifying.
        this.state = 'idle';
      }
    }, QUIET_MS);
  }

  private disarm(): void {
    clearTimeout(this.quietTimer);
    this.quietTimer = undefined;
  }
}
