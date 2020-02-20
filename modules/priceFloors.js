import { getGlobal } from '../src/prebidGlobal';
import { config } from '../src/config.js';
import * as utils from '../src/utils';
import { ajaxBuilder } from '../src/ajax';
import events from '../src/events';
import CONSTANTS from '../src/constants.json';
import { getHook } from '../src/hook.js';
import { createBid } from '../src/bidfactory';
import find from 'core-js/library/fn/array/find';

/**
 * @summary This Module is intended to provide users with the ability to dynamically set and enforce price floors on a per auction basis.
 */
const MODULE_NAME = 'Price Floors';

/**
 * @summary Instantiate Ajax so we control the timeout TODO: Change to 5000 before PR
 */
const ajax = ajaxBuilder(10000);

/**
 * @summary Allowed fields for rules to have
 */
const allowedFields = ['gptSlot', 'adUnitCode', 'size', 'domain', 'mediaType'];

/**
 * @summary This is a flag to indicate if a AJAX call is processing for a floors request
*/
let fetching = false;

/**
 * @summary so we only register for our hooks once
*/
let addedFloorsHook = false;

/**
 * @summary The config to be used. Can be updated via: setConfig or a real time fetch
 */
let _floorsConfig = {};

/**
 * @summary If a auction is to be delayed by an ongoing fetch we hold it here until it can be resumed
 */
let _delayedAuctions = [];

/**
 * @summary Each auction can have differing floors data depending on execution time or per adunit setup
 * So we will be saving each auction offset by it's auctionId in order to make sure data is not changed
 * Once the auction commences
 */
export let _floorDataForAuction = {};

/**
 * @summary Simple function to round up to a certain decimal degree
 */
function roundUp(number, precision) {
  return Math.ceil(parseFloat(number) * Math.pow(10, precision)) / Math.pow(10, precision);
}

/**
 * @summary floor field types with their matching functions to resolve the actual matched value
 */
const fieldMatchingFunctions = {
  'gptSlot': bidObject => utils.getGptSlotInfoForAdUnitCode(bidObject.adUnitCode).gptSlot,
  'domain': () => window.location.hostname,
  'adUnitCode': bidObject => bidObject.adUnitCode
};

/**
 * @summary Based on the fields array in floors data, it enumerates all possible matches based on exact match coupled with
 * a "*" catch-all match
 * Returns array of Tuple [exact match, catch all] for each field in rules file
 */
function enumeratePossibleFieldValues(floorFields, bidObject, mediaType, size) {
  // enumerate possible matches
  size = utils.parseGPTSingleSizeArray(size) || '*';

  return floorFields.reduce((accum, field) => {
    let exactMatch;
    if (field === 'size') {
      exactMatch = size;
    } else if (field === 'mediaType') {
      exactMatch = mediaType;
    } else {
      exactMatch = fieldMatchingFunctions[field](bidObject);
    }
    // storing exact matches as lowerCase since we want to compare case insensitively
    accum.push(exactMatch === '*' ? ['*'] : [exactMatch.toLowerCase(), '*']);
    return accum;
  }, []);
};

/**
 * @summary get's the first matching floor based on context provided.
 * Generates all possible rule matches and picks the first matching one.
 */
export function getFirstMatchingFloor(floorData, bidObject, mediaType, size) {
  let fieldValues = enumeratePossibleFieldValues(utils.deepAccess(floorData, 'schema.fields') || [], bidObject, mediaType, size);
  if (!fieldValues.length) return { matchingFloor: floorData.default };
  let allPossibleMatches = generatePossibleEnumerations(fieldValues, utils.deepAccess(floorData, 'schema.delimiter') || '|');
  let matchingRule = find(allPossibleMatches, hashValue => floorData.values.hasOwnProperty(hashValue));

  return {
    matchingFloor: floorData.values[matchingRule] || floorData.default,
    matchingData: allPossibleMatches[0], // the first possible match is an "exact" so contains all data relevant for anlaytics adapters
    matchingRule
  }
};

/**
 * @summary Generates all possible rule hash's based on input array of array's
 * The generated list is of all possible key matches based on fields input
 * The list is sorted by least amount of * in rule to most with left most fields taking precedence
 */
function generatePossibleEnumerations(arrayOfFields, delimiter) {
  return arrayOfFields.reduce((accum, currentVal) => {
    let ret = [];
    accum.map(obj => {
      currentVal.map(obj1 => {
        ret.push(obj + delimiter + obj1)
      });
    });
    return ret;
  }).sort((left, right) => (left.split('*').length - 1) - (right.split('*').length - 1));
};

/**
 * @summary If a the input bidder has a registered cpmadjustment it returns the input CPM after being adjusted
 */
export function getBiddersCpmAdjustment(bidderName, inputCpm) {
  const adjustmentFunction = utils.deepAccess(getGlobal(), `bidderSettings.${bidderName}.bidCpmAdjustment`);
  if (adjustmentFunction) {
    return parseFloat(adjustmentFunction(inputCpm));
  }
  return parseFloat(inputCpm);
};

/**
 * @summary This function takes the original floor and the adjusted floor in order to determine the bidders actual floor
 */
export function calculateAdjustedFloor(oldFloor, newFloor) {
  return oldFloor / newFloor * oldFloor;
};

/**
 * @summary This is the function which will return a single floor based on the input requests
 * and matching it to a rule for the current auction
 */
export function getFloor(requestParams = {}) {
  let floorData = _floorDataForAuction[this.auctionId];
  if (!floorData || floorData.skipped) return {};

  let floorInfo = getFirstMatchingFloor(floorData.data, this, requestParams.mediaType || 'banner', requestParams.size || '*');
  let currency = requestParams.currency || floorData.currency;

  // if bidder asked for a currency which is not what floors are set in convert
  if (floorInfo.matchingFloor && currency !== floorData.data.currency) {
    try {
      floorInfo.matchingFloor = getGlobal().convertCurrency(floorInfo.matchingFloor, floorData.data.currency, currency);
    } catch (err) {
      utils.logWarn(`${MODULE_NAME}: Unable to get currency conversion for getFloor for bidder ${this.bidder}. You must have currency module enabled with defaultRates in your currency config`);
      // since we were unable to convert to the bidders requested currency, we send back just the actual floors currency to them
      currency = floorData.data.currency;
    }
  }

  // if cpmAdjustment flag is true and we have a valid floor then run the adjustment on it
  if (floorData.enforcement.bidAdjustment && floorInfo.matchingFloor) {
    let cpmAdjustment = getBiddersCpmAdjustment(this.bidder, floorInfo.matchingFloor);
    floorInfo.matchingFloor = calculateAdjustedFloor(floorInfo.matchingFloor, cpmAdjustment);
  }

  if (floorInfo.matchingFloor) {
    return {
      floor: roundUp(floorInfo.matchingFloor, 4),
      currency,
    };
  }
  return {};
};

/**
 * @summary Takes a floorsData object and converts it into a hash map with appropriate keys
 */
export function getFloorsDataForAuction(floorData, adUnitCode) {
  let auctionFloorData = utils.deepClone(floorData);
  auctionFloorData.schema.delimiter = floorData.schema.delimiter || '|';
  auctionFloorData.values = normalizeRulesForAuction(auctionFloorData, adUnitCode);
  // default the currency to USD if not passed in
  auctionFloorData.currency = auctionFloorData.currency || 'USD';
  return auctionFloorData;
};

/**
 * @summary if adUnitCode needs to be added to the offset then it will add it else just return the values
 */
function normalizeRulesForAuction(floorData, adUnitCode) {
  let fields = floorData.schema.fields;
  let delimiter = floorData.schema.delimiter

  // if we are building the floor data form an ad unit, we need to append adUnit code as to not cause collisions
  let prependAdUnitCode = adUnitCode && !fields.includes('adUnitCode') && fields.unshift('adUnitCode');
  return Object.keys(floorData.values).reduce((rulesHash, oldKey) => {
    let newKey = prependAdUnitCode ? `${adUnitCode}${delimiter}${oldKey}` : oldKey
    // we store the rule keys as lower case for case insensitive compare
    rulesHash[newKey.toLowerCase()] = floorData.values[oldKey];
    return rulesHash;
  }, {});
};

export function getFloorDataFromAdUnits(adUnits) {
  return adUnits.reduce((accum, adUnit) => {
    if (isFloorsDataValid(adUnit.floors)) {
      // if values already exist we want to not overwrite them
      if (!accum.values) {
        accum = getFloorsDataForAuction(adUnit.floors, adUnit.code);
        accum.location = 'adUnit';
      } else {
        let newRules = getFloorsDataForAuction(adUnit.floors, adUnit.code).values;
        // copy over the new rules into our values object
        Object.assign(accum.values, newRules);
      }
    }
    return accum;
  }, {});
};
/**
 * @summary This function takes the adUnits for the auction and update them accordingly as well as returns the rules hashmap for the auction
 */
export function updateAdUnitsForAuction(adUnits, floorData, skipped) {
  adUnits.forEach((adUnit) => {
    adUnit.bids.forEach(bid => {
      if (skipped) {
        delete bid.getFloor;
      } else {
        bid.getFloor = getFloor;
      }
      // information for bid and analytics adapters
      bid.floorData = {
        skipped,
        modelVersion: utils.deepAccess(floorData, 'data.modelVersion') || '',
        location: floorData.data.location,
      }
    });
  });
};

/**
 * @summary Updates the adUnits accordingly and returns the necessary floorsData for the current auction
 */
export function createFloorsDataForAuction(adUnits) {
  let resolvedFloorsData = utils.deepClone(_floorsConfig);

  // if we do not have a floors data set, we will try to use data set on adUnits
  let useAdUnitData = Object.keys(utils.deepAccess(resolvedFloorsData, 'data.values') || {}).length === 0;
  if (useAdUnitData) {
    resolvedFloorsData.data = getFloorDataFromAdUnits(adUnits);
  } else {
    resolvedFloorsData.data = getFloorsDataForAuction(resolvedFloorsData.data);
  }
  // if we still do not have a valid floor data then floors is not on for this auction
  if (Object.keys(utils.deepAccess(resolvedFloorsData, 'data.values') || {}).length === 0) {
    return;
  }
  // determine the skip rate now
  const isSkipped = Math.random() * 100 < (utils.deepAccess(resolvedFloorsData, 'data.skipRate') || 0);
  resolvedFloorsData.skipped = isSkipped;
  updateAdUnitsForAuction(adUnits, resolvedFloorsData, isSkipped);
  return resolvedFloorsData;
};

/**
 * @summary This is the function which will be called to exit our module and continue the auction.
 */
export function continueAuction(hookConfig) {
  // only run if hasExited
  if (!hookConfig.hasExited) {
    // if this current auction is still fetching, remove it from the _delayedAuctions
    _delayedAuctions = _delayedAuctions.filter(auctionConfig => auctionConfig.timer !== hookConfig.timer);

    // We need to know the auctionId at this time. So we will use the passed in one or generate and set it ourselves
    hookConfig.reqBidsConfigObj.auctionId = hookConfig.reqBidsConfigObj.auctionId || utils.generateUUID();

    // now we do what we need to with adUnits and save the data object to be used for getFloor and enforcement calls
    _floorDataForAuction[hookConfig.reqBidsConfigObj.auctionId] = createFloorsDataForAuction(hookConfig.reqBidsConfigObj.adUnits || getGlobal().adUnits);

    hookConfig.nextFn.apply(hookConfig.context, [hookConfig.reqBidsConfigObj]);
    hookConfig.hasExited = true;
  }
};

function validateSchemaFields(fields) {
  if (Array.isArray(fields) && fields.length > 0 && fields.every(field => allowedFields.includes(field))) {
    return true;
  }
  utils.logError(`${MODULE_NAME}: Fields recieved do not match allowed fields`);
  return false;
};

function isValidRule(key, floor, numFields, delimiter) {
  if (typeof key !== 'string' || key.split(delimiter).length !== numFields) {
    return false;
  }
  return typeof floor === 'number';
};

function validateRules(rules, numFields, delimiter) {
  if (typeof rules !== 'object') {
    return false;
  }
  // if an invalid rule exists we remove it
  rules = Object.keys(rules).reduce((filteredRules, key) => {
    if (isValidRule(key, rules[key], numFields, delimiter)) {
      filteredRules[key] = rules[key];
    }
    return filteredRules
  }, {});
  // rules is only valid if at least one rule remains
  return Object.keys(rules).length > 0;
};

/**
 * @summary Fields array should have at least one entry and all should match allowed fields
 * Each rule in the values array should have a 'key' and 'floor' param
 * And each 'key' should have the correct number of 'fields' after splitting
 * on the delim. If rule does not match remove it. return if still at least 1 rule
 */
export function isFloorsDataValid(floorsData) {
  if (typeof floorsData !== 'object') {
    return false;
  }
  // schema.fields has only allowed attributes
  if (!validateSchemaFields(utils.deepAccess(floorsData, 'schema.fields'))) {
    return false;
  }
  return validateRules(floorsData.values, floorsData.schema.fields.length, floorsData.schema.delimiter || '|')
};

/**
 * This function updates the global Floors Data field based on the new one passed in
 */
export function parseFloorData(floorsData, location) {
  if (floorsData && typeof floorsData === 'object' && isFloorsDataValid(floorsData)) {
    return {
      ...floorsData,
      location
    };
  }
  utils.logError(`${MODULE_NAME}: The floors data did not contain correct values`, floorsData);
};

/**
 *
 * @param {Object} reqBidsConfigObj required; This is the same param that's used in pbjs.requestBids.
 * @param {function} fn required; The next function in the chain, used by hook.js
 */
export function requestBidsHook(fn, reqBidsConfigObj) {
  // preserves all module related variables for the current auction instance (used primiarily for concurrent auctions)
  const hookConfig = {
    reqBidsConfigObj,
    context: this,
    nextFn: fn,
    haveExited: false,
    timer: null
  };

  // If auction delay > 0 AND we are fetching -> Then wait until it finishes
  if (_floorsConfig.auctionDelay > 0 && fetching) {
    hookConfig.timer = setTimeout(() => {
      utils.logWarn(`${MODULE_NAME}: Fetch attempt did not return in time for auction`);
      continueAuction(hookConfig);
    }, _floorsConfig.auctionDelay);
    _delayedAuctions.push(hookConfig);
  } else {
    continueAuction(hookConfig);
  }
};

function resumeDelayedAuctions() {
  _delayedAuctions.forEach(auctionConfig => {
    // clear the timeout
    clearTimeout(auctionConfig.timer);
    continueAuction(auctionConfig);
  });
  _delayedAuctions = [];
}

/**
 * This function handles the ajax response which comes from the user set URL to fetch floors data from
 * @param {object} fetchResponse The floors data response which came back from the url configured in config.floors
 */
export function handleFetchResponse(fetchResponse) {
  fetching = false;
  let floorResponse;
  try {
    floorResponse = JSON.parse(fetchResponse);
  } catch (ex) {
    floorResponse = fetchResponse;
  }
  // Update the global floors object according to the fetched data
  _floorsConfig.data = parseFloorData(floorResponse, 'fetch') || _floorsConfig.data;

  // if any auctions are waiting for fetch to finish, we need to continue them!
  resumeDelayedAuctions();
};

function handleFetchError(status) {
  fetching = false;
  utils.logError(`${MODULE_NAME}: Fetch errored with: ${status}`);

  // if any auctions are waiting for fetch to finish, we need to continue them!
  resumeDelayedAuctions();
};

/**
 * This function handles sending and recieving the AJAX call for a floors fetch
 * @param {object} floorsConfig the floors config coming from setConfig
 */
export function generateAndHandleFetch(floorEndpoint) {
  // if a fetch url is defined and one is not already occuring, fire it!
  if (floorEndpoint.url && !fetching) {
    // default to GET and we only support GET for now
    let requestMethod = floorEndpoint.method || 'GET';
    if (requestMethod !== 'GET') {
      utils.logError(`${MODULE_NAME}: 'GET' is the only request method supported at this time!`);
    } else {
      ajax(floorEndpoint.url, { success: handleFetchResponse, error: handleFetchError }, null, { method: 'GET' });
      fetching = true;
    }
  } else if (fetching) {
    utils.logWarn(`${MODULE_NAME}: A fetch is already occuring. Skipping.`);
  }
};

/**
 * @summary This is the function which controls what happens during a pbjs.setConfig({...floors: {}}) is called
 */
export function handleSetFloorsConfig(config) {
  _floorsConfig = utils.pick(config, [
    'enabled', enabled => enabled !== false, // defaults to true
    'auctionDelay', auctionDelay => auctionDelay || 0,
    'endpoint', endpoint => endpoint || {},
    'enforcement', enforcement => utils.pick(enforcement, [
      'enforceJS', enforceJS => enforceJS !== false, // defaults to true
      'enforcePBS', enforcePBS => enforcePBS !== true, // defaults to false
      'floorDeals', floorDeals => floorDeals !== true, // defaults to false
      'bidAdjustment', bidAdjustment => bidAdjustment !== false, // defaults to true
    ]),
    'data', data => parseFloorData(data, 'setConfig') || _floorsConfig.data // do not overwrite if passed in data not valid
  ]);

  // if enabled then do some stuff
  if (_floorsConfig.enabled) {
    // handle the floors fetch
    generateAndHandleFetch(_floorsConfig.endpoint);

    if (!addedFloorsHook) {
      // register hooks / listening events
      // when auction finishes remove it's associated floor data
      events.on(CONSTANTS.EVENTS.AUCTION_END, (args) => delete _floorDataForAuction[args.auctionId]);

      // we want our hooks to run after the currency hooks
      getGlobal().requestBids.before(requestBidsHook, 50);
      getHook('addBidResponse').before(addBidResponseHook, 50);
      addedFloorsHook = true;
    }
  } else {
    utils.logInfo(`${MODULE_NAME}: Turning off module`);

    _floorsConfig = {};
    _floorDataForAuction = {};

    getHook('addBidResponse').getHooks({hook: addBidResponseHook}).remove();
    getGlobal().requestBids.getHooks({hook: requestBidsHook}).remove();

    addedFloorsHook = false;
  }
};

function addFloorDataToBid(floorData, floorInfo, bid, adjustedCpm) {
  bid.floorData = {
    floorEnforced: floorInfo.matchingFloor,
    adjustedCpm,
    enforceJS: floorData.enforcement.enforceJS,
    matchedFields: {}
  }
  floorData.data.schema.fields.forEach((field, index) => {
    let matchedValue = floorInfo.matchingData.split(floorData.data.schema.delimiter)[index];
    bid.floorData.matchedFields[field] = matchedValue;
  });
}

function shouldFloorBid(floorData, floorInfo, bid) {
  let enforceJS = utils.deepAccess(floorData, 'enforcement.enforceJS') !== false;
  let shouldFloorDeal = utils.deepAccess(floorData, 'enforcement.floorDeals') === true || !bid.dealId;
  let bidBelowFloor = bid.floorData.adjustedCpm < floorInfo.matchingFloor;
  return enforceJS && (bidBelowFloor && shouldFloorDeal);
}

export function addBidResponseHook(fn, adUnitCode, bid) {
  let floorData = _floorDataForAuction[this.bidderRequest.auctionId];
  // if no floorData or it was skipped then just continue
  if (!floorData || !bid || floorData.skipped) {
    return fn.call(this, adUnitCode, bid);
  }

  // get the matching rule
  let mediaType = bid.mediaType || 'banner';
  let size = [bid.width, bid.height];
  const matchingBidRequest = find(this.bidderRequest.bids, bidRequest => bidRequest.bidId === bid.requestId);
  let floorInfo = getFirstMatchingFloor(floorData.data, matchingBidRequest, mediaType, size);

  if (!floorInfo.matchingFloor) {
    utils.logWarn(`${MODULE_NAME}: unable to determine a matching price floor for bidResponse`, bid);
    return fn.call(this, adUnitCode, bid);
  }

  // we need to get the bidders cpm after the adjustment
  let adjustedCpm = getBiddersCpmAdjustment(bid.bidderCode, bid.cpm);

  // floors currency not guaranteed to be adServer Currency
  // if the floor currency is not the same as the cpm currency then we need to convert
  if (floorData.data.currency.toUpperCase() !== bid.currency.toUpperCase()) {
    if (typeof bid.getCpmInNewCurrency !== 'function') {
      utils.logError(`${MODULE_NAME}: Currency module is required if any bidResponse currency differs from floors currency`);
      return fn.call(this, adUnitCode, bid);
    }
    adjustedCpm = parseFloat(bid.getCpmInNewCurrency(floorData.data.currency.toUpperCase()));
  }
  // add floor data to bid for analytics adapters to use
  addFloorDataToBid(floorData, floorInfo, bid, adjustedCpm);

  // now do the compare!
  if (shouldFloorBid(floorData, floorInfo, bid)) {
    // bid fails floor -> throw it out
    // create basic bid no-bid with necessary data fro analytics adapters
    let flooredBid = createBid(CONSTANTS.STATUS.NO_BID, matchingBidRequest);
    Object.assign(flooredBid, utils.pick(bid, [
      'floorData',
      'width',
      'height',
      'mediaType',
      'currency',
      'originalCpm',
      'originalCurrency',
      'getCpmInNewCurrency',
    ]));
    flooredBid.status = 'bidRejected';
    // if floor not met update bid with 0 cpm so it is not included downstream and marked as no-bid
    flooredBid.cpm = 0;
    return fn.call(this, adUnitCode, flooredBid);
  }
  return fn.call(this, adUnitCode, bid);
}

config.getConfig('floors', config => handleSetFloorsConfig(config.floors));
