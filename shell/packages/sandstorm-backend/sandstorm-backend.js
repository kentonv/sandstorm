// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2015 Sandstorm Development Group, Inc. and contributors
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

var Capnp = Npm.require("capnp");
var Backend = Capnp.importSystem("sandstorm/backend.capnp").Backend;
var Crypto = Npm.require("crypto");
var Future = Npm.require("fibers/future");
var Promise = Npm.require("es6-promise").Promise;

var inMeteorInternal = Meteor.bindEnvironment(function (callback) {
  callback();
});

inMeteor = function (callback) {
  // Calls the callback in a Meteor context.  Returns a Promise for its result.
  return new Promise(function (resolve, reject) {
    inMeteorInternal(function () {
      try {
        resolve(callback());
      } catch (err) {
        reject(err);
      }
    });
  });
}

promiseToFuture = function (promise) {
  var result = new Future();
  promise.then(result.return.bind(result), result.throw.bind(result));
  return result;
}

waitPromise = function (promise) {
  return promiseToFuture(promise).wait();
}

SANDSTORM_ALTHOME = Meteor.settings && Meteor.settings.home;

SandstormBackend = function(db, backendCap) {
  this._db = db;
  this.runningGrains = {};
  this._backendCap = backendCap
}

SandstormBackend.prototype.cap = function() {
  return this._backendCap;
}

SandstormBackend.prototype.shutdownGrain = function (grainId, ownerId, keepSessions) {
  if (!keepSessions) {
    Sessions.remove({grainId: grainId});
    delete this.runningGrains[grainId];
  }

  var grain = this._backendCap.getGrain(ownerId, grainId).supervisor;
  return grain.shutdown().then(function () {
    grain.close();
    throw new Error("expected shutdown() to throw disconnected");
  }, function (err) {
    grain.close();
    if (err.kjType !== "disconnected") {
      throw err;
    }
  });
}

SandstormBackend.prototype.deleteGrain = function (grainId, ownerId) {
  // We leave it up to the caller if they want to actually wait, but some don't so we report
  // exceptions.
  return this._backendCap.deleteGrain(ownerId, grainId).catch(function (err) {
    console.error("problem deleting grain " + grainId + ":", err.message);
    throw err;
  });
}


SandstormBackend.prototype.openGrain = function (grainId, isRetry) {
  // Create a Cap'n Proto connection to the given grain. Note that this function does not actually
  // verify that the connection succeeded. Instead, if an RPC call to the connection fails, check
  // shouldRestartGrain(). If it returns true, call continueGrain() and then openGrain()
  // again with isRetry = true, and then retry.
  //
  // Must be called in a Meteor context.

  if (isRetry) {
    // Since this is a retry, try starting the grain even if we think it's already running.
    return this.continueGrain(grainId);
  } else {
    // Start the grain if it is not running.
    var runningGrain = this.runningGrains[grainId];
    if (runningGrain) {
      return waitPromise(runningGrain);
    } else {
      return this.continueGrain(grainId);
    }
  }
}

SandstormBackend.shouldRestartGrain = function (error, retryCount) {
  // Given an error thrown by an RPC call to a grain, return whether or not it makes sense to try
  // to restart the grain and retry. `retryCount` is the number of times that the request has
  // already gone through this cycle (should be zero for the first call).

  return error.kjType === "disconnected" && retryCount < 1;
}

SandstormBackend.prototype.maybeRetryUseGrain = function (grainId, cb, retryCount, err) {
  var self = this;
  if (SandstormBackend.shouldRestartGrain(err, retryCount)) {
    return inMeteor(function () {
      return cb(self.openGrain(grainId, true).supervisor)
          .catch(self.maybeRetryUseGrain.bind(undefined, grainId, cb, retryCount + 1));
    });
  } else {
    throw err;
  }
}

SandstormBackend.prototype.useGrain = function (grainId, cb) {
  // This will open a grain for you, handling restarts if needed, and call the passed function with
  // the supervisor capability as the only parameter. The callback must return a promise that used
  // the supervisor, so that we can check if a disconnect error occurred, and retry if possible.
  // This function returns the same promise that your callback returns.
  //
  // This function is NOT expected to be run in a meteor context.

  var runningGrain = this.runningGrains[grainId];
  var self = this;
  if (runningGrain) {
    return runningGrain.then(function (grainInfo) {
      return cb(grainInfo.supervisor);
    }).catch(self.maybeRetryUseGrain.bind(undefined, grainId, cb, 0));
  } else {
    return inMeteor(function () {
      return cb(self.openGrain(grainId, false).supervisor)
          .catch(self.maybeRetryUseGrain.bind(undefined, grainId, cb, 0));
    });
  }
}

SandstormBackend.prototype.continueGrain = function(grainId) {
  var grain = Grains.findOne(grainId);
  if (!grain) {
    throw new Meteor.Error(404, "Grain Not Found", "Grain ID: " + grainId);
  }

  var manifest;
  var packageId;
  var devApp = DevApps.findOne({_id: grain.appId});
  var isDev;
  if (devApp) {
    // If a DevApp with the same app ID is currently active, we let it override the installed
    // package, so that the grain runs using the dev app.
    manifest = devApp.manifest;
    packageId = devApp.packageId;
    isDev = true;
  } else {
    var pkg = Packages.findOne(grain.packageId);
    if (pkg) {
      manifest = pkg.manifest;
      packageId = pkg._id;
    } else {
      throw new Meteor.Error(500, "Grain's package not installed",
                             "Package ID: " + grain.packageId);
    }
  }

  if (!("continueCommand" in manifest)) {
    throw new Meteor.Error(500, "Package manifest defines no continueCommand.",
                           "Package ID: " + packageId);
  }

  return this.startGrainInternal(
      packageId, grainId, grain.userId, manifest.continueCommand, false, isDev);
}

SandstormBackend.prototype.startGrainInternal = function(packageId, grainId, ownerId, command, isNew, isDev) {
  // Starts the grain supervisor.  Must be executed in a Meteor context.  Blocks until grain is
  // started. Returns a promise for an object containing two fields: `owner` (the ID of the owning
  // user) and `supervisor` (the supervisor capability).

  if (isUserExcessivelyOverQuota(Meteor.users.findOne(ownerId))) {
    throw new Meteor.Error(402, "Cannot start grain because owner's storage is exhausted.");
  }

  // Ugly: Stay backwards-compatible with old manifests that had "executablePath" and "args" rather
  //   than just "argv".
  if ("args" in command) {
    if (!("argv" in command)) {
      command.argv = command.args;
    }
    delete command.args;
  }
  if ("executablePath" in command) {
    if (!("deprecatedExecutablePath" in command)) {
      command.deprecatedExecutablePath = command.executablePath;
    }
    delete command.executablePath;
  }

  var whenReady = this._backendCap.startGrain(ownerId, grainId, packageId, command, isNew, isDev)
      .then(function (results) {
    return {
      owner: ownerId,
      supervisor: results.supervisor
    };
  });

  this.runningGrains[grainId] = whenReady;
  return waitPromise(whenReady);
}

SandstormBackend.prototype.updateLastActive = function(grainId, userId, identityId) {
  // Update the lastActive date on the grain, any relevant API tokens, and the user,
  // and also update the user's storage usage.

  var storagePromise = undefined;
  if (Meteor.settings.public.quotaEnabled) {
    storagePromise = globalBackend._backendCap.getUserStorageUsage(userId);
  }

  var now = new Date();
  Grains.update(grainId, {$set: {lastUsed: now}});
  if (userId) {
    Meteor.users.update(userId, {$set: {lastActive: now}});
  }
  if (identityId) {
    // Update any API tokens that match this user/grain pairing as well
    var now = new Date();
    ApiTokens.update({"grainId": grainId, "owner.user.identityId": identityId},
        {$set: {"owner.user.lastUsed": now }});
  }

  if (Meteor.settings.public.quotaEnabled) {
    try {
      var ownerId = Grains.findOne(grainId).userId;
      var size = parseInt(waitPromise(storagePromise).size);
      Meteor.users.update(ownerId, {$set: {storageUsage: size}});
      // TODO(security): Consider actively killing grains if the user is excessively over quota?
      //   Otherwise a constantly-active grain could consume arbitrary space without being stopped.
    } catch (err) {
      if (err.kjType !== "unimplemented") {
        console.error("error getting user storage usage:", err.stack);
      }
    }
  }
}


function generateSessionId(grainId, userId, salt) {
  var sessionParts = [grainId, salt];
  if (userId) {
    sessionParts.push(userId);
  }
  var sessionInput = sessionParts.join(":");
  return Crypto.createHash("sha256").update(sessionInput).digest("hex");
}

SandstormBackend.prototype.openSessionInternal = function (grainId, userId, identityId, title, apiToken, cachedSalt) {

  // Start the grain if it is not running. This is an optimization: if we didn't start it here,
  // it would start on the first request to the session host, but we'd like to get started before
  // the round trip.
  var runningGrain = this.runningGrains[grainId];
  var grainInfo;
  if (runningGrain) {
    grainInfo = waitPromise(runningGrain);
  } else {
    grainInfo = this.continueGrain(grainId);
  }

  this.updateLastActive(grainId, userId, identityId);

  cachedSalt = cachedSalt || Random.id(22);
  var sessionId = generateSessionId(grainId, userId, cachedSalt);
  var session = Sessions.findOne({_id: sessionId});
  if (session) {
    // TODO(someday): also do some more checks for anonymous sessions (sessions without a userId).
    if ((session.identityId && session.identityId !== identityId) ||
        (session.grainId !== grainId)) {
      var e = new Meteor.Error(500, "Duplicate SessionId");
      console.error(e);
      throw e;
    } else {
      return {sessionId: session._id, title: title, grainId: grainId, hostId: session.hostId, salt: cachedSalt};
    }
  }

  session = {
    _id: sessionId,
    grainId: grainId,
    hostId: Crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 32),
    timestamp: new Date().getTime(),
    hasLoaded: false
  };

  if (userId) {
    session.identityId = identityId;
    session.userId = userId;
  } else if (apiToken) {
    session.hashedToken = apiToken._id;
  } else {
    // Must be old-style sharing, i.e. !grain.private.
  }

  Sessions.insert(session);

  return {sessionId: session._id, title: title, grainId: grainId, hostId: session.hostId, salt: cachedSalt};
}
