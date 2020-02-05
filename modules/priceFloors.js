import { getGlobal } from '../src/prebidGlobal';
import { config } from '../src/config.js';
import * as utils from '../src/utils';
import { ajaxBuilder } from '../src/ajax';
import events from '../src/events';
import CONSTANTS from '../src/constants.json';
import { getHook } from '../src/hook.js';

/**
 * This Module is intended to provide users with the ability to
 * dynamically set and enforce price floors on a per auction basis.
 */
const MODULE_NAME = 'Price Floors';

/**
 * Our own implementation of Ajax so we control the timeout TODO: Change to 5000 before PR
 */
const ajax = ajaxBuilder(10000);

/**
 * @property
 * @summary Allowed fields for rules to have
 * @name allowedFields
 * @type {Array}
 */
let allowedFields = ['gptSlot', 'adUnitCode', 'size', 'domain', 'mediaType'];

/**
 * @property
 * @summary This is a flag to indicate if a AJAX call is processing for a floors request
 * @name fetching
 * @type {Boolean}
 */
let fetching = false;

let addedFloorsHook = false;

/**
 * @property
 * @summary The config to be used. Can be updated via: setConfig or a real time fetch
 * @name _floorsConfig
 * @type {Object}
 */
let _floorsConfig = {
  auctionDelay: 0,
  enforcement: { // enforcement flags which alter the way price floors will be enforced or not
    enforceJS: true, // Wether to enforce the derived floor per bidResponse or ignore
    enforcePBS: false, // Sends a flag to PBS which has it do flooring on the server
    floorDeals: false, // Signals if bidResponses containing dealId's are adherendt to flooring
    bidAdjustment: false, // Signals wether the getFloors function should take into account the bidders CPM Adjustment when returning a floor value
  },
  skipRate: 0, // The percentage of the time we will skip running floors module per auction (0-100)
  data: { // The actual floors data to be used. See test/spec/modules/priceFloorsSchema.json for more detail
    currency: 'USD',
    delimiter: '|',
    schema: {
      fields: [],
    },
    values: [],
  },
};

/**
 * @property
 * @summary If a auction is to be delayed by an ongoing fetch we hold it here until it can be resumed
 * @name _delayedAuctions
 * @type {Array}
 */
let _delayedAuctions = [];

/**
 * @property
 * @summary Each auction can have differing floors data depending on execution time or per adunit setup
 * So we will be saving each auction offset by it's auctionId in order to make sure data is not changed
 * Once the auction commences
 * @name _floorsConfig
 * @type {Object}
 */
let _floorDataForAuction = {};

/**
 * Simple function to round up to a certain decimal degree
 * @param {*} number The number / float to round
 * @param {*} precision How many decimal points
 */
function roundUp(number, precision) {
  return Math.ceil(number * Math.pow(10, precision)) / Math.pow(10, precision);
}

/**
 * Uses the adUnit's code in order to find a matching gptSlot on the page
 */
export function getGptSlotInfoForAdUnit(adUnit) {
  let matchingSlot;
  if (window.googletag && window.googletag.apiReady) {
    // find the first matching gpt slot on the page
    matchingSlot = window.googletag.pubads().getSlots().find(slot => {
      return (adUnit.adUnitCode === slot.getAdUnitPath() || adUnit.adUnitCode === slot.getSlotElementId())
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
 * floor field types with their matching functions to resolve the actual matched value
 */
const fieldMatchingFunctions = {
  'gptSlot': adUnit => getGptSlotInfoForAdUnit(adUnit).gptSlot,
  'domain': () => window.location.hostname,
  'adUnitCode': (adUnit) => adUnit.adUnitCode
};

/**
 * Based on the fields array in floors data, it enumerates all possible matches based on exact match coupled with
 * a "*" catch-all match
 * Returns array of Tuple [exact match, catch all] for each field in rules file
 */
export function enumeratePossibleFieldValues(floorData, adUnit, requestParams = {}) {
  // enumerate possible matches
  let mediaType = requestParams.mediaType || 'banner';
  let size = utils.parseGPTSingleSizeArray(requestParams.size) || '*';

  return floorData.schema.fields.reduce((accum, field) => {
    let exactMatch;
    if (field === 'size') {
      exactMatch = size;
    } else if (field === 'mediaType') {
      exactMatch = mediaType;
    } else {
      exactMatch = fieldMatchingFunctions[field](adUnit);
    }
    // storing exact matches as lowerCase since we want to compare case insensitively
    accum.push([exactMatch.toLowerCase(), '*']);
    return accum;
  }, []);
};

/**
 *
 */
export function getFirstMatchingFloor(floorData, adUnit, requestParams) {
  let fieldValues = enumeratePossibleFieldValues(floorData, adUnit, requestParams);
  if (!fieldValues) return { matchingFloor: floorData.default };
  let allPossibleMatches = generatePossibleEnumerations(fieldValues, floorData.delimiter);
  let matchingRule = allPossibleMatches.find(hashValue => floorData.rules.hasOwnProperty(hashValue));

  return {
    matchingFloor: floorData.rules[matchingRule] || floorData.default,
    matchingData: allPossibleMatches[0] // the first possible match is an "exact" so contains all data relevant for anlaytics adapters
  }
};

/**
 *
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
 * If a the input bidder has a registered cpmadjustment it returns the input CPM after being adjusted
 */
export function getBiddersCpmAdjustment(bidderName, inputCpm) {
  const adjustmentFunction = utils.deepAccess(getGlobal(), `bidderSettings.${bidderName}.bidCpmAdjustment`);
  if (adjustmentFunction) {
    return adjustmentFunction(inputCpm);
  }
  return inputCpm;
};

/**
 * This function takes the origional floor and the adjusted floor in order to determine the bidders actual floor
 */
export function calculateAdjustedFloor(oldFloor, newFloor) {
  return oldFloor / newFloor * oldFloor;
};

/**
 * If enforecePBS is on, then we need to pass along the floors data in the PBS call
 * Including some special translation to fit the PBS Floor API
 */
function updateFloorDataForPBS(floorData) {
  // ugh do stuff
  // if gptSlot do magic stuff
  // convert adUnitCode to imp.id
  // convert imp.mediaType to imp.mediaType
  return floorData;
};

/**
 * This is the function which will return a single floor based on the input requests
 * and matching it to a rule for the current auction
 * @param {object} requestParams The params for adapters to select specific
 */
export function getFloor(requestParams = {}) {
  let floorData = _floorDataForAuction[this.auctionId];

  if (floorData.skipped) {
    return {};
  } else if (this.src === 's2s') {
    return updateFloorDataForPBS(floorData);
  }

  let floorInfo = getFirstMatchingFloor(floorData.data, this, requestParams);

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
      floor: roundUp(parseFloat(floorInfo.matchingFloor), 4),
      currency,
    };
  }
  return {};
};

/**
 * Takes a floorsData object and converts it into a hash map with appropriate keys
 * @param {*} floorData The floors data to use
 * @param {*} adUnit The ad unit to build the floor data from (if not defined using top level data)
 */
export function getFloorsDataForAuction(floorData, adUnitCode) {
  let auctionFloorData = utils.deepClone(floorData);
  auctionFloorData.delimiter = floorData.delimiter || '|';
  auctionFloorData.rules = convertRulesToHash(auctionFloorData, adUnitCode);
  // default the currency to USD if not passed in
  auctionFloorData.currency = auctionFloorData.currency || 'USD';
  return auctionFloorData;
};

export function convertRulesToHash(floorData, adUnitCode) {
  let fields = floorData.schema.fields;
  let delimiter = floorData.delimiter

  // if we are building the floor data form an ad unit, we need to append adUnit code as to not cause collisions
  let prependAdUnit = adUnitCode && !fields.includes('adUnitCode') && fields.unshift('adUnitCode');
  return floorData.values.reduce((rulesHash, rule) => {
    // filter out any rule which does not match correct domain?
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
 * This function takes the adUnits for the auction and update them accordingly as well as returns the rules hashmap
 * @param {object} adUnits The adUnits for this auction
 */
export function updateAdUnitsForAuction(adUnits) {
  let resolvedFloorsData = utils.deepClone(_floorsConfig);
  resolvedFloorsData.skipped = false;

  // if we do not have a floors data set, we will try to use data set on adUnits
  let useAdUnitData = (utils.deepAccess(_floorsConfig, 'data.values') || []).length === 0;

  adUnits.forEach((adUnit, index) => {
    // add getFloor to each bid
    adUnit.bids.forEach(bid => {
      // allows getFloor to have context of the bidRequestObj
      bid.getFloor = getFloor;
      // information for bid and analytics adapters
      bid.floorData = {
        skipped: false,
        modelVersion: utils.deepAccess(_floorsConfig, 'data.modelVersion') || _floorsConfig.modelVersion || '',
        location: useAdUnitData ? 'adUnit' : _floorsConfig.location,
      }
    });

    // if we need to generate floors data from adUnit do it
    if (useAdUnitData) {
      if (isFloorsDataValid(adUnit.floors)) {
        // if values already exist we want to not overwrite them
        if (index === 0) {
          resolvedFloorsData.data = getFloorsDataForAuction(adUnit.floors, adUnit.code);
        } else {
          let newRules = getFloorsDataForAuction(adUnit.floors, adUnit.code).rules;
          Object.assign(resolvedFloorsData.data.rules, newRules);
        }
      }
    }
  });
  if (!useAdUnitData) {
    resolvedFloorsData.data = getFloorsDataForAuction(_floorsConfig.data);
  }
  return resolvedFloorsData;
};

function shouldSkipFloors(skipRate) {
  var rndWeight = Math.random() * 100;
  return rndWeight < skipRate;
};

/**
 * This function takes the global floors data and filters it down into a new floors object
 * for the current auction. It filters the floors data into adUnit level grains while also
 * filtering out any floor rules which do not apply to the ad unit
 * @param {object} adUnits The adUnits for this auction
 */
export function createFloorsDataForAuction(adUnits) {
  // determine the skip rate now
  const skipRate = utils.deepAccess(_floorsConfig, 'data.skipRate') || _floorsConfig.skipRate || 0;
  if (shouldSkipFloors(skipRate)) {
    // loop through adUnits and remove getFloor if it's there and add floor info
    adUnits.forEach(adUnit => {
      adUnit.bids.forEach(bid => bid.floorData = {
        skipped: true,
        modelVersion: utils.deepAccess(_floorsConfig, 'data.modelVersion') || _floorsConfig.modelVersion || '',
        location: _floorsConfig.location
      });
    });
    return {
      skipped: true
    };
  }
  // default stuff that is necessary no matter what
  return updateAdUnitsForAuction(adUnits);
};

/**
 * This is the function which will be called to exit our module and
 * continue the auction.
 */
export function continueAuction(hookConfig) {
  // only run if hasExited
  if (!hookConfig.hasExited) {
    // if this current auction is still fetching, remove it from the _delayedAuctions
    _delayedAuctions = _delayedAuctions.filter(auctionConfig => auctionConfig.timer !== hookConfig.timer);

    // We need to know the auctionId at this time. So we will use the passed in one or generate and set it ourselves
    let reqBidsConfigObj = hookConfig.reqBidsConfigObj;
    reqBidsConfigObj.auctionId = reqBidsConfigObj.auctionId || utils.generateUUID();

    // now we do what we need to with adUnits and save the data object to be used for getFloor and enforcement calls
    _floorDataForAuction[reqBidsConfigObj.auctionId] = createFloorsDataForAuction(reqBidsConfigObj.adUnits || getGlobal().adUnits);

    hookConfig.nextFn.apply(hookConfig.context, [reqBidsConfigObj]);
    hookConfig.hasExited = true;
  }
};

/**
 * If any of the passed fields are not allowed, returns false
 * @param {object} fields The fields for the schema in question
 */
export function validateSchemaFields(fields) {
  if (Array.isArray(fields) && fields.every(field => allowedFields.includes(field))) {
    return true;
  }
  utils.logError(`${MODULE_NAME}: Fields recieved do not match allowed fields`);
  return false;
};

/**
 * Each rule in the values array should have a 'key' and 'floor' param
 * And each 'key' should have the correct number of 'fields' after splitting
 * on the delim. If rule does not match remove it. return if still at least 1 rule
 * @param {object} fields The fields for the schema in question
 */
export function validateRules(rules, numFields, delimiter) {
  rules = rules.filter(rule => rule.key && rule.floor && rule.key.split(delimiter).length === numFields);
  return rules.length > 0;
};

/**
 * This function validates that the passed object is a valid floors data object according to the schema
 * See test/spec/modules/priceFloorsSchema.json for more detail
 */
export function isFloorsDataValid(floorsData) {
  let fields = utils.deepAccess(floorsData, 'schema.fields');
  let rules = floorsData.values;
  // schema.fields has only allowed attributes
  if (!validateSchemaFields(fields)) {
    return false;
  }

  if (!validateRules(rules, fields.length, floorsData.delimiter || '|')) {
    return false;
  }
  return true;
};

/**
 * This function updates the global Floors Data field based on the new one passed in
 * It will only overwrite it if the passed in object is valid
 * @param {object} floorsData The floors data
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
      ajax(
        floorsConfig.endpoint.url,
        {
          success: handleFetchResponse,
          error: handleFetchError
        },
        null,
        {
          method: 'GET'
        }
      );
      fetching = true;
    }
  } else if (fetching) {
    utils.logWarn(`${MODULE_NAME}: A fetch is already occuring. Skipping.`);
  }
};

/**
 * This is the function which controls what happens during a pbjs.setConfig({...floors: {}}) is called
 * @param {object} newFloorsConfig The floors config which the user passed in
 */
function handleSetFloorsConfig(newFloorsConfig) {
  // Update our internal config with the passed in config
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

export function getMatchingBidRequestForResponse(bidderRequest, bidResponse) {
  return bidderRequest.bids.find(bidRequest => bidRequest.bidId === bidResponse.requestId);
}

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

export function addBidResponseHook(fn, adUnitCode, bid) {
  let floorData = _floorDataForAuction[this.bidderRequest.auctionId];

  // if no floorData or it was skipped then just continue
  if (!floorData || floorData.skipped) {
    return fn.call(this, adUnitCode, bid);
  }

  // get the matching rule
  let mediaType = bid.mediaType || 'banner';
  let size = [bid.width, bid.height];
  const matchingBidRequest = getMatchingBidRequestForResponse(this.bidderRequest, bid)
  let floorInfo = getFirstMatchingFloor(floorData.data, matchingBidRequest, {mediaType, size});

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
    adjustedCpm = bid.getCpmInNewCurrency(floorData.data.currency.toUpperCase());
  }

  adjustedCpm = parseFloat(adjustedCpm);
  // add floor data to bid for analytics adapters to use
  addFloorDataToBid(floorData, floorInfo, bid, adjustedCpm);

  // now do the compare!
  if (!floorData.enforcement.enforceJS && ((adjustedCpm < floorInfo.matchingFloor) && (floorData.enforcement.floorDeals || !bid.dealId))) {
    // bid fails floor set! throw it out
    // add floorInfo onto bid object
    // emit floorNotMet event
    bid.status = 'floorNotMet';
    // if floor not met update bid with adjustedCpm
    bid.cpm = adjustedCpm;
    events.emit(CONSTANTS.EVENTS.FLOOR_NOT_MET, bid);
    return;
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
