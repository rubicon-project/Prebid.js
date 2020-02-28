import {expect} from 'chai';
import * as utils from 'src/utils.js';
import { getGlobal } from 'src/prebidGlobal.js';
import CONSTANTS from 'src/constants.json';
import {
  _floorDataForAuction,
  getFloorsDataForAuction,
  getFirstMatchingFloor,
  getFloor,
  handleSetFloorsConfig,
  requestBidsHook,
  isFloorsDataValid,
  addBidResponseHook
} from 'modules/priceFloors.js';

describe('the price floors module', function () {
  let logErrorSpy;
  let logWarnSpy;
  let sandbox;
  const basicFloorData = {
    modelVersion: 'basic model',
    currency: 'USD',
    schema: {
      delimiter: '|',
      fields: ['mediaType']
    },
    values: {
      'banner': 1.0,
      'video': 5.0,
      '*': 2.5
    }
  };
  const basicFloorConfig = {
    enabled: true,
    auctionDelay: 0,
    endpoint: {},
    enforcement: {
      enforceJS: true,
      enforcePBS: false,
      floorDeals: false,
      bidAdjustment: true
    },
    data: basicFloorData
  }
  const basicBidRequest = {
    bidder: 'rubicon',
    adUnitCode: 'test_div_1',
    auctionId: '1234-56-789',
  };

  function getAdUnitMock(code = 'adUnit-code') {
    return {
      code,
      mediaTypes: {banner: { sizes: [[300, 200], [300, 600]] }, native: {}},
      bids: [{bidder: 'someBidder'}, {bidder: 'someOtherBidder'}]
    };
  }
  beforeEach(function() {
    sandbox = sinon.sandbox.create();
    logErrorSpy = sinon.spy(utils, 'logError');
    logWarnSpy = sinon.spy(utils, 'logWarn');
  });

  afterEach(function() {
    handleSetFloorsConfig({enabled: false});
    sandbox.restore();
    utils.logError.restore();
    utils.logWarn.restore();
  });

  describe('getFloorsDataForAuction', function () {
    it('converts basic input floor data into a floorData map for the auction correctly', function () {
      // basic input where nothing needs to be updated
      expect(getFloorsDataForAuction(basicFloorData)).to.deep.equal(basicFloorData);

      // if cur and delim not defined then default to correct ones (usd and |)
      let inputFloorData = utils.deepClone(basicFloorData);
      delete inputFloorData.currency;
      delete inputFloorData.schema.delimiter;
      expect(getFloorsDataForAuction(inputFloorData)).to.deep.equal(basicFloorData);

      // should not use defaults if differing values
      inputFloorData.currency = 'EUR'
      inputFloorData.schema.delimiter = '^'
      let resultingData = getFloorsDataForAuction(inputFloorData);
      expect(resultingData.currency).to.equal('EUR');
      expect(resultingData.schema.delimiter).to.equal('^');
    });

    it('converts more complex floor data correctly', function () {
      let inputFloorData = {
        schema: {
          fields: ['mediaType', 'size', 'domain']
        },
        values: {
          'banner|300x250|prebid.org': 1.0,
          'video|640x480|prebid.org': 5.0,
          'banner|728x90|rubicon.com': 3.5,
          'video|600x300|appnexus.com': 3.5,
          '*|*|prebid.org': 3.5,
        }
      };
      let resultingData = getFloorsDataForAuction(inputFloorData);
      expect(resultingData).to.deep.equal({
        currency: 'USD',
        schema: {
          delimiter: '|',
          fields: ['mediaType', 'size', 'domain']
        },
        values: {
          'banner|300x250|prebid.org': 1.0,
          'video|640x480|prebid.org': 5.0,
          'banner|728x90|rubicon.com': 3.5,
          'video|600x300|appnexus.com': 3.5,
          '*|*|prebid.org': 3.5,
        }
      });
    });

    it('adds adUnitCode to the schema if the floorData comes from adUnit level to maintain scope', function () {
      let inputFloorData = utils.deepClone(basicFloorData);
      let resultingData = getFloorsDataForAuction(inputFloorData, 'test_div_1');
      expect(resultingData).to.deep.equal({
        modelVersion: 'basic model',
        currency: 'USD',
        schema: {
          delimiter: '|',
          fields: ['adUnitCode', 'mediaType']
        },
        values: {
          'test_div_1|banner': 1.0,
          'test_div_1|video': 5.0,
          'test_div_1|*': 2.5
        }
      });

      // uses the right delim if not |
      inputFloorData.schema.delimiter = '^';
      resultingData = getFloorsDataForAuction(inputFloorData, 'this_is_a_div');
      expect(resultingData).to.deep.equal({
        modelVersion: 'basic model',
        currency: 'USD',
        schema: {
          delimiter: '^',
          fields: ['adUnitCode', 'mediaType']
        },
        values: {
          'this_is_a_div^banner': 1.0,
          'this_is_a_div^video': 5.0,
          'this_is_a_div^*': 2.5
        }
      });
    });
  });

  describe('getFirstMatchingFloor', function () {
    it('selects the right floor for different mediaTypes', function () {
      // banner with * size (not in rule file so does not do anything)
      expect(getFirstMatchingFloor({...basicFloorData}, basicBidRequest, 'banner', '*')).to.deep.equal({
        matchingFloor: 1.0,
        matchingData: 'banner',
        matchingRule: 'banner'
      });
      // video with * size (not in rule file so does not do anything)
      expect(getFirstMatchingFloor({...basicFloorData}, basicBidRequest, 'video', '*')).to.deep.equal({
        matchingFloor: 5.0,
        matchingData: 'video',
        matchingRule: 'video'
      });
      // native (not in the rule list) with * size (not in rule file so does not do anything)
      expect(getFirstMatchingFloor({...basicFloorData}, basicBidRequest, 'native', '*')).to.deep.equal({
        matchingFloor: 2.5,
        matchingData: 'native',
        matchingRule: '*'
      });
    });
    it('selects the right floor for different sizes', function () {
      let inputFloorData = {
        currency: 'USD',
        schema: {
          delimiter: '|',
          fields: ['size']
        },
        values: {
          '300x250': 1.1,
          '640x480': 2.2,
          '728x90': 3.3,
          '600x300': 4.4,
          '*': 5.5,
        }
      }
      // banner with 300x250 size
      expect(getFirstMatchingFloor(inputFloorData, basicBidRequest, 'banner', [300, 250])).to.deep.equal({
        matchingFloor: 1.1,
        matchingData: '300x250',
        matchingRule: '300x250'
      });
      // video with 300x250 size
      expect(getFirstMatchingFloor(inputFloorData, basicBidRequest, 'video', [300, 250])).to.deep.equal({
        matchingFloor: 1.1,
        matchingData: '300x250',
        matchingRule: '300x250'
      });
      // native (not in the rule list) with 300x600 size
      expect(getFirstMatchingFloor(inputFloorData, basicBidRequest, 'native', [600, 300])).to.deep.equal({
        matchingFloor: 4.4,
        matchingData: '600x300',
        matchingRule: '600x300'
      });
      // n/a mediaType with a size not in file should go to catch all
      expect(getFirstMatchingFloor(inputFloorData, basicBidRequest, undefined, [1, 1])).to.deep.equal({
        matchingFloor: 5.5,
        matchingData: '1x1',
        matchingRule: '*'
      });
    });
    it('selects the right floor for more complex rules', function () {
      let inputFloorData = {
        currency: 'USD',
        schema: {
          delimiter: '^',
          fields: ['adUnitCode', 'mediaType', 'size']
        },
        values: {
          'test_div_1^banner^300x250': 1.1,
          'test_div_1^video^640x480': 2.2,
          'test_div_2^*^*': 3.3,
          '*^banner^300x250': 4.4,
          'weird_div^*^300x250': 5.5
        },
        default: 0.5
      };
      // banner with 300x250 size
      expect(getFirstMatchingFloor(inputFloorData, basicBidRequest, 'banner', [300, 250])).to.deep.equal({
        matchingFloor: 1.1,
        matchingData: 'test_div_1^banner^300x250',
        matchingRule: 'test_div_1^banner^300x250'
      });
      // video with 300x250 size -> No matching rule so should use default
      expect(getFirstMatchingFloor(inputFloorData, basicBidRequest, 'video', [300, 250])).to.deep.equal({
        matchingFloor: 0.5,
        matchingData: 'test_div_1^video^300x250',
        matchingRule: undefined
      });
      // remove default and should still return the same floor as above since matches are cached
      delete inputFloorData.default;
      expect(getFirstMatchingFloor(inputFloorData, basicBidRequest, 'video', [300, 250])).to.deep.equal({
        matchingFloor: 0.5,
        matchingData: 'test_div_1^video^300x250',
        matchingRule: undefined
      });
      // update adUnitCode to test_div_2 with weird other params
      let newBidRequest = { ...basicBidRequest, adUnitCode: 'test_div_2' }
      expect(getFirstMatchingFloor(inputFloorData, newBidRequest, 'badMediaType', [900, 900])).to.deep.equal({
        matchingFloor: 3.3,
        matchingData: 'test_div_2^badmediatype^900x900',
        matchingRule: 'test_div_2^*^*'
      });
    });
    it('it does not break if floorData has bad values', function () {
      let inputFloorData = {};
      expect(getFirstMatchingFloor(inputFloorData, basicBidRequest, 'banner', '*')).to.deep.equal({
        matchingFloor: undefined
      });
      // if default is there use it
      inputFloorData = { default: 5.0 };
      expect(getFirstMatchingFloor(inputFloorData, basicBidRequest, 'banner', '*')).to.deep.equal({
        matchingFloor: 5.0
      });
    });
  });
  describe('pre-auction tests', function () {
    let exposedAdUnits;
    const validateBidRequests = (getFloorExpected, FloorDataExpected) => {
      exposedAdUnits.forEach(adUnit => adUnit.bids.forEach(bid => {
        expect(bid.hasOwnProperty('getFloor')).to.equal(getFloorExpected);
        expect(bid.floorData).to.deep.equal(FloorDataExpected);
      }));
    };
    const runStandardAuction = (adUnits = [getAdUnitMock('test_div_1')]) => {
      requestBidsHook(config => exposedAdUnits = config.adUnits, {
        auctionId: basicBidRequest.auctionId,
        adUnits,
      });
    };
    let fakeFloorProvider;
    let clock;
    before(function () {
      clock = sinon.useFakeTimers();
    });
    after(function () {
      clock.restore();
    });
    beforeEach(function() {
      fakeFloorProvider = sinon.fakeServer.create();
    });
    afterEach(function() {
      fakeFloorProvider.restore();
      exposedAdUnits = undefined;
    });
    it('should not do floor stuff if no resulting floor object can be resolved for auciton', function () {
      handleSetFloorsConfig({
        ...basicFloorConfig,
        data: undefined
      });
      runStandardAuction();
      validateBidRequests(false, undefined);
    });
    it('should use adUnit level data if not setConfig or fetch has occured', function () {
      handleSetFloorsConfig({
        ...basicFloorConfig,
        data: undefined
      });
      // attach floor data onto an adUnit and run an auction
      let adUnitWithFloors1 = {
        ...getAdUnitMock('adUnit-Div-1'),
        floors: {
          ...basicFloorData,
          modelVersion: 'adUnit Model Version', // change the model name
        }
      };
      let adUnitWithFloors2 = {
        ...getAdUnitMock('adUnit-Div-2'),
        floors: {
          ...basicFloorData,
          values: {
            'banner': 5.0,
            '*': 10.4
          }
        }
      };
      runStandardAuction([adUnitWithFloors1, adUnitWithFloors2]);
      validateBidRequests(true, {
        skipped: false,
        modelVersion: 'adUnit Model Version',
        location: 'adUnit',
      });
    });
    it('bidRequests should have getFloor function and flooring meta data when setConfig occurs', function () {
      handleSetFloorsConfig({...basicFloorConfig});
      runStandardAuction();
      validateBidRequests(true, {
        skipped: false,
        modelVersion: 'basic model',
        location: 'setConfig',
      });
    });
    it('Should continue auction of delay is hit without a response from floor provider', function () {
      handleSetFloorsConfig({...basicFloorConfig, auctionDelay: 250, endpoint: {url: 'http://www.fakeFloorProvider.json'}});

      // start the auction it should delay and not immediately call `continueAuction`
      runStandardAuction();

      // exposedAdUnits should be undefined if the auction has not continued
      expect(exposedAdUnits).to.be.undefined;

      // hit the delay
      clock.tick(250);

      // log warn should be called and adUnits not undefined
      expect(logWarnSpy.calledOnce).to.equal(true);
      expect(exposedAdUnits).to.not.be.undefined;

      // the exposedAdUnits should be from the fetch not setConfig level data
      validateBidRequests(true, {
        skipped: false,
        modelVersion: 'basic model',
        location: 'setConfig',
      });
      fakeFloorProvider.respond();
    });
    it('It should fetch if config has url and bidRequests have fetch level flooring meta data', function () {
      // init the fake server with response stuff
      let fetchFloorData = {
        ...basicFloorData,
        modelVersion: 'fetch model name', // change the model name
      };
      fakeFloorProvider.respondWith(JSON.stringify(fetchFloorData));

      // run setConfig indicating fetch
      handleSetFloorsConfig({...basicFloorConfig, auctionDelay: 250, endpoint: {url: 'http://www.fakeFloorProvider.json'}});

      // floor provider should be called
      expect(fakeFloorProvider.requests.length).to.equal(1);
      expect(fakeFloorProvider.requests[0].url).to.equal('http://www.fakeFloorProvider.json');

      // start the auction it should delay and not immediately call `continueAuction`
      runStandardAuction();

      // exposedAdUnits should be undefined if the auction has not continued
      expect(exposedAdUnits).to.be.undefined;

      // make the fetch respond
      fakeFloorProvider.respond();
      expect(exposedAdUnits).to.not.be.undefined;

      // the exposedAdUnits should be from the fetch not setConfig level data
      validateBidRequests(true, {
        skipped: false,
        modelVersion: 'fetch model name',
        location: 'fetch',
      });
    });
    it('Should not break if floor provider returns non json', function () {
      fakeFloorProvider.respondWith('Not valid response');

      // run setConfig indicating fetch
      handleSetFloorsConfig({...basicFloorConfig, auctionDelay: 250, endpoint: {url: 'http://www.fakeFloorProvider.json'}});

      // run the auction and make server respond
      fakeFloorProvider.respond();
      runStandardAuction();

      // should have caught the response error and still used setConfig data
      validateBidRequests(true, {
        skipped: false,
        modelVersion: 'basic model',
        location: 'setConfig',
      });
    });
    it('should handle not using fetch correctly', function () {
      // run setConfig twice indicating fetch
      fakeFloorProvider.respondWith(JSON.stringify(basicFloorData));
      handleSetFloorsConfig({...basicFloorConfig, auctionDelay: 250, endpoint: {url: 'http://www.fakeFloorProvider.json'}});
      handleSetFloorsConfig({...basicFloorConfig, auctionDelay: 250, endpoint: {url: 'http://www.fakeFloorProvider.json'}});

      // log warn should be called and server only should have one request
      expect(logWarnSpy.calledOnce).to.equal(true);
      expect(fakeFloorProvider.requests.length).to.equal(1);
      expect(fakeFloorProvider.requests[0].url).to.equal('http://www.fakeFloorProvider.json');

      // now we respond and then run again it should work and make another request
      fakeFloorProvider.respond();
      handleSetFloorsConfig({...basicFloorConfig, auctionDelay: 250, endpoint: {url: 'http://www.fakeFloorProvider.json'}});
      fakeFloorProvider.respond();

      // now warn still only called once and server called twice
      expect(logWarnSpy.calledOnce).to.equal(true);
      expect(fakeFloorProvider.requests.length).to.equal(2);

      // should log error if method is not GET for now
      expect(logErrorSpy.calledOnce).to.equal(false);
      handleSetFloorsConfig({...basicFloorConfig, endpoint: {url: 'http://www.fakeFloorProvider.json', method: 'POST'}});
      expect(logErrorSpy.calledOnce).to.equal(true);
    });
    describe('isFloorsDataValid', function () {
      it('should work correctly for fields array', function () {
        let inputFloorData = utils.deepClone(basicFloorData);
        expect(isFloorsDataValid(inputFloorData)).to.to.equal(true);

        // no fields array
        delete inputFloorData.schema.fields;
        expect(isFloorsDataValid(inputFloorData)).to.to.equal(false);

        // Fields is not an array
        inputFloorData.schema.fields = {};
        expect(isFloorsDataValid(inputFloorData)).to.to.equal(false);
        inputFloorData.schema.fields = undefined;
        expect(isFloorsDataValid(inputFloorData)).to.to.equal(false);
        inputFloorData.schema.fields = 'adUnitCode';
        expect(isFloorsDataValid(inputFloorData)).to.to.equal(false);

        // fields has a value that is not one of the "allowed" fields
        inputFloorData.schema.fields = ['adUnitCode', 'notValidMapping'];
        expect(isFloorsDataValid(inputFloorData)).to.to.equal(false);
      });
      it('should work correctly for values object', function () {
        let inputFloorData = utils.deepClone(basicFloorData);
        expect(isFloorsDataValid(inputFloorData)).to.to.equal(true);

        // no values object
        delete inputFloorData.values;
        expect(isFloorsDataValid(inputFloorData)).to.to.equal(false);

        // values is not correct type
        inputFloorData.values = [];
        expect(isFloorsDataValid(inputFloorData)).to.to.equal(false);
        inputFloorData.values = '123455/slot';
        expect(isFloorsDataValid(inputFloorData)).to.to.equal(false);

        // is an object but structure is wrong
        inputFloorData.values = {
          'banner': 'not a floor value'
        };
        expect(isFloorsDataValid(inputFloorData)).to.to.equal(false);
        inputFloorData.values = {
          'banner': undefined
        };
        expect(isFloorsDataValid(inputFloorData)).to.to.equal(false);

        // should be true if at least one rule is valid
        inputFloorData.schema.fields = ['adUnitCode', 'mediaType'];
        inputFloorData.values = {
          'banner': 1.0,
          'test-div-1|native': 1.0, // only valid rule should still work and delete the other rules
          'video': 1.0,
          '*': 1.0
        };
        expect(isFloorsDataValid(inputFloorData)).to.to.equal(true);
        expect(inputFloorData.values).to.deep.equal({ 'test-div-1|native': 1.0 });
      });
    });
    describe('getFloor', function () {
      let bidRequest = {
        ...basicBidRequest,
        getFloor
      };
      it('returns empty if no matching data for auction is found', function () {
        expect(bidRequest.getFloor({})).to.deep.equal({});
      });
      it('picks the right rule depending on input', function () {
        _floorDataForAuction[bidRequest.auctionId] = utils.deepClone(basicFloorConfig);

        // empty params into getFloor should use default of banner * FloorData Curr
        let inputParams = {};
        expect(bidRequest.getFloor(inputParams)).to.deep.equal({
          currency: 'USD',
          floor: 1.0
        });

        // ask for banner
        inputParams = {mediaType: 'banner'};
        expect(bidRequest.getFloor(inputParams)).to.deep.equal({
          currency: 'USD',
          floor: 1.0
        });

        // ask for video
        inputParams = {mediaType: 'video'};
        expect(bidRequest.getFloor(inputParams)).to.deep.equal({
          currency: 'USD',
          floor: 5.0
        });

        // ask for *
        inputParams = {mediaType: '*'};
        expect(bidRequest.getFloor(inputParams)).to.deep.equal({
          currency: 'USD',
          floor: 2.5
        });
      });
      it('picks the right rule with more complex rules', function () {
        _floorDataForAuction[bidRequest.auctionId] = {
          ...basicFloorConfig,
          data: {
            currency: 'USD',
            schema: { fields: ['mediaType', 'size'], delimiter: '|' },
            values: {
              'banner|300x250': 0.5,
              'banner|300x600': 1.5,
              'banner|728x90': 2.5,
              'banner|*': 3.5,
              'video|640x480': 4.5,
              'video|*': 5.5
            },
            default: 10.0
          }
        };

        // assumes banner *
        let inputParams = {};
        expect(bidRequest.getFloor(inputParams)).to.deep.equal({
          currency: 'USD',
          floor: 3.5
        });

        // ask for banner with a size
        inputParams = {mediaType: 'banner', size: [300, 600]};
        expect(bidRequest.getFloor(inputParams)).to.deep.equal({
          currency: 'USD',
          floor: 1.5
        });

        // ask for video with a size
        inputParams = {mediaType: 'video', size: [640, 480]};
        expect(bidRequest.getFloor(inputParams)).to.deep.equal({
          currency: 'USD',
          floor: 4.5
        });

        // ask for video with a size not in rules (should pick rule which has video and *)
        inputParams = {mediaType: 'video', size: [111, 222]};
        expect(bidRequest.getFloor(inputParams)).to.deep.equal({
          currency: 'USD',
          floor: 5.5
        });

        // ask for native * but no native rule so should use default value if there
        inputParams = {mediaType: 'native', size: '*'};
        expect(bidRequest.getFloor(inputParams)).to.deep.equal({
          currency: 'USD',
          floor: 10.0
        });
      });
      it('should round up to 4 decimal places', function () {
        _floorDataForAuction[bidRequest.auctionId] = utils.deepClone(basicFloorConfig);
        _floorDataForAuction[bidRequest.auctionId].data.values = {
          'banner': 1.777777,
          'video': 1.1111111,
        };

        // assumes banner *
        let inputParams = {mediaType: 'banner'};
        expect(bidRequest.getFloor(inputParams)).to.deep.equal({
          currency: 'USD',
          floor: 1.7778
        });

        // assumes banner *
        inputParams = {mediaType: 'video'};
        expect(bidRequest.getFloor(inputParams)).to.deep.equal({
          currency: 'USD',
          floor: 1.1112
        });
      });
      it('should return the adjusted floor if bidder has cpm adjustment function', function () {
        getGlobal().bidderSettings = {
          rubicon: {
            bidCpmAdjustment: function (bidCpm) {
              return bidCpm * 0.5;
            },
          },
          appnexus: {
            bidCpmAdjustment: function (bidCpm) {
              return bidCpm * 0.75;
            },
          }
        };
        _floorDataForAuction[bidRequest.auctionId] = utils.deepClone(basicFloorConfig);
        _floorDataForAuction[bidRequest.auctionId].data.values = { '*': 1.0 };
        let appnexusBid = {
          ...bidRequest,
          bidder: 'appnexus'
        };

        // the conversion should be what the bidder would need to return in order to match the actual floor
        // rubicon
        expect(bidRequest.getFloor()).to.deep.equal({
          currency: 'USD',
          floor: 2.0 // a 2.0 bid after rubicons cpm adjustment would be 1.0 and thus is the floor after adjust
        });

        // appnexus
        expect(appnexusBid.getFloor()).to.deep.equal({
          currency: 'USD',
          floor: 1.3334 // 1.3334 * 0.75 = 1.000005 which is the floor (we cut off getFloor at 4 decimal points)
        });

        // reset global bidder settings so no weird test side effects
        getGlobal().bidderSettings = {};
      });
    });
  });
  describe('bidResponseHook tests', function () {
    let returnedBidResponse;
    let bidderRequest = {
      bidderCode: 'appnexus',
      auctionId: '123456',
      bids: [{
        bidder: 'appnexus',
        adUnitCode: 'test_div_1',
        auctionId: '123456',
        bidId: '1111'
      }]
    };
    let basicBidResponse = {
      bidderCode: 'appnexus',
      width: 300,
      height: 250,
      cpm: 0.5,
      mediaType: 'banner',
      requestId: '1111',
    };
    beforeEach(function () {
      returnedBidResponse = {};
    });
    function runBidResponse(bidResp = basicBidResponse) {
      let next = (adUnitCode, bid) => {
        returnedBidResponse = bid;
      };
      addBidResponseHook.bind({ bidderRequest })(next, bidResp.adUnitCode, bidResp);
    };
    it('continues with the auction if not floors data is present without any flooring', function () {
      runBidResponse();
      expect(returnedBidResponse).to.not.haveOwnProperty('floorData');
    });
    it('if no matching rule it should not floor and should call log warn', function () {
      _floorDataForAuction[bidderRequest.auctionId] = utils.deepClone(basicFloorConfig);
      _floorDataForAuction[bidderRequest.auctionId].data.values = { 'video': 1.0 };
      runBidResponse();
      expect(returnedBidResponse).to.not.haveOwnProperty('floorData');
      expect(logWarnSpy.calledOnce).to.equal(true);
    });
    it('if it finds a rule and floors should update the bid accordingly', function () {
      _floorDataForAuction[bidderRequest.auctionId] = utils.deepClone(basicFloorConfig);
      _floorDataForAuction[bidderRequest.auctionId].data.values = { 'banner': 1.0 };
      runBidResponse();
      expect(returnedBidResponse).to.haveOwnProperty('floorData');
      expect(returnedBidResponse.status).to.equal(CONSTANTS.BID_STATUS.BID_REJECTED);
      expect(returnedBidResponse.cpm).to.equal(0);
    });
    it('if it finds a rule and does not floor should update the bid accordingly', function () {
      _floorDataForAuction[bidderRequest.auctionId] = utils.deepClone(basicFloorConfig);
      _floorDataForAuction[bidderRequest.auctionId].data.values = { 'banner': 0.3 };
      runBidResponse();
      expect(returnedBidResponse).to.haveOwnProperty('floorData');
      expect(returnedBidResponse.floorData).to.deep.equal({
        floorValue: 0.3,
        floorCurrency: 'USD',
        floorRule: 'banner',
        cpmAfterAdjustments: 0.5,
        enforcements: {
          bidAdjustment: true,
          enforceJS: true,
          enforcePBS: false,
          floorDeals: false
        },
        matchedFields: {
          mediaType: 'banner'
        }
      });
      expect(returnedBidResponse.cpm).to.equal(0.5);
    });
    it('if should work with more complex rules and update accordingly', function () {
      _floorDataForAuction[bidderRequest.auctionId] = {
        ...basicFloorConfig,
        data: {
          currency: 'USD',
          schema: { fields: ['mediaType', 'size'], delimiter: '|' },
          values: {
            'banner|300x250': 0.5,
            'banner|300x600': 1.5,
            'banner|728x90': 2.5,
            'banner|*': 3.5,
            'video|640x480': 4.5,
            'video|*': 5.5
          },
          default: 10.0
        }
      };
      runBidResponse();
      expect(returnedBidResponse).to.haveOwnProperty('floorData');
      expect(returnedBidResponse.floorData).to.deep.equal({
        floorValue: 0.5,
        floorCurrency: 'USD',
        floorRule: 'banner|300x250',
        cpmAfterAdjustments: 0.5,
        enforcements: {
          bidAdjustment: true,
          enforceJS: true,
          enforcePBS: false,
          floorDeals: false
        },
        matchedFields: {
          mediaType: 'banner',
          size: '300x250'
        }
      });
      expect(returnedBidResponse.cpm).to.equal(0.5);

      // update bidResponse to have different combinations (should pick video|*)
      runBidResponse({
        width: 300,
        height: 250,
        cpm: 7.5,
        mediaType: 'video',
        requestId: '1111',
      });
      expect(returnedBidResponse).to.haveOwnProperty('floorData');
      expect(returnedBidResponse.floorData).to.deep.equal({
        floorValue: 5.5,
        floorCurrency: 'USD',
        floorRule: 'video|*',
        cpmAfterAdjustments: 7.5,
        enforcements: {
          bidAdjustment: true,
          enforceJS: true,
          enforcePBS: false,
          floorDeals: false
        },
        matchedFields: {
          mediaType: 'video',
          size: '300x250'
        }
      });
      expect(returnedBidResponse.cpm).to.equal(7.5);
    });
  });
});
