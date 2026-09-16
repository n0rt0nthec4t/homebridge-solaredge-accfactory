# Change Log

All notable changes to `homebridge-solaredge-accfactory` are documented in this file.
This project adheres to [Semantic Versioning](http://semver.org/).

### Known Issues

- The API key is stored in plain text in the Homebridge configuration.
- The plugin uses version 1 of the SolarEdge Monitoring API.
- SolarEdge storage batteries are not published as separate accessories.

## v0.0.6 (2026/09/16)

### Improvements

- Split configuration, Monitoring API requests, accessory behavior, and platform lifecycle into focused modules.
- Restore shared `scaleValue()` and `fetchWrapper()` utilities and use them from the inverter and Monitoring API client.
- Use HomeKitDevice's managed timer for delayed outlet-state restoration.
- Honor global and per inverter Eve history settings when adding accessories.
- Add Eve voltage and current from inverter telemetry while staying within the SolarEdge request budget.
- Read sites beyond the first 100 using Monitoring API pagination.

### Fixes

- Keep API keys out of request errors and stop polling cleanly during shutdown.
- Read the documented inverter `serialNumber` and detect PV to grid export.
- Mark failed site updates as faults without recording stale Eve history.
- Remove cached accessories only after a complete, successful inventory pass.

### Maintenance

- Standardise SolarEdge module headers and keep protocol and HomeKit comments beside the behavior they explain.
- Keep SolarEdge response normalisation and grid direction logic beside their callers.
- Validate inverter overrides in the Homebridge configuration schema.
- Rewrite the README around setup, exposed services, API behavior, and development.

### Testing

- Add tests for configuration, power-flow units and direction, API requests, pagination, telemetry, and inventory translation.

## v0.0.3 (2025/06/15)

- Minor code cleanup and device object simplification.

## v0.0.2 (2025/06/14)

- Internal code cleanup and structural improvements.
- Improved logging, error handling, and API handling.
- Moved solar generation value to a dedicated LightSensor service.

## v0.0.1 (alpha)

- Initial version from my internal home project, SolarEdge_accfactory.
