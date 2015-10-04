// Minimal tooling for doing run-at-least-once, ordered migrations.
//
// Because migrations can experience partial failure and likely have
// side-effects, we should be careful to make sure all migrations are
// idempotent and safe to accidentally run multiple times.

var Future = Npm.require("fibers/future");

var updateLoginStyleToRedirect = function() {
  var configurations = Package["service-configuration"].ServiceConfiguration.configurations;
  ["google", "github"].forEach(function(serviceName) {
    var config = configurations.findOne({service: serviceName});
    if (config && config.loginStyle !== "redirect") {
      configurations.update({service: serviceName}, {$set: {loginStyle: "redirect"}});
    }
  });
};

var enableLegacyOAuthProvidersIfNotInSettings = function() {
  // In the before time, Google and Github login were enabled by default.
  //
  // This actually didn't make much sense, required the first user to configure
  // OAuth, and had some trust-the-first-user properties that weren't totally
  // secure.
  //
  // Now, we have admin-token, so we wish to disable all logins by default
  // (since they need to be configured anyway) but since users may have never
  // explicitly told Sandstorm that Google or Github login should be enabled,
  // we can't just use the value in the Settings collection, since it might
  // never have been set.
  //
  // Thus, if the service is configured but absent from Settings, we should
  // explicitly enable it in Settings, and then the rest of the logic can just
  // depend on what value is in Settings and default to false without breaking
  // user installations.
  var configurations = Package["service-configuration"].ServiceConfiguration.configurations;
  ["google", "github"].forEach(function(serviceName) {
    var config = configurations.findOne({service: serviceName});
    var serviceConfig = Settings.findOne({_id: serviceName});
    if (config && !serviceConfig) {
      // Only explicitly enable the login service if:
      // 1) the service is already configured
      // 2) there is no sandstorm configuration already present (the user was
      //    using the previous default behavior).
      Settings.insert({_id: serviceName, value: true});
    }
  });
};

var denormalizeInviteInfo = function() {
  // When a user is invited via a signup token, the `signupKey` field of their user table entry
  // has always been populated to indicate the key they used. This points into the SignupKeys table
  // which has more information about the key, namely a freeform note entered by the admin when
  // they created the key. In the case that the email invite form was used, the note has the form
  // "E-mail invite to <address>".
  //
  // Later, we decided it was useful to indicate in the users table visible to the admin
  // information about the invite terms. Namely, for email invites we want to show the address
  // and for others we want to show the note. To make this efficient, fields `signupNote` and
  // `signupEmail` were added to the users table. We can backfill these values by denormalizing
  // from the SignupKeys table.

  Meteor.users.find().forEach(function (user) {
    if (user.signupKey && (typeof user.signupKey) === "string" && user.signupKey !== "admin") {
      var signupInfo = SignupKeys.findOne(user.signupKey);
      if (signupInfo && signupInfo.note) {
        var newFields = { signupNote: signupInfo.note };

        var prefix = "E-mail invite to ";
        if (signupInfo.note.lastIndexOf(prefix) === 0) {
          newFields.signupEmail = signupInfo.note.slice(prefix.length);
        }

        Meteor.users.update(user._id, {$set: newFields});
      }
    }
  });
}

function mergeRoleAssignmentsIntoApiTokens() {
  RoleAssignments.find().forEach(function(roleAssignment) {
    ApiTokens.insert({
      grainId: roleAssignment.grainId,
      userId: roleAssignment.sharer,
      roleAssignment: roleAssignment.roleAssignment,
      petname: roleAssignment.petname,
      created: roleAssignment.created,
      owner: {user: {userId: roleAssignment.recipient,
                     title: roleAssignment.title}},
    });
  });
}

function fixOasisStorageUsageStats() {}
// This migration only pertained to Oasis and it was successfully applied there. Since it referred
// to some global variables that we later wanted to remove and/or rename, we've since replaced it
// with a no-op.

function fetchProfilePictures() {
  Meteor.users.find({}).forEach(function (user) {
    var url = userPictureUrl(user);
    if (url) {
      console.log("Fetching user picture:", url);
      var assetId = fetchPicture(url);
      if (assetId) {
        Meteor.users.update(user._id, {$set: {"profile.picture": assetId}});
      }
    }
  });
}

function assignPlans() {
  if (Meteor.settings.public.quotaEnabled && SandstormDb.paymentsMigrationHook) {
    SandstormDb.paymentsMigrationHook(SignupKeys, Plans.find().fetch());
  }
}

function removeKeyrings() {
  // These blobs full of public keys were not intended to find their way into mongo and while
  // harmless they slow things down because they're huge. Remove them.
  Packages.update({"manifest.metadata.pgpKeyring": {$exists: true}},
      {$unset: {"manifest.metadata.pgpKeyring": ""}},
      {multi: true});
}

function useLocalizedTextInUserActions() {
  function toLocalizedText(newObj, oldObj, field) {
    if (field in oldObj) {
      if (typeof oldObj[field] === "string") {
        newObj[field] = {defaultText: oldObj[field]};
      } else {
        newObj[field] = oldObj[field];
      }
    }
  }
  UserActions.find({}).forEach(function (userAction) {
    var fields = {};
    toLocalizedText(fields, userAction, "appTitle");
    toLocalizedText(fields, userAction, "title");
    toLocalizedText(fields, userAction, "nounPhrase");
    UserActions.update(userAction._id, {$set: fields});
  });
}

function verifyAllPgpSignatures() {
  Packages.find({}).forEach(function (pkg) {
    try {
      console.log("checking PGP signature for package:", pkg._id);
      var info = waitPromise(globalBackend.cap().tryGetPackage(pkg._id));
      if (info.authorPgpKeyFingerprint) {
        console.log("  " + info.authorPgpKeyFingerprint);
        Packages.update(pkg._id,
            {$set: {authorPgpKeyFingerprint: info.authorPgpKeyFingerprint}});
      } else {
        console.log("  no signature");
      }
    } catch (err) {
      console.error(err.stack);
    }
  });
}

function splitUserIdsIntoAccountIdsAndIdentityIds() {
  var Crypto = Npm.require("crypto");
  Meteor.users.find().forEach(function (user) {
    var identity = {};
    var serviceUserId;
    if ("devName" in user) {
      identity.service = "dev";
      serviceUserId = user.devName;
    } else if ("expires" in user) {
      identity.service = "demo";
      serviceUserId = user._id;
    } else if (user.services && "google" in user.services) {
      identity.service = "google";
      if (user.services.google.email && user.services.google.verified_email) {
        identity.verifiedEmail = user.services.google.email;
      }
      serviceUserId = user.services.google.id;
    } else if (user.services && "github" in user.services) {
      identity.service = "github";
      identity.unverifiedEmail = user.services.github.email;
      serviceUserId = user.services.github.id;
    } else if (user.services && "emailToken" in user.services) {
      identity.service = "emailToken";
      identity.verifiedEmail = user.services.emailToken.email;
      serviceUserId = user.services.emailToken.email;
    }

    identity.id = Crypto.createHash("sha256")
        .update(identity.service + ":" + serviceUserId).digest("hex");

    if (user.profile) {
      if (user.profile.name) {
        identity.name = user.profile.name;
      }
      if (user.profile.handle) {
        identity.handle = user.profile.handle;
      }
      if (user.profile.picture) {
        identity.picture = user.profile.picture;
      }
      if (user.profile.pronoun) {
        identity.pronoun = user.profile.pronoun;
      }
      if (user.profile.email) {
        identity.unverifiedEmail = user.profile.email;
      }
    }
    identity.main = true;

    Meteor.users.update(user._id, {$set: {identities: [identity]}});

    Grains.update({userId: user._id}, {$set: {identityId: identity.id}}, {multi: true});
    Sessions.update({userId: user._id}, {$set: {identityId: identity.id}}, {multi: true});
    ApiTokens.update({userId: user._id},
                     {$set: {identityId: identity.id}},
                     {multi: true});
    ApiTokens.update({"owner.user.userId": user._id},
                     {$set: {"owner.user.identityId": identity.id}},
                     {multi: true});
    ApiTokens.update({"owner.grain.introducerUser": user._id},
                     {$set: {"owner.grain.introducerIdentity": identity.id}},
                     {multi: true});

    while (ApiTokens.update({"requirements.permissionsHeld.userId": user._id},
                            {$set: {"requirements.$.permissionsHeld.identityId": identity.id},
                             $unset: {"requirements.$.permissionsHeld.userId": 1}},
                            {multi: true}) > 0);
    // The `$` operatorer modifies the first element in the array that matches the query. Since
    // there may be many matches, we need to repeat until no documents are modified.

  });

  ApiTokens.remove({userInfo: {$exists: true}});
  // We've renamed `Grain.UserInfo.userId` to `Grain.userInfo.identityId`. The only place
  // that this field could show up in the database was in this deprecated, no-longer-functional
  // form of API token.
}

// This must come after all the functions named within are defined.
// Only append to this list!  Do not modify or remove list entries;
// doing so is likely change the meaning and semantics of user databases.
var MIGRATIONS = [
  updateLoginStyleToRedirect,
  enableLegacyOAuthProvidersIfNotInSettings,
  denormalizeInviteInfo,
  mergeRoleAssignmentsIntoApiTokens,
  fixOasisStorageUsageStats,
  fetchProfilePictures,
  assignPlans,
  removeKeyrings,
  useLocalizedTextInUserActions,
  verifyAllPgpSignatures,
  splitUserIdsIntoAccountIdsAndIdentityIds
];

function migrateToLatest() {
  if (Meteor.settings.replicaNumber) {
    // This is a replica. Wait for the first replica to perform migrations.

    console.log("Waiting for migrations on replica zero...");

    var done = new Future();
    var change = function (doc) {
      console.log("Migrations applied elsewhere: " + doc.value + "/" + MIGRATIONS.length);
      if (doc.value >= MIGRATIONS.length) done.return();
    }
    var observer = Migrations.find({_id: "migrations_applied"}).observe({
      added: change,
      changed: change
    });

    done.wait();
    observer.stop();
    console.log("Migrations have completed on replica zero.");

  } else {
    var applied = Migrations.findOne({_id: "migrations_applied"});
    var start;
    if (!applied) {
      // Migrations table is not yet seeded with a value.  This means it has
      // applied 0 migrations.  Persist this.
      Migrations.insert({_id: "migrations_applied", value: 0});
      start = 0;
    } else {
      start = applied.value;
    }
    console.log("Migrations already applied: " + start + "/" + MIGRATIONS.length);

    for (var i = start ; i < MIGRATIONS.length ; i++) {
      // Apply migration i, then record that migration i was successfully run.
      console.log("Applying migration " + (i+1));
      MIGRATIONS[i]();
      Migrations.update({_id: "migrations_applied"}, {$set: {value: i+1}});
      console.log("Applied migration " + (i+1));
    }
  }
}

// Apply all migrations on startup.
Meteor.startup(migrateToLatest);
