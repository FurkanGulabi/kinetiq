/* eslint no-bitwise: 0 */
/**
 * CNCjs macro language: the esprima-based expression evaluator used while streaming G-code.
 *
 * Ported from CNCjs 1.11.5:
 * - src/server/cnc/lib/evaluate-expression.js            -> evaluateExpression
 * - src/server/cnc/lib/evaluate-assignment-expression.js -> evaluateAssignmentExpression
 * - src/server/cnc/lib/translate-expression.js           -> translateExpression
 *
 * `[expr]` inside a G-code line (e.g. `G0 X[posx - 8]`) is replaced by translateExpression, and
 * `%var=expr` lines are run by evaluateAssignmentExpression, both against the controller's context
 * (positions, modal state, GLOBAL_OBJECTS). The evaluator only understands the node types handled in
 * `walk` below; anything else resolves to `undefined`. Keep it that way: this is the sandbox boundary.
 *
 * The port is line-by-line on purpose, including the quirks of the original (see the comments
 * marked "CNCjs quirk"), because G-code programs written for CNCjs rely on the exact behaviour.
 */
import _set from 'lodash/set';
import { generate } from 'escodegen';
import { parseScript } from 'esprima';
import type * as ESTree from 'estree';
import logger from '../logger';


// `esprima.parse(src)` (what CNCjs called) is exactly `parseScript(src)`: both parse a script with
// default options. `@types/esprima` only declares the latter.
const parse = (src: string): ESTree.Program => parseScript(src);

// Loosely-typed views used where the original reads properties that may not exist on a node
// (the resulting `undefined` / TypeError is part of the behaviour and is kept).
type AnyObject = Record<PropertyKey, unknown>;
type CallableValue = (...args: unknown[]) => unknown;

/*
 * evaluateExpression
 */

const logEvaluate = logger('evaluate-expression');

const UNRESOLVED = Symbol('unresolved');

/**
 * Evaluates an expression (source string or an already parsed ESTree node) against `context`.
 * Returns `undefined` when the expression cannot be resolved (unknown identifier, unsupported
 * node type) or throws (the error is logged).
 *
 * Note: `context` is used as-is when it is an object, so evaluating a function expression leaves
 * its parameter names set to `null` in the caller's object (CNCjs quirk).
 */
export const evaluateExpression = (src: string | ESTree.Node, context?: unknown): unknown => {
  let vars = context as AnyObject;
  if (!vars || typeof vars !== 'object') {
    vars = { ...(vars as object) };
  }

  // `node` may be null/undefined at runtime (array holes, a missing return argument, a statement
  // that is not an expression...); reading `node.type` then throws and the error is logged below.
  const walk = (node: ESTree.Node): unknown => {
    if (node.type === 'Literal') {
      return node.value;
    }

    if (node.type === 'UnaryExpression') {
      // CNCjs quirk: the argument is not checked for UNRESOLVED, so `!unknown` is `false` and
      // `-unknown` throws (converting a Symbol to a number).
      const val = walk(node.argument);
      if (node.operator === '+') {
        return +(val as number);
      }
      if (node.operator === '-') {
        return -(val as number);
      }
      if (node.operator === '~') {
        return ~(val as number);
      }
      if (node.operator === '!') {
        return !val;
      }
      return UNRESOLVED;
    }

    if (node.type === 'ArrayExpression') {
      const xs: unknown[] = [];
      for (let i = 0, l = node.elements.length; i < l; i++) {
        const x = walk(node.elements[i] as ESTree.Node);
        if (x === UNRESOLVED) {
          return UNRESOLVED;
        }
        xs.push(x);
      }
      return xs;
    }

    if (node.type === 'ObjectExpression') {
      const obj: AnyObject = {};
      for (let i = 0; i < node.properties.length; i++) {
        const prop = node.properties[i] as ESTree.Property;
        const value = (prop.value === null)
          ? prop.value
          : walk(prop.value);
        if (value === UNRESOLVED) {
          return UNRESOLVED;
        }
        const key = prop.key as { value?: unknown; name?: unknown };
        obj[(key.value || key.name) as PropertyKey] = value;
      }
      return obj;
    }

    if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') {
      // Both operands are always evaluated (no short-circuit for && and ||).
      const l = walk(node.left);
      if (l === UNRESOLVED) {
        return UNRESOLVED;
      }
      const r = walk(node.right);
      if (r === UNRESOLVED) {
        return UNRESOLVED;
      }
      // The casts below only satisfy the type checker; the operators keep their plain JS semantics.
      const ln = l as number;
      const rn = r as number;
      const op = node.operator;
      if (op === '==') {
        return l == r; // eslint-disable-line eqeqeq
      }
      if (op === '===') {
        return l === r;
      }
      if (op === '!=') {
        return l != r; // eslint-disable-line eqeqeq
      }
      if (op === '!==') {
        return l !== r;
      }
      if (op === '+') {
        return ln + rn;
      }
      if (op === '-') {
        return ln - rn;
      }
      if (op === '*') {
        return ln * rn;
      }
      if (op === '/') {
        return ln / rn;
      }
      if (op === '%') {
        return ln % rn;
      }
      if (op === '<') {
        return ln < rn;
      }
      if (op === '<=') {
        return ln <= rn;
      }
      if (op === '>') {
        return ln > rn;
      }
      if (op === '>=') {
        return ln >= rn;
      }
      if (op === '|') {
        return ln | rn;
      }
      if (op === '&') {
        return ln & rn;
      }
      if (op === '^') {
        return ln ^ rn;
      }
      if (op === '&&') {
        return l && r;
      }
      if (op === '||') {
        return l || r;
      }
      return UNRESOLVED;
    }

    if (node.type === 'Identifier') {
      if (Object.hasOwnProperty.call(vars, node.name)) {
        return vars[node.name];
      }
      return UNRESOLVED;
    }

    if (node.type === 'ThisExpression') {
      if (Object.hasOwnProperty.call(vars, 'this')) {
        return vars['this']; // eslint-disable-line dot-notation
      }
      return UNRESOLVED;
    }

    if (node.type === 'CallExpression') {
      const callee = walk(node.callee);
      if (callee === UNRESOLVED) {
        return UNRESOLVED;
      }
      if (typeof callee !== 'function') {
        return UNRESOLVED;
      }
      // CNCjs quirk: for `a.b(...)` the object `a` is walked a second time to get `this`.
      const calleeObject = (node.callee as Partial<ESTree.MemberExpression>).object;
      let ctx = calleeObject ? walk(calleeObject) : UNRESOLVED;
      if (ctx === UNRESOLVED) {
        ctx = null;
      }
      const args: unknown[] = [];
      for (let i = 0, l = node.arguments.length; i < l; i++) {
        const x = walk(node.arguments[i]);
        if (x === UNRESOLVED) {
          return UNRESOLVED;
        }
        args.push(x);
      }
      return (callee as CallableValue).apply(ctx, args);
    }

    if (node.type === 'MemberExpression') {
      const obj = walk(node.object);
      if (obj === UNRESOLVED) {
        return UNRESOLVED;
      }
      // CNCjs quirk: an Identifier property is taken by name even when computed, so `a[b]` reads
      // `a.b` (not `a[<value of b>]`). Use `a["b"]` / `a[0]` / `a[b + 0]` style for dynamic access.
      if (node.property.type === 'Identifier') {
        return (obj as AnyObject)[node.property.name];
      }
      const prop = walk(node.property);
      if (prop === UNRESOLVED) {
        return UNRESOLVED;
      }
      return (obj as AnyObject)[prop as PropertyKey];
    }

    if (node.type === 'ConditionalExpression') {
      const val = walk(node.test);
      if (val === UNRESOLVED) {
        return UNRESOLVED;
      }
      return val ? walk(node.consequent) : walk(node.alternate);
    }

    if (node.type === 'ExpressionStatement') {
      const val = walk(node.expression);
      if (val === UNRESOLVED) {
        return UNRESOLVED;
      }
      return val;
    }

    if (node.type === 'ReturnStatement') {
      return walk(node.argument as ESTree.Expression);
    }

    if (node.type === 'FunctionExpression') {
      const bodies = node.body.body;

      // Create a "scope" for our arguments
      const oldVars: AnyObject = {};
      Object.keys(vars).forEach(element => {
        oldVars[element] = vars[element];
      });

      for (let i = 0; i < node.params.length; i++) {
        const key = node.params[i];
        if (key.type !== 'Identifier') {
          return UNRESOLVED;
        }

        vars[key.name] = null;
      }

      for (const i in bodies) { // eslint-disable-line guard-for-in
        if (walk((bodies as unknown as Record<string, ESTree.Statement>)[i]) === UNRESOLVED) {
          return UNRESOLVED;
        }
      }

      // restore the vars and scope after walk
      vars = oldVars;

      const keys = Object.keys(vars);
      const vals = keys.map(key => {
        return vars[key];
      });

      return Function(keys.join(', '), 'return ' + generate(node)).apply(null, vals); // eslint-disable-line no-new-func
    }

    if (node.type === 'TemplateLiteral') {
      let str = '';
      let i = 0;
      for (i = 0; i < node.expressions.length; i++) {
        str += walk(node.quasis[i]);
        str += walk(node.expressions[i]);
      }
      str += walk(node.quasis[i]);
      return str;
    }

    if (node.type === 'TaggedTemplateExpression') {
      const tag = walk(node.tag);
      const quasi = node.quasi;
      const strings = quasi.quasis.map(walk);
      const values = quasi.expressions.map(walk);
      return (tag as CallableValue).apply(null, ([strings] as unknown[]).concat(values));
    }

    if (node.type === 'TemplateElement') {
      return node.value.cooked;
    }

    return UNRESOLVED;
  };

  let result: unknown = UNRESOLVED;

  try {
    let ast: ESTree.Node;

    if (typeof src === 'string') {
      ast = (parse(src).body[0] as ESTree.ExpressionStatement).expression;
    } else {
      ast = src;
    }

    result = walk(ast);
  } catch (e) {
    logEvaluate.error(`src="${src}", vars=${JSON.stringify(vars)}`);
    logEvaluate.error(e);
  }

  return (result === UNRESOLVED) ? undefined : result;
};

/*
 * evaluateAssignmentExpression
 */

const logAssignment = logger('evaluate-assignment-expression');

const isStaticMemberExpression = (node: ESTree.Node): boolean => typeof node === 'object' && node.type === 'MemberExpression' && !node.computed;
const isComputedMemberExpression = (node: ESTree.Node): boolean => typeof node === 'object' && node.type === 'MemberExpression' && !!node.computed;

const lookupObjectPath = (node: ESTree.Node | null | undefined, vars: unknown): unknown[] => {
  if (!node) {
    return [];
  }

  /*
     * Expression: 'x = value'
     *
     * Identifier { type: 'Identifier', name: 'x' }
     */
  if (node.type === 'Identifier') {
    return [node.name];
  }

  if (isComputedMemberExpression(node)) {
    const member = node as ESTree.MemberExpression;
    return [...lookupObjectPath(member.object, vars), evaluateExpression(member.property, vars)];
  }

  if (isStaticMemberExpression(node)) {
    const member = node as ESTree.MemberExpression;
    /*
         * Expression: 'x.y = value'
         *
         * StaticMemberExpression {
         *   type: 'MemberExpression',
         *   computed: false,
         *   object: Identifier { type: 'Identifier', name: 'x' },
         *   property: Identifier { type: 'Identifier', name: 'y' }
         * }
         *
         * Expression: 'x[y] = value'
         *
         * ComputedMemberExpression {
         *   type: 'MemberExpression',
         *   computed: true,
         *   object: Identifier { type: 'Identifier', name: 'x' },
         *   property: Identifier { type: 'Identifier', name: 'y' }
         * }
         */
    if (member.property.type === 'Identifier') {
      return [...lookupObjectPath(member.object, vars), member.property.name];
    }

    /*
         * Expression: 'x["y"] = value'
         *
         * ComputedMemberExpression {
         *   type: 'MemberExpression',
         *   computed: true,
         *   object: Identifier { type: 'Identifier', name: 'x' },
         *   property: Literal { type: 'Literal', value: 'y', raw: '"y"' }
         * }
         */
    if (member.property.type === 'Literal') {
      return [...lookupObjectPath(member.object, vars), member.property.value];
    }

    return [...lookupObjectPath(member.object, vars), evaluateExpression(member.property, vars)];
  }

  return [(node as { name?: unknown }).name];
};

const walkAssignmentExpression = (node: ESTree.AssignmentExpression, vars: unknown): void => {
  console.assert(node && node.type === 'AssignmentExpression');

  // CNCjs quirk: the operator is ignored, so `x += 1` behaves like `x = 1`.
  const path = lookupObjectPath(node.left, vars);
  if (path) {
    const value = evaluateExpression(node.right, vars);
    _set(vars as object, path as PropertyKey[], value);
  }
};

const walkSequenceExpression = (node: ESTree.SequenceExpression, vars: unknown): void => {
  console.assert(node && node.type === 'SequenceExpression');

  node.expressions.forEach(expr => {
    if (expr.type === 'AssignmentExpression') {
      walkAssignmentExpression(expr, vars);
      return;
    }

    evaluateExpression(expr, vars);
  });
};

/**
 * Runs `src` (e.g. `_x = posx, _y = posy`) and writes the assigned values into `vars` (mutated in
 * place, lodash `set` paths). Returns `vars`. Errors are logged, never thrown.
 */
export const evaluateAssignmentExpression = <T = Record<string, unknown>>(src: string, vars: T = {} as T): T => {
  if (!src) {
    return vars;
  }

  try {
    const ast = (parse(src).body[0] as ESTree.ExpressionStatement).expression;

    if (ast.type === 'AssignmentExpression') {
      walkAssignmentExpression(ast, vars);
    } else if (ast.type === 'SequenceExpression') {
      walkSequenceExpression(ast, vars);
    } else {
      evaluateExpression(ast, vars);
    }
  } catch (e) {
    logAssignment.error(`src="${src}", vars=${JSON.stringify(vars)}`);
    logAssignment.error(e);
  }

  return vars;
};

/*
 * translateExpression
 */

const logTranslate = logger('translate-expression');
const re = new RegExp(/\[[^\]]+\]/g);

/**
 * Replaces every `[expr]` in `data` with its evaluated value (stringified by `String.replace`, so
 * `0.1+0.2` gives `0.30000000000000004` and `-0` gives `0`). Unresolvable expressions are left as-is.
 * Brackets are matched without nesting or comment awareness: `[a[0]]` matches `[a[0]`.
 */
export const translateExpression = (data: string, vars: unknown = {}): string => {
  if (!data) {
    return '';
  }

  try {
    data = String(data).replace(re, (match) => {
      const src = match.slice(1, -1);
      const value = evaluateExpression(src, vars);
      return (value !== undefined ? value : match) as string;
    });
  } catch (e) {
    logTranslate.error(`data="${data}", vars=${JSON.stringify(vars)}`);
    logTranslate.error(e);
  }

  return data;
};
