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

const getBaseURL = (options: ExchangeOptions) => {
  if (options.extra?.binance?.http) {
    return options.testnet
      ? options.extra.binance.http.testnet
      : options.extra.binance.http.livenet;
  }

  return options.testnet ? BASE_URL.testnet : BASE_URL.livenet;
};

export const createAPI = (options: ExchangeOptions) => {
  const baseURL = getBaseURL(options);

  const xhr = axios.create({
    baseURL: baseURL,
    headers: {
      "X-MBX-APIKEY": options.key,
      "Content-Type": "application/json, chartset=utf-8",
    },
  });

  // retry requests on network errors instead of throwing
  retry(xhr, { retries: 3, retryCondition: isNetworkError });

  xhr.interceptors.request.use((config) => {
    // on livenet, don't sign listen key requests (they don't need it)
    if (config.url === ENDPOINTS.LISTEN_KEY && !options.testnet) {
      return config;
    }

    // don't sign requests if no API key is provided
    // and don't add the timeout option
    if (PUBLIC_ENDPOINTS.some((str) => config.url?.startsWith(str))) {
      return config;
    }

    const nextConfig = { ...config };
    const timestamp = virtualClock.getCurrentTime().valueOf();

    const data = { ...config.params, ...config.data };
    data.timestamp = timestamp;
    data.recvWindow = RECV_WINDOW;

    const queryString = qs.stringify(data, { arrayFormat: "repeat" });
    const signature = createHmac("sha256", options.secret)
      .update(queryString)
      .digest("hex");

    // Construct the full URL with the signature at the end
    const fullUrl = `${config.url}?${queryString}&signature=${signature}`;
    nextConfig.url = fullUrl;

    // Remove params and data from the config
    delete nextConfig.params;
    delete nextConfig.data;

    // use cors-anywhere to bypass CORS
    // Binance doesn't allow CORS on their testnet API
    if (
      nextConfig.method !== "get" &&
      options.testnet &&
      options.corsAnywhere
    ) {
      nextConfig.baseURL = `${options.corsAnywhere}/${config.baseURL}`;
    }

    // Add timeout to signed requests (default is 5s)
    nextConfig.timeout = options?.extra?.recvWindow ?? RECV_WINDOW;

    return nextConfig;
  });

  return xhr;
};
