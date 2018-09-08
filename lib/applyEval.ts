import { Continuation, ErrorContinuation, EvaluationConfig } from "./types";
import { tokens } from "./interpreters";
import { ASTNode } from "./nodes/nodes";
import { Environment } from "./environment";
import { NotImplementedException } from "./exceptions";
import { callInterceptor } from "./metaes";

export function evaluateProp(
  propertyKey: string,
  e: ASTNode,
  env: Environment,
  config: EvaluationConfig,
  c: Continuation,
  cerr: ErrorContinuation
) {
  callInterceptor({ phase: "enter", propertyKey }, config, e);

  const value = e[propertyKey];
  const createContinuation = (cnt, value) => {
    callInterceptor({ phase: "exit", propertyKey }, config, e, env);
    cnt(value);
  };
  const _c = createContinuation.bind(null, c);
  const _cerr = createContinuation.bind(null, cerr);

  Array.isArray(value) ? evaluateArray(value, env, config, _c, _cerr) : evaluate(value, env, config, _c, _cerr);
}

// TODO: DRY
export function evaluatePropWrap(
  propertyKey: string,
  body: (c: Continuation, cerr: ErrorContinuation) => void,
  e: ASTNode,
  env: Environment,
  config: EvaluationConfig,
  c: Continuation,
  cerr: ErrorContinuation
) {
  callInterceptor({ phase: "enter", propertyKey }, config, e, env);

  body(
    value => {
      callInterceptor({ phase: "exit", propertyKey }, config, e, env);
      c(value);
    },
    exception => {
      callInterceptor({ phase: "exit", propertyKey }, config, e, env);
      cerr(exception);
    }
  );
}

export function evaluate(
  e: ASTNode,
  env: Environment,
  config: EvaluationConfig,
  c: Continuation,
  cerr: ErrorContinuation
) {
  if (e.type in tokens) {
    callInterceptor({ phase: "enter" }, config, e, env);
    try {
      tokens[e.type](
        e,
        env,
        config,
        value => {
          callInterceptor({ phase: "exit" }, config, e, env, value);
          c(value);
        },
        exception => {
          if (!exception.location) {
            exception.location = e;
          }
          callInterceptor({ phase: "exit" }, config, e, env, exception);
          cerr(exception);
        }
      );
    } catch (error) {
      throw error;
    }
  } else {
    const exception = NotImplementedException(`"${e.type}" node type interpreter is not defined yet.`, e);
    callInterceptor({ phase: "enter" }, config, e, env);
    cerr(exception);
    callInterceptor({ phase: "enter" }, config, e, env, exception);
  }
}

type Visitor<T> = (element: T, c: Continuation, cerr: ErrorContinuation) => void;

/**
 * visitArray uses trampolining inside as it's likely that too long array execution will eat up callstack.
 * @param items
 * @param fn
 * @param c
 * @param cerr
 */
export const visitArray = <T>(items: T[], fn: Visitor<T>, c: Continuation, cerr: ErrorContinuation) => {
  // Array of loop function arguments to be applied next time
  const tasks: any[] = [];
  // Indicates if tasks execution is done. Initially it is done.
  let done = true;

  // Simple `loop` function executor, just loop over arguments until nothing is left.
  function execute() {
    done = false;
    while (tasks.length) {
      (<any>loop)(...tasks.shift());
    }
    done = true;
  }

  const visited = new Set();

  function loop(index, accumulated: T[]) {
    if (index < items.length) {
      fn(
        items[index],
        value => {
          // If true, it means currently may be happening for example a reevaluation of items 
          // from certain index using call/cc. Copy accumulated previously results and ignore their tail
          // after given index as this reevalution may happen in the middle of an array.
          if (visited.has(index)) {
            accumulated = accumulated.slice(0, index);
          }
          accumulated.push(value);
          visited.add(index);
          tasks.push([index + 1, accumulated]);
          if (done) {
            execute();
          }
        },
        cerr
      );
    } else {
      c(accumulated);
    }
  }

  // start
  loop(0, []);
};

export const evaluateArray = (
  array: ASTNode[],
  env: Environment,
  config: EvaluationConfig,
  c: Continuation,
  cerr: ErrorContinuation
) => visitArray(array, (e, c, cerr) => evaluate(e, env, config, c, cerr), c, cerr);

export const apply = (fn: Function, thisObj: any, args: any[]) => fn.apply(thisObj, args);
