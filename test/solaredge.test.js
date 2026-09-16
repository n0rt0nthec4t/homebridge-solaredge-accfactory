import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate, setTimeout } from 'node:timers';
import { URL } from 'node:url';
import * as hap from '@homebridge/hap-nodejs';
import { processConfig } from '../dist/config.js';
import registerSolarEdge from '../dist/index.js';
import HomeKitDevice from '../dist/HomeKitDevice.js';
import SolarInverter from '../dist/inverter.js';
import SolarEdgeAccfactory from '../dist/system.js';
import { formatApiTime, SolarEdgeClient } from '../dist/solarclient.js';
import { translateInverterTelemetry, translateSites } from '../dist/translator.js';
import { fetchWrapper, scaleValue } from '../dist/utils.js';

test('configuration applies history defaults and honors device overrides', () => {
  let original = { solaredge: { apiKey: ' key ' }, options: { eveHistory: false }, devices: { ABC: { eveHistory: true } } };
  let result = processConfig(original);
  assert.equal(result.solaredge.apiKey, 'key');
  assert.equal(result.options.eveHistory, false);
  assert.equal(result.devices.ABC.eveHistory, true);
  assert.equal(original.solaredge.apiKey, ' key ');
  assert.equal(processConfig({ solaredge: { apiKey: 'key' } }).options.eveHistory, true);
});

test('power flow converts source units without mutating the response', () => {
  let source = { unit: 'kW', PV: { currentPower: 2.5 }, GRID: { currentPower: null }, connections: { from: 'PV', to: 'Load' } };
  let devices = translateSites(
    { 1: { site: { id: 1, peakPower: 5 }, inventory: { inverters: [{ serialNumber: 'ABC' }] }, powerflow: source } },
    { options: { eveHistory: true }, devices: {} },
  );
  let output = devices.ABC.powerflow;
  assert.equal(output.PV.currentPower, 2500);
  assert.equal(output.GRID.currentPower, 0);
  assert.equal(output.unit, 'W');
  assert.deepEqual(output.connections, [{ from: 'PV', to: 'Load' }]);
  assert.equal(source.PV.currentPower, 2.5);
});

test('inverter telemetry combines phase readings for Eve Energy', () => {
  let electrical = translateInverterTelemetry({
    data: {
      telemetries: [
        {
          date: '2026-09-16 12:00:00',
          L1Data: { acVoltage: 230, acCurrent: 2 },
          L2Data: { acVoltage: 232, acCurrent: 3 },
          L3Data: { acVoltage: 234, acCurrent: 4 },
        },
      ],
    },
  });
  assert.deepEqual(electrical, { volts: 232, amps: 9, measuredAt: '2026-09-16 12:00:00' });
});

test('shared scaleValue clamps generation to HomeKit percentage', () => {
  assert.equal(scaleValue(2500, 0, 5000, 0, 100), 50);
  assert.equal(scaleValue(6000, 0, 5000, 0, 100), 100);
  assert.equal(scaleValue(0, 0, 0, 0, 100), 0);
  assert.equal(scaleValue('invalid', 0, 5000, 0, 100), undefined);
});

test('shared fetchWrapper is used by the default client without leaking its key', async () => {
  let previousFetch = globalThis.fetch;
  let requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: false, status: 401, statusText: 'Unauthorized', text: async () => '' };
  };
  try {
    let client = new SolarEdgeClient('secret-key');
    await assert.rejects(client.get('/sites/list'), (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.message.includes('secret-key'), false);
      return true;
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.method, 'get');
    assert.equal(requests[0].options.signal instanceof AbortSignal, true);
    assert.equal(typeof fetchWrapper, 'function');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('entry point registers the SolarEdge platform', () => {
  let platform;
  registerSolarEdge({ registerPlatform: (name, implementation) => (platform = { name, implementation }) });
  assert.equal(platform.name, 'SolarEdgeAccfactory');
  assert.equal(platform.implementation.name, 'SolarEdgeAccfactory');
});

test('API client builds Monitoring API requests and keeps the key out of errors', async () => {
  assert.equal(formatApiTime(new Date('2026-09-16T02:30:00Z'), 'Australia/Sydney'), '2026-09-16 12:30:00');
  assert.throws(() => new SolarEdgeClient('secret-key', 'http://example.test'), /HTTPS/);
  let request;
  let client = new SolarEdgeClient('secret-key', 'https://example.test/', async (method, url, options) => {
    request = { method, url, options };
    return { json: async () => ({ sites: { site: [{ id: 1 }] } }) };
  });
  assert.deepEqual(await client.get('/sites/list', { size: 100 }), { sites: { site: [{ id: 1 }] } });
  let url = new URL(request.url);
  assert.equal(url.pathname, '/sites/list.json');
  assert.equal(url.searchParams.get('api_key'), 'secret-key');
  assert.equal(url.searchParams.get('size'), '100');
  assert.equal(request.method, 'get');
  assert.equal(request.options.timeout, 30000);

  await client.getInverterTelemetry(12, 'ABC-123', new Date(2026, 8, 16, 12, 30, 0));
  let telemetryUrl = new URL(request.url);
  assert.equal(telemetryUrl.pathname, '/equipment/12/ABC-123/data.json');
  assert.equal(telemetryUrl.searchParams.get('endTime'), formatApiTime(new Date(2026, 8, 16, 12, 30, 0)));
  assert.equal(telemetryUrl.searchParams.get('startTime'), formatApiTime(new Date(2026, 8, 16, 12, 0, 0)));

  let failed = new SolarEdgeClient('secret-key', undefined, async () => {
    throw Object.assign(new Error('GET https://example.test/?api_key=secret-key failed'), { status: 401 });
  });
  await assert.rejects(failed.get('/sites/list'), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.message.includes('secret-key'), false);
    return true;
  });
});

test('site list follows Monitoring API pagination', async () => {
  let indexes = [];
  let client = new SolarEdgeClient('key', undefined, async (_method, requestUrl) => {
    let startIndex = Number(new URL(requestUrl).searchParams.get('startIndex'));
    indexes.push(startIndex);
    let page = startIndex === 0 ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })) : [{ id: 101 }];
    return { json: async () => ({ sites: { count: 101, site: page } }) };
  });
  let sites = await client.listSites();
  assert.equal(sites.length, 101);
  assert.deepEqual(indexes, [0, 100]);
});

test('documented inventory serialNumber creates an inverter snapshot', () => {
  let raw = {
    12: {
      site: { id: 12, peakPower: 6, location: { city: 'Sydney' } },
      inventory: { inverters: [{ serialNumber: ' abc-123 ', name: 'Inverter 1', cpuVersion: '4-2', model: 'SE6K' }] },
      powerflow: { unit: 'kW', PV: { currentPower: 1.2 } },
    },
  };
  let devices = translateSites(raw, { options: { eveHistory: false }, devices: { 'ABC-123': { eveHistory: true } } });
  assert.equal(devices['ABC-123'].serialNumber, 'ABC-123');
  assert.equal(devices['ABC-123'].softwareVersion, '4.2');
  assert.equal(devices['ABC-123'].siteId, 12);
  assert.equal(devices['ABC-123'].peakPower, 6000);
  assert.equal(devices['ABC-123'].powerflow.PV.currentPower, 1200);
  assert.equal(devices['ABC-123'].eveHistory, true);
});

test('inverter creates an outlet through the current HomeKitDevice API', async () => {
  let registered = [];
  let log = Object.fromEntries(['info', 'success', 'warn', 'error', 'debug'].map((level) => [level, () => {}]));
  let api = {
    hap,
    version: 2,
    platformAccessory: hap.Accessory,
    on() {},
    registerPlatformAccessories(_plugin, _platform, accessories) {
      registered.push(...accessories);
    },
    updatePlatformAccessories() {},
    unregisterPlatformAccessories() {},
  };
  HomeKitDevice.LOGGER = log;
  let device = new SolarInverter(undefined, api, {
    serialNumber: 'ABC-123',
    softwareVersion: '4.2',
    description: 'Solar Inverter',
    manufacturer: 'SolarEdge',
    model: 'SE6K',
    peakPower: 6000,
    electrical: { volts: 232.4, amps: 5.6 },
    powerflow: { PV: { currentPower: 1200, status: 'Active' }, connections: [{ from: 'PV', to: 'GRID' }] },
    online: true,
  });
  try {
    assert.equal(
      await device.add({ hapAccessoryName: 'SolarEdge Inverter', hapCategory: hap.Categories.OUTLET, enableHistory: true }),
      true,
    );
    assert.equal(registered.length, 1);
    assert.equal(device.historyService !== undefined, true);
    assert.equal(device.accessory.getService(hap.Service.Outlet).getCharacteristic(hap.Characteristic.On).value, true);
    assert.equal(device.accessory.getService(hap.Service.Battery).getCharacteristic(hap.Characteristic.BatteryLevel).value, 20);
    assert.equal(
      device.accessory.getService(hap.Service.LightSensor).getCharacteristic(hap.Characteristic.CurrentAmbientLightLevel).value,
      1200,
    );
    assert.deepEqual(await HomeKitDevice.message(device.uuid, HomeKitDevice.EVEHOME.GET, {}), {
      volts: 232.4,
      watts: 1200,
      amps: 5.6,
    });

    await HomeKitDevice.message(device.uuid, HomeKitDevice.UPDATE, { online: false });
    assert.equal(
      device.accessory.getService(hap.Service.Outlet).getCharacteristic(hap.Characteristic.StatusFault).value,
      hap.Characteristic.StatusFault.GENERAL_FAULT,
    );
  } finally {
    await device.shutdown();
  }
});

test('platform discovers an API site and registers its inverter', async () => {
  let events = new Map();
  let registered = [];
  let unregistered = [];
  let resolveRegistered;
  let registeredAccessory = new Promise((resolve) => {
    resolveRegistered = resolve;
  });
  let log = Object.fromEntries(['info', 'success', 'warn', 'error', 'debug'].map((level) => [level, () => {}]));
  let api = {
    hap,
    version: 2,
    platformAccessory: hap.Accessory,
    on(event, listener) {
      events.set(event, [...(events.get(event) ?? []), listener]);
    },
    registerPlatformAccessories(_plugin, _platform, accessories) {
      registered.push(...accessories);
      resolveRegistered(accessories[0]);
    },
    updatePlatformAccessories() {},
    unregisterPlatformAccessories(_plugin, _platform, accessories) {
      unregistered.push(...accessories);
    },
  };
  let responses = {
    '/sites/list.json': { sites: { count: 1, site: [{ id: 12, peakPower: 6, location: { city: 'Sydney' } }] } },
    '/site/12/inventory.json': { Inventory: { inverters: [{ serialNumber: 'ABC-123', name: 'Inverter 1', model: 'SE6K' }] } },
    '/site/12/currentPowerFlow.json': { siteCurrentPowerFlow: { unit: 'kW', PV: { currentPower: 1.2, status: 'Active' } } },
  };
  let platform = new SolarEdgeAccfactory(log, { solaredge: { apiKey: 'key' }, options: { eveHistory: false } }, api, {
    fetchRequest: async (_method, requestUrl) => ({ json: async () => responses[new URL(requestUrl).pathname] }),
  });
  let staleAccessory = new hap.Accessory('Removed inverter', hap.uuid.generate('REMOVED-INVERTER'));
  platform.configureAccessory(staleAccessory);

  try {
    events.get('didFinishLaunching')[0]();
    let accessory = await Promise.race([
      registeredAccessory,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Inverter registration timed out')), 1000)),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(registered.length, 1);
    assert.equal(accessory.getService(hap.Service.Outlet).getCharacteristic(hap.Characteristic.On).value, true);
    assert.deepEqual(unregistered, [staleAccessory]);
  } finally {
    for (let listener of events.get('shutdown') ?? []) {
      await listener();
    }
  }
});

test('a failed site request does not prevent another inverter from publishing', async () => {
  let events = new Map();
  let registered = [];
  let log = Object.fromEntries(['info', 'success', 'warn', 'error', 'debug'].map((level) => [level, () => {}]));
  let api = {
    hap,
    version: 2,
    platformAccessory: hap.Accessory,
    on(event, listener) {
      events.set(event, [...(events.get(event) ?? []), listener]);
    },
    registerPlatformAccessories(_plugin, _platform, accessories) {
      registered.push(...accessories);
    },
    updatePlatformAccessories() {},
    unregisterPlatformAccessories() {},
  };
  let responses = {
    '/sites/list.json': {
      sites: {
        count: 2,
        site: [
          { id: 11, peakPower: 5 },
          { id: 12, peakPower: 6 },
        ],
      },
    },
    '/site/12/inventory.json': { Inventory: { inverters: [{ serialNumber: 'GOOD-INVERTER' }] } },
    '/site/12/currentPowerFlow.json': { siteCurrentPowerFlow: { unit: 'kW', PV: { currentPower: 2 } } },
  };
  new SolarEdgeAccfactory(log, { solaredge: { apiKey: 'key' }, options: { eveHistory: false } }, api, {
    fetchRequest: async (_method, requestUrl) => {
      let path = new URL(requestUrl).pathname;
      if (path.startsWith('/site/11/')) {
        throw new Error('Site request failed');
      }
      return { json: async () => responses[path] };
    },
  });
  try {
    await events.get('didFinishLaunching')[0]();
    assert.equal(registered.length, 1);
    assert.equal(
      registered[0].getService(hap.Service.AccessoryInformation).getCharacteristic(hap.Characteristic.SerialNumber).value,
      'GOOD-INVERTER',
    );
    assert.equal(registered[0].getService(hap.Service.Outlet).getCharacteristic(hap.Characteristic.On).value, true);
  } finally {
    for (let listener of events.get('shutdown') ?? []) {
      await listener();
    }
  }
});
