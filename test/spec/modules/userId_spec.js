import {
  init,
  syncDelay,
  submodules,
  pubCommonIdSubmodule,
  unifiedIdSubmodule,
  digitrustIdModule,
  requestBidsHook
} from 'modules/userId';
import {config} from 'src/config';
import * as utils from 'src/utils';
import * as auctionModule from 'src/auction';
import {getAdUnits} from 'test/fixtures/fixtures';
import {registerBidder} from 'src/adapters/bidderFactory';

let assert = require('chai').assert;
let expect = require('chai').expect;

describe('User ID', function() {
  const EXPIRED_COOKIE_DATE = 'Thu, 01 Jan 1970 00:00:01 GMT';

  function createStorageConfig(name = 'pubCommonId', key = 'pubcid', type = 'cookie', expires = 30) {
    return { name: name, storage: { name: key, type: type, expires: expires } }
  }

  describe('Decorate Ad Units', function() {
    beforeEach(function() {
      utils.setCookie('pubcid', '', EXPIRED_COOKIE_DATE);
      utils.setCookie('pubcid_alt', 'altpubcid200000', (new Date(Date.now() + 5000).toUTCString()));
    });

    afterEach(function () {
      $$PREBID_GLOBAL$$.requestBids.removeAll();
      config.resetConfig();
    });

    after(function() {
      utils.setCookie('pubcid', '', EXPIRED_COOKIE_DATE);
      utils.setCookie('pubcid_alt', '', EXPIRED_COOKIE_DATE);
    });

    it('Check same cookie behavior', function () {
      let adUnits1 = getAdUnits();
      let adUnits2 = getAdUnits();
      let innerAdUnits1;
      let innerAdUnits2;

      let pubcid = utils.getCookie('pubcid');
      expect(pubcid).to.be.null; // there should be no cookie initially

      init(config, [pubCommonIdSubmodule, unifiedIdSubmodule]);
      config.setConfig({ usersync: { syncDelay: 0, userIds: [ createStorageConfig() ] } });

      requestBidsHook((config) => { innerAdUnits1 = config.adUnits }, {adUnits: adUnits1});
      pubcid = utils.getCookie('pubcid'); // cookies is created after requestbidHook

      innerAdUnits1.forEach((unit) => {
        unit.bids.forEach((bid) => {
          expect(bid).to.have.deep.nested.property('userId.pubcid');
          expect(bid.userId.pubcid).to.equal(pubcid);
        });
      });

      requestBidsHook((config) => { innerAdUnits2 = config.adUnits }, {adUnits: adUnits2});
      assert.deepEqual(innerAdUnits1, innerAdUnits2);
    });

    it('Check different cookies', function () {
      let adUnits1 = getAdUnits();
      let adUnits2 = getAdUnits();
      let innerAdUnits1;
      let innerAdUnits2;
      let pubcid1;
      let pubcid2;

      init(config, [pubCommonIdSubmodule, unifiedIdSubmodule]);
      config.setConfig({ usersync: { syncDelay: 0, userIds: [ createStorageConfig() ] } });
      requestBidsHook((config) => { innerAdUnits1 = config.adUnits }, {adUnits: adUnits1});
      pubcid1 = utils.getCookie('pubcid'); // get first cookie
      utils.setCookie('pubcid', '', EXPIRED_COOKIE_DATE); // erase cookie

      innerAdUnits1.forEach((unit) => {
        unit.bids.forEach((bid) => {
          expect(bid).to.have.deep.nested.property('userId.pubcid');
          expect(bid.userId.pubcid).to.equal(pubcid1);
        });
      });

      init(config, [pubCommonIdSubmodule, unifiedIdSubmodule]);
      config.setConfig({ usersync: { syncDelay: 0, userIds: [ createStorageConfig() ] } });
      requestBidsHook((config) => { innerAdUnits2 = config.adUnits }, {adUnits: adUnits2});

      pubcid2 = utils.getCookie('pubcid'); // get second cookie

      innerAdUnits2.forEach((unit) => {
        unit.bids.forEach((bid) => {
          expect(bid).to.have.deep.nested.property('userId.pubcid');
          expect(bid.userId.pubcid).to.equal(pubcid2);
        });
      });

      expect(pubcid1).to.not.equal(pubcid2);
    });

    it('Check new cookie', function () {
      let adUnits = getAdUnits();
      let innerAdUnits;

      init(config, [pubCommonIdSubmodule, unifiedIdSubmodule]);
      config.setConfig({
        usersync: {
          syncDelay: 0,
          userIds: [createStorageConfig('pubCommonId', 'pubcid_alt', 'cookie')]}
      });
      requestBidsHook((config) => { innerAdUnits = config.adUnits }, {adUnits});
      innerAdUnits.forEach((unit) => {
        unit.bids.forEach((bid) => {
          expect(bid).to.have.deep.nested.property('userId.pubcid');
          expect(bid.userId.pubcid).to.equal('altpubcid200000');
        });
      });
    });
  });

  describe('Opt out', function () {
    before(function () {
      utils.setCookie('_pbjs_id_optout', '1', (new Date(Date.now() + 5000).toUTCString()));
    });

    beforeEach(function () {
      sinon.stub(utils, 'logInfo');
    });

    afterEach(function () {
      // removed cookie
      utils.setCookie('_pbjs_id_optout', '', EXPIRED_COOKIE_DATE);
      $$PREBID_GLOBAL$$.requestBids.removeAll();
      utils.logInfo.restore();
      config.resetConfig();
    });

    after(function () {
      utils.setCookie('_pbjs_id_optout', '', EXPIRED_COOKIE_DATE);
    });

    it('fails initialization if opt out cookie exists', function () {
      init(config, [pubCommonIdSubmodule, unifiedIdSubmodule]);
      config.setConfig({ usersync: { syncDelay: 0, userIds: [ createStorageConfig() ] } });
      expect(utils.logInfo.args[0][0]).to.exist.and.to.equal('User ID - opt-out cookie found, exit module');
    });

    it('initializes if no opt out cookie exists', function () {
      init(config, [pubCommonIdSubmodule, unifiedIdSubmodule]);
      config.setConfig({ usersync: { syncDelay: 0, userIds: [ createStorageConfig() ] } });
      expect(utils.logInfo.args[0][0]).to.exist.and.to.equal('User ID - usersync config updated for 1 submodules');
    });
  });

  describe('Handle variations of config values', function () {
    beforeEach(function () {
      sinon.stub(utils, 'logInfo');
    });

    afterEach(function () {
      $$PREBID_GLOBAL$$.requestBids.removeAll();
      utils.logInfo.restore();
      config.resetConfig();
    });

    it('handles config with no usersync object', function () {
      init(config, [pubCommonIdSubmodule, unifiedIdSubmodule]);
      config.setConfig({});
      // usersync is undefined, and no logInfo message for 'User ID - usersync config updated'
      expect(typeof utils.logInfo.args[0]).to.equal('undefined');
    });

    it('handles config with empty usersync object', function () {
      init(config, [pubCommonIdSubmodule, unifiedIdSubmodule]);
      config.setConfig({ usersync: {} });
      expect(typeof utils.logInfo.args[0]).to.equal('undefined');
    });

    it('handles config with usersync and userIds that are empty objs', function () {
      init(config, [pubCommonIdSubmodule, unifiedIdSubmodule]);
      config.setConfig({
        usersync: {
          userIds: [{}]
        }
      });
      expect(typeof utils.logInfo.args[0]).to.equal('undefined');
    });

    it('handles config with usersync and userIds with empty names or that dont match a submodule.name', function () {
      init(config, [pubCommonIdSubmodule, unifiedIdSubmodule]);
      config.setConfig({
        usersync: {
          userIds: [{
            name: '',
            value: { test: '1' }
          }, {
            name: 'foo',
            value: { test: '1' }
          }]
        }
      });
      expect(typeof utils.logInfo.args[0]).to.equal('undefined');
    });

    it('config with 1 configurations should create 1 submodules', function () {
      init(config, [pubCommonIdSubmodule, unifiedIdSubmodule]);
      config.setConfig({
        usersync: {
          syncDelay: 0,
          userIds: [{
            name: 'unifiedId',
            storage: { name: 'unifiedid', type: 'cookie' }
          }]
        }
      });
      expect(utils.logInfo.args[0][0]).to.exist.and.to.equal('User ID - usersync config updated for 1 submodules');
    });

    it('config with 2 configurations should result in 2 submodules add', function () {
      init(config, [pubCommonIdSubmodule, unifiedIdSubmodule]);
      config.setConfig({
        usersync: {
          syncDelay: 0,
          userIds: [{
            name: 'pubCommonId', value: {'pubcid': '11111'}
          }, {
            name: 'unifiedId',
            storage: { name: 'unifiedid', type: 'cookie' }
          }]
        }
      });
      expect(utils.logInfo.args[0][0]).to.exist.and.to.equal('User ID - usersync config updated for 2 submodules');
    });

    it('config syncDelay updates module correctly', function () {
      init(config, [pubCommonIdSubmodule, unifiedIdSubmodule]);
      config.setConfig({
        usersync: {
          syncDelay: 99,
          userIds: [{
            name: 'unifiedId',
            storage: { name: 'unifiedid', type: 'cookie' }
          }]
        }
      });
      expect(syncDelay).to.equal(99);
    });
  });

  describe('Invoking requestBid', function () {
    let storageResetCount = 0;
    let createAuctionStub;
    let adUnits;
    let adUnitCodes;
    let capturedReqs;
    let sampleSpec = {
      code: 'sampleBidder',
      isBidRequestValid: () => {},
      buildRequest: (reqs) => {},
      interpretResponse: () => {},
      getUserSyncs: () => {}
    };

    beforeEach(function () {
      // simulate existing browser cookie values
      utils.setCookie('pubcid', `testpubcid${storageResetCount}`, (new Date(Date.now() + 5000).toUTCString()));
      utils.setCookie('unifiedid', JSON.stringify({
        'TDID': `testunifiedid${storageResetCount}`
      }), (new Date(Date.now() + 5000).toUTCString()));

      // simulate existing browser local storage values
      localStorage.setItem('unifiedid_alt', JSON.stringify({
        'TDID': `testunifiedid_alt${storageResetCount}`
      }));
      localStorage.setItem('unifiedid_alt_exp', '');

      adUnits = [{
        code: 'adUnit-code',
        mediaTypes: {
          banner: {},
          native: {},
        },
        sizes: [[300, 200], [300, 600]],
        bids: [
          {bidder: 'sampleBidder', params: {placementId: 'banner-only-bidder'}}
        ]
      }];
      adUnitCodes = ['adUnit-code'];
      let auction = auctionModule.newAuction({adUnits, adUnitCodes, callback: function() {}, cbTimeout: 2000});
      createAuctionStub = sinon.stub(auctionModule, 'newAuction');
      createAuctionStub.returns(auction);

      init(config, [pubCommonIdSubmodule, unifiedIdSubmodule]);

      registerBidder(sampleSpec);
    });

    afterEach(function () {
      storageResetCount++;

      utils.setCookie('pubcid', '', EXPIRED_COOKIE_DATE);
      utils.setCookie('unifiedid', '', EXPIRED_COOKIE_DATE);
      localStorage.removeItem('unifiedid_alt');
      localStorage.removeItem('unifiedid_alt_exp');
      auctionModule.newAuction.restore();
      $$PREBID_GLOBAL$$.requestBids.removeAll();
      config.resetConfig();
    });

    it('test hook from pubcommonid cookie', function() {
      config.setConfig({
        usersync: {
          syncDelay: 0,
          userIds: [createStorageConfig('pubCommonId', 'pubcid', 'cookie')]
        }
      });

      $$PREBID_GLOBAL$$.requestBids({adUnits});

      adUnits.forEach((unit) => {
        unit.bids.forEach((bid) => {
          expect(bid).to.have.deep.nested.property('userId.pubcid');
          expect(bid.userId.pubcid).to.equal(`testpubcid${storageResetCount}`);
        });
      });
    });

    it('test hook from pubcommonid config value object', function() {
      config.setConfig({
        usersync: {
          syncDelay: 0,
          userIds: [{
            name: 'pubCommonId',
            value: {'pubcidvalue': 'testpubcidvalue'}
          }]}
      });

      $$PREBID_GLOBAL$$.requestBids({adUnits});

      adUnits.forEach((unit) => {
        unit.bids.forEach((bid) => {
          expect(bid).to.have.deep.nested.property('userId.pubcidvalue');
          expect(bid.userId.pubcidvalue).to.equal('testpubcidvalue');
        });
      });
    });

    it('test hook from pubcommonid html5', function() {
      config.setConfig({
        usersync: {
          syncDelay: 0,
          userIds: [createStorageConfig('unifiedId', 'unifiedid_alt', 'html5')]}
      });

      $$PREBID_GLOBAL$$.requestBids({adUnits});

      adUnits.forEach((unit) => {
        unit.bids.forEach((bid) => {
          expect(bid).to.have.deep.nested.property('userId.tdid');
          expect(bid.userId.tdid).to.equal(`testunifiedid_alt${storageResetCount}`);
        });
      });
    });

    it('test hook when both pubCommonId and unifiedId have data to pass', function() {
      config.setConfig({
        usersync: {
          syncDelay: 0,
          userIds: [
            createStorageConfig('pubCommonId', 'pubcid', 'cookie'),
            createStorageConfig('unifiedId', 'unifiedid', 'cookie')
          ]}
      });

      $$PREBID_GLOBAL$$.requestBids({adUnits});

      adUnits.forEach((unit) => {
        unit.bids.forEach((bid) => {
          // verify that the PubCommonId id data was copied to bid
          expect(bid).to.have.deep.nested.property('userId.pubcid');
          expect(bid.userId.pubcid).to.equal(`testpubcid${storageResetCount}`);

          // also check that UnifiedId id data was copied to bid
          expect(bid).to.have.deep.nested.property('userId.tdid');
          expect(bid.userId.tdid).to.equal(`testunifiedid${storageResetCount}`);
        });
      });
    });

    it('test that hook does not add a userId property if not submodule data was available', function() {
      config.setConfig({
        usersync: {
          syncDelay: 0,
          userIds: [createStorageConfig('unifiedId', 'unifiedid', 'html5')]}
      });

      $$PREBID_GLOBAL$$.requestBids({adUnits});

      // unifiedId configured to execute callback to load user id data after the auction ends
      const submodulesWithCallbacks = submodules.filter(item => (typeof item.callback === 'function' && typeof item.idObj === 'undefined'));
      expect(submodulesWithCallbacks.length).to.equal(1);
      expect(submodulesWithCallbacks[0].submodule).to.equal(unifiedIdSubmodule);

      adUnits.forEach((unit) => {
        unit.bids.forEach((bid) => {
          expect(typeof bid.userId).to.equal('undefined');
        });
      });
    });
  });

  describe('DigiTrust submodule works as expected', function () {
    let createAuctionStub;
    let adUnits;
    let adUnitCodes;
    let sampleSpec = {
      code: 'sampleBidder',
      isBidRequestValid: () => {},
      buildRequest: (reqs) => {},
      interpretResponse: () => {},
      getUserSyncs: () => {}
    };
    let xhr;
    let requests;
    let clock;
    const DigiTrust = {
      isClient: true,
      getUser(data) {}
    }

    before(function() {
      clock = sinon.useFakeTimers();
      xhr = sinon.useFakeXMLHttpRequest();
      requests = [];
      xhr.onCreate = function (xhr) {
        requests.push(xhr);
      };
      // use to test behavior when a digitrust cookie exists (note: DigiTrust cookie values are encoded in base64)
      utils.setCookie('DigiTrust.1', btoa('678678678'), Number.MAX_VALUE);
    });

    after(function() {
      clock.restore();
      xhr.restore();
      utils.setCookie('DigiTrust.1', '0', EXPIRED_COOKIE_DATE);
    });

    beforeEach(function() {
      requests = [];
      adUnits = [{
        code: 'adUnit-code',
        mediaTypes: {
          banner: {},
          native: {},
        },
        sizes: [[300, 200], [300, 600]],
        bids: [
          {bidder: 'sampleBidder', params: {placementId: 'banner-only-bidder'}}
        ]
      }];
      adUnitCodes = ['adUnit-code'];
      let auction = auctionModule.newAuction({adUnits, adUnitCodes, callback: function() {}, cbTimeout: 2000});
      createAuctionStub = sinon.stub(auctionModule, 'newAuction');
      createAuctionStub.returns(auction);
      sinon.stub(utils, 'logError');

      init(config, [digitrustIdModule]);
      registerBidder(sampleSpec);
    });

    afterEach(function() {
      auctionModule.newAuction.restore();
      $$PREBID_GLOBAL$$.requestBids.removeAll();
      utils.logError.restore();
      config.resetConfig();
      utils.setCookie('DigiTrust', '0', EXPIRED_COOKIE_DATE);
    });

    it('Gets userid from webservice if framework does not exist', function() {
      config.setConfig({
        usersync: {
          syncDelay: 0,
          userIds: [createStorageConfig('digitrust', 'DigiTrust', 'cookie', 50000)]
        }
      });

      $$PREBID_GLOBAL$$.requestBids({adUnits});
      clock.tick(4000);
      expect(requests.length).to.equal(1);
      expect(requests[0].url).to.equal('https://cdn-cf.digitru.st/id/v1');

      requests[0].respond(200, {"Content-Type": "text/plain"}, "1234567890")

      const digitrustCookie = utils.getCookie('DigiTrust');
      expect(typeof digitrustCookie === 'string').to.equal(true);
      // expect decoded digistrust stored cookie equals value from url request
      expect(atob(digitrustCookie)).to.equal('1234567890');
    });

    it('Handles webservice request error', function() {
      config.setConfig({
        usersync: {
          syncDelay: 0,
          userIds: [createStorageConfig('digitrust', 'DigiTrust', 'cookie', 50000)]
        }
      });

      $$PREBID_GLOBAL$$.requestBids({adUnits});
      clock.tick(4000);
      expect(requests.length).to.equal(1);
      expect(requests[0].url).to.equal('https://cdn-cf.digitru.st/id/v1');

      requests[0].respond(500, {}, "")

      const digitrustCookie = utils.getCookie('DigiTrust');
      expect(typeof digitrustCookie === 'string').to.equal(false);

      expect(utils.logError.args.length).to.equal(3);
      // should get error messages for api error and empty value
      expect(utils.logError.args[1][0]).to.equal('User ID - DigiTrustId API error: Internal Server Error');
      expect(utils.logError.args[2][0]).to.equal('User ID: digitrust - request id responded with an empty value');
    });

    it('Handles webservice response with invalid data (Unicode String)', function() {
      config.setConfig({
        usersync: {
          syncDelay: 0,
          userIds: [createStorageConfig('digitrust', 'DigiTrust', 'cookie', 50000)]
        }
      });

      $$PREBID_GLOBAL$$.requestBids({adUnits});
      clock.tick(4000);
      expect(requests.length).to.equal(1);
      expect(requests[0].url).to.equal('https://cdn-cf.digitru.st/id/v1');

      // In most browsers, calling btoa() on a Unicode string will cause an InvalidCharacterError exception.
      requests[0].respond(200, {"Content-Type": "text/text"}, "I \u2661 Unicode!")

      const digitrustCookie = utils.getCookie('DigiTrust');
      expect(typeof digitrustCookie === 'string').to.equal(false);

      expect(utils.logError.args.length).to.equal(2);
      // should get error messages for api error and empty value
      expect(utils.logError.args[1][0]).to.equal('User ID: digitrust - request id responded with an empty value');
    });

    it('Gets userid from DigiTrust framework asynchronously', function() {
      let callbackRef;
      const stubGetUser = sinon.stub(DigiTrust, 'getUser').callsFake(function fakeGetUser(data, callback) {
        callbackRef = callback;
        // callback({success: true, identity: '9876543210'});
      });
      window.DigiTrust = DigiTrust;

      config.setConfig({
        usersync: {
          syncDelay: 0,
          userIds: [createStorageConfig('digitrust', 'DigiTrust', 'cookie', 50000)]
        }
      });

      $$PREBID_GLOBAL$$.requestBids({adUnits});
      callbackRef({success: true, identity: '9876543210'});
      clock.tick(4000);
      expect(requests.length).to.equal(0);

      const digitrustCookie = utils.getCookie('DigiTrust');
      expect(typeof digitrustCookie === 'string').to.equal(true);
      // expect decoded digistrust stored cookie equals value from url request
      expect(atob(digitrustCookie)).to.equal('9876543210');

      stubGetUser.restore();
      delete window.DigiTrust;
    });

    it('Gets userid from DigiTrust framework synchronously and id added to bids in auction', function() {
      const stubGetUser = sinon.stub(DigiTrust, 'getUser').callsFake(function fakeGetUser(data, callback) {
        callback({success: true, identity: '222222'});
      });
      window.DigiTrust = DigiTrust;

      config.setConfig({
        usersync: {
          syncDelay: 0,
          userIds: [createStorageConfig('digitrust', 'DigiTrust', 'cookie', 5000000)]
        }
      });

      $$PREBID_GLOBAL$$.requestBids({adUnits});

      // should have no submodules with callbacks registered
      const submodulesWithCallbacks = submodules.filter(item => (typeof item.callback === 'function' && typeof item.idObj === 'undefined'));
      expect(submodulesWithCallbacks.length).to.equal(0);

      clock.tick(4000);

      // expect no webrequest since the framework was used
      expect(requests.length).to.equal(0);

      // expect decoded digistrust stored cookie equals value from url request
      const digitrustCookie = utils.getCookie('DigiTrust');
      expect(typeof digitrustCookie === 'string').to.equal(true);
      expect(atob(digitrustCookie)).to.equal('222222');

      // expect digitrustid to be added to current auction bids
      adUnits.forEach((unit) => {
        unit.bids.forEach((bid) => {
          // verify that the id data was copied to bid
          expect(bid).to.have.deep.nested.property('userId.digitrustid');
          // should be the decoded value set by 'util.setCookie' in the 'before'
          expect(bid.userId.digitrustid).to.equal('222222');
        });
      });

      stubGetUser.restore();
      delete window.DigiTrust;
    });

    it('Handles no data returned from framework', function() {
      let callbackRef;
      const stubGetUser = sinon.stub(DigiTrust, 'getUser').callsFake(function fakeGetUser(data, callback) {
        // callback({success: false});
        callbackRef = callback;
      });
      window.DigiTrust = DigiTrust;

      config.setConfig({
        usersync: {
          syncDelay: 0,
          userIds: [createStorageConfig('digitrust', 'DigiTrust', 'cookie', 50000)]
        }
      });

      $$PREBID_GLOBAL$$.requestBids({adUnits});
      callbackRef({success: false});
      clock.tick(4000);

      // expect no webrequest since the framework is defined
      expect(requests.length).to.equal(0);
      // expect no cookie value to be saved since framework returned no data
      const digitrustCookie = utils.getCookie('DigiTrust');
      expect(typeof digitrustCookie === 'string').to.equal(false);
      expect(utils.logError.args.length).to.equal(2);
      // should get an error message that data was empty
      expect(utils.logError.args[1][0]).to.equal('User ID: digitrust - request id responded with an empty value');

      stubGetUser.restore();
      delete window.DigiTrust;
    });

    it('Handles error when calling framework method to get userid data', function() {
      const stubGetUser = sinon.stub(DigiTrust, 'getUser').onFirstCall().returns(undefined);
      stubGetUser.onSecondCall().throws('Error');

      window.DigiTrust = DigiTrust;

      config.setConfig({
        usersync: {
          syncDelay: 0,
          userIds: [createStorageConfig('digitrust', 'DigiTrust', 'cookie', 50000)]
        }
      });

      $$PREBID_GLOBAL$$.requestBids({adUnits});

      clock.tick(4000);

      // expect no webrequest since the framework is defined
      expect(requests.length).to.equal(0);
      // expect no cookie value to be saved since framework returned no data
      const digitrustCookie = utils.getCookie('DigiTrust');
      expect(typeof digitrustCookie === 'string').to.equal(false);
      expect(utils.logError.args.length).to.equal(3);
      // should get error messages for framework error and empty value
      expect(utils.logError.args[1][0]).to.equal('User ID - DigiTrustId framework error: Error');
      expect(utils.logError.args[2][0]).to.equal('User ID: digitrust - request id responded with an empty value');

      stubGetUser.restore();
      delete window.DigiTrust;
    });

    it('Decodes userid data and passes to bids when cookie value exists', function() {
      config.setConfig({
        usersync: {
          syncDelay: 0,
          userIds: [createStorageConfig('digitrust', 'DigiTrust.1', 'cookie', 50000)]}
      });

      $$PREBID_GLOBAL$$.requestBids({adUnits});

      adUnits.forEach((unit) => {
        unit.bids.forEach((bid) => {
          // verify that the id data was copied to bid
          expect(bid).to.have.deep.nested.property('userId.digitrustid');
          // should be the decoded value set by 'util.setCookie' in the 'before'
          expect(bid.userId.digitrustid).to.equal('678678678');
        });
      });
    });
  });
});
