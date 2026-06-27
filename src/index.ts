import { config, validateConfig } from "./utils/config";
import { logger } from "./utils/logger";
import { createBot } from "./bot/bot";
import { OddsTracker } from "./engine/odds-tracker";
import { EventTracker } from "./engine/event-tracker";
import { DivergenceDetector, severityRank } from "./engine/divergence";
import type { DivergenceAlert } from "./engine/divergence";
import type { MatchState } from "./engine/event-tracker";
import { narrateAlert } from "./engine/narrator";
import { createScoresStream } from "./txodds/scores-stream";
import { createOddsStream } from "./txodds/odds-stream";
import { getSubscribersForFixture, getUserSettings, incrementAlertCount, logAlert } from "./db/queries";
import { getDb } from "./db/schema";
import type { Bot } from "grammy";

const oddsTracker = new OddsTracker();
const eventTracker = new EventTracker();
const divergenceDetector = new DivergenceDetector();
const activeStreams = new Set<number>();

let bot: Bot;

async function deliverAlert(alert: DivergenceAlert): Promise<void> {
  const matchState = eventTracker.getMatchState(alert.fixtureId);
  const message = await narrateAlert(alert, matchState);

  const subscribers = getSubscribersForFixture(alert.fixtureId);

  for (const userId of subscribers) {
    const settings = getUserSettings(userId);
    if (severityRank(alert.severity) >= severityRank(settings.minSeverity)) {
      try {
        await bot.api.sendMessage(userId, message, { parse_mode: "Markdown" });
        incrementAlertCount(userId, alert.fixtureId);
      } catch (err) {
        logger.error("delivery", `Failed to send to ${userId}: ${(err as Error).message}`);
      }
    }
  }

  logAlert(alert.fixtureId, alert.type, alert.severity, alert.title, message, alert.data);
}

function startStreamsForFixture(fixtureId: number): void {
  if (activeStreams.has(fixtureId)) return;
  if (!config.txoddsJwt || !config.txoddsApiToken) {
    logger.warn("streams", "No TxODDS credentials — streams won't connect. Set TXODDS_JWT and TXODDS_API_TOKEN.");
    return;
  }

  activeStreams.add(fixtureId);
  logger.info("streams", `Starting streams for fixture ${fixtureId}`);

  const scoresStream = createScoresStream({
    jwt: config.txoddsJwt,
    apiToken: config.txoddsApiToken,
    fixtureId,
  });

  const oddsStream = createOddsStream({
    jwt: config.txoddsJwt,
    apiToken: config.txoddsApiToken,
    fixtureId,
  });

  scoresStream.on("data", (scoreEvent) => {
    const eventSignals = eventTracker.processScoreUpdate(scoreEvent);
    if (eventSignals.length > 0) {
      const alerts = divergenceDetector.processEventSignals(eventSignals);
      for (const alert of alerts) {
        deliverAlert(alert);
      }
    }
  });

  oddsStream.on("data", (oddsUpdate) => {
    const oddsSignals = oddsTracker.processOddsUpdate(oddsUpdate);
    if (oddsSignals.length > 0) {
      const alerts = divergenceDetector.processOddsSignals(oddsSignals);
      for (const alert of alerts) {
        deliverAlert(alert);
      }
    }
  });
}

async function main(): Promise<void> {
  validateConfig();
  getDb(); // initialize database

  bot = createBot(eventTracker, (fixtureId) => {
    startStreamsForFixture(fixtureId);
  });

  bot.start({
    onStart: () => {
      logger.info("main", "Whistle is live. Watching for opportunities...");
    },
  });

  // If TxODDS credentials are set, also start global streams
  if (config.txoddsJwt && config.txoddsApiToken) {
    logger.info("main", "Starting global TxODDS streams");

    const globalScores = createScoresStream({
      jwt: config.txoddsJwt,
      apiToken: config.txoddsApiToken,
    });

    const globalOdds = createOddsStream({
      jwt: config.txoddsJwt,
      apiToken: config.txoddsApiToken,
    });

    globalScores.on("data", (scoreEvent) => {
      const signals = eventTracker.processScoreUpdate(scoreEvent);
      if (signals.length > 0) {
        const alerts = divergenceDetector.processEventSignals(signals);
        for (const alert of alerts) deliverAlert(alert);
      }
    });

    globalOdds.on("data", (oddsUpdate) => {
      const signals = oddsTracker.processOddsUpdate(oddsUpdate);
      if (signals.length > 0) {
        const alerts = divergenceDetector.processOddsSignals(signals);
        for (const alert of alerts) deliverAlert(alert);
      }
    });
  }
}

main().catch((err) => {
  logger.error("main", `Fatal error: ${err.message}`);
  process.exit(1);
});
