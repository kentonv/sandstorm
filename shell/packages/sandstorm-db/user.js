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

var Crypto = Npm.require('crypto');
var Future = Npm.require('fibers/future');

userPictureUrl = function(user) {
  if (user.services && !(user.profile && user.profile.picture)) {
    // Try to determine user's avatar URL from login service.

    var google = user.services.google;
    if (google && google.picture) {
      return google.picture;
    }

    var github = user.services.github;
    if (github && github.id) {
      return 'https://avatars.githubusercontent.com/u/' + github.id;
    }

    // Note that we do NOT support Gravatar for email addresses because pinging Gravatar would be
    // a data leak, revealing that the user has logged into this Sandstorm server. Google and
    // Github are different because they are actually the identity providers, so they already know
    // the user logged in.
  }
};

fetchPicture = function(url) {
  try {
    var result = HTTP.get(url, {
      npmRequestOptions: { encoding: null },
      timeout: 5000,
    });

    var metadata = {};

    metadata.mimeType = result.headers['content-type'];
    if (metadata.mimeType.lastIndexOf('image/png', 0) === -1 &&
        metadata.mimeType.lastIndexOf('image/jpeg', 0) === -1) {
      throw new Error('unexpected Content-Type:', metadata.mimeType);
    }

    var enc = result.headers['content-encoding'];
    if (enc && enc !== 'identity') {
      metadata.encoding = enc;
    }

    return addStaticAsset(metadata, result.content);
  } catch (err) {
    console.error('failed to fetch user profile picture:', url, err.stack);
  }
};

var ValidHandle = Match.Where(function(handle) {
  check(handle, String);
  return !!handle.match(/^[a-z_][a-z0-9_]*$/);
});

Accounts.onCreateUser(function(options, user) {
  if (user.loginIdentities) {
    // it's an account
    check(user, {_id: String,
                 createdAt: Date,
                 isAdmin: Match.Optional(Boolean),
                 hasCompletedSignup: Match.Optional(Boolean),
                 signupKey: Match.Optional(String),
                 signupNote: Match.Optional(String),
                 signupEmail: Match.Optional(String),
                 expires: Match.Optional(Date),
                 appDemoId: Match.Optional(String),
                 loginIdentities: [{id: String}],
                 nonloginIdentities: [{id: String}], });

    if (Meteor.settings.public.quotaEnabled) {
      user.experiments = user.experiments || {};
      user.experiments = {
        firstTimeBillingPrompt: Math.random() < 0.5 ? 'control' : 'test',
      };
    }

    return user;
  }

  // Check profile.
  if (options.profile) {
    // TODO(cleanup): This check also appears in accounts-ui-methods.js.
    check(options.profile, Match.ObjectIncluding({
      name: Match.OneOf(null, Match.Optional(String)),
      handle: Match.Optional(ValidHandle),
      pronoun: Match.Optional(Match.OneOf('male', 'female', 'neutral', 'robot')),
    }));
  }

  check(options.unverifiedEmail, Match.Optional(String));

  if (options.unverifiedEmail) {
    user.unverifiedEmail = options.unverifiedEmail;
  }

  user.profile = _.pick(options.profile || {}, 'name', 'handle', 'pronouns');

  // Try downloading avatar.
  var url = userPictureUrl(user);
  if (url) {
    var assetId = fetchPicture(url);
    if (assetId) {
      user.profile.picture = assetId;
    }
  }

  var serviceUserId;
  if (user.services && user.services.dev) {
    check(user.services.dev, {name: String, isAdmin: Boolean, hasCompletedSignup: Boolean});
    serviceUserId = user.services.dev.name;
    user.profile.service = 'dev';
  } else if ('expires' in user) {
    serviceUserId = user._id;
    user.profile.service = 'demo';
  } else if (user.services && user.services.email) {
    check(user.services.email,
          {email: String,
           tokens: [{digest: String, algorithm: String, createdAt: Date}], });
    serviceUserId = user.services.email.email;
    user.profile.service = 'email';
  } else if (user.services && 'google' in user.services) {
    serviceUserId = user.services.google.id;
    user.profile.service = 'google';
  } else if (user.services && 'github' in user.services) {
    serviceUserId = user.services.github.id;
    user.profile.service = 'github';
  } else {
    throw new Meteor.Error(400, 'user does not have a recognized identity provider: ' +
                           JSON.stringify(user));
  }

  user._id = Crypto.createHash('sha256')
    .update(user.profile.service + ':' + serviceUserId).digest('hex');

  return user;
});

// TODO delete this obsolete index.
Meteor.users._ensureIndex('identities.id', {unique: 1, sparse: 1});

Meteor.users._ensureIndex('loginIdentities.id', {unique: 1, sparse: 1});
Meteor.users._ensureIndex('nonloginIdentities.id', {sparse: 1});
