// Plugin Entry Point
// Part of homebridge-solaredge-accfactory
//
// Registers the SolarEdge dynamic platform and sets shared accessory metadata.
//
// Responsibilities:
// - Validate the Homebridge API object
// - Configure shared plugin and platform identifiers
// - Enable Eve history support
// - Register the platform implementation from system.js
//
// Code version 2026.09.16
// Mark Hulskamp
'use strict';

// Import our modules
import SolarEdgeAccfactory from './system.js';
import HomeKitDevice from './HomeKitDevice.js';
import HomeKitHistory from './HomeKitHistory.js';
HomeKitDevice.PLUGIN_NAME = 'homebridge-solaredge-accfactory';
HomeKitDevice.PLATFORM_NAME = 'SolarEdgeAccfactory';
HomeKitDevice.EVEHOME = HomeKitHistory;
// HomeKitDevice.LOGGER will be set by the system class constructor

export default (api) => {
  // Validate Homebridge API object
  if (typeof api?.registerPlatform !== 'function') {
    throw new Error('SolarEdgeAccfactory: Invalid Homebridge API object - registerPlatform method not found');
  }

  // Register our platform with Homebridge
  api.registerPlatform(HomeKitDevice.PLATFORM_NAME, SolarEdgeAccfactory);
};
