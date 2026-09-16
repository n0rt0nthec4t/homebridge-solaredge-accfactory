<p align="center">
  <a href="https://homebridge.io"><img src="https://raw.githubusercontent.com/homebridge/branding/latest/logos/homebridge-color-round-stylized.png" height="140"></a>
</p>
<span align="center">

# SolarEdge Accfactory

![npm](https://img.shields.io/npm/v/homebridge-solaredge-accfactory/latest?label=npm%40latest&color=%234CAF50)

</span>

A dynamic Homebridge platform for solar inverters discovered through the [SolarEdge Monitoring API](https://knowledge-center.solaredge.com/sites/kc/files/se_monitoring_api.pdf).

## Features

- Automatic discovery of sites and inverters available to the configured API key
- HomeKit outlet state showing whether solar generation is active
- Solar output as a percentage of site peak power, plus grid export and import indicators
- Current solar output in watts, inverter AC voltage and current, and optional Eve Energy history
- Global and per-inverter Eve history settings, plus per-inverter exclusion
- Rate-aware polling with retry after Monitoring API failures
- Inverter accessories backed by the shared `HomeKitDevice` module

## SolarEdge setup

Obtain a SolarEdge Monitoring API key with access to your sites. The Homebridge host must be able to reach `monitoringapi.solaredge.com` over HTTPS. The plugin uses the cloud Monitoring API; it does not connect to each inverter on the local network.

Install the plugin through the Homebridge UI and add the `SolarEdgeAccfactory` platform. Enter the API key under SolarEdge. The plugin reads each site's inventory and publishes an accessory for every inverter with a serial number, unless that serial is excluded. These accessories are registered under the Homebridge bridge and appear in the Home app after the bridge is paired.

## Configuration

```json
{
  "platform": "SolarEdgeAccfactory",
  "name": "SolarEdgeAccfactory",
  "solaredge": {
    "apiKey": "YOUR_API_KEY"
  },
  "options": {
    "eveHistory": true
  },
  "devices": {
    "INVERTER_SERIAL_A": {
      "exclude": true
    },
    "INVERTER_SERIAL_B": {
      "eveHistory": false
    }
  }
}
```

The `devices` entries are optional and use uppercase inverter serial numbers from SolarEdge inventory. Per-inverter entries must currently be edited in `config.json`; the Homebridge UI form exposes the API key and global Eve history option.

### Platform options

| Option | Default | Description |
| --- | --- | --- |
| `solaredge.apiKey` | Required | Monitoring API key with access to the sites. |
| `options.eveHistory` | `true` | Record outlet power for Eve Energy history. |

### Inverter entries

| Field | Required | Description |
| --- | --- | --- |
| Serial-number key | Yes | Uppercase inverter serial number used to match a discovered inverter. |
| `exclude` | No | Prevent this inverter from being published. Defaults to `false`. |
| `eveHistory` | No | Override the platform Eve history setting for this inverter. |

The API key is stored in the Homebridge configuration, so keep `config.json` and its backups private.

## SolarEdge communication

The plugin reads the site list, each site's inverter inventory and current power flow, and inverter technical data through the Monitoring API. A single-site account is polled every ten minutes. For accounts with multiple sites, the interval increases in proportion to the site count so the requests remain within SolarEdge's account limit. Failed authorization is retried with backoff; a failed site request does not stop the remaining sites from updating. An existing accessory can retain its last reported values until a successful poll.

**The current power-flow endpoint reports site totals.** When a site has multiple inverters, each inverter accessory displays the same site solar output and grid flow. Do not add these readings together as though they were per-inverter production.

The outlet's `On` and `Outlet In Use` characteristics indicate active generation. It is read-only and cannot turn the inverter on or off. A hidden battery service uses Battery Level for solar output relative to the site's peak power, Charging State for grid export, and Status Low Battery for grid import. This service does not represent a physical SolarEdge battery. A hidden light sensor carries solar watts in its illuminance characteristic; that value is not a lux measurement. HomeKit requires a positive illuminance value, so zero output appears as `0.0001`.

Eve Energy history records outlet power when enabled. Eve Electrical Voltage is the inverter's AC phase voltage, averaged when the inverter reports multiple phases. Eve Electrical Current is the sum of the available AC phase currents. SolarEdge limits API keys and individual sites to 300 calls per day, so the plugin requests technical data for one inverter per site on each poll and rotates through the inverters at multi-inverter sites. Voltage and current can therefore update less often than site power on a multi-inverter site.

The plugin currently publishes inverter accessories only; SolarEdge storage batteries are not separate accessories.

## Development

The shared `HomeKitDevice` and `HomeKitHistory` modules are Git submodules. Clone with submodules, or initialise them after cloning:

```sh
git submodule update --init --recursive
npm install
npm run check
```

Requires Node.js 22, 24, or 26 and either Homebridge 1.11.4 or newer in the 1.x series, or Homebridge 2.4.0 or newer in the 2.x series.
