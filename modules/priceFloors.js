import { getGlobal } from '../src/prebidGlobal.js';
import { config } from '../src/config.js';
import * as utils from '../src/utils.js';
import { ajaxBuilder } from '../src/ajax.js';
import events from '../src/events.js';
import CONSTANTS from '../src/constants.json';
import { getHook } from '../src/hook.js';
import { createBid } from '../src/bidfactory.js';
import find from 'core-js/library/fn/array/find.js';
import { parse as urlParse } from '../src/url.js';
import { getRefererInfo } from '../src/refererDetection.js';

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
export let allowedFields = ['gptSlot', 'adUnitCode', 'size', 'domain', 'mediaType'];

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

let referrerHostname;

function getHostNameFromReferer(referer) {
  referrerHostname = urlParse(referer).hostname;
  return referrerHostname;
};

/**
 * @summary floor field types with their matching functions to resolve the actual matched value
 */
export let fieldMatchingFunctions = {
  'gptSlot': bidObject => utils.getGptSlotInfoForAdUnitCode(bidObject.adUnitCode).gptSlot,
  'domain': () => referrerHostname || getHostNameFromReferer(getRefererInfo().referer),
  'adUnitCode': bidObject => bidObject.adUnitCode
};

/**
 * @summary Based on the fields array in floors data, it enumerates all possible matches based on exact match coupled with
 * a "*" catch-all match
 * Returns array of Tuple [exact match, catch all] for each field in rules file
 */
function enumeratePossibleFieldValues(floorFields, bidObject, mediaType, size) {
  // generate combination of all exact matches and catch all for each field type
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
  mediaType = mediaType || 'banner';
  size = utils.parseGPTSingleSizeArray(size) || '*';

  let fieldValues = enumeratePossibleFieldValues(utils.deepAccess(floorData, 'schema.fields') || [], bidObject, mediaType, size);
  if (!fieldValues.length) return { matchingFloor: floorData.default };
  let matchingInput = fieldValues.map(field => field[0]).join('-');
  // if we already have gotten the matching rule from this matching input then use it! No need to look again
  if (utils.deepAccess(floorData, `matchingInputs.${matchingInput}`)) {
    return floorData.matchingInputs[matchingInput];
  }
  let allPossibleMatches = generatePossibleEnumerations(fieldValues, utils.deepAccess(floorData, 'schema.delimiter') || '|');
  let matchingRule = find(allPossibleMatches, hashValue => floorData.values.hasOwnProperty(hashValue));

  let matchingData = {
    matchingFloor: floorData.values[matchingRule] || floorData.default,
    matchingData: allPossibleMatches[0], // the first possible match is an "exact" so contains all data relevant for anlaytics adapters
    matchingRule
  };
  // save for later lookup if needed
  utils.deepSetValue(floorData, `matchingInputs.${matchingInput}`, {...matchingData});
  return matchingData
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

const getMediaTypesSizes = {
  banner: (bid) => utils.deepAccess(bid, 'mediaTypes.banner.sizes') || [],
  video: (bid) => utils.deepAccess(bid, 'mediaTypes.video.playerSize') || [],
  native: (bid) => [utils.deepAccess(bid, 'mediaTypes.native.image.sizes')] || [],
}

/**
 * @summary This is the function which will return a single floor based on the input requests
 * and matching it to a rule for the current auction
 */
export function getFloor(requestParams = {currency: 'USD', mediaType: '*', size: '*'}) {
  let floorData = _floorDataForAuction[this.auctionId];
  if (!floorData || floorData.skipped) return {};

  // if adapter asks for *'s then we can do some logic to infer if we can get a more specific rule based on context of bid
  let mediaTypesOnBid = Object.keys(this.mediaTypes || {});
  // if there is only one mediaType then we can just use it
  if (requestParams.mediaType === '*' && mediaTypesOnBid.length === 1) {
    requestParams.mediaType = mediaTypesOnBid[0];
  }
  // if they asked for * size, but for the given mediaType there is only one size, we can just use it
  if (requestParams.size === '*' && mediaTypesOnBid.indexOf(requestParams.mediaType) !== -1 && getMediaTypesSizes[requestParams.mediaType] && getMediaTypesSizes[requestParams.mediaType](this).length === 1) {
    requestParams.size = getMediaTypesSizes[requestParams.mediaType](this)[0];
  }
  let floorInfo = getFirstMatchingFloor(floorData.data, this, requestParams.mediaType, requestParams.size);
  let currency = requestParams.currency || floorData.data.currency;

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
    floorInfo.matchingFloor = cpmAdjustment ? calculateAdjustedFloor(floorInfo.matchingFloor, cpmAdjustment) : floorInfo.matchingFloor;
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

function validateRules(floorsData, numFields, delimiter) {
  if (typeof floorsData.values !== 'object') {
    return false;
  }
  // if an invalid rule exists we remove it
  floorsData.values = Object.keys(floorsData.values).reduce((filteredRules, key) => {
    if (isValidRule(key, floorsData.values[key], numFields, delimiter)) {
      filteredRules[key] = floorsData.values[key];
    }
    return filteredRules
  }, {});
  // rules is only valid if at least one rule remains
  return Object.keys(floorsData.values).length > 0;
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
  return validateRules(floorsData, floorsData.schema.fields.length, floorsData.schema.delimiter || '|')
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
 * @summary Updates our allowedFields and fieldMatchingFunctions with the publisher defined new ones
 */
function addFieldOverrides(overrides) {
  Object.keys(overrides).forEach(override => {
    // we only add it if it is not already in the allowed fields and if the passed in value is a function
    if (allowedFields.indexOf(override) === -1 && typeof overrides[override] === 'function') {
      allowedFields.push(override);
      fieldMatchingFunctions[override] = overrides[override];
    }
  });
}

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
      'enforcePBS', enforcePBS => enforcePBS === true, // defaults to false
      'floorDeals', floorDeals => floorDeals === true, // defaults to false
      'bidAdjustment', bidAdjustment => bidAdjustment !== false, // defaults to true
    ]),
    'additionalSchemaFields', additionalSchemaFields => typeof additionalSchemaFields === 'object' && Object.keys(additionalSchemaFields).length > 0 ? addFieldOverrides(additionalSchemaFields) : undefined,
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
      // if user has debug on then we want to allow the debugging module to run before this, assuming they are testing priceFloors
      // debugging is currently set at 5 priority
      getHook('addBidResponse').before(addBidResponseHook, utils.debugTurnedOn() ? 4 : 50);
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
    floorValue: floorInfo.matchingFloor,
    floorRule: floorInfo.matchingRule,
    floorCurrency: floorData.data.currency,
    cpmAfterAdjustments: adjustedCpm,
    enforcements: {...floorData.enforcement},
    matchedFields: {}
  };
  floorData.data.schema.fields.forEach((field, index) => {
    let matchedValue = floorInfo.matchingData.split(floorData.data.schema.delimiter)[index];
    bid.floorData.matchedFields[field] = matchedValue;
  });
}

function shouldFloorBid(floorData, floorInfo, bid) {
  let enforceJS = utils.deepAccess(floorData, 'enforcement.enforceJS') !== false;
  let shouldFloorDeal = utils.deepAccess(floorData, 'enforcement.floorDeals') === true || !bid.dealId;
  let bidBelowFloor = bid.floorData.cpmAfterAdjustments < floorInfo.matchingFloor;
  return enforceJS && (bidBelowFloor && shouldFloorDeal);
}

export function addBidResponseHook(fn, adUnitCode, bid) {
  let floorData = _floorDataForAuction[this.bidderRequest.auctionId];
  // if no floor data or associated bidRequest then bail
  const matchingBidRequest = find(this.bidderRequest.bids, bidRequest => bidRequest.bidId && bidRequest.bidId === bid.requestId);
  if (!floorData || !bid || floorData.skipped || !matchingBidRequest) {
    return fn.call(this, adUnitCode, bid);
  }

  // get the matching rule
  let floorInfo = getFirstMatchingFloor(floorData.data, matchingBidRequest, bid.mediaType, [bid.width, bid.height]);

  if (!floorInfo.matchingFloor) {
    utils.logWarn(`${MODULE_NAME}: unable to determine a matching price floor for bidResponse`, bid);
    return fn.call(this, adUnitCode, bid);
  }

  // determine the base cpm to use based on if the currency matches the floor currency
  let adjustedCpm;
  let floorCurrency = floorData.data.currency.toUpperCase();
  let bidResponseCurrency = bid.currency || 'USD'; // if an adapter does not set a bid currency and currency module not on it may come in as undefined
  if (floorCurrency === bidResponseCurrency.toUpperCase()) {
    adjustedCpm = bid.cpm;
  } else if (bid.originalCurrency && floorCurrency === bid.originalCurrency.toUpperCase()) {
    adjustedCpm = bid.originalCpm;
  } else {
    try {
      adjustedCpm = getGlobal().convertCurrency(bid.cpm, bidResponseCurrency.toUpperCase(), floorCurrency);
    } catch (err) {
      utils.logError(`${MODULE_NAME}: Unable do get currency conversion for bidResponse to Floor Currency. Do you have Currency module enabled? ${bid}`);
      return fn.call(this, adUnitCode, bid);
    }
  }

  // ok we got the bid response cpm in our desired currency. Now we need to run the bidders CPMAdjustment function if it exists
  adjustedCpm = getBiddersCpmAdjustment(bid.bidderCode, adjustedCpm);

  // add necessary data information for analytics adapters / floor providers would possibly need
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
    flooredBid.status = CONSTANTS.BID_STATUS.BID_REJECTED;
    // if floor not met update bid with 0 cpm so it is not included downstream and marked as no-bid
    flooredBid.cpm = 0;
    utils.logWarn(`${MODULE_NAME}: ${flooredBid.bidderCode}'s Bid Response for ${adUnitCode} was rejected due to floor not met`, bid);
    return fn.call(this, adUnitCode, flooredBid);
  }
  return fn.call(this, adUnitCode, bid);
}

config.getConfig('floors', config => handleSetFloorsConfig(config.floors));
