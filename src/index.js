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
// Code version 18/10/2024
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import EventEmitter from 'node:events';
import { setInterval, clearInterval, setTimeout } from 'node:timers';
import crypto from 'node:crypto';

// Import our modules
import HomeKitDevice from './HomeKitDevice.js';
HomeKitDevice.PLUGIN_NAME = 'homebridge-solaredge-accfactory';
HomeKitDevice.PLATFORM_NAME = 'SolarEdgeAccfactory';

import HomeKitHistory from './HomeKitHistory.js';
HomeKitDevice.HISTORY = HomeKitHistory;

// Solar Inverter class
class SolarInverter extends HomeKitDevice {
  batteryService = undefined;
  outletService = undefined;

  constructor(accessory, api, log, eventEmitter, deviceData) {
    super(accessory, api, log, eventEmitter, deviceData);
  }

  // Class functions
  addServices() {
    // Setup the outlet service if not already present on the accessory
    this.outletService = this.accessory.getService(this.hap.Service.Outlet);
    if (this.outletService === undefined) {
      this.outletService = this.accessory.addService(this.hap.Service.Outlet, '', 1);
    }
    if (this.outletService.testCharacteristic(this.hap.Characteristic.StatusFault) === false) {
      this.outletService.addCharacteristic(this.hap.Characteristic.StatusFault);
    }
    if (this.outletService.testCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel) === false) {
      this.outletService.addCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel);
    }
    this.outletService.setPrimaryService();

    // Setup the battery service if not already present on the accessory
    this.batteryService = this.accessory.getService(this.hap.Service.Battery);
    if (this.batteryService === undefined) {
      this.batteryService = this.accessory.addService(this.hap.Service.Battery, '', 1);
    }
    this.batteryService.setHiddenService(true);

    // Below doesnt appear to change anything in HomeKit, but we'll do it anyway. maybe for future
    this.outletService.getCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel).displayName = 'Solar Generation';
    this.batteryService.getCharacteristic(this.hap.Characteristic.BatteryLevel).displayName = 'Solar Generation';
    this.batteryService.getCharacteristic(this.hap.Characteristic.ChargingState).displayName = 'Exporting';

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

  updateServices(deviceData) {
    if (typeof deviceData !== 'object' || this.outletService === undefined || this.batteryService === undefined) {
      return;
    }

    // If device isn't online report in HomeKit
    this.outletService.updateCharacteristic(
      this.hap.Characteristic.StatusFault,
      deviceData.online === true ? this.hap.Characteristic.StatusFault.NO_FAULT : this.hap.Characteristic.StatusFault.GENERAL_FAULT,
    );

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
    this.outletService.updateCharacteristic(
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
  #connectionTimer = undefined;
  #trackedDevices = {}; // Object of devices we've created. used to track comms uuid. key'd by serial #

  constructor(log, config, api) {
    this.config = config;
    this.log = log;
    this.api = api;

    // Perform validation on the configuration passed into us and set defaults if not present
    if (config?.solaredge?.apiKey === undefined || config.solaredge.apiKey === '') {
      this?.log?.error && this.log.error('Required SolarEdge API Key is missing from JSON configuration. Please review');
      return;
    }

    // Valid connection object
    this.#connections[crypto.randomUUID()] = {
      authorised: false,
      retry: true,
      apiKey: config.solaredge.apiKey,
    };

    this.config.options.eveHistory = typeof this.config.options?.eveHistory === 'boolean' ? this.config.options.eveHistory : true;

    if (this.api instanceof EventEmitter === true) {
      this.api.on('didFinishLaunching', async () => {
        // We got notified that Homebridge has finished loading, so we are ready to process
        this.discoverDevices();

        // We'll check connection status every 15 seconds. We'll also handle token expiry/refresh this way
        clearInterval(this.#connectionTimer);
        this.#connectionTimer = setInterval(this.discoverDevices.bind(this), 15000);
      });

      this.api.on('shutdown', async () => {
        // We got notified that Homebridge is shutting down
        // Perform cleanup some internal cleaning up
        clearInterval(this.#connectionTimer);
        this.#eventEmitter.removeAllListeners();
        this.#rawData = {};
        this.#eventEmitter = undefined;
        this.#connectionTimer = undefined;
      });
    }
  }

  configureAccessory(accessory) {
    // This gets called from HomeBridge each time it restores an accessory from its cache
    this?.log?.info && this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache, so we can track if it has already been registered
    this.cachedAccessories.push(accessory);
  }

  async discoverDevices() {
    Object.keys(this.#connections).forEach((uuid) => {
      if (this.#connections[uuid]?.authorised === false && this.#connections[uuid]?.retry === true) {
        this.#connect(uuid).then(() => {
          if (this.#connections[uuid].authorised === true) {
            this.#subscribeREST(uuid);
          }
        });
      }
    });
  }

  async #connect(connectionUUID) {
    if (typeof this.#connections?.[connectionUUID] === 'object') {
      this?.log?.info && this.log.info('Performing authorisation to SolarEdge Monitoring API');
      await fetchWrapper(
        'get',
        'https://monitoringapi.solaredge.com/sites/list?sortProperty=name&sortOrder=ASC&api_key=' +
          this.#connections[connectionUUID].apiKey,
        {},
      )
        .then((response) => response.json())
        // eslint-disable-next-line no-unused-vars
        .then((data) => {
          this.#connections[connectionUUID].authorised = true;

          this?.log?.success && this.log.success('Successfully authorised to SolarEdge Monitoring API');
        })
        // eslint-disable-next-line no-unused-vars
        .catch((error) => {
          this.#connections[connectionUUID].authorised = false;

          this?.log?.error &&
            this.log.error(
              'Authorisation failed to SolarEdge Monitoring API. A periodic retry event will be triggered',
              this.#connections[connectionUUID].gateway,
            );
          this.#connections[connectionUUID].retry = true;
          return;
        });
    }
  }

  async #subscribeREST(connectionUUID) {
    if (typeof this.#connections?.[connectionUUID] !== 'object' || this.#connections?.[connectionUUID]?.authorised !== true) {
      // Not a valid connection object and/or we're not authorised
      return;
    }

    await fetchWrapper(
      'get',
      'https://monitoringapi.solaredge.com/sites/list?sortProperty=name&sortOrder=ASC&api_key=' + this.#connections[connectionUUID].apiKey,
      {},
    )
      .then((response) => response.json())
      .then(async (data) => {
        if (Array.isArray(data?.sites?.site) === true) {
          const FETCHURLS = ['/inventory.json', '/currentPowerFlow.json'];
          data.sites.site.forEach(async (site) => {
            let tempObject = [];
            await Promise.all(
              FETCHURLS.map(async (url) => {
                await fetchWrapper(
                  'get',
                  'https://monitoringapi.solaredge.com/site/' + site.id + url + '?api_key=' + this.#connections[connectionUUID].apiKey,
                  {
                    timeout: 30000,
                  },
                )
                  .then((response) => response.json())
                  .then((data) => {
                    tempObject[url] = data;
                  })
                  .catch((error) => {
                    if (
                      error?.cause !== undefined &&
                      JSON.stringify(error.cause).toUpperCase().includes('TIMEOUT') === false &&
                      this?.log?.debug
                    ) {
                      this.log.debug('REST API had an error obtaining data from url "%s" for uuid "%s"', url, connectionUUID);
                      this.log.debug('Error was "%s"', error);
                    }
                  });
              }),
            );

            if (Object.keys(tempObject).length === FETCHURLS.length) {
              // We got all the data required, so now can process what we retrieved
              this.#rawData[site.id] = {
                connection: connectionUUID,
                site: site,
                inventory: tempObject['/inventory.json'].Inventory,
                powerflow: tempObject['/currentPowerFlow.json'].siteCurrentPowerFlow,
              };

              await this.#processPostSubscribe();
            }
          });
        }
      });

    // redo data gathering again after specified timeout
    setTimeout(this.#subscribeREST.bind(this, connectionUUID), SUBSCRIBEINTERVAL);
  }

  #processPostSubscribe() {
    Object.values(this.#processData('')).forEach((deviceData) => {
      if (this.#trackedDevices?.[deviceData?.serialNumber] === undefined && deviceData?.excluded === true) {
        // We haven't tracked this device before (ie: should be a new one) and but its excluded
        this?.log?.warn && this.log.warn('Device "%s" is ignored due to it being marked as excluded', deviceData.description);
      }
      if (this.#trackedDevices?.[deviceData?.serialNumber] === undefined && deviceData?.excluded === false) {
        // SolarEdge Inverter - Categories.OUTLET = 7
        let tempDevice = new SolarInverter(this.cachedAccessories, this.api, this.log, this.#eventEmitter, deviceData);
        tempDevice.add('SolarEdge Invertor', 7, true);

        // Track this device once created
        this.#trackedDevices[deviceData.serialNumber] = {
          uuid: tempDevice.uuid,
        };
      }

      // Finally, if device is not excluded, send updated data to device for it to process
      if (deviceData.excluded === false && this.#trackedDevices?.[deviceData?.serialNumber] !== undefined) {
        this.#eventEmitter.emit(this.#trackedDevices[deviceData.serialNumber].uuid, HomeKitDevice.UPDATE, deviceData);
      }
    });
  }

  #processData(deviceUUID) {
    if (typeof deviceUUID !== 'string') {
      deviceUUID = '';
    }
    let devices = {};

    Object.values(this.#rawData).forEach((data) => {
      // process raw device data
      Object.values(data.inventory.inverters).forEach((inverter) => {
        var tempDevice = {};
        tempDevice.excluded = false;
        tempDevice.serialNumber = inverter.SN.toUpperCase();
        tempDevice.softwareVersion = inverter.cpuVersion.replace(/-/g, '.');
        tempDevice.model = inverter.model;
        tempDevice.manufacturer = inverter.manufacturer;
        tempDevice.siteid = data.site.id;
        tempDevice.installationDate = data.site.installationDate;

        let description = inverter.name;
        let location = typeof data?.site?.location?.city === 'string' ? data.site.location.city : '';
        if (description === '') {
          description = location;
          location = '';
        }
        tempDevice.description = makeHomeKitName(location === '' ? description : description + ' - ' + location);

        // Fix up power values
        var unitMultplier = 1000; // Default is kW or 1000W
        if (data.powerflow.unit.toUpperCase() === 'KW') {
          unitMultplier = 1000;
        } // kW
        if (data.powerflow.unit.toUpperCase() === 'MW') {
          unitMultplier = 1000000;
        } // mW
        if (data.powerflow.unit.toUpperCase() === 'W') {
          unitMultplier = 1;
        } // W
        if (data.powerflow.GRID.hasOwnProperty('currentPower') === true) {
          data.powerflow.GRID.currentPower = data.powerflow.GRID.currentPower * unitMultplier;
        }
        if (data.powerflow.PV.hasOwnProperty('currentPower') === true) {
          data.powerflow.PV.currentPower = data.powerflow.PV.currentPower * unitMultplier;
        }
        if (data.powerflow.LOAD.hasOwnProperty('currentPower') === true) {
          data.powerflow.LOAD.currentPower = data.powerflow.LOAD.currentPower * unitMultplier;
        }
        tempDevice.peakPower = data.site.peakPower * unitMultplier;
        tempDevice.powerflow = data.powerflow;
        tempDevice.online = true;   // Can we work this out???

        tempDevice.eveHistory =
          this.config.options.eveHistory === true || this.config?.devices?.[tempDevice.serialNumber]?.eveHistory === true;

        devices[tempDevice.serialNumber] = tempDevice; // Store processed device
      });
    });

    return devices;
  }
}

// General helper functions which don't need to be part of an object class
function makeHomeKitName(nameToMakeValid) {
  // Strip invalid characters to meet HomeKit naming requirements
  // Ensure only letters or numbers are at the beginning AND/OR end of string
  // Matches against uni-code characters
  return typeof nameToMakeValid === 'string'
    ? nameToMakeValid
        .replace(/[^\p{L}\p{N}\p{Z}\u2019.,-]/gu, '')
        .replace(/^[^\p{L}\p{N}]*/gu, '')
        .replace(/[^\p{L}\p{N}]+$/gu, '')
    : nameToMakeValid;
}

function scaleValue(value, sourceRangeMin, sourceRangeMax, targetRangeMin, targetRangeMax) {
  if (value < sourceRangeMin) {
    value = sourceRangeMin;
  }
  if (value > sourceRangeMax) {
    value = sourceRangeMax;
  }
  return ((value - sourceRangeMin) * (targetRangeMax - targetRangeMin)) / (sourceRangeMax - sourceRangeMin) + targetRangeMin;
}

async function fetchWrapper(method, url, options, data, response) {
  if ((method !== 'get' && method !== 'post') || typeof url !== 'string' || url === '' || typeof options !== 'object') {
    return;
  }

  if (isNaN(options?.timeout) === false && Number(options?.timeout) > 0) {
    // If a timeout is specified in the options, setup here
    // eslint-disable-next-line no-undef
    options.signal = AbortSignal.timeout(Number(options.timeout));
  }

  if (options?.retry === undefined) {
    // If not retry option specifed , we'll do just once
    options.retry = 1;
  }

  options.method = method; // Set the HTTP method to use

  if (method === 'post' && typeof data !== undefined) {
    // Doing a HTTP post, so include the data in the body
    options.body = data;
  }

  if (options.retry > 0) {
    // eslint-disable-next-line no-undef
    response = await fetch(url, options);
    if (response.ok === false && options.retry > 1) {
      options.retry--; // One less retry to go

      // Try again after short delay (500ms)
      // We pass back in this response also for when we reach zero retries and still not successful
      await new Promise((resolve) => setTimeout(resolve, 500));
      // eslint-disable-next-line no-undef
      response = await fetchWrapper(method, url, options, data, structuredClone(response));
    }
    if (response.ok === false && options.retry === 0) {
      let error = new Error(response.statusText);
      error.code = response.status;
      throw error;
    }
  }

  return response;
}

// Startup code
export default (api) => {
  // Register our platform with HomeBridge
  api.registerPlatform(HomeKitDevice.PLATFORM_NAME, SolarEdgeAccfactory);
};
