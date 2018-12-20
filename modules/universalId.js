/**
 * This module adds Universal ID support to prebid.js
 */
import {ajax} from 'src/ajax';
import {config} from 'src/config';
import * as utils from 'src/utils';
import find from 'core-js/library/fn/array/find';
import { gdprDataHandler } from 'src/adaptermanager';

const events = require('../src/events');
const CONSTANTS = require('../src/constants.json');

/**
 * @callback getIdCallback
 * @param {Object} response - assumed to be a json object
 */

/**
 * @callback getId
 * @summary submodule interface for getId function
 * @param {Object} data
 * @param {Object} consentData
 * @param {number} syncDelay
 * @param {getIdCallback} callback - optional callback to execute on id retrieval
 */

/**
 * @callback decode
 * @summary submodule interface for decode function
 * @param {Object|string|number} idData
 * @returns {Object}
 */

/**
 * @typedef {Object} IdSubmodule
 * @property {string} configKey - property name within the config universal id object
 * @property {number} expires - cookie expires time
 * @property {decode} decode - decode a stored value for passing to bid requests
 * @property {getId} getId - performs action to obtain id and return a value in the callback's response argument
 */

/**
 * @typedef {Object} SubmoduleConfig - IdSubmodule config obj contained in the config 'usersync.universalIds' array
 * @property {Object} storage
 * @property {Object} value
 * @property {Object} params
 */

const STORAGE_TYPE_COOKIE = 'cookie';
const STORAGE_TYPE_LOCALSTORAGE = 'html5';

/**
 * data to be added to bid requests
 * @type {{addData: function, getData: function}}
 */
export const extendedBidRequestData = (function () {
  // @type {Object[]}
  const dataItems = [];
  return {
    addData: function (data) {
      // activate requestBids hook when adding first item, this prevents unnecessary processing
      if (dataItems.length === 0) {
        $$PREBID_GLOBAL$$.requestBids.addHook(requestBidHook);
      }
      dataItems.push(data);
    },
    getData: function () {
      return dataItems;
    }
  }
})();

/**
 * @type {IdSubmodule[]}
 */
const submodules = [{
  configKey: 'pubCommonId',
  decode: function(idData) {
    return { 'pubcid': idData }
  },
  getId: function(data, consentData, syncDelay, callback) {
    const responseObj = {
      data: utils.generateUUID(),
      expires: data.storage.expires || 60
    };
    callback(responseObj);
  }
}, {
  configKey: 'unifiedId',
  decode: function(idData) {
    try {
      return { 'tdid': idData };
    } catch (e) {
      utils.logError('Universal ID submodule decode error');
    }
  },
  getId: function(data, consentData, syncDelay, callback) {
    function callEndpoint() {
      // validate config values: params.partner and params.endpoint
      const partner = data.params.partner || 'prebid';
      const url = data.params.url || `http://match.adsrvr.org/track/rid?ttd_pid=${partner}&fmt=json`;

      utils.logInfo('Universal ID Module, call sync endpoint', url);

      ajax(url, response => {
        if (response) {
          try {
            const parsedResponse = (typeof response !== 'object') ? JSON.parse(response) : response;
            const responseObj = {
              data: parsedResponse.TDID,
              expires: parsedResponse.expires || data.storage.expires || 60
            };
            callback(responseObj);
          } catch (e) {}
        }
        callback();
      }, undefined, { method: 'GET' });
    }
    // if no sync delay call endpoint immediately, else start a timer after auction ends to call sync
    if (!syncDelay) {
      utils.logInfo('Universal ID Module, call endpoint to sync without delay');
      callEndpoint();
    } else {
      utils.logInfo('Universal ID Module, sync delay exists, set auction end event listener and call with timer');
      // wrap auction end event handler in function so that it can be removed
      const auctionEndHandler = function auctionEndHandler() {
        utils.logInfo('Universal ID Module, auction end event listener called, set timer for', syncDelay);
        // remove event handler immediately since we only need to listen for the first auction ending
        events.off(CONSTANTS.EVENTS.AUCTION_END, auctionEndHandler);
        setTimeout(callEndpoint, syncDelay);
      };
      events.on(CONSTANTS.EVENTS.AUCTION_END, auctionEndHandler);
    }
  }
}];

/**
 * @param {IdSubmodule} submodule
 * @param {SubmoduleConfig} submoduleConfig
 * @param {{data: string, expires: number}} response
 */
export function submoduleGetIdCallback(submodule, submoduleConfig, response) {
  if (response && typeof response === 'object') {
    const responseStr = (response.data && typeof response.data !== 'string') ? JSON.stringify(response.data) : response.data;
    if (submoduleConfig.storage.type === STORAGE_TYPE_COOKIE) {
      setCookie(submoduleConfig.storage.name, responseStr, response.expires);
    } else if (submoduleConfig.storage.type === STORAGE_TYPE_LOCALSTORAGE) {
      localStorage.setItem(submoduleConfig.storage.name, responseStr);
    } else {
      utils.logError('Universal ID Module: Invalid configuration storage type');
    }
    extendedBidRequestData.addData(submodule.decode(response.data));
  } else {
    utils.logError('Universal ID Module: Submodule getId callback returned empty or invalid response');
  }
}

/**
 * @param {Navigator} navigator - navigator passed for easier testing through dependency injection
 * @param {Document} document - document passed for easier testing through dependency injection
 * @returns {boolean}
 */
function browserSupportsCookie (navigator, document) {
  try {
    if (navigator.cookieEnabled === false) {
      return false;
    }
    document.cookie = 'prebid.cookieTest';
    return document.cookie.indexOf('prebid.cookieTest') !== -1;
  } catch (e) {
    return false;
  }
}

/**
 * @param localStorage - localStorage passed for easier testing through dependency injection
 * @returns {boolean}
 */
function browserSupportsLocalStorage (localStorage) {
  try {
    if (typeof localStorage !== 'object' || typeof localStorage.setItem !== 'function') {
      return false;
    }
    localStorage.setItem('prebid.cookieTest', '1');
    return localStorage.getItem('prebid.cookieTest') === '1';
  } catch (e) {
    return false;
  }
}

/**
 * @param {string} name
 * @param {string} value
 * @param {?number} expires
 */
export function setCookie(name, value, expires) {
  const expTime = new Date();
  expTime.setTime(expTime.getTime() + (expires || 60) * 1000 * 60);
  window.document.cookie = name + '=' + encodeURIComponent(value) + ';path=/;expires=' +
    expTime.toGMTString();
}

/**
 * @param {string} name
 * @returns {any}
 */
export function getCookie(name) {
  const m = window.document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]*)\\s*(;|$)');
  return m ? decodeURIComponent(m[2]) : null;
}

/**
 * helper to check if local storage or cookies are enabled
 * @param {{document: Document, navigator: Navigator}} dependencyContainer
 * @returns {[]}
 */
export function enabledStorageTypes (dependencyContainer) {
  const enabledStorageTypes = [];
  if (browserSupportsLocalStorage(dependencyContainer.document.localStorage)) {
    enabledStorageTypes.push(STORAGE_TYPE_LOCALSTORAGE);
  }
  if (browserSupportsCookie(dependencyContainer.navigator, dependencyContainer.document)) {
    enabledStorageTypes.push(STORAGE_TYPE_COOKIE)
  }
  return enabledStorageTypes;
}

/**
 * check if any universal id types are set in configuration (must opt-in to enable)
 * @param {{universalIds: [], submodules: []}} dependencyContainer
 */
export function validateConfig (dependencyContainer) {
  // exit if no configurations are set
  if (!Array.isArray(dependencyContainer.universalIds)) {
    return false;
  }
  // check that at least one config exists
  return dependencyContainer.submodules.some(submodule => {
    const submoduleConfig = find(dependencyContainer.universalIds, universalIdConfig => {
      return universalIdConfig.name === submodule.configKey;
    });
    // return true if a valid config exists for submodule
    if (submoduleConfig && typeof submoduleConfig === 'object') {
      return true;
    }
    // false if no config exists for submodule
    return false;
  });
}

/**
 * @param {string} consentString
 * @returns {boolean}
 */
export function gdprLocalStorageConsent(consentString) {
  try {
    return (atob(consentString).charCodeAt(16) | 247) === 255;
  } catch (e) {
    utils.logError('Universal ID Module error decoding gdpr consent string');
    return false;
  }
}

/**
 * test if consent module is present, applies, and is valid for local storage (purpose 1)
 * @returns {boolean}
 */
export function hasGDPRConsent(consentData) {
  if (consentData && typeof consentData.gdprApplies === 'boolean' && consentData.gdprApplies) {
    if (!consentData.consentString) {
      utils.logWarn('Universal ID Module exiting on no GDPR consent string');
      return false;
    } else if (!gdprLocalStorageConsent(consentData.consentString)) {
      utils.logWarn('Universal ID Module exiting on no GDPR consent to local storage (purpose #1)');
      return false;
    }
    return true;
  }
}

/**
 * Decorate ad units with universal id properties. This hook function is called before the
 * real pbjs.requestBids is invoked, and can modify its parameter
 * @param {PrebidConfig} config
 * @param next
 * @returns {*}
 */
export function requestBidHook (config, next) {
  const adUnits = config.adUnits || $$PREBID_GLOBAL$$.adUnits;
  if (adUnits && hasGDPRConsent(gdprDataHandler.getConsentData())) {
    const universalID = extendedBidRequestData.getData().reduce((carry, item) => {
      Object.keys(item).forEach(key => {
        carry[key] = item[key];
      });
      return carry;
    }, {});
    adUnits.forEach((adUnit) => {
      adUnit.bids.forEach((bid) => {
        bid.universalID = universalID;
      });
    });
  }
  // Note: calling next() allows Prebid to continue processing an auction, if not called, the auction will be stalled.
  return next.apply(this, arguments);
}

/**
 * init submodules if config values are set correctly
 * @param {{universalIds: [], syncDelay: number, submodules: [], navigator: Navigator, document: Document, consentData: {}, utils: {} }} dependencyContainer
 * @returns {Array} - returns list of enabled submodules
 */
export function initSubmodules (dependencyContainer) {
  // valid if at least one configuration is valid
  if (!validateConfig(dependencyContainer)) {
    dependencyContainer.utils.logInfo('Failed to validate configuration for Universal ID module');
    return [];
  }
  // storage enabled storage types, use to check if submodule has a valid configuration
  const storageTypes = enabledStorageTypes(dependencyContainer);
  // process and return list of enabled submodules
  return submodules.reduce((carry, submodule) => {
    const universalId = find(dependencyContainer.universalIds, universalIdConfig => {
      return universalIdConfig.name === submodule.configKey;
    });
    // skip, config with name matching submodule.configKey does not exist
    if (!universalId) {
      return carry;
    }

    if (universalId.value && typeof universalId.value === 'object') {
      // submodule just passes a value set in config
      carry.push(`${universalId.name} has valid value configuration, pass directly to bid requests`);
      // add obj to list to pass to adapters
      extendedBidRequestData.addData(universalId.value);
    } else if (universalId.storage && typeof universalId.storage === 'object' &&
      typeof universalId.storage.type === 'string' && storageTypes.indexOf(universalId.storage.type) !== -1) {
      // submodule uses local storage to get value
      carry.push(`${universalId.name} has valid configuration, pass decoded storage value to bid requests`);

      let storageValue;
      if (universalId.storage.type === STORAGE_TYPE_COOKIE) {
        storageValue = getCookie(universalId.storage.name);
      } else if (universalId.storage.type === STORAGE_TYPE_LOCALSTORAGE) {
        storageValue = dependencyContainer.document.localStorage.getItem(universalId.storage.name);
      } else {
        dependencyContainer.utils.logError(`Universal ID Module ${universalId.name} has invalid storage type: ${universalId.storage.type}`);
      }

      if (storageValue) {
        extendedBidRequestData.addData(submodule.decode(storageValue));
      } else {
        // stored value does not exist, call submodule getId
        submodule.getId(universalId, dependencyContainer.consentData, dependencyContainer.syncDelay, function (response) {
          if (response && response.data) {
            if (universalId.storage.type === STORAGE_TYPE_COOKIE) {
              setCookie(universalId.storage.name, JSON.stringify(response.data), response.expires);
            } else if (universalId.storage.type === STORAGE_TYPE_LOCALSTORAGE) {
              dependencyContainer.document.localStorage.setItem(universalId.storage.name, JSON.stringify(response.data));
            } else {
              utils.logError('Universal ID Module: Invalid configuration storage type');
            }
            extendedBidRequestData.addData(submodule.decode(response.data));
          } else {
            dependencyContainer.utils.logError('Universal ID Module: Submodule getId callback returned empty or invalid response');
          }
        });
      }
    }
    return carry;
  }, []);
}

/**
 * @param {{config: {}, submodules: [], navigator: Navigator, document: Document, utils: {}, consentData: {}}} dependencyContainer
 */
export function init(dependencyContainer) {
  dependencyContainer.config.getConfig('usersync', ({usersync}) => {
    if (usersync) {
      dependencyContainer['syncDelay'] = usersync.syncDelay || 0;
      dependencyContainer['universalIds'] = usersync.universalIds;
      const enabledModules = initSubmodules(dependencyContainer);
      dependencyContainer.utils.logInfo(`Universal ID Module initialized ${enabledModules.length} submodules`);
    }
  });
}
init({
  config: config,
  submodules: submodules,
  navigator: window.navigator,
  document: window.document,
  utils: utils,
  consentData: gdprDataHandler.getConsentData()
});
