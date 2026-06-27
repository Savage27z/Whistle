import Anthropic from "@anthropic-ai/sdk";
import { config } from "../utils/config";
import { logger } from "../utils/logger";
import type { DivergenceAlert } from "./divergence";
import type { MatchState } from "./event-tracker";

let client: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (!config.anthropicApiKey) return null;
  if (!client) client = new Anthropic({ apiKey: config.anthropicApiKey });
  return client;
}

export async function narrateAlert(alert: DivergenceAlert, matchState?: MatchState): Promise<string> {
  const anthropic = getClient();
  if (!anthropic) return formatFallback(alert, matchState);

  const team1 = matchState?.team1 || "Home";
  const team2 = matchState?.team2 || "Away";
  const score = matchState ? `${matchState.score[0]}-${matchState.score[1]}` : "?-?";
  const minute = matchState?.minute || "?";
  const phase = matchState?.phase || "?";

  const prompt = `You are Whistle, a sharp sports trading intelligence bot. Write a concise Telegram alert (max 4 lines) for this signal. Be direct, use trading language, include the key numbers. No fluff.

Match: ${team1} vs ${team2} | Score: ${score} | Minute: ${minute}' | Phase: ${phase}

Alert type: ${alert.type}
Severity: ${alert.severity}
Raw description: ${alert.description}
Data: ${JSON.stringify(alert.data)}

Format: Use emoji prefix based on severity (🔴 critical, 🟠 high, 🟡 medium, ⚪ low). First line is the headline. Rest is the actionable insight. End with the implied trading angle if obvious.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0];
    if (text.type === "text" && text.text) return text.text;
    return formatFallback(alert, matchState);
  } catch (err) {
    logger.error("narrator", `AI narration failed: ${(err as Error).message}`);
    return formatFallback(alert, matchState);
  }
}

function severityEmoji(severity: string): string {
  switch (severity) {
    case "critical": return "🔴";
    case "high": return "🟠";
    case "medium": return "🟡";
    default: return "⚪";
  }
}

function formatFallback(alert: DivergenceAlert, matchState?: MatchState): string {
  const emoji = severityEmoji(alert.severity);
  const team1 = matchState?.team1 || "Home";
  const team2 = matchState?.team2 || "Away";
  const score = matchState ? `${matchState.score[0]}-${matchState.score[1]}` : "";
  const minute = matchState?.minute ? `${matchState.minute}'` : "";
  const header = [team1, "vs", team2, score, minute].filter(Boolean).join(" ");

  return `${emoji} *${alert.title.toUpperCase()}*\n${header}\n\n${alert.description}`;
}
