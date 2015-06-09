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
var Capnp = Npm.require("capnp");

var PersistentHandle = Capnp.importSystem("sandstorm/supervisor.capnp").PersistentHandle;
var SandstormCore = Capnp.importSystem("sandstorm/supervisor.capnp").SandstormCore;
var SandstormCoreFactory = Capnp.importSystem("sandstorm/backend.capnp").SandstormCoreFactory;
var PersistentOngoingNotification = Capnp.importSystem("sandstorm/supervisor.capnp").PersistentOngoingNotification;

function SandstormCoreImpl(grainId) {
  this.grainId = grainId;
}

var makeSandstormCore = function (grainId) {
  return new Capnp.Capability(new SandstormCoreImpl(grainId), SandstormCore);
};

function NotificationHandle(notificationId, saved) {
  this.notificationId = notificationId;
  this.saved = saved;
}

function makeNotificationHandle(notificationId, saved) {
  return new Capnp.Capability(new NotificationHandle(notificationId, saved), PersistentHandle);
}

function dropWakelock(grainId, wakeLockNotificationId) {
  waitPromise(useGrain(grainId, function (supervisor) {
    return supervisor.drop({ref: {wakeLockNotification: wakeLockNotificationId}});
  }));
}

function dismissNotification(notificationId, callCancel) {
  var notification = Notifications.findOne({_id: notificationId});
  if (notification) {
    Notifications.remove({_id: notificationId});
    if (notification.ongoing) {
      var sandstormCore = new SandstormCoreImpl(notification.grainId);
      // For some reason, Mongo returns an object that looks buffer-like, but isn't a buffer.
      // Only way to fix seems to be to copy it.
      var id = new Buffer(notification.ongoing);

      if (!callCancel) {
        waitPromise(sandstormCore.drop({token: id}));
      } else {
        var notificationCap = waitPromise(sandstormCore.restore({token: id})).cap;
        var castedNotification = notificationCap.castAs(PersistentOngoingNotification);
        waitPromise(sandstormCore.drop({token: id}));
        try {
          waitPromise(castedNotification.cancel());
          castedNotification.close();
          notificationCap.close();
        } catch (err) {
          if (err.kjType !== "disconnected") {
            // ignore disconnected errors, since cancel may shutdown the grain before the supervisor
            // responds.
            throw err;
          }
        }
      }
    }
  }
}

function hashSturdyRef(sturdyRef) {
  return Crypto.createHash("sha256").update(sturdyRef).digest("base64");
}

Meteor.methods({
  dismissNotification: function (notificationId) {
    // This will remove notifications from the database and from view of the user.
    // For ongoing notifications, it will begin the process of cancelling and dropping them from
    // the app.
    var notification = Notifications.findOne({_id: notificationId});
    if (!notification) {
      throw new Meteor.Error(404, "Notification id not found.");
    } else if (notification.userId !== Meteor.userId()) {
      throw new Meteor.Error(403, "Notification does not belong to current user.");
    } else {
      dismissNotification(notificationId, true);
    }
  },
  readAllNotifications: function () {
    // Marks all notifications as read for the current user.
    if (!Meteor.userId()) {
      throw new Meteor.Error(403, "User not logged in.");
    }
    Notifications.update({userId: Meteor.userId()}, {$set: {isUnread: false}}, {multi: true});
  }
});

NotificationHandle.prototype.close = function () {
  var self = this;
  return inMeteor(function () {
    if (!self.saved) {
      dismissNotification(self.notificationId);
    }
  });
};

NotificationHandle.prototype.save = function () {
  var self = this;
  return inMeteor(function () {
    var sturdyRef = new Buffer(Random.id(20));
    var hashedSturdyRef = hashSturdyRef(sturdyRef);
    ApiTokens.insert({
      _id: hashedSturdyRef,
      frontendRef: {
        notificationHandle: self.notificationId
      }
    });
    self.saved = true;
    return {sturdyRef: sturdyRef};
  });
};

SandstormCoreImpl.prototype.restore = function (params) {
  var self = this;
  return inMeteor(function () {
    var hashedSturdyRef = hashSturdyRef(params.token);
    var token = ApiTokens.findOne(hashedSturdyRef);
    if (!token) {
      throw new Error("No token found to restore");
    }
    if (token.frontendRef) {
      if (token.frontendRef.notificationHandle) {
        var notificationId = token.frontendRef.notificationHandle;
        return {cap: makeNotificationHandle(notificationId, true)};
      } else {
        throw new Error("Unknown frontend token type.");
      }
    } else if (token.objectId) {
      return useGrain(self.grainId, function (supervisor) {
        return supervisor.restore({ref: token.objectId});
      });
    } else {
      throw new Error("Unknown token type.");
    }
  });
};

SandstormCoreImpl.prototype.drop = function (params) {
  var grainId = this.grainId;
  return inMeteor(function () {
    var hashedSturdyRef = hashSturdyRef(params.token);
    var token = ApiTokens.findOne({_id: hashedSturdyRef});
    if (!token) {
      return;
    }
    if (token.frontendRef) {
      if (token.frontendRef.notificationHandle) {
        var notificationId = token.frontendRef.notificationHandle;
        ApiTokens.remove({_id: hashedSturdyRef});
        var anyToken = ApiTokens.findOne({"frontendRef.notificationHandle": notificationId});
        if (!anyToken) {
          // No other tokens referencing this notification exist, so dismiss the notification
          dismissNotification(notificationId);
        }
      } else {
        throw new Error("Unknown frontend token type.");
      }
    } else if (token.objectId) {
      if (token.objectId.wakeLockNotification) {
        dropWakelock(grainId, token.objectId.wakeLockNotification);
      } else {
        throw new Error("Unknown objectId token type.");
      }
    } else {
      throw new Error("Unknown token type.");
    }
  });
};

SandstormCoreImpl.prototype.makeToken = function (params) {
  var self = this;
  return inMeteor(function () {
    var sturdyRef = new Buffer(Random.id(20));
    var hashedSturdyRef = hashSturdyRef(sturdyRef);
    ApiTokens.insert({
      _id: hashedSturdyRef,
      grainId: self.grainId,
      objectId: params.ref,
      owner: params.owner
    });

    return {
      token: sturdyRef
    };
  });
};

SandstormCoreImpl.prototype.getOwnerNotificationTarget = function() {
  var grainId = this.grainId;
  return {owner: {addOngoing: function(params) {
    return inMeteor(function () {
      var grain = Grains.findOne({_id: grainId});
      if (!grain) {
        throw new Error("Grain not found.");
      }
      var castedNotification = params.notification.castAs(PersistentOngoingNotification);
      var wakelockToken = waitPromise(castedNotification.save()).sturdyRef;

      // We have to close both the casted cap and the original. Perhaps this should be fixed in
      // node-capnp?
      castedNotification.close();
      params.notification.close();
      var notificationId = Notifications.insert({
        ongoing: wakelockToken,
        grainId: grainId,
        userId: grain.userId,
        text: params.displayInfo.caption,
        timestamp: new Date(),
        isUnread: true
      });

      return {handle: makeNotificationHandle(notificationId, false)};
    });
  }}};
};

function SandstormCoreFactoryImpl() {
}

SandstormCoreFactoryImpl.prototype.getSandstormCore = function (params) {
  return {core: makeSandstormCore(params.grainId)};
};

makeSandstormCoreFactory = function () {
  return new Capnp.Capability(new SandstormCoreFactoryImpl(), SandstormCoreFactory);
};
