require('test/helpers/prebidGlobal.js');
require('test/mocks/adloaderStub.js');
require('test/mocks/xhr.js');

var testsContext = require.context('.', true, /(priceFloors)|(pbjs_api)_spec$/);

testsContext.keys().forEach(testsContext);

// [
//   // './spec/AnalyticsAdapter_spec',
//   // './spec/adUnits_spec',
//   // './spec/adapters/adbutler_spec',
//   // './spec/adloader_spec',
//   // './spec/aliasBidder_spec',
//   // './spec/api_spec',
//   // './spec/auctionmanager_spec',
//   // './spec/config_spec',
//   // './spec/cpmBucketManager_spec',
//   // './spec/debugging_spec',
//   './spec/modules/priceFloors_spec',
//   // './spec/native_spec',
//   // './spec/refererDetection_spec',
//   // './spec/renderer_spec',
//   // './spec/sizeMapping_spec',
//   // './spec/unit/adServerManager_spec',
//   // './spec/unit/adUnits_spec',
//   // './spec/unit/core/adapterManager_spec',
//   // './spec/unit/core/bidderFactory_spec',
//   // './spec/unit/core/targeting_spec',
//   './spec/unit/pbjs_api_spec',
//   // './spec/unit/secureCreatives_spec',
//   // './spec/url_spec',
//   // './spec/userSync_spec',
//   // './spec/utils_spec',
//   // './spec/videoCache_spec',
//   // './spec/video_spec'
// ].forEach(testsContext);

window.$$PREBID_GLOBAL$$.processQueue();
