// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Here we are testing a toy app (see https://github.com/jparyani/sandstorm-test-app/tree/powerbox
// for the code). It has an "offer" and "request" button that lets us test the basics of the
// copy/paste powerbox flow.

"use strict";

var utils = require("../utils"),
    short_wait = utils.short_wait,
    medium_wait = utils.medium_wait,
    long_wait = utils.long_wait,
    very_long_wait = utils.very_long_wait;

module.exports = {};

module.exports["Install Powerbox"] = function (browser) {
  browser
    .init()
    .installApp("http://sandstorm.io/apps/jparyani/powerbox-4.spk", "baaceb4cda0d9451968670a3d4ffe5e7", "jm40yaw7zvnxyggqt2dddp5ztt0f5wku7a8wfz8uzn9cjus46ygh")
    .assert.containsText("#grainTitle", "Untitled PowerboxTest");
};

module.exports["Test Powerbox"] = function (browser) {
  browser
    .waitForElementVisible('.grain-frame', short_wait)
    .frame("grain-frame")
      .waitForElementVisible("#offer", short_wait)
      .click("#offer")
      .waitForElementVisible("#offer-result", short_wait)
      .assert.containsText("#offer-result", "offer: success")
    .frameParent()
    .waitForElementVisible("#powerbox-offer-url", short_wait)
    .getText("#powerbox-offer-url", function (result) {
        browser
          .frame("grain-frame")
            .click("#request")
          .frameParent()
          .waitForElementVisible("#powerbox-request-input", short_wait)
          .setValue("#powerbox-request-input", result.value)
          .click("#powerbox-request-form button")
          .frame("grain-frame")
          .waitForElementVisible("#request-result", short_wait)
          .assert.containsText("#request-result", "request: footest")
          .end();
    });
};

// Source at https://github.com/jparyani/sandstorm-test-app/tree/powerbox-save
module.exports["Install PowerboxSave"] = function (browser) {
  browser
    .init()
    .installApp("http://sandstorm.io/apps/jparyani/powerbox-save-0.spk", "5af2a3ca2a4e99ff082c458321c85105", "f6pf7a9my5vrcxk22f00msk97zss1ukz5fvesuh2mxfhs8uzvwu0")
    .assert.containsText("#grainTitle", "Untitled PowerboxSaveTest");
};

module.exports["Test PowerboxSave"] = function (browser) {
  browser
    .waitForElementVisible('.grain-frame', short_wait)
    .frame("grain-frame")
      .waitForElementVisible("#offer", short_wait)
      .click("#offer")
      .waitForElementVisible("#offer-result", short_wait)
      .assert.containsText("#offer-result", "offer: success")
    .frameParent()
    .waitForElementVisible("#powerbox-offer-url", short_wait)
    .getText("#powerbox-offer-url", function (result) {
        browser
          .frame("grain-frame")
            .click("#request")
          .frameParent()
          .waitForElementVisible("#powerbox-request-input", short_wait)
          .setValue("#powerbox-request-input", result.value)
          .click("#powerbox-request-form button")
          .frame("grain-frame")
          .waitForElementVisible("#request-result", short_wait)
          .assert.containsText("#request-result", "request: footest")
          .end();
    });
};

// This powerbox app adds `requiredPermissions` to the `restore` call that aren't satisfied.
// We test to make sure an error is thrown.
// Source at https://github.com/jparyani/sandstorm-test-app/tree/powerbox-permissions
module.exports["Install Powerbox with failing requirements"] = function (browser) {
  browser
    .init()
    .installApp("http://sandstorm.io/apps/jparyani/powerbox-2.spk", "9d6493e63bc9919de3959fe0c5a131ad", "jm40yaw7zvnxyggqt2dddp5ztt0f5wku7a8wfz8uzn9cjus46ygh")
    .assert.containsText("#grainTitle", "Untitled PowerboxTest sandstormtest");
};

module.exports["Test Powerbox with failing requirements"] = function (browser) {
  browser
    // We'll use the debugLog at the bottom of the test, but it's nice to open it early and give it time to load.
    .click("#openDebugLog")
    .waitForElementVisible('.grain-frame', short_wait)
    .frame("grain-frame")
      .waitForElementVisible("#offer", short_wait)
      .click("#offer")
      .waitForElementVisible("#offer-result", short_wait)
      .assert.containsText("#offer-result", "offer: success")
    .frameParent()
    .waitForElementVisible("#powerbox-offer-url", short_wait)
    .getText("#powerbox-offer-url", function (result) {
        browser
          .frame("grain-frame")
            .click("#request")
          .frame()
          .waitForElementVisible("#powerbox-request-input", short_wait)
          .setValue("#powerbox-request-input", result.value)
          .click("#powerbox-request-form button")
          .frame("grain-frame")
            .waitForElementVisible("#request-result", short_wait)
            .assert.containsText("#request-result", "request:")
            .windowHandles(function (windows) {
              browser
                .switchWindow(windows.value[1])
                .waitForElementVisible(".grainlog-contents > pre", short_wait)
                .assert.containsText(".grainlog-contents > pre", "Error: Requirements not satisfied")
                .end();
            });
    })
};

// This tests the basic functionality of the inline powerbox.
// Source: https://github.com/jparyani/sandstorm-test-app/tree/inline-powerbox
module.exports["Install Inline Powerbox"] = function (browser) {
  browser
    .init()
    .installApp("http://sandstorm.io/apps/jparyani/inline-powebox-test-1.spk", "b58a280b3ca4dc72c8fc4c7b41d3e03d", "8stkfx4ez54109qzmzjtthaq105nf7f4sqfdzzp00g22p1r3uxg0")
    .assert.containsText("#grainTitle", "Untitled InlinePowerboxTest");
};

module.exports["Test Inline Powerbox"] = function (browser) {
  browser
    .waitForElementVisible("#grain-frame", short_wait)
    .frame("grain-frame")
    .waitForElementVisible("#inline-powerbox", short_wait)
    .click("#inline-powerbox")
    .frame()
    .execute(function () {
      // Sandstorm's inline powerbox defines a special event called testInput for testing purposes
      var ev = new CustomEvent("testInput", {
        detail: {
          keys: "https://sandstorm.io/apps/jparyani/test_inline_powerbox ",
        },
        bubbles: false,
        cancelable: true,
      });
      document.querySelector(".inline-powerbox").dispatchEvent(ev);
    })
    .frame("grain-frame")
    .waitForElementVisible("#request-result", short_wait)
    .assert.containsText("#request-result", "successfully fetched page");
};

module.exports["Install Faling Inline Powerbox"] = function (browser) {
  browser
    .init()
    .installApp("http://sandstorm.io/apps/jparyani/inline-powebox-test-1.spk", "b58a280b3ca4dc72c8fc4c7b41d3e03d", "8stkfx4ez54109qzmzjtthaq105nf7f4sqfdzzp00g22p1r3uxg0")
    .assert.containsText("#grainTitle", "Untitled InlinePowerboxTest");
};

module.exports["Test Faling Inline Powerbox"] = function (browser) {
  browser
    .waitForElementVisible("#grain-frame", short_wait)
    .frame("grain-frame")
    .waitForElementVisible("#inline-powerbox", short_wait)
    .click("#inline-powerbox")
    .frame()
    .execute(function () {
      // Sandstorm's inline powerbox defines a special event called testInput for testing purposes
      var ev = new CustomEvent("testInput", {
        detail: {
          keys: "http://local.sandstorm.io " // This resolves to 127.0.0.1
        },
        bubbles: false,
        cancelable: true,
      });
      document.querySelector(".inline-powerbox").dispatchEvent(ev);
    })
    .frame("grain-frame")
    .waitForElementPresent("#request-error", short_wait)
    .assert.containsText("#request-error", "Domain resolved to an invalid IP")
    .end();
};
