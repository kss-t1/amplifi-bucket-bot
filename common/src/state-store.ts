/**
 * Minimal JSON state-file persistence for bots: read on startup, write on
 * each meaningful transition. Atomic write (tmp + rename) so a crash
 * mid-write doesn't truncate the file. Missing-file is not an error — the
 * caller's `defaultState` is returned instead.
 *
 * Not concurrency-safe: a single bot process per state file. State files
 * usually live alongside the bot under `bots/<name>/.state.{dry,live}.json`.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export class StateStore<T> {
  constructor(private readonly filePath: string) {}

  /** Read the state file. Returns `defaultState` on ENOENT; re-throws any
   *  other error (the caller usually wants to know about EACCES / parse
   *  errors rather than silently start fresh). */
  async load(defaultState: T): Promise<T> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return JSON.parse(raw) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultState;
      throw err;
    }
  }

  /** Atomic write: encode to tmp, then rename onto the target. Creates
   *  parent directories as needed. */
  async save(state: T): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(tmp, this.filePath);
  }
}

/** Default state-file path for a given bot, mode-segregated so dry-run
 *  experiments never pollute live state. Bots usually expose `STATE_FILE`
 *  as an override env var; this is the fallback. */
export function defaultStateFilePath(botDir: string, dryRun: boolean): string {
  return dryRun ? `${botDir}/.state.dry.json` : `${botDir}/.state.live.json`;
}
