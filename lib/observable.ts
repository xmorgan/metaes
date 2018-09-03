import { MetaesContext } from "./metaes";
import { ASTNode } from "./nodes/nodes";
import { Evaluation } from "./types";

type Traps = {
  apply?: (target: object, methodName: string, args: any[], expressionValue: any) => void;
  get?: (target: object, key: string, value: any) => void;
  set?: (target: object, key: string, args: any) => void;
  didSet?: (target: object, key: string, args: any) => void;
};

type ObserverHandler = {
  target: any;
  traps: Traps;
};

export type FlameGraph = {
  executionStack: EvaluationNode[];
  values: Map<ASTNode, any>;
};

export type EvaluationNode = {
  evaluation: Evaluation;
  children: EvaluationNode[];
};

type EvaluationListener = (node: Evaluation, flameGraph: FlameGraph) => void;
type FlameGraphs = { [key: string]: FlameGraph };

type InterceptorOnce = (evaluation: Evaluation) => boolean;

const { apply, call } = Function;

export class ObservableContext extends MetaesContext {
  private _listeners: EvaluationListener[] = [];
  private _handlers: ObserverHandler[] = [];
  private _flameGraphs: FlameGraphs = {};
  private _oneTimeInterceptors: InterceptorOnce[] = [];

  constructor(target: object, mainHandler?: Traps) {
    super(
      undefined,
      undefined,
      // create additional wrapping environment to 
      // disallow creating variables in top environment.
      // Only target value should sit in top environment.
      { values: {}, prev: { values: { this: target, self: target } } },
      {
        interceptor: (evaluation: Evaluation) => {
          this._flameGraphBuilder("before", evaluation);
          try {
            this.interceptor(evaluation);
          } catch (e) {
            // TODO: use logger
            console.log(e);
          }
          this._flameGraphBuilder("after", evaluation);
        }
      }
    );

    if (mainHandler) {
      this._handlers.push({ traps: mainHandler, target });
    }
  }

  addListener(listener: EvaluationListener) {
    this._listeners.push(listener);
  }

  _interceptOnce(fn: InterceptorOnce) {
    this._oneTimeInterceptors.push(fn);
  }

  addHandler(handler: ObserverHandler) {
    this._handlers.push(handler);
  }

  interceptor(evaluation: Evaluation) {
    this._mainInterceptor(evaluation);
    for (let i = 0; i < this._oneTimeInterceptors.length; i++) {
      const interceptor = this._oneTimeInterceptors[i];
      try {
        if (interceptor(evaluation)) {
          this._oneTimeInterceptors.splice(i, 1);
        }
      } catch (e) {
        console.error(e);
      }
    }
  }

  _mainInterceptor(evaluation: Evaluation) {
    const { scriptId } = evaluation;
    const flameGraph = this._flameGraphs[scriptId];
    const getValue = e => flameGraph.values.get(e);

    // handler.set
    if (evaluation.tag.phase === "enter" && evaluation.e.type === "AssignmentExpression") {
      const assignment = evaluation.e as any;
      this._interceptOnce(evaluation => {
        if (evaluation.tag.phase === "exit" && evaluation.tag.propertyKey === "property") {
          const left = getValue(assignment.left.object);
          if (left) {
            for (let i = 0; i < this._handlers.length; i++) {
              const handler = this._handlers[i];
              if (handler.target === left && handler.traps.set) {
                handler.traps.set(left, getValue(assignment.left.property), getValue(assignment.right));
              }
            }
          }
          return true;
        }
        return false;
      });
    }

    if (evaluation.tag.phase === "exit") {
      // handler.didSet
      if (evaluation.e.type === "AssignmentExpression") {
        const assignment = evaluation.e as any;

        const left = getValue(assignment.left.object);
        if (left) {
          for (let i = 0; i < this._handlers.length; i++) {
            const handler = this._handlers[i];
            if (handler.target === left && handler.traps.didSet) {
              handler.traps.didSet(left, getValue(assignment.left.property), getValue(assignment.right));
            }
          }
        }
      }

      // handler.apply
      if (evaluation.e.type === "CallExpression") {
        const callNode = evaluation.e as any;
        const callNodeValue = getValue(callNode);
        const object = getValue(callNode.callee.object);
        const property = getValue(callNode.callee.property);
        const args: any[] = callNode.arguments.map(getValue);
        for (let i = 0; i < this._handlers.length; i++) {
          const handler = this._handlers[i];
          if (handler.traps.apply) {
            if (handler.target === object) {
              handler.traps.apply(object, property, args, callNodeValue);
            } else if (
              // in this case check if function is called using .call or .apply with
              // `this` equal to `observer.target`
              args[0] === handler.target
            ) {
              if (property === apply) {
                handler.traps.apply(args[0], object, args[1], callNodeValue);
              } else if (property === call) {
                handler.traps.apply(args[0], object, args.slice(1), callNodeValue);
              }
            }
          }
        }
      }
    }

    this._listeners.forEach(listener => listener(evaluation, flameGraph));
  }

  private _flameGraphBuilder(phase: "before" | "after", evaluation: Evaluation) {
    const { tag, scriptId } = evaluation;
    const flameGraph =
      this._flameGraphs[scriptId] ||
      (this._flameGraphs[scriptId] = {
        executionStack: [],
        values: new Map()
      });
    const stack = flameGraph.executionStack;

    if (phase === "before") {
      if (tag.phase === "enter") {
        const node: EvaluationNode = {
          evaluation,
          children: []
        };
        const parent = stack[stack.length - 1];
        if (parent) {
          parent.children.push(node);
        }
        stack.push(node);
      } else {
        flameGraph.values.set(evaluation.e, evaluation.value);
      }
    }
    if (phase === "after" && tag.phase === "exit") {
      stack.pop();
    }
  }
}
