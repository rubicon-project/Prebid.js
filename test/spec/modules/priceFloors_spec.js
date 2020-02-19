import {expect} from 'chai';
import {config} from 'src/config';
import * as utils from 'src/utils';
import {server} from 'test/mocks/xhr';
import {
  _floorDataForAuction,
  getFloorsDataForAuction,
  getFirstMatchingFloor,
  getFloor,
  handleSetFloorsConfig,
  continueAuction,
  requestBidsHook
} from 'modules/priceFloors';

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
    values: [
      {key: 'banner', floor: 1.0},
      {key: 'video', floor: 5.0},
      {key: '*', floor: 2.5},
    ]
  };
  const basicFloorDataAfterMap = {
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
      enfocePBS: false,
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
      // basic input
      expect(getFloorsDataForAuction(basicFloorData)).to.deep.equal(basicFloorDataAfterMap);

      // if cur and delim not defined then default to correct ones (usd and |)
      let inputFloorData = utils.deepClone(basicFloorData);
      delete inputFloorData.currency;
      delete inputFloorData.schema.delimiter;
      expect(getFloorsDataForAuction(inputFloorData)).to.deep.equal(basicFloorDataAfterMap);

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
        values: [
          {key: 'banner|300x250|prebid.org', floor: 1.0},
          {key: 'video|640x480|prebid.org', floor: 5.0},
          {key: 'banner|728x90|rubicon.com', floor: 3.5},
          {key: 'video|600x300|appnexus.com', floor: 3.5},
          {key: '*|*|prebid.org', floor: 3.5},
        ]
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
      expect(getFirstMatchingFloor(basicFloorDataAfterMap, basicBidRequest, 'banner', '*')).to.deep.equal({
        matchingFloor: 1.0,
        matchingData: 'banner',
        matchingRule: 'banner'
      });
      // video with * size (not in rule file so does not do anything)
      expect(getFirstMatchingFloor(basicFloorDataAfterMap, basicBidRequest, 'video', '*')).to.deep.equal({
        matchingFloor: 5.0,
        matchingData: 'video',
        matchingRule: 'video'
      });
      // native (not in the rule list) with * size (not in rule file so does not do anything)
      expect(getFirstMatchingFloor(basicFloorDataAfterMap, basicBidRequest, 'native', '*')).to.deep.equal({
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
      // remove default and should return undefined floor
      delete inputFloorData.default;
      expect(getFirstMatchingFloor(inputFloorData, basicBidRequest, 'video', [300, 250])).to.deep.equal({
        matchingFloor: undefined,
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
    const clock = sinon.useFakeTimers();
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
      let adUnitWithFloors = {
        ...getAdUnitMock('adUnit-Div'),
        floors: {
          ...basicFloorData,
          modelVersion: 'adUnit Model Version', // change the model name
        }
      };
      runStandardAuction([adUnitWithFloors]);
      validateBidRequests(true, {
        skipped: false,
        modelVersion: 'adUnit Model Version',
        location: 'adUnit',
      });
    });
    it('bidRequests should have getFloor function and flooring meta data when setConfig occurs', function () {
      handleSetFloorsConfig(basicFloorConfig);
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
    // it('getFloor should work correctly', function () {
    //   let exposedAdUnits;
    //   requestBidsHook(config => exposedAdUnits = config.adUnits, {
    //     auctionId: basicBidRequest.auctionId,
    //     adUnits: [getAdUnitMock('test_div_1')]
    //   });
    //   // empty params into getFloor should use default of banner * FloorData Curr
    //   let inputParams = {}
    //   expect(basicBidRequest.getFloor(inputParams)).to.deep.equal({
    //     currency: 'USD',
    //     floor: 1.0
    //   });
    // });
  });
});
