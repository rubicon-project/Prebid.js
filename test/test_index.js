require('test/helpers/prebidGlobal.js');
require('test/mocks/adloaderStub.js');
require('test/mocks/xhr.js');

var testsContext = require.context('.', true, /(priceFloors)|(pbjs_api)_spec$/);

testsContext.keys().forEach(testsContext);

window.$$PREBID_GLOBAL$$.processQueue();
