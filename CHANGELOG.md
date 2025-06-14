# Change Log

All notable changes to `homebridge-solaredge-accfactory` will be documented in this file. This project tries to adhere to [Semantic Versioning](http://semver.org/).

## Known issues

- API Key is stored in plain text in configuration JSON
- Currently uses v1 of the SolarEdge monitoring API
- Only SolarEdge configured inverters are added (Need todo batteries)

## v0.0.2 (2025/06/14)

- Internal code cleanup and structural improvements
- Improved logging, error handling, and API handling
- Moved solar generation value to a dedicated LightSensor service

## v0.0.1 (alpha)

- Initial version from my internal home project, SolarEdge_accfactory