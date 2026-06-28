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
import { formatMatchLine } from "./formatters";
import type { EventTracker } from "../engine/event-tracker";
import type { Severity } from "../engine/divergence";
import { logger } from "../utils/logger";
import { escHtml } from "../engine/narrator";

export function setupCommands(
  bot: Bot,
  eventTracker: EventTracker,
  onWatch: (fixtureId: number) => void,
  getStreamHealth: () => { active: number; globalConnected: boolean },
): void {
  bot.api.setMyCommands([
    { command: "start", description: "Welcome message and overview" },
    { command: "watch", description: "Pick a live match to monitor" },
    { command: "unwatch", description: "Stop watching a match" },
    { command: "live", description: "View your watched matches" },
    { command: "alerts", description: "Recent divergence alerts" },
    { command: "settings", description: "Configure alert severity" },
    { command: "stats", description: "Alert statistics" },
    { command: "status", description: "Bot connection status" },
    { command: "help", description: "How Whistle works" },
  ]).catch(() => {});

  bot.command("help", async (ctx) => {
    await ctx.reply(
      `📖 <b>How Whistle Works</b>\n\n` +
        `Whistle connects to TxODDS live data streams and cross-references odds movements with match events in real-time.\n\n` +
        `<b>Divergence patterns I detect:</b>\n\n` +
        `🔴 <b>Silent Odds Shift</b> — Multiple bookmakers move odds sharply with no visible match event. Could signal insider info, injury, or tactical change.\n\n` +
        `🔴 <b>Odds Collapse</b> — Odds crash from 1.50+ to below 1.20. Outcome is near-certain — check for unreported events.\n\n` +
        `🟠 <b>Delayed Market Reaction</b> — A goal, red card, or penalty happens but odds haven't adjusted within 10s. The market is slow.\n\n` +
        `🟡 <b>Momentum Mispricing</b> — Sustained attacking pressure (3+ danger possessions) but odds haven't shortened. Goal probability is underpriced.\n\n` +
        `🟡 <b>Goal Imminent</b> — TxODDS signals an imminent goal but Over/BTTS market hasn't tightened.\n\n` +
        `⚪ <b>Bookmaker Disagreement</b> — 20%+ spread across 3+ bookmakers on the same market. Someone knows something.\n\n` +
        `<b>Match events:</b> You'll also receive instant alerts for goals ⚽, red cards 🟥, penalties ⚠️, and VAR reviews 📺.\n\n` +
        `<b>Commands:</b>\n` +
        `/watch — Pick a match to monitor\n` +
        `/unwatch — Stop monitoring\n` +
        `/live — Your active matches\n` +
        `/alerts — Recent alerts\n` +
        `/settings — Set minimum severity\n` +
        `/stats — Alert breakdown\n` +
        `/status — Connection health`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("start", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId) ensureUser(userId, ctx.from?.username);

    await ctx.reply(
      `⚽ <b>Welcome to Whistle</b>\n\n` +
        `I watch live World Cup matches through TxODDS data feeds and alert you to trading opportunities in real-time.\n\n` +
        `<b>What I detect:</b>\n` +
        `🔴 Silent odds shifts — market moves with no visible event\n` +
        `🟠 Delayed reactions — big events the market hasn't priced\n` +
        `🟡 Momentum mispricing — sustained pressure not in the odds\n` +
        `⚪ Bookmaker disagreement — some books know more\n\n` +
        `Plus instant match event alerts: goals, red cards, penalties, VAR.\n\n` +
        `Use /watch to pick a live match and start receiving alerts.`,
      { parse_mode: "HTML" }
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
      const matchState = eventTracker.getMatchState(fixtureId);
      const label = matchState ? `${matchState.team1} vs ${matchState.team2}` : `fixture ${fixtureId}`;
      return ctx.reply(`✅ Now watching ${escHtml(label)}. I'll alert you when I spot something.\n\nUse /unwatch to stop.`);
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

      await ctx.reply("<b>Select a match to watch:</b>", {
        reply_markup: keyboard,
        parse_mode: "HTML",
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

    const matchState = eventTracker.getMatchState(fixtureId);
    const label = matchState ? `${matchState.team1} vs ${matchState.team2}` : `match ${fixtureId}`;

    await ctx.answerCallbackQuery({ text: "Watching! You'll get alerts." });
    await ctx.editMessageText(
      `✅ Now watching <b>${escHtml(label)}</b>. I'll alert you when I spot something.\n\nUse /unwatch to stop.`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("unwatch", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const args = ctx.match?.trim();
    if (args) {
      const fixtureId = parseInt(args, 10);
      if (isNaN(fixtureId)) {
        return ctx.reply("Invalid fixture ID.");
      }
      unsubscribeWatch(userId, fixtureId);
      return ctx.reply(`Stopped watching fixture ${fixtureId}.`);
    }

    const watching = getUserWatchList(userId);
    if (watching.length === 0) {
      return ctx.reply("You're not watching any matches.");
    }

    const keyboard = new InlineKeyboard();
    for (const w of watching) {
      const state = eventTracker.getMatchState(w.fixture_id);
      const label = state ? `${state.team1} vs ${state.team2}` : `Fixture ${w.fixture_id}`;
      keyboard.text(`❌ ${label}`, `unwatch:${w.fixture_id}`).row();
    }

    await ctx.reply("<b>Tap a match to stop watching:</b>", {
      reply_markup: keyboard,
      parse_mode: "HTML",
    });
  });

  bot.callbackQuery(/^unwatch:(\d+)$/, async (ctx) => {
    const fixtureId = parseInt(ctx.match![1]);
    const userId = ctx.from.id;

    unsubscribeWatch(userId, fixtureId);
    const state = eventTracker.getMatchState(fixtureId);
    const label = state ? `${state.team1} vs ${state.team2}` : `fixture ${fixtureId}`;

    await ctx.answerCallbackQuery({ text: "Stopped watching." });
    await ctx.editMessageText(`Stopped watching ${escHtml(label)}.`);
  });

  bot.command("live", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const watching = getUserWatchList(userId);
    if (watching.length === 0) {
      return ctx.reply("You're not watching any matches. Use /watch to start.");
    }

    let msg = "<b>Your live matches:</b>\n\n";
    for (const w of watching) {
      const state = eventTracker.getMatchState(w.fixture_id);
      if (state) {
        msg += formatMatchLine(state, w.alert_count) + "\n\n";
      } else {
        msg += `📋 Fixture ${w.fixture_id} — awaiting data\n   Alerts sent: ${w.alert_count}\n\n`;
      }
    }

    await ctx.reply(msg, { parse_mode: "HTML" });
  });

  bot.command("alerts", async (ctx) => {
    const alerts = getRecentAlerts(5);
    if (alerts.length === 0) {
      return ctx.reply("No alerts yet. Watch a match with /watch to start receiving alerts.");
    }

    let msg = "<b>Recent Alerts:</b>\n\n";
    for (const a of alerts) {
      const time = new Date(a.created_at * 1000).toLocaleTimeString();
      msg += `${a.message}\n<i>${escHtml(time)}</i>\n\n`;
    }

    await ctx.reply(msg, { parse_mode: "HTML" });
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
      `<b>Your Settings</b>\n\nMinimum alert severity: <b>${escHtml(settings.minSeverity)}</b>\n\nTap to change:`,
      { parse_mode: "HTML", reply_markup: keyboard }
    );
  });

  bot.callbackQuery(/^severity:(\w+)$/, async (ctx) => {
    const severity = ctx.match![1] as Severity;
    const userId = ctx.from.id;
    updateUserSeverity(userId, severity);
    await ctx.answerCallbackQuery({ text: `Severity set to ${severity}` });
    await ctx.editMessageText(`✅ Minimum alert severity set to: <b>${escHtml(severity)}</b>`, { parse_mode: "HTML" });
  });

  bot.command("stats", async (ctx) => {
    const alerts = getRecentAlerts(100);
    const byType: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    for (const a of alerts) {
      byType[a.type] = (byType[a.type] || 0) + 1;
      bySeverity[a.severity] = (bySeverity[a.severity] || 0) + 1;
    }

    let msg = `<b>Whistle Stats</b>\n\nTotal alerts: ${alerts.length}\n\n`;

    if (Object.keys(bySeverity).length > 0) {
      msg += `<b>By severity:</b>\n`;
      for (const [sev, count] of Object.entries(bySeverity)) {
        msg += `  ${sev}: ${count}\n`;
      }
      msg += `\n`;
    }

    msg += `<b>By type:</b>\n`;
    for (const [type, count] of Object.entries(byType)) {
      msg += `  ${type.replace(/_/g, " ")}: ${count}\n`;
    }

    await ctx.reply(msg, { parse_mode: "HTML" });
  });

  bot.command("status", async (ctx) => {
    const health = getStreamHealth();
    const fixtureCount = health.active;
    const global = health.globalConnected ? "✅ Connected" : "❌ Disconnected";

    let msg = `<b>Whistle Status</b>\n\n`;
    msg += `TxODDS streams: ${global}\n`;
    msg += `Active fixtures: ${fixtureCount}\n`;

    const watching = getUserWatchList(ctx.from?.id || 0);
    msg += `Your watches: ${watching.length}\n`;

    for (const w of watching) {
      const state = eventTracker.getMatchState(w.fixture_id);
      if (state) {
        const ago = Math.round((Date.now() - state.lastEventTs) / 1000);
        msg += `  • ${escHtml(state.team1)} vs ${escHtml(state.team2)} — last data ${ago}s ago\n`;
      } else {
        msg += `  • Fixture ${w.fixture_id} — no data yet\n`;
      }
    }

    await ctx.reply(msg, { parse_mode: "HTML" });
  });
}
