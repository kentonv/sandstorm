import { Template } from "meteor/templating";
import { Router } from "meteor/iron:router";
import { Session } from "meteor/session";

import { globalDb } from "/imports/db-deprecated";

Template.newAdmin.helpers({
  setDocumentTitle: function () {
    document.title = "Admin panel · " + globalDb.getServerTitle();
  },

  adminTab() {
    return Router.current().route.getName();
  },

  wildcardHostSeemsBroken() {
    return Session.get("alreadyTestedWildcardHost") && !Session.get("wildcardHostWorks");
  },
});
