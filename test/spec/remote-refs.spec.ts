require("source-map-support").install();

import { assert } from "chai";
import { afterEach, before, describe, it } from "mocha";
import { GetProperty, Identifier, Apply } from "../../lib/interpreter/base";
import { ECMAScriptInterpreters } from "../../lib/interpreters";
import { evalAsPromise, MetaesContext, evalFnBodyAsPromise } from "../../lib/metaes";
import * as NodeTypes from "../../lib/nodeTypes";
import { environmentToMessage } from "../../lib/remote";
import { GetValue } from "../../lib/environment";

describe.only("References acquisition", () => {
  let context,
    _globalEnv,
    _eval,
    _encounteredReferences = new Set(),
    _finalReferences = new Set(),
    _closeParentOf = new Map<object, object>(),
    _ids = new Map(),
    _finalSource,
    _finalValues;

  afterEach(() => {
    _finalReferences.clear();
    _encounteredReferences.clear();
    _closeParentOf.clear();
    _ids.clear();
  });
  before(() => {
    function belongsToRootEnv(value: any) {
      for (let k in _globalEnv.values) {
        if (_globalEnv.values[k] === value) {
          return true;
        }
      }
      return false;
    }
    function belongsToRootHeap(value) {
      while ((value = _closeParentOf.get(value))) {
        if (value === _globalEnv.values) {
          return true;
        }
      }
      return false;
    }

    const interpreters = {
      values: {
        Apply(e, c, cerr, env, config) {
          const { thisValue } = e;
          if ((thisValue && Array.isArray(thisValue) && belongsToRootEnv(thisValue)) || belongsToRootHeap(thisValue)) {
            Apply(
              e,
              elements => {
                if (elements && Array.isArray(elements)) {
                  elements
                    .filter(element => typeof element === "object" || typeof element === "function")
                    .forEach(element => {
                      if (thisValue.includes(element)) {
                        _encounteredReferences.add(element);
                        _closeParentOf.set(element, thisValue);
                      }

                      for (let i in element) {
                        if (typeof element[i] === "object") {
                          _encounteredReferences.add(element[i]);
                          _closeParentOf.set(element[i], thisValue);
                        }
                      }
                    });
                }
                c(elements);
              },
              cerr,
              env,
              config
            );
          } else {
            Apply.apply(null, arguments);
          }
        },
        GetValue({ name }, _c, _cerr, env) {
          const obj = env.values;
          if (
            belongsToRootEnv(obj) ||
            ((belongsToRootHeap(obj) && typeof obj[name] === "object") || typeof obj[name] === "function")
          ) {
            _closeParentOf.set(obj[name], obj);
          }
          GetValue.apply(null, arguments);
        },
        GetProperty(e: NodeTypes.GetProperty, c, cerr, env, config) {
          const { object } = e;
          _encounteredReferences.add(object);
          GetProperty(
            e,
            value => {
              if (typeof value === "object" || typeof value === "function") {
                _encounteredReferences.add(value);
                _closeParentOf.set(value, object);
              }
              c(value);
            },
            cerr,
            env,
            config
          );
        },
        Identifier(e, c, cerr, env, config) {
          Identifier(
            e,
            value => {
              if (typeof value === "object" || typeof value === "function") {
                _encounteredReferences.add(value);
                if (belongsToRootEnv(value)) {
                  _closeParentOf.set(value, _globalEnv.values);
                }
              }
              c(value);
            },
            cerr,
            env,
            config
          );
        }
      },
      prev: ECMAScriptInterpreters
    };

    _eval = async (script, env = { values: {} }) => {
      try {
        console.log("[_eval]:", script);
        const result =
          typeof script === "function"
            ? await evalFnBodyAsPromise({ context, source: script }, env)
            : await evalAsPromise(context, script, env);

        let counter = 0;

        function sourceify(rootValue, isVariable = false) {
          function _toSource(value: any, tabs: string, depth: number) {
            let type = typeof value;
            switch (type) {
              case "string":
                return `"${value}"`;
              case "boolean":
              case "number":
              case "undefined":
                return "" + value;
              case "function":
              case "object":
                if (value === null) {
                  return "null";
                }
                const isTop = isVariable && depth === 0 && value === rootValue;
                if (!isTop && _encounteredReferences.has(value) && belongsToRootHeap(value)) {
                  _finalReferences.add(value);
                  let id = _ids.get(value);
                  if (!id) {
                    id = "ref" + counter++;
                    _ids.set(value, id);
                  }
                  return id;
                } else if (Array.isArray(value)) {
                  return "[" + value.map(v => _toSource(v, tabs, depth + 1)).join(", ") + "]";
                } else if (typeof value === "function" && !_encounteredReferences.has(value)) {
                  return null;
                } else {
                  return (
                    "{\n" +
                    tabs +
                    "  " +
                    Object.getOwnPropertyNames(value)
                      .map(k => {
                        const source = _toSource(value[k], tabs + "  ", depth + 1);
                        return source ? k + ": " + source : null;
                      })
                      .filter(x => !!x)
                      .join(",\n" + tabs + "  ") +
                    `\n${tabs}}`
                  );
                }
              default:
                throw new Error(`Can't stringify value of type '${typeof value}'.`);
            }
          }
          return _toSource(rootValue, "", 0);
        }

        function sourceify2(value) {
          function replacer(key, value) {}
        }
        const source = sourceify(result);
        const variables = [..._finalReferences]
          .reverse()
          .map(ref => `${_ids.get(ref)}=${sourceify(ref, true)};`)
          .join("\n");
        _finalSource = variables + "\n" + `(${source});`;

        _finalValues = [..._ids.entries()].reduce((result, [k, v]) => {
          result[v] = k;
          return result;
        }, {});
        return result;
      } catch (e) {
        throw e.value || e;
      }
    };
    const me = {
      firstName: "User1",
      lastName: "Surname1",
      location: {
        country: "PL",
        address: {
          street: "Street 1",
          city: "City 1"
        }
      },
      setOnlineStatus(_flag) {},
      logout() {}
    };
    const otherUser = {
      firstName: "Other-firstName",
      lastName: "Other-lastName"
    };
    const comment1 = {
      author: me,
      title: "Comment1"
    };
    const comment2 = {
      author: otherUser,
      title: "Comment2"
    };
    const comment3 = {
      author: otherUser,
      title: "Comment3"
    };
    const val = {};
    _globalEnv = {
      values: {
        repeated: [val, val],
        me,
        posts: Array.from({ length: 20 }).map((_, i) => ({
          title: "Post" + i,
          body: "Body of post" + i,
          comments: [comment1, comment2, comment3],
          likedBy: [me]
        }))
      }
    };
    context = new MetaesContext(undefined, console.error, _globalEnv, {
      interpreters
    });
  });

  it.only("should send stringified non root heap object", async () => {
    console.log(
      "result",
      await _eval(function() {
        const { firstName, lastName, location } = me;
        ({
          firstName,
          lastName,
          location,
          posts,
          postsSliced: posts.slice(0, 1),
          postsMapped: posts.map(({ title, comments }) => ({ title, comments })),
          postsMappedDeeper: posts.map(({ title, comments, likedBy }) => ({
            title,
            comments: comments.map(({ title }) => ({ title })),
            likedBy
          }))
        });
      })
    );
    console.log("[Source]:", _finalSource);
    console.log("[references]:", {
      references: environmentToMessage(context, {
        values: _finalValues
      }).references
    });
    // assert.equal(
    //   await evalAsPromise(new MetaesContext(), _finalSource, { values: _finalValues }),
    //   {},
    //   "object is not stringified in default way"
    // );
  });

  it("should acquire one reference", async () => {
    await _eval("me");
    assert.sameMembers([..._finalReferences], [_globalEnv.values.me]);
    console.log("[Source]:", _finalSource);
    console.log(
      environmentToMessage(context, {
        values: _finalValues
      })
    );
    assert.equal(
      await evalAsPromise(new MetaesContext(), _finalSource, { values: _finalValues }),
      {},
      "object is not stringified in default way"
    );
  });

  it("should acquire multiple references in array", async () => {
    await _eval(`[me, posts]`);
    assert.sameMembers([..._finalReferences], [_globalEnv.values.me, _globalEnv.values.posts]);
  });

  it("should acquire multiple references in object", async () => {
    await _eval(`({me, posts})`);
    assert.sameMembers([..._finalReferences], [_globalEnv.values.me, _globalEnv.values.posts]);
  });

  it("should not acquire local references", async () => {
    await _eval(`var local = 'anything'; [local,me]`);
    assert.sameMembers([..._finalReferences], [_globalEnv.values.me]);
  });

  it("should acquire references only for returned value", async () => {
    await _eval(`posts; me`);
    assert.sameMembers([..._finalReferences], [_globalEnv.values.me]);
  });

  it("should acquire references under different name, but pointing to the same object.", async () => {
    await _eval(`var _me = me; _me;`);
    assert.sameMembers([..._finalReferences], [_globalEnv.values.me]);
  });

  it("should acquire any deep references", async () => {
    await _eval(`posts; me; [me.location, me.location.address, "a string", 1, true, false, null]`);
    assert.sameMembers([..._finalReferences], [_globalEnv.values.me.location, _globalEnv.values.me.location.address]);
  });

  it("should acquire no refrences", async () => {
    await _eval(`me.location.address.street`);
    assert.sameMembers([..._finalReferences], []);
  });

  it("should support functions", async () => {
    await _eval(`me.logout; me.setOnlineStatus`);
    assert.sameMembers([..._finalReferences], [_globalEnv.values.me.setOnlineStatus]);
  });

  it("should support functions properties serialization", async () => {
    await _eval(`[me, me.setOnlineStatus]`);
    assert.sameMembers([..._finalReferences], [_globalEnv.values.me, _globalEnv.values.me.setOnlineStatus]);
  });

  it("should support repeating values as one reference", async () => {
    await _eval(`[repeated, repeated]`);
    console.log({ _finalReferences });
    assert.sameMembers([..._finalReferences], [_globalEnv.values.repeated]);
  });

  it("should destruct references chain", async () => {
    await _eval(`[repeated, repeated[0]]`);
    console.log({ _finalReferences });
    assert.sameMembers([..._finalReferences], [_globalEnv.values.repeated, _globalEnv.values.repeated[0]]);
  });

  it("should not support cyclic values", () =>
    new Promise((resolve, reject) =>
      _eval(`
    let a = ["a"];
    let b = ["b"];
    a.push(b);
    b.push(b);
    a;
    `)
        .then(reject)
        .catch(resolve)
    ));
});
