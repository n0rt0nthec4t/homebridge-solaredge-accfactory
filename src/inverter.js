// HomeKit Solar Inverter
// Part of homebridge-solaredge-accfactory
//
// Presents site generation, grid direction, and Eve Energy history as one
// outlet accessory with hidden battery and light sensor services.
//
// Responsibilities:
// - Map SolarEdge power flow to HomeKit characteristics
// - Keep the outlet read-only while reporting live generation
// - Supply solar output to Eve Energy history
//
// Code version 2026.09.16
// Mark Hulskamp
'use strict';

// Import our modules
import HomeKitDevice from './HomeKitDevice.js';
import { scaleValue } from './utils.js';

export default class SolarInverter extends HomeKitDevice {
  static TYPE = 'SolarInverter';
  static VERSION = '2026.09.16';

  batteryService = undefined;
  outletService = undefined;
  lightService = undefined;

  onAdd() {
    // The outlet is primary because its On state represents active solar generation.
    this.outletService = this.addService(this.hap.Service.Outlet, '', 1, { messages: this.message.bind(this) });
    this.outletService.setPrimaryService();

    this.addCharacteristic(this.outletService, this.hap.Characteristic.On, {
      initialValue: this.#isGenerating(this.deviceData),
      onSet: () => {
        // Reject manual changes and revert to current inverter state
        this.addTimer('outlet-reset', { delay: 100, reset: true }, () =>
          this.outletService?.updateCharacteristic(this.hap.Characteristic.On, this.#isGenerating(this.deviceData)),
        );
      },
    });

    this.addCharacteristic(this.outletService, this.hap.Characteristic.OutletInUse, {
      initialValue: this.#isGenerating(this.deviceData),
    });
    this.addCharacteristic(this.outletService, this.hap.Characteristic.StatusFault, {
      initialValue:
        this.deviceData.online === true ? this.hap.Characteristic.StatusFault.NO_FAULT : this.hap.Characteristic.StatusFault.GENERAL_FAULT,
    });

    // HomeKit's Battery service carries generation percentage and grid direction.
    this.batteryService = this.addService(this.hap.Service.Battery, '', 1);
    this.batteryService.setHiddenService(true);
    this.batteryService.getCharacteristic(this.hap.Characteristic.BatteryLevel).displayName = 'Solar Generation';
    this.batteryService.getCharacteristic(this.hap.Characteristic.ChargingState).displayName = 'Exporting';

    this.addCharacteristic(this.batteryService, this.hap.Characteristic.BatteryLevel, {
      initialValue: this.#batteryLevel(this.deviceData),
    });
    this.addCharacteristic(this.batteryService, this.hap.Characteristic.ChargingState, {
      initialValue: this.hap.Characteristic.ChargingState.NOT_CHARGING,
    });
    this.addCharacteristic(this.batteryService, this.hap.Characteristic.StatusLowBattery, {
      initialValue: this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    });

    // The light sensor exposes watts through a characteristic HomeKit apps can display.
    this.lightService = this.addService(this.hap.Service.LightSensor, '', 1);
    this.lightService.setHiddenService(true);

    this.addCharacteristic(this.lightService, this.hap.Characteristic.CurrentAmbientLightLevel, {
      initialValue: this.#solarLux(this.deviceData),
    });
    this.lightService.getCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel).displayName = 'Solar Generation';
  }

  onUpdate(deviceData) {
    // Initial setup may deliver data before all HomeKit services are available.
    if (
      deviceData === null ||
      typeof deviceData !== 'object' ||
      this.outletService === undefined ||
      this.batteryService === undefined ||
      this.lightService === undefined
    ) {
      return;
    }

    let connections = Array.isArray(deviceData.powerflow?.connections) === true ? deviceData.powerflow.connections : [];

    // Export follows power delivered to GRID; import follows GRID feeding LOAD.
    let exporting =
      connections.some(
        (flow) => flow?.to?.toUpperCase?.() === 'GRID' && ['PV', 'LOAD', 'STORAGE'].includes(flow?.from?.toUpperCase?.()) === true,
      ) === true;
    let importing = connections.some((flow) => flow?.from?.toUpperCase?.() === 'GRID' && flow?.to?.toUpperCase?.() === 'LOAD') === true;

    // The outlet remains read-only; its state follows the latest PV data.
    this.outletService.updateCharacteristic(
      this.hap.Characteristic.StatusFault,
      deviceData.online === true ? this.hap.Characteristic.StatusFault.NO_FAULT : this.hap.Characteristic.StatusFault.GENERAL_FAULT,
    );
    this.outletService.updateCharacteristic(this.hap.Characteristic.On, this.#isGenerating(deviceData));
    this.outletService.updateCharacteristic(this.hap.Characteristic.OutletInUse, this.#isGenerating(deviceData));

    this.batteryService.updateCharacteristic(this.hap.Characteristic.BatteryLevel, this.#batteryLevel(deviceData));
    this.batteryService.updateCharacteristic(
      this.hap.Characteristic.ChargingState,
      exporting === true ? this.hap.Characteristic.ChargingState.CHARGING : this.hap.Characteristic.ChargingState.NOT_CHARGING,
    );
    this.batteryService.updateCharacteristic(
      this.hap.Characteristic.StatusLowBattery,
      importing === true
        ? this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );

    this.lightService.updateCharacteristic(this.hap.Characteristic.CurrentAmbientLightLevel, this.#solarLux(deviceData));

    // Eve Energy records successful readings with a two-minute minimum gap.
    if (deviceData.online === true) {
      this.history(
        this.outletService,
        {
          time: Math.floor(Date.now() / 1000),
          status: this.#isGenerating(deviceData) === true ? 1 : 0,
          volts: this.#electricalValue(deviceData, 'volts'),
          watts: this.#currentPower(deviceData, 'PV'),
          amps: this.#electricalValue(deviceData, 'amps'),
        },
        {
          timegap: 120,
        },
      );
    }

    // Eve queries the stored snapshot after HomeKit characteristics have updated.
    this.deviceData = deviceData;
    this.historyService?.updateEveHome?.(this.outletService);
  }

  onMessage(type, message) {
    if (typeof type !== 'string' || type === '' || message === null || typeof message !== 'object' || message?.constructor !== Object) {
      return;
    }

    if (type === HomeKitDevice?.EVEHOME?.GET) {
      // Eve Energy requests current output when reading its history service.
      message.volts = this.#electricalValue(this.deviceData, 'volts');
      message.watts = this.#currentPower(this.deviceData, 'PV');
      message.amps = this.#electricalValue(this.deviceData, 'amps');

      return message;
    }
  }

  #currentPower(deviceData, key) {
    // Missing or invalid flow power is displayed as zero rather than NaN.
    if (typeof key !== 'string' || key === '') {
      return 0;
    }

    if (
      deviceData?.powerflow?.[key]?.currentPower !== null &&
      Number.isFinite(Number(deviceData?.powerflow?.[key]?.currentPower)) === true
    ) {
      return Number(deviceData.powerflow[key].currentPower);
    }

    return 0;
  }

  #electricalValue(deviceData, key) {
    // Eve accepts one non-negative value for each electrical measurement.
    let value = Number(deviceData?.electrical?.[key]);

    return Number.isFinite(value) === true && value >= 0 ? value : 0;
  }

  #isGenerating(deviceData) {
    // SolarEdge can report Active before the measured PV power becomes positive.
    if (this.#currentPower(deviceData, 'PV') > 0) {
      return true;
    }

    if (typeof deviceData?.powerflow?.PV?.status === 'string' && deviceData.powerflow.PV.status.toUpperCase() === 'ACTIVE') {
      return true;
    }

    return false;
  }

  #batteryLevel(deviceData) {
    // The hidden battery characteristic represents output relative to site peak power.
    return Math.round(scaleValue(this.#currentPower(deviceData, 'PV'), 0, Number(deviceData?.peakPower), 0, 100) ?? 0);
  }

  #solarLux(deviceData) {
    // HomeKit light levels cannot be zero, so idle output uses its minimum value.
    return this.#currentPower(deviceData, 'PV') < 0.0001 ? 0.0001 : this.#currentPower(deviceData, 'PV');
  }
}
