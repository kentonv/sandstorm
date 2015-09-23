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

var Crypto = Npm.require("crypto");
var ChildProcess = Npm.require("child_process");
var Fs = Npm.require("fs");
var Path = Npm.require("path");
var Future = Npm.require("fibers/future");
var Http = Npm.require("http");
var Url = Npm.require("url");
var Promise = Npm.require("es6-promise").Promise;
var Capnp = Npm.require("capnp");
var Net = Npm.require("net");

var ByteStream = Capnp.importSystem("sandstorm/util.capnp").ByteStream;
var ApiSession = Capnp.importSystem("sandstorm/api-session.capnp").ApiSession;
var WebSession = Capnp.importSystem("sandstorm/web-session.capnp").WebSession;
var HackSession = Capnp.importSystem("sandstorm/hack-session.capnp");
var Supervisor = Capnp.importSystem("sandstorm/supervisor.capnp").Supervisor;
var Backend = Capnp.importSystem("sandstorm/backend.capnp").Backend;

SANDSTORM_ALTHOME = Meteor.settings && Meteor.settings.home;
SANDSTORM_LOGDIR = (SANDSTORM_ALTHOME || "") + "/var/log";
SANDSTORM_VARDIR = (SANDSTORM_ALTHOME || "") + "/var/sandstorm";

sandstormExe = function (progname) {
  if (SANDSTORM_ALTHOME) {
    return SANDSTORM_ALTHOME + "/latest/bin/" + progname;
  } else {
    return progname;
  }
}

sandstormBackendConnection = Capnp.connect("unix:" + (SANDSTORM_ALTHOME || "") + Backend.socketPath,
  makeSandstormCoreFactory());
sandstormBackend = sandstormBackendConnection.restore(null, Backend);

// =======================================================================================
// Meteor context <-> Async Node.js context adapters
// TODO(cleanup):  Move to a different file.

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

// =======================================================================================
// API for creating / starting grains from Meteor methods.

var runningGrains = {};
var proxiesByHostId = {};

Meteor.methods({
  newGrain: function (packageId, command, title) {
    // Create and start a new grain.

    check(packageId, String);
    check(command, Object);  // Manifest.Command from package.capnp.
    check(title, String);

    if (!this.userId) {
      throw new Meteor.Error(403, "Unauthorized", "Must be logged in to create grains.");
    }

    if (!isSignedUpOrDemo()) {
      throw new Meteor.Error(403, "Unauthorized",
                             "Only invited users or demo users can create grains.");
    }

    if (isUserOverQuota(Meteor.user())) {
      throw new Meteor.Error(402,
          "You are out of storage space. Please delete some things and try again.");
    }

    var pkg = Packages.findOne(packageId);
    var appId;
    var manifest;
    var isDev = false;
    if (pkg) {
      appId = pkg.appId;
      manifest = pkg.manifest;
    } else {
      var devApp = DevApps.findOne({packageId: packageId});
      if (devApp) {
        appId = devApp._id;
        manifest = devApp.manifest;
        isDev = true;
      } else {
        throw new Meteor.Error(404, "Not Found", "No such package is installed.");
      }
    }
    var userIdentity = this.connection.sandstormDb.getUserIdentities(this.userId)[0];

    var grainId = Random.id(22);  // 128 bits of entropy
    Grains.insert({
      _id: grainId,
      packageId: packageId,
      appId: appId,
      appVersion: manifest.appVersion,
      userId: this.userId,
      identityId: userIdentity.id,
      title: title,
      private: true
    });
    startGrainInternal(packageId, grainId, this.userId, command, true, isDev);
    updateLastActive(grainId, this.userId, userIdentity.id);
    return grainId;
  },

  openSession: function (grainId, cachedSalt) {
    // Open a new UI session on an existing grain.  Starts the grain if it is not already
    // running.

    check(grainId, String);
    var db = this.connection.sandstormDb;
    var identity = db.getUserIdentities(this.userId)[0];
    check(cachedSalt, Match.OneOf(undefined, null, String));
    if (!SandstormPermissions.mayOpenGrain(db,
                                           {grain: {_id: grainId, identityId: identity.id}})) {
      throw new Meteor.Error(403, "Unauthorized", "User is not authorized to open this grain.");
    }

    return openSessionInternal(grainId, Meteor.user(), null, null, cachedSalt);
  },

  openSessionFromApiToken: function(params, cachedSalt) {
    // Given an API token, either opens a new WebSession to the underlying grain or returns a
    // path to which the client should redirect in order to open such a session.

    check(params, {
      token: String,
      incognito: Boolean,
    });
    check(cachedSalt, Match.OneOf(undefined, null, String));

    var token = params.token;
    var incognito = params.incognito;
    var hashedToken = Crypto.createHash("sha256").update(token).digest("base64");
    var apiToken = ApiTokens.findOne(hashedToken);
    validateWebkey(apiToken);
    var grain = Grains.findOne({_id: apiToken.grainId});
    if (!grain) {
      throw new Meteor.Error(404, "Grain not found", "Grain ID: " + apiToken.grainId);
    }
    var pkg = Packages.findOne({_id: grain.packageId});
    var appTitle = (pkg && pkg.manifest && pkg.manifest.appTitle) || { defaultText: ""};
    var appIcon = undefined;
    if (pkg && pkg.manifest && pkg.manifest.metadata && pkg.manifest.metadata.icons) {
      var icons = pkg.manifest.metadata.icons;
      appIcon = icons.grain || icons.appGrid;
    }
    // Only provide an app ID if we have no icon asset to provide and need to offer an identicon.
    var appId = appIcon ? undefined : grain.appId;
    var title;
    if (grain.identityId == apiToken.identityId) {
      title = grain.title;
    } else {
      if (apiToken.identityId) {
        var sharerToken = ApiTokens.findOne({grainId: apiToken.grainId,
                                             "owner.user.identityId": apiToken.identityId},
                                            {sort : {created : 1}});
        if (sharerToken) {
          title = sharerToken.owner.user.title;
        }
      }
    }

    if (this.userId && !incognito) {
      var identity = globalDb.getUserIdentities(this.userId)[0];
      if (identity.id != apiToken.identityId && identity.id != grain.identityId &&
          !ApiTokens.findOne({'owner.user.identityId': identity.id, parentToken: hashedToken })) {
        // The current user is neither the sharer nor the grain owner,
        // and the current user has not already redeemed this token.
        var now = new Date();
        var grainInfo = { appTitle: appTitle };
        if (appIcon) { grainInfo.icon = appIcon; }
        if (appId) { grainInfo.appId = appId; }
        var owner = {user: {identityId: identity.id, title: title, lastUsed: now,
                            denormalizedGrainMetadata: grainInfo}};
        var newToken = {
          grainId: apiToken.grainId,
          identityId: apiToken.identityId,
          parentToken: hashedToken,
          roleAssignment: {allAccess: null},
          petname: apiToken.petname,
          created: new Date(),
          owner: owner,
        };
        ApiTokens.insert(newToken);
      }
      return {redirectToGrain: apiToken.grainId};
    } else {
      if (!SandstormPermissions.mayOpenGrain(globalDb, {token: apiToken})) {
        throw new Meteor.Error(403, "Unauthorized",
                               "User is not authorized to open this grain.");
      }
      return openSessionInternal(apiToken.grainId, null, title, apiToken, cachedSalt);
    }
  },

  keepSessionAlive: function (sessionId) {
    // TODO(security):  Prevent draining someone else's quota by holding open several grains shared
    //   by them.
    check(sessionId, String);

    var session = Sessions.findAndModify({
      query: {_id: sessionId},
      update: {$set: {timestamp: new Date().getTime()}},
      fields: {grainId: 1}
    });

    if (session) {
      // Session still present in database, so send keep-alive to backend.

      var grainId = session.grainId;
      waitPromise(openGrain(grainId, false).supervisor.keepAlive());
      updateLastActive(grainId, this.userId, session.identityId);
      return true;
    } else {
      return false;
    }
  },

  shutdownGrain: function (grainId) {
    check(grainId, String);
    var grain = Grains.findOne(grainId);
    if (!grain || !this.userId || grain.userId !== this.userId) {
      throw new Meteor.Error(403, "Unauthorized", "User is not the owner of this grain");
    }

    waitPromise(shutdownGrain(grainId, grain.userId, true));
  }
});

function validateWebkey (apiToken, refreshedExpiration) {
  // Validates that `apiToken` is a valid UiView webkey, throwing an exception if it is not. If
  // `refreshedExpiration` is set and if the token has an `expiresIfUnused` field, then the
  // `expiresIfUnused` field is reset to `refreshedExpiration`.

  if (!apiToken) {
    throw new Meteor.Error(403, "Invalid authorization token");
  }
  if (apiToken.revoked) {
    throw new Meteor.Error(403, "Authorization token has been revoked");
  }
  if (apiToken.owner && !("webkey" in apiToken.owner)) {
    throw new Meteor.Error(403, "Unauthorized to open non-webkey token.");
  }

  if (apiToken.expires && apiToken.expires.getTime() <= Date.now()) {
    throw new Meteor.Error(403, "Authorization token expired");
  }

  if (apiToken.expiresIfUnused) {
    if (apiToken.expiresIfUnused.getTime() <= Date.now()) {
      throw new Meteor.Error(403, "Authorization token expired");
    } else if (refreshedExpiration) {
      ApiTokens.update(apiToken._id, {$set: {expiresIfUnused: refreshedExpiration}});
    } else {
      // It's getting used now, so clear the expiresIfUnused field.
      ApiTokens.update(apiToken._id, {$set: {expiresIfUnused: null}});
    }
  }

  if (apiToken.objectId || apiToken.frontendRef) {
    throw new Meteor.Error(403, "ApiToken refers to a non-webview Capability.");
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

function openSessionInternal(grainId, user, title, apiToken, cachedSalt) {
  var userId = user ? user._id : undefined;
  var identityId = user ? SandstormDb.getUserIdentities(user)[0].id : undefined;

  // Start the grain if it is not running. This is an optimization: if we didn't start it here,
  // it would start on the first request to the session host, but we'd like to get started before
  // the round trip.
  var runningGrain = runningGrains[grainId];
  var grainInfo;
  if (runningGrain) {
    grainInfo = waitPromise(runningGrain);
  } else {
    grainInfo = continueGrain(grainId);
  }

  updateLastActive(grainId, userId, identityId);

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

function updateLastActive(grainId, userId, identityId) {
  // Update the lastActive date on the grain, any relevant API tokens, and the user,
  // and also update the user's storage usage.

  var storagePromise = undefined;
  if (Meteor.settings.public.quotaEnabled) {
    storagePromise = sandstormBackend.getUserStorageUsage(userId);
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

openGrain = function (grainId, isRetry) {
  // Create a Cap'n Proto connection to the given grain. Note that this function does not actually
  // verify that the connection succeeded. Instead, if an RPC call to the connection fails, check
  // shouldRestartGrain(). If it returns true, call continueGrain() and then openGrain()
  // again with isRetry = true, and then retry.
  //
  // Must be called in a Meteor context.

  if (isRetry) {
    // Since this is a retry, try starting the grain even if we think it's already running.
    return continueGrain(grainId);
  } else {
    // Start the grain if it is not running.
    var runningGrain = runningGrains[grainId];
    if (runningGrain) {
      return waitPromise(runningGrain);
    } else {
      return continueGrain(grainId);
    }
  }
}

shouldRestartGrain = function (error, retryCount) {
  // Given an error thrown by an RPC call to a grain, return whether or not it makes sense to try
  // to restart the grain and retry. `retryCount` is the number of times that the request has
  // already gone through this cycle (should be zero for the first call).

  return error.kjType === "disconnected" && retryCount < 1;
}

function maybeRetryUseGrain(grainId, cb, retryCount, err) {
  if (shouldRestartGrain(err, retryCount)) {
    return inMeteor(function () {
      return cb(openGrain(grainId, true).supervisor)
          .catch(maybeRetryUseGrain.bind(undefined, grainId, cb, retryCount + 1));
    });
  } else {
    throw err;
  }
}

useGrain = function (grainId, cb) {
  // This will open a grain for you, handling restarts if needed, and call the passed function with
  // the supervisor capability as the only parameter. The callback must return a promise that used
  // the supervisor, so that we can check if a disconnect error occurred, and retry if possible.
  // This function returns the same promise that your callback returns.
  //
  // This function is NOT expected to be run in a meteor context.

  var runningGrain = runningGrains[grainId];
  if (runningGrain) {
    return runningGrain.then(function (grainInfo) {
      return cb(grainInfo.supervisor);
    }).catch(maybeRetryUseGrain.bind(undefined, grainId, cb, 0));
  } else {
    return inMeteor(function () {
      return cb(openGrain(grainId, false).supervisor)
          .catch(maybeRetryUseGrain.bind(undefined, grainId, cb, 0));
    });
  }
}

function continueGrain(grainId) {
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

  return startGrainInternal(
      packageId, grainId, grain.userId, manifest.continueCommand, false, isDev);
}

function startGrainInternal(packageId, grainId, ownerId, command, isNew, isDev) {
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

  var whenReady = sandstormBackend.startGrain(ownerId, grainId, packageId, command, isNew, isDev)
      .then(function (results) {
    return {
      owner: ownerId,
      supervisor: results.supervisor
    };
  });

  runningGrains[grainId] = whenReady;
  return waitPromise(whenReady);
}

shutdownGrain = function (grainId, ownerId, keepSessions) {
  if (!keepSessions) {
    Sessions.remove({grainId: grainId});
    delete runningGrains[grainId];
  }

  var grain = sandstormBackend.getGrain(ownerId, grainId).supervisor;
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

deleteGrain = function (grainId, ownerId) {
  // We leave it up to the caller if they want to actually wait, but some don't so we report
  // exceptions.
  return sandstormBackend.deleteGrain(ownerId, grainId).catch(function (err) {
    console.error("problem deleting grain " + grainId + ":", err.message);
    throw err;
  });
}

getGrainSize = function (supervisor, oldSize) {
  var promise;
  if (oldSize === undefined) {
    promise = supervisor.getGrainSize();
  } else {
    promise = supervisor.getGrainSizeWhenDifferent(oldSize);
  }

  var promise2 = promise.then(function (result) { return parseInt(result.size); });
  promise2.cancel = function () { promise.cancel(); }

  return promise2;
}

Meteor.startup(function () {
  function shutdownApp(appId) {
    Grains.find({appId: appId}).forEach(function(grain) {
      waitPromise(shutdownGrain(grain._id, grain.userId));
    });
  }

  DevApps.find().observeChanges({
    removed: shutdownApp,
    updated: shutdownApp,
    added:   shutdownApp,
  });

  Sessions.find().observe({
    removed : function(session) {
      delete proxiesByHostId[session.hostId];
    }
  });
});

// Kill off sessions idle for >~3 minutes.
var TIMEOUT_MS = 180000;
function gcSessions() {
  var now = new Date().getTime();
  Sessions.remove({timestamp: {$lt: (now - TIMEOUT_MS)}});
}
SandstormDb.periodicCleanup(TIMEOUT_MS, gcSessions);

var getProxyForHostId = function (hostId) {
  // Get the Proxy corresponding to the given grain session host, possibly (re)creating it if it
  // doesn't already exist. The first request on the session host will always create a new proxy.
  // Later requests may create a proxy if they go to a different front-end replica or if the
  // front-end was restarted.
  check(hostId, String);

  return Promise.resolve(undefined).then(function () {
    var proxy = proxiesByHostId[hostId]
    if (proxy) {
      return proxy;
    } else {
      // Set table entry to null for now so that we can detect if it is concurrently deleted.
      proxiesByHostId[hostId] = null;

      return inMeteor(function () {
        var session = Sessions.findOne({hostId: hostId});
        if (!session) {
          // Does not appear to be a valid session host.
          return undefined;
        }

        var apiToken;
        if (session.hashedToken) {
          apiToken = ApiTokens.findOne({_id: session.hashedToken});
          // We don't have to fully validate the API token here because if it changed the session
          // would have been deleted.
          if (!apiToken) {
            throw new Meteor.Error(410, "ApiToken has been deleted");
          }
        }

        var grain = Grains.findOne(session.grainId);
        if (!grain) {
          // Grain was deleted, I guess.
          throw new Meteor.Error(410, "Resource has been deleted");
        }

        // Note that we don't need to call mayOpenGrain() because the existence of a session
        // implies this check was already performed.

        var user = session.userId && Meteor.users.findOne(session.userId);

        var proxy = new Proxy(grain._id, grain.userId, session._id, hostId,
                              user && user._id === grain._id, user, null, false);
        if (apiToken) proxy.apiToken = apiToken;

        // Only add the proxy to the table if it was not concurrently deleted (which could happen
        // e.g. if the user's access was revoked).
        if (hostId in proxiesByHostId) {
          proxiesByHostId[hostId] = proxy;
        } else {
          throw new Meteor.Error(403, "Session was concurrently closed.");
        }

        return proxy;
      });
    }
  });
}

// =======================================================================================
// API tokens

var proxiesByApiToken = {};

Meteor.startup(function() {
  function clearSessionsAndProxies (token) {
    // Clears all sessions and API proxies associated with `token` or any token that is downstream
    // in the sharing graph.
    // TODO(soon): Only clear sessions and proxies for which the permissions have changed.
    var downstream = SandstormPermissions.downstreamTokens(globalDb, {token: token});
    downstream.push(token);
    var identityIds = [];
    var tokenIds = [];
    downstream.forEach(function (token) {
      var proxy = proxiesByApiToken[token._id];
      if (proxy) {
        proxy.close();
      }
      delete proxiesByApiToken[token._id];
      tokenIds.push(token._id);
      if (token.owner && token.owner.user){
        identityIds.push(token.owner.user.identityId);
      }
    });
    Sessions.find({grainId: token.grainId,
                   $or: [{identityId: {$in: identityIds}},
                         {hashedToken: {$in: tokenIds}}]},
                  {fields: {hostId: 1}}).forEach(function (session) {
      var proxy = proxiesByHostId[session.hostId];
      if (proxy) {
        proxy.close();
      }
      delete proxiesByHostId[session.hostId];
    });
    Sessions.remove({grainId: token.grainId, $or: [{identityId: {$in: identityIds}},
                                                   {hashedToken: {$in: tokenIds}}]});
  }

  Grains.find().observe({
    changed: function (newGrain, oldGrain) {
      if (oldGrain.private != newGrain.private) {
        Sessions.remove({grainId: oldGrain._id, identityId: {$ne: oldGrain.identityId}});
        ApiTokens.find({grainId: oldGrain._id}).forEach(function(apiToken) {
          delete proxiesByApiToken[apiToken._id];
        });
      }
    },
  });

  ApiTokens.find({grainId: {$exists: true}, objectId: {$exists: false}}).observe({
    added: function (newApiToken) {
      // TODO(soon): Unfortunately, added() gets called for all existing role assignments when the
      //   front-end restarts, meaning clearing sessions here will cause people's views to refresh
      //   on server upgrade, which is not a nice user experience. It's also sad to force-refresh
      //   people when they gained new permissions since they might be in the middle of something,
      //   and it's not strictly necessary for security. OTOH, it's sad to be non-reactive. Maybe
      //   we should notify people that they have new permissions and let them click a thing to
      //   refresh?
//      clearSessions(roleAssignment.grainId, roleAssignment.recipient);
//      clearApiProxies(roleAssignment.grainId);
    },

    changed : function (newApiToken, oldApiToken) {
      if (!_.isEqual(newApiToken.roleAssignment, oldApiToken.roleAssignment) ||
          !_.isEqual(newApiToken.revoked, oldApiToken.revoked)) {
        clearSessionsAndProxies(newApiToken);
      }
    },

    removed: function (oldApiToken) {
      clearSessionsAndProxies(oldApiToken);
    }
  });
});

getProxyForApiToken = function (token) {
  check(token, String);
  var hashedToken = Crypto.createHash("sha256").update(token).digest("base64");
  return Promise.resolve(undefined).then(function () {
    var proxy = proxiesByApiToken[hashedToken];
    if (proxy) {
      if (proxy.expires && proxy.expires.getTime() <= Date.now()) {
        throw new Meteor.Error(403, "Authorization token expired");
      }
      return proxy;
    } else {
      // Set table entry to null for now so that we can detect if it is concurrently deleted.
      proxiesByApiToken[hashedToken] = null;

      return inMeteor(function () {
        var tokenInfo = ApiTokens.findOne(hashedToken);
        validateWebkey(tokenInfo);

        var grain = Grains.findOne(tokenInfo.grainId);
        if (!grain) {
          // Grain was deleted, I guess.
          throw new Meteor.Error(410, "Resource has been deleted");
        }

        var proxy;
        if (tokenInfo.userId) {
          var user = null;
          if (!tokenInfo.forSharing) {
            user = Meteor.users.findOne({_id: tokenInfo.userId});
            if (!user) {
              throw new Meteor.Error(403, "User has been deleted");
            }
          }

          var isOwner = grain.userId === tokenInfo.userId;
          proxy = new Proxy(tokenInfo.grainId, grain.userId, null, null, isOwner, user, null, true);
          proxy.apiToken = tokenInfo;
        } else if (tokenInfo.userInfo) {
          throw new Error("API tokens created with arbitrary userInfo no longer supported");
        } else {
          proxy = new Proxy(tokenInfo.grainId, grain.userId, null, null, false, null, null, true);
        }

        if (!SandstormPermissions.mayOpenGrain(globalDb, {token: tokenInfo})) {
          // Note that only public grains may be opened without a user ID.
          throw new Meteor.Error(403, "Unauthorized.");
        }

        if (tokenInfo.expires) {
          proxy.expires = tokenInfo.expires;
        }

        // Only add the proxy to the table if it was not concurrently deleted (which could happen
        // e.g. if the token was revoked).
        if (hashedToken in proxiesByApiToken) {
          proxiesByApiToken[hashedToken] = proxy;
        } else {
          throw new Meteor.Error(403, "Token was concurrently revoked.");
        }

        return proxy;
      });
    }
  });
}

function apiUseBasicAuth(req) {
  // For clients with no convenient way to add an "Authorization: Bearer" header, we allow the token
  // to be transmitted as a basic auth password.
  var agent = req.headers["user-agent"];
  if (agent && ((agent.slice(0, 4) === "git/") || (agent.slice(0, 16) === "GitHub-Hookshot/"))) {
    return true;
  } else {
    return false;
  }
}

function apiTokenForRequest(req) {
  var auth = req.headers.authorization;
  if (auth && auth.slice(0, 7).toLowerCase() === "bearer ") {
    return auth.slice(7).trim();
  } else if (auth && auth.slice(0, 6).toLowerCase() === "basic " && apiUseBasicAuth(req)) {
    return (new Buffer(auth.slice(6).trim(), "base64")).toString().split(":")[1];
  } else {
    return undefined;
  }
}

// =======================================================================================
// Routing to proxies.
//

tryProxyUpgrade = function (hostId, req, socket, head) {
  // Attempt to handle a WebSocket upgrade by dispatching it to a grain. Returns a promise that
  // resolves true if an appropriate grain is found, false if there was no match (but the caller
  // should consider other host types, like static web publishing), or throws an error if the
  // request is definitely invalid.

  if (hostId === "api") {
    var token = apiTokenForRequest(req);
    if (token) {
      return getProxyForApiToken(token).then(function (proxy) {
        // Meteor sets the timeout to five seconds. Change that back to two
        // minutes, which is the default value.
        socket.setTimeout(120000);

        proxy.upgradeHandler(req, socket, head);
        return true;
      });
    } else {
      return Promise.resolve(false);
    }
  } else {
    return getProxyForHostId(hostId).then(function (proxy) {
      if (proxy) {
        // Cross-origin requests are not allowed on UI session hosts.
        var origin = req.headers.origin;
        if (origin !== (PROTOCOL + "//" + req.headers.host)) {
          throw new Meteor.Error(403, "Detected illegal cross-origin WebSocket from: " + origin);
        }

        // Meteor sets the timeout to five seconds. Change that back to two
        // minutes, which is the default value.
        socket.setTimeout(120000);

        proxy.upgradeHandler(req, socket, head);
        return true;
      } else {
        return false;
      }
    });
  }
}

tryProxyRequest = function (hostId, req, res) {
  // Attempt to handle an HTTP request by dispatching it to a grain. Returns a promise that
  // resolves true if an appropriate grain is found, false if there was no match (but the caller
  // should consider other host types, like static web publishing), or throws an error if the
  // request is definitely invalid.

  if (hostId === "api") {
    // This is a request for the API host.

    if (req.method === "OPTIONS") {
      // Reply to CORS preflight request.

      // All we want to do is permit APIs to be accessed from arbitrary origins. Since clients must
      // send a valid Authorization header, and since cookies are not used for authorization, this
      // is perfectly safe. In a sane world, we would only need to send back
      // "Access-Control-Allow-Origin: *" and be done with it.
      //
      // However, CORS demands that we explicitly whitelist individual methods and headers for use
      // cross-origin, as if this is somehow useful for implementing any practical security policy
      // (it isn't). To make matters worse, we are REQUIRED to enumerate each one individually.
      // We cannot just write "*" for these lists. WTF, CORS?
      //
      // Luckily, the request tells us exactly what method and headers are being requested, so we
      // only need to copy those over, rather than create an exhaustive list. But this is still
      // overly complicated.

      var accessControlHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE",
        "Access-Control-Max-Age": "3600"
      };

      // Copy all requested headers to the allowed headers list.
      var requestedHeaders = req.headers["access-control-request-headers"];
      if (requestedHeaders) {
        accessControlHeaders["Access-Control-Allow-Headers"] = requestedHeaders;
      }

      // Add the requested method to the allowed methods list, if it's not there already.
      var requestedMethod = req.headers["access-control-request-method"];
      if (requestedMethod &&
          !(_.contains(["GET", "HEAD", "POST", "PUT", "DELETE"], requestedMethod))) {
        accessControlHeaders["Access-Control-Allow-Methods"] += ", " + requestedMethod;
      }

      res.writeHead(204, accessControlHeaders);
      res.end();
      return Promise.resolve(true);
    }

    var responseHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "text/plain",
    };

    function errorHandler(err) {
      if (err instanceof Meteor.Error) {
        console.log("error: " + err);
        res.writeHead(err.error, err.reason, responseHeaders);
      } else {
        res.writeHead(500, "Internal Server Error", responseHeaders);
      }
      res.end(err.stack);
    }

    var token = apiTokenForRequest(req);
    if (token && req.headers["x-sandstorm-token-keepalive"]) {
      inMeteor(function() {
        var keepaliveDuration = parseInt(req.headers["x-sandstorm-token-keepalive"]);
        check(keepaliveDuration, Match.Integer);
        var hashedToken = Crypto.createHash("sha256").update(token).digest("base64");
        validateWebkey(ApiTokens.findOne(hashedToken), new Date(Date.now() + keepaliveDuration));
      }).then(function() {
        res.writeHead(200, responseHeaders);
        res.end();
      }, errorHandler);
    } else if (token) {
      getProxyForApiToken(token).then(function (proxy) {
        proxy.requestHandler(req, res);
      }, errorHandler);
    } else {
      if (apiUseBasicAuth(req)) {
        res.writeHead(401, {"Content-Type": "text/plain",
                            "WWW-Authenticate": "Basic realm=\"Sandstorm API\""});
      } else {
        // TODO(someday): Display some sort of nifty API browser.
        res.writeHead(403, responseHeaders);
      }
      res.end("Missing or invalid authorization header.\n\n" +
          "This address serves APIs, which allow external apps (such as a phone app) to\n" +
          "access data on your Sandstorm server. This address is not meant to be opened\n" +
          "in a regular browser.");
    }
    return Promise.resolve(true);
  } else {
    return getProxyForHostId(hostId).then(function (proxy) {
      if (proxy) {
        proxy.requestHandler(req, res);
        return true;
      } else {
        return false;
      }
    });
  }
}


// =======================================================================================
// Proxy class
//
// Connects to a grain and exports it on a wildcard host.
//

function Proxy(grainId, ownerId, sessionId, hostId, isOwner, user, userInfo, isApi,
               supervisor) {
  this.grainId = grainId;
  this.ownerId = ownerId;
  this.supervisor = supervisor;  // note: optional parameter; we can reconnect
  this.sessionId = sessionId;
  this.isOwner = isOwner;
  this.isApi = isApi;
  this.hasLoaded = false;
  this.websockets = [];
  if (sessionId) {
    if (!hostId) throw new Error("sessionId must come with hostId");
    if (isApi) throw new Error("API proxy shouldn't have sessionId");
    this.hostId = hostId;
  } else {
    if (!isApi) throw new Error("non-API proxy requires sessionId");
    if (hostId) throw new Error("API proxy sholudn't have hostId");
  }

  if (userInfo) {
    this.userInfo = userInfo;
  } else if (user) {
    var identities = SandstormDb.getUserIdentities(user);
    if (identities.length !== 1) {
      if (identities.length === 0) {
        // Make sure that if we add a new user type we don't forget to update this.
        throw new Meteor.Error(500, "Unknown user type.");
      } else {
        // Make sure that if we implement multiple identities we don't forget to update this.
        throw new Meteor.Error(500, "User has multiple or zero identities?");
      }
    }
    var identity = identities[0];
    this.userId = user._id;
    this.identityId = identity.id;

    this.userInfo = {
      displayName: {defaultText: identity.name},
      preferredHandle: identity.handle,
      userId: new Buffer(identity.id, "hex")
    };
    if (identity.picture) this.userInfo.pictureUrl = identity.picture;
    if (identity.pronoun) this.userInfo.pronouns = identity.pronoun;
  } else {
    this.userInfo = {
      displayName: {defaultText: "Anonymous User"},
      preferredHandle: "anonymous"
    }
  }

  var self = this;

  this.requestHandler = function (request, response) {
    if (this.sessionId) {
      // Implement /_sandstorm-init for setting the session cookie.
      var url = Url.parse(request.url, true);
      if (url.pathname === "/_sandstorm-init" && url.query.sessionid === self.sessionId) {
        self.doSessionInit(request, response, url.query.path);
        return;
      }
    }

    Promise.resolve(undefined).then(function () {
      var contentLength = request.headers["content-length"];
      if ((request.method === "POST" || request.method === "PUT") &&
          (contentLength === undefined || contentLength > 1024 * 1024)) {
        // The input is either very long, or we don't know how long it is, so use streaming mode.
        return self.handleRequestStreaming(request, response, contentLength, 0);
      } else {
        return readAll(request).then(function (data) {
          return self.handleRequest(request, data, response, 0);
        });
      }
    }).catch(function (err) {
      self.setHasLoaded();

      var body = err.stack;
      if (err.cppFile) {
        body += "\nC++ location:" + err.cppFile + ":" + (err.line || "??");
      }
      if (err.kjType) {
        body += "\ntype: " + err.kjType;
      }

      if (response.headersSent) {
        // Unfortunately, it's too late to tell the client what happened.
        console.error("HTTP request failed after response already sent:", body);
        response.end();
      } else {
        if (err instanceof Meteor.Error) {
          response.writeHead(err.error, err.reason, { "Content-Type": "text/plain" });
        } else {
          response.writeHead(500, "Internal Server Error", { "Content-Type": "text/plain" });
        }
        response.end(body);
      }
    });
  };

  this.upgradeHandler = function (request, socket, head) {
    self.handleWebSocket(request, socket, head, 0).catch(function (err) {
      console.error("WebSocket setup failed:", err.stack);
      // TODO(cleanup):  Manually send back a 500 response?
      socket.destroy();
    });
  };
}

Proxy.prototype.close = function () {
  this.websockets.forEach(function (socket) {
    socket.destroy();
  });
}

Proxy.prototype.getConnection = function () {
  if (!this.supervisor) {
    this.supervisor = sandstormBackend.getGrain(this.ownerId, this.grainId).supervisor;
    this.uiView = null;
  }
  if (!this.uiView) {
    this.uiView = this.supervisor.getMainView().view;
  }
}

var Url = Npm.require("url");
var PROTOCOL = Url.parse(process.env.ROOT_URL).protocol;

Proxy.prototype._callNewWebSession = function (request, userInfo) {
  var params = Capnp.serialize(WebSession.Params, {
    basePath: PROTOCOL + "//" + request.headers.host,
    userAgent: "user-agent" in request.headers
        ? request.headers["user-agent"]
        : "UnknownAgent/0.0",
    acceptableLanguages: "accept-language" in request.headers
        ? request.headers["accept-language"].split(",").map(function (s) { return s.trim(); })
        : [ "en-US", "en" ]
  });

  return this.uiView.newSession(userInfo,
                                makeHackSessionContext(this.grainId, this.sessionId, this.userId),
                                WebSession.typeId, params).session;
};

var isRfc1918OrLocal = function(address) {
  if (Net.isIPv4(address)) {
    quad = address.split(".").map(function(x) { return parseInt(x, 10); });
    return (quad[0] === 127 || quad[0] === 10 ||
            (quad[0] === 192 && quad[1] === 168) ||
            (quad[0] === 172 && quad[1] >= 16 && quad[1] < 32));
  } else if (Net.isIPv6(address)) {
    // IPv6 specifies ::1 as localhost and fd:: as reserved for private networks
    return (address === "::1" || address.lastIndexOf("fd", 0) === 0);
  } else {
    // Ignore things that are neither IPv4 nor IPv6
    return false;
  }
};

var quadToIntString = function(quad) {
    var num = Bignum(quad[0]).shiftLeft(16)
                .add(quad[1]).shiftLeft(16)
                .add(quad[2]).shiftLeft(16)
                .add(quad[3]);
    return num.toString();
}

Proxy.prototype._callNewApiSession = function (request, userInfo) {
  var self = this;
  var params = {};

  if ("x-sandstorm-passthrough" in request.headers) {
    var optIns = request.headers["x-sandstorm-passthrough"]
        .split(',')
        .map(function(s) { return s.trim(); });
    // The only currently supported passthrough value is "address", but others could be useful in
    // the future
    if (optIns.indexOf("address") !== -1) {
      // Sadly, we can't use request.socket.remoteFamily because it's not available in the (rather-old)
      // version of node that comes in the Meteor bundle we're using.  Hence this hackery.
      var addressToPass = request.socket.remoteAddress;
      if (isRfc1918OrLocal(addressToPass) && "x-real-ip" in request.headers) {
        // Allow overriding the socket's remote address with X-Real-IP header if the request comes
        // from either localhost or an RFC1918 address.  These are not useful for geolocation
        // anyway.
        addressToPass = request.headers["x-real-ip"];
      }
      if (Net.isIPv4(addressToPass)) {
        // Map IPv4 addresses in IPv6.
        // This conveniently comes out to a 48-bit number, which is precisely representable in a
        // double (which has 53 mantissa bits). Thus we can avoid using Bignum/strings, which we
        // might otherwise need to precisely represent 64-bit fields.
        var v4Int = 0xFFFF00000000 + addressToPass.split(".")
            .map(function(x) { return parseInt(x, 10); })
            .reduce(function(a, b) { return 256*a + b; });
        params.remoteAddress = {
            lower64: v4Int,
            upper64: 0
        };
      } else if (Net.isIPv6(addressToPass)) {
        // TODO(test): Unit test this
        // Parse a valid v6 address.
        // Split into groups, then insert an appropriate number of 0's if :: was used.
        var groups = addressToPass.split(":");
        // Strip extra empty group in the case of a leading or trailing "::".
        if (groups[0] === '') {
            groups.shift();
        }
        if (groups[groups.length - 1] === '') {
            groups.pop();
        }
        var lastGroup = groups[groups.length - 1];
        // Handle IPv4-mapped IPv6 addresses.  These end in a dotted-quad IPv4 address, which we
        // should expand into two groups of 4-character hex strings, like the rest of the address.
        if (Net.isIPv4(lastGroup)) {
            groups.pop();
            var quad = lastGroup.split(".").map(function(x) { return parseInt(x, 10); });
            groups.push((quad[0]*256 + quad[1]).toString(16));
            groups.push((quad[2]*256 + quad[3]).toString(16));
        }
        var groupsToAdd = 8 - groups.length;
        var emptyGroupIndex = groups.indexOf('');
        if (emptyGroupIndex !== -1) {
          var head = groups.slice(0, emptyGroupIndex);
          // groupsToAdd + 1 because we sliced out the empty element
          var mid = Array(groupsToAdd + 1);
          for (var i = 0; i < groupsToAdd + 1 ; i++) {
              mid[i] = '0';
          }
          var tail = groups.slice(emptyGroupIndex + 1, groups.length);
          var cleanGroups = [].concat(head, mid, tail);
        } else {
          var cleanGroups = groups;
        }
        var ints = cleanGroups.map(function(x) { return parseInt(x, 16); });
        // We use strings because we'd lose data from loss of precision casting the 64-bit uints
        // into 53-bit-mantissa doubles.
        params.remoteAddress = {
            upper64: quadToIntString(ints.slice(0,4)),
            lower64: quadToIntString(ints.slice(4,8))
        };
      }
    }
  }

  var serializedParams = Capnp.serialize(ApiSession.Params, params);

  // TODO(someday): We are currently falling back to WebSession if we get any kind of error upon
  // calling newSession with an ApiSession._id.
  // Eventually we'll remove this logic once we're sure apps have updated.
  return this.uiView.newSession(userInfo,
                                makeHackSessionContext(this.grainId, this.sessionId, this.userId),
                                ApiSession.typeId, serializedParams)
      .then(function (session) {
    return session.session;
  }, function (err) {
    return self._callNewWebSession(request, userInfo);
  });
};

Proxy.prototype._callNewSession = function (request, viewInfo) {
  var userInfo = _.clone(this.userInfo);
  var self = this;
  var promise = inMeteor(function () {
    var vertex;
    if (self.apiToken) {
      vertex = {token: self.apiToken};
    } else {
      // (self.userId might be null; this is fine)
      vertex = {grain: {_id: self.grainId, identityId: self.identityId}};
    }
    var permissions = SandstormPermissions.grainPermissions(globalDb, vertex, viewInfo);
    if (!permissions) {
      throw new Meteor.Error(403, "Unauthorized", "User is not authorized to open this grain.");
    }
    Sessions.update({_id: self.sessionId},
                    {$set : {"viewInfo": viewInfo, "permissions": permissions}});
    return permissions;
  });

  return promise.then(function(permissions) {
    userInfo.permissions = permissions;

    var numBytes = Math.ceil(permissions.length / 8);
    var buf = new Buffer(numBytes);
    for (var ii =0; ii < numBytes; ++ii) {
      buf[ii] = 0;
    }
    for (var ii = 0; ii < permissions.length; ++ii) {
      var byteNum = Math.floor(ii / 8);
      var bitNum = ii % 8;
      if (permissions[ii]) {
        buf[byteNum] = (buf[byteNum] | (1 << bitNum));
      }
    }
    userInfo.deprecatedPermissionsBlob = buf;

    if (self.isApi) {
      return self._callNewApiSession(request, userInfo);
    } else {
      return self._callNewWebSession(request, userInfo);
    }
  });
};

Proxy.prototype.getSession = function (request) {
  if (!this.session) {
    this.getConnection();  // make sure we're connected
    var self = this;
    var promise = this.uiView.getViewInfo().then(function (viewInfo) {
      return inMeteor(function() {
        Grains.update(self.grainId, {$set: {cachedViewInfo: viewInfo}});
      }).then(function () {
        return self._callNewSession(request, viewInfo);
      });
    }, function (error) {
      if (error.kjType === "failed" || error.kjType === "unimplemented") {
        // Method not implemented.
        // TODO(apibump): Don't treat "failed" as "unimplemented". Unfortunately, old apps built
        //   with old versions of Cap'n Proto don't throw "unimplemented" exceptions, so we have
        //   to accept "failed" here at least until the next API bump.
        return self._callNewSession(request, {});
      } else {
        return Promise.reject(error);
      }
    });
    this.session = new Capnp.Capability(promise, WebSession);
  }

  return this.session;
}

Proxy.prototype.keepAlive = function () {
  this.getConnection();
  return this.supervisor.keepAlive();
}

Proxy.prototype.resetConnection = function () {
  if (this.session) {
    this.session.close();
    delete this.session;
  }
  if (this.uiView) {
    this.uiView.close();
    delete this.uiView;
  }
  if (this.supervisor) {
    this.supervisor.close();
    delete runningGrains[this.grainId];
    delete this.supervisor;
  }
}

Proxy.prototype.maybeRetryAfterError = function (error, retryCount) {
  // If the error may be caused by the grain dying or a network failure, try to restart it,
  // returning a promise that resolves once restarted. Otherwise, just rethrow the error.
  // `retryCount` should be incremented for every successful retry as part of the same request;
  // we only want to retry once.

  var self = this;

  if (shouldRestartGrain(error, retryCount)) {
    this.resetConnection();
    return inMeteor(function () {
      self.supervisor = continueGrain(self.grainId).supervisor;
    });
  } else {
    throw error;
  }
}

// -----------------------------------------------------------------------------
// Session cookie management

function parseCookies(request) {
  var header = request.headers["cookie"];

  var result = { cookies: [] };
  if (header) {
    var reqCookies = header.split(";");
    for (var i in reqCookies) {
      var reqCookie = reqCookies[i];
      var equalsPos = reqCookie.indexOf("=");
      var cookie;
      if (equalsPos === -1) {
        cookie = {key: reqCookie.trim(), value: ""};
      } else {
        cookie = {key: reqCookie.slice(0, equalsPos).trim(), value: reqCookie.slice(equalsPos + 1)};
      }

      if (cookie.key === "sandstorm-sid") {
        if (result.sessionId) {
          throw new Error("Multiple sandstorm session IDs?");
        }
        result.sessionId = cookie.value;
      } else {
        result.cookies.push(cookie);
      }
    }
  }

  return result;
}

function parseAcceptHeader(request) {
  var header = request.headers["accept"];

  var result = [];
  if (header) {
    var acceptList = header.split(",");
    for (var i in acceptList) {
      var acceptStr = acceptList[i];
      var tokensList = acceptStr.split(";");

      var temp = {mimeType: tokensList[0].trim()};

      var tokensListRest = tokensList.slice(1);
      for (var j in tokensListRest) {
        var token = tokensListRest[j];
        var equalsPos = token.indexOf('=');
        if (equalsPos) {
          var key = token.slice(0, equalsPos).trim();
          var value = token.slice(equalsPos + 1).trim();

          if (key === 'q') {
            temp.qValue = +value;
          }
        }
      }
      result.push(temp);
    }
  }

  return result;
}

Proxy.prototype.doSessionInit = function (request, response, path) {
  path = path || "/";

  // Check that the path is relative (ie. starts with a /).
  // Also ensure that it doesn't start with 2 /, because that is interpreted as non-relative
  if (path.lastIndexOf("/", 0) !== 0 || path.lastIndexOf("//", 0) === 0) {
    response.writeHead(400, "Invalid path supplied", { "Content-Type": "text/plain" });
    response.end("Invalid path supplied.");
    return;
  }

  // Set the session ID.
  response.setHeader("Set-Cookie", ["sandstorm-sid=", this.sessionId, "; Max-Age=31536000; HttpOnly"].join(""));

  response.setHeader("Cache-Control", "no-cache, private");

  // Redirect to the app's root URL.
  // Note:  All browsers support relative locations and the next update to HTTP/1.1 will officially
  //   make them valid.  http://tools.ietf.org/html/draft-ietf-httpbis-p2-semantics-26#page-67
  response.writeHead(303, "See Other", { "Location": path });
  response.end();
}

Proxy.prototype.makeContext = function (request, response) {
  // Parses the cookies from the request, checks that the session ID is present and valid, then
  // returns the request context which contains the other cookies.  Throws an exception if the
  // session ID is missing or invalid.

  var context = {};

  if (this.hostId) {
    var parseResult = parseCookies(request);
    if (!parseResult.sessionId || parseResult.sessionId !== this.sessionId) {
      throw new Meteor.Error(403, "Unauthorized");
    }

    if (parseResult.cookies.length > 0) {
      context.cookies = parseResult.cookies;
    }
  } else {
    // This is an API request. Cookies are not supported.
  }

  context.accept = parseAcceptHeader(request);

  var promise = new Promise(function (resolve, reject) {
    response.resolveResponseStream = resolve;
    response.rejectResponseStream = reject;
  });

  context.responseStream = new Capnp.Capability(promise, ByteStream);

  return context;
}

// -----------------------------------------------------------------------------
// Regular HTTP request handling

function readAll(stream) {
  return new Promise(function (resolve, reject) {
    var buffers = [];
    stream.on("data", function (buf) {
      buffers.push(buf);
    });
    stream.on("end", function () {
      resolve(Buffer.concat(buffers));
    });
    stream.on("error", reject);
  });
}

function makeSetCookieHeader(cookie) {
  var result = [cookie.name, "=", cookie.value];

  if ("absolute" in cookie.expires) {
    result.push("; Expires=");
    result.push(new Date(cookie.expires.absolute * 1000).toUTCString());
  } else if ("relative" in cookie.expires) {
    result.push("; Max-Age=" + cookie.expires.relative);
  }

  if (cookie.path) {
    result.push("; Path=" + cookie.path);
  }

  if (cookie.httpOnly) {
    result.push("; HttpOnly");
  }

  return result.join("");
}

// TODO(cleanup):  Auto-generate based on annotations in web-session.capnp.
var successCodes = {
  ok:       { id: 200, title: "OK" },
  created:  { id: 201, title: "Created" },
  accepted: { id: 202, title: "Accepted" }
};
var noContentSuccessCodes = [
  // Indexed by shouldResetForm * 1
  { id: 204, title: "No Content" },
  { id: 205, title: "Reset Content" }
];
var redirectCodes = [
  // Indexed by switchToGet * 2 + isPermanent
  { id: 307, title: "Temporary Redirect" },
  { id: 308, title: "Permanent Redirect" },
  { id: 303, title: "See Other" },
  { id: 301, title: "Moved Permanently" }
];
var errorCodes = {
  badRequest:            { id: 400, title: "Bad Request" },
  forbidden:             { id: 403, title: "Forbidden" },
  notFound:              { id: 404, title: "Not Found" },
  methodNotAllowed:      { id: 405, title: "Method Not Allowed" },
  notAcceptable:         { id: 406, title: "Not Acceptable" },
  conflict:              { id: 409, title: "Conflict" },
  gone:                  { id: 410, title: "Gone" },
  requestEntityTooLarge: { id: 413, title: "Request Entity Too Large" },
  requestUriTooLong:     { id: 414, title: "Request-URI Too Long" },
  unsupportedMediaType:  { id: 415, title: "Unsupported Media Type" },
  imATeapot:             { id: 418, title: "I'm a teapot" },
};

function ResponseStream(response, streamHandle, resolve, reject) {
  this.response = response;
  this.streamHandle = streamHandle;
  this.resolve = resolve;
  this.reject = reject;
  this.ended = false;
}

ResponseStream.prototype.write = function (data) {
  this.response.write(data);
}

ResponseStream.prototype.done = function () {
  this.response.end();
  this.streamHandle.close();
  this.ended = true;
}

ResponseStream.prototype.close = function () {
  if (this.ended) {
    this.resolve();
  } else {
    this.streamHandle.close();
    this.reject(new Error("done() was never called on outbound stream."));
  }
}

Proxy.prototype.translateResponse = function (rpcResponse, response) {
  if (this.hostId) {
    if (rpcResponse.setCookies && rpcResponse.setCookies.length > 0) {
      response.setHeader("Set-Cookie", rpcResponse.setCookies.map(makeSetCookieHeader));
    }

    // TODO(security): Add a Content-Security-Policy header which:
    // (1) Prevents the app from initiating HTTP requests to third parties.
    // (2) Prevents the app from navigating the parent frame.
    // (3) Prevents the app from opening popups.
    // (4) Prohibits anyone other than the Sandstorm shell from framing the app (as a backup
    //   defense vs. clickjacking, though unguessable hostnames already mostly prevent this).
  } else {
    // This is an API request. Cookies are not supported.

    // We need to make sure caches know that different bearer tokens get totally different results.
    response.setHeader("Vary", "Authorization");

    // APIs can be called from any origin. Because we ignore cookies, there is no security problem.
    response.setHeader("Access-Control-Allow-Origin", "*");

    // Add a Content-Security-Policy as a backup in case someone finds a way to load this resource
    // in a browser context. This policy should thoroughly neuter it.
    response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  }

  // On first response, update the session to have hasLoaded=true
  this.setHasLoaded();

  // TODO(security): Set X-Content-Type-Options: nosniff?

  if ("content" in rpcResponse) {
    var content = rpcResponse.content;
    var code = successCodes[content.statusCode];
    if (!code) {
      throw new Error("Unknown status code: ", content.statusCode);
    }

    if (content.mimeType) {
      response.setHeader("Content-Type", content.mimeType);
    }
    if (content.encoding) {
      response.setHeader("Content-Encoding", content.encoding);
    }
    if (content.language) {
      response.setHeader("Content-Language", content.language);
    }
    if (("disposition" in content) && ("download" in content.disposition)) {
      response.setHeader("Content-Disposition", "attachment; filename=\"" +
          content.disposition.download.replace(/([\\"\n])/g, "\\$1") + "\"");
    }
    if ("stream" in content.body) {
      var streamHandle = content.body.stream;
      response.writeHead(code.id, code.title);
      var promise = new Promise(function (resolve, reject) {
        response.resolveResponseStream(new Capnp.Capability(
            new ResponseStream(response, streamHandle, resolve, reject), ByteStream));
      });
      promise.streamHandle = streamHandle;
      return promise;
    } else {
      response.rejectResponseStream(
        new Error("Response content body was not a stream."));

      if ("bytes" in content.body) {
        response.setHeader("Content-Length", content.body.bytes.length);
      } else {
        throw new Error("Unknown content body type.");
      }
    }

    response.writeHead(code.id, code.title);

    if ("bytes" in content.body) {
      response.end(content.body.bytes);
    }
  } else if ("noContent" in rpcResponse) {
    var noContent = rpcResponse.noContent;
    var noContentCode = noContentSuccessCodes[noContent.shouldResetForm * 1];
    response.writeHead(noContentCode.id, noContentCode.title);
    response.end();
  } else if ("redirect" in rpcResponse) {
    var redirect = rpcResponse.redirect;
    var redirectCode = redirectCodes[redirect.switchToGet * 2 + redirect.isPermanent];
    response.writeHead(redirectCode.id, redirectCode.title, {
      "Location": redirect.location
    });
    response.end();
  } else if ("clientError" in rpcResponse) {
    var clientError = rpcResponse.clientError;
    var errorCode = errorCodes[clientError.statusCode];
    if (!errorCode) {
      throw new Error("Unknown status code: ", clientError.statusCode);
    }
    response.writeHead(errorCode.id, errorCode.title, {
      "Content-Type": "text/html"
    });
    if (clientError.descriptionHtml) {
      response.end(clientError.descriptionHtml);
    } else {
      // TODO(someday):  Better default error page.
      response.end("<html><body><h1>" + errorCode.id + ": " + errorCode.title +
                   "</h1></body></html>");
    }
  } else if ("serverError" in rpcResponse) {
    response.writeHead(500, "Internal Server Error", {
      "Content-Type": "text/html"
    });
    if (rpcResponse.serverError.descriptionHtml) {
      response.end(rpcResponse.serverError.descriptionHtml);
    } else {
      // TODO(someday):  Better default error page.
      response.end("<html><body><h1>500: Internal Server Error</h1></body></html>");
    }
  } else {
    throw new Error("Unknown HTTP response type:\n" + JSON.stringify(rpcResponse));
  }

  return Promise.resolve(undefined);
}

Proxy.prototype.handleRequest = function (request, data, response, retryCount) {
  var self = this;

  return Promise.resolve(undefined).then(function () {
    return self.makeContext(request, response);
  }).then(function (context) {
    // Send the RPC.
    var path = request.url.slice(1);  // remove leading '/'
    var session = self.getSession(request);

    if (request.method === "GET") {
      return session.get(path, context);
    } else if (request.method === "POST") {
      return session.post(path, {
        mimeType: request.headers["content-type"] || "application/octet-stream",
        content: data,
        encoding: request.headers["content-encoding"]
      }, context);
    } else if (request.method === "PUT") {
      return session.put(path, {
        mimeType: request.headers["content-type"] || "application/octet-stream",
        content: data,
        encoding: request.headers["content-encoding"]
      }, context);
    } else if (request.method === "DELETE") {
      return session.delete(path, context);
    } else {
      throw new Error("Sandstorm only supports GET, POST, PUT, and DELETE requests.");
    }

  }).then(function (rpcResponse) {
    return self.translateResponse(rpcResponse, response);
  }).catch(function (error) {
    return self.maybeRetryAfterError(error, retryCount).then(function () {
      return self.handleRequest(request, data, response, retryCount + 1);
    });
  });
}

Proxy.prototype.handleRequestStreaming = function (request, response, contentLength, retryCount) {
  var self = this;
  var context = this.makeContext(request, response);
  var path = request.url.slice(1);  // remove leading '/'
  var session = this.getSession(request);

  var mimeType = request.headers["content-type"] || "application/octet-stream";
  var encoding = request.headers["content-encoding"]

  var requestStreamPromise;
  if (request.method === "POST") {
    requestStreamPromise = session.postStreaming(path, mimeType, context, encoding);
  } else if (request.method === "PUT") {
    requestStreamPromise = session.putStreaming(path, mimeType, context, encoding);
  } else {
    throw new Error("Sandstorm only supports streaming POST and PUT requests.");
  }

  // TODO(perf): We ought to be pipelining the body, but we can't currently, because we have to
  //   handle the case where the app doesn't actually support streaming. We could pipeline while
  //   also buffering the data on the side in case we need it again later, but that's kind of
  //   complicated. We should fix the whole protocol to make streaming the standard.
  return requestStreamPromise.then(function(requestStreamResult) {
    var requestStream = requestStreamResult.stream;

    // Initialized when getResponse() returns, if the response is streaming.
    var downloadStreamHandle;

    // Initialized if an upload-stream method throws.
    var uploadStreamError;

    // We call `getResponse()` immediately so that the app can start streaming data down even while
    // data is still being streamed up. This theoretically allows apps to perform bidirectional
    // streaming, though probably very few actually do that.
    //
    // Note that we need to be able to cancel `responsePromise` below, so it's important that it is
    // the raw Cap'n Proto promise. Hence `translateResponsePromise` is a separate variable.
    var responsePromise = requestStream.getResponse();

    function reportUploadStreamError(err) {
      // Called when an upload-stream method throws.

      if (!uploadStreamError) {
        uploadStreamError = err;

        // If we're still waiting on any response stuff, cancel it.
        responsePromise.cancel();
        requestStream.close();
        if (downloadStreamHandle) {
          downloadStreamHandle.close();
        }
      }
    }

    // If we have a Content-Length, pass it along to the app by calling `expectSize()`.
    if (contentLength !== undefined) {
      requestStream.expectSize(contentLength).catch(function (err) {
        // expectSize() is allowed to be unimplemented.
        if (err.kjType !== "unimplemented") {
          reportUploadStreamError(err);
        }
      });
    }

    // Pipe the input stream to the app.
    request.on("data", function (buf) {
      // TODO(soon): Only allow a small number of write()s to be in-flight at once,
      //   pausing the input stream if we hit that limit, so that we block the TCP socket all the
      //   way back to the source. May want to also coalesce small writes for this purpose.
      // TODO(security): The above problem may allow a DoS attack on the front-end.
      if (!uploadStreamError) requestStream.write(buf).catch(reportUploadStreamError);
    });
    request.on("end", function () {
      if (!uploadStreamError) requestStream.done().catch(reportUploadStreamError);

      // We're all done making calls to requestStream.
      requestStream.close();
    });
    request.on("close", function () {
      reportUploadStreamError(new Error("HTTP connection unexpectedly closed during request."));
    });
    request.on("error", function (err) {
      reportUploadStreamError(err);
    });

    return responsePromise.then(function (rpcResponse) {
      // Stop here if the upload stream has already failed.
      if (uploadStreamError) throw uploadStreamError;

      var promise = self.translateResponse(rpcResponse, response);
      downloadStreamHandle = promise.streamHandle;
      return promise;
    });
  }, function (err) {
    if (err.kjType === "failed" && err.message.indexOf("not implemented") !== -1) {
      // Hack to work around old apps using an old version of Cap'n Proto, before the
      // "unimplemented" exception type was introduced. :(
      // TODO(cleanup): When we transition to API version 2, we can move this into the
      //   compatibility layer.
      err.kjType = "unimplemented";
    }

    if (shouldRestartGrain(err, 0)) {
      // This is the kind of error that indicates we should retry. Note that we passed 0 for the
      // retry count above because we were just checking if this is a retriable error (vs. possibly
      // a method-not-implemented error); maybeRetryAfterError() will check again with the proper
      // retry count.
      return self.maybeRetryAfterError(err, retryCount).then(function () {
        return self.handleRequestStreaming(request, response, contentLength, retryCount + 1);
      });
    } else if (err.kjType === "unimplemented") {
      // Streaming is not implemented. Fall back to non-streaming version.
      return readAll(request).then(function (data) {
        return self.handleRequest(request, data, response, 0);
      });
    } else {
      throw err;
    }
  });
}

// -----------------------------------------------------------------------------
// WebSocket handling

function WebSocketReceiver(socket) {
  var queue = [];
  this.go = function () {
    for (var i in queue) {
      socket.write(queue[i]);
    }
    queue = null;
  };
  this.sendBytes = function (message) {
    // TODO(someday):  Flow control of some sort?
    if (queue === null) {
      socket.write(message);
    } else {
      queue.push(message);
    }
  };
  this.close = function () {
    socket.end();
  };
}

function pumpWebSocket(socket, rpcStream) {
  socket.on("data", function (chunk) {
    rpcStream.sendBytes(chunk).catch(function (err) {
      if (err.kjType !== "disconnected") {
        console.error("WebSocket sendBytes failed: " + err.stack);
      }
      socket.destroy();
    });
  });
  socket.on("end", function (chunk) {
    rpcStream.close();
  });
}

Proxy.prototype.handleWebSocket = function (request, socket, head, retryCount) {
  var self = this;

  return Promise.resolve(undefined).then(function () {
    return self.makeContext(request);
  }).then(function (context) {
    var path = request.url.slice(1);  // remove leading '/'
    var session = self.getSession(request);

    if (!("sec-websocket-key" in request.headers)) {
      throw new Error("Missing Sec-WebSocket-Accept header.");
    }

    var magic = request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    var acceptKey = Crypto.createHash("sha1").update(magic).digest("base64");

    var protocols = [];
    if ("sec-websocket-protocol" in request.headers) {
      protocols = request.headers["sec-websocket-protocol"]
          .split(",").map(function (s) { return s.trim(); });
    }

    var receiver = new WebSocketReceiver(socket);
    // TODO(someday): do we want to make these be weak references somehow?
    self.websockets.push(socket);

    var promise = session.openWebSocket(path, context, protocols, receiver);

    if (head.length > 0) {
      promise.serverStream.sendBytes(head);
    }
    pumpWebSocket(socket, promise.serverStream);

    return promise.then(function (response) {
      var headers = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Accept: " + acceptKey];
      if (response.protocol && response.protocol.length > 0) {
        headers.push("Sec-WebSocket-Protocol: " + response.protocol.join(", "));
      }
      headers.push("");
      headers.push("");

      socket.write(headers.join("\r\n"));
      receiver.go();

      // Note:  At this point errors are out of our hands.
    });
  }).catch(function (error) {
    return self.maybeRetryAfterError(error, retryCount).then(function () {
      return self.handleWebSocket(request, socket, head, retryCount + 1);
    });
  });
}

Proxy.prototype.setHasLoaded = function () {
  if (!this.hasLoaded) {
    this.hasLoaded = true;
    var sessionId = this.sessionId;
    inMeteor(function () {
      Sessions.update({_id: sessionId}, {$set: {hasLoaded: true}});
    });
  }
}

// =======================================================================================
// Debug log access

Meteor.publish("grainLog", function (grainId) {
  check(grainId, String);
  var id = 0;
  var grain = Grains.findOne(grainId);
  if (!grain || !this.userId || grain.userId !== this.userId) {
    this.added("grainLog", id++, {text: "Only the grain owner can view the debug log."});
    this.ready();
    return;
  }

  var connected = false;
  var self = this;

  var receiver = {
    write: function (data) {
      connected = true;
      self.added("grainLog", id++, {text: data.toString("utf8")});
    },
    close: function () {
      if (connected) {
        self.added("grainLog", id++, {
          text: "*** lost connection to grain (probably because it shut down) ***"
        });
      }
    }
  };

  try {
    var handle = waitPromise(useGrain(grainId, function (supervisor) {
      return supervisor.watchLog(8192, receiver);
    })).handle;
    connected = true;
    this.onStop(function() {
      handle.close();
    });
  } catch (err) {
    if (!connected) {
      this.added("grainLog", id++, {
        text: "*** couldn't connect to grain (" + err + ") ***"
      });
    }
  }

  // Notify ready.
  this.ready();
});
