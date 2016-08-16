// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2016 Sandstorm Development Group, Inc. and contributors
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

const PowerboxOptions = new Mongo.Collection("powerboxOptions");

SandstormPowerboxRequest = class SandstormPowerboxRequest {
  constructor(db, requestInfo) {
    check(requestInfo, Match.ObjectIncluding({
      source: Match.Any,
      origin: Match.Any,
      rpcId: Match.Any,
      // For reasons I don't understand, Match.Optional does not work here.
      query: Match.OneOf(undefined, [String]),
      saveLabel: Match.Optional(Match.Any),
      sessionId: String,
      grainId: String,
      identityId: String,
      onCompleted: Function,
    }));

    this._db = db;
    this._requestInfo = requestInfo;
    this._completed = false;
    this._error = new ReactiveVar(undefined);

    // State to track UI status.
    this._filter = new ReactiveVar("");
    this._selectedProvider = new ReactiveVar(undefined);

    this._requestId = Random.id();
  }

  subscribe(tmpl) {
    if (this._requestInfo.query) {
      tmpl.subscribe("powerboxOptions", this._requestId, this._requestInfo.query);
    }
  }

  finalize() {
    if (!this._completed) {
      // postMessage back to the origin frame that the request was cancelled.
      this._requestInfo.source.postMessage({
        rpcId: this._requestInfo.rpcId,
        canceled: true,
      }, this._requestInfo.origin);
      this._completed = true;
    }
  }

  completeRequest(token, descriptor) {
    this._completed = true;
    this._requestInfo.source.postMessage({
      rpcId: this._requestInfo.rpcId,
      token: token,
      descriptor: descriptor,
    }, this._requestInfo.origin);
    // Completion event closes popup.
    this._requestInfo.onCompleted();
  }

  cancelRequest() {
    this.finalize();
    this._requestInfo.onCompleted();
  }

  failRequest(err) {
    console.error(err);
    this._error.set(err.toString());
  }

  selectCard(card) {
    if (card.configureTemplate) {
      // There is further UI to display.
      this._selectedProvider.set(card);
    } else if (card.option.frontendRef) {
      this.completeNewFrontendRef(card.option.frontendRef);
    } else {
      this.failRequest(new Error("not sure how to complete powerbox request for non-frontedRef " +
                                 "that didn't provide a configureTemplate"));
    }
  }

  filteredCardData() {
    // Returns an array of "cards" (options from which the user can pick), sorted in the order in
    // which they should appear. Each "card" is intended to be the data context for a card or
    // configuration template, and has the following fields:
    //
    // db: The SansdtormDb.
    // powerboxRequest: This SandstormPowerboxRequest object.
    // option: The PowerboxOption returned by the `powerboxOptions` subscription.
    // grainInfo: If option.grainId is present, extended display information about the grain:
    //     title: Human-readable title string.
    //     appTitle (optional): Human-readable title of the app serving this option.
    //     iconSrc (optional): URL of an icon.
    //     lastUsed (optional): Date when this item was last accessed.
    //     cachedViewInfo (optional): The ViewInfo for the grain, if it is locally available.
    //     apiTokenId (optional): The _id in ApiTokens of the token granting the user access to
    //         this grain.
    // cardTemplate: The Template object named by option.cardTemplate.
    // configureTemplate: The Template object named by option.configureTemplate.

    const cards = PowerboxOptions.find({ requestId: this._requestId }).map(option => {
      const result = {
        db: this._db,
        powerboxRequest: this,
        option: option,
        cardTemplate: option.cardTemplate && Template[option.cardTemplate],
        configureTemplate: option.configureTemplate && Template[option.configureTemplate],
      };

      if (option.grainId) {
        result.grainInfo = this.collectGrainInfo(option.grainId);
      }

      return result;
    });

    const now = new Date();
    return _.chain(cards)
        .filter(compileMatchFilter(this._filter.get()))
        .sortBy(card => -((card.grainInfo || {}).lastUsed || now).getTime())
        .value();
  }

  collectGrainInfo(grainId) {
    // Gather display info for a grain.

    // Look for an owned grain.
    const grain = this._db.collections.grains.findOne(grainId);
    if (grain && grain.userId === Meteor.userId()) {
      const pkg = this._db.collections.packages.findOne(grain.packageId);
      return {
        title: grain.title,
        appTitle: pkg ? SandstormDb.appNameFromPackage(pkg) : "",
        iconSrc: pkg ? this._db.iconSrcForPackage(pkg, "grain") : "",
        lastUsed: grain.lastUsed,
        cachedViewInfo: grain.cachedViewInfo,
      };
    }

    // Look for an ApiToken.
    const apiToken = this._db.collections.apiTokens.findOne(
        { grainId: grainId, "owner.user": { $exists: true } });
    if (apiToken) {
      const ownerData = apiToken.owner.user;
      const grainInfo = ownerData.denormalizedGrainMetadata;
      const staticAssetHost = this._db.makeWildcardHost("static");

      return {
        title: ownerData.upstreamTitle && !ownerData.renamed ?
            ownerData.upstreamTitle : ownerData.title,
        appTitle:
            (grainInfo && grainInfo.appTitle && grainInfo.appTitle.defaultText) || "",
        iconSrc: (grainInfo && grainInfo.icon && grainInfo.icon.assetId) ?
            (window.location.protocol + "//" + staticAssetHost + "/" + grainInfo.icon.assetId) :
            Identicon.identiconForApp(
                (grainInfo && grainInfo.appId) || "00000000000000000000000000000000"),
        lastUsed: apiToken.lastUsed,
        apiTokenId: apiToken._id,
      };
    }

    // Couldn't find anything.
    return {};
  }

  completeNewFrontendRef(frontendRef) {
    Meteor.call("newFrontendRef",
      this._requestInfo.sessionId,
      frontendRef,
      (err, result) => {
        if (err) {
          this.failRequest(err);
        } else {
          this.completeRequest(result.sturdyRef, result.descriptor);
        }
      }
    );
  }

  completeUiView(grainId, roleAssignment) {
    Meteor.call(
      "fulfillUiViewRequest",
      this._requestInfo.sessionId,
      this._requestInfo.identityId,
      grainId,
      // TODO(cleanup): Petnames on ApiTokens have never really been used as intended, and it's
      //   not clear that they are useful in any case. `ApiTokens.petname` was originally intended
      //   to describe -- to the owner of the target grain -- the circumstances under which the
      //   capability was issued, to be considered when auditing/revoking incoming capabilities.
      //   It probably makes more sense to derive a visualization from `owner` and `requirements`.
      "selected via Powerbox",
      roleAssignment,
      this._requestInfo.grainId,
      (err, result) => {
        if (err) {
          this.failRequest(err);
        } else {
          this.completeRequest(result.sturdyRef, result.descriptor);
        }
      }
    );
  }
};

const matchesAppOrGrainTitle = function (needle, cardData) {
  if (cardData.title && cardData.title.toLowerCase().indexOf(needle) !== -1) return true;
  if (cardData.appTitle && cardData.appTitle.toLowerCase().indexOf(needle) !== -1) return true;
  return false;
};

const compileMatchFilter = function (searchString) {
  // split up searchString into an array of regexes, use them to match against item
  const searchKeys = searchString.toLowerCase()
      .split(" ")
      .filter(function (k) { return k !== "";});

  return function matchFilter(item) {
    if (searchKeys.length === 0) return true;
    return _.chain(searchKeys)
        .map((searchKey) => matchesAppOrGrainTitle(searchKey, (item || {}).grainInfo || {}))
        .reduce(function (a, b) { return a && b; })
        .value();
  };
};

const prepareViewInfoForDisplay = function (viewInfo) {
  const result = _.clone(viewInfo || {});
  if (result.permissions) indexElements(result.permissions);
  // It's essential that we index the roles *before* hiding obsolete roles,
  // or else we'll produce the incorrect roleAssignment for roles that are
  // described after obsolete roles in the pkgdef.
  if (result.roles) {
    indexElements(result.roles);
    result.roles = removeObsolete(result.roles);
  }

  return result;
};

const indexElements = function (arr) {
  // Helper function to annotate an array of objects with their indices
  for (let i = 0; i < arr.length; i++) {
    arr[i].index = i;
  }
};

const removeObsolete = function (arr) {
  // remove entries from the list that are flagged as obsolete
  return _.filter(arr, function (el) {
    return !el.obsolete;
  });
};

Template.powerboxRequest.onCreated(function () {
  this.autorun(() => {
    const request = this.data.get();
    if (request) request.subscribe(this);
  });
});

Template.powerboxRequest.onRendered(function () {
  const searchbar = this.findAll(".search-bar")[0];
  if (searchbar) searchbar.focus();
});

Template.powerboxRequest.helpers({
  cards: function () {
    const ref = Template.instance().data.get();
    return ref && ref.filteredCardData() || [];
  },

  selectedProvider: function () {
    const ref = Template.instance().data.get();
    return ref && ref._selectedProvider && ref._selectedProvider.get();
  },

  showWebkeyInput: function () {
    // Transitional feature: treat requests that specified no query patterns to match, not even the
    // empty list, as requests for webkeys.  Later, we"ll want to transition the test apps to
    // specify interfaces, and implement frontendrefs to support those interfaces.
    const ref = Template.instance().data.get();
    return !(ref && ref._requestInfo && ref._requestInfo.query);
  },

  webkeyError: function () {
    // Transitional function:
    const ref = Template.instance().data.get();
    return ref && ref._error.get();
  },

  error() {
    const ref = Template.instance().data.get();
    return ref && ref._error.get();
  },

  iconSrc() {
    // data context is a card here
    return this.cardTemplate.powerboxIconSrc && this.cardTemplate.powerboxIconSrc(this);
  },
});

Template.powerboxRequest.events({
  "input .search-bar": function (evt) {
    Template.instance().data.get()._filter.set(evt.target.value);
  },

  "keypress .search-bar": function (evt) {
    if (evt.keyCode === 13) {
      // Enter pressed.  If a single grain is shown, activate it.
      const ref = Template.instance().data.get();
      const cards = ref.filteredCardData();
      if (cards.length === 1) {
        cards[0].powerboxRequest.selectCard(cards[0]);
      }
    }
  },

  "submit #powerbox-request-form": function (evt) {
    // Legacy support for the webkey workflow.
    evt.preventDefault();
    const ref = Template.instance().data.get();
    const saveLabel = ref._requestInfo.saveLabel;
    const identityId = ref._requestInfo.identityId;
    const grainId = ref._requestInfo.grainId;
    const sessionId = ref._requestInfo.sessionId;
    Meteor.call("finishPowerboxRequest", sessionId, evt.target.token.value, saveLabel,
                identityId, grainId, function (err, token) {
        if (err) {
          ref._error.set(err.toString());
        } else {
          ref._completed = true;
          ref._requestInfo.source.postMessage({
            rpcId: ref._requestInfo.rpcId,
            token: token,
          }, ref._requestInfo.origin);
          // Completion event closes popup.
          ref._requestInfo.onCompleted();
        }
      }
    );
  },

  "click .card-button": function (evt) {
    this.powerboxRequest.selectCard(this);
  },
});

// =======================================================================================
// Templates for specific request types.
//
// TODO(cleanup): Find a better home for these.

Template.grainPowerboxCard.powerboxIconSrc = card => {
  return card.grainInfo.iconSrc;
};

Template.uiViewPowerboxConfiguration.onCreated(function () {
  this._viewInfo = new ReactiveVar({});

  // Fetch the view info for the grain.
  if (this.data.grainInfo.cachedViewInfo) {
    this._viewInfo.set(prepareViewInfoForDisplay(this.data.grainInfo.cachedViewInfo));
  } else if (this.data.grainInfo.apiTokenId) {
    Meteor.call("getViewInfoForApiToken", this.data.grainInfo.apiTokenId, (err, result) => {
      if (err) {
        console.log(err);
        this.data.powerboxRequest.failRequest(err);
      } else {
        this._viewInfo.set(prepareViewInfoForDisplay(result));
      }
    });
  }
});

Template.uiViewPowerboxConfiguration.helpers({
  viewInfo: function () {
    return Template.instance()._viewInfo.get();
  },
});

Template.uiViewPowerboxConfiguration.events({
  "click .connect-button": function (evt) {
    evt.preventDefault();
    const selectedInput = Template.instance().find('form input[name="role"]:checked');
    if (selectedInput) {
      let roleAssignment;
      if (selectedInput.value === "all") {
        roleAssignment = { allAccess: null };
      } else {
        const role = parseInt(selectedInput.value, 10);
        roleAssignment = { roleId: role };
      }

      this.powerboxRequest.completeUiView(this.option.grainId, roleAssignment);
    }
  },
});

Template.emailVerifierPowerboxCard.helpers({
  serviceTitle: function () {
    const services = this.option.frontendRef.emailVerifier.services;
    const name = services[0];
    const service = Accounts.identityServices[name];
    if (service.loginTemplate.name === "oauthLoginButton") {
      return service.loginTemplate.data.displayName;
    } else if (name === "email") {
      return "passwordless e-mail login";
    } else if (name === "ldap") {
      return "LDAP";
    } else {
      return name;
    }
  },
});

Template.emailVerifierPowerboxCard.powerboxIconSrc = () => "/email-m.svg";
Template.verifiedEmailPowerboxCard.powerboxIconSrc = () => "/email-m.svg";
