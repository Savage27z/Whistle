import type { OddsUpdate } from "../txodds/types";
import { logger } from "../utils/logger";

export interface OddsSnapshot {
  value: number;
  ts: number;
  bookmakerId: number;
}

export interface OddsSignal {
  type: "sharp_movement" | "bookmaker_disagreement" | "odds_collapse";
  fixtureId: number;
  market: string;
  ts: number;
  velocity?: number;
  currentValue?: number;
  bookmakerCount?: number;
  spread?: number;
  from?: number;
  to?: number;
}

interface OddsState {
  history: Map<string, OddsSnapshot[]>;
}

const MAX_HISTORY = 500;

export class OddsTracker {
  private state: Map<number, OddsState> = new Map();

  processOddsUpdate(update: OddsUpdate): OddsSignal[] {
    const signals: OddsSignal[] = [];
    const fixtureState = this.getOrCreate(update.fixtureId);

    for (let i = 0; i < update.priceNames.length; i++) {
      const priceName = update.priceNames[i];
      const priceRaw = update.prices[i];
      if (priceName === undefined || priceRaw === undefined) continue;

      const price = priceRaw / 1000;
      const key = `${update.bookmakerId}:${update.oddsType}:${priceName}`;
      const marketKey = `${update.oddsType}:${priceName}`;

      const history = fixtureState.history.get(key) || [];
      const prevValue = history.length > 0 ? history[history.length - 1].value : null;

      history.push({ value: price, ts: update.ts, bookmakerId: update.bookmakerId });
      if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
      fixtureState.history.set(key, history);

      const velocity = this.calculateVelocity(history, 60_000);

      if (Math.abs(velocity) > 0.10) {
        const bookmakerCount = this.countMovingBookmakers(fixtureState, update.oddsType, priceName, 60_000);
        signals.push({
          type: "sharp_movement",
          fixtureId: update.fixtureId,
          market: marketKey,
          velocity,
          currentValue: price,
          bookmakerCount,
          ts: update.ts,
        });
      }

      const spread = this.calculateSpread(fixtureState, update.oddsType, priceName);
      if (spread > 0.15) {
        signals.push({
          type: "bookmaker_disagreement",
          fixtureId: update.fixtureId,
          market: marketKey,
          spread,
          ts: update.ts,
        });
      }

      if (prevValue !== null && price < 1.2 && prevValue > 1.5) {
        signals.push({
          type: "odds_collapse",
          fixtureId: update.fixtureId,
          market: marketKey,
          from: prevValue,
          to: price,
          ts: update.ts,
        });
      }
    }

    if (signals.length > 0) {
      logger.debug("odds-tracker", `Generated ${signals.length} signals for fixture ${update.fixtureId}`);
    }

    return signals;
  }

  getConsensusOdds(fixtureId: number, oddsType: string, outcomeName: string): number | null {
    const state = this.state.get(fixtureId);
    if (!state) return null;

    const values: number[] = [];
    for (const [key, history] of state.history) {
      if (key.includes(`:${oddsType}:${outcomeName}`) && history.length > 0) {
        values.push(history[history.length - 1].value);
      }
    }
    if (values.length === 0) return null;
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  }

  private getOrCreate(fixtureId: number): OddsState {
    let s = this.state.get(fixtureId);
    if (!s) {
      s = { history: new Map() };
      this.state.set(fixtureId, s);
    }
    return s;
  }

  private calculateVelocity(history: OddsSnapshot[], windowMs: number): number {
    if (history.length < 2) return 0;
    const now = history[history.length - 1].ts;
    const cutoff = now - windowMs;
    const older = history.filter((h) => h.ts <= cutoff);
    if (older.length === 0) {
      const first = history[0];
      const last = history[history.length - 1];
      if (first.value === 0) return 0;
      return (last.value - first.value) / first.value;
    }
    const baseline = older[older.length - 1];
    const current = history[history.length - 1];
    if (baseline.value === 0) return 0;
    return (current.value - baseline.value) / baseline.value;
  }

  private countMovingBookmakers(state: OddsState, oddsType: string, outcomeName: string, windowMs: number): number {
    let count = 0;
    for (const [key, history] of state.history) {
      if (!key.includes(`:${oddsType}:${outcomeName}`)) continue;
      const v = this.calculateVelocity(history, windowMs);
      if (Math.abs(v) > 0.05) count++;
    }
    return count;
  }

  private calculateSpread(state: OddsState, oddsType: string, outcomeName: string): number {
    const latestValues: number[] = [];
    for (const [key, history] of state.history) {
      if (!key.includes(`:${oddsType}:${outcomeName}`) || history.length === 0) continue;
      latestValues.push(history[history.length - 1].value);
    }
    if (latestValues.length < 2) return 0;
    const min = Math.min(...latestValues);
    const max = Math.max(...latestValues);
    if (min === 0) return 0;
    return (max - min) / min;
  }
}
