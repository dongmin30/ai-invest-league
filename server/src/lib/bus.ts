import { EventEmitter } from 'node:events';
import type { DecisionLog, FxQuote, Order, Quote, RankingRow } from '../../../shared/api-types';

export interface BusEvents {
  quotes: Quote[];
  fx: FxQuote;
  order: { league_id: number; participant_id: number; order: Order };
  rankings: { league_id: number; rankings: RankingRow[] };
  decision: {
    league_id: number;
    agent_id: number;
    agent_name: string;
    status: DecisionLog['status'];
    summary: string;
  };
}

export type BusEventName = keyof BusEvents;
export type BusListener<K extends BusEventName> = (payload: BusEvents[K]) => void;

class TypedBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // One listener per open SSE connection.
    this.emitter.setMaxListeners(0);
  }

  on<K extends BusEventName>(event: K, listener: BusListener<K>): this {
    this.emitter.on(event, listener);
    return this;
  }

  off<K extends BusEventName>(event: K, listener: BusListener<K>): this {
    this.emitter.off(event, listener);
    return this;
  }

  /** Listener errors are logged, never propagated to the emitter (jobs must not crash). */
  emit<K extends BusEventName>(event: K, payload: BusEvents[K]): void {
    for (const listener of this.emitter.listeners(event) as BusListener<K>[]) {
      try {
        listener(payload);
      } catch (err) {
        console.error(`[bus] listener for '${event}' failed:`, err);
      }
    }
  }
}

export const bus = new TypedBus();
