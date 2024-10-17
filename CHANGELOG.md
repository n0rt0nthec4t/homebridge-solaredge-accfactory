# Change Log

All notable changes to `homebridge-teslapowerwall-accfactory` will be documented in this file. This project tries to adhere to [Semantic Versioning](http://semver.org/).

## Known issues

- Entered passwords for gateway(s) are stored in plain text in configuration JSON.

## v0.0.5 (2024/10/12) 

- Safer way to handle that the Tesla uses. No longer set NODE_TLS_REJECT_UNAUTHORIZED to 0 in the process that starts the code

## v0.0.4 (2024/10/10)

- Added plugin configuration via Homebridge-config-ui GUI

## v0.0.2 (2024/10/08)

- Fix for devices not updating

## v0.0.1 (2024/10/07)

- Initial version from my internal home project, TelsaPowerwall_accfactory