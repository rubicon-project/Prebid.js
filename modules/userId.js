/**
 * This module adds User ID support to prebid.js
 * @module userId
 */

/**
 * @typedef {Object} ConsentData
 * @property {(string|undefined)} consentString
 * @property {(Object|undefined)} vendorData
 * @property {(boolean|undefined)} gdprApplies
 */

/**
 * @typedef {Object} SubmoduleConfig
 * @property {string} name - the User ID submodule name (used to link submodule with config)
 * @property {(SubmoduleStorage|undefined)} storage - browser storage config
 * @property {(SubmoduleParams|undefined)} params - params config for use by the submodule.getId function
 * @property {(Object|undefined)} value - if not empty, this value is added to bid requests for access in adapters
 */

/**
 * @typedef {Object} SubmoduleStorage
 * @property {string} type - browser storage type (html5 or cookie)
 * @property {string} name - key name to use when saving/reading to local storage or cookies
 * @property {(number|undefined)} expires - time to live for browser cookie
 */

/**
 * @typedef {Object} SubmoduleParams
 * @property {(string|undefined)} partner - partner url param value
 * @property {(string|undefined)} url - webservice request url used to load Id data
 */

/**
 * @typedef {Object} Submodule
 * @property {string} name - used to link submodule with config
 * @property {decode} decode - decode a stored value for passing to bid requests
 * @property {getId} getId - performs action to obtain id and return a value in the callback's response argument
 */

/**
 * @callback getId
 * @param {SubmoduleParams} [submoduleConfigParams]
 * @param {ConsentData} [consentData]
 * @returns {(function|Object|string)} - returns id data or a callback, the callback is called on the auction end event
 */

/**
 * @callback decode
 * @param {(Object|string)} value
 * @returns {(Object|undefined)}
 */

/**
 * @typedef {Object} SubmoduleContainer
 * @property {Submodule} submodule
 * @property {SubmoduleConfig} config
 * @property {(Object|undefined)} idObj - cache decoded id value (this is copied to every adUnit bid)
 * @property {(function|undefined)} callback - holds reference to submodule.getId() result if it returned a function. Will be set to undefined after callback executes
 */

import find from 'core-js/library/fn/array/find';
import {config} from '../src/config.js';
import events from '../src/events.js';
import * as utils from '../src/utils.js';
import {getGlobal} from '../src/prebidGlobal.js';
import {gdprDataHandler} from '../src/adapterManager.js';
import {unifiedIdSubmodule} from './idSystemUnifiedId.js';
import {pubCommonIdSubmodule} from './idSystemPubCommonId.js';
import CONSTANTS from '../src/constants.json';

export const MODULE_NAME = 'User ID';
const COOKIE = 'cookie';
const LOCAL_STORAGE = 'html5';
const DEFAULT_SYNC_DELAY = 500;

/**
 * delay after auction to make webrequests for id data
 * @type {number}
 */
export let syncDelay;

/** @type {SubmoduleContainer[]} */
export let submodules = [];

/** @type {Submodule[]} */
let submoduleRegistry = [];

/** @type {SubmoduleContainer[]} */
let initializedSubmodules;

/** @type {SubmoduleConfig[]} */
let configRegistry;

/** @type {string[]} */
let activeStorageTypes = [];

/** @type {boolean} */
let addedUserIdHook = false;

/** @param {Submodule[]} submodules */
export function setEnabledSubmodules(submodules) {
  submoduleRegistry = submodules;
}

/**
 * @param {SubmoduleStorage} storage
 * @param {string} value
 * @param {(number|string)} expires
 */
export function setStoredValue(storage, value, expires) {
  try {
    const valueStr = utils.isPlainObject(value) ? JSON.stringify(value) : value;
    const expiresStr = (new Date(Date.now() + (expires * (60 * 60 * 24 * 1000)))).toUTCString();

    if (storage.type === COOKIE) {
      utils.setCookie(storage.name, valueStr, expiresStr);
    } else if (storage.type === LOCAL_STORAGE) {
      localStorage.setItem(`${storage.name}_exp`, expiresStr);
      localStorage.setItem(storage.name, encodeURIComponent(valueStr));
    }
  } catch (error) {
    utils.logError(error);
  }
}

/**
 * @param {SubmoduleStorage} storage
 * @returns {string}
 */
export function getStoredValue(storage) {
  let storedValue;
  try {
    if (storage.type === COOKIE) {
      storedValue = utils.getCookie(storage.name);
    } else if (storage.type === LOCAL_STORAGE) {
      const storedValueExp = localStorage.getItem(`${storage.name}_exp`);
      // empty string means no expiration set
      if (storedValueExp === '') {
        storedValue = localStorage.getItem(storage.name);
      } else if (storedValueExp) {
        if ((new Date(storedValueExp)).getTime() - Date.now() > 0) {
          storedValue = decodeURIComponent(localStorage.getItem(storage.name));
        }
      }
    }
    // we support storing either a string or a stringified object,
    // so we test if the string contains an stringified object, and if so convert to an object
    if (typeof storedValue === 'string' && storedValue.charAt(0) === '{') {
      storedValue = JSON.parse(storedValue);
    }
  } catch (e) {
    utils.logError(e);
  }
  return storedValue;
}

/**
 * test if consent module is present, applies, and is valid for local storage or cookies (purpose 1)
 * @param {ConsentData} consentData
 * @returns {boolean}
 */
export function hasGDPRConsent(consentData) {
  if (consentData && typeof consentData.gdprApplies === 'boolean' && consentData.gdprApplies) {
    if (!consentData.consentString) {
      return false;
    }
    if (consentData.vendorData && consentData.vendorData.purposeConsents && consentData.vendorData.purposeConsents['1'] === false) {
      return false;
    }
  }
  return true;
}

/**
 * @param {SubmoduleContainer[]} submodules
 */
export function processSubmoduleCallbacks(submodules) {
  submodules.forEach(function(submodule) {
    submodule.callback(function callbackCompleted (idObj) {
      // clear callback, this prop is used to test if all submodule callbacks are complete below
      submodule.callback = undefined;

      // if valid, id data should be saved to cookie/html storage
      if (idObj) {
        setStoredValue(submodule.config.storage, idObj, submodule.config.storage.expires);

        // cache decoded value (this is copied to every adUnit bid)
        submodule.idObj = submodule.submodule.decode(idObj);
      } else {
        utils.logError(`${MODULE_NAME}: ${submodule.submodule.name} - request id responded with an empty value`);
      }
    });
  });
}

/**
 * @param {AdUnit[]} adUnits
 * @param {SubmoduleContainer[]} submodules
 */
export function addIdDataToAdUnitBids(adUnits, submodules) {
  if (!Array.isArray(adUnits)) {
    return;
  }

  const combinedSubmoduleIds = submodules.filter(submodule => !!submodule.idObj).reduce((carry, submodule) => {
    Object.keys(submodule.idObj).forEach(key => {
      carry[key] = submodule.idObj[key];
    });
    return carry;
  }, {});

  if (Object.keys(combinedSubmoduleIds).length) {
    adUnits.forEach(adUnit => {
      adUnit.bids.forEach(bid => {
        // create a User ID object on the bid, with child properties from submmodules.idObj
        bid.userId = combinedSubmoduleIds;
      });
    });
  }
}

/**
 * Hook is executed before adapters, but after consentManagement. Consent data is requied because
 * this module requires GDPR consent with Purpose #1 to save data locally.
 * The two main actions handled by the hook are:
 * 1. check gdpr consentData and handle submodule initialization.
 * 2. append user id data (loaded from cookied/html or from the getId method) to bids to be accessed in adapters.
 * @param {Object} reqBidsConfigObj required; This is the same param that's used in pbjs.requestBids.
 * @param {function} fn required; The next function in the chain, used by hook.js
 */
export function requestBidsHook(fn, reqBidsConfigObj) {
  // initialize submodules only when undefined
  if (typeof initializedSubmodules === 'undefined') {
    initializedSubmodules = initSubmodules(submodules, gdprDataHandler.getConsentData());
    if (initializedSubmodules.length) {
      // list of sumodules that have callbacks that need to be executed
      const submodulesWithCallbacks = initializedSubmodules.filter(item => utils.isFn(item.callback));

      if (submodulesWithCallbacks.length) {
        // wait for auction complete before processing submodule callbacks
        events.on(CONSTANTS.EVENTS.AUCTION_END, function auctionEndHandler() {
          events.off(CONSTANTS.EVENTS.AUCTION_END, auctionEndHandler);

          // when syncDelay is zero, process callbacks now, otherwise dealy process with a setTimeout
          if (syncDelay > 0) {
            setTimeout(function() {
              processSubmoduleCallbacks(submodulesWithCallbacks);
            }, syncDelay);
          } else {
            processSubmoduleCallbacks(submodulesWithCallbacks);
          }
        });
      }
    }
  }

  // pass available user id data to bid adapters
  addIdDataToAdUnitBids(reqBidsConfigObj.adUnits || getGlobal().adUnits, initializedSubmodules);

  // calling fn allows prebid to continue processing
  return fn.call(this, reqBidsConfigObj);
}

/**
 * @param {SubmoduleContainer[]} submodules
 * @param {ConsentData} consentData
 * @returns {SubmoduleContainer[]} initialized submodules
 */
export function initSubmodules(submodules, consentData) {
  // gdpr consent with purpose one is required, otherwise exit immediately
  if (!hasGDPRConsent(consentData)) {
    utils.logWarn(`${MODULE_NAME} - gdpr permission not valid for local storage or cookies, exit module`);
    return [];
  }
  return submodules.reduce((carry, submodule) => {
    // There are two submodule configuration types to handle: storage or value
    // 1. storage: retrieve user id data from cookie/html storage or with the submodule's getId method
    // 2. value: pass directly to bids
    if (submodule.config && submodule.config.storage) {
      const storedId = getStoredValue(submodule.config.storage);
      if (storedId) {
        // cache decoded value (this is copied to every adUnit bid)
        submodule.idObj = submodule.submodule.decode(storedId);
      } else {
        // getId will return user id data or a function that will load the data
        const getIdResult = submodule.submodule.getId(submodule.config.params, consentData);

        // If the getId result has a type of function, it is asynchronous and cannot be called until later
        if (utils.isFn(getIdResult)) {
          submodule.callback = getIdResult;
        } else {
          // A getId result that is not a function is assumed to be valid user id data, which should be saved to users local storage or cookies
          setStoredValue(submodule.config.storage, getIdResult, submodule.config.storage.expires);

          // cache decoded value (this is copied to every adUnit bid)
          submodule.idObj = submodule.submodule.decode(getIdResult);
        }
      }
    } else if (submodule.config.value) {
      // cache decoded value (this is copied to every adUnit bid)
      submodule.idObj = submodule.config.value;
    }

    carry.push(submodule);
    return carry;
  }, []);
}

/**
 * list of submodule configurations with valid 'storage' or 'value' obj definitions
 * * storage config: contains values for storing/retrieving User ID data in browser storage
 * * value config: object properties that are copied to bids (without saving to storage)
 * @param {SubmoduleConfig[]} configRegistry
 * @param {Submodule[]} submoduleRegistry
 * @param {string[]} activeStorageTypes
 * @returns {SubmoduleConfig[]}
 */
export function getValidSubmoduleConfigs(configRegistry, submoduleRegistry, activeStorageTypes) {
  if (!Array.isArray(configRegistry)) {
    return [];
  }
  return configRegistry.reduce((carry, conf) => {
    // every submodule config obj must contain a valid 'name'
    if (!conf || utils.isEmptyStr(conf.name)) {
      return carry;
    }
    // alidate storage config contains 'type' and 'name' properties with non-empty string values
    // 'type' must be a value currently enabled in the browser
    if (conf.storage &&
      !utils.isEmptyStr(conf.storage.type) &&
      !utils.isEmptyStr(conf.storage.name) &&
      activeStorageTypes.indexOf(conf.storage.type) !== -1) {
      carry.push(conf);
    } else if (utils.isPlainObject(conf.value)) {
      carry.push(conf);
    }
    return carry;
  }, []);
}

/**
 * update submodules by validating against existing configs and storage types
 */
function updateSubmodules () {
  const configs = getValidSubmoduleConfigs(configRegistry, submoduleRegistry, activeStorageTypes);
  if (!configs.length) {
    return;
  }
  // do this to avoid reprocessing submodules
  const addedSubmodules = submoduleRegistry.filter(i => !find(submodules, j => j.name === i.name));
  submodules = addedSubmodules.map(submodule => {
    // find submodule configuration with matching name, if one exists, append a submoduleContainer with the submodule and config
    const conf = find(configs, i => i.name === submodule.name);
    return conf ? {
      submodule: submodule,
      config: conf,
      callback: undefined,
      idObj: undefined
    } : null;
  }).filter(submodule => submodule);

  // initialization if submodules exist
  if (submodules.length && !addedUserIdHook) {
    // priority has been set so it loads after consentManagement (which has a priority of 50)
    getGlobal().requestBids.before(requestBidsHook, 40);
    utils.logInfo(`${MODULE_NAME} - usersync config updated for ${submodules.length} submodules`);
    addedUserIdHook = true;
  }
}

/**
 * @param {PrebidConfig} config
 */
export function init(config) {
  submodules = [];
  configRegistry = [];
  addedUserIdHook = false;
  initializedSubmodules = undefined;

  // list of browser enabled storage types
  activeStorageTypes = [
    utils.localStorageIsEnabled() ? LOCAL_STORAGE : null,
    utils.cookiesAreEnabled() ? COOKIE : null
  ].filter(i => i !== null);

  // exit immediately if opt out cookie or local storage keys exists.
  // _pubcid_optout is checked for compatiblility with pubCommonId
  if (activeStorageTypes.indexOf(COOKIE) !== -1 && utils.getCookie('_pbjs_id_optout')) {
    utils.logInfo(`${MODULE_NAME} - opt-out cookie found, exit module`);
    return;
  }
  if (activeStorageTypes.indexOf(LOCAL_STORAGE) !== -1 &&
    (localStorage.getItem('_pbjs_id_optout') && localStorage.getItem('_pubcid_optout'))) {
    utils.logInfo(`${MODULE_NAME} - opt-out localStorage found, exit module`);
    return;
  }

  // listen for config userSyncs to be set
  config.getConfig(conf => {
    const userSync = conf.userSync || conf.usersync;
    if (userSync && userSync.userIds) {
      configRegistry = userSync.userIds || [];
      syncDelay = utils.isNumber(userSync.syncDelay) ? userSync.syncDelay : DEFAULT_SYNC_DELAY;
      updateSubmodules();
    }
  })
}

/**
 * @param {Submodule} submodule
 */
export function attachIdSystem(submodule) {
  if (!find(submoduleRegistry, i => i.name === submodule.name)) {
    submoduleRegistry.push(submodule);
    updateSubmodules();
  }
}

// Attach submodules
attachIdSystem(unifiedIdSubmodule);
attachIdSystem(pubCommonIdSubmodule);
// init config update listener to start the application
init(config);
