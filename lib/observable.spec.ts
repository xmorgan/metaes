import { describe, it } from "mocha";
import { ObservableContext } from "./observable";
import { expect } from "chai";
import { evaluateFunction } from "./metaes";
import { ASTNode } from "./nodes/nodes";
import { MemberExpression } from "./nodeTypes";
import { Environment } from "./environment";

describe("ObservableContext", () => {
  it("should correctly build tree structure of children", async () => {
    const value = {};
    const context = new ObservableContext(value);

    await evaluateFunction(context, () => (self["foo"] = "bar"));

    expect(value["foo"]).to.equal("bar");
  });

  it("should execute code inside proxied context", async () => {
    const value = {};
    const context = new ObservableContext(value);

    await context.evaluate(`self.foo="bar"`);

    expect(value["foo"]).to.equal("bar");
  });

  it("should collect trap results before value is set", async () => {
    const value = {};
    let called = false;
    const context = new ObservableContext(value, {
      set(observedValue, key, args) {
        called = true;
        expect(observedValue).to.equal(value);

        expect(key).to.equal("foo");
        expect(args).to.equal("bar");

        expect(observedValue["foo"]).to.equal(undefined);
      }
    });
    const source = `self.foo="bar"`;
    await context.evaluate(source);

    expect(called).to.be.true;
  });

  it("should collect trap results after value is set", async () => {
    const value = {};
    let called = false;
    const context = new ObservableContext(value, {
      didSet(observedValue, key, args) {
        called = true;
        expect(observedValue).to.equal(value);

        expect(key).to.equal("foo");
        expect(args).to.equal("bar");

        expect(observedValue["foo"]).to.equal("bar");
      }
    });
    const source = `self["foo"]="bar"`;
    await context.evaluate(source);

    expect(called).to.be.true;
  });

  it("should collect trap results of dynamically added context", async () => {
    const source = `self["foo"]={}, self.foo.bar=1`;
    const value = {};
    let called = false;

    await new Promise((resolve, reject) => {
      const context = new ObservableContext(value, {
        didSet(_context, key) {
          context.addHandler({
            target: _context[key],
            traps: {
              set(_object, key, args) {
                try {
                  expect(key).to.equal("bar");
                  expect(args).to.equal(1);
                  called = true;
                  resolve();
                } catch (e) {
                  console.log({ _object, key, args });
                  reject(e);
                }
              }
            }
          });
        }
      });
      context.evaluate(source);
    });

    expect(called).to.be.true;
  });

  it("should collect trap results of method call", async () => {
    const value = [];
    let called = false;
    const context = new ObservableContext(value, {
      apply(target, methodName, args) {
        expect(target).to.equal(value);
        expect(methodName).to.equal(value.push);
        expect(args).to.eql([1]);
        called = true;
      }
    });
    await context.evaluate(`self.push(1)`);

    expect(called).to.be.true;
  });

  it("should collect trap results of chained method call", async () => {
    const value = { array: [] };
    let called = false;
    const context = new ObservableContext(value);
    context.addHandler({
      target: value.array,
      traps: {
        apply(target, methodName, args) {
          expect(target).to.equal(value.array);
          expect(methodName).to.equal(value.array.push);
          expect(args).to.eql([1]);
          called = true;
        }
      }
    });
    const source = `self.array.push(1)`;
    await context.evaluate(source);
    expect(value.array.length).to.equal(1);

    expect(called).to.be.true;
  });

  it("should collect trap results of method call when using apply", async () => {
    const value = [];
    let called = false;
    const context = new ObservableContext(value, {
      apply(target, methodName, args) {
        expect(target).to.equal(value);
        expect(methodName).to.equal(value.push);
        expect(args).to.eql([1]);
        called = true;
      }
    });

    await context.evaluate(`self.push.apply(self, [1])`);
    expect(value.length).to.equal(1);
    expect(called).to.be.true;
  });

  it("should collect trap results of method call when using call", async () => {
    const value = [];
    let called = false;
    const context = new ObservableContext(value, {
      apply(target, methodName, args) {
        expect(target).to.equal(value);
        expect(methodName).to.equal(value.push);
        expect(args).to.eql([1]);
        called = true;
      }
    });

    await context.evaluate(`self.push.call(self, 1)`);
    expect(value.length).to.equal(1);
    expect(called).to.be.true;
  });

  it("should collect results of member expressions", async () => {
    const self = {
      user: { name: "First", lastname: "Lastname", address: { street: "Long" } }
    };
    const context = new ObservableContext(self);

    // self.user.address.street shouldn't be collected, it's a primitive value.
    // anything from `dummy` shouldn't be collected.
    const source = `
      [self.user.address, self.user, self.user.address.street, dummy.value1]
    `;

    function objectValueRec(e: ASTNode) {
      if (isMemberExpression(e)) {
        return objectValueRec(e.object);
      } else {
        return e;
      }
    }

    const isMemberExpression = (e: ASTNode): e is MemberExpression => e.type === "MemberExpression";

    function getTopEnv(env: Environment) {
      while (env.prev) {
        env = env.prev;
      }
      return env;
    }

    function environmentHasValue(environment: Environment, value: any) {
      for (let k in environment.values) {
        if (value === environment.values[k]) {
          return true;
        }
      }
      return false;
    }

    const belongsToObservableEnvironment = (value: any) => environmentHasValue(topEnv, value);

    const topEnv = getTopEnv(context.environment);

    const actualToObserve = new Set();

    context.addListener(({ e, tag: { phase } }, graph) => {
      if (phase === "exit") {
        if (isMemberExpression(e)) {
          const [rootObjectValue, propertyValue] = [
            graph.values.get(objectValueRec(e.object)),
            graph.values.get(e.property)
          ];
          if (belongsToObservableEnvironment(rootObjectValue) && typeof propertyValue === "object") {
            actualToObserve.add(propertyValue);
          }
        } else if (e.type === "Identifier") {
          const value = graph.values.get(e);

          if (self === value) {
            if (graph.executionStack[graph.executionStack.length - 2].evaluation.e.type !== "MemberExpression") {
              actualToObserve.add(value);
            }
          }
        }
      }
    });
    let error;
    context.evaluate(source, undefined, _e => (error = _e.value), { values: { dummy: {} }, prev: topEnv });
    if (error) {
      throw error;
    }

    const expected = [self.user, self.user.address];
    const results = [...actualToObserve];

    results.forEach(result => expect(expected).to.include(result));
    expect(results).to.have.length(expected.length);
  });
});
