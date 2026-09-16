// Utility Helpers
// Part of homebridge-solaredge-accfactory
//
// Provides shared value scaling and HTTP request handling for SolarEdge.
//
// Responsibilities:
// - Scale solar generation into HomeKit ranges
// - Perform GET and POST requests with timeouts and transient retries
//
// Notes:
// - SolarEdgeClient removes API keys from errors before platform logging
//
// Code version 2026.09.16
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { setTimeout } from 'node:timers';

function scaleValue(value, sourceMin, sourceMax, targetMin, targetMax) {
  // Validate numeric inputs
  if (
    Number.isFinite(Number(value)) !== true ||
    Number.isFinite(Number(sourceMin)) !== true ||
    Number.isFinite(Number(sourceMax)) !== true ||
    Number.isFinite(Number(targetMin)) !== true ||
    Number.isFinite(Number(targetMax)) !== true
  ) {
    return undefined;
  }

  value = Number(value);
  sourceMin = Number(sourceMin);
  sourceMax = Number(sourceMax);
  targetMin = Number(targetMin);
  targetMax = Number(targetMax);

  // Prevent divide-by-zero scaling range
  if (sourceMax === sourceMin) {
    return targetMin;
  }

  // Clamp source value to input range
  value = Math.max(sourceMin, Math.min(sourceMax, value));

  // Scale value proportionally into target range
  return ((value - sourceMin) * (targetMax - targetMin)) / (sourceMax - sourceMin) + targetMin;
}

async function fetchWrapper(method, url, options = {}, data) {
  // Only support GET and POST requests
  // Invalid inputs fail silently to match existing helper behaviour
  if ((method !== 'get' && method !== 'post') || typeof url !== 'string' || url === '' || typeof options !== 'object') {
    return;
  }

  // Retry count configuration
  // Defaults to a single attempt if not specified
  let retry = Number.isFinite(Number(options.retry)) === true && Number(options.retry) > 0 ? Number(options.retry) : 1;
  let retryCount = Number.isFinite(Number(options._retryCount)) === true ? Number(options._retryCount) : 0;

  // Clone fetch options so we can safely remove internal-only fields
  let fetchOptions = {
    ...options,
    method,
    _retryCount: retryCount,
  };

  // Remove internal helper options before passing to fetch()
  delete fetchOptions.retry;
  delete fetchOptions.timeout;
  delete fetchOptions._retryCount;
  delete fetchOptions.signal;

  // Apply timeout using AbortSignal if configured
  if (Number.isFinite(Number(options?.timeout)) === true && Number(options.timeout) > 0) {
    fetchOptions.signal = AbortSignal.timeout(Number(options.timeout));
  }

  // Process POST body handling
  if (method === 'post' && data !== undefined) {
    // Automatically serialise plain objects as JSON
    if (typeof data === 'object' && data !== null && data.constructor === Object) {
      fetchOptions.body = JSON.stringify(data);
      fetchOptions.headers ??= {};

      // Apply JSON content type if not already specified
      if (fetchOptions.headers['Content-Type'] === undefined) {
        fetchOptions.headers['Content-Type'] = 'application/json';
      }
    } else {
      // Pass through raw body types unchanged
      fetchOptions.body = data;
    }
  }

  try {
    // Perform request
    // eslint-disable-next-line no-undef
    let response = await fetch(url, {
      ...fetchOptions,
      ...(options?.dispatcher !== undefined ? { dispatcher: options.dispatcher } : {}),
    });

    // HTTP request completed but returned non-success status
    if (response?.ok === false) {
      // Only retry transient/server-side failures
      // Do not retry authentication or client configuration failures
      let retryableStatus = [408, 429, 500, 502, 503, 504].includes(response.status) === true;

      if (retry > 1 && retryableStatus === true) {
        // Exponential backoff delay
        let delay = 500 * Math.pow(2, retryCount);
        await new Promise((resolve) => setTimeout(resolve, delay));

        return fetchWrapper(
          method,
          url,
          {
            ...options,
            retry: retry - 1,
            _retryCount: retryCount + 1,
          },
          data,
        );
      }

      // Attempt to capture response body for debugging
      let body = '';
      try {
        body = await response.text();
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        // Ignore body parsing failures
      }

      throw Object.assign(
        new Error(
          'HTTP ' +
            response.status +
            ' on ' +
            method.toUpperCase() +
            ' ' +
            url +
            ': ' +
            (typeof response.statusText === 'string' && response.statusText !== '' ? response.statusText : 'Unknown error'),
        ),
        {
          code: response.status,
          status: response.status,
          body,
        },
      );
    }

    return response;
  } catch (error) {
    // Preserve original/root cause where available
    let original = error?.cause ?? error;

    // Determine whether failure is considered transient/retryable
    let retryable =
      error?.name === 'AbortError' ||
      error?.name === 'TimeoutError' ||
      error?.name === 'TypeError' ||
      original?.name === 'AbortError' ||
      original?.name === 'TimeoutError' ||
      original?.name === 'TypeError' ||
      original?.code === 'UND_ERR_HEADERS_TIMEOUT' ||
      original?.code === 'UND_ERR_CONNECT_TIMEOUT';

    // Invalid URLs should fail immediately
    if (original?.code === 'ERR_INVALID_URL') {
      throw Object.assign(new Error('Invalid URL: ' + url), {
        code: 'ERR_INVALID_URL',
        cause: original,
      });
    }

    // Retry transient transport/network failures
    if (retry > 1 && retryable === true) {
      // Exponential backoff delay
      let delay = 500 * Math.pow(2, retryCount);
      await new Promise((resolve) => setTimeout(resolve, delay));

      return fetchWrapper(
        method,
        url,
        {
          ...options,
          retry: retry - 1,
          _retryCount: retryCount + 1,
        },
        data,
      );
    }

    // Final wrapped error after all retry attempts exhausted
    throw Object.assign(
      new Error(
        method.toUpperCase() +
          ' ' +
          url +
          ' failed after ' +
          (retryCount + 1) +
          ' attempt' +
          (retryCount + 1 > 1 ? 's' : '') +
          ': ' +
          (typeof original?.message === 'string' && original.message !== '' ? original.message : String(original)),
      ),
      {
        code: original?.code,
        cause: original,
      },
    );
  }
}

// Define exports
export { scaleValue, fetchWrapper };
