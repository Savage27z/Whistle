import { Bot } from "grammy";
import { config } from "../utils/config";
import { setupCommands } from "./commands";
import { logger } from "../utils/logger";
import type { EventTracker } from "../engine/event-tracker";
import type { DivergenceDetector } from "../engine/divergence";
import type { OddsTracker } from "../engine/odds-tracker";

export function createBot(
  eventTracker: EventTracker,
  onWatch: (fixtureId: number) => Promise<void>,
  getStreamHealth: () => { active: number; globalConnected: boolean },
  divergenceDetector: DivergenceDetector,
  oddsTracker: OddsTracker,
): Bot {
  const bot = new Bot(config.telegramBotToken);

  bot.catch((err) => {
    const cmd = err.ctx?.update?.message?.text?.split(" ")[0] || "unknown";
    logger.error("bot", `Unhandled error in ${cmd}: ${err.message}`);
  });

  setupCommands(bot, eventTracker, onWatch, getStreamHealth, divergenceDetector, oddsTracker);

  logger.info("bot", "Telegram bot initialized");
  return bot;
}
