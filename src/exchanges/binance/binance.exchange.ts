import type { AxiosInstance } from "axios";
import rateLimit from "axios-rate-limit";
import type { ManipulateType } from "dayjs";
import dayjs from "dayjs";
import chunk from "lodash/chunk";
import groupBy from "lodash/groupBy";
import omit from "lodash/omit";
import times from "lodash/times";
import OrderQueueManager from "./orderQueueManager";

import type { Store } from "../../store/store.interface";
import type {
  Candle,
  ExchangeOptions,
  Market,
  MutableBalance,
  OHLCVOptions,
  Order,
  OrderBook,
  OrderResult,
  PayloadOrder,
  PlaceOrderOpts,
  Position,
  SplidOrderOpts,
  SplitOrderError,
  SplitOrderResult,
  Ticker,
  UpdateOrderOpts,
} from "../../types";
import {
  OrderTimeInForce,
  PositionSide,
  OrderSide,
  OrderStatus,
  OrderType,
} from "../../types";
import { v } from "../../utils/get-key";
import { inverseObj } from "../../utils/inverse-obj";
import { loop } from "../../utils/loop";
import { omitUndefined } from "../../utils/omit-undefined";
import { adjust, subtract } from "../../utils/safe-math";
import { generateOrderId, uuid } from "../../utils/uuid";
import { BaseExchange } from "../base";

import { createAPI } from "./binance.api";
import {
  ORDER_TYPE,
  ORDER_SIDE,
  POSITION_SIDE,
  ENDPOINTS,
  TIME_IN_FORCE,
} from "./binance.types";
import { BinancePrivateWebsocket } from "./binance.ws-private";
import { BinancePublicWebsocket } from "./binance.ws-public";
import {
  calculateWeights,
  calcValidOrdersCount,
} from "../../utils/scaleWeights";

export class BinanceExchange extends BaseExchange {
  name = "BINANCE";

  xhr: AxiosInstance;
  unlimitedXHR: AxiosInstance;

  publicWebsocket: BinancePublicWebsocket;
  privateWebsocket: BinancePrivateWebsocket;
  private orderQueueManager: OrderQueueManager;

  constructor(opts: ExchangeOptions, store: Store) {
    super(opts, store);

    this.xhr = rateLimit(createAPI(opts), { maxRPS: 3 });
    this.unlimitedXHR = createAPI(opts);
    this.xhr.interceptors.response.use(
      (response) => {
        // Log all headers
        this.emitter.emit("test", response);

        this.emitter.emit("test", response.headers["x-mbx-used-weight-1m"]);

        return response;
      },
      (error) => {
        return Promise.reject(error);
      }
    );
    this.unlimitedXHR.interceptors.response.use(
      (response) => {
        // Log all headers
        this.emitter.emit("test", response.headers);

        this.emitter.emit("test", response.headers["x-mbx-used-weight-1m"]);

        return response;
      },
      (error) => {
        return Promise.reject(error);
      }
    );

    this.orderQueueManager = new OrderQueueManager(
      this.emitter,
      this.placeOrderFast.bind(this) // Pass the placeOrderBatch function
    );

    this.publicWebsocket = new BinancePublicWebsocket(this);
    this.privateWebsocket = new BinancePrivateWebsocket(this);
  }

  dispose = () => {
    super.dispose();
    this.publicWebsocket.dispose();
    this.privateWebsocket.dispose();
  };

  getAccount = async () => {
    const {
      data: [{ accountAlias }],
    } = await this.xhr.get(ENDPOINTS.BALANCE);

    return { userId: accountAlias };
  };

  validateAccount = async () => {
    try {
      await this.xhr.get(ENDPOINTS.ACCOUNT);
      return "";
    } catch (err: any) {
      this.emitter.emit("error", err?.response?.data?.msg || err?.message);
      return err?.message?.toLowerCase()?.includes?.("network error")
        ? "Error while contacting Binance API"
        : err?.response?.data?.msg || "Invalid API key or secret";
    }
  };

  start = async () => {
    // load initial market data
    // then we can poll for live data
    const markets = await this.fetchMarkets();
    if (this.isDisposed) return;

    this.store.update({
      markets,
      loaded: { ...this.store.loaded, markets: true },
    });

    // load initial tickers data
    // then we use websocket for live data
    const tickers = await this.fetchTickers();
    if (this.isDisposed) return;

    this.log(
      `Loaded ${Math.min(tickers.length, markets.length)} Binance markets`
    );

    this.store.update({
      tickers,
      loaded: { ...this.store.loaded, tickers: true },
    });

    // start websocket streams
    this.publicWebsocket.connectAndSubscribe();
    this.privateWebsocket.connectAndSubscribe();

    // fetch current position mode (Hedge/One-way)
    this.store.setSetting("isHedged", await this.fetchPositionMode());

    // start ticking live data
    // balance, tickers, positions
    await this.tick();
    if (this.isDisposed) return;

    this.log(`Ready to trade on Binance`);

    // fetch unfilled orders
    const orders = await this.fetchOrders();
    if (this.isDisposed) return;

    this.log(`Loaded Binance orders`);

    this.store.update({
      orders,
      loaded: { ...this.store.loaded, orders: true },
    });
  };
  refreshOrdersAndPositions = async () => {
    if (this.isDisposed) return;

    try {
      // Fetch orders
      const orders = await this.fetchOrders();
      if (this.isDisposed) return;

      // Fetch balance and positions
      const { balance, positions } = await this.fetchBalanceAndPositions();
      if (this.isDisposed) return;

      // Update the store with the fetched data
      this.store.update({
        orders,
        balance,
        positions,
      });

      this.log(`Refreshed orders, balance, and positions`);
    } catch (err: any) {
      this.emitter.emit("error", err?.message);
    }
  };
  tick = async () => {
    if (!this.isDisposed) {
      try {
        const { balance, positions } = await this.fetchBalanceAndPositions();
        if (this.isDisposed) return;

        this.store.update({
          balance,
          positions,
          loaded: {
            ...this.store.loaded,
            balance: true,
            positions: true,
          },
        });
      } catch (err: any) {
        this.emitter.emit("error", err?.message);
      }

      loop(() => this.tick(), this.options.extra?.tickInterval);
    }
  };

  fetchMarkets = async () => {
    try {
      // First API call
      const response1 = await this.xhr.get<{
        symbols: Array<Record<string, any>>;
      }>(ENDPOINTS.MARKETS);

      const {
        data: { symbols },
      } = response1;

      // Check and update store with response headers
      this.emitter.emit("test", response1.headers);
      // Second API call
      const response2 = await this.xhr.get<Array<Record<string, any>>>(
        ENDPOINTS.LEVERAGE_BRACKET
      );
      const { data } = response2;

      // Check and update store with response headers
      const usedWeight2 =
        response2.headers["x-mbx-used-weight-1m"] ||
        response2.headers["X-MBX-USED-WEIGHT-1M"] ||
        response2.headers["X-Mbx-Used-Weight-1m"];
      if (usedWeight2) {
        this.store.update({ usedWeight: parseInt(usedWeight2, 10) });
      }

      // Process symbols and markets
      const unwantedSymbols = [
        "BTSUSDT",
        "TOMOUSDT",
        "SCUSDT",
        "HNTUSDT",
        "SRMUSDT",
        "FTTUSDT",
        "RAYUSDT",
        "CVCUSDT",
        "COCOSUSDT",
        "STRAXUSDT",
        "DGBUSDT",
        "CTKUSDT",
        "ANTUSDT",
        "SNTUSDT",
        "WAVESUSDT",
        "GLMRUSDT",
        "AGIXUSDT",
        "IDEXUSDT",
        "MDTUSDT",
        "CVXUSDT",
        "STPTUSDT",
        "SLPUSDT",
        "RADUSDT",
        "OCEANUSDT",
      ];

      const filteredSymbols = symbols.filter(
        (symbol) => !unwantedSymbols.includes(symbol.symbol)
      );
      const markets: Market[] = filteredSymbols
        .filter(
          (m) =>
            (v(m, "contractType") === "PERPETUAL" &&
              v(m, "marginAsset") === "USDT") ||
            "USDC"
        )
        .map((m) => {
          const p = m.filters.find(
            (f: any) => v(f, "filterType") === "PRICE_FILTER"
          );

          const amt = m.filters.find(
            (f: any) => v(f, "filterType") === "LOT_SIZE"
          );
          const notional = m.filters.find(
            (f: any) => v(f, "filterType") === "MIN_NOTIONAL"
          );
          const mAmt = m.filters.find(
            (f: any) => v(f, "filterType") === "MARKET_LOT_SIZE"
          );

          const { brackets } = data.find((b) => b.symbol === m.symbol)!;
          const baseAsset = v(m, "baseAsset");
          const quoteAsset = v(m, "quoteAsset");
          const marginAsset = v(m, "marginAsset");

          return {
            id: `${baseAsset}/${quoteAsset}:${marginAsset}`,
            symbol: m.symbol,
            base: baseAsset,
            quote: quoteAsset,
            active: m.status === "TRADING",
            precision: {
              amount: parseFloat(v(amt, "stepSize")),
              price: parseFloat(v(p, "tickSize")),
            },
            limits: {
              amount: {
                min: Math.max(
                  parseFloat(v(amt, "minQty")),
                  parseFloat(v(mAmt, "minQty"))
                ),
                max: Math.min(
                  parseFloat(v(amt, "maxQty")),
                  parseFloat(v(mAmt, "maxQty"))
                ),
              },
              minNotional: parseFloat(v(notional, "notional")),

              leverage: {
                min: 1,
                max: v(brackets[0], "initialLeverage"),
              },
            },
          };
        });

      return markets;
    } catch (err: any) {
      this.emitter.emit("error", err?.response?.data?.msg || err?.message);
      return this.store.markets;
    }
  };

  fetchTickers = async () => {
    try {
      // First API call
      const response1 = await this.xhr.get<Array<Record<string, any>>>(
        ENDPOINTS.TICKERS_24H
      );
      const { data: dailys } = response1;

      // Check and update store with response headers
      const usedWeight1 =
        response1.headers["x-mbx-used-weight-1m"] ||
        response1.headers["X-MBX-USED-WEIGHT-1M"] ||
        response1.headers["X-Mbx-Used-Weight-1m"];
      if (usedWeight1) {
        this.store.update({ usedWeight: parseInt(usedWeight1, 10) });
      }

      // Second API call
      const response2 = await this.xhr.get<Array<Record<string, any>>>(
        ENDPOINTS.TICKERS_BOOK
      );
      const { data: books } = response2;

      // Check and update store with response headers
      const usedWeight2 =
        response2.headers["x-mbx-used-weight-1m"] ||
        response2.headers["X-MBX-USED-WEIGHT-1M"] ||
        response2.headers["X-Mbx-Used-Weight-1m"];
      if (usedWeight2) {
        this.store.update({ usedWeight: parseInt(usedWeight2, 10) });
      }

      // Third API call
      const response3 = await this.xhr.get<Array<Record<string, any>>>(
        ENDPOINTS.TICKERS_PRICE
      );
      const { data: prices } = response3;

      // Check and update store with response headers
      const usedWeight3 =
        response3.headers["x-mbx-used-weight-1m"] ||
        response3.headers["X-MBX-USED-WEIGHT-1M"] ||
        response3.headers["X-Mbx-Used-Weight-1m"];
      if (usedWeight3) {
        this.store.update({ usedWeight: parseInt(usedWeight3, 10) });
      }

      // Process tickers
      const tickers: Ticker[] = books.reduce((acc: Ticker[], book) => {
        const market = this.store.markets.find((m) => m.symbol === book.symbol);

        const daily = dailys.find((d) => d.symbol === book.symbol)!;
        const price = prices.find((p) => p.symbol === book.symbol)!;

        if (!market || !daily || !price) return acc;

        const ticker = {
          id: market.id,
          symbol: market.symbol,
          bid: parseFloat(v(book, "bidPrice")),
          ask: parseFloat(v(book, "askPrice")),
          last: parseFloat(v(daily, "lastPrice")),
          mark: parseFloat(v(price, "markPrice")),
          index: parseFloat(v(price, "indexPrice")),
          percentage: parseFloat(v(daily, "priceChangePercent")),
          fundingRate: parseFloat(v(price, "lastFundingRate")),
          volume: parseFloat(daily.volume),
          quoteVolume: parseFloat(v(daily, "quoteVolume")),
          openInterest: 0, // Binance doesn't provide all tickers data
        };

        return [...acc, ticker];
      }, []);

      return tickers;
    } catch (err: any) {
      this.emitter.emit("error", err?.response?.data?.msg || err?.message);
      return this.store.tickers;
    }
  };

  fetchBalanceAndPositions = async () => {
    try {
      const { data } = await this.xhr.get<
        Record<string, any> & { positions: Array<Record<string, any>> }
      >(ENDPOINTS.ACCOUNT);

      const balance: MutableBalance = {
        total: 0,
        free: parseFloat(data.availableBalance),
        used: parseFloat(data.totalInitialMargin),
        upnl: parseFloat(data.totalUnrealizedProfit),
        assets: [],
      };

      for (const assetData of data.assets) {
        const walletBalance = parseFloat(assetData.walletBalance);

        // Only process assets with a non-zero wallet balance
        if (walletBalance > 0) {
          const asset = assetData.asset;
          let usdValue = walletBalance;

          // Calculate USD value for non-stablecoin assets
          if (!["USDC", "USDT", "FDUSD", "BNFCR"].includes(asset)) {
            const symbol = asset + "USDT";
            const ticker = this.store.tickers.find((t) => t.symbol === symbol);
            if (!ticker) {
              throw new Error(`Ticker ${symbol} not found`);
            }
            usdValue = ticker.last * walletBalance;
          }

          // Add the asset details to the assets array
          balance.assets.push({
            symbol: asset,
            walletBalance,
            usdValue,
          });

          // Accumulate the total USD value
          balance.total = balance.assets.reduce(
            (sum, asset) => sum + asset.usdValue,
            0
          );
        }
      }

      // We need to filter out positions that corresponds to
      // markets that are not supported by safe-cex

      const supportedPositions = data.positions.filter((p) =>
        this.store.markets.some((m) => m.symbol === p.symbol)
      );

      const positions: Position[] = supportedPositions.map((p) => {
        const entryPrice = parseFloat(v(p, "entryPrice"));
        const contracts = parseFloat(v(p, "positionAmt"));
        const upnl = parseFloat(v(p, "unrealizedProfit"));
        const pSide = v(p, "positionSide");

        // If account is not on hedge mode,
        // we need to define the side of the position with the contracts amount
        const side =
          (pSide in POSITION_SIDE && POSITION_SIDE[pSide]) ||
          (contracts > 0 ? PositionSide.Long : PositionSide.Short);

        return {
          symbol: p.symbol,
          side,
          entryPrice,
          notional: Math.abs(contracts * entryPrice + upnl),
          leverage: parseFloat(p.leverage),
          unrealizedPnl: upnl,
          contracts: Math.abs(contracts),
          liquidationPrice: parseFloat(v(p, "liquidationPrice")),
        };
      });

      return {
        positions,
        balance,
      };
    } catch (err: any) {
      this.emitter.emit("error", err?.response?.data?.msg || err?.message);

      return {
        positions: this.store.positions,
        balance: this.store.balance,
      };
    }
  };

  fetchOrders = async () => {
    try {
      const { data } = await this.xhr.get<Array<Record<string, any>>>(
        ENDPOINTS.OPEN_ORDERS
      );

      const orders: Order[] = data.map((o) => {
        const order = {
          id: v(o, "clientOrderId"),
          orderId: v(o, "orderId"),
          status: OrderStatus.Open,
          symbol: o.symbol,
          type: ORDER_TYPE[o.type],
          side: ORDER_SIDE[o.side],
          price: parseFloat(o.price) || parseFloat(v(o, "stopPrice")),
          amount: parseFloat(v(o, "origQty")),
          reduceOnly: v(o, "reduceOnly") || false,
          filled: parseFloat(v(o, "executedQty")),
          remaining: subtract(v(o, "origQty"), v(o, "executedQty")),
        };

        return order;
      });

      return orders;
    } catch (err: any) {
      this.emitter.emit("error", err?.response?.data?.msg || err?.message);
      return this.store.orders;
    }
  };

  fetchOHLCV = async (opts: OHLCVOptions) => {
    const interval = opts.interval;
    const limit = Math.min(opts.limit || 500, 1500);
    const [, amount, unit] = opts.interval.split(/(\d+)/);

    const end = opts.to ? dayjs(opts.to) : dayjs();
    const start =
      !opts.limit && opts.from
        ? dayjs(opts.from)
        : end.subtract(parseFloat(amount) * limit, unit as ManipulateType);

    const { data } = await this.xhr.get<any[][]>(ENDPOINTS.KLINE, {
      params: {
        symbol: opts.symbol,
        interval,
        startTime: start.valueOf(),
        endTime: end.valueOf(),
        limit,
      },
    });

    const candles: Candle[] = data.map(
      ([time, open, high, low, close, volume]) => {
        return {
          timestamp: time / 1000,
          open: parseFloat(open),
          high: parseFloat(high),
          low: parseFloat(low),
          close: parseFloat(close),
          volume: parseFloat(volume),
        };
      }
    );

    return candles;
  };

  listenOHLCV = (opts: OHLCVOptions, callback: (candle: Candle) => void) => {
    return this.publicWebsocket.listenOHLCV(opts, callback);
  };

  listenOrderBook = (
    symbol: string,
    callback: (orderBook: OrderBook) => void
  ) => {
    return this.publicWebsocket.listenOrderBook(symbol, callback);
  };

  fetchPositionMode = async () => {
    const { data } = await this.xhr.get(ENDPOINTS.HEDGE_MODE);
    return data.dualSidePosition === true;
  };

  changePositionMode = async (hedged: boolean) => {
    if (this.store.positions.filter((p) => p.contracts > 0).length > 0) {
      this.emitter.emit(
        "error",
        "Please close all positions before switching position mode"
      );
      return;
    }

    try {
      await this.xhr.post(ENDPOINTS.HEDGE_MODE, {
        dualSidePosition: hedged ? "true" : "false",
      });
      this.store.setSetting("isHedged", hedged);
    } catch (err: any) {
      this.emitter.emit("error", err?.response?.data?.msg || err?.message);
    }
  };

  setLeverage = async (symbol: string, inputLeverage: number) => {
    const market = this.store.markets.find((m) => m.symbol === symbol);
    const position = this.store.positions.find((p) => p.symbol === symbol);

    if (!market) throw new Error(`Market ${symbol} not found`);
    if (!position) throw new Error(`Position ${symbol} not found`);

    const leverage = Math.min(
      Math.max(inputLeverage, market.limits.leverage.min),
      market.limits.leverage.max
    );

    if (position.leverage !== leverage) {
      try {
        await this.xhr.post(ENDPOINTS.SET_LEVERAGE, {
          symbol,
          leverage,
        });

        this.store.updatePositions([
          [{ symbol, side: PositionSide.Long }, { leverage }],
          [{ symbol, side: PositionSide.Short }, { leverage }],
        ]);
      } catch (err: any) {
        this.emitter.emit("error", err?.response?.data?.msg || err?.message);
      }
    }
  };
  cancelOrders = async (orders: Order[]) => {
    try {
      const groupedBySymbol = groupBy(orders, "symbol");
      const requests = Object.entries(groupedBySymbol).flatMap(
        ([symbol, symbolOrders]) => {
          if (symbolOrders.length === 1) {
            return [
              {
                symbol,
                origClientOrderIdList: [symbolOrders[0].id],
              },
            ];
          } else {
            const lots = chunk(
              symbolOrders.map((o) => o.id),
              10
            );
            return lots.map((lot) => ({
              symbol,
              origClientOrderIdList: lot,
            }));
          }
        }
      );

      const promises = requests.map((request) =>
        this.unlimitedXHR
          .delete(
            request.origClientOrderIdList.length === 1
              ? ENDPOINTS.ORDER
              : ENDPOINTS.BATCH_ORDERS,
            {
              params: {
                symbol: request.symbol,
                origClientOrderIdList:
                  request.origClientOrderIdList.length === 1
                    ? request.origClientOrderIdList[0]
                    : request.origClientOrderIdList,
              },
            }
          )
          .then(() => {
            // Remove orders from the store as each promise resolves
            this.store.removeOrders(
              request.origClientOrderIdList.map((id) => ({ id }))
            );
          })
          .catch((err) => {
            // Handle individual errors
            this.emitter.emit(
              "error",
              err?.response?.data?.msg || err?.message
            );
          })
      );

      // Send all cancellation requests at the same time
      await Promise.allSettled(promises);
    } catch (err: any) {
      this.emitter.emit("error", err?.response?.data?.msg || err?.message);
    }
  };

  cancelSymbolOrders = async (symbol: string) => {
    try {
      await this.unlimitedXHR.delete(ENDPOINTS.CANCEL_SYMBOL_ORDERS, {
        params: { symbol },
      });

      this.store.removeOrders(
        this.store.orders.filter((o) => o.symbol === symbol)
      );
    } catch (err: any) {
      this.emitter.emit("error", err?.response?.data?.msg || err?.message);
    }
  };

  updateOrder = async ({ order, update }: UpdateOrderOpts) => {
    const newOrder = {
      symbol: order.symbol,
      type: order.type,
      side: order.side,
      price: order.price,
      amount: order.amount,
      reduceOnly: order.reduceOnly || false,
    };

    if ("price" in update) newOrder.price = update.price;
    if ("amount" in update) newOrder.amount = update.amount;

    await this.cancelOrders([order]);
    return await this.placeOrder(newOrder);
  };

  placeOrder = async (opts: PlaceOrderOpts) => {
    const payloads = this.formatCreateOrder(opts);
    return await this.placeOrderBatch(payloads);
  };

  placeOrders = async (orders: PlaceOrderOpts[]) => {
    const requests = orders.flatMap((o) => this.formatCreateOrder(o));
    return await this.placeOrderBatch(requests);
  };

  destroyQueue = () => {
    this.orderQueueManager.destroyQueue();
  };
  placeOrdersFast = async (orders: PlaceOrderOpts[]) => {
    const requests = orders.flatMap((o) => this.formatCreateOrder(o));

    // Enqueue all requests in the OrderQueueManager
    await this.orderQueueManager.enqueueOrders(requests);

    // Wait for the OrderQueueManager to finish processing
    while (this.orderQueueManager.isProcessing()) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const data = this.orderQueueManager.getResults();
    // Return the results
    return data;
  };

  placeSplitOrderFast = async (
    orders: SplidOrderOpts[]
  ): Promise<SplitOrderResult> => {
    // Separate valid orders from errors
    const results = orders.map((o) => this.formatCreateSplitOrders(o));
    const validOrders: PayloadOrder[] = [];
    const NimbusErrors: SplitOrderError[] = [];

    results.forEach((result) => {
      if (Array.isArray(result)) {
        validOrders.push(...result);
      } else if (result.error) {
        NimbusErrors.push(result.error);
      }
    });

    await this.orderQueueManager.enqueueOrders(validOrders);
    this.emitter.emit("info", "Waiting for split orders to be processed");

    while (
      this.orderQueueManager.isProcessing() ||
      this.orderQueueManager.isWaitingForResponse()
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const successfulOrders = this.orderQueueManager.getResults();
    const BinanceErrors = this.orderQueueManager.getResultsCollected();

    const orderResults: SplitOrderResult = {
      successfulOrders,
      NimbusErrors,
      BinanceErrors,
    };

    return orderResults;
  };

  private formatCreateSplitOrders = (
    opts: SplidOrderOpts
  ): PayloadOrder[] | { error: SplitOrderError } => {
    const orders: PayloadOrder[] = [];
    const market = this.store.markets.find(
      ({ symbol }: Market) => symbol === opts.symbol
    );
    const ticker = this.store.tickers.find(
      ({ symbol }: Ticker) => symbol === opts.symbol
    );
    const position = this.store.positions.find(
      ({ symbol }: Position) => symbol === opts.symbol
    );

    if (!market) {
      return {
        error: {
          symbol: opts.symbol,
          message: `Market ${opts.symbol} not found`,
          code: "MARKET_NOT_FOUND",
        },
      };
    }
    if (!ticker) {
      return {
        error: {
          symbol: opts.symbol,
          message: `Ticker ${opts.symbol} not found`,
          code: "TICKER_NOT_FOUND",
        },
      };
    }
    if (!position) {
      return {
        error: {
          symbol: opts.symbol,
          message: `Position ${opts.symbol} not found`,
          code: "POSITION_NOT_FOUND",
        },
      };
    }

    let side = undefined;
    let amount = null;
    if (opts.reduceOnly) {
      if (!position) {
        return {
          error: {
            symbol: opts.symbol,
            message: `Position ${opts.symbol} not found`,
            code: "POSITION_NOT_FOUND",
          },
        };
      }
      if (!opts.tpPercentOfPosition) {
        return {
          error: {
            symbol: opts.symbol,
            message: "tpPercentOfPosition is required for split orders",
            code: "TP_PERCENT_REQUIRED",
          },
        };
      }
      side =
        position.side === PositionSide.Long ? OrderSide.Sell : OrderSide.Buy;
      amount = (position.contracts * opts.tpPercentOfPosition) / 100;
    } else {
      if (opts.amount === undefined) {
        return {
          error: {
            symbol: opts.symbol,
            message: "Amount is required",
            code: "AMOUNT_REQUIRED",
          },
        };
      }
      side = opts.side;
      amount = opts.amount;
    }

    const minSize = market.limits.amount.min;
    const minNotional = market.limits.minNotional;
    const pPrice = market.precision.price;
    const pAmount = market.precision.amount;

    if (side === undefined) {
      return {
        error: {
          symbol: opts.symbol,
          message: "Side is required for split orders",
          code: "SIDE_REQUIRED",
        },
      };
    }
    let fromPrice = null;
    let toPrice = null;
    if (opts.fromPrice !== undefined) {
      fromPrice = opts.fromPrice;
    }
    if (opts.toPrice !== undefined) {
      toPrice = opts.toPrice;
    }

    // Check and set fromPrice independently
    if (!fromPrice) {
      if (opts.fromPriceDiff) {
        if (side === "buy") {
          fromPrice = ticker.last - (ticker.last * opts.fromPriceDiff) / 100;
        } else if (side === "sell") {
          fromPrice = ticker.last + (ticker.last * opts.fromPriceDiff) / 100;
        }
      }
    }

    // Check and set toPrice independently
    if (!toPrice) {
      if (opts.toPriceDiff) {
        if (side === "buy") {
          toPrice = ticker.last - (ticker.last * opts.toPriceDiff) / 100;
        } else if (side === "sell") {
          toPrice = ticker.last + (ticker.last * opts.toPriceDiff) / 100;
        }
      }
    }

    if (!fromPrice || !toPrice) {
      return {
        error: {
          symbol: opts.symbol,
          message: "Invalid price",
          code: "INVALID_PRICE",
        },
      };
    }
    this.emitter.emit("info", `Split order from ${fromPrice} to ${toPrice}`);

    const avgPrice = (fromPrice + toPrice) / 2;

    const finalAmount = amount !== null ? amount : opts.amount;
    if (finalAmount === undefined) {
      return {
        error: {
          symbol: opts.symbol,
          message: "Amount is required",
          code: "AMOUNT_REQUIRED",
        },
      };
    }

    if (avgPrice <= 0) {
      throw new Error("avgPrice must be greater than 0");
    }

    const quantity = opts.reduceOnly ? finalAmount : finalAmount / avgPrice;
    this.emitter.emit("info", `Split order quantity: ${quantity}`);
    const totalWeight = calculateWeights({
      fromScale: opts.fromScale,
      toScale: opts.toScale,
      orders: opts.orders,
    });
    const lowestSize = (opts.fromScale / totalWeight) * quantity;
    this.emitter.emit("info", `Split order lowest size: ${lowestSize}`);

    if (
      (!opts.reduceOnly && lowestSize < minSize) ||
      (!opts.reduceOnly && lowestSize * fromPrice < minNotional)
    ) {
      if (opts.autoReAdjust === true) {
        const validOrdersAmount = calcValidOrdersCount({
          fromScale: opts.fromScale,
          toScale: opts.toScale,
          orders: opts.orders,
          amount: quantity,
          minSize: minSize,
          minNotional: minNotional,
          totalWeight: totalWeight,
          fromPrice: fromPrice,
        });
        if (validOrdersAmount < 3) {
          return {
            error: {
              symbol: opts.symbol,
              message: "Scale too extreme to split orders",
              code: "SCALE_EXTREME",
            },
          };
        }
        const reAdjustedWeight = calculateWeights({
          fromScale: opts.fromScale,
          toScale: opts.toScale,
          orders: validOrdersAmount,
        });
        const newLowestSize = (opts.fromScale / reAdjustedWeight) * quantity;
        if (
          newLowestSize < minSize ||
          newLowestSize * fromPrice < minNotional
        ) {
          return {
            error: {
              symbol: opts.symbol,
              message: "Scale too extreme to split orders",
              code: "SCALE_EXTREME",
            },
          };
        }
      } else {
        return {
          error: {
            symbol: opts.symbol,
            message: "Scale too extreme",
            code: "SCALE_EXTREME",
          },
        };
      }
    }

    const priceDifference = toPrice - fromPrice;
    const priceStep = priceDifference / (opts.orders - 1);
    for (let i = 0; i < opts.orders; i++) {
      const weightOfOrder =
        opts.fromScale +
        (opts.toScale - opts.fromScale) * (i / (opts.orders - 1));
      let sizeOfOrder = quantity * (weightOfOrder / totalWeight);
      const price: number = fromPrice + priceStep * i;
      if (sizeOfOrder * price < minNotional * 1.05) {
        sizeOfOrder = (minNotional * 1.1) / price;
      }
      const reduceOnly = !this.store.options.isHedged && opts.reduceOnly;

      const req: PayloadOrder = omitUndefined({
        symbol: opts.symbol,
        side: inverseObj(ORDER_SIDE)[side],
        type: inverseObj(ORDER_TYPE)[opts.type],
        quantity: adjust(sizeOfOrder, pAmount).toString(), // Convert quantity to string
        timeInForce: "GTC",
        price: adjust(price, pPrice).toString(), // Convert price to string
        reduceOnly: reduceOnly ? "true" : undefined,
        newClientOrderId: generateOrderId(),
      });

      orders.push(req);
    }
    // emit all orders for debug
    this.emitter.emit("info", `Split orders: ${JSON.stringify(orders)}`);

    return orders;
  };

  // eslint-disable-next-line complexity
  private formatCreateOrder = (opts: PlaceOrderOpts) => {
    if (opts.type === OrderType.TrailingStopLoss) {
      return this.formatCreateTrailingStopLossOrder(opts);
    }

    const market = this.store.markets.find(({ symbol }) => {
      return symbol === opts.symbol;
    });

    if (!market) {
      throw new Error(`Market ${opts.symbol} not found`);
    }

    const isStopOrTP =
      opts.type === OrderType.StopLoss || opts.type === OrderType.TakeProfit;
    const isTP = opts.type === OrderType.TakeProfit;

    const pSide = this.getOrderPositionSide(opts);

    const maxSize = market.limits.amount.max;
    const pPrice = market.precision.price;

    const pAmount = market.precision.amount;
    const amount = adjust(opts.amount, pAmount);

    // We use price only for limit orders
    // Market order should not define price
    const price =
      opts.price && opts.type !== OrderType.Market
        ? adjust(opts.price, pPrice)
        : undefined;

    // Binance stopPrice only for SL or TP orders
    const priceField = isStopOrTP ? "stopPrice" : "price";

    const reduceOnly = !this.store.options.isHedged && opts.reduceOnly;
    const timeInForce = opts.timeInForce
      ? inverseObj(TIME_IN_FORCE)[opts.timeInForce]
      : inverseObj(TIME_IN_FORCE)[OrderTimeInForce.GoodTillCancel];

    const req = omitUndefined({
      symbol: opts.symbol,
      positionSide: pSide,
      side: inverseObj(ORDER_SIDE)[opts.side],
      type: inverseObj(ORDER_TYPE)[opts.type],
      quantity: !isTP && amount ? `${amount}` : undefined,
      [priceField]: price ? `${price}` : undefined,
      timeInForce: opts.type === OrderType.Limit ? timeInForce : undefined,
      closePosition: isStopOrTP ? "true" : undefined,
      reduceOnly: reduceOnly && !isStopOrTP ? "true" : undefined,
    });

    const lots = amount > maxSize ? Math.ceil(amount / maxSize) : 1;
    const rest = amount > maxSize ? adjust(amount % maxSize, pAmount) : 0;

    const lotSize = adjust((amount - rest) / lots, pAmount);

    const payloads: Array<Record<string, any>> = times(lots, () => ({
      ...req,
      quantity: `${lotSize}`,
    }));

    if (rest) {
      payloads.push({ ...req, quantity: `${rest}` });
    }

    if (opts.stopLoss) {
      payloads.push({
        ...omit(req, "price"),
        side: inverseObj(ORDER_SIDE)[
          opts.side === OrderSide.Buy ? OrderSide.Sell : OrderSide.Buy
        ],
        type: inverseObj(ORDER_TYPE)[OrderType.StopLoss],
        stopPrice: `${opts.stopLoss}`,
        timeInForce: "GTC",
        closePosition: "true",
      });
    }

    if (opts.takeProfit) {
      payloads.push({
        ...omit(req, "price"),
        side: inverseObj(ORDER_SIDE)[
          opts.side === OrderSide.Buy ? OrderSide.Sell : OrderSide.Buy
        ],
        type: inverseObj(ORDER_TYPE)[OrderType.TakeProfit],
        stopPrice: `${opts.takeProfit}`,
        timeInForce: "GTC",
        closePosition: "true",
      });
    }

    // We need to set orderId for each order
    // otherwise Binance will duplicate the IDs
    // when its sent in batches
    for (const payload of payloads) {
      payload.newClientOrderId = uuid();
    }

    return payloads;
  };

  private formatCreateTrailingStopLossOrder = (opts: PlaceOrderOpts) => {
    const market = this.store.markets.find((m) => m.symbol === opts.symbol);
    const ticker = this.store.tickers.find((t) => t.symbol === opts.symbol);

    const pSide =
      opts.side === OrderSide.Buy ? PositionSide.Short : PositionSide.Long;

    const position = this.store.positions.find(
      (p) => p.symbol === opts.symbol && p.side === pSide
    );

    if (!market) throw new Error(`Market ${opts.symbol} not found`);
    if (!ticker) throw new Error(`Ticker ${opts.symbol} not found`);

    if (!position) {
      throw new Error(`Position ${opts.symbol} and side ${pSide} not found`);
    }

    const priceDistance = adjust(
      Math.max(ticker.last, opts.price!) - Math.min(ticker.last, opts.price!),
      market.precision.price
    );

    const distancePercentage =
      Math.round(((priceDistance * 100) / ticker.last) * 10) / 10;

    const payload = {
      symbol: opts.symbol,
      positionSide: this.getOrderPositionSide(opts),
      side: inverseObj(ORDER_SIDE)[opts.side],
      type: inverseObj(ORDER_TYPE)[OrderType.TrailingStopLoss],
      quantity: `${position.contracts}`,
      callbackRate: `${distancePercentage}`,
      priceProtect: "true",
      newClientOrderId: uuid(),
    };

    return [payload];
  };

  private getOrderPositionSide = (opts: PlaceOrderOpts) => {
    let positionSide = "BOTH";

    // We need to specify side of the position to interract with
    // if we are in hedged mode on the binance account
    if (this.store.options.isHedged) {
      positionSide = opts.side === OrderSide.Buy ? "LONG" : "SHORT";

      if (
        opts.type === OrderType.StopLoss ||
        opts.type === OrderType.TakeProfit ||
        opts.type === OrderType.TrailingStopLoss ||
        opts.reduceOnly
      ) {
        positionSide = positionSide === "LONG" ? "SHORT" : "LONG";
      }
    }

    return positionSide;
  };

  private placeOrderBatch = async (payloads: any[]) => {
    const lots = chunk(payloads, 5);
    const orderIds = [] as string[];

    for (const lot of lots) {
      if (lot.length === 1) {
        try {
          await this.unlimitedXHR.post(ENDPOINTS.ORDER, lot[0]);
          orderIds.push(lot[0].newClientOrderId);
        } catch (err: any) {
          this.emitter.emit("error", err?.response?.data?.msg || err?.message);
        }
      }

      if (lot.length > 1) {
        const { data } = await this.unlimitedXHR.post(ENDPOINTS.BATCH_ORDERS, {
          batchOrders: JSON.stringify(lot),
        });

        data?.forEach?.((o: any) => {
          if (o.code) {
            this.emitter.emit("error", o.msg);
          } else {
            orderIds.push(o.clientOrderId);
          }
        });
      }
    }

    return orderIds;
  };
  // private sleep(ms: number) {
  //   return new Promise((resolve) => setTimeout(resolve, ms));
  // }

  // private placeOrderBatchFast = async (payloads: any[]) => {
  //   const lots = chunk(payloads, 5);
  //   const orderResults = [] as OrderResult[];

  //   const promises = lots.map(async (lot) => {
  //     try {
  //       const { data } = await this.unlimitedXHR.post(ENDPOINTS.BATCH_ORDERS, {
  //         batchOrders: JSON.stringify(lot),
  //       });
  //       await this.sleep(5);

  //       data?.forEach?.((o: any, index: number) => {
  //         const originalOrder = lot[index];
  //         if (o.code) {
  //           orderResults.push({
  //             orderId: originalOrder.newClientOrderId,
  //             error: o,
  //             symbol: originalOrder.symbol,
  //           });
  //         } else {
  //           orderResults.push({
  //             orderId: originalOrder.newClientOrderId,
  //             error: null,
  //             symbol: originalOrder.symbol,
  //           });
  //         }
  //       });
  //     } catch (err: any) {
  //       lot.forEach((o: any) => {
  //         orderResults.push({
  //           orderId: o.newClientOrderId,
  //           symbol: o.symbol,
  //           error: o,
  //         });
  //       });
  //     }
  //   });

  //   await Promise.all(promises);
  //   this.emitter.emit(
  //     "info",
  //     "Returning split orders results from placeorderbatchfast"
  //   );
  //   this.emitter.emit("info", orderResults);

  //   return orderResults;
  // };

  private placeOrderFast = async (payload: any): Promise<OrderResult> => {
    try {
      const { data } = await this.unlimitedXHR.post(ENDPOINTS.ORDER, payload);
      return {
        orderId: data.orderId, // Use the orderId from the response
        error: null,
        symbol: payload.symbol,
      };
    } catch (err: any) {
      return {
        orderId: payload.newClientOrderId, // Use newClientOrderId in case of error
        error: err,
        symbol: payload.symbol,
      };
    }
  };

  // private placeSplitOrders = async (payloads: PayloadOrder[]) => {
  //   const orderPromises = payloads.map((payload) =>
  //     this.unlimitedXHR
  //       .post(ENDPOINTS.ORDER, payload)
  //       .then(() => payload.newClientOrderId)
  //       .catch((err) => {
  //         this.emitter.emit("error", err?.response?.data?.msg || err?.message);
  //         return null; // Return null or a similar marker to indicate failure.
  //       })
  //   );

  //   const results = await Promise.allSettled(orderPromises);
  //   const orderIds = results
  //     .filter(
  //       (result) => result.status === "fulfilled" && result.value !== null
  //     )
  //     .map((result) => (result as PromiseFulfilledResult<string>).value);

  //   return orderIds;
  // };
}
