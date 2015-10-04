var iconForAction = function (action) {
  var ref = Template.instance().data;
  var appId = action.appId;
  var pkg = ref._db.collections.packages.findOne({_id: action.packageId});
  if (!pkg) {
    // Sometimes pkg may not have synced to minimongo yet on pageload.
    // Reactivity will ensure the page looks right when the data loads, but in the meantime,
    // avoid causing noisy backtraces in the console.
    return "";
  }
  return Identicon.iconSrcForPackage(pkg, 'appGrid', ref._staticHost);
};
var appTitleForAction = function (action) {
  if (action.appTitle) return action.appTitle.defaultText;
  // Legacy cruft: guess at the app title from the action text.
  // N.B.: calls into shell.js.  TODO: refactor
  return appNameFromActionName(action.title.defaultText);
};
var matchesAppOrActionTitle = function (needle, action) {
  var appTitle = appTitleForAction(action);
  if (nounFromAction(action, appTitle).toLowerCase().indexOf(needle) !== -1) return true;
  if (appTitle.toLowerCase().indexOf(needle) !== -1) return true;
  return false;
}
var compileMatchFilter = function(searchString) {
  var searchKeys = searchString.toLowerCase()
      .split(" ")
      .filter(function(k) { return k !== "";});
  return function matchFilter(item) {
    if (searchKeys.length === 0) return true;
    return _.chain(searchKeys)
        .map(function (searchKey) {return matchesAppOrActionTitle(searchKey, item); })
        .reduce(function (a, b) {return a && b; })
        .value();
  };
}

var actionToTemplateObject = function(action) {
  var title = appTitleForAction(action);
  return {
    _id: action._id,
    iconSrc: iconForAction(action),
    appTitle: title,
    noun: nounFromAction(action, title),
    appId: action.appId
  };
};
var matchActions = function (searchString) {
  var filter = compileMatchFilter(searchString)

  var allActions = Template.instance().data._db.currentUserActions().fetch();
  var actions = _.chain(allActions)
                 .filter(filter)
                 .value()
  return actions;
};
var nounFromAction = function (action, appTitle) {
  // A hack to deal with legacy apps not including fields in their manifests.
  // I look forward to the day I can remove most of this code.
  // Attempt to figure out the appropriate noun that this action will create.
  // Use an explicit noun phrase is one is available.  Apps should add these in the future.
  if (action.nounPhrase) return action.nounPhrase.defaultText;
  // Otherwise, try to guess one from the structure of the action title field
  if (action.title) {
    var text = action.title.defaultText;
    // Strip a leading "New "
    if (text.lastIndexOf("New ", 0) === 0) {
      var candidate = text.slice(4);
      // Strip a leading appname too, if provided
      if (candidate.lastIndexOf(appTitle, 0) === 0) {
        var newCandidate = candidate.slice(appTitle.length);
        // Unless that leaves you with no noun, in which case, use "instance"
        if (newCandidate.length > 0) {
          return newCandidate.toLowerCase();
        } else {
          return "instance";
        }
      }
      return candidate.toLowerCase();
    }
    // Some other verb phrase was given.  Just use it verbatim, and hope the app author updates
    // the package soon.
    return text;
  } else {
    return "instance";
  }
};

// Client-only stuff...
Template.sandstormAppList.helpers({
  searching: function() {
    var ref = Template.instance().data;
    return ref._filter.get().length > 0;
  },
  myGrainsCount: function () {
    return Template.instance().data._db.currentUserGrains().count();
  },
  actionsCount: function() {
    var ref = Template.instance().data;
    return ref._db.currentUserActions({}).count();
  },
  actions: function() {
    var ref = Template.instance().data;
    var actions = matchActions(ref._filter.get());
    return _.chain(actions)
            .map(actionToTemplateObject)
            .sortBy(function (action) { return action.appTitle.toLowerCase(); })
            .value();
  },
  assetPath: function(assetId) {
    return makeWildcardHost("static") + assetId;
  },
  popularActions: function() {
    var ref = Template.instance().data;
    // We approximate action popularity by the number of grains the user has for the app
    // which provides that action.
    var actions = matchActions(ref._filter.get());
    // Map actions into the apps that own them.
    var appIds = _.pluck(actions, "appId");
    // Count the number of grains owned by this user created by that app.
    var grains = ref._db.currentUserGrains().fetch();
    var appCounts = _.countBy(grains, function(x) { return x.appId; });
    // Sort apps by the number of grains created descending.
    var appIdsByGrainsCreated = _.chain(appIds)
        .sortBy(function(appId) { return appCounts[appId] || 0; })
        .reverse()
        .value();
    // Sort actions by the number of grains created by the matching app.
    var actionsByGrainCount = _.sortBy(actions, function(action) {
       return appIdsByGrainsCreated.indexOf(action.appId);
    });
    return actionsByGrainCount.map(actionToTemplateObject);
  },
  devActions: function () {
    var ref = Template.instance().data;
    var result = ref._db.collections.devApps.find().fetch();
    var actionList = result.map(function(devapp) {
      var thisAppActions = [];
      for (var i = 0 ; i < devapp.manifest.actions.length ; i++) {
        thisAppActions.push({
          _id: devapp._id,
          appTitle: devapp.manifest.appTitle.defaultText,
          noun: nounFromAction(devapp.manifest.actions[i], devapp.manifest.appTitle.defaultText),
          iconSrc: Identicon.iconSrcForDevPackage(devapp, 'appGrid', Template.instance().data._staticHost),
          actionIndex: i
        });
      }
      return thisAppActions;
    });
    // Flatten array of arrays of actions into single array
    if (actionList.length > 0) {
      return _.flatten(actionList, true);
    } else {
      return [];
    }
  },
  origin: function() {
    return document.location.protocol + "//" + document.location.host;
  },
  isSignedUpOrDemo: function() {
    return this._db.isSignedUpOrDemo();
  },
  shouldHighlight: function () {
    return this.appId === Template.instance().data._highlight;
  },
  uninstalling: function () {
    return Template.instance().data._uninstalling.get();
  },
  appIsLoading: function () {
    return Template.instance().appIsLoading.get();
  },
});
Template.sandstormAppList.events({
  "click .install-button": function (event) {
    event.preventDefault();
    event.stopPropagation();
    Template.instance().data._quotaEnforcer.ifQuotaAvailable(function () {
      window.open("https://apps.sandstorm.io/?host=" +
          document.location.protocol + "//" + document.location.host, "_blank");
    });
  },
  "click .upload-button": function (event) {
    Template.instance().data._quotaEnforcer.ifPlanAllowsCustomApps(function () {
      // N.B.: this calls into a global in shell.js.
      // TODO(cleanup): refactor into a safer dependency.
      promptUploadApp();
    });
  },
  "click .restore-button": function (event) {
    Template.instance().data._quotaEnforcer.ifQuotaAvailable(function () {
      // N.B.: this calls into a global in shell.js.
      // TODO(cleanup): refactor into a safer dependency.
      promptRestoreBackup();
    });
  },
  "click .app-action": function(event, template) {
    var actionId = this._id;
    Template.instance().data._quotaEnforcer.ifQuotaAvailable(function () {
      // N.B.: this calls into a global in shell.js.
      // TODO(cleanup): refactor into a safer dependency.
      template.appIsLoading.set(true);
      launchAndEnterGrainByActionId(actionId);
    });
  },
  "click .uninstall-action": function(event) {
    var actionId = this._id;
    var appId = UserActions.findOne(actionId).appId;
    UserActions.remove(actionId);
    Meteor.call("deleteUnusedPackages", appId);
  },
  "click .dev-action": function(event, template) {
    var devId = this._id;
    var actionIndex = this.actionIndex;
    // N.B.: this calls into a global in shell.js.
    // TODO(cleanup): refactor into a safer dependency.
    template.appIsLoading.set(true);
    launchAndEnterGrainByActionId("dev", this._id, this.actionIndex);
  },
  "click button.toggle-uninstall": function(event) {
    var uninstallVar = Template.instance().data._uninstalling;
    uninstallVar.set(!uninstallVar.get());
  },
  // We use keyup rather than keypress because keypress's event.currentTarget.value will not
  // have taken into account the keypress generating this event, so we'll miss a letter to
  // filter by
  "keyup .search-bar": function(event) {
    Template.instance().data._filter.set(event.currentTarget.value);
  },
  "keypress .search-bar": function(event, template) {
    var ref = Template.instance().data;
    if (event.keyCode === 13) {
      // Enter pressed.  If a single grain is shown, open it.
      var actions = matchActions(ref._filter.get());
      if (actions.length === 1) {
        // Unique grain found with current filter.  Activate it!
        var action = actions[0]._id;
        // N.B.: this calls into a global in shell.js.
        // TODO(cleanup): refactor into a safer dependency.
        template.appIsLoading.set(true);
        launchAndEnterGrainByActionId(action);
      }
    }
  }
});
Template.sandstormAppList.onRendered(function () {
  // Scroll to highlighted app, if any.
  if (this.data._highlight) {
    var self = this;
    this.autorun(function (computation) {
      if (self.subscriptionsReady()) {
        var item = self.findAll(".highlight")[0];
        if (item) {
          item.focus();
          item.scrollIntoView();
        }
        computation.stop();
      }
    });
  } else {
    // Auto-focus search bar on desktop, but not mobile (on mobile it will open the software
    // keyboard which is undesirable). window.orientation is generally defined on mobile browsers
    // but not desktop browsers, but some mobile browsers don't support it, so we also check
    // clientWidth. Note that it's better to err on the side of not auto-focusing.
    if (window.orientation === undefined && window.innerWidth > 600) {
      var searchbar = this.findAll(".search-bar")[0];
      if (searchbar) searchbar.focus();
    }
  }
});
Template.sandstormAppList.onCreated(function () {
  this.appIsLoading = new ReactiveVar(false);
});
