// SolarEdge Inventory Translation
// Part of homebridge-solaredge-accfactory
//
// Converts site inventory and power flow responses into one HomeKit-ready
// snapshot per inverter while preserving the API response data.
//
// Responsibilities:
// - Normalise source power units to watts
// - Read stable inverter serial numbers and metadata
// - Apply per-inverter exclusion and Eve history settings
//
// Code version 2026.09.16
// Mark Hulskamp
'use strict';

// Import our modules
import HomeKitDevice from './HomeKitDevice.js';
import SolarInverter from './inverter.js';

function translateSites(rawData, config) {
  let devices = {};

  // Each raw entry combines one site's details, inventory, and current power flow.
  Object.values(rawData).forEach((data) => {
    // Reuse the site flow for its inverters without changing the cached API response.
    let powerflow = structuredClone(data?.powerflow?.constructor === Object ? data.powerflow : {});

    // Monitoring API power flow defaults to kilowatts; HomeKit values use watts.
    let unit = typeof powerflow.unit === 'string' ? powerflow.unit.toUpperCase() : 'KW';
    let multiplier = { W: 1, KW: 1000, MW: 1000000 }[unit] ?? 1000;
    for (let key of ['GRID', 'PV', 'LOAD', 'STORAGE']) {
      // Some sites omit a flow element or its power; HomeKit receives zero then.
      let value = powerflow[key]?.constructor === Object ? powerflow[key] : {};
      let watts =
        value.currentPower !== null && Number.isFinite(Number(value.currentPower)) === true ? Number(value.currentPower) * multiplier : 0;

      powerflow[key] = {
        ...value,
        currentPower: watts,
        status: typeof value.status === 'string' ? value.status : watts > 0 ? 'Active' : 'Idle',
      };
    }

    powerflow.unit = 'W';

    // SolarEdge may return one connection object instead of an array.
    let connections = powerflow.connections;
    powerflow.connections = Array.isArray(connections) === true ? connections : connections?.constructor === Object ? [connections] : [];

    // The inventory API can likewise return a single inverter object.
    let inventory = data?.inventory?.inverters;
    let inverters = Array.isArray(inventory) === true ? inventory : inventory?.constructor === Object ? [inventory] : [];

    // Site peakPower is specified in kilowatts independently of flow.unit.
    let sitePeakPower = Number.isFinite(Number(data?.site?.peakPower)) === true ? Number(data.site.peakPower) * 1000 : 0;

    inverters.forEach((inverter) => {
      // serialNumber is the Monitoring API field; SN supports older payloads.
      let serialValue = inverter?.serialNumber ?? inverter?.SN;
      let serial = typeof serialValue === 'string' ? serialValue.trim().toUpperCase() : '';
      let location = typeof data?.site?.location?.city === 'string' ? data.site.location.city : '';

      let description =
        typeof inverter?.name === 'string' && inverter.name !== '' ? inverter.name : location || 'SolarEdge Inverter ' + serial;

      if (serial === '') {
        // A stable serial is required to create the same accessory on each launch.
        return;
      }

      // Global history is the default; an explicit per-inverter boolean overrides it.
      let electrical = translateInverterTelemetry(data?.telemetry?.[serial]);

      devices[serial] = {
        excluded: config?.devices?.[serial]?.exclude === true || config?.devices?.[serial]?.excluded === true,
        serialNumber: serial,
        softwareVersion: typeof inverter?.cpuVersion === 'string' ? inverter.cpuVersion.replace(/-/g, '.') : SolarInverter.VERSION,
        model: typeof inverter?.model === 'string' && inverter.model !== '' ? inverter.model : 'SolarEdge Inverter',
        manufacturer: typeof inverter?.manufacturer === 'string' && inverter.manufacturer !== '' ? inverter.manufacturer : 'SolarEdge',
        siteId: data.site.id,
        installationDate: data.site.installationDate,
        description: HomeKitDevice.makeValidHKName(location === '' ? description : description + ' - ' + location),
        peakPower: sitePeakPower,
        powerflow: powerflow,
        ...(electrical === undefined ? {} : { electrical }),
        online: true,
        eveHistory:
          typeof config?.devices?.[serial]?.eveHistory === 'boolean' ? config.devices[serial].eveHistory : config.options.eveHistory,
      };
    });
  });

  return devices;
}

function translateInverterTelemetry(response) {
  let telemetries = response?.data?.telemetries;
  if (Array.isArray(telemetries) === false || telemetries.length === 0) {
    return;
  }

  let latest = telemetries[telemetries.length - 1];

  // Some clients wrap the phase fields in threePhaseInverterTelemetry.
  latest = latest?.threePhaseInverterTelemetry ?? latest;

  let phases = ['L1Data', 'L2Data', 'L3Data'].map((key) => latest?.[key]).filter((phase) => phase !== null && typeof phase === 'object');
  let volts = phases.map((phase) => Number(phase.acVoltage)).filter((value) => Number.isFinite(value) === true);
  let amps = phases.map((phase) => Number(phase.acCurrent)).filter((value) => Number.isFinite(value) === true);

  if (volts.length === 0 || amps.length === 0) {
    return;
  }

  // Eve has one value for each measurement. For multiphase inverters expose
  // average phase voltage and total current across the available phases.
  return {
    volts: volts.reduce((total, value) => total + value, 0) / volts.length,
    amps: amps.reduce((total, value) => total + value, 0),
    measuredAt: typeof latest.date === 'string' ? latest.date : undefined,
  };
}

// Define exports
export { translateSites, translateInverterTelemetry };
