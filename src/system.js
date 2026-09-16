// SolarEdge Platform Lifecycle
// Part of homebridge-solaredge-accfactory
//
// Coordinates Monitoring API snapshots and HomeKitDevice-backed inverter
// accessories. SolarEdgeClient owns HTTP requests and translator owns data
// normalization so this class describes discovery, updates, and shutdown.
//
// Responsibilities:
// - Discover the sites and inverters available to one Monitoring API key
// - Refresh site power flow and create or update inverter accessories
// - Retry site-list failures and release platform and device timers on shutdown
//
// Code version 2026.09.16
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { clearTimeout, setTimeout } from 'node:timers';

// Import our modules
import HomeKitDevice from './HomeKitDevice.js';
import SolarInverter from './inverter.js';
import { translateSites } from './translator.js';
import { processConfig } from './config.js';
import { SolarEdgeClient } from './solarclient.js';

const POLL_INTERVAL = 10 * 60 * 1000;
const RETRY_DELAY = 15 * 1000;
const RETRY_DELAY_MAX = 60 * 1000;

export default class SolarEdgeAccfactory {
  cachedAccessories = [];

  #client;
  #inFlight;
  #pollTimer;
  #retryDelay = RETRY_DELAY;
  #shuttingDown = false;
  #siteInventory = new Map(); // Inventory is stable and does not need polling every ten minutes
  #sites; // Site discovery is cached so routine polls preserve the account request budget
  #telemetryCursor = new Map(); // Round-robin inverter index for each site's telemetry request
  #trackedDevices = new Map(); // Inverter instances keyed by SolarEdge serial number

  constructor(log, config, api, dependencies = {}) {
    // Homebridge supplies the first three arguments. A replaceable HTTP boundary
    // lets lifecycle tests run without a SolarEdge account.
    this.config = processConfig(config, log);
    this.log = log;
    this.api = api;
    HomeKitDevice.LOGGER = log;

    if (this.config.solaredge.apiKey === '') {
      return;
    }

    try {
      this.#client = new SolarEdgeClient(this.config.solaredge.apiKey, this.config.solaredge.baseUrl, dependencies.fetchRequest);
    } catch (error) {
      this.log?.error?.('Invalid SolarEdge API configuration: %s', error.message);
      return;
    }

    this.api?.on?.('didFinishLaunching', async () => {
      // Homebridge restores bridged accessories before this event.
      await this.#refreshSites();
    });

    this.api?.on?.('shutdown', async () => {
      // Stop scheduling new work and let the current API request finish before
      // clearing tracked devices. Each device shuts down its own timers.
      this.#shuttingDown = true;
      clearTimeout(this.#pollTimer);

      await this.#inFlight;
      await Promise.allSettled(
        [...this.#trackedDevices.values()].map((tracked) => tracked.device?.shutdown()).filter((shutdown) => shutdown !== undefined),
      );

      this.#trackedDevices.clear();
      this.#siteInventory.clear();
      this.#telemetryCursor.clear();
      this.#sites = undefined;
    });
  }

  configureAccessory(accessory) {
    // Homebridge calls this for bridged accessories restored from its cache.
    this.log?.info?.('Loading accessory from cache: %s', accessory.displayName);

    let informationService = accessory?.getService?.(this.api.hap.Service.AccessoryInformation);

    if (informationService === undefined) {
      // A cache entry without identity information cannot be restored safely.
      this.log?.warn?.('Cached accessory "%s" is missing AccessoryInformation service. Removing from cache', accessory.displayName);
      try {
        this.api.unregisterPlatformAccessories(HomeKitDevice.PLUGIN_NAME, HomeKitDevice.PLATFORM_NAME, [accessory]);
      } catch (error) {
        this.log?.debug?.('Unable to remove invalid cached accessory "%s": %s', accessory.displayName, error.message);
      }

      return;
    }

    this.cachedAccessories.push(accessory);
  }

  async #refreshSites() {
    // A single refresh promise prevents overlapping timer and startup requests.
    if (this.#shuttingDown === true || this.#client === undefined) {
      return;
    }

    if (this.#inFlight !== undefined) {
      return this.#inFlight;
    }

    this.#inFlight = this.#loadSites();
    let siteListLoaded;
    try {
      siteListLoaded = await this.#inFlight;
    } finally {
      this.#inFlight = undefined;
    }

    if (this.#shuttingDown === true) {
      return;
    }

    // A site-list failure retries quickly; individual site failures wait for
    // the next normal poll so healthy sites can continue updating.
    // Each site consumes one flow and one telemetry request. Spread accounts
    // with multiple sites across the same daily request budget.
    let delay = siteListLoaded === true ? POLL_INTERVAL * Math.max(this.#sites?.length ?? 1, 1) : this.#retryDelay;
    this.#retryDelay = siteListLoaded === true ? RETRY_DELAY : Math.min(this.#retryDelay * 2, RETRY_DELAY_MAX);
    this.#pollTimer = setTimeout(() => this.#refreshSites(), delay);
  }

  async #loadSites() {
    if (this.#sites === undefined) {
      try {
        // The site list also verifies that the key is authorized. Cache it so
        // recurring polls can spend the limited request budget on live data.
        this.#sites = await this.#client.listSites();
      } catch (error) {
        if (this.#shuttingDown === false) {
          this.log?.error?.('Unable to load SolarEdge sites: %s', error.message);
        }

        return false;
      }
    }

    let activeAccessoryUUIDs = new Set();
    let allSitesLoaded = true;

    for (let site of this.#sites) {
      if (this.#shuttingDown === true) {
        break;
      }

      if (site?.id === undefined) {
        allSitesLoaded = false;
        continue;
      }

      try {
        let inventory = this.#siteInventory.get(site.id);

        if (inventory === undefined) {
          let response = await this.#client.get('/site/' + site.id + '/inventory');
          inventory = response?.Inventory ?? response?.inventory ?? {};
          this.#siteInventory.set(site.id, inventory);
        }

        let powerflow = await this.#client.get('/site/' + site.id + '/currentPowerFlow');

        if (this.#shuttingDown === true) {
          break;
        }

        // Some Monitoring API responses use a differently cased root field.
        let snapshot = {
          site,
          inventory,
          powerflow: powerflow?.siteCurrentPowerFlow ?? powerflow?.SiteCurrentPowerFlow ?? powerflow?.currentPowerFlow ?? {},
          telemetry: {},
        };

        // One inverter telemetry request per site and poll keeps the plugin
        // below SolarEdge's 300 daily site-call limit. Multi-inverter sites
        // are sampled in rotation rather than all at once.
        let listed =
          Array.isArray(inventory?.inverters) === true
            ? inventory.inverters
            : inventory?.inverters?.constructor === Object
              ? [inventory.inverters]
              : [];

        if (listed.length !== 0) {
          let index = this.#telemetryCursor.get(site.id) ?? 0;
          let inverter = listed[index % listed.length];
          let serial = inverter?.serialNumber ?? inverter?.SN;

          this.#telemetryCursor.set(site.id, (index + 1) % listed.length);

          if (typeof serial === 'string' && serial.trim() !== '') {
            try {
              snapshot.telemetry[serial.trim().toUpperCase()] = await this.#client.getInverterTelemetry(
                site.id,
                serial,
                new Date(),
                site?.location?.timeZone,
              );
            } catch (error) {
              this.log?.debug?.('Unable to load telemetry for SolarEdge inverter "%s": %s', serial, error.message);
            }
          }
        }

        let siteAccessoryUUIDs = await this.#updateInverters(snapshot);

        for (let uuid of siteAccessoryUUIDs) {
          activeAccessoryUUIDs.add(uuid);
        }
      } catch (error) {
        if (this.#shuttingDown === true) {
          break;
        }

        allSitesLoaded = false;
        this.log?.debug?.('Unable to refresh SolarEdge site "%s": %s', site.id, error.message);

        // Keep the last power snapshot while marking its accessories offline.
        await Promise.allSettled(
          [...this.#trackedDevices.values()]
            .filter((tracked) => tracked.siteId === site.id && tracked.device !== undefined)
            .map((tracked) => HomeKitDevice.message(tracked.device.uuid, HomeKitDevice.UPDATE, { online: false })),
        );
      }
    }

    if (allSitesLoaded === true && this.#shuttingDown === false) {
      // A complete inventory pass is the only safe time to discard accessories
      // that SolarEdge no longer returns. Partial failures keep the cache intact.
      let staleAccessories = this.cachedAccessories.filter((accessory) => activeAccessoryUUIDs.has(accessory.UUID) === false);

      if (staleAccessories.length !== 0) {
        try {
          this.api.unregisterPlatformAccessories(HomeKitDevice.PLUGIN_NAME, HomeKitDevice.PLATFORM_NAME, staleAccessories);
          this.cachedAccessories = this.cachedAccessories.filter((accessory) => activeAccessoryUUIDs.has(accessory.UUID) === true);
        } catch (error) {
          this.log?.debug?.('Unable to remove stale SolarEdge accessories: %s', error.message);
        }
      }
    }

    return true;
  }

  async #updateInverters(snapshot) {
    // One site snapshot yields one accessory description for each inventoried
    // inverter. Its power flow is site-wide, so those inverters share the value.
    let devices = translateSites({ [snapshot.site.id]: snapshot }, this.config);
    let activeAccessoryUUIDs = new Set();

    for (let deviceData of Object.values(devices)) {
      if (this.#shuttingDown === true) {
        return activeAccessoryUUIDs;
      }

      let serial = deviceData.serialNumber;
      let tracked = this.#trackedDevices.get(serial);

      if (deviceData.excluded === true) {
        if (tracked?.excluded !== true) {
          this.log?.warn?.('Device "%s" is ignored due to it being marked as excluded', deviceData.description);

          if (tracked?.device !== undefined) {
            await tracked.device.remove();
          } else {
            // Remove an older bridged accessory when its serial is now excluded.
            let uuid = HomeKitDevice.generateUUID(HomeKitDevice.PLUGIN_NAME, this.api, serial);
            let cached = this.cachedAccessories.find((accessory) => accessory?.UUID === uuid);

            if (cached !== undefined) {
              this.api.unregisterPlatformAccessories(HomeKitDevice.PLUGIN_NAME, HomeKitDevice.PLATFORM_NAME, [cached]);
            }

            this.cachedAccessories = this.cachedAccessories.filter((accessory) => accessory?.UUID !== uuid);
          }

          this.#trackedDevices.set(serial, { excluded: true, siteId: snapshot.site.id });
        }

        continue;
      }

      let uuid = HomeKitDevice.generateUUID(HomeKitDevice.PLUGIN_NAME, this.api, serial);
      activeAccessoryUUIDs.add(uuid);

      if (tracked === undefined || tracked.excluded === true) {
        let device;
        try {
          device = new SolarInverter(this.cachedAccessories, this.api, deviceData);
          let added = await device.add({
            hapAccessoryName: 'SolarEdge Inverter',
            hapCategory: this.api.hap.Categories.OUTLET,
            enableHistory: deviceData.eveHistory,
          });

          if (added !== true) {
            await device.remove();
            this.log?.warn?.('Unable to add SolarEdge inverter "%s"', deviceData.description);
            continue;
          }
        } catch (error) {
          await device?.remove?.();
          this.log?.warn?.('Unable to add SolarEdge inverter "%s": %s', deviceData.description, error.message);
          continue;
        }

        tracked = { device, siteId: snapshot.site.id };
        this.#trackedDevices.set(serial, tracked);
      }

      // The device's update handler maps PV and grid flow to HomeKit services.
      if (tracked.device !== undefined) {
        tracked.siteId = snapshot.site.id;
        await HomeKitDevice.message(tracked.device.uuid, HomeKitDevice.UPDATE, deviceData);
      }
    }

    return activeAccessoryUUIDs;
  }
}
