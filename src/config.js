// Configuration Processing
// Part of homebridge-solaredge-accfactory
//
// Validates the Monitoring API key and applies history defaults without
// changing the Homebridge configuration object.
//
// Responsibilities:
// - Validate the API key before network requests begin
// - Preserve per-inverter exclusions and Eve history overrides
// - Apply the global Eve history default
//
// Code version 2026.09.16
// Mark Hulskamp
'use strict';

export function processConfig(config = {}, log = undefined) {
  // Reject malformed sections while preserving the original config for callers.
  let source = config?.constructor === Object ? config : {};
  let solaredge = source?.solaredge?.constructor === Object ? source.solaredge : {};
  let options = source?.options?.constructor === Object ? source.options : {};
  let devices = source?.devices?.constructor === Object ? source.devices : {};

  // A blank key cannot authorise any Monitoring API request.
  let apiKey = typeof solaredge.apiKey === 'string' ? solaredge.apiKey.trim() : '';

  if (apiKey === '') {
    log?.error?.('Required SolarEdge API Key is missing from JSON configuration. Please review');
  }

  // Only an explicit false disables Eve history; device overrides are applied later.
  return {
    ...source,
    solaredge: {
      ...solaredge,
      apiKey,
    },
    options: {
      ...options,
      eveHistory: options.eveHistory !== false,
    },
    devices,
  };
}
