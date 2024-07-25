import type {
  Balance,
  Market,
  Order,
  Position,
  StoreData,
  Ticker,
  Writable,
} from "../types";
import { clone } from "../utils/clone";

import type { Store } from "./store.interface";

export const defaultStore: StoreData = {
  latency: 0,
  balance: { used: 0, free: 0, total: 0, upnl: 0, assets: [] },
  markets: [],
  tickers: [],
  positions: [],
  orders: [],
  loaded: {
    balance: false,
    orders: false,
    markets: false,
    tickers: false,
    positions: false,
  },
  options: {
    isHedged: false,
  },
};

export class DefaultStore implements Store {
  private listeners = new Set<(data: StoreData) => void>();
  private orderListeners = new Set<(data: Order[]) => void>();

  private state: Writable<StoreData> = clone(defaultStore);

  get latency() {
    return this.state.latency;
  }

  get balance() {
    return this.state.balance;
  }

  get markets() {
    return this.state.markets;
  }

  get tickers() {
    return this.state.tickers;
  }

  get orders() {
    return this.state.orders;
  }

  get positions() {
    return this.state.positions;
  }

  get loaded() {
    return this.state.loaded;
  }

  get options() {
    return this.state.options;
  }

  update = (changes: Partial<StoreData>) => {
    Object.assign(this.state, changes);
    this.notify();
  };
  updateBalance = (balance: StoreData["balance"]) => {
    // Recalculate usdValue for each asset
    const newAssets = balance.assets.map((asset) => {
      let usdValue = asset.walletBalance;

      if (!["USDC", "USDT", "FDUSD", "BNFCR"].includes(asset.symbol)) {
        const symbol = asset.symbol + "USDT";
        const ticker = this.state.tickers.find((t) => t.symbol === symbol);
        if (!ticker) {
          throw new Error(`Ticker ${symbol} not found`);
        }
        usdValue = ticker.last * asset.walletBalance;
      }

      return {
        ...asset,
        usdValue: usdValue,
      };
    });

    // Recalculate total
    const total = newAssets.reduce((sum, asset) => sum + asset.usdValue, 0);

    const newBalance: Balance = {
      ...balance,
      assets: newAssets,
      total: total,
    };

    this.state.balance = newBalance;
    this.notify();
  };

  reset = () => {
    this.state = clone(defaultStore);
    this.notify();
  };

  subscribe = (cb: (data: StoreData) => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  subscribeOrders = (cb: (orders: Order[]) => void) => {
    this.orderListeners.add(cb);
    return () => this.orderListeners.delete(cb);
  };
  removeOrders = (orders: Array<Pick<Order, "id">>) => {
    orders.forEach((order) => {
      const idx = this.state.orders.findIndex((o) => o.id === order.id);
      if (idx > -1) this.state.orders.splice(idx, 1);
    });

    this.notify();
    this.notifyOrders();
  };

  removeOrder = (order: Pick<Order, "id">) => {
    const idx = this.state.orders.findIndex((o) => o.id === order.id);

    if (idx > -1) {
      this.state.orders.splice(idx, 1);
      this.notify();
      this.notifyOrders();
    }
  };

  updateOrder = (order: Pick<Order, "id">, changes: Partial<Order>) => {
    const idx = this.state.orders.findIndex((o) => o.id === order.id);

    if (idx > -1) {
      this.updateInArray("orders", idx, changes);
      this.notify();
      this.notifyOrders();
    }
  };

  addOrder = (order: Order) => {
    this.state.orders.push(order);
    this.notify();
    this.notifyOrders();
  };

  addOrUpdateOrder = (order: Order) => {
    const idx = this.state.orders.findIndex((o) => o.id === order.id);
    if (idx > -1) {
      this.updateInArray("orders", idx, order);
    } else {
      this.state.orders.push(order);
    }
    this.notify();
    this.notifyOrders();
  };

  addOrUpdateOrders = (orders: Order[]) => {
    orders.forEach((order) => {
      const idx = this.state.orders.findIndex((o) => o.id === order.id);
      if (idx > -1) {
        this.updateInArray("orders", idx, order);
      } else {
        this.state.orders.push(order);
      }
    });
    this.notify();
    this.notifyOrders();
  };

  removePosition = (position: Pick<Position, "side" | "symbol">) => {
    const idx = this.state.positions.findIndex(
      (p) => p.side === position.side && p.symbol === position.symbol
    );

    if (idx > -1) {
      this.state.orders.splice(idx, 1);
      this.notify();
    }
  };

  updatePosition = (
    position: Pick<Position, "side" | "symbol">,
    changes: Partial<Position>
  ) => {
    const idx = this.state.positions.findIndex(
      (p) => p.side === position.side && p.symbol === position.symbol
    );

    if (idx > -1) {
      this.updateInArray("positions", idx, changes);
      this.notify();
    }
  };

  updatePositions = (
    updates: Array<[Pick<Position, "side" | "symbol">, Partial<Position>]>
  ) => {
    const idexesChanges = updates.map(([position, changes]) => {
      const idx = this.state.positions.findIndex(
        (p) => p.side === position.side && p.symbol === position.symbol
      );
      return [idx, changes] as const;
    });

    if (idexesChanges.some(([idx]) => idx !== -1)) {
      idexesChanges.forEach(([idx, changes]) =>
        this.updateInArray("positions", idx, changes)
      );
      this.notify();
    }
  };

  updateTicker = (ticker: Pick<Ticker, "id">, changes: Partial<Ticker>) => {
    const idx = this.state.tickers.findIndex((t) => t.id === ticker.id);

    if (idx > -1) {
      this.updateInArray("tickers", idx, changes);
      this.notify();
    }
  };

  addOrUpdateTickers = (tickers: Ticker[]) => {
    tickers.forEach((ticker) => {
      const idx = this.state.tickers.findIndex((o) => o.id === ticker.id);
      if (idx > -1) {
        this.updateInArray("tickers", idx, ticker);
      } else {
        this.state.tickers.push(ticker);
      }
    });
    this.notify();
  };

  updateMarket = (market: Pick<Market, "id">, changes: Partial<Market>) => {
    const idx = this.state.markets.findIndex((m) => m.id === market.id);

    if (idx > -1) {
      this.updateInArray("markets", idx, changes);
      this.notify();
    }
  };

  setSetting = (key: keyof StoreData["options"], value: boolean) => {
    if (this.state.options[key] !== value) {
      this.state.options[key] = value;
      this.notify();
    }
  };

  private updateInArray = <
    K extends "markets" | "orders" | "positions" | "tickers",
  >(
    key: K,
    idx: number,
    changes: Partial<StoreData[K][number]>
  ) => {
    if (idx > -1 && key in this.state) {
      this.state[key][idx] = { ...this.state[key][idx], ...changes };
    }
  };

  private notify = () => {
    if (this.listeners.size > 0) {
      this.listeners.forEach((cb) => cb(this.state));
    }
  };
  private notifyOrders = () => {
    if (this.orderListeners.size > 0) {
      this.orderListeners.forEach((cb) => cb(this.state.orders));
    }
  };
}
