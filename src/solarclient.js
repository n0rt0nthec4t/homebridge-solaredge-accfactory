// SolarEdge Monitoring API Client
// Part of homebridge-solaredge-accfactory
//
// Owns authenticated Monitoring API requests, site discovery, and inverter
// telemetry query formatting.
//
// Responsibilities:
// - Validate and use the configured Monitoring API URL and key
// - Fetch JSON with timeout and retry for transient failures
// - Keep the API key out of errors passed to platform logging
// - Fetch every page of sites owned by the account
// - Request recent inverter telemetry in the site's reported time zone
//
// Code version 2026.09.16
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { URL } from 'node:url';

// Import our modules
import { fetchWrapper } from './utils.js';

const API_BASE_URL = 'https://monitoringapi.solaredge.com';
const FETCH_TIMEOUT = 30000;

export function formatApiTime(value, timeZone = undefined) {
  // Format one instant using the timestamp shape expected by the Monitoring API.
  let date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime()) === true) {
    throw new TypeError('Invalid SolarEdge API date');
  }

  if (typeof timeZone === 'string' && timeZone !== '') {
    try {
      // The site time zone keeps the query window aligned when Homebridge runs
      // in a different region from the SolarEdge installation.
      let values = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', {
          timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hourCycle: 'h23',
        })
          .formatToParts(date)
          .filter((part) => part.type !== 'literal')
          .map((part) => [part.type, part.value]),
      );

      return [values.year, values.month, values.day].join('-') + ' ' + [values.hour, values.minute, values.second].join(':');
    } catch {
      // Use the local-time fallback below.
    }
  }

  // Missing or invalid site zones use the Homebridge host's local time.
  let local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);

  return local.toISOString().slice(0, 19).replace('T', ' ');
}

export class SolarEdgeClient {
  constructor(apiKey, baseUrl = API_BASE_URL, fetchRequest = fetchWrapper) {
    // Validate the API boundary once so later requests can use a fixed HTTPS origin.
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      throw new TypeError('SolarEdge API key is required');
    }

    // An empty custom URL falls back to SolarEdge's public Monitoring API.
    let parsed = new URL(typeof baseUrl === 'string' && baseUrl.trim() !== '' ? baseUrl : API_BASE_URL);

    if (parsed.protocol !== 'https:') {
      throw new TypeError('SolarEdge API URL must use HTTPS');
    }

    this.apiKey = apiKey;
    this.baseUrl = parsed.toString().replace(/\/$/, '');
    this.fetchRequest = fetchRequest;
  }

  async get(endpoint, params = {}) {
    // Build one authenticated JSON request and hide credentials from failures.
    if (typeof endpoint !== 'string' || endpoint.startsWith('/') === false) {
      throw new TypeError('Invalid SolarEdge API endpoint');
    }

    let url = new URL(this.baseUrl + endpoint + '.json');

    for (let [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    // SolarEdge v1 authenticates with a query parameter rather than a header.
    url.searchParams.set('api_key', this.apiKey);

    let response;
    try {
      response = await this.fetchRequest('get', url.toString(), { timeout: FETCH_TIMEOUT, retry: 2 });
    } catch (error) {
      // fetchWrapper includes the request URL; replace that error before it can
      // reach Homebridge logging because the URL contains the API key.
      let status = error?.status ?? (typeof error?.code === 'number' ? error.code : undefined);
      let safeError = new Error('SolarEdge request failed for ' + endpoint + (status !== undefined ? ' (HTTP ' + status + ')' : ''));

      safeError.status = status;

      throw safeError;
    }

    // A successful HTTP response still needs valid JSON before it can be translated.
    try {
      return await response.json();
    } catch {
      throw new Error('SolarEdge returned invalid JSON for ' + endpoint);
    }
  }

  async listSites() {
    // Load every site visible to the key while respecting the 100-site page size.
    let sites = [];

    for (let startIndex = 0; ; startIndex += 100) {
      let data = await this.get('/sites/list', { sortProperty: 'name', sortOrder: 'ASC', size: 100, startIndex });

      // JSON responses use sites.site; older payloads have also used other casing.
      let result = data?.sites?.site ?? data?.sites?.list ?? data?.Sites?.site ?? data?.Sites?.list;
      let page = Array.isArray(result) === true ? result : result !== null && typeof result === 'object' ? [result] : [];

      // Stop if a server ignores startIndex and repeats the previous page.
      if (startIndex > 0 && page[0]?.id === sites[startIndex - 100]?.id) {
        break;
      }

      sites.push(...page);
      let count = Number(data?.sites?.count ?? data?.Sites?.count);

      if (page.length < 100 || (Number.isFinite(count) === true && count > 0 && sites.length >= count)) {
        break;
      }
    }

    return sites;
  }

  async getInverterTelemetry(siteId, serialNumber, endTime = new Date(), timeZone = undefined) {
    // Request the most recent 30-minute technical-data window for one inverter.
    if ((typeof siteId !== 'number' && typeof siteId !== 'string') || String(siteId) === '') {
      throw new TypeError('SolarEdge site ID is required');
    }

    if (typeof serialNumber !== 'string' || serialNumber.trim() === '') {
      throw new TypeError('SolarEdge inverter serial number is required');
    }

    let end = endTime instanceof Date ? endTime : new Date(endTime);
    let start = new Date(end.getTime() - 30 * 60 * 1000);

    // Endpoint path values identify the physical inverter; query timestamps use
    // the site's local time because SolarEdge returns unzoned telemetry dates.
    return this.get('/equipment/' + encodeURIComponent(siteId) + '/' + encodeURIComponent(serialNumber.trim()) + '/data', {
      startTime: formatApiTime(start, timeZone),
      endTime: formatApiTime(end, timeZone),
    });
  }
}
