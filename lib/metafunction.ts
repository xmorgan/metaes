import { evaluate } from "./applyEval";
import { Environment } from "./environment";
import { NotImplementedException, toException } from "./exceptions";
import { FunctionNode } from "./nodeTypes";
import { Continuation, ErrorContinuation, EvaluationConfig, MetaesFunction } from "./types";

export const evaluateMetaFunction = (
  metaFunction: MetaesFunction,
  c: Continuation,
  cerr: ErrorContinuation,
  thisObject: any,
  args: any[],
  executionTimeConfig?: EvaluationConfig
) => {
  const { e, closure, config } = metaFunction;
  try {
    const env = {
      prev: closure,
      values: { this: thisObject, arguments: args }
    };
    for (let i = 0; i < e.params.length; i++) {
      let param = e.params[i];
      switch (param.type) {
        case "Identifier":
          env.values[param.name] = args[i];
          break;
        case "RestElement":
          env.values[param.argument.name] = args.slice(i);
          break;
        default:
          throw NotImplementedException(`Not supported type (${param["type"]}) of function param.`, param);
      }
    }

    evaluate(
      e.body,
      value => {
        // use implicit return only if function is arrow function and have expression as a body
        if (e.type === "ArrowFunctionExpression" && e.body.type !== "BlockStatement") {
          c(value);
        } else {
          // ignore what was evaluated in function body, return statement in error continuation should carry the value
          c();
        }
      },
      exception => {
        switch (exception.type) {
          case "ReturnStatement":
            c(exception.value);
            break;
          default:
            cerr(exception);
        }
      },
      env,
      Object.assign({}, executionTimeConfig, config)
    );
  } catch (e) {
    cerr(e);
  }
};

export const createMetaFunctionWrapper = (metaFunction: MetaesFunction) => {
  const fn = function(this: any, ...args) {
    let result;
    let exception;
    evaluateMetaFunction(metaFunction, r => (result = r), ex => (exception = toException(ex)), this, args);
    if (exception) {
      throw exception;
    }
    return result;
  };

  markAsMetaFunction(fn, metaFunction);
  return fn;
};

export const createMetaFunction = (e: FunctionNode, closure: Environment, config: EvaluationConfig) =>
  createMetaFunctionWrapper({
    e,
    closure,
    config
  });

const META_KEY = "__meta__";

export function markAsMetaFunction(fn: Function, meta: MetaesFunction) {
  (<any>fn)[META_KEY] = meta;
}

export function isMetaFunction(fn: Function) {
  return (<any>fn)[META_KEY];
}

export function getMetaFunction(fn: Function) {
  return (<any>fn)[META_KEY];
}
