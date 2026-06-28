import { Bot, InlineKeyboard } from "grammy";
import { fetchFixtures } from "../txodds/client";
import {
  ensureUser,
  subscribeWatch,
  unsubscribeWatch,
  getUserWatchList,
  getRecentAlerts,
  getUserSettings,
  updateUserSeverity,
} from "../db/queries";
import { formatMatchLine, formatPhase } from "./formatters";
import type { EventTracker } from "../engine/event-tracker";
import type { Severity } from "../engine/divergence";
import { logger } from "../utils/logger";

export function setupCommands(bot: Bot, eventTracker: EventTracker, onWatch: (fixtureId: number) => void): void {
  bot.api.setMyCommands([
    { command: "start", description: "Welcome message and overview" },
    { command: "watch", description: "Pick a live match to monitor" },
    { command: "unwatch", description: "Stop watching a match" },
    { command: "live", description: "View your watched matches" },
    { command: "alerts", description: "Recent divergence alerts" },
    { command: "settings", description: "Configure alert severity" },
    { command: "stats", description: "Alert statistics" },
    { command: "help", description: "How Whistle works" },
  ]).catch(() => {});

  bot.command("help", async (ctx) => {
    await ctx.reply(
      `📖 *How Whistle Works*\n\n` +
        `Whistle connects to TxODDS live data streams and cross\\-references odds movements with match events in real\\-time\\.\n\n` +
        `*Divergence patterns I detect:*\n\n` +
        `🔴 *Silent Odds Shift* — Multiple bookmakers move odds sharply with no visible match event\\. Could signal insider info, injury, or tactical change\\.\n\n` +
        `🟠 *Delayed Market Reaction* — A goal, red card, or penalty happens but odds haven't adjusted within 10s\\. The market is slow\\.\n\n` +
        `🟡 *Momentum Mispricing* — Sustained attacking pressure \\(3\\+ danger possessions\\) but odds haven't shortened\\. Goal probability is underpriced\\.\n\n` +
        `⚪ *Bookmaker Disagreement* — \\>15% spread across bookmakers on the same market\\. Someone knows something\\.\n\n` +
        `*Commands:*\n` +
        `/watch — Pick a match to monitor\n` +
        `/unwatch — Stop monitoring\n` +
        `/live — Your active matches\n` +
        `/alerts — Recent alerts\n` +
        `/settings — Set minimum severity\n` +
        `/stats — Alert breakdown`,
      { parse_mode: "MarkdownV2" }
    );
  });

  bot.command("start", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId) ensureUser(userId, ctx.from?.username);

    await ctx.reply(
      `⚽ *Welcome to Whistle*\n\n` +
        `I watch live World Cup matches through TxODDS data feeds and alert you to trading opportunities in real\\-time\\.\n\n` +
        `*What I detect:*\n` +
        `🔴 Silent odds shifts — market moves with no visible event\n` +
        `🟠 Delayed reactions — big events the market hasn't priced\n` +
        `🟡 Momentum mispricing — sustained pressure not in the odds\n` +
        `⚪ Bookmaker disagreement — some books know more\n\n` +
        `Use /watch to pick a live match and start receiving alerts\\.`,
      { parse_mode: "MarkdownV2" }
    );
  });

  bot.command("watch", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    ensureUser(userId, ctx.from?.username);

    const args = ctx.match?.trim();
    if (args) {
      const fixtureId = parseInt(args, 10);
      if (isNaN(fixtureId)) {
        return ctx.reply("Invalid fixture ID. Use /watch to see available matches.");
      }
      subscribeWatch(userId, fixtureId);
      onWatch(fixtureId);
      return ctx.reply(`✅ Now watching fixture ${fixtureId}. I'll alert you when I spot something.\n\nUse /unwatch ${fixtureId} to stop.`);
    }

    try {
      const fixtures = await fetchFixtures();
      if (fixtures.length === 0) {
        return ctx.reply("No live World Cup matches right now. Check back during match time!\n\nYou can also use /watch <fixtureId> if you know the fixture ID.");
      }

      const keyboard = new InlineKeyboard();
      for (const f of fixtures) {
        const label = `${f.team1} vs ${f.team2}`;
        keyboard.text(label, `watch:${f.fixtureId}`).row();
      }

      await ctx.reply("*Select a match to watch:*", {
        reply_markup: keyboard,
        parse_mode: "Markdown",
      });
    } catch (err) {
      logger.error("bot", `Failed to fetch fixtures: ${(err as Error).message}`);
      await ctx.reply("Couldn't fetch matches right now. You can use /watch <fixtureId> directly if you know the ID.");
    }
  });

  bot.callbackQuery(/^watch:(\d+)$/, async (ctx) => {
    const fixtureId = parseInt(ctx.match![1]);
    const userId = ctx.from.id;

    ensureUser(userId, ctx.from.username);
    subscribeWatch(userId, fixtureId);
    onWatch(fixtureId);

    await ctx.answerCallbackQuery({ text: "Watching! You'll get alerts." });
    await ctx.editMessageText(
      `✅ Now watching match ${fixtureId}. I'll alert you when I spot something.\n\nUse /unwatch ${fixtureId} to stop.`
    );
  });

  bot.command("unwatch", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const args = ctx.match?.trim();
    if (!args) {
      return ctx.reply("Usage: /unwatch <fixtureId>");
    }
    const fixtureId = parseInt(args, 10);
    if (isNaN(fixtureId)) {
      return ctx.reply("Invalid fixture ID.");
    }

    unsubscribeWatch(userId, fixtureId);
    await ctx.reply(`Stopped watching fixture ${fixtureId}.`);
  });

  bot.command("live", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const watching = getUserWatchList(userId);
    if (watching.length === 0) {
      return ctx.reply("You're not watching any matches. Use /watch to start.");
    }

    let msg = "*Your live matches:*\n\n";
    for (const w of watching) {
      const state = eventTracker.getMatchState(w.fixture_id);
      if (state) {
        msg += formatMatchLine(state, w.alert_count) + "\n\n";
      } else {
        msg += `📋 Fixture ${w.fixture_id} — awaiting data\n   Alerts sent: ${w.alert_count}\n\n`;
      }
    }

    await ctx.reply(msg, { parse_mode: "MarkdownV2" });
  });

  bot.command("alerts", async (ctx) => {
    const alerts = getRecentAlerts(5);
    if (alerts.length === 0) {
      return ctx.reply("No alerts yet. Watch a match with /watch to start receiving alerts.");
    }

    let msg = "*Recent Alerts:*\n\n";
    for (const a of alerts) {
      const time = new Date(a.created_at * 1000).toLocaleTimeString();
      msg += `${a.message}\n_${time}_\n\n`;
    }

    await ctx.reply(msg, { parse_mode: "Markdown" });
  });

  bot.command("settings", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const args = ctx.match?.trim();
    if (args) {
      const validSeverities: Severity[] = ["low", "medium", "high", "critical"];
      if (validSeverities.includes(args as Severity)) {
        updateUserSeverity(userId, args as Severity);
        return ctx.reply(`✅ Minimum alert severity set to: ${args}`);
      }
      return ctx.reply("Invalid severity. Options: low, medium, high, critical");
    }

    const settings = getUserSettings(userId);
    const keyboard = new InlineKeyboard()
      .text("⚪ Low", "severity:low")
      .text("🟡 Medium", "severity:medium")
      .row()
      .text("🟠 High", "severity:high")
      .text("🔴 Critical", "severity:critical");

    await ctx.reply(
      `*Your Settings*\n\nMinimum alert severity: *${settings.minSeverity}*\n\nTap to change:`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
  });

  bot.callbackQuery(/^severity:(\w+)$/, async (ctx) => {
    const severity = ctx.match![1] as Severity;
    const userId = ctx.from.id;
    updateUserSeverity(userId, severity);
    await ctx.answerCallbackQuery({ text: `Severity set to ${severity}` });
    await ctx.editMessageText(`✅ Minimum alert severity set to: *${severity}*`, { parse_mode: "Markdown" });
  });

  bot.command("stats", async (ctx) => {
    const alerts = getRecentAlerts(100);
    const byType: Record<string, number> = {};
    for (const a of alerts) {
      byType[a.type] = (byType[a.type] || 0) + 1;
    }

    let msg = `*Whistle Stats*\n\nTotal alerts: ${alerts.length}\n\n`;
    for (const [type, count] of Object.entries(byType)) {
      msg += `• ${type.replace(/_/g, " ")}: ${count}\n`;
    }

    await ctx.reply(msg, { parse_mode: "Markdown" });
  });
}
