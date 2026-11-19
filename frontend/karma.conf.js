const os = require('os');
const path = require('path');

module.exports = function (config) {
  config.set({
    basePath: '',
    frameworks: ['jasmine', '@angular-devkit/build-angular'],
    plugins: [
      require('karma-jasmine'),
      require('karma-chrome-launcher'),
      require('karma-jasmine-html-reporter'),
      require('karma-coverage'),
      require('@angular-devkit/build-angular/plugins/karma'),
    ],
    client: { jasmine: { random: false }, clearContext: false },
    reporters: ['progress', 'kjhtml'],
    browsers: ['ChromeHeadlessCI'],
    customLaunchers: {
      ChromeHeadlessCI: { base: 'ChromeHeadless', flags: ['--no-sandbox', '--disable-gpu', '--user-data-dir=' + path.join(os.tmpdir(), 'wakara-karma-profile')] },
    },
    restartOnFileChange: true,
    // the measurement of thousands of dossiers (offline.spec.ts) takes a while without any message to the runner
    browserNoActivityTimeout: 180000, browserDisconnectTimeout: 30000,
  });
};
