/**
 * @file apiRubicon (apiRubicon) adapter
 */

import { getBidRequest } from '../utils.js';

var CONSTANTS = require('../constants.json');
var utils = require('../utils.js');
var bidmanager = require('../bidmanager.js');
var bidfactory = require('../bidfactory.js');

var apiRubiconAdapter;
apiRubiconAdapter = function RubiconAdapter() {

  var sizeMap = {
    1:'468x60',
    2:'728x90',
    8:'120x600',
    9:'160x600',
    10:'300x600',
    15:'300x250',
    16:'336x280',
    43:'320x50',
    44:'300x50',
    54:'300x1050',
    55:'970x90',
    57:'970x250',
    58:'1000x90',
    59:'320x80',
    65:'640x480',
    67:'320x480',
    68:'1800x1000',
    72:'320x320',
    73:'320x160',
    101:'480x320',
    102:'768x1024',
    113:'1000x300',
    117:'320x100',
    125:'800x250',
    126:'200x600',
    '468x60': 1,
    '728x90': 2,
    '120x600': 8,
    '160x600': 9,
    '300x600': 10,
    '300x250': 15,
    '336x280': 16,
    '320x50': 43,
    '300x50': 44,
    '300x1050': 54,
    '970x90': 55,
    '970x250': 57,
    '1000x90': 58,
    '320x80': 59,
    '640x480': 65,
    '320x480': 67,
    '1800x1000': 68,
    '320x320': 72,
    '320x160': 73,
    '480x320': 101,
    '768x1024': 102,
    '1000x300': 113,
    '320x100': 117,
    '800x250': 125,
    '200x600': 126
  };

  function _callBids(params) {

    var bids = params.bids || [];

    function xhr(bidderUrl, callbackId) {
      var xhttp = new XMLHttpRequest();
      xhttp.onreadystatechange = function() {
        if (this.readyState === 4 && this.status === 200) {
          handleRpCB(this.responseText, callbackId);
        }
      };
      xhttp.open('GET', bidderUrl, true);
      xhttp.send();
    }

    for (var i = 0; i < bids.length; i++) {
      var bidRequest = bids[i];
      var callbackId = bidRequest.bidId;

      xhr(buildOptimizedCall(bidRequest), callbackId);
    }
  }

  function buildOptimizedCall(bid) {

    var accountId = utils.getBidIdParamater('accountId', bid.params);
    var siteId = utils.getBidIdParamater('siteId', bid.params);
    var zoneId = utils.getBidIdParamater('zoneId', bid.params);
    var position = utils.getBidIdParamater('position', bid.params) || 'btf';
    var keyword = utils.getBidIdParamater('keyword', bid.params);
    var visitor = utils.getBidIdParamater('visitor', bid.params);
    var inventory = utils.getBidIdParamater('inventory', bid.params);

    //build our base tag, based on if we are http or https
    var optimizedCall = 'http' + (document.location.protocol === 'https:' ? 's:' : ':')  + '//optimized-by.rubiconproject.com/a/api/fastlane.json?';

    optimizedCall = utils.tryAppendQueryString(optimizedCall, 'account_id', accountId);
    optimizedCall = utils.tryAppendQueryString(optimizedCall, 'site_id', siteId);
    optimizedCall = utils.tryAppendQueryString(optimizedCall, 'zone_id', zoneId);
    optimizedCall = utils.tryAppendQueryString(optimizedCall, 'rf', utils.getTopWindowUrl());
    optimizedCall = utils.tryAppendQueryString(optimizedCall, 'p_pos', position);
    optimizedCall = utils.tryAppendQueryString(optimizedCall, 'kw', keyword);

    if (visitor && typeof visitor === 'object') {
      for (var vkey in visitor) {
        if (visitor.hasOwnProperty(vkey)) {
          if (visitor[vkey] && (typeof visitor[vkey] === 'string' || typeof visitor[vkey] === 'number' || typeof visitor[vkey] === 'boolean')) {
            optimizedCall = utils.tryAppendQueryString(optimizedCall, 'tg_v.'+vkey, visitor[vkey]);
          }
        }
      }
    }

    if (inventory && typeof inventory === 'object') {
      for (var ikey in inventory) {
        if (inventory.hasOwnProperty(ikey)) {
          if (inventory[ikey] && (typeof inventory[ikey] === 'string' || typeof inventory[ikey] === 'number' || typeof inventory[ikey] === 'boolean')) {
            optimizedCall = utils.tryAppendQueryString(optimizedCall, 'tg_v.'+ikey, inventory[ikey]);
          }
        }
      }
    }

    optimizedCall = utils.tryAppendQueryString(optimizedCall, 'rp_floor', '0.01');
    optimizedCall = utils.tryAppendQueryString(optimizedCall, 'tk_flint', '$$PREBID_GLOBAL$$.api');
    optimizedCall = utils.tryAppendQueryString(optimizedCall, 'cb', Math.random());

    //sizes takes a bit more logic
    var sizeQueryString = '';
    var parsedSizes = utils.parseSizesInput(bid.sizes);

    //combine string into proper querystring
    var parsedSizesLength = parsedSizes.length;
    if (parsedSizesLength > 0) {
      //first value should be "size"
      sizeQueryString = 'size_id=' + sizeMap[parsedSizes[0]];
      if (parsedSizesLength > 1) {
        //any subsequent values should be "alt_size_ids"
        sizeQueryString += '&alt_size_ids=';
        for (var j = 1; j < parsedSizesLength; j++) {
          sizeQueryString += sizeMap[parsedSizes[j]] + ',';
        }

        //remove trailing comma
        if (sizeQueryString && sizeQueryString.charAt(sizeQueryString.length - 1) === ',') {
          sizeQueryString = sizeQueryString.slice(0, sizeQueryString.length - 1);
        }
      }
    }

    if (sizeQueryString) {
      optimizedCall += sizeQueryString + '&';
    }

    //remove the trailing "&"
    if (optimizedCall.lastIndexOf('&') === optimizedCall.length - 1) {
      optimizedCall = optimizedCall.substring(0, optimizedCall.length - 1);
    }

    // @if NODE_ENV='debug'
    utils.logMessage('optimized request built: ' + optimizedCall);

    // @endif

    //append a timer here to track latency
    bid.startTime = new Date().getTime();

    return optimizedCall;

  }

  function _renderCreative(script) {

    return '<html>\n' +
           '<head>\n' +
           '<scr' + 'ipt type=\'text\/javascript\'>' +
           'inDapIF=true;\n' +
           '<' + '/scr' + 'ipt>\n' +
           '<\/head>\n' +
           '<body style=\'margin : 0; padding: 0;\'>\n' +
           '<!-- Rubicon Project Ad Tag -->\n' +
           '<scr' + 'ipt type=\'text\/javascript\'>\n' +
           ''+ script + '' +
           '<' + '/scr' + 'ipt>\n' +
           '<\/body>\n' +
           '<\/html>';
  }

  //expose the callback to the global object:
  function handleRpCB(optimizedResponseObj, callbackId) {

    var bidCode;
    optimizedResponseObj = JSON.parse(optimizedResponseObj);

    if (optimizedResponseObj && optimizedResponseObj.status === 'ok') {
      var id = callbackId;
      var placementCode = '';
      var bidObj = getBidRequest(id);
      var optimizedAdObj = optimizedResponseObj.ads[0];

      if (bidObj) {
        bidCode = bidObj.bidder;
        placementCode = bidObj.placementCode;

        //set the status
        bidObj.status = CONSTANTS.STATUS.GOOD;
      }

      if (optimizedAdObj.status === 'ok') {
        var responseCPM;

        // @if NODE_ENV='debug'
        utils.logMessage('XHR callback function called for ad ID: ' + id);

        // @endif
        var bid = [];
        if (optimizedAdObj.cpm && optimizedAdObj.cpm !== 0) {
          responseCPM = optimizedAdObj.cpm;

          //store bid response
          //bid status is good (indicating 1)
          var adId = optimizedAdObj.ad_id;
          bid = bidfactory.createBid(1);
          bid.creative_id = adId;
          bid.bidderCode = bidCode;
          bid.cpm = responseCPM;
          bid.ad = _renderCreative(optimizedAdObj.script);
          bid.width = sizeMap[optimizedAdObj.size_id].split('x')[0];
          bid.height = sizeMap[optimizedAdObj.size_id].split('x')[1];
          bid.dealId = optimizedResponseObj.deal;

          bidmanager.addBidResponse(placementCode, bid);

        } else {
          //no response data
          // @if NODE_ENV='debug'
          utils.logMessage('No prebid response from apiRubicon for placement code ' + placementCode);

          // @endif
          //indicate that there is no bid for this placement
          bid = bidfactory.createBid(2);
          bid.bidderCode = bidCode;
          bidmanager.addBidResponse(placementCode, bid);
        }

      } else {
        //no response data
        // @if NODE_ENV='debug'
        utils.logMessage('No prebid response for placement ' + placementCode);

        // @endif

      }
    }
  }

  return {
    callBids: _callBids
  };
};

module.exports = apiRubiconAdapter;