import type { OddsSignal } from "./odds-tracker";
import type { EventSignal } from "./event-tracker";
import { logger } from "../utils/logger";

export type AlertType = "silent_odds_shift" | "delayed_market_reaction" | "momentum_mispricing" | "value_spot" | "odds_event_divergence";
export type Severity = "low" | "medium" | "high" | "critical";

export interface DivergenceAlert {
  type: AlertType;
  severity: Severity;
  fixtureId: number;
  title: string;
  description: string;
  data: Record<string, unknown>;
  ts: number;
}

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function severityRank(s: Severity): number {
  return SEVERITY_RANK[s] ?? 0;
}

export class DivergenceDetector {
  private recentOddsSignals: (OddsSignal & { _ts: number })[] = [];
  private recentEventSignals: (EventSignal & { _ts: number })[] = [];
  private alertCooldowns: Map<string, number> = new Map();

  processOddsSignals(signals: OddsSignal[]): DivergenceAlert[] {
    const now = Date.now();
    for (const s of signals) {
      this.recentOddsSignals.push({ ...s, _ts: now });
    }
    this.prune();
    return this.detect(now);
  }

  processEventSignals(signals: EventSignal[]): DivergenceAlert[] {
    const now = Date.now();
    for (const s of signals) {
      this.recentEventSignals.push({ ...s, _ts: now });
    }
    this.prune();
    return this.detect(now);
  }

  private prune(): void {
    const cutoff = Date.now() - 120_000;
    this.recentOddsSignals = this.recentOddsSignals.filter((s) => s._ts > cutoff);
    this.recentEventSignals = this.recentEventSignals.filter((s) => s._ts > cutoff);
  }

  private detect(now: number): DivergenceAlert[] {
    const alerts: DivergenceAlert[] = [];

    // PATTERN 1: SILENT ODDS SHIFT
    const sharpMoves = this.recentOddsSignals.filter(
      (s) => s.type === "sharp_movement" && s._ts > now - 60_000
    );
    const recentBigEvents = this.recentEventSignals.filter(
      (s) => ["goal", "red_card", "penalty", "var_review"].includes(s.type) && s._ts > now - 60_000
    );

    for (const move of sharpMoves) {
      const fixtureEvents = recentBigEvents.filter((e) => e.fixtureId === move.fixtureId);
      if (fixtureEvents.length === 0) {
        alerts.push({
          type: "silent_odds_shift",
          severity: (move.bookmakerCount || 0) >= 3 ? "critical" : "high",
          fixtureId: move.fixtureId,
          title: "Silent Odds Shift",
          description: `${move.market} odds shifted ${((move.velocity || 0) * 100).toFixed(1)}% across ${move.bookmakerCount || "?"} bookmakers in 60s with no visible match event. Possible: injury, tactical change, or information the broadcast hasn't caught up to.`,
          data: move as unknown as Record<string, unknown>,
          ts: now,
        });
      }
    }

    // PATTERN 2: DELAYED MARKET REACTION
    const bigEvents = this.recentEventSignals.filter(
      (s) => ["goal", "red_card", "penalty"].includes(s.type) && s._ts > now - 30_000
    );

    for (const event of bigEvents) {
      const oddsAfter = this.recentOddsSignals.filter(
        (s) => s.fixtureId === event.fixtureId && s._ts > event._ts && s._ts < event._ts + 30_000
      );
      const sharpAfter = oddsAfter.filter((s) => s.type === "sharp_movement");

      if (sharpAfter.length === 0 && now - event._ts > 10_000) {
        alerts.push({
          type: "delayed_market_reaction",
          severity: "high",
          fixtureId: event.fixtureId,
          title: "Market Hasn't Reacted",
          description: `${event.type.replace("_", " ")} at minute ${event.minute} but odds haven't moved in ${Math.round((now - event._ts) / 1000)}s. Market may be slow to price this in.`,
          data: event as unknown as Record<string, unknown>,
          ts: now,
        });
      }
    }

    // PATTERN 3: MOMENTUM MISPRICING
    const pressureSignals = this.recentEventSignals.filter((s) => s.type === "sustained_pressure");
    for (const pressure of pressureSignals) {
      const recentSharpMoves = this.recentOddsSignals.filter(
        (s) => s.fixtureId === pressure.fixtureId && s.type === "sharp_movement" && s._ts > now - 120_000
      );
      if (recentSharpMoves.length === 0) {
        alerts.push({
          type: "momentum_mispricing",
          severity: "medium",
          fixtureId: pressure.fixtureId,
          title: "Momentum Not Priced In",
          description: `Team ${pressure.team} has had ${pressure.dangerCount} consecutive danger possessions but odds haven't shortened. Momentum suggests goal probability is higher than the market implies.`,
          data: pressure as unknown as Record<string, unknown>,
          ts: now,
        });
      }
    }

    // PATTERN 4: BOOKMAKER DISAGREEMENT
    const disagreements = this.recentOddsSignals.filter((s) => s.type === "bookmaker_disagreement");
    for (const d of disagreements) {
      alerts.push({
        type: "value_spot",
        severity: "medium",
        fixtureId: d.fixtureId,
        title: "Bookmaker Disagreement",
        description: `${d.market} has ${((d.spread || 0) * 100).toFixed(0)}% spread across bookmakers. Some books are pricing this very differently — one side may have better information.`,
        data: d as unknown as Record<string, unknown>,
        ts: now,
      });
    }

    // PATTERN 5: GOAL IMMINENT
    const goalImminent = this.recentEventSignals.filter((s) => s.type === "goal_imminent");
    for (const g of goalImminent) {
      alerts.push({
        type: "value_spot",
        severity: "medium",
        fixtureId: g.fixtureId,
        title: "Goal Probability Spiking",
        description: `TxODDS data signals a goal is imminent for Team ${g.team}. If the Over/BTTS market hasn't tightened, there may be value.`,
        data: g as unknown as Record<string, unknown>,
        ts: now,
      });
    }

    // PATTERN 6: ODDS COLLAPSE
    const collapses = this.recentOddsSignals.filter((s) => s.type === "odds_collapse");
    for (const c of collapses) {
      alerts.push({
        type: "silent_odds_shift",
        severity: "critical",
        fixtureId: c.fixtureId,
        title: "Odds Collapsed",
        description: `${c.market} odds crashed from ${c.from?.toFixed(2)} to ${c.to?.toFixed(2)}. A massive shift like this usually means the outcome is near-certain — check for unreported events.`,
        data: c as unknown as Record<string, unknown>,
        ts: now,
      });
    }

    const cooldownMs: Record<Severity, number> = {
      critical: 60_000,
      high: 120_000,
      medium: 180_000,
      low: 180_000,
    };

    const filtered = alerts.filter((a) => {
      const key = `${a.fixtureId}:${a.type}`;
      const lastSent = this.alertCooldowns.get(key) || 0;
      if (now - lastSent < cooldownMs[a.severity]) return false;
      this.alertCooldowns.set(key, now);
      return true;
    });

    if (filtered.length > 0) {
      logger.info("divergence", `Detected ${filtered.length} alerts`);
    }

    return filtered;
  }
}
