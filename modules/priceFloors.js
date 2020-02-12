import { getGlobal } from '../src/prebidGlobal';
import { config } from '../src/config.js';
import * as utils from '../src/utils';
import { ajaxBuilder } from '../src/ajax';
import events from '../src/events';
import CONSTANTS from '../src/constants.json';
import { getHook } from '../src/hook.js';
import { createBid } from '../src/bidfactory';

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
let allowedFields = ['gptSlot', 'adUnitCode', 'size', 'domain', 'mediaType'];

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
let _floorsConfig = {
  auctionDelay: 0,
  enforcement: { // enforcement flags which alter the way price floors will be enforced or not
    enforceJS: true, // Wether to enforce the derived floor per bidResponse or ignore
    enforcePBS: false, // Sends a flag to PBS which has it do flooring on the server
    floorDeals: false, // Signals if bidResponses containing dealId's are adherendt to flooring
    bidAdjustment: false, // Signals wether the getFloors function should take into account the bidders CPM Adjustment when returning a floor value
  },
};

/**
 * @summary If a auction is to be delayed by an ongoing fetch we hold it here until it can be resumed
 */
let _delayedAuctions = [];

/**
 * @summary Each auction can have differing floors data depending on execution time or per adunit setup
 * So we will be saving each auction offset by it's auctionId in order to make sure data is not changed
 * Once the auction commences
 */
let _floorDataForAuction = {};

/**
 * @summary Simple function to round up to a certain decimal degree
 */
function roundUp(number, precision) {
  return Math.ceil(number * Math.pow(10, precision)) / Math.pow(10, precision);
}

/**
 * @summary Uses the adUnit's code in order to find a matching gptSlot on the page
 */
export function getGptSlotInfoForAdUnit(adUnitCode) {
  let matchingSlot;
  if (window.googletag && window.googletag.apiReady) {
    // find the first matching gpt slot on the page
    matchingSlot = window.googletag.pubads().getSlots().find(slot => {
      return (adUnitCode === slot.getAdUnitPath() || adUnitCode === slot.getSlotElementId())
    });
  }
  if (matchingSlot) {
    return {
      gptSlot: matchingSlot.getAdUnitPath(),
      divId: matchingSlot.getSlotElementId()
    }
  }
  utils.logError(`${MODULE_NAME}: The GPT API must be ready and slots defined when using 'gptSlot' as one of the floor fields`);
  return {};
};

/**
 * @summary floor field types with their matching functions to resolve the actual matched value
 */
const fieldMatchingFunctions = {
  'gptSlot': bidObject => getGptSlotInfoForAdUnit(bidObject.adUnitCode).gptSlot,
  'domain': () => window.location.hostname,
  'adUnitCode': bidObject => bidObject.adUnitCode
};

/**
 * @summary Based on the fields array in floors data, it enumerates all possible matches based on exact match coupled with
 * a "*" catch-all match
 * Returns array of Tuple [exact match, catch all] for each field in rules file
 */
export function enumeratePossibleFieldValues(floorData, bidObject, mediaType, size) {
  // enumerate possible matches
  size = utils.parseGPTSingleSizeArray(size) || '*';

  return floorData.schema.fields.reduce((accum, field) => {
    let exactMatch;
    if (field === 'size') {
      exactMatch = size;
    } else if (field === 'mediaType') {
      exactMatch = mediaType;
    } else {
      exactMatch = fieldMatchingFunctions[field](bidObject);
    }
    // storing exact matches as lowerCase since we want to compare case insensitively
    accum.push([exactMatch.toLowerCase(), '*']);
    return accum;
  }, []);
};

/**
 * @summary get's the first matching floor based on context provided.
 * Generates all possible rule matches and picks the first matching one.
 */
export function getFirstMatchingFloor(floorData, bidObject, mediaType, size) {
  let fieldValues = enumeratePossibleFieldValues(floorData, bidObject, mediaType, size);
  if (!fieldValues) return { matchingFloor: floorData.default };
  let allPossibleMatches = generatePossibleEnumerations(fieldValues, floorData.delimiter);
  let matchingRule = allPossibleMatches.find(hashValue => floorData.values.hasOwnProperty(hashValue));

  return {
    matchingFloor: floorData.values[matchingRule] || floorData.default,
    matchingData: allPossibleMatches[0] // the first possible match is an "exact" so contains all data relevant for anlaytics adapters
  }
};

/**
 * @summary Generates all possible rule hash's based on input array of array's
 */
export function generatePossibleEnumerations(arrayOfFields, delimiter) {
  return arrayOfFields.reduce((accum, currentVal) => {
    let ret = [];
    accum.map(obj => {
      currentVal.map(obj1 => {
        ret.push(obj + delimiter + obj1)
      });
    });
    return ret;
  });
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
      floorInfo.matchingFloor = this.convertCurrency(floorInfo.matchingFloor, floorData.data.currency, currency);
    } catch (err) {
      utils.logWarn(`${MODULE_NAME}: Unable to get currency conversion for getFloor for bidder ${this.bidder}. You must have currency module enabled with addBidRequestHook enabled and at least have defaultRates in your currency config`);
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
      floor: roundUp(parseFloat(parseFloat(floorInfo.matchingFloor).toFixed(5)), 4),
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
  auctionFloorData.delimiter = floorData.delimiter || '|';
  auctionFloorData.values = convertRulesToHash(auctionFloorData, adUnitCode);
  // default the currency to USD if not passed in
  auctionFloorData.currency = auctionFloorData.currency || 'USD';
  return auctionFloorData;
};

/**
 * @summary Flattens the provided values array into an object with {KEY: FLOOR}
 */
export function convertRulesToHash(floorData, adUnitCode) {
  let fields = floorData.schema.fields;
  let delimiter = floorData.delimiter

  // if we are building the floor data form an ad unit, we need to append adUnit code as to not cause collisions
  let prependAdUnit = adUnitCode && !fields.includes('adUnitCode') && fields.unshift('adUnitCode');
  return floorData.values.reduce((rulesHash, rule) => {
    let key = rule.key;
    if (prependAdUnit) {
      key = `${adUnitCode}${delimiter}${key}`;
    }
    // we store the rule keys as lower case for case insensitive compare
    rulesHash[key.toLowerCase()] = rule.floor;
    return rulesHash;
  }, {});
};

/**
 * @summary This function takes the adUnits for the auction and update them accordingly as well as returns the rules hashmap for the auction
 */
export function updateAdUnitsForAuction(adUnits) {
  let newRules;
  let resolvedFloorsData = utils.deepClone(_floorsConfig);
  resolvedFloorsData.skipped = false;

  // if we do not have a floors data set, we will try to use data set on adUnits
  let useAdUnitData = (utils.deepAccess(resolvedFloorsData, 'data.values') || []).length === 0;
  adUnits.forEach((adUnit, index) => {
    // add getFloor to each bid
    adUnit.bids.forEach(bid => {
      // allows getFloor to have context of the bidRequestObj
      bid.getFloor = getFloor;
      // information for bid and analytics adapters
      bid.floorData = {
        skipped: false,
        modelVersion: utils.deepAccess(resolvedFloorsData, 'data.modelVersion') || '',
        location: useAdUnitData ? 'adUnit' : resolvedFloorsData.location,
      }
    });

    // if we need to generate floors data from adUnit do it
    if (useAdUnitData) {
      if (isFloorsDataValid(adUnit.floors)) {
        // if values already exist we want to not overwrite them
        if (index === 0) {
          resolvedFloorsData.data = getFloorsDataForAuction(adUnit.floors, adUnit.code);
        } else {
          newRules = getFloorsDataForAuction(adUnit.floors, adUnit.code).values;
          Object.assign(resolvedFloorsData.data.values, newRules);
        }
      }
    }
  });
  if (!useAdUnitData) {
    resolvedFloorsData.data = getFloorsDataForAuction(resolvedFloorsData.data);
  }
  return resolvedFloorsData;
};

/**
 * @summary Updates the adUnits accordingly and returns the necessary floorsData for the current auction
 */
export function createFloorsDataForAuction(adUnits) {
  // determine the skip rate now
  const skipRate = utils.deepAccess(_floorsConfig, 'data.skipRate') || _floorsConfig.skipRate || 0;
  if (Math.random() * 100 < skipRate) {
    // loop through adUnits and remove getFloor if it's there (re-used adUnits scenario) and add floor info
    adUnits.forEach(adUnit => {
      adUnit.bids.forEach(bid => {
        bid.floorData = {
          skipped: true,
          modelVersion: utils.deepAccess(_floorsConfig, 'data.modelVersion') || '',
          location: _floorsConfig.location
        };
        delete bid.getFloor;
      });
    });
    return {
      skipped: true
    };
  }
  // else we are flooring
  return updateAdUnitsForAuction(adUnits);
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

function isValidRule(rule, numFields, delimiter) {
  if (typeof rule !== 'object') {
    return false
  }
  if (typeof rule.key !== 'string' || rule.key.split(delimiter).length !== numFields) {
    return false;
  }
  return typeof rule.floor === 'number';
};

function validateRules(rules, numFields, delimiter) {
  if (!Array.isArray(rules)) {
    return false;
  }
  rules = rules.filter(rule => isValidRule(rule, numFields, delimiter));
  return rules.length > 0;
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
  return validateRules(floorsData.values, floorsData.schema.fields.length, floorsData.delimiter || '|')
};

/**
 * This function updates the global Floors Data field based on the new one passed in
 */
export function updateGlobalFloorsData(floorsData, location) {
  if (floorsData && typeof floorsData === 'object' && isFloorsDataValid(floorsData)) {
    _floorsConfig.data = floorsData;
    _floorsConfig.location = location;
  } else {
    utils.logError(`${MODULE_NAME}: The floors data did not contain correct values`, floorsData);
  }
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
  updateGlobalFloorsData(floorResponse, 'fetch');

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
export function generateAndHandleFetch(floorsConfig) {
  // if a fetch url is defined and one is not already occuring, fire it!
  if (utils.deepAccess(floorsConfig, 'endpoint.url') && !fetching) {
    // default to GET and we only support GET for now
    let requestMethod = utils.deepAccess(floorsConfig, 'endpoint.method') || 'GET';
    if (requestMethod !== 'GET') {
      utils.logError(`${MODULE_NAME}: 'GET' is the only request method supported at this time!`);
    } else {
      ajax(floorsConfig.endpoint.url, { success: handleFetchResponse, error: handleFetchError }, null, { method: 'GET' });
      fetching = true;
    }
  } else if (fetching) {
    utils.logWarn(`${MODULE_NAME}: A fetch is already occuring. Skipping.`);
  }
};

/**
 * @summary This is the function which controls what happens during a pbjs.setConfig({...floors: {}}) is called
 */
function handleSetFloorsConfig(newFloorsConfig) {
  // Update our internal top level config with the passed in config
  Object.assign(_floorsConfig, newFloorsConfig); // TODO: this is temp for testing will expand later

  // only update the floorsData if something is not fetching
  if (!fetching && newFloorsConfig.data) {
    updateGlobalFloorsData(newFloorsConfig.data, 'setConfig');
  }
  // handle the floors fetch
  generateAndHandleFetch(newFloorsConfig);

  if (!addedFloorsHook) {
    // register hooks / listening events
    // when auction finishes remove it's associated floor data
    events.on(CONSTANTS.EVENTS.AUCTION_END, (args) => delete _floorDataForAuction[args.auctionId]);

    // we want our hooks to run after the currency hooks
    getGlobal().requestBids.before(requestBidsHook, 1);
    getHook('addBidResponse').before(addBidResponseHook, 1);
    addedFloorsHook = true;
  }
};

function addFloorDataToBid(floorData, floorInfo, bid, adjustedCpm) {
  bid.floorData = {
    floorEnforced: floorInfo.matchingFloor,
    adjustedCpm
  }
  floorData.data.schema.fields.forEach((field, index) => {
    let matchedValue = floorInfo.matchingData.split(floorData.data.delimiter)[index];
    bid.floorData[field] = matchedValue;
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
  const matchingBidRequest = this.bidderRequest.bids.find(bidRequest => bidRequest.bidId === bid.requestId);
  let floorInfo = getFirstMatchingFloor(floorData.data, matchingBidRequest, mediaType, size);

  if (!floorInfo.matchingFloor) {
    utils.logWarn(`${MODULE_NAME}: unable to determine a matching price floor for bidResponse ${bid}`);
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
    flooredBid.status = 'floorNotMet';
    // if floor not met update bid with 0 cpm so it is not included downstream and marked as no-bid
    flooredBid.cpm = 0;
    return fn.call(this, adUnitCode, flooredBid);
  }
  return fn.call(this, adUnitCode, bid);
}

config.getConfig('floors', config => handleSetFloorsConfig(config.floors));

/// // TEMP TESTING CODE //////
// Function which generates a floors data rules combinations with a bunch of differing floors
function tempTestCode () {
  let arrayOfFields = [
    ['/112115922/HB_QA_Tests', '/112115922/HB_QA_Tests-hello', '*'],
    ['banner', 'video', '*'],
    ['300x250', '728x90', '640x480', '*'],
    ['cnn.com', 'rubitest.com', '*'],
  ];

  let combos = arrayOfFields.reduce((accum, currentVal) => {
    let ret = [];
    accum.map(obj => {
      currentVal.map(obj_1 => {
        ret.push(obj + '|' + obj_1)
      });
    });
    return ret;
  });

  let values = combos.reduce((accum, hashThing) => {
    let objectThing = {
      key: hashThing,
      floor: accum.length + 0.01
    };
    accum.push(objectThing);
    return accum;
  }, []);

  console.log(JSON.stringify(values));
}
