import { getDb, saveDb } from "./schema";
import type { Severity } from "../engine/divergence";

export function ensureUser(telegramId: number, username?: string): void {
  const db = getDb();
  const key = String(telegramId);
  if (!db.users[key]) {
    db.users[key] = {
      telegram_id: telegramId,
      username: username || null,
      min_severity: "medium",
      alert_cooldown: 180,
      created_at: Math.floor(Date.now() / 1000),
    };
  } else if (username) {
    db.users[key].username = username;
  }
  saveDb();
}

export function getUserSettings(telegramId: number): { minSeverity: Severity; alertCooldown: number } {
  const db = getDb();
  const user = db.users[String(telegramId)];
  return {
    minSeverity: (user?.min_severity as Severity) || "medium",
    alertCooldown: user?.alert_cooldown ?? 180,
  };
}

export function updateUserSeverity(telegramId: number, severity: Severity): void {
  const db = getDb();
  const user = db.users[String(telegramId)];
  if (user) {
    user.min_severity = severity;
    saveDb();
  }
}

export function subscribeWatch(telegramId: number, fixtureId: number): void {
  const db = getDb();
  const key = `${telegramId}:${fixtureId}`;
  if (!db.watches[key]) {
    db.watches[key] = {
      telegram_id: telegramId,
      fixture_id: fixtureId,
      alert_count: 0,
      started_at: Math.floor(Date.now() / 1000),
    };
    saveDb();
  }
}

export function unsubscribeWatch(telegramId: number, fixtureId: number): void {
  const db = getDb();
  delete db.watches[`${telegramId}:${fixtureId}`];
  saveDb();
}

export function getUserWatchList(telegramId: number): { fixture_id: number; alert_count: number }[] {
  const db = getDb();
  return Object.values(db.watches)
    .filter((w) => w.telegram_id === telegramId)
    .map((w) => ({ fixture_id: w.fixture_id, alert_count: w.alert_count }));
}

export function getSubscribersForFixture(fixtureId: number): number[] {
  const db = getDb();
  return Object.values(db.watches)
    .filter((w) => w.fixture_id === fixtureId)
    .map((w) => w.telegram_id);
}

export function incrementAlertCount(telegramId: number, fixtureId: number): void {
  const db = getDb();
  const w = db.watches[`${telegramId}:${fixtureId}`];
  if (w) {
    w.alert_count++;
    saveDb();
  }
}

export function logAlert(
  fixtureId: number,
  type: string,
  severity: string,
  title: string,
  message: string,
  data: Record<string, unknown>
): void {
  const db = getDb();
  db.alerts.push({
    id: db.nextAlertId++,
    fixture_id: fixtureId,
    type,
    severity,
    title,
    message,
    data: JSON.stringify(data),
    created_at: Math.floor(Date.now() / 1000),
  });
  // Keep last 500 alerts
  if (db.alerts.length > 500) db.alerts = db.alerts.slice(-500);
  saveDb();
}

export function getRecentAlerts(limit: number = 10) {
  const db = getDb();
  return db.alerts.slice(-limit).reverse();
}
