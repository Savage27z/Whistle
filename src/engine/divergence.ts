import type { OddsSignal } from "./odds-tracker";
import type { EventSignal, MatchState } from "./event-tracker";
import { logger } from "../utils/logger";

export type AlertType = "silent_odds_shift" | "delayed_market_reaction" | "momentum_mispricing" | "value_spot";
export type Severity = "low" | "medium" | "high" | "critical";

export interface DivergenceAlert {
  type: AlertType;
  severity: Severity;
  fixtureId: number;
  title: string;
  description: string;
  confidence: number;
  data: Record<string, unknown>;
  ts: number;
}

export interface EdgeResult {
  alertId: string;
  fixtureId: number;
  type: AlertType;
  confirmed: boolean;
  checkedAt: number;
}

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function severityRank(s: Severity): number {
  return SEVERITY_RANK[s] ?? 0;
}

export class DivergenceDetector {
  private recentOddsSignals: (OddsSignal & { _ts: number })[] = [];
  private recentEventSignals: (EventSignal & { _ts: number })[] = [];
  private alertCooldowns: Map<string, number> = new Map();
  private pendingEdges: { id: string; fixtureId: number; type: AlertType; market?: string; firedAt: number; baselineOdds?: number }[] = [];
  private edgeResults: EdgeResult[] = [];
  private totalAlerts = 0;
  private confirmedEdges = 0;
  private matchStateResolver?: (fixtureId: number) => MatchState | undefined;

  setMatchStateResolver(resolver: (fixtureId: number) => MatchState | undefined): void {
    this.matchStateResolver = resolver;
  }

  private resolveTeamName(fixtureId: number, teamNum?: number): string {
    if (!teamNum) return "Unknown";
    const state = this.matchStateResolver?.(fixtureId);
    if (!state) return `Team ${teamNum}`;
    return teamNum === 1 ? state.team1 : teamNum === 2 ? state.team2 : `Team ${teamNum}`;
  }

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

  verifyEdges(oddsSignals: OddsSignal[]): void {
    const now = Date.now();
    const toRemove: number[] = [];

    for (let i = 0; i < this.pendingEdges.length; i++) {
      const edge = this.pendingEdges[i];
      const elapsed = now - edge.firedAt;

      if (elapsed > 120_000) {
        this.edgeResults.push({ alertId: edge.id, fixtureId: edge.fixtureId, type: edge.type, confirmed: false, checkedAt: now });
        toRemove.push(i);
        continue;
      }

      if (elapsed < 15_000) continue;

      let confirmed = false;
      if (edge.type === "delayed_market_reaction") {
        const marketMoved = oddsSignals.some((s) => s.fixtureId === edge.fixtureId && s.type === "sharp_movement");
        if (marketMoved) confirmed = true;
      } else if (edge.type === "silent_odds_shift" || edge.type === "value_spot") {
        const continued = oddsSignals.some(
          (s) => s.fixtureId === edge.fixtureId && (s.type === "sharp_movement" || s.type === "bookmaker_disagreement")
        );
        if (continued) confirmed = true;
      } else if (edge.type === "momentum_mispricing") {
        const goalHappened = this.recentEventSignals.some(
          (s) => s.fixtureId === edge.fixtureId && s.type === "goal" && s._ts > edge.firedAt
        );
        if (goalHappened) confirmed = true;
      }

      if (confirmed) {
        this.confirmedEdges++;
        this.edgeResults.push({ alertId: edge.id, fixtureId: edge.fixtureId, type: edge.type, confirmed: true, checkedAt: now });
        toRemove.push(i);
      }
    }

    for (let i = toRemove.length - 1; i >= 0; i--) {
      this.pendingEdges.splice(toRemove[i], 1);
    }

    if (this.edgeResults.length > 200) this.edgeResults = this.edgeResults.slice(-200);
  }

  getEdgeStats(): { total: number; confirmed: number; accuracy: number; recent: EdgeResult[] } {
    return {
      total: this.totalAlerts,
      confirmed: this.confirmedEdges,
      accuracy: this.totalAlerts > 0 ? Math.round((this.confirmedEdges / this.totalAlerts) * 100) : 0,
      recent: this.edgeResults.slice(-10),
    };
  }

  private prune(): void {
    const cutoff = Date.now() - 120_000;
    this.recentOddsSignals = this.recentOddsSignals.filter((s) => s._ts > cutoff);
    this.recentEventSignals = this.recentEventSignals.filter((s) => s._ts > cutoff);

    if (this.alertCooldowns.size > 500) {
      for (const [key, ts] of this.alertCooldowns) {
        if (ts < cutoff) this.alertCooldowns.delete(key);
      }
    }
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
        const bkCount = move.bookmakerCount || 1;
        const velMag = Math.abs(move.velocity || 0);
        const confidence = Math.min(95, Math.round(40 + bkCount * 15 + velMag * 100));
        alerts.push({
          type: "silent_odds_shift",
          severity: bkCount >= 3 ? "critical" : "high",
          fixtureId: move.fixtureId,
          title: "Silent Odds Shift",
          confidence,
          description: `${move.market} odds shifted ${(velMag * 100).toFixed(1)}% across ${bkCount} bookmakers in 60s with no visible match event. Possible: injury, tactical change, or information the broadcast hasn't caught up to.`,
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
        const delaySec = Math.round((now - event._ts) / 1000);
        const confidence = Math.min(92, Math.round(50 + delaySec * 2));
        alerts.push({
          type: "delayed_market_reaction",
          severity: "high",
          fixtureId: event.fixtureId,
          title: "Market Hasn't Reacted",
          confidence,
          description: `${event.type.replace("_", " ")} at minute ${event.minute} but odds haven't moved in ${delaySec}s. Market may be slow to price this in.`,
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
        const dangerCount = pressure.dangerCount || 3;
        const confidence = Math.min(80, Math.round(35 + dangerCount * 10));
        alerts.push({
          type: "momentum_mispricing",
          severity: "medium",
          fixtureId: pressure.fixtureId,
          title: "Momentum Not Priced In",
          confidence,
          description: `${this.resolveTeamName(pressure.fixtureId, pressure.team)} has had ${dangerCount} consecutive danger possessions but odds haven't shortened. Momentum suggests goal probability is higher than the market implies.`,
          data: pressure as unknown as Record<string, unknown>,
          ts: now,
        });
      }
    }

    // PATTERN 4: BOOKMAKER DISAGREEMENT
    const disagreements = this.recentOddsSignals.filter((s) => s.type === "bookmaker_disagreement");
    for (const d of disagreements) {
      const spreadPct = ((d.spread || 0) * 100);
      const confidence = Math.min(75, Math.round(30 + spreadPct * 2));
      alerts.push({
        type: "value_spot",
        severity: "low",
        fixtureId: d.fixtureId,
        title: "Bookmaker Disagreement",
        confidence,
        description: `${d.market} has ${spreadPct.toFixed(0)}% spread across bookmakers. Some books are pricing this very differently — one side may have better information.`,
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
        confidence: 60,
        description: `TxODDS data signals a goal is imminent for ${this.resolveTeamName(g.fixtureId, g.team)}. If the Over/BTTS market hasn't tightened, there may be value.`,
        data: g as unknown as Record<string, unknown>,
        ts: now,
      });
    }

    // PATTERN 6: ODDS COLLAPSE
    const collapses = this.recentOddsSignals.filter((s) => s.type === "odds_collapse");
    for (const c of collapses) {
      const dropPct = c.from && c.to ? Math.round(((c.from - c.to) / c.from) * 100) : 30;
      alerts.push({
        type: "silent_odds_shift",
        severity: "critical",
        fixtureId: c.fixtureId,
        title: "Odds Collapsed",
        confidence: Math.min(95, 60 + dropPct),
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
      const market = (a.data as any)?.market || "";
      const key = `${a.fixtureId}:${a.type}:${market}`;
      const lastSent = this.alertCooldowns.get(key) || 0;
      if (now - lastSent < cooldownMs[a.severity]) return false;
      this.alertCooldowns.set(key, now);
      return true;
    });

    for (const alert of filtered) {
      this.totalAlerts++;
      const edgeId = `${alert.fixtureId}:${alert.type}:${now}`;
      this.pendingEdges.push({
        id: edgeId,
        fixtureId: alert.fixtureId,
        type: alert.type,
        market: (alert.data as any)?.market,
        firedAt: now,
      });
    }

    if (this.pendingEdges.length > 100) this.pendingEdges = this.pendingEdges.slice(-100);

    if (filtered.length > 0) {
      logger.info("divergence", `Detected ${filtered.length} alerts`);
    }

    return filtered;
  }
}
