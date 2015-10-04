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

var Crypto = Npm.require("crypto");
var Url = Npm.require("url");

SandstormPermissions = {};

function PermissionSet(array) {
  // A wrapper around an array of booleans.

  if (!array) {
    this.array = [];
  } else if (array instanceof Array) {
    this.array = array.slice(0);
  } else {
    throw new Error("don't know how to interpret as PermissionSet: " + array);
  }
}

// Methods for mutating a PermissionSet by combining it with another PermissionSet.
// These return a boolean indicating whether the operation had any effect.

PermissionSet.prototype.add = function(other) {
  var changed = false;
  for (var ii = 0; ii < other.array.length; ++ii) {
    var old = this.array[ii];
    this.array[ii] = this.array[ii] || other.array[ii];
    if (old != this.array[ii]) {
      changed = true;
    }
  }
  return changed;
}

PermissionSet.prototype.remove = function(other) {
  var changed = false;
  for (var ii = 0; ii < other.array.length && ii < this.array.length; ++ii) {
    var old = this.array[ii];
    this.array[ii] = this.array[ii] && !other.array[ii];
    if (old != this.array[ii]) {
      changed = true;
    }
  }
  return changed;
}

PermissionSet.prototype.intersect = function(other) {
  var changed = false;
  for (var ii = 0; ii < this.array.length; ++ii) {
    var old = this.array[ii];
    this.array[ii] = this.array[ii] && other.array[ii];
    if (old != this.array[ii]) {
      changed = true;
    }
  }
  return changed;
}

function roleAssignmentPermissions(roleAssignment, viewInfo) {
  var result = new PermissionSet([]);

  if (!roleAssignment || "none" in roleAssignment) {
    if (viewInfo.roles) {
      for (var ii = 0; ii < viewInfo.roles.length; ++ii) {
        var roleDef = viewInfo.roles[ii];
        if (roleDef.default) {
          result = new PermissionSet(roleDef.permissions);
          break;
        }
      }
    }
  } else if ("allAccess" in roleAssignment) {
    var length = 0;
    if (viewInfo.permissions) {
      length = viewInfo.permissions.length;
    }
    var array = new Array(length);
    for (var ii = 0; ii < array.length; ++ii) {
      array[ii] = true;
    }
    result = new PermissionSet(array);
  } else if ("roleId" in roleAssignment && viewInfo.roles && viewInfo.roles.length > 0) {
    var roleDef = viewInfo.roles[roleAssignment.roleId];
    if (roleDef) {
      result = new PermissionSet(roleDef.permissions);
    }
  }

  if (roleAssignment) {
    result.add(new PermissionSet(roleAssignment.addPermissionSet));
    result.remove(new PermissionSet(roleAssignment.removePermissionSet));
  }
  return result;
}

function collectEdges(db, vertex) {
  // Given a vertex in the sharing graph in the format specified by the `check()` invocation below,
  // collects the data needed for permissions computations pertaining to that vertex. There are four
  // self-explanatory special cases for the return value. In order of decreasing precedence, they
  // are: `{grainDoesNotExist: true}`, `{openerIsOwner: true}`, `{grainIsPublic: true}`, and
  // `{disallowedAnonymousAccess: true}`. In all other cases, this function returns an object
  // of the form: `{owner: <identityId>, edgesByRecipient: <object>, terminalEdge: Maybe(<object>)}`.
  // The `owner` field indicates the user who owns the grain. The `edgesByRecipient` field is a map
  // that coalesces chains of `parentToken` UiView tokens into direct user-to-user edges; its keys
  // are identity IDs of recipient users and its values are lists of "edge" objects of the form
  // `{sharer: <identityId>, roleAssignments: <list of role assignments>}`.  The role assignments
  // should be applied in sequence to compute the set of permissions that flow to a recipient from
  // a sharer. The `terminalEdge` field is an edge object representing the link to `vertex` from
  // the nearest user in the sharing graph. If `vertex` is already a user, then this edge is
  // trivial and its `roleAssignments` field is an empty list. If `terminalEdge` is not present,
  // then there is no such link.
  //
  // TODO(someday): Once UiView tokens can have membrane requirements, we'll need to account for
  // them in this computation.
  check(vertex,
        Match.OneOf({token: Match.ObjectIncluding({_id: String, grainId: String})},
                    {grain: Match.ObjectIncluding(
                      {_id: String,
                       identityId: Match.OneOf(String, null, undefined)})}));

  var grainId;
  if (vertex.token) {
    grainId = vertex.token.grainId;
  } else if (vertex.grain) {
    grainId = vertex.grain._id;
  }
  var grain = db.getGrain(grainId);
  if (!grain) {
    return {grainDoesNotExist: true};
  }

  if (vertex.grain && grain.identityId === vertex.grain.identityId) {
    return {openerIsOwner: true};
  }

  if (!grain.private) {
    return {grainIsPublic: true};
  } else if (vertex.grain && !vertex.grain.identityId) {
    return {disallowedAnonymousAccess: true};
  }

  var result = {edgesByRecipient: {}, owner: grain.identityId};
  var tokensById = {};
  db.collections.apiTokens.find({grainId: grainId,
                                 revoked: {$ne: true}}).forEach(function(token) {
    tokensById[token._id] = token;
  });

  function computeEdge(token) {
    var roleAssignments = [];
    var curToken = token;
    while (curToken && curToken.parentToken) {
      // For a `parentToken` provider, no role assignment means don't attenuate.
      if (curToken.roleAssignment) {
        roleAssignments.push(curToken.roleAssignment);
      }
      curToken = tokensById[curToken.parentToken];
    }
    if (curToken && curToken.grainId && curToken.identityId) {
      roleAssignments.push(curToken.roleAssignment);
      return {sharer: curToken.identityId, roleAssignments: roleAssignments};
    } else {
      return;
    }
  }

  if (vertex.token) {
    result.terminalEdge = computeEdge(tokensById[vertex.token._id]);
  } else if (vertex.grain) {
    result.terminalEdge = {sharer: vertex.grain.identityId, roleAssignments: []};
  }

  for (var id in tokensById) {
    var token = tokensById[id];
    if (Match.test(token.owner, {user: Match.Any})) {
      var edge = computeEdge(token);
      if (edge) {
        var recipient = token.owner.user.identityId ;
        if (!result.edgesByRecipient[recipient]) {
          result.edgesByRecipient[recipient] = [];
        }
        result.edgesByRecipient[recipient].push(edge);
      }
    }
  }
  return result;
}

SandstormPermissions.grainPermissions = function(db, vertex, viewInfo) {
  // Computes the permissions of a vertex. If the vertex is not allowed to open the grain,
  // returns null. Otherwise, returns an array of bools representing the permissions held.
  var edges = collectEdges(db, vertex);
  if (edges.openerIsOwner) {
    return roleAssignmentPermissions({allAccess: null}, viewInfo).array;
  }
  if (edges.grainIsPublic) {
    // Grains using the old sharing model always share the default role to anyone who has the
    // grain URL.
    return roleAssignmentPermissions({none: null}, viewInfo).array;
  }
  if (edges.grainDoesNotExist || !edges.terminalEdge || edges.disallowedAnonymousAccess) {
    return null;
  }

  var openerIdentityId = edges.terminalEdge.sharer;
  var edgesByRecipient = edges.edgesByRecipient;
  var owner = edges.owner;

  var permissionsMap = {};
  // Keeps track of the permissions that the opener receives from each user. The final result of
  // our computation will be stored in permissionsMap[owner].

  var userStack = [openerIdentityId];

  var openerAttenuation = roleAssignmentPermissions({allAccess: null}, viewInfo);
  edges.terminalEdge.roleAssignments.forEach(function(roleAssignment) {
    openerAttenuation.intersect(roleAssignmentPermissions(roleAssignment, viewInfo));
  });
  permissionsMap[openerIdentityId] = openerAttenuation;

  while (userStack.length > 0) {
    var recipient = userStack.pop();
    if (edgesByRecipient[recipient]) {
      edgesByRecipient[recipient].forEach(function (inEdge) {
        var sharer = inEdge.sharer;
        var needToPush = false;
        if (!permissionsMap[sharer]) {
          permissionsMap[sharer] = new PermissionSet();
          needToPush = true;
        }

        var newPermissions = roleAssignmentPermissions({allAccess: null}, viewInfo);
        inEdge.roleAssignments.forEach(function(roleAssignment) {
          newPermissions.intersect(roleAssignmentPermissions(roleAssignment, viewInfo));
        });
        newPermissions.intersect(permissionsMap[recipient]);

        // Optimization: we don't care about permissions that we've already proven the opener has.
        if (permissionsMap[owner]) {
          newPermissions.remove(permissionsMap[owner]);
        }

        if (permissionsMap[sharer].add(newPermissions)) {
          needToPush = true;
        }
        if (needToPush) {
          userStack.push(sharer);
        }
      });
    }
  }
  if (permissionsMap[owner]) {
    return permissionsMap[owner].array;
  } else {
    return null;
  }
}

SandstormPermissions.mayOpenGrain = function(db, vertex) {
  // Determines whether the vertex is allowed to open the grain by searching depth first
  // for a path of active role assignments leading from the grain owner to the vertex.

  var edges = collectEdges(db, vertex);
  if (edges.grainDoesNotExist || edges.disallowedAnonymousAccess) {
    return false;
  }
  if (edges.openerIsOwner || edges.grainIsPublic) {
    return true;
  }
  var edgesByRecipient = edges.edgesByRecipient;
  var owner = edges.owner;
  if (!edges.terminalEdge) { return false; }
  if (owner == edges.terminalEdge.sharer) {
    return true;
  }

  var openerIdentityId = edges.terminalEdge.sharer;
  var stackedUsers = {};
  stackedUsers[openerIdentityId] = true;
  var userStack = [openerIdentityId];

  while (userStack.length > 0) {
    var recipient = userStack.pop();
    var edges = edgesByRecipient[recipient];
    if (edges) {
      for (var ii = 0; ii < edges.length; ++ii) {
        var inEdge = edges[ii];
        var sharer = inEdge.sharer;
        if (sharer == owner) {
          return true;
        }
        if (!stackedUsers[sharer]) {
          userStack.push(sharer);
          stackedUsers[sharer] = true;
        }
      }
    }
  }
  return false;
}

SandstormPermissions.downstreamTokens = function(db, root) {
  // Computes a list of the UiView tokens that are downstream in the sharing graph from a given
  // source. The source, `root`, can either be a token or a (grain, user) pair. The exact format
  // of `root` is specified in the `check()` invocation below.
  //
  // TODO(someday): Once UiView tokens can have membrane requirements, we'll need to account for
  // them in this computation.

  check(root, Match.OneOf({token: Match.ObjectIncluding({_id: String, grainId: String})},
                          {grain: Match.ObjectIncluding({_id: String, identityId: String})}));

  var result = [];
  var tokenStack = [];
  var stackedTokens = {};
  var tokensBySharer = {};
  var tokensByParent = {};
  var tokensById = {};

  function addChildren(tokenId) {
    var children = tokensByParent[tokenId];
    if (children) {
      children.forEach(function (child) {
        if (!stackedTokens[child._id]) {
          tokenStack.push(child);
          stackedTokens[child._id] = true;
        }
      });
    }
  }

  function addSharedTokens(sharer) {
    var sharedTokens = tokensBySharer[sharer];
    if (sharedTokens) {
      sharedTokens.forEach(function (sharedToken) {
        if (!stackedTokens[sharedToken._id]) {
          tokenStack.push(sharedToken);
          stackedTokens[sharedToken._id] = true;
        }
      });
    }
  }

  var grainId;
  if (root.token) {
    grainId = root.token.grainId;
  } else if (root.grain) {
    grainId = root.grain._id;
  }

  var grain = db.getGrain(grainId);
  if (!grain || !grain.private ) { return result; }

  db.collections.apiTokens.find({grainId: grainId,
                                 revoked: {$ne: true}}).forEach(function (token) {
    tokensById[token._id] = token;
    if (token.parentToken) {
      if (!tokensByParent[token.parentToken]) {
        tokensByParent[token.parentToken] = [];
      }
      tokensByParent[token.parentToken].push(token);
    } else if (token.identityId) {
      if (!tokensBySharer[token.identityId]) {
        tokensBySharer[token.identityId] = [];
      }
      tokensBySharer[token.identityId].push(token);
    }
  });

  if (root.token) {
    addChildren(root.token._id);
  } else if (root.grain) {
    addSharedTokens(root.grain.identityId);
  }

  while (tokenStack.length > 0) {
    var token = tokenStack.pop();
    result.push(token);
    addChildren(token._id);
    if (token.owner && token.owner.user) {
      addSharedTokens(token.owner.user.identityId);
    }
  }

  return result;
}

SandstormPermissions.createNewApiToken = function (db, provider, grainId, petname,
                                                   roleAssignment, forSharing,
                                                   expiresIfUnusedDuration) {
  // Creates a new UiView API token. If `rawParentToken` is set, creates a child token.
  check(grainId, String);
  check(petname, String);
  check(roleAssignment, db.roleAssignmentPattern);
  check(forSharing, Boolean);
  // Meteor bug #3877: we get null here instead of undefined when we
  // explicitly pass in undefined.
  check(expiresIfUnusedDuration, Match.OneOf(undefined, null, Number));
  check(provider, Match.OneOf({identityId: String}, {rawParentToken: String}));

  var grain = db.getGrain(grainId);
  if (!grain) {
    throw new Meteor.Error(403, "Unauthorized", "No grain found.");
  }

  var token = Random.secret();
        var apiToken = {
    _id: Crypto.createHash("sha256").update(token).digest("base64"),
    grainId: grainId,
    roleAssignment: roleAssignment,
    petname: petname,
    created: new Date(),
    expires: null,
  };

  if (provider.rawParentToken) {
    var parentToken = Crypto.createHash("sha256").update(provider.rawParentToken).digest("base64");
    var parentApiToken = db.collections.apiTokens.findOne(
      {_id: parentToken, grainId: grainId, objectId: {$exists: false}});
    if (!parentApiToken) {
      throw new Meteor.Error(403, "No such parent token found.");
    }
    identityId = parentApiToken.identityId;
    if (parentApiToken.forSharing) {
      forSharing = true;
    }
    apiToken.parentToken = parentToken;
  } else {
    apiToken.identityId = provider.identityId;
  }
  apiToken.forSharing = forSharing;

  if (expiresIfUnusedDuration) {
    apiToken.expiresIfUnused = new Date(Date.now() + expiresIfUnusedDuration);
  }

  db.collections.apiTokens.insert(apiToken);

  var endpointUrl = Url.parse(process.env.ROOT_URL).protocol + "//" + db.makeWildcardHost("api");
  return {id: apiToken._id, token: token, endpointUrl: endpointUrl};
}

// Make self-destructing tokens actually self-destruct, so they don't
// clutter the token list view.
SandstormPermissions.cleanupSelfDestructing = function (db) {
  return function () {
    var now = new Date();
    db.collections.apiTokens.remove({expiresIfUnused: {$lt: now}});
  }
}

Meteor.methods({
  transitiveShares: function(identityId, grainId) {
    check(identityId, String);
    check(grainId, String);
    if (this.userId) {
      var db = this.connection.sandstormDb;
      return SandstormPermissions.downstreamTokens(db,
          {grain: {_id: grainId, identityId: identityId }});
    }
  },

  newApiToken: function (provider, grainId, petname, roleAssignment, forSharing,
                         expiresIfUnusedDuration) {
    check(provider, Match.OneOf({identityId: String}, {rawParentToken: String}));
    var db = this.connection.sandstormDb;
    if (provider.identityId) {
      if (!this.userId || !db.getIdentityOfUser(provider.identityId, this.userId)) {
        throw new Meteor.Error(403, "Not an identity of the current user: " + provider.identityId);
      }
    }
    return SandstormPermissions.createNewApiToken(
      this.connection.sandstormDb, provider, grainId, petname, roleAssignment, forSharing,
      expiresIfUnusedDuration);
  },

  updateApiToken: function (token, newFields) {
    var db = this.connection.sandstormDb;

    check(token, String);
    check(newFields, {petname: Match.Optional(String),
                      roleAssignment: Match.Optional(db.roleAssignmentPattern),
                      revoked: Match.Optional(Boolean)});

    var apiToken = db.collections.apiTokens.findOne(token);
    if (!apiToken) {
      throw new Meteor.Error(404, "No such token found.");
    }
    if (this.userId && apiToken.identityId == db.getUserIdentities(this.userId)[0].id) {
      var modifier = {$set: newFields};
      db.collections.apiTokens.update(token, modifier);
    } else {
      throw new Meteor.Error(403, "User not authorized to modify this token.");
    }
  }
});
