import axios from "axios";
import retry, { isNetworkError } from "axios-retry";
import createHmac from "create-hmac";
import omit from "lodash/omit";
import qs from "qs";

import type { ExchangeOptions } from "../../types";
import { virtualClock } from "../../utils/virtual-clock";

import {
  BASE_URL,
  ENDPOINTS,
  PUBLIC_ENDPOINTS,
  RECV_WINDOW,
} from "./binance.types";

function getRandomLocalhostIP() {
  return `127.0.0.${Math.floor(Math.random() * 256)}`;
}

function getParamString(method: string, data: any, timestamp: number): string {
  const RECV_WINDOW = 5000; // Adjust this value as needed

  if (method.toLowerCase() === "get") {
    return `batchOrders=${encodeURIComponent(
      data.batchOrders
    )}&recvWindow=${RECV_WINDOW}&timestamp=${timestamp}`;
  } else if (method.toLowerCase() === "delete") {
    if (data.origClientOrderIdList) {
      // For batch cancellations
      return `symbol=${data.symbol}&origClientOrderIdList=${encodeURIComponent(
        JSON.stringify(data.origClientOrderIdList)
      )}&recvWindow=${RECV_WINDOW}&timestamp=${timestamp}`;
    } else {
      // For single order cancellation
      return `symbol=${data.symbol}&origClientOrderId=${encodeURIComponent(
        data.origClientOrderId
      )}&recvWindow=${RECV_WINDOW}&timestamp=${timestamp}`;
    }
  } else {
    throw new Error(`Unsupported method: ${method}`);
  }
}
const getBaseURL = (options: ExchangeOptions) => {
  if (options.extra?.binance?.http) {
    return options.testnet
      ? options.extra.binance.http.testnet
      : options.extra.binance.http.livenet;
  }

  return options.testnet ? BASE_URL.testnet : BASE_URL.livenet;
};
export const createAPI = (options: ExchangeOptions) => {
  const xhr = axios.create({
    baseURL: getBaseURL(options),
    headers: {
      "X-My-X-Forwarded-For": getRandomLocalhostIP(),
    },
  });

  // retry requests on network errors instead of throwing
  retry(xhr, { retries: 3, retryCondition: isNetworkError });

  xhr.interceptors.request.use((config) => {
    // on livenet, don't sign listen key requests (they don't need it)
    if (config.url === ENDPOINTS.LISTEN_KEY && !options.testnet) {
      const nextConfig = { ...config };
      nextConfig.headers["X-MBX-APIKEY"] = options.key;
      delete nextConfig.headers["X-My-X-Forwarded-For"];
      nextConfig.headers["Content-Type"] = "application/json, chartset=utf-8";
      nextConfig.baseURL = BASE_URL.livenet;
      return omit(nextConfig, "data");
    }

    // don't sign requests if no API key is provided
    // and don't add the timeout option
    if (PUBLIC_ENDPOINTS.some((str) => config.url?.startsWith(str))) {
      return config;
    }

    const nextConfig = { ...config };

    // Set default headers
    nextConfig.headers = nextConfig.headers || {};
    nextConfig.headers["X-My-X-Forwarded-For"] = getRandomLocalhostIP();

    nextConfig.headers["X-MBX-APIKEY"] = options.key;
    nextConfig.headers["Content-Type"] = "application/json, chartset=utf-8";
    const timestamp = virtualClock.getCurrentTime().valueOf();
    const data = config.data || config.params || {};
    data.timestamp = timestamp;
    data.recvWindow = RECV_WINDOW;

    // Sort parameters alphabetically
    const sortedData = Object.keys(data)
      .sort()
      .reduce(
        (acc, key) => {
          acc[key] = data[key];
          return acc;
        },
        {} as Record<string, any>
      );

    // Check if it's a batch order
    if (config.url === ENDPOINTS.BATCH_ORDERS && config.method) {
      // URL encode only the batchOrders parameter

      const paramString = getParamString(config.method, data, timestamp);

      const signature = createHmac("sha256", options.secret)
        .update(paramString)
        .digest("hex");

      // Set up the request
      nextConfig.headers["Content-Type"] = "application/x-www-form-urlencoded";
      nextConfig.data = `${paramString}&signature=${signature}`;
      delete nextConfig.headers["accept-encoding"];
      nextConfig.headers["Accept"] = "*/*";
      return omit(nextConfig, "params");
    } else {
      // For non-batch orders, use the previous approach
      const asString = qs.stringify(sortedData, { arrayFormat: "repeat" });
      const signature = createHmac("sha256", options.secret)
        .update(asString)
        .digest("hex");

      sortedData.signature = signature;
      nextConfig.params = sortedData;
      nextConfig.timeout = options?.extra?.recvWindow ?? RECV_WINDOW;
      return omit(nextConfig, "data");
    }
  });

  return xhr;
};
