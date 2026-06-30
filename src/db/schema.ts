import fs from "fs";
import path from "path";
import { logger } from "../utils/logger";

export interface DbData {
  users: Record<string, { telegram_id: number; username: string | null; min_severity: string; alert_cooldown: number; created_at: number }>;
  watches: Record<string, { telegram_id: number; fixture_id: number; alert_count: number; started_at: number }>;
  alerts: { id: number; fixture_id: number; type: string; severity: string; title: string; message: string; data: string; created_at: number }[];
  nextAlertId: number;
}

const DB_PATH = path.join(process.cwd(), "whistle-data.json");
let data: DbData | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function defaultData(): DbData {
  return { users: {}, watches: {}, alerts: [], nextAlertId: 1 };
}

export function getDb(): DbData {
  if (!data) {
    if (fs.existsSync(DB_PATH)) {
      try {
        data = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
        logger.info("db", `Loaded data from ${DB_PATH}`);
      } catch (err) {
        logger.error("db", `Corrupt or unreadable ${DB_PATH}, starting fresh: ${(err as Error).message}`);
        data = defaultData();
      }
    } else {
      data = defaultData();
      logger.info("db", "Initialized fresh data store");
    }
  }
  return data!;
}

function writeNow(): void {
  if (!data) return;
  try {
    const tmpPath = `${DB_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, DB_PATH);
  } catch (err) {
    logger.error("db", `Failed to save: ${(err as Error).message}`);
  }
}

export function saveDb(): void {
  if (!data) return;
  if (saveTimer) return; // debounce
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeNow();
  }, 1000);
}

// Flush any pending debounced write immediately — call before process exit
// so the last <1s of activity (e.g. before a SIGTERM redeploy) isn't lost.
export function flushDb(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  writeNow();
}
