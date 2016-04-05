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

const Crypto = Npm.require("crypto");

SandstormPermissions = {};

class PermissionSet {
  // A wrapper around an array of booleans representing a set of permissions like "read" or
  // "write". This might represent the permissions held by some user on some grain, or it might
  // represent the permissions that one user has chosen to share with another user.
  //
  // In our model, permissions are independent. You can have "read" without "write" and you can
  // have "write" without "read". Many apps don't actually allow arbitrary permutations, and
  // instead define "roles" like "editor" or "viewer", where "editor" implies both read and write
  // permission while "viewer" implies only read. Roles, however, are just aliases for sets of
  // permissions; all actual computation is done on permissions.

  constructor(array) {
    if (!array) {
      this.array = [];
    } else if (array instanceof Array) {
      this.array = array.slice(0);
    } else {
      throw new Error("don't know how to interpret as PermissionSet: " + array);
    }
  }

  static fromRoleAssignment(roleAssignment, viewInfo) {
    // Create a PermissionSet based on a ViewSharingLink.RoleAssignment and a UiView.ViewInfo (as
    // defined in grain.capnp). ViewInfo defines a mapping from roles to permission sets for a
    // particular grain type. RoleAssignment represents the permissions passed from one user to
    // another -- usually it specifies a single role, but sometimes also specifies permissions to
    // add or remove as well.
    //
    // A falsy value for `roleAssignment` is considered equivalent to a "none" value, which means
    // that no role was explicitly chosen, so the default role should be assigned.

    let result = new PermissionSet([]);

    if (!roleAssignment || "none" in roleAssignment) {
      // No role explicitly chosen, e.g. because the app did not define any roles at the time
      // the sharing took place. Assign the default role, if there is one.

      if (viewInfo.roles) {
        for (let ii = 0; ii < viewInfo.roles.length; ++ii) {
          const roleDef = viewInfo.roles[ii];
          if (roleDef.default) {
            result = new PermissionSet(roleDef.permissions);
            break;
          }
        }
      }
    } else if ("allAccess" in roleAssignment) {
      // All permissions are shared, even if there is no explicitly-defined role for this.

      let length = 0;
      if (viewInfo.permissions) {
        length = viewInfo.permissions.length;
      }

      const array = new Array(length);
      for (let ii = 0; ii < array.length; ++ii) {
        array[ii] = true;
      }

      result = new PermissionSet(array);
    } else if ("roleId" in roleAssignment && viewInfo.roles && viewInfo.roles.length > 0) {
      // A specific role was chosen.

      const roleDef = viewInfo.roles[roleAssignment.roleId];
      if (roleDef) {
        result = new PermissionSet(roleDef.permissions);
      }
    }

    if (roleAssignment) {
      // Add or remove specific permissions. This is uncommon.
      result.add(new PermissionSet(roleAssignment.addPermissionSet));
      result.remove(new PermissionSet(roleAssignment.removePermissionSet));
    }

    return result;
  }

  isEmpty() {
    let result = true;
    this.array.forEach((p) => {
      if (p) {
        result = false;
      }
    });

    return result;
  }

  isSubsetOf(other) {
    check(other, PermissionSet);
    for (let ii = 0; ii < this.array.length; ++ii) {
      const mine = this.array[ii];
      const yours = other.array[ii] || false;
      if (mine && !yours) {
        return false;
      }
    }

    return true;
  }

  // Methods for mutating a PermissionSet by combining it with another PermissionSet.
  // These return a boolean indicating whether the operation had any effect.

  add(other) {
    check(other, PermissionSet);
    let changed = false;
    for (let ii = 0; ii < other.array.length; ++ii) {
      const old = !!this.array[ii];
      this.array[ii] = !!this.array[ii] || other.array[ii];
      if (old !== this.array[ii]) {
        changed = true;
      }
    }

    return changed;
  }

  remove(other) {
    check(other, PermissionSet);
    let changed = false;
    for (let ii = 0; ii < other.array.length && ii < this.array.length; ++ii) {
      const old = !!this.array[ii];
      this.array[ii] = !!this.array[ii] && !other.array[ii];
      if (old !== this.array[ii]) {
        changed = true;
      }
    }

    return changed;
  }

  intersect(other) {
    check(other, PermissionSet);
    let changed = false;
    for (let ii = 0; ii < this.array.length; ++ii) {
      const old = !!this.array[ii];
      this.array[ii] = !!this.array[ii] && other.array[ii];
      if (old !== this.array[ii]) {
        changed = true;
      }
    }

    return changed;
  }
}

class RequirementSet {
  // A conjunction of permissions for identities on grains.
  //
  // This typically represents a set of `MembraneRequirement`s, as defined in `supervisor.capnp`.
  // These represent conditions under which some connection formed between grains remains valid.
  // When a capability travels from grain to grain, it passes across these connections -- if any
  // of the connections becomes invalid (is revoked), then the capability must be revoked as well.
  // The word "membrane" comes from the concept of revokable membranes; the capability is passing
  // across such membranes as it travels.
  //
  // For example, a RequirementSet might represent the statement "Alice has read access to Foo, Bob
  // has write access to Foo, and Bob has read access to Bar". Specifically, this example situation
  // would come about if:
  // - Bob used his read access to Bar to extract a capability from it.
  // - Bob embedded that capability into Foo, using his write access.
  // - Alice extracted the capability from Foo, using her read access.
  // If any of these permissions are revoked, then the capability needs to be revoked as well.

  constructor() {
    this.identityPermissions = {};
    // Two-level map. Maps a pair of a grain ID and an identity ID to a PermissionSet.
  }

  isEmpty() {
    for (const grainId in this.identityPermissions) {
      if (Object.keys(this.identityPermissions[grainId]).length > 0) {
        return false;
      }
    }

    return true;
  }

  addRequirements(requirements) {
    // Updates this RequirementSet to include the permissions required by `requirements`, which
    // is a decoded Cap'n Proto List(MembraneRequirement).

    if (!requirements) return;
    requirements.forEach((requirement) => {
      if (requirement.permissionsHeld) {
        const grainId = requirement.permissionsHeld.grainId;
        const identityId = requirement.permissionsHeld.identityId;
        const permissions = new PermissionSet(requirement.permissionsHeld.permissions);
        this._ensureEntryExists(grainId, identityId);
        this.identityPermissions[grainId][identityId].add(permissions);
      } else {
        throw new Error("unsupported requirement: " + JSON.toString(requirement));
      }
    });
  }

  _ensureEntryExists(grainId, identityId) {
    check(grainId, String);
    check(identityId, String);

    if (!this.identityPermissions[grainId]) {
      this.identityPermissions[grainId] = {};
    }

    if (!this.identityPermissions[grainId][identityId]) {
      this.identityPermissions[grainId][identityId] = new PermissionSet([]);
    }
  }

  getGrainIds() {
    return Object.keys(this.identityPermissions);
  }

  pop() {
    // Chooses one (grainId, identityId) pair in this RequirementSet, removes it, and returns the
    // corresponding PermissionSet.

    if (this.isEmpty()) {
      throw new Error("pop() called on empty RequirementSet");
    }

    const grainId = Object.keys(this.identityPermissions)[0];
    const identityId = Object.keys(this.identityPermissions[grainId])[0];

    const permissions = this.identityPermissions[grainId][identityId];

    delete this.identityPermissions[grainId][identityId];
    if (Object.keys(this.identityPermissions[grainId]).length == 0) {
      delete this.identityPermissions[grainId];
    }

    return { grainId: grainId, identityId: identityId, permissionSet: permissions, };
  }
}

const permissionIdPattern = Match.OneOf({ canAccess: null }, { appDefined: Match.Integer });
// As we compute a flow of permissions, we need to be able to explicitly refer to not only
// the permissions enumerated in a grain's `ViewInfo`, but also the usually-implicit "can
// access the grain at all" permission. A permission ID, defined here, allows us to refer
// to either of these types of permissions.

function forEachPermission(permissions, f) {
  check(permissions, [Boolean]);
  f({ canAccess: null });
  for (let ii = 0; ii < permissions.length; ++ii) {
    if (permissions[ii]) {
      f({ appDefined: ii });
    }
  }
}

// A vertex is a principal in the sharing graph. A "vertex ID" is either "i:" + an identity ID,
// or "t:" + a token ID. In some limited contexts, "o:Owner" is also allowed, signifying the
// *account* of the grain owner, from which all permissions flow.

function vertexIdOfTokenOwner(token) {
  let result = "t:" + token._id;
  if (token.owner && token.owner.user) {
    result = "i:" + token.owner.user.identityId;
  }

  return result;
}

class Variable {
  // Our permissions computation can be framed as a propositional HORNSAT problem; this `Variable`
  // class represents a variable in that sense. There is a variable for every (grain ID, vertex ID,
  // permission ID) triple. In any given computation, we only explicitly construct those
  // variables that know might actually be relevant to the result.
  //
  // The value of a variable represents an answer to the question "does this vertex in the sharing
  // graph receive this permission at this grain?" We start out by setting all variables to `false`,
  // and we only set a variable to `true` when an edge in the sharing graph forces us to. If
  // this forward-chaining eventually forces us to set our end goal variables to `true`, then the
  // HORNSAT problem is unsatisfiable and we have proved what we wanted. Otherwise, the HORNSAT
  // problem is satisfiable, i.e. there is a consistent way to set values to variables in which
  // our goal nodes do *not* receive the permissions we wanted them to.

  constructor() {
    this.value = false;

    this.directTailList = [];
    // List of token IDs for outgoing edges that need to be looked at once this variable gets set
    // to `true`.

    this.requirementsTailList = [];
    // List of token IDs for tokens that have requirements that get fulfilled once this variable
    // gets set to `true`.
  }
}

class ActiveToken {
  // An "active token" is one that we allow to propagate permissions because we've decided
  // that it might be relevant to our current computation. This class tracks which permissions
  // the token carries, which of those permissions we've actually proved to arrive at the source
  // end of the token, and how many of the token's requirements are still unmet.

  constructor(numUnmetRequirements, permissions) {
    check(numUnmetRequirements, Match.Integer);
    check(permissions, [Boolean]);

    this.numUnmetRequirements = numUnmetRequirements;

    // The following fields have a "permission status" value, one of:
    // {unmet: null}, {met: null}, or { doesNotCarry: null }.
    this.canAccess = { unmet: null };
    this.appDefined = [];

    for (let ii = 0; ii < permissions.length; ++ii) {
      if (permissions[ii]) {
        this.appDefined.push({ unmet: null });
      } else {
        this.appDefined.push({ doesNotCarry: null });
      }
    }
  }

  requirementsAreMet() {
    return this.numUnmetRequirements <= 0;
  }

  decrementRequirements() {
    this.numUnmetRequirements -= 1;
  }

  directIsMet(permissionId) {
    check(permissionId, permissionIdPattern);
    if ("canAccess" in permissionId) {
      return "met" in this.canAccess;
    } else if ("appDefined" in permissionId) {
      return "met" in this.appDefined[permissionId.appDefined];
    }
  }

  decrementDirect(permissionId) {
    check(permissionId, permissionIdPattern);
    if ("canAccess" in permissionId) {
      this.canAccess = { met: null };
    } else if ("appDefined" in permissionId) {
      this.appDefined[permissionId.appDefined] = { met: null };
    }
  }

  forEachPermission(func) {
    // `func` takes a permission ID and a permission status.

    func({ canAccess: null }, this.canAccess);
    for (let ii = 0; ii < this.appDefined.length; ++ii) {
      func({ appDefined: ii }, this.appDefined[ii]);
    }
  }
}

class Context {
  // An ongoing permissions computation, including cached database state.

  constructor() {
    this.grains = {};            // Map from grain ID to entry in Grains table.
    this.userIdentityIds = {};   // Map from account ID to list of linked identity IDs.
    this.tokensById = {};        // Map from token ID to token.
    this.tokensByRecipient = {}; // Map from grain ID and identity ID to token array.

    this.variables = {};
    // GrainId -> VertexId -> { canAccess: Variable, appDefined: [Variable] }

    this.activeTokens = {};      // TokenId -> ActiveToken

    this.setToTrueStack = [];
    // Variables enqueued to be set to true.
    // Array of { grainId: String, vertexId: String, permissionId: PermissionId,
    //            responsibleTokenId: Optional(String) }

    this.unmetRequirements = new RequirementSet();
    // As we run our forward-chaining algorithm, when we encounter a token with unmet requirements
    // we add those requirements to this set. Then, if we find that our current knowledge base
    // is not large enough to prove our goal, we can expand our search by following these
    // requirements backwards and activating tokens that might help prove that they are met.
    // `unmetRequirements` is allowed to be an overestimate, as might happen if we add
    // some requirements to it and then prove that they hold before we get around to draining it.
  }

  reset() {
    // Resets all state except this.grains and this.userIdentityIds.
    this.tokensById = {};
    this.tokensByRecipient = {};
    this.unmetRequirements = new RequirementSet();
    this.setToTrueStack = [];
    this.variables = {};
    this.activeTokens = {};
  }

  addToken(token) {
    // Retrives a token from the database. Does not activate it.

    check(token, Match.ObjectIncluding({ grainId: String }));

    if (this.tokensById[token._id]) return;

    this.tokensById[token._id] = token;
    if (token.owner && token.owner.user) {
      if (!this.tokensByRecipient[token.grainId]) {
        this.tokensByRecipient[token.grainId] = {};
      }

      if (!this.tokensByRecipient[token.grainId][token.owner.user.identityId]) {
        this.tokensByRecipient[token.grainId][token.owner.user.identityId] = [];
      }

      this.tokensByRecipient[token.grainId][token.owner.user.identityId].push(token);
    }
  }

  addGrains(db, grainIds) {
    // Retrieves grains from the database.

    check(db, SandstormDb);
    check(grainIds, [String]);
    db.collections.grains.find({ _id: { $in: grainIds } }).forEach((grain) => {
      this.grains[grain._id] = grain;
      if (!this.userIdentityIds[grain.userId]) {
        this.userIdentityIds[grain.userId] = SandstormDb.getUserIdentityIds(
          Meteor.users.findOne({ _id: grain.userId }));
      }
    });

    const query = { grainId: { $in: grainIds },
                    revoked: { $ne: true }, objectId: { $exists: false }, };
    db.collections.apiTokens.find(query).forEach((token) => this.addToken(token));
  }

  addTokensFromCursor(cursor) {
    cursor.forEach((token) => this.addToken(token));
  }

  activateOwnerEdges(grainId, edges) {
    check(edges, [{ identityId: String, role: SandstormDb.prototype.roleAssignmentPattern }]);

    edges.forEach((edge) => {
      const viewInfo = this.grains[grainId].cachedViewInfo || {};
      const permissions = PermissionSet.fromRoleAssignment(edge.role, viewInfo);
      const vertexId = "i:" + edge.identityId
      forEachPermission(permissions.array, (permissionId) => {
        this.setToTrueStack.push({ grainId: grainId, vertexId: vertexId,
                                   permissionId: permissionId, });
      });
    });
  }

  activateToken(tokenId) {
    // Includes a new token (which must already be in `this.tokensById`) in our computation. The
    // tricky part here is dealing with our already-accumulated knowledge; we need to compute how
    // many of the token's requirements are currently unmet and whether we need to push anything new
    // onto `setToTrueStack`.

    check(tokenId, String);
    if (tokenId in this.activeTokens) {
      return false;
    }

    const token = this.tokensById[tokenId];
    const grainId = token.grainId;
    const viewInfo = this.grains[grainId].cachedViewInfo || {};
    const tokenPermissions = PermissionSet.fromRoleAssignment(token.roleAssignment, viewInfo);

    const sharerId = token.parentToken ? "t:" + token.parentToken : "i:" + token.identityId;
    const recipientId = vertexIdOfTokenOwner(token);

    let numUnmetRequirements = 0;
    if (token.requirements) {
      token.requirements.forEach((requirement) => {
        if (requirement.permissionsHeld) {
          const reqGrainId = requirement.permissionsHeld.grainId;
          const reqVertexId = "i:" + requirement.permissionsHeld.identityId;
          const reqPermissions = requirement.permissionsHeld.permissions || [];

          forEachPermission(reqPermissions, (permissionId) => {
            const variable = this.getVariable(reqGrainId, reqVertexId, permissionId);
            if (!variable.value) {
              numUnmetRequirements += 1;
              variable.requirementsTailList.push(tokenId);
            }
          });
        }
      });
    }

    const activeToken = new ActiveToken(numUnmetRequirements, tokenPermissions.array);
    let needToExploreUnmet = false;

    activeToken.forEachPermission((permissionId, status) => {
      if (!("doesNotCarry" in status)) {
        const recipientVariable = this.getVariable(grainId, recipientId, permissionId);
        if (!recipientVariable.value) {
          const sharerVariable = this.getVariable(grainId, sharerId, permissionId);
          if (!sharerVariable.value) {
            sharerVariable.directTailList.push(tokenId);
          } else {
            activeToken.decrementDirect(permissionId);
            if (numUnmetRequirements == 0) {
              this.setToTrueStack.push({ grainId: grainId,
                                         vertexId: vertexIdOfTokenOwner(token),
                                         permissionId: permissionId,
                                         responsibleTokenId: tokenId, });
            } else {
              needToExploreUnmet = true;
            }
          }
        }
      }
    });

    if (needToExploreUnmet) {
      this.unmetRequirements.addRequirements(token.requirements);
    }

    this.activeTokens[tokenId] = activeToken;

    return true;
  }

  _ensureVariableExists(grainId, vertexId, permissionId) {
    if (!this.variables[grainId]) {
      this.variables[grainId] = {};
    }

    if (!this.variables[grainId][vertexId]) {
      this.variables[grainId][vertexId] = { canAccess: new Variable(),
                                            appDefined: [], };
    }

    const variables = this.variables[grainId][vertexId];

    if ("appDefined" in permissionId) {
      while (permissionId.appDefined >= variables.appDefined.length) {
        variables.appDefined.push(new Variable());
      }
    }
  }

  getVariable(grainId, vertexId, permissionId) {
    check(grainId, String);
    check(vertexId, String);
    check(permissionId, permissionIdPattern);

    this._ensureVariableExists(grainId, vertexId, permissionId);

    const nodeVariables = this.variables[grainId][vertexId];
    if ("canAccess" in permissionId) {
      return nodeVariables.canAccess;
    } else if ("appDefined" in permissionId) {
      return nodeVariables.appDefined[permissionId.appDefined];
    } else {
      throw new Meteor.Error(500, "unknown permissionId: " + JSON.stringify(permissionId));
    }
  }

  getPermissions(grainId, vertexId) {
    // Looks up the permissions that have already been proven for the `vertexId` on `grainId`.

    check(grainId, String);
    check(vertexId, String);

    this._ensureVariableExists(grainId, vertexId, { canAccess: null });

    const nodeVariables = this.variables[grainId][vertexId];
    if (!nodeVariables.canAccess.value) {
      return null;
    } else {
      return new PermissionSet(nodeVariables.appDefined.map((variable) => variable.value));
    }
  }

  runForwardChaining(grainId, vertexId, permissionSet) {
    // TODO(perf): Exit early if we've already proven that permissionSet is fulfilled.

    check(grainId, String);
    check(vertexId, String);
    check(permissionSet, PermissionSet);

    if (permissionSet.array.length > 0) {
      // Make sure that the result of this call, retrieved through `this.getPermissions()`,
      // will have a full array of permissions, even if they aren't all set to `true`.
      this._ensureVariableExists(grainId, vertexId, { appDefined: permissionSet.array.length - 1 });
    }

    while (this.setToTrueStack.length > 0) {
      const current = this.setToTrueStack.pop();
      const variable = this.getVariable(current.grainId, current.vertexId, current.permissionId);
      if (variable.value) {
        continue;
      }

      variable.value = true;
      variable.responsibleTokenId = current.responsibleTokenId;
      variable.directTailList.forEach((tokenId) => {
        const activeToken = this.activeTokens[tokenId];
        activeToken.decrementDirect(current.permissionId);
        // We know this permission must be met now.

        const token = this.tokensById[tokenId];
        if (activeToken.requirementsAreMet()) {
          // We've triggered a new edge! Push it onto the queue.
          this.setToTrueStack.push({ grainId: token.grainId,
                                     vertexId: vertexIdOfTokenOwner(token),
                                     permissionId: current.permissionId,
                                     responsibleTokenId: tokenId, });
        } else {
          this.unmetRequirements.addRequirements(token.requirements);
        }
      });

      variable.requirementsTailList.forEach((tokenId) => {
        const token = this.tokensById[tokenId];
        const activeToken = this.activeTokens[tokenId];
        activeToken.decrementRequirements(current.permissionId);
        if (activeToken.requirementsAreMet()) {
          activeToken.forEachPermission((permissionId, status) => {
            if ("met" in status) {
              // We've triggered a new edge! Push it onto the queue.
              this.setToTrueStack.push({ grainId: token.grainId,
                                        vertexId: vertexIdOfTokenOwner(token),
                                        permissionId: permissionId,
                                        responsibleTokenId: tokenId, });
            }
          });
        }
      });
    }

    return this.getPermissions(grainId, vertexId);
  }

  activateRelevantTokens(grainId, vertexId) {
    // Returns true if more computation might yield more progress.

    check(grainId, String);
    check(vertexId, String);

    let result = false;
    const relevant = computeRelevantTokens(this, grainId, vertexId);
    this.activateOwnerEdges(grainId, relevant.ownerEdges);
    relevant.tokenIds.forEach((tokenId) => {
      if (this.activateToken(tokenId)) {
        result = true;
      }
    });

    return result;
  }

  processUnmetRequirements(db) {
    // Returns true if more computation might yield more progress.

    const grainIds = this.unmetRequirements.getGrainIds()
          .filter((grainId) => !(grainId in this.grains));

    if (db) {
      this.addGrains(db, grainIds);
    }

    let result = false;

    while (!this.unmetRequirements.isEmpty()) {
      const next = this.unmetRequirements.pop();
      if (this.activateRelevantTokens(next.grainId, "i:" + next.identityId)) {
        result = true;
      }
    }

    return result;
  }

  tryToProve(grainId, vertexId, permissionSet, db) {
    // Tries to prove that `vertexId` has the given permissions on the given grain. Returns a
    // `PermissionSet` representing the permissions proven, or null if it has not been proved
    // yet that the vertex even has access to the grain.

    check(grainId, String);
    check(vertexId, String);
    check(permissionSet, PermissionSet);
    check(db, Match.OneOf(undefined, SandstormDb));
    // If `db` is not provided, then this function will make no database queries.

    if (db) {
      this.addGrains(db, [grainId]);
    }

    this.activateRelevantTokens(grainId, vertexId, permissionSet);
    while (true) {
      const result = this.runForwardChaining(grainId, vertexId, permissionSet);
      if (result && permissionSet.isSubsetOf(result)) {
        return result;
      }

      if (!this.processUnmetRequirements(db)) {
        return result;
      }
    }
  }

  getResponsibleTokens(grainId, vertexId) {
    // For the permissions that we've already proven must be held by `vertexId`, transitively finds
    // the tokens that we have used in that proof, including tokens responsible for fulfilling
    // membrane requirements.
    //
    // Whenever we prove a fact, we keep track of the immediately responsible token for that fact,
    // This function works by walking backwards in the sharing graph, following this trail of
    // "responsible tokens".
    //
    // Returns the result as a list of token IDs.

    check(grainId, String);
    check(vertexId, String);

    const stack = []; // [{ grainId: String, vertexId: String, permissionId: PermissionId }]
    const visited = {}; // grainId -> vertexId -> { canAccess: bool, appDefined: [bool] }

    function pushVertex(grainId, vertexId, permissionId) {
      if (!visited[grainId]) {
        visited[grainId] = {};
      }

      if (!visited[grainId][vertexId]) {
        visited[grainId][vertexId] = { canAccess: false, appDefined: [], };
      }

      const vertex = visited[grainId][vertexId];
      if ("canAccess" in permissionId) {
        if (!vertex.canAccess) {
          vertex.canAccess = true;
          stack.push({ grainId: grainId, vertexId: vertexId, permissionId: permissionId });
        }
      } else if ("appDefined" in permissionId) {
        while (permissionId.appDefined >= vertex.appDefined.length) {
          vertex.appDefined.push(false);
        }

        if (!vertex.appDefined[permissionId.appDefined]) {
          vertex.appDefined[permissionId.appDefined] = true;
          stack.push({ grainId: grainId, vertexId: vertexId, permissionId: permissionId });
        }
      } else {
        throw new Error("Unsupported permission ID: " + JSON.stringify(permissionId));
      }
    }

    const neededTokens = {}; // TokenId -> bool

    forEachPermission(this.getPermissions(grainId, vertexId).array, (permissionId) => {
      stack.push({ grainId: grainId, vertexId: vertexId, permissionId: permissionId });
    });

    while (stack.length > 0) {
      const current = stack.pop();
      const variable = this.getVariable(current.grainId, current.vertexId, current.permissionId);
      const tokenId = variable.responsibleTokenId;
      if (tokenId) {
        const token = this.tokensById[tokenId];

        let sharerId = (token.parentToken && "t:" + token.parentToken) || ("i:" + token.identityId);
        pushVertex(token.grainId, sharerId, current.permissionId);

        if (!neededTokens[tokenId]) {
          neededTokens[tokenId] = true;
          if (token.requirements) {
            token.requirements.forEach((requirement) => {
              if (requirement.permissionsHeld) {
                const reqVertexId = "i:" + requirement.permissionsHeld.identityId;
                forEachPermission(requirement.permissionsHeld.permissions, (permissionId) => {
                  pushVertex(requirement.permissionsHeld.grainId, reqVertexId, permissionId);
                });
              }
            });
          }
        }
      }
    }

    return Object.keys(neededTokens);
  }
}

function computeRelevantTokens(context, grainId, vertexId) {
  // Finds all tokens in `context` that could possibly carry permissions of the grain `grainId` to
  // the vertex `vertexId` -- that is, all tokens that are contained in a non-self-intersecting path
  // starting at the grain owner and ending at `vertexId`. Ignores any requirements that those
  // tokens might be conditional upon.
  //
  // Returns an object with two fields:
  //    tokenIds: list of relevant token IDs.
  //    ownerEdges: objects of the form { identityId: String, role: RoleAssignment }, representing
  //                initial pseudo-edges in the graph. `identityId` is typically an identity of
  //                the grain's owning user, but for the case of a legacy public grain it could
  //                be any identity.
  //
  // Works by traversing the sharing graph twice: first backwards starting from `vertexId`, then
  // forwards starting from the grain owner using only those tokens touched in the first step.
  //
  // `context` contains all the information from the database which is available for now. This call
  // will not make any new database lookups; edges not listed in `context` will not be considered
  // (as if they'd been revoked).

  check(context, Context);
  check(grainId, String);
  check(vertexId, String);

  const grain = context.grains[grainId];
  const viewInfo = grain.cachedViewInfo || {};
  const ownerIdentityIds = context.userIdentityIds[grain.userId];

  const vertexStack = []; // Vertex IDs that we need to explore.
  const visitedVertexIds = {}; // Set of vertex IDs that we have already enqueued to get explored.

  visitedVertexIds[vertexId] = true;
  vertexStack.push(vertexId);

  const visitedTokensBySharerId = {};
  const ownerEdges = [];

  // Repeatedly pop a vertex from the stack, find all its incoming edges (i.e. all other vertexes
  // that share permissions to this vertex), and push those vertexes onto the stack.
  while (vertexStack.length > 0) {
    const vertexId = vertexStack.pop();

    let incomingEdges = [];
    // List of edges in the sharing graph ending at this vertex. Each is an object with the fields:
    //     sharerId: The vertex ID of the edge's source.
    //     token: the token object backing this edge, if there is one.

    function tokenToEdge(token) {
      // Convert an ApiToken into an edge.
      return {
        token: token,
        sharerId: token.parentToken ? "t:" + token.parentToken : "i:" + token.identityId,
      };
    }

    if (vertexId.slice(0, 2) === "o:") {
      // Owner. We don't need to do anything.
      incomingEdges = [];
    } else if (vertexId.slice(0, 2) === "t:") {
      // A webkey token. Extract it from the context (or ignore if it isn't present).
      const token = context.tokensById[vertexId.slice(2)];
      if (token) {
        incomingEdges = [tokenToEdge(token)];
      }
    } else if (vertexId.slice(0, 2) === "i:") {
      // An identity.
      const identityId = vertexId.slice(2);
      if (ownerIdentityIds.indexOf(identityId) >= 0) {
        // This is one of the owner's identities.
        incomingEdges = [{ sharerId: "o:Owner" }];
        ownerEdges.push({ identityId: identityId, role: { allAccess: null } });
      } else if (!grain.private) {
        // This is a legacy "public" grain, meaning that any user who knows the grain ID receives
        // the grain's default role. If the user doesn't know the grain ID then they are unable
        // to express a request to open the grain in the first place and we'll never get to the
        // point of this permissions computation, so for this purpose we can assume all users
        // have the default role. (Similarly, a user who doesn't know the grain ID couldn't
        // possibly be the subject of any MembraneRequirements against the grain because they
        // have never interacted with the grain and so couldn't have caused such
        // MembraneRequiments to come about. Note that this is kind of shaky non-local reasoning,
        // but literally no such legacy grain has been created since early 2015 and none will ever
        // be created again, so it's not a huge deal.)
        incomingEdges = [{ sharerId: "o:Owner" }];
        ownerEdges.push({ identityId: identityId, role: { none: null } });
      } else {
        // Not a special case. Gather all tokens where this user is the recipient.
        incomingEdges = ((context.tokensByRecipient[grainId] || {})[vertexId.slice(2)] || [])
          .map(tokenToEdge);
      }
    } else {
      throw new Meteor.Error(500, "Unrecognized vertex ID: " + vertexId);
    }

    // For each edge incoming to this vertex, backpropagate this vertex's PermissionFlow to the
    // source vertex, joining it with the edge's constraints.
    incomingEdges.forEach((edge) => {
      const sharerId = edge.sharerId;
      if (edge.token) {
        if (!visitedTokensBySharerId[sharerId]) {
          visitedTokensBySharerId[sharerId] = {};
        }

        visitedTokensBySharerId[sharerId][edge.token._id] = edge.token;
      }

      if (!visitedVertexIds[sharerId]) {
        // Never saw this vertex before.
        visitedVertexIds[sharerId] = true;
        vertexStack.push(sharerId);
      }

    });
  }

  // Now walk forward from the owner.
  const relevantTokens = {};
  const visitedSharers = {};

  const sharerStack = [];
  ownerIdentityIds.forEach((identityId) => { sharerStack.push("i:" + identityId); });
  while (sharerStack.length > 0) {
    const sharerId = sharerStack.pop();
    for (const tokenId in visitedTokensBySharerId[sharerId]) {
      relevantTokens[tokenId] = true;
      const token = visitedTokensBySharerId[sharerId][tokenId];
      const recipientId = vertexIdOfTokenOwner(token);

      if (!visitedSharers[recipientId]) {
        visitedSharers[recipientId] = true;
        sharerStack.push(recipientId);
      }
    }
  }

  return {
    tokenIds: Object.keys(relevantTokens),
    ownerEdges: ownerEdges,
  };
}

const vertexPattern = Match.OneOf({ token: Match.ObjectIncluding({ _id: String, grainId: String }) },
                                  { grain: Match.ObjectIncluding(
                                    { _id: String,
                                     identityId: Match.OneOf(String, null, undefined), }), });
// A vertex in the sharing graph is a principal, e.g. a user (identity) or a token. Complicating
// matters, we may have to traverse sharing graphs for multiple grains in the same computation. A
// token is specific to one grain, but a user of course can have access to multiple grains, so in
// the case of a user we represent the vertex as a (user, grain) pair.
//
// TODO(cleanup): Perhaps `grain` should be renamed to `user` or `identity`? In the common case
//   where only a single grain's shares need to be considered, it feels weird to think of the
//   grain ID as being the primary distinguishing feature of the vertex.

SandstormPermissions.mayOpenGrain = function (db, vertex) {
  // Determines whether the vertex is allowed to open the grain. May make multiple database
  // queries.

  check(vertex, vertexPattern);
  const grainId = vertex.token ? vertex.token.grainId : vertex.grain._id;
  const vertexId = vertex.token ? ("t:" + vertex.token._id) : "i:" + vertex.grain.identityId;
  const context = new Context();
  const emptyPermissions = new PermissionSet([]);
  return !!context.tryToProve(grainId, vertexId, emptyPermissions, db);
};

SandstormPermissions.grainPermissions = function (db, vertex, viewInfo, onInvalidated) {
  // Computes the set of permissions received by `vertex`. Returns an object with a
  // `permissions` field containing the computed permissions. If the field is null then
  // the `vertex` does not even have the base "allowed to access at all" permission.
  //
  // `onInvalidated` is an optional callback. If provided, it will be called when the result
  // has been invalidated. If `onValidated` is provided, the result of `grainPermissions` will
  // have a `observeHandle` field, containing an object with a `stop()` method that must be
  // called once the computation becomes so longer relevant.

  check(db, SandstormDb);
  check(vertex, vertexPattern);
  const grainId = vertex.token ? vertex.token.grainId : vertex.grain._id;
  const vertexId = vertex.token ? ("t:" + vertex.token._id) : "i:" + vertex.grain.identityId;

  let resultPermissions;
  let observeHandle;
  let onInvalidatedActive = false;

  const startTime = new Date();
  function measureElapsedTime(result) {
    const elapsedMilliseconds = (new Date()) - startTime;
    if (elapsedMilliseconds > 200) {
      console.log("Warning: SandstormPermissions.grainPermissions() took " + elapsedMilliseconds +
                  " milliseconds to complete for the vertex " + JSON.stringify(vertex));
    }
  }

  // Our computation proceeds in two phases. In the first, we determine which permissions the vertex
  // appears to have and we compute set of tokens which appears to be sufficent to prove those
  // permissions. However, concurrent database modifications may render the computation invalid, so
  // in the second phases we verify that our proof is still valid and arrange for onInvalidated
  // to be called when necessary. This is an optimisistic approach to concurrency. If the
  // verification phase fails, we try again before giving up entirely.
  for (let attemptCount = 0; attemptCount < 3; ++attemptCount) {
    if (observeHandle) {
      observeHandle.stop();
      observeHandle = null;
    }

    const context = new Context();
    const allPermissions = PermissionSet.fromRoleAssignment({ allAccess: null }, viewInfo);
    const firstPhasePermissions = context.tryToProve(grainId, vertexId, allPermissions, db);

    if (!firstPhasePermissions) return { permissions: null };

    const neededTokens = context.getResponsibleTokens(grainId, vertexId);

    // Phase 2: Now let's verify those permissions.

    let invalidated = false;
    function guardedOnInvalidated() {
      invalidated = true;
      if (onInvalidatedActive) {
        onInvalidated();
      }
    }

    const cursor = db.collections.apiTokens.find({
      _id: { $in: neededTokens },
      revoked: { $ne: true },
      objectId: { $exists: false },
    });

    if (onInvalidated) {
      observeHandle = cursor.observe({
        changed(newApiToken, oldApiToken) {
          if (!_.isEqual(newApiToken.roleAssignment, oldApiToken.roleAssignment) ||
              !_.isEqual(newApiToken.revoked, oldApiToken.revoked)) {
            observeHandle.stop();
            guardedOnInvalidated();
          }
        },

        removed(oldApiToken) {
          observeHandle.stop();
          guardedOnInvalidated();
        },
      });
    }

    context.reset();
    context.addTokensFromCursor(cursor);

    // TODO(someday): Also account for possible concurrent linking/unlinking of identities,
    //   and legacy publis grains becoming private.

    resultPermissions = context.tryToProve(grainId, vertexId, firstPhasePermissions);

    if (resultPermissions && firstPhasePermissions.isSubsetOf(resultPermissions)) {
      // We've confirmed the permissions that we found the in the first phase. Done!
      break;
    }
  } // for (let attemptCount ...) {

  onInvalidatedActive = true;
  const result = {};
  if (resultPermissions) result.permissions = resultPermissions.array;
  if (observeHandle) result.observeHandle = observeHandle;
  measureElapsedTime();
  return result;
};

SandstormPermissions.downstreamTokens = function (db, root) {
  // Computes a list of the UiView tokens that are downstream in the sharing graph from a given
  // source. The source, `root`, can either be a token or a (grain, user) pair. The exact format
  // of `root` is specified in the `check()` invocation below.
  //
  // TODO(someday): Account for membrane requirements in this computation.

  check(root, Match.OneOf({ token: Match.ObjectIncluding({ _id: String, grainId: String }) },
                          { grain: Match.ObjectIncluding({ _id: String, identityId: String }) }));

  const result = [];
  const tokenStack = [];
  const stackedTokens = {};
  const tokensBySharer = {};
  const tokensByParent = {};
  const tokensById = {};

  function addChildren(tokenId) {
    const children = tokensByParent[tokenId];
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
    const sharedTokens = tokensBySharer[sharer];
    if (sharedTokens) {
      sharedTokens.forEach(function (sharedToken) {
        if (!stackedTokens[sharedToken._id]) {
          tokenStack.push(sharedToken);
          stackedTokens[sharedToken._id] = true;
        }
      });
    }
  }

  const grainId = root.token ? root.token.grainId : root.grain._id;
  const grain = db.getGrain(grainId);
  if (!grain || !grain.private) { return result; }

  db.collections.apiTokens.find({ grainId: grainId,
                                 revoked: { $ne: true }, }).forEach(function (token) {
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
    const token = tokenStack.pop();
    result.push(token);
    addChildren(token._id);
    if (token.owner && token.owner.user) {
      addSharedTokens(token.owner.user.identityId);
    }
  }

  return result;
};

const HeaderSafeString = Match.Where(function (str) {
  check(str, String);
  return str.match(/^[\x20-\x7E]*$/);
});

const DavClass = Match.Where(function (str) {
  check(str, String);
  return str.match(/^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/) ||
         str.match(/^<[\x21-\x7E]*>$/);  // supposed to be a URL
});

const ResourceMap = Match.Where(function (map) {
  for (path in map) {
    if (!path.match(/^\/[\x21-\x7E]*$/)) {
      return false;
    }

    check(map[path], {
      type: HeaderSafeString,
      language: Match.Optional(HeaderSafeString),
      encoding: Match.Optional(HeaderSafeString),
      body: String,
    });
  }

  return true;
});

const LocalizedString = {
  defaultText: String,
  localizations: Match.Optional([
     { locale: String, text: String },
  ]),
};

SandstormPermissions.createNewApiToken = function (db, provider, grainId, petname,
                                                   roleAssignment, owner, unauthenticated) {
  // Creates a new UiView API token. If `rawParentToken` is set, creates a child token.
  check(grainId, String);
  check(petname, String);
  check(roleAssignment, db.roleAssignmentPattern);
  // Meteor bug #3877: we get null here instead of undefined when we
  // explicitly pass in undefined.
  check(provider, Match.OneOf({ identityId: String, accountId: String },
                              { rawParentToken: String }));
  check(owner, Match.OneOf({ webkey: { forSharing: Boolean,
                                     expiresIfUnusedDuration: Match.Optional(Number), }, },
                           { user: { identityId: String,
                                   title: String, }, },
                           { grain: { grainId: String,
                                      saveLabel: LocalizedString,
                                      introducerIdentity: String, }, },
                           { frontend: null }));
  check(unauthenticated, Match.OneOf(undefined, null, {
    options: Match.Optional({ dav: [Match.Optional(DavClass)] }),
    resources: Match.Optional(ResourceMap),
  }));

  if (unauthenticated && JSON.stringify(unauthenticated).length > 4096) {
    throw new Meteor.Error(400, "Unauthenticated params too large; limit 4kb.");
  }

  const grain = db.getGrain(grainId);
  if (!grain) {
    throw new Meteor.Error(403, "Unauthorized", "No grain found.");
  }

  const token = Random.secret();
  const apiToken = {
    _id: Crypto.createHash("sha256").update(token).digest("base64"),
    grainId: grainId,
    roleAssignment: roleAssignment,
    petname: petname,
    created: new Date(),
    expires: null,
  };

  const result = {};
  let parentForSharing = false;
  if (provider.rawParentToken) {
    const parentToken = Crypto.createHash("sha256").update(provider.rawParentToken).digest("base64");
    const parentApiToken = db.collections.apiTokens.findOne(
      { _id: parentToken, grainId: grainId, objectId: { $exists: false } });
    if (!parentApiToken) {
      throw new Meteor.Error(403, "No such parent token found.");
    }

    if (parentApiToken.forSharing) {
      parentForSharing = true;
    }

    apiToken.identityId = parentApiToken.identityId;
    apiToken.accountId = parentApiToken.accountId;

    apiToken.parentToken = parentToken;
    result.parentApiToken = parentApiToken;
  } else if (provider.identityId) {
    apiToken.identityId = provider.identityId;
    apiToken.accountId = provider.accountId;
  }

  if (owner.webkey) {
    // Non-null webkey is a special case not covered in ApiTokenOwner.
    // TODO(cleanup): Maybe ApiTokenOwner.webkey should be extended with these fields?
    apiToken.owner = { webkey: null };
    apiToken.forSharing = parentForSharing || owner.webkey.forSharing;
    if (owner.webkey.expiresIfUnusedDuration) {
      apiToken.expiresIfUnused = new Date(Date.now() + owner.webkey.expiresIfUnusedDuration);
    }
  } else if (owner.user) {
    const grainInfo = db.getDenormalizedGrainInfo(grainId);
    apiToken.owner = {
      user: {
        identityId: owner.user.identityId,
        title: owner.user.title,
        // lastUsed: ??
        denormalizedGrainMetadata: grainInfo,
      },
    };
  } else {
    // Note: Also covers the case of `webkey: null`.
    apiToken.owner = owner;
  }

  if (unauthenticated) {
    const apiHost = {
      _id: db.apiHostIdHashForToken(token),
      hash2: Crypto.createHash("sha256").update(apiToken._id).digest("base64"),
    };
    if (unauthenticated.options) {
      apiHost.options = unauthenticated.options;
    }

    if (unauthenticated.resources) {
      // Mongo requires keys in objects to be escaped. Ugh.
      apiHost.resources = {};
      for (const key in unauthenticated.resources) {
        apiHost.resources[SandstormDb.escapeMongoKey(key)] = unauthenticated.resources[key];
      }
    }

    db.collections.apiHosts.insert(apiHost);
    apiToken.hasApiHost = true;
  }

  db.collections.apiTokens.insert(apiToken);

  result.id = apiToken._id;
  result.token = token;
  return result;
};

// Make self-destructing tokens actually self-destruct, so they don't
// clutter the token list view.
SandstormPermissions.cleanupSelfDestructing = function (db) {
  return function () {
    const now = new Date();
    db.removeApiTokens({ expiresIfUnused: { $lt: now } });
  };
};

Meteor.methods({
  transitiveShares: function (identityId, grainId) {
    check(identityId, String);
    check(grainId, String);
    if (this.userId) {
      const db = this.connection.sandstormDb;
      return SandstormPermissions.downstreamTokens(db,
          { grain: { _id: grainId, identityId: identityId } });
    }
  },

  newApiToken: function (provider, grainId, petname, roleAssignment, owner, unauthenticated) {
    check(provider, Match.OneOf({ identityId: String }, { rawParentToken: String }));
    // other check()s happen in SandstormPermissions.createNewApiToken().
    const db = this.connection.sandstormDb;
    if (provider.identityId) {
      if (!this.userId || !db.userHasIdentity(this.userId, provider.identityId)) {
        throw new Meteor.Error(403, "Not an identity of the current user: " + provider.identityId);
      }
    }

    if (provider.identityId) {
      provider.accountId = this.userId;
    }

    return SandstormPermissions.createNewApiToken(
      this.connection.sandstormDb, provider, grainId, petname, roleAssignment, owner,
      unauthenticated);
  },

  updateApiToken: function (token, newFields) {
    const db = this.connection.sandstormDb;

    check(token, String);
    check(newFields, { petname: Match.Optional(String),
                      roleAssignment: Match.Optional(db.roleAssignmentPattern),
                      revoked: Match.Optional(Boolean), });

    if (!this.userId) {
      throw new Meteor.Error(403, "Must be logged in to modify a token");
    }

    const apiToken = db.collections.apiTokens.findOne(token);
    if (!apiToken) {
      throw new Meteor.Error(404, "No such token found.");
    }

    if (db.userHasIdentity(this.userId, apiToken.identityId)) {
      const modifier = { $set: newFields };
      db.collections.apiTokens.update(token, modifier);
    } else {
      throw new Meteor.Error(403, "User not authorized to modify this token.");
    }
  },
});
