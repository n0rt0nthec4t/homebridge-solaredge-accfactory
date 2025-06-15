// homebridge-solaredge-accfactory
//
// reference for details:
// v1 API - https://www.solaredge.com/sites/default/files/se_monitoring_api.pdf
// v2 API - https://developers.solaredge.com/docs/monitoring/e9nwvc91l1jf5-getting-started-with-monitoring-api
//
// Expose "outlet" service with additonal battery service
//  Outlet On = Generating Solar
//  Outlet Off = Not generating Solar
//
//  Battery Level = Percentage of solar generating vs max system specs
//  Battery Charging Yes = Generating solar and exporting to grid
//  Battery Charging No = Generating solar only, not exprting to grid
//  Low battery indicator = Importing from grid
//
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import EventEmitter from 'node:events';
import { clearInterval, setTimeout } from 'node:timers';
import crypto from 'node:crypto';

// Import our modules
import HomeKitDevice from './HomeKitDevice.js';
HomeKitDevice.PLUGIN_NAME = 'homebridge-solaredge-accfactory';
HomeKitDevice.PLATFORM_NAME = 'SolarEdgeAccfactory';

import HomeKitHistory from './HomeKitHistory.js';
HomeKitDevice.HISTORY = HomeKitHistory;

// Solar Inverter class
class SolarInverter extends HomeKitDevice {
  static TYPE = 'SolarInverter';
  static VERSION = '2025.06.15';

  batteryService = undefined;
  outletService = undefined;
  lightService = undefined;

  constructor(accessory, api, log, eventEmitter, deviceData) {
    super(accessory, api, log, eventEmitter, deviceData);
  }

  // Class functions
  setupDevice() {
    // Setup the outlet service if not already present on the accessory
    this.outletService = this.addHKService(this.hap.Service.Outlet, '', 1);
    this.outletService.setPrimaryService();

    // Setup battery service if not already present on the accessory
    this.batteryService = this.addHKService(this.hap.Service.Battery, '', 1);
    this.batteryService.setHiddenService(true);
    this.batteryService.getCharacteristic(this.hap.Characteristic.BatteryLevel).displayName = 'Solar Generation';
    this.batteryService.getCharacteristic(this.hap.Characteristic.ChargingState).displayName = 'Exporting';

    // Setup LightSensor service for solar generation LUX
    this.lightService = this.addHKService(this.hap.Service.LightSensor, '', 1);
    this.lightService.setHiddenService(true);

    this.addHKCharacteristic(this.lightService, this.hap.Characteristic.CurrentAmbientLightLevel);
    this.lightService.getCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel).displayName = 'Solar Generation';

    // Setup linkage to EveHome app if configured todo so
    if (
      this.deviceData?.eveHistory === true &&
      this.outletService !== undefined &&
      typeof this.historyService?.linkToEveHome === 'function'
    ) {
      this.historyService.linkToEveHome(this.outletService, {
        description: this.deviceData.description,
        getcommand: this.#EveHomeGetcommand.bind(this),
      });
    }
  }

  updateDevice(deviceData) {
    if (typeof deviceData !== 'object' || this.outletService === undefined || this.batteryService === undefined) {
      return;
    }

    // Update energy flows
    this.outletService.updateCharacteristic(
      this.hap.Characteristic.On,
      deviceData.powerflow.PV.currentPower !== 0 || deviceData.powerflow.PV.status.toUpperCase() === 'ACTIVE' ? true : false,
    );
    this.outletService.updateCharacteristic(
      this.hap.Characteristic.OutletInUse,
      deviceData.powerflow.PV.currentPower !== 0 || deviceData.powerflow.PV.status.toUpperCase() === 'ACTIVE' ? true : false,
    );

    // Update battery level and status
    let batteryLevel = scaleValue(deviceData.powerflow.PV.currentPower, 0, deviceData.peakPower, 0, 100);
    this.batteryService.updateCharacteristic(this.hap.Characteristic.BatteryLevel, batteryLevel);
    this.batteryService.updateCharacteristic(this.hap.Characteristic.ChargingState, this.hap.Characteristic.ChargingState.NOT_CHARGING); // By default, not sending power to grid. gets updated below
    deviceData.powerflow.connections &&
      deviceData.powerflow.connections.forEach((flow) => {
        // Work out how the power is flowing
        if (flow.from.toUpperCase() === 'LOAD' && flow.to.toUpperCase() === 'GRID') {
          // We're exporting power to the grid
          this.batteryService.updateCharacteristic(this.hap.Characteristic.ChargingState, this.hap.Characteristic.ChargingState.CHARGING);
          this.batteryService.updateCharacteristic(
            this.hap.Characteristic.StatusLowBattery,
            this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
          );
        }
        if (flow.from.toUpperCase() === 'GRID' && flow.to.toUpperCase() === 'LOAD') {
          // We're importing power from the grid
          this.batteryService.updateCharacteristic(
            this.hap.Characteristic.ChargingState,
            this.hap.Characteristic.ChargingState.NOT_CHARGING,
          );
          this.batteryService.updateCharacteristic(
            this.hap.Characteristic.StatusLowBattery,
            this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW,
          );
        }
      });

    // Solar generation in watts as a LUX reading
    this.lightService.updateCharacteristic(
      this.hap.Characteristic.CurrentAmbientLightLevel,
      deviceData.powerflow.PV.currentPower < 0.0001 ? 0.0001 : deviceData.powerflow.PV.currentPower,
    );

    // If we have the history service running and power output has changed to previous in past 2mins
    if (this.outletService !== undefined && typeof this.historyService?.addHistory === 'function') {
      this.historyService.addHistory(
        this.outletService,
        {
          time: Math.floor(Date.now() / 1000),
          status: (deviceData.powerflow.PV.currentPower !== 0 || deviceData.powerflow.PV.status.toUpperCase() === 'ACTIVE' ? true : false)
            ? 1
            : 0,
          volts: 0,
          watts: deviceData.powerflow.PV.currentPower,
          amps: 0,
        },
        120,
      );
    }

    // Notify Eve App of device status changes if linked
    if (
      this.deviceData.eveHistory === true &&
      this.outletService !== undefined &&
      typeof this.historyService?.updateEveHome === 'function'
    ) {
      // Update our internal data with properties Eve will need to process
      this.deviceData.powerflow.PV.currentPower = deviceData.powerflow.PV.currentPower;
      this.historyService.updateEveHome(this.outletService, this.#EveHomeGetcommand.bind(this));
    }
  }

  #EveHomeGetcommand(EveHomeGetData) {
    // Pass back extra data for Eve Energy onGet() to process command
    // Data will already be an object, our only job is to add/modify it
    if (typeof EveHomeGetData === 'object') {
      EveHomeGetData.volts = 0;
      EveHomeGetData.watts = this.deviceData.powerflow.PV.currentPower;
      EveHomeGetData.amps = 0;
    }

    return EveHomeGetData;
  }
}

// SolarEdge class
const SUBSCRIBEINTERVAL = 1000 * 60 * 10; // every 10minutes

class SolarEdgeAccfactory {
  cachedAccessories = []; // Track restored cached accessories

  // Internal data only for this class
  #connections = {}; // Object of confirmed connections
  #rawData = {}; // Cached copy of data from Rest API
  #eventEmitter = new EventEmitter(); // Used for object messaging from this platform
  #trackedDevices = {}; // Object of devices we've created. used to track comms uuid. key'd by serial #

  constructor(log, config, api) {
    this.config = config;
    this.log = log;
    this.api = api;

    // Perform validation on the configuration passed into us and set defaults if not present
    if (config?.solaredge?.apiKey === undefined || config.solaredge.apiKey === '') {
      this?.log?.error?.('Required SolarEdge API Key is missing from JSON configuration. Please review');
      return;
    }

    // Valid connection object
    this.#connections[crypto.randomUUID()] = {
      authorised: false,
      apiKey: config.solaredge.apiKey,
    };

    this.config.options.eveHistory = typeof this.config.options?.eveHistory === 'boolean' ? this.config.options.eveHistory : true;

    this?.api?.on?.('didFinishLaunching', async () => {
      // We got notified that Homebridge has finished loading, so we are ready to process
      // Start reconnect loop per connection with backoff for failed tries
      for (const uuid of Object.keys(this.#connections)) {
        let reconnectDelay = 15000;

        const reconnectLoop = async () => {
          if (this.#connections?.[uuid]?.authorised === false) {
            try {
              await this.#connect(uuid);
              this.#subscribeREST(uuid);
              // eslint-disable-next-line no-unused-vars
            } catch (error) {
              // Empty
            }

            reconnectDelay = this.#connections?.[uuid]?.authorised === true ? 15000 : Math.min(reconnectDelay * 2, 60000);
          } else {
            reconnectDelay = 15000;
          }

          setTimeout(reconnectLoop, reconnectDelay);
        };

        reconnectLoop();
      }
    });

    this?.api?.on?.('shutdown', async () => {
      // We got notified that Homebridge is shutting down
      // Perform cleanup of internal state
      this.#eventEmitter?.removeAllListeners();

      Object.values(this.#trackedDevices).forEach((device) => {
        Object.values(device?.timers || {}).forEach((timer) => clearInterval(timer));
      });

      this.#trackedDevices = {};
      this.#rawData = {};
      this.#eventEmitter = undefined;
    });
  }

  configureAccessory(accessory) {
    // This gets called from HomeBridge each time it restores an accessory from its cache
    this?.log?.info?.('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache, so we can track if it has already been registered
    this.cachedAccessories.push(accessory);
  }

  async #connect(uuid) {
    if (typeof this.#connections?.[uuid] === 'object') {
      this?.log?.info?.('Performing authorisation to SolarEdge Monitoring API');

      try {
        let response = await fetchWrapper(
          'get',
          'https://monitoringapi.solaredge.com/sites/list?sortProperty=name&sortOrder=ASC&api_key=' + this.#connections[uuid].apiKey,
          {},
        );
        await response.json();

        this.#connections[uuid].authorised = true;

        this?.log?.success?.('Successfully authorised to SolarEdge Monitoring API');
      } catch (error) {
        this.#connections[uuid].authorised = false;

        this?.log?.error?.(
          'Authorisation failed to SolarEdge Monitoring API. A periodic retry event will be triggered',
          String(error?.cause),
        );
      }
    }
  }

  async #subscribeREST(uuid) {
    if (typeof this.#connections?.[uuid] !== 'object' || this.#connections?.[uuid]?.authorised !== true) {
      return;
    }

    try {
      let response = await fetchWrapper(
        'get',
        'https://monitoringapi.solaredge.com/sites/list?sortProperty=name&sortOrder=ASC&api_key=' + this.#connections[uuid].apiKey,
        {},
      );
      let data = await response.json();

      if (Array.isArray(data?.sites?.site) === true) {
        const FETCHURLS = ['/inventory.json', '/currentPowerFlow.json'];

        for (const site of data.sites.site) {
          let tempObject = {};

          await Promise.all(
            FETCHURLS.map(async (url) => {
              try {
                let response = await fetchWrapper(
                  'get',
                  'https://monitoringapi.solaredge.com/site/' + site.id + url + '?api_key=' + this.#connections[uuid].apiKey,
                  {
                    timeout: 30000,
                  },
                );
                tempObject[url] = await response.json();
              } catch (error) {
                if (String(error?.cause).toUpperCase().includes('TIMEOUT') === false && this?.log?.debug) {
                  this.log.debug('REST API had an error obtaining data from url "%s" for uuid "%s"', url, uuid);
                  this.log.debug('Error was "%s"', String(error?.cause));
                }
              }
            }),
          );

          if (Object.keys(tempObject).length === FETCHURLS.length) {
            this.#rawData[site.id] = {
              connection: uuid,
              site: site,
              inventory: tempObject['/inventory.json'].Inventory,
              powerflow: tempObject['/currentPowerFlow.json'].siteCurrentPowerFlow,
            };

            await this.#processPostSubscribe();
          }
        }
      }
    } catch {
      // Suppress site list fetch errors
    }

    setTimeout(() => this.#subscribeREST(uuid), SUBSCRIBEINTERVAL);
  }

  #processPostSubscribe() {
    Object.values(this.#processData('')).forEach((deviceData) => {
      if (this.#trackedDevices?.[deviceData?.serialNumber] === undefined && deviceData?.excluded === true) {
        // We haven't tracked this device before (ie: should be a new one) and but its excluded
        this?.log?.warn?.('Device "%s" is ignored due to it being marked as excluded', deviceData.description);

        // Track this device even though its excluded
        this.#trackedDevices[deviceData.serialNumber] = {
          uuid: HomeKitDevice.generateUUID(HomeKitDevice.PLUGIN_NAME, this.api, deviceData.serialNumber),
          timers: undefined,
          exclude: true,
        };

        // If the device is now marked as excluded and present in accessory cache
        // Then we'll unregister it from the Homebridge platform
        let accessory = this.cachedAccessories.find((accessory) => accessory?.UUID === this.#trackedDevices[deviceData.serialNumber].uuid);
        if (accessory !== undefined && typeof accessory === 'object') {
          this.api.unregisterPlatformAccessories(HomeKitDevice.PLUGIN_NAME, HomeKitDevice.PLATFORM_NAME, [accessory]);
        }
      }

      if (this.#trackedDevices?.[deviceData?.serialNumber] === undefined && deviceData?.excluded === false) {
        // SolarEdge Inverter - Categories.OUTLET = 7
        let tempDevice = new SolarInverter(this.cachedAccessories, this.api, this.log, this.#eventEmitter, deviceData);
        tempDevice.add('SolarEdge Invertor', 7, true);

        // Track this device once created
        this.#trackedDevices[deviceData.serialNumber] = {
          uuid: tempDevice.uuid,
          timers: undefined,
          exclude: false,
        };
      }

      // Finally, if device is not excluded, send updated data to device for it to process
      if (deviceData.excluded === false && this.#trackedDevices?.[deviceData?.serialNumber] !== undefined) {
        this.#trackedDevices?.[deviceData?.serialNumber]?.uuid &&
          this.#eventEmitter?.emit?.(this.#trackedDevices[deviceData.serialNumber].uuid, HomeKitDevice.UPDATE, deviceData);
      }
    });
  }

  #processData(deviceUUID) {
    if (typeof deviceUUID !== 'string') {
      deviceUUID = '';
    }

    let devices = {};

    Object.values(this.#rawData).forEach((data) => {
      // eslint-disable-next-line no-undef
      let powerflow = structuredClone(data.powerflow);
      let unitMultiplier = 1000;

      if (typeof powerflow?.unit === 'string') {
        let unit = powerflow.unit.toUpperCase();
        if (unit === 'MW') {
          unitMultiplier = 1000000;
        } else if (unit === 'W') {
          unitMultiplier = 1;
        }
      }

      ['GRID', 'PV', 'LOAD'].forEach((key) => {
        if (powerflow?.[key]?.currentPower !== undefined) {
          powerflow[key].currentPower *= unitMultiplier;
        }
      });

      Array.isArray(data?.inventory?.inverters) === true &&
        data.inventory.inverters.forEach((inverter) => {
          let serial = inverter.SN.toUpperCase();
          let location = typeof data?.site?.location?.city === 'string' ? data.site.location.city : '';
          let description = inverter.name;
          if (description === '') {
            description = location;
          }

          devices[serial] = {
            excluded: false,
            serialNumber: serial,
            softwareVersion: inverter.cpuVersion.replace(/-/g, '.'),
            model: inverter.model,
            manufacturer: inverter.manufacturer,
            siteid: data.site.id,
            installationDate: data.site.installationDate,
            description: HomeKitDevice.makeHomeKitName(location === '' ? description : description + ' - ' + location),
            peakPower: data.site.peakPower * unitMultiplier,
            powerflow: powerflow,
            online: true,
            eveHistory: this.config.options.eveHistory === true || this.config?.devices?.[serial]?.eveHistory === true,
          };
        });
    });

    return devices;
  }
}

// General helper functions which don't need to be part of an object class
function scaleValue(value, sourceMin, sourceMax, targetMin, targetMax) {
  if (sourceMax === sourceMin) {
    return targetMin;
  }

  value = Math.max(sourceMin, Math.min(sourceMax, value));

  return ((value - sourceMin) * (targetMax - targetMin)) / (sourceMax - sourceMin) + targetMin;
}

async function fetchWrapper(method, url, options, data) {
  if ((method !== 'get' && method !== 'post') || typeof url !== 'string' || url === '' || typeof options !== 'object') {
    return;
  }

  if (isNaN(options?.timeout) === false && Number(options.timeout) > 0) {
    // eslint-disable-next-line no-undef
    options.signal = AbortSignal.timeout(Number(options.timeout));
  }

  if (isNaN(options.retry) === true || options.retry < 1) {
    options.retry = 1;
  }

  if (isNaN(options._retryCount) === true) {
    options._retryCount = 0;
  }

  options.method = method;

  if (method === 'post' && data !== undefined) {
    options.body = data;
  }

  let response;
  try {
    // eslint-disable-next-line no-undef
    response = await fetch(url, options);
  } catch (error) {
    if (options.retry > 1) {
      options.retry--;
      options._retryCount++;

      const delay = 500 * 2 ** (options._retryCount - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));

      return fetchWrapper(method, url, options, data);
    }

    error.message = `Fetch failed for ${method.toUpperCase()} ${url} after ${options._retryCount + 1} attempt(s): ${error.message}`;
    throw error;
  }

  if (response?.ok === false) {
    if (options.retry > 1) {
      options.retry--;
      options._retryCount++;

      let delay = 500 * 2 ** (options._retryCount - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));

      return fetchWrapper(method, url, options, data);
    }

    let error = new Error(`HTTP ${response.status} on ${method.toUpperCase()} ${url}: ${response.statusText || 'Unknown error'}`);
    error.code = response.status;
    throw error;
  }

  return response;
}

// Startup code
export default (api) => {
  // Register our platform with HomeBridge
  api.registerPlatform(HomeKitDevice.PLATFORM_NAME, SolarEdgeAccfactory);
};
