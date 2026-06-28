import { Bot } from "grammy";
import { config } from "../utils/config";
import { setupCommands } from "./commands";
import { logger } from "../utils/logger";
import type { EventTracker } from "../engine/event-tracker";
import type { DivergenceDetector } from "../engine/divergence";
import type { OddsTracker } from "../engine/odds-tracker";

export function createBot(
  eventTracker: EventTracker,
  onWatch: (fixtureId: number) => void,
  getStreamHealth: () => { active: number; globalConnected: boolean },
  divergenceDetector: DivergenceDetector,
  oddsTracker: OddsTracker,
): Bot {
  const bot = new Bot(config.telegramBotToken);

  bot.catch((err) => {
    logger.error("bot", `Unhandled error: ${err.message}`);
  });

  setupCommands(bot, eventTracker, onWatch, getStreamHealth, divergenceDetector, oddsTracker);

  logger.info("bot", "Telegram bot initialized");
  return bot;
}
