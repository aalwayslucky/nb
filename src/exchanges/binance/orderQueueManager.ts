import { Mutex } from "async-mutex";
import { OrderResult } from "../../types";

class OrderQueueManager {
  private placeOrderFast: (payload: any) => Promise<OrderResult>;
  private queue: any[] = [];
  private mutex = new Mutex();
  private processing = false;
  private waitingForResponse = false;
  private results: string[] = [];
  private resultsCollector: OrderResult[] = [];
  private orderTimestamps10s: number[] = [];
  private orderTimestamps60s: number[] = [];

  constructor(
    private emitter: any,
    placeOrderFast: (payload: any) => Promise<OrderResult>
  ) {
    this.placeOrderFast = placeOrderFast;
  }

  enqueueOrders = async (orders: any[]) => {
    const release = await this.mutex.acquire();
    try {
      this.queue.push(...orders);
      this.emitter.emit("orderManager", this.queue.length);
      if (!this.processing) {
        this.processing = true;
        this.startProcessing();
      }
    } finally {
      release();
    }
  };

  destroyQueue = async () => {
    const release = await this.mutex.acquire();
    try {
      this.queue = [];
      this.processing = false;
      this.orderTimestamps10s = [];
      this.orderTimestamps60s = [];
      this.emitter.emit("orderManager", this.queue.length);
    } finally {
      release();
    }
  };

  isProcessing() {
    return this.processing;
  }

  isWaitingForResponse() {
    return this.waitingForResponse;
  }

  getResults() {
    const resultsCopy = [...this.results];
    this.results = [];
    return resultsCopy;
  }

  getResultsCollected() {
    const resultsCollectorCopy = [...this.resultsCollector];
    this.resultsCollector = [];
    return resultsCollectorCopy;
  }

  private async startProcessing() {
    try {
      while (this.queue.length > 0) {
        await this.processOrders();
      }
    } catch (error) {
      this.emitter.emit("error", "Error in processing loop:", error);
    } finally {
      this.processing = false;
    }
  }

  private async processOrders() {
    const sleep = (ms: number) => {
      if (ms > 1000) {
        this.emitter.emit("waitingtime", ms);
      }
      return new Promise((resolve) => setTimeout(resolve, ms));
    };

    while (this.queue.length > 0) {
      const now = Date.now();
      this.orderTimestamps10s = this.orderTimestamps10s.filter(
        (timestamp) => now - timestamp < 10000
      );
      this.orderTimestamps60s = this.orderTimestamps60s.filter(
        (timestamp) => now - timestamp < 60000
      );

      if (
        this.orderTimestamps10s.length >= 300 ||
        this.orderTimestamps60s.length >= 1200
      ) {
        await sleep(
          now -
            Math.min(this.orderTimestamps10s[0], this.orderTimestamps60s[0]) +
            1
        );
        continue;
      }

      const release = await this.mutex.acquire();
      const order = this.queue.shift();
      release();
      this.emitter.emit("orderManager", this.queue.length);

      this.orderTimestamps10s.push(now);
      this.orderTimestamps60s.push(now);

      this.waitingForResponse = true;
      this.emitter.emit("waitingForResponse", this.waitingForResponse);

      try {
        const orderResult = await this.placeOrderFast(order);
        if (orderResult.error === null) {
          this.results.push(orderResult.orderId);
        } else {
          this.resultsCollector.push(orderResult);
        }
      } catch (error) {
        this.emitter.emit("error", "An unexpected error occurred:", error);
      } finally {
        this.waitingForResponse = false;
        this.emitter.emit("waitingForResponse", this.waitingForResponse);
      }

      // Add a small delay between orders to avoid overwhelming the API
      await sleep(10);
    }
  }
}

export default OrderQueueManager;
