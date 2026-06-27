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
      } catch {
        data = defaultData();
      }
    } else {
      data = defaultData();
      logger.info("db", "Initialized fresh data store");
    }
  }
  return data!;
}

export function saveDb(): void {
  if (!data) return;
  if (saveTimer) return; // debounce
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
    } catch (err) {
      logger.error("db", `Failed to save: ${(err as Error).message}`);
    }
  }, 1000);
}
