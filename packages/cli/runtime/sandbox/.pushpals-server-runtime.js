// @bun
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: __accessProp.bind(mod, key),
        enumerable: true
      });
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);

// node_modules/ajv/dist/compile/codegen/code.js
var require_code = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.regexpCode = exports.getEsmExportName = exports.getProperty = exports.safeStringify = exports.stringify = exports.strConcat = exports.addCodeArg = exports.str = exports._ = exports.nil = exports._Code = exports.Name = exports.IDENTIFIER = exports._CodeOrName = undefined;

  class _CodeOrName {
  }
  exports._CodeOrName = _CodeOrName;
  exports.IDENTIFIER = /^[a-z$_][a-z$_0-9]*$/i;

  class Name extends _CodeOrName {
    constructor(s) {
      super();
      if (!exports.IDENTIFIER.test(s))
        throw new Error("CodeGen: name must be a valid identifier");
      this.str = s;
    }
    toString() {
      return this.str;
    }
    emptyStr() {
      return false;
    }
    get names() {
      return { [this.str]: 1 };
    }
  }
  exports.Name = Name;

  class _Code extends _CodeOrName {
    constructor(code) {
      super();
      this._items = typeof code === "string" ? [code] : code;
    }
    toString() {
      return this.str;
    }
    emptyStr() {
      if (this._items.length > 1)
        return false;
      const item = this._items[0];
      return item === "" || item === '""';
    }
    get str() {
      var _a;
      return (_a = this._str) !== null && _a !== undefined ? _a : this._str = this._items.reduce((s, c) => `${s}${c}`, "");
    }
    get names() {
      var _a;
      return (_a = this._names) !== null && _a !== undefined ? _a : this._names = this._items.reduce((names, c) => {
        if (c instanceof Name)
          names[c.str] = (names[c.str] || 0) + 1;
        return names;
      }, {});
    }
  }
  exports._Code = _Code;
  exports.nil = new _Code("");
  function _(strs, ...args) {
    const code = [strs[0]];
    let i = 0;
    while (i < args.length) {
      addCodeArg(code, args[i]);
      code.push(strs[++i]);
    }
    return new _Code(code);
  }
  exports._ = _;
  var plus = new _Code("+");
  function str(strs, ...args) {
    const expr = [safeStringify(strs[0])];
    let i = 0;
    while (i < args.length) {
      expr.push(plus);
      addCodeArg(expr, args[i]);
      expr.push(plus, safeStringify(strs[++i]));
    }
    optimize(expr);
    return new _Code(expr);
  }
  exports.str = str;
  function addCodeArg(code, arg) {
    if (arg instanceof _Code)
      code.push(...arg._items);
    else if (arg instanceof Name)
      code.push(arg);
    else
      code.push(interpolate(arg));
  }
  exports.addCodeArg = addCodeArg;
  function optimize(expr) {
    let i = 1;
    while (i < expr.length - 1) {
      if (expr[i] === plus) {
        const res = mergeExprItems(expr[i - 1], expr[i + 1]);
        if (res !== undefined) {
          expr.splice(i - 1, 3, res);
          continue;
        }
        expr[i++] = "+";
      }
      i++;
    }
  }
  function mergeExprItems(a, b) {
    if (b === '""')
      return a;
    if (a === '""')
      return b;
    if (typeof a == "string") {
      if (b instanceof Name || a[a.length - 1] !== '"')
        return;
      if (typeof b != "string")
        return `${a.slice(0, -1)}${b}"`;
      if (b[0] === '"')
        return a.slice(0, -1) + b.slice(1);
      return;
    }
    if (typeof b == "string" && b[0] === '"' && !(a instanceof Name))
      return `"${a}${b.slice(1)}`;
    return;
  }
  function strConcat(c1, c2) {
    return c2.emptyStr() ? c1 : c1.emptyStr() ? c2 : str`${c1}${c2}`;
  }
  exports.strConcat = strConcat;
  function interpolate(x) {
    return typeof x == "number" || typeof x == "boolean" || x === null ? x : safeStringify(Array.isArray(x) ? x.join(",") : x);
  }
  function stringify(x) {
    return new _Code(safeStringify(x));
  }
  exports.stringify = stringify;
  function safeStringify(x) {
    return JSON.stringify(x).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  }
  exports.safeStringify = safeStringify;
  function getProperty(key) {
    return typeof key == "string" && exports.IDENTIFIER.test(key) ? new _Code(`.${key}`) : _`[${key}]`;
  }
  exports.getProperty = getProperty;
  function getEsmExportName(key) {
    if (typeof key == "string" && exports.IDENTIFIER.test(key)) {
      return new _Code(`${key}`);
    }
    throw new Error(`CodeGen: invalid export name: ${key}, use explicit $id name mapping`);
  }
  exports.getEsmExportName = getEsmExportName;
  function regexpCode(rx) {
    return new _Code(rx.toString());
  }
  exports.regexpCode = regexpCode;
});

// node_modules/ajv/dist/compile/codegen/scope.js
var require_scope = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.ValueScope = exports.ValueScopeName = exports.Scope = exports.varKinds = exports.UsedValueState = undefined;
  var code_1 = require_code();

  class ValueError extends Error {
    constructor(name) {
      super(`CodeGen: "code" for ${name} not defined`);
      this.value = name.value;
    }
  }
  var UsedValueState;
  (function(UsedValueState2) {
    UsedValueState2[UsedValueState2["Started"] = 0] = "Started";
    UsedValueState2[UsedValueState2["Completed"] = 1] = "Completed";
  })(UsedValueState || (exports.UsedValueState = UsedValueState = {}));
  exports.varKinds = {
    const: new code_1.Name("const"),
    let: new code_1.Name("let"),
    var: new code_1.Name("var")
  };

  class Scope {
    constructor({ prefixes, parent } = {}) {
      this._names = {};
      this._prefixes = prefixes;
      this._parent = parent;
    }
    toName(nameOrPrefix) {
      return nameOrPrefix instanceof code_1.Name ? nameOrPrefix : this.name(nameOrPrefix);
    }
    name(prefix) {
      return new code_1.Name(this._newName(prefix));
    }
    _newName(prefix) {
      const ng = this._names[prefix] || this._nameGroup(prefix);
      return `${prefix}${ng.index++}`;
    }
    _nameGroup(prefix) {
      var _a, _b;
      if (((_b = (_a = this._parent) === null || _a === undefined ? undefined : _a._prefixes) === null || _b === undefined ? undefined : _b.has(prefix)) || this._prefixes && !this._prefixes.has(prefix)) {
        throw new Error(`CodeGen: prefix "${prefix}" is not allowed in this scope`);
      }
      return this._names[prefix] = { prefix, index: 0 };
    }
  }
  exports.Scope = Scope;

  class ValueScopeName extends code_1.Name {
    constructor(prefix, nameStr) {
      super(nameStr);
      this.prefix = prefix;
    }
    setValue(value, { property, itemIndex }) {
      this.value = value;
      this.scopePath = (0, code_1._)`.${new code_1.Name(property)}[${itemIndex}]`;
    }
  }
  exports.ValueScopeName = ValueScopeName;
  var line = (0, code_1._)`\n`;

  class ValueScope extends Scope {
    constructor(opts) {
      super(opts);
      this._values = {};
      this._scope = opts.scope;
      this.opts = { ...opts, _n: opts.lines ? line : code_1.nil };
    }
    get() {
      return this._scope;
    }
    name(prefix) {
      return new ValueScopeName(prefix, this._newName(prefix));
    }
    value(nameOrPrefix, value) {
      var _a;
      if (value.ref === undefined)
        throw new Error("CodeGen: ref must be passed in value");
      const name = this.toName(nameOrPrefix);
      const { prefix } = name;
      const valueKey = (_a = value.key) !== null && _a !== undefined ? _a : value.ref;
      let vs = this._values[prefix];
      if (vs) {
        const _name = vs.get(valueKey);
        if (_name)
          return _name;
      } else {
        vs = this._values[prefix] = new Map;
      }
      vs.set(valueKey, name);
      const s = this._scope[prefix] || (this._scope[prefix] = []);
      const itemIndex = s.length;
      s[itemIndex] = value.ref;
      name.setValue(value, { property: prefix, itemIndex });
      return name;
    }
    getValue(prefix, keyOrRef) {
      const vs = this._values[prefix];
      if (!vs)
        return;
      return vs.get(keyOrRef);
    }
    scopeRefs(scopeName, values = this._values) {
      return this._reduceValues(values, (name) => {
        if (name.scopePath === undefined)
          throw new Error(`CodeGen: name "${name}" has no value`);
        return (0, code_1._)`${scopeName}${name.scopePath}`;
      });
    }
    scopeCode(values = this._values, usedValues, getCode) {
      return this._reduceValues(values, (name) => {
        if (name.value === undefined)
          throw new Error(`CodeGen: name "${name}" has no value`);
        return name.value.code;
      }, usedValues, getCode);
    }
    _reduceValues(values, valueCode, usedValues = {}, getCode) {
      let code = code_1.nil;
      for (const prefix in values) {
        const vs = values[prefix];
        if (!vs)
          continue;
        const nameSet = usedValues[prefix] = usedValues[prefix] || new Map;
        vs.forEach((name) => {
          if (nameSet.has(name))
            return;
          nameSet.set(name, UsedValueState.Started);
          let c = valueCode(name);
          if (c) {
            const def = this.opts.es5 ? exports.varKinds.var : exports.varKinds.const;
            code = (0, code_1._)`${code}${def} ${name} = ${c};${this.opts._n}`;
          } else if (c = getCode === null || getCode === undefined ? undefined : getCode(name)) {
            code = (0, code_1._)`${code}${c}${this.opts._n}`;
          } else {
            throw new ValueError(name);
          }
          nameSet.set(name, UsedValueState.Completed);
        });
      }
      return code;
    }
  }
  exports.ValueScope = ValueScope;
});

// node_modules/ajv/dist/compile/codegen/index.js
var require_codegen = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.or = exports.and = exports.not = exports.CodeGen = exports.operators = exports.varKinds = exports.ValueScopeName = exports.ValueScope = exports.Scope = exports.Name = exports.regexpCode = exports.stringify = exports.getProperty = exports.nil = exports.strConcat = exports.str = exports._ = undefined;
  var code_1 = require_code();
  var scope_1 = require_scope();
  var code_2 = require_code();
  Object.defineProperty(exports, "_", { enumerable: true, get: function() {
    return code_2._;
  } });
  Object.defineProperty(exports, "str", { enumerable: true, get: function() {
    return code_2.str;
  } });
  Object.defineProperty(exports, "strConcat", { enumerable: true, get: function() {
    return code_2.strConcat;
  } });
  Object.defineProperty(exports, "nil", { enumerable: true, get: function() {
    return code_2.nil;
  } });
  Object.defineProperty(exports, "getProperty", { enumerable: true, get: function() {
    return code_2.getProperty;
  } });
  Object.defineProperty(exports, "stringify", { enumerable: true, get: function() {
    return code_2.stringify;
  } });
  Object.defineProperty(exports, "regexpCode", { enumerable: true, get: function() {
    return code_2.regexpCode;
  } });
  Object.defineProperty(exports, "Name", { enumerable: true, get: function() {
    return code_2.Name;
  } });
  var scope_2 = require_scope();
  Object.defineProperty(exports, "Scope", { enumerable: true, get: function() {
    return scope_2.Scope;
  } });
  Object.defineProperty(exports, "ValueScope", { enumerable: true, get: function() {
    return scope_2.ValueScope;
  } });
  Object.defineProperty(exports, "ValueScopeName", { enumerable: true, get: function() {
    return scope_2.ValueScopeName;
  } });
  Object.defineProperty(exports, "varKinds", { enumerable: true, get: function() {
    return scope_2.varKinds;
  } });
  exports.operators = {
    GT: new code_1._Code(">"),
    GTE: new code_1._Code(">="),
    LT: new code_1._Code("<"),
    LTE: new code_1._Code("<="),
    EQ: new code_1._Code("==="),
    NEQ: new code_1._Code("!=="),
    NOT: new code_1._Code("!"),
    OR: new code_1._Code("||"),
    AND: new code_1._Code("&&"),
    ADD: new code_1._Code("+")
  };

  class Node {
    optimizeNodes() {
      return this;
    }
    optimizeNames(_names, _constants) {
      return this;
    }
  }

  class Def extends Node {
    constructor(varKind, name, rhs) {
      super();
      this.varKind = varKind;
      this.name = name;
      this.rhs = rhs;
    }
    render({ es5, _n }) {
      const varKind = es5 ? scope_1.varKinds.var : this.varKind;
      const rhs = this.rhs === undefined ? "" : ` = ${this.rhs}`;
      return `${varKind} ${this.name}${rhs};` + _n;
    }
    optimizeNames(names, constants) {
      if (!names[this.name.str])
        return;
      if (this.rhs)
        this.rhs = optimizeExpr(this.rhs, names, constants);
      return this;
    }
    get names() {
      return this.rhs instanceof code_1._CodeOrName ? this.rhs.names : {};
    }
  }

  class Assign extends Node {
    constructor(lhs, rhs, sideEffects) {
      super();
      this.lhs = lhs;
      this.rhs = rhs;
      this.sideEffects = sideEffects;
    }
    render({ _n }) {
      return `${this.lhs} = ${this.rhs};` + _n;
    }
    optimizeNames(names, constants) {
      if (this.lhs instanceof code_1.Name && !names[this.lhs.str] && !this.sideEffects)
        return;
      this.rhs = optimizeExpr(this.rhs, names, constants);
      return this;
    }
    get names() {
      const names = this.lhs instanceof code_1.Name ? {} : { ...this.lhs.names };
      return addExprNames(names, this.rhs);
    }
  }

  class AssignOp extends Assign {
    constructor(lhs, op, rhs, sideEffects) {
      super(lhs, rhs, sideEffects);
      this.op = op;
    }
    render({ _n }) {
      return `${this.lhs} ${this.op}= ${this.rhs};` + _n;
    }
  }

  class Label extends Node {
    constructor(label) {
      super();
      this.label = label;
      this.names = {};
    }
    render({ _n }) {
      return `${this.label}:` + _n;
    }
  }

  class Break extends Node {
    constructor(label) {
      super();
      this.label = label;
      this.names = {};
    }
    render({ _n }) {
      const label = this.label ? ` ${this.label}` : "";
      return `break${label};` + _n;
    }
  }

  class Throw extends Node {
    constructor(error) {
      super();
      this.error = error;
    }
    render({ _n }) {
      return `throw ${this.error};` + _n;
    }
    get names() {
      return this.error.names;
    }
  }

  class AnyCode extends Node {
    constructor(code) {
      super();
      this.code = code;
    }
    render({ _n }) {
      return `${this.code};` + _n;
    }
    optimizeNodes() {
      return `${this.code}` ? this : undefined;
    }
    optimizeNames(names, constants) {
      this.code = optimizeExpr(this.code, names, constants);
      return this;
    }
    get names() {
      return this.code instanceof code_1._CodeOrName ? this.code.names : {};
    }
  }

  class ParentNode extends Node {
    constructor(nodes = []) {
      super();
      this.nodes = nodes;
    }
    render(opts) {
      return this.nodes.reduce((code, n) => code + n.render(opts), "");
    }
    optimizeNodes() {
      const { nodes } = this;
      let i = nodes.length;
      while (i--) {
        const n = nodes[i].optimizeNodes();
        if (Array.isArray(n))
          nodes.splice(i, 1, ...n);
        else if (n)
          nodes[i] = n;
        else
          nodes.splice(i, 1);
      }
      return nodes.length > 0 ? this : undefined;
    }
    optimizeNames(names, constants) {
      const { nodes } = this;
      let i = nodes.length;
      while (i--) {
        const n = nodes[i];
        if (n.optimizeNames(names, constants))
          continue;
        subtractNames(names, n.names);
        nodes.splice(i, 1);
      }
      return nodes.length > 0 ? this : undefined;
    }
    get names() {
      return this.nodes.reduce((names, n) => addNames(names, n.names), {});
    }
  }

  class BlockNode extends ParentNode {
    render(opts) {
      return "{" + opts._n + super.render(opts) + "}" + opts._n;
    }
  }

  class Root extends ParentNode {
  }

  class Else extends BlockNode {
  }
  Else.kind = "else";

  class If extends BlockNode {
    constructor(condition, nodes) {
      super(nodes);
      this.condition = condition;
    }
    render(opts) {
      let code = `if(${this.condition})` + super.render(opts);
      if (this.else)
        code += "else " + this.else.render(opts);
      return code;
    }
    optimizeNodes() {
      super.optimizeNodes();
      const cond = this.condition;
      if (cond === true)
        return this.nodes;
      let e = this.else;
      if (e) {
        const ns = e.optimizeNodes();
        e = this.else = Array.isArray(ns) ? new Else(ns) : ns;
      }
      if (e) {
        if (cond === false)
          return e instanceof If ? e : e.nodes;
        if (this.nodes.length)
          return this;
        return new If(not(cond), e instanceof If ? [e] : e.nodes);
      }
      if (cond === false || !this.nodes.length)
        return;
      return this;
    }
    optimizeNames(names, constants) {
      var _a;
      this.else = (_a = this.else) === null || _a === undefined ? undefined : _a.optimizeNames(names, constants);
      if (!(super.optimizeNames(names, constants) || this.else))
        return;
      this.condition = optimizeExpr(this.condition, names, constants);
      return this;
    }
    get names() {
      const names = super.names;
      addExprNames(names, this.condition);
      if (this.else)
        addNames(names, this.else.names);
      return names;
    }
  }
  If.kind = "if";

  class For extends BlockNode {
  }
  For.kind = "for";

  class ForLoop extends For {
    constructor(iteration) {
      super();
      this.iteration = iteration;
    }
    render(opts) {
      return `for(${this.iteration})` + super.render(opts);
    }
    optimizeNames(names, constants) {
      if (!super.optimizeNames(names, constants))
        return;
      this.iteration = optimizeExpr(this.iteration, names, constants);
      return this;
    }
    get names() {
      return addNames(super.names, this.iteration.names);
    }
  }

  class ForRange extends For {
    constructor(varKind, name, from, to) {
      super();
      this.varKind = varKind;
      this.name = name;
      this.from = from;
      this.to = to;
    }
    render(opts) {
      const varKind = opts.es5 ? scope_1.varKinds.var : this.varKind;
      const { name, from, to } = this;
      return `for(${varKind} ${name}=${from}; ${name}<${to}; ${name}++)` + super.render(opts);
    }
    get names() {
      const names = addExprNames(super.names, this.from);
      return addExprNames(names, this.to);
    }
  }

  class ForIter extends For {
    constructor(loop, varKind, name, iterable) {
      super();
      this.loop = loop;
      this.varKind = varKind;
      this.name = name;
      this.iterable = iterable;
    }
    render(opts) {
      return `for(${this.varKind} ${this.name} ${this.loop} ${this.iterable})` + super.render(opts);
    }
    optimizeNames(names, constants) {
      if (!super.optimizeNames(names, constants))
        return;
      this.iterable = optimizeExpr(this.iterable, names, constants);
      return this;
    }
    get names() {
      return addNames(super.names, this.iterable.names);
    }
  }

  class Func extends BlockNode {
    constructor(name, args, async) {
      super();
      this.name = name;
      this.args = args;
      this.async = async;
    }
    render(opts) {
      const _async = this.async ? "async " : "";
      return `${_async}function ${this.name}(${this.args})` + super.render(opts);
    }
  }
  Func.kind = "func";

  class Return extends ParentNode {
    render(opts) {
      return "return " + super.render(opts);
    }
  }
  Return.kind = "return";

  class Try extends BlockNode {
    render(opts) {
      let code = "try" + super.render(opts);
      if (this.catch)
        code += this.catch.render(opts);
      if (this.finally)
        code += this.finally.render(opts);
      return code;
    }
    optimizeNodes() {
      var _a, _b;
      super.optimizeNodes();
      (_a = this.catch) === null || _a === undefined || _a.optimizeNodes();
      (_b = this.finally) === null || _b === undefined || _b.optimizeNodes();
      return this;
    }
    optimizeNames(names, constants) {
      var _a, _b;
      super.optimizeNames(names, constants);
      (_a = this.catch) === null || _a === undefined || _a.optimizeNames(names, constants);
      (_b = this.finally) === null || _b === undefined || _b.optimizeNames(names, constants);
      return this;
    }
    get names() {
      const names = super.names;
      if (this.catch)
        addNames(names, this.catch.names);
      if (this.finally)
        addNames(names, this.finally.names);
      return names;
    }
  }

  class Catch extends BlockNode {
    constructor(error) {
      super();
      this.error = error;
    }
    render(opts) {
      return `catch(${this.error})` + super.render(opts);
    }
  }
  Catch.kind = "catch";

  class Finally extends BlockNode {
    render(opts) {
      return "finally" + super.render(opts);
    }
  }
  Finally.kind = "finally";

  class CodeGen {
    constructor(extScope, opts = {}) {
      this._values = {};
      this._blockStarts = [];
      this._constants = {};
      this.opts = { ...opts, _n: opts.lines ? `
` : "" };
      this._extScope = extScope;
      this._scope = new scope_1.Scope({ parent: extScope });
      this._nodes = [new Root];
    }
    toString() {
      return this._root.render(this.opts);
    }
    name(prefix) {
      return this._scope.name(prefix);
    }
    scopeName(prefix) {
      return this._extScope.name(prefix);
    }
    scopeValue(prefixOrName, value) {
      const name = this._extScope.value(prefixOrName, value);
      const vs = this._values[name.prefix] || (this._values[name.prefix] = new Set);
      vs.add(name);
      return name;
    }
    getScopeValue(prefix, keyOrRef) {
      return this._extScope.getValue(prefix, keyOrRef);
    }
    scopeRefs(scopeName) {
      return this._extScope.scopeRefs(scopeName, this._values);
    }
    scopeCode() {
      return this._extScope.scopeCode(this._values);
    }
    _def(varKind, nameOrPrefix, rhs, constant) {
      const name = this._scope.toName(nameOrPrefix);
      if (rhs !== undefined && constant)
        this._constants[name.str] = rhs;
      this._leafNode(new Def(varKind, name, rhs));
      return name;
    }
    const(nameOrPrefix, rhs, _constant) {
      return this._def(scope_1.varKinds.const, nameOrPrefix, rhs, _constant);
    }
    let(nameOrPrefix, rhs, _constant) {
      return this._def(scope_1.varKinds.let, nameOrPrefix, rhs, _constant);
    }
    var(nameOrPrefix, rhs, _constant) {
      return this._def(scope_1.varKinds.var, nameOrPrefix, rhs, _constant);
    }
    assign(lhs, rhs, sideEffects) {
      return this._leafNode(new Assign(lhs, rhs, sideEffects));
    }
    add(lhs, rhs) {
      return this._leafNode(new AssignOp(lhs, exports.operators.ADD, rhs));
    }
    code(c) {
      if (typeof c == "function")
        c();
      else if (c !== code_1.nil)
        this._leafNode(new AnyCode(c));
      return this;
    }
    object(...keyValues) {
      const code = ["{"];
      for (const [key, value] of keyValues) {
        if (code.length > 1)
          code.push(",");
        code.push(key);
        if (key !== value || this.opts.es5) {
          code.push(":");
          (0, code_1.addCodeArg)(code, value);
        }
      }
      code.push("}");
      return new code_1._Code(code);
    }
    if(condition, thenBody, elseBody) {
      this._blockNode(new If(condition));
      if (thenBody && elseBody) {
        this.code(thenBody).else().code(elseBody).endIf();
      } else if (thenBody) {
        this.code(thenBody).endIf();
      } else if (elseBody) {
        throw new Error('CodeGen: "else" body without "then" body');
      }
      return this;
    }
    elseIf(condition) {
      return this._elseNode(new If(condition));
    }
    else() {
      return this._elseNode(new Else);
    }
    endIf() {
      return this._endBlockNode(If, Else);
    }
    _for(node, forBody) {
      this._blockNode(node);
      if (forBody)
        this.code(forBody).endFor();
      return this;
    }
    for(iteration, forBody) {
      return this._for(new ForLoop(iteration), forBody);
    }
    forRange(nameOrPrefix, from, to, forBody, varKind = this.opts.es5 ? scope_1.varKinds.var : scope_1.varKinds.let) {
      const name = this._scope.toName(nameOrPrefix);
      return this._for(new ForRange(varKind, name, from, to), () => forBody(name));
    }
    forOf(nameOrPrefix, iterable, forBody, varKind = scope_1.varKinds.const) {
      const name = this._scope.toName(nameOrPrefix);
      if (this.opts.es5) {
        const arr = iterable instanceof code_1.Name ? iterable : this.var("_arr", iterable);
        return this.forRange("_i", 0, (0, code_1._)`${arr}.length`, (i) => {
          this.var(name, (0, code_1._)`${arr}[${i}]`);
          forBody(name);
        });
      }
      return this._for(new ForIter("of", varKind, name, iterable), () => forBody(name));
    }
    forIn(nameOrPrefix, obj, forBody, varKind = this.opts.es5 ? scope_1.varKinds.var : scope_1.varKinds.const) {
      if (this.opts.ownProperties) {
        return this.forOf(nameOrPrefix, (0, code_1._)`Object.keys(${obj})`, forBody);
      }
      const name = this._scope.toName(nameOrPrefix);
      return this._for(new ForIter("in", varKind, name, obj), () => forBody(name));
    }
    endFor() {
      return this._endBlockNode(For);
    }
    label(label) {
      return this._leafNode(new Label(label));
    }
    break(label) {
      return this._leafNode(new Break(label));
    }
    return(value) {
      const node = new Return;
      this._blockNode(node);
      this.code(value);
      if (node.nodes.length !== 1)
        throw new Error('CodeGen: "return" should have one node');
      return this._endBlockNode(Return);
    }
    try(tryBody, catchCode, finallyCode) {
      if (!catchCode && !finallyCode)
        throw new Error('CodeGen: "try" without "catch" and "finally"');
      const node = new Try;
      this._blockNode(node);
      this.code(tryBody);
      if (catchCode) {
        const error = this.name("e");
        this._currNode = node.catch = new Catch(error);
        catchCode(error);
      }
      if (finallyCode) {
        this._currNode = node.finally = new Finally;
        this.code(finallyCode);
      }
      return this._endBlockNode(Catch, Finally);
    }
    throw(error) {
      return this._leafNode(new Throw(error));
    }
    block(body, nodeCount) {
      this._blockStarts.push(this._nodes.length);
      if (body)
        this.code(body).endBlock(nodeCount);
      return this;
    }
    endBlock(nodeCount) {
      const len = this._blockStarts.pop();
      if (len === undefined)
        throw new Error("CodeGen: not in self-balancing block");
      const toClose = this._nodes.length - len;
      if (toClose < 0 || nodeCount !== undefined && toClose !== nodeCount) {
        throw new Error(`CodeGen: wrong number of nodes: ${toClose} vs ${nodeCount} expected`);
      }
      this._nodes.length = len;
      return this;
    }
    func(name, args = code_1.nil, async, funcBody) {
      this._blockNode(new Func(name, args, async));
      if (funcBody)
        this.code(funcBody).endFunc();
      return this;
    }
    endFunc() {
      return this._endBlockNode(Func);
    }
    optimize(n = 1) {
      while (n-- > 0) {
        this._root.optimizeNodes();
        this._root.optimizeNames(this._root.names, this._constants);
      }
    }
    _leafNode(node) {
      this._currNode.nodes.push(node);
      return this;
    }
    _blockNode(node) {
      this._currNode.nodes.push(node);
      this._nodes.push(node);
    }
    _endBlockNode(N1, N2) {
      const n = this._currNode;
      if (n instanceof N1 || N2 && n instanceof N2) {
        this._nodes.pop();
        return this;
      }
      throw new Error(`CodeGen: not in block "${N2 ? `${N1.kind}/${N2.kind}` : N1.kind}"`);
    }
    _elseNode(node) {
      const n = this._currNode;
      if (!(n instanceof If)) {
        throw new Error('CodeGen: "else" without "if"');
      }
      this._currNode = n.else = node;
      return this;
    }
    get _root() {
      return this._nodes[0];
    }
    get _currNode() {
      const ns = this._nodes;
      return ns[ns.length - 1];
    }
    set _currNode(node) {
      const ns = this._nodes;
      ns[ns.length - 1] = node;
    }
  }
  exports.CodeGen = CodeGen;
  function addNames(names, from) {
    for (const n in from)
      names[n] = (names[n] || 0) + (from[n] || 0);
    return names;
  }
  function addExprNames(names, from) {
    return from instanceof code_1._CodeOrName ? addNames(names, from.names) : names;
  }
  function optimizeExpr(expr, names, constants) {
    if (expr instanceof code_1.Name)
      return replaceName(expr);
    if (!canOptimize(expr))
      return expr;
    return new code_1._Code(expr._items.reduce((items, c) => {
      if (c instanceof code_1.Name)
        c = replaceName(c);
      if (c instanceof code_1._Code)
        items.push(...c._items);
      else
        items.push(c);
      return items;
    }, []));
    function replaceName(n) {
      const c = constants[n.str];
      if (c === undefined || names[n.str] !== 1)
        return n;
      delete names[n.str];
      return c;
    }
    function canOptimize(e) {
      return e instanceof code_1._Code && e._items.some((c) => c instanceof code_1.Name && names[c.str] === 1 && constants[c.str] !== undefined);
    }
  }
  function subtractNames(names, from) {
    for (const n in from)
      names[n] = (names[n] || 0) - (from[n] || 0);
  }
  function not(x) {
    return typeof x == "boolean" || typeof x == "number" || x === null ? !x : (0, code_1._)`!${par(x)}`;
  }
  exports.not = not;
  var andCode = mappend(exports.operators.AND);
  function and(...args) {
    return args.reduce(andCode);
  }
  exports.and = and;
  var orCode = mappend(exports.operators.OR);
  function or(...args) {
    return args.reduce(orCode);
  }
  exports.or = or;
  function mappend(op) {
    return (x, y) => x === code_1.nil ? y : y === code_1.nil ? x : (0, code_1._)`${par(x)} ${op} ${par(y)}`;
  }
  function par(x) {
    return x instanceof code_1.Name ? x : (0, code_1._)`(${x})`;
  }
});

// node_modules/ajv/dist/compile/util.js
var require_util = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.checkStrictMode = exports.getErrorPath = exports.Type = exports.useFunc = exports.setEvaluated = exports.evaluatedPropsToName = exports.mergeEvaluated = exports.eachItem = exports.unescapeJsonPointer = exports.escapeJsonPointer = exports.escapeFragment = exports.unescapeFragment = exports.schemaRefOrVal = exports.schemaHasRulesButRef = exports.schemaHasRules = exports.checkUnknownRules = exports.alwaysValidSchema = exports.toHash = undefined;
  var codegen_1 = require_codegen();
  var code_1 = require_code();
  function toHash(arr) {
    const hash = {};
    for (const item of arr)
      hash[item] = true;
    return hash;
  }
  exports.toHash = toHash;
  function alwaysValidSchema(it, schema) {
    if (typeof schema == "boolean")
      return schema;
    if (Object.keys(schema).length === 0)
      return true;
    checkUnknownRules(it, schema);
    return !schemaHasRules(schema, it.self.RULES.all);
  }
  exports.alwaysValidSchema = alwaysValidSchema;
  function checkUnknownRules(it, schema = it.schema) {
    const { opts, self } = it;
    if (!opts.strictSchema)
      return;
    if (typeof schema === "boolean")
      return;
    const rules = self.RULES.keywords;
    for (const key in schema) {
      if (!rules[key])
        checkStrictMode(it, `unknown keyword: "${key}"`);
    }
  }
  exports.checkUnknownRules = checkUnknownRules;
  function schemaHasRules(schema, rules) {
    if (typeof schema == "boolean")
      return !schema;
    for (const key in schema)
      if (rules[key])
        return true;
    return false;
  }
  exports.schemaHasRules = schemaHasRules;
  function schemaHasRulesButRef(schema, RULES) {
    if (typeof schema == "boolean")
      return !schema;
    for (const key in schema)
      if (key !== "$ref" && RULES.all[key])
        return true;
    return false;
  }
  exports.schemaHasRulesButRef = schemaHasRulesButRef;
  function schemaRefOrVal({ topSchemaRef, schemaPath }, schema, keyword, $data) {
    if (!$data) {
      if (typeof schema == "number" || typeof schema == "boolean")
        return schema;
      if (typeof schema == "string")
        return (0, codegen_1._)`${schema}`;
    }
    return (0, codegen_1._)`${topSchemaRef}${schemaPath}${(0, codegen_1.getProperty)(keyword)}`;
  }
  exports.schemaRefOrVal = schemaRefOrVal;
  function unescapeFragment(str) {
    return unescapeJsonPointer(decodeURIComponent(str));
  }
  exports.unescapeFragment = unescapeFragment;
  function escapeFragment(str) {
    return encodeURIComponent(escapeJsonPointer(str));
  }
  exports.escapeFragment = escapeFragment;
  function escapeJsonPointer(str) {
    if (typeof str == "number")
      return `${str}`;
    return str.replace(/~/g, "~0").replace(/\//g, "~1");
  }
  exports.escapeJsonPointer = escapeJsonPointer;
  function unescapeJsonPointer(str) {
    return str.replace(/~1/g, "/").replace(/~0/g, "~");
  }
  exports.unescapeJsonPointer = unescapeJsonPointer;
  function eachItem(xs, f) {
    if (Array.isArray(xs)) {
      for (const x of xs)
        f(x);
    } else {
      f(xs);
    }
  }
  exports.eachItem = eachItem;
  function makeMergeEvaluated({ mergeNames, mergeToName, mergeValues, resultToName }) {
    return (gen, from, to, toName) => {
      const res = to === undefined ? from : to instanceof codegen_1.Name ? (from instanceof codegen_1.Name ? mergeNames(gen, from, to) : mergeToName(gen, from, to), to) : from instanceof codegen_1.Name ? (mergeToName(gen, to, from), from) : mergeValues(from, to);
      return toName === codegen_1.Name && !(res instanceof codegen_1.Name) ? resultToName(gen, res) : res;
    };
  }
  exports.mergeEvaluated = {
    props: makeMergeEvaluated({
      mergeNames: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true && ${from} !== undefined`, () => {
        gen.if((0, codegen_1._)`${from} === true`, () => gen.assign(to, true), () => gen.assign(to, (0, codegen_1._)`${to} || {}`).code((0, codegen_1._)`Object.assign(${to}, ${from})`));
      }),
      mergeToName: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true`, () => {
        if (from === true) {
          gen.assign(to, true);
        } else {
          gen.assign(to, (0, codegen_1._)`${to} || {}`);
          setEvaluated(gen, to, from);
        }
      }),
      mergeValues: (from, to) => from === true ? true : { ...from, ...to },
      resultToName: evaluatedPropsToName
    }),
    items: makeMergeEvaluated({
      mergeNames: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true && ${from} !== undefined`, () => gen.assign(to, (0, codegen_1._)`${from} === true ? true : ${to} > ${from} ? ${to} : ${from}`)),
      mergeToName: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true`, () => gen.assign(to, from === true ? true : (0, codegen_1._)`${to} > ${from} ? ${to} : ${from}`)),
      mergeValues: (from, to) => from === true ? true : Math.max(from, to),
      resultToName: (gen, items) => gen.var("items", items)
    })
  };
  function evaluatedPropsToName(gen, ps) {
    if (ps === true)
      return gen.var("props", true);
    const props = gen.var("props", (0, codegen_1._)`{}`);
    if (ps !== undefined)
      setEvaluated(gen, props, ps);
    return props;
  }
  exports.evaluatedPropsToName = evaluatedPropsToName;
  function setEvaluated(gen, props, ps) {
    Object.keys(ps).forEach((p) => gen.assign((0, codegen_1._)`${props}${(0, codegen_1.getProperty)(p)}`, true));
  }
  exports.setEvaluated = setEvaluated;
  var snippets = {};
  function useFunc(gen, f) {
    return gen.scopeValue("func", {
      ref: f,
      code: snippets[f.code] || (snippets[f.code] = new code_1._Code(f.code))
    });
  }
  exports.useFunc = useFunc;
  var Type;
  (function(Type2) {
    Type2[Type2["Num"] = 0] = "Num";
    Type2[Type2["Str"] = 1] = "Str";
  })(Type || (exports.Type = Type = {}));
  function getErrorPath(dataProp, dataPropType, jsPropertySyntax) {
    if (dataProp instanceof codegen_1.Name) {
      const isNumber = dataPropType === Type.Num;
      return jsPropertySyntax ? isNumber ? (0, codegen_1._)`"[" + ${dataProp} + "]"` : (0, codegen_1._)`"['" + ${dataProp} + "']"` : isNumber ? (0, codegen_1._)`"/" + ${dataProp}` : (0, codegen_1._)`"/" + ${dataProp}.replace(/~/g, "~0").replace(/\\//g, "~1")`;
    }
    return jsPropertySyntax ? (0, codegen_1.getProperty)(dataProp).toString() : "/" + escapeJsonPointer(dataProp);
  }
  exports.getErrorPath = getErrorPath;
  function checkStrictMode(it, msg, mode = it.opts.strictSchema) {
    if (!mode)
      return;
    msg = `strict mode: ${msg}`;
    if (mode === true)
      throw new Error(msg);
    it.self.logger.warn(msg);
  }
  exports.checkStrictMode = checkStrictMode;
});

// node_modules/ajv/dist/compile/names.js
var require_names = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var codegen_1 = require_codegen();
  var names = {
    data: new codegen_1.Name("data"),
    valCxt: new codegen_1.Name("valCxt"),
    instancePath: new codegen_1.Name("instancePath"),
    parentData: new codegen_1.Name("parentData"),
    parentDataProperty: new codegen_1.Name("parentDataProperty"),
    rootData: new codegen_1.Name("rootData"),
    dynamicAnchors: new codegen_1.Name("dynamicAnchors"),
    vErrors: new codegen_1.Name("vErrors"),
    errors: new codegen_1.Name("errors"),
    this: new codegen_1.Name("this"),
    self: new codegen_1.Name("self"),
    scope: new codegen_1.Name("scope"),
    json: new codegen_1.Name("json"),
    jsonPos: new codegen_1.Name("jsonPos"),
    jsonLen: new codegen_1.Name("jsonLen"),
    jsonPart: new codegen_1.Name("jsonPart")
  };
  exports.default = names;
});

// node_modules/ajv/dist/compile/errors.js
var require_errors = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.extendErrors = exports.resetErrorsCount = exports.reportExtraError = exports.reportError = exports.keyword$DataError = exports.keywordError = undefined;
  var codegen_1 = require_codegen();
  var util_1 = require_util();
  var names_1 = require_names();
  exports.keywordError = {
    message: ({ keyword }) => (0, codegen_1.str)`must pass "${keyword}" keyword validation`
  };
  exports.keyword$DataError = {
    message: ({ keyword, schemaType }) => schemaType ? (0, codegen_1.str)`"${keyword}" keyword must be ${schemaType} ($data)` : (0, codegen_1.str)`"${keyword}" keyword is invalid ($data)`
  };
  function reportError(cxt, error = exports.keywordError, errorPaths, overrideAllErrors) {
    const { it } = cxt;
    const { gen, compositeRule, allErrors } = it;
    const errObj = errorObjectCode(cxt, error, errorPaths);
    if (overrideAllErrors !== null && overrideAllErrors !== undefined ? overrideAllErrors : compositeRule || allErrors) {
      addError(gen, errObj);
    } else {
      returnErrors(it, (0, codegen_1._)`[${errObj}]`);
    }
  }
  exports.reportError = reportError;
  function reportExtraError(cxt, error = exports.keywordError, errorPaths) {
    const { it } = cxt;
    const { gen, compositeRule, allErrors } = it;
    const errObj = errorObjectCode(cxt, error, errorPaths);
    addError(gen, errObj);
    if (!(compositeRule || allErrors)) {
      returnErrors(it, names_1.default.vErrors);
    }
  }
  exports.reportExtraError = reportExtraError;
  function resetErrorsCount(gen, errsCount) {
    gen.assign(names_1.default.errors, errsCount);
    gen.if((0, codegen_1._)`${names_1.default.vErrors} !== null`, () => gen.if(errsCount, () => gen.assign((0, codegen_1._)`${names_1.default.vErrors}.length`, errsCount), () => gen.assign(names_1.default.vErrors, null)));
  }
  exports.resetErrorsCount = resetErrorsCount;
  function extendErrors({ gen, keyword, schemaValue, data, errsCount, it }) {
    if (errsCount === undefined)
      throw new Error("ajv implementation error");
    const err = gen.name("err");
    gen.forRange("i", errsCount, names_1.default.errors, (i) => {
      gen.const(err, (0, codegen_1._)`${names_1.default.vErrors}[${i}]`);
      gen.if((0, codegen_1._)`${err}.instancePath === undefined`, () => gen.assign((0, codegen_1._)`${err}.instancePath`, (0, codegen_1.strConcat)(names_1.default.instancePath, it.errorPath)));
      gen.assign((0, codegen_1._)`${err}.schemaPath`, (0, codegen_1.str)`${it.errSchemaPath}/${keyword}`);
      if (it.opts.verbose) {
        gen.assign((0, codegen_1._)`${err}.schema`, schemaValue);
        gen.assign((0, codegen_1._)`${err}.data`, data);
      }
    });
  }
  exports.extendErrors = extendErrors;
  function addError(gen, errObj) {
    const err = gen.const("err", errObj);
    gen.if((0, codegen_1._)`${names_1.default.vErrors} === null`, () => gen.assign(names_1.default.vErrors, (0, codegen_1._)`[${err}]`), (0, codegen_1._)`${names_1.default.vErrors}.push(${err})`);
    gen.code((0, codegen_1._)`${names_1.default.errors}++`);
  }
  function returnErrors(it, errs) {
    const { gen, validateName, schemaEnv } = it;
    if (schemaEnv.$async) {
      gen.throw((0, codegen_1._)`new ${it.ValidationError}(${errs})`);
    } else {
      gen.assign((0, codegen_1._)`${validateName}.errors`, errs);
      gen.return(false);
    }
  }
  var E = {
    keyword: new codegen_1.Name("keyword"),
    schemaPath: new codegen_1.Name("schemaPath"),
    params: new codegen_1.Name("params"),
    propertyName: new codegen_1.Name("propertyName"),
    message: new codegen_1.Name("message"),
    schema: new codegen_1.Name("schema"),
    parentSchema: new codegen_1.Name("parentSchema")
  };
  function errorObjectCode(cxt, error, errorPaths) {
    const { createErrors } = cxt.it;
    if (createErrors === false)
      return (0, codegen_1._)`{}`;
    return errorObject(cxt, error, errorPaths);
  }
  function errorObject(cxt, error, errorPaths = {}) {
    const { gen, it } = cxt;
    const keyValues = [
      errorInstancePath(it, errorPaths),
      errorSchemaPath(cxt, errorPaths)
    ];
    extraErrorProps(cxt, error, keyValues);
    return gen.object(...keyValues);
  }
  function errorInstancePath({ errorPath }, { instancePath }) {
    const instPath = instancePath ? (0, codegen_1.str)`${errorPath}${(0, util_1.getErrorPath)(instancePath, util_1.Type.Str)}` : errorPath;
    return [names_1.default.instancePath, (0, codegen_1.strConcat)(names_1.default.instancePath, instPath)];
  }
  function errorSchemaPath({ keyword, it: { errSchemaPath } }, { schemaPath, parentSchema }) {
    let schPath = parentSchema ? errSchemaPath : (0, codegen_1.str)`${errSchemaPath}/${keyword}`;
    if (schemaPath) {
      schPath = (0, codegen_1.str)`${schPath}${(0, util_1.getErrorPath)(schemaPath, util_1.Type.Str)}`;
    }
    return [E.schemaPath, schPath];
  }
  function extraErrorProps(cxt, { params, message }, keyValues) {
    const { keyword, data, schemaValue, it } = cxt;
    const { opts, propertyName, topSchemaRef, schemaPath } = it;
    keyValues.push([E.keyword, keyword], [E.params, typeof params == "function" ? params(cxt) : params || (0, codegen_1._)`{}`]);
    if (opts.messages) {
      keyValues.push([E.message, typeof message == "function" ? message(cxt) : message]);
    }
    if (opts.verbose) {
      keyValues.push([E.schema, schemaValue], [E.parentSchema, (0, codegen_1._)`${topSchemaRef}${schemaPath}`], [names_1.default.data, data]);
    }
    if (propertyName)
      keyValues.push([E.propertyName, propertyName]);
  }
});

// node_modules/ajv/dist/compile/validate/boolSchema.js
var require_boolSchema = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.boolOrEmptySchema = exports.topBoolOrEmptySchema = undefined;
  var errors_1 = require_errors();
  var codegen_1 = require_codegen();
  var names_1 = require_names();
  var boolError = {
    message: "boolean schema is false"
  };
  function topBoolOrEmptySchema(it) {
    const { gen, schema, validateName } = it;
    if (schema === false) {
      falseSchemaError(it, false);
    } else if (typeof schema == "object" && schema.$async === true) {
      gen.return(names_1.default.data);
    } else {
      gen.assign((0, codegen_1._)`${validateName}.errors`, null);
      gen.return(true);
    }
  }
  exports.topBoolOrEmptySchema = topBoolOrEmptySchema;
  function boolOrEmptySchema(it, valid) {
    const { gen, schema } = it;
    if (schema === false) {
      gen.var(valid, false);
      falseSchemaError(it);
    } else {
      gen.var(valid, true);
    }
  }
  exports.boolOrEmptySchema = boolOrEmptySchema;
  function falseSchemaError(it, overrideAllErrors) {
    const { gen, data } = it;
    const cxt = {
      gen,
      keyword: "false schema",
      data,
      schema: false,
      schemaCode: false,
      schemaValue: false,
      params: {},
      it
    };
    (0, errors_1.reportError)(cxt, boolError, undefined, overrideAllErrors);
  }
});

// node_modules/ajv/dist/compile/rules.js
var require_rules = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.getRules = exports.isJSONType = undefined;
  var _jsonTypes = ["string", "number", "integer", "boolean", "null", "object", "array"];
  var jsonTypes = new Set(_jsonTypes);
  function isJSONType(x) {
    return typeof x == "string" && jsonTypes.has(x);
  }
  exports.isJSONType = isJSONType;
  function getRules() {
    const groups = {
      number: { type: "number", rules: [] },
      string: { type: "string", rules: [] },
      array: { type: "array", rules: [] },
      object: { type: "object", rules: [] }
    };
    return {
      types: { ...groups, integer: true, boolean: true, null: true },
      rules: [{ rules: [] }, groups.number, groups.string, groups.array, groups.object],
      post: { rules: [] },
      all: {},
      keywords: {}
    };
  }
  exports.getRules = getRules;
});

// node_modules/ajv/dist/compile/validate/applicability.js
var require_applicability = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.shouldUseRule = exports.shouldUseGroup = exports.schemaHasRulesForType = undefined;
  function schemaHasRulesForType({ schema, self }, type) {
    const group = self.RULES.types[type];
    return group && group !== true && shouldUseGroup(schema, group);
  }
  exports.schemaHasRulesForType = schemaHasRulesForType;
  function shouldUseGroup(schema, group) {
    return group.rules.some((rule) => shouldUseRule(schema, rule));
  }
  exports.shouldUseGroup = shouldUseGroup;
  function shouldUseRule(schema, rule) {
    var _a;
    return schema[rule.keyword] !== undefined || ((_a = rule.definition.implements) === null || _a === undefined ? undefined : _a.some((kwd) => schema[kwd] !== undefined));
  }
  exports.shouldUseRule = shouldUseRule;
});

// node_modules/ajv/dist/compile/validate/dataType.js
var require_dataType = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.reportTypeError = exports.checkDataTypes = exports.checkDataType = exports.coerceAndCheckDataType = exports.getJSONTypes = exports.getSchemaTypes = exports.DataType = undefined;
  var rules_1 = require_rules();
  var applicability_1 = require_applicability();
  var errors_1 = require_errors();
  var codegen_1 = require_codegen();
  var util_1 = require_util();
  var DataType;
  (function(DataType2) {
    DataType2[DataType2["Correct"] = 0] = "Correct";
    DataType2[DataType2["Wrong"] = 1] = "Wrong";
  })(DataType || (exports.DataType = DataType = {}));
  function getSchemaTypes(schema) {
    const types = getJSONTypes(schema.type);
    const hasNull = types.includes("null");
    if (hasNull) {
      if (schema.nullable === false)
        throw new Error("type: null contradicts nullable: false");
    } else {
      if (!types.length && schema.nullable !== undefined) {
        throw new Error('"nullable" cannot be used without "type"');
      }
      if (schema.nullable === true)
        types.push("null");
    }
    return types;
  }
  exports.getSchemaTypes = getSchemaTypes;
  function getJSONTypes(ts) {
    const types = Array.isArray(ts) ? ts : ts ? [ts] : [];
    if (types.every(rules_1.isJSONType))
      return types;
    throw new Error("type must be JSONType or JSONType[]: " + types.join(","));
  }
  exports.getJSONTypes = getJSONTypes;
  function coerceAndCheckDataType(it, types) {
    const { gen, data, opts } = it;
    const coerceTo = coerceToTypes(types, opts.coerceTypes);
    const checkTypes = types.length > 0 && !(coerceTo.length === 0 && types.length === 1 && (0, applicability_1.schemaHasRulesForType)(it, types[0]));
    if (checkTypes) {
      const wrongType = checkDataTypes(types, data, opts.strictNumbers, DataType.Wrong);
      gen.if(wrongType, () => {
        if (coerceTo.length)
          coerceData(it, types, coerceTo);
        else
          reportTypeError(it);
      });
    }
    return checkTypes;
  }
  exports.coerceAndCheckDataType = coerceAndCheckDataType;
  var COERCIBLE = new Set(["string", "number", "integer", "boolean", "null"]);
  function coerceToTypes(types, coerceTypes) {
    return coerceTypes ? types.filter((t) => COERCIBLE.has(t) || coerceTypes === "array" && t === "array") : [];
  }
  function coerceData(it, types, coerceTo) {
    const { gen, data, opts } = it;
    const dataType = gen.let("dataType", (0, codegen_1._)`typeof ${data}`);
    const coerced = gen.let("coerced", (0, codegen_1._)`undefined`);
    if (opts.coerceTypes === "array") {
      gen.if((0, codegen_1._)`${dataType} == 'object' && Array.isArray(${data}) && ${data}.length == 1`, () => gen.assign(data, (0, codegen_1._)`${data}[0]`).assign(dataType, (0, codegen_1._)`typeof ${data}`).if(checkDataTypes(types, data, opts.strictNumbers), () => gen.assign(coerced, data)));
    }
    gen.if((0, codegen_1._)`${coerced} !== undefined`);
    for (const t of coerceTo) {
      if (COERCIBLE.has(t) || t === "array" && opts.coerceTypes === "array") {
        coerceSpecificType(t);
      }
    }
    gen.else();
    reportTypeError(it);
    gen.endIf();
    gen.if((0, codegen_1._)`${coerced} !== undefined`, () => {
      gen.assign(data, coerced);
      assignParentData(it, coerced);
    });
    function coerceSpecificType(t) {
      switch (t) {
        case "string":
          gen.elseIf((0, codegen_1._)`${dataType} == "number" || ${dataType} == "boolean"`).assign(coerced, (0, codegen_1._)`"" + ${data}`).elseIf((0, codegen_1._)`${data} === null`).assign(coerced, (0, codegen_1._)`""`);
          return;
        case "number":
          gen.elseIf((0, codegen_1._)`${dataType} == "boolean" || ${data} === null
              || (${dataType} == "string" && ${data} && ${data} == +${data})`).assign(coerced, (0, codegen_1._)`+${data}`);
          return;
        case "integer":
          gen.elseIf((0, codegen_1._)`${dataType} === "boolean" || ${data} === null
              || (${dataType} === "string" && ${data} && ${data} == +${data} && !(${data} % 1))`).assign(coerced, (0, codegen_1._)`+${data}`);
          return;
        case "boolean":
          gen.elseIf((0, codegen_1._)`${data} === "false" || ${data} === 0 || ${data} === null`).assign(coerced, false).elseIf((0, codegen_1._)`${data} === "true" || ${data} === 1`).assign(coerced, true);
          return;
        case "null":
          gen.elseIf((0, codegen_1._)`${data} === "" || ${data} === 0 || ${data} === false`);
          gen.assign(coerced, null);
          return;
        case "array":
          gen.elseIf((0, codegen_1._)`${dataType} === "string" || ${dataType} === "number"
              || ${dataType} === "boolean" || ${data} === null`).assign(coerced, (0, codegen_1._)`[${data}]`);
      }
    }
  }
  function assignParentData({ gen, parentData, parentDataProperty }, expr) {
    gen.if((0, codegen_1._)`${parentData} !== undefined`, () => gen.assign((0, codegen_1._)`${parentData}[${parentDataProperty}]`, expr));
  }
  function checkDataType(dataType, data, strictNums, correct = DataType.Correct) {
    const EQ = correct === DataType.Correct ? codegen_1.operators.EQ : codegen_1.operators.NEQ;
    let cond;
    switch (dataType) {
      case "null":
        return (0, codegen_1._)`${data} ${EQ} null`;
      case "array":
        cond = (0, codegen_1._)`Array.isArray(${data})`;
        break;
      case "object":
        cond = (0, codegen_1._)`${data} && typeof ${data} == "object" && !Array.isArray(${data})`;
        break;
      case "integer":
        cond = numCond((0, codegen_1._)`!(${data} % 1) && !isNaN(${data})`);
        break;
      case "number":
        cond = numCond();
        break;
      default:
        return (0, codegen_1._)`typeof ${data} ${EQ} ${dataType}`;
    }
    return correct === DataType.Correct ? cond : (0, codegen_1.not)(cond);
    function numCond(_cond = codegen_1.nil) {
      return (0, codegen_1.and)((0, codegen_1._)`typeof ${data} == "number"`, _cond, strictNums ? (0, codegen_1._)`isFinite(${data})` : codegen_1.nil);
    }
  }
  exports.checkDataType = checkDataType;
  function checkDataTypes(dataTypes, data, strictNums, correct) {
    if (dataTypes.length === 1) {
      return checkDataType(dataTypes[0], data, strictNums, correct);
    }
    let cond;
    const types = (0, util_1.toHash)(dataTypes);
    if (types.array && types.object) {
      const notObj = (0, codegen_1._)`typeof ${data} != "object"`;
      cond = types.null ? notObj : (0, codegen_1._)`!${data} || ${notObj}`;
      delete types.null;
      delete types.array;
      delete types.object;
    } else {
      cond = codegen_1.nil;
    }
    if (types.number)
      delete types.integer;
    for (const t in types)
      cond = (0, codegen_1.and)(cond, checkDataType(t, data, strictNums, correct));
    return cond;
  }
  exports.checkDataTypes = checkDataTypes;
  var typeError = {
    message: ({ schema }) => `must be ${schema}`,
    params: ({ schema, schemaValue }) => typeof schema == "string" ? (0, codegen_1._)`{type: ${schema}}` : (0, codegen_1._)`{type: ${schemaValue}}`
  };
  function reportTypeError(it) {
    const cxt = getTypeErrorContext(it);
    (0, errors_1.reportError)(cxt, typeError);
  }
  exports.reportTypeError = reportTypeError;
  function getTypeErrorContext(it) {
    const { gen, data, schema } = it;
    const schemaCode = (0, util_1.schemaRefOrVal)(it, schema, "type");
    return {
      gen,
      keyword: "type",
      data,
      schema: schema.type,
      schemaCode,
      schemaValue: schemaCode,
      parentSchema: schema,
      params: {},
      it
    };
  }
});

// node_modules/ajv/dist/compile/validate/defaults.js
var require_defaults = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.assignDefaults = undefined;
  var codegen_1 = require_codegen();
  var util_1 = require_util();
  function assignDefaults(it, ty) {
    const { properties, items } = it.schema;
    if (ty === "object" && properties) {
      for (const key in properties) {
        assignDefault(it, key, properties[key].default);
      }
    } else if (ty === "array" && Array.isArray(items)) {
      items.forEach((sch, i) => assignDefault(it, i, sch.default));
    }
  }
  exports.assignDefaults = assignDefaults;
  function assignDefault(it, prop, defaultValue) {
    const { gen, compositeRule, data, opts } = it;
    if (defaultValue === undefined)
      return;
    const childData = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(prop)}`;
    if (compositeRule) {
      (0, util_1.checkStrictMode)(it, `default is ignored for: ${childData}`);
      return;
    }
    let condition = (0, codegen_1._)`${childData} === undefined`;
    if (opts.useDefaults === "empty") {
      condition = (0, codegen_1._)`${condition} || ${childData} === null || ${childData} === ""`;
    }
    gen.if(condition, (0, codegen_1._)`${childData} = ${(0, codegen_1.stringify)(defaultValue)}`);
  }
});

// node_modules/ajv/dist/vocabularies/code.js
var require_code2 = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.validateUnion = exports.validateArray = exports.usePattern = exports.callValidateCode = exports.schemaProperties = exports.allSchemaProperties = exports.noPropertyInData = exports.propertyInData = exports.isOwnProperty = exports.hasPropFunc = exports.reportMissingProp = exports.checkMissingProp = exports.checkReportMissingProp = undefined;
  var codegen_1 = require_codegen();
  var util_1 = require_util();
  var names_1 = require_names();
  var util_2 = require_util();
  function checkReportMissingProp(cxt, prop) {
    const { gen, data, it } = cxt;
    gen.if(noPropertyInData(gen, data, prop, it.opts.ownProperties), () => {
      cxt.setParams({ missingProperty: (0, codegen_1._)`${prop}` }, true);
      cxt.error();
    });
  }
  exports.checkReportMissingProp = checkReportMissingProp;
  function checkMissingProp({ gen, data, it: { opts } }, properties, missing) {
    return (0, codegen_1.or)(...properties.map((prop) => (0, codegen_1.and)(noPropertyInData(gen, data, prop, opts.ownProperties), (0, codegen_1._)`${missing} = ${prop}`)));
  }
  exports.checkMissingProp = checkMissingProp;
  function reportMissingProp(cxt, missing) {
    cxt.setParams({ missingProperty: missing }, true);
    cxt.error();
  }
  exports.reportMissingProp = reportMissingProp;
  function hasPropFunc(gen) {
    return gen.scopeValue("func", {
      ref: Object.prototype.hasOwnProperty,
      code: (0, codegen_1._)`Object.prototype.hasOwnProperty`
    });
  }
  exports.hasPropFunc = hasPropFunc;
  function isOwnProperty(gen, data, property) {
    return (0, codegen_1._)`${hasPropFunc(gen)}.call(${data}, ${property})`;
  }
  exports.isOwnProperty = isOwnProperty;
  function propertyInData(gen, data, property, ownProperties) {
    const cond = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(property)} !== undefined`;
    return ownProperties ? (0, codegen_1._)`${cond} && ${isOwnProperty(gen, data, property)}` : cond;
  }
  exports.propertyInData = propertyInData;
  function noPropertyInData(gen, data, property, ownProperties) {
    const cond = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(property)} === undefined`;
    return ownProperties ? (0, codegen_1.or)(cond, (0, codegen_1.not)(isOwnProperty(gen, data, property))) : cond;
  }
  exports.noPropertyInData = noPropertyInData;
  function allSchemaProperties(schemaMap) {
    return schemaMap ? Object.keys(schemaMap).filter((p) => p !== "__proto__") : [];
  }
  exports.allSchemaProperties = allSchemaProperties;
  function schemaProperties(it, schemaMap) {
    return allSchemaProperties(schemaMap).filter((p) => !(0, util_1.alwaysValidSchema)(it, schemaMap[p]));
  }
  exports.schemaProperties = schemaProperties;
  function callValidateCode({ schemaCode, data, it: { gen, topSchemaRef, schemaPath, errorPath }, it }, func, context, passSchema) {
    const dataAndSchema = passSchema ? (0, codegen_1._)`${schemaCode}, ${data}, ${topSchemaRef}${schemaPath}` : data;
    const valCxt = [
      [names_1.default.instancePath, (0, codegen_1.strConcat)(names_1.default.instancePath, errorPath)],
      [names_1.default.parentData, it.parentData],
      [names_1.default.parentDataProperty, it.parentDataProperty],
      [names_1.default.rootData, names_1.default.rootData]
    ];
    if (it.opts.dynamicRef)
      valCxt.push([names_1.default.dynamicAnchors, names_1.default.dynamicAnchors]);
    const args = (0, codegen_1._)`${dataAndSchema}, ${gen.object(...valCxt)}`;
    return context !== codegen_1.nil ? (0, codegen_1._)`${func}.call(${context}, ${args})` : (0, codegen_1._)`${func}(${args})`;
  }
  exports.callValidateCode = callValidateCode;
  var newRegExp = (0, codegen_1._)`new RegExp`;
  function usePattern({ gen, it: { opts } }, pattern) {
    const u = opts.unicodeRegExp ? "u" : "";
    const { regExp } = opts.code;
    const rx = regExp(pattern, u);
    return gen.scopeValue("pattern", {
      key: rx.toString(),
      ref: rx,
      code: (0, codegen_1._)`${regExp.code === "new RegExp" ? newRegExp : (0, util_2.useFunc)(gen, regExp)}(${pattern}, ${u})`
    });
  }
  exports.usePattern = usePattern;
  function validateArray(cxt) {
    const { gen, data, keyword, it } = cxt;
    const valid = gen.name("valid");
    if (it.allErrors) {
      const validArr = gen.let("valid", true);
      validateItems(() => gen.assign(validArr, false));
      return validArr;
    }
    gen.var(valid, true);
    validateItems(() => gen.break());
    return valid;
    function validateItems(notValid) {
      const len = gen.const("len", (0, codegen_1._)`${data}.length`);
      gen.forRange("i", 0, len, (i) => {
        cxt.subschema({
          keyword,
          dataProp: i,
          dataPropType: util_1.Type.Num
        }, valid);
        gen.if((0, codegen_1.not)(valid), notValid);
      });
    }
  }
  exports.validateArray = validateArray;
  function validateUnion(cxt) {
    const { gen, schema, keyword, it } = cxt;
    if (!Array.isArray(schema))
      throw new Error("ajv implementation error");
    const alwaysValid = schema.some((sch) => (0, util_1.alwaysValidSchema)(it, sch));
    if (alwaysValid && !it.opts.unevaluated)
      return;
    const valid = gen.let("valid", false);
    const schValid = gen.name("_valid");
    gen.block(() => schema.forEach((_sch, i) => {
      const schCxt = cxt.subschema({
        keyword,
        schemaProp: i,
        compositeRule: true
      }, schValid);
      gen.assign(valid, (0, codegen_1._)`${valid} || ${schValid}`);
      const merged = cxt.mergeValidEvaluated(schCxt, schValid);
      if (!merged)
        gen.if((0, codegen_1.not)(valid));
    }));
    cxt.result(valid, () => cxt.reset(), () => cxt.error(true));
  }
  exports.validateUnion = validateUnion;
});

// node_modules/ajv/dist/compile/validate/keyword.js
var require_keyword = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.validateKeywordUsage = exports.validSchemaType = exports.funcKeywordCode = exports.macroKeywordCode = undefined;
  var codegen_1 = require_codegen();
  var names_1 = require_names();
  var code_1 = require_code2();
  var errors_1 = require_errors();
  function macroKeywordCode(cxt, def) {
    const { gen, keyword, schema, parentSchema, it } = cxt;
    const macroSchema = def.macro.call(it.self, schema, parentSchema, it);
    const schemaRef = useKeyword(gen, keyword, macroSchema);
    if (it.opts.validateSchema !== false)
      it.self.validateSchema(macroSchema, true);
    const valid = gen.name("valid");
    cxt.subschema({
      schema: macroSchema,
      schemaPath: codegen_1.nil,
      errSchemaPath: `${it.errSchemaPath}/${keyword}`,
      topSchemaRef: schemaRef,
      compositeRule: true
    }, valid);
    cxt.pass(valid, () => cxt.error(true));
  }
  exports.macroKeywordCode = macroKeywordCode;
  function funcKeywordCode(cxt, def) {
    var _a;
    const { gen, keyword, schema, parentSchema, $data, it } = cxt;
    checkAsyncKeyword(it, def);
    const validate = !$data && def.compile ? def.compile.call(it.self, schema, parentSchema, it) : def.validate;
    const validateRef = useKeyword(gen, keyword, validate);
    const valid = gen.let("valid");
    cxt.block$data(valid, validateKeyword);
    cxt.ok((_a = def.valid) !== null && _a !== undefined ? _a : valid);
    function validateKeyword() {
      if (def.errors === false) {
        assignValid();
        if (def.modifying)
          modifyData(cxt);
        reportErrs(() => cxt.error());
      } else {
        const ruleErrs = def.async ? validateAsync() : validateSync();
        if (def.modifying)
          modifyData(cxt);
        reportErrs(() => addErrs(cxt, ruleErrs));
      }
    }
    function validateAsync() {
      const ruleErrs = gen.let("ruleErrs", null);
      gen.try(() => assignValid((0, codegen_1._)`await `), (e) => gen.assign(valid, false).if((0, codegen_1._)`${e} instanceof ${it.ValidationError}`, () => gen.assign(ruleErrs, (0, codegen_1._)`${e}.errors`), () => gen.throw(e)));
      return ruleErrs;
    }
    function validateSync() {
      const validateErrs = (0, codegen_1._)`${validateRef}.errors`;
      gen.assign(validateErrs, null);
      assignValid(codegen_1.nil);
      return validateErrs;
    }
    function assignValid(_await = def.async ? (0, codegen_1._)`await ` : codegen_1.nil) {
      const passCxt = it.opts.passContext ? names_1.default.this : names_1.default.self;
      const passSchema = !(("compile" in def) && !$data || def.schema === false);
      gen.assign(valid, (0, codegen_1._)`${_await}${(0, code_1.callValidateCode)(cxt, validateRef, passCxt, passSchema)}`, def.modifying);
    }
    function reportErrs(errors) {
      var _a2;
      gen.if((0, codegen_1.not)((_a2 = def.valid) !== null && _a2 !== undefined ? _a2 : valid), errors);
    }
  }
  exports.funcKeywordCode = funcKeywordCode;
  function modifyData(cxt) {
    const { gen, data, it } = cxt;
    gen.if(it.parentData, () => gen.assign(data, (0, codegen_1._)`${it.parentData}[${it.parentDataProperty}]`));
  }
  function addErrs(cxt, errs) {
    const { gen } = cxt;
    gen.if((0, codegen_1._)`Array.isArray(${errs})`, () => {
      gen.assign(names_1.default.vErrors, (0, codegen_1._)`${names_1.default.vErrors} === null ? ${errs} : ${names_1.default.vErrors}.concat(${errs})`).assign(names_1.default.errors, (0, codegen_1._)`${names_1.default.vErrors}.length`);
      (0, errors_1.extendErrors)(cxt);
    }, () => cxt.error());
  }
  function checkAsyncKeyword({ schemaEnv }, def) {
    if (def.async && !schemaEnv.$async)
      throw new Error("async keyword in sync schema");
  }
  function useKeyword(gen, keyword, result) {
    if (result === undefined)
      throw new Error(`keyword "${keyword}" failed to compile`);
    return gen.scopeValue("keyword", typeof result == "function" ? { ref: result } : { ref: result, code: (0, codegen_1.stringify)(result) });
  }
  function validSchemaType(schema, schemaType, allowUndefined = false) {
    return !schemaType.length || schemaType.some((st) => st === "array" ? Array.isArray(schema) : st === "object" ? schema && typeof schema == "object" && !Array.isArray(schema) : typeof schema == st || allowUndefined && typeof schema == "undefined");
  }
  exports.validSchemaType = validSchemaType;
  function validateKeywordUsage({ schema, opts, self, errSchemaPath }, def, keyword) {
    if (Array.isArray(def.keyword) ? !def.keyword.includes(keyword) : def.keyword !== keyword) {
      throw new Error("ajv implementation error");
    }
    const deps = def.dependencies;
    if (deps === null || deps === undefined ? undefined : deps.some((kwd) => !Object.prototype.hasOwnProperty.call(schema, kwd))) {
      throw new Error(`parent schema must have dependencies of ${keyword}: ${deps.join(",")}`);
    }
    if (def.validateSchema) {
      const valid = def.validateSchema(schema[keyword]);
      if (!valid) {
        const msg = `keyword "${keyword}" value is invalid at path "${errSchemaPath}": ` + self.errorsText(def.validateSchema.errors);
        if (opts.validateSchema === "log")
          self.logger.error(msg);
        else
          throw new Error(msg);
      }
    }
  }
  exports.validateKeywordUsage = validateKeywordUsage;
});

// node_modules/ajv/dist/compile/validate/subschema.js
var require_subschema = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.extendSubschemaMode = exports.extendSubschemaData = exports.getSubschema = undefined;
  var codegen_1 = require_codegen();
  var util_1 = require_util();
  function getSubschema(it, { keyword, schemaProp, schema, schemaPath, errSchemaPath, topSchemaRef }) {
    if (keyword !== undefined && schema !== undefined) {
      throw new Error('both "keyword" and "schema" passed, only one allowed');
    }
    if (keyword !== undefined) {
      const sch = it.schema[keyword];
      return schemaProp === undefined ? {
        schema: sch,
        schemaPath: (0, codegen_1._)`${it.schemaPath}${(0, codegen_1.getProperty)(keyword)}`,
        errSchemaPath: `${it.errSchemaPath}/${keyword}`
      } : {
        schema: sch[schemaProp],
        schemaPath: (0, codegen_1._)`${it.schemaPath}${(0, codegen_1.getProperty)(keyword)}${(0, codegen_1.getProperty)(schemaProp)}`,
        errSchemaPath: `${it.errSchemaPath}/${keyword}/${(0, util_1.escapeFragment)(schemaProp)}`
      };
    }
    if (schema !== undefined) {
      if (schemaPath === undefined || errSchemaPath === undefined || topSchemaRef === undefined) {
        throw new Error('"schemaPath", "errSchemaPath" and "topSchemaRef" are required with "schema"');
      }
      return {
        schema,
        schemaPath,
        topSchemaRef,
        errSchemaPath
      };
    }
    throw new Error('either "keyword" or "schema" must be passed');
  }
  exports.getSubschema = getSubschema;
  function extendSubschemaData(subschema, it, { dataProp, dataPropType: dpType, data, dataTypes, propertyName }) {
    if (data !== undefined && dataProp !== undefined) {
      throw new Error('both "data" and "dataProp" passed, only one allowed');
    }
    const { gen } = it;
    if (dataProp !== undefined) {
      const { errorPath, dataPathArr, opts } = it;
      const nextData = gen.let("data", (0, codegen_1._)`${it.data}${(0, codegen_1.getProperty)(dataProp)}`, true);
      dataContextProps(nextData);
      subschema.errorPath = (0, codegen_1.str)`${errorPath}${(0, util_1.getErrorPath)(dataProp, dpType, opts.jsPropertySyntax)}`;
      subschema.parentDataProperty = (0, codegen_1._)`${dataProp}`;
      subschema.dataPathArr = [...dataPathArr, subschema.parentDataProperty];
    }
    if (data !== undefined) {
      const nextData = data instanceof codegen_1.Name ? data : gen.let("data", data, true);
      dataContextProps(nextData);
      if (propertyName !== undefined)
        subschema.propertyName = propertyName;
    }
    if (dataTypes)
      subschema.dataTypes = dataTypes;
    function dataContextProps(_nextData) {
      subschema.data = _nextData;
      subschema.dataLevel = it.dataLevel + 1;
      subschema.dataTypes = [];
      it.definedProperties = new Set;
      subschema.parentData = it.data;
      subschema.dataNames = [...it.dataNames, _nextData];
    }
  }
  exports.extendSubschemaData = extendSubschemaData;
  function extendSubschemaMode(subschema, { jtdDiscriminator, jtdMetadata, compositeRule, createErrors, allErrors }) {
    if (compositeRule !== undefined)
      subschema.compositeRule = compositeRule;
    if (createErrors !== undefined)
      subschema.createErrors = createErrors;
    if (allErrors !== undefined)
      subschema.allErrors = allErrors;
    subschema.jtdDiscriminator = jtdDiscriminator;
    subschema.jtdMetadata = jtdMetadata;
  }
  exports.extendSubschemaMode = extendSubschemaMode;
});

// node_modules/fast-deep-equal/index.js
var require_fast_deep_equal = __commonJS((exports, module) => {
  module.exports = function equal(a, b) {
    if (a === b)
      return true;
    if (a && b && typeof a == "object" && typeof b == "object") {
      if (a.constructor !== b.constructor)
        return false;
      var length, i, keys;
      if (Array.isArray(a)) {
        length = a.length;
        if (length != b.length)
          return false;
        for (i = length;i-- !== 0; )
          if (!equal(a[i], b[i]))
            return false;
        return true;
      }
      if (a.constructor === RegExp)
        return a.source === b.source && a.flags === b.flags;
      if (a.valueOf !== Object.prototype.valueOf)
        return a.valueOf() === b.valueOf();
      if (a.toString !== Object.prototype.toString)
        return a.toString() === b.toString();
      keys = Object.keys(a);
      length = keys.length;
      if (length !== Object.keys(b).length)
        return false;
      for (i = length;i-- !== 0; )
        if (!Object.prototype.hasOwnProperty.call(b, keys[i]))
          return false;
      for (i = length;i-- !== 0; ) {
        var key = keys[i];
        if (!equal(a[key], b[key]))
          return false;
      }
      return true;
    }
    return a !== a && b !== b;
  };
});

// node_modules/json-schema-traverse/index.js
var require_json_schema_traverse = __commonJS((exports, module) => {
  var traverse = module.exports = function(schema, opts, cb) {
    if (typeof opts == "function") {
      cb = opts;
      opts = {};
    }
    cb = opts.cb || cb;
    var pre = typeof cb == "function" ? cb : cb.pre || function() {};
    var post = cb.post || function() {};
    _traverse(opts, pre, post, schema, "", schema);
  };
  traverse.keywords = {
    additionalItems: true,
    items: true,
    contains: true,
    additionalProperties: true,
    propertyNames: true,
    not: true,
    if: true,
    then: true,
    else: true
  };
  traverse.arrayKeywords = {
    items: true,
    allOf: true,
    anyOf: true,
    oneOf: true
  };
  traverse.propsKeywords = {
    $defs: true,
    definitions: true,
    properties: true,
    patternProperties: true,
    dependencies: true
  };
  traverse.skipKeywords = {
    default: true,
    enum: true,
    const: true,
    required: true,
    maximum: true,
    minimum: true,
    exclusiveMaximum: true,
    exclusiveMinimum: true,
    multipleOf: true,
    maxLength: true,
    minLength: true,
    pattern: true,
    format: true,
    maxItems: true,
    minItems: true,
    uniqueItems: true,
    maxProperties: true,
    minProperties: true
  };
  function _traverse(opts, pre, post, schema, jsonPtr, rootSchema, parentJsonPtr, parentKeyword, parentSchema, keyIndex) {
    if (schema && typeof schema == "object" && !Array.isArray(schema)) {
      pre(schema, jsonPtr, rootSchema, parentJsonPtr, parentKeyword, parentSchema, keyIndex);
      for (var key in schema) {
        var sch = schema[key];
        if (Array.isArray(sch)) {
          if (key in traverse.arrayKeywords) {
            for (var i = 0;i < sch.length; i++)
              _traverse(opts, pre, post, sch[i], jsonPtr + "/" + key + "/" + i, rootSchema, jsonPtr, key, schema, i);
          }
        } else if (key in traverse.propsKeywords) {
          if (sch && typeof sch == "object") {
            for (var prop in sch)
              _traverse(opts, pre, post, sch[prop], jsonPtr + "/" + key + "/" + escapeJsonPtr(prop), rootSchema, jsonPtr, key, schema, prop);
          }
        } else if (key in traverse.keywords || opts.allKeys && !(key in traverse.skipKeywords)) {
          _traverse(opts, pre, post, sch, jsonPtr + "/" + key, rootSchema, jsonPtr, key, schema);
        }
      }
      post(schema, jsonPtr, rootSchema, parentJsonPtr, parentKeyword, parentSchema, keyIndex);
    }
  }
  function escapeJsonPtr(str) {
    return str.replace(/~/g, "~0").replace(/\//g, "~1");
  }
});

// node_modules/ajv/dist/compile/resolve.js
var require_resolve = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.getSchemaRefs = exports.resolveUrl = exports.normalizeId = exports._getFullPath = exports.getFullPath = exports.inlineRef = undefined;
  var util_1 = require_util();
  var equal = require_fast_deep_equal();
  var traverse = require_json_schema_traverse();
  var SIMPLE_INLINED = new Set([
    "type",
    "format",
    "pattern",
    "maxLength",
    "minLength",
    "maxProperties",
    "minProperties",
    "maxItems",
    "minItems",
    "maximum",
    "minimum",
    "uniqueItems",
    "multipleOf",
    "required",
    "enum",
    "const"
  ]);
  function inlineRef(schema, limit = true) {
    if (typeof schema == "boolean")
      return true;
    if (limit === true)
      return !hasRef(schema);
    if (!limit)
      return false;
    return countKeys(schema) <= limit;
  }
  exports.inlineRef = inlineRef;
  var REF_KEYWORDS = new Set([
    "$ref",
    "$recursiveRef",
    "$recursiveAnchor",
    "$dynamicRef",
    "$dynamicAnchor"
  ]);
  function hasRef(schema) {
    for (const key in schema) {
      if (REF_KEYWORDS.has(key))
        return true;
      const sch = schema[key];
      if (Array.isArray(sch) && sch.some(hasRef))
        return true;
      if (typeof sch == "object" && hasRef(sch))
        return true;
    }
    return false;
  }
  function countKeys(schema) {
    let count = 0;
    for (const key in schema) {
      if (key === "$ref")
        return Infinity;
      count++;
      if (SIMPLE_INLINED.has(key))
        continue;
      if (typeof schema[key] == "object") {
        (0, util_1.eachItem)(schema[key], (sch) => count += countKeys(sch));
      }
      if (count === Infinity)
        return Infinity;
    }
    return count;
  }
  function getFullPath(resolver, id = "", normalize) {
    if (normalize !== false)
      id = normalizeId(id);
    const p = resolver.parse(id);
    return _getFullPath(resolver, p);
  }
  exports.getFullPath = getFullPath;
  function _getFullPath(resolver, p) {
    const serialized = resolver.serialize(p);
    return serialized.split("#")[0] + "#";
  }
  exports._getFullPath = _getFullPath;
  var TRAILING_SLASH_HASH = /#\/?$/;
  function normalizeId(id) {
    return id ? id.replace(TRAILING_SLASH_HASH, "") : "";
  }
  exports.normalizeId = normalizeId;
  function resolveUrl(resolver, baseId, id) {
    id = normalizeId(id);
    return resolver.resolve(baseId, id);
  }
  exports.resolveUrl = resolveUrl;
  var ANCHOR = /^[a-z_][-a-z0-9._]*$/i;
  function getSchemaRefs(schema, baseId) {
    if (typeof schema == "boolean")
      return {};
    const { schemaId, uriResolver } = this.opts;
    const schId = normalizeId(schema[schemaId] || baseId);
    const baseIds = { "": schId };
    const pathPrefix = getFullPath(uriResolver, schId, false);
    const localRefs = {};
    const schemaRefs = new Set;
    traverse(schema, { allKeys: true }, (sch, jsonPtr, _, parentJsonPtr) => {
      if (parentJsonPtr === undefined)
        return;
      const fullPath = pathPrefix + jsonPtr;
      let innerBaseId = baseIds[parentJsonPtr];
      if (typeof sch[schemaId] == "string")
        innerBaseId = addRef.call(this, sch[schemaId]);
      addAnchor.call(this, sch.$anchor);
      addAnchor.call(this, sch.$dynamicAnchor);
      baseIds[jsonPtr] = innerBaseId;
      function addRef(ref) {
        const _resolve = this.opts.uriResolver.resolve;
        ref = normalizeId(innerBaseId ? _resolve(innerBaseId, ref) : ref);
        if (schemaRefs.has(ref))
          throw ambiguos(ref);
        schemaRefs.add(ref);
        let schOrRef = this.refs[ref];
        if (typeof schOrRef == "string")
          schOrRef = this.refs[schOrRef];
        if (typeof schOrRef == "object") {
          checkAmbiguosRef(sch, schOrRef.schema, ref);
        } else if (ref !== normalizeId(fullPath)) {
          if (ref[0] === "#") {
            checkAmbiguosRef(sch, localRefs[ref], ref);
            localRefs[ref] = sch;
          } else {
            this.refs[ref] = fullPath;
          }
        }
        return ref;
      }
      function addAnchor(anchor) {
        if (typeof anchor == "string") {
          if (!ANCHOR.test(anchor))
            throw new Error(`invalid anchor "${anchor}"`);
          addRef.call(this, `#${anchor}`);
        }
      }
    });
    return localRefs;
    function checkAmbiguosRef(sch1, sch2, ref) {
      if (sch2 !== undefined && !equal(sch1, sch2))
        throw ambiguos(ref);
    }
    function ambiguos(ref) {
      return new Error(`reference "${ref}" resolves to more than one schema`);
    }
  }
  exports.getSchemaRefs = getSchemaRefs;
});

// node_modules/ajv/dist/compile/validate/index.js
var require_validate = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.getData = exports.KeywordCxt = exports.validateFunctionCode = undefined;
  var boolSchema_1 = require_boolSchema();
  var dataType_1 = require_dataType();
  var applicability_1 = require_applicability();
  var dataType_2 = require_dataType();
  var defaults_1 = require_defaults();
  var keyword_1 = require_keyword();
  var subschema_1 = require_subschema();
  var codegen_1 = require_codegen();
  var names_1 = require_names();
  var resolve_1 = require_resolve();
  var util_1 = require_util();
  var errors_1 = require_errors();
  function validateFunctionCode(it) {
    if (isSchemaObj(it)) {
      checkKeywords(it);
      if (schemaCxtHasRules(it)) {
        topSchemaObjCode(it);
        return;
      }
    }
    validateFunction(it, () => (0, boolSchema_1.topBoolOrEmptySchema)(it));
  }
  exports.validateFunctionCode = validateFunctionCode;
  function validateFunction({ gen, validateName, schema, schemaEnv, opts }, body) {
    if (opts.code.es5) {
      gen.func(validateName, (0, codegen_1._)`${names_1.default.data}, ${names_1.default.valCxt}`, schemaEnv.$async, () => {
        gen.code((0, codegen_1._)`"use strict"; ${funcSourceUrl(schema, opts)}`);
        destructureValCxtES5(gen, opts);
        gen.code(body);
      });
    } else {
      gen.func(validateName, (0, codegen_1._)`${names_1.default.data}, ${destructureValCxt(opts)}`, schemaEnv.$async, () => gen.code(funcSourceUrl(schema, opts)).code(body));
    }
  }
  function destructureValCxt(opts) {
    return (0, codegen_1._)`{${names_1.default.instancePath}="", ${names_1.default.parentData}, ${names_1.default.parentDataProperty}, ${names_1.default.rootData}=${names_1.default.data}${opts.dynamicRef ? (0, codegen_1._)`, ${names_1.default.dynamicAnchors}={}` : codegen_1.nil}}={}`;
  }
  function destructureValCxtES5(gen, opts) {
    gen.if(names_1.default.valCxt, () => {
      gen.var(names_1.default.instancePath, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.instancePath}`);
      gen.var(names_1.default.parentData, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.parentData}`);
      gen.var(names_1.default.parentDataProperty, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.parentDataProperty}`);
      gen.var(names_1.default.rootData, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.rootData}`);
      if (opts.dynamicRef)
        gen.var(names_1.default.dynamicAnchors, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.dynamicAnchors}`);
    }, () => {
      gen.var(names_1.default.instancePath, (0, codegen_1._)`""`);
      gen.var(names_1.default.parentData, (0, codegen_1._)`undefined`);
      gen.var(names_1.default.parentDataProperty, (0, codegen_1._)`undefined`);
      gen.var(names_1.default.rootData, names_1.default.data);
      if (opts.dynamicRef)
        gen.var(names_1.default.dynamicAnchors, (0, codegen_1._)`{}`);
    });
  }
  function topSchemaObjCode(it) {
    const { schema, opts, gen } = it;
    validateFunction(it, () => {
      if (opts.$comment && schema.$comment)
        commentKeyword(it);
      checkNoDefault(it);
      gen.let(names_1.default.vErrors, null);
      gen.let(names_1.default.errors, 0);
      if (opts.unevaluated)
        resetEvaluated(it);
      typeAndKeywords(it);
      returnResults(it);
    });
    return;
  }
  function resetEvaluated(it) {
    const { gen, validateName } = it;
    it.evaluated = gen.const("evaluated", (0, codegen_1._)`${validateName}.evaluated`);
    gen.if((0, codegen_1._)`${it.evaluated}.dynamicProps`, () => gen.assign((0, codegen_1._)`${it.evaluated}.props`, (0, codegen_1._)`undefined`));
    gen.if((0, codegen_1._)`${it.evaluated}.dynamicItems`, () => gen.assign((0, codegen_1._)`${it.evaluated}.items`, (0, codegen_1._)`undefined`));
  }
  function funcSourceUrl(schema, opts) {
    const schId = typeof schema == "object" && schema[opts.schemaId];
    return schId && (opts.code.source || opts.code.process) ? (0, codegen_1._)`/*# sourceURL=${schId} */` : codegen_1.nil;
  }
  function subschemaCode(it, valid) {
    if (isSchemaObj(it)) {
      checkKeywords(it);
      if (schemaCxtHasRules(it)) {
        subSchemaObjCode(it, valid);
        return;
      }
    }
    (0, boolSchema_1.boolOrEmptySchema)(it, valid);
  }
  function schemaCxtHasRules({ schema, self }) {
    if (typeof schema == "boolean")
      return !schema;
    for (const key in schema)
      if (self.RULES.all[key])
        return true;
    return false;
  }
  function isSchemaObj(it) {
    return typeof it.schema != "boolean";
  }
  function subSchemaObjCode(it, valid) {
    const { schema, gen, opts } = it;
    if (opts.$comment && schema.$comment)
      commentKeyword(it);
    updateContext(it);
    checkAsyncSchema(it);
    const errsCount = gen.const("_errs", names_1.default.errors);
    typeAndKeywords(it, errsCount);
    gen.var(valid, (0, codegen_1._)`${errsCount} === ${names_1.default.errors}`);
  }
  function checkKeywords(it) {
    (0, util_1.checkUnknownRules)(it);
    checkRefsAndKeywords(it);
  }
  function typeAndKeywords(it, errsCount) {
    if (it.opts.jtd)
      return schemaKeywords(it, [], false, errsCount);
    const types = (0, dataType_1.getSchemaTypes)(it.schema);
    const checkedTypes = (0, dataType_1.coerceAndCheckDataType)(it, types);
    schemaKeywords(it, types, !checkedTypes, errsCount);
  }
  function checkRefsAndKeywords(it) {
    const { schema, errSchemaPath, opts, self } = it;
    if (schema.$ref && opts.ignoreKeywordsWithRef && (0, util_1.schemaHasRulesButRef)(schema, self.RULES)) {
      self.logger.warn(`$ref: keywords ignored in schema at path "${errSchemaPath}"`);
    }
  }
  function checkNoDefault(it) {
    const { schema, opts } = it;
    if (schema.default !== undefined && opts.useDefaults && opts.strictSchema) {
      (0, util_1.checkStrictMode)(it, "default is ignored in the schema root");
    }
  }
  function updateContext(it) {
    const schId = it.schema[it.opts.schemaId];
    if (schId)
      it.baseId = (0, resolve_1.resolveUrl)(it.opts.uriResolver, it.baseId, schId);
  }
  function checkAsyncSchema(it) {
    if (it.schema.$async && !it.schemaEnv.$async)
      throw new Error("async schema in sync schema");
  }
  function commentKeyword({ gen, schemaEnv, schema, errSchemaPath, opts }) {
    const msg = schema.$comment;
    if (opts.$comment === true) {
      gen.code((0, codegen_1._)`${names_1.default.self}.logger.log(${msg})`);
    } else if (typeof opts.$comment == "function") {
      const schemaPath = (0, codegen_1.str)`${errSchemaPath}/$comment`;
      const rootName = gen.scopeValue("root", { ref: schemaEnv.root });
      gen.code((0, codegen_1._)`${names_1.default.self}.opts.$comment(${msg}, ${schemaPath}, ${rootName}.schema)`);
    }
  }
  function returnResults(it) {
    const { gen, schemaEnv, validateName, ValidationError, opts } = it;
    if (schemaEnv.$async) {
      gen.if((0, codegen_1._)`${names_1.default.errors} === 0`, () => gen.return(names_1.default.data), () => gen.throw((0, codegen_1._)`new ${ValidationError}(${names_1.default.vErrors})`));
    } else {
      gen.assign((0, codegen_1._)`${validateName}.errors`, names_1.default.vErrors);
      if (opts.unevaluated)
        assignEvaluated(it);
      gen.return((0, codegen_1._)`${names_1.default.errors} === 0`);
    }
  }
  function assignEvaluated({ gen, evaluated, props, items }) {
    if (props instanceof codegen_1.Name)
      gen.assign((0, codegen_1._)`${evaluated}.props`, props);
    if (items instanceof codegen_1.Name)
      gen.assign((0, codegen_1._)`${evaluated}.items`, items);
  }
  function schemaKeywords(it, types, typeErrors, errsCount) {
    const { gen, schema, data, allErrors, opts, self } = it;
    const { RULES } = self;
    if (schema.$ref && (opts.ignoreKeywordsWithRef || !(0, util_1.schemaHasRulesButRef)(schema, RULES))) {
      gen.block(() => keywordCode(it, "$ref", RULES.all.$ref.definition));
      return;
    }
    if (!opts.jtd)
      checkStrictTypes(it, types);
    gen.block(() => {
      for (const group of RULES.rules)
        groupKeywords(group);
      groupKeywords(RULES.post);
    });
    function groupKeywords(group) {
      if (!(0, applicability_1.shouldUseGroup)(schema, group))
        return;
      if (group.type) {
        gen.if((0, dataType_2.checkDataType)(group.type, data, opts.strictNumbers));
        iterateKeywords(it, group);
        if (types.length === 1 && types[0] === group.type && typeErrors) {
          gen.else();
          (0, dataType_2.reportTypeError)(it);
        }
        gen.endIf();
      } else {
        iterateKeywords(it, group);
      }
      if (!allErrors)
        gen.if((0, codegen_1._)`${names_1.default.errors} === ${errsCount || 0}`);
    }
  }
  function iterateKeywords(it, group) {
    const { gen, schema, opts: { useDefaults } } = it;
    if (useDefaults)
      (0, defaults_1.assignDefaults)(it, group.type);
    gen.block(() => {
      for (const rule of group.rules) {
        if ((0, applicability_1.shouldUseRule)(schema, rule)) {
          keywordCode(it, rule.keyword, rule.definition, group.type);
        }
      }
    });
  }
  function checkStrictTypes(it, types) {
    if (it.schemaEnv.meta || !it.opts.strictTypes)
      return;
    checkContextTypes(it, types);
    if (!it.opts.allowUnionTypes)
      checkMultipleTypes(it, types);
    checkKeywordTypes(it, it.dataTypes);
  }
  function checkContextTypes(it, types) {
    if (!types.length)
      return;
    if (!it.dataTypes.length) {
      it.dataTypes = types;
      return;
    }
    types.forEach((t) => {
      if (!includesType(it.dataTypes, t)) {
        strictTypesError(it, `type "${t}" not allowed by context "${it.dataTypes.join(",")}"`);
      }
    });
    narrowSchemaTypes(it, types);
  }
  function checkMultipleTypes(it, ts) {
    if (ts.length > 1 && !(ts.length === 2 && ts.includes("null"))) {
      strictTypesError(it, "use allowUnionTypes to allow union type keyword");
    }
  }
  function checkKeywordTypes(it, ts) {
    const rules = it.self.RULES.all;
    for (const keyword in rules) {
      const rule = rules[keyword];
      if (typeof rule == "object" && (0, applicability_1.shouldUseRule)(it.schema, rule)) {
        const { type } = rule.definition;
        if (type.length && !type.some((t) => hasApplicableType(ts, t))) {
          strictTypesError(it, `missing type "${type.join(",")}" for keyword "${keyword}"`);
        }
      }
    }
  }
  function hasApplicableType(schTs, kwdT) {
    return schTs.includes(kwdT) || kwdT === "number" && schTs.includes("integer");
  }
  function includesType(ts, t) {
    return ts.includes(t) || t === "integer" && ts.includes("number");
  }
  function narrowSchemaTypes(it, withTypes) {
    const ts = [];
    for (const t of it.dataTypes) {
      if (includesType(withTypes, t))
        ts.push(t);
      else if (withTypes.includes("integer") && t === "number")
        ts.push("integer");
    }
    it.dataTypes = ts;
  }
  function strictTypesError(it, msg) {
    const schemaPath = it.schemaEnv.baseId + it.errSchemaPath;
    msg += ` at "${schemaPath}" (strictTypes)`;
    (0, util_1.checkStrictMode)(it, msg, it.opts.strictTypes);
  }

  class KeywordCxt {
    constructor(it, def, keyword) {
      (0, keyword_1.validateKeywordUsage)(it, def, keyword);
      this.gen = it.gen;
      this.allErrors = it.allErrors;
      this.keyword = keyword;
      this.data = it.data;
      this.schema = it.schema[keyword];
      this.$data = def.$data && it.opts.$data && this.schema && this.schema.$data;
      this.schemaValue = (0, util_1.schemaRefOrVal)(it, this.schema, keyword, this.$data);
      this.schemaType = def.schemaType;
      this.parentSchema = it.schema;
      this.params = {};
      this.it = it;
      this.def = def;
      if (this.$data) {
        this.schemaCode = it.gen.const("vSchema", getData(this.$data, it));
      } else {
        this.schemaCode = this.schemaValue;
        if (!(0, keyword_1.validSchemaType)(this.schema, def.schemaType, def.allowUndefined)) {
          throw new Error(`${keyword} value must be ${JSON.stringify(def.schemaType)}`);
        }
      }
      if ("code" in def ? def.trackErrors : def.errors !== false) {
        this.errsCount = it.gen.const("_errs", names_1.default.errors);
      }
    }
    result(condition, successAction, failAction) {
      this.failResult((0, codegen_1.not)(condition), successAction, failAction);
    }
    failResult(condition, successAction, failAction) {
      this.gen.if(condition);
      if (failAction)
        failAction();
      else
        this.error();
      if (successAction) {
        this.gen.else();
        successAction();
        if (this.allErrors)
          this.gen.endIf();
      } else {
        if (this.allErrors)
          this.gen.endIf();
        else
          this.gen.else();
      }
    }
    pass(condition, failAction) {
      this.failResult((0, codegen_1.not)(condition), undefined, failAction);
    }
    fail(condition) {
      if (condition === undefined) {
        this.error();
        if (!this.allErrors)
          this.gen.if(false);
        return;
      }
      this.gen.if(condition);
      this.error();
      if (this.allErrors)
        this.gen.endIf();
      else
        this.gen.else();
    }
    fail$data(condition) {
      if (!this.$data)
        return this.fail(condition);
      const { schemaCode } = this;
      this.fail((0, codegen_1._)`${schemaCode} !== undefined && (${(0, codegen_1.or)(this.invalid$data(), condition)})`);
    }
    error(append, errorParams, errorPaths) {
      if (errorParams) {
        this.setParams(errorParams);
        this._error(append, errorPaths);
        this.setParams({});
        return;
      }
      this._error(append, errorPaths);
    }
    _error(append, errorPaths) {
      (append ? errors_1.reportExtraError : errors_1.reportError)(this, this.def.error, errorPaths);
    }
    $dataError() {
      (0, errors_1.reportError)(this, this.def.$dataError || errors_1.keyword$DataError);
    }
    reset() {
      if (this.errsCount === undefined)
        throw new Error('add "trackErrors" to keyword definition');
      (0, errors_1.resetErrorsCount)(this.gen, this.errsCount);
    }
    ok(cond) {
      if (!this.allErrors)
        this.gen.if(cond);
    }
    setParams(obj, assign) {
      if (assign)
        Object.assign(this.params, obj);
      else
        this.params = obj;
    }
    block$data(valid, codeBlock, $dataValid = codegen_1.nil) {
      this.gen.block(() => {
        this.check$data(valid, $dataValid);
        codeBlock();
      });
    }
    check$data(valid = codegen_1.nil, $dataValid = codegen_1.nil) {
      if (!this.$data)
        return;
      const { gen, schemaCode, schemaType, def } = this;
      gen.if((0, codegen_1.or)((0, codegen_1._)`${schemaCode} === undefined`, $dataValid));
      if (valid !== codegen_1.nil)
        gen.assign(valid, true);
      if (schemaType.length || def.validateSchema) {
        gen.elseIf(this.invalid$data());
        this.$dataError();
        if (valid !== codegen_1.nil)
          gen.assign(valid, false);
      }
      gen.else();
    }
    invalid$data() {
      const { gen, schemaCode, schemaType, def, it } = this;
      return (0, codegen_1.or)(wrong$DataType(), invalid$DataSchema());
      function wrong$DataType() {
        if (schemaType.length) {
          if (!(schemaCode instanceof codegen_1.Name))
            throw new Error("ajv implementation error");
          const st = Array.isArray(schemaType) ? schemaType : [schemaType];
          return (0, codegen_1._)`${(0, dataType_2.checkDataTypes)(st, schemaCode, it.opts.strictNumbers, dataType_2.DataType.Wrong)}`;
        }
        return codegen_1.nil;
      }
      function invalid$DataSchema() {
        if (def.validateSchema) {
          const validateSchemaRef = gen.scopeValue("validate$data", { ref: def.validateSchema });
          return (0, codegen_1._)`!${validateSchemaRef}(${schemaCode})`;
        }
        return codegen_1.nil;
      }
    }
    subschema(appl, valid) {
      const subschema = (0, subschema_1.getSubschema)(this.it, appl);
      (0, subschema_1.extendSubschemaData)(subschema, this.it, appl);
      (0, subschema_1.extendSubschemaMode)(subschema, appl);
      const nextContext = { ...this.it, ...subschema, items: undefined, props: undefined };
      subschemaCode(nextContext, valid);
      return nextContext;
    }
    mergeEvaluated(schemaCxt, toName) {
      const { it, gen } = this;
      if (!it.opts.unevaluated)
        return;
      if (it.props !== true && schemaCxt.props !== undefined) {
        it.props = util_1.mergeEvaluated.props(gen, schemaCxt.props, it.props, toName);
      }
      if (it.items !== true && schemaCxt.items !== undefined) {
        it.items = util_1.mergeEvaluated.items(gen, schemaCxt.items, it.items, toName);
      }
    }
    mergeValidEvaluated(schemaCxt, valid) {
      const { it, gen } = this;
      if (it.opts.unevaluated && (it.props !== true || it.items !== true)) {
        gen.if(valid, () => this.mergeEvaluated(schemaCxt, codegen_1.Name));
        return true;
      }
    }
  }
  exports.KeywordCxt = KeywordCxt;
  function keywordCode(it, keyword, def, ruleType) {
    const cxt = new KeywordCxt(it, def, keyword);
    if ("code" in def) {
      def.code(cxt, ruleType);
    } else if (cxt.$data && def.validate) {
      (0, keyword_1.funcKeywordCode)(cxt, def);
    } else if ("macro" in def) {
      (0, keyword_1.macroKeywordCode)(cxt, def);
    } else if (def.compile || def.validate) {
      (0, keyword_1.funcKeywordCode)(cxt, def);
    }
  }
  var JSON_POINTER = /^\/(?:[^~]|~0|~1)*$/;
  var RELATIVE_JSON_POINTER = /^([0-9]+)(#|\/(?:[^~]|~0|~1)*)?$/;
  function getData($data, { dataLevel, dataNames, dataPathArr }) {
    let jsonPointer;
    let data;
    if ($data === "")
      return names_1.default.rootData;
    if ($data[0] === "/") {
      if (!JSON_POINTER.test($data))
        throw new Error(`Invalid JSON-pointer: ${$data}`);
      jsonPointer = $data;
      data = names_1.default.rootData;
    } else {
      const matches = RELATIVE_JSON_POINTER.exec($data);
      if (!matches)
        throw new Error(`Invalid JSON-pointer: ${$data}`);
      const up = +matches[1];
      jsonPointer = matches[2];
      if (jsonPointer === "#") {
        if (up >= dataLevel)
          throw new Error(errorMsg("property/index", up));
        return dataPathArr[dataLevel - up];
      }
      if (up > dataLevel)
        throw new Error(errorMsg("data", up));
      data = dataNames[dataLevel - up];
      if (!jsonPointer)
        return data;
    }
    let expr = data;
    const segments = jsonPointer.split("/");
    for (const segment of segments) {
      if (segment) {
        data = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)((0, util_1.unescapeJsonPointer)(segment))}`;
        expr = (0, codegen_1._)`${expr} && ${data}`;
      }
    }
    return expr;
    function errorMsg(pointerType, up) {
      return `Cannot access ${pointerType} ${up} levels up, current level is ${dataLevel}`;
    }
  }
  exports.getData = getData;
});

// node_modules/ajv/dist/runtime/validation_error.js
var require_validation_error = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });

  class ValidationError extends Error {
    constructor(errors) {
      super("validation failed");
      this.errors = errors;
      this.ajv = this.validation = true;
    }
  }
  exports.default = ValidationError;
});

// node_modules/ajv/dist/compile/ref_error.js
var require_ref_error = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var resolve_1 = require_resolve();

  class MissingRefError extends Error {
    constructor(resolver, baseId, ref, msg) {
      super(msg || `can't resolve reference ${ref} from id ${baseId}`);
      this.missingRef = (0, resolve_1.resolveUrl)(resolver, baseId, ref);
      this.missingSchema = (0, resolve_1.normalizeId)((0, resolve_1.getFullPath)(resolver, this.missingRef));
    }
  }
  exports.default = MissingRefError;
});

// node_modules/ajv/dist/compile/index.js
var require_compile = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.resolveSchema = exports.getCompilingSchema = exports.resolveRef = exports.compileSchema = exports.SchemaEnv = undefined;
  var codegen_1 = require_codegen();
  var validation_error_1 = require_validation_error();
  var names_1 = require_names();
  var resolve_1 = require_resolve();
  var util_1 = require_util();
  var validate_1 = require_validate();

  class SchemaEnv {
    constructor(env) {
      var _a;
      this.refs = {};
      this.dynamicAnchors = {};
      let schema;
      if (typeof env.schema == "object")
        schema = env.schema;
      this.schema = env.schema;
      this.schemaId = env.schemaId;
      this.root = env.root || this;
      this.baseId = (_a = env.baseId) !== null && _a !== undefined ? _a : (0, resolve_1.normalizeId)(schema === null || schema === undefined ? undefined : schema[env.schemaId || "$id"]);
      this.schemaPath = env.schemaPath;
      this.localRefs = env.localRefs;
      this.meta = env.meta;
      this.$async = schema === null || schema === undefined ? undefined : schema.$async;
      this.refs = {};
    }
  }
  exports.SchemaEnv = SchemaEnv;
  function compileSchema(sch) {
    const _sch = getCompilingSchema.call(this, sch);
    if (_sch)
      return _sch;
    const rootId = (0, resolve_1.getFullPath)(this.opts.uriResolver, sch.root.baseId);
    const { es5, lines } = this.opts.code;
    const { ownProperties } = this.opts;
    const gen = new codegen_1.CodeGen(this.scope, { es5, lines, ownProperties });
    let _ValidationError;
    if (sch.$async) {
      _ValidationError = gen.scopeValue("Error", {
        ref: validation_error_1.default,
        code: (0, codegen_1._)`require("ajv/dist/runtime/validation_error").default`
      });
    }
    const validateName = gen.scopeName("validate");
    sch.validateName = validateName;
    const schemaCxt = {
      gen,
      allErrors: this.opts.allErrors,
      data: names_1.default.data,
      parentData: names_1.default.parentData,
      parentDataProperty: names_1.default.parentDataProperty,
      dataNames: [names_1.default.data],
      dataPathArr: [codegen_1.nil],
      dataLevel: 0,
      dataTypes: [],
      definedProperties: new Set,
      topSchemaRef: gen.scopeValue("schema", this.opts.code.source === true ? { ref: sch.schema, code: (0, codegen_1.stringify)(sch.schema) } : { ref: sch.schema }),
      validateName,
      ValidationError: _ValidationError,
      schema: sch.schema,
      schemaEnv: sch,
      rootId,
      baseId: sch.baseId || rootId,
      schemaPath: codegen_1.nil,
      errSchemaPath: sch.schemaPath || (this.opts.jtd ? "" : "#"),
      errorPath: (0, codegen_1._)`""`,
      opts: this.opts,
      self: this
    };
    let sourceCode;
    try {
      this._compilations.add(sch);
      (0, validate_1.validateFunctionCode)(schemaCxt);
      gen.optimize(this.opts.code.optimize);
      const validateCode = gen.toString();
      sourceCode = `${gen.scopeRefs(names_1.default.scope)}return ${validateCode}`;
      if (this.opts.code.process)
        sourceCode = this.opts.code.process(sourceCode, sch);
      const makeValidate = new Function(`${names_1.default.self}`, `${names_1.default.scope}`, sourceCode);
      const validate = makeValidate(this, this.scope.get());
      this.scope.value(validateName, { ref: validate });
      validate.errors = null;
      validate.schema = sch.schema;
      validate.schemaEnv = sch;
      if (sch.$async)
        validate.$async = true;
      if (this.opts.code.source === true) {
        validate.source = { validateName, validateCode, scopeValues: gen._values };
      }
      if (this.opts.unevaluated) {
        const { props, items } = schemaCxt;
        validate.evaluated = {
          props: props instanceof codegen_1.Name ? undefined : props,
          items: items instanceof codegen_1.Name ? undefined : items,
          dynamicProps: props instanceof codegen_1.Name,
          dynamicItems: items instanceof codegen_1.Name
        };
        if (validate.source)
          validate.source.evaluated = (0, codegen_1.stringify)(validate.evaluated);
      }
      sch.validate = validate;
      return sch;
    } catch (e) {
      delete sch.validate;
      delete sch.validateName;
      if (sourceCode)
        this.logger.error("Error compiling schema, function code:", sourceCode);
      throw e;
    } finally {
      this._compilations.delete(sch);
    }
  }
  exports.compileSchema = compileSchema;
  function resolveRef(root, baseId, ref) {
    var _a;
    ref = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, ref);
    const schOrFunc = root.refs[ref];
    if (schOrFunc)
      return schOrFunc;
    let _sch = resolve.call(this, root, ref);
    if (_sch === undefined) {
      const schema = (_a = root.localRefs) === null || _a === undefined ? undefined : _a[ref];
      const { schemaId } = this.opts;
      if (schema)
        _sch = new SchemaEnv({ schema, schemaId, root, baseId });
    }
    if (_sch === undefined)
      return;
    return root.refs[ref] = inlineOrCompile.call(this, _sch);
  }
  exports.resolveRef = resolveRef;
  function inlineOrCompile(sch) {
    if ((0, resolve_1.inlineRef)(sch.schema, this.opts.inlineRefs))
      return sch.schema;
    return sch.validate ? sch : compileSchema.call(this, sch);
  }
  function getCompilingSchema(schEnv) {
    for (const sch of this._compilations) {
      if (sameSchemaEnv(sch, schEnv))
        return sch;
    }
  }
  exports.getCompilingSchema = getCompilingSchema;
  function sameSchemaEnv(s1, s2) {
    return s1.schema === s2.schema && s1.root === s2.root && s1.baseId === s2.baseId;
  }
  function resolve(root, ref) {
    let sch;
    while (typeof (sch = this.refs[ref]) == "string")
      ref = sch;
    return sch || this.schemas[ref] || resolveSchema.call(this, root, ref);
  }
  function resolveSchema(root, ref) {
    const p = this.opts.uriResolver.parse(ref);
    const refPath = (0, resolve_1._getFullPath)(this.opts.uriResolver, p);
    let baseId = (0, resolve_1.getFullPath)(this.opts.uriResolver, root.baseId, undefined);
    if (Object.keys(root.schema).length > 0 && refPath === baseId) {
      return getJsonPointer.call(this, p, root);
    }
    const id = (0, resolve_1.normalizeId)(refPath);
    const schOrRef = this.refs[id] || this.schemas[id];
    if (typeof schOrRef == "string") {
      const sch = resolveSchema.call(this, root, schOrRef);
      if (typeof (sch === null || sch === undefined ? undefined : sch.schema) !== "object")
        return;
      return getJsonPointer.call(this, p, sch);
    }
    if (typeof (schOrRef === null || schOrRef === undefined ? undefined : schOrRef.schema) !== "object")
      return;
    if (!schOrRef.validate)
      compileSchema.call(this, schOrRef);
    if (id === (0, resolve_1.normalizeId)(ref)) {
      const { schema } = schOrRef;
      const { schemaId } = this.opts;
      const schId = schema[schemaId];
      if (schId)
        baseId = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, schId);
      return new SchemaEnv({ schema, schemaId, root, baseId });
    }
    return getJsonPointer.call(this, p, schOrRef);
  }
  exports.resolveSchema = resolveSchema;
  var PREVENT_SCOPE_CHANGE = new Set([
    "properties",
    "patternProperties",
    "enum",
    "dependencies",
    "definitions"
  ]);
  function getJsonPointer(parsedRef, { baseId, schema, root }) {
    var _a;
    if (((_a = parsedRef.fragment) === null || _a === undefined ? undefined : _a[0]) !== "/")
      return;
    for (const part of parsedRef.fragment.slice(1).split("/")) {
      if (typeof schema === "boolean")
        return;
      const partSchema = schema[(0, util_1.unescapeFragment)(part)];
      if (partSchema === undefined)
        return;
      schema = partSchema;
      const schId = typeof schema === "object" && schema[this.opts.schemaId];
      if (!PREVENT_SCOPE_CHANGE.has(part) && schId) {
        baseId = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, schId);
      }
    }
    let env;
    if (typeof schema != "boolean" && schema.$ref && !(0, util_1.schemaHasRulesButRef)(schema, this.RULES)) {
      const $ref = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, schema.$ref);
      env = resolveSchema.call(this, root, $ref);
    }
    const { schemaId } = this.opts;
    env = env || new SchemaEnv({ schema, schemaId, root, baseId });
    if (env.schema !== env.root.schema)
      return env;
    return;
  }
});

// node_modules/ajv/dist/refs/data.json
var require_data = __commonJS((exports, module) => {
  module.exports = {
    $id: "https://raw.githubusercontent.com/ajv-validator/ajv/master/lib/refs/data.json#",
    description: "Meta-schema for $data reference (JSON AnySchema extension proposal)",
    type: "object",
    required: ["$data"],
    properties: {
      $data: {
        type: "string",
        anyOf: [{ format: "relative-json-pointer" }, { format: "json-pointer" }]
      }
    },
    additionalProperties: false
  };
});

// node_modules/fast-uri/lib/utils.js
var require_utils = __commonJS((exports, module) => {
  var isUUID = RegExp.prototype.test.bind(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu);
  var isIPv4 = RegExp.prototype.test.bind(/^(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)$/u);
  function stringArrayToHexStripped(input) {
    let acc = "";
    let code = 0;
    let i = 0;
    for (i = 0;i < input.length; i++) {
      code = input[i].charCodeAt(0);
      if (code === 48) {
        continue;
      }
      if (!(code >= 48 && code <= 57 || code >= 65 && code <= 70 || code >= 97 && code <= 102)) {
        return "";
      }
      acc += input[i];
      break;
    }
    for (i += 1;i < input.length; i++) {
      code = input[i].charCodeAt(0);
      if (!(code >= 48 && code <= 57 || code >= 65 && code <= 70 || code >= 97 && code <= 102)) {
        return "";
      }
      acc += input[i];
    }
    return acc;
  }
  var nonSimpleDomain = RegExp.prototype.test.bind(/[^!"$&'()*+,\-.;=_`a-z{}~]/u);
  function consumeIsZone(buffer) {
    buffer.length = 0;
    return true;
  }
  function consumeHextets(buffer, address, output) {
    if (buffer.length) {
      const hex = stringArrayToHexStripped(buffer);
      if (hex !== "") {
        address.push(hex);
      } else {
        output.error = true;
        return false;
      }
      buffer.length = 0;
    }
    return true;
  }
  function getIPV6(input) {
    let tokenCount = 0;
    const output = { error: false, address: "", zone: "" };
    const address = [];
    const buffer = [];
    let endipv6Encountered = false;
    let endIpv6 = false;
    let consume = consumeHextets;
    for (let i = 0;i < input.length; i++) {
      const cursor = input[i];
      if (cursor === "[" || cursor === "]") {
        continue;
      }
      if (cursor === ":") {
        if (endipv6Encountered === true) {
          endIpv6 = true;
        }
        if (!consume(buffer, address, output)) {
          break;
        }
        if (++tokenCount > 7) {
          output.error = true;
          break;
        }
        if (i > 0 && input[i - 1] === ":") {
          endipv6Encountered = true;
        }
        address.push(":");
        continue;
      } else if (cursor === "%") {
        if (!consume(buffer, address, output)) {
          break;
        }
        consume = consumeIsZone;
      } else {
        buffer.push(cursor);
        continue;
      }
    }
    if (buffer.length) {
      if (consume === consumeIsZone) {
        output.zone = buffer.join("");
      } else if (endIpv6) {
        address.push(buffer.join(""));
      } else {
        address.push(stringArrayToHexStripped(buffer));
      }
    }
    output.address = address.join("");
    return output;
  }
  function normalizeIPv6(host) {
    if (findToken(host, ":") < 2) {
      return { host, isIPV6: false };
    }
    const ipv6 = getIPV6(host);
    if (!ipv6.error) {
      let newHost = ipv6.address;
      let escapedHost = ipv6.address;
      if (ipv6.zone) {
        newHost += "%" + ipv6.zone;
        escapedHost += "%25" + ipv6.zone;
      }
      return { host: newHost, isIPV6: true, escapedHost };
    } else {
      return { host, isIPV6: false };
    }
  }
  function findToken(str, token) {
    let ind = 0;
    for (let i = 0;i < str.length; i++) {
      if (str[i] === token)
        ind++;
    }
    return ind;
  }
  function removeDotSegments(path) {
    let input = path;
    const output = [];
    let nextSlash = -1;
    let len = 0;
    while (len = input.length) {
      if (len === 1) {
        if (input === ".") {
          break;
        } else if (input === "/") {
          output.push("/");
          break;
        } else {
          output.push(input);
          break;
        }
      } else if (len === 2) {
        if (input[0] === ".") {
          if (input[1] === ".") {
            break;
          } else if (input[1] === "/") {
            input = input.slice(2);
            continue;
          }
        } else if (input[0] === "/") {
          if (input[1] === "." || input[1] === "/") {
            output.push("/");
            break;
          }
        }
      } else if (len === 3) {
        if (input === "/..") {
          if (output.length !== 0) {
            output.pop();
          }
          output.push("/");
          break;
        }
      }
      if (input[0] === ".") {
        if (input[1] === ".") {
          if (input[2] === "/") {
            input = input.slice(3);
            continue;
          }
        } else if (input[1] === "/") {
          input = input.slice(2);
          continue;
        }
      } else if (input[0] === "/") {
        if (input[1] === ".") {
          if (input[2] === "/") {
            input = input.slice(2);
            continue;
          } else if (input[2] === ".") {
            if (input[3] === "/") {
              input = input.slice(3);
              if (output.length !== 0) {
                output.pop();
              }
              continue;
            }
          }
        }
      }
      if ((nextSlash = input.indexOf("/", 1)) === -1) {
        output.push(input);
        break;
      } else {
        output.push(input.slice(0, nextSlash));
        input = input.slice(nextSlash);
      }
    }
    return output.join("");
  }
  function normalizeComponentEncoding(component, esc) {
    const func = esc !== true ? escape : unescape;
    if (component.scheme !== undefined) {
      component.scheme = func(component.scheme);
    }
    if (component.userinfo !== undefined) {
      component.userinfo = func(component.userinfo);
    }
    if (component.host !== undefined) {
      component.host = func(component.host);
    }
    if (component.path !== undefined) {
      component.path = func(component.path);
    }
    if (component.query !== undefined) {
      component.query = func(component.query);
    }
    if (component.fragment !== undefined) {
      component.fragment = func(component.fragment);
    }
    return component;
  }
  function recomposeAuthority(component) {
    const uriTokens = [];
    if (component.userinfo !== undefined) {
      uriTokens.push(component.userinfo);
      uriTokens.push("@");
    }
    if (component.host !== undefined) {
      let host = unescape(component.host);
      if (!isIPv4(host)) {
        const ipV6res = normalizeIPv6(host);
        if (ipV6res.isIPV6 === true) {
          host = `[${ipV6res.escapedHost}]`;
        } else {
          host = component.host;
        }
      }
      uriTokens.push(host);
    }
    if (typeof component.port === "number" || typeof component.port === "string") {
      uriTokens.push(":");
      uriTokens.push(String(component.port));
    }
    return uriTokens.length ? uriTokens.join("") : undefined;
  }
  module.exports = {
    nonSimpleDomain,
    recomposeAuthority,
    normalizeComponentEncoding,
    removeDotSegments,
    isIPv4,
    isUUID,
    normalizeIPv6,
    stringArrayToHexStripped
  };
});

// node_modules/fast-uri/lib/schemes.js
var require_schemes = __commonJS((exports, module) => {
  var { isUUID } = require_utils();
  var URN_REG = /([\da-z][\d\-a-z]{0,31}):((?:[\w!$'()*+,\-.:;=@]|%[\da-f]{2})+)/iu;
  var supportedSchemeNames = [
    "http",
    "https",
    "ws",
    "wss",
    "urn",
    "urn:uuid"
  ];
  function isValidSchemeName(name) {
    return supportedSchemeNames.indexOf(name) !== -1;
  }
  function wsIsSecure(wsComponent) {
    if (wsComponent.secure === true) {
      return true;
    } else if (wsComponent.secure === false) {
      return false;
    } else if (wsComponent.scheme) {
      return wsComponent.scheme.length === 3 && (wsComponent.scheme[0] === "w" || wsComponent.scheme[0] === "W") && (wsComponent.scheme[1] === "s" || wsComponent.scheme[1] === "S") && (wsComponent.scheme[2] === "s" || wsComponent.scheme[2] === "S");
    } else {
      return false;
    }
  }
  function httpParse(component) {
    if (!component.host) {
      component.error = component.error || "HTTP URIs must have a host.";
    }
    return component;
  }
  function httpSerialize(component) {
    const secure = String(component.scheme).toLowerCase() === "https";
    if (component.port === (secure ? 443 : 80) || component.port === "") {
      component.port = undefined;
    }
    if (!component.path) {
      component.path = "/";
    }
    return component;
  }
  function wsParse(wsComponent) {
    wsComponent.secure = wsIsSecure(wsComponent);
    wsComponent.resourceName = (wsComponent.path || "/") + (wsComponent.query ? "?" + wsComponent.query : "");
    wsComponent.path = undefined;
    wsComponent.query = undefined;
    return wsComponent;
  }
  function wsSerialize(wsComponent) {
    if (wsComponent.port === (wsIsSecure(wsComponent) ? 443 : 80) || wsComponent.port === "") {
      wsComponent.port = undefined;
    }
    if (typeof wsComponent.secure === "boolean") {
      wsComponent.scheme = wsComponent.secure ? "wss" : "ws";
      wsComponent.secure = undefined;
    }
    if (wsComponent.resourceName) {
      const [path, query] = wsComponent.resourceName.split("?");
      wsComponent.path = path && path !== "/" ? path : undefined;
      wsComponent.query = query;
      wsComponent.resourceName = undefined;
    }
    wsComponent.fragment = undefined;
    return wsComponent;
  }
  function urnParse(urnComponent, options) {
    if (!urnComponent.path) {
      urnComponent.error = "URN can not be parsed";
      return urnComponent;
    }
    const matches = urnComponent.path.match(URN_REG);
    if (matches) {
      const scheme = options.scheme || urnComponent.scheme || "urn";
      urnComponent.nid = matches[1].toLowerCase();
      urnComponent.nss = matches[2];
      const urnScheme = `${scheme}:${options.nid || urnComponent.nid}`;
      const schemeHandler = getSchemeHandler(urnScheme);
      urnComponent.path = undefined;
      if (schemeHandler) {
        urnComponent = schemeHandler.parse(urnComponent, options);
      }
    } else {
      urnComponent.error = urnComponent.error || "URN can not be parsed.";
    }
    return urnComponent;
  }
  function urnSerialize(urnComponent, options) {
    if (urnComponent.nid === undefined) {
      throw new Error("URN without nid cannot be serialized");
    }
    const scheme = options.scheme || urnComponent.scheme || "urn";
    const nid = urnComponent.nid.toLowerCase();
    const urnScheme = `${scheme}:${options.nid || nid}`;
    const schemeHandler = getSchemeHandler(urnScheme);
    if (schemeHandler) {
      urnComponent = schemeHandler.serialize(urnComponent, options);
    }
    const uriComponent = urnComponent;
    const nss = urnComponent.nss;
    uriComponent.path = `${nid || options.nid}:${nss}`;
    options.skipEscape = true;
    return uriComponent;
  }
  function urnuuidParse(urnComponent, options) {
    const uuidComponent = urnComponent;
    uuidComponent.uuid = uuidComponent.nss;
    uuidComponent.nss = undefined;
    if (!options.tolerant && (!uuidComponent.uuid || !isUUID(uuidComponent.uuid))) {
      uuidComponent.error = uuidComponent.error || "UUID is not valid.";
    }
    return uuidComponent;
  }
  function urnuuidSerialize(uuidComponent) {
    const urnComponent = uuidComponent;
    urnComponent.nss = (uuidComponent.uuid || "").toLowerCase();
    return urnComponent;
  }
  var http = {
    scheme: "http",
    domainHost: true,
    parse: httpParse,
    serialize: httpSerialize
  };
  var https = {
    scheme: "https",
    domainHost: http.domainHost,
    parse: httpParse,
    serialize: httpSerialize
  };
  var ws = {
    scheme: "ws",
    domainHost: true,
    parse: wsParse,
    serialize: wsSerialize
  };
  var wss = {
    scheme: "wss",
    domainHost: ws.domainHost,
    parse: ws.parse,
    serialize: ws.serialize
  };
  var urn = {
    scheme: "urn",
    parse: urnParse,
    serialize: urnSerialize,
    skipNormalize: true
  };
  var urnuuid = {
    scheme: "urn:uuid",
    parse: urnuuidParse,
    serialize: urnuuidSerialize,
    skipNormalize: true
  };
  var SCHEMES = {
    http,
    https,
    ws,
    wss,
    urn,
    "urn:uuid": urnuuid
  };
  Object.setPrototypeOf(SCHEMES, null);
  function getSchemeHandler(scheme) {
    return scheme && (SCHEMES[scheme] || SCHEMES[scheme.toLowerCase()]) || undefined;
  }
  module.exports = {
    wsIsSecure,
    SCHEMES,
    isValidSchemeName,
    getSchemeHandler
  };
});

// node_modules/fast-uri/index.js
var require_fast_uri = __commonJS((exports, module) => {
  var { normalizeIPv6, removeDotSegments, recomposeAuthority, normalizeComponentEncoding, isIPv4, nonSimpleDomain } = require_utils();
  var { SCHEMES, getSchemeHandler } = require_schemes();
  function normalize(uri, options) {
    if (typeof uri === "string") {
      uri = serialize(parse(uri, options), options);
    } else if (typeof uri === "object") {
      uri = parse(serialize(uri, options), options);
    }
    return uri;
  }
  function resolve(baseURI, relativeURI, options) {
    const schemelessOptions = options ? Object.assign({ scheme: "null" }, options) : { scheme: "null" };
    const resolved = resolveComponent(parse(baseURI, schemelessOptions), parse(relativeURI, schemelessOptions), schemelessOptions, true);
    schemelessOptions.skipEscape = true;
    return serialize(resolved, schemelessOptions);
  }
  function resolveComponent(base, relative, options, skipNormalization) {
    const target = {};
    if (!skipNormalization) {
      base = parse(serialize(base, options), options);
      relative = parse(serialize(relative, options), options);
    }
    options = options || {};
    if (!options.tolerant && relative.scheme) {
      target.scheme = relative.scheme;
      target.userinfo = relative.userinfo;
      target.host = relative.host;
      target.port = relative.port;
      target.path = removeDotSegments(relative.path || "");
      target.query = relative.query;
    } else {
      if (relative.userinfo !== undefined || relative.host !== undefined || relative.port !== undefined) {
        target.userinfo = relative.userinfo;
        target.host = relative.host;
        target.port = relative.port;
        target.path = removeDotSegments(relative.path || "");
        target.query = relative.query;
      } else {
        if (!relative.path) {
          target.path = base.path;
          if (relative.query !== undefined) {
            target.query = relative.query;
          } else {
            target.query = base.query;
          }
        } else {
          if (relative.path[0] === "/") {
            target.path = removeDotSegments(relative.path);
          } else {
            if ((base.userinfo !== undefined || base.host !== undefined || base.port !== undefined) && !base.path) {
              target.path = "/" + relative.path;
            } else if (!base.path) {
              target.path = relative.path;
            } else {
              target.path = base.path.slice(0, base.path.lastIndexOf("/") + 1) + relative.path;
            }
            target.path = removeDotSegments(target.path);
          }
          target.query = relative.query;
        }
        target.userinfo = base.userinfo;
        target.host = base.host;
        target.port = base.port;
      }
      target.scheme = base.scheme;
    }
    target.fragment = relative.fragment;
    return target;
  }
  function equal(uriA, uriB, options) {
    if (typeof uriA === "string") {
      uriA = unescape(uriA);
      uriA = serialize(normalizeComponentEncoding(parse(uriA, options), true), { ...options, skipEscape: true });
    } else if (typeof uriA === "object") {
      uriA = serialize(normalizeComponentEncoding(uriA, true), { ...options, skipEscape: true });
    }
    if (typeof uriB === "string") {
      uriB = unescape(uriB);
      uriB = serialize(normalizeComponentEncoding(parse(uriB, options), true), { ...options, skipEscape: true });
    } else if (typeof uriB === "object") {
      uriB = serialize(normalizeComponentEncoding(uriB, true), { ...options, skipEscape: true });
    }
    return uriA.toLowerCase() === uriB.toLowerCase();
  }
  function serialize(cmpts, opts) {
    const component = {
      host: cmpts.host,
      scheme: cmpts.scheme,
      userinfo: cmpts.userinfo,
      port: cmpts.port,
      path: cmpts.path,
      query: cmpts.query,
      nid: cmpts.nid,
      nss: cmpts.nss,
      uuid: cmpts.uuid,
      fragment: cmpts.fragment,
      reference: cmpts.reference,
      resourceName: cmpts.resourceName,
      secure: cmpts.secure,
      error: ""
    };
    const options = Object.assign({}, opts);
    const uriTokens = [];
    const schemeHandler = getSchemeHandler(options.scheme || component.scheme);
    if (schemeHandler && schemeHandler.serialize)
      schemeHandler.serialize(component, options);
    if (component.path !== undefined) {
      if (!options.skipEscape) {
        component.path = escape(component.path);
        if (component.scheme !== undefined) {
          component.path = component.path.split("%3A").join(":");
        }
      } else {
        component.path = unescape(component.path);
      }
    }
    if (options.reference !== "suffix" && component.scheme) {
      uriTokens.push(component.scheme, ":");
    }
    const authority = recomposeAuthority(component);
    if (authority !== undefined) {
      if (options.reference !== "suffix") {
        uriTokens.push("//");
      }
      uriTokens.push(authority);
      if (component.path && component.path[0] !== "/") {
        uriTokens.push("/");
      }
    }
    if (component.path !== undefined) {
      let s = component.path;
      if (!options.absolutePath && (!schemeHandler || !schemeHandler.absolutePath)) {
        s = removeDotSegments(s);
      }
      if (authority === undefined && s[0] === "/" && s[1] === "/") {
        s = "/%2F" + s.slice(2);
      }
      uriTokens.push(s);
    }
    if (component.query !== undefined) {
      uriTokens.push("?", component.query);
    }
    if (component.fragment !== undefined) {
      uriTokens.push("#", component.fragment);
    }
    return uriTokens.join("");
  }
  var URI_PARSE = /^(?:([^#/:?]+):)?(?:\/\/((?:([^#/?@]*)@)?(\[[^#/?\]]+\]|[^#/:?]*)(?::(\d*))?))?([^#?]*)(?:\?([^#]*))?(?:#((?:.|[\n\r])*))?/u;
  function parse(uri, opts) {
    const options = Object.assign({}, opts);
    const parsed = {
      scheme: undefined,
      userinfo: undefined,
      host: "",
      port: undefined,
      path: "",
      query: undefined,
      fragment: undefined
    };
    let isIP = false;
    if (options.reference === "suffix") {
      if (options.scheme) {
        uri = options.scheme + ":" + uri;
      } else {
        uri = "//" + uri;
      }
    }
    const matches = uri.match(URI_PARSE);
    if (matches) {
      parsed.scheme = matches[1];
      parsed.userinfo = matches[3];
      parsed.host = matches[4];
      parsed.port = parseInt(matches[5], 10);
      parsed.path = matches[6] || "";
      parsed.query = matches[7];
      parsed.fragment = matches[8];
      if (isNaN(parsed.port)) {
        parsed.port = matches[5];
      }
      if (parsed.host) {
        const ipv4result = isIPv4(parsed.host);
        if (ipv4result === false) {
          const ipv6result = normalizeIPv6(parsed.host);
          parsed.host = ipv6result.host.toLowerCase();
          isIP = ipv6result.isIPV6;
        } else {
          isIP = true;
        }
      }
      if (parsed.scheme === undefined && parsed.userinfo === undefined && parsed.host === undefined && parsed.port === undefined && parsed.query === undefined && !parsed.path) {
        parsed.reference = "same-document";
      } else if (parsed.scheme === undefined) {
        parsed.reference = "relative";
      } else if (parsed.fragment === undefined) {
        parsed.reference = "absolute";
      } else {
        parsed.reference = "uri";
      }
      if (options.reference && options.reference !== "suffix" && options.reference !== parsed.reference) {
        parsed.error = parsed.error || "URI is not a " + options.reference + " reference.";
      }
      const schemeHandler = getSchemeHandler(options.scheme || parsed.scheme);
      if (!options.unicodeSupport && (!schemeHandler || !schemeHandler.unicodeSupport)) {
        if (parsed.host && (options.domainHost || schemeHandler && schemeHandler.domainHost) && isIP === false && nonSimpleDomain(parsed.host)) {
          try {
            parsed.host = URL.domainToASCII(parsed.host.toLowerCase());
          } catch (e) {
            parsed.error = parsed.error || "Host's domain name can not be converted to ASCII: " + e;
          }
        }
      }
      if (!schemeHandler || schemeHandler && !schemeHandler.skipNormalize) {
        if (uri.indexOf("%") !== -1) {
          if (parsed.scheme !== undefined) {
            parsed.scheme = unescape(parsed.scheme);
          }
          if (parsed.host !== undefined) {
            parsed.host = unescape(parsed.host);
          }
        }
        if (parsed.path) {
          parsed.path = escape(unescape(parsed.path));
        }
        if (parsed.fragment) {
          parsed.fragment = encodeURI(decodeURIComponent(parsed.fragment));
        }
      }
      if (schemeHandler && schemeHandler.parse) {
        schemeHandler.parse(parsed, options);
      }
    } else {
      parsed.error = parsed.error || "URI can not be parsed.";
    }
    return parsed;
  }
  var fastUri = {
    SCHEMES,
    normalize,
    resolve,
    resolveComponent,
    equal,
    serialize,
    parse
  };
  module.exports = fastUri;
  module.exports.default = fastUri;
  module.exports.fastUri = fastUri;
});

// node_modules/ajv/dist/runtime/uri.js
var require_uri = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var uri = require_fast_uri();
  uri.code = 'require("ajv/dist/runtime/uri").default';
  exports.default = uri;
});

// node_modules/ajv/dist/core.js
var require_core = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.CodeGen = exports.Name = exports.nil = exports.stringify = exports.str = exports._ = exports.KeywordCxt = undefined;
  var validate_1 = require_validate();
  Object.defineProperty(exports, "KeywordCxt", { enumerable: true, get: function() {
    return validate_1.KeywordCxt;
  } });
  var codegen_1 = require_codegen();
  Object.defineProperty(exports, "_", { enumerable: true, get: function() {
    return codegen_1._;
  } });
  Object.defineProperty(exports, "str", { enumerable: true, get: function() {
    return codegen_1.str;
  } });
  Object.defineProperty(exports, "stringify", { enumerable: true, get: function() {
    return codegen_1.stringify;
  } });
  Object.defineProperty(exports, "nil", { enumerable: true, get: function() {
    return codegen_1.nil;
  } });
  Object.defineProperty(exports, "Name", { enumerable: true, get: function() {
    return codegen_1.Name;
  } });
  Object.defineProperty(exports, "CodeGen", { enumerable: true, get: function() {
    return codegen_1.CodeGen;
  } });
  var validation_error_1 = require_validation_error();
  var ref_error_1 = require_ref_error();
  var rules_1 = require_rules();
  var compile_1 = require_compile();
  var codegen_2 = require_codegen();
  var resolve_1 = require_resolve();
  var dataType_1 = require_dataType();
  var util_1 = require_util();
  var $dataRefSchema = require_data();
  var uri_1 = require_uri();
  var defaultRegExp = (str, flags) => new RegExp(str, flags);
  defaultRegExp.code = "new RegExp";
  var META_IGNORE_OPTIONS = ["removeAdditional", "useDefaults", "coerceTypes"];
  var EXT_SCOPE_NAMES = new Set([
    "validate",
    "serialize",
    "parse",
    "wrapper",
    "root",
    "schema",
    "keyword",
    "pattern",
    "formats",
    "validate$data",
    "func",
    "obj",
    "Error"
  ]);
  var removedOptions = {
    errorDataPath: "",
    format: "`validateFormats: false` can be used instead.",
    nullable: '"nullable" keyword is supported by default.',
    jsonPointers: "Deprecated jsPropertySyntax can be used instead.",
    extendRefs: "Deprecated ignoreKeywordsWithRef can be used instead.",
    missingRefs: "Pass empty schema with $id that should be ignored to ajv.addSchema.",
    processCode: "Use option `code: {process: (code, schemaEnv: object) => string}`",
    sourceCode: "Use option `code: {source: true}`",
    strictDefaults: "It is default now, see option `strict`.",
    strictKeywords: "It is default now, see option `strict`.",
    uniqueItems: '"uniqueItems" keyword is always validated.',
    unknownFormats: "Disable strict mode or pass `true` to `ajv.addFormat` (or `formats` option).",
    cache: "Map is used as cache, schema object as key.",
    serialize: "Map is used as cache, schema object as key.",
    ajvErrors: "It is default now."
  };
  var deprecatedOptions = {
    ignoreKeywordsWithRef: "",
    jsPropertySyntax: "",
    unicode: '"minLength"/"maxLength" account for unicode characters by default.'
  };
  var MAX_EXPRESSION = 200;
  function requiredOptions(o) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0;
    const s = o.strict;
    const _optz = (_a = o.code) === null || _a === undefined ? undefined : _a.optimize;
    const optimize = _optz === true || _optz === undefined ? 1 : _optz || 0;
    const regExp = (_c = (_b = o.code) === null || _b === undefined ? undefined : _b.regExp) !== null && _c !== undefined ? _c : defaultRegExp;
    const uriResolver = (_d = o.uriResolver) !== null && _d !== undefined ? _d : uri_1.default;
    return {
      strictSchema: (_f = (_e = o.strictSchema) !== null && _e !== undefined ? _e : s) !== null && _f !== undefined ? _f : true,
      strictNumbers: (_h = (_g = o.strictNumbers) !== null && _g !== undefined ? _g : s) !== null && _h !== undefined ? _h : true,
      strictTypes: (_k = (_j = o.strictTypes) !== null && _j !== undefined ? _j : s) !== null && _k !== undefined ? _k : "log",
      strictTuples: (_m = (_l = o.strictTuples) !== null && _l !== undefined ? _l : s) !== null && _m !== undefined ? _m : "log",
      strictRequired: (_p = (_o = o.strictRequired) !== null && _o !== undefined ? _o : s) !== null && _p !== undefined ? _p : false,
      code: o.code ? { ...o.code, optimize, regExp } : { optimize, regExp },
      loopRequired: (_q = o.loopRequired) !== null && _q !== undefined ? _q : MAX_EXPRESSION,
      loopEnum: (_r = o.loopEnum) !== null && _r !== undefined ? _r : MAX_EXPRESSION,
      meta: (_s = o.meta) !== null && _s !== undefined ? _s : true,
      messages: (_t = o.messages) !== null && _t !== undefined ? _t : true,
      inlineRefs: (_u = o.inlineRefs) !== null && _u !== undefined ? _u : true,
      schemaId: (_v = o.schemaId) !== null && _v !== undefined ? _v : "$id",
      addUsedSchema: (_w = o.addUsedSchema) !== null && _w !== undefined ? _w : true,
      validateSchema: (_x = o.validateSchema) !== null && _x !== undefined ? _x : true,
      validateFormats: (_y = o.validateFormats) !== null && _y !== undefined ? _y : true,
      unicodeRegExp: (_z = o.unicodeRegExp) !== null && _z !== undefined ? _z : true,
      int32range: (_0 = o.int32range) !== null && _0 !== undefined ? _0 : true,
      uriResolver
    };
  }

  class Ajv {
    constructor(opts = {}) {
      this.schemas = {};
      this.refs = {};
      this.formats = {};
      this._compilations = new Set;
      this._loading = {};
      this._cache = new Map;
      opts = this.opts = { ...opts, ...requiredOptions(opts) };
      const { es5, lines } = this.opts.code;
      this.scope = new codegen_2.ValueScope({ scope: {}, prefixes: EXT_SCOPE_NAMES, es5, lines });
      this.logger = getLogger(opts.logger);
      const formatOpt = opts.validateFormats;
      opts.validateFormats = false;
      this.RULES = (0, rules_1.getRules)();
      checkOptions.call(this, removedOptions, opts, "NOT SUPPORTED");
      checkOptions.call(this, deprecatedOptions, opts, "DEPRECATED", "warn");
      this._metaOpts = getMetaSchemaOptions.call(this);
      if (opts.formats)
        addInitialFormats.call(this);
      this._addVocabularies();
      this._addDefaultMetaSchema();
      if (opts.keywords)
        addInitialKeywords.call(this, opts.keywords);
      if (typeof opts.meta == "object")
        this.addMetaSchema(opts.meta);
      addInitialSchemas.call(this);
      opts.validateFormats = formatOpt;
    }
    _addVocabularies() {
      this.addKeyword("$async");
    }
    _addDefaultMetaSchema() {
      const { $data, meta, schemaId } = this.opts;
      let _dataRefSchema = $dataRefSchema;
      if (schemaId === "id") {
        _dataRefSchema = { ...$dataRefSchema };
        _dataRefSchema.id = _dataRefSchema.$id;
        delete _dataRefSchema.$id;
      }
      if (meta && $data)
        this.addMetaSchema(_dataRefSchema, _dataRefSchema[schemaId], false);
    }
    defaultMeta() {
      const { meta, schemaId } = this.opts;
      return this.opts.defaultMeta = typeof meta == "object" ? meta[schemaId] || meta : undefined;
    }
    validate(schemaKeyRef, data) {
      let v;
      if (typeof schemaKeyRef == "string") {
        v = this.getSchema(schemaKeyRef);
        if (!v)
          throw new Error(`no schema with key or ref "${schemaKeyRef}"`);
      } else {
        v = this.compile(schemaKeyRef);
      }
      const valid = v(data);
      if (!("$async" in v))
        this.errors = v.errors;
      return valid;
    }
    compile(schema, _meta) {
      const sch = this._addSchema(schema, _meta);
      return sch.validate || this._compileSchemaEnv(sch);
    }
    compileAsync(schema, meta) {
      if (typeof this.opts.loadSchema != "function") {
        throw new Error("options.loadSchema should be a function");
      }
      const { loadSchema } = this.opts;
      return runCompileAsync.call(this, schema, meta);
      async function runCompileAsync(_schema, _meta) {
        await loadMetaSchema.call(this, _schema.$schema);
        const sch = this._addSchema(_schema, _meta);
        return sch.validate || _compileAsync.call(this, sch);
      }
      async function loadMetaSchema($ref) {
        if ($ref && !this.getSchema($ref)) {
          await runCompileAsync.call(this, { $ref }, true);
        }
      }
      async function _compileAsync(sch) {
        try {
          return this._compileSchemaEnv(sch);
        } catch (e) {
          if (!(e instanceof ref_error_1.default))
            throw e;
          checkLoaded.call(this, e);
          await loadMissingSchema.call(this, e.missingSchema);
          return _compileAsync.call(this, sch);
        }
      }
      function checkLoaded({ missingSchema: ref, missingRef }) {
        if (this.refs[ref]) {
          throw new Error(`AnySchema ${ref} is loaded but ${missingRef} cannot be resolved`);
        }
      }
      async function loadMissingSchema(ref) {
        const _schema = await _loadSchema.call(this, ref);
        if (!this.refs[ref])
          await loadMetaSchema.call(this, _schema.$schema);
        if (!this.refs[ref])
          this.addSchema(_schema, ref, meta);
      }
      async function _loadSchema(ref) {
        const p = this._loading[ref];
        if (p)
          return p;
        try {
          return await (this._loading[ref] = loadSchema(ref));
        } finally {
          delete this._loading[ref];
        }
      }
    }
    addSchema(schema, key, _meta, _validateSchema = this.opts.validateSchema) {
      if (Array.isArray(schema)) {
        for (const sch of schema)
          this.addSchema(sch, undefined, _meta, _validateSchema);
        return this;
      }
      let id;
      if (typeof schema === "object") {
        const { schemaId } = this.opts;
        id = schema[schemaId];
        if (id !== undefined && typeof id != "string") {
          throw new Error(`schema ${schemaId} must be string`);
        }
      }
      key = (0, resolve_1.normalizeId)(key || id);
      this._checkUnique(key);
      this.schemas[key] = this._addSchema(schema, _meta, key, _validateSchema, true);
      return this;
    }
    addMetaSchema(schema, key, _validateSchema = this.opts.validateSchema) {
      this.addSchema(schema, key, true, _validateSchema);
      return this;
    }
    validateSchema(schema, throwOrLogError) {
      if (typeof schema == "boolean")
        return true;
      let $schema;
      $schema = schema.$schema;
      if ($schema !== undefined && typeof $schema != "string") {
        throw new Error("$schema must be a string");
      }
      $schema = $schema || this.opts.defaultMeta || this.defaultMeta();
      if (!$schema) {
        this.logger.warn("meta-schema not available");
        this.errors = null;
        return true;
      }
      const valid = this.validate($schema, schema);
      if (!valid && throwOrLogError) {
        const message = "schema is invalid: " + this.errorsText();
        if (this.opts.validateSchema === "log")
          this.logger.error(message);
        else
          throw new Error(message);
      }
      return valid;
    }
    getSchema(keyRef) {
      let sch;
      while (typeof (sch = getSchEnv.call(this, keyRef)) == "string")
        keyRef = sch;
      if (sch === undefined) {
        const { schemaId } = this.opts;
        const root = new compile_1.SchemaEnv({ schema: {}, schemaId });
        sch = compile_1.resolveSchema.call(this, root, keyRef);
        if (!sch)
          return;
        this.refs[keyRef] = sch;
      }
      return sch.validate || this._compileSchemaEnv(sch);
    }
    removeSchema(schemaKeyRef) {
      if (schemaKeyRef instanceof RegExp) {
        this._removeAllSchemas(this.schemas, schemaKeyRef);
        this._removeAllSchemas(this.refs, schemaKeyRef);
        return this;
      }
      switch (typeof schemaKeyRef) {
        case "undefined":
          this._removeAllSchemas(this.schemas);
          this._removeAllSchemas(this.refs);
          this._cache.clear();
          return this;
        case "string": {
          const sch = getSchEnv.call(this, schemaKeyRef);
          if (typeof sch == "object")
            this._cache.delete(sch.schema);
          delete this.schemas[schemaKeyRef];
          delete this.refs[schemaKeyRef];
          return this;
        }
        case "object": {
          const cacheKey = schemaKeyRef;
          this._cache.delete(cacheKey);
          let id = schemaKeyRef[this.opts.schemaId];
          if (id) {
            id = (0, resolve_1.normalizeId)(id);
            delete this.schemas[id];
            delete this.refs[id];
          }
          return this;
        }
        default:
          throw new Error("ajv.removeSchema: invalid parameter");
      }
    }
    addVocabulary(definitions) {
      for (const def of definitions)
        this.addKeyword(def);
      return this;
    }
    addKeyword(kwdOrDef, def) {
      let keyword;
      if (typeof kwdOrDef == "string") {
        keyword = kwdOrDef;
        if (typeof def == "object") {
          this.logger.warn("these parameters are deprecated, see docs for addKeyword");
          def.keyword = keyword;
        }
      } else if (typeof kwdOrDef == "object" && def === undefined) {
        def = kwdOrDef;
        keyword = def.keyword;
        if (Array.isArray(keyword) && !keyword.length) {
          throw new Error("addKeywords: keyword must be string or non-empty array");
        }
      } else {
        throw new Error("invalid addKeywords parameters");
      }
      checkKeyword.call(this, keyword, def);
      if (!def) {
        (0, util_1.eachItem)(keyword, (kwd) => addRule.call(this, kwd));
        return this;
      }
      keywordMetaschema.call(this, def);
      const definition = {
        ...def,
        type: (0, dataType_1.getJSONTypes)(def.type),
        schemaType: (0, dataType_1.getJSONTypes)(def.schemaType)
      };
      (0, util_1.eachItem)(keyword, definition.type.length === 0 ? (k) => addRule.call(this, k, definition) : (k) => definition.type.forEach((t) => addRule.call(this, k, definition, t)));
      return this;
    }
    getKeyword(keyword) {
      const rule = this.RULES.all[keyword];
      return typeof rule == "object" ? rule.definition : !!rule;
    }
    removeKeyword(keyword) {
      const { RULES } = this;
      delete RULES.keywords[keyword];
      delete RULES.all[keyword];
      for (const group of RULES.rules) {
        const i = group.rules.findIndex((rule) => rule.keyword === keyword);
        if (i >= 0)
          group.rules.splice(i, 1);
      }
      return this;
    }
    addFormat(name, format) {
      if (typeof format == "string")
        format = new RegExp(format);
      this.formats[name] = format;
      return this;
    }
    errorsText(errors = this.errors, { separator = ", ", dataVar = "data" } = {}) {
      if (!errors || errors.length === 0)
        return "No errors";
      return errors.map((e) => `${dataVar}${e.instancePath} ${e.message}`).reduce((text, msg) => text + separator + msg);
    }
    $dataMetaSchema(metaSchema, keywordsJsonPointers) {
      const rules = this.RULES.all;
      metaSchema = JSON.parse(JSON.stringify(metaSchema));
      for (const jsonPointer of keywordsJsonPointers) {
        const segments = jsonPointer.split("/").slice(1);
        let keywords = metaSchema;
        for (const seg of segments)
          keywords = keywords[seg];
        for (const key in rules) {
          const rule = rules[key];
          if (typeof rule != "object")
            continue;
          const { $data } = rule.definition;
          const schema = keywords[key];
          if ($data && schema)
            keywords[key] = schemaOrData(schema);
        }
      }
      return metaSchema;
    }
    _removeAllSchemas(schemas, regex) {
      for (const keyRef in schemas) {
        const sch = schemas[keyRef];
        if (!regex || regex.test(keyRef)) {
          if (typeof sch == "string") {
            delete schemas[keyRef];
          } else if (sch && !sch.meta) {
            this._cache.delete(sch.schema);
            delete schemas[keyRef];
          }
        }
      }
    }
    _addSchema(schema, meta, baseId, validateSchema = this.opts.validateSchema, addSchema = this.opts.addUsedSchema) {
      let id;
      const { schemaId } = this.opts;
      if (typeof schema == "object") {
        id = schema[schemaId];
      } else {
        if (this.opts.jtd)
          throw new Error("schema must be object");
        else if (typeof schema != "boolean")
          throw new Error("schema must be object or boolean");
      }
      let sch = this._cache.get(schema);
      if (sch !== undefined)
        return sch;
      baseId = (0, resolve_1.normalizeId)(id || baseId);
      const localRefs = resolve_1.getSchemaRefs.call(this, schema, baseId);
      sch = new compile_1.SchemaEnv({ schema, schemaId, meta, baseId, localRefs });
      this._cache.set(sch.schema, sch);
      if (addSchema && !baseId.startsWith("#")) {
        if (baseId)
          this._checkUnique(baseId);
        this.refs[baseId] = sch;
      }
      if (validateSchema)
        this.validateSchema(schema, true);
      return sch;
    }
    _checkUnique(id) {
      if (this.schemas[id] || this.refs[id]) {
        throw new Error(`schema with key or id "${id}" already exists`);
      }
    }
    _compileSchemaEnv(sch) {
      if (sch.meta)
        this._compileMetaSchema(sch);
      else
        compile_1.compileSchema.call(this, sch);
      if (!sch.validate)
        throw new Error("ajv implementation error");
      return sch.validate;
    }
    _compileMetaSchema(sch) {
      const currentOpts = this.opts;
      this.opts = this._metaOpts;
      try {
        compile_1.compileSchema.call(this, sch);
      } finally {
        this.opts = currentOpts;
      }
    }
  }
  Ajv.ValidationError = validation_error_1.default;
  Ajv.MissingRefError = ref_error_1.default;
  exports.default = Ajv;
  function checkOptions(checkOpts, options, msg, log = "error") {
    for (const key in checkOpts) {
      const opt = key;
      if (opt in options)
        this.logger[log](`${msg}: option ${key}. ${checkOpts[opt]}`);
    }
  }
  function getSchEnv(keyRef) {
    keyRef = (0, resolve_1.normalizeId)(keyRef);
    return this.schemas[keyRef] || this.refs[keyRef];
  }
  function addInitialSchemas() {
    const optsSchemas = this.opts.schemas;
    if (!optsSchemas)
      return;
    if (Array.isArray(optsSchemas))
      this.addSchema(optsSchemas);
    else
      for (const key in optsSchemas)
        this.addSchema(optsSchemas[key], key);
  }
  function addInitialFormats() {
    for (const name in this.opts.formats) {
      const format = this.opts.formats[name];
      if (format)
        this.addFormat(name, format);
    }
  }
  function addInitialKeywords(defs) {
    if (Array.isArray(defs)) {
      this.addVocabulary(defs);
      return;
    }
    this.logger.warn("keywords option as map is deprecated, pass array");
    for (const keyword in defs) {
      const def = defs[keyword];
      if (!def.keyword)
        def.keyword = keyword;
      this.addKeyword(def);
    }
  }
  function getMetaSchemaOptions() {
    const metaOpts = { ...this.opts };
    for (const opt of META_IGNORE_OPTIONS)
      delete metaOpts[opt];
    return metaOpts;
  }
  var noLogs = { log() {}, warn() {}, error() {} };
  function getLogger(logger) {
    if (logger === false)
      return noLogs;
    if (logger === undefined)
      return console;
    if (logger.log && logger.warn && logger.error)
      return logger;
    throw new Error("logger must implement log, warn and error methods");
  }
  var KEYWORD_NAME = /^[a-z_$][a-z0-9_$:-]*$/i;
  function checkKeyword(keyword, def) {
    const { RULES } = this;
    (0, util_1.eachItem)(keyword, (kwd) => {
      if (RULES.keywords[kwd])
        throw new Error(`Keyword ${kwd} is already defined`);
      if (!KEYWORD_NAME.test(kwd))
        throw new Error(`Keyword ${kwd} has invalid name`);
    });
    if (!def)
      return;
    if (def.$data && !(("code" in def) || ("validate" in def))) {
      throw new Error('$data keyword must have "code" or "validate" function');
    }
  }
  function addRule(keyword, definition, dataType) {
    var _a;
    const post = definition === null || definition === undefined ? undefined : definition.post;
    if (dataType && post)
      throw new Error('keyword with "post" flag cannot have "type"');
    const { RULES } = this;
    let ruleGroup = post ? RULES.post : RULES.rules.find(({ type: t }) => t === dataType);
    if (!ruleGroup) {
      ruleGroup = { type: dataType, rules: [] };
      RULES.rules.push(ruleGroup);
    }
    RULES.keywords[keyword] = true;
    if (!definition)
      return;
    const rule = {
      keyword,
      definition: {
        ...definition,
        type: (0, dataType_1.getJSONTypes)(definition.type),
        schemaType: (0, dataType_1.getJSONTypes)(definition.schemaType)
      }
    };
    if (definition.before)
      addBeforeRule.call(this, ruleGroup, rule, definition.before);
    else
      ruleGroup.rules.push(rule);
    RULES.all[keyword] = rule;
    (_a = definition.implements) === null || _a === undefined || _a.forEach((kwd) => this.addKeyword(kwd));
  }
  function addBeforeRule(ruleGroup, rule, before) {
    const i = ruleGroup.rules.findIndex((_rule) => _rule.keyword === before);
    if (i >= 0) {
      ruleGroup.rules.splice(i, 0, rule);
    } else {
      ruleGroup.rules.push(rule);
      this.logger.warn(`rule ${before} is not defined`);
    }
  }
  function keywordMetaschema(def) {
    let { metaSchema } = def;
    if (metaSchema === undefined)
      return;
    if (def.$data && this.opts.$data)
      metaSchema = schemaOrData(metaSchema);
    def.validateSchema = this.compile(metaSchema, true);
  }
  var $dataRef = {
    $ref: "https://raw.githubusercontent.com/ajv-validator/ajv/master/lib/refs/data.json#"
  };
  function schemaOrData(schema) {
    return { anyOf: [schema, $dataRef] };
  }
});

// node_modules/ajv/dist/vocabularies/core/id.js
var require_id = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var def = {
    keyword: "id",
    code() {
      throw new Error('NOT SUPPORTED: keyword "id", use "$id" for schema ID');
    }
  };
  exports.default = def;
});

// node_modules/ajv/dist/vocabularies/core/ref.js
var require_ref = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.callRef = exports.getValidate = undefined;
  var ref_error_1 = require_ref_error();
  var code_1 = require_code2();
  var codegen_1 = require_codegen();
  var names_1 = require_names();
  var compile_1 = require_compile();
  var util_1 = require_util();
  var def = {
    keyword: "$ref",
    schemaType: "string",
    code(cxt) {
      const { gen, schema: $ref, it } = cxt;
      const { baseId, schemaEnv: env, validateName, opts, self } = it;
      const { root } = env;
      if (($ref === "#" || $ref === "#/") && baseId === root.baseId)
        return callRootRef();
      const schOrEnv = compile_1.resolveRef.call(self, root, baseId, $ref);
      if (schOrEnv === undefined)
        throw new ref_error_1.default(it.opts.uriResolver, baseId, $ref);
      if (schOrEnv instanceof compile_1.SchemaEnv)
        return callValidate(schOrEnv);
      return inlineRefSchema(schOrEnv);
      function callRootRef() {
        if (env === root)
          return callRef(cxt, validateName, env, env.$async);
        const rootName = gen.scopeValue("root", { ref: root });
        return callRef(cxt, (0, codegen_1._)`${rootName}.validate`, root, root.$async);
      }
      function callValidate(sch) {
        const v = getValidate(cxt, sch);
        callRef(cxt, v, sch, sch.$async);
      }
      function inlineRefSchema(sch) {
        const schName = gen.scopeValue("schema", opts.code.source === true ? { ref: sch, code: (0, codegen_1.stringify)(sch) } : { ref: sch });
        const valid = gen.name("valid");
        const schCxt = cxt.subschema({
          schema: sch,
          dataTypes: [],
          schemaPath: codegen_1.nil,
          topSchemaRef: schName,
          errSchemaPath: $ref
        }, valid);
        cxt.mergeEvaluated(schCxt);
        cxt.ok(valid);
      }
    }
  };
  function getValidate(cxt, sch) {
    const { gen } = cxt;
    return sch.validate ? gen.scopeValue("validate", { ref: sch.validate }) : (0, codegen_1._)`${gen.scopeValue("wrapper", { ref: sch })}.validate`;
  }
  exports.getValidate = getValidate;
  function callRef(cxt, v, sch, $async) {
    const { gen, it } = cxt;
    const { allErrors, schemaEnv: env, opts } = it;
    const passCxt = opts.passContext ? names_1.default.this : codegen_1.nil;
    if ($async)
      callAsyncRef();
    else
      callSyncRef();
    function callAsyncRef() {
      if (!env.$async)
        throw new Error("async schema referenced by sync schema");
      const valid = gen.let("valid");
      gen.try(() => {
        gen.code((0, codegen_1._)`await ${(0, code_1.callValidateCode)(cxt, v, passCxt)}`);
        addEvaluatedFrom(v);
        if (!allErrors)
          gen.assign(valid, true);
      }, (e) => {
        gen.if((0, codegen_1._)`!(${e} instanceof ${it.ValidationError})`, () => gen.throw(e));
        addErrorsFrom(e);
        if (!allErrors)
          gen.assign(valid, false);
      });
      cxt.ok(valid);
    }
    function callSyncRef() {
      cxt.result((0, code_1.callValidateCode)(cxt, v, passCxt), () => addEvaluatedFrom(v), () => addErrorsFrom(v));
    }
    function addErrorsFrom(source) {
      const errs = (0, codegen_1._)`${source}.errors`;
      gen.assign(names_1.default.vErrors, (0, codegen_1._)`${names_1.default.vErrors} === null ? ${errs} : ${names_1.default.vErrors}.concat(${errs})`);
      gen.assign(names_1.default.errors, (0, codegen_1._)`${names_1.default.vErrors}.length`);
    }
    function addEvaluatedFrom(source) {
      var _a;
      if (!it.opts.unevaluated)
        return;
      const schEvaluated = (_a = sch === null || sch === undefined ? undefined : sch.validate) === null || _a === undefined ? undefined : _a.evaluated;
      if (it.props !== true) {
        if (schEvaluated && !schEvaluated.dynamicProps) {
          if (schEvaluated.props !== undefined) {
            it.props = util_1.mergeEvaluated.props(gen, schEvaluated.props, it.props);
          }
        } else {
          const props = gen.var("props", (0, codegen_1._)`${source}.evaluated.props`);
          it.props = util_1.mergeEvaluated.props(gen, props, it.props, codegen_1.Name);
        }
      }
      if (it.items !== true) {
        if (schEvaluated && !schEvaluated.dynamicItems) {
          if (schEvaluated.items !== undefined) {
            it.items = util_1.mergeEvaluated.items(gen, schEvaluated.items, it.items);
          }
        } else {
          const items = gen.var("items", (0, codegen_1._)`${source}.evaluated.items`);
          it.items = util_1.mergeEvaluated.items(gen, items, it.items, codegen_1.Name);
        }
      }
    }
  }
  exports.callRef = callRef;
  exports.default = def;
});

// node_modules/ajv/dist/vocabularies/core/index.js
var require_core2 = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var id_1 = require_id();
  var ref_1 = require_ref();
  var core = [
    "$schema",
    "$id",
    "$defs",
    "$vocabulary",
    { keyword: "$comment" },
    "definitions",
    id_1.default,
    ref_1.default
  ];
  exports.default = core;
});

// node_modules/ajv/dist/vocabularies/validation/limitNumber.js
var require_limitNumber = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var codegen_1 = require_codegen();
  var ops = codegen_1.operators;
  var KWDs = {
    maximum: { okStr: "<=", ok: ops.LTE, fail: ops.GT },
    minimum: { okStr: ">=", ok: ops.GTE, fail: ops.LT },
    exclusiveMaximum: { okStr: "<", ok: ops.LT, fail: ops.GTE },
    exclusiveMinimum: { okStr: ">", ok: ops.GT, fail: ops.LTE }
  };
  var error = {
    message: ({ keyword, schemaCode }) => (0, codegen_1.str)`must be ${KWDs[keyword].okStr} ${schemaCode}`,
    params: ({ keyword, schemaCode }) => (0, codegen_1._)`{comparison: ${KWDs[keyword].okStr}, limit: ${schemaCode}}`
  };
  var def = {
    keyword: Object.keys(KWDs),
    type: "number",
    schemaType: "number",
    $data: true,
    error,
    code(cxt) {
      const { keyword, data, schemaCode } = cxt;
      cxt.fail$data((0, codegen_1._)`${data} ${KWDs[keyword].fail} ${schemaCode} || isNaN(${data})`);
    }
  };
  exports.default = def;
});

// node_modules/ajv/dist/vocabularies/validation/multipleOf.js
var require_multipleOf = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var codegen_1 = require_codegen();
  var error = {
    message: ({ schemaCode }) => (0, codegen_1.str)`must be multiple of ${schemaCode}`,
    params: ({ schemaCode }) => (0, codegen_1._)`{multipleOf: ${schemaCode}}`
  };
  var def = {
    keyword: "multipleOf",
    type: "number",
    schemaType: "number",
    $data: true,
    error,
    code(cxt) {
      const { gen, data, schemaCode, it } = cxt;
      const prec = it.opts.multipleOfPrecision;
      const res = gen.let("res");
      const invalid = prec ? (0, codegen_1._)`Math.abs(Math.round(${res}) - ${res}) > 1e-${prec}` : (0, codegen_1._)`${res} !== parseInt(${res})`;
      cxt.fail$data((0, codegen_1._)`(${schemaCode} === 0 || (${res} = ${data}/${schemaCode}, ${invalid}))`);
    }
  };
  exports.default = def;
});

// node_modules/ajv/dist/runtime/ucs2length.js
var require_ucs2length = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  function ucs2length(str) {
    const len = str.length;
    let length = 0;
    let pos = 0;
    let value;
    while (pos < len) {
      length++;
      value = str.charCodeAt(pos++);
      if (value >= 55296 && value <= 56319 && pos < len) {
        value = str.charCodeAt(pos);
        if ((value & 64512) === 56320)
          pos++;
      }
    }
    return length;
  }
  exports.default = ucs2length;
  ucs2length.code = 'require("ajv/dist/runtime/ucs2length").default';
});

// node_modules/ajv/dist/vocabularies/validation/limitLength.js
var require_limitLength = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var codegen_1 = require_codegen();
  var util_1 = require_util();
  var ucs2length_1 = require_ucs2length();
  var error = {
    message({ keyword, schemaCode }) {
      const comp = keyword === "maxLength" ? "more" : "fewer";
      return (0, codegen_1.str)`must NOT have ${comp} than ${schemaCode} characters`;
    },
    params: ({ schemaCode }) => (0, codegen_1._)`{limit: ${schemaCode}}`
  };
  var def = {
    keyword: ["maxLength", "minLength"],
    type: "string",
    schemaType: "number",
    $data: true,
    error,
    code(cxt) {
      const { keyword, data, schemaCode, it } = cxt;
      const op = keyword === "maxLength" ? codegen_1.operators.GT : codegen_1.operators.LT;
      const len = it.opts.unicode === false ? (0, codegen_1._)`${data}.length` : (0, codegen_1._)`${(0, util_1.useFunc)(cxt.gen, ucs2length_1.default)}(${data})`;
      cxt.fail$data((0, codegen_1._)`${len} ${op} ${schemaCode}`);
    }
  };
  exports.default = def;
});

// node_modules/ajv/dist/vocabularies/validation/pattern.js
var require_pattern = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var code_1 = require_code2();
  var codegen_1 = require_codegen();
  var error = {
    message: ({ schemaCode }) => (0, codegen_1.str)`must match pattern "${schemaCode}"`,
    params: ({ schemaCode }) => (0, codegen_1._)`{pattern: ${schemaCode}}`
  };
  var def = {
    keyword: "pattern",
    type: "string",
    schemaType: "string",
    $data: true,
    error,
    code(cxt) {
      const { data, $data, schema, schemaCode, it } = cxt;
      const u = it.opts.unicodeRegExp ? "u" : "";
      const regExp = $data ? (0, codegen_1._)`(new RegExp(${schemaCode}, ${u}))` : (0, code_1.usePattern)(cxt, schema);
      cxt.fail$data((0, codegen_1._)`!${regExp}.test(${data})`);
    }
  };
  exports.default = def;
});

// node_modules/ajv/dist/vocabularies/validation/limitProperties.js
var require_limitProperties = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var codegen_1 = require_codegen();
  var error = {
    message({ keyword, schemaCode }) {
      const comp = keyword === "maxProperties" ? "more" : "fewer";
      return (0, codegen_1.str)`must NOT have ${comp} than ${schemaCode} properties`;
    },
    params: ({ schemaCode }) => (0, codegen_1._)`{limit: ${schemaCode}}`
  };
  var def = {
    keyword: ["maxProperties", "minProperties"],
    type: "object",
    schemaType: "number",
    $data: true,
    error,
    code(cxt) {
      const { keyword, data, schemaCode } = cxt;
      const op = keyword === "maxProperties" ? codegen_1.operators.GT : codegen_1.operators.LT;
      cxt.fail$data((0, codegen_1._)`Object.keys(${data}).length ${op} ${schemaCode}`);
    }
  };
  exports.default = def;
});

// node_modules/ajv/dist/vocabularies/validation/required.js
var require_required = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var code_1 = require_code2();
  var codegen_1 = require_codegen();
  var util_1 = require_util();
  var error = {
    message: ({ params: { missingProperty } }) => (0, codegen_1.str)`must have required property '${missingProperty}'`,
    params: ({ params: { missingProperty } }) => (0, codegen_1._)`{missingProperty: ${missingProperty}}`
  };
  var def = {
    keyword: "required",
    type: "object",
    schemaType: "array",
    $data: true,
    error,
    code(cxt) {
      const { gen, schema, schemaCode, data, $data, it } = cxt;
      const { opts } = it;
      if (!$data && schema.length === 0)
        return;
      const useLoop = schema.length >= opts.loopRequired;
      if (it.allErrors)
        allErrorsMode();
      else
        exitOnErrorMode();
      if (opts.strictRequired) {
        const props = cxt.parentSchema.properties;
        const { definedProperties } = cxt.it;
        for (const requiredKey of schema) {
          if ((props === null || props === undefined ? undefined : props[requiredKey]) === undefined && !definedProperties.has(requiredKey)) {
            const schemaPath = it.schemaEnv.baseId + it.errSchemaPath;
            const msg = `required property "${requiredKey}" is not defined at "${schemaPath}" (strictRequired)`;
            (0, util_1.checkStrictMode)(it, msg, it.opts.strictRequired);
          }
        }
      }
      function allErrorsMode() {
        if (useLoop || $data) {
          cxt.block$data(codegen_1.nil, loopAllRequired);
        } else {
          for (const prop of schema) {
            (0, code_1.checkReportMissingProp)(cxt, prop);
          }
        }
      }
      function exitOnErrorMode() {
        const missing = gen.let("missing");
        if (useLoop || $data) {
          const valid = gen.let("valid", true);
          cxt.block$data(valid, () => loopUntilMissing(missing, valid));
          cxt.ok(valid);
        } else {
          gen.if((0, code_1.checkMissingProp)(cxt, schema, missing));
          (0, code_1.reportMissingProp)(cxt, missing);
          gen.else();
        }
      }
      function loopAllRequired() {
        gen.forOf("prop", schemaCode, (prop) => {
          cxt.setParams({ missingProperty: prop });
          gen.if((0, code_1.noPropertyInData)(gen, data, prop, opts.ownProperties), () => cxt.error());
        });
      }
      function loopUntilMissing(missing, valid) {
        cxt.setParams({ missingProperty: missing });
        gen.forOf(missing, schemaCode, () => {
          gen.assign(valid, (0, code_1.propertyInData)(gen, data, missing, opts.ownProperties));
          gen.if((0, codegen_1.not)(valid), () => {
            cxt.error();
            gen.break();
          });
        }, codegen_1.nil);
      }
    }
  };
  exports.default = def;
});

// node_modules/ajv/dist/vocabularies/validation/limitItems.js
var require_limitItems = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var codegen_1 = require_codegen();
  var error = {
    message({ keyword, schemaCode }) {
      const comp = keyword === "maxItems" ? "more" : "fewer";
      return (0, codegen_1.str)`must NOT have ${comp} than ${schemaCode} items`;
    },
    params: ({ schemaCode }) => (0, codegen_1._)`{limit: ${schemaCode}}`
  };
  var def = {
    keyword: ["maxItems", "minItems"],
    type: "array",
    schemaType: "number",
    $data: true,
    error,
    code(cxt) {
      const { keyword, data, schemaCode } = cxt;
      const op = keyword === "maxItems" ? codegen_1.operators.GT : codegen_1.operators.LT;
      cxt.fail$data((0, codegen_1._)`${data}.length ${op} ${schemaCode}`);
    }
  };
  exports.default = def;
});

// node_modules/ajv/dist/runtime/equal.js
var require_equal = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var equal = require_fast_deep_equal();
  equal.code = 'require("ajv/dist/runtime/equal").default';
  exports.default = equal;
});

// node_modules/ajv/dist/vocabularies/validation/uniqueItems.js
var require_uniqueItems = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var dataType_1 = require_dataType();
  var codegen_1 = require_codegen();
  var util_1 = require_util();
  var equal_1 = require_equal();
  var error = {
    message: ({ params: { i, j } }) => (0, codegen_1.str)`must NOT have duplicate items (items ## ${j} and ${i} are identical)`,
    params: ({ params: { i, j } }) => (0, codegen_1._)`{i: ${i}, j: ${j}}`
  };
  var def = {
    keyword: "uniqueItems",
    type: "array",
    schemaType: "boolean",
    $data: true,
    error,
    code(cxt) {
      const { gen, data, $data, schema, parentSchema, schemaCode, it } = cxt;
      if (!$data && !schema)
        return;
      const valid = gen.let("valid");
      const itemTypes = parentSchema.items ? (0, dataType_1.getSchemaTypes)(parentSchema.items) : [];
      cxt.block$data(valid, validateUniqueItems, (0, codegen_1._)`${schemaCode} === false`);
      cxt.ok(valid);
      function validateUniqueItems() {
        const i = gen.let("i", (0, codegen_1._)`${data}.length`);
        const j = gen.let("j");
        cxt.setParams({ i, j });
        gen.assign(valid, true);
        gen.if((0, codegen_1._)`${i} > 1`, () => (canOptimize() ? loopN : loopN2)(i, j));
      }
      function canOptimize() {
        return itemTypes.length > 0 && !itemTypes.some((t) => t === "object" || t === "array");
      }
      function loopN(i, j) {
        const item = gen.name("item");
        const wrongType = (0, dataType_1.checkDataTypes)(itemTypes, item, it.opts.strictNumbers, dataType_1.DataType.Wrong);
        const indices = gen.const("indices", (0, codegen_1._)`{}`);
        gen.for((0, codegen_1._)`;${i}--;`, () => {
          gen.let(item, (0, codegen_1._)`${data}[${i}]`);
          gen.if(wrongType, (0, codegen_1._)`continue`);
          if (itemTypes.length > 1)
            gen.if((0, codegen_1._)`typeof ${item} == "string"`, (0, codegen_1._)`${item} += "_"`);
          gen.if((0, codegen_1._)`typeof ${indices}[${item}] == "number"`, () => {
            gen.assign(j, (0, codegen_1._)`${indices}[${item}]`);
            cxt.error();
            gen.assign(valid, false).break();
          }).code((0, codegen_1._)`${indices}[${item}] = ${i}`);
        });
      }
      function loopN2(i, j) {
        const eql = (0, util_1.useFunc)(gen, equal_1.default);
        const outer = gen.name("outer");
        gen.label(outer).for((0, codegen_1._)`;${i}--;`, () => gen.for((0, codegen_1._)`${j} = ${i}; ${j}--;`, () => gen.if((0, codegen_1._)`${eql}(${data}[${i}], ${data}[${j}])`, () => {
          cxt.error();
          gen.assign(valid, false).break(outer);
        })));
      }
    }
  };
  exports.default = def;
});

// node_modules/ajv/dist/vocabularies/validation/const.js
var require_const = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var codegen_1 = require_codegen();
  var util_1 = require_util();
  var equal_1 = require_equal();
  var error = {
    message: "must be equal to constant",
    params: ({ schemaCode }) => (0, codegen_1._)`{allowedValue: ${schemaCode}}`
  };
  var def = {
    keyword: "const",
    $data: true,
    error,
    code(cxt) {
      const { gen, data, $data, schemaCode, schema } = cxt;
      if ($data || schema && typeof schema == "object") {
        cxt.fail$data((0, codegen_1._)`!${(0, util_1.useFunc)(gen, equal_1.default)}(${data}, ${schemaCode})`);
      } else {
        cxt.fail((0, codegen_1._)`${schema} !== ${data}`);
      }
    }
  };
  exports.default = def;
});

// node_modules/ajv/dist/vocabularies/validation/enum.js
var require_enum = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var codegen_1 = require_codegen();
  var util_1 = require_util();
  var equal_1 = require_equal();
  var error = {
    message: "must be equal to one of the allowed values",
    params: ({ schemaCode }) => (0, codegen_1._)`{allowedValues: ${schemaCode}}`
  };
  var def = {
    keyword: "enum",
    schemaType: "array",
    $data: true,
    error,
    code(cxt) {
      const { gen, data, $data, schema, schemaCode, it } = cxt;
      if (!$data && schema.length === 0)
        throw new Error("enum must have non-empty array");
      const useLoop = schema.length >= it.opts.loopEnum;
      let eql;
      const getEql = () => eql !== null && eql !== undefined ? eql : eql = (0, util_1.useFunc)(gen, equal_1.default);
      let valid;
      if (useLoop || $data) {
        valid = gen.let("valid");
        cxt.block$data(valid, loopEnum);
      } else {
        if (!Array.isArray(schema))
          throw new Error("ajv implementation error");
        const vSchema = gen.const("vSchema", schemaCode);
        valid = (0, codegen_1.or)(...schema.map((_x, i) => equalCode(vSchema, i)));
      }
      cxt.pass(valid);
      function loopEnum() {
        gen.assign(valid, false);
        gen.forOf("v", schemaCode, (v) => gen.if((0, codegen_1._)`${getEql()}(${data}, ${v})`, () => gen.assign(valid, true).break()));
      }
      function equalCode(vSchema, i) {
        const sch = schema[i];
        return typeof sch === "object" && sch !== null ? (0, codegen_1._)`${getEql()}(${data}, ${vSchema}[${i}])` : (0, codegen_1._)`${data} === ${sch}`;
      }
    }
  };
  exports.default = def;
});

// node_modules/ajv/dist/vocabularies/validation/index.js
var require_validation = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var limitNumber_1 = require_limitNumber();
  var multipleOf_1 = require_multipleOf();
  var limitLength_1 = require_limitLength();
  var pattern_1 = require_pattern();
  var limitProperties_1 = require_limitProperties();
  var required_1 = require_required();
  var limitItems_1 = require_limitItems();
  var uniqueItems_1 = require_uniqueItems();
  var const_1 = require_const();
  var enum_1 = require_enum();
  var validation = [
    limitNumber_1.default,
    multipleOf_1.default,
    limitLength_1.default,
    pattern_1.default,
    limitProperties_1.default,
    required_1.default,
    limitItems_1.default,
    uniqueItems_1.default,
    { keyword: "type", schemaType: ["string", "array"] },
    { keyword: "nullable", schemaType: "boolean" },
    const_1.default,
    enum_1.default
  ];
  exports.default = validation;
});

// node_modules/ajv/dist/vocabularies/applicator/additionalItems.js
var require_additionalItems = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.validateAdditionalItems = undefined;
  var codegen_1 = require_codegen();
  var util_1 = require_util();
  var error = {
    message: ({ params: { len } }) => (0, codegen_1.str)`must NOT have more than ${len} items`,
    params: ({ params: { len } }) => (0, codegen_1._)`{limit: ${len}}`
  };
  var def = {
    keyword: "additionalItems",
    type: "array",
    schemaType: ["boolean", "object"],
    before: "uniqueItems",
    error,
    code(cxt) {
      const { parentSchema, it } = cxt;
      const { items } = parentSchema;
      if (!Array.isArray(items)) {
        (0, util_1.checkStrictMode)(it, '"additionalItems" is ignored when "items" is not an array of schemas');
        return;
      }
      validateAdditionalItems(cxt, items);
    }
  };
  function validateAdditionalItems(cxt, items) {
    const { gen, schema, data, keyword, it } = cxt;
    it.items = true;
    const len = gen.const("len", (0, codegen_1._)`${data}.length`);
    if (schema === false) {
      cxt.setParams({ len: items.length });
      cxt.pass((0, codegen_1._)`${len} <= ${items.length}`);
    } else if (typeof schema == "object" && !(0, util_1.alwaysValidSchema)(it, schema)) {
      const valid = gen.var("valid", (0, codegen_1._)`${len} <= ${items.length}`);
      gen.if((0, codegen_1.not)(valid), () => validateItems(valid));
      cxt.ok(valid);
    }
    function validateItems(valid) {
      gen.forRange("i", items.length, len, (i) => {
        cxt.subschema({ keyword, dataProp: i, dataPropType: util_1.Type.Num }, valid);
        if (!it.allErrors)
          gen.if((0, codegen_1.not)(valid), () => gen.break());
      });
    }
  }
  exports.validateAdditionalItems = validateAdditionalItems;
  exports.default = def;
});

// node_modules/ajv/dist/vocabularies/applicator/items.js
var require_items = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.validateTuple = undefined;
  var codegen_1 = require_codegen();
  var util_1 = require_util();
  var code_1 = require_code2();
  var def = {
    keyword: "items",
    type: "array",
    schemaType: ["object", "array", "boolean"],
    before: "uniqueItems",
    code(cxt) {
      const { schema, it } = cxt;
      if (Array.isArray(schema))
        return validateTuple(cxt, "additionalItems", schema);
      it.items = true;
      if ((0, util_1.alwaysValidSchema)(it, schema))
        return;
      cxt.ok((0, code_1.validateArray)(cxt));
    }
  };
  function validateTuple(cxt, extraItems, schArr = cxt.schema) {
    const { gen, parentSchema, data, keyword, it } = cxt;
    checkStrictTuple(parentSchema);
    if (it.opts.unevaluated && schArr.length && it.items !== true) {
      it.items = util_1.mergeEvaluated.items(gen, schArr.length, it.items);
    }
    const valid = gen.name("valid");
    const len = gen.const("len", (0, codegen_1._)`${data}.length`);
    schArr.forEach((sch, i) => {
      if ((0, util_1.alwaysValidSchema)(it, sch))
        return;
      gen.if((0, codegen_1._)`${len} > ${i}`, () => cxt.subschema({
        keyword,
        schemaProp: i,
        dataProp: i
      }, valid));
      cxt.ok(valid);
    });
    function checkStrictTuple(sch) {
      const { opts, errSchemaPath } = it;
      const l = schArr.length;
      const fullTuple = l === sch.minItems && (l === sch.maxItems || sch[extraItems] === false);
      if (opts.strictTuples && !fullTuple) {
        const msg = `"${keyword}" is ${l}-tuple, but minItems or maxItems/${extraItems} are not specified or different at path "${errSchemaPath}"`;
        (0, util_1.checkStrictMode)(it, msg, opts.strictTuples);
      }
    }
  }
  exports.validateTuple = validateTuple;
  exports.default = def;
});

// node_modules/ajv/dist/vocabularies/applicator/prefixItems.js
var require_prefixItems = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var items_1 = require_items();
  var def = {
    keyword: "prefixItems",
    type: "array",
    schemaType: ["array"],
    before: "uniqueItems",
    code: (cxt) => (0, items_1.validateTuple)(cxt, "items")
  };
  exports.default = def;
});

// node_modules/ajv/dist/vocabularies/applicator/items2020.js
var require_items2020 = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var codegen_1 = require_codegen();
  var util_1 = require_util();
  var code_1 = require_code2();
  var additionalItems_1 = require_additionalItems();
  var error = {
    message: ({ params: { len } }) => (0, codegen_1.str)`must NOT have more than ${len} items`,
    params: ({ params: { len } }) => (0, codegen_1._)`{limit: ${len}}`
  };
  var def = {
    keyword: "items",
    type: "array",
    schemaType: ["object", "boolean"],
    before: "uniqueItems",
    error,
    code(cxt) {
      const { schema, parentSchema, it } = cxt;
      const { prefixItems } = parentSchema;
      it.items = true;
      if ((0, util_1.alwaysValidSchema)(it, schema))
        return;
      if (prefixItems)
        (0, additionalItems_1.validateAdditionalItems)(cxt, prefixItems);
      else
        cxt.ok((0, code_1.validateArray)(cxt));
    }
  };
  exports.default = def;
});

// node_modules/ajv/dist/vocabularies/applicator/contains.js
var require_contains = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var codegen_1 = require_codegen();
  var util_1 = require_util();
  var error = {
    message: ({ params: { min, max } }) => max === undefined ? (0, codegen_1.str)`must contain at least ${min} valid item(s)` : (0, codegen_1.str)`must contain at least ${min} and no more than ${max} valid item(s)`,
    params: ({ params: { min, max } }) => max === undefined ? (0, codegen_1._)`{minContains: ${min}}` : (0, codegen_1._)`{minContains: ${min}, maxContains: ${max}}`
  };
  var def = {
    keyword: "contains",
    type: "array",
    schemaType: ["object", "boolean"],
    before: "uniqueItems",
    trackErrors: true,
    error,
    code(cxt) {
      const { gen, schema, parentSchema, data, it } = cxt;
      let min;
      let max;
      const { minContains, maxContains } = parentSchema;
      if (it.opts.next) {
        min = minContains === undefined ? 1 : minContains;
        max = maxContains;
      } else {
        min = 1;
      }
      const len = gen.const("len", (0, codegen_1._)`${data}.length`);
      cxt.setParams({ min, max });
      if (max === undefined && min === 0) {
        (0, util_1.checkStrictMode)(it, `"minContains" == 0 without "maxContains": "contains" keyword ignored`);
        return;
      }
      if (max !== undefined && min > max) {
        (0, util_1.checkStrictMode)(it, `"minContains" > "maxContains" is always invalid`);
        cxt.fail();
        return;
      }
      if ((0, util_1.alwaysValidSchema)(it, schema)) {
        let cond = (0, codegen_1._)`${len} >= ${min}`;
        if (max !== undefined)
          cond = (0, codegen_1._)`${cond} && ${len} <= ${max}`;
        cxt.pass(cond);
        return;
      }
      it.items = true;
      const valid = gen.name("valid");
      if (max === undefined && min === 1) {
        validateItems(valid, () => gen.if(valid, () => gen.break()));
      } else if (min === 0) {
        gen.let(valid, true);
        if (max !== undefined)
          gen.if((0, codegen_1._)`${data}.length > 0`, validateItemsWithCount);
      } else {
        gen.let(valid, false);
        validateItemsWithCount();
      }
      cxt.result(valid, () => cxt.reset());
      function validateItemsWithCount() {
        const schValid = gen.name("_valid");
        const count = gen.let("count", 0);
        validateItems(schValid, () => gen.if(schValid, () => checkLimits(count)));
      }
      function validateItems(_valid, block) {
        gen.forRange("i", 0, len, (i) => {
          cxt.subschema({
            keyword: "contains",
            dataProp: i,
            dataPropType: util_1.Type.Num,
            compositeRule: true
          }, _valid);
          block();
        });
      }
      function checkLimits(count) {
        gen.code((0, codegen_1._)`${count}++`);
        if (max === undefined) {
          gen.if((0, codegen_1._)`${count} >= ${min}`, () => gen.assign(valid, true).break());
        } else {
          gen.if((0, codegen_1._)`${count} > ${max}`, () => gen.assign(valid, false).break());
          if (min === 1)
            gen.assign(valid, true);
          else
            gen.if((0, codegen_1._)`${count} >= ${min}`, () => gen.assign(valid, true));
        }
      }
    }
  };
  exports.default = def;
});

// node_modules/ajv/dist/vocabularies/applicator/dependencies.js
var require_dependencies = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.validateSchemaDeps = exports.validatePropertyDeps = exports.error = undefined;
  var codegen_1 = require_codegen();
  var util_1 = require_util();
  var code_1 = require_code2();
  exports.error = {
    message: ({ params: { property, depsCount, deps } }) => {
      const property_ies = depsCount === 1 ? "property" : "properties";
      return (0, codegen_1.str)`must have ${property_ies} ${deps} when property ${property} is present`;
    },
    params: ({ params: { property, depsCount, deps, missingProperty } }) => (0, codegen_1._)`{property: ${property},
    missingProperty: ${missingProperty},
    depsCount: ${depsCount},
    deps: ${deps}}`
  };
  var def = {
    keyword: "dependencies",
    type: "object",
    schemaType: "object",
    error: exports.error,
    code(cxt) {
      const [propDeps, schDeps] = splitDependencies(cxt);
      validatePropertyDeps(cxt, propDeps);
      validateSchemaDeps(cxt, schDeps);
    }
  };
  function splitDependencies({ schema }) {
    const propertyDeps = {};
    const schemaDeps = {};
    for (const key in schema) {
      if (key === "__proto__")
        continue;
      const deps = Array.isArray(schema[key]) ? propertyDeps : schemaDeps;
      deps[key] = schema[key];
    }
    return [propertyDeps, schemaDeps];
  }
  function validatePropertyDeps(cxt, propertyDeps = cxt.schema) {
    const { gen, data, it } = cxt;
    if (Object.keys(propertyDeps).length === 0)
      return;
    const missing = gen.let("missing");
    for (const prop in propertyDeps) {
      const deps = propertyDeps[prop];
      if (deps.length === 0)
        continue;
      const hasProperty = (0, code_1.propertyInData)(gen, data, prop, it.opts.ownProperties);
      cxt.setParams({
        property: prop,
        depsCount: deps.length,
        deps: deps.join(", ")
      });
      if (it.allErrors) {
        gen.if(hasProperty, () => {
          for (const depProp of deps) {
            (0, code_1.checkReportMissingProp)(cxt, depProp);
          }
        });
      } else {
        gen.if((0, codegen_1._)`${hasProperty} && (${(0, code_1.checkMissingProp)(cxt, deps, missing)})`);
        (0, code_1.reportMissingProp)(cxt, missing);
        gen.else();
      }
    }
  }
  exports.validatePropertyDeps = validatePropertyDeps;
  function validateSchemaDeps(cxt, schemaDeps = cxt.schema) {
    const { gen, data, keyword, it } = cxt;
    const valid = gen.name("valid");
    for (const prop in schemaDeps) {
      if ((0, util_1.alwaysValidSchema)(it, schemaDeps[prop]))
        continue;
      gen.if((0, code_1.propertyInData)(gen, data, prop, it.opts.ownProperties), () => {
        const schCxt = cxt.subschema({ keyword, schemaProp: prop }, valid);
        cxt.mergeValidEvaluated(schCxt, valid);
      }, () => gen.var(valid, true));
      cxt.ok(valid);
    }
  }
  exports.validateSchemaDeps = validateSchemaDeps;
  exports.default = def;
});

// node_modules/ajv/dist/vocabularies/applicator/propertyNames.js
var require_propertyNames = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var codegen_1 = require_codegen();
  var util_1 = require_util();
  var error = {
    message: "property name must be valid",
    params: ({ params }) => (0, codegen_1._)`{propertyName: ${params.propertyName}}`
  };
  var def = {
    keyword: "propertyNames",
    type: "object",
    schemaType: ["object", "boolean"],
    error,
    code(cxt) {
      const { gen, schema, data, it } = cxt;
      if ((0, util_1.alwaysValidSchema)(it, schema))
        return;
      const valid = gen.name("valid");
      gen.forIn("key", data, (key) => {
        cxt.setParams({ propertyName: key });
        cxt.subschema({
          keyword: "propertyNames",
          data: key,
          dataTypes: ["string"],
          propertyName: key,
          compositeRule: true
        }, valid);
        gen.if((0, codegen_1.not)(valid), () => {
          cxt.error(true);
          if (!it.allErrors)
            gen.break();
        });
      });
      cxt.ok(valid);
    }
  };
  exports.default = def;
});

// node_modules/ajv/dist/vocabularies/applicator/additionalProperties.js
var require_additionalProperties = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var code_1 = require_code2();
  var codegen_1 = require_codegen();
  var names_1 = require_names();
  var util_1 = require_util();
  var error = {
    message: "must NOT have additional properties",
    params: ({ params }) => (0, codegen_1._)`{additionalProperty: ${params.additionalProperty}}`
  };
  var def = {
    keyword: "additionalProperties",
    type: ["object"],
    schemaType: ["boolean", "object"],
    allowUndefined: true,
    trackErrors: true,
    error,
    code(cxt) {
      const { gen, schema, parentSchema, data, errsCount, it } = cxt;
      if (!errsCount)
        throw new Error("ajv implementation error");
      const { allErrors, opts } = it;
      it.props = true;
      if (opts.removeAdditional !== "all" && (0, util_1.alwaysValidSchema)(it, schema))
        return;
      const props = (0, code_1.allSchemaProperties)(parentSchema.properties);
      const patProps = (0, code_1.allSchemaProperties)(parentSchema.patternProperties);
      checkAdditionalProperties();
      cxt.ok((0, codegen_1._)`${errsCount} === ${names_1.default.errors}`);
      function checkAdditionalProperties() {
        gen.forIn("key", data, (key) => {
          if (!props.length && !patProps.length)
            additionalPropertyCode(key);
          else
            gen.if(isAdditional(key), () => additionalPropertyCode(key));
        });
      }
      function isAdditional(key) {
        let definedProp;
        if (props.length > 8) {
          const propsSchema = (0, util_1.schemaRefOrVal)(it, parentSchema.properties, "properties");
          definedProp = (0, code_1.isOwnProperty)(gen, propsSchema, key);
        } else if (props.length) {
          definedProp = (0, codegen_1.or)(...props.map((p) => (0, codegen_1._)`${key} === ${p}`));
        } else {
          definedProp = codegen_1.nil;
        }
        if (patProps.length) {
          definedProp = (0, codegen_1.or)(definedProp, ...patProps.map((p) => (0, codegen_1._)`${(0, code_1.usePattern)(cxt, p)}.test(${key})`));
        }
        return (0, codegen_1.not)(definedProp);
      }
      function deleteAdditional(key) {
        gen.code((0, codegen_1._)`delete ${data}[${key}]`);
      }
      function additionalPropertyCode(key) {
        if (opts.removeAdditional === "all" || opts.removeAdditional && schema === false) {
          deleteAdditional(key);
          return;
        }
        if (schema === false) {
          cxt.setParams({ additionalProperty: key });
          cxt.error();
          if (!allErrors)
            gen.break();
          return;
        }
        if (typeof schema == "object" && !(0, util_1.alwaysValidSchema)(it, schema)) {
          const valid = gen.name("valid");
          if (opts.removeAdditional === "failing") {
            applyAdditionalSchema(key, valid, false);
            gen.if((0, codegen_1.not)(valid), () => {
              cxt.reset();
              deleteAdditional(key);
            });
          } else {
            applyAdditionalSchema(key, valid);
            if (!allErrors)
              gen.if((0, codegen_1.not)(valid), () => gen.break());
          }
        }
      }
      function applyAdditionalSchema(key, valid, errors) {
        const subschema = {
          keyword: "additionalProperties",
          dataProp: key,
          dataPropType: util_1.Type.Str
        };
        if (errors === false) {
          Object.assign(subschema, {
            compositeRule: true,
            createErrors: false,
            allErrors: false
          });
        }
        cxt.subschema(subschema, valid);
      }
    }
  };
  exports.default = def;
});

// node_modules/ajv/dist/vocabularies/applicator/properties.js
var require_properties = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var validate_1 = require_validate();
  var code_1 = require_code2();
  var util_1 = require_util();
  var additionalProperties_1 = require_additionalProperties();
  var def = {
    keyword: "properties",
    type: "object",
    schemaType: "object",
    code(cxt) {
      const { gen, schema, parentSchema, data, it } = cxt;
      if (it.opts.removeAdditional === "all" && parentSchema.additionalProperties === undefined) {
        additionalProperties_1.default.code(new validate_1.KeywordCxt(it, additionalProperties_1.default, "additionalProperties"));
      }
      const allProps = (0, code_1.allSchemaProperties)(schema);
      for (const prop of allProps) {
        it.definedProperties.add(prop);
      }
      if (it.opts.unevaluated && allProps.length && it.props !== true) {
        it.props = util_1.mergeEvaluated.props(gen, (0, util_1.toHash)(allProps), it.props);
      }
      const properties = allProps.filter((p) => !(0, util_1.alwaysValidSchema)(it, schema[p]));
      if (properties.length === 0)
        return;
      const valid = gen.name("valid");
      for (const prop of properties) {
        if (hasDefault(prop)) {
          applyPropertySchema(prop);
        } else {
          gen.if((0, code_1.propertyInData)(gen, data, prop, it.opts.ownProperties));
          applyPropertySchema(prop);
          if (!it.allErrors)
            gen.else().var(valid, true);
          gen.endIf();
        }
        cxt.it.definedProperties.add(prop);
        cxt.ok(valid);
      }
      function hasDefault(prop) {
        return it.opts.useDefaults && !it.compositeRule && schema[prop].default !== undefined;
      }
      function applyPropertySchema(prop) {
        cxt.subschema({
          keyword: "properties",
          schemaProp: prop,
          dataProp: prop
        }, valid);
      }
    }
  };
  exports.default = def;
});

// node_modules/ajv/dist/vocabularies/applicator/patternProperties.js
var require_patternProperties = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var code_1 = require_code2();
  var codegen_1 = require_codegen();
  var util_1 = require_util();
  var util_2 = require_util();
  var def = {
    keyword: "patternProperties",
    type: "object",
    schemaType: "object",
    code(cxt) {
      const { gen, schema, data, parentSchema, it } = cxt;
      const { opts } = it;
      const patterns = (0, code_1.allSchemaProperties)(schema);
      const alwaysValidPatterns = patterns.filter((p) => (0, util_1.alwaysValidSchema)(it, schema[p]));
      if (patterns.length === 0 || alwaysValidPatterns.length === patterns.length && (!it.opts.unevaluated || it.props === true)) {
        return;
      }
      const checkProperties = opts.strictSchema && !opts.allowMatchingProperties && parentSchema.properties;
      const valid = gen.name("valid");
      if (it.props !== true && !(it.props instanceof codegen_1.Name)) {
        it.props = (0, util_2.evaluatedPropsToName)(gen, it.props);
      }
      const { props } = it;
      validatePatternProperties();
      function validatePatternProperties() {
        for (const pat of patterns) {
          if (checkProperties)
            checkMatchingProperties(pat);
          if (it.allErrors) {
            validateProperties(pat);
          } else {
            gen.var(valid, true);
            validateProperties(pat);
            gen.if(valid);
          }
        }
      }
      function checkMatchingProperties(pat) {
        for (const prop in checkProperties) {
          if (new RegExp(pat).test(prop)) {
            (0, util_1.checkStrictMode)(it, `property ${prop} matches pattern ${pat} (use allowMatchingProperties)`);
          }
        }
      }
      function validateProperties(pat) {
        gen.forIn("key", data, (key) => {
          gen.if((0, codegen_1._)`${(0, code_1.usePattern)(cxt, pat)}.test(${key})`, () => {
            const alwaysValid = alwaysValidPatterns.includes(pat);
            if (!alwaysValid) {
              cxt.subschema({
                keyword: "patternProperties",
                schemaProp: pat,
                dataProp: key,
                dataPropType: util_2.Type.Str
              }, valid);
            }
            if (it.opts.unevaluated && props !== true) {
              gen.assign((0, codegen_1._)`${props}[${key}]`, true);
            } else if (!alwaysValid && !it.allErrors) {
              gen.if((0, codegen_1.not)(valid), () => gen.break());
            }
          });
        });
      }
    }
  };
  exports.default = def;
});

// node_modules/ajv/dist/vocabularies/applicator/not.js
var require_not = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var util_1 = require_util();
  var def = {
    keyword: "not",
    schemaType: ["object", "boolean"],
    trackErrors: true,
    code(cxt) {
      const { gen, schema, it } = cxt;
      if ((0, util_1.alwaysValidSchema)(it, schema)) {
        cxt.fail();
        return;
      }
      const valid = gen.name("valid");
      cxt.subschema({
        keyword: "not",
        compositeRule: true,
        createErrors: false,
        allErrors: false
      }, valid);
      cxt.failResult(valid, () => cxt.reset(), () => cxt.error());
    },
    error: { message: "must NOT be valid" }
  };
  exports.default = def;
});

// node_modules/ajv/dist/vocabularies/applicator/anyOf.js
var require_anyOf = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var code_1 = require_code2();
  var def = {
    keyword: "anyOf",
    schemaType: "array",
    trackErrors: true,
    code: code_1.validateUnion,
    error: { message: "must match a schema in anyOf" }
  };
  exports.default = def;
});

// node_modules/ajv/dist/vocabularies/applicator/oneOf.js
var require_oneOf = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var codegen_1 = require_codegen();
  var util_1 = require_util();
  var error = {
    message: "must match exactly one schema in oneOf",
    params: ({ params }) => (0, codegen_1._)`{passingSchemas: ${params.passing}}`
  };
  var def = {
    keyword: "oneOf",
    schemaType: "array",
    trackErrors: true,
    error,
    code(cxt) {
      const { gen, schema, parentSchema, it } = cxt;
      if (!Array.isArray(schema))
        throw new Error("ajv implementation error");
      if (it.opts.discriminator && parentSchema.discriminator)
        return;
      const schArr = schema;
      const valid = gen.let("valid", false);
      const passing = gen.let("passing", null);
      const schValid = gen.name("_valid");
      cxt.setParams({ passing });
      gen.block(validateOneOf);
      cxt.result(valid, () => cxt.reset(), () => cxt.error(true));
      function validateOneOf() {
        schArr.forEach((sch, i) => {
          let schCxt;
          if ((0, util_1.alwaysValidSchema)(it, sch)) {
            gen.var(schValid, true);
          } else {
            schCxt = cxt.subschema({
              keyword: "oneOf",
              schemaProp: i,
              compositeRule: true
            }, schValid);
          }
          if (i > 0) {
            gen.if((0, codegen_1._)`${schValid} && ${valid}`).assign(valid, false).assign(passing, (0, codegen_1._)`[${passing}, ${i}]`).else();
          }
          gen.if(schValid, () => {
            gen.assign(valid, true);
            gen.assign(passing, i);
            if (schCxt)
              cxt.mergeEvaluated(schCxt, codegen_1.Name);
          });
        });
      }
    }
  };
  exports.default = def;
});

// node_modules/ajv/dist/vocabularies/applicator/allOf.js
var require_allOf = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var util_1 = require_util();
  var def = {
    keyword: "allOf",
    schemaType: "array",
    code(cxt) {
      const { gen, schema, it } = cxt;
      if (!Array.isArray(schema))
        throw new Error("ajv implementation error");
      const valid = gen.name("valid");
      schema.forEach((sch, i) => {
        if ((0, util_1.alwaysValidSchema)(it, sch))
          return;
        const schCxt = cxt.subschema({ keyword: "allOf", schemaProp: i }, valid);
        cxt.ok(valid);
        cxt.mergeEvaluated(schCxt);
      });
    }
  };
  exports.default = def;
});

// node_modules/ajv/dist/vocabularies/applicator/if.js
var require_if = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var codegen_1 = require_codegen();
  var util_1 = require_util();
  var error = {
    message: ({ params }) => (0, codegen_1.str)`must match "${params.ifClause}" schema`,
    params: ({ params }) => (0, codegen_1._)`{failingKeyword: ${params.ifClause}}`
  };
  var def = {
    keyword: "if",
    schemaType: ["object", "boolean"],
    trackErrors: true,
    error,
    code(cxt) {
      const { gen, parentSchema, it } = cxt;
      if (parentSchema.then === undefined && parentSchema.else === undefined) {
        (0, util_1.checkStrictMode)(it, '"if" without "then" and "else" is ignored');
      }
      const hasThen = hasSchema(it, "then");
      const hasElse = hasSchema(it, "else");
      if (!hasThen && !hasElse)
        return;
      const valid = gen.let("valid", true);
      const schValid = gen.name("_valid");
      validateIf();
      cxt.reset();
      if (hasThen && hasElse) {
        const ifClause = gen.let("ifClause");
        cxt.setParams({ ifClause });
        gen.if(schValid, validateClause("then", ifClause), validateClause("else", ifClause));
      } else if (hasThen) {
        gen.if(schValid, validateClause("then"));
      } else {
        gen.if((0, codegen_1.not)(schValid), validateClause("else"));
      }
      cxt.pass(valid, () => cxt.error(true));
      function validateIf() {
        const schCxt = cxt.subschema({
          keyword: "if",
          compositeRule: true,
          createErrors: false,
          allErrors: false
        }, schValid);
        cxt.mergeEvaluated(schCxt);
      }
      function validateClause(keyword, ifClause) {
        return () => {
          const schCxt = cxt.subschema({ keyword }, schValid);
          gen.assign(valid, schValid);
          cxt.mergeValidEvaluated(schCxt, valid);
          if (ifClause)
            gen.assign(ifClause, (0, codegen_1._)`${keyword}`);
          else
            cxt.setParams({ ifClause: keyword });
        };
      }
    }
  };
  function hasSchema(it, keyword) {
    const schema = it.schema[keyword];
    return schema !== undefined && !(0, util_1.alwaysValidSchema)(it, schema);
  }
  exports.default = def;
});

// node_modules/ajv/dist/vocabularies/applicator/thenElse.js
var require_thenElse = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var util_1 = require_util();
  var def = {
    keyword: ["then", "else"],
    schemaType: ["object", "boolean"],
    code({ keyword, parentSchema, it }) {
      if (parentSchema.if === undefined)
        (0, util_1.checkStrictMode)(it, `"${keyword}" without "if" is ignored`);
    }
  };
  exports.default = def;
});

// node_modules/ajv/dist/vocabularies/applicator/index.js
var require_applicator = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var additionalItems_1 = require_additionalItems();
  var prefixItems_1 = require_prefixItems();
  var items_1 = require_items();
  var items2020_1 = require_items2020();
  var contains_1 = require_contains();
  var dependencies_1 = require_dependencies();
  var propertyNames_1 = require_propertyNames();
  var additionalProperties_1 = require_additionalProperties();
  var properties_1 = require_properties();
  var patternProperties_1 = require_patternProperties();
  var not_1 = require_not();
  var anyOf_1 = require_anyOf();
  var oneOf_1 = require_oneOf();
  var allOf_1 = require_allOf();
  var if_1 = require_if();
  var thenElse_1 = require_thenElse();
  function getApplicator(draft2020 = false) {
    const applicator = [
      not_1.default,
      anyOf_1.default,
      oneOf_1.default,
      allOf_1.default,
      if_1.default,
      thenElse_1.default,
      propertyNames_1.default,
      additionalProperties_1.default,
      dependencies_1.default,
      properties_1.default,
      patternProperties_1.default
    ];
    if (draft2020)
      applicator.push(prefixItems_1.default, items2020_1.default);
    else
      applicator.push(additionalItems_1.default, items_1.default);
    applicator.push(contains_1.default);
    return applicator;
  }
  exports.default = getApplicator;
});

// node_modules/ajv/dist/vocabularies/format/format.js
var require_format = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var codegen_1 = require_codegen();
  var error = {
    message: ({ schemaCode }) => (0, codegen_1.str)`must match format "${schemaCode}"`,
    params: ({ schemaCode }) => (0, codegen_1._)`{format: ${schemaCode}}`
  };
  var def = {
    keyword: "format",
    type: ["number", "string"],
    schemaType: "string",
    $data: true,
    error,
    code(cxt, ruleType) {
      const { gen, data, $data, schema, schemaCode, it } = cxt;
      const { opts, errSchemaPath, schemaEnv, self } = it;
      if (!opts.validateFormats)
        return;
      if ($data)
        validate$DataFormat();
      else
        validateFormat();
      function validate$DataFormat() {
        const fmts = gen.scopeValue("formats", {
          ref: self.formats,
          code: opts.code.formats
        });
        const fDef = gen.const("fDef", (0, codegen_1._)`${fmts}[${schemaCode}]`);
        const fType = gen.let("fType");
        const format = gen.let("format");
        gen.if((0, codegen_1._)`typeof ${fDef} == "object" && !(${fDef} instanceof RegExp)`, () => gen.assign(fType, (0, codegen_1._)`${fDef}.type || "string"`).assign(format, (0, codegen_1._)`${fDef}.validate`), () => gen.assign(fType, (0, codegen_1._)`"string"`).assign(format, fDef));
        cxt.fail$data((0, codegen_1.or)(unknownFmt(), invalidFmt()));
        function unknownFmt() {
          if (opts.strictSchema === false)
            return codegen_1.nil;
          return (0, codegen_1._)`${schemaCode} && !${format}`;
        }
        function invalidFmt() {
          const callFormat = schemaEnv.$async ? (0, codegen_1._)`(${fDef}.async ? await ${format}(${data}) : ${format}(${data}))` : (0, codegen_1._)`${format}(${data})`;
          const validData = (0, codegen_1._)`(typeof ${format} == "function" ? ${callFormat} : ${format}.test(${data}))`;
          return (0, codegen_1._)`${format} && ${format} !== true && ${fType} === ${ruleType} && !${validData}`;
        }
      }
      function validateFormat() {
        const formatDef = self.formats[schema];
        if (!formatDef) {
          unknownFormat();
          return;
        }
        if (formatDef === true)
          return;
        const [fmtType, format, fmtRef] = getFormat(formatDef);
        if (fmtType === ruleType)
          cxt.pass(validCondition());
        function unknownFormat() {
          if (opts.strictSchema === false) {
            self.logger.warn(unknownMsg());
            return;
          }
          throw new Error(unknownMsg());
          function unknownMsg() {
            return `unknown format "${schema}" ignored in schema at path "${errSchemaPath}"`;
          }
        }
        function getFormat(fmtDef) {
          const code = fmtDef instanceof RegExp ? (0, codegen_1.regexpCode)(fmtDef) : opts.code.formats ? (0, codegen_1._)`${opts.code.formats}${(0, codegen_1.getProperty)(schema)}` : undefined;
          const fmt = gen.scopeValue("formats", { key: schema, ref: fmtDef, code });
          if (typeof fmtDef == "object" && !(fmtDef instanceof RegExp)) {
            return [fmtDef.type || "string", fmtDef.validate, (0, codegen_1._)`${fmt}.validate`];
          }
          return ["string", fmtDef, fmt];
        }
        function validCondition() {
          if (typeof formatDef == "object" && !(formatDef instanceof RegExp) && formatDef.async) {
            if (!schemaEnv.$async)
              throw new Error("async format in sync schema");
            return (0, codegen_1._)`await ${fmtRef}(${data})`;
          }
          return typeof format == "function" ? (0, codegen_1._)`${fmtRef}(${data})` : (0, codegen_1._)`${fmtRef}.test(${data})`;
        }
      }
    }
  };
  exports.default = def;
});

// node_modules/ajv/dist/vocabularies/format/index.js
var require_format2 = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var format_1 = require_format();
  var format = [format_1.default];
  exports.default = format;
});

// node_modules/ajv/dist/vocabularies/metadata.js
var require_metadata = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.contentVocabulary = exports.metadataVocabulary = undefined;
  exports.metadataVocabulary = [
    "title",
    "description",
    "default",
    "deprecated",
    "readOnly",
    "writeOnly",
    "examples"
  ];
  exports.contentVocabulary = [
    "contentMediaType",
    "contentEncoding",
    "contentSchema"
  ];
});

// node_modules/ajv/dist/vocabularies/draft7.js
var require_draft7 = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var core_1 = require_core2();
  var validation_1 = require_validation();
  var applicator_1 = require_applicator();
  var format_1 = require_format2();
  var metadata_1 = require_metadata();
  var draft7Vocabularies = [
    core_1.default,
    validation_1.default,
    (0, applicator_1.default)(),
    format_1.default,
    metadata_1.metadataVocabulary,
    metadata_1.contentVocabulary
  ];
  exports.default = draft7Vocabularies;
});

// node_modules/ajv/dist/vocabularies/discriminator/types.js
var require_types = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.DiscrError = undefined;
  var DiscrError;
  (function(DiscrError2) {
    DiscrError2["Tag"] = "tag";
    DiscrError2["Mapping"] = "mapping";
  })(DiscrError || (exports.DiscrError = DiscrError = {}));
});

// node_modules/ajv/dist/vocabularies/discriminator/index.js
var require_discriminator = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var codegen_1 = require_codegen();
  var types_1 = require_types();
  var compile_1 = require_compile();
  var ref_error_1 = require_ref_error();
  var util_1 = require_util();
  var error = {
    message: ({ params: { discrError, tagName } }) => discrError === types_1.DiscrError.Tag ? `tag "${tagName}" must be string` : `value of tag "${tagName}" must be in oneOf`,
    params: ({ params: { discrError, tag, tagName } }) => (0, codegen_1._)`{error: ${discrError}, tag: ${tagName}, tagValue: ${tag}}`
  };
  var def = {
    keyword: "discriminator",
    type: "object",
    schemaType: "object",
    error,
    code(cxt) {
      const { gen, data, schema, parentSchema, it } = cxt;
      const { oneOf } = parentSchema;
      if (!it.opts.discriminator) {
        throw new Error("discriminator: requires discriminator option");
      }
      const tagName = schema.propertyName;
      if (typeof tagName != "string")
        throw new Error("discriminator: requires propertyName");
      if (schema.mapping)
        throw new Error("discriminator: mapping is not supported");
      if (!oneOf)
        throw new Error("discriminator: requires oneOf keyword");
      const valid = gen.let("valid", false);
      const tag = gen.const("tag", (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(tagName)}`);
      gen.if((0, codegen_1._)`typeof ${tag} == "string"`, () => validateMapping(), () => cxt.error(false, { discrError: types_1.DiscrError.Tag, tag, tagName }));
      cxt.ok(valid);
      function validateMapping() {
        const mapping = getMapping();
        gen.if(false);
        for (const tagValue in mapping) {
          gen.elseIf((0, codegen_1._)`${tag} === ${tagValue}`);
          gen.assign(valid, applyTagSchema(mapping[tagValue]));
        }
        gen.else();
        cxt.error(false, { discrError: types_1.DiscrError.Mapping, tag, tagName });
        gen.endIf();
      }
      function applyTagSchema(schemaProp) {
        const _valid = gen.name("valid");
        const schCxt = cxt.subschema({ keyword: "oneOf", schemaProp }, _valid);
        cxt.mergeEvaluated(schCxt, codegen_1.Name);
        return _valid;
      }
      function getMapping() {
        var _a;
        const oneOfMapping = {};
        const topRequired = hasRequired(parentSchema);
        let tagRequired = true;
        for (let i = 0;i < oneOf.length; i++) {
          let sch = oneOf[i];
          if ((sch === null || sch === undefined ? undefined : sch.$ref) && !(0, util_1.schemaHasRulesButRef)(sch, it.self.RULES)) {
            const ref = sch.$ref;
            sch = compile_1.resolveRef.call(it.self, it.schemaEnv.root, it.baseId, ref);
            if (sch instanceof compile_1.SchemaEnv)
              sch = sch.schema;
            if (sch === undefined)
              throw new ref_error_1.default(it.opts.uriResolver, it.baseId, ref);
          }
          const propSch = (_a = sch === null || sch === undefined ? undefined : sch.properties) === null || _a === undefined ? undefined : _a[tagName];
          if (typeof propSch != "object") {
            throw new Error(`discriminator: oneOf subschemas (or referenced schemas) must have "properties/${tagName}"`);
          }
          tagRequired = tagRequired && (topRequired || hasRequired(sch));
          addMappings(propSch, i);
        }
        if (!tagRequired)
          throw new Error(`discriminator: "${tagName}" must be required`);
        return oneOfMapping;
        function hasRequired({ required }) {
          return Array.isArray(required) && required.includes(tagName);
        }
        function addMappings(sch, i) {
          if (sch.const) {
            addMapping(sch.const, i);
          } else if (sch.enum) {
            for (const tagValue of sch.enum) {
              addMapping(tagValue, i);
            }
          } else {
            throw new Error(`discriminator: "properties/${tagName}" must have "const" or "enum"`);
          }
        }
        function addMapping(tagValue, i) {
          if (typeof tagValue != "string" || tagValue in oneOfMapping) {
            throw new Error(`discriminator: "${tagName}" values must be unique strings`);
          }
          oneOfMapping[tagValue] = i;
        }
      }
    }
  };
  exports.default = def;
});

// node_modules/ajv/dist/refs/json-schema-draft-07.json
var require_json_schema_draft_07 = __commonJS((exports, module) => {
  module.exports = {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "http://json-schema.org/draft-07/schema#",
    title: "Core schema meta-schema",
    definitions: {
      schemaArray: {
        type: "array",
        minItems: 1,
        items: { $ref: "#" }
      },
      nonNegativeInteger: {
        type: "integer",
        minimum: 0
      },
      nonNegativeIntegerDefault0: {
        allOf: [{ $ref: "#/definitions/nonNegativeInteger" }, { default: 0 }]
      },
      simpleTypes: {
        enum: ["array", "boolean", "integer", "null", "number", "object", "string"]
      },
      stringArray: {
        type: "array",
        items: { type: "string" },
        uniqueItems: true,
        default: []
      }
    },
    type: ["object", "boolean"],
    properties: {
      $id: {
        type: "string",
        format: "uri-reference"
      },
      $schema: {
        type: "string",
        format: "uri"
      },
      $ref: {
        type: "string",
        format: "uri-reference"
      },
      $comment: {
        type: "string"
      },
      title: {
        type: "string"
      },
      description: {
        type: "string"
      },
      default: true,
      readOnly: {
        type: "boolean",
        default: false
      },
      examples: {
        type: "array",
        items: true
      },
      multipleOf: {
        type: "number",
        exclusiveMinimum: 0
      },
      maximum: {
        type: "number"
      },
      exclusiveMaximum: {
        type: "number"
      },
      minimum: {
        type: "number"
      },
      exclusiveMinimum: {
        type: "number"
      },
      maxLength: { $ref: "#/definitions/nonNegativeInteger" },
      minLength: { $ref: "#/definitions/nonNegativeIntegerDefault0" },
      pattern: {
        type: "string",
        format: "regex"
      },
      additionalItems: { $ref: "#" },
      items: {
        anyOf: [{ $ref: "#" }, { $ref: "#/definitions/schemaArray" }],
        default: true
      },
      maxItems: { $ref: "#/definitions/nonNegativeInteger" },
      minItems: { $ref: "#/definitions/nonNegativeIntegerDefault0" },
      uniqueItems: {
        type: "boolean",
        default: false
      },
      contains: { $ref: "#" },
      maxProperties: { $ref: "#/definitions/nonNegativeInteger" },
      minProperties: { $ref: "#/definitions/nonNegativeIntegerDefault0" },
      required: { $ref: "#/definitions/stringArray" },
      additionalProperties: { $ref: "#" },
      definitions: {
        type: "object",
        additionalProperties: { $ref: "#" },
        default: {}
      },
      properties: {
        type: "object",
        additionalProperties: { $ref: "#" },
        default: {}
      },
      patternProperties: {
        type: "object",
        additionalProperties: { $ref: "#" },
        propertyNames: { format: "regex" },
        default: {}
      },
      dependencies: {
        type: "object",
        additionalProperties: {
          anyOf: [{ $ref: "#" }, { $ref: "#/definitions/stringArray" }]
        }
      },
      propertyNames: { $ref: "#" },
      const: true,
      enum: {
        type: "array",
        items: true,
        minItems: 1,
        uniqueItems: true
      },
      type: {
        anyOf: [
          { $ref: "#/definitions/simpleTypes" },
          {
            type: "array",
            items: { $ref: "#/definitions/simpleTypes" },
            minItems: 1,
            uniqueItems: true
          }
        ]
      },
      format: { type: "string" },
      contentMediaType: { type: "string" },
      contentEncoding: { type: "string" },
      if: { $ref: "#" },
      then: { $ref: "#" },
      else: { $ref: "#" },
      allOf: { $ref: "#/definitions/schemaArray" },
      anyOf: { $ref: "#/definitions/schemaArray" },
      oneOf: { $ref: "#/definitions/schemaArray" },
      not: { $ref: "#" }
    },
    default: true
  };
});

// node_modules/ajv/dist/ajv.js
var require_ajv = __commonJS((exports, module) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.MissingRefError = exports.ValidationError = exports.CodeGen = exports.Name = exports.nil = exports.stringify = exports.str = exports._ = exports.KeywordCxt = exports.Ajv = undefined;
  var core_1 = require_core();
  var draft7_1 = require_draft7();
  var discriminator_1 = require_discriminator();
  var draft7MetaSchema = require_json_schema_draft_07();
  var META_SUPPORT_DATA = ["/properties"];
  var META_SCHEMA_ID = "http://json-schema.org/draft-07/schema";

  class Ajv extends core_1.default {
    _addVocabularies() {
      super._addVocabularies();
      draft7_1.default.forEach((v) => this.addVocabulary(v));
      if (this.opts.discriminator)
        this.addKeyword(discriminator_1.default);
    }
    _addDefaultMetaSchema() {
      super._addDefaultMetaSchema();
      if (!this.opts.meta)
        return;
      const metaSchema = this.opts.$data ? this.$dataMetaSchema(draft7MetaSchema, META_SUPPORT_DATA) : draft7MetaSchema;
      this.addMetaSchema(metaSchema, META_SCHEMA_ID, false);
      this.refs["http://json-schema.org/schema"] = META_SCHEMA_ID;
    }
    defaultMeta() {
      return this.opts.defaultMeta = super.defaultMeta() || (this.getSchema(META_SCHEMA_ID) ? META_SCHEMA_ID : undefined);
    }
  }
  exports.Ajv = Ajv;
  module.exports = exports = Ajv;
  module.exports.Ajv = Ajv;
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.default = Ajv;
  var validate_1 = require_validate();
  Object.defineProperty(exports, "KeywordCxt", { enumerable: true, get: function() {
    return validate_1.KeywordCxt;
  } });
  var codegen_1 = require_codegen();
  Object.defineProperty(exports, "_", { enumerable: true, get: function() {
    return codegen_1._;
  } });
  Object.defineProperty(exports, "str", { enumerable: true, get: function() {
    return codegen_1.str;
  } });
  Object.defineProperty(exports, "stringify", { enumerable: true, get: function() {
    return codegen_1.stringify;
  } });
  Object.defineProperty(exports, "nil", { enumerable: true, get: function() {
    return codegen_1.nil;
  } });
  Object.defineProperty(exports, "Name", { enumerable: true, get: function() {
    return codegen_1.Name;
  } });
  Object.defineProperty(exports, "CodeGen", { enumerable: true, get: function() {
    return codegen_1.CodeGen;
  } });
  var validation_error_1 = require_validation_error();
  Object.defineProperty(exports, "ValidationError", { enumerable: true, get: function() {
    return validation_error_1.default;
  } });
  var ref_error_1 = require_ref_error();
  Object.defineProperty(exports, "MissingRefError", { enumerable: true, get: function() {
    return ref_error_1.default;
  } });
});

// node_modules/ajv-formats/dist/formats.js
var require_formats = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.formatNames = exports.fastFormats = exports.fullFormats = undefined;
  function fmtDef(validate, compare) {
    return { validate, compare };
  }
  exports.fullFormats = {
    date: fmtDef(date, compareDate),
    time: fmtDef(getTime(true), compareTime),
    "date-time": fmtDef(getDateTime(true), compareDateTime),
    "iso-time": fmtDef(getTime(), compareIsoTime),
    "iso-date-time": fmtDef(getDateTime(), compareIsoDateTime),
    duration: /^P(?!$)((\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?|(\d+W)?)$/,
    uri,
    "uri-reference": /^(?:[a-z][a-z0-9+\-.]*:)?(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'"()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?(?:\?(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i,
    "uri-template": /^(?:(?:[^\x00-\x20"'<>%\\^`{|}]|%[0-9a-f]{2})|\{[+#./;?&=,!@|]?(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?(?:,(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?)*\})*$/i,
    url: /^(?:https?|ftp):\/\/(?:\S+(?::\S*)?@)?(?:(?!(?:10|127)(?:\.\d{1,3}){3})(?!(?:169\.254|192\.168)(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z0-9\u{00a1}-\u{ffff}]+-)*[a-z0-9\u{00a1}-\u{ffff}]+)(?:\.(?:[a-z0-9\u{00a1}-\u{ffff}]+-)*[a-z0-9\u{00a1}-\u{ffff}]+)*(?:\.(?:[a-z\u{00a1}-\u{ffff}]{2,})))(?::\d{2,5})?(?:\/[^\s]*)?$/iu,
    email: /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i,
    hostname: /^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-0-9a-z]{0,61}[0-9a-z])?)*\.?$/i,
    ipv4: /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/,
    ipv6: /^((([0-9a-f]{1,4}:){7}([0-9a-f]{1,4}|:))|(([0-9a-f]{1,4}:){6}(:[0-9a-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){5}(((:[0-9a-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){4}(((:[0-9a-f]{1,4}){1,3})|((:[0-9a-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){3}(((:[0-9a-f]{1,4}){1,4})|((:[0-9a-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){2}(((:[0-9a-f]{1,4}){1,5})|((:[0-9a-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){1}(((:[0-9a-f]{1,4}){1,6})|((:[0-9a-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9a-f]{1,4}){1,7})|((:[0-9a-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))$/i,
    regex,
    uuid: /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i,
    "json-pointer": /^(?:\/(?:[^~/]|~0|~1)*)*$/,
    "json-pointer-uri-fragment": /^#(?:\/(?:[a-z0-9_\-.!$&'()*+,;:=@]|%[0-9a-f]{2}|~0|~1)*)*$/i,
    "relative-json-pointer": /^(?:0|[1-9][0-9]*)(?:#|(?:\/(?:[^~/]|~0|~1)*)*)$/,
    byte,
    int32: { type: "number", validate: validateInt32 },
    int64: { type: "number", validate: validateInt64 },
    float: { type: "number", validate: validateNumber },
    double: { type: "number", validate: validateNumber },
    password: true,
    binary: true
  };
  exports.fastFormats = {
    ...exports.fullFormats,
    date: fmtDef(/^\d\d\d\d-[0-1]\d-[0-3]\d$/, compareDate),
    time: fmtDef(/^(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)$/i, compareTime),
    "date-time": fmtDef(/^\d\d\d\d-[0-1]\d-[0-3]\dt(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)$/i, compareDateTime),
    "iso-time": fmtDef(/^(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)?$/i, compareIsoTime),
    "iso-date-time": fmtDef(/^\d\d\d\d-[0-1]\d-[0-3]\d[t\s](?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)?$/i, compareIsoDateTime),
    uri: /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/)?[^\s]*$/i,
    "uri-reference": /^(?:(?:[a-z][a-z0-9+\-.]*:)?\/?\/)?(?:[^\\\s#][^\s#]*)?(?:#[^\\\s]*)?$/i,
    email: /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i
  };
  exports.formatNames = Object.keys(exports.fullFormats);
  function isLeapYear(year) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  }
  var DATE = /^(\d\d\d\d)-(\d\d)-(\d\d)$/;
  var DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  function date(str) {
    const matches = DATE.exec(str);
    if (!matches)
      return false;
    const year = +matches[1];
    const month = +matches[2];
    const day = +matches[3];
    return month >= 1 && month <= 12 && day >= 1 && day <= (month === 2 && isLeapYear(year) ? 29 : DAYS[month]);
  }
  function compareDate(d1, d2) {
    if (!(d1 && d2))
      return;
    if (d1 > d2)
      return 1;
    if (d1 < d2)
      return -1;
    return 0;
  }
  var TIME = /^(\d\d):(\d\d):(\d\d(?:\.\d+)?)(z|([+-])(\d\d)(?::?(\d\d))?)?$/i;
  function getTime(strictTimeZone) {
    return function time(str) {
      const matches = TIME.exec(str);
      if (!matches)
        return false;
      const hr = +matches[1];
      const min = +matches[2];
      const sec = +matches[3];
      const tz = matches[4];
      const tzSign = matches[5] === "-" ? -1 : 1;
      const tzH = +(matches[6] || 0);
      const tzM = +(matches[7] || 0);
      if (tzH > 23 || tzM > 59 || strictTimeZone && !tz)
        return false;
      if (hr <= 23 && min <= 59 && sec < 60)
        return true;
      const utcMin = min - tzM * tzSign;
      const utcHr = hr - tzH * tzSign - (utcMin < 0 ? 1 : 0);
      return (utcHr === 23 || utcHr === -1) && (utcMin === 59 || utcMin === -1) && sec < 61;
    };
  }
  function compareTime(s1, s2) {
    if (!(s1 && s2))
      return;
    const t1 = new Date("2020-01-01T" + s1).valueOf();
    const t2 = new Date("2020-01-01T" + s2).valueOf();
    if (!(t1 && t2))
      return;
    return t1 - t2;
  }
  function compareIsoTime(t1, t2) {
    if (!(t1 && t2))
      return;
    const a1 = TIME.exec(t1);
    const a2 = TIME.exec(t2);
    if (!(a1 && a2))
      return;
    t1 = a1[1] + a1[2] + a1[3];
    t2 = a2[1] + a2[2] + a2[3];
    if (t1 > t2)
      return 1;
    if (t1 < t2)
      return -1;
    return 0;
  }
  var DATE_TIME_SEPARATOR = /t|\s/i;
  function getDateTime(strictTimeZone) {
    const time = getTime(strictTimeZone);
    return function date_time(str) {
      const dateTime = str.split(DATE_TIME_SEPARATOR);
      return dateTime.length === 2 && date(dateTime[0]) && time(dateTime[1]);
    };
  }
  function compareDateTime(dt1, dt2) {
    if (!(dt1 && dt2))
      return;
    const d1 = new Date(dt1).valueOf();
    const d2 = new Date(dt2).valueOf();
    if (!(d1 && d2))
      return;
    return d1 - d2;
  }
  function compareIsoDateTime(dt1, dt2) {
    if (!(dt1 && dt2))
      return;
    const [d1, t1] = dt1.split(DATE_TIME_SEPARATOR);
    const [d2, t2] = dt2.split(DATE_TIME_SEPARATOR);
    const res = compareDate(d1, d2);
    if (res === undefined)
      return;
    return res || compareTime(t1, t2);
  }
  var NOT_URI_FRAGMENT = /\/|:/;
  var URI = /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)(?:\?(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i;
  function uri(str) {
    return NOT_URI_FRAGMENT.test(str) && URI.test(str);
  }
  var BYTE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/gm;
  function byte(str) {
    BYTE.lastIndex = 0;
    return BYTE.test(str);
  }
  var MIN_INT32 = -(2 ** 31);
  var MAX_INT32 = 2 ** 31 - 1;
  function validateInt32(value) {
    return Number.isInteger(value) && value <= MAX_INT32 && value >= MIN_INT32;
  }
  function validateInt64(value) {
    return Number.isInteger(value);
  }
  function validateNumber() {
    return true;
  }
  var Z_ANCHOR = /[^\\]\\Z/;
  function regex(str) {
    if (Z_ANCHOR.test(str))
      return false;
    try {
      new RegExp(str);
      return true;
    } catch (e) {
      return false;
    }
  }
});

// node_modules/ajv-formats/dist/limit.js
var require_limit = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.formatLimitDefinition = undefined;
  var ajv_1 = require_ajv();
  var codegen_1 = require_codegen();
  var ops = codegen_1.operators;
  var KWDs = {
    formatMaximum: { okStr: "<=", ok: ops.LTE, fail: ops.GT },
    formatMinimum: { okStr: ">=", ok: ops.GTE, fail: ops.LT },
    formatExclusiveMaximum: { okStr: "<", ok: ops.LT, fail: ops.GTE },
    formatExclusiveMinimum: { okStr: ">", ok: ops.GT, fail: ops.LTE }
  };
  var error = {
    message: ({ keyword, schemaCode }) => (0, codegen_1.str)`should be ${KWDs[keyword].okStr} ${schemaCode}`,
    params: ({ keyword, schemaCode }) => (0, codegen_1._)`{comparison: ${KWDs[keyword].okStr}, limit: ${schemaCode}}`
  };
  exports.formatLimitDefinition = {
    keyword: Object.keys(KWDs),
    type: "string",
    schemaType: "string",
    $data: true,
    error,
    code(cxt) {
      const { gen, data, schemaCode, keyword, it } = cxt;
      const { opts, self } = it;
      if (!opts.validateFormats)
        return;
      const fCxt = new ajv_1.KeywordCxt(it, self.RULES.all.format.definition, "format");
      if (fCxt.$data)
        validate$DataFormat();
      else
        validateFormat();
      function validate$DataFormat() {
        const fmts = gen.scopeValue("formats", {
          ref: self.formats,
          code: opts.code.formats
        });
        const fmt = gen.const("fmt", (0, codegen_1._)`${fmts}[${fCxt.schemaCode}]`);
        cxt.fail$data((0, codegen_1.or)((0, codegen_1._)`typeof ${fmt} != "object"`, (0, codegen_1._)`${fmt} instanceof RegExp`, (0, codegen_1._)`typeof ${fmt}.compare != "function"`, compareCode(fmt)));
      }
      function validateFormat() {
        const format = fCxt.schema;
        const fmtDef = self.formats[format];
        if (!fmtDef || fmtDef === true)
          return;
        if (typeof fmtDef != "object" || fmtDef instanceof RegExp || typeof fmtDef.compare != "function") {
          throw new Error(`"${keyword}": format "${format}" does not define "compare" function`);
        }
        const fmt = gen.scopeValue("formats", {
          key: format,
          ref: fmtDef,
          code: opts.code.formats ? (0, codegen_1._)`${opts.code.formats}${(0, codegen_1.getProperty)(format)}` : undefined
        });
        cxt.fail$data(compareCode(fmt));
      }
      function compareCode(fmt) {
        return (0, codegen_1._)`${fmt}.compare(${data}, ${schemaCode}) ${KWDs[keyword].fail} 0`;
      }
    },
    dependencies: ["format"]
  };
  var formatLimitPlugin = (ajv) => {
    ajv.addKeyword(exports.formatLimitDefinition);
    return ajv;
  };
  exports.default = formatLimitPlugin;
});

// node_modules/ajv-formats/dist/index.js
var require_dist = __commonJS((exports, module) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var formats_1 = require_formats();
  var limit_1 = require_limit();
  var codegen_1 = require_codegen();
  var fullName = new codegen_1.Name("fullFormats");
  var fastName = new codegen_1.Name("fastFormats");
  var formatsPlugin = (ajv, opts = { keywords: true }) => {
    if (Array.isArray(opts)) {
      addFormats(ajv, opts, formats_1.fullFormats, fullName);
      return ajv;
    }
    const [formats, exportName] = opts.mode === "fast" ? [formats_1.fastFormats, fastName] : [formats_1.fullFormats, fullName];
    const list = opts.formats || formats_1.formatNames;
    addFormats(ajv, list, formats, exportName);
    if (opts.keywords)
      (0, limit_1.default)(ajv);
    return ajv;
  };
  formatsPlugin.get = (name, mode = "full") => {
    const formats = mode === "fast" ? formats_1.fastFormats : formats_1.fullFormats;
    const f = formats[name];
    if (!f)
      throw new Error(`Unknown format "${name}"`);
    return f;
  };
  function addFormats(ajv, list, fs, exportName) {
    var _a;
    var _b;
    (_a = (_b = ajv.opts.code).formats) !== null && _a !== undefined || (_b.formats = (0, codegen_1._)`require("ajv-formats/dist/formats").${exportName}`);
    for (const f of list)
      ajv.addFormat(f, fs[f]);
  }
  module.exports = exports = formatsPlugin;
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.default = formatsPlugin;
});

// packages/protocol/dist/version.js
var PROTOCOL_VERSION = "0.1.0";
// packages/protocol/dist/validate.js
var import_ajv = __toESM(require_ajv(), 1);
var import_ajv_formats = __toESM(require_dist(), 1);
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
var __dirname2 = dirname(fileURLToPath(import.meta.url));
var ajv = new import_ajv.default({ strict: true });
import_ajv_formats.default(ajv);
function loadSchema(filename) {
  const distSchemasPath = join(__dirname2, "schemas", filename);
  const srcSchemasPath = join(__dirname2, "..", "src", "schemas", filename);
  const envSchemasDir = String(process.env.PUSHPALS_PROTOCOL_SCHEMAS_DIR ?? "").trim();
  const envSchemasPath = envSchemasDir ? join(envSchemasDir, filename) : "";
  const candidates = [distSchemasPath, srcSchemasPath, envSchemasPath].filter(Boolean);
  for (const pathValue of candidates) {
    try {
      return JSON.parse(readFileSync(pathValue, "utf-8"));
    } catch {}
  }
  throw new Error(`Failed to load schema ${filename}. Expected at dist/schemas (build), src/schemas (dev), or PUSHPALS_PROTOCOL_SCHEMAS_DIR.`);
}
var envelopeSchema = loadSchema("envelope.schema.json");
var eventsSchema = loadSchema("events.schema.json");
try {
  ajv.addSchema(envelopeSchema, "envelope.schema.json");
  ajv.addSchema(eventsSchema, "events.schema.json");
} catch (_e) {}
var validateEnvelopeBase = ajv.compile(envelopeSchema);
var validateEventPayload = ajv.compile(eventsSchema);
var validateMessageRequestSchema = ajv.compile({
  type: "object",
  required: ["text"],
  properties: {
    text: { type: "string" },
    intent: { type: "object", additionalProperties: true }
  },
  additionalProperties: false
});
var validateMessageResponseSchema = ajv.compile({
  type: "object",
  required: ["ok"],
  properties: {
    ok: { type: "boolean" }
  },
  additionalProperties: false
});
var validateApprovalDecisionRequestSchema = ajv.compile({
  type: "object",
  required: ["decision"],
  properties: {
    decision: {
      type: "string",
      enum: ["approve", "deny"]
    }
  },
  additionalProperties: false
});
var validateApprovalDecisionResponseSchema = ajv.compile({
  type: "object",
  required: ["ok"],
  properties: {
    ok: { type: "boolean" }
  },
  additionalProperties: false
});
function validateEventEnvelope(data) {
  const baseValid = validateEnvelopeBase(data);
  if (!baseValid) {
    const errors = (validateEnvelopeBase.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim());
    return { ok: false, errors };
  }
  const maybe = data;
  const pair = { type: maybe?.type, payload: maybe?.payload };
  const payloadValid = validateEventPayload(pair);
  if (!payloadValid) {
    const errors = (validateEventPayload.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim());
    return { ok: false, errors };
  }
  return { ok: true };
}
function validateMessageRequest(data) {
  const valid = validateMessageRequestSchema(data);
  return {
    ok: valid,
    errors: valid ? undefined : ajv.errorsText(validateMessageRequestSchema.errors).split(", ")
  };
}
function validateApprovalDecisionRequest(data) {
  const valid = validateApprovalDecisionRequestSchema(data);
  return {
    ok: valid,
    errors: valid ? undefined : ajv.errorsText(validateApprovalDecisionRequestSchema.errors).split(", ")
  };
}
var allEventTypes = [
  "log",
  "scan_result",
  "suggestions",
  "diff_ready",
  "approval_required",
  "approved",
  "denied",
  "committed",
  "assistant_message",
  "error",
  "done",
  "agent_status",
  "task_created",
  "task_started",
  "task_progress",
  "task_completed",
  "task_failed",
  "tool_call",
  "tool_result",
  "delegate_request",
  "delegate_response",
  "job_enqueued",
  "job_claimed",
  "job_completed",
  "job_failed",
  "message",
  "job_log",
  "status",
  "autonomy_cycle_started",
  "autonomy_candidates_generated",
  "autonomy_objective_dispatched",
  "autonomy_objective_blocked",
  "autonomy_feedback_recorded",
  "question_asked",
  "question_answered"
];
var validateCommandRequestSchema = ajv.compile({
  type: "object",
  required: ["type", "payload"],
  properties: {
    type: { type: "string", enum: allEventTypes },
    payload: { type: "object", additionalProperties: true },
    from: { type: "string" },
    to: { type: "string" },
    correlationId: { type: "string" },
    turnId: { type: "string" },
    parentId: { type: "string" }
  },
  additionalProperties: false
});
function validateCommandRequest(data) {
  const valid = validateCommandRequestSchema(data);
  return {
    ok: valid,
    errors: valid ? undefined : ajv.errorsText(validateCommandRequestSchema.errors).split(", ")
  };
}
// apps/server/src/events.ts
import { randomUUID } from "crypto";

// apps/server/src/db.ts
import { Database } from "bun:sqlite";

class EventStore {
  db;
  insertEventStmt;
  getEventsAfterStmt;
  getAllEventsStmt;
  getLatestCursorStmt;
  insertSessionStmt;
  getSessionStmt;
  constructor(dbPath = ":memory:") {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this._migrate();
    this.insertEventStmt = this.db.prepare(`
      INSERT INTO events (id, session_id, type, ts, envelope)
      VALUES ($id, $sessionId, $type, $ts, $envelope)
      RETURNING event_id AS eventId
    `);
    this.getEventsAfterStmt = this.db.prepare(`
      SELECT event_id AS eventId, id, session_id AS sessionId, type, ts, envelope
      FROM events
      WHERE session_id = $sessionId AND event_id > $afterEventId
      ORDER BY event_id ASC
      LIMIT $limit
    `);
    this.getAllEventsStmt = this.db.prepare(`
      SELECT event_id AS eventId, id, session_id AS sessionId, type, ts, envelope
      FROM events
      WHERE session_id = $sessionId
      ORDER BY event_id ASC
    `);
    this.getLatestCursorStmt = this.db.prepare(`
      SELECT MAX(event_id) AS cursor FROM events WHERE session_id = $sessionId
    `);
    this.insertSessionStmt = this.db.prepare(`
      INSERT INTO sessions (session_id, created_at, label)
      VALUES ($sessionId, $createdAt, $label)
      ON CONFLICT(session_id) DO NOTHING
    `);
    this.getSessionStmt = this.db.prepare(`
      SELECT session_id AS sessionId, created_at AS createdAt, label
      FROM sessions
      WHERE session_id = $sessionId
    `);
  }
  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id  TEXT PRIMARY KEY,
        created_at  TEXT NOT NULL,
        label       TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        event_id    INTEGER PRIMARY KEY AUTOINCREMENT,
        id          TEXT    NOT NULL,
        session_id  TEXT    NOT NULL,
        type        TEXT    NOT NULL,
        ts          TEXT    NOT NULL,
        envelope    TEXT    NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      );

      CREATE INDEX IF NOT EXISTS idx_events_session_cursor
        ON events (session_id, event_id);
    `);
  }
  createSession(sessionId, label) {
    const res = this.insertSessionStmt.run({
      $sessionId: sessionId,
      $createdAt: new Date().toISOString(),
      $label: label ?? null
    });
    return res.changes === 1;
  }
  getSession(sessionId) {
    return this.getSessionStmt.get({ $sessionId: sessionId }) ?? null;
  }
  insertEvent(envelope) {
    const row = this.insertEventStmt.get({
      $id: envelope.id,
      $sessionId: envelope.sessionId,
      $type: envelope.type,
      $ts: envelope.ts,
      $envelope: JSON.stringify(envelope)
    });
    return row.eventId;
  }
  static DEFAULT_REPLAY_LIMIT = 1000;
  static MAX_REPLAY_LIMIT = 1e4;
  getEventsAfter(sessionId, afterEventId = 0, limit = EventStore.DEFAULT_REPLAY_LIMIT) {
    const clampedLimit = Math.min(Math.max(1, limit), EventStore.MAX_REPLAY_LIMIT);
    return this.getEventsAfterStmt.all({
      $sessionId: sessionId,
      $afterEventId: afterEventId,
      $limit: clampedLimit
    });
  }
  getAllEvents(sessionId) {
    return this.getAllEventsStmt.all({ $sessionId: sessionId });
  }
  getLatestCursor(sessionId) {
    const row = this.getLatestCursorStmt.get({ $sessionId: sessionId });
    return row?.cursor ?? 0;
  }
  close() {
    this.db.close();
  }
}

// apps/server/src/events.ts
var STARTUP_READY_MESSAGE = "All systems online, feel free to send messages!";
var ASK_REMOTE_BUDDY_COMMAND = "/ask_remote_buddy";
var ASK_REMOTE_BUDDY_USAGE = "Usage: /ask_remote_buddy <request>. Example: /ask_remote_buddy fix the failing job status in the dashboard.";
var STARTUP_READY_REQUIRED_KEYS = ["remotebuddy"];
var STARTUP_READY_DETAIL_RE = /\bonline\b/i;
var startupReadyKeyForAgent = (agentId) => {
  if (agentId === "source_control_manager")
    return "source_control_manager";
  if (agentId.startsWith("localbuddy"))
    return "localbuddy";
  if (agentId.startsWith("remotebuddy"))
    return "remotebuddy";
  return null;
};
function normalizeIncomingClientMessageText(text) {
  const trimmed = String(text ?? "").trim();
  const command = ASK_REMOTE_BUDDY_COMMAND.toLowerCase();
  if (!trimmed.toLowerCase().startsWith(command)) {
    return { text: trimmed };
  }
  const rest = trimmed.slice(command.length).replace(/^[:\-]\s*/, "").trim();
  if (!rest) {
    return {
      text: "",
      usageMessage: ASK_REMOTE_BUDDY_USAGE
    };
  }
  return { text: rest };
}
function parseIncomingClientMessage(body) {
  const validation = validateMessageRequest(body);
  if (!validation.ok) {
    return {
      ok: false,
      message: validation.errors?.join("; ") || "Invalid message request"
    };
  }
  const rawText = body.text;
  const intent = body.intent;
  const normalized = normalizeIncomingClientMessageText(rawText);
  if (normalized.usageMessage) {
    return {
      ok: false,
      message: normalized.usageMessage
    };
  }
  return {
    ok: true,
    accepted: {
      text: normalized.text,
      ...intent ? { intent } : {},
      turnId: randomUUID()
    }
  };
}

class SessionEventBus {
  sessionId;
  subscribers = new Set;
  store;
  tasks = new Map;
  constructor(sessionId, store) {
    this.sessionId = sessionId;
    this.store = store;
  }
  subscribe(callback) {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }
  emit(envelope) {
    const validation = validateEventEnvelope(envelope);
    if (!validation.ok) {
      const errorEnvelope = {
        protocolVersion: PROTOCOL_VERSION,
        id: randomUUID(),
        ts: new Date().toISOString(),
        sessionId: this.sessionId,
        type: "error",
        payload: {
          message: "Failed to validate event",
          detail: validation.errors?.join("; ")
        }
      };
      const cursor2 = this.store.insertEvent(errorEnvelope);
      this.subscribers.forEach((cb) => cb(errorEnvelope, cursor2));
      return cursor2;
    }
    this._trackTask(envelope);
    const cursor = this.store.insertEvent(envelope);
    this.subscribers.forEach((cb) => cb(envelope, cursor));
    return cursor;
  }
  replayHistory(callback, afterEventId = 0) {
    const rows = this.store.getEventsAfter(this.sessionId, afterEventId);
    for (const row of rows) {
      try {
        const envelope = JSON.parse(row.envelope);
        callback(envelope, row.eventId);
      } catch (err) {
        console.error(`[replay] Failed to parse event ${row.eventId} in session ${this.sessionId}:`, err);
      }
    }
  }
  getLatestCursor() {
    return this.store.getLatestCursor(this.sessionId);
  }
  getSubscriberCount() {
    return this.subscribers.size;
  }
  _trackTask(envelope) {
    const p = envelope.payload;
    switch (envelope.type) {
      case "task_created":
        this.tasks.set(p.taskId, {
          taskId: p.taskId,
          title: p.title,
          description: p.description,
          createdBy: p.createdBy,
          status: "created",
          priority: p.priority,
          tags: p.tags
        });
        break;
      case "task_started": {
        const t = this.tasks.get(p.taskId);
        if (t)
          t.status = "started";
        break;
      }
      case "task_progress": {
        const t = this.tasks.get(p.taskId);
        if (t)
          t.status = "in_progress";
        break;
      }
      case "task_completed": {
        const t = this.tasks.get(p.taskId);
        if (t) {
          t.status = "completed";
          t.summary = p.summary;
        }
        break;
      }
      case "task_failed": {
        const t = this.tasks.get(p.taskId);
        if (t) {
          t.status = "failed";
          t.failMessage = p.message;
        }
        break;
      }
    }
  }
}

class SessionManager {
  sessions = new Map;
  startupReadyBySession = new Map;
  clientMessageIngress = null;
  pendingApprovals = new Map;
  authToken = process.env.PUSHPALS_AUTH_TOKEN ?? null;
  store;
  constructor(dbPath) {
    this.store = new EventStore(dbPath);
  }
  close() {
    this.store.close();
  }
  setClientMessageIngress(handler) {
    this.clientMessageIngress = handler;
  }
  static SESSION_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;
  createSession(sessionId) {
    if (sessionId && !SessionManager.SESSION_ID_RE.test(sessionId)) {
      return { id: null, created: false };
    }
    const id = sessionId ?? randomUUID();
    const created = this.store.createSession(id);
    if (!this.sessions.has(id)) {
      this.sessions.set(id, new SessionEventBus(id, this.store));
    }
    return { id, created };
  }
  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }
  validateAuth(headerValue) {
    if (!this.authToken)
      return true;
    if (!headerValue)
      return false;
    const token = headerValue.replace(/^Bearer\s+/i, "");
    return token === this.authToken;
  }
  emitClientMessageValidationError(sessionId, message) {
    return this.emitClientMessageError(sessionId, message, "invalid");
  }
  emitClientMessageError(sessionId, message, code = "invalid") {
    const session = this.getSession(sessionId);
    if (!session) {
      return { ok: false, code: "session_not_found", message: "Session not found" };
    }
    session.emit({
      protocolVersion: PROTOCOL_VERSION,
      id: randomUUID(),
      ts: new Date().toISOString(),
      sessionId,
      type: "error",
      payload: {
        message
      }
    });
    return { ok: false, code, message };
  }
  emitAcceptedClientMessage(sessionId, accepted) {
    const session = this.getSession(sessionId);
    if (!session) {
      return { ok: false, code: "session_not_found", message: "Session not found" };
    }
    const messageEnv = {
      protocolVersion: PROTOCOL_VERSION,
      id: randomUUID(),
      ts: new Date().toISOString(),
      sessionId,
      type: "message",
      from: "client",
      turnId: accepted.turnId,
      payload: {
        text: accepted.text,
        ...accepted.intent ? { intent: accepted.intent } : {}
      }
    };
    session.emit(messageEnv);
    return { ok: true, code: "accepted", eventId: messageEnv.id };
  }
  handleMessage(sessionId, body) {
    const session = this.getSession(sessionId);
    if (!session) {
      return { ok: false, code: "session_not_found", message: "Session not found" };
    }
    const parsed = parseIncomingClientMessage(body);
    if (!parsed.ok) {
      return this.emitClientMessageValidationError(sessionId, parsed.message);
    }
    if (this.clientMessageIngress) {
      try {
        const ingress = this.clientMessageIngress(sessionId, parsed.accepted);
        if (!ingress.ok) {
          return this.emitClientMessageError(sessionId, ingress.message || "Failed to enqueue request", "enqueue_failed");
        }
        return {
          ...this.emitAcceptedClientMessage(sessionId, parsed.accepted),
          ...ingress.requestId ? { requestId: ingress.requestId } : {},
          ...typeof ingress.queuePosition === "number" ? { queuePosition: ingress.queuePosition } : {},
          ...typeof ingress.etaMs === "number" ? { etaMs: ingress.etaMs } : {}
        };
      } catch (err) {
        return this.emitClientMessageError(sessionId, err instanceof Error ? err.message : String(err), "enqueue_failed");
      }
    }
    return this.emitAcceptedClientMessage(sessionId, parsed.accepted);
  }
  handleCommand(sessionId, body) {
    const session = this.getSession(sessionId);
    if (!session)
      return { ok: false, message: "Session not found" };
    const validation = validateCommandRequest(body);
    if (!validation.ok) {
      return { ok: false, message: validation.errors?.join("; ") };
    }
    const cmd = body;
    const eventId = randomUUID();
    const envelope = {
      protocolVersion: PROTOCOL_VERSION,
      id: eventId,
      ts: new Date().toISOString(),
      sessionId,
      type: cmd.type,
      from: cmd.from,
      to: cmd.to,
      correlationId: cmd.correlationId,
      turnId: cmd.turnId,
      parentId: cmd.parentId,
      payload: cmd.payload
    };
    if (cmd.type === "tool_call" && cmd.payload.requiresApproval === true) {
      const toolCallId = cmd.payload.toolCallId;
      this._createApprovalFromToolCall(sessionId, toolCallId, cmd.payload);
    }
    session.emit(envelope);
    this._maybeEmitStartupReady(sessionId, envelope);
    return { ok: true, eventId };
  }
  _maybeEmitStartupReady(sessionId, envelope) {
    if (envelope.type !== "status")
      return;
    const payload = envelope.payload;
    const agentId = typeof payload.agentId === "string" ? payload.agentId : "";
    if (!agentId)
      return;
    const readyKey = startupReadyKeyForAgent(agentId);
    if (!readyKey)
      return;
    const detail = typeof payload.detail === "string" ? payload.detail : "";
    if (!STARTUP_READY_DETAIL_RE.test(detail))
      return;
    const state = this.startupReadyBySession.get(sessionId) ?? {
      readyKeys: new Set,
      announced: false
    };
    if (state.announced)
      return;
    state.readyKeys.add(readyKey);
    this.startupReadyBySession.set(sessionId, state);
    const allReady = STARTUP_READY_REQUIRED_KEYS.every((key) => state.readyKeys.has(key));
    if (!allReady)
      return;
    state.announced = true;
    const session = this.getSession(sessionId);
    if (!session)
      return;
    session.emit({
      protocolVersion: PROTOCOL_VERSION,
      id: randomUUID(),
      ts: new Date().toISOString(),
      sessionId,
      type: "assistant_message",
      from: "system",
      payload: { text: STARTUP_READY_MESSAGE }
    });
  }
  createApproval(sessionId, action, summary, details) {
    const approvalId = randomUUID();
    this.pendingApprovals.set(approvalId, {
      approvalId,
      sessionId,
      action,
      summary,
      details
    });
    const session = this.getSession(sessionId);
    if (session) {
      session.emit({
        protocolVersion: PROTOCOL_VERSION,
        id: randomUUID(),
        ts: new Date().toISOString(),
        sessionId,
        type: "approval_required",
        payload: {
          approvalId,
          action,
          summary,
          details
        }
      });
    }
    return approvalId;
  }
  _createApprovalFromToolCall(sessionId, toolCallId, payload) {
    this.pendingApprovals.set(toolCallId, {
      approvalId: toolCallId,
      sessionId,
      toolCallId,
      action: payload.tool ?? "other",
      summary: `Tool call: ${payload.tool}`,
      details: payload
    });
    const session = this.getSession(sessionId);
    if (session) {
      session.emit({
        protocolVersion: PROTOCOL_VERSION,
        id: randomUUID(),
        ts: new Date().toISOString(),
        sessionId,
        type: "approval_required",
        payload: {
          approvalId: toolCallId,
          action: "other",
          summary: `Tool call: ${payload.tool}`,
          details: payload
        }
      });
    }
  }
  handleApprovalDecision(approvalId, decision) {
    const approval = this.pendingApprovals.get(approvalId);
    if (!approval) {
      return { ok: false, message: "Approval not found" };
    }
    const validation = validateApprovalDecisionRequest({ decision });
    if (!validation.ok) {
      return { ok: false, message: validation.errors?.join("; ") };
    }
    const session = this.getSession(approval.sessionId);
    if (!session) {
      return { ok: false, message: "Session not found" };
    }
    const eventType = decision === "approve" ? "approved" : "denied";
    session.emit({
      protocolVersion: PROTOCOL_VERSION,
      id: randomUUID(),
      ts: new Date().toISOString(),
      sessionId: approval.sessionId,
      type: eventType,
      payload: {
        approvalId
      }
    });
    this.pendingApprovals.delete(approvalId);
    return { ok: true };
  }
}

// apps/server/src/jobs.ts
import { Database as Database2 } from "bun:sqlite";
import { createHash as createHash2, randomUUID as randomUUID2 } from "crypto";
// packages/shared/src/prompts.ts
var promptTemplateCache = new Map;
var repoDocCache = new Map;
// packages/shared/src/config.ts
import { existsSync, readFileSync as readFileSync2 } from "fs";
import { join as join2, resolve, isAbsolute } from "path";

// packages/shared/src/autonomy_policy.ts
import { createHash } from "crypto";
var PATH_META_RE = /[*?\[\]{}()!]/;
var DRIVE_RE = /^[A-Za-z]:\//;
var SLASH_RE = /\/+/g;
function parentPath(path) {
  const idx = path.lastIndexOf("/");
  if (idx <= 0)
    return path;
  return path.slice(0, idx);
}
function isProbablyFilePath(path) {
  const lastSegment = path.split("/").at(-1) ?? "";
  return lastSegment.includes(".");
}
function scopeSeedPath(path) {
  return isProbablyFilePath(path) ? parentPath(path) : path;
}
function commonRepoAncestor(paths) {
  const normalized = paths.map((entry) => normalizeRepoRelativePath(entry)).filter((entry) => Boolean(entry));
  if (normalized.length === 0)
    return null;
  if (normalized.length === 1)
    return normalized[0] ?? null;
  const segments = normalized.map((entry) => entry.split("/"));
  const shared = [];
  const first = segments[0] ?? [];
  for (let idx = 0;idx < first.length; idx += 1) {
    const segment = first[idx];
    if (!segment)
      break;
    if (segments.every((parts) => parts[idx] === segment)) {
      shared.push(segment);
      continue;
    }
    break;
  }
  if (shared.length === 0)
    return null;
  return shared.join("/");
}
function normalizeAutonomyComponentArea(value) {
  const normalized = normalizeRepoRelativePath(value);
  if (!normalized)
    return null;
  return normalized;
}
function deriveAutonomyComponentArea(targetPathsInput, writeGlobsInput) {
  const writePrefixes = Array.isArray(writeGlobsInput) ? writeGlobsInput.map((entry) => normalizeWriteGlob(entry)).filter((entry) => Boolean(entry)).map((entry) => literalPrefix(entry)).map((entry) => scopeSeedPath(entry)).filter(Boolean) : [];
  if (writePrefixes.length > 0) {
    return commonRepoAncestor(writePrefixes);
  }
  const targetSeeds = Array.isArray(targetPathsInput) ? targetPathsInput.map((entry) => normalizeTargetPath(entry)).filter((entry) => Boolean(entry)).map((entry) => scopeSeedPath(entry)).filter(Boolean) : [];
  if (targetSeeds.length === 0)
    return null;
  return commonRepoAncestor(targetSeeds);
}
function collectScopeSeedPaths(targetPathsInput, writeGlobsInput) {
  const seeds = new Set;
  if (Array.isArray(writeGlobsInput)) {
    for (const raw of writeGlobsInput) {
      const normalized = normalizeWriteGlob(raw);
      if (!normalized)
        continue;
      const prefix = literalPrefix(normalized);
      if (!prefix)
        continue;
      const seed = scopeSeedPath(prefix);
      if (seed)
        seeds.add(seed);
    }
  }
  if (Array.isArray(targetPathsInput)) {
    for (const raw of targetPathsInput) {
      const normalized = normalizeTargetPath(raw);
      if (!normalized)
        continue;
      const seed = scopeSeedPath(normalized);
      if (seed)
        seeds.add(seed);
    }
  }
  return [...seeds];
}
function componentRootPrefix(area) {
  const normalized = normalizeAutonomyComponentArea(area);
  if (!normalized)
    return "";
  return `${normalized}/`;
}
function normalizeRepoRelativePath(value) {
  if (typeof value !== "string")
    return null;
  let path = value.trim();
  if (!path)
    return null;
  path = path.normalize("NFC").replace(/\\/g, "/");
  if (path.startsWith("/"))
    return null;
  if (DRIVE_RE.test(path))
    return null;
  path = path.replace(SLASH_RE, "/");
  const out = [];
  for (const rawSegment of path.split("/")) {
    const segment = rawSegment.trim();
    if (!segment || segment === ".")
      continue;
    if (segment === "..")
      return null;
    out.push(segment);
  }
  if (out.length === 0)
    return null;
  return out.join("/");
}
function normalizeTargetPath(value) {
  const normalized = normalizeRepoRelativePath(value);
  if (!normalized)
    return null;
  if (PATH_META_RE.test(normalized))
    return null;
  return normalized;
}
function isSupportedGlobSyntax(glob) {
  if (!glob)
    return false;
  if (glob.includes("\\"))
    return false;
  if (/[{}\[\]()!]/.test(glob))
    return false;
  const segments = glob.split("/");
  for (const segment of segments) {
    if (!segment || segment === ".")
      return false;
    if (segment === "..")
      return false;
    const idx = segment.indexOf("**");
    if (idx >= 0 && segment !== "**")
      return false;
  }
  return true;
}
function normalizeWriteGlob(value) {
  if (typeof value !== "string")
    return null;
  let glob = value.trim();
  if (!glob)
    return null;
  glob = glob.normalize("NFC").replace(/\\/g, "/");
  if (glob.startsWith("/"))
    return null;
  if (DRIVE_RE.test(glob))
    return null;
  while (glob.startsWith("./"))
    glob = glob.slice(2);
  glob = glob.replace(SLASH_RE, "/").replace(/\/+$/, "");
  if (!glob)
    return null;
  if (!isSupportedGlobSyntax(glob))
    return null;
  return glob;
}
function literalPrefix(glob) {
  const segments = glob.split("/");
  const out = [];
  for (const segment of segments) {
    if (segment === "**" || segment.includes("*") || segment.includes("?"))
      break;
    out.push(segment);
  }
  return out.join("/");
}
function escapeRegex(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function matchesSegment(pathSegment, globSegment) {
  const regexSource = `^${escapeRegex(globSegment).replace(/\\\*/g, ".*").replace(/\\\?/g, ".")}$`;
  return new RegExp(regexSource).test(pathSegment);
}
function matchesGlob(path, glob) {
  const pathSegs = path.split("/");
  const globSegs = glob.split("/");
  const walk = (pi, gi) => {
    if (gi >= globSegs.length)
      return pi >= pathSegs.length;
    const g = globSegs[gi];
    if (g === "**") {
      if (gi === globSegs.length - 1)
        return true;
      for (let k = pi;k <= pathSegs.length; k++) {
        if (walk(k, gi + 1))
          return true;
      }
      return false;
    }
    if (pi >= pathSegs.length)
      return false;
    if (!matchesSegment(pathSegs[pi], g))
      return false;
    return walk(pi + 1, gi + 1);
  };
  return walk(0, 0);
}
function clamp01(value) {
  if (!Number.isFinite(value))
    return 0;
  if (value < 0)
    return 0;
  if (value > 1)
    return 1;
  return value;
}
function normalizePenalties(values) {
  const map = new Map;
  for (const value of values) {
    const reason = String(value.reason ?? "").trim();
    const kind = value.kind;
    if (!kind || !reason)
      continue;
    const key = `${kind}\u241F${reason}`;
    if (map.has(key))
      continue;
    map.set(key, {
      kind,
      reason,
      weight: clamp01(Number(value.weight)),
      evidence_ids: Array.isArray(value.evidence_ids) ? value.evidence_ids.map((entry) => String(entry ?? "").trim()).filter(Boolean).slice(0, 24) : []
    });
  }
  return [...map.values()].sort((a, b) => {
    if (a.kind === b.kind)
      return a.reason.localeCompare(b.reason);
    return a.kind.localeCompare(b.kind);
  });
}
function penaltyTotal(values) {
  return normalizePenalties(values).reduce((sum, value) => sum + clamp01(value.weight), 0);
}
function globBreadthScore(glob) {
  const hasGlobStar = glob.includes("**") ? 1 : 0;
  const wildcardCount = (glob.match(/[\*\?]/g) ?? []).length;
  const rootWide = /^[\*]/.test(glob) || glob.startsWith("**/") ? 1 : 0;
  const literalSegments = glob.split("/").filter((segment) => segment.length > 0 && !segment.includes("*") && !segment.includes("?")).length;
  const shallowPenalty = Math.max(0, 2 - Math.min(literalSegments, 2));
  return 4 * hasGlobStar + 2 * rootWide + Math.min(4, wildcardCount) + shallowPenalty;
}
function classifyGlobBreadth(writeGlobs) {
  const scores = writeGlobs.map(globBreadthScore);
  const total = scores.reduce((sum, score) => sum + score, 0);
  const max = Math.max(...scores, 0);
  if (max <= 3 && total <= 6 && writeGlobs.length <= 3)
    return "narrow";
  if (max <= 6 && total <= 12 && writeGlobs.length <= 5)
    return "medium";
  return "broad";
}
function underRoot(path, rootPrefix) {
  if (path.startsWith(rootPrefix))
    return true;
  return rootPrefix.endsWith("/") && path === rootPrefix.slice(0, -1);
}
function hasForbiddenBroadGlob(glob) {
  if (glob === "." || glob === "**")
    return true;
  if (glob === "*" || glob === "*/**")
    return true;
  if (glob === "**/*" || glob === "**/**")
    return true;
  return false;
}
function validateScopeInvariants(componentArea, targetPathsInput, writeGlobsInput, options) {
  const errors = [];
  const scopeSeeds = collectScopeSeedPaths(targetPathsInput, writeGlobsInput);
  const normalizedComponentArea = normalizeAutonomyComponentArea(componentArea) ?? deriveAutonomyComponentArea(targetPathsInput, writeGlobsInput);
  const allowMultipleComponentRoots = options?.allowMultipleComponentRoots === true;
  const hintsOnly = options?.hintsOnly === true;
  if (!hintsOnly && !normalizedComponentArea && scopeSeeds.length > 1 && !allowMultipleComponentRoots) {
    errors.push(`scope spans multiple component roots: ${scopeSeeds.slice(0, 6).join(", ")}`);
  }
  const rootPrefix = normalizedComponentArea ? componentRootPrefix(normalizedComponentArea) : "";
  const normalizedTargetPaths = [];
  const targetSeen = new Set;
  for (const raw of targetPathsInput) {
    const normalized = normalizeTargetPath(raw);
    if (!normalized) {
      errors.push(`invalid target_path: ${String(raw ?? "")}`);
      continue;
    }
    if (!hintsOnly && rootPrefix && !underRoot(normalized, rootPrefix)) {
      errors.push(`target_path outside component root: ${normalized}`);
      continue;
    }
    if (targetSeen.has(normalized))
      continue;
    targetSeen.add(normalized);
    normalizedTargetPaths.push(normalized);
  }
  normalizedTargetPaths.sort();
  if (normalizedTargetPaths.length === 0) {
    errors.push("target_paths must contain at least one literal path");
  }
  const normalizedWriteGlobs = [];
  const writeSeen = new Set;
  for (const raw of writeGlobsInput) {
    const normalized = normalizeWriteGlob(raw);
    if (!normalized) {
      errors.push(`invalid write_glob: ${String(raw ?? "")}`);
      continue;
    }
    if (!hintsOnly && hasForbiddenBroadGlob(normalized)) {
      errors.push(`forbidden broad write_glob: ${normalized}`);
      continue;
    }
    const prefix = literalPrefix(normalized);
    if (!hintsOnly && !prefix) {
      errors.push(`write_glob literal prefix cannot be empty: ${normalized}`);
      continue;
    }
    if (!hintsOnly && rootPrefix && !underRoot(prefix, rootPrefix)) {
      errors.push(`write_glob outside component root: ${normalized}`);
      continue;
    }
    if (!hintsOnly && !normalizedTargetPaths.some((targetPath) => targetPath === prefix || targetPath.startsWith(`${prefix}/`))) {
      errors.push(`write_glob prefix does not align with target_paths: ${normalized}`);
      continue;
    }
    if (writeSeen.has(normalized))
      continue;
    writeSeen.add(normalized);
    normalizedWriteGlobs.push(normalized);
  }
  normalizedWriteGlobs.sort();
  if ((options?.requireWriteGlobs ?? true) && normalizedWriteGlobs.length === 0) {
    errors.push("write_globs must be provided and non-empty");
  }
  if (!hintsOnly && normalizedTargetPaths.length > 0 && normalizedWriteGlobs.length > 0) {
    for (const targetPath of normalizedTargetPaths) {
      const covered = normalizedWriteGlobs.some((glob) => matchesGlob(targetPath, glob));
      if (!covered)
        errors.push(`target_path not covered by write_globs: ${targetPath}`);
    }
  }
  if (!hintsOnly && !normalizedComponentArea && !allowMultipleComponentRoots) {
    errors.push("component_area could not be derived from scope");
  }
  const breadth = classifyGlobBreadth(normalizedWriteGlobs);
  return {
    ok: errors.length === 0,
    componentArea: normalizedComponentArea,
    normalizedTargetPaths,
    normalizedWriteGlobs,
    breadth,
    errors
  };
}
function makePatternKey(objectiveType, targetPaths, triggerType, componentArea) {
  const normalizedTargets = [...targetPaths].map((entry) => normalizeTargetPath(entry)).filter((entry) => Boolean(entry)).filter((entry, index, array) => array.indexOf(entry) === index).sort();
  const payload = [
    String(objectiveType ?? "").trim(),
    normalizedTargets.join(","),
    String(triggerType ?? "").trim(),
    String(componentArea ?? "").trim()
  ].join("|");
  const digest = createHash("sha256").update(payload).digest("hex");
  return `pk_${digest}`;
}

// packages/shared/src/local_network.ts
var DEFAULT_LOCAL_LOOPBACK_HOST = "127.0.0.1";
function isLoopbackHost(hostname) {
  const normalized = String(hostname ?? "").trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}
function normalizeLoopbackHost(hostname) {
  const normalized = String(hostname ?? "").trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (isLoopbackHost(normalized))
    return DEFAULT_LOCAL_LOOPBACK_HOST;
  return DEFAULT_LOCAL_LOOPBACK_HOST;
}
function isLoopbackOrigin(origin) {
  const text = String(origin ?? "").trim();
  if (!text)
    return false;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}
function buildLocalCorsHeaders(options) {
  const headers = {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": options.allowAuthorizationHeader ? "content-type, authorization" : "content-type"
  };
  const origin = String(options.origin ?? "").trim();
  if (isLoopbackOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}
function normalizeLoopbackHttpUrl(value, fallbackPort) {
  const fallback = `http://${DEFAULT_LOCAL_LOOPBACK_HOST}:${Math.max(1, fallbackPort)}`;
  const text = String(value ?? "").trim();
  if (!text)
    return fallback;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return fallback;
    }
    parsed.protocol = "http:";
    parsed.username = "";
    parsed.password = "";
    parsed.hostname = normalizeLoopbackHost(parsed.hostname);
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    if (!parsed.port) {
      parsed.port = String(Math.max(1, fallbackPort));
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

// packages/shared/src/config.ts
var PROJECT_ROOT = resolve(import.meta.dir, "..", "..", "..");
var DEFAULT_CONFIG_DIR = "configs";
var TRUTHY = new Set(["1", "true", "yes", "on"]);
var FALSY = new Set(["0", "false", "no", "off"]);
var DEFAULT_WORKERPALS_QUALITY_CRITIC_MIN_SCORE = 8;
var DEFAULT_WORKERPALS_QUALITY_MAX_AUTO_REVISIONS = 3;
var DEFAULT_WORKERPALS_FILE_MODIFYING_JOBS = ["task.execute"];
var DEFAULT_WORKERPALS_OUTPUT_MAX_CHARS = 192 * 1024;
var DEFAULT_WORKERPALS_OUTPUT_MAX_LINES = 600;
var DEFAULT_WORKERPALS_OUTPUT_MAX_HEAD_LINES = 120;
var DEFAULT_WORKERPALS_QUALITY_VALIDATION_STEP_TIMEOUT_MS = 180000;
var DEFAULT_WORKERPALS_QUALITY_CRITIC_TIMEOUT_MS = 90000;
var DEFAULT_WORKERPALS_QUALITY_CRITIC_TIMEOUT_BEHAVIOR = "retry_once";
var DEFAULT_WORKERPALS_QUALITY_CRITIC_MAX_DIFF_CHARS = 16000;
var DEFAULT_WORKERPALS_QUALITY_CRITIC_MAX_VALIDATION_OUTPUT_CHARS = 8000;
var DEFAULT_WORKERPALS_EXECUTOR = "openai_codex";
var DEFAULT_WORKERPALS_EXECUTION_PLATFORM = "auto";
var DEFAULT_WORKERPALS_EXECUTOR_RESULT_PREFIX = "__PUSHPALS_OH_RESULT__ ";
var DEFAULT_REMOTEBUDDY_MEMORY_MAX_RECALL_ITEMS = 12;
var DEFAULT_REMOTEBUDDY_MEMORY_MAX_RECALL_CHARS = 2400;
var DEFAULT_REMOTEBUDDY_MEMORY_MAX_SUMMARY_CHARS = 420;
var DEFAULT_REMOTEBUDDY_MEMORY_RETENTION_DAYS = 30;
var DEFAULT_OPENAI_CODEX_MODEL = "gpt-5.6-sol";
var DEFAULT_OPENAI_CODEX_REASONING_EFFORT = "xhigh";
var REDACTED_LOG_VALUE = "[REDACTED]";
var SENSITIVE_CONFIG_KEY_PATTERN = /(token|secret|password|api[_-]?key|private[_-]?key|access[_-]?key)/i;
var cachedConfig = null;
var cachedConfigKey = "";
function invalidatePushPalsConfigCache() {
  cachedConfig = null;
  cachedConfigKey = "";
}
function firstNonEmpty(...values) {
  for (const value of values) {
    const trimmed = (value ?? "").trim();
    if (trimmed)
      return trimmed;
  }
  return "";
}
function parseBoolEnv(name) {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw)
    return null;
  if (TRUTHY.has(raw))
    return true;
  if (FALSY.has(raw))
    return false;
  return null;
}
function parseIntEnv(name) {
  const raw = (process.env[name] ?? "").trim();
  if (!raw)
    return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}
function parseTomlFile(path) {
  if (!existsSync(path))
    return {};
  const raw = readFileSync2(path, "utf-8").replace(/^\uFEFF/, "");
  const parsed = Bun.TOML.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return {};
  return parsed;
}
function parseRequiredTomlFile(path) {
  if (!existsSync(path)) {
    throw new Error(`Missing required runtime config file: ${path}`);
  }
  return parseTomlFile(path);
}
function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function mergeDeep(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    if (isObject(existing) && isObject(value)) {
      out[key] = mergeDeep(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
function getObject(parent, key) {
  const value = parent[key];
  if (isObject(value))
    return value;
  return {};
}
function asString(value, fallback) {
  if (typeof value === "string" && value.trim())
    return value.trim();
  return fallback;
}
function asQualityCriticTimeoutBehavior(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "skip" || normalized === "retry_once" || normalized === "block") {
    return normalized;
  }
  return DEFAULT_WORKERPALS_QUALITY_CRITIC_TIMEOUT_BEHAVIOR;
}
function normalizeWorkerPalsExecutionPlatform(value, fallback = DEFAULT_WORKERPALS_EXECUTION_PLATFORM) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "auto" || normalized === "windows" || normalized === "linux_docker") {
    return normalized;
  }
  return fallback;
}
function asBoolean(value, fallback) {
  if (typeof value === "boolean")
    return value;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (TRUTHY.has(lowered))
      return true;
    if (FALSY.has(lowered))
      return false;
  }
  return fallback;
}
function asInt(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value))
    return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed))
      return parsed;
  }
  return fallback;
}
function asIntOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value))
    return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed))
      return parsed;
  }
  return null;
}
function asStringArray(value) {
  if (!Array.isArray(value))
    return [];
  return value.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean);
}
function asCheckArray(value) {
  if (!Array.isArray(value))
    return [];
  const checks = [];
  for (const entry of value) {
    if (!isObject(entry))
      continue;
    const name = asString(entry.name, "").trim();
    const command = asString(entry.command, "").trim();
    if (!name || !command)
      continue;
    const timeoutMs = Math.max(1000, asInt(entry.timeout_ms ?? entry.timeoutMs, 300000));
    checks.push({ name, command, timeoutMs });
  }
  return checks;
}
function asStringNumberRecord(value) {
  if (!isObject(value))
    return {};
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    const name = key.trim();
    if (!name)
      continue;
    const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseInt(raw.trim(), 10) : Number.NaN;
    if (!Number.isFinite(num))
      continue;
    out[name] = Math.max(0, Math.floor(num));
  }
  return out;
}
function resolvePathFromRoot(projectRoot, value) {
  if (!value)
    return projectRoot;
  if (isAbsolute(value))
    return resolve(value);
  return resolve(projectRoot, value);
}
function resolveRuntimeConfigDir(projectRoot, configuredDir) {
  if (configuredDir && configuredDir.trim()) {
    return resolvePathFromRoot(projectRoot, configuredDir);
  }
  return resolvePathFromRoot(projectRoot, DEFAULT_CONFIG_DIR);
}
function normalizeBackend(value) {
  const text = value.trim().toLowerCase();
  if (!text)
    return "lmstudio";
  if (text === "openai_compatible")
    return "lmstudio";
  if (text === "ollama_chat")
    return "ollama";
  return text;
}
function normalizeWorkerImageRebuildMode(value) {
  const text = value.trim().toLowerCase();
  if (text === "always" || text === "1" || text === "true" || text === "yes" || text === "on") {
    return "always";
  }
  if (text === "never" || text === "0" || text === "false" || text === "no" || text === "off") {
    return "never";
  }
  return "auto";
}
function normalizeStartupPortConflictPolicy(value) {
  const text = value.trim().toLowerCase().replace(/-/g, "_");
  if (text === "terminate_pushpals" || text === "kill_pushpals" || text === "auto_kill_pushpals") {
    return "terminate_pushpals";
  }
  return "fail";
}
function defaultApiKeyForBackend(backend, endpoint) {
  const normalizedBackend = backend.trim().toLowerCase();
  const normalizedEndpoint = endpoint.trim().toLowerCase();
  const openAiKey = (process.env.OPENAI_API_KEY ?? "").trim();
  if (normalizedBackend === "openai") {
    return openAiKey;
  }
  if (normalizedBackend === "lmstudio") {
    return "lmstudio";
  }
  if (normalizedEndpoint.includes("api.openai.com")) {
    return openAiKey;
  }
  return "";
}
function resolveLlmConfig(serviceNode, envPrefix, defaults, globalSessionId) {
  const llmNode = getObject(serviceNode, "llm");
  const backend = normalizeBackend(firstNonEmpty(process.env[`${envPrefix}_LLM_BACKEND`], asString(llmNode.backend, defaults.backend), defaults.backend));
  const endpoint = firstNonEmpty(process.env[`${envPrefix}_LLM_ENDPOINT`], asString(llmNode.endpoint, defaults.endpoint), defaults.endpoint);
  const envModel = firstNonEmpty(process.env[`${envPrefix}_LLM_MODEL`]);
  const configuredFileModel = firstNonEmpty(asString(llmNode.model, ""));
  const configuredModel = firstNonEmpty(envModel, configuredFileModel);
  const modelFallback = backend === "openai_codex" ? DEFAULT_OPENAI_CODEX_MODEL : defaults.model;
  const model = backend === "openai_codex" && !envModel && (!configuredFileModel || configuredFileModel === defaults.model) ? DEFAULT_OPENAI_CODEX_MODEL : firstNonEmpty(configuredModel, modelFallback) ?? modelFallback;
  const sessionId = firstNonEmpty(process.env[`${envPrefix}_LLM_SESSION_ID`], asString(llmNode.session_id, defaults.sessionId), process.env.PUSHPALS_LLM_SESSION_ID, globalSessionId);
  const apiKey = firstNonEmpty(process.env[`${envPrefix}_LLM_API_KEY`], defaultApiKeyForBackend(backend, endpoint));
  const reasoningEffort = firstNonEmpty(process.env[`${envPrefix}_LLM_REASONING_EFFORT`], asString(llmNode.reasoning_effort, ""), backend === "openai_codex" ? DEFAULT_OPENAI_CODEX_REASONING_EFFORT : "");
  const codexAuthMode = firstNonEmpty(process.env[`${envPrefix}_LLM_CODEX_AUTH_MODE`], asString(llmNode.codex_auth_mode, ""));
  const codexBin = firstNonEmpty(process.env[`${envPrefix}_LLM_CODEX_BIN`], asString(llmNode.codex_bin, ""));
  const codexTimeoutMs = Math.max(1e4, asInt(parseIntEnv(`${envPrefix}_LLM_CODEX_TIMEOUT_MS`) ?? llmNode.codex_timeout_ms, 120000));
  return {
    backend,
    endpoint,
    model,
    sessionId,
    apiKey,
    reasoningEffort,
    codexAuthMode,
    codexBin,
    codexTimeoutMs
  };
}
function loadPushPalsConfig(options = {}) {
  const projectRootOverride = firstNonEmpty(options.projectRoot, process.env.PUSHPALS_PROJECT_ROOT_OVERRIDE, PROJECT_ROOT);
  const projectRoot = resolve(projectRootOverride);
  const configDirOverride = firstNonEmpty(options.configDir, process.env.PUSHPALS_CONFIG_DIR_OVERRIDE, "");
  const configDir = resolveRuntimeConfigDir(projectRoot, configDirOverride);
  const cacheKey = `${projectRoot}::${configDir}::${process.env.PUSHPALS_PROFILE ?? ""}`;
  if (!options.reload && cachedConfig && cachedConfigKey === cacheKey) {
    return cachedConfig;
  }
  const defaultToml = parseRequiredTomlFile(join2(configDir, "default.toml"));
  const preferredProfile = firstNonEmpty(process.env.PUSHPALS_PROFILE, asString(defaultToml.profile, "dev"), "dev");
  const profileToml = parseTomlFile(join2(configDir, `${preferredProfile}.toml`));
  const localExampleToml = parseTomlFile(join2(configDir, "local.example.toml"));
  const localToml = parseTomlFile(join2(configDir, "local.toml"));
  const merged = mergeDeep(mergeDeep(mergeDeep(defaultToml, profileToml), localExampleToml), localToml);
  const profile = firstNonEmpty(process.env.PUSHPALS_PROFILE, asString(merged.profile, preferredProfile), preferredProfile);
  const sessionId = firstNonEmpty(process.env.PUSHPALS_SESSION_ID, asString(merged.session_id, "dev"), "dev");
  const llmNode = getObject(merged, "llm");
  const lmStudioNode = getObject(llmNode, "lmstudio");
  const lmStudioContextWindow = Math.max(512, asInt(parseIntEnv("PUSHPALS_LMSTUDIO_CONTEXT_WINDOW") ?? lmStudioNode.context_window, 4096));
  const lmStudioMinOutputTokens = Math.max(64, asInt(parseIntEnv("PUSHPALS_LMSTUDIO_MIN_OUTPUT_TOKENS") ?? lmStudioNode.min_output_tokens, 256));
  const lmStudioTokenSafetyMargin = Math.max(16, asInt(parseIntEnv("PUSHPALS_LMSTUDIO_TOKEN_SAFETY_MARGIN") ?? lmStudioNode.token_safety_margin, 64));
  const lmStudioBatchTailMessages = Math.max(1, asInt(parseIntEnv("PUSHPALS_LMSTUDIO_BATCH_TAIL_MESSAGES") ?? lmStudioNode.batch_tail_messages, 3));
  const lmStudioBatchChunkTokens = Math.max(0, asInt(parseIntEnv("PUSHPALS_LMSTUDIO_BATCH_CHUNK_TOKENS") ?? lmStudioNode.batch_chunk_tokens, 0));
  const lmStudioBatchMemoryChars = Math.max(0, asInt(parseIntEnv("PUSHPALS_LMSTUDIO_BATCH_MEMORY_CHARS") ?? lmStudioNode.batch_memory_chars, 0));
  const pathsNode = getObject(merged, "paths");
  const dataDir = resolvePathFromRoot(projectRoot, firstNonEmpty(process.env.PUSHPALS_DATA_DIR, asString(pathsNode.data_dir, "outputs/data")));
  const sharedDbPath = resolvePathFromRoot(projectRoot, firstNonEmpty(process.env.PUSHPALS_DB_PATH, asString(pathsNode.shared_db_path, join2(dataDir, "pushpals.db"))));
  const remotebuddyDbPath = resolvePathFromRoot(projectRoot, firstNonEmpty(process.env.REMOTEBUDDY_DB_PATH, asString(pathsNode.remotebuddy_db_path, join2(dataDir, "remotebuddy-state.db"))));
  const serverNode = getObject(merged, "server");
  const serverPort = Math.max(1, asInt(parseIntEnv("PUSHPALS_PORT") ?? serverNode.port, 3001));
  const serverUrl = normalizeLoopbackHttpUrl(firstNonEmpty(process.env.PUSHPALS_SERVER_URL, asString(serverNode.url, `http://127.0.0.1:${serverPort}`), `http://127.0.0.1:${serverPort}`), serverPort);
  const serverHost = normalizeLoopbackHost(firstNonEmpty(process.env.PUSHPALS_HOST, asString(serverNode.host, "127.0.0.1")));
  const debugHttp = parseBoolEnv("PUSHPALS_DEBUG_HTTP") ?? asBoolean(serverNode.debug_http, false);
  const staleClaimTtlMs = Math.max(5000, asInt(parseIntEnv("PUSHPALS_STALE_CLAIM_TTL_MS") ?? serverNode.stale_claim_ttl_ms, 120000));
  const staleClaimSweepIntervalMs = Math.max(1000, asInt(parseIntEnv("PUSHPALS_STALE_CLAIM_SWEEP_INTERVAL_MS") ?? serverNode.stale_claim_sweep_interval_ms, 5000));
  const sessionTokenBudget = Math.max(0, asInt(parseIntEnv("PUSHPALS_SESSION_TOKEN_BUDGET") ?? serverNode.session_token_budget, 0));
  const sessionTokenBudgetAction = "pause";
  const globalStatusHeartbeatMs = parseIntEnv("PUSHPALS_STATUS_HEARTBEAT_MS");
  const localNode = getObject(merged, "localbuddy");
  const localEnabled = parseBoolEnv("LOCALBUDDY_ENABLED") ?? asBoolean(localNode.enabled, false);
  const localPort = Math.max(1, asInt(parseIntEnv("LOCAL_AGENT_PORT") ?? localNode.port, 3003));
  const localStatusHeartbeatMs = Math.max(0, asInt(parseIntEnv("LOCALBUDDY_STATUS_HEARTBEAT_MS") ?? globalStatusHeartbeatMs ?? localNode.status_heartbeat_ms, 120000));
  const localLlm = resolveLlmConfig(localNode, "LOCALBUDDY", {
    backend: "lmstudio",
    endpoint: "http://127.0.0.1:1234",
    model: "local-model",
    sessionId: "localbuddy-dev"
  }, sessionId);
  const remoteNode = getObject(merged, "remotebuddy");
  const remoteStatusHeartbeatMs = Math.max(0, asInt(parseIntEnv("REMOTEBUDDY_STATUS_HEARTBEAT_MS") ?? globalStatusHeartbeatMs ?? remoteNode.status_heartbeat_ms, 120000));
  const remotePollMs = Math.max(200, asInt(parseIntEnv("REMOTEBUDDY_POLL_MS") ?? remoteNode.poll_ms, 2000));
  const remoteMaxWorkerpals = Math.max(1, asInt(parseIntEnv("REMOTEBUDDY_MAX_WORKERPALS") ?? remoteNode.max_workerpals, 20));
  const remoteMinWorkerpals = Math.max(1, Math.min(remoteMaxWorkerpals, asInt(parseIntEnv("REMOTEBUDDY_MIN_WORKERPALS") ?? remoteNode.min_workerpals, 1)));
  const remoteLlm = resolveLlmConfig(remoteNode, "REMOTEBUDDY", {
    backend: "lmstudio",
    endpoint: "http://127.0.0.1:1234",
    model: "local-model",
    sessionId: "remotebuddy-dev"
  }, sessionId);
  const remoteMemoryNode = getObject(remoteNode, "memory");
  const remoteMemoryEnabled = parseBoolEnv("REMOTEBUDDY_MEMORY_ENABLED") ?? asBoolean(remoteMemoryNode.enabled, true);
  const remoteMemoryIncludeCrossSession = parseBoolEnv("REMOTEBUDDY_MEMORY_INCLUDE_CROSS_SESSION") ?? asBoolean(remoteMemoryNode.include_cross_session, true);
  const remoteMemoryMaxRecallItems = Math.max(1, Math.min(128, asInt(parseIntEnv("REMOTEBUDDY_MEMORY_MAX_RECALL_ITEMS") ?? remoteMemoryNode.max_recall_items, DEFAULT_REMOTEBUDDY_MEMORY_MAX_RECALL_ITEMS)));
  const remoteMemoryMaxRecallChars = Math.max(120, Math.min(64000, asInt(parseIntEnv("REMOTEBUDDY_MEMORY_MAX_RECALL_CHARS") ?? remoteMemoryNode.max_recall_chars, DEFAULT_REMOTEBUDDY_MEMORY_MAX_RECALL_CHARS)));
  const remoteMemoryMaxSummaryChars = Math.max(64, Math.min(16000, asInt(parseIntEnv("REMOTEBUDDY_MEMORY_MAX_SUMMARY_CHARS") ?? remoteMemoryNode.max_summary_chars, DEFAULT_REMOTEBUDDY_MEMORY_MAX_SUMMARY_CHARS)));
  const remoteMemoryRetentionDays = Math.max(1, Math.min(3650, asInt(parseIntEnv("REMOTEBUDDY_MEMORY_RETENTION_DAYS") ?? remoteMemoryNode.retention_days, DEFAULT_REMOTEBUDDY_MEMORY_RETENTION_DAYS)));
  const remoteAutonomyNode = getObject(remoteNode, "autonomy");
  const remoteAutonomyReplayNode = getObject(remoteAutonomyNode, "replay");
  const remoteAutonomyDispatchByTypeCfg = {
    flaky_test: 4,
    lint_fix: 3,
    type_fix: 3,
    small_refactor: 2,
    feature_small: 2,
    feature_medium: 1,
    feature_large: 0,
    docs: 1,
    dep_bump: 0
  };
  const remoteAutonomyDispatchByType = {
    ...remoteAutonomyDispatchByTypeCfg,
    ...asStringNumberRecord(remoteAutonomyNode.max_dispatch_per_hour_by_type)
  };
  const remoteAutonomyDispatchByComponentCfg = {
    "apps/server": 3,
    "apps/remotebuddy": 2,
    "apps/workerpals": 2,
    "apps/client": 2,
    "packages/protocol": 1,
    "packages/shared": 2,
    "tests/integration": 2,
    "tests/unit": 2
  };
  const remoteAutonomyDispatchByComponentRaw = asStringNumberRecord(remoteAutonomyNode.max_dispatch_per_hour_by_component);
  const legacyAutonomyComponentAliasMap = new Map(Object.keys(remoteAutonomyDispatchByComponentCfg).flatMap((key) => {
    const direct = normalizeAutonomyComponentArea(key);
    const legacyUnderscore = normalizeAutonomyComponentArea(key.replace(/\//g, "_"));
    const legacyHyphen = normalizeAutonomyComponentArea(key.replace(/\//g, "-"));
    return [direct, legacyUnderscore, legacyHyphen].filter((value) => Boolean(value)).map((value) => [value, key]);
  }));
  const coerceAutonomyComponentConfigKey = (value) => {
    const direct = normalizeAutonomyComponentArea(value);
    const legacyAliasCandidate = normalizeAutonomyComponentArea(value.trim().toLowerCase().replace(/\\/g, "/").replace(/_+/g, "/").replace(/-+/g, "/").replace(/\/+/g, "/"));
    if (legacyAliasCandidate && legacyAutonomyComponentAliasMap.has(legacyAliasCandidate)) {
      return legacyAutonomyComponentAliasMap.get(legacyAliasCandidate) ?? legacyAliasCandidate;
    }
    return direct;
  };
  const remoteAutonomyDispatchByComponent = Object.fromEntries(Object.entries(remoteAutonomyDispatchByComponentCfg).map(([key, value]) => [
    coerceAutonomyComponentConfigKey(key) ?? key,
    value
  ]));
  for (const [rawKey, rawValue] of Object.entries(remoteAutonomyDispatchByComponentRaw)) {
    const canonical = coerceAutonomyComponentConfigKey(rawKey);
    if (!canonical)
      continue;
    const parsed = rawValue;
    remoteAutonomyDispatchByComponent[canonical] = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
  }
  const workerNode = getObject(merged, "workerpals");
  const workerOpenHandsNode = getObject(workerNode, "openhands");
  const workerExecutionPlatform = normalizeWorkerPalsExecutionPlatform(firstNonEmpty(process.env.WORKERPALS_EXECUTION_PLATFORM, process.env.PUSHPALS_WORKERPALS_EXECUTION_PLATFORM, asString(workerNode.execution_platform, DEFAULT_WORKERPALS_EXECUTION_PLATFORM), DEFAULT_WORKERPALS_EXECUTION_PLATFORM));
  const configuredRemoteWorkerpalDocker = parseBoolEnv("REMOTEBUDDY_WORKERPAL_DOCKER") ?? asBoolean(remoteNode.workerpal_docker, true);
  const configuredRemoteWorkerpalRequireDocker = parseBoolEnv("REMOTEBUDDY_WORKERPAL_REQUIRE_DOCKER") ?? asBoolean(remoteNode.workerpal_require_docker, true);
  const configuredWorkerRequireDocker = parseBoolEnv("WORKERPALS_REQUIRE_DOCKER") ?? asBoolean(workerNode.require_docker, false);
  const effectiveRemoteWorkerpalDocker = workerExecutionPlatform === "windows" ? false : workerExecutionPlatform === "linux_docker" ? true : configuredRemoteWorkerpalDocker;
  const effectiveRemoteWorkerpalRequireDocker = workerExecutionPlatform === "windows" ? false : workerExecutionPlatform === "linux_docker" ? true : configuredRemoteWorkerpalRequireDocker;
  const effectiveWorkerRequireDocker = workerExecutionPlatform === "windows" ? false : workerExecutionPlatform === "linux_docker" ? true : configuredWorkerRequireDocker;
  const workerPollMs = Math.max(200, asInt(parseIntEnv("WORKERPALS_POLL_MS") ?? workerNode.poll_ms, 2000));
  const workerHeartbeatMs = Math.max(200, asInt(parseIntEnv("WORKERPALS_HEARTBEAT_MS") ?? workerNode.heartbeat_ms, 5000));
  const workerExecutor = firstNonEmpty(process.env.WORKERPALS_EXECUTOR, asString(workerNode.executor, DEFAULT_WORKERPALS_EXECUTOR), DEFAULT_WORKERPALS_EXECUTOR).toLowerCase();
  const workerOpenHandsPython = firstNonEmpty(process.env.WORKERPALS_OPENHANDS_PYTHON, asString(workerNode.openhands_python, "python"), "python");
  const workerOpenHandsTimeoutMs = Math.max(1e4, asInt(parseIntEnv("WORKERPALS_OPENHANDS_TIMEOUT_MS") ?? workerNode.openhands_timeout_ms, 1800000));
  const workerMiniswePython = firstNonEmpty(process.env.WORKERPALS_MINISWE_PYTHON, asString(workerNode.miniswe_python, "python"), "python");
  const workerMinisweTimeoutMs = Math.max(1e4, asInt(parseIntEnv("WORKERPALS_MINISWE_TIMEOUT_MS") ?? workerNode.miniswe_timeout_ms, 1800000));
  const workerOpenAICodexPython = firstNonEmpty(process.env.PUSHPALS_OPENAI_CODEX_PYTHON, asString(workerNode.openai_codex_python, "python"), "python");
  const workerOpenAICodexTimeoutMs = Math.max(1e4, asInt(workerNode.openai_codex_timeout_ms, 7200000));
  const workerQualityMaxAutoRevisions = Math.max(0, Math.min(10, asInt(parseIntEnv("WORKERPALS_QUALITY_MAX_AUTO_REVISIONS") ?? workerNode.quality_max_auto_revisions, DEFAULT_WORKERPALS_QUALITY_MAX_AUTO_REVISIONS)));
  const workerQualityValidationMaxAutoRevisions = Math.max(0, Math.min(10, asInt(parseIntEnv("WORKERPALS_QUALITY_VALIDATION_MAX_AUTO_REVISIONS") ?? workerNode.quality_validation_max_auto_revisions, DEFAULT_WORKERPALS_QUALITY_MAX_AUTO_REVISIONS)));
  const workerFileModifyingJobs = (() => {
    const envRaw = firstNonEmpty(process.env.WORKERPALS_FILE_MODIFYING_JOBS);
    const parsed = envRaw ? envRaw.split(",").map((entry) => entry.trim()).filter(Boolean) : asStringArray(workerNode.file_modifying_jobs);
    const out = parsed.length > 0 ? parsed : DEFAULT_WORKERPALS_FILE_MODIFYING_JOBS;
    return [...new Set(out)];
  })();
  const workerOutputMaxChars = Math.max(8192, Math.min(4194304, asInt(parseIntEnv("WORKERPALS_OUTPUT_MAX_CHARS") ?? workerNode.output_max_chars, DEFAULT_WORKERPALS_OUTPUT_MAX_CHARS)));
  const workerOutputMaxLines = Math.max(50, Math.min(20000, asInt(parseIntEnv("WORKERPALS_OUTPUT_MAX_LINES") ?? workerNode.output_max_lines, DEFAULT_WORKERPALS_OUTPUT_MAX_LINES)));
  const workerOutputMaxHeadLines = Math.max(1, Math.min(workerOutputMaxLines, asInt(parseIntEnv("WORKERPALS_OUTPUT_MAX_HEAD_LINES") ?? workerNode.output_max_head_lines, DEFAULT_WORKERPALS_OUTPUT_MAX_HEAD_LINES)));
  const workerQualityValidationStepTimeoutMs = Math.max(1000, asInt(parseIntEnv("WORKERPALS_QUALITY_VALIDATION_STEP_TIMEOUT_MS") ?? workerNode.quality_validation_step_timeout_ms, DEFAULT_WORKERPALS_QUALITY_VALIDATION_STEP_TIMEOUT_MS));
  const workerQualityCriticTimeoutMs = Math.max(1000, asInt(parseIntEnv("WORKERPALS_QUALITY_CRITIC_TIMEOUT_MS") ?? workerNode.quality_critic_timeout_ms, DEFAULT_WORKERPALS_QUALITY_CRITIC_TIMEOUT_MS));
  const workerQualityCriticTimeoutBehavior = asQualityCriticTimeoutBehavior(process.env.WORKERPALS_QUALITY_CRITIC_TIMEOUT_BEHAVIOR ?? workerNode.quality_critic_timeout_behavior);
  const workerQualitySoftPassOnExhausted = parseBoolEnv("WORKERPALS_QUALITY_SOFT_PASS_ON_EXHAUSTED") ?? asBoolean(workerNode.quality_soft_pass_on_exhausted, true);
  const workerQualityScopeGateEnabled = parseBoolEnv("WORKERPALS_QUALITY_SCOPE_GATE_ENABLED") ?? asBoolean(workerNode.quality_scope_gate_enabled, true);
  const workerQualityValidationGateEnabled = parseBoolEnv("WORKERPALS_QUALITY_VALIDATION_GATE_ENABLED") ?? asBoolean(workerNode.quality_validation_gate_enabled, true);
  const workerQualityCriticGateEnabled = parseBoolEnv("WORKERPALS_QUALITY_CRITIC_GATE_ENABLED") ?? asBoolean(workerNode.quality_critic_gate_enabled, true);
  const workerQualityPublishGateEnabled = parseBoolEnv("WORKERPALS_QUALITY_PUBLISH_GATE_ENABLED") ?? asBoolean(workerNode.quality_publish_gate_enabled, true);
  const workerQualityCriticMinScore = (() => {
    const configThresholdRaw = workerNode.quality_critic_min_score == null ? "" : String(workerNode.quality_critic_min_score);
    const raw = firstNonEmpty(process.env.WORKERPALS_QUALITY_CRITIC_MIN_SCORE, configThresholdRaw, String(DEFAULT_WORKERPALS_QUALITY_CRITIC_MIN_SCORE));
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed))
      return DEFAULT_WORKERPALS_QUALITY_CRITIC_MIN_SCORE;
    return Math.max(0, Math.min(10, parsed));
  })();
  const workerQualityCriticModel = firstNonEmpty(process.env.WORKERPALS_QUALITY_CRITIC_MODEL, asString(workerNode.quality_critic_model, ""), "");
  const workerQualityCriticMaxDiffChars = Math.max(256, Math.min(524288, asInt(parseIntEnv("WORKERPALS_QUALITY_CRITIC_MAX_DIFF_CHARS") ?? workerNode.quality_critic_max_diff_chars, DEFAULT_WORKERPALS_QUALITY_CRITIC_MAX_DIFF_CHARS)));
  const workerQualityCriticMaxValidationOutputChars = Math.max(256, Math.min(524288, asInt(parseIntEnv("WORKERPALS_QUALITY_CRITIC_MAX_VALIDATION_OUTPUT_CHARS") ?? workerNode.quality_critic_max_validation_output_chars, DEFAULT_WORKERPALS_QUALITY_CRITIC_MAX_VALIDATION_OUTPUT_CHARS)));
  const workerExecutorResultPrefix = (() => {
    if (process.env.WORKERPALS_EXECUTOR_RESULT_PREFIX !== undefined) {
      const raw = process.env.WORKERPALS_EXECUTOR_RESULT_PREFIX;
      if (typeof raw === "string" && raw.length > 0)
        return raw;
    }
    if (Object.prototype.hasOwnProperty.call(workerNode, "executor_result_prefix") && typeof workerNode.executor_result_prefix === "string" && workerNode.executor_result_prefix.length > 0) {
      return workerNode.executor_result_prefix;
    }
    return DEFAULT_WORKERPALS_EXECUTOR_RESULT_PREFIX;
  })();
  const workerOpenHandsStuckGuardEnabled = parseBoolEnv("WORKERPALS_OPENHANDS_STUCK_GUARD_ENABLED") ?? asBoolean(workerNode.openhands_stuck_guard_enabled, true);
  const workerOpenHandsStuckGuardExploreLimit = Math.max(6, asInt(parseIntEnv("WORKERPALS_OPENHANDS_STUCK_GUARD_EXPLORE_LIMIT") ?? workerNode.openhands_stuck_guard_explore_limit, 18));
  const workerOpenHandsStuckGuardMinElapsedMs = Math.max(60000, asInt(parseIntEnv("WORKERPALS_OPENHANDS_STUCK_GUARD_MIN_ELAPSED_MS") ?? workerNode.openhands_stuck_guard_min_elapsed_ms, 180000));
  const workerOpenHandsStuckGuardBroadScanLimit = Math.max(1, asInt(parseIntEnv("WORKERPALS_OPENHANDS_STUCK_GUARD_BROAD_SCAN_LIMIT") ?? workerNode.openhands_stuck_guard_broad_scan_limit, 2));
  const workerOpenHandsStuckGuardNoProgressMaxMs = Math.max(60000, asInt(parseIntEnv("WORKERPALS_OPENHANDS_STUCK_GUARD_NO_PROGRESS_MAX_MS") ?? workerNode.openhands_stuck_guard_no_progress_max_ms, 300000));
  const workerOpenHandsAutoSteerEnabled = parseBoolEnv("WORKERPALS_OPENHANDS_AUTO_STEER_ENABLED") ?? asBoolean(workerOpenHandsNode.auto_steer_enabled, true);
  const workerOpenHandsAutoSteerInitialDelaySec = Math.max(0, Math.min(600, asInt(parseIntEnv("WORKERPALS_OPENHANDS_AUTO_STEER_INITIAL_DELAY_SEC") ?? workerOpenHandsNode.auto_steer_initial_delay_sec, 90)));
  const workerOpenHandsAutoSteerIntervalSec = Math.max(15, Math.min(600, asInt(parseIntEnv("WORKERPALS_OPENHANDS_AUTO_STEER_INTERVAL_SEC") ?? workerOpenHandsNode.auto_steer_interval_sec, 60)));
  const workerOpenHandsAutoSteerMaxNudges = Math.max(0, Math.min(120, asInt(parseIntEnv("WORKERPALS_OPENHANDS_AUTO_STEER_MAX_NUDGES") ?? workerOpenHandsNode.auto_steer_max_nudges, 30)));
  const workerRequirePush = parseBoolEnv("WORKERPALS_REQUIRE_PUSH") ?? asBoolean(workerNode.require_push, false);
  const workerPushAgentBranchEnv = parseBoolEnv("WORKERPALS_PUSH_AGENT_BRANCH");
  const workerPushAgentBranch = workerRequirePush || (workerPushAgentBranchEnv ?? asBoolean(workerNode.push_agent_branch, false));
  const workerSkipDockerSelfCheck = parseBoolEnv("WORKERPALS_SKIP_DOCKER_SELF_CHECK") ?? asBoolean(workerNode.skip_docker_self_check, false);
  const workerDockerAgentStartupTimeoutMs = Math.max(1e4, Math.min(180000, asInt(parseIntEnv("WORKERPALS_DOCKER_AGENT_STARTUP_TIMEOUT_MS") ?? workerNode.docker_agent_startup_timeout_ms, 45000)));
  const workerDockerWarmMaxAttempts = Math.max(1, Math.min(5, asInt(parseIntEnv("WORKERPALS_DOCKER_WARM_MAX_ATTEMPTS") ?? workerNode.docker_warm_max_attempts, 3)));
  const workerDockerWarmRetryBackoffMs = Math.max(250, Math.min(60000, asInt(parseIntEnv("WORKERPALS_DOCKER_WARM_RETRY_BACKOFF_MS") ?? workerNode.docker_warm_retry_backoff_ms, 2000)));
  const workerDockerJobMaxAttempts = Math.max(1, Math.min(3, asInt(parseIntEnv("WORKERPALS_DOCKER_JOB_MAX_ATTEMPTS") ?? workerNode.docker_job_max_attempts, 2)));
  const workerDockerJobRetryBackoffMs = Math.max(250, Math.min(60000, asInt(parseIntEnv("WORKERPALS_DOCKER_JOB_RETRY_BACKOFF_MS") ?? workerNode.docker_job_retry_backoff_ms, 3000)));
  const workerDockerWarmMemoryMb = Math.max(512, Math.min(32768, asInt(parseIntEnv("WORKERPALS_DOCKER_WARM_MEMORY_MB") ?? workerNode.docker_warm_memory_mb, 2048)));
  const workerDockerWarmCpus = Math.max(1, Math.min(16, asInt(parseIntEnv("WORKERPALS_DOCKER_WARM_CPUS") ?? workerNode.docker_warm_cpus, 2)));
  const workerLlm = resolveLlmConfig(workerNode, "WORKERPALS", {
    backend: "lmstudio",
    endpoint: "http://127.0.0.1:1234",
    model: "local-model",
    sessionId: "workerpals-dev"
  }, sessionId);
  const scmNode = getObject(merged, "source_control_manager");
  const scmRepoPath = resolvePathFromRoot(projectRoot, firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_REPO_PATH, asString(scmNode.repo_path, ".worktrees/source_control_manager"), ".worktrees/source_control_manager"));
  const scmRemote = asString(process.env.SOURCE_CONTROL_MANAGER_REMOTE ?? scmNode.remote, "origin");
  const scmMainBranch = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_MAIN_BRANCH, process.env.PUSHPALS_INTEGRATION_BRANCH, asString(scmNode.pushpals_branch, "main_agents"), "main_agents");
  const scmBaseBranch = firstNonEmpty(process.env.PUSHPALS_INTEGRATION_BASE_BRANCH, asString(scmNode.base_branch, "main"), "main");
  const scmBranchPrefix = asString(process.env.SOURCE_CONTROL_MANAGER_BRANCH_PREFIX ?? scmNode.branch_prefix, "agent/");
  const scmPollIntervalSeconds = Math.max(1, asInt(parseIntEnv("SOURCE_CONTROL_MANAGER_POLL_INTERVAL_SECONDS") ?? scmNode.poll_interval_seconds, 10));
  const scmChecks = asCheckArray(scmNode.checks);
  const scmStateDir = resolvePathFromRoot(projectRoot, firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_STATE_DIR, asString(scmNode.state_dir, join2(dataDir, "source_control_manager")), join2(dataDir, "source_control_manager")));
  const scmPort = Math.max(1, Math.min(65535, asInt(parseIntEnv("SOURCE_CONTROL_MANAGER_PORT") ?? scmNode.port, 3002)));
  const scmDeleteAfterMerge = parseBoolEnv("SOURCE_CONTROL_MANAGER_DELETE_AFTER_MERGE") ?? asBoolean(scmNode.delete_after_merge, false);
  const scmMaxAttempts = Math.max(1, asInt(parseIntEnv("SOURCE_CONTROL_MANAGER_MAX_ATTEMPTS") ?? scmNode.max_attempts, 3));
  const scmMergeStrategyRaw = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_MERGE_STRATEGY, asString(scmNode.merge_strategy, "cherry-pick"), "cherry-pick");
  const scmMergeStrategy = scmMergeStrategyRaw === "no-ff" || scmMergeStrategyRaw === "ff-only" ? scmMergeStrategyRaw : "cherry-pick";
  let scmPushMainAfterMerge = asBoolean(scmNode.push_main_after_merge, true);
  const scmPushMainAfterMergeEnv = parseBoolEnv("SOURCE_CONTROL_MANAGER_PUSH_MAIN_AFTER_MERGE");
  if (scmPushMainAfterMergeEnv != null)
    scmPushMainAfterMerge = scmPushMainAfterMergeEnv;
  const scmNoPushEnv = parseBoolEnv("SOURCE_CONTROL_MANAGER_NO_PUSH");
  if (scmNoPushEnv != null)
    scmPushMainAfterMerge = !scmNoPushEnv;
  let scmOpenPrAfterPush = asBoolean(scmNode.open_pr_after_push, true);
  const scmOpenPrAfterPushEnv = parseBoolEnv("SOURCE_CONTROL_MANAGER_OPEN_PR_AFTER_PUSH");
  if (scmOpenPrAfterPushEnv != null)
    scmOpenPrAfterPush = scmOpenPrAfterPushEnv;
  const scmDisableAutoPrEnv = parseBoolEnv("SOURCE_CONTROL_MANAGER_DISABLE_AUTO_PR");
  if (scmDisableAutoPrEnv != null)
    scmOpenPrAfterPush = !scmDisableAutoPrEnv;
  const scmPrBaseBranch = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_PR_BASE_BRANCH, asString(scmNode.pr_base_branch, scmBaseBranch), scmBaseBranch);
  const scmPrTitle = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_PR_TITLE, asString(scmNode.pr_title, ""));
  const scmPrBody = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_PR_BODY, asString(scmNode.pr_body, ""));
  const scmPrDraft = parseBoolEnv("SOURCE_CONTROL_MANAGER_PR_DRAFT") ?? asBoolean(scmNode.pr_draft, false);
  const scmStatusHeartbeatMs = Math.max(0, asInt(parseIntEnv("SOURCE_CONTROL_MANAGER_STATUS_HEARTBEAT_MS") ?? globalStatusHeartbeatMs ?? scmNode.status_heartbeat_ms, 120000));
  const scmSkipCleanCheck = parseBoolEnv("SOURCE_CONTROL_MANAGER_SKIP_CLEAN_CHECK") ?? asBoolean(scmNode.skip_clean_check, false);
  const scmAutoCreateMainBranch = parseBoolEnv("SOURCE_CONTROL_MANAGER_AUTO_CREATE_MAIN_BRANCH") ?? asBoolean(scmNode.auto_create_main_branch, false);
  const scmReviewAgentNode = getObject(scmNode, "review_agent");
  const scmReviewAgentEnabled = parseBoolEnv("SOURCE_CONTROL_MANAGER_REVIEW_AGENT_ENABLED") ?? asBoolean(scmReviewAgentNode.enabled, false);
  const scmReviewAgentPollIntervalMs = Math.max(5000, asInt(parseIntEnv("SOURCE_CONTROL_MANAGER_REVIEW_AGENT_POLL_INTERVAL_MS") ?? scmReviewAgentNode.poll_interval_ms, 60000));
  const scmReviewAgentReviewerMdPath = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_REVIEW_AGENT_REVIEWER_MD_PATH, asString(scmReviewAgentNode.reviewer_md_path, "prompts/review_agent/reviewer.md"), "prompts/review_agent/reviewer.md");
  const scmReviewAgentPassThreshold = (() => {
    const configThresholdRaw = scmReviewAgentNode.pass_threshold == null ? "" : String(scmReviewAgentNode.pass_threshold);
    const raw = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_REVIEW_AGENT_PASS_THRESHOLD, configThresholdRaw, "9.5");
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? Math.max(1, Math.min(10, parsed)) : 9.5;
  })();
  const scmReviewAgentMaxPrCommentsBeforeGiveUp = Math.max(1, Math.min(100, asInt(parseIntEnv("SOURCE_CONTROL_MANAGER_REVIEW_AGENT_MAX_PR_COMMENTS_BEFORE_GIVE_UP") ?? scmReviewAgentNode.max_pr_comments_before_give_up, 10)));
  const scmReviewAgentMergeMethodRaw = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_REVIEW_AGENT_MERGE_METHOD, asString(scmReviewAgentNode.merge_method, "squash"), "squash").toLowerCase();
  const scmReviewAgentMergeMethod = scmReviewAgentMergeMethodRaw === "merge" || scmReviewAgentMergeMethodRaw === "rebase" ? scmReviewAgentMergeMethodRaw : "squash";
  const scmReviewAgentCodexBin = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_REVIEW_AGENT_CODEX_BIN, asString(scmReviewAgentNode.codex_bin, "bun x --yes @openai/codex"), "bun x --yes @openai/codex");
  const scmReviewAgentCodexAuthMode = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_REVIEW_AGENT_CODEX_AUTH_MODE, asString(scmReviewAgentNode.codex_auth_mode, "chatgpt"), "chatgpt");
  const scmReviewAgentCodexHomeDir = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_REVIEW_AGENT_CODEX_HOME_DIR, asString(scmReviewAgentNode.codex_home_dir, ""));
  const scmReviewAgentCodexTimeoutMs = Math.max(30000, asInt(parseIntEnv("SOURCE_CONTROL_MANAGER_REVIEW_AGENT_CODEX_TIMEOUT_MS") ?? scmReviewAgentNode.codex_timeout_ms, 300000));
  const startupNode = getObject(merged, "startup");
  const startupWorkerImageRebuild = normalizeWorkerImageRebuildMode(firstNonEmpty(process.env.PUSHPALS_WORKER_IMAGE_REBUILD, asString(startupNode.worker_image_rebuild, "auto"), "auto"));
  const startupLogConfigOnStart = parseBoolEnv("PUSHPALS_LOG_CONFIG_ON_START") ?? asBoolean(startupNode.log_config_on_start, true);
  const startupSyncIntegrationWithMain = parseBoolEnv("PUSHPALS_SYNC_INTEGRATION_WITH_MAIN") ?? asBoolean(startupNode.sync_integration_with_main, true);
  const startupSkipLlmPreflight = parseBoolEnv("PUSHPALS_SKIP_LLM_PREFLIGHT") ?? asBoolean(startupNode.skip_llm_preflight, false);
  const startupAutoStartLmStudio = parseBoolEnv("PUSHPALS_AUTO_START_LMSTUDIO") ?? asBoolean(startupNode.auto_start_lmstudio, true);
  const startupLmStudioReadyTimeoutMs = Math.max(1000, asInt(parseIntEnv("PUSHPALS_LMSTUDIO_READY_TIMEOUT_MS") ?? startupNode.lmstudio_ready_timeout_ms, 120000));
  const startupLmStudioCli = firstNonEmpty(process.env.PUSHPALS_LMSTUDIO_CLI, asString(startupNode.lmstudio_cli, "lms"), "lms");
  const startupLmStudioPort = Math.max(1, Math.min(65535, asInt(parseIntEnv("PUSHPALS_LMSTUDIO_PORT") ?? startupNode.lmstudio_port, 1234)));
  const startupLmStudioStartArgs = firstNonEmpty(process.env.PUSHPALS_LMSTUDIO_START_ARGS, asString(startupNode.lmstudio_start_args, ""));
  const startupWarmup = parseBoolEnv("PUSHPALS_STARTUP_WARMUP") ?? asBoolean(startupNode.startup_warmup, true);
  const startupWarmupTimeoutMs = Math.max(15000, asInt(parseIntEnv("PUSHPALS_STARTUP_WARMUP_TIMEOUT_MS") ?? startupNode.startup_warmup_timeout_ms, 120000));
  const startupWarmupPollMs = Math.max(250, Math.min(5000, asInt(parseIntEnv("PUSHPALS_STARTUP_WARMUP_POLL_MS") ?? startupNode.startup_warmup_poll_ms, 1000)));
  const startupAllowExternalClean = parseBoolEnv("PUSHPALS_ALLOW_EXTERNAL_CLEAN") ?? asBoolean(startupNode.allow_external_clean, false);
  const startupPortPreflight = parseBoolEnv("PUSHPALS_STARTUP_PORT_PREFLIGHT") ?? asBoolean(startupNode.port_preflight, true);
  const startupPortConflictPolicy = normalizeStartupPortConflictPolicy(firstNonEmpty(process.env.PUSHPALS_STARTUP_PORT_CONFLICT_POLICY, asString(startupNode.port_conflict_policy, "terminate_pushpals"), "terminate_pushpals"));
  const clientNode = getObject(merged, "client");
  const authToken = firstNonEmpty(process.env.PUSHPALS_AUTH_TOKEN) || null;
  const gitToken = firstNonEmpty(process.env.PUSHPALS_GIT_TOKEN, process.env.GITHUB_TOKEN, process.env.GH_TOKEN) || null;
  const config = {
    projectRoot,
    configDir,
    profile,
    sessionId,
    authToken,
    gitToken,
    llm: {
      lmstudio: {
        contextWindow: lmStudioContextWindow,
        minOutputTokens: lmStudioMinOutputTokens,
        tokenSafetyMargin: lmStudioTokenSafetyMargin,
        batchTailMessages: lmStudioBatchTailMessages,
        batchChunkTokens: lmStudioBatchChunkTokens,
        batchMemoryChars: lmStudioBatchMemoryChars
      }
    },
    paths: {
      dataDir,
      sharedDbPath,
      remotebuddyDbPath
    },
    server: {
      url: serverUrl,
      host: serverHost,
      port: serverPort,
      debugHttp,
      staleClaimTtlMs,
      staleClaimSweepIntervalMs,
      sessionTokenBudget,
      sessionTokenBudgetAction
    },
    localbuddy: {
      enabled: localEnabled,
      port: localPort,
      statusHeartbeatMs: localStatusHeartbeatMs,
      llm: localLlm
    },
    remotebuddy: {
      pollMs: remotePollMs,
      statusHeartbeatMs: remoteStatusHeartbeatMs,
      workerpalOnlineTtlMs: Math.max(1000, asInt(parseIntEnv("REMOTEBUDDY_WORKERPAL_ONLINE_TTL_MS") ?? remoteNode.workerpal_online_ttl_ms, 15000)),
      waitForWorkerpalMs: Math.max(0, asInt(parseIntEnv("REMOTEBUDDY_WAIT_FOR_WORKERPAL_MS") ?? remoteNode.wait_for_workerpal_ms, 15000)),
      autoSpawnWorkerpals: parseBoolEnv("REMOTEBUDDY_AUTO_SPAWN_WORKERPALS") ?? asBoolean(remoteNode.auto_spawn_workerpals, true),
      minWorkerpals: remoteMinWorkerpals,
      maxWorkerpals: remoteMaxWorkerpals,
      workerpalStartupTimeoutMs: Math.max(1000, asInt(parseIntEnv("REMOTEBUDDY_WORKERPAL_STARTUP_TIMEOUT_MS") ?? remoteNode.workerpal_startup_timeout_ms, 1e4)),
      workerpalDocker: effectiveRemoteWorkerpalDocker,
      workerpalRequireDocker: effectiveRemoteWorkerpalRequireDocker,
      workerpalImage: firstNonEmpty(process.env.REMOTEBUDDY_WORKERPAL_IMAGE, asString(remoteNode.workerpal_image, "")) || null,
      workerpalPollMs: asIntOrNull(parseIntEnv("REMOTEBUDDY_WORKERPAL_POLL_MS")) ?? asIntOrNull(remoteNode.workerpal_poll_ms),
      workerpalHeartbeatMs: asIntOrNull(parseIntEnv("REMOTEBUDDY_WORKERPAL_HEARTBEAT_MS")) ?? asIntOrNull(remoteNode.workerpal_heartbeat_ms),
      workerpalLabels: firstNonEmpty(process.env.REMOTEBUDDY_WORKERPAL_LABELS) ? firstNonEmpty(process.env.REMOTEBUDDY_WORKERPAL_LABELS).split(",").map((value) => value.trim()).filter(Boolean) : asStringArray(remoteNode.workerpal_labels),
      executionBudgetInteractiveMs: Math.max(60000, asInt(parseIntEnv("REMOTEBUDDY_EXECUTION_BUDGET_INTERACTIVE_MS") ?? remoteNode.execution_budget_interactive_ms, 300000)),
      executionBudgetNormalMs: Math.max(120000, asInt(parseIntEnv("REMOTEBUDDY_EXECUTION_BUDGET_NORMAL_MS") ?? remoteNode.execution_budget_normal_ms, 900000)),
      executionBudgetBackgroundMs: Math.max(180000, asInt(parseIntEnv("REMOTEBUDDY_EXECUTION_BUDGET_BACKGROUND_MS") ?? remoteNode.execution_budget_background_ms, 1200000)),
      finalizationBudgetMs: Math.max(30000, asInt(parseIntEnv("REMOTEBUDDY_FINALIZATION_BUDGET_MS") ?? remoteNode.finalization_budget_ms, 120000)),
      crashRestartEnabled: parseBoolEnv("REMOTEBUDDY_CRASH_RESTART_ENABLED") ?? asBoolean(remoteNode.crash_restart_enabled, true),
      crashRestartMaxRestarts: Math.max(0, asInt(parseIntEnv("REMOTEBUDDY_CRASH_RESTART_MAX_RESTARTS") ?? remoteNode.crash_restart_max_restarts, 3)),
      crashRestartBackoffMs: Math.max(0, asInt(parseIntEnv("REMOTEBUDDY_CRASH_RESTART_BACKOFF_MS") ?? remoteNode.crash_restart_backoff_ms, 3000)),
      memory: {
        enabled: remoteMemoryEnabled,
        includeCrossSession: remoteMemoryIncludeCrossSession,
        maxRecallItems: remoteMemoryMaxRecallItems,
        maxRecallChars: remoteMemoryMaxRecallChars,
        maxSummaryChars: remoteMemoryMaxSummaryChars,
        retentionDays: remoteMemoryRetentionDays
      },
      autonomy: {
        enabled: parseBoolEnv("REMOTEBUDDY_AUTONOMY_ENABLED") ?? asBoolean(remoteAutonomyNode.enabled, true),
        killSwitchEnabled: parseBoolEnv("REMOTEBUDDY_AUTONOMY_KILL_SWITCH_ENABLED") ?? asBoolean(remoteAutonomyNode.kill_switch_enabled, false),
        tickIntervalMs: Math.max(5000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_TICK_INTERVAL_MS") ?? remoteAutonomyNode.tick_interval_ms, 120000)),
        startupGraceMs: Math.max(0, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_STARTUP_GRACE_MS") ?? remoteAutonomyNode.startup_grace_ms, 120000)),
        heartbeatLogMs: Math.max(1000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_HEARTBEAT_LOG_MS") ?? remoteAutonomyNode.heartbeat_log_ms, 30000)),
        visionContextMaxChars: Math.max(1000, Math.min(1e6, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_VISION_CONTEXT_MAX_CHARS") ?? remoteAutonomyNode.vision_context_max_chars, 65536))),
        ideationBudgetMs: Math.max(1000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_IDEATION_BUDGET_MS") ?? remoteAutonomyNode.ideation_budget_ms, 20000)),
        llmTimeoutMs: Math.max(1000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_LLM_TIMEOUT_MS") ?? remoteAutonomyNode.llm_timeout_ms, 12000)),
        allowDirtyWorktree: parseBoolEnv("REMOTEBUDDY_AUTONOMY_ALLOW_DIRTY_WORKTREE") ?? asBoolean(remoteAutonomyNode.allow_dirty_worktree, false),
        ideationMaxCandidates: Math.max(1, Math.min(100, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_IDEATION_MAX_CANDIDATES") ?? remoteAutonomyNode.ideation_max_candidates, 20))),
        topK: Math.max(1, Math.min(20, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_TOP_K") ?? remoteAutonomyNode.top_k, 3))),
        exploreRate: Math.max(0, Math.min(1, (() => {
          const parsed = Number.parseFloat(String(firstNonEmpty(process.env.REMOTEBUDDY_AUTONOMY_EXPLORE_RATE, asString(remoteAutonomyNode.explore_rate, "0.3"), "0.3")));
          return Number.isFinite(parsed) ? parsed : 0.3;
        })())),
        minConfidence: Math.max(0, Math.min(1, (() => {
          const parsed = Number.parseFloat(String(firstNonEmpty(process.env.REMOTEBUDDY_AUTONOMY_MIN_CONFIDENCE, asString(remoteAutonomyNode.min_confidence, "0.65"), "0.65")));
          return Number.isFinite(parsed) ? parsed : 0.65;
        })())),
        maxConcurrentObjectives: Math.max(1, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_MAX_CONCURRENT_OBJECTIVES") ?? remoteAutonomyNode.max_concurrent_objectives, 2)),
        maxDispatchPerHour: Math.max(1, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_MAX_DISPATCH_PER_HOUR") ?? remoteAutonomyNode.max_dispatch_per_hour, 6)),
        maxDispatchPerHourByType: remoteAutonomyDispatchByType,
        maxDispatchPerHourByComponent: remoteAutonomyDispatchByComponent,
        maxTokenUsagePerHour: Math.max(0, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_MAX_TOKEN_USAGE_PER_HOUR") ?? remoteAutonomyNode.max_token_usage_per_hour, 0)),
        maxRuntimeMsPerHour: Math.max(0, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_MAX_RUNTIME_MS_PER_HOUR") ?? remoteAutonomyNode.max_runtime_ms_per_hour, 0)),
        cooldownFailStreakThreshold: Math.max(1, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_COOLDOWN_FAIL_STREAK_THRESHOLD") ?? remoteAutonomyNode.cooldown_fail_streak_threshold, 2)),
        cooldownMs: Math.max(1000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_COOLDOWN_MS") ?? remoteAutonomyNode.cooldown_ms, 1800000)),
        staleObjectiveTtlMs: Math.max(60000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_STALE_OBJECTIVE_TTL_MS") ?? remoteAutonomyNode.stale_objective_ttl_ms, 2700000)),
        staleObjectiveSweepIntervalMs: Math.max(5000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_STALE_OBJECTIVE_SWEEP_INTERVAL_MS") ?? remoteAutonomyNode.stale_objective_sweep_interval_ms, 60000)),
        autoFreezeFailStreakThreshold: Math.max(1, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_AUTO_FREEZE_FAIL_STREAK_THRESHOLD") ?? remoteAutonomyNode.auto_freeze_fail_streak_threshold, 3)),
        autoFreezeDurationMs: Math.max(60000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_AUTO_FREEZE_DURATION_MS") ?? remoteAutonomyNode.auto_freeze_duration_ms, 1800000)),
        evaluatorWindowHours: Math.max(1, Math.min(168, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_EVALUATOR_WINDOW_HOURS") ?? remoteAutonomyNode.evaluator_window_hours, 24))),
        evaluatorMinSamples: Math.max(1, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_EVALUATOR_MIN_SAMPLES") ?? remoteAutonomyNode.evaluator_min_samples, 6)),
        evaluatorMinSuccessRate: Math.max(0, Math.min(1, (() => {
          const parsed = Number.parseFloat(String(firstNonEmpty(process.env.REMOTEBUDDY_AUTONOMY_EVALUATOR_MIN_SUCCESS_RATE, asString(remoteAutonomyNode.evaluator_min_success_rate, "0.45"), "0.45")));
          return Number.isFinite(parsed) ? parsed : 0.45;
        })())),
        evaluatorMaxRegretRate: Math.max(0, Math.min(1, (() => {
          const parsed = Number.parseFloat(String(firstNonEmpty(process.env.REMOTEBUDDY_AUTONOMY_EVALUATOR_MAX_REGRET_RATE, asString(remoteAutonomyNode.evaluator_max_regret_rate, "0.35"), "0.35")));
          return Number.isFinite(parsed) ? parsed : 0.35;
        })())),
        evaluatorRunIntervalMs: Math.max(1e4, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_EVALUATOR_RUN_INTERVAL_MS") ?? remoteAutonomyNode.evaluator_run_interval_ms, 120000)),
        alertQueuePendingThreshold: Math.max(1, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_ALERT_QUEUE_PENDING_THRESHOLD") ?? remoteAutonomyNode.alert_queue_pending_threshold, 20)),
        alertJobFailureRateThreshold: Math.max(0, Math.min(1, (() => {
          const parsed = Number.parseFloat(String(firstNonEmpty(process.env.REMOTEBUDDY_AUTONOMY_ALERT_JOB_FAILURE_RATE_THRESHOLD, asString(remoteAutonomyNode.alert_job_failure_rate_threshold, "0.3"), "0.3")));
          return Number.isFinite(parsed) ? parsed : 0.3;
        })())),
        alertAutonomyFailureRateThreshold: Math.max(0, Math.min(1, (() => {
          const parsed = Number.parseFloat(String(firstNonEmpty(process.env.REMOTEBUDDY_AUTONOMY_ALERT_AUTONOMY_FAILURE_RATE_THRESHOLD, asString(remoteAutonomyNode.alert_autonomy_failure_rate_threshold, "0.45"), "0.45")));
          return Number.isFinite(parsed) ? parsed : 0.45;
        })())),
        allowReadAnywhere: parseBoolEnv("REMOTEBUDDY_AUTONOMY_ALLOW_READ_ANYWHERE") ?? asBoolean(remoteAutonomyNode.allow_read_anywhere, true),
        prFeedbackCommentRows: Math.max(1, Math.min(200, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_PR_FEEDBACK_COMMENT_ROWS") ?? remoteAutonomyNode.pr_feedback_comment_rows, 16))),
        prFeedbackCommentChars: Math.max(32, Math.min(20000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_PR_FEEDBACK_COMMENT_CHARS") ?? remoteAutonomyNode.pr_feedback_comment_chars, 600))),
        prFeedbackSummaryChars: Math.max(32, Math.min(20000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_PR_FEEDBACK_SUMMARY_CHARS") ?? remoteAutonomyNode.pr_feedback_summary_chars, 600))),
        questionTtlMs: Math.max(60000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_QUESTION_TTL_MS") ?? remoteAutonomyNode.question_ttl_ms, 259200000)),
        policyVersion: firstNonEmpty(process.env.REMOTEBUDDY_AUTONOMY_POLICY_VERSION, asString(remoteAutonomyNode.policy_version, "policy-v3.3"), "policy-v3.3"),
        impactModelVersion: firstNonEmpty(process.env.REMOTEBUDDY_AUTONOMY_IMPACT_MODEL_VERSION, asString(remoteAutonomyNode.impact_model_version, "impact-v1"), "impact-v1"),
        replay: {
          storePromptPayloads: parseBoolEnv("REMOTEBUDDY_AUTONOMY_REPLAY_STORE_PROMPT_PAYLOADS") ?? asBoolean(remoteAutonomyReplayNode.store_prompt_payloads, false),
          maxRunsWithPayloads: Math.max(0, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_REPLAY_MAX_RUNS_WITH_PAYLOADS") ?? remoteAutonomyReplayNode.max_runs_with_payloads, 50)),
          maxPayloadBytes: Math.max(1024, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_REPLAY_MAX_PAYLOAD_BYTES") ?? remoteAutonomyReplayNode.max_payload_bytes, 262144))
        }
      },
      llm: remoteLlm
    },
    workerpals: {
      pollMs: workerPollMs,
      heartbeatMs: workerHeartbeatMs,
      executionPlatform: workerExecutionPlatform,
      executor: workerExecutor,
      openhandsPython: workerOpenHandsPython,
      openhandsTimeoutMs: workerOpenHandsTimeoutMs,
      miniswePython: workerMiniswePython,
      minisweTimeoutMs: workerMinisweTimeoutMs,
      openaiCodexPython: workerOpenAICodexPython,
      openaiCodexTimeoutMs: workerOpenAICodexTimeoutMs,
      openhandsStuckGuardEnabled: workerOpenHandsStuckGuardEnabled,
      openhandsStuckGuardExploreLimit: workerOpenHandsStuckGuardExploreLimit,
      openhandsStuckGuardMinElapsedMs: workerOpenHandsStuckGuardMinElapsedMs,
      openhandsStuckGuardBroadScanLimit: workerOpenHandsStuckGuardBroadScanLimit,
      openhandsStuckGuardNoProgressMaxMs: workerOpenHandsStuckGuardNoProgressMaxMs,
      openhandsAutoSteerEnabled: workerOpenHandsAutoSteerEnabled,
      openhandsAutoSteerInitialDelaySec: workerOpenHandsAutoSteerInitialDelaySec,
      openhandsAutoSteerIntervalSec: workerOpenHandsAutoSteerIntervalSec,
      openhandsAutoSteerMaxNudges: workerOpenHandsAutoSteerMaxNudges,
      requirePush: workerRequirePush,
      pushAgentBranch: workerPushAgentBranch,
      requireDocker: effectiveWorkerRequireDocker,
      skipDockerSelfCheck: workerSkipDockerSelfCheck,
      dockerImage: firstNonEmpty(process.env.WORKERPALS_DOCKER_IMAGE, asString(workerNode.docker_image, "pushpals-worker-sandbox:latest"), "pushpals-worker-sandbox:latest"),
      dockerTimeoutMs: Math.max(1e4, asInt(parseIntEnv("WORKERPALS_DOCKER_TIMEOUT_MS") ?? workerNode.docker_timeout_ms, 7260000)),
      dockerIdleTimeoutMs: Math.max(0, asInt(parseIntEnv("WORKERPALS_DOCKER_IDLE_TIMEOUT_MS") ?? workerNode.docker_idle_timeout_ms, 600000)),
      dockerAgentStartupTimeoutMs: workerDockerAgentStartupTimeoutMs,
      dockerWarmMaxAttempts: workerDockerWarmMaxAttempts,
      dockerWarmRetryBackoffMs: workerDockerWarmRetryBackoffMs,
      dockerJobMaxAttempts: workerDockerJobMaxAttempts,
      dockerJobRetryBackoffMs: workerDockerJobRetryBackoffMs,
      dockerWarmMemoryMb: workerDockerWarmMemoryMb,
      dockerWarmCpus: workerDockerWarmCpus,
      fileModifyingJobs: workerFileModifyingJobs,
      outputMaxChars: workerOutputMaxChars,
      outputMaxLines: workerOutputMaxLines,
      outputMaxHeadLines: workerOutputMaxHeadLines,
      qualityMaxAutoRevisions: workerQualityMaxAutoRevisions,
      qualityValidationMaxAutoRevisions: workerQualityValidationMaxAutoRevisions,
      qualityScopeGateEnabled: workerQualityScopeGateEnabled,
      qualityValidationGateEnabled: workerQualityValidationGateEnabled,
      qualityCriticGateEnabled: workerQualityCriticGateEnabled,
      qualityPublishGateEnabled: workerQualityPublishGateEnabled,
      qualityValidationStepTimeoutMs: workerQualityValidationStepTimeoutMs,
      qualityCriticTimeoutMs: workerQualityCriticTimeoutMs,
      qualityCriticTimeoutBehavior: workerQualityCriticTimeoutBehavior,
      qualitySoftPassOnExhausted: workerQualitySoftPassOnExhausted,
      qualityCriticMinScore: workerQualityCriticMinScore,
      qualityCriticModel: workerQualityCriticModel,
      qualityCriticMaxDiffChars: workerQualityCriticMaxDiffChars,
      qualityCriticMaxValidationOutputChars: workerQualityCriticMaxValidationOutputChars,
      executorResultPrefix: workerExecutorResultPrefix,
      dockerNetworkMode: asString(process.env.WORKERPALS_DOCKER_NETWORK_MODE ?? workerNode.docker_network_mode, "bridge"),
      baseRef: firstNonEmpty(process.env.WORKERPALS_BASE_REF, asString(workerNode.base_ref, "origin/main_agents"), "origin/main_agents"),
      labels: firstNonEmpty(process.env.WORKERPALS_LABELS) ? firstNonEmpty(process.env.WORKERPALS_LABELS).split(",").map((value) => value.trim()).filter(Boolean) : asStringArray(workerNode.labels),
      failureCooldownMs: Math.max(0, asInt(parseIntEnv("WORKERPALS_FAILURE_COOLDOWN_MS") ?? parseIntEnv("WORKERPALS_DOCKER_FAILURE_COOLDOWN_MS") ?? workerNode.failure_cooldown_ms, 20000)),
      llm: workerLlm
    },
    sourceControlManager: {
      repoPath: scmRepoPath,
      remote: scmRemote,
      mainBranch: scmMainBranch,
      baseBranch: scmBaseBranch,
      branchPrefix: scmBranchPrefix,
      pollIntervalSeconds: scmPollIntervalSeconds,
      checks: scmChecks,
      stateDir: scmStateDir,
      port: scmPort,
      deleteAfterMerge: scmDeleteAfterMerge,
      maxAttempts: scmMaxAttempts,
      mergeStrategy: scmMergeStrategy,
      pushMainAfterMerge: scmPushMainAfterMerge,
      openPrAfterPush: scmOpenPrAfterPush,
      prBaseBranch: scmPrBaseBranch,
      prTitle: scmPrTitle || null,
      prBody: scmPrBody || null,
      prDraft: scmPrDraft,
      statusHeartbeatMs: scmStatusHeartbeatMs,
      skipCleanCheck: scmSkipCleanCheck,
      autoCreateMainBranch: scmAutoCreateMainBranch,
      reviewAgent: {
        enabled: scmReviewAgentEnabled,
        pollIntervalMs: scmReviewAgentPollIntervalMs,
        reviewerMdPath: scmReviewAgentReviewerMdPath,
        passThreshold: scmReviewAgentPassThreshold,
        maxPrCommentsBeforeGiveUp: scmReviewAgentMaxPrCommentsBeforeGiveUp,
        mergeMethod: scmReviewAgentMergeMethod,
        codexBin: scmReviewAgentCodexBin,
        codexAuthMode: scmReviewAgentCodexAuthMode,
        codexHomeDir: scmReviewAgentCodexHomeDir,
        codexTimeoutMs: scmReviewAgentCodexTimeoutMs
      }
    },
    startup: {
      workerImageRebuild: startupWorkerImageRebuild,
      logConfigOnStart: startupLogConfigOnStart,
      syncIntegrationWithMain: startupSyncIntegrationWithMain,
      skipLlmPreflight: startupSkipLlmPreflight,
      autoStartLmStudio: startupAutoStartLmStudio,
      lmStudioReadyTimeoutMs: startupLmStudioReadyTimeoutMs,
      lmStudioCli: startupLmStudioCli,
      lmStudioPort: startupLmStudioPort,
      lmStudioStartArgs: startupLmStudioStartArgs,
      startupWarmup,
      startupWarmupTimeoutMs,
      startupWarmupPollMs,
      allowExternalClean: startupAllowExternalClean,
      portPreflight: startupPortPreflight,
      portConflictPolicy: startupPortConflictPolicy
    },
    client: {
      localAgentUrl: normalizeLoopbackHttpUrl(firstNonEmpty(process.env.EXPO_PUBLIC_LOCAL_AGENT_URL, asString(clientNode.local_agent_url, `http://127.0.0.1:${localPort}`), `http://127.0.0.1:${localPort}`), localPort),
      traceTailLines: Math.max(10, asInt(parseIntEnv("EXPO_PUBLIC_PUSHPALS_TRACE_TAIL_LINES") ?? clientNode.trace_tail_lines, 100))
    }
  };
  cachedConfig = config;
  cachedConfigKey = cacheKey;
  return config;
}
function sanitizeConfigString(value) {
  let out = String(value ?? "");
  if (!out)
    return out;
  out = out.replace(/(https?:\/\/)[^@\s/]+@/gi, "$1***@");
  out = out.replace(/https%3a\/\/[^@\s/]+@/gi, "https%3A//***@");
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._\-:+/=]+\b/gi, "$1***");
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "gh***");
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "github_pat_***");
  out = out.replace(/\bglpat-[A-Za-z0-9\-_]{20,}\b/gi, "glpat-***");
  out = out.replace(/\bsk-[A-Za-z0-9]{20,}\b/g, "sk-***");
  return out;
}
function sanitizeConfigValueForLogging(value, parentKey = "") {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value == null) {
    if (typeof value === "string") {
      if (SENSITIVE_CONFIG_KEY_PATTERN.test(parentKey)) {
        return value.trim() ? REDACTED_LOG_VALUE : "";
      }
      return sanitizeConfigString(value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeConfigValueForLogging(entry, parentKey));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = sanitizeConfigValueForLogging(entry, key);
    }
    return out;
  }
  return String(value);
}
function sanitizePushPalsConfigForLogging(value) {
  return sanitizeConfigValueForLogging(value);
}
// packages/shared/src/git_backend.ts
function trimToken(value) {
  return String(value ?? "").trim();
}
function sanitizeGitRemoteUrl(remoteUrl) {
  const raw = trimToken(remoteUrl);
  if (!raw)
    return "";
  return raw.replace(/^(https?:\/\/)[^@/]+@/i, "$1");
}
function parseGitRemoteHost(remoteUrl) {
  const raw = trimToken(remoteUrl);
  if (!raw)
    return "";
  const patterns = [
    /^https?:\/\/(?:[^@/]+@)?([^/:?#]+)(?::\d+)?(?:[/?#].*)?$/i,
    /^ssh:\/\/(?:[^@/]+@)?([^/:?#]+)(?::\d+)?(?:[/?#].*)?$/i,
    /^(?:[^@:\s]+@)?([^:/\s]+):[^?\s]+$/i
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const host = match?.[1] ? trimToken(match[1]) : "";
    if (host)
      return host.toLowerCase();
  }
  return "";
}
function inferGitBackendFromRemote(remoteUrl) {
  const host = parseGitRemoteHost(remoteUrl);
  if (!host)
    return "unknown";
  if (host === "github.com" || host.endsWith(".github.com") || host.includes("github")) {
    return "github";
  }
  if (host === "gitlab.com" || host.endsWith(".gitlab.com") || host.includes("gitlab")) {
    return "gitlab";
  }
  return "unknown";
}
function parseGitHubRepo(remoteUrl) {
  const sanitized = sanitizeGitRemoteUrl(remoteUrl);
  if (!sanitized)
    return null;
  const httpsMatch = sanitized.match(/^https?:\/\/(?:[^@/]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:[/?#].*)?$/i);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }
  const sshMatch = sanitized.match(/^(?:ssh:\/\/)?(?:[^@/\s]+@)?github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }
  return null;
}
function toGitHubRepoWebUrl(remoteUrl) {
  const repo = parseGitHubRepo(remoteUrl);
  if (!repo)
    return null;
  return `https://github.com/${repo.owner}/${repo.repo}`;
}
// packages/shared/src/tooling.ts
var KNOWN_TOOL_NAMES = new Set([
  "bun",
  "codex",
  "docker",
  "gh",
  "git",
  "node",
  "npm",
  "python",
  "shell"
]);
var DEFAULT_TOOL_REGISTRY = {
  fallbackKind: "discovered",
  adapters: [
    { tool: "git", kind: "known", executableHints: ["git"], defaultEffects: ["read", "write", "git"] },
    { tool: "codex", kind: "known", executableHints: ["codex", "bunx @openai/codex"], defaultEffects: ["read", "write", "network", "process"] },
    { tool: "bun", kind: "known", executableHints: ["bun"], defaultEffects: ["read", "write", "process"] },
    { tool: "docker", kind: "known", executableHints: ["docker"], defaultEffects: ["read", "write", "network", "process"] },
    { tool: "gh", kind: "known", executableHints: ["gh"], defaultEffects: ["read", "write", "network"] },
    { tool: "node", kind: "known", executableHints: ["node"], defaultEffects: ["read", "write", "process"] },
    { tool: "shell", kind: "shell", executableHints: ["sh", "bash", "cmd", "powershell"], defaultEffects: ["read", "write", "process"] }
  ]
};
var TOOL_RUN_TAIL_CHARS = 8000;
function cleanText(value) {
  return String(value ?? "").trim();
}
function basename(command) {
  const trimmed = command.trim();
  const withoutQuotes = trimmed.replace(/^["']|["']$/g, "");
  const parts = withoutQuotes.split(/[\\/]/);
  return parts[parts.length - 1] || withoutQuotes;
}
function truncateToolText(value, maxChars = TOOL_RUN_TAIL_CHARS) {
  const text = cleanText(value);
  if (!text)
    return "";
  if (text.length <= maxChars)
    return text;
  return `...[truncated]...
${text.slice(-maxChars)}`;
}
function redactToolText(value) {
  const text = cleanText(value);
  if (!text)
    return "";
  return text.replace(/\b(OPENAI_API_KEY|GITHUB_TOKEN|GH_TOKEN|PUSHPALS_AUTH_TOKEN)=([^\s]+)/gi, "$1=[redacted]").replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[redacted]").replace(/\b(ghp|github_pat)_[A-Za-z0-9_]{20,}/g, "[redacted-github-token]").replace(/\bsk-[A-Za-z0-9_-]{20,}/g, "[redacted-openai-key]");
}
function normalizeToolName(tool) {
  const raw = cleanText(tool).toLowerCase();
  if (!raw)
    return "shell";
  if (raw.includes("@openai/codex") || raw.includes("openai_codex"))
    return "codex";
  const name = basename(raw).replace(/\.(exe|cmd|bat|ps1)$/i, "");
  if (name === "bunx")
    return "bun";
  if (name === "python3")
    return "python";
  if (name === "pwsh" || name === "powershell" || name === "bash" || name === "sh" || name === "cmd") {
    return "shell";
  }
  return name || "shell";
}
function resolveToolKind(tool, registry = DEFAULT_TOOL_REGISTRY) {
  const normalized = normalizeToolName(tool);
  const adapter = registry.adapters.find((entry) => normalizeToolName(entry.tool) === normalized);
  if (adapter)
    return adapter.kind;
  return KNOWN_TOOL_NAMES.has(normalized) ? "known" : registry.fallbackKind;
}
function inferToolNameFromFailureText(input) {
  const explicit = normalizeToolName(input.tool);
  if (explicit !== "shell")
    return explicit;
  const argv = Array.isArray(input.argv) ? input.argv : [];
  const argvText = argv.join(" ");
  const text = [
    input.commandLine,
    argvText,
    input.summary,
    input.detail,
    input.stdout,
    input.stderr
  ].map((part) => cleanText(part).toLowerCase()).filter(Boolean).join(`
`);
  if (text.includes("failed to sync branch before push") || text.includes("tracked .codex path blocks branch sync") || text.includes("untracked working tree files would be overwritten") || text.includes("git pull --rebase") || text.includes("could not detach head") || text.includes("could not apply")) {
    return "git";
  }
  if (text.includes("@openai/codex") || text.includes("openai_codex") || /\bcodex\b/.test(text)) {
    return "codex";
  }
  if (/\bgit\b/.test(text) || /\b(rebase|cherry-pick|checkout|merge conflict)\b/.test(text)) {
    return "git";
  }
  if (/\bdocker\b/.test(text) || text.includes("docker_engine"))
    return "docker";
  if (/\bgh\b/.test(text) || text.includes("github api"))
    return "gh";
  if (/\bbun\b/.test(text))
    return "bun";
  if (/\bnode\b/.test(text))
    return "node";
  return "shell";
}
function combinedFailureText(input) {
  return [
    input.tool,
    input.argv?.join(" "),
    input.commandLine,
    input.summary,
    input.detail,
    input.stdout,
    input.stderr
  ].map(cleanText).filter(Boolean).join(`
`);
}
function hasNodeEnvRuntimeFailure(text) {
  return /env:\s*[`'"\u2018\u2019\u201c\u201d]?node[`'"\u2018\u2019\u201c\u201d]?:?\s+no such file or directory/i.test(text) || /\bnode:\s+not found\b/i.test(text) || /\bnode\.exe.*not found\b/i.test(text);
}
function classifyToolFailure(input) {
  const tool = inferToolNameFromFailureText(input);
  const text = combinedFailureText(input);
  const lower = text.toLowerCase();
  if (input.timedOut || lower.includes("timed out") || lower.includes("timeout")) {
    return {
      failureClass: "timeout",
      retryable: true,
      remediation: "Retry with a larger tool budget or reduce the command scope."
    };
  }
  if (hasNodeEnvRuntimeFailure(text)) {
    return {
      failureClass: "missing_runtime",
      retryable: false,
      remediation: tool === "codex" ? "Codex was invoked through a launcher that requires node, but node is absent in this environment. Use a Bun-backed Codex launcher or install node in the sandbox image." : "Install the missing node runtime or invoke the tool through a runtime available in this environment."
    };
  }
  if (lower.includes("requires a newer version of codex") || lower.includes("requires newer") && lower.includes("codex")) {
    return {
      failureClass: "missing_runtime",
      retryable: false,
      remediation: "Upgrade the Codex CLI/runtime used by PushPals before retrying this model."
    };
  }
  if (lower.includes("docker_engine") || lower.includes("cannot connect to the docker daemon") || lower.includes("docker daemon is not running") || lower.includes("failed to connect to the docker api") && lower.includes("docker")) {
    return {
      failureClass: "missing_runtime",
      retryable: false,
      remediation: "Start Docker Desktop/the Docker daemon, then retry the Docker-backed operation."
    };
  }
  if (lower.includes("command-router") || lower.includes("policy rejection") || lower.includes("policy denied") || lower.includes("disallowed command") || lower.includes("command policy")) {
    return {
      failureClass: "policy_denied",
      retryable: false,
      remediation: "Adjust the tool invocation to comply with the configured command policy."
    };
  }
  if (lower.includes("login is required") || lower.includes("not logged in") || lower.includes("authentication") || lower.includes("unauthorized") || lower.includes("invalid api key") || lower.includes("api_key auth requires")) {
    return {
      failureClass: "auth",
      retryable: false,
      remediation: `Authenticate ${tool} or provide the required token before retrying.`
    };
  }
  if (lower.includes("econnrefused") || lower.includes("enotfound") || lower.includes("etimedout") || lower.includes("failed to connect") || lower.includes("connection reset") || lower.includes("network is unreachable")) {
    return {
      failureClass: "network",
      retryable: true,
      remediation: "Retry after the dependent service or network path is available."
    };
  }
  if (lower.includes("read-only file system") || lower.includes("mounted read-only") || lower.includes("operation not permitted") || lower.includes("permission denied") || lower.includes("eacces") || lower.includes("eperm")) {
    const sandboxMount = lower.includes("read-only") || lower.includes("mounted");
    return {
      failureClass: sandboxMount ? "sandbox_mount" : "permission",
      retryable: false,
      remediation: sandboxMount ? "Remount the sandbox/worktree with writable metadata or move mutable tool state outside the read-only mount." : "Fix filesystem or process permissions before retrying."
    };
  }
  if (lower.includes("rebase in progress") || lower.includes("merge conflict") || lower.includes("tracked .codex path blocks branch sync") || lower.includes("untracked working tree files would be overwritten") || lower.includes("could not apply") || lower.includes("please move or remove them before you switch branches")) {
    return {
      failureClass: "repo_state",
      retryable: false,
      remediation: "Resolve the repository state conflict before retrying the same publish/sync step."
    };
  }
  if (lower.includes("command not found") || lower.includes("not recognized as an internal or external command") || lower.includes("neither bunx nor codex was found") || lower.includes("no such file or directory")) {
    return {
      failureClass: "missing_binary",
      retryable: false,
      remediation: `Install ${tool} or configure its executable path before retrying.`
    };
  }
  if (typeof input.exitCode === "number" && input.exitCode !== 0) {
    return {
      failureClass: "nonzero_exit",
      retryable: false,
      remediation: `Inspect ${tool} stdout/stderr and fix the command-specific failure before retrying.`
    };
  }
  return {
    failureClass: "unknown",
    retryable: false,
    remediation: "Inspect the tool output and add a classifier if this failure mode recurs."
  };
}
// packages/shared/src/toolchain.ts
var SHELL_CONTROL_TOKENS = new Set(["|", "||", "&", "&&", ";", ">", ">>", "<", "<<"]);
var NODE_BACKED_CLI_NAMES = new Set([
  "astro",
  "babel",
  "cypress",
  "eslint",
  "expo",
  "jest",
  "metro",
  "next",
  "nuxt",
  "playwright",
  "react-native",
  "rollup",
  "tsc",
  "tsx",
  "vite",
  "vitest",
  "webpack"
]);
var BUN_OPTIONS_WITH_VALUE = new Set(["--cwd", "-C"]);
var PACKAGE_MANAGER_OPTIONS_WITH_VALUE = new Set([
  "--cwd",
  "--dir",
  "--filter",
  "--prefix",
  "--workspace",
  "-C",
  "-F"
]);
// packages/shared/src/trusted_validation.ts
var MAX_TRUSTED_VALIDATION_COMMANDS = 8;
var MAX_TRUSTED_VALIDATION_COMMAND_LENGTH = 1000;
var TRUSTED_VALIDATION_EXECUTABLES = new Set([
  "bun",
  "bunx",
  "cargo",
  "coverage",
  "deno",
  "docker",
  "docker-compose",
  "eslint",
  "go",
  "jest",
  "make",
  "mypy",
  "node",
  "npm",
  "npx",
  "pnpm",
  "pytest",
  "python",
  "python3",
  "ruff",
  "tsc",
  "uv",
  "vitest",
  "yarn"
]);
function tokenizeTrustedValidationCommand(command) {
  const trimmed = String(command ?? "").trim();
  if (!trimmed || trimmed.length > MAX_TRUSTED_VALIDATION_COMMAND_LENGTH)
    return null;
  const argv = [];
  let current = "";
  let quote = null;
  let escaped = false;
  const pushCurrent = () => {
    if (!current)
      return;
    argv.push(current);
    current = "";
  };
  for (const ch of trimmed) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (quote) {
      if (quote === '"' && ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "`" || ch === `
` || ch === "\r") {
      return null;
    }
    current += ch;
  }
  if (escaped || quote)
    return null;
  pushCurrent();
  if (argv.length === 0)
    return null;
  if (argv.some((entry) => entry.includes("$(") || entry.includes("${")))
    return null;
  if (argv[0].includes("/") || argv[0].includes("\\"))
    return null;
  const executable = argv[0].toLowerCase();
  if (!TRUSTED_VALIDATION_EXECUTABLES.has(executable))
    return null;
  const firstArg = argv[1]?.toLowerCase() ?? "";
  if (["bun", "deno", "node"].includes(executable) && ["-e", "--eval"].includes(firstArg) || ["python", "python3"].includes(executable) && firstArg === "-c") {
    return null;
  }
  return argv;
}
function normalizeTrustedValidationCommands(value) {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return { ok: false, message: "trusted validation commands must be a JSON array" };
    }
  }
  if (!Array.isArray(candidate) || candidate.length === 0) {
    return { ok: false, message: "trusted validation commands must be a non-empty array" };
  }
  if (candidate.length > MAX_TRUSTED_VALIDATION_COMMANDS) {
    return {
      ok: false,
      message: `trusted validation is limited to ${MAX_TRUSTED_VALIDATION_COMMANDS} commands`
    };
  }
  const commands = [];
  const seen = new Set;
  for (const entry of candidate) {
    if (typeof entry !== "string") {
      return { ok: false, message: "trusted validation commands must contain only strings" };
    }
    const command = entry.trim();
    if (!tokenizeTrustedValidationCommand(command)) {
      return { ok: false, message: `unsafe or unsupported trusted validation command: ${command}` };
    }
    const key = command.replace(/\s+/g, " ").toLowerCase();
    if (seen.has(key))
      continue;
    seen.add(key);
    commands.push(command);
  }
  return commands.length > 0 ? { ok: true, commands } : { ok: false, message: "trusted validation commands must be a non-empty array" };
}
// packages/shared/src/session_event_visibility.ts
var ALWAYS_VISIBLE_EVENT_TYPES = new Set(["question_asked"]);
// packages/shared/src/localbuddy_runtime.ts
var TRUTHY2 = new Set(["1", "true", "yes", "on"]);
var FALSY2 = new Set(["0", "false", "no", "off"]);
// apps/server/src/jobs.ts
var JOB_PRIORITY_QUEUE_SLA_MS = {
  interactive: 20000,
  normal: 90000,
  background: 240000
};
var JOB_EXECUTION_BUDGET_MS = {
  interactive: 300000,
  normal: 900000,
  background: 1200000
};
var JOB_FINALIZATION_BUDGET_MS_DEFAULT = 120000;
var PR_WORKER_ASSIGNMENT_MAX_AGE_MS = 120000;
var ORPHANED_CLAIM_HEARTBEAT_GRACE_MS = 15000;
var RETRY_SAFE_REQUEUE_DELAY_MS = 5000;
function parseObjectJson(value) {
  if (!value)
    return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    return parsed;
  } catch {
    return {};
  }
}
function parseStringArrayJson(value) {
  if (!value)
    return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed))
      return [];
    return parsed.map((entry) => String(entry ?? "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}
function parseToolEffectsJson(value) {
  const allowed = new Set(["read", "write", "network", "git", "process"]);
  return parseStringArrayJson(value).filter((entry) => allowed.has(entry));
}
var TOOL_FAILURE_CLASSES = [
  "missing_binary",
  "missing_runtime",
  "auth",
  "network",
  "permission",
  "policy_denied",
  "timeout",
  "nonzero_exit",
  "repo_state",
  "sandbox_mount",
  "unknown"
];
function normalizeToolFailureClass(value) {
  const text = String(value ?? "").trim();
  return TOOL_FAILURE_CLASSES.includes(text) ? text : null;
}
function shouldAcceptClientToolFailureClass(serverClass, clientClass) {
  if (!clientClass)
    return false;
  return !serverClass || serverClass === "unknown" || serverClass === "nonzero_exit";
}
function compactDbText(value, maxChars) {
  const text = String(value ?? "").trim();
  if (!text)
    return null;
  if (text.length <= maxChars)
    return text;
  return text.slice(0, maxChars);
}
function boolFromUnknown(value) {
  if (typeof value === "boolean")
    return value;
  if (typeof value === "number")
    return value !== 0;
  const text = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(text);
}
function sanitizeToolRunMetadata(value, depth = 0) {
  if (value == null)
    return null;
  if (typeof value === "string")
    return compactDbText(redactToolText(value), 1000) ?? "";
  if (typeof value === "number")
    return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean")
    return value;
  if (depth >= 4)
    return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => sanitizeToolRunMetadata(entry, depth + 1));
  }
  if (typeof value !== "object")
    return String(value);
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 100)) {
    const key = compactDbText(rawKey, 120);
    if (!key)
      continue;
    out[key] = sanitizeToolRunMetadata(rawValue, depth + 1);
  }
  return out;
}
var MAX_JOB_DIAGNOSTIC_ATTEMPTS = 8;
var MAX_JOB_DIAGNOSTIC_PHASE_SPANS = 32;
var MAX_JOB_DIAGNOSTIC_VALIDATION_RUNS = 20;
var MAX_JOB_DIAGNOSTIC_PATCH_SNAPSHOTS = 20;
var MAX_JOB_DIAGNOSTIC_PATH_SAMPLE = 50;
function recordFromUnknown(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return null;
  return value;
}
function arrayFromUnknown(value) {
  return Array.isArray(value) ? value : [];
}
function boundedDbInt(value, max = Number.MAX_SAFE_INTEGER) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(parsed))
    return null;
  return Math.max(0, Math.min(Math.floor(parsed), max));
}
function diagnosticText(value, maxChars) {
  return compactDbText(redactToolText(value), maxChars);
}
function diagnosticMetadataJson(value) {
  const sanitized = sanitizeToolRunMetadata(value ?? {});
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized))
    return "{}";
  return JSON.stringify(sanitized);
}
function diagnosticStringArrayJson(value, limit = MAX_JOB_DIAGNOSTIC_PATH_SAMPLE) {
  const values = arrayFromUnknown(value).map((entry) => diagnosticText(entry, 240)).filter((entry) => Boolean(entry)).slice(0, limit);
  return JSON.stringify(values);
}
function diagnosticIso(value) {
  return coerceIsoTimestamp(value);
}
function parseJsonArray(value) {
  if (!value)
    return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function stringArrayFromUnknown(value) {
  if (!Array.isArray(value))
    return [];
  return value.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0);
}
function normalizedJobPath(value) {
  return String(value ?? "").trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "").toLowerCase();
}
function normalizedJobPathList(value) {
  const out = [];
  const seen = new Set;
  for (const entry of stringArrayFromUnknown(value)) {
    const normalized = normalizedJobPath(entry);
    if (!normalized || normalized === "." || seen.has(normalized))
      continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}
function normalizedJobPathValues(...values) {
  const out = new Set;
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const path2 of normalizedJobPathList(value))
        out.add(path2);
      continue;
    }
    const path = normalizedJobPath(value);
    if (path && path !== ".")
      out.add(path);
  }
  return [...out];
}
function jobPathOverlaps(left, right) {
  for (const a of left) {
    for (const b of right) {
      if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`))
        return true;
    }
  }
  return false;
}
function overlappingFailureTargetPaths(currentPaths, previousPaths) {
  const overlapping = new Set;
  for (const current of currentPaths) {
    for (const previous of previousPaths) {
      if (current === previous || current.startsWith(`${previous}/`) || previous.startsWith(`${current}/`)) {
        overlapping.add(current.length >= previous.length ? current : previous);
      }
    }
  }
  return [...overlapping].sort();
}
function normalizeFailureCommand(value) {
  return String(value ?? "").trim().replace(/\\/g, "/").replace(/\s+/g, " ").toLowerCase().slice(0, 1000);
}
function jobFailureText(value) {
  const raw = String(value ?? "");
  if (!raw.trim())
    return "";
  try {
    const parsed = JSON.parse(raw);
    return [parsed.message, parsed.detail, parsed.error].map((part) => String(part ?? "")).filter(Boolean).join(`
`);
  } catch {
    return raw;
  }
}
function nestedFailureCommand(value) {
  const text = jobFailureText(value);
  const scriptMatches = [
    ...text.matchAll(/error:\s*script\s+"([^"]+)"\s+(?:exited|was terminated)/gi)
  ];
  const nestedScript = scriptMatches.at(-1)?.[1]?.trim();
  if (nestedScript)
    return normalizeFailureCommand(`bun run ${nestedScript}`);
  const unchanged = text.match(/validation failed unchanged after two attempts for "([^"]+)"/i)?.[1];
  if (unchanged)
    return normalizeFailureCommand(unchanged);
  const required = text.match(/required vision\.md validation (?:failed|blocked publishing)[^:\r\n]*:\s*([^\r\n;]+?)(?:\s+exited\b|;|$)/i)?.[1];
  return normalizeFailureCommand(required);
}
function failureClassFromEvidence(value) {
  const text = jobFailureText(value).toLowerCase();
  if (!text)
    return null;
  if (/\/var\/run\/docker\.sock|docker daemon|operation not permitted|permission denied|read-only file system|\beacces\b|\beperm\b/.test(text)) {
    return "environment";
  }
  return null;
}
function nestedFailedTestSample(value) {
  const text = jobFailureText(value);
  const samples = new Set;
  for (const match of text.matchAll(/error:\s*script\s+"([^"]+)"\s+(?:exited|was terminated)/gi)) {
    const script = String(match[1] ?? "").trim().toLowerCase();
    if (script)
      samples.add(`script:${script}`);
  }
  return [...samples].sort();
}
function extractFailedTestSample(...values) {
  const text = values.map((value) => String(value ?? "")).join(`
`);
  const samples = new Set;
  for (const match of text.matchAll(/(?:\(fail\)|\bfail(?:ed)?\b|[\u00D7\u2717])\s*[:>-]?\s*([^\r\n]{3,240})/gi)) {
    const normalized = String(match[1] ?? "").replace(/\s+\[[\d.]+\s*(?:ms|s)\]\s*$/i, "").replace(/\s+/g, " ").trim().toLowerCase();
    if (normalized)
      samples.add(normalized);
    if (samples.size >= 8)
      break;
  }
  if (samples.size < 8) {
    for (const match of text.matchAll(/(?:^|[\s("'`])([a-z0-9_./-]+\.(?:test|spec)\.[cm]?[jt]sx?)(?=$|[\s:)"'`])/gim)) {
      samples.add(String(match[1] ?? "").replace(/\\/g, "/").toLowerCase());
      if (samples.size >= 8)
        break;
    }
  }
  return [...samples].sort();
}
function failureFingerprint(parts) {
  return createHash2("sha256").update(JSON.stringify({
    targetPaths: [...parts.targetPaths].sort(),
    failureClass: parts.failureClass,
    command: parts.command,
    failedTests: parts.failedTests
  })).digest("hex").slice(0, 24);
}
function normalizeWorkerStatus(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "busy" || text === "error" || text === "offline") {
    return text;
  }
  return "idle";
}
function normalizeJobPriority(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "interactive" || text === "background")
    return text;
  return "normal";
}
function parseBudgetMs(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0)
    return fallback;
  return Math.max(1000, parsed);
}
function parseDedupeCooldownMs(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 0)
    return fallback;
  return Math.max(0, Math.min(parsed, 24 * 60 * 60 * 1000));
}
function parseIsoMs(value) {
  if (!value)
    return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
function coerceIsoTimestamp(value) {
  if (typeof value !== "string")
    return null;
  const trimmed = value.trim();
  if (!trimmed)
    return null;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms))
    return null;
  return new Date(ms).toISOString();
}
function percentile(values, p) {
  if (values.length === 0)
    return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1));
  const value = sorted[rank];
  return Number.isFinite(value) ? value : null;
}
function summarizeSamples(samples) {
  const valid = samples.filter((value) => Number.isFinite(value) && value >= 0);
  if (valid.length === 0)
    return { p50: null, p95: null, avg: null, sampleSize: 0 };
  const avg = Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length);
  return {
    p50: percentile(valid, 50),
    p95: percentile(valid, 95),
    avg: Number.isFinite(avg) ? avg : null,
    sampleSize: valid.length
  };
}
function isTimeoutFailureError(errorPayload) {
  if (!errorPayload)
    return false;
  let haystack = errorPayload;
  try {
    const parsed = JSON.parse(errorPayload);
    if (parsed && typeof parsed === "object") {
      const record = parsed;
      haystack = `${String(record.message ?? "")} ${String(record.detail ?? "")}`.trim() || errorPayload;
    }
  } catch {}
  return /\b(timeout|timed out|deadline exceeded|stale worker claim|heartbeat stale|watchdog)\b/i.test(haystack);
}
function parseJobParamsRecord(value) {
  return parseObjectJson(value);
}
function extractResolutionType(params) {
  const direct = params.resolutionType;
  if (typeof direct === "string" && direct.trim())
    return direct.trim().toLowerCase();
  const reviewAgent = params.reviewAgent;
  if (reviewAgent && typeof reviewAgent === "object" && !Array.isArray(reviewAgent)) {
    const nested = reviewAgent.resolutionType;
    if (typeof nested === "string" && nested.trim())
      return nested.trim().toLowerCase();
  }
  return null;
}
function classifyJobRetrySafety(kind, params) {
  const explicit = String(params.retrySafety ?? "").trim().toLowerCase();
  if (explicit === "retry_safe" || explicit === "retry-safe" || explicit === "safe") {
    return {
      retrySafety: "retry_safe",
      reason: "params.retrySafety explicitly marked this job retry-safe"
    };
  }
  if (explicit === "manual_retry_required" || explicit === "manual-retry-required" || explicit === "unsafe" || explicit === "non_idempotent") {
    return {
      retrySafety: "manual_retry_required",
      reason: "params.retrySafety explicitly marked this job non-idempotent"
    };
  }
  if (kind === "warmup.execute") {
    return {
      retrySafety: "retry_safe",
      reason: "warmup.execute is side-effect free and safe to restart from scratch"
    };
  }
  if (kind === "task.execute") {
    const resolutionType = extractResolutionType(params);
    if (resolutionType === "merge_conflict") {
      return {
        retrySafety: "manual_retry_required",
        reason: "merge_conflict task.execute may rewrite rebase or branch state before abandonment"
      };
    }
    if (resolutionType === "review_fix") {
      return {
        retrySafety: "manual_retry_required",
        reason: "review_fix task.execute may create follow-up commit or PR side effects"
      };
    }
    return {
      retrySafety: "manual_retry_required",
      reason: "task.execute may mutate repository or publish side effects and is not auto-requeue safe"
    };
  }
  return {
    retrySafety: "manual_retry_required",
    reason: `${kind || "unknown"} is not classified as retry-safe`
  };
}
function buildResumeParams(params, recovery) {
  const next = { ...params };
  const rawHistory = Array.isArray(next.resumeHistory) ? next.resumeHistory : [];
  const history = rawHistory.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry)).slice(-7);
  history.push({
    previousJobId: recovery.previousJobId,
    previousWorkerId: recovery.previousWorkerId,
    recoveredAt: recovery.recoveredAt,
    reason: recovery.reason,
    detail: recovery.detail,
    retrySafety: recovery.retrySafety,
    classificationReason: recovery.classificationReason,
    attempt: recovery.attempt
  });
  next.resume = {
    strategy: "restart_after_abandonment",
    previousJobId: recovery.previousJobId,
    previousWorkerId: recovery.previousWorkerId,
    recoveredAt: recovery.recoveredAt,
    reason: recovery.reason,
    detail: recovery.detail,
    retrySafety: recovery.retrySafety,
    classificationReason: recovery.classificationReason,
    attempt: recovery.attempt
  };
  next.resumeHistory = history;
  return next;
}
function extractPlanningField(params, key) {
  if (!params || typeof params !== "object" || Array.isArray(params))
    return;
  const planning = params.planning;
  if (!planning || typeof planning !== "object" || Array.isArray(planning))
    return;
  return planning[key];
}
function normalizeDedupeKey(value) {
  if (typeof value !== "string")
    return null;
  const key = value.trim().toLowerCase();
  if (!key)
    return null;
  return key.slice(0, 512);
}
function normalizePrUrl(value) {
  if (typeof value !== "string")
    return null;
  const trimmed = value.trim();
  if (!trimmed)
    return null;
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/+$/, "").toLowerCase();
  } catch {
    return trimmed.replace(/\/+$/, "").toLowerCase();
  }
}
function normalizePrFeedbackVerdict(value) {
  return String(value ?? "").trim().toLowerCase();
}
function isMergedPrFeedbackVerdict(value) {
  const verdict = normalizePrFeedbackVerdict(value);
  if (!verdict)
    return false;
  if (verdict.includes("unmergeable") || verdict.includes("merge_conflict") || verdict.includes("merge_failed")) {
    return false;
  }
  return verdict.includes("merged");
}
function isClosedPrFeedbackVerdict(value) {
  const verdict = normalizePrFeedbackVerdict(value);
  if (!verdict)
    return false;
  if (isMergedPrFeedbackVerdict(verdict))
    return false;
  return verdict.includes("closed");
}
function extractReviewAgentPrUrl(params) {
  const reviewAgent = params.reviewAgent;
  if (!reviewAgent || typeof reviewAgent !== "object" || Array.isArray(reviewAgent))
    return null;
  return normalizePrUrl(reviewAgent.prUrl);
}
function resolveJobPrUrl(body, params) {
  return normalizePrUrl(body.prUrl) ?? extractReviewAgentPrUrl(params);
}

class JobQueue {
  db;
  constructor(dbPath = ":memory:") {
    this.db = new Database2(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this._migrate();
  }
  _migrate() {
    this.db.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          id                  TEXT PRIMARY KEY,
          taskId              TEXT NOT NULL,
          sessionId           TEXT NOT NULL DEFAULT '',
          kind                TEXT NOT NULL,
          params              TEXT NOT NULL DEFAULT '{}',
          dedupeKey           TEXT,
          dedupeCooldownMs    INTEGER NOT NULL DEFAULT 0,
          priority            TEXT NOT NULL DEFAULT 'normal',
          queueWaitBudgetMs   INTEGER NOT NULL DEFAULT 90000,
          executionBudgetMs   INTEGER NOT NULL DEFAULT 900000,
          finalizationBudgetMs INTEGER NOT NULL DEFAULT 120000,
          status              TEXT NOT NULL DEFAULT 'pending',
          workerId            TEXT,
          targetWorkerId      TEXT,
          result              TEXT,
          prUrl               TEXT,
          error               TEXT,
          availableAt         TEXT,
          enqueuedAt          TEXT,
          claimedAt           TEXT,
          startedAt           TEXT,
          firstLogAt          TEXT,
          failedAt            TEXT,
          abandonedAt         TEXT,
          publishBlockedAt    TEXT,
          completedAt         TEXT,
          durationMs          INTEGER,
          resumeOfJobId       TEXT,
          attempt             INTEGER NOT NULL DEFAULT 1,
          createdAt           TEXT NOT NULL,
          updatedAt           TEXT NOT NULL
        );

      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_taskId ON jobs(taskId);
      CREATE INDEX IF NOT EXISTS idx_jobs_session_created ON jobs(sessionId, createdAt);

      CREATE TABLE IF NOT EXISTS job_logs (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        jobId   TEXT NOT NULL,
        ts      TEXT NOT NULL,
        message TEXT NOT NULL,
        FOREIGN KEY (jobId) REFERENCES jobs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_job_logs_job_id ON job_logs(jobId, id);

      CREATE TABLE IF NOT EXISTS tool_runs (
        id                 TEXT PRIMARY KEY,
        jobId              TEXT,
        workerId           TEXT,
        sessionId          TEXT,
        phase              TEXT,
        tool               TEXT NOT NULL,
        kind               TEXT NOT NULL DEFAULT 'discovered',
        capability         TEXT,
        envProfile         TEXT,
        cwd                TEXT,
        argvJson           TEXT NOT NULL DEFAULT '[]',
        commandLine        TEXT,
        allowedEffectsJson TEXT NOT NULL DEFAULT '[]',
        ok                 INTEGER NOT NULL DEFAULT 0,
        exitCode           INTEGER,
        failureClass       TEXT,
        retryable          INTEGER NOT NULL DEFAULT 0,
        remediation        TEXT,
        startedAt          TEXT NOT NULL,
        finishedAt         TEXT NOT NULL,
        durationMs         INTEGER NOT NULL DEFAULT 0,
        stdoutTail         TEXT,
        stderrTail         TEXT,
        metadataJson       TEXT NOT NULL DEFAULT '{}',
        createdAt          TEXT NOT NULL,
        FOREIGN KEY (jobId) REFERENCES jobs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_tool_runs_job_id ON tool_runs(jobId, finishedAt);
      CREATE INDEX IF NOT EXISTS idx_tool_runs_tool ON tool_runs(tool, finishedAt);
      CREATE INDEX IF NOT EXISTS idx_tool_runs_failure_class ON tool_runs(failureClass, finishedAt);

      CREATE TABLE IF NOT EXISTS job_attempts (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        jobId          TEXT NOT NULL,
        attempt        INTEGER NOT NULL DEFAULT 1,
        workerId       TEXT,
        backend        TEXT,
        model          TEXT,
        startedAt      TEXT,
        finishedAt     TEXT,
        durationMs     INTEGER,
        terminalReason TEXT,
        exitCode       INTEGER,
        metadataJson   TEXT NOT NULL DEFAULT '{}',
        createdAt      TEXT NOT NULL,
        FOREIGN KEY (jobId) REFERENCES jobs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_job_attempts_job_id ON job_attempts(jobId, attempt);

      CREATE TABLE IF NOT EXISTS job_terminal_diagnostics (
        jobId                 TEXT PRIMARY KEY,
        status                TEXT NOT NULL,
        failureClass          TEXT,
        terminalStage         TEXT,
        executorBackend       TEXT,
        summary               TEXT,
        watchdogFired         INTEGER NOT NULL DEFAULT 0,
        timeoutMs             INTEGER,
        publishableFileCount  INTEGER,
        artifactOnlyPathCount INTEGER,
        changedPathSampleJson TEXT NOT NULL DEFAULT '[]',
        metadataJson          TEXT NOT NULL DEFAULT '{}',
        createdAt             TEXT NOT NULL,
        updatedAt             TEXT NOT NULL,
        FOREIGN KEY (jobId) REFERENCES jobs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_job_terminal_failure_class
        ON job_terminal_diagnostics(failureClass, updatedAt);

      CREATE TABLE IF NOT EXISTS job_phase_spans (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        jobId        TEXT NOT NULL,
        attempt      INTEGER,
        phase        TEXT NOT NULL,
        startedAt    TEXT NOT NULL,
        finishedAt   TEXT NOT NULL,
        durationMs   INTEGER NOT NULL DEFAULT 0,
        outcome      TEXT,
        metadataJson TEXT NOT NULL DEFAULT '{}',
        createdAt    TEXT NOT NULL,
        FOREIGN KEY (jobId) REFERENCES jobs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_job_phase_spans_job_id ON job_phase_spans(jobId, startedAt);
      CREATE INDEX IF NOT EXISTS idx_job_phase_spans_phase ON job_phase_spans(phase, startedAt);

      CREATE TABLE IF NOT EXISTS job_validation_runs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        jobId        TEXT NOT NULL,
        attempt      INTEGER,
        command      TEXT NOT NULL,
        exitCode     INTEGER,
        durationMs   INTEGER,
        passed       INTEGER NOT NULL DEFAULT 0,
        failureClass TEXT,
        stdoutTail   TEXT,
        stderrTail   TEXT,
        metadataJson TEXT NOT NULL DEFAULT '{}',
        createdAt    TEXT NOT NULL,
        FOREIGN KEY (jobId) REFERENCES jobs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_job_validation_runs_job_id ON job_validation_runs(jobId, id);
      CREATE INDEX IF NOT EXISTS idx_job_validation_runs_failure_class
        ON job_validation_runs(failureClass, createdAt);

      CREATE TABLE IF NOT EXISTS job_patch_snapshots (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        jobId                  TEXT NOT NULL,
        attempt                INTEGER,
        phase                  TEXT,
        publishableFileCount   INTEGER,
        artifactOnlyPathCount  INTEGER,
        changedPathSampleJson  TEXT NOT NULL DEFAULT '[]',
        topLevelDirsJson       TEXT NOT NULL DEFAULT '[]',
        capturedAt             TEXT,
        metadataJson           TEXT NOT NULL DEFAULT '{}',
        createdAt              TEXT NOT NULL,
        FOREIGN KEY (jobId) REFERENCES jobs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_job_patch_snapshots_job_id
        ON job_patch_snapshots(jobId, capturedAt);

      CREATE TABLE IF NOT EXISTS job_artifacts (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        jobId   TEXT NOT NULL,
        kind    TEXT NOT NULL,
        uri     TEXT,
        text    TEXT,
        FOREIGN KEY (jobId) REFERENCES jobs(id)
      );

      CREATE TABLE IF NOT EXISTS workers (
        workerId      TEXT PRIMARY KEY,
        status        TEXT NOT NULL DEFAULT 'idle',
        currentJobId  TEXT,
        pollMs        INTEGER,
        capabilities  TEXT,
        details       TEXT,
        lastHeartbeat TEXT NOT NULL,
        createdAt     TEXT NOT NULL,
        updatedAt     TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_workers_last_heartbeat ON workers(lastHeartbeat);

      CREATE TABLE IF NOT EXISTS pr_worker_assignments (
        prUrl         TEXT PRIMARY KEY,
        workerId      TEXT NOT NULL,
        createdAt     TEXT NOT NULL,
        updatedAt     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pr_worker_assignments_worker ON pr_worker_assignments(workerId);
    `);
    const jobColumns = this.db.prepare(`PRAGMA table_info(jobs)`).all();
    if (!jobColumns.some((col) => col.name === "targetWorkerId")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN targetWorkerId TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "priority")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';`);
    }
    if (!jobColumns.some((col) => col.name === "dedupeKey")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN dedupeKey TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "dedupeCooldownMs")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN dedupeCooldownMs INTEGER NOT NULL DEFAULT 0;`);
    }
    if (!jobColumns.some((col) => col.name === "queueWaitBudgetMs")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN queueWaitBudgetMs INTEGER NOT NULL DEFAULT 90000;`);
    }
    if (!jobColumns.some((col) => col.name === "executionBudgetMs")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN executionBudgetMs INTEGER NOT NULL DEFAULT 900000;`);
    }
    if (!jobColumns.some((col) => col.name === "finalizationBudgetMs")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN finalizationBudgetMs INTEGER NOT NULL DEFAULT 120000;`);
    }
    if (!jobColumns.some((col) => col.name === "enqueuedAt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN enqueuedAt TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "claimedAt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN claimedAt TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "startedAt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN startedAt TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "firstLogAt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN firstLogAt TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "failedAt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN failedAt TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "abandonedAt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN abandonedAt TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "publishBlockedAt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN publishBlockedAt TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "completedAt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN completedAt TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "durationMs")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN durationMs INTEGER;`);
    }
    if (!jobColumns.some((col) => col.name === "resumeOfJobId")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN resumeOfJobId TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "attempt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;`);
    }
    if (!jobColumns.some((col) => col.name === "prUrl")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN prUrl TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "availableAt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN availableAt TEXT;`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_target_worker ON jobs(targetWorkerId);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_priority_created ON jobs(status, priority, createdAt);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_available_at ON jobs(status, availableAt);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_dedupe_created ON jobs(dedupeKey, createdAt);`);
    this.db.exec(`DROP INDEX IF EXISTS idx_jobs_dedupe_active;`);
    this.db.exec(`CREATE UNIQUE INDEX idx_jobs_dedupe_active
         ON jobs(dedupeKey)
       WHERE dedupeKey IS NOT NULL
         AND dedupeKey <> ''
         AND status IN ('pending','claimed','finalizing');`);
    this.db.exec(`
      UPDATE jobs
      SET
        priority = CASE LOWER(COALESCE(priority, 'normal'))
          WHEN 'interactive' THEN 'interactive'
          WHEN 'background' THEN 'background'
          ELSE 'normal'
        END,
        dedupeCooldownMs = CASE
          WHEN dedupeCooldownMs IS NULL OR dedupeCooldownMs < 0 THEN 0
          ELSE dedupeCooldownMs
        END,
        attempt = CASE WHEN attempt IS NULL OR attempt <= 0 THEN 1 ELSE attempt END,
        queueWaitBudgetMs = CASE WHEN queueWaitBudgetMs IS NULL OR queueWaitBudgetMs <= 0 THEN 90000 ELSE queueWaitBudgetMs END,
        executionBudgetMs = CASE WHEN executionBudgetMs IS NULL OR executionBudgetMs <= 0 THEN 900000 ELSE executionBudgetMs END,
        finalizationBudgetMs = CASE WHEN finalizationBudgetMs IS NULL OR finalizationBudgetMs <= 0 THEN 120000 ELSE finalizationBudgetMs END,
        enqueuedAt = COALESCE(enqueuedAt, createdAt)
      WHERE 1 = 1;
    `);
  }
  assignedWorkerForPr(prUrl) {
    const normalizedPrUrl = normalizePrUrl(prUrl);
    if (!normalizedPrUrl)
      return null;
    const row = this.db.prepare(`SELECT workerId FROM pr_worker_assignments WHERE prUrl = ?`).get(normalizedPrUrl);
    const workerId = row?.workerId?.trim() ?? "";
    if (!workerId)
      return null;
    const worker = this.db.prepare(`SELECT status, lastHeartbeat FROM workers WHERE workerId = ?`).get(workerId);
    if (!worker)
      return null;
    if (String(worker.status ?? "").trim().toLowerCase() === "offline")
      return null;
    const heartbeatMs = parseIsoMs(worker.lastHeartbeat);
    if (heartbeatMs == null)
      return null;
    if (Date.now() - heartbeatMs > PR_WORKER_ASSIGNMENT_MAX_AGE_MS)
      return null;
    return workerId ? workerId : null;
  }
  upsertPrWorkerAssignment(prUrl, workerId, now) {
    const normalizedPrUrl = normalizePrUrl(prUrl);
    const normalizedWorkerId = typeof workerId === "string" ? workerId.trim() : "";
    if (!normalizedPrUrl || !normalizedWorkerId)
      return;
    this.db.prepare(`INSERT INTO pr_worker_assignments (prUrl, workerId, createdAt, updatedAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(prUrl) DO UPDATE SET
           workerId = excluded.workerId,
           updatedAt = excluded.updatedAt`).run(normalizedPrUrl, normalizedWorkerId, now, now);
  }
  refreshPrWorkerAssignmentForJob(jobId, now) {
    const row = this.db.prepare(`SELECT prUrl, workerId FROM jobs WHERE id = ?`).get(jobId);
    if (!row)
      return;
    this.upsertPrWorkerAssignment(row.prUrl, row.workerId, now);
  }
  pendingOrderedIds(targetWorkerId = null) {
    const now = new Date().toISOString();
    const targetWorkerCutoff = new Date(Date.now() - PR_WORKER_ASSIGNMENT_MAX_AGE_MS).toISOString();
    if (targetWorkerId) {
      const rows2 = this.db.prepare(`SELECT id
           FROM jobs
           WHERE status = 'pending'
             AND (
               targetWorkerId IS NULL
               OR targetWorkerId = ?
               OR NOT EXISTS (
                 SELECT 1
                 FROM workers tw
                 WHERE tw.workerId = jobs.targetWorkerId
                   AND COALESCE(tw.status, 'idle') <> 'offline'
                   AND tw.lastHeartbeat >= ?
               )
             )
             AND (
               availableAt IS NULL
               OR availableAt <= ?
               OR targetWorkerId = ?
               OR (
                 targetWorkerId IS NOT NULL
                 AND NOT EXISTS (
                   SELECT 1
                   FROM workers tw
                   WHERE tw.workerId = jobs.targetWorkerId
                     AND COALESCE(tw.status, 'idle') <> 'offline'
                     AND tw.lastHeartbeat >= ?
                 )
               )
             )
             AND (
               targetWorkerId IS NULL
               OR targetWorkerId = ?
               OR NOT EXISTS (
                 SELECT 1
                 FROM workers tw
                 WHERE tw.workerId = jobs.targetWorkerId
                   AND COALESCE(tw.status, 'idle') <> 'offline'
                   AND tw.lastHeartbeat >= ?
               )
             )
           ORDER BY
             CASE WHEN targetWorkerId = ? THEN 0 ELSE 1 END ASC,
             CASE LOWER(priority)
               WHEN 'interactive' THEN 0
               WHEN 'normal' THEN 1
               WHEN 'background' THEN 2
               ELSE 1
             END ASC,
             createdAt ASC`).all(targetWorkerId, targetWorkerCutoff, now, targetWorkerId, targetWorkerCutoff, targetWorkerId, targetWorkerCutoff, targetWorkerId);
      return rows2.map((row) => row.id);
    }
    const rows = this.db.prepare(`SELECT id
         FROM jobs
         WHERE status = 'pending'
           AND (
             availableAt IS NULL
             OR availableAt <= ?
             OR (
               targetWorkerId IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1
                 FROM workers tw
                 WHERE tw.workerId = jobs.targetWorkerId
                   AND COALESCE(tw.status, 'idle') <> 'offline'
                   AND tw.lastHeartbeat >= ?
               )
             )
           )
           AND (
             targetWorkerId IS NULL
             OR NOT EXISTS (
               SELECT 1
               FROM workers tw
               WHERE tw.workerId = jobs.targetWorkerId
                 AND COALESCE(tw.status, 'idle') <> 'offline'
                 AND tw.lastHeartbeat >= ?
             )
           )
         ORDER BY
           CASE LOWER(priority)
             WHEN 'interactive' THEN 0
             WHEN 'normal' THEN 1
             WHEN 'background' THEN 2
             ELSE 1
           END ASC,
           createdAt ASC`).all(now, targetWorkerCutoff, targetWorkerCutoff);
    return rows.map((row) => row.id);
  }
  queuePosition(jobId, targetWorkerId = null) {
    const ordered = this.pendingOrderedIds(targetWorkerId);
    const idx = ordered.indexOf(jobId);
    if (idx < 0)
      return null;
    return idx + 1;
  }
  estimateEtaMs(priority, position) {
    if (!position || position <= 0)
      return null;
    const slotMs = JOB_PRIORITY_QUEUE_SLA_MS[priority];
    return Math.max(0, slotMs * (position - 1));
  }
  enqueue(body) {
    const taskId = String(body.taskId ?? "").trim();
    const kind = String(body.kind ?? "").trim();
    const sessionId = String(body.sessionId ?? "").trim();
    const params = body.params && typeof body.params === "object" && !Array.isArray(body.params) ? body.params : {};
    const prUrl = resolveJobPrUrl(body, params);
    const targetWorkerIdRaw = body.targetWorkerId;
    const requestedTargetWorkerId = typeof targetWorkerIdRaw === "string" && targetWorkerIdRaw.trim().length > 0 ? targetWorkerIdRaw.trim() : null;
    const targetWorkerId = requestedTargetWorkerId || (prUrl ? this.assignedWorkerForPr(prUrl) : null);
    if (!taskId || !kind) {
      return { ok: false, message: "taskId and kind are required" };
    }
    const priority = normalizeJobPriority(body.priority ?? extractPlanningField(params, "queuePriority"));
    const queueWaitBudgetMs = parseBudgetMs(body.queueWaitBudgetMs ?? extractPlanningField(params, "queueWaitBudgetMs"), JOB_PRIORITY_QUEUE_SLA_MS[priority]);
    const executionBudgetMs = parseBudgetMs(body.executionBudgetMs ?? extractPlanningField(params, "executionBudgetMs"), JOB_EXECUTION_BUDGET_MS[priority]);
    const finalizationBudgetMs = parseBudgetMs(body.finalizationBudgetMs ?? extractPlanningField(params, "finalizationBudgetMs"), JOB_FINALIZATION_BUDGET_MS_DEFAULT);
    const dedupeKey = normalizeDedupeKey(body.dedupeKey);
    const dedupeCooldownMs = parseDedupeCooldownMs(body.dedupeCooldownMs, dedupeKey ? 0 : 0);
    if (dedupeKey) {
      const active = this.db.prepare(`SELECT id, taskId
           FROM jobs
           WHERE dedupeKey = ?
             AND status IN ('pending', 'claimed', 'finalizing')
           ORDER BY createdAt DESC
           LIMIT 1`).get(dedupeKey);
      if (active?.id) {
        return {
          ok: true,
          jobId: active.id,
          taskId: active.taskId,
          deduped: true,
          message: `Active job already exists for dedupeKey ${dedupeKey}`
        };
      }
      if (dedupeCooldownMs > 0) {
        const latest = this.db.prepare(`SELECT id, taskId, createdAt
             FROM jobs
             WHERE dedupeKey = ?
             ORDER BY createdAt DESC
             LIMIT 1`).get(dedupeKey);
        if (latest?.id) {
          const createdAtMs = parseIsoMs(latest.createdAt);
          if (createdAtMs != null && Date.now() - createdAtMs < dedupeCooldownMs) {
            return {
              ok: true,
              jobId: latest.id,
              taskId: latest.taskId,
              deduped: true,
              message: `Dedupe cooldown active for dedupeKey ${dedupeKey}`
            };
          }
        }
      }
    }
    const jobId = randomUUID2();
    const now = new Date().toISOString();
    try {
      this.db.prepare(`INSERT INTO jobs (
            id, taskId, sessionId, kind, params, dedupeKey, dedupeCooldownMs, priority,
            queueWaitBudgetMs, executionBudgetMs, finalizationBudgetMs,
            status, workerId, targetWorkerId, result, prUrl, error,
            enqueuedAt, claimedAt, startedAt, firstLogAt, failedAt, completedAt, durationMs,
            createdAt, updatedAt
          )
           VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?,
            'pending', NULL, ?, NULL, ?, NULL,
            ?, NULL, NULL, NULL, NULL, NULL, NULL,
            ?, ?
           )`).run(jobId, taskId, sessionId, kind, JSON.stringify(params), dedupeKey, dedupeCooldownMs, priority, queueWaitBudgetMs, executionBudgetMs, finalizationBudgetMs, targetWorkerId, prUrl, now, now, now);
    } catch (err) {
      const message = String(err?.message ?? err ?? "");
      if (dedupeKey && /UNIQUE constraint failed/i.test(message)) {
        const active = this.db.prepare(`SELECT id, taskId
             FROM jobs
             WHERE dedupeKey = ?
               AND status IN ('pending', 'claimed', 'finalizing')
             ORDER BY createdAt DESC
             LIMIT 1`).get(dedupeKey);
        if (active?.id) {
          return {
            ok: true,
            jobId: active.id,
            taskId: active.taskId,
            deduped: true,
            message: `Active job already exists for dedupeKey ${dedupeKey}`
          };
        }
      }
      throw err;
    }
    const queuePosition = this.queuePosition(jobId, targetWorkerId);
    const etaMs = this.estimateEtaMs(priority, queuePosition);
    return {
      ok: true,
      jobId,
      taskId,
      queuePosition: queuePosition ?? undefined,
      etaMs: etaMs ?? undefined
    };
  }
  claim(workerIdRaw) {
    const workerId = workerIdRaw.trim() || "unknown";
    const now = new Date().toISOString();
    const targetWorkerCutoff = new Date(Date.now() - PR_WORKER_ASSIGNMENT_MAX_AGE_MS).toISOString();
    const tx = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO workers (workerId, status, currentJobId, pollMs, capabilities, details, lastHeartbeat, createdAt, updatedAt)
           VALUES (?, 'idle', NULL, NULL, '{}', '{}', ?, ?, ?)
           ON CONFLICT(workerId) DO UPDATE SET
             lastHeartbeat = excluded.lastHeartbeat,
             updatedAt = excluded.updatedAt`).run(workerId, now, now, now);
      const existingClaim = this.db.prepare(`SELECT * FROM jobs
           WHERE workerId = ?
             AND status = 'claimed'
           ORDER BY COALESCE(startedAt, claimedAt, updatedAt, createdAt) ASC
           LIMIT 1`).get(workerId);
      if (existingClaim) {
        this.db.prepare(`UPDATE workers SET status = 'busy', currentJobId = ?, lastHeartbeat = ?, updatedAt = ?
             WHERE workerId = ?`).run(existingClaim.id, now, now, workerId);
        return {
          job: {
            ...existingClaim,
            workerId,
            status: "claimed"
          },
          queueWaitMs: 0,
          reusedActiveClaim: true
        };
      }
      const row = this.db.prepare(`SELECT * FROM jobs
           WHERE status = 'pending'
             AND (
               targetWorkerId IS NULL
               OR targetWorkerId = ?
               OR NOT EXISTS (
                 SELECT 1
                 FROM workers tw
                 WHERE tw.workerId = jobs.targetWorkerId
                   AND COALESCE(tw.status, 'idle') <> 'offline'
                   AND tw.lastHeartbeat >= ?
               )
             )
             AND (
               availableAt IS NULL
               OR availableAt <= ?
               OR targetWorkerId = ?
               OR (
                 targetWorkerId IS NOT NULL
                 AND NOT EXISTS (
                   SELECT 1
                   FROM workers tw
                   WHERE tw.workerId = jobs.targetWorkerId
                     AND COALESCE(tw.status, 'idle') <> 'offline'
                     AND tw.lastHeartbeat >= ?
                 )
               )
             )
             AND (
               targetWorkerId IS NULL
               OR targetWorkerId = ?
               OR NOT EXISTS (
                 SELECT 1
                 FROM workers tw
                 WHERE tw.workerId = jobs.targetWorkerId
                   AND COALESCE(tw.status, 'idle') <> 'offline'
                   AND tw.lastHeartbeat >= ?
               )
             )
           ORDER BY
             CASE WHEN targetWorkerId = ? THEN 0 ELSE 1 END ASC,
             CASE LOWER(priority)
               WHEN 'interactive' THEN 0
               WHEN 'normal' THEN 1
               WHEN 'background' THEN 2
               ELSE 1
             END ASC,
             createdAt ASC
           LIMIT 1`).get(workerId, targetWorkerCutoff, now, workerId, targetWorkerCutoff, workerId, targetWorkerCutoff, workerId);
      if (!row) {
        this.db.prepare(`UPDATE workers SET status = 'idle', currentJobId = NULL, lastHeartbeat = ?, updatedAt = ?
             WHERE workerId = ?`).run(now, now, workerId);
        return null;
      }
      this.db.prepare(`UPDATE jobs
           SET status = 'claimed',
               workerId = ?,
               claimedAt = ?,
               startedAt = COALESCE(startedAt, ?),
               availableAt = NULL,
               failedAt = NULL,
               abandonedAt = NULL,
               publishBlockedAt = NULL,
               completedAt = NULL,
               durationMs = NULL,
               updatedAt = ?
            WHERE id = ?`).run(workerId, now, now, now, row.id);
      this.db.prepare(`UPDATE workers SET status = 'busy', currentJobId = ?, lastHeartbeat = ?, updatedAt = ?
           WHERE workerId = ?`).run(row.id, now, now, workerId);
      this.upsertPrWorkerAssignment(row.prUrl, workerId, now);
      const queueWaitMs = Math.max(0, Math.floor(Date.parse(now) - Date.parse(row.enqueuedAt || row.createdAt || now) || 0));
      return {
        job: {
          ...row,
          status: "claimed",
          workerId,
          claimedAt: now,
          startedAt: row.startedAt || now,
          failedAt: null,
          publishBlockedAt: null,
          completedAt: null,
          durationMs: null,
          updatedAt: now
        },
        queueWaitMs
      };
    });
    const claimed = tx();
    if (!claimed)
      return { ok: false, message: "No pending jobs" };
    if ("reusedActiveClaim" in claimed) {
      return {
        ok: false,
        message: `Worker ${workerId} already has claimed job ${claimed.job.id}`
      };
    }
    return { ok: true, job: claimed.job, queueWaitMs: claimed.queueWaitMs };
  }
  recoverClaimedJob(jobId, now, options) {
    const job = this.getJob(jobId);
    if (!job || job.status !== "claimed")
      return null;
    if (options.expectedWorkerId && job.workerId !== options.expectedWorkerId)
      return null;
    const params = parseJobParamsRecord(job.params);
    const { retrySafety, reason: classificationReason } = classifyJobRetrySafety(job.kind, params);
    const detailWithClassification = [
      options.detail,
      `retrySafety=${retrySafety}`,
      `classificationReason=${classificationReason}`
    ].join("; ");
    if (retrySafety === "retry_safe") {
      const replacementJobId = randomUUID2();
      const attempt = Math.max(1, Math.floor(Number(job.attempt || 1))) + 1;
      const replacementAvailableAt = new Date(Date.parse(now) + RETRY_SAFE_REQUEUE_DELAY_MS).toISOString();
      const replacementParams = buildResumeParams(params, {
        previousJobId: job.id,
        previousWorkerId: job.workerId,
        recoveredAt: now,
        reason: options.recoveryReason,
        detail: options.detail,
        retrySafety,
        classificationReason,
        attempt
      });
      const nextTargetWorkerId = job.targetWorkerId && job.targetWorkerId !== job.workerId ? job.targetWorkerId : null;
      const abandonmentError = JSON.stringify({
        message: options.abandonmentMessage,
        detail: detailWithClassification,
        replacementJobId,
        replacementAvailableAt
      });
      const abandonedInfo = this.db.prepare(`UPDATE jobs
           SET status = 'abandoned',
               error = ?,
               failedAt = NULL,
               abandonedAt = ?,
               publishBlockedAt = NULL,
               availableAt = NULL,
               completedAt = NULL,
               durationMs = MAX(
                 0,
                 CAST((julianday(?) - julianday(COALESCE(startedAt, claimedAt, enqueuedAt, createdAt))) * 86400000 AS INTEGER)
               ),
               updatedAt = ?
           WHERE id = ?
             AND status = 'claimed'
             AND (? IS NULL OR workerId = ?)`).run(abandonmentError, now, now, now, job.id, options.expectedWorkerId ?? null, options.expectedWorkerId ?? null);
      if (abandonedInfo.changes === 0)
        return null;
      this.db.prepare(`INSERT INTO jobs (
             id, taskId, sessionId, kind, params, dedupeKey, dedupeCooldownMs, priority,
             queueWaitBudgetMs, executionBudgetMs, finalizationBudgetMs,
             status, workerId, targetWorkerId, result, prUrl, error, availableAt,
             enqueuedAt, claimedAt, startedAt, firstLogAt, failedAt, abandonedAt, completedAt,
             durationMs, resumeOfJobId, attempt, createdAt, updatedAt
           )
           VALUES (
             ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?,
             'pending', NULL, ?, NULL, ?, NULL, ?,
             ?, NULL, NULL, NULL, NULL, NULL, NULL,
             NULL, ?, ?, ?, ?
           )`).run(replacementJobId, job.taskId, job.sessionId, job.kind, JSON.stringify(replacementParams), job.dedupeKey, job.dedupeCooldownMs, job.priority, job.queueWaitBudgetMs, job.executionBudgetMs, job.finalizationBudgetMs, nextTargetWorkerId, job.prUrl, replacementAvailableAt, now, job.id, attempt, now, now);
      return {
        jobId: job.id,
        taskId: job.taskId,
        sessionId: job.sessionId,
        workerId: job.workerId,
        message: options.abandonmentMessage,
        detail: detailWithClassification,
        action: "requeued",
        finalStatus: "abandoned",
        retrySafety,
        replacementJobId,
        replacementAvailableAt,
        recoveredAt: now
      };
    }
    const failureError = JSON.stringify({
      message: options.failureMessage,
      detail: detailWithClassification
    });
    const failedInfo = this.db.prepare(`UPDATE jobs
         SET status = 'failed',
             error = ?,
             failedAt = ?,
             abandonedAt = NULL,
             publishBlockedAt = NULL,
             availableAt = NULL,
             completedAt = NULL,
             durationMs = MAX(
               0,
               CAST((julianday(?) - julianday(COALESCE(startedAt, claimedAt, enqueuedAt, createdAt))) * 86400000 AS INTEGER)
             ),
             updatedAt = ?
         WHERE id = ?
           AND status = 'claimed'
           AND (? IS NULL OR workerId = ?)`).run(failureError, now, now, now, job.id, options.expectedWorkerId ?? null, options.expectedWorkerId ?? null);
    if (failedInfo.changes === 0)
      return null;
    return {
      jobId: job.id,
      taskId: job.taskId,
      sessionId: job.sessionId,
      workerId: job.workerId,
      message: options.failureMessage,
      detail: detailWithClassification,
      action: "failed",
      finalStatus: "failed",
      retrySafety,
      recoveredAt: now
    };
  }
  heartbeat(body) {
    const workerIdRaw = body.workerId;
    if (typeof workerIdRaw !== "string" || workerIdRaw.trim().length === 0) {
      return { ok: false, message: "workerId is required" };
    }
    const workerId = workerIdRaw.trim();
    const status = normalizeWorkerStatus(body.status);
    const currentJobId = typeof body.currentJobId === "string" && body.currentJobId.trim().length > 0 ? body.currentJobId.trim() : null;
    const pollMs = typeof body.pollMs === "number" && Number.isFinite(body.pollMs) ? Math.max(0, body.pollMs) : null;
    const capabilities = JSON.stringify(body.capabilities && typeof body.capabilities === "object" && !Array.isArray(body.capabilities) ? body.capabilities : {});
    const details = JSON.stringify(body.details && typeof body.details === "object" && !Array.isArray(body.details) ? body.details : {});
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO workers (workerId, status, currentJobId, pollMs, capabilities, details, lastHeartbeat, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workerId) DO UPDATE SET
           status = excluded.status,
           currentJobId = excluded.currentJobId,
           pollMs = excluded.pollMs,
           capabilities = excluded.capabilities,
           details = excluded.details,
           lastHeartbeat = excluded.lastHeartbeat,
           updatedAt = excluded.updatedAt`).run(workerId, status, currentJobId, pollMs, capabilities, details, now, now, now);
    this.reconcileWorkerHeartbeatMismatch(workerId, status, currentJobId, now);
    return { ok: true };
  }
  reconcileWorkerHeartbeatMismatch(workerId, status, currentJobId, now) {
    const rows = this.db.prepare(`SELECT
           j.id AS jobId,
           j.taskId AS taskId,
           j.sessionId AS sessionId,
           j.updatedAt AS updatedAt,
           j.claimedAt AS claimedAt,
           j.startedAt AS startedAt,
           j.firstLogAt AS firstLogAt,
           (
             SELECT MAX(jl.ts)
             FROM job_logs jl
             WHERE jl.jobId = j.id
           ) AS lastLogTs,
           COALESCE(
             (
               SELECT MAX(jl.ts)
               FROM job_logs jl
               WHERE jl.jobId = j.id
             ),
             j.firstLogAt,
             j.startedAt,
             j.claimedAt,
             j.updatedAt
           ) AS activityAt
         FROM jobs j
         WHERE j.status = 'claimed'
           AND j.workerId = ?`).all(workerId);
    if (rows.length === 0)
      return;
    const mismatchedRows = status === "busy" && currentJobId ? rows.filter((row) => row.jobId !== currentJobId) : rows;
    if (mismatchedRows.length === 0)
      return;
    const nowMs = Date.parse(now);
    const tx = this.db.transaction((claimedRows) => {
      for (const row of claimedRows) {
        const activityMs = parseIsoMs(row.activityAt) ?? parseIsoMs(row.updatedAt) ?? nowMs;
        const activityAgeMs = Math.max(0, nowMs - activityMs);
        if (activityAgeMs < ORPHANED_CLAIM_HEARTBEAT_GRACE_MS)
          continue;
        const failureMessage = "Job auto-failed after worker heartbeat dropped claimed job";
        const abandonmentMessage = "Job auto-abandoned after worker heartbeat dropped claimed job";
        const detailParts = [
          `worker=${workerId}`,
          `workerStatus=${status}`,
          currentJobId ? `workerCurrentJobId=${currentJobId}` : "workerCurrentJobId=missing",
          `jobId=${row.jobId}`,
          row.lastLogTs ? `lastLogTs=${row.lastLogTs}` : "lastLogTs=none",
          `activityAt=${row.activityAt}`,
          `jobUpdatedAt=${row.updatedAt}`,
          `activityAgeMs=${activityAgeMs}`,
          `graceMs=${ORPHANED_CLAIM_HEARTBEAT_GRACE_MS}`
        ];
        const detail = detailParts.join("; ");
        const recovered = this.recoverClaimedJob(row.jobId, now, {
          expectedWorkerId: workerId,
          recoveryReason: "worker_heartbeat_mismatch",
          failureMessage,
          abandonmentMessage,
          detail
        });
        if (!recovered)
          continue;
      }
    });
    tx(mismatchedRows);
  }
  listWorkers(onlineTtlMs = 15000) {
    const ttl = Number.isFinite(onlineTtlMs) ? Math.max(1000, Math.floor(onlineTtlMs)) : 15000;
    const nowMs = Date.now();
    const rows = this.db.prepare(`SELECT
           w.workerId,
           w.status,
           w.currentJobId,
           w.pollMs,
           w.capabilities,
           w.details,
           w.lastHeartbeat,
           w.createdAt,
           w.updatedAt,
           COALESCE(claimed.activeJobCount, 0) AS activeJobCount
         FROM workers w
         LEFT JOIN (
           SELECT workerId, COUNT(*) AS activeJobCount
           FROM jobs
           WHERE status = 'claimed'
           GROUP BY workerId
         ) claimed ON claimed.workerId = w.workerId
         ORDER BY w.lastHeartbeat DESC, w.workerId ASC`).all();
    return rows.map((row) => {
      const heartbeatMs = Date.parse(row.lastHeartbeat);
      const isOnline = Number.isFinite(heartbeatMs) && nowMs - heartbeatMs <= ttl;
      return {
        workerId: row.workerId,
        status: row.status,
        currentJobId: row.currentJobId,
        pollMs: row.pollMs,
        capabilities: parseObjectJson(row.capabilities),
        details: parseObjectJson(row.details),
        lastHeartbeat: row.lastHeartbeat,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        activeJobCount: Number(row.activeJobCount || 0),
        isOnline
      };
    });
  }
  recordJobDiagnostics(jobId, body, status, now) {
    const diagnostics = recordFromUnknown(body.diagnostics);
    if (!diagnostics)
      return;
    const hasAttempts = Array.isArray(diagnostics.attempts);
    const hasPhaseSpans = Array.isArray(diagnostics.phaseSpans);
    const hasValidationRuns = Array.isArray(diagnostics.validationRuns);
    const hasPatchSnapshots = Array.isArray(diagnostics.patchSnapshots);
    const attempts = arrayFromUnknown(diagnostics.attempts).map(recordFromUnknown).filter((entry) => Boolean(entry)).slice(0, MAX_JOB_DIAGNOSTIC_ATTEMPTS);
    const phaseSpans = arrayFromUnknown(diagnostics.phaseSpans).map(recordFromUnknown).filter((entry) => Boolean(entry)).slice(0, MAX_JOB_DIAGNOSTIC_PHASE_SPANS);
    const validationRuns = arrayFromUnknown(diagnostics.validationRuns).map(recordFromUnknown).filter((entry) => Boolean(entry)).slice(0, MAX_JOB_DIAGNOSTIC_VALIDATION_RUNS);
    const patchSnapshots = arrayFromUnknown(diagnostics.patchSnapshots).map(recordFromUnknown).filter((entry) => Boolean(entry)).slice(0, MAX_JOB_DIAGNOSTIC_PATCH_SNAPSHOTS);
    const terminal = recordFromUnknown(diagnostics.terminal);
    const tx = this.db.transaction(() => {
      if (hasAttempts)
        this.db.prepare(`DELETE FROM job_attempts WHERE jobId = ?`).run(jobId);
      if (hasPhaseSpans)
        this.db.prepare(`DELETE FROM job_phase_spans WHERE jobId = ?`).run(jobId);
      if (hasValidationRuns) {
        this.db.prepare(`DELETE FROM job_validation_runs WHERE jobId = ?`).run(jobId);
      }
      if (hasPatchSnapshots) {
        this.db.prepare(`DELETE FROM job_patch_snapshots WHERE jobId = ?`).run(jobId);
      }
      if (terminal) {
        this.db.prepare(`DELETE FROM job_terminal_diagnostics WHERE jobId = ?`).run(jobId);
      }
      const insertAttempt = this.db.prepare(`INSERT INTO job_attempts (
           jobId, attempt, workerId, backend, model, startedAt, finishedAt, durationMs,
           terminalReason, exitCode, metadataJson, createdAt
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const attempt of attempts) {
        insertAttempt.run(jobId, boundedDbInt(attempt.attempt, 1000) ?? 1, diagnosticText(attempt.workerId, 160), diagnosticText(attempt.backend, 120), diagnosticText(attempt.model, 180), diagnosticIso(attempt.startedAt), diagnosticIso(attempt.finishedAt), boundedDbInt(attempt.durationMs, 30 * 24 * 60 * 60 * 1000), diagnosticText(attempt.terminalReason, 1000), boundedDbInt(attempt.exitCode, 999), diagnosticMetadataJson(attempt.metadata), now);
      }
      if (terminal) {
        this.db.prepare(`INSERT INTO job_terminal_diagnostics (
               jobId, status, failureClass, terminalStage, executorBackend, summary,
               watchdogFired, timeoutMs, publishableFileCount, artifactOnlyPathCount,
               changedPathSampleJson, metadataJson, createdAt, updatedAt
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(jobId, status, diagnosticText(terminal.failureClass, 160), diagnosticText(terminal.terminalStage, 160), diagnosticText(terminal.executorBackend, 160), diagnosticText(terminal.summary ?? body.summary ?? body.message, 1000), boolFromUnknown(terminal.watchdogFired) ? 1 : 0, boundedDbInt(terminal.timeoutMs, 30 * 24 * 60 * 60 * 1000), boundedDbInt(terminal.publishableFileCount, 1e5), boundedDbInt(terminal.artifactOnlyPathCount, 1e5), diagnosticStringArrayJson(terminal.changedPathSample), diagnosticMetadataJson(terminal.metadata), now, now);
      }
      const insertPhaseSpan = this.db.prepare(`INSERT INTO job_phase_spans (
           jobId, attempt, phase, startedAt, finishedAt, durationMs, outcome, metadataJson, createdAt
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const span of phaseSpans) {
        const startedAt = diagnosticIso(span.startedAt);
        const finishedAt = diagnosticIso(span.finishedAt);
        const phase = diagnosticText(span.phase, 160);
        if (!startedAt || !finishedAt || !phase)
          continue;
        insertPhaseSpan.run(jobId, boundedDbInt(span.attempt, 1000), phase, startedAt, finishedAt, boundedDbInt(span.durationMs, 30 * 24 * 60 * 60 * 1000) ?? 0, diagnosticText(span.outcome, 160), diagnosticMetadataJson(span.metadata), now);
      }
      const insertValidationRun = this.db.prepare(`INSERT INTO job_validation_runs (
           jobId, attempt, command, exitCode, durationMs, passed, failureClass,
           stdoutTail, stderrTail, metadataJson, createdAt
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const run of validationRuns) {
        const command = diagnosticText(run.command, 1000);
        if (!command)
          continue;
        insertValidationRun.run(jobId, boundedDbInt(run.attempt, 1000), command, boundedDbInt(run.exitCode, 999), boundedDbInt(run.durationMs, 24 * 60 * 60 * 1000), boolFromUnknown(run.passed) ? 1 : 0, diagnosticText(run.failureClass, 160), diagnosticText(run.stdoutTail, 8000), diagnosticText(run.stderrTail, 8000), diagnosticMetadataJson(run.metadata), now);
      }
      const insertPatchSnapshot = this.db.prepare(`INSERT INTO job_patch_snapshots (
           jobId, attempt, phase, publishableFileCount, artifactOnlyPathCount,
           changedPathSampleJson, topLevelDirsJson, capturedAt, metadataJson, createdAt
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const snapshot of patchSnapshots) {
        insertPatchSnapshot.run(jobId, boundedDbInt(snapshot.attempt, 1000), diagnosticText(snapshot.phase, 160), boundedDbInt(snapshot.publishableFileCount, 1e5), boundedDbInt(snapshot.artifactOnlyPathCount, 1e5), diagnosticStringArrayJson(snapshot.changedPathSample), diagnosticStringArrayJson(snapshot.topLevelDirs, 20), diagnosticIso(snapshot.capturedAt), diagnosticMetadataJson(snapshot.metadata), now);
      }
    });
    tx();
  }
  complete(jobId, body) {
    const now = new Date().toISOString();
    const summary = body.summary ?? null;
    const artifacts = body.artifacts ? JSON.stringify(body.artifacts) : null;
    const prUrl = typeof body.prUrl === "string" && body.prUrl.trim().length > 0 ? body.prUrl.trim() : null;
    const jobRow = this.db.prepare(`SELECT workerId FROM jobs WHERE id = ?`).get(jobId);
    const info = this.db.prepare(`UPDATE jobs
         SET status = 'completed',
             result = ?,
             prUrl = COALESCE(?, prUrl),
             completedAt = ?,
             failedAt = NULL,
             abandonedAt = NULL,
             publishBlockedAt = NULL,
             durationMs = MAX(
               0,
               CAST((julianday(?) - julianday(COALESCE(startedAt, claimedAt, enqueuedAt, createdAt))) * 86400000 AS INTEGER)
             ),
             updatedAt = ?
         WHERE id = ? AND status = 'claimed'`).run(JSON.stringify({ summary, artifacts }), prUrl, now, now, now, jobId);
    if (info.changes === 0) {
      return { ok: false, message: "Job not found or not in claimed state" };
    }
    try {
      this.recordJobDiagnostics(jobId, body, "completed", now);
    } catch (error) {
      console.error(`[JobQueue] Failed to persist completed diagnostics for ${jobId}: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    }
    const completed = this.db.prepare(`SELECT durationMs, completedAt FROM jobs WHERE id = ?`).get(jobId);
    this.refreshPrWorkerAssignmentForJob(jobId, now);
    this.setWorkerIdleIfNoClaimedJobs(jobRow?.workerId ?? null, now);
    return {
      ok: true,
      durationMs: completed?.durationMs ?? undefined,
      completedAt: completed?.completedAt ?? undefined
    };
  }
  fail(jobId, body) {
    const now = new Date().toISOString();
    const message = String(body.message ?? "Unknown error");
    const detail = body.detail == null ? null : String(body.detail);
    const jobRow = this.db.prepare(`SELECT workerId FROM jobs WHERE id = ?`).get(jobId);
    const info = this.db.prepare(`UPDATE jobs
         SET status = 'failed',
             error = ?,
             failedAt = ?,
             availableAt = NULL,
             completedAt = NULL,
             abandonedAt = NULL,
             publishBlockedAt = NULL,
             durationMs = MAX(
               0,
               CAST((julianday(?) - julianday(COALESCE(startedAt, claimedAt, enqueuedAt, createdAt))) * 86400000 AS INTEGER)
             ),
             updatedAt = ?
         WHERE id = ? AND status = 'claimed'`).run(JSON.stringify({ message, detail }), now, now, now, jobId);
    if (info.changes === 0) {
      return { ok: false, message: "Job not found or not in claimed state" };
    }
    try {
      this.recordJobDiagnostics(jobId, body, "failed", now);
    } catch (error) {
      console.error(`[JobQueue] Failed to persist failed diagnostics for ${jobId}: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    }
    const failed = this.db.prepare(`SELECT durationMs, failedAt FROM jobs WHERE id = ?`).get(jobId);
    this.refreshPrWorkerAssignmentForJob(jobId, now);
    this.setWorkerIdleIfNoClaimedJobs(jobRow?.workerId ?? null, now);
    return {
      ok: true,
      durationMs: failed?.durationMs ?? undefined,
      failedAt: failed?.failedAt ?? undefined
    };
  }
  publishBlocked(jobId, body) {
    const now = new Date().toISOString();
    const message = String(body.message ?? "Publish blocked");
    const detail = body.detail == null ? null : String(body.detail);
    const publishBlocked = body.publishBlocked ?? null;
    const jobRow = this.db.prepare(`SELECT workerId FROM jobs WHERE id = ?`).get(jobId);
    const info = this.db.prepare(`UPDATE jobs
         SET status = 'publish_blocked',
             error = ?,
             publishBlockedAt = ?,
             availableAt = NULL,
             completedAt = NULL,
             failedAt = NULL,
             abandonedAt = NULL,
             durationMs = MAX(
               0,
               CAST((julianday(?) - julianday(COALESCE(startedAt, claimedAt, enqueuedAt, createdAt))) * 86400000 AS INTEGER)
             ),
             updatedAt = ?
         WHERE id = ? AND status = 'claimed'`).run(JSON.stringify({ message, detail, publishBlocked }), now, now, now, jobId);
    if (info.changes === 0) {
      return { ok: false, message: "Job not found or not in claimed state" };
    }
    try {
      this.recordJobDiagnostics(jobId, body, "publish_blocked", now);
    } catch (error) {
      console.error(`[JobQueue] Failed to persist publish-blocked diagnostics for ${jobId}: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    }
    const blocked = this.db.prepare(`SELECT durationMs, publishBlockedAt FROM jobs WHERE id = ?`).get(jobId);
    this.refreshPrWorkerAssignmentForJob(jobId, now);
    this.setWorkerIdleIfNoClaimedJobs(jobRow?.workerId ?? null, now);
    return {
      ok: true,
      durationMs: blocked?.durationMs ?? undefined,
      publishBlockedAt: blocked?.publishBlockedAt ?? undefined
    };
  }
  defer(jobId, body) {
    const workerId = String(body.workerId ?? "").trim();
    if (!workerId) {
      return { ok: false, message: "workerId is required" };
    }
    const now = new Date().toISOString();
    const deferMsRaw = Number.parseInt(String(body.deferMs ?? ""), 10);
    const deferMs = Number.isFinite(deferMsRaw) ? Math.max(1000, Math.min(deferMsRaw, 30 * 60000)) : 60000;
    const availableAt = new Date(Date.now() + deferMs).toISOString();
    const targetWorkerId = body.targetWorkerId === null ? null : typeof body.targetWorkerId === "string" && body.targetWorkerId.trim().length > 0 ? body.targetWorkerId.trim() : workerId;
    const info = this.db.prepare(`UPDATE jobs
         SET status = 'pending',
             workerId = NULL,
             targetWorkerId = ?,
             claimedAt = NULL,
             startedAt = NULL,
             firstLogAt = NULL,
             availableAt = ?,
             updatedAt = ?
         WHERE id = ?
           AND status = 'claimed'
           AND workerId = ?`).run(targetWorkerId, availableAt, now, jobId, workerId);
    if (info.changes === 0) {
      return { ok: false, message: "Job not found, not claimed, or not owned by worker" };
    }
    this.setWorkerIdleIfNoClaimedJobs(workerId, now);
    return { ok: true, availableAt };
  }
  failDeferred(jobId, body) {
    const workerId = String(body.workerId ?? "").trim();
    if (!workerId) {
      return { ok: false, message: "workerId is required" };
    }
    const now = new Date().toISOString();
    const message = String(body.message ?? "Unknown error");
    const detail = body.detail == null ? null : String(body.detail);
    const info = this.db.prepare(`UPDATE jobs
         SET status = 'failed',
             error = ?,
             failedAt = ?,
             availableAt = NULL,
             targetWorkerId = NULL,
             completedAt = NULL,
             durationMs = NULL,
             updatedAt = ?
         WHERE id = ?
           AND status = 'pending'
           AND targetWorkerId = ?
           AND availableAt IS NOT NULL`).run(JSON.stringify({ message, detail }), now, now, jobId, workerId);
    if (info.changes === 0) {
      return { ok: false, message: "Deferred job not found or not owned by worker" };
    }
    return { ok: true, failedAt: now };
  }
  recoverStaleClaimedJobs(staleAfterMs, limit = 100) {
    const ttlMs = Number.isFinite(staleAfterMs) ? Math.max(5000, Math.floor(staleAfterMs)) : 120000;
    const maxRows = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 100;
    const nowMs = Date.now();
    const cutoff = new Date(nowMs - ttlMs).toISOString();
    const candidates = this.db.prepare(`SELECT
           j.id AS jobId,
           j.taskId AS taskId,
           j.sessionId AS sessionId,
           j.executionBudgetMs AS executionBudgetMs,
           j.finalizationBudgetMs AS finalizationBudgetMs,
           j.workerId AS workerId,
           w.status AS workerStatus,
           w.currentJobId AS workerCurrentJobId,
           w.lastHeartbeat AS workerLastHeartbeat,
           j.updatedAt AS jobUpdatedAt,
           (
             SELECT MAX(jl.ts)
             FROM job_logs jl
             WHERE jl.jobId = j.id
           ) AS lastLogTs,
           COALESCE(
             (
               SELECT MAX(jl.ts)
               FROM job_logs jl
               WHERE jl.jobId = j.id
             ),
             j.firstLogAt,
             j.startedAt,
             j.claimedAt,
             j.updatedAt
           ) AS activityAt
         FROM jobs j
         LEFT JOIN workers w ON w.workerId = j.workerId
         WHERE j.status = 'claimed'
         ORDER BY activityAt ASC
         LIMIT ?`).all(maxRows);
    if (candidates.length === 0)
      return [];
    const now = new Date().toISOString();
    const recovered = [];
    const tx = this.db.transaction((rows) => {
      for (const row of rows) {
        const activityMs = parseIsoMs(row.activityAt) ?? parseIsoMs(row.jobUpdatedAt) ?? nowMs;
        const heartbeatMs = parseIsoMs(row.workerLastHeartbeat);
        const activityAgeMs = Math.max(0, nowMs - activityMs);
        const heartbeatAgeMs = heartbeatMs == null ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - heartbeatMs);
        const workerAligned = !!row.workerId && row.workerStatus === "busy" && row.workerCurrentJobId === row.jobId;
        const executionBudgetMs = typeof row.executionBudgetMs === "number" && Number.isFinite(row.executionBudgetMs) ? Math.max(5000, Math.floor(row.executionBudgetMs)) : JOB_EXECUTION_BUDGET_MS.normal;
        const finalizationBudgetMs = typeof row.finalizationBudgetMs === "number" && Number.isFinite(row.finalizationBudgetMs) ? Math.max(5000, Math.floor(row.finalizationBudgetMs)) : JOB_FINALIZATION_BUDGET_MS_DEFAULT;
        const combinedBudgetMs = executionBudgetMs + finalizationBudgetMs;
        const alignedGraceMs = Math.max(ttlMs, Math.min(combinedBudgetMs, ttlMs * 5));
        const heartbeatFreshForGrace = heartbeatMs != null && Number.isFinite(heartbeatMs) && !Number.isNaN(heartbeatMs) && heartbeatAgeMs <= ttlMs;
        const effectiveStaleAfterMs = workerAligned && heartbeatFreshForGrace ? alignedGraceMs : ttlMs;
        if (activityAgeMs < effectiveStaleAfterMs)
          continue;
        if (workerAligned && heartbeatAgeMs < effectiveStaleAfterMs)
          continue;
        const failureMessage = "Job auto-failed after stale worker claim";
        const abandonmentMessage = "Job auto-abandoned after stale worker claim";
        const detailParts = [
          row.workerId ? `worker=${row.workerId}` : "worker=missing",
          row.workerStatus ? `workerStatus=${row.workerStatus}` : "workerStatus=missing",
          row.workerCurrentJobId ? `workerCurrentJobId=${row.workerCurrentJobId}` : "workerCurrentJobId=missing",
          row.workerLastHeartbeat ? `lastHeartbeat=${row.workerLastHeartbeat}` : "lastHeartbeat=missing",
          row.lastLogTs ? `lastLogTs=${row.lastLogTs}` : "lastLogTs=none",
          `activityAt=${row.activityAt}`,
          `jobUpdatedAt=${row.jobUpdatedAt}`,
          `workerAligned=${workerAligned ? "yes" : "no"}`,
          `heartbeatFreshForGrace=${heartbeatFreshForGrace ? "yes" : "no"}`,
          `activityAgeMs=${activityAgeMs}`,
          `heartbeatAgeMs=${Number.isFinite(heartbeatAgeMs) ? heartbeatAgeMs : -1}`,
          `staleAfterMs=${ttlMs}`,
          `effectiveStaleAfterMs=${effectiveStaleAfterMs}`
        ];
        const detail = detailParts.join("; ");
        const recoveredItem = this.recoverClaimedJob(row.jobId, now, {
          expectedWorkerId: row.workerId,
          recoveryReason: "stale_worker_claim",
          failureMessage,
          abandonmentMessage,
          detail
        });
        if (!recoveredItem)
          continue;
        if (row.workerId) {
          const staleHeartbeat = heartbeatMs == null || !Number.isFinite(heartbeatMs) || Number.isNaN(heartbeatMs) || heartbeatMs < Date.parse(cutoff);
          const nextStatus = staleHeartbeat ? "offline" : "error";
          this.db.prepare(`UPDATE workers
               SET status = ?,
                   currentJobId = CASE WHEN currentJobId = ? THEN NULL ELSE currentJobId END,
                   updatedAt = ?
               WHERE workerId = ?`).run(nextStatus, row.jobId, now, row.workerId);
        }
        recovered.push(recoveredItem);
      }
    });
    tx(candidates);
    return recovered;
  }
  setWorkerIdleIfNoClaimedJobs(workerId, now) {
    if (!workerId)
      return;
    const active = this.db.prepare(`SELECT COUNT(*) AS c FROM jobs WHERE workerId = ? AND status = 'claimed'`).get(workerId);
    if ((active?.c ?? 0) > 0)
      return;
    this.db.prepare(`UPDATE workers SET status = 'idle', currentJobId = NULL, lastHeartbeat = ?, updatedAt = ?
         WHERE workerId = ?`).run(now, now, workerId);
  }
  setPrUrl(jobId, prUrl) {
    const normalizedPrUrl = typeof prUrl === "string" && prUrl.trim().length > 0 ? prUrl.trim() : null;
    if (!normalizedPrUrl) {
      return { ok: false, message: "prUrl is required" };
    }
    const now = new Date().toISOString();
    const info = this.db.prepare(`UPDATE jobs
         SET prUrl = COALESCE(?, prUrl),
             updatedAt = ?
         WHERE id = ?`).run(normalizedPrUrl, now, jobId);
    if (info.changes === 0) {
      return { ok: false, message: "Job not found" };
    }
    this.refreshPrWorkerAssignmentForJob(jobId, now);
    return { ok: true };
  }
  getJob(jobId) {
    return this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId) ?? null;
  }
  getPendingJobs() {
    return this.db.prepare(`SELECT * FROM jobs
         WHERE status = 'pending'
         ORDER BY
           CASE LOWER(priority)
             WHEN 'interactive' THEN 0
             WHEN 'normal' THEN 1
             WHEN 'background' THEN 2
             ELSE 1
           END ASC,
           createdAt ASC`).all();
  }
  listJobs(options) {
    const status = options?.status ?? "all";
    const limit = typeof options?.limit === "number" && Number.isFinite(options.limit) ? Math.max(1, Math.min(500, Math.floor(options.limit))) : 200;
    if (status === "all") {
      return this.db.prepare(`SELECT * FROM jobs ORDER BY createdAt DESC LIMIT ?`).all(limit);
    }
    return this.db.prepare(`SELECT * FROM jobs WHERE status = ? ORDER BY createdAt DESC LIMIT ?`).all(status, limit);
  }
  countByStatus() {
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS count FROM jobs GROUP BY status`).all();
    const counts = {
      pending: 0,
      claimed: 0,
      finalizing: 0,
      completed: 0,
      failed: 0,
      abandoned: 0,
      publish_blocked: 0
    };
    for (const row of rows) {
      if (row.status in counts)
        counts[row.status] = Number(row.count || 0);
    }
    return counts;
  }
  countByPriority() {
    const rows = this.db.prepare(`SELECT priority, COUNT(*) AS count
         FROM jobs
         WHERE status IN ('pending', 'claimed', 'finalizing')
         GROUP BY priority`).all();
    const counts = {
      interactive: 0,
      normal: 0,
      background: 0
    };
    for (const row of rows) {
      const priority = normalizeJobPriority(row.priority);
      counts[priority] = Number(row.count || 0);
    }
    return counts;
  }
  countByKindAndStatus(kind, statuses) {
    const normalizedKind = String(kind ?? "").trim();
    if (!normalizedKind)
      return 0;
    const requestedStatuses = Array.isArray(statuses) ? statuses : [statuses];
    const normalizedStatuses = [
      ...new Set(requestedStatuses.map((status) => String(status).trim()))
    ].filter((status) => status === "pending" || status === "claimed" || status === "finalizing" || status === "completed" || status === "failed" || status === "abandoned" || status === "publish_blocked");
    if (normalizedStatuses.length === 0)
      return 0;
    const placeholders = normalizedStatuses.map(() => "?").join(", ");
    const row = this.db.prepare(`SELECT COUNT(*) AS count
         FROM jobs
         WHERE kind = ?
           AND status IN (${placeholders})`).get(normalizedKind, ...normalizedStatuses);
    return Number(row?.count || 0);
  }
  countAutoscalablePendingByKind(kind) {
    const normalizedKind = String(kind ?? "").trim();
    if (!normalizedKind)
      return 0;
    const now = new Date().toISOString();
    const targetWorkerCutoff = new Date(Date.now() - PR_WORKER_ASSIGNMENT_MAX_AGE_MS).toISOString();
    const row = this.db.prepare(`SELECT COUNT(*) AS count
         FROM jobs
         WHERE kind = ?
           AND status = 'pending'
           AND (
             availableAt IS NULL
             OR availableAt <= ?
             OR (
               targetWorkerId IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1
                 FROM workers tw
                 WHERE tw.workerId = jobs.targetWorkerId
                   AND COALESCE(tw.status, 'idle') <> 'offline'
                   AND tw.lastHeartbeat >= ?
               )
             )
           )
           AND (
             targetWorkerId IS NULL
             OR NOT EXISTS (
               SELECT 1
               FROM workers tw
               WHERE tw.workerId = jobs.targetWorkerId
                 AND COALESCE(tw.status, 'idle') <> 'offline'
                 AND tw.lastHeartbeat >= ?
             )
           )`).get(normalizedKind, now, targetWorkerCutoff, targetWorkerCutoff);
    return Number(row?.count || 0);
  }
  listWorkerPrBacklog(limit = 200) {
    const maxRows = Number.isFinite(limit) ? Math.max(1, Math.min(2000, Math.floor(limit))) : 200;
    const scanRows = Math.max(50, maxRows * 8);
    const latestJobs = new Map;
    const jobRows = this.db.prepare(`SELECT
           id,
           prUrl,
           status,
           COALESCE(completedAt, failedAt, updatedAt, createdAt) AS latestJobAt
         FROM jobs
         WHERE prUrl IS NOT NULL
           AND TRIM(prUrl) <> ''
         ORDER BY latestJobAt DESC
         LIMIT ?`).all(scanRows);
    for (const row of jobRows) {
      const normalizedPrUrl = normalizePrUrl(row.prUrl);
      if (!normalizedPrUrl || latestJobs.has(normalizedPrUrl))
        continue;
      latestJobs.set(normalizedPrUrl, {
        prUrl: String(row.prUrl ?? "").trim(),
        latestJobId: row.id,
        latestJobStatus: row.status,
        latestJobAt: row.latestJobAt
      });
      if (latestJobs.size >= maxRows)
        break;
    }
    const latestFeedbackByPr = new Map;
    try {
      const feedbackRows = this.db.prepare(`SELECT pr_url AS prUrl, verdict, created_at AS createdAt
           FROM autonomy_pr_feedback
           WHERE pr_url IS NOT NULL
             AND TRIM(pr_url) <> ''
           ORDER BY created_at DESC
           LIMIT ?`).all(Math.max(200, maxRows * 12));
      for (const row of feedbackRows) {
        const normalizedPrUrl = normalizePrUrl(row.prUrl);
        if (!normalizedPrUrl || latestFeedbackByPr.has(normalizedPrUrl))
          continue;
        latestFeedbackByPr.set(normalizedPrUrl, {
          verdict: row.verdict ? String(row.verdict).trim() : null,
          createdAt: row.createdAt ? String(row.createdAt).trim() : null
        });
      }
    } catch {}
    const entries = [];
    for (const [normalizedPrUrl, job] of latestJobs.entries()) {
      const feedback = latestFeedbackByPr.get(normalizedPrUrl);
      const latestFeedbackVerdict = feedback?.verdict ?? null;
      const mergeState = isMergedPrFeedbackVerdict(latestFeedbackVerdict) ? "merged" : isClosedPrFeedbackVerdict(latestFeedbackVerdict) ? "closed_unmerged" : "open_unmerged";
      entries.push({
        prUrl: job.prUrl,
        normalizedPrUrl,
        latestJobId: job.latestJobId,
        latestJobStatus: job.latestJobStatus,
        latestJobAt: job.latestJobAt,
        latestFeedbackVerdict,
        latestFeedbackAt: feedback?.createdAt ?? null,
        mergeState
      });
    }
    return entries.slice(0, maxRows);
  }
  countOpenUnmergedWorkerPrs(limit = 500) {
    return this.listWorkerPrBacklog(limit).filter((entry) => entry.mergeState === "open_unmerged").length;
  }
  nextPendingSnapshot(limit = 10) {
    const ordered = this.pendingOrderedIds().slice(0, Math.max(1, Math.min(limit, 50)));
    return ordered.map((id, idx) => {
      const row = this.db.prepare(`SELECT priority FROM jobs WHERE id = ?`).get(id);
      const priority = normalizeJobPriority(row?.priority);
      return {
        id,
        priority,
        position: idx + 1,
        etaMs: this.estimateEtaMs(priority, idx + 1) ?? 0
      };
    });
  }
  sloSummary(windowHours = 24) {
    const boundedWindowHours = Number.isFinite(windowHours) && windowHours > 0 ? Math.max(1, Math.min(24 * 30, Math.floor(windowHours))) : 24;
    const cutoffIso = new Date(Date.now() - boundedWindowHours * 60 * 60 * 1000).toISOString();
    const rows = this.db.prepare(`SELECT status, durationMs, enqueuedAt, claimedAt, createdAt, updatedAt, error
         FROM jobs
         WHERE status IN ('completed', 'failed', 'abandoned', 'publish_blocked')
           AND updatedAt >= ?`).all(cutoffIso);
    let completed = 0;
    let failed = 0;
    let abandoned = 0;
    let publishBlocked = 0;
    let timeoutFailures = 0;
    const durationSamples = [];
    const queueWaitSamples = [];
    for (const row of rows) {
      if (row.status === "completed")
        completed += 1;
      if (row.status === "failed" || row.status === "abandoned" || row.status === "publish_blocked") {
        if (row.status === "failed")
          failed += 1;
        if (row.status === "abandoned")
          abandoned += 1;
        if (row.status === "publish_blocked")
          publishBlocked += 1;
        if (isTimeoutFailureError(row.error))
          timeoutFailures += 1;
      }
      if (typeof row.durationMs === "number" && Number.isFinite(row.durationMs) && row.durationMs >= 0) {
        durationSamples.push(Math.round(row.durationMs));
      }
      const queueStart = parseIsoMs(row.enqueuedAt) ?? parseIsoMs(row.createdAt) ?? null;
      const queueEnd = parseIsoMs(row.claimedAt) ?? parseIsoMs(row.updatedAt) ?? null;
      if (queueStart != null && queueEnd != null && queueEnd >= queueStart) {
        queueWaitSamples.push(queueEnd - queueStart);
      }
    }
    const terminal = completed + failed + abandoned + publishBlocked;
    const successRate = terminal > 0 ? Number((completed / terminal).toFixed(4)) : null;
    const timeoutRate = terminal > 0 ? Number((timeoutFailures / terminal).toFixed(4)) : null;
    return {
      windowHours: boundedWindowHours,
      terminal,
      completed,
      failed,
      abandoned,
      publishBlocked,
      timeoutFailures,
      successRate,
      timeoutRate,
      durationMs: summarizeSamples(durationSamples),
      queueWaitMs: summarizeSamples(queueWaitSamples)
    };
  }
  noPublishableFailureCircuitSummary(options) {
    const windowMs = Math.max(60000, Math.min(24 * 60 * 60 * 1000, Math.floor(options?.windowMs ?? 60 * 60 * 1000)));
    const threshold = Math.max(1, Math.min(100, Math.floor(options?.threshold ?? 3)));
    const failureRateThreshold = Math.max(0, Math.min(1, Number(options?.failureRateThreshold ?? 0.5)));
    const cutoffIso = new Date(Date.now() - windowMs).toISOString();
    const row = this.db.prepare(`SELECT
           COUNT(*) AS terminalCount,
           SUM(CASE WHEN j.status = 'completed' THEN 1 ELSE 0 END) AS completedCount,
           SUM(
             CASE
               WHEN j.status = 'failed'
                AND NOT (
                  d.failureClass = 'codex_startup_stall'
                  OR d.summary LIKE '%stalled before first response%'
                  OR d.summary LIKE '%startup stall%'
                  OR EXISTS (
                    SELECT 1
                    FROM job_attempts a
                    WHERE a.jobId = j.id
                      AND (
                        a.terminalReason LIKE '%stalled before first response%'
                        OR a.terminalReason LIKE '%startup stall%'
                      )
                  )
                )
                AND (
                  d.failureClass = 'artifact_only_no_publishable_patch'
                  OR d.summary LIKE '%no publishable changes%'
                  OR d.summary LIKE '%no publishable file changes%'
                  OR d.summary LIKE '%no-edit watchdog%'
                  OR EXISTS (
                    SELECT 1
                    FROM job_attempts a
                    WHERE a.jobId = j.id
                      AND (
                        a.terminalReason LIKE '%no publishable changes%'
                        OR a.terminalReason LIKE '%no publishable file changes%'
                        OR a.terminalReason LIKE '%no-edit watchdog%'
                      )
                  )
                )
               THEN 1
               ELSE 0
             END
           ) AS noPublishableFailureCount,
           MAX(
             CASE
               WHEN j.status = 'failed'
                AND NOT (
                  d.failureClass = 'codex_startup_stall'
                  OR d.summary LIKE '%stalled before first response%'
                  OR d.summary LIKE '%startup stall%'
                  OR EXISTS (
                    SELECT 1
                    FROM job_attempts a
                    WHERE a.jobId = j.id
                      AND (
                        a.terminalReason LIKE '%stalled before first response%'
                        OR a.terminalReason LIKE '%startup stall%'
                      )
                  )
                )
                AND (
                  d.failureClass = 'artifact_only_no_publishable_patch'
                  OR d.summary LIKE '%no publishable changes%'
                  OR d.summary LIKE '%no publishable file changes%'
                  OR d.summary LIKE '%no-edit watchdog%'
                  OR EXISTS (
                    SELECT 1
                    FROM job_attempts a
                    WHERE a.jobId = j.id
                      AND (
                        a.terminalReason LIKE '%no publishable changes%'
                        OR a.terminalReason LIKE '%no publishable file changes%'
                        OR a.terminalReason LIKE '%no-edit watchdog%'
                      )
                  )
                )
               THEN COALESCE(j.failedAt, d.updatedAt, j.updatedAt)
               ELSE NULL
             END
           ) AS lastFailureAt
         FROM jobs j
         LEFT JOIN job_terminal_diagnostics d ON d.jobId = j.id
         WHERE j.kind = 'task.execute'
           AND j.status IN ('completed', 'failed', 'abandoned', 'publish_blocked')
           AND j.updatedAt >= ?`).get(cutoffIso);
    const terminalCount = Math.max(0, Number(row?.terminalCount ?? 0));
    const noPublishableFailureCount = Math.max(0, Number(row?.noPublishableFailureCount ?? 0));
    const completedCount = Math.max(0, Number(row?.completedCount ?? 0));
    const noPublishableFailureRate = terminalCount > 0 ? Number((noPublishableFailureCount / terminalCount).toFixed(4)) : 0;
    return {
      blocked: noPublishableFailureCount >= threshold && noPublishableFailureRate >= failureRateThreshold,
      windowMs,
      threshold,
      failureRateThreshold,
      terminalCount,
      noPublishableFailureCount,
      noPublishableFailureRate,
      completedCount,
      lastFailureAt: row?.lastFailureAt ?? null
    };
  }
  similarNoPublishableFailureSummary(options) {
    const windowMs = Math.max(60000, Math.min(24 * 60 * 60 * 1000, Math.floor(options?.windowMs ?? 6 * 60 * 60 * 1000)));
    const threshold = Math.max(1, Math.min(20, Math.floor(options?.threshold ?? 2)));
    const patternKey = String(options?.patternKey ?? "").trim() || null;
    const targetPaths = normalizedJobPathList(options?.targetPaths ?? []);
    const base = {
      blocked: false,
      windowMs,
      threshold,
      recentSimilarFailureCount: 0,
      patternKey,
      targetPathSample: targetPaths.slice(0, 8),
      lastFailureAt: null
    };
    if (!patternKey && targetPaths.length === 0)
      return base;
    const cutoffIso = new Date(Date.now() - windowMs).toISOString();
    const rows = this.db.prepare(`SELECT j.id, j.params, j.failedAt, j.updatedAt
         FROM jobs j
         LEFT JOIN job_terminal_diagnostics d ON d.jobId = j.id
         WHERE j.kind = 'task.execute'
           AND j.status = 'failed'
           AND j.updatedAt >= ?
           AND NOT (
             d.failureClass = 'codex_startup_stall'
             OR d.summary LIKE '%stalled before first response%'
             OR d.summary LIKE '%startup stall%'
             OR EXISTS (
               SELECT 1
               FROM job_attempts a
               WHERE a.jobId = j.id
                 AND (
                   a.terminalReason LIKE '%stalled before first response%'
                   OR a.terminalReason LIKE '%startup stall%'
                 )
             )
           )
           AND (
             d.failureClass = 'artifact_only_no_publishable_patch'
             OR d.summary LIKE '%no publishable changes%'
             OR d.summary LIKE '%no publishable file changes%'
             OR d.summary LIKE '%no-edit watchdog%'
             OR EXISTS (
               SELECT 1
               FROM job_attempts a
               WHERE a.jobId = j.id
                 AND (
                   a.terminalReason LIKE '%no publishable changes%'
                   OR a.terminalReason LIKE '%no publishable file changes%'
                   OR a.terminalReason LIKE '%no-edit watchdog%'
                 )
             )
           )
         ORDER BY j.updatedAt DESC
         LIMIT 250`).all(cutoffIso);
    let count = 0;
    let lastFailureAt = null;
    for (const row of rows) {
      const params = parseObjectJson(row.params);
      const autonomy = recordFromUnknown(params.autonomy);
      const origin = String(params.origin ?? autonomy?.origin ?? "").trim().toLowerCase();
      if (origin !== "autonomy")
        continue;
      const previousPatternKey = String(autonomy?.patternKey ?? autonomy?.pattern_key ?? "").trim();
      const planning = recordFromUnknown(params.planning);
      const previousPaths = [
        ...normalizedJobPathValues(params.path, params.targetPath, params.target_path, params.paths),
        ...normalizedJobPathValues(planning?.targetPath, planning?.target_path, planning?.targetPaths, planning?.target_paths),
        ...normalizedJobPathValues(autonomy?.targetPath, autonomy?.target_path, autonomy?.targetPaths, autonomy?.target_paths)
      ];
      const patternMatches = Boolean(patternKey && previousPatternKey === patternKey);
      const pathMatches = targetPaths.length > 0 && previousPaths.length > 0 && jobPathOverlaps(targetPaths, previousPaths);
      if (!patternMatches && !pathMatches)
        continue;
      count += 1;
      const failureAt = row.failedAt ?? row.updatedAt ?? null;
      if (failureAt && (!lastFailureAt || Date.parse(failureAt) > Date.parse(lastFailureAt))) {
        lastFailureAt = failureAt;
      }
    }
    return {
      ...base,
      blocked: count >= threshold,
      recentSimilarFailureCount: count,
      lastFailureAt
    };
  }
  similarFailureFingerprintSummary(options) {
    const windowMs = Math.max(60000, Math.min(24 * 60 * 60 * 1000, Math.floor(options?.windowMs ?? 6 * 60 * 60 * 1000)));
    const threshold = Math.max(2, Math.min(20, Math.floor(options?.threshold ?? 2)));
    const targetPaths = normalizedJobPathList(options?.targetPaths ?? []);
    const empty = {
      blocked: false,
      windowMs,
      threshold,
      recentSimilarFailureCount: 0,
      fingerprint: null,
      targetPathSample: targetPaths.slice(0, 8),
      failureClass: null,
      command: null,
      failedTestSample: [],
      lastFailureAt: null
    };
    if (targetPaths.length === 0)
      return empty;
    const cutoffIso = new Date(Date.now() - windowMs).toISOString();
    const rows = this.db.prepare(`SELECT
           j.id,
           j.params,
           j.error,
           COALESCE(j.failedAt, j.publishBlockedAt, j.abandonedAt, j.updatedAt) AS failureAt,
           d.failureClass,
           d.summary,
           (
             SELECT v.command
             FROM job_validation_runs v
             WHERE v.jobId = j.id AND v.passed = 0
             ORDER BY v.id DESC
             LIMIT 1
           ) AS command,
           (
             SELECT v.failureClass
             FROM job_validation_runs v
             WHERE v.jobId = j.id AND v.passed = 0
             ORDER BY v.id DESC
             LIMIT 1
           ) AS validationFailureClass,
           (
             SELECT v.stdoutTail
             FROM job_validation_runs v
             WHERE v.jobId = j.id AND v.passed = 0
             ORDER BY v.id DESC
             LIMIT 1
           ) AS stdoutTail,
           (
             SELECT v.stderrTail
             FROM job_validation_runs v
             WHERE v.jobId = j.id AND v.passed = 0
             ORDER BY v.id DESC
             LIMIT 1
           ) AS stderrTail
         FROM jobs j
         LEFT JOIN job_terminal_diagnostics d ON d.jobId = j.id
         WHERE j.kind = 'task.execute'
           AND j.status IN ('failed', 'abandoned', 'publish_blocked')
           AND COALESCE(j.failedAt, j.publishBlockedAt, j.abandonedAt, j.updatedAt) >= ?
         ORDER BY j.updatedAt DESC
         LIMIT 300`).all(cutoffIso);
    const clusters = new Map;
    for (const row of rows) {
      const params = parseObjectJson(row.params);
      const autonomy = recordFromUnknown(params.autonomy);
      const origin = String(params.origin ?? autonomy?.origin ?? "").trim().toLowerCase();
      if (origin !== "autonomy")
        continue;
      const planning = recordFromUnknown(params.planning);
      const previousPaths = [
        ...normalizedJobPathValues(params.path, params.targetPath, params.target_path, params.paths),
        ...normalizedJobPathValues(planning?.targetPath, planning?.target_path, planning?.targetPaths, planning?.target_paths),
        ...normalizedJobPathValues(autonomy?.targetPath, autonomy?.target_path, autonomy?.targetPaths, autonomy?.target_paths)
      ];
      const uniquePreviousPaths = [...new Set(previousPaths)].sort();
      if (uniquePreviousPaths.length === 0 || !jobPathOverlaps(targetPaths, uniquePreviousPaths)) {
        continue;
      }
      const fingerprintTargetPaths = overlappingFailureTargetPaths(targetPaths, uniquePreviousPaths);
      if (fingerprintTargetPaths.length === 0)
        continue;
      const command = normalizeFailureCommand(row.command) || nestedFailureCommand(row.error);
      const failureClass = String(failureClassFromEvidence(row.error) ?? row.validationFailureClass ?? row.failureClass ?? "unknown_failure").trim().toLowerCase();
      const nestedFailedTests = nestedFailedTestSample(row.error);
      const failedTests = nestedFailedTests.length > 0 ? nestedFailedTests : extractFailedTestSample(row.stdoutTail, row.stderrTail, row.summary, jobFailureText(row.error));
      const fingerprint2 = failureFingerprint({
        targetPaths: fingerprintTargetPaths,
        failureClass,
        command,
        failedTests
      });
      const previous = clusters.get(fingerprint2);
      const lastFailureAt = row.failureAt && (!previous?.lastFailureAt || Date.parse(row.failureAt) > Date.parse(previous.lastFailureAt)) ? row.failureAt : previous?.lastFailureAt ?? null;
      clusters.set(fingerprint2, {
        count: (previous?.count ?? 0) + 1,
        failureClass,
        command,
        failedTests,
        targetPaths: fingerprintTargetPaths,
        lastFailureAt
      });
    }
    const dominant = [...clusters.entries()].sort((left, right) => {
      if (right[1].count !== left[1].count)
        return right[1].count - left[1].count;
      return Date.parse(right[1].lastFailureAt ?? "") - Date.parse(left[1].lastFailureAt ?? "");
    })[0];
    if (!dominant)
      return empty;
    const [fingerprint, cluster] = dominant;
    return {
      ...empty,
      blocked: cluster.count >= threshold,
      recentSimilarFailureCount: cluster.count,
      fingerprint,
      targetPathSample: cluster.targetPaths.slice(0, 8),
      failureClass: cluster.failureClass || null,
      command: cluster.command || null,
      failedTestSample: cluster.failedTests.slice(0, 8),
      lastFailureAt: cluster.lastFailureAt
    };
  }
  addLog(jobId, message, ts) {
    const now = coerceIsoTimestamp(ts) ?? new Date().toISOString();
    let insertedId = null;
    const tx = this.db.transaction(() => {
      const insertInfo = this.db.prepare(`INSERT INTO job_logs (jobId, ts, message) VALUES (?, ?, ?)`).run(jobId, now, message);
      const rawId = insertInfo.lastInsertRowid;
      if (typeof rawId === "bigint")
        insertedId = Number(rawId);
      else if (typeof rawId === "number" && Number.isFinite(rawId))
        insertedId = rawId;
      this.db.prepare(`UPDATE jobs
           SET updatedAt = ?,
               startedAt = COALESCE(startedAt, ?),
               firstLogAt = COALESCE(firstLogAt, ?)
           WHERE id = ? AND status = 'claimed'`).run(now, now, now, jobId);
    });
    tx();
    return insertedId;
  }
  listJobLogs(jobId, limit = 50, afterId) {
    const maxRows = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 50;
    if (Number.isFinite(afterId) && afterId > 0) {
      return this.db.prepare(`SELECT id, jobId, ts, message
           FROM job_logs
           WHERE jobId = ? AND id > ?
           ORDER BY id ASC
           LIMIT ?`).all(jobId, Math.floor(afterId), maxRows);
    }
    const rows = this.db.prepare(`SELECT id, jobId, ts, message
         FROM job_logs
         WHERE jobId = ?
         ORDER BY id DESC
         LIMIT ?`).all(jobId, maxRows);
    return rows.reverse();
  }
  recordToolRun(body) {
    const now = new Date().toISOString();
    const id = compactDbText(body.id, 128) ?? randomUUID2();
    const jobId = compactDbText(body.jobId, 128);
    const workerId = compactDbText(body.workerId, 128);
    const sessionId = compactDbText(body.sessionId, 128);
    const phase = compactDbText(body.phase, 128);
    const capability = compactDbText(body.capability, 128);
    const envProfile = compactDbText(body.envProfile, 128);
    const cwd = compactDbText(body.cwd, 1000);
    const argv = Array.isArray(body.argv) ? body.argv.map((arg) => String(arg ?? "").trim()).filter(Boolean).slice(0, 80) : [];
    const commandLine = compactDbText(body.commandLine, 2000);
    const allowedEffects = Array.isArray(body.allowedEffects) ? body.allowedEffects.map((entry) => String(entry ?? "").trim()).filter((entry) => ["read", "write", "network", "git", "process"].includes(entry)) : [];
    const ok = boolFromUnknown(body.ok);
    const exitCodeRaw = Number(body.exitCode);
    const exitCode = Number.isFinite(exitCodeRaw) ? Math.trunc(exitCodeRaw) : null;
    const stdoutTail = truncateToolText(redactToolText(body.stdoutTail ?? body.stdout), 8000);
    const stderrTail = truncateToolText(redactToolText(body.stderrTail ?? body.stderr ?? body.detail), 8000);
    const tool = inferToolNameFromFailureText({
      tool: normalizeToolName(body.tool ?? "shell"),
      argv,
      commandLine,
      stdout: stdoutTail,
      stderr: stderrTail,
      summary: body.summary,
      detail: body.detail,
      exitCode,
      timedOut: boolFromUnknown(body.timedOut)
    });
    const kindRaw = compactDbText(body.kind, 32);
    const kind = kindRaw === "known" || kindRaw === "discovered" || kindRaw === "shell" ? kindRaw : resolveToolKind(tool);
    const classification = ok ? null : classifyToolFailure({
      tool,
      argv,
      commandLine,
      stdout: stdoutTail,
      stderr: stderrTail,
      summary: body.summary,
      detail: body.detail,
      exitCode,
      timedOut: boolFromUnknown(body.timedOut)
    });
    const clientFailureClass = normalizeToolFailureClass(body.failureClass);
    const serverFailureClass = classification?.failureClass ?? "unknown";
    const acceptsClientFailureClass = shouldAcceptClientToolFailureClass(serverFailureClass, clientFailureClass);
    const failureClass = ok ? null : acceptsClientFailureClass ? clientFailureClass : serverFailureClass;
    const retryable = ok ? false : failureClass === clientFailureClass && body.retryable !== undefined && body.retryable !== null && acceptsClientFailureClass ? boolFromUnknown(body.retryable) : classification?.retryable ?? false;
    const clientRemediation = compactDbText(body.remediation, 1000);
    const remediation = ok || failureClass === clientFailureClass && acceptsClientFailureClass ? clientRemediation ?? classification?.remediation ?? null : classification?.remediation ?? clientRemediation ?? null;
    const finishedAt = coerceIsoTimestamp(body.finishedAt) ?? now;
    const startedAt = coerceIsoTimestamp(body.startedAt) ?? finishedAt;
    const durationRaw = Number(body.durationMs);
    const durationMs = Number.isFinite(durationRaw) && durationRaw >= 0 ? Math.min(Math.trunc(durationRaw), 86400000) : 0;
    const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata) ? sanitizeToolRunMetadata(body.metadata) : {};
    try {
      this.db.prepare(`INSERT OR REPLACE INTO tool_runs (
            id, jobId, workerId, sessionId, phase, tool, kind, capability, envProfile, cwd,
            argvJson, commandLine, allowedEffectsJson, ok, exitCode, failureClass, retryable,
            remediation, startedAt, finishedAt, durationMs, stdoutTail, stderrTail, metadataJson, createdAt
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, jobId, workerId, sessionId, phase, tool, kind, capability, envProfile, cwd, JSON.stringify(argv), commandLine, JSON.stringify(allowedEffects), ok ? 1 : 0, exitCode, failureClass, retryable ? 1 : 0, remediation, startedAt, finishedAt, durationMs, stdoutTail || null, stderrTail || null, JSON.stringify(metadata), now);
      return { ok: true, id };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }
  listJobToolRuns(jobId, limit = 50) {
    const maxRows = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 50;
    const rows = this.db.prepare(`SELECT *
         FROM tool_runs
         WHERE jobId = ?
         ORDER BY finishedAt DESC, createdAt DESC
         LIMIT ?`).all(jobId, maxRows);
    return rows.map((row) => ({
      id: row.id,
      jobId: row.jobId,
      workerId: row.workerId,
      sessionId: row.sessionId,
      phase: row.phase,
      tool: row.tool,
      kind: row.kind,
      capability: row.capability,
      envProfile: row.envProfile,
      cwd: row.cwd,
      argv: parseStringArrayJson(row.argvJson),
      commandLine: row.commandLine,
      allowedEffects: parseToolEffectsJson(row.allowedEffectsJson),
      ok: row.ok === 1,
      exitCode: row.exitCode,
      failureClass: row.failureClass,
      retryable: row.retryable === 1,
      remediation: row.remediation,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      durationMs: row.durationMs,
      stdoutTail: row.stdoutTail,
      stderrTail: row.stderrTail,
      metadata: parseObjectJson(row.metadataJson)
    }));
  }
  getJobDiagnostics(jobId) {
    const terminal = this.db.prepare(`SELECT * FROM job_terminal_diagnostics WHERE jobId = ?`).get(jobId);
    const attempts = this.db.prepare(`SELECT *
         FROM job_attempts
         WHERE jobId = ?
         ORDER BY attempt ASC, id ASC`).all(jobId);
    const phaseSpans = this.db.prepare(`SELECT *
         FROM job_phase_spans
         WHERE jobId = ?
         ORDER BY startedAt ASC, id ASC`).all(jobId);
    const validationRuns = this.db.prepare(`SELECT *
         FROM job_validation_runs
         WHERE jobId = ?
         ORDER BY id ASC`).all(jobId);
    const patchSnapshots = this.db.prepare(`SELECT *
         FROM job_patch_snapshots
         WHERE jobId = ?
         ORDER BY capturedAt ASC, id ASC`).all(jobId);
    return {
      terminal: terminal ? {
        status: terminal.status,
        failureClass: terminal.failureClass,
        terminalStage: terminal.terminalStage,
        executorBackend: terminal.executorBackend,
        summary: terminal.summary,
        watchdogFired: terminal.watchdogFired === 1,
        timeoutMs: terminal.timeoutMs,
        publishableFileCount: terminal.publishableFileCount,
        artifactOnlyPathCount: terminal.artifactOnlyPathCount,
        changedPathSample: parseJsonArray(terminal.changedPathSampleJson),
        metadata: parseObjectJson(terminal.metadataJson),
        createdAt: terminal.createdAt,
        updatedAt: terminal.updatedAt
      } : null,
      attempts: attempts.map((row) => ({
        attempt: row.attempt,
        workerId: row.workerId,
        backend: row.backend,
        model: row.model,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        durationMs: row.durationMs,
        terminalReason: row.terminalReason,
        exitCode: row.exitCode,
        metadata: parseObjectJson(row.metadataJson),
        createdAt: row.createdAt
      })),
      phaseSpans: phaseSpans.map((row) => ({
        attempt: row.attempt,
        phase: row.phase,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        durationMs: row.durationMs,
        outcome: row.outcome,
        metadata: parseObjectJson(row.metadataJson),
        createdAt: row.createdAt
      })),
      validationRuns: validationRuns.map((row) => ({
        attempt: row.attempt,
        command: row.command,
        exitCode: row.exitCode,
        durationMs: row.durationMs,
        passed: row.passed === 1,
        failureClass: row.failureClass,
        stdoutTail: row.stdoutTail,
        stderrTail: row.stderrTail,
        metadata: parseObjectJson(row.metadataJson),
        createdAt: row.createdAt
      })),
      patchSnapshots: patchSnapshots.map((row) => ({
        attempt: row.attempt,
        phase: row.phase,
        publishableFileCount: row.publishableFileCount,
        artifactOnlyPathCount: row.artifactOnlyPathCount,
        changedPathSample: parseJsonArray(row.changedPathSampleJson),
        topLevelDirs: parseJsonArray(row.topLevelDirsJson),
        capturedAt: row.capturedAt,
        metadata: parseObjectJson(row.metadataJson),
        createdAt: row.createdAt
      }))
    };
  }
  saveJobDiagnostics(jobId, body) {
    const row = this.db.prepare(`SELECT status FROM jobs WHERE id = ?`).get(jobId);
    if (!row)
      return { ok: false, message: "Job not found" };
    this.recordJobDiagnostics(jobId, body, row.status, new Date().toISOString());
    const diagnostics = this.getJobDiagnostics(jobId);
    return {
      ok: true,
      counts: {
        attempts: Array.isArray(diagnostics.attempts) ? diagnostics.attempts.length : 0,
        phaseSpans: Array.isArray(diagnostics.phaseSpans) ? diagnostics.phaseSpans.length : 0,
        validationRuns: Array.isArray(diagnostics.validationRuns) ? diagnostics.validationRuns.length : 0,
        patchSnapshots: Array.isArray(diagnostics.patchSnapshots) ? diagnostics.patchSnapshots.length : 0
      }
    };
  }
  close() {
    this.db.close();
  }
}

// apps/server/src/requests.ts
import { Database as Database3 } from "bun:sqlite";
import { randomUUID as randomUUID3 } from "crypto";
var PRIORITY_SLA_MS = {
  interactive: 20000,
  normal: 90000,
  background: 240000
};
function normalizePriority(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "interactive" || text === "background")
    return text;
  return "normal";
}
function parseBudgetMs2(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0)
    return fallback;
  return Math.max(1000, parsed);
}
function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return null;
  return value;
}
function asString2(value) {
  return String(value ?? "").trim();
}
function asStringArray2(value) {
  if (!Array.isArray(value))
    return [];
  return value.map((entry) => asString2(entry)).filter(Boolean);
}
function parseMetadataJson(raw) {
  if (!raw)
    return;
  try {
    const parsed = JSON.parse(raw);
    const obj = asObject(parsed);
    return obj ?? undefined;
  } catch {
    return;
  }
}
function isAutonomyMetadata(metadata) {
  return asString2(metadata?.origin).toLowerCase() === "autonomy";
}
function sanitizeRequestMetadata(input) {
  const record = asObject(input);
  if (!record)
    return { metadata: null };
  const origin = asString2(record.origin).toLowerCase();
  if (origin !== "autonomy")
    return { metadata: null };
  const autonomy = asObject(record.autonomy);
  if (!autonomy) {
    return { metadata: null, error: "metadata.autonomy object is required for origin=autonomy" };
  }
  const componentAreaRaw = asString2(autonomy.componentArea ?? autonomy.component_area);
  const componentArea = normalizeAutonomyComponentArea(componentAreaRaw);
  const targetPathsRaw = asStringArray2(autonomy.targetPaths ?? autonomy.target_paths);
  const writeGlobsRaw = asStringArray2(autonomy.writeGlobs ?? autonomy.write_globs);
  const scope = validateScopeInvariants(componentArea, targetPathsRaw, writeGlobsRaw, { requireWriteGlobs: true, hintsOnly: true });
  if (!scope.ok) {
    return {
      metadata: null,
      error: `autonomy metadata scope invalid: ${scope.errors.join("; ")}`
    };
  }
  return {
    metadata: {
      origin: "autonomy",
      autonomy: {
        objectiveId: asString2(autonomy.objectiveId ?? autonomy.objective_id),
        runId: asString2(autonomy.runId ?? autonomy.run_id),
        snapshotId: asString2(autonomy.snapshotId ?? autonomy.snapshot_id),
        patternKey: asString2(autonomy.patternKey ?? autonomy.pattern_key),
        componentArea: scope.componentArea ?? componentAreaRaw,
        targetPaths: scope.normalizedTargetPaths,
        writeGlobs: scope.normalizedWriteGlobs
      }
    }
  };
}
function parseIsoMs2(value) {
  if (!value)
    return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
function percentile2(values, p) {
  if (values.length === 0)
    return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1));
  const value = sorted[rank];
  return Number.isFinite(value) ? value : null;
}
function summarizeSamples2(samples) {
  const valid = samples.filter((value) => Number.isFinite(value) && value >= 0);
  if (valid.length === 0) {
    return { p50: null, p95: null, avg: null, sampleSize: 0 };
  }
  const avg = Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length);
  return {
    p50: percentile2(valid, 50),
    p95: percentile2(valid, 95),
    avg: Number.isFinite(avg) ? avg : null,
    sampleSize: valid.length
  };
}

class RequestQueue {
  db;
  static SELECT_COLUMNS = `
    id,
    sessionId,
    prompt,
    priority,
    queueWaitBudgetMs,
    metadataJson,
    idempotencyKey,
    forceWorker,
    forceLane,
    status,
    agentId,
    result,
    error,
    enqueuedAt,
    claimedAt,
    completedAt,
    failedAt,
    durationMs,
    createdAt,
    updatedAt
  `;
  constructor(dbPath = ":memory:") {
    this.db = new Database3(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this._migrate();
  }
  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id               TEXT PRIMARY KEY,
        sessionId        TEXT NOT NULL,
        prompt           TEXT NOT NULL,
        priority         TEXT NOT NULL DEFAULT 'normal',
        queueWaitBudgetMs INTEGER NOT NULL DEFAULT 90000,
        metadataJson     TEXT,
        idempotencyKey   TEXT,
        forceWorker      INTEGER NOT NULL DEFAULT 0,
        forceLane        TEXT,
        status           TEXT NOT NULL DEFAULT 'pending',
        agentId          TEXT,
        result           TEXT,
        error            TEXT,
        enqueuedAt       TEXT,
        claimedAt        TEXT,
        completedAt      TEXT,
        failedAt         TEXT,
        durationMs       INTEGER,
        createdAt        TEXT NOT NULL,
        updatedAt        TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
      CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(sessionId);
    `);
    const columns = this.db.prepare(`PRAGMA table_info(requests)`).all();
    const ensureColumn = (name, sql) => {
      if (!columns.some((col) => col.name === name))
        this.db.exec(sql);
    };
    ensureColumn("prompt", `ALTER TABLE requests ADD COLUMN prompt TEXT NOT NULL DEFAULT '';`);
    ensureColumn("priority", `ALTER TABLE requests ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';`);
    ensureColumn("queueWaitBudgetMs", `ALTER TABLE requests ADD COLUMN queueWaitBudgetMs INTEGER NOT NULL DEFAULT 90000;`);
    ensureColumn("metadataJson", `ALTER TABLE requests ADD COLUMN metadataJson TEXT;`);
    ensureColumn("idempotencyKey", `ALTER TABLE requests ADD COLUMN idempotencyKey TEXT;`);
    ensureColumn("forceWorker", `ALTER TABLE requests ADD COLUMN forceWorker INTEGER NOT NULL DEFAULT 0;`);
    ensureColumn("forceLane", `ALTER TABLE requests ADD COLUMN forceLane TEXT;`);
    ensureColumn("enqueuedAt", `ALTER TABLE requests ADD COLUMN enqueuedAt TEXT;`);
    ensureColumn("claimedAt", `ALTER TABLE requests ADD COLUMN claimedAt TEXT;`);
    ensureColumn("completedAt", `ALTER TABLE requests ADD COLUMN completedAt TEXT;`);
    ensureColumn("failedAt", `ALTER TABLE requests ADD COLUMN failedAt TEXT;`);
    ensureColumn("durationMs", `ALTER TABLE requests ADD COLUMN durationMs INTEGER;`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_requests_priority_created ON requests(status, priority, createdAt);`);
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_idempotency
         ON requests(idempotencyKey)
         WHERE idempotencyKey IS NOT NULL AND idempotencyKey <> '';`);
    this.db.exec(`
      UPDATE requests
      SET
        priority = CASE LOWER(COALESCE(priority, 'normal'))
          WHEN 'interactive' THEN 'interactive'
          WHEN 'background' THEN 'background'
          ELSE 'normal'
        END,
        queueWaitBudgetMs = CASE
          WHEN queueWaitBudgetMs IS NULL OR queueWaitBudgetMs <= 0 THEN 90000
          ELSE queueWaitBudgetMs
        END,
        forceWorker = CASE
          WHEN forceWorker IS NULL THEN 0
          ELSE forceWorker
        END,
        enqueuedAt = COALESCE(enqueuedAt, createdAt)
      WHERE 1 = 1;
    `);
  }
  pendingOrderedIds() {
    const rows = this.db.prepare(`SELECT id, priority, createdAt
         FROM requests
         WHERE status = 'pending'
         ORDER BY
           CASE LOWER(priority)
             WHEN 'interactive' THEN 0
             WHEN 'normal' THEN 1
             WHEN 'background' THEN 2
             ELSE 1
           END ASC,
           createdAt ASC`).all();
    return rows.map((row) => row.id);
  }
  queuePosition(requestId) {
    const orderedIds = this.pendingOrderedIds();
    const idx = orderedIds.indexOf(requestId);
    if (idx < 0)
      return null;
    return idx + 1;
  }
  estimateEtaMs(priority, position) {
    if (!position || position <= 0)
      return null;
    const slotMs = PRIORITY_SLA_MS[priority];
    return Math.max(0, slotMs * (position - 1));
  }
  enqueue(body) {
    const sessionId = String(body.sessionId ?? "").trim();
    const prompt = String(body.prompt ?? "").trim();
    const priority = normalizePriority(body.priority);
    const queueWaitBudgetMs = parseBudgetMs2(body.queueWaitBudgetMs, PRIORITY_SLA_MS[priority]);
    const forceWorker = body.forceWorker === true ? 1 : 0;
    const rawLane = typeof body.forceLane === "string" ? body.forceLane.trim().toLowerCase() : "";
    const forceLane = rawLane === "deterministic" || rawLane === "worker" ? rawLane : null;
    const metadataSource = body.metadata ?? body.meta;
    const metadataParsed = sanitizeRequestMetadata(metadataSource);
    if (metadataParsed.error) {
      return { ok: false, message: metadataParsed.error };
    }
    const metadataJson = metadataParsed.metadata ? JSON.stringify(metadataParsed.metadata) : null;
    const idempotencyKeyRaw = asString2(body.idempotencyKey ?? body.idempotency_key);
    const idempotencyKey = idempotencyKeyRaw ? idempotencyKeyRaw.slice(0, 256) : null;
    if (!sessionId || !prompt) {
      return { ok: false, message: "sessionId and prompt are required" };
    }
    if (idempotencyKey) {
      const existing = this.db.prepare(`SELECT id, priority, status
           FROM requests
           WHERE idempotencyKey = ?
           ORDER BY createdAt DESC
           LIMIT 1`).get(idempotencyKey);
      if (existing?.id) {
        const queuePosition2 = existing.status === "pending" ? this.queuePosition(existing.id) : null;
        const etaMs2 = this.estimateEtaMs(normalizePriority(existing.priority), queuePosition2);
        return {
          ok: true,
          requestId: existing.id,
          queuePosition: queuePosition2 ?? undefined,
          etaMs: etaMs2 ?? undefined,
          deduplicated: true
        };
      }
    }
    const requestId = randomUUID3();
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO requests (
          id, sessionId, prompt, priority, queueWaitBudgetMs, metadataJson, idempotencyKey, forceWorker, forceLane,
          status, agentId, result, error,
          enqueuedAt, claimedAt, completedAt, failedAt, durationMs, createdAt, updatedAt
        )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, NULL, NULL, NULL, NULL, ?, ?)`).run(requestId, sessionId, prompt, priority, queueWaitBudgetMs, metadataJson, idempotencyKey, forceWorker, forceLane, now, now, now);
    const queuePosition = this.queuePosition(requestId);
    const etaMs = this.estimateEtaMs(priority, queuePosition);
    return {
      ok: true,
      requestId,
      queuePosition: queuePosition ?? undefined,
      etaMs: etaMs ?? undefined
    };
  }
  claim(agentIdRaw) {
    const now = new Date().toISOString();
    const agentId = String(agentIdRaw ?? "").trim() || "unknown";
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT ${RequestQueue.SELECT_COLUMNS}
           FROM requests
           WHERE status = 'pending'
           ORDER BY
             CASE LOWER(priority)
               WHEN 'interactive' THEN 0
               WHEN 'normal' THEN 1
               WHEN 'background' THEN 2
               ELSE 1
             END ASC,
             createdAt ASC
           LIMIT 1`).get();
      if (!row)
        return null;
      this.db.prepare(`UPDATE requests
           SET status = 'claimed',
               agentId = ?,
               claimedAt = ?,
               completedAt = NULL,
               failedAt = NULL,
               durationMs = NULL,
               updatedAt = ?
           WHERE id = ?`).run(agentId, now, now, row.id);
      const queueWaitMs = Math.max(0, Math.floor(Date.parse(now) - Date.parse(row.enqueuedAt || row.createdAt || now) || 0));
      return {
        request: {
          ...row,
          metadata: parseMetadataJson(row.metadataJson),
          status: "claimed",
          agentId,
          claimedAt: now,
          completedAt: null,
          failedAt: null,
          durationMs: null,
          updatedAt: now
        },
        queueWaitMs
      };
    });
    const claimed = tx();
    if (!claimed)
      return { ok: false, message: "No pending requests" };
    return { ok: true, request: claimed.request, queueWaitMs: claimed.queueWaitMs };
  }
  complete(requestId, body) {
    const now = new Date().toISOString();
    const result = body.result ? JSON.stringify(body.result) : null;
    const info = this.db.prepare(`UPDATE requests
         SET status = 'completed',
             result = ?,
             completedAt = ?,
             failedAt = NULL,
             durationMs = MAX(0, CAST((julianday(?) - julianday(COALESCE(enqueuedAt, createdAt))) * 86400000 AS INTEGER)),
             updatedAt = ?
         WHERE id = ? AND status = 'claimed'`).run(result, now, now, now, requestId);
    if (info.changes === 0) {
      return { ok: false, message: "Request not found or not in claimed state" };
    }
    return { ok: true };
  }
  fail(requestId, body) {
    const now = new Date().toISOString();
    const message = String(body.message ?? "Unknown error");
    const detail = body.detail == null ? null : String(body.detail);
    const info = this.db.prepare(`UPDATE requests
         SET status = 'failed',
             error = ?,
             failedAt = ?,
             completedAt = NULL,
             durationMs = MAX(0, CAST((julianday(?) - julianday(COALESCE(enqueuedAt, createdAt))) * 86400000 AS INTEGER)),
             updatedAt = ?
         WHERE id = ? AND status = 'claimed'`).run(JSON.stringify({ message, detail }), now, now, now, requestId);
    if (info.changes === 0) {
      return { ok: false, message: "Request not found or not in claimed state" };
    }
    return { ok: true };
  }
  getRequest(requestId) {
    const row = this.db.prepare(`SELECT ${RequestQueue.SELECT_COLUMNS} FROM requests WHERE id = ?`).get(requestId) ?? null;
    if (!row)
      return null;
    return { ...row, metadata: parseMetadataJson(row.metadataJson) };
  }
  getPendingRequests() {
    const rows = this.db.prepare(`SELECT ${RequestQueue.SELECT_COLUMNS}
         FROM requests
         WHERE status = 'pending'
         ORDER BY
           CASE LOWER(priority)
             WHEN 'interactive' THEN 0
             WHEN 'normal' THEN 1
             WHEN 'background' THEN 2
             ELSE 1
            END ASC,
            createdAt ASC`).all();
    return rows.map((row) => ({ ...row, metadata: parseMetadataJson(row.metadataJson) }));
  }
  listRequests(options) {
    const status = options?.status ?? "all";
    const limit = typeof options?.limit === "number" && Number.isFinite(options.limit) ? Math.max(1, Math.min(500, Math.floor(options.limit))) : 200;
    if (status === "all") {
      const rows2 = this.db.prepare(`SELECT ${RequestQueue.SELECT_COLUMNS}
           FROM requests
           ORDER BY createdAt DESC
           LIMIT ?`).all(limit);
      return rows2.map((row) => ({ ...row, metadata: parseMetadataJson(row.metadataJson) }));
    }
    const rows = this.db.prepare(`SELECT ${RequestQueue.SELECT_COLUMNS}
         FROM requests
         WHERE status = ?
         ORDER BY createdAt DESC
         LIMIT ?`).all(status, limit);
    return rows.map((row) => ({ ...row, metadata: parseMetadataJson(row.metadataJson) }));
  }
  countByStatus() {
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS count FROM requests GROUP BY status`).all();
    const counts = {
      pending: 0,
      claimed: 0,
      completed: 0,
      failed: 0
    };
    for (const row of rows) {
      if (row.status in counts)
        counts[row.status] = Number(row.count || 0);
    }
    return counts;
  }
  countByPriority() {
    const rows = this.db.prepare(`SELECT priority, COUNT(*) AS count
         FROM requests
         WHERE status IN ('pending', 'claimed')
         GROUP BY priority`).all();
    const counts = {
      interactive: 0,
      normal: 0,
      background: 0
    };
    for (const row of rows) {
      const priority = normalizePriority(row.priority);
      counts[priority] = Number(row.count || 0);
    }
    return counts;
  }
  countAutonomyRequests(statuses = ["pending", "claimed"]) {
    const normalized = Array.from(new Set(statuses.map((status) => String(status ?? "").trim().toLowerCase()).filter((status) => status === "pending" || status === "claimed" || status === "completed" || status === "failed")));
    if (normalized.length === 0)
      return 0;
    const placeholders = normalized.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT metadataJson
         FROM requests
         WHERE status IN (${placeholders})
           AND metadataJson IS NOT NULL
           AND metadataJson <> ''`).all(...normalized);
    let count = 0;
    for (const row of rows) {
      const metadata = parseMetadataJson(row.metadataJson);
      if (isAutonomyMetadata(metadata))
        count += 1;
    }
    return count;
  }
  nextPendingSnapshot(limit = 10) {
    const ordered = this.pendingOrderedIds().slice(0, Math.max(1, Math.min(limit, 50)));
    return ordered.map((id, idx) => {
      const row = this.db.prepare(`SELECT priority FROM requests WHERE id = ?`).get(id);
      const priority = normalizePriority(row?.priority);
      return {
        id,
        priority,
        position: idx + 1,
        etaMs: this.estimateEtaMs(priority, idx + 1) ?? 0
      };
    });
  }
  sloSummary(windowHours = 24) {
    const boundedWindowHours = Number.isFinite(windowHours) && windowHours > 0 ? Math.max(1, Math.min(24 * 30, Math.floor(windowHours))) : 24;
    const cutoffIso = new Date(Date.now() - boundedWindowHours * 60 * 60 * 1000).toISOString();
    const rows = this.db.prepare(`SELECT status, durationMs, enqueuedAt, claimedAt, createdAt, updatedAt
         FROM requests
         WHERE status IN ('completed', 'failed')
           AND updatedAt >= ?`).all(cutoffIso);
    let completed = 0;
    let failed = 0;
    const durationSamples = [];
    const queueWaitSamples = [];
    for (const row of rows) {
      if (row.status === "completed")
        completed += 1;
      if (row.status === "failed")
        failed += 1;
      if (typeof row.durationMs === "number" && Number.isFinite(row.durationMs) && row.durationMs >= 0) {
        durationSamples.push(Math.round(row.durationMs));
      }
      const queueStart = parseIsoMs2(row.enqueuedAt) ?? parseIsoMs2(row.createdAt) ?? null;
      const queueEnd = parseIsoMs2(row.claimedAt) ?? parseIsoMs2(row.updatedAt) ?? null;
      if (queueStart != null && queueEnd != null && queueEnd >= queueStart) {
        queueWaitSamples.push(queueEnd - queueStart);
      }
    }
    const terminal = completed + failed;
    const successRate = terminal > 0 ? Number((completed / terminal).toFixed(4)) : null;
    return {
      windowHours: boundedWindowHours,
      terminal,
      completed,
      failed,
      successRate,
      durationMs: summarizeSamples2(durationSamples),
      queueWaitMs: summarizeSamples2(queueWaitSamples)
    };
  }
  close() {
    this.db.close();
  }
}

// apps/server/src/completions.ts
import { Database as Database4 } from "bun:sqlite";
import { randomUUID as randomUUID4 } from "crypto";
function normalizeTrustedValidationTiming(timing) {
  const normalizedDuration = (value) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
  return {
    installDurationMs: normalizedDuration(timing?.installDurationMs),
    validationDurationMs: normalizedDuration(timing?.validationDurationMs),
    installCacheHit: typeof timing?.installCacheHit === "boolean" ? timing.installCacheHit ? 1 : 0 : null
  };
}

class CompletionQueue {
  db;
  constructor(dbPath = ":memory:") {
    this.db = typeof dbPath === "string" ? new Database4(dbPath) : dbPath;
    this.db.exec("PRAGMA journal_mode = WAL;");
    this._migrate();
  }
  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS completions (
        id         TEXT PRIMARY KEY,
        jobId      TEXT NOT NULL,
        sessionId  TEXT NOT NULL,
        origin     TEXT NOT NULL DEFAULT 'user',
        commitSha  TEXT,
        branch     TEXT,
        message    TEXT NOT NULL,
        prUrl      TEXT,
        prTitle    TEXT,
        prBody     TEXT,
        trustedValidationCommandsJson TEXT,
        trustedValidationSummary TEXT,
        trustedValidationDetail TEXT,
        trustedInstallDurationMs INTEGER,
        trustedValidationDurationMs INTEGER,
        trustedValidationCacheHit INTEGER,
        status     TEXT NOT NULL DEFAULT 'pending',
        pusherId   TEXT,
        error      TEXT,
        createdAt  TEXT NOT NULL,
        updatedAt  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_completions_status ON completions(status);
      CREATE INDEX IF NOT EXISTS idx_completions_job ON completions(jobId);
    `);
    const columns = this.db.prepare(`PRAGMA table_info(completions)`).all();
    if (!columns.some((col) => col.name === "prTitle")) {
      this.db.exec(`ALTER TABLE completions ADD COLUMN prTitle TEXT;`);
    }
    if (!columns.some((col) => col.name === "prBody")) {
      this.db.exec(`ALTER TABLE completions ADD COLUMN prBody TEXT;`);
    }
    if (!columns.some((col) => col.name === "prUrl")) {
      this.db.exec(`ALTER TABLE completions ADD COLUMN prUrl TEXT;`);
    }
    if (!columns.some((col) => col.name === "origin")) {
      this.db.exec(`ALTER TABLE completions ADD COLUMN origin TEXT NOT NULL DEFAULT 'user';`);
    }
    if (!columns.some((col) => col.name === "trustedValidationCommandsJson")) {
      this.db.exec(`ALTER TABLE completions ADD COLUMN trustedValidationCommandsJson TEXT;`);
    }
    if (!columns.some((col) => col.name === "trustedValidationSummary")) {
      this.db.exec(`ALTER TABLE completions ADD COLUMN trustedValidationSummary TEXT;`);
    }
    if (!columns.some((col) => col.name === "trustedValidationDetail")) {
      this.db.exec(`ALTER TABLE completions ADD COLUMN trustedValidationDetail TEXT;`);
    }
    if (!columns.some((col) => col.name === "trustedInstallDurationMs")) {
      this.db.exec(`ALTER TABLE completions ADD COLUMN trustedInstallDurationMs INTEGER;`);
    }
    if (!columns.some((col) => col.name === "trustedValidationDurationMs")) {
      this.db.exec(`ALTER TABLE completions ADD COLUMN trustedValidationDurationMs INTEGER;`);
    }
    if (!columns.some((col) => col.name === "trustedValidationCacheHit")) {
      this.db.exec(`ALTER TABLE completions ADD COLUMN trustedValidationCacheHit INTEGER;`);
    }
    this.reconcileLegacyParentJobStates();
  }
  reconcileLegacyParentJobStates() {
    const jobsTable = this.db.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'jobs'`).get();
    if (!jobsTable)
      return;
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE jobs
           SET status = 'finalizing', completedAt = NULL, updatedAt = ?
           WHERE status = 'completed'
             AND EXISTS (
               SELECT 1 FROM completions c
               WHERE c.jobId = jobs.id AND c.status IN ('pending', 'claimed')
             )`).run(now);
      this.db.prepare(`UPDATE jobs
           SET status = 'publish_blocked',
               error = COALESCE(
                 (SELECT c.error FROM completions c
                  WHERE c.jobId = jobs.id AND c.status = 'failed'
                  ORDER BY c.updatedAt DESC LIMIT 1),
                 error
               ),
               completedAt = NULL,
               publishBlockedAt = COALESCE(publishBlockedAt, ?),
               updatedAt = ?
           WHERE status IN ('completed', 'finalizing')
             AND EXISTS (
               SELECT 1 FROM completions c
               WHERE c.jobId = jobs.id AND c.status = 'failed'
             )`).run(now, now);
      this.db.prepare(`UPDATE jobs
           SET status = 'completed',
               completedAt = COALESCE(completedAt, ?),
               error = NULL,
               publishBlockedAt = NULL,
               updatedAt = ?
           WHERE status = 'finalizing'
             AND EXISTS (
               SELECT 1 FROM completions c
               WHERE c.jobId = jobs.id AND c.status = 'processed'
             )`).run(now, now);
      const diagnosticsTable = this.db.prepare(`SELECT 1 AS present FROM sqlite_master
           WHERE type = 'table' AND name = 'job_terminal_diagnostics'`).get();
      if (diagnosticsTable) {
        const failedParents = this.db.prepare(`SELECT j.id AS jobId,
                    c.error AS error,
                    c.trustedValidationCommandsJson AS trustedValidationCommandsJson
             FROM jobs j
             JOIN completions c ON c.id = (
               SELECT latest.id FROM completions latest
               WHERE latest.jobId = j.id AND latest.status = 'failed'
               ORDER BY latest.updatedAt DESC LIMIT 1
             )
             WHERE j.status = 'publish_blocked'`).all();
        for (const row of failedParents) {
          this.upsertPublicationTerminalDiagnostics({
            jobId: row.jobId,
            status: "publish_blocked",
            failureClass: row.trustedValidationCommandsJson ? "trusted_validation_failed" : "publication_failed",
            terminalStage: row.trustedValidationCommandsJson ? "trusted_environment_validation" : "publication",
            summary: row.error || "Candidate publication failed",
            now
          });
        }
      }
    });
    tx();
  }
  enqueue(body, options = {}) {
    const jobId = body.jobId;
    const sessionId = body.sessionId;
    const commitSha = body.commitSha;
    const branch = body.branch;
    const message = body.message;
    const origin = body.origin === "autonomy" ? "autonomy" : "user";
    const prUrl = typeof body.prUrl === "string" && body.prUrl.trim().length > 0 ? body.prUrl.trim() : null;
    const prTitle = typeof body.prTitle === "string" && body.prTitle.trim().length > 0 ? body.prTitle.trim() : null;
    const prBody = typeof body.prBody === "string" && body.prBody.trim().length > 0 ? body.prBody.trim() : null;
    let trustedValidationCommandsJson = null;
    let trustedValidationSummary = null;
    let trustedValidationDetail = null;
    if (body.trustedValidationCommands !== undefined) {
      const trustedCommands = normalizeTrustedValidationCommands(body.trustedValidationCommands);
      if (!trustedCommands.ok) {
        return { ok: false, message: trustedCommands.message };
      }
      trustedValidationCommandsJson = JSON.stringify(trustedCommands.commands);
      trustedValidationSummary = typeof body.trustedValidationSummary === "string" ? body.trustedValidationSummary.trim().slice(0, 500) || null : null;
      trustedValidationDetail = typeof body.trustedValidationDetail === "string" ? body.trustedValidationDetail.trim().slice(0, 4000) || null : null;
    }
    if (!jobId || !sessionId || !message) {
      return { ok: false, message: "jobId, sessionId, and message are required" };
    }
    const completionId = randomUUID4();
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      if (options.beginJobFinalization) {
        const job = this.db.prepare(`SELECT status, workerId FROM jobs WHERE id = ?`).get(jobId);
        if (!job)
          return { ok: false, message: "Job not found" };
        const existing = this.db.prepare(`SELECT id FROM completions
             WHERE jobId = ? AND status IN ('pending', 'claimed')
             ORDER BY createdAt DESC
             LIMIT 1`).get(jobId);
        if (existing && job.status === "finalizing") {
          return {
            ok: true,
            completionId: existing.id,
            deduped: true,
            jobStatus: "finalizing"
          };
        }
        if (job.status !== "claimed") {
          return {
            ok: false,
            message: `Job is ${job.status}; expected claimed before completion handoff`
          };
        }
        if (existing) {
          return {
            ok: false,
            message: `Job already has active completion ${existing.id}`
          };
        }
      }
      this.db.prepare(`INSERT INTO completions (
             id, jobId, sessionId, origin, commitSha, branch, message, prUrl, prTitle, prBody,
             trustedValidationCommandsJson, trustedValidationSummary, trustedValidationDetail,
             status, createdAt, updatedAt
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(completionId, jobId, sessionId, origin, commitSha ?? null, branch ?? null, message, prUrl, prTitle, prBody, trustedValidationCommandsJson, trustedValidationSummary, trustedValidationDetail, now, now);
      if (options.beginJobFinalization) {
        const summary = typeof body.jobResultSummary === "string" ? body.jobResultSummary.trim() : "";
        const artifacts = Array.isArray(body.jobArtifacts) ? body.jobArtifacts : [];
        const transitioned = this.db.prepare(`UPDATE jobs
             SET status = 'finalizing',
                 result = ?,
                 prUrl = COALESCE(?, prUrl),
                 error = NULL,
                 completedAt = NULL,
                 failedAt = NULL,
                 abandonedAt = NULL,
                 publishBlockedAt = NULL,
                 updatedAt = ?
             WHERE id = ? AND status = 'claimed'`).run(JSON.stringify({ summary: summary || message, artifacts }), prUrl, now, jobId);
        if (transitioned.changes === 0) {
          throw new Error(`Job ${jobId} left claimed state during completion handoff`);
        }
        this.db.prepare(`UPDATE workers
             SET status = 'idle',
                 currentJobId = CASE WHEN currentJobId = ? THEN NULL ELSE currentJobId END,
                 lastHeartbeat = ?,
                 updatedAt = ?
             WHERE workerId = (SELECT workerId FROM jobs WHERE id = ?)
               AND NOT EXISTS (
                 SELECT 1 FROM jobs active
                 WHERE active.workerId = workers.workerId AND active.status = 'claimed'
               )`).run(jobId, now, now, jobId);
      }
      return {
        ok: true,
        completionId,
        ...options.beginJobFinalization ? { jobStatus: "finalizing" } : {}
      };
    });
    try {
      return tx();
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }
  claim(pusherId) {
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM completions WHERE status = 'pending' ORDER BY createdAt ASC LIMIT 1`).get();
      if (!row)
        return null;
      this.db.prepare(`UPDATE completions SET status = 'claimed', pusherId = ?, updatedAt = ? WHERE id = ?`).run(pusherId, now, row.id);
      return { ...row, status: "claimed", pusherId, updatedAt: now };
    });
    const completion = tx();
    if (!completion)
      return { ok: false, message: "No pending completions" };
    return { ok: true, completion };
  }
  markProcessed(completionId, prUrl) {
    const now = new Date().toISOString();
    const normalizedPrUrl = typeof prUrl === "string" && prUrl.trim().length > 0 ? prUrl.trim() : null;
    const info = this.db.prepare(`UPDATE completions
         SET status = 'processed',
             prUrl = COALESCE(?, prUrl),
             updatedAt = ?
         WHERE id = ? AND status = 'claimed'`).run(normalizedPrUrl, now, completionId);
    if (info.changes === 0) {
      return { ok: false, message: "Completion not found or not in claimed state" };
    }
    return { ok: true };
  }
  markFailed(completionId, error) {
    const now = new Date().toISOString();
    const info = this.db.prepare(`UPDATE completions SET status = 'failed', error = ?, updatedAt = ? WHERE id = ? AND status = 'claimed'`).run(error, now, completionId);
    if (info.changes === 0) {
      return { ok: false, message: "Completion not found or not in claimed state" };
    }
    return { ok: true };
  }
  markProcessedAndFinalizeJob(completionId, prUrl, trustedTiming) {
    const now = new Date().toISOString();
    const normalizedPrUrl = typeof prUrl === "string" && prUrl.trim().length > 0 ? prUrl.trim() : null;
    const normalizedTiming = normalizeTrustedValidationTiming(trustedTiming);
    const tx = this.db.transaction(() => {
      const completion = this.getCompletion(completionId);
      if (!completion)
        return { ok: false, message: "Completion not found" };
      if (completion.status === "processed") {
        return { ok: true, jobId: completion.jobId, jobTransitioned: false };
      }
      if (completion.status !== "claimed") {
        return { ok: false, message: "Completion not in claimed state" };
      }
      const job = this.db.prepare(`SELECT status FROM jobs WHERE id = ?`).get(completion.jobId);
      if (!job)
        return { ok: false, message: "Parent job not found" };
      if (job.status !== "finalizing" && job.status !== "completed") {
        return {
          ok: false,
          message: `Parent job is ${job.status}; expected finalizing`
        };
      }
      this.db.prepare(`UPDATE completions
           SET status = 'processed',
               prUrl = COALESCE(?, prUrl),
               trustedInstallDurationMs = COALESCE(?, trustedInstallDurationMs),
               trustedValidationDurationMs = COALESCE(?, trustedValidationDurationMs),
               trustedValidationCacheHit = COALESCE(?, trustedValidationCacheHit),
               error = NULL,
               updatedAt = ?
           WHERE id = ? AND status = 'claimed'`).run(normalizedPrUrl, normalizedTiming.installDurationMs, normalizedTiming.validationDurationMs, normalizedTiming.installCacheHit, now, completionId);
      const transitioned = this.db.prepare(`UPDATE jobs
           SET status = 'completed',
               prUrl = COALESCE(?, prUrl),
               error = NULL,
               completedAt = ?,
               failedAt = NULL,
               abandonedAt = NULL,
               publishBlockedAt = NULL,
               durationMs = MAX(
                 0,
                 CAST((julianday(?) - julianday(COALESCE(startedAt, claimedAt, enqueuedAt, createdAt))) * 86400000 AS INTEGER)
               ),
               updatedAt = ?
           WHERE id = ? AND status = 'finalizing'`).run(normalizedPrUrl, now, now, now, completion.jobId);
      if (transitioned.changes > 0) {
        this.upsertPublicationTerminalDiagnostics({
          jobId: completion.jobId,
          status: "completed",
          failureClass: "success",
          terminalStage: "publication",
          summary: normalizedPrUrl ? `Candidate published successfully: ${normalizedPrUrl}` : "Candidate published successfully",
          now
        });
      }
      const saved = this.db.prepare(`SELECT durationMs, completedAt FROM jobs WHERE id = ?`).get(completion.jobId);
      return {
        ok: true,
        jobId: completion.jobId,
        jobTransitioned: transitioned.changes > 0,
        durationMs: saved?.durationMs ?? undefined,
        completedAt: saved?.completedAt ?? undefined
      };
    });
    return tx();
  }
  markFailedAndBlockJob(completionId, error, trustedTiming) {
    const now = new Date().toISOString();
    const failure = String(error || "Unknown publication error");
    const normalizedTiming = normalizeTrustedValidationTiming(trustedTiming);
    const tx = this.db.transaction(() => {
      const completion = this.getCompletion(completionId);
      if (!completion)
        return { ok: false, message: "Completion not found" };
      if (completion.status === "failed") {
        return { ok: true, jobId: completion.jobId, jobTransitioned: false };
      }
      if (completion.status !== "claimed") {
        return { ok: false, message: "Completion not in claimed state" };
      }
      const job = this.db.prepare(`SELECT status FROM jobs WHERE id = ?`).get(completion.jobId);
      if (!job)
        return { ok: false, message: "Parent job not found" };
      if (job.status !== "finalizing" && job.status !== "completed") {
        return {
          ok: false,
          message: `Parent job is ${job.status}; expected finalizing`
        };
      }
      this.db.prepare(`UPDATE completions
           SET status = 'failed',
               trustedInstallDurationMs = COALESCE(?, trustedInstallDurationMs),
               trustedValidationDurationMs = COALESCE(?, trustedValidationDurationMs),
               trustedValidationCacheHit = COALESCE(?, trustedValidationCacheHit),
               error = ?,
               updatedAt = ?
           WHERE id = ? AND status = 'claimed'`).run(normalizedTiming.installDurationMs, normalizedTiming.validationDurationMs, normalizedTiming.installCacheHit, failure, now, completionId);
      const transitioned = this.db.prepare(`UPDATE jobs
           SET status = 'publish_blocked',
               error = ?,
               publishBlockedAt = ?,
               completedAt = NULL,
               failedAt = NULL,
               abandonedAt = NULL,
               durationMs = MAX(
                 0,
                 CAST((julianday(?) - julianday(COALESCE(startedAt, claimedAt, enqueuedAt, createdAt))) * 86400000 AS INTEGER)
               ),
               updatedAt = ?
           WHERE id = ? AND status IN ('finalizing', 'completed')`).run(JSON.stringify({
        message: "Candidate publication failed",
        detail: failure,
        completionId
      }), now, now, now, completion.jobId);
      if (transitioned.changes > 0) {
        this.upsertPublicationTerminalDiagnostics({
          jobId: completion.jobId,
          status: "publish_blocked",
          failureClass: completion.trustedValidationCommandsJson ? "trusted_validation_failed" : "publication_failed",
          terminalStage: completion.trustedValidationCommandsJson ? "trusted_environment_validation" : "publication",
          summary: failure,
          now
        });
      }
      const saved = this.db.prepare(`SELECT durationMs, publishBlockedAt FROM jobs WHERE id = ?`).get(completion.jobId);
      return {
        ok: true,
        jobId: completion.jobId,
        jobTransitioned: transitioned.changes > 0,
        durationMs: saved?.durationMs ?? undefined,
        publishBlockedAt: saved?.publishBlockedAt ?? undefined
      };
    });
    return tx();
  }
  upsertPublicationTerminalDiagnostics(options) {
    this.db.prepare(`INSERT INTO job_terminal_diagnostics (
           jobId, status, failureClass, terminalStage, summary,
           watchdogFired, changedPathSampleJson, metadataJson, createdAt, updatedAt
         ) VALUES (?, ?, ?, ?, ?, 0, '[]', ?, ?, ?)
         ON CONFLICT(jobId) DO UPDATE SET
           status = excluded.status,
           failureClass = excluded.failureClass,
           terminalStage = excluded.terminalStage,
           summary = excluded.summary,
           updatedAt = excluded.updatedAt`).run(options.jobId, options.status, options.failureClass, options.terminalStage, options.summary.slice(0, 1000), JSON.stringify({ completionFinalized: true }), options.now, options.now);
  }
  getCompletion(completionId) {
    return this.db.prepare(`SELECT * FROM completions WHERE id = ?`).get(completionId) ?? null;
  }
  getPendingCompletions() {
    return this.db.prepare(`SELECT * FROM completions WHERE status = 'pending' ORDER BY createdAt ASC`).all();
  }
  listCompletions(options) {
    const status = options?.status ?? "all";
    const limit = typeof options?.limit === "number" && Number.isFinite(options.limit) ? Math.max(1, Math.min(500, Math.floor(options.limit))) : 200;
    if (status === "all") {
      return this.db.prepare(`SELECT * FROM completions ORDER BY createdAt DESC LIMIT ?`).all(limit);
    }
    return this.db.prepare(`SELECT * FROM completions WHERE status = ? ORDER BY createdAt DESC LIMIT ?`).all(status, limit);
  }
  countByStatus() {
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS count FROM completions GROUP BY status`).all();
    const counts = {
      pending: 0,
      claimed: 0,
      processed: 0,
      failed: 0
    };
    for (const row of rows) {
      if (row.status in counts)
        counts[row.status] = Number(row.count || 0);
    }
    return counts;
  }
  close() {
    this.db.close();
  }
}

// apps/server/src/autonomy.ts
import { Database as Database5 } from "bun:sqlite";
import { createHash as createHash3, randomUUID as randomUUID5 } from "crypto";
var OBJECTIVE_POLICY = {
  flaky_test: {
    maxRisk: "low",
    maxGlobBreadth: "narrow",
    autonomousAllowed: true,
    requireValidation: true,
    dependencyChanges: false
  },
  lint_fix: {
    maxRisk: "low",
    maxGlobBreadth: "narrow",
    autonomousAllowed: true,
    requireValidation: true,
    dependencyChanges: false
  },
  type_fix: {
    maxRisk: "low",
    maxGlobBreadth: "medium",
    autonomousAllowed: true,
    requireValidation: true,
    dependencyChanges: false
  },
  small_refactor: {
    maxRisk: "medium",
    maxGlobBreadth: "medium",
    autonomousAllowed: true,
    requireValidation: true,
    dependencyChanges: false
  },
  feature_small: {
    maxRisk: "low",
    maxGlobBreadth: "medium",
    autonomousAllowed: true,
    requireValidation: true,
    dependencyChanges: false
  },
  feature_medium: {
    maxRisk: "medium",
    maxGlobBreadth: "medium",
    autonomousAllowed: true,
    requireValidation: true,
    dependencyChanges: false
  },
  feature_large: {
    maxRisk: "high",
    maxGlobBreadth: "broad",
    autonomousAllowed: false,
    requireValidation: true,
    dependencyChanges: false
  },
  docs: {
    maxRisk: "low",
    maxGlobBreadth: "medium",
    autonomousAllowed: true,
    requireValidation: false,
    dependencyChanges: false
  },
  dep_bump: {
    maxRisk: "medium",
    maxGlobBreadth: "narrow",
    autonomousAllowed: false,
    requireValidation: true,
    dependencyChanges: true
  }
};
var RISK_ORDER = { low: 0, medium: 1, high: 2 };
var OBJECTIVE_TYPES = new Set(Object.keys(OBJECTIVE_POLICY));
var TRIGGER_TYPES = new Set([
  "test_failure",
  "lint_failure",
  "typecheck_failure",
  "queue_health",
  "regret_signal"
]);
var RECENT_SUCCESS_SUPPRESSION_WINDOW_HOURS = 24;
var ENGINE_SOURCE_PROMOTE_MIN_SAMPLES = 5;
var ENGINE_SOURCE_ARCHIVE_MIN_SAMPLES = 8;
var ENGINE_SOURCE_WATCHLIST_MIN_SAMPLES = 4;
var ENGINE_SOURCE_FRESHNESS_HALF_LIFE_DAYS = 14;
function isNegativePrFeedbackVerdict(value) {
  const text = value.toLowerCase();
  return text.includes("reject") || text.includes("merge_failed") || text.includes("failed");
}
function deriveOutcomeFromPrFeedbackVerdict(verdict) {
  const text = verdict.toLowerCase();
  if (text.includes("approved_unmergeable") || text.includes("approved") && (text.includes("unmergeable") || text.includes("merge_conflict"))) {
    return null;
  }
  if (text.includes("rejected_comment_cap_closed") || text.includes("closed")) {
    return {
      success: false,
      userAction: "rejected",
      reopenedWithin24h: true,
      regressionFlag: true,
      terminal: true
    };
  }
  if (isNegativePrFeedbackVerdict(text)) {
    return {
      success: false,
      userAction: "rejected",
      reopenedWithin24h: true,
      regressionFlag: true,
      terminal: !text.includes("reject")
    };
  }
  if (text.includes("approved") || text.includes("merged")) {
    return {
      success: true,
      userAction: "accepted",
      reopenedWithin24h: false,
      regressionFlag: false,
      terminal: true
    };
  }
  return null;
}
function asIsoNow() {
  return new Date().toISOString();
}
function sha256Hex(value) {
  return createHash3("sha256").update(value).digest("hex");
}
function jsonByteLength(value) {
  return Buffer.byteLength(value, "utf8");
}
function clamp012(value) {
  if (!Number.isFinite(value))
    return 0;
  if (value <= 0)
    return 0;
  if (value >= 1)
    return 1;
  return value;
}
function asObject2(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return {};
  return value;
}
function asString3(value) {
  return String(value ?? "").trim();
}
function normalizeServiceName(value) {
  return asString3(value).toLowerCase();
}
function truncateText(value, maxChars) {
  if (maxChars <= 0)
    return "";
  if (value.length <= maxChars)
    return value;
  if (maxChars <= 3)
    return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - 3).trimEnd()}...`;
}
function asStringArray3(value) {
  if (!Array.isArray(value))
    return [];
  return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}
function normalizedAutonomyFailureTargets(params) {
  const planning = asObject2(params.planning);
  const autonomy = asObject2(params.autonomy);
  return [
    asString3(params.path),
    asString3(params.targetPath ?? params.target_path),
    ...asStringArray3(params.paths),
    asString3(planning.targetPath ?? planning.target_path),
    ...asStringArray3(planning.targetPaths ?? planning.target_paths),
    asString3(autonomy.targetPath ?? autonomy.target_path),
    ...asStringArray3(autonomy.targetPaths ?? autonomy.target_paths)
  ].map((entry) => entry.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "").toLowerCase()).filter(Boolean).filter((entry, index, entries) => entries.indexOf(entry) === index).sort();
}
function failedTestNamesFromOutput(...values) {
  const text = values.map((value) => String(value ?? "")).join(`
`);
  const tests = new Set;
  for (const match of text.matchAll(/(?:\(fail\)|\bfail(?:ed)?\b)\s*[:>-]?\s*([^\r\n]{3,240})/gi)) {
    const normalized = asString3(match[1]).replace(/\s+\[[\d.]+\s*(?:ms|s)\]\s*$/i, "").replace(/\s+/g, " ").toLowerCase();
    if (normalized)
      tests.add(normalized);
    if (tests.size >= 8)
      break;
  }
  if (tests.size < 8) {
    for (const match of text.matchAll(/(?:^|[\s("'`])([a-z0-9_./-]+\.(?:test|spec)\.[cm]?[jt]sx?)(?=$|[\s:)"'`])/gim)) {
      tests.add(asString3(match[1]).replace(/\\/g, "/").toLowerCase());
      if (tests.size >= 8)
        break;
    }
  }
  return [...tests].sort();
}
var PUSHPALS_INTERNAL_CANDIDATE_PATTERNS = [
  /\bqueue[_-]?health\b/i,
  /\bworkerpals?\b/i,
  /\bremotebuddy\b/i,
  /\blocalbuddy\b/i,
  /\bsource[_-]?control[_-]?manager\b/i,
  /\bsourcecontrolmanager\b/i,
  /\breview[_-]?agent\b/i,
  /\breviewagent\b/i,
  /\bpushpals?\b/i,
  /\bdispatch locks?\b/i,
  /\bautonomy diagnostics?\b/i
];
var PUSHPALS_OWNED_PATH_PATTERNS = [
  /^apps\/(?:workerpals|remotebuddy|localbuddy|source_control_manager|server)\b/i,
  /^packages\/(?:cli|shared)\b/i,
  /^prompts\/(?:workerpals|review_agent|remotebuddy|localbuddy)\b/i,
  /^scripts\/(?:pushpals|sync-cli|build-runtime|release|replay-worker-job)/i,
  /\bpushpals\b/i,
  /\bworkerpals\b/i,
  /\bremotebuddy\b/i,
  /\bsource_control_manager\b/i
];
function pushpalsInternalCandidateReason(record) {
  const scope = asObject2(record.scope);
  const targetPaths = [
    ...asStringArray3(record.targetPaths ?? record.target_paths),
    ...asStringArray3(scope.targetPaths ?? scope.target_paths)
  ];
  const writeGlobs = asStringArray3(scope.writeGlobs ?? scope.write_globs);
  const ownershipHints = [
    asString3(record.componentArea ?? record.component_area),
    ...targetPaths,
    ...writeGlobs
  ].map((entry) => entry.replace(/\\/g, "/").replace(/\/+/g, "/").trim()).filter(Boolean);
  const targetsPushPalsOwnedArea = ownershipHints.some((entry) => PUSHPALS_OWNED_PATH_PATTERNS.some((pattern) => pattern.test(entry)));
  if (targetsPushPalsOwnedArea)
    return null;
  const candidateText = [
    record.title,
    record.name,
    record.summary,
    record.description,
    record.instruction,
    record.patternKey ?? record.pattern_key,
    record.componentArea ?? record.component_area,
    ...asStringArray3(record.acceptanceCriteria ?? record.acceptance_criteria)
  ].map((entry) => asString3(entry)).join(`
`);
  const leakedTerm = PUSHPALS_INTERNAL_CANDIDATE_PATTERNS.find((pattern) => pattern.test(candidateText));
  if (!leakedTerm)
    return null;
  return "candidate appears to target PushPals-internal orchestration concepts in a user repo; generate repo-native product/test work instead";
}
function uniqueLowercaseTokens(value, maxItems = 24) {
  const seen = new Set;
  const out = [];
  for (const entry of asStringArray3(value)) {
    const token = entry.toLowerCase();
    if (!token || seen.has(token))
      continue;
    seen.add(token);
    out.push(token);
    if (out.length >= maxItems)
      break;
  }
  return out;
}
function normalizeInspirationSourceType(value) {
  const text = asString3(value).toLowerCase();
  if (!text)
    return "external_doc";
  if ([
    "external_repo",
    "external_doc",
    "internal_doc",
    "research_note",
    "incident_postmortem",
    "benchmark",
    "community_discussion"
  ].includes(text)) {
    return text;
  }
  return "external_doc";
}
function asBoolean2(value, fallback = false) {
  if (typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      return fallback;
    return value !== 0;
  }
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(text))
      return true;
    if (["0", "false", "no", "off"].includes(text))
      return false;
  }
  return fallback;
}
function asNumber(value, fallback = 0) {
  if (value === null || value === undefined)
    return fallback;
  if (typeof value === "string" && value.trim().length === 0)
    return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function asNonNegativeInt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed))
    return 0;
  return Math.max(0, Math.floor(parsed));
}
function parseJsonObject(raw) {
  if (!raw)
    return {};
  try {
    return asObject2(JSON.parse(raw));
  } catch {
    return {};
  }
}
function parseJsonArray2(raw) {
  if (!raw)
    return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function formatAnswerForAutonomyInstruction(answer, maxChars = 1600) {
  if (typeof answer === "string")
    return truncateText(answer.trim(), maxChars);
  if (typeof answer === "number" || typeof answer === "boolean")
    return String(answer);
  if (answer == null)
    return "";
  try {
    const encoded = JSON.stringify(answer, null, 2);
    return truncateText(encoded, maxChars);
  } catch {
    return truncateText(String(answer), maxChars);
  }
}
function norm(x, min, max) {
  if (!Number.isFinite(x) || max <= min)
    return 0;
  return clamp012((x - min) / (max - min));
}
function normalizeSignalType(value) {
  const text = value.toLowerCase();
  if (text === "lint_failure" || /\blint\b/.test(text))
    return "lint_failure";
  if (text === "typecheck_failure" || /\btype(check)?\b/.test(text))
    return "typecheck_failure";
  if (text === "test_failure" || /\b(test|pytest|vitest|jest|e2e|smoke|browser|playwright)\b/.test(text))
    return "test_failure";
  if (text === "regret_signal" || /\bregret|reopen|re-open\b/.test(text))
    return "regret_signal";
  if (text === "queue_health")
    return "queue_health";
  return "queue_health";
}
function normalizeValidationCommand(value) {
  return asString3(value).replace(/\s+/g, " ");
}
function validationSignalType(command, failureClass, sample) {
  return normalizeSignalType(`${command} ${failureClass ?? ""} ${sample}`);
}
function validationIncidentDigest(command, failureClass, sample) {
  return sha256Hex(`${command}
${failureClass ?? ""}
${sample}`).slice(0, 16);
}
function collectValidationPathHints(...texts) {
  const seen = new Set;
  const out = [];
  const pathRe = /(?:^|[\s("'`])([A-Za-z0-9_.@/-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|html|yml|yaml|toml))(?:[:)\s,"'`]|$)/g;
  for (const text of texts) {
    for (const match of text.matchAll(pathRe)) {
      const raw = asString3(match[1]).replace(/\\/g, "/");
      if (!raw || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw))
        continue;
      if (raw.includes("node_modules/") || raw.includes("/node_modules/"))
        continue;
      const normalized = normalizeAutonomyComponentArea(raw);
      if (!normalized || seen.has(normalized))
        continue;
      seen.add(normalized);
      out.push(normalized);
      if (out.length >= 12)
        return out;
    }
  }
  return out;
}
function parseJobPayloadText(raw) {
  if (!raw)
    return "";
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed;
      return `${asString3(record.summary)} ${asString3(record.message)} ${asString3(record.detail)}`.trim();
    }
  } catch {}
  return String(raw).trim();
}
function parseJobPayloadSignalSummary(raw) {
  if (!raw)
    return "";
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed;
      return `${asString3(record.summary)} ${asString3(record.message)}`.trim();
    }
  } catch {}
  return String(raw).trim();
}
function isRequiredValidationFailureSignal(text) {
  return /\b(ValidationGate:\s*Required|required validation)\b/i.test(text);
}
function isNonRepairableValidationEnvironmentFailure(failureClass, stdoutTail, stderrTail) {
  const normalizedClass = asString3(failureClass).trim().toLowerCase();
  if (normalizedClass === "environment" || normalizedClass === "trusted_validation_required") {
    return true;
  }
  const text = `${asString3(stdoutTail)}
${asString3(stderrTail)}`.toLowerCase();
  return text.includes("trusted-environment validation deferred before execution") || text.includes("worker sandbox intentionally has no docker socket") && text.includes("run this command on the trusted host");
}
function isWorkerQualityTrajectoryFailureSignal(text) {
  return /\bScopeGate\b/i.test(text) || /\bno relevant test file modified\b/i.test(text) || /\brollout coach could not recover publishable progress\b/i.test(text) || /\b(no|without) publishable progress\b/i.test(text) || /\bartifact_only_no_publishable_patch\b/i.test(text);
}
function failedJobSignalType(row) {
  const errorSummary = parseJobPayloadSignalSummary(row.error);
  const text = `${asString3(row.failureClass)} ${asString3(row.diagnosticSummary) || errorSummary}`.trim().replace(/\s+/g, " ");
  if (isRequiredValidationFailureSignal(text))
    return normalizeSignalType(text);
  if (isWorkerQualityTrajectoryFailureSignal(text))
    return "queue_health";
  return normalizeSignalType(text || errorSummary);
}
function publicFailureClassLabel(value) {
  const normalized = asString3(value).toLowerCase();
  switch (normalized) {
    case "artifact_only_no_publishable_patch":
      return "no_reviewable_repo_change";
    case "codex_startup_stall":
      return "executor_startup_stall";
    default:
      return asString3(value);
  }
}
function isStaleClaimFailureText(value) {
  return /\b(stale worker claim|heartbeat stale|watchdog|job auto-failed after stale worker claim)\b/i.test(value);
}
function extractQualityGateRevisionInfo(value) {
  const match = value.match(/quality gate (soft-pass after|failed after) (\d+) auto-revision attempt/i);
  if (!match)
    return null;
  const attempts = Math.max(0, Math.floor(asNumber(match[2], 0)));
  const mode = asString3(match[1]).toLowerCase();
  return {
    attempts,
    failed: mode.includes("failed"),
    softPass: mode.includes("soft-pass")
  };
}
function asRiskLevel(value) {
  const text = asString3(value).toLowerCase();
  if (text === "low" || text === "medium" || text === "high")
    return text;
  return null;
}
function asObjectiveType(value) {
  const text = asString3(value);
  if (!text)
    return null;
  return OBJECTIVE_TYPES.has(text) ? text : null;
}
function asComponentArea(value) {
  return normalizeAutonomyComponentArea(value);
}
function asTriggerType(value) {
  const text = asString3(value);
  if (!text)
    return null;
  return TRIGGER_TYPES.has(text) ? text : null;
}
function scopedCandidateStorageId(runId, candidateId) {
  const normalizedRunId = asString3(runId);
  const normalizedCandidateId = asString3(candidateId);
  if (!normalizedRunId)
    return normalizedCandidateId || randomUUID5();
  if (!normalizedCandidateId)
    return `${normalizedRunId}:${randomUUID5()}`;
  const prefix = `${normalizedRunId}:`;
  if (normalizedCandidateId.startsWith(prefix))
    return normalizedCandidateId;
  return `${prefix}${normalizedCandidateId}`;
}
function deriveInspirationSourceKey(params) {
  const fingerprint = asString3(params.sourceFingerprint);
  if (fingerprint)
    return `fingerprint:${fingerprint.toLowerCase()}`;
  const sourceType = asString3(params.sourceType).toLowerCase();
  const sourceLabel = asString3(params.sourceLabel).toLowerCase();
  const sourceUrl = asString3(params.sourceUrl).toLowerCase();
  if (!sourceType && !sourceLabel && !sourceUrl)
    return "";
  return `source:${createHash3("sha256").update([sourceType, sourceLabel, sourceUrl].join("|")).digest("hex")}`;
}
function normalizeEngineSourceCurationStatus(value) {
  const text = asString3(value).toLowerCase();
  if (text === "trusted")
    return "trusted";
  if (text === "watchlist")
    return "watchlist";
  if (text === "archived")
    return "archived";
  return "candidate";
}
function computeEngineSourceTrustScore(row) {
  return clamp012(0.45 * clamp012(asNumber(row.ema_success, 0)) + 0.25 * clamp012(asNumber(row.ema_user_accept, 0)) + 0.15 * clamp012(asNumber(row.ema_latency, 0)) + 0.15 * (1 - clamp012(asNumber(row.ema_regret, 0))));
}
function classifyEngineSourceCuration(row) {
  const sampleCount = Math.max(0, Math.floor(asNumber(row.sample_count, 0)));
  const trustScore = clamp012(asNumber(row.trust_score, 0));
  const emaSuccess = clamp012(asNumber(row.ema_success, 0));
  const emaUserAccept = clamp012(asNumber(row.ema_user_accept, 0));
  const emaRegret = clamp012(asNumber(row.ema_regret, 0));
  const freshness = clamp012(asNumber(row.freshness_score, 0.5));
  if (sampleCount >= ENGINE_SOURCE_ARCHIVE_MIN_SAMPLES && (trustScore <= 0.35 || emaSuccess <= 0.35 || emaUserAccept <= 0.35 || emaRegret >= 0.65)) {
    return {
      status: "archived",
      reason: `low-performing source after ${sampleCount} samples (trust=${trustScore.toFixed(2)})`
    };
  }
  if (sampleCount >= ENGINE_SOURCE_PROMOTE_MIN_SAMPLES && trustScore >= 0.72 && emaRegret <= 0.35 && freshness >= 0.35) {
    return {
      status: "trusted",
      reason: `promoted: strong outcomes (trust=${trustScore.toFixed(2)}, samples=${sampleCount})`
    };
  }
  if (sampleCount >= ENGINE_SOURCE_WATCHLIST_MIN_SAMPLES && (trustScore <= 0.5 || emaRegret >= 0.5)) {
    return {
      status: "watchlist",
      reason: `watchlist: mixed outcomes (trust=${trustScore.toFixed(2)}, regret=${emaRegret.toFixed(2)})`
    };
  }
  return {
    status: "candidate",
    reason: `candidate: awaiting stable evidence (samples=${sampleCount})`
  };
}
function freshnessDecay(value, staleDays) {
  const freshness = clamp012(value);
  if (!Number.isFinite(staleDays) || staleDays <= 0)
    return freshness;
  const lambda = Math.log(2) / ENGINE_SOURCE_FRESHNESS_HALF_LIFE_DAYS;
  return clamp012(freshness * Math.exp(-lambda * staleDays));
}
function parseEngineBuildingBlockIdFromCandidateId(candidateId) {
  if (!candidateId.startsWith("cand_engine_"))
    return "";
  const suffix = candidateId.slice("cand_engine_".length);
  if (!suffix)
    return "";
  const pieces = suffix.split("_");
  if (pieces.length < 2)
    return "";
  pieces.pop();
  return pieces.join("_").trim();
}
function deriveEngineAlgorithmFromTitle(title) {
  const prefix = "engine building block:";
  const text = title.trim();
  if (!text)
    return "";
  if (!text.toLowerCase().startsWith(prefix))
    return "";
  return text.slice(prefix.length).trim();
}
function extractEngineTrialCandidateMeta(record) {
  const candidateId = asString3(record.id);
  const title = asString3(record.title);
  const trial = asObject2(record.engine_trial ?? record.engineTrial ?? record.engine_inspiration ?? record.engineInspiration ?? asObject2(record.debug).engine_trial ?? asObject2(record.debug).engineTrial);
  const explicitBlockId = asString3(trial.building_block_id ?? trial.buildingBlockId ?? trial.block_id ?? trial.blockId ?? trial.engine_building_block_id ?? trial.engineBuildingBlockId);
  const fallbackBlockId = parseEngineBuildingBlockIdFromCandidateId(candidateId);
  const buildingBlockId = explicitBlockId || fallbackBlockId;
  if (!buildingBlockId)
    return null;
  const explicitAlgorithm = asString3(trial.algorithm ?? trial.algo ?? trial.name);
  const algorithm = explicitAlgorithm || deriveEngineAlgorithmFromTitle(title) || "engine_building_block";
  const score = Number.isFinite(asNumber(trial.score, Number.NaN)) ? asNumber(trial.score, 0) : null;
  const source = asString3(trial.source) || (fallbackBlockId ? "engine_fallback" : "llm");
  const objectiveIds = asStringArray3(trial.objective_ids ?? trial.objectiveIds);
  const gapIds = asStringArray3(trial.gap_ids ?? trial.gapIds ?? trial.opportunity_gap_ids);
  const metadata = asObject2(trial.metadata);
  const inspirationSourceType = asString3(trial.source_type ?? trial.sourceType ?? metadata.source_type ?? metadata.sourceType);
  const inspirationSourceLabel = asString3(trial.source_label ?? trial.sourceLabel ?? metadata.source_label ?? metadata.sourceLabel);
  const inspirationSourceUrl = asString3(trial.source_url ?? trial.sourceUrl ?? metadata.source_url ?? metadata.sourceUrl);
  const inspirationSourceFingerprint = asString3(trial.source_fingerprint ?? trial.sourceFingerprint ?? metadata.source_fingerprint ?? metadata.sourceFingerprint);
  const inspirationSourceKey = asString3(trial.source_key ?? trial.sourceKey ?? metadata.source_key ?? metadata.sourceKey) || deriveInspirationSourceKey({
    sourceFingerprint: inspirationSourceFingerprint,
    sourceType: inspirationSourceType,
    sourceLabel: inspirationSourceLabel,
    sourceUrl: inspirationSourceUrl
  });
  if (inspirationSourceType)
    metadata.source_type = inspirationSourceType;
  if (inspirationSourceLabel)
    metadata.source_label = inspirationSourceLabel;
  if (inspirationSourceUrl)
    metadata.source_url = inspirationSourceUrl;
  if (inspirationSourceFingerprint)
    metadata.source_fingerprint = inspirationSourceFingerprint;
  if (inspirationSourceKey)
    metadata.source_key = inspirationSourceKey;
  const summary = asString3(trial.summary);
  if (summary)
    metadata.summary = summary;
  const hypothesis = asString3(trial.hypothesis);
  if (hypothesis)
    metadata.hypothesis = hypothesis;
  if (candidateId)
    metadata.candidate_id = candidateId;
  if (title)
    metadata.candidate_title = title;
  return {
    buildingBlockId,
    algorithm,
    source,
    score,
    objectiveIds,
    gapIds,
    inspirationSourceKey: inspirationSourceKey || null,
    inspirationSourceType: inspirationSourceType || null,
    inspirationSourceLabel: inspirationSourceLabel || null,
    inspirationSourceUrl: inspirationSourceUrl || null,
    inspirationSourceFingerprint: inspirationSourceFingerprint || null,
    metadata
  };
}
function normalizeTextList(value, maxItems = 16, maxChars = 240) {
  const out = [];
  const seen = new Set;
  for (const raw of asStringArray3(value)) {
    const text = truncateText(raw, maxChars);
    const key = text.toLowerCase();
    if (!text || seen.has(key))
      continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems)
      break;
  }
  return out;
}
function mergeUniqueText(base, incoming, maxItems = 24) {
  return normalizeTextList([...base, ...incoming], maxItems, 320);
}
function normalizeInspirationPatternEntry(raw) {
  const record = asObject2(raw);
  const algorithm = truncateText(asString3(record.algorithm ?? record.title ?? record.name), 220);
  const whenToUse = truncateText(asString3(record.when_to_use ?? record.whenToUse ?? record.context ?? record.use_case), 360);
  const summary = truncateText(asString3(record.summary ?? record.abstract ?? record.problem ?? record.content ?? record.notes), 2400);
  if (!algorithm || !whenToUse || !summary)
    return null;
  const sourceType = normalizeInspirationSourceType(record.source_type ?? record.sourceType ?? record.kind ?? record.type);
  const sourceLabel = truncateText(asString3(record.source_label ?? record.sourceLabel ?? record.source_name ?? record.sourceName), 240) || null;
  const sourceUrl = truncateText(asString3(record.source_url ?? record.sourceUrl ?? record.url), 1000) || null;
  const explicitSourceRef = truncateText(asString3(record.source_ref ?? record.sourceRef ?? record.reference), 1000) || null;
  const sourceRefs = normalizeTextList([explicitSourceRef, sourceUrl, sourceLabel, sourceType].filter(Boolean), 32, 1000);
  const risks = normalizeTextList(record.risks ?? record.risk_notes ?? record.riskNotes, 20, 320);
  const validationIdeas = normalizeTextList(record.validation ?? record.validation_ideas ?? record.validationIdeas ?? record.checks, 20, 320);
  const tags = uniqueLowercaseTokens(record.tags, 24);
  const qualityScore = clamp012(asNumber(record.quality_score ?? record.qualityScore, 0.5));
  const explicitFreshness = record.freshness_score ?? record.freshnessScore;
  const freshnessScore = Number.isFinite(asNumber(explicitFreshness, Number.NaN)) ? clamp012(asNumber(explicitFreshness, 0.5)) : (() => {
    const publishedAt = Date.parse(asString3(record.published_at ?? record.publishedAt));
    const ageDays = Number.isFinite(publishedAt) ? Math.max(0, (Date.now() - publishedAt) / (24 * 60 * 60 * 1000)) : 180;
    return clamp012(1 - ageDays / 365);
  })();
  const metadata = asObject2(record.metadata);
  if (sourceRefs.length > 0)
    metadata.source_refs = sourceRefs;
  const fingerprint = sha256Hex([algorithm.toLowerCase(), whenToUse.toLowerCase()].join(`
`));
  return {
    fingerprint,
    sourceType,
    sourceLabel,
    sourceUrl,
    sourceRefs,
    algorithm,
    whenToUse,
    summary,
    risks,
    validationIdeas,
    tags,
    qualityScore,
    freshnessScore,
    metadata
  };
}
function policyViolations(params) {
  const reasons = [];
  const objectiveType = params.objectiveType;
  const policy = OBJECTIVE_POLICY[objectiveType];
  if (!policy) {
    reasons.push(`unsupported objective_type "${params.objectiveType}"`);
    return reasons;
  }
  const riskLevel = asRiskLevel(params.riskLevel);
  if (!riskLevel) {
    reasons.push(`invalid risk_level "${params.riskLevel}"`);
  } else if (RISK_ORDER[riskLevel] > RISK_ORDER[policy.maxRisk]) {
    reasons.push(`risk_level "${riskLevel}" exceeds policy max "${policy.maxRisk}"`);
  }
  if (params.readAnywhere && !params.allowReadAnywhere) {
    reasons.push("read_anywhere=true is not allowlisted");
  }
  if (!policy.autonomousAllowed) {
    reasons.push(`objective_type "${objectiveType}" is not autonomous_allowed`);
  }
  if (policy.requireValidation && params.expectedValidation.length === 0) {
    reasons.push("expected_validation must contain at least one command");
  }
  return reasons;
}
function validateAnswerAgainstSchema(questionType, schema, answer) {
  if (questionType === "yes_no") {
    if (typeof answer === "boolean")
      return { valid: true, normalized: answer };
    if (typeof answer === "string") {
      const text = answer.trim().toLowerCase();
      if (["yes", "true", "y", "1"].includes(text))
        return { valid: true, normalized: true };
      if (["no", "false", "n", "0"].includes(text))
        return { valid: true, normalized: false };
    }
    return { valid: false, normalized: answer, error: "Expected yes/no answer." };
  }
  if (questionType === "single_choice") {
    const choices = asStringArray3(schema.choices);
    const selected = asString3(answer);
    if (!selected)
      return { valid: false, normalized: answer, error: "Answer is required." };
    if (choices.length > 0 && !choices.includes(selected)) {
      return {
        valid: false,
        normalized: answer,
        error: "Answer is not one of the allowed choices."
      };
    }
    return { valid: true, normalized: selected };
  }
  if (questionType === "multi_choice") {
    const choices = asStringArray3(schema.choices);
    const selected = Array.isArray(answer) ? answer.map((entry) => asString3(entry)).filter(Boolean) : [];
    if (selected.length === 0) {
      return { valid: false, normalized: answer, error: "Expected one or more selected choices." };
    }
    if (choices.length > 0 && selected.some((entry) => !choices.includes(entry))) {
      return {
        valid: false,
        normalized: answer,
        error: "One or more selected choices are invalid."
      };
    }
    return { valid: true, normalized: selected };
  }
  if (questionType === "bounded_text") {
    const text = asString3(answer);
    const minLength = Math.max(0, Math.floor(asNumber(schema.min_length, 0)));
    const maxLength = Math.max(minLength, Math.floor(asNumber(schema.max_length, 4000)));
    if (!text || text.length < minLength || text.length > maxLength) {
      return {
        valid: false,
        normalized: answer,
        error: `Text answer length must be between ${minLength} and ${maxLength} characters.`
      };
    }
    return { valid: true, normalized: text };
  }
  if (questionType === "json_payload") {
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
      return { valid: false, normalized: answer, error: "Expected a JSON object payload." };
    }
    const requiredKeys = asStringArray3(schema.required_keys);
    const record = answer;
    for (const key of requiredKeys) {
      if (!(key in record)) {
        return { valid: false, normalized: answer, error: `Missing required key "${key}".` };
      }
    }
    return { valid: true, normalized: record };
  }
  return { valid: false, normalized: answer, error: `Unknown question_type "${questionType}"` };
}

class AutonomyStore {
  db;
  get config() {
    return loadPushPalsConfig();
  }
  alpha = 0.2;
  lastInspirationMaintenanceAtMs = 0;
  lastEvaluatorRunAtMs = 0;
  lastStaleObjectiveSweepAtMs = 0;
  lastStaleObjectiveSweepAtIso = null;
  constructor(dbPath) {
    this.db = new Database5(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this._migrate();
  }
  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS autonomy_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        ttl_ms INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS autonomy_candidates (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        objective_type TEXT NOT NULL,
        problem_statement TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        component_area TEXT NOT NULL,
        target_paths_json TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        expected_validation_json TEXT NOT NULL,
        estimated_effort TEXT NOT NULL,
        why_now_signal_ids_json TEXT NOT NULL,
        confidence REAL NOT NULL,
        pattern_key TEXT NOT NULL,
        llm_score REAL,
        impact_signal REAL,
        ema_success REAL,
        ema_user_accept REAL,
        penalties_json TEXT,
        final_score REAL,
        selected INTEGER NOT NULL DEFAULT 0,
        rejection_reason TEXT,
        gate_decision TEXT,
        gate_reasons_json TEXT,
        debug_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS autonomy_objectives (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        candidate_id TEXT,
        title TEXT NOT NULL,
        instruction TEXT NOT NULL,
        objective_type TEXT NOT NULL,
        component_area TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        pattern_key TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'autonomous',
        confidence REAL NOT NULL,
        priority TEXT,
        risk_level TEXT NOT NULL,
        request_id TEXT,
        job_id TEXT,
        question_id TEXT,
        block_reason TEXT,
        scope_json TEXT NOT NULL,
        evidence_json TEXT,
        score_breakdown_json TEXT,
        policy_version TEXT,
        impact_model_version TEXT,
        dispatched_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS autonomy_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        objective_id TEXT,
        request_id TEXT,
        job_id TEXT,
        pattern_key TEXT NOT NULL,
        success INTEGER NOT NULL,
        retries INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER,
        user_action TEXT,
        reopened_within_24h INTEGER NOT NULL DEFAULT 0,
        regression_flag INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS autonomy_pattern_stats (
        pattern_key TEXT PRIMARY KEY,
        ema_success REAL NOT NULL DEFAULT 0,
        ema_user_accept REAL NOT NULL DEFAULT 0,
        ema_latency REAL NOT NULL DEFAULT 0,
        ema_regret REAL NOT NULL DEFAULT 0,
        fail_streak INTEGER NOT NULL DEFAULT 0,
        cooldown_until TEXT,
        sample_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS autonomy_engine_idea_trials (
        trial_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        objective_id TEXT,
        candidate_id TEXT,
        pattern_key TEXT NOT NULL,
        engine_building_block_id TEXT NOT NULL,
        engine_algorithm TEXT NOT NULL,
        engine_source TEXT NOT NULL DEFAULT 'llm',
        engine_score REAL,
        inspiration_source_key TEXT,
        inspiration_source_type TEXT,
        inspiration_source_label TEXT,
        inspiration_source_url TEXT,
        inspiration_source_fingerprint TEXT,
        objective_ids_json TEXT NOT NULL,
        gap_ids_json TEXT NOT NULL,
        metadata_json TEXT,
        status TEXT NOT NULL,
        success INTEGER,
        user_action TEXT,
        latency_ms INTEGER,
        last_outcome_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_autonomy_engine_trials_objective
        ON autonomy_engine_idea_trials(objective_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_autonomy_engine_trials_block
        ON autonomy_engine_idea_trials(engine_building_block_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS autonomy_engine_idea_stats (
        engine_building_block_id TEXT PRIMARY KEY,
        engine_algorithm TEXT NOT NULL,
        ema_success REAL NOT NULL DEFAULT 0,
        ema_user_accept REAL NOT NULL DEFAULT 0,
        ema_latency REAL NOT NULL DEFAULT 0,
        ema_regret REAL NOT NULL DEFAULT 0,
        sample_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS autonomy_engine_source_stats (
        source_key TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_label TEXT,
        source_url TEXT,
        source_fingerprint TEXT,
        source_algorithm TEXT NOT NULL,
        curation_status TEXT NOT NULL DEFAULT 'candidate',
        curation_reason TEXT,
        trust_score REAL NOT NULL DEFAULT 0,
        freshness_score REAL NOT NULL DEFAULT 0.5,
        last_reinforced_at TEXT,
        ema_success REAL NOT NULL DEFAULT 0,
        ema_user_accept REAL NOT NULL DEFAULT 0,
        ema_latency REAL NOT NULL DEFAULT 0,
        ema_regret REAL NOT NULL DEFAULT 0,
        sample_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_autonomy_engine_source_stats_type
        ON autonomy_engine_source_stats(source_type, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_autonomy_engine_source_stats_fingerprint
        ON autonomy_engine_source_stats(source_fingerprint, updated_at DESC);
      CREATE TABLE IF NOT EXISTS autonomy_inspiration_patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fingerprint TEXT NOT NULL UNIQUE,
        source_type TEXT NOT NULL,
        source_label TEXT,
        source_url TEXT,
        source_refs_json TEXT NOT NULL,
        algorithm TEXT NOT NULL,
        when_to_use TEXT NOT NULL,
        summary TEXT NOT NULL,
        risks_json TEXT NOT NULL,
        validation_json TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        quality_score REAL NOT NULL DEFAULT 0.5,
        freshness_score REAL NOT NULL DEFAULT 0.5,
        metadata_json TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        seen_count INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_autonomy_inspiration_updated
        ON autonomy_inspiration_patterns(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_autonomy_inspiration_source_updated
        ON autonomy_inspiration_patterns(source_type, updated_at DESC);
      CREATE TABLE IF NOT EXISTS autonomy_pr_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        feedback_key TEXT,
        objective_id TEXT,
        request_id TEXT,
        job_id TEXT,
        pattern_key TEXT NOT NULL,
        pr_number INTEGER,
        pr_url TEXT,
        verdict TEXT NOT NULL,
        review_score REAL,
        review_threshold REAL,
        summary TEXT,
        comment_count INTEGER NOT NULL DEFAULT 0,
        comments_json TEXT,
        source TEXT NOT NULL DEFAULT 'review_agent',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_autonomy_pr_feedback_pattern_created
        ON autonomy_pr_feedback(pattern_key, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_autonomy_pr_feedback_created
        ON autonomy_pr_feedback(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_autonomy_pr_feedback_job
        ON autonomy_pr_feedback(job_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_autonomy_pr_feedback_key
        ON autonomy_pr_feedback(feedback_key)
        WHERE feedback_key IS NOT NULL AND feedback_key <> '';
      CREATE TABLE IF NOT EXISTS questions_queue (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        question TEXT NOT NULL,
        question_type TEXT NOT NULL,
        expected_answer_schema_json TEXT,
        context_json TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        answer_json TEXT,
        answer_validation_status TEXT NOT NULL DEFAULT 'pending',
        validation_error TEXT,
        created_at TEXT NOT NULL,
        answered_at TEXT,
        expires_at TEXT
      );
      CREATE TABLE IF NOT EXISTS autonomy_safety_state (
        state_id TEXT PRIMARY KEY,
        kill_switch_enabled INTEGER NOT NULL DEFAULT 0,
        freeze_until TEXT,
        freeze_reason TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS autonomy_evaluator_scorecards (
        id TEXT PRIMARY KEY,
        window_hours INTEGER NOT NULL,
        sample_count INTEGER NOT NULL,
        success_rate REAL,
        regret_rate REAL,
        avg_latency_ms REAL,
        dispatch_count INTEGER NOT NULL DEFAULT 0,
        recommendation TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_autonomy_evaluator_scorecards_created
        ON autonomy_evaluator_scorecards(created_at DESC);
      CREATE TABLE IF NOT EXISTS autonomy_evaluator_freeze_evidence (
        state_id TEXT PRIMARY KEY,
        evidence_key TEXT NOT NULL,
        frozen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS autonomy_ops_alerts (
        id TEXT PRIMARY KEY,
        alert_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        details_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_autonomy_ops_alerts_created
        ON autonomy_ops_alerts(created_at DESC);
      CREATE TABLE IF NOT EXISTS autonomy_ops_alert_state (
        alert_type TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'open',
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        details_json TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        resolved_at TEXT,
        occurrence_count INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_autonomy_ops_alert_state_status
        ON autonomy_ops_alert_state(status, last_seen_at DESC);
      CREATE TABLE IF NOT EXISTS autonomy_dead_letters (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        previous_status TEXT NOT NULL,
        reason TEXT NOT NULL,
        details_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_autonomy_dead_letters_created
        ON autonomy_dead_letters(created_at DESC);
      CREATE TABLE IF NOT EXISTS autonomy_llm_calls (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        objective_id TEXT,
        phase TEXT NOT NULL,
        prompt_template_version TEXT,
        prompt_hash TEXT,
        request_payload_hash TEXT,
        model_id TEXT,
        temperature REAL,
        timeout_ms INTEGER,
        response_json TEXT,
        response_hash TEXT,
        token_usage_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS llm_usage_events (
        id TEXT PRIMARY KEY,
        service TEXT NOT NULL,
        session_id TEXT,
        backend TEXT,
        model_id TEXT,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        estimated INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_llm_usage_events_created
        ON llm_usage_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_llm_usage_events_service_created
        ON llm_usage_events(service, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_llm_usage_events_session_created
        ON llm_usage_events(session_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS autonomy_dispatch_lock (
        lock_id TEXT PRIMARY KEY,
        owner_session_id TEXT NOT NULL,
        owner_run_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const ensureColumn = (table, columnSql) => {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnSql}`);
      } catch {}
    };
    ensureColumn("autonomy_engine_idea_trials", "inspiration_source_key TEXT");
    ensureColumn("autonomy_engine_idea_trials", "inspiration_source_type TEXT");
    ensureColumn("autonomy_engine_idea_trials", "inspiration_source_label TEXT");
    ensureColumn("autonomy_engine_idea_trials", "inspiration_source_url TEXT");
    ensureColumn("autonomy_engine_idea_trials", "inspiration_source_fingerprint TEXT");
    ensureColumn("autonomy_engine_source_stats", "curation_status TEXT NOT NULL DEFAULT 'candidate'");
    ensureColumn("autonomy_engine_source_stats", "curation_reason TEXT");
    ensureColumn("autonomy_engine_source_stats", "trust_score REAL NOT NULL DEFAULT 0");
    ensureColumn("autonomy_engine_source_stats", "freshness_score REAL NOT NULL DEFAULT 0.5");
    ensureColumn("autonomy_engine_source_stats", "last_reinforced_at TEXT");
    ensureColumn("questions_queue", "closed_reason TEXT");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_autonomy_engine_trials_source
        ON autonomy_engine_idea_trials(inspiration_source_key, created_at DESC);
    `);
    const now = asIsoNow();
    this.db.prepare(`INSERT OR IGNORE INTO autonomy_safety_state (
          state_id, kill_switch_enabled, freeze_until, freeze_reason, updated_at
        ) VALUES ('global', 0, NULL, NULL, ?)`).run(now);
  }
  getDispatchCountsLastHour(nowIso) {
    const rows = this.db.prepare(`SELECT objective_type AS objectiveType, component_area AS componentArea, COUNT(*) AS count
         FROM autonomy_objectives
         WHERE dispatched_at IS NOT NULL
            AND datetime(dispatched_at) >= datetime(?, '-1 hour')
         GROUP BY objective_type, component_area`).all(nowIso);
    const byType = {};
    const byComponent = {};
    let globalCount = 0;
    for (const row of rows) {
      const key = asString3(row.objectiveType);
      const component = asString3(row.componentArea);
      const count = Math.max(0, Math.floor(asNumber(row.count, 0)));
      if (key)
        byType[key] = (byType[key] ?? 0) + count;
      if (component)
        byComponent[component] = (byComponent[component] ?? 0) + count;
      globalCount += count;
    }
    return { globalCount, byType, byComponent };
  }
  hasTable(tableName) {
    const row = this.db.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`).get(tableName);
    return row?.present === 1;
  }
  getResourceUsageLastHour(nowIso) {
    const tokenRow = this.db.prepare(`SELECT SUM(total_tokens) AS total_tokens
         FROM llm_usage_events
         WHERE datetime(created_at) >= datetime(?, '-1 hour')`).get(nowIso);
    const tokenUsage = Math.max(0, Math.floor(asNumber(tokenRow?.total_tokens, 0)));
    const runtimeRow = this.db.prepare(`SELECT SUM(CASE WHEN latency_ms IS NOT NULL THEN latency_ms ELSE 0 END) AS runtime_ms
         FROM autonomy_outcomes
         WHERE datetime(created_at) >= datetime(?, '-1 hour')`).get(nowIso);
    const runtimeMs = Math.max(0, Math.floor(asNumber(runtimeRow?.runtime_ms, 0)));
    let activeRuntimeMs = 0;
    if (this.hasTable("jobs")) {
      const activeRuntimeRow = this.db.prepare(`SELECT SUM(
             MIN(
               3600000,
               MAX(
                 0,
                 CAST((julianday(?) - julianday(COALESCE(startedAt, claimedAt))) * 86400000 AS INTEGER)
               )
             )
           ) AS active_runtime_ms
           FROM jobs
           WHERE status = 'claimed'
             AND COALESCE(startedAt, claimedAt) IS NOT NULL
             AND lower(COALESCE(
               json_extract(params, '$.origin'),
               json_extract(params, '$.autonomy.origin'),
               ''
             )) = 'autonomy'`).get(nowIso);
      activeRuntimeMs = Math.max(0, Math.floor(asNumber(activeRuntimeRow?.active_runtime_ms, 0)));
    }
    return {
      tokenUsage: Math.max(0, Math.floor(tokenUsage)),
      runtimeMs: runtimeMs + activeRuntimeMs,
      activeRuntimeMs
    };
  }
  resourceBudgetSnapshot(nowIso = asIsoNow()) {
    const usage = this.getResourceUsageLastHour(nowIso);
    const cfg = this.config.remotebuddy.autonomy;
    const tokenBudget = Math.max(0, Math.floor(asNumber(cfg.maxTokenUsagePerHour, 0)));
    const runtimeBudgetMs = Math.max(0, Math.floor(asNumber(cfg.maxRuntimeMsPerHour, 0)));
    return {
      rolling_window_seconds: 3600,
      token_usage_last_hour: usage.tokenUsage,
      runtime_ms_last_hour: usage.runtimeMs,
      token_budget_per_hour: tokenBudget,
      runtime_budget_ms_per_hour: runtimeBudgetMs,
      token_budget_exhausted: tokenBudget > 0 && usage.tokenUsage >= tokenBudget,
      runtime_budget_exhausted: runtimeBudgetMs > 0 && usage.runtimeMs >= runtimeBudgetMs,
      active_runtime_ms: usage.activeRuntimeMs
    };
  }
  resourceBudgetBlockReason(nowIso = asIsoNow()) {
    const snapshot = this.resourceBudgetSnapshot(nowIso);
    if (snapshot.token_budget_exhausted) {
      return `hourly token budget exceeded (${snapshot.token_usage_last_hour}/` + `${snapshot.token_budget_per_hour})`;
    }
    if (snapshot.runtime_budget_exhausted) {
      return `hourly runtime budget exceeded (${snapshot.runtime_ms_last_hour}/` + `${snapshot.runtime_budget_ms_per_hour} ms)`;
    }
    return null;
  }
  readSafetyStateRow() {
    const row = this.db.prepare(`SELECT kill_switch_enabled, freeze_until, freeze_reason, updated_at
         FROM autonomy_safety_state
         WHERE state_id = 'global'
         LIMIT 1`).get();
    if (row)
      return row;
    const now = asIsoNow();
    this.db.prepare(`INSERT OR IGNORE INTO autonomy_safety_state (
          state_id, kill_switch_enabled, freeze_until, freeze_reason, updated_at
        ) VALUES ('global', 0, NULL, NULL, ?)`).run(now);
    return {
      kill_switch_enabled: 0,
      freeze_until: null,
      freeze_reason: null,
      updated_at: now
    };
  }
  getSafetyState(nowIso = asIsoNow()) {
    const row = this.readSafetyStateRow();
    const freezeUntil = asString3(row.freeze_until) || null;
    const freezeUntilMs = freezeUntil ? Date.parse(freezeUntil) : Number.NaN;
    const nowMs = Date.parse(nowIso);
    const runtimeKillSwitch = Boolean(this.config.remotebuddy.autonomy.killSwitchEnabled);
    return {
      killSwitchEnabled: runtimeKillSwitch || asBoolean2(row.kill_switch_enabled, false),
      freezeUntil,
      freezeReason: asString3(row.freeze_reason) || null,
      isFrozen: Boolean(freezeUntil) && Number.isFinite(freezeUntilMs) && Number.isFinite(nowMs) && freezeUntilMs > nowMs,
      updatedAt: asString3(row.updated_at) || null
    };
  }
  updateSafetyState(body, nowIso = asIsoNow()) {
    const now = nowIso;
    const current = this.readSafetyStateRow();
    let killSwitchEnabled = asBoolean2(current.kill_switch_enabled, false);
    let freezeUntil = asString3(current.freeze_until) || null;
    let freezeReason = asString3(current.freeze_reason) || null;
    if (typeof body.killSwitchEnabled === "boolean" || typeof body.kill_switch_enabled === "boolean") {
      killSwitchEnabled = asBoolean2(body.killSwitchEnabled ?? body.kill_switch_enabled, false);
    }
    if (asBoolean2(body.unfreeze ?? body.clearFreeze ?? body.clear_freeze, false)) {
      freezeUntil = null;
      freezeReason = null;
    }
    const freezeForMsRaw = asNumber(body.freezeForMs ?? body.freeze_for_ms, Number.NaN);
    if (Number.isFinite(freezeForMsRaw) && freezeForMsRaw > 0) {
      const freezeForMs = Math.max(1000, Math.floor(freezeForMsRaw));
      freezeUntil = new Date(Date.parse(now) + freezeForMs).toISOString();
      freezeReason = asString3(body.freezeReason ?? body.freeze_reason) || "manual_freeze";
    }
    const freezeUntilInput = asString3(body.freezeUntil ?? body.freeze_until);
    if (freezeUntilInput) {
      const freezeUntilMs = Date.parse(freezeUntilInput);
      if (!Number.isFinite(freezeUntilMs)) {
        return {
          ok: false,
          reason: "freezeUntil must be a valid ISO timestamp",
          state: this.getSafetyState(now)
        };
      }
      freezeUntil = new Date(freezeUntilMs).toISOString();
      freezeReason = asString3(body.freezeReason ?? body.freeze_reason) || freezeReason || "manual_freeze";
    }
    this.db.prepare(`INSERT INTO autonomy_safety_state (
          state_id, kill_switch_enabled, freeze_until, freeze_reason, updated_at
        ) VALUES ('global', ?, ?, ?, ?)
        ON CONFLICT(state_id) DO UPDATE SET
          kill_switch_enabled = excluded.kill_switch_enabled,
          freeze_until = excluded.freeze_until,
          freeze_reason = excluded.freeze_reason,
          updated_at = excluded.updated_at`).run(killSwitchEnabled ? 1 : 0, freezeUntil, freezeReason, now);
    return { ok: true, state: this.getSafetyState(now) };
  }
  applyAutomaticFreeze(params) {
    const nowIso = params.nowIso || asIsoNow();
    const current = this.getSafetyState(nowIso);
    if (current.killSwitchEnabled || current.isFrozen) {
      return { applied: false, state: current };
    }
    const result = this.updateSafetyState({
      freezeForMs: params.freezeForMs,
      freezeReason: params.freezeReason
    }, nowIso);
    return { applied: result.ok && result.state.isFrozen, state: result.state };
  }
  safetyBlockReason(nowIso = asIsoNow()) {
    const state = this.getSafetyState(nowIso);
    if (state.killSwitchEnabled)
      return "autonomy kill switch enabled";
    if (state.isFrozen) {
      return `autonomy frozen until ${state.freezeUntil}`;
    }
    return null;
  }
  recordOpsAlert(params) {
    const nowIso = params.nowIso ?? asIsoNow();
    const alertType = asString3(params.alertType);
    const message = truncateText(asString3(params.message), 800);
    if (!alertType || !message)
      return;
    const existing = this.db.prepare(`SELECT status, severity, message, details_json, occurrence_count
         FROM autonomy_ops_alert_state
         WHERE alert_type = ?`).get(alertType);
    const detailsJson = JSON.stringify(asObject2(params.details));
    if (asString3(existing?.status).toLowerCase() === "open") {
      const materiallyChanged = asString3(existing?.severity) !== params.severity || asString3(existing?.message) !== message || asString3(existing?.details_json) !== detailsJson;
      this.db.prepare(`UPDATE autonomy_ops_alert_state
           SET severity = ?,
               message = ?,
               details_json = ?,
               last_seen_at = ?,
               occurrence_count = occurrence_count + ?
           WHERE alert_type = ?`).run(params.severity, message, detailsJson, nowIso, materiallyChanged ? 1 : 0, alertType);
      return;
    }
    this.db.prepare(`INSERT INTO autonomy_ops_alert_state (
           alert_type, status, severity, message, details_json,
           first_seen_at, last_seen_at, resolved_at, occurrence_count
         ) VALUES (?, 'open', ?, ?, ?, ?, ?, NULL, 1)
         ON CONFLICT(alert_type) DO UPDATE SET
           status = 'open',
           severity = excluded.severity,
           message = excluded.message,
           details_json = excluded.details_json,
           first_seen_at = excluded.first_seen_at,
           last_seen_at = excluded.last_seen_at,
           resolved_at = NULL,
           occurrence_count = 1`).run(alertType, params.severity, message, detailsJson, nowIso, nowIso);
    this.db.prepare(`INSERT INTO autonomy_ops_alerts (
          id, alert_type, severity, message, details_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`).run(`alert_${randomUUID5().slice(0, 8)}`, alertType, params.severity, message, detailsJson, nowIso);
  }
  resolveOpsAlert(alertTypeRaw, nowIso = asIsoNow()) {
    const alertType = asString3(alertTypeRaw);
    if (!alertType)
      return;
    this.db.prepare(`UPDATE autonomy_ops_alert_state
         SET status = 'resolved',
             last_seen_at = ?,
             resolved_at = ?
         WHERE alert_type = ?
           AND status = 'open'`).run(nowIso, nowIso, alertType);
  }
  listRecentOpsAlerts(limit = 20) {
    const rows = this.db.prepare(`SELECT alert_type, status, severity, message, details_json,
                first_seen_at, last_seen_at, resolved_at, occurrence_count
         FROM autonomy_ops_alert_state
         WHERE status = 'open'
         ORDER BY last_seen_at DESC
         LIMIT ?`).all(Math.max(1, Math.min(200, Math.floor(limit))));
    return rows.map((row) => {
      const severityRaw = asString3(row.severity).toLowerCase();
      const severity = severityRaw === "critical" ? "critical" : severityRaw === "warning" ? "warning" : "info";
      return {
        id: `alert_state_${sha256Hex(asString3(row.alert_type)).slice(0, 12)}`,
        alertType: asString3(row.alert_type) || "generic",
        severity,
        message: asString3(row.message),
        details: parseJsonObject(row.details_json),
        createdAt: asString3(row.first_seen_at),
        status: asString3(row.status) === "resolved" ? "resolved" : "open",
        firstSeenAt: asString3(row.first_seen_at),
        lastSeenAt: asString3(row.last_seen_at),
        resolvedAt: asString3(row.resolved_at) || null,
        occurrenceCount: Math.max(1, Math.floor(asNumber(row.occurrence_count, 1)))
      };
    });
  }
  getAutonomyJobHealth(nowIso, windowHours) {
    if (!this.hasTable("jobs")) {
      return {
        terminalCount: 0,
        successRate: null,
        timeoutRate: null,
        activeRuntimeMs: 0,
        repeatedFailureCount: 0,
        latestTerminalAt: null
      };
    }
    const health = this.db.prepare(`SELECT
           COUNT(*) AS terminal_count,
           MAX(COALESCE(
             j.completedAt,
             j.failedAt,
             j.publishBlockedAt,
             j.abandonedAt,
             j.updatedAt
           )) AS latest_terminal_at,
           SUM(CASE WHEN j.status = 'completed' THEN 1 ELSE 0 END) AS success_count,
           SUM(
             CASE
               WHEN lower(COALESCE(d.failureClass, '')) LIKE '%timeout%'
                 OR lower(COALESCE(d.failureClass, '')) LIKE '%watchdog%'
                 OR lower(COALESCE(d.summary, j.error, '')) LIKE '%timed out%'
                 OR lower(COALESCE(d.summary, j.error, '')) LIKE '%timeout%'
               THEN 1
               ELSE 0
             END
           ) AS timeout_count
         FROM jobs j
         LEFT JOIN job_terminal_diagnostics d ON d.jobId = j.id
         WHERE j.kind = 'task.execute'
           AND j.status IN ('completed', 'failed', 'abandoned', 'publish_blocked')
           AND datetime(COALESCE(
                 j.completedAt,
                 j.failedAt,
                 j.publishBlockedAt,
                 j.abandonedAt,
                 j.updatedAt
               )) >= datetime(?, '-${Math.max(1, windowHours)} hours')
           AND lower(COALESCE(
             json_extract(j.params, '$.origin'),
             json_extract(j.params, '$.autonomy.origin'),
             ''
           )) = 'autonomy'`).get(nowIso);
    const terminalCount = Math.max(0, Math.floor(asNumber(health?.terminal_count, 0)));
    const successCount = Math.max(0, Math.floor(asNumber(health?.success_count, 0)));
    const timeoutCount = Math.max(0, Math.floor(asNumber(health?.timeout_count, 0)));
    const resourceUsage = this.getResourceUsageLastHour(nowIso);
    let repeatedFailureCount = 0;
    if (this.hasTable("job_validation_runs") && this.hasTable("job_terminal_diagnostics")) {
      const repeatedRows = this.db.prepare(`SELECT
             j.params,
             lower(COALESCE(v.failureClass, d.failureClass, 'unknown')) AS failure_class,
             lower(trim(COALESCE(v.command, ''))) AS failed_command,
             v.stdoutTail AS stdout_tail,
             v.stderrTail AS stderr_tail,
             d.summary
           FROM jobs j
           LEFT JOIN job_terminal_diagnostics d ON d.jobId = j.id
           LEFT JOIN job_validation_runs v
             ON v.id = (
               SELECT latest.id
               FROM job_validation_runs latest
               WHERE latest.jobId = j.id AND latest.passed = 0
               ORDER BY latest.id DESC
               LIMIT 1
             )
           WHERE j.kind = 'task.execute'
             AND j.status IN ('failed', 'abandoned', 'publish_blocked')
             AND datetime(COALESCE(j.failedAt, j.publishBlockedAt, j.abandonedAt, j.updatedAt))
                 >= datetime(?, '-${Math.max(1, windowHours)} hours')
             AND lower(COALESCE(
               json_extract(j.params, '$.origin'),
               json_extract(j.params, '$.autonomy.origin'),
               ''
             )) = 'autonomy'
           ORDER BY COALESCE(j.failedAt, j.publishBlockedAt, j.abandonedAt, j.updatedAt) DESC
           LIMIT 500`).all(nowIso);
      const fingerprintCounts = new Map;
      for (const row of repeatedRows) {
        const targets = normalizedAutonomyFailureTargets(parseJsonObject(row.params));
        if (targets.length === 0)
          continue;
        const fingerprint = sha256Hex(JSON.stringify({
          targets,
          failureClass: asString3(row.failure_class).toLowerCase() || "unknown",
          command: asString3(row.failed_command).replace(/\s+/g, " ").toLowerCase(),
          failedTests: failedTestNamesFromOutput(row.stdout_tail, row.stderr_tail, row.summary)
        })).slice(0, 24);
        const count = (fingerprintCounts.get(fingerprint) ?? 0) + 1;
        fingerprintCounts.set(fingerprint, count);
        repeatedFailureCount = Math.max(repeatedFailureCount, count);
      }
    }
    return {
      terminalCount,
      successRate: terminalCount > 0 ? clamp012(successCount / terminalCount) : null,
      timeoutRate: terminalCount > 0 ? clamp012(timeoutCount / terminalCount) : null,
      activeRuntimeMs: resourceUsage.activeRuntimeMs,
      repeatedFailureCount,
      latestTerminalAt: asString3(health?.latest_terminal_at) || null
    };
  }
  latestEvaluatorScorecard() {
    const row = this.db.prepare(`SELECT id, window_hours, sample_count, success_rate, regret_rate, avg_latency_ms, dispatch_count,
                recommendation, payload_json, created_at
         FROM autonomy_evaluator_scorecards
         ORDER BY created_at DESC
         LIMIT 1`).get();
    if (!row)
      return null;
    const recommendationRaw = asString3(row.recommendation).toLowerCase();
    const recommendation = recommendationRaw === "pause" ? "pause" : recommendationRaw === "constrain" ? "constrain" : "healthy";
    const payload = parseJsonObject(row.payload_json);
    return {
      id: asString3(row.id),
      windowHours: Math.max(1, Math.floor(asNumber(row.window_hours, 24))),
      sampleCount: Math.max(0, Math.floor(asNumber(row.sample_count, 0))),
      successRate: Number.isFinite(asNumber(row.success_rate, Number.NaN)) ? clamp012(asNumber(row.success_rate, 0)) : null,
      regretRate: Number.isFinite(asNumber(row.regret_rate, Number.NaN)) ? clamp012(asNumber(row.regret_rate, 0)) : null,
      avgLatencyMs: Number.isFinite(asNumber(row.avg_latency_ms, Number.NaN)) ? Math.max(0, Math.floor(asNumber(row.avg_latency_ms, 0))) : null,
      dispatchCount: Math.max(0, Math.floor(asNumber(row.dispatch_count, 0))),
      jobTerminalCount: Math.max(0, Math.floor(asNumber(payload.jobTerminalCount, 0))),
      jobSuccessRate: Number.isFinite(asNumber(payload.jobSuccessRate, Number.NaN)) ? clamp012(asNumber(payload.jobSuccessRate, 0)) : null,
      jobTimeoutRate: Number.isFinite(asNumber(payload.jobTimeoutRate, Number.NaN)) ? clamp012(asNumber(payload.jobTimeoutRate, 0)) : null,
      activeRuntimeMs: Math.max(0, Math.floor(asNumber(payload.activeRuntimeMs, 0))),
      repeatedFailureCount: Math.max(0, Math.floor(asNumber(payload.repeatedFailureCount, 0))),
      tokenBudgetExhausted: asBoolean2(payload.tokenBudgetExhausted, false),
      runtimeBudgetExhausted: asBoolean2(payload.runtimeBudgetExhausted, false),
      recommendation,
      createdAt: asString3(row.created_at)
    };
  }
  runEvaluator(nowIso = asIsoNow()) {
    const cfg = this.config.remotebuddy.autonomy;
    const windowHours = Math.max(1, Math.floor(asNumber(cfg.evaluatorWindowHours, 24)));
    const rows = this.db.prepare(`WITH windowed AS (
           SELECT id, success, latency_ms, reopened_within_24h, regression_flag, created_at,
                  CASE
                    WHEN NULLIF(objective_id, '') IS NOT NULL THEN 'objective:' || objective_id
                    WHEN NULLIF(job_id, '') IS NOT NULL THEN 'job:' || job_id
                    WHEN NULLIF(request_id, '') IS NOT NULL THEN 'request:' || request_id
                    ELSE 'outcome:' || id
                  END AS sample_key
           FROM autonomy_outcomes
           WHERE datetime(created_at) >= datetime(?, '-${Math.max(1, windowHours)} hours')
         ),
         ranked AS (
           SELECT windowed.*,
                  ROW_NUMBER() OVER (
                    PARTITION BY sample_key
                    ORDER BY datetime(created_at) DESC, id DESC
                  ) AS recency_rank
           FROM windowed
         ),
         latest AS (
           SELECT *
           FROM ranked
           WHERE recency_rank = 1
         )
         SELECT (SELECT COUNT(*) FROM windowed) AS raw_sample_count,
                COUNT(*) AS sample_count,
                SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS success_count,
                SUM(CASE WHEN reopened_within_24h = 1 OR regression_flag = 1 THEN 1 ELSE 0 END) AS regret_count,
                AVG(CASE WHEN latency_ms IS NOT NULL THEN latency_ms END) AS avg_latency_ms,
                MAX(created_at) AS latest_outcome_at
         FROM latest`).get(nowIso);
    const dispatchRow = this.db.prepare(`SELECT COUNT(*) AS count
         FROM autonomy_objectives
         WHERE dispatched_at IS NOT NULL
           AND datetime(dispatched_at) >= datetime(?, '-${Math.max(1, windowHours)} hours')`).get(nowIso);
    const sampleCount = Math.max(0, Math.floor(asNumber(rows?.sample_count, 0)));
    const successCount = Math.max(0, Math.floor(asNumber(rows?.success_count, 0)));
    const regretCount = Math.max(0, Math.floor(asNumber(rows?.regret_count, 0)));
    const successRate = sampleCount > 0 ? clamp012(successCount / sampleCount) : null;
    const regretRate = sampleCount > 0 ? clamp012(regretCount / sampleCount) : null;
    const avgLatencyMs = Number.isFinite(asNumber(rows?.avg_latency_ms, Number.NaN)) ? Math.max(0, Math.floor(asNumber(rows?.avg_latency_ms, 0))) : null;
    const dispatchCount = Math.max(0, Math.floor(asNumber(dispatchRow?.count, 0)));
    const minSamples = Math.max(1, Math.floor(asNumber(cfg.evaluatorMinSamples, 1)));
    const minSuccessRate = clamp012(asNumber(cfg.evaluatorMinSuccessRate, 0.45));
    const maxRegretRate = clamp012(asNumber(cfg.evaluatorMaxRegretRate, 0.35));
    const rawSampleCount = Math.max(0, Math.floor(asNumber(rows?.raw_sample_count, sampleCount)));
    const jobHealth = this.getAutonomyJobHealth(nowIso, windowHours);
    const resourceBudget = this.resourceBudgetSnapshot(nowIso);
    const hasOutcomeEvidence = sampleCount >= minSamples;
    const hasJobEvidence = jobHealth.terminalCount >= minSamples;
    let recommendation = "healthy";
    if (resourceBudget.token_budget_exhausted || resourceBudget.runtime_budget_exhausted) {
      recommendation = "pause";
    } else if (!hasOutcomeEvidence && !hasJobEvidence) {
      recommendation = "constrain";
    } else if (hasOutcomeEvidence && (typeof successRate === "number" && successRate < minSuccessRate || typeof regretRate === "number" && regretRate > maxRegretRate) || hasJobEvidence && (typeof jobHealth.successRate === "number" && jobHealth.successRate < 0.6 || typeof jobHealth.timeoutRate === "number" && jobHealth.timeoutRate >= 0.35 || typeof jobHealth.successRate === "number" && typeof jobHealth.timeoutRate === "number" && jobHealth.successRate < 0.8 && jobHealth.timeoutRate >= 0.2)) {
      recommendation = "pause";
    } else if (hasOutcomeEvidence && (typeof successRate === "number" && successRate < Math.min(1, Math.max(0.8, minSuccessRate + 0.08)) || typeof regretRate === "number" && regretRate > maxRegretRate * 0.8) || hasJobEvidence && (typeof jobHealth.successRate === "number" && jobHealth.successRate < 0.8 || typeof jobHealth.timeoutRate === "number" && jobHealth.timeoutRate >= 0.2) || jobHealth.repeatedFailureCount >= 2) {
      recommendation = "constrain";
    }
    const evaluatorEvidenceKey = sha256Hex(JSON.stringify({
      rawSampleCount,
      sampleCount,
      successCount,
      regretCount,
      latestOutcomeAt: asString3(rows?.latest_outcome_at) || null,
      jobTerminalCount: jobHealth.terminalCount,
      jobSuccessRate: jobHealth.successRate,
      jobTimeoutRate: jobHealth.timeoutRate,
      repeatedFailureCount: jobHealth.repeatedFailureCount,
      latestJobTerminalAt: jobHealth.latestTerminalAt
    })).slice(0, 24);
    const resourcePause = resourceBudget.token_budget_exhausted || resourceBudget.runtime_budget_exhausted;
    if (recommendation === "pause" && !resourcePause) {
      const consumedEvidence = this.db.prepare(`SELECT evidence_key
           FROM autonomy_evaluator_freeze_evidence
           WHERE state_id = 'global'`).get();
      const safety = this.getSafetyState(nowIso);
      if (!safety.isFrozen && asString3(consumedEvidence?.evidence_key) === evaluatorEvidenceKey) {
        recommendation = "constrain";
      }
    }
    const payload = {
      minSamples,
      minSuccessRate,
      maxRegretRate,
      rawSampleCount,
      sampleCount,
      successRate,
      regretRate,
      avgLatencyMs,
      dispatchCount,
      jobTerminalCount: jobHealth.terminalCount,
      jobSuccessRate: jobHealth.successRate,
      jobTimeoutRate: jobHealth.timeoutRate,
      activeRuntimeMs: jobHealth.activeRuntimeMs,
      repeatedFailureCount: jobHealth.repeatedFailureCount,
      tokenBudgetExhausted: resourceBudget.token_budget_exhausted,
      runtimeBudgetExhausted: resourceBudget.runtime_budget_exhausted,
      evaluatorEvidenceKey
    };
    const id = `eval_${randomUUID5().slice(0, 8)}`;
    this.db.prepare(`INSERT INTO autonomy_evaluator_scorecards (
          id, window_hours, sample_count, success_rate, regret_rate, avg_latency_ms, dispatch_count,
          recommendation, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, windowHours, sampleCount, successRate, regretRate, avgLatencyMs, dispatchCount, recommendation, JSON.stringify(payload), nowIso);
    if (recommendation === "pause" && (hasOutcomeEvidence || hasJobEvidence || resourceBudget.token_budget_exhausted || resourceBudget.runtime_budget_exhausted)) {
      this.recordOpsAlert({
        alertType: "evaluator_pause",
        severity: "critical",
        message: `Evaluator recommends pause: successRate=${successRate?.toFixed(2) ?? "n/a"} ` + `regretRate=${regretRate?.toFixed(2) ?? "n/a"} jobSuccessRate=${jobHealth.successRate?.toFixed(2) ?? "n/a"} ` + `jobTimeoutRate=${jobHealth.timeoutRate?.toFixed(2) ?? "n/a"} samples=${sampleCount}/${jobHealth.terminalCount}`,
        details: payload,
        nowIso
      });
      if (!resourcePause) {
        this.db.prepare(`INSERT INTO autonomy_evaluator_freeze_evidence (
               state_id, evidence_key, frozen_at
             ) VALUES ('global', ?, ?)
             ON CONFLICT(state_id) DO UPDATE SET
               evidence_key = excluded.evidence_key,
               frozen_at = excluded.frozen_at`).run(evaluatorEvidenceKey, nowIso);
      }
      this.applyAutomaticFreeze({
        freezeForMs: Math.max(60000, Math.floor(asNumber(cfg.autoFreezeDurationMs, 1800000))),
        freezeReason: "auto_freeze:evaluator_pause",
        nowIso
      });
      this.resolveOpsAlert("evaluator_constrain", nowIso);
    } else if (recommendation === "constrain" && (hasOutcomeEvidence || hasJobEvidence)) {
      this.recordOpsAlert({
        alertType: "evaluator_constrain",
        severity: "warning",
        message: `Evaluator recommends constrain: successRate=${successRate?.toFixed(2) ?? "n/a"} ` + `regretRate=${regretRate?.toFixed(2) ?? "n/a"} jobSuccessRate=${jobHealth.successRate?.toFixed(2) ?? "n/a"} ` + `jobTimeoutRate=${jobHealth.timeoutRate?.toFixed(2) ?? "n/a"} samples=${sampleCount}/${jobHealth.terminalCount}`,
        details: payload,
        nowIso
      });
      this.resolveOpsAlert("evaluator_pause", nowIso);
    } else {
      this.resolveOpsAlert("evaluator_pause", nowIso);
      this.resolveOpsAlert("evaluator_constrain", nowIso);
    }
    if (recommendation !== "pause") {
      const safety = this.getSafetyState(nowIso);
      const evaluatorFreeze = safety.freezeReason === "auto_freeze:evaluator_pause";
      const expiredAutomaticFreeze = !safety.isFrozen && Boolean(safety.freezeReason?.startsWith("auto_freeze:"));
      if (evaluatorFreeze || expiredAutomaticFreeze) {
        this.updateSafetyState({ clearFreeze: true }, nowIso);
      }
    }
    return {
      id,
      windowHours,
      sampleCount,
      successRate,
      regretRate,
      avgLatencyMs,
      dispatchCount,
      jobTerminalCount: jobHealth.terminalCount,
      jobSuccessRate: jobHealth.successRate,
      jobTimeoutRate: jobHealth.timeoutRate,
      activeRuntimeMs: jobHealth.activeRuntimeMs,
      repeatedFailureCount: jobHealth.repeatedFailureCount,
      tokenBudgetExhausted: resourceBudget.token_budget_exhausted,
      runtimeBudgetExhausted: resourceBudget.runtime_budget_exhausted,
      recommendation,
      createdAt: nowIso
    };
  }
  maybeRunEvaluator(nowIso = asIsoNow()) {
    const intervalMs = Math.max(1e4, Math.floor(asNumber(this.config.remotebuddy.autonomy.evaluatorRunIntervalMs, 120000)));
    const nowMs = Date.parse(nowIso);
    if (!Number.isFinite(nowMs))
      return this.latestEvaluatorScorecard();
    if (this.lastEvaluatorRunAtMs > 0 && nowMs - this.lastEvaluatorRunAtMs < intervalMs) {
      return this.latestEvaluatorScorecard();
    }
    const card = this.runEvaluator(nowIso);
    this.lastEvaluatorRunAtMs = nowMs;
    return card;
  }
  maybeSweepStaleObjectives(nowIso = asIsoNow()) {
    const cfg = this.config.remotebuddy.autonomy;
    const intervalMs = Math.max(5000, Math.floor(asNumber(cfg.staleObjectiveSweepIntervalMs, 60000)));
    const nowMs = Date.parse(nowIso);
    if (!Number.isFinite(nowMs)) {
      return { ok: false, deadLettered: 0, scanned: 0, sweepAt: nowIso };
    }
    if (this.lastStaleObjectiveSweepAtMs > 0 && nowMs - this.lastStaleObjectiveSweepAtMs < intervalMs) {
      return {
        ok: true,
        deadLettered: 0,
        scanned: 0,
        sweepAt: this.lastStaleObjectiveSweepAtIso ?? nowIso
      };
    }
    this.lastStaleObjectiveSweepAtMs = nowMs;
    this.lastStaleObjectiveSweepAtIso = nowIso;
    const ttlMs = Math.max(60000, Math.floor(asNumber(cfg.staleObjectiveTtlMs, 2700000)));
    const rows = this.db.prepare(`SELECT id, status, updated_at, question_id
         FROM autonomy_objectives
         WHERE status IN ('proposed','gated','dispatched','running','blocked','needs_clarification')
         ORDER BY updated_at ASC
         LIMIT 400`).all();
    let deadLettered = 0;
    for (const row of rows) {
      const updatedAt = asString3(row.updated_at);
      const updatedAtMs = Date.parse(updatedAt);
      if (!Number.isFinite(updatedAtMs) || nowMs - updatedAtMs < ttlMs)
        continue;
      this.db.prepare(`UPDATE autonomy_objectives
           SET status = 'dead_letter',
               block_reason = 'stale_objective_timeout',
               updated_at = ?
           WHERE id = ?
             AND status IN ('proposed','gated','dispatched','running','blocked','needs_clarification')`).run(nowIso, row.id);
      this.db.prepare(`INSERT INTO autonomy_dead_letters (
            id, objective_id, previous_status, reason, details_json, created_at
          ) VALUES (?, ?, ?, 'stale_objective_timeout', ?, ?)`).run(`dl_${randomUUID5().slice(0, 10)}`, row.id, asString3(row.status) || "unknown", JSON.stringify({
        staleByMs: Math.max(0, nowMs - updatedAtMs),
        staleObjectiveTtlMs: ttlMs
      }), nowIso);
      if (asString3(row.question_id)) {
        this.db.prepare(`UPDATE questions_queue
             SET status = 'closed',
                 answer_validation_status = COALESCE(NULLIF(answer_validation_status, ''), 'stale'),
                 validation_error = COALESCE(validation_error, 'Objective timed out and was dead-lettered'),
                 closed_reason = 'stale_objective_timeout'
             WHERE id = ?
               AND status IN ('open','invalid')`).run(asString3(row.question_id));
      }
      deadLettered += 1;
    }
    if (deadLettered > 0) {
      this.recordOpsAlert({
        alertType: "stale_objective_dead_letter",
        severity: "warning",
        message: `Dead-lettered ${deadLettered} stale objective(s)`,
        details: { deadLettered, staleObjectiveTtlMs: ttlMs },
        nowIso
      });
    }
    return { ok: true, deadLettered, scanned: rows.length, sweepAt: nowIso };
  }
  getOpsSummary(params) {
    const now = asIsoNow();
    this.maybeSweepStaleObjectives(now);
    const safetyState = this.getSafetyState(now);
    const latestEvaluatorScorecard = this.maybeRunEvaluator(now);
    const deadLetterRow = this.db.prepare(`SELECT COUNT(*) AS count
         FROM autonomy_dead_letters
         WHERE datetime(created_at) >= datetime(?, '-24 hours')`).get(now);
    const staleDeadLetterCount24h = Math.max(0, Math.floor(asNumber(deadLetterRow?.count, 0)));
    const requestPending = Math.max(0, Math.floor(asNumber(params?.requestPending, 0)));
    const queuePendingThreshold = Math.max(1, Math.floor(asNumber(this.config.remotebuddy.autonomy.alertQueuePendingThreshold, 20)));
    if (params?.requestPending !== undefined && requestPending >= queuePendingThreshold) {
      this.recordOpsAlert({
        alertType: "request_queue_pending_high",
        severity: requestPending >= queuePendingThreshold * 2 ? "critical" : "warning",
        message: `Request pending queue high: ${requestPending} (threshold ${queuePendingThreshold})`,
        details: { requestPending, queuePendingThreshold },
        nowIso: now
      });
    } else if (params?.requestPending !== undefined) {
      this.resolveOpsAlert("request_queue_pending_high", now);
    }
    const jobFailureRate = clamp012(asNumber(params?.jobFailureRate, 0));
    const failureThreshold = clamp012(asNumber(this.config.remotebuddy.autonomy.alertJobFailureRateThreshold, 0.3));
    if (params?.jobFailureRate !== undefined && jobFailureRate >= failureThreshold && failureThreshold > 0) {
      this.recordOpsAlert({
        alertType: "job_failure_rate_high",
        severity: jobFailureRate >= failureThreshold * 1.4 ? "critical" : "warning",
        message: `Job failure rate high: ${(jobFailureRate * 100).toFixed(1)}% ` + `(threshold ${(failureThreshold * 100).toFixed(1)}%)`,
        details: { jobFailureRate, threshold: failureThreshold },
        nowIso: now
      });
    } else if (params?.jobFailureRate !== undefined) {
      this.resolveOpsAlert("job_failure_rate_high", now);
    }
    const resourceBudget = this.resourceBudgetSnapshot(now);
    if (resourceBudget.token_budget_exhausted) {
      this.recordOpsAlert({
        alertType: "resource_budget_token_exhausted",
        severity: "critical",
        message: `Hourly autonomy token budget exhausted: ${resourceBudget.token_usage_last_hour}/` + `${resourceBudget.token_budget_per_hour}`,
        details: resourceBudget,
        nowIso: now
      });
    } else {
      this.resolveOpsAlert("resource_budget_token_exhausted", now);
    }
    if (resourceBudget.runtime_budget_exhausted) {
      this.recordOpsAlert({
        alertType: "resource_budget_runtime_exhausted",
        severity: "critical",
        message: `Hourly autonomy runtime budget exhausted: ${resourceBudget.runtime_ms_last_hour}/` + `${resourceBudget.runtime_budget_ms_per_hour} ms`,
        details: resourceBudget,
        nowIso: now
      });
    } else {
      this.resolveOpsAlert("resource_budget_runtime_exhausted", now);
    }
    const recentAlerts = this.listRecentOpsAlerts(params?.alertLimit ?? 16);
    return {
      safetyState,
      latestEvaluatorScorecard,
      recentAlerts,
      staleDeadLetterCount24h,
      lastStaleSweepAt: this.lastStaleObjectiveSweepAtIso
    };
  }
  getSessionLlmUsageSummary(sessionIdRaw) {
    const sessionId = asString3(sessionIdRaw).trim();
    if (!sessionId)
      return null;
    const row = this.db.prepare(`SELECT
           SUM(prompt_tokens) AS prompt_tokens,
           SUM(completion_tokens) AS completion_tokens,
           SUM(total_tokens) AS total_tokens,
           COUNT(*) AS call_count,
           SUM(CASE WHEN estimated = 1 THEN 1 ELSE 0 END) AS estimated_call_count
         FROM llm_usage_events
         WHERE session_id = ?`).get(sessionId);
    const promptTokens = Math.max(0, Math.floor(asNumber(row?.prompt_tokens, 0)));
    const completionTokens = Math.max(0, Math.floor(asNumber(row?.completion_tokens, 0)));
    const totalTokens = Math.max(0, Math.floor(asNumber(row?.total_tokens, promptTokens + completionTokens)));
    return {
      sessionId,
      promptTokens,
      completionTokens,
      totalTokens,
      callCount: Math.max(0, Math.floor(asNumber(row?.call_count, 0))),
      estimatedCallCount: Math.max(0, Math.floor(asNumber(row?.estimated_call_count, 0)))
    };
  }
  getSessionTokenBudgetStatus(sessionIdRaw, limit, action = "pause") {
    const sessionId = asString3(sessionIdRaw).trim();
    const normalizedLimit = Math.max(0, Math.floor(asNumber(limit, 0)));
    if (!sessionId || normalizedLimit <= 0)
      return null;
    const usage = this.getSessionLlmUsageSummary(sessionId);
    if (!usage)
      return null;
    return {
      ...usage,
      limit: normalizedLimit,
      remainingTokens: Math.max(0, normalizedLimit - usage.totalTokens),
      exceeded: usage.totalTokens >= normalizedLimit,
      action
    };
  }
  recordLlmUsage(body, opts) {
    const service = normalizeServiceName(body.service);
    if (!service)
      return { ok: false, reason: "service is required" };
    const promptTokens = asNonNegativeInt(body.promptTokens ?? body.prompt_tokens);
    const completionTokens = asNonNegativeInt(body.completionTokens ?? body.completion_tokens);
    const explicitTotal = asNonNegativeInt(body.totalTokens ?? body.total_tokens);
    const totalTokens = explicitTotal > 0 ? explicitTotal : promptTokens + completionTokens;
    if (totalTokens <= 0)
      return { ok: false, reason: "token usage is required" };
    const sessionId = asString3(body.sessionId ?? body.session_id).trim();
    const sessionBudgetLimit = Math.max(0, Math.floor(asNumber(opts?.sessionTokenBudget, 0)));
    const sessionBudgetAction = opts?.sessionTokenBudgetAction ?? "pause";
    const beforeBudget = sessionId && sessionBudgetLimit > 0 ? this.getSessionTokenBudgetStatus(sessionId, sessionBudgetLimit, sessionBudgetAction) : null;
    this.db.prepare(`INSERT OR REPLACE INTO llm_usage_events (
          id, service, session_id, backend, model_id, prompt_tokens, completion_tokens,
          total_tokens, estimated, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(asString3(body.id) || randomUUID5(), service, sessionId || null, asString3(body.backend) || null, asString3(body.modelId ?? body.model_id) || null, promptTokens, completionTokens, totalTokens, asBoolean2(body.estimated, false) ? 1 : 0, asIsoNow());
    const sessionBudget = sessionId && sessionBudgetLimit > 0 ? this.getSessionTokenBudgetStatus(sessionId, sessionBudgetLimit, sessionBudgetAction) : null;
    return {
      ok: true,
      sessionBudget,
      crossedLimit: Boolean(sessionBudget?.exceeded && (!beforeBudget || beforeBudget.totalTokens < sessionBudget.limit))
    };
  }
  getLlmUsageSummary(params) {
    const rawWindowHours = asNonNegativeInt(params?.windowHours ?? 24);
    const windowHours = Math.max(1, rawWindowHours || 24);
    const nowIso = asIsoNow();
    const modifier = `-${windowHours} hours`;
    const overall = this.db.prepare(`SELECT
           SUM(prompt_tokens) AS prompt_tokens,
           SUM(completion_tokens) AS completion_tokens,
           SUM(total_tokens) AS total_tokens,
           COUNT(*) AS call_count,
           SUM(CASE WHEN estimated = 1 THEN 1 ELSE 0 END) AS estimated_call_count
         FROM llm_usage_events
         WHERE datetime(created_at) >= datetime(?, ?)`).get(nowIso, modifier);
    const serviceRows = this.db.prepare(`SELECT
           service,
           SUM(prompt_tokens) AS prompt_tokens,
           SUM(completion_tokens) AS completion_tokens,
           SUM(total_tokens) AS total_tokens,
           COUNT(*) AS call_count,
           SUM(CASE WHEN estimated = 1 THEN 1 ELSE 0 END) AS estimated_call_count,
           MAX(created_at) AS last_call_at
         FROM llm_usage_events
         WHERE datetime(created_at) >= datetime(?, ?)
         GROUP BY service
         ORDER BY total_tokens DESC, service ASC`).all(nowIso, modifier);
    const toServiceSummary = (row) => {
      const promptTokens2 = Math.max(0, Math.floor(asNumber(row.prompt_tokens, 0)));
      const completionTokens2 = Math.max(0, Math.floor(asNumber(row.completion_tokens, 0)));
      const totalTokens2 = Math.max(0, Math.floor(asNumber(row.total_tokens, promptTokens2 + completionTokens2)));
      const callCount2 = Math.max(0, Math.floor(asNumber(row.call_count, 0)));
      return {
        service: row.service,
        promptTokens: promptTokens2,
        completionTokens: completionTokens2,
        totalTokens: totalTokens2,
        callCount: callCount2,
        avgTokensPerHour: windowHours > 0 ? totalTokens2 / windowHours : 0,
        avgTokensPerCall: callCount2 > 0 ? totalTokens2 / callCount2 : null,
        estimatedCallCount: Math.max(0, Math.floor(asNumber(row.estimated_call_count, 0))),
        lastCallAt: row.last_call_at || null
      };
    };
    const promptTokens = Math.max(0, Math.floor(asNumber(overall?.prompt_tokens, 0)));
    const completionTokens = Math.max(0, Math.floor(asNumber(overall?.completion_tokens, 0)));
    const totalTokens = Math.max(0, Math.floor(asNumber(overall?.total_tokens, promptTokens + completionTokens)));
    const callCount = Math.max(0, Math.floor(asNumber(overall?.call_count, 0)));
    return {
      windowHours,
      promptTokens,
      completionTokens,
      totalTokens,
      callCount,
      avgTokensPerHour: windowHours > 0 ? totalTokens / windowHours : 0,
      avgTokensPerCall: callCount > 0 ? totalTokens / callCount : null,
      estimatedCallCount: Math.max(0, Math.floor(asNumber(overall?.estimated_call_count, 0))),
      services: serviceRows.map(toServiceSummary)
    };
  }
  recentExecutionHealthSummary() {
    let rows = [];
    try {
      rows = this.db.prepare(`SELECT j.result,
                  j.error,
                  COALESCE(j.failedAt, j.completedAt, j.updatedAt, j.createdAt) AS activity_at
           FROM jobs j
           JOIN autonomy_objectives obj ON obj.job_id = j.id
           WHERE LOWER(COALESCE(obj.source, 'autonomous')) = 'autonomous'
             AND datetime(COALESCE(j.failedAt, j.completedAt, j.updatedAt, j.createdAt)) >= datetime('now', '-24 hours')
           ORDER BY activity_at DESC
           LIMIT 200`).all();
    } catch {
      rows = [];
    }
    const nowMs = Date.now();
    let staleClaimFailures = 0;
    let staleClaimOldestMinutes = 0;
    let qualityRevisionJobs = 0;
    let qualityRevisionTotalAttempts = 0;
    let qualityRevisionFailures = 0;
    let qualityRevisionSoftPasses = 0;
    for (const row of rows) {
      const errorText = parseJobPayloadText(row.error);
      const resultText = parseJobPayloadText(row.result);
      const combined = `${resultText}
${errorText}`.trim();
      if (errorText && isStaleClaimFailureText(errorText)) {
        staleClaimFailures += 1;
        const activityAtMs = Date.parse(asString3(row.activity_at));
        if (Number.isFinite(activityAtMs)) {
          staleClaimOldestMinutes = Math.max(staleClaimOldestMinutes, Math.floor(Math.max(0, nowMs - activityAtMs) / 60000));
        }
      }
      const revisionInfo = combined ? extractQualityGateRevisionInfo(combined) : null;
      if (revisionInfo) {
        qualityRevisionJobs += 1;
        qualityRevisionTotalAttempts += revisionInfo.attempts;
        if (revisionInfo.failed)
          qualityRevisionFailures += 1;
        if (revisionInfo.softPass)
          qualityRevisionSoftPasses += 1;
      }
    }
    return {
      staleClaimFailures,
      staleClaimOldestMinutes,
      qualityRevisionJobs,
      qualityRevisionTotalAttempts,
      qualityRevisionFailures,
      qualityRevisionSoftPasses
    };
  }
  detectActiveValidationIncident(nowIso) {
    let rows = [];
    try {
      rows = this.db.prepare(`SELECT v.jobId AS jobId,
                  v.command AS command,
                  v.passed AS passed,
                  v.failureClass AS failureClass,
                  v.stdoutTail AS stdoutTail,
                  v.stderrTail AS stderrTail,
                  v.createdAt AS createdAt,
                  j.status AS jobStatus
           FROM job_validation_runs v
           JOIN jobs j ON j.id = v.jobId
           WHERE datetime(v.createdAt) >= datetime(?, '-24 hours')
           ORDER BY v.createdAt DESC, v.id DESC
           LIMIT 240`).all(nowIso);
    } catch {
      return null;
    }
    const groups = new Map;
    const failedJobStatuses = new Set(["failed", "abandoned", "publish_blocked"]);
    for (const row of rows) {
      const command = normalizeValidationCommand(row.command);
      if (!command)
        continue;
      const createdAt = asString3(row.createdAt);
      const createdAtMs = Date.parse(createdAt);
      const group = groups.get(command) ?? {
        command,
        totalRuns: 0,
        failureCount: 0,
        failedJobIds: new Set,
        lastFailure: null,
        latestFailAtMs: 0,
        latestPassAtMs: 0,
        firstFailedAt: null,
        requiredCommands: new Set,
        pathHints: []
      };
      groups.set(command, group);
      group.totalRuns += 1;
      if (Number(row.passed) === 1) {
        if (Number.isFinite(createdAtMs)) {
          group.latestPassAtMs = Math.max(group.latestPassAtMs, createdAtMs);
        }
        continue;
      }
      if (!failedJobStatuses.has(asString3(row.jobStatus)))
        continue;
      if (isNonRepairableValidationEnvironmentFailure(row.failureClass, row.stdoutTail, row.stderrTail)) {
        continue;
      }
      const jobId = asString3(row.jobId);
      if (!jobId)
        continue;
      group.failureCount += 1;
      group.failedJobIds.add(jobId);
      if (Number.isFinite(createdAtMs)) {
        if (createdAtMs >= group.latestFailAtMs) {
          group.latestFailAtMs = createdAtMs;
          group.lastFailure = row;
        }
        if (!group.firstFailedAt || createdAtMs < Date.parse(group.firstFailedAt)) {
          group.firstFailedAt = createdAt;
        }
      } else if (!group.lastFailure) {
        group.lastFailure = row;
      }
      group.requiredCommands.add(command);
      const hints = collectValidationPathHints(asString3(row.stderrTail), asString3(row.stdoutTail), command);
      for (const hint of hints) {
        if (!group.pathHints.includes(hint))
          group.pathHints.push(hint);
      }
    }
    for (const row of rows) {
      const jobId = asString3(row.jobId);
      const command = normalizeValidationCommand(row.command);
      if (!jobId || !command)
        continue;
      for (const group of groups.values()) {
        if (group.failedJobIds.has(jobId))
          group.requiredCommands.add(command);
      }
    }
    const activeGroups = [...groups.values()].filter((group) => group.failureCount >= 2).filter((group) => group.latestFailAtMs > group.latestPassAtMs).sort((a, b) => {
      if (b.failureCount !== a.failureCount)
        return b.failureCount - a.failureCount;
      if (b.failedJobIds.size !== a.failedJobIds.size) {
        return b.failedJobIds.size - a.failedJobIds.size;
      }
      return b.latestFailAtMs - a.latestFailAtMs;
    });
    const selected = activeGroups[0];
    if (!selected?.lastFailure)
      return null;
    const sample = truncateText(asString3(selected.lastFailure.stderrTail) || asString3(selected.lastFailure.stdoutTail), 900);
    const failureClass = asString3(selected.lastFailure.failureClass) || null;
    const digest = validationIncidentDigest(selected.command, failureClass, sample);
    return {
      active: true,
      incident_id: `valid_inc_${digest}`,
      command: selected.command,
      signal_type: validationSignalType(selected.command, failureClass, sample),
      failure_class: failureClass,
      failure_count: selected.failureCount,
      total_runs: selected.totalRuns,
      failed_job_ids: [...selected.failedJobIds].slice(0, 8),
      last_failed_job_id: asString3(selected.lastFailure.jobId) || null,
      first_failed_at: selected.firstFailedAt,
      last_failed_at: asString3(selected.lastFailure.createdAt) || null,
      digest,
      sample_error: sample,
      required_commands: [...selected.requiredCommands].slice(0, 8),
      target_path_hints: selected.pathHints.slice(0, 8)
    };
  }
  buildTopSignals(requestSlo, jobSlo, executionHealth, validationIncident) {
    const topSignals = [];
    if (validationIncident?.active) {
      topSignals.push({
        signal_id: "sig_validation_incident",
        type: validationIncident.signal_type,
        value: clamp012(0.6 + validationIncident.failure_count / 10),
        evidence: `required validation failing: ${validationIncident.command} ` + `failures=${validationIncident.failure_count} jobs=${validationIncident.failed_job_ids.length}`
      });
    }
    let failedRows = [];
    try {
      failedRows = this.db.prepare(`SELECT j.kind AS kind,
                  j.error AS error,
                  d.failureClass AS failureClass,
                  d.terminalStage AS terminalStage,
                  d.summary AS diagnosticSummary,
                  COUNT(*) AS count
           FROM jobs j
           LEFT JOIN job_terminal_diagnostics d ON d.jobId = j.id
           WHERE j.status IN ('failed', 'abandoned', 'publish_blocked')
             AND datetime(COALESCE(j.failedAt, j.updatedAt, j.createdAt)) >= datetime('now', '-24 hours')
           GROUP BY j.kind, j.error, d.failureClass, d.terminalStage, d.summary
           ORDER BY count DESC
           LIMIT 12`).all();
    } catch {
      failedRows = [];
    }
    for (let i = 0;i < failedRows.length; i++) {
      const row = failedRows[i];
      const count = Math.max(1, Math.floor(asNumber(row.count, 1)));
      const kind = asString3(row.kind) || "job";
      const failureClass = asString3(row.failureClass);
      const publicFailureClass = publicFailureClassLabel(failureClass);
      topSignals.push({
        signal_id: `sig_fail_${i + 1}`,
        type: failedJobSignalType(row),
        value: clamp012(count / 8),
        evidence: `${kind} failure count=${count}${publicFailureClass ? ` class=${publicFailureClass}` : ""}`
      });
    }
    const requestP95 = Number(requestSlo?.queueWaitMs?.p95 ?? 0);
    const jobFailures = Number(jobSlo?.failed ?? 0) + Number(jobSlo?.abandoned ?? 0) + Number(jobSlo?.publishBlocked ?? 0);
    const jobTerminal = Number(jobSlo?.completed ?? 0) + jobFailures;
    const jobFailureRate = jobTerminal > 0 ? jobFailures / jobTerminal : 0;
    const queueHealthDegradation = clamp012(0.6 * norm(requestP95, 90000, 180000) + 0.4 * norm(jobFailureRate, 0.05, 0.15));
    topSignals.push({
      signal_id: "sig_queue_health",
      type: "queue_health",
      value: queueHealthDegradation,
      evidence: `queue_p95=${Math.floor(requestP95)} job_failure_rate=${jobFailureRate.toFixed(3)}`
    });
    const regretRows = this.db.prepare(`SELECT COUNT(*) AS count
         FROM autonomy_outcomes
         WHERE reopened_within_24h = 1
           AND datetime(created_at) >= datetime('now', '-24 hours')`).get();
    const regretCount = Math.max(0, Math.floor(asNumber(regretRows?.count ?? 0, 0)));
    topSignals.push({
      signal_id: "sig_regret_24h",
      type: "regret_signal",
      value: clamp012(regretCount / 6),
      evidence: `reopened_within_24h=${regretCount}`
    });
    let stalledObjectiveRows = [];
    try {
      stalledObjectiveRows = this.db.prepare(`SELECT status,
                  COUNT(*) AS count,
                  MAX((julianday('now') - julianday(updated_at)) * 24 * 60) AS oldest_minutes
           FROM autonomy_objectives
           WHERE status IN ('dispatched','running','blocked','needs_clarification')
             AND datetime(updated_at) <= datetime('now', '-15 minutes')
           GROUP BY status
           ORDER BY count DESC, oldest_minutes DESC`).all();
    } catch {
      stalledObjectiveRows = [];
    }
    if (stalledObjectiveRows.length > 0) {
      const queueStalledStatuses = new Set(["dispatched", "running"]);
      const queueStalledRows = stalledObjectiveRows.filter((row) => queueStalledStatuses.has(asString3(row.status).toLowerCase()));
      if (queueStalledRows.length > 0) {
        const stalledCount = queueStalledRows.reduce((sum, row) => sum + Math.max(0, Math.floor(asNumber(row.count, 0))), 0);
        const oldestMinutes = queueStalledRows.reduce((max, row) => Math.max(max, Math.max(0, Math.floor(asNumber(row.oldest_minutes, 0)))), 0);
        topSignals.push({
          signal_id: "sig_objective_stall",
          type: "queue_health",
          value: clamp012(0.65 * clamp012(stalledCount / 3) + 0.35 * clamp012(oldestMinutes / 120)),
          evidence: `stalled_open_objectives=${stalledCount} oldest_age_min=${oldestMinutes}`
        });
      }
      const blockedStatuses = new Set(["blocked", "needs_clarification"]);
      const blockedRows = stalledObjectiveRows.filter((row) => blockedStatuses.has(asString3(row.status).toLowerCase()));
      if (blockedRows.length > 0) {
        const blockedCount = blockedRows.reduce((sum, row) => sum + Math.max(0, Math.floor(asNumber(row.count, 0))), 0);
        const oldestMinutes = blockedRows.reduce((max, row) => Math.max(max, Math.max(0, Math.floor(asNumber(row.oldest_minutes, 0)))), 0);
        topSignals.push({
          signal_id: "sig_objective_blocked",
          type: "regret_signal",
          value: clamp012(0.6 * clamp012(blockedCount / 3) + 0.4 * clamp012(oldestMinutes / 180)),
          evidence: `blocked_objectives=${blockedCount} oldest_age_min=${oldestMinutes}`
        });
      }
    }
    let failedOutcomeRows = [];
    try {
      failedOutcomeRows = this.db.prepare(`SELECT obj.trigger_type AS trigger_type,
                  COUNT(*) AS failure_count,
                  SUM(CASE WHEN o.regression_flag = 1 THEN 1 ELSE 0 END) AS regression_count,
                  SUM(CASE WHEN LOWER(COALESCE(o.user_action, '')) = 'needs_clarification' THEN 1 ELSE 0 END) AS clarification_count,
                  SUM(CASE WHEN LOWER(COALESCE(o.user_action, '')) = 'no_change' THEN 1 ELSE 0 END) AS no_change_count
           FROM autonomy_outcomes o
           JOIN autonomy_objectives obj ON obj.id = o.objective_id
           WHERE o.success = 0
             AND datetime(o.created_at) >= datetime('now', '-24 hours')
           GROUP BY obj.trigger_type
           ORDER BY failure_count DESC
           LIMIT 5`).all();
    } catch {
      failedOutcomeRows = [];
    }
    for (let i = 0;i < Math.min(failedOutcomeRows.length, 3); i++) {
      const row = failedOutcomeRows[i];
      const triggerType = normalizeSignalType(asString3(row.trigger_type));
      const failureCount = Math.max(0, Math.floor(asNumber(row.failure_count, 0)));
      const regressionCount = Math.max(0, Math.floor(asNumber(row.regression_count, 0)));
      const clarificationCount = Math.max(0, Math.floor(asNumber(row.clarification_count, 0)));
      const noChangeCount = Math.max(0, Math.floor(asNumber(row.no_change_count, 0)));
      topSignals.push({
        signal_id: `sig_objective_failure_${i + 1}`,
        type: triggerType,
        value: clamp012(0.5 * clamp012(failureCount / 4) + 0.3 * clamp012(regressionCount / 3) + 0.2 * clamp012((clarificationCount + noChangeCount) / 3)),
        evidence: `autonomy_failures=${failureCount} regressions=${regressionCount} ` + `clarifications=${clarificationCount} no_change=${noChangeCount}`
      });
    }
    const workerHealth = executionHealth ?? this.recentExecutionHealthSummary();
    if (workerHealth.staleClaimFailures > 0) {
      topSignals.push({
        signal_id: "sig_worker_stale_claims",
        type: "queue_health",
        value: clamp012(0.7 * clamp012(workerHealth.staleClaimFailures / 3) + 0.3 * clamp012(workerHealth.staleClaimOldestMinutes / 180)),
        evidence: `stale_claim_failures=${workerHealth.staleClaimFailures} ` + `oldest_age_min=${workerHealth.staleClaimOldestMinutes}`
      });
    }
    if (workerHealth.qualityRevisionJobs > 0) {
      topSignals.push({
        signal_id: "sig_quality_revision_churn",
        type: "regret_signal",
        value: clamp012(0.45 * clamp012(workerHealth.qualityRevisionJobs / 3) + 0.3 * clamp012(workerHealth.qualityRevisionTotalAttempts / 4) + 0.25 * clamp012(workerHealth.qualityRevisionFailures / 2)),
        evidence: `revision_jobs=${workerHealth.qualityRevisionJobs} ` + `revision_attempts=${workerHealth.qualityRevisionTotalAttempts} ` + `revision_failures=${workerHealth.qualityRevisionFailures} ` + `soft_passes=${workerHealth.qualityRevisionSoftPasses}`
      });
    }
    let prFeedbackRows = [];
    try {
      prFeedbackRows = this.db.prepare(`SELECT verdict, summary, comment_count
           FROM autonomy_pr_feedback
           WHERE datetime(created_at) >= datetime('now', '-24 hours')
           ORDER BY created_at DESC
           LIMIT 60`).all();
    } catch {
      prFeedbackRows = [];
    }
    if (prFeedbackRows.length > 0) {
      const negativeRows = prFeedbackRows.filter((row) => isNegativePrFeedbackVerdict(asString3(row.verdict)));
      if (negativeRows.length > 0) {
        const totalComments = negativeRows.reduce((sum, row) => sum + Math.max(0, Math.floor(asNumber(row.comment_count, 0))), 0);
        const negativeRatio = negativeRows.length / Math.max(1, prFeedbackRows.length);
        topSignals.push({
          signal_id: "sig_pr_feedback_24h",
          type: "regret_signal",
          value: clamp012(0.55 * negativeRatio + 0.3 * clamp012(negativeRows.length / 6) + 0.15 * clamp012(totalComments / 20)),
          evidence: `pr_feedback_negative=${negativeRows.length}/${prFeedbackRows.length} comments=${totalComments}`
        });
        const byType = new Map;
        for (const row of negativeRows) {
          const text = `${asString3(row.verdict)} ${asString3(row.summary)}`.trim();
          const signalType = normalizeSignalType(text);
          byType.set(signalType, (byType.get(signalType) ?? 0) + 1);
        }
        const typed = [...byType.entries()].sort((a, b) => {
          if (b[1] !== a[1])
            return b[1] - a[1];
          return a[0].localeCompare(b[0]);
        }).slice(0, 3);
        for (let i = 0;i < typed.length; i++) {
          const [type, count] = typed[i];
          topSignals.push({
            signal_id: `sig_pr_feedback_type_${i + 1}`,
            type,
            value: clamp012(count / 4),
            evidence: `pr feedback ${type} count=${count}`
          });
        }
      }
      for (let i = 0;i < Math.min(prFeedbackRows.length, 3); i++) {
        const row = prFeedbackRows[i];
        const summary = truncateText(asString3(row.summary), 180);
        if (!summary)
          continue;
        const verdict = asString3(row.verdict) || "feedback";
        topSignals.push({
          signal_id: `sig_pr_comment_${i + 1}`,
          type: normalizeSignalType(`${verdict} ${summary}`),
          value: clamp012(0.38 + Math.min(0.28, summary.length / 500)),
          evidence: `pr ${verdict}: ${summary}`
        });
      }
    }
    return topSignals.sort((a, b) => b.value - a.value).slice(0, 20);
  }
  buildStateTraits(params) {
    const traits = [];
    const pushTrait = (trait) => {
      if (!trait.trait_id || !trait.evidence)
        return;
      traits.push({
        ...trait,
        score: clamp012(asNumber(trait.score, 0))
      });
    };
    const queueP95 = asNumber(params.requestSlo?.queueWaitMs?.p95, 0);
    if (queueP95 >= 120000) {
      pushTrait({
        trait_id: "queue_latency_high",
        category: "weakness",
        focus: "queue_latency",
        score: norm(queueP95, 120000, 300000),
        evidence: `request queue p95=${Math.floor(queueP95)}ms`
      });
    } else {
      pushTrait({
        trait_id: "queue_latency_healthy",
        category: "strength",
        focus: "queue_latency",
        score: norm(120000 - queueP95, 0, 120000),
        evidence: `request queue p95=${Math.floor(queueP95)}ms`
      });
    }
    if (params.validationIncident?.active) {
      pushTrait({
        trait_id: "repo_validation_red",
        category: "risk",
        focus: "repo_validation",
        score: clamp012(0.65 + params.validationIncident.failure_count / 10),
        evidence: `required validation failing: ${params.validationIncident.command} ` + `failures=${params.validationIncident.failure_count} jobs=${params.validationIncident.failed_job_ids.length}`
      });
    }
    const completed = Math.max(0, Math.floor(asNumber(params.jobSlo?.completed, 0)));
    const failed = Math.max(0, Math.floor(asNumber(params.jobSlo?.failed, 0)));
    const terminal = completed + failed;
    const failureRate = terminal > 0 ? failed / terminal : 0;
    if (terminal >= 5) {
      if (failureRate >= 0.12) {
        pushTrait({
          trait_id: "job_failure_rate_high",
          category: "weakness",
          focus: "worker_reliability",
          score: norm(failureRate, 0.12, 0.4),
          evidence: `job failure rate=${failureRate.toFixed(3)} (${failed}/${terminal})`
        });
      } else {
        pushTrait({
          trait_id: "job_failure_rate_low",
          category: "strength",
          focus: "worker_reliability",
          score: norm(0.12 - failureRate, 0, 0.12),
          evidence: `job failure rate=${failureRate.toFixed(3)} (${failed}/${terminal})`
        });
      }
    }
    for (const signal of params.topSignals.slice(0, 5)) {
      if (signal.value < 0.35)
        continue;
      const focus = signal.type === "test_failure" ? "test_reliability" : signal.type === "lint_failure" ? "lint_hygiene" : signal.type === "typecheck_failure" ? "type_hygiene" : signal.type === "regret_signal" ? "change_stability" : "queue_health";
      pushTrait({
        trait_id: `signal_${signal.signal_id}`,
        category: signal.type === "regret_signal" ? "risk" : "weakness",
        focus,
        score: clamp012(signal.value),
        evidence: signal.evidence
      });
    }
    const componentRows = this.db.prepare(`SELECT obj.component_area AS componentArea,
                SUM(CASE WHEN o.success = 1 THEN 1 ELSE 0 END) AS successCount,
                COUNT(*) AS totalCount
         FROM autonomy_outcomes o
         JOIN autonomy_objectives obj ON obj.id = o.objective_id
         WHERE datetime(o.created_at) >= datetime(?, '-7 days')
         GROUP BY obj.component_area
         HAVING COUNT(*) >= 2
         ORDER BY totalCount DESC
         LIMIT 24`).all(params.nowIso);
    for (const row of componentRows) {
      const area = asString3(row.componentArea);
      if (!area)
        continue;
      const totalCount = Math.max(0, Math.floor(asNumber(row.totalCount, 0)));
      if (totalCount < 2)
        continue;
      const successCount = Math.max(0, Math.floor(asNumber(row.successCount, 0)));
      const successRate = successCount / totalCount;
      if (successRate <= 0.45) {
        pushTrait({
          trait_id: `component_weak_${area}`,
          category: "weakness",
          focus: `component:${area}`,
          score: norm(0.45 - successRate, 0, 0.45),
          evidence: `${area} 7d success=${successRate.toFixed(2)} (${successCount}/${totalCount})`
        });
      } else if (successRate >= 0.75) {
        pushTrait({
          trait_id: `component_strong_${area}`,
          category: "strength",
          focus: `component:${area}`,
          score: norm(successRate, 0.75, 1),
          evidence: `${area} 7d success=${successRate.toFixed(2)} (${successCount}/${totalCount})`
        });
      }
    }
    const objectiveRows = this.db.prepare(`SELECT obj.objective_type AS objectiveType,
                SUM(CASE WHEN o.success = 1 THEN 1 ELSE 0 END) AS successCount,
                COUNT(*) AS totalCount
         FROM autonomy_outcomes o
         JOIN autonomy_objectives obj ON obj.id = o.objective_id
         WHERE datetime(o.created_at) >= datetime(?, '-7 days')
         GROUP BY obj.objective_type
         ORDER BY totalCount DESC
         LIMIT 24`).all(params.nowIso);
    for (const row of objectiveRows) {
      const objectiveType = asString3(row.objectiveType);
      if (!objectiveType)
        continue;
      const totalCount = Math.max(0, Math.floor(asNumber(row.totalCount, 0)));
      if (totalCount === 0)
        continue;
      const successCount = Math.max(0, Math.floor(asNumber(row.successCount, 0)));
      const successRate = successCount / totalCount;
      if (totalCount >= 3 && successRate <= 0.45) {
        pushTrait({
          trait_id: `objective_weak_${objectiveType}`,
          category: "weakness",
          focus: `objective_type:${objectiveType}`,
          score: norm(0.45 - successRate, 0, 0.45),
          evidence: `${objectiveType} 7d success=${successRate.toFixed(2)} (${successCount}/${totalCount})`
        });
      } else if (totalCount >= 3 && successRate >= 0.75) {
        pushTrait({
          trait_id: `objective_strong_${objectiveType}`,
          category: "strength",
          focus: `objective_type:${objectiveType}`,
          score: norm(successRate, 0.75, 1),
          evidence: `${objectiveType} 7d success=${successRate.toFixed(2)} (${successCount}/${totalCount})`
        });
      } else if (totalCount <= 1) {
        pushTrait({
          trait_id: `objective_opportunity_${objectiveType}`,
          category: "opportunity",
          focus: `objective_type:${objectiveType}`,
          score: norm(1 - totalCount, 0, 1),
          evidence: `${objectiveType} has sparse recent samples (${totalCount} in 7d)`
        });
      }
    }
    const globalLimit = Math.max(1, this.config.remotebuddy.autonomy.maxDispatchPerHour);
    const dispatchPressure = clamp012(params.dispatchBudget.globalCount / globalLimit);
    if (dispatchPressure >= 0.8) {
      pushTrait({
        trait_id: "dispatch_pressure_high",
        category: "risk",
        focus: "dispatch_budget",
        score: dispatchPressure,
        evidence: `dispatch usage ${params.dispatchBudget.globalCount}/${globalLimit} in last hour`
      });
    }
    const activeCount = params.openObjectives.length;
    const concurrentLimit = Math.max(1, this.config.remotebuddy.autonomy.maxConcurrentObjectives);
    const activePressure = clamp012(activeCount / concurrentLimit);
    if (activePressure >= 1) {
      pushTrait({
        trait_id: "active_objectives_saturated",
        category: "risk",
        focus: "objective_concurrency",
        score: activePressure,
        evidence: `active objectives ${activeCount}/${concurrentLimit}`
      });
    }
    const stalledOpenObjectives = params.openObjectives.filter((objective) => {
      const status = asString3(objective.status).toLowerCase();
      if (status !== "dispatched" && status !== "running")
        return false;
      const updatedAtMs = Date.parse(asString3(objective.updated_at));
      const nowMs = Date.parse(params.nowIso);
      if (!Number.isFinite(updatedAtMs) || !Number.isFinite(nowMs))
        return false;
      return nowMs - updatedAtMs >= 15 * 60 * 1000;
    });
    if (stalledOpenObjectives.length > 0) {
      const oldestAgeMinutes = stalledOpenObjectives.reduce((max, objective) => {
        const updatedAtMs = Date.parse(asString3(objective.updated_at));
        const nowMs = Date.parse(params.nowIso);
        if (!Number.isFinite(updatedAtMs) || !Number.isFinite(nowMs))
          return max;
        return Math.max(max, Math.floor((nowMs - updatedAtMs) / 60000));
      }, 0);
      pushTrait({
        trait_id: "open_objectives_stalled",
        category: "risk",
        focus: "objective_progress",
        score: clamp012(0.65 * clamp012(stalledOpenObjectives.length / Math.max(1, concurrentLimit)) + 0.35 * clamp012(oldestAgeMinutes / 120)),
        evidence: `stalled objectives=${stalledOpenObjectives.length} oldest_age_min=${oldestAgeMinutes}`
      });
    }
    const blockedOpenObjectives = params.openObjectives.filter((objective) => {
      const status = asString3(objective.status).toLowerCase();
      if (status !== "blocked" && status !== "needs_clarification")
        return false;
      const updatedAtMs = Date.parse(asString3(objective.updated_at));
      const nowMs = Date.parse(params.nowIso);
      if (!Number.isFinite(updatedAtMs) || !Number.isFinite(nowMs))
        return false;
      return nowMs - updatedAtMs >= 15 * 60 * 1000;
    });
    if (blockedOpenObjectives.length > 0) {
      const oldestAgeMinutes = blockedOpenObjectives.reduce((max, objective) => {
        const updatedAtMs = Date.parse(asString3(objective.updated_at));
        const nowMs = Date.parse(params.nowIso);
        if (!Number.isFinite(updatedAtMs) || !Number.isFinite(nowMs))
          return max;
        return Math.max(max, Math.floor((nowMs - updatedAtMs) / 60000));
      }, 0);
      pushTrait({
        trait_id: "blocked_objectives_waiting",
        category: "risk",
        focus: "objective_progress",
        score: clamp012(0.6 * clamp012(blockedOpenObjectives.length / Math.max(1, concurrentLimit)) + 0.4 * clamp012(oldestAgeMinutes / 180)),
        evidence: `blocked objectives=${blockedOpenObjectives.length} oldest_age_min=${oldestAgeMinutes}`
      });
    }
    const workerHealth = params.executionHealth;
    if (workerHealth && workerHealth.staleClaimFailures > 0) {
      pushTrait({
        trait_id: "worker_stale_claim_pressure",
        category: "risk",
        focus: "worker_reliability",
        score: clamp012(0.7 * clamp012(workerHealth.staleClaimFailures / 3) + 0.3 * clamp012(workerHealth.staleClaimOldestMinutes / 180)),
        evidence: `stale claim failures=${workerHealth.staleClaimFailures} ` + `oldest_age_min=${workerHealth.staleClaimOldestMinutes}`
      });
    }
    if (workerHealth && workerHealth.qualityRevisionJobs > 0) {
      pushTrait({
        trait_id: "quality_revision_churn",
        category: "risk",
        focus: "execution_quality",
        score: clamp012(0.45 * clamp012(workerHealth.qualityRevisionJobs / 3) + 0.3 * clamp012(workerHealth.qualityRevisionTotalAttempts / 4) + 0.25 * clamp012(workerHealth.qualityRevisionFailures / 2)),
        evidence: `revision jobs=${workerHealth.qualityRevisionJobs} ` + `attempts=${workerHealth.qualityRevisionTotalAttempts} ` + `failures=${workerHealth.qualityRevisionFailures} ` + `soft_passes=${workerHealth.qualityRevisionSoftPasses}`
      });
    }
    if (asBoolean2(params.repoHealthFlags?.is_worktree_dirty, false)) {
      pushTrait({
        trait_id: "repo_dirty_worktree",
        category: "risk",
        focus: "repo_state",
        score: 0.9,
        evidence: "repo preflight reports dirty worktree"
      });
    }
    if (asBoolean2(params.repoHealthFlags?.is_merge_in_progress, false)) {
      pushTrait({
        trait_id: "repo_merge_in_progress",
        category: "risk",
        focus: "repo_state",
        score: 1,
        evidence: "repo preflight reports merge/rebase in progress"
      });
    }
    if (traits.length === 0) {
      pushTrait({
        trait_id: "state_signal_sparse",
        category: "opportunity",
        focus: "exploration",
        score: 0.5,
        evidence: "insufficient recent signals; prioritize low-risk scoped improvements"
      });
    }
    const deduped = new Map;
    for (const trait of traits) {
      const existing = deduped.get(trait.trait_id);
      if (!existing || trait.score > existing.score)
        deduped.set(trait.trait_id, trait);
    }
    return [...deduped.values()].sort((a, b) => {
      if (b.score !== a.score)
        return b.score - a.score;
      return a.trait_id.localeCompare(b.trait_id);
    }).slice(0, 32);
  }
  lockRow(nowIso) {
    const row = this.db.prepare(`SELECT lock_id, owner_session_id, owner_run_id, acquired_at, expires_at, updated_at
         FROM autonomy_dispatch_lock
         WHERE lock_id = 'autonomy_dispatch'
         LIMIT 1`).get();
    if (!row)
      return null;
    const expiresAtMs = Date.parse(asString3(row.expires_at));
    const nowMs = Date.parse(nowIso);
    if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs) || expiresAtMs <= nowMs) {
      this.db.prepare(`DELETE FROM autonomy_dispatch_lock WHERE lock_id = 'autonomy_dispatch'`).run();
      return null;
    }
    return row;
  }
  isDispatchLockHeld(nowIso = asIsoNow()) {
    return this.lockRow(nowIso) !== null;
  }
  isDispatchLockHeldByAnotherRun(runId, nowIso = asIsoNow()) {
    const row = this.lockRow(nowIso);
    if (!row)
      return false;
    const normalizedRunId = asString3(runId);
    return normalizedRunId.length === 0 || row.owner_run_id !== normalizedRunId;
  }
  acquireDispatchLock(params) {
    const sessionId = asString3(params.sessionId);
    const runId = asString3(params.runId);
    if (!sessionId || !runId)
      return { ok: false, reason: "sessionId and runId are required" };
    const now = asIsoNow();
    const nowMs = Date.parse(now);
    const ttlMs = Math.max(5000, Math.floor(asNumber(params.ttlMs, Math.max(this.config.remotebuddy.autonomy.llmTimeoutMs * 3, this.config.remotebuddy.autonomy.tickIntervalMs))));
    const staleAfterMs = Math.max(0, Math.floor(asNumber(params.staleAfterMs, 0)));
    const lockUntil = new Date(Date.parse(now) + ttlMs).toISOString();
    let replacedStale = false;
    try {
      this.db.exec("BEGIN IMMEDIATE TRANSACTION");
      const existing = this.lockRow(now);
      if (existing && existing.owner_run_id !== runId) {
        const updatedAtMs = Date.parse(asString3(existing.updated_at));
        const sameSession = existing.owner_session_id === sessionId;
        const staleForSameSession = sameSession && staleAfterMs > 0 && Number.isFinite(nowMs) && Number.isFinite(updatedAtMs) && nowMs - updatedAtMs >= staleAfterMs;
        if (!staleForSameSession) {
          this.db.exec("ROLLBACK");
          return {
            ok: false,
            reason: `dispatch lock held by ${existing.owner_run_id} until ${existing.expires_at}`
          };
        }
        replacedStale = true;
      }
      this.db.prepare(`INSERT INTO autonomy_dispatch_lock (
            lock_id, owner_session_id, owner_run_id, acquired_at, expires_at, updated_at
          ) VALUES ('autonomy_dispatch', ?, ?, ?, ?, ?)
          ON CONFLICT(lock_id) DO UPDATE SET
            owner_session_id = excluded.owner_session_id,
            owner_run_id = excluded.owner_run_id,
            acquired_at = excluded.acquired_at,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at`).run(sessionId, runId, now, lockUntil, now);
      this.db.exec("COMMIT");
      return { ok: true, lockUntil, ...replacedStale ? { replacedStale: true } : {} };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      return { ok: false, reason: `failed to acquire dispatch lock: ${String(error)}` };
    }
  }
  renewDispatchLock(params) {
    const sessionId = asString3(params.sessionId);
    const runId = asString3(params.runId);
    if (!sessionId || !runId)
      return { ok: false, reason: "sessionId and runId are required" };
    const now = asIsoNow();
    const current = this.lockRow(now);
    if (!current)
      return { ok: false, reason: "dispatch lock not held" };
    if (current.owner_session_id !== sessionId || current.owner_run_id !== runId) {
      return {
        ok: false,
        reason: `dispatch lock held by ${current.owner_run_id} until ${current.expires_at}`
      };
    }
    return this.acquireDispatchLock(params);
  }
  releaseDispatchLock(params) {
    const sessionId = asString3(params.sessionId);
    const runId = asString3(params.runId);
    if (!sessionId || !runId)
      return { ok: true, released: false };
    const res = this.db.prepare(`DELETE FROM autonomy_dispatch_lock
         WHERE lock_id = 'autonomy_dispatch'
           AND owner_session_id = ?
           AND owner_run_id = ?`).run(sessionId, runId);
    return { ok: true, released: Number(res.changes ?? 0) > 0 };
  }
  snapshotPayloadForStorage(snapshot) {
    const replayCfg = this.config.remotebuddy.autonomy.replay;
    const fullPayload = JSON.stringify(snapshot);
    const payloadHash = sha256Hex(fullPayload);
    if (!replayCfg.storePromptPayloads) {
      return JSON.stringify({
        snapshot_id: snapshot.snapshot_id,
        snapshot_created_at: snapshot.snapshot_created_at,
        snapshot_ttl_ms: snapshot.snapshot_ttl_ms,
        impact_model_version: snapshot.impact_model_version,
        top_signals: snapshot.top_signals,
        state_traits: snapshot.state_traits,
        feedback_priors: snapshot.feedback_priors.slice(0, 40),
        engine_idea_priors: snapshot.engine_idea_priors.slice(0, 40),
        engine_source_priors: snapshot.engine_source_priors.slice(0, 40),
        active_cooldowns: snapshot.active_cooldowns.slice(0, 40),
        open_objectives: snapshot.open_objectives.slice(0, 40),
        recent_objectives: snapshot.recent_objectives.slice(0, 80),
        repo_health_flags: snapshot.repo_health_flags,
        dispatch_budget: snapshot.dispatch_budget,
        resource_budget: snapshot.resource_budget,
        payload_hash: payloadHash
      });
    }
    if (jsonByteLength(fullPayload) <= replayCfg.maxPayloadBytes)
      return fullPayload;
    return JSON.stringify({
      snapshot_id: snapshot.snapshot_id,
      snapshot_created_at: snapshot.snapshot_created_at,
      snapshot_ttl_ms: snapshot.snapshot_ttl_ms,
      impact_model_version: snapshot.impact_model_version,
      engine_idea_priors: snapshot.engine_idea_priors.slice(0, 20),
      engine_source_priors: snapshot.engine_source_priors.slice(0, 20),
      repo_health_flags: snapshot.repo_health_flags,
      dispatch_budget: snapshot.dispatch_budget,
      resource_budget: snapshot.resource_budget,
      payload_hash: payloadHash,
      truncated: true,
      truncated_reason: `payload exceeds max_payload_bytes=${replayCfg.maxPayloadBytes}`
    });
  }
  llmResponseJsonForStorage(call) {
    const replayCfg = this.config.remotebuddy.autonomy.replay;
    if (!replayCfg.storePromptPayloads)
      return null;
    const responsePayload = {
      response: asObject2(call.response),
      request_payload: asObject2(call.requestPayload ?? call.request_payload),
      prompt_inputs: asObject2(call.promptInputs ?? call.prompt_inputs)
    };
    const serialized = JSON.stringify(responsePayload);
    if (jsonByteLength(serialized) <= replayCfg.maxPayloadBytes)
      return serialized;
    return JSON.stringify({
      truncated: true,
      response_hash: asString3(call.responseHash ?? call.response_hash) || sha256Hex(serialized),
      truncated_reason: `payload exceeds max_payload_bytes=${replayCfg.maxPayloadBytes}`
    });
  }
  enforceReplayRetention() {
    const replayCfg = this.config.remotebuddy.autonomy.replay;
    if (!replayCfg.storePromptPayloads) {
      this.db.prepare(`UPDATE autonomy_llm_calls SET response_json = NULL`).run();
      return;
    }
    const keepRuns = Math.max(0, Math.floor(replayCfg.maxRunsWithPayloads));
    if (keepRuns <= 0) {
      this.db.prepare(`UPDATE autonomy_llm_calls SET response_json = NULL`).run();
      return;
    }
    const keepRows = this.db.prepare(`SELECT run_id AS runId
         FROM autonomy_llm_calls
         WHERE response_json IS NOT NULL
         GROUP BY run_id
         ORDER BY MAX(datetime(created_at)) DESC
         LIMIT ?`).all(keepRuns);
    const keepIds = keepRows.map((row) => asString3(row.runId)).filter(Boolean);
    if (keepIds.length === 0) {
      this.db.prepare(`UPDATE autonomy_llm_calls SET response_json = NULL`).run();
      return;
    }
    const placeholders = keepIds.map(() => "?").join(", ");
    this.db.prepare(`UPDATE autonomy_llm_calls SET response_json = NULL WHERE run_id NOT IN (${placeholders})`).run(...keepIds);
  }
  maybeRunInspirationMaintenance(nowIso = asIsoNow()) {
    const nowMs = Date.parse(nowIso);
    if (!Number.isFinite(nowMs))
      return;
    if (this.lastInspirationMaintenanceAtMs > 0 && nowMs - this.lastInspirationMaintenanceAtMs < 300000) {
      return;
    }
    this.applyInspirationFreshnessDecay(nowIso);
    this.refreshEngineSourceCuration(nowIso);
    this.lastInspirationMaintenanceAtMs = nowMs;
  }
  applyInspirationFreshnessDecay(nowIso) {
    const nowMs = Date.parse(nowIso);
    if (!Number.isFinite(nowMs))
      return;
    const sourceRows = this.db.prepare(`SELECT source_key, freshness_score, last_reinforced_at, updated_at
         FROM autonomy_engine_source_stats`).all();
    const updateSource = this.db.prepare(`UPDATE autonomy_engine_source_stats
       SET freshness_score = ?, updated_at = ?
       WHERE source_key = ?`);
    for (const row of sourceRows) {
      const anchorIso = asString3(row.last_reinforced_at) || asString3(row.updated_at);
      const anchorMs = Date.parse(anchorIso);
      if (!Number.isFinite(anchorMs))
        continue;
      const staleDays = Math.floor((nowMs - anchorMs) / 86400000);
      if (staleDays <= 0)
        continue;
      const prevFreshness = clamp012(asNumber(row.freshness_score, 0.5));
      const nextFreshness = freshnessDecay(prevFreshness, staleDays);
      if (Math.abs(nextFreshness - prevFreshness) < 0.005)
        continue;
      updateSource.run(nextFreshness, nowIso, asString3(row.source_key));
    }
    const patternRows = this.db.prepare(`SELECT id, freshness_score, metadata_json, last_seen_at, updated_at
         FROM autonomy_inspiration_patterns`).all();
    const updatePattern = this.db.prepare(`UPDATE autonomy_inspiration_patterns
       SET freshness_score = ?, metadata_json = ?, updated_at = ?
       WHERE id = ?`);
    for (const row of patternRows) {
      const metadata = parseJsonObject(row.metadata_json);
      const reinforcedIso = asString3(metadata.last_reinforced_at);
      const anchorIso = reinforcedIso || asString3(row.last_seen_at) || asString3(row.updated_at);
      const anchorMs = Date.parse(anchorIso);
      if (!Number.isFinite(anchorMs))
        continue;
      const staleDays = Math.floor((nowMs - anchorMs) / 86400000);
      if (staleDays <= 0)
        continue;
      const prevFreshness = clamp012(asNumber(row.freshness_score, 0.5));
      const nextFreshness = freshnessDecay(prevFreshness, staleDays);
      if (Math.abs(nextFreshness - prevFreshness) < 0.005)
        continue;
      const nextMetadata = {
        ...metadata,
        freshness_decay_applied_at: nowIso,
        freshness_stale_days: staleDays
      };
      updatePattern.run(nextFreshness, JSON.stringify(nextMetadata), nowIso, Math.max(0, Math.floor(asNumber(row.id, 0))));
    }
  }
  refreshEngineSourceCuration(nowIso) {
    const rows = this.db.prepare(`SELECT source_key, curation_status, curation_reason, trust_score, freshness_score, sample_count,
                ema_success, ema_user_accept, ema_latency, ema_regret
         FROM autonomy_engine_source_stats`).all();
    const update = this.db.prepare(`UPDATE autonomy_engine_source_stats
       SET curation_status = ?, curation_reason = ?, trust_score = ?, updated_at = ?
       WHERE source_key = ?`);
    for (const row of rows) {
      const trustScore = computeEngineSourceTrustScore({
        ema_success: row.ema_success,
        ema_user_accept: row.ema_user_accept,
        ema_latency: row.ema_latency,
        ema_regret: row.ema_regret
      });
      const curation = classifyEngineSourceCuration({
        sample_count: row.sample_count,
        trust_score: trustScore,
        ema_success: row.ema_success,
        ema_user_accept: row.ema_user_accept,
        ema_regret: row.ema_regret,
        freshness_score: row.freshness_score
      });
      const prevStatus = normalizeEngineSourceCurationStatus(row.curation_status);
      const prevReason = asString3(row.curation_reason);
      const prevTrust = clamp012(asNumber(row.trust_score, 0));
      if (prevStatus === curation.status && prevReason === curation.reason && Math.abs(prevTrust - trustScore) < 0.005) {
        continue;
      }
      update.run(curation.status, curation.reason, trustScore, nowIso, asString3(row.source_key));
    }
  }
  createSnapshot(params) {
    const now = asIsoNow();
    this.maybeRunInspirationMaintenance(now);
    this.maybeSweepStaleObjectives(now);
    const evaluatorCard = this.maybeRunEvaluator(now);
    const safetyState = this.getSafetyState(now);
    const snapshotId = `snap_${Date.now()}_${randomUUID5().slice(0, 8)}`;
    const ttlMs = this.config.remotebuddy.autonomy.tickIntervalMs * 2;
    const executionHealth = this.recentExecutionHealthSummary();
    const validationIncident = this.detectActiveValidationIncident(now);
    const topSignals = this.buildTopSignals(params.requestSlo, params.jobSlo, executionHealth, validationIncident);
    const feedbackPriors = this.db.prepare(`SELECT pattern_key, ema_success, ema_user_accept, ema_latency, ema_regret, fail_streak, sample_count, cooldown_until, updated_at
         FROM autonomy_pattern_stats
         ORDER BY updated_at DESC
         LIMIT 80`).all();
    const engineIdeaPriors = this.db.prepare(`SELECT engine_building_block_id, engine_algorithm, ema_success, ema_user_accept, ema_latency, ema_regret, sample_count, updated_at
         FROM autonomy_engine_idea_stats
         ORDER BY updated_at DESC
         LIMIT 80`).all();
    const engineSourcePriors = this.db.prepare(`SELECT source_key, source_type, source_label, source_url, source_fingerprint, source_algorithm,
                curation_status, curation_reason, trust_score, freshness_score, last_reinforced_at,
                ema_success, ema_user_accept, ema_latency, ema_regret, sample_count, updated_at
         FROM autonomy_engine_source_stats
         ORDER BY updated_at DESC
         LIMIT 80`).all();
    const activeCooldowns = feedbackPriors.filter((row) => typeof row.cooldown_until === "string" && row.cooldown_until.length > 0 && Date.parse(row.cooldown_until) > Date.parse(now)).map((row) => ({
      pattern_key: row.pattern_key,
      cooldown_until: row.cooldown_until
    }));
    const openObjectiveRows = this.db.prepare(`SELECT id AS objective_id, status, objective_type, component_area, pattern_key, scope_json, updated_at
         FROM autonomy_objectives
         WHERE status IN ('proposed','gated','dispatched','running','blocked','needs_clarification')
         ORDER BY updated_at DESC
         LIMIT 50`).all();
    const hydrateObjective = (row) => {
      const scopeRecord = parseJsonObject(row.scope_json);
      const targetPaths = asStringArray3(scopeRecord.targetPaths ?? scopeRecord.target_paths);
      const writeGlobs = asStringArray3(scopeRecord.writeGlobs ?? scopeRecord.write_globs);
      const readAnywhere = asBoolean2(scopeRecord.readAnywhere ?? scopeRecord.read_anywhere, false);
      return {
        objective_id: row.objective_id,
        status: row.status,
        objective_type: row.objective_type,
        component_area: row.component_area,
        pattern_key: row.pattern_key,
        target_paths: targetPaths,
        scope: {
          read_anywhere: readAnywhere,
          write_globs: writeGlobs,
          target_paths: targetPaths
        },
        updated_at: row.updated_at
      };
    };
    const openObjectives = openObjectiveRows.map(hydrateObjective);
    const recentObjectiveRows = this.db.prepare(`SELECT id AS objective_id, status, objective_type, component_area, pattern_key, scope_json, updated_at
         FROM autonomy_objectives
         WHERE status NOT IN ('proposed','gated','dispatched','running','blocked','needs_clarification')
           AND updated_at >= ?
         ORDER BY updated_at DESC
         LIMIT 100`).all(new Date(Date.parse(now) - 24 * 60 * 60000).toISOString());
    const recentObjectives = recentObjectiveRows.map(hydrateObjective);
    const dispatchBudget = this.getDispatchCountsLastHour(now);
    const resourceBudget = this.resourceBudgetSnapshot(now);
    const stateTraits = this.buildStateTraits({
      nowIso: now,
      requestSlo: params.requestSlo,
      jobSlo: params.jobSlo,
      topSignals,
      executionHealth,
      dispatchBudget,
      openObjectives,
      repoHealthFlags: params.repoHealthFlags,
      validationIncident
    });
    const snapshot = {
      snapshot_id: snapshotId,
      snapshot_created_at: now,
      snapshot_ttl_ms: ttlMs,
      impact_model_version: this.config.remotebuddy.autonomy.impactModelVersion,
      top_signals: topSignals,
      state_traits: stateTraits,
      feedback_priors: feedbackPriors,
      engine_idea_priors: engineIdeaPriors,
      engine_source_priors: engineSourcePriors,
      active_cooldowns: activeCooldowns,
      open_objectives: openObjectives,
      recent_objectives: recentObjectives,
      repo_health_flags: {
        is_worktree_dirty: Boolean(params.repoHealthFlags?.is_worktree_dirty),
        is_merge_in_progress: Boolean(params.repoHealthFlags?.is_merge_in_progress),
        dispatch_lock_held: this.isDispatchLockHeldByAnotherRun(params.runId, now),
        required_validation_red: Boolean(validationIncident?.active)
      },
      validation_incident: validationIncident,
      dispatch_budget: {
        rolling_window_seconds: 3600,
        global_count_last_hour: dispatchBudget.globalCount,
        by_type_count_last_hour: dispatchBudget.byType,
        by_component_count_last_hour: dispatchBudget.byComponent
      },
      resource_budget: resourceBudget,
      safety_state: {
        kill_switch_enabled: safetyState.killSwitchEnabled,
        freeze_until: safetyState.freezeUntil,
        freeze_reason: safetyState.freezeReason,
        is_frozen: safetyState.isFrozen
      },
      evaluator: {
        recommendation: evaluatorCard?.recommendation ?? "healthy",
        sample_count: evaluatorCard?.sampleCount ?? 0,
        success_rate: evaluatorCard?.successRate ?? null,
        regret_rate: evaluatorCard?.regretRate ?? null,
        created_at: evaluatorCard?.createdAt ?? null
      }
    };
    this.db.prepare(`INSERT INTO autonomy_snapshots (snapshot_id, session_id, created_at, ttl_ms, payload_json)
         VALUES (?, ?, ?, ?, ?)`).run(snapshotId, params.sessionId, now, ttlMs, this.snapshotPayloadForStorage(snapshot));
    return snapshot;
  }
  activeObjectiveCount() {
    const row = this.db.prepare(`SELECT COUNT(*) AS count
         FROM autonomy_objectives
         WHERE status IN ('proposed','gated','dispatched','running','blocked','needs_clarification')`).get();
    return Math.max(0, Math.floor(asNumber(row?.count ?? 0, 0)));
  }
  cooldownReason(patternKey, nowIso) {
    if (!patternKey)
      return null;
    const row = this.db.prepare(`SELECT cooldown_until FROM autonomy_pattern_stats WHERE pattern_key = ?`).get(patternKey);
    const until = asString3(row?.cooldown_until);
    if (!until)
      return null;
    const untilMs = Date.parse(until);
    const nowMs = Date.parse(nowIso);
    if (!Number.isFinite(untilMs) || !Number.isFinite(nowMs))
      return null;
    return untilMs > nowMs ? `cooldown_active until ${until}` : null;
  }
  recentSuccessSuppressionReason(params) {
    const { patternKey, objectiveType, componentArea, nowIso } = params;
    if (patternKey) {
      const exactRow = this.db.prepare(`SELECT 1
           FROM autonomy_outcomes
           WHERE pattern_key = ?
             AND success = 1
             AND datetime(created_at) >= datetime(?, '-${RECENT_SUCCESS_SUPPRESSION_WINDOW_HOURS} hours')
           LIMIT 1`).get(patternKey, nowIso);
      if (exactRow)
        return "recent_success_same_pattern_within_24h";
    }
    if (objectiveType === "docs" && componentArea) {
      const nearRow = this.db.prepare(`SELECT 1
           FROM autonomy_outcomes o
           JOIN autonomy_objectives obj ON obj.id = o.objective_id
           WHERE o.success = 1
             AND obj.objective_type = 'docs'
             AND obj.component_area = ?
             AND datetime(o.created_at) >= datetime(?, '-${RECENT_SUCCESS_SUPPRESSION_WINDOW_HOURS} hours')
           LIMIT 1`).get(componentArea, nowIso);
      if (nearRow)
        return "recent_success_near_pattern_within_24h";
    }
    return null;
  }
  preflightReason(snapshotId, runId) {
    if (this.isDispatchLockHeldByAnotherRun(runId)) {
      return "repo preflight blocked: dispatch lock held";
    }
    const row = this.db.prepare(`SELECT payload_json FROM autonomy_snapshots WHERE snapshot_id = ?`).get(snapshotId);
    if (!row?.payload_json)
      return null;
    const payload = parseJsonObject(row.payload_json);
    const flags = asObject2(payload.repo_health_flags);
    if (asBoolean2(flags.is_worktree_dirty, false) && !this.config.remotebuddy.autonomy.allowDirtyWorktree) {
      return "repo preflight blocked: worktree is dirty";
    }
    if (asBoolean2(flags.is_merge_in_progress, false))
      return "repo preflight blocked: merge/rebase in progress";
    if (asBoolean2(flags.dispatch_lock_held, false))
      return "repo preflight blocked: dispatch lock held";
    const safety = asObject2(payload.safety_state);
    if (asBoolean2(safety.kill_switch_enabled, false)) {
      return "autonomy kill switch enabled";
    }
    const isFrozen = asBoolean2(safety.is_frozen, false);
    if (isFrozen) {
      const freezeUntil = asString3(safety.freeze_until);
      return freezeUntil ? `autonomy frozen until ${freezeUntil}` : "autonomy frozen";
    }
    const resourceBudget = asObject2(payload.resource_budget);
    if (asBoolean2(resourceBudget.token_budget_exhausted, false)) {
      const usage = Math.max(0, Math.floor(asNumber(resourceBudget.token_usage_last_hour, 0)));
      const budget = Math.max(0, Math.floor(asNumber(resourceBudget.token_budget_per_hour, 0)));
      return `hourly token budget exceeded (${usage}/${budget})`;
    }
    if (asBoolean2(resourceBudget.runtime_budget_exhausted, false)) {
      const usage = Math.max(0, Math.floor(asNumber(resourceBudget.runtime_ms_last_hour, 0)));
      const budget = Math.max(0, Math.floor(asNumber(resourceBudget.runtime_budget_ms_per_hour, 0)));
      return `hourly runtime budget exceeded (${usage}/${budget} ms)`;
    }
    return null;
  }
  evaluateEligibility(body) {
    const runId = asString3(body.runId);
    const snapshotId = asString3(body.snapshotId);
    if (!runId || !snapshotId) {
      return { ok: false, reason: "runId and snapshotId are required" };
    }
    const candidates = Array.isArray(body.candidates) ? body.candidates : [];
    const now = asIsoNow();
    const counts = this.getDispatchCountsLastHour(now);
    const limits = this.config.remotebuddy.autonomy;
    const maxConcurrent = limits.maxConcurrentObjectives;
    let activeCount = this.activeObjectiveCount();
    const byTypeCounts = { ...counts.byType };
    const byComponentCounts = { ...counts.byComponent };
    let globalCount = counts.globalCount;
    const applySequentialAccounting = asBoolean2(body.applySequentialAccounting ?? body.apply_sequential_accounting, true);
    const preflightErr = this.preflightReason(snapshotId, runId);
    const safetyErr = this.safetyBlockReason(now);
    const resourceBudgetErr = this.resourceBudgetBlockReason(now);
    const activePatternRows = this.db.prepare(`SELECT DISTINCT pattern_key AS patternKey
         FROM autonomy_objectives
         WHERE status IN ('proposed','gated','dispatched','running','blocked','needs_clarification')`).all();
    const activePatternKeys = new Set(activePatternRows.map((row) => asString3(row.patternKey)).filter(Boolean));
    const results = candidates.map((raw) => {
      const record = asObject2(raw);
      const candidateId = asString3(record.id ?? record.candidateId ?? record.candidate_id) || randomUUID5();
      const objectiveTypeRaw = asString3(record.objectiveType ?? record.objective_type);
      const objectiveType = asObjectiveType(objectiveTypeRaw);
      if (!objectiveType) {
        return {
          candidate_id: candidateId,
          ok: false,
          reason: `invalid objective_type "${objectiveTypeRaw}"`
        };
      }
      const patternKey = asString3(record.patternKey ?? record.pattern_key);
      const componentArea = asComponentArea(record.componentArea ?? record.component_area);
      const confidence = clamp012(asNumber(record.confidence, 0));
      const pushpalsInternalErr = pushpalsInternalCandidateReason(record);
      if (pushpalsInternalErr) {
        return {
          candidate_id: candidateId,
          ok: false,
          reason: pushpalsInternalErr
        };
      }
      const perTypeLimit = Math.max(0, Math.floor(limits.maxDispatchPerHourByType[objectiveType] ?? limits.maxDispatchPerHour));
      const perTypeCount = Math.max(0, Math.floor(byTypeCounts[objectiveType] ?? 0));
      if (perTypeCount >= perTypeLimit) {
        return {
          candidate_id: candidateId,
          ok: false,
          reason: `per-type budget exceeded for ${objectiveType}`
        };
      }
      if (globalCount >= limits.maxDispatchPerHour) {
        return { candidate_id: candidateId, ok: false, reason: "global dispatch budget exceeded" };
      }
      if (componentArea) {
        const perComponentLimit = Math.max(0, Math.floor(limits.maxDispatchPerHourByComponent[componentArea] ?? limits.maxDispatchPerHour));
        const perComponentCount = Math.max(0, Math.floor(byComponentCounts[componentArea] ?? 0));
        if (perComponentCount >= perComponentLimit) {
          return {
            candidate_id: candidateId,
            ok: false,
            reason: `per-component budget exceeded for ${componentArea}`
          };
        }
      }
      if (activeCount >= maxConcurrent) {
        return {
          candidate_id: candidateId,
          ok: false,
          reason: "max concurrent objectives reached"
        };
      }
      const cooldownErr = this.cooldownReason(patternKey, now);
      if (cooldownErr) {
        return { candidate_id: candidateId, ok: false, reason: cooldownErr };
      }
      const recentSuccessErr = this.recentSuccessSuppressionReason({
        patternKey,
        objectiveType,
        componentArea,
        nowIso: now
      });
      if (recentSuccessErr) {
        return { candidate_id: candidateId, ok: false, reason: recentSuccessErr };
      }
      if (preflightErr) {
        return { candidate_id: candidateId, ok: false, reason: preflightErr };
      }
      if (safetyErr) {
        return { candidate_id: candidateId, ok: false, reason: safetyErr };
      }
      if (resourceBudgetErr) {
        return { candidate_id: candidateId, ok: false, reason: resourceBudgetErr };
      }
      if (patternKey && activePatternKeys.has(patternKey)) {
        return {
          candidate_id: candidateId,
          ok: false,
          reason: "pattern already has active objective"
        };
      }
      if (confidence < limits.minConfidence) {
        return {
          candidate_id: candidateId,
          ok: false,
          reason: `candidate confidence ${confidence.toFixed(2)} < ${limits.minConfidence}`
        };
      }
      if (applySequentialAccounting) {
        byTypeCounts[objectiveType] = perTypeCount + 1;
        if (componentArea)
          byComponentCounts[componentArea] = Math.max(0, byComponentCounts[componentArea] ?? 0) + 1;
        globalCount += 1;
        activeCount += 1;
        if (patternKey)
          activePatternKeys.add(patternKey);
      }
      return { candidate_id: candidateId, ok: true };
    });
    return { ok: true, results };
  }
  recordObjectiveDecision(body) {
    const runId = asString3(body.runId);
    const snapshotId = asString3(body.snapshotId);
    const sessionId = asString3(body.sessionId);
    if (!runId || !snapshotId || !sessionId) {
      return { ok: false, reason: "runId, snapshotId, and sessionId are required" };
    }
    const candidates = Array.isArray(body.candidates) ? body.candidates : [];
    const candidateEngineTrialMetaById = new Map;
    for (const raw of candidates) {
      const record = asObject2(raw);
      const objectiveTypeRaw2 = asString3(record.objectiveType ?? record.objective_type);
      const componentAreaRaw2 = asString3(record.componentArea ?? record.component_area);
      const triggerTypeRaw2 = asString3(record.triggerType ?? record.trigger_type);
      const objectiveType2 = asObjectiveType(objectiveTypeRaw2);
      const componentArea2 = asComponentArea(componentAreaRaw2);
      const triggerType2 = asTriggerType(triggerTypeRaw2);
      const targetPaths2 = asStringArray3(record.targetPaths ?? record.target_paths);
      const scopeRecord2 = asObject2(record.scope);
      const riskLevel2 = asString3(record.riskLevel ?? record.risk_level);
      const expectedValidation2 = asStringArray3(record.expectedValidation ?? record.expected_validation);
      const readAnywhere2 = asBoolean2(scopeRecord2.readAnywhere ?? scopeRecord2.read_anywhere, false);
      const writeGlobs = asStringArray3(scopeRecord2.writeGlobs ?? scopeRecord2.write_globs);
      const scopeValidation2 = validateScopeInvariants(componentArea2, targetPaths2, writeGlobs, {
        requireWriteGlobs: true,
        hintsOnly: true
      });
      const enumErrors = [];
      if (!objectiveType2)
        enumErrors.push(`invalid objective_type "${objectiveTypeRaw2}"`);
      if (!triggerType2)
        enumErrors.push(`invalid trigger_type "${triggerTypeRaw2}"`);
      const policyErrors2 = policyViolations({
        objectiveType: objectiveType2 ?? objectiveTypeRaw2,
        riskLevel: riskLevel2,
        readAnywhere: readAnywhere2,
        expectedValidation: expectedValidation2,
        allowReadAnywhere: this.config.remotebuddy.autonomy.allowReadAnywhere
      });
      const pushpalsInternalErr2 = pushpalsInternalCandidateReason(record);
      const gateReasons = [
        ...enumErrors,
        ...scopeValidation2.ok ? [] : scopeValidation2.errors,
        ...policyErrors2,
        ...pushpalsInternalErr2 ? [pushpalsInternalErr2] : []
      ];
      const penalties = normalizePenalties((Array.isArray(record.penalties) ? record.penalties : []).map((entry) => {
        const item = asObject2(entry);
        return {
          kind: asString3(item.kind),
          weight: asNumber(item.weight, 0),
          reason: asString3(item.reason),
          evidence_ids: asStringArray3(item.evidence_ids)
        };
      }));
      const llmScore = asNumber(record.llmScore ?? record.llm_score, 0);
      const impactSignal = asNumber(record.impactSignal ?? record.impact_signal, 0);
      const emaSuccess = asNumber(record.emaSuccess ?? record.ema_success, 0);
      const emaUserAccept = asNumber(record.emaUserAccept ?? record.ema_user_accept, 0);
      const finalScore = Number.isFinite(asNumber(record.finalScore ?? record.final_score, Number.NaN)) ? asNumber(record.finalScore ?? record.final_score, 0) : 0.55 * llmScore + 0.2 * impactSignal + 0.15 * emaSuccess + 0.1 * emaUserAccept - penaltyTotal(penalties);
      const objectiveTypePersist = (objectiveType2 ?? objectiveTypeRaw2) || "invalid";
      const triggerTypePersist = (triggerType2 ?? triggerTypeRaw2) || "invalid";
      const componentAreaPersist = scopeValidation2.componentArea ?? componentAreaRaw2 ?? "invalid";
      const candidateExternalId = asString3(record.id) || randomUUID5();
      const candidateStorageId = scopedCandidateStorageId(runId, candidateExternalId);
      const engineTrialMeta = extractEngineTrialCandidateMeta(record);
      if (engineTrialMeta) {
        candidateEngineTrialMetaById.set(candidateStorageId, engineTrialMeta);
      }
      const debugRecord = {
        ...asObject2(record.debug),
        candidate_external_id: candidateExternalId
      };
      this.db.prepare(`INSERT OR REPLACE INTO autonomy_candidates (
            id, run_id, snapshot_id, session_id, title, objective_type, problem_statement, trigger_type,
            component_area, target_paths_json, scope_json, risk_level, expected_validation_json,
            estimated_effort, why_now_signal_ids_json, confidence, pattern_key, llm_score, impact_signal,
            ema_success, ema_user_accept, penalties_json, final_score, selected, rejection_reason,
            gate_decision, gate_reasons_json, debug_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(candidateStorageId, runId, snapshotId, sessionId, asString3(record.title), objectiveTypePersist, asString3(record.problemStatement ?? record.problem_statement), triggerTypePersist, componentAreaPersist, JSON.stringify(scopeValidation2.normalizedTargetPaths), JSON.stringify({
        readAnywhere: readAnywhere2,
        writeGlobs: scopeValidation2.normalizedWriteGlobs
      }), riskLevel2, JSON.stringify(expectedValidation2), asString3(record.estimatedEffort ?? record.estimated_effort), JSON.stringify(asStringArray3(record.whyNowSignalIds ?? record.why_now_signal_ids)), clamp012(asNumber(record.confidence, 0)), makePatternKey(objectiveTypePersist, scopeValidation2.normalizedTargetPaths, triggerTypePersist, componentAreaPersist), llmScore, impactSignal, emaSuccess, emaUserAccept, JSON.stringify(penalties), finalScore, asBoolean2(record.selected, false) ? 1 : 0, asString3(record.rejectionReason ?? record.rejection_reason) || null, asString3(record.gateDecision ?? record.gate_decision) || (gateReasons.length === 0 ? "approved" : "rejected"), JSON.stringify(gateReasons.length === 0 ? asStringArray3(record.gateReasons ?? record.gate_reasons) : gateReasons), JSON.stringify(debugRecord), asIsoNow());
    }
    const llmCalls = Array.isArray(body.llmCalls) ? body.llmCalls : [];
    for (const raw of llmCalls) {
      const call = asObject2(raw);
      this.db.prepare(`INSERT OR REPLACE INTO autonomy_llm_calls (
            id, run_id, snapshot_id, objective_id, phase, prompt_template_version, prompt_hash,
            request_payload_hash, model_id, temperature, timeout_ms, response_json, response_hash,
            token_usage_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(asString3(call.id) || randomUUID5(), runId, snapshotId, asString3(call.objectiveId ?? call.objective_id) || null, asString3(call.phase), asString3(call.promptTemplateVersion ?? call.prompt_template_version) || null, asString3(call.promptHash ?? call.prompt_hash) || null, asString3(call.requestPayloadHash ?? call.request_payload_hash) || null, asString3(call.modelId ?? call.model_id) || null, Number.isFinite(asNumber(call.temperature, Number.NaN)) ? asNumber(call.temperature, 0) : null, Number.isFinite(asNumber(call.timeoutMs ?? call.timeout_ms, Number.NaN)) ? Math.floor(asNumber(call.timeoutMs ?? call.timeout_ms, 0)) : null, this.llmResponseJsonForStorage(call), asString3(call.responseHash ?? call.response_hash) || null, JSON.stringify(asObject2(call.tokenUsage ?? call.token_usage)), asIsoNow());
    }
    if (llmCalls.length > 0)
      this.enforceReplayRetention();
    const objective = asObject2(body.objective);
    if (Object.keys(objective).length === 0)
      return { ok: true };
    const objectiveId = asString3(objective.id) || randomUUID5();
    const objectiveTypeRaw = asString3(objective.objectiveType ?? objective.objective_type);
    const objectiveType = asObjectiveType(objectiveTypeRaw);
    const now = asIsoNow();
    const objectiveStatus = asString3(objective.status);
    if (!objectiveType) {
      return { ok: false, objectiveId, reason: `invalid objective_type "${objectiveTypeRaw}"` };
    }
    const componentAreaRaw = asString3(objective.componentArea ?? objective.component_area);
    const componentArea = asComponentArea(componentAreaRaw);
    const triggerTypeRaw = asString3(objective.triggerType ?? objective.trigger_type);
    const triggerType = asTriggerType(triggerTypeRaw);
    if (!triggerType) {
      return { ok: false, objectiveId, reason: `invalid trigger_type "${triggerTypeRaw}"` };
    }
    const targetPaths = asStringArray3(objective.targetPaths ?? objective.target_paths);
    const scopeRecord = asObject2(objective.scope);
    const riskLevel = asString3(objective.riskLevel ?? objective.risk_level);
    const readAnywhere = asBoolean2(scopeRecord.readAnywhere ?? scopeRecord.read_anywhere, false);
    const scopeValidation = validateScopeInvariants(componentArea, targetPaths, asStringArray3(scopeRecord.writeGlobs ?? scopeRecord.write_globs), { requireWriteGlobs: true, hintsOnly: true });
    if (!scopeValidation.ok)
      return { ok: false, objectiveId, reason: scopeValidation.errors.join("; ") };
    const normalizedComponentArea = scopeValidation.componentArea ?? componentAreaRaw;
    const expectedValidation = asStringArray3(objective.expectedValidation ?? objective.expected_validation ?? asObject2(body.candidate).expectedValidation ?? asObject2(body.candidate).expected_validation);
    const policyErrors = policyViolations({
      objectiveType,
      riskLevel,
      readAnywhere,
      expectedValidation,
      allowReadAnywhere: this.config.remotebuddy.autonomy.allowReadAnywhere
    });
    if (policyErrors.length > 0) {
      return { ok: false, objectiveId, reason: policyErrors.join("; ") };
    }
    const pushpalsInternalErr = pushpalsInternalCandidateReason(objective);
    if (pushpalsInternalErr) {
      return { ok: false, objectiveId, reason: pushpalsInternalErr };
    }
    const patternKey = makePatternKey(objectiveType, scopeValidation.normalizedTargetPaths, triggerType, normalizedComponentArea);
    const objectiveCandidateRaw = asString3(objective.candidateId ?? objective.candidate_id);
    const objectiveCandidateId = objectiveCandidateRaw ? scopedCandidateStorageId(runId, objectiveCandidateRaw) : null;
    if (objectiveStatus === "dispatched") {
      const overrideCooldown = asBoolean2(objective.overrideCooldown ?? objective.override_cooldown ?? body.overrideCooldown ?? body.override_cooldown, false);
      const eligibility = this.evaluateEligibility({
        runId,
        snapshotId,
        candidates: [
          {
            candidate_id: objectiveId,
            objective_type: objectiveType,
            pattern_key: patternKey,
            confidence: clamp012(asNumber(objective.confidence, 0))
          }
        ]
      });
      if (!eligibility.ok) {
        return {
          ok: false,
          objectiveId,
          reason: eligibility.reason ?? "eligibility evaluation failed"
        };
      }
      const decision = eligibility.results?.[0];
      if (!decision?.ok) {
        const reason = asString3(decision?.reason) || "objective not eligible for dispatch";
        const isCooldownOnlyBlock = reason.startsWith("cooldown_active");
        if (!(overrideCooldown && isCooldownOnlyBlock)) {
          return {
            ok: false,
            objectiveId,
            reason
          };
        }
      }
    }
    this.db.prepare(`INSERT OR REPLACE INTO autonomy_objectives (
          id, run_id, snapshot_id, session_id, candidate_id, title, instruction, objective_type,
          component_area, trigger_type, pattern_key, status, source, confidence, priority, risk_level,
          request_id, job_id, question_id, block_reason, scope_json, evidence_json,
          score_breakdown_json, policy_version, impact_model_version, dispatched_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'autonomous', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(objectiveId, runId, snapshotId, sessionId, objectiveCandidateId, asString3(objective.title), asString3(objective.instruction), objectiveType, normalizedComponentArea, triggerType, patternKey, objectiveStatus, clamp012(asNumber(objective.confidence, 0)), asString3(objective.priority) || "background", riskLevel, asString3(objective.requestId ?? objective.request_id) || null, asString3(objective.jobId ?? objective.job_id) || null, asString3(objective.questionId ?? objective.question_id) || null, asString3(objective.blockReason ?? objective.block_reason) || null, JSON.stringify({
      readAnywhere,
      writeGlobs: scopeValidation.normalizedWriteGlobs,
      targetPaths: scopeValidation.normalizedTargetPaths
    }), JSON.stringify(asObject2(objective.evidence)), JSON.stringify(asObject2(objective.scoreBreakdown ?? objective.score_breakdown)), asString3(objective.policyVersion ?? objective.policy_version) || this.config.remotebuddy.autonomy.policyVersion, asString3(objective.impactModelVersion ?? objective.impact_model_version) || this.config.remotebuddy.autonomy.impactModelVersion, objectiveStatus === "dispatched" ? now : null, now, now);
    const trialMeta = (objectiveCandidateId ? candidateEngineTrialMetaById.get(objectiveCandidateId) : undefined) ?? null;
    if (trialMeta) {
      const trialId = `trial_${objectiveId}`;
      this.db.prepare(`INSERT OR REPLACE INTO autonomy_engine_idea_trials (
            trial_id, run_id, snapshot_id, session_id, objective_id, candidate_id, pattern_key,
            engine_building_block_id, engine_algorithm, engine_source, engine_score,
            inspiration_source_key, inspiration_source_type, inspiration_source_label, inspiration_source_url,
            inspiration_source_fingerprint,
            objective_ids_json, gap_ids_json, metadata_json, status, success, user_action, latency_ms,
            last_outcome_id, created_at, updated_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL)`).run(trialId, runId, snapshotId, sessionId, objectiveId, objectiveCandidateId, patternKey, trialMeta.buildingBlockId, trialMeta.algorithm, trialMeta.source || "llm", trialMeta.score, trialMeta.inspirationSourceKey, trialMeta.inspirationSourceType, trialMeta.inspirationSourceLabel, trialMeta.inspirationSourceUrl, trialMeta.inspirationSourceFingerprint, JSON.stringify(trialMeta.objectiveIds), JSON.stringify(trialMeta.gapIds), JSON.stringify(trialMeta.metadata), objectiveStatus || "proposed", now, now);
    }
    let questionId;
    const question = asObject2(body.question);
    if (Object.keys(question).length > 0) {
      questionId = asString3(question.id) || randomUUID5();
      this.db.prepare(`INSERT OR REPLACE INTO questions_queue (
            id, objective_id, session_id, question, question_type, expected_answer_schema_json,
            context_json, status, answer_json, answer_validation_status, validation_error, created_at,
            answered_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, 'pending', NULL, ?, NULL, ?)`).run(questionId, objectiveId, sessionId, asString3(question.question), asString3(question.questionType ?? question.question_type), JSON.stringify(asObject2(question.expectedAnswerSchema ?? question.expected_answer_schema)), JSON.stringify(asObject2(question.context)), now, asString3(question.expiresAt ?? question.expires_at) || new Date(Date.parse(now) + this.config.remotebuddy.autonomy.questionTtlMs).toISOString());
      this.db.prepare(`UPDATE autonomy_objectives SET question_id = ?, updated_at = ? WHERE id = ?`).run(questionId, now, objectiveId);
    }
    return { ok: true, objectiveId, questionId, patternKey };
  }
  resolvePatternContext(params) {
    const objectiveId = asString3(params.objectiveId);
    const requestId = asString3(params.requestId);
    const jobId = asString3(params.jobId);
    const prUrl = asString3(params.prUrl);
    const readByObjective = (id) => this.db.prepare(`SELECT id AS objectiveId, request_id AS requestId, job_id AS jobId, pattern_key AS patternKey
           FROM autonomy_objectives
           WHERE id = ?
           ORDER BY updated_at DESC
           LIMIT 1`).get(id);
    const readByRequest = (id) => this.db.prepare(`SELECT id AS objectiveId, request_id AS requestId, job_id AS jobId, pattern_key AS patternKey
           FROM autonomy_objectives
           WHERE request_id = ?
           ORDER BY updated_at DESC
           LIMIT 1`).get(id);
    const readByJob = (id) => this.db.prepare(`SELECT id AS objectiveId, request_id AS requestId, job_id AS jobId, pattern_key AS patternKey
           FROM autonomy_objectives
           WHERE job_id = ?
           ORDER BY updated_at DESC
           LIMIT 1`).get(id);
    const readByPrUrl = (url) => {
      try {
        return this.db.prepare(`SELECT o.id AS objectiveId,
                    o.request_id AS requestId,
                    o.job_id AS jobId,
                    o.pattern_key AS patternKey
             FROM autonomy_objectives o
             JOIN jobs j ON j.id = o.job_id
             WHERE j.prUrl = ? OR LOWER(j.prUrl) = LOWER(?)
             ORDER BY o.updated_at DESC
             LIMIT 1`).get(url, url);
      } catch {
        return;
      }
    };
    const db = this.db;
    function readContextFromJobRow(whereSql, args, visitedJobIds = new Set) {
      let row2;
      try {
        row2 = db.prepare(`SELECT id AS jobId, params AS paramsJson
             FROM jobs
             WHERE ${whereSql}
             ORDER BY COALESCE(completedAt, failedAt, updatedAt, createdAt) DESC
             LIMIT 1`).get(...args);
      } catch {
        return;
      }
      if (!row2)
        return;
      const currentJobId = asString3(row2.jobId);
      if (currentJobId)
        visitedJobIds.add(currentJobId);
      const paramsRecord = parseJsonObject(row2.paramsJson);
      const autonomyRecord = asObject2(paramsRecord.autonomy);
      const reviewAgentRecord = asObject2(paramsRecord.reviewAgent);
      const sourceJobId = asString3(reviewAgentRecord.sourceJobId ?? reviewAgentRecord.source_job_id);
      const resolvedFromObjective = (asString3(autonomyRecord.objectiveId ?? paramsRecord.objectiveId ?? paramsRecord.objective_id) ? readByObjective(asString3(autonomyRecord.objectiveId ?? paramsRecord.objectiveId ?? paramsRecord.objective_id)) : undefined) ?? (asString3(paramsRecord.requestId ?? paramsRecord.request_id) ? readByRequest(asString3(paramsRecord.requestId ?? paramsRecord.request_id)) : undefined);
      const resolvedFromSourceJob = sourceJobId && !visitedJobIds.has(sourceJobId) ? readByJob(sourceJobId) ?? readContextFromJobRow("id = ?", [sourceJobId], new Set(visitedJobIds)) : undefined;
      return {
        objectiveId: asString3(autonomyRecord.objectiveId ?? paramsRecord.objectiveId ?? paramsRecord.objective_id) || asString3(resolvedFromObjective?.objectiveId) || asString3(resolvedFromSourceJob?.objectiveId) || null,
        requestId: asString3(paramsRecord.requestId ?? paramsRecord.request_id) || asString3(resolvedFromObjective?.requestId) || asString3(resolvedFromSourceJob?.requestId) || null,
        jobId: currentJobId || asString3(resolvedFromObjective?.jobId) || asString3(resolvedFromSourceJob?.jobId) || null,
        patternKey: asString3(autonomyRecord.patternKey ?? paramsRecord.patternKey ?? paramsRecord.pattern_key) || asString3(resolvedFromObjective?.patternKey) || asString3(resolvedFromSourceJob?.patternKey) || null
      };
    }
    const readJobById = (id) => readContextFromJobRow("id = ?", [id]);
    const readJobByPrUrl = (url) => readContextFromJobRow("prUrl = ? OR LOWER(prUrl) = LOWER(?)", [url, url]);
    const row = (objectiveId ? readByObjective(objectiveId) : undefined) ?? (jobId ? readByJob(jobId) : undefined) ?? (requestId ? readByRequest(requestId) : undefined) ?? (prUrl ? readByPrUrl(prUrl) : undefined) ?? (jobId ? readJobById(jobId) : undefined) ?? (prUrl ? readJobByPrUrl(prUrl) : undefined);
    if (!row)
      return null;
    return {
      objectiveId: asString3(row.objectiveId) || null,
      requestId: asString3(row.requestId) || null,
      jobId: asString3(row.jobId) || null,
      patternKey: asString3(row.patternKey) || null
    };
  }
  recordPrFeedback(body) {
    const now = asIsoNow();
    const verdict = asString3(body.verdict).toLowerCase();
    if (!verdict)
      return { ok: false, reason: "verdict is required" };
    const feedbackKey = asString3(body.feedbackKey ?? body.feedback_key) || null;
    const objectiveIdRaw = asString3(body.objectiveId ?? body.objective_id) || null;
    const requestIdRaw = asString3(body.requestId ?? body.request_id) || null;
    const jobIdRaw = asString3(body.jobId ?? body.job_id) || null;
    const prUrl = asString3(body.prUrl ?? body.pr_url) || null;
    let patternKey = asString3(body.patternKey ?? body.pattern_key) || null;
    const resolved = this.resolvePatternContext({
      objectiveId: objectiveIdRaw,
      requestId: requestIdRaw,
      jobId: jobIdRaw,
      prUrl
    });
    if (!patternKey) {
      patternKey = asString3(resolved?.patternKey) || null;
    }
    if (!patternKey) {
      return {
        ok: true,
        ignored: true,
        reason: "unable to resolve patternKey from objectiveId/requestId/jobId/prUrl"
      };
    }
    const objectiveId = objectiveIdRaw ?? resolved?.objectiveId ?? null;
    const requestId = requestIdRaw ?? resolved?.requestId ?? null;
    const jobId = jobIdRaw ?? resolved?.jobId ?? null;
    const reviewScore = Number.isFinite(asNumber(body.reviewScore ?? body.review_score, Number.NaN)) ? asNumber(body.reviewScore ?? body.review_score, 0) : null;
    const reviewThreshold = Number.isFinite(asNumber(body.reviewThreshold ?? body.review_threshold, Number.NaN)) ? asNumber(body.reviewThreshold ?? body.review_threshold, 0) : null;
    const prFeedbackCommentRows = Math.max(1, Math.floor(asNumber(this.config.remotebuddy.autonomy.prFeedbackCommentRows, 16)));
    const prFeedbackCommentChars = Math.max(32, Math.floor(asNumber(this.config.remotebuddy.autonomy.prFeedbackCommentChars, 600)));
    const prFeedbackSummaryChars = Math.max(32, Math.floor(asNumber(this.config.remotebuddy.autonomy.prFeedbackSummaryChars, 600)));
    const summary = truncateText(asString3(body.summary ?? body.verdictSummary ?? body.verdict_summary), prFeedbackSummaryChars);
    const source = asString3(body.source) || "review_agent";
    const prNumber = Number.isFinite(asNumber(body.prNumber ?? body.pr_number, Number.NaN)) ? Math.max(0, Math.floor(asNumber(body.prNumber ?? body.pr_number, 0))) : null;
    const rawComments = Array.isArray(body.comments) ? body.comments : [];
    const comments = rawComments.map((entry) => {
      const row = asObject2(entry);
      const text = truncateText(asString3(row.body), prFeedbackCommentChars);
      if (!text)
        return null;
      return {
        body: text,
        user_login: asString3(row.userLogin ?? row.user_login ?? row.author),
        created_at: asString3(row.createdAt ?? row.created_at),
        html_url: asString3(row.htmlUrl ?? row.html_url)
      };
    }).filter((entry) => Boolean(entry)).slice(0, prFeedbackCommentRows);
    const payloadCommentCount = Number.isFinite(asNumber(body.commentCount ?? body.comment_count, Number.NaN)) ? Math.max(0, Math.floor(asNumber(body.commentCount ?? body.comment_count, 0))) : 0;
    const commentCount = Math.max(payloadCommentCount, comments.length);
    const insertInfo = this.db.prepare(`INSERT OR IGNORE INTO autonomy_pr_feedback (
          feedback_key, objective_id, request_id, job_id, pattern_key, pr_number, pr_url,
          verdict, review_score, review_threshold, summary, comment_count, comments_json, source, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(feedbackKey, objectiveId, requestId, jobId, patternKey, prNumber, prUrl, verdict, reviewScore, reviewThreshold, summary || null, commentCount, comments.length > 0 ? JSON.stringify(comments) : null, source, now);
    const inserted = Number(insertInfo.changes ?? 0) > 0;
    if (!inserted) {
      return {
        ok: true,
        deduped: true,
        patternKey,
        ...objectiveId ? { objectiveId } : {}
      };
    }
    const mappedOutcome = deriveOutcomeFromPrFeedbackVerdict(verdict);
    if (!mappedOutcome) {
      return {
        ok: true,
        patternKey,
        ...objectiveId ? { objectiveId } : {}
      };
    }
    const outcome = this.recordOutcome({
      objectiveId,
      requestId,
      jobId,
      patternKey,
      success: mappedOutcome.success,
      retries: 0,
      latencyMs: null,
      userAction: mappedOutcome.userAction,
      reopenedWithin24h: mappedOutcome.reopenedWithin24h,
      regressionFlag: mappedOutcome.regressionFlag,
      terminal: mappedOutcome.terminal
    });
    if (!outcome.ok) {
      return {
        ok: false,
        reason: outcome.reason
      };
    }
    return {
      ok: true,
      patternKey,
      ...objectiveId ? { objectiveId } : {},
      success: mappedOutcome.success,
      userAction: mappedOutcome.userAction
    };
  }
  recordOutcome(body) {
    let patternKey = asString3(body.patternKey ?? body.pattern_key);
    const objectiveIdRaw = asString3(body.objectiveId ?? body.objective_id) || null;
    const requestIdRaw = asString3(body.requestId ?? body.request_id) || null;
    const jobIdRaw = asString3(body.jobId ?? body.job_id) || null;
    const resolved = !patternKey || !objectiveIdRaw || !requestIdRaw || !jobIdRaw ? this.resolvePatternContext({
      objectiveId: objectiveIdRaw,
      requestId: requestIdRaw,
      jobId: jobIdRaw
    }) : null;
    if (!patternKey) {
      patternKey = asString3(resolved?.patternKey);
    }
    if (!patternKey)
      return { ok: false, reason: "patternKey is required" };
    const objectiveId = objectiveIdRaw ?? resolved?.objectiveId ?? null;
    const requestId = requestIdRaw ?? resolved?.requestId ?? null;
    const jobId = jobIdRaw ?? resolved?.jobId ?? null;
    const now = asIsoNow();
    const success = asBoolean2(body.success, false);
    const retries = Math.max(0, Math.floor(asNumber(body.retries, 0)));
    const latencyMs = Number.isFinite(asNumber(body.latencyMs ?? body.latency_ms, Number.NaN)) ? Math.max(0, Math.floor(asNumber(body.latencyMs ?? body.latency_ms, 0))) : null;
    const userAction = asString3(body.userAction ?? body.user_action) || null;
    const reopenedWithin24h = asBoolean2(body.reopenedWithin24h ?? body.reopened_within_24h, false);
    const regressionFlag = asBoolean2(body.regressionFlag ?? body.regression_flag, false);
    const terminal = asBoolean2(body.terminal ?? body.isTerminal ?? body.is_terminal ?? body.terminal_outcome, true);
    const normalizedUserAction = userAction ? userAction.toLowerCase() : "";
    if (success && normalizedUserAction === "accepted" && !jobId && objectiveId) {
      const objectiveRow = this.db.prepare(`SELECT source, status, job_id FROM autonomy_objectives WHERE id = ? LIMIT 1`).get(objectiveId);
      if (objectiveRow) {
        const source = asString3(objectiveRow.source).toLowerCase();
        const status = asString3(objectiveRow.status).toLowerCase();
        const linkedJobId = asString3(objectiveRow.job_id);
        const pendingStatuses = new Set(["proposed", "gated", "dispatched", "running"]);
        if (source === "autonomous" && !linkedJobId && pendingStatuses.has(status)) {
          return { ok: true };
        }
      }
    }
    const outcomeInsert = this.db.prepare(`INSERT INTO autonomy_outcomes (
          objective_id, request_id, job_id, pattern_key, success, retries, latency_ms, user_action,
          reopened_within_24h, regression_flag, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(objectiveId, requestId, jobId, patternKey, success ? 1 : 0, retries, latencyMs, userAction, reopenedWithin24h ? 1 : 0, regressionFlag ? 1 : 0, now);
    const outcomeId = Math.max(0, Math.floor(asNumber(outcomeInsert.lastInsertRowid, 0)));
    if (!terminal) {
      this.maybeRunEvaluator(now);
      return { ok: true };
    }
    if (objectiveId) {
      const terminalStatus = success ? "completed" : "failed";
      this.db.prepare(`UPDATE autonomy_objectives
           SET status = ?,
               request_id = COALESCE(?, request_id),
               job_id = COALESCE(?, job_id),
               updated_at = ?
           WHERE id = ?`).run(terminalStatus, requestId, jobId, now, objectiveId);
    }
    const pendingIdeaTrials = objectiveId ? this.db.prepare(`SELECT trial_id, engine_building_block_id, engine_algorithm,
                    inspiration_source_key, inspiration_source_type, inspiration_source_label,
                    inspiration_source_url, inspiration_source_fingerprint
             FROM autonomy_engine_idea_trials
             WHERE objective_id = ?
               AND completed_at IS NULL
             ORDER BY created_at ASC`).all(objectiveId) : [];
    const existing = this.db.prepare(`SELECT ema_success, ema_user_accept, ema_latency, ema_regret, fail_streak, sample_count
         FROM autonomy_pattern_stats
         WHERE pattern_key = ?`).get(patternKey);
    const prev = existing ?? {
      ema_success: 0,
      ema_user_accept: 0,
      ema_latency: 0,
      ema_regret: 0,
      fail_streak: 0,
      sample_count: 0
    };
    const ema = (oldValue, currentValue) => this.alpha * currentValue + (1 - this.alpha) * oldValue;
    const successValue = success ? 1 : 0;
    const userAcceptValue = userAction && ["accepted", "manual_fix", "override_dispatch", "applied"].includes(userAction) ? 1 : 0;
    const latencyScore = typeof latencyMs === "number" ? clamp012(1 - latencyMs / 600000) : prev.ema_latency;
    const regretValue = reopenedWithin24h || userAction && ["rejected", "cancelled"].includes(userAction) ? 1 : 0;
    const nextFailStreak = success ? 0 : prev.fail_streak + 1;
    const cooldownUntil = !success && nextFailStreak >= this.config.remotebuddy.autonomy.cooldownFailStreakThreshold ? new Date(Date.parse(now) + this.config.remotebuddy.autonomy.cooldownMs).toISOString() : null;
    if (pendingIdeaTrials.length > 0) {
      const terminalStatus = success ? "completed" : "failed";
      const outcomeRef = outcomeId > 0 ? outcomeId : null;
      const updateTrial = this.db.prepare(`UPDATE autonomy_engine_idea_trials
         SET status = ?,
             success = ?,
             user_action = ?,
             latency_ms = ?,
             last_outcome_id = ?,
             completed_at = ?,
             updated_at = ?
         WHERE trial_id = ?
           AND completed_at IS NULL`);
      const readIdeaStat = this.db.prepare(`SELECT ema_success, ema_user_accept, ema_latency, ema_regret, sample_count
         FROM autonomy_engine_idea_stats
         WHERE engine_building_block_id = ?`);
      const upsertIdeaStat = this.db.prepare(`INSERT INTO autonomy_engine_idea_stats (
          engine_building_block_id, engine_algorithm, ema_success, ema_user_accept, ema_latency, ema_regret, sample_count, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(engine_building_block_id) DO UPDATE SET
          engine_algorithm = excluded.engine_algorithm,
          ema_success = excluded.ema_success,
          ema_user_accept = excluded.ema_user_accept,
          ema_latency = excluded.ema_latency,
          ema_regret = excluded.ema_regret,
          sample_count = excluded.sample_count,
          updated_at = excluded.updated_at`);
      const readSourceStat = this.db.prepare(`SELECT ema_success, ema_user_accept, ema_latency, ema_regret, sample_count,
                trust_score, freshness_score, curation_status, curation_reason
         FROM autonomy_engine_source_stats
         WHERE source_key = ?`);
      const upsertSourceStat = this.db.prepare(`INSERT INTO autonomy_engine_source_stats (
          source_key, source_type, source_label, source_url, source_fingerprint, source_algorithm,
          curation_status, curation_reason, trust_score, freshness_score, last_reinforced_at,
          ema_success, ema_user_accept, ema_latency, ema_regret, sample_count, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_key) DO UPDATE SET
          source_type = excluded.source_type,
          source_label = excluded.source_label,
          source_url = excluded.source_url,
          source_fingerprint = excluded.source_fingerprint,
          source_algorithm = excluded.source_algorithm,
          curation_status = excluded.curation_status,
          curation_reason = excluded.curation_reason,
          trust_score = excluded.trust_score,
          freshness_score = excluded.freshness_score,
          last_reinforced_at = excluded.last_reinforced_at,
          ema_success = excluded.ema_success,
          ema_user_accept = excluded.ema_user_accept,
          ema_latency = excluded.ema_latency,
          ema_regret = excluded.ema_regret,
          sample_count = excluded.sample_count,
          updated_at = excluded.updated_at`);
      const readPatternByFingerprint = this.db.prepare(`SELECT id, quality_score, freshness_score, metadata_json
         FROM autonomy_inspiration_patterns
         WHERE fingerprint = ?
         LIMIT 1`);
      const updatePatternByFingerprint = this.db.prepare(`UPDATE autonomy_inspiration_patterns
         SET quality_score = ?,
             freshness_score = ?,
             metadata_json = ?,
             last_seen_at = ?,
             updated_at = ?
         WHERE id = ?`);
      for (const trial of pendingIdeaTrials) {
        updateTrial.run(terminalStatus, success ? 1 : 0, userAction, latencyMs, outcomeRef, now, now, trial.trial_id);
        const blockId = asString3(trial.engine_building_block_id);
        if (!blockId)
          continue;
        const stats = readIdeaStat.get(blockId);
        const prevIdea = stats ?? {
          ema_success: 0,
          ema_user_accept: 0,
          ema_latency: 0,
          ema_regret: 0,
          sample_count: 0
        };
        const ideaLatencyScore = typeof latencyMs === "number" ? clamp012(1 - latencyMs / 600000) : prevIdea.ema_latency;
        upsertIdeaStat.run(blockId, asString3(trial.engine_algorithm) || "engine_building_block", ema(prevIdea.ema_success, successValue), ema(prevIdea.ema_user_accept, userAcceptValue), ema(prevIdea.ema_latency, ideaLatencyScore), ema(prevIdea.ema_regret, regretValue), prevIdea.sample_count + 1, now);
        const sourceKey = asString3(trial.inspiration_source_key) || deriveInspirationSourceKey({
          sourceFingerprint: asString3(trial.inspiration_source_fingerprint),
          sourceType: asString3(trial.inspiration_source_type),
          sourceLabel: asString3(trial.inspiration_source_label),
          sourceUrl: asString3(trial.inspiration_source_url)
        });
        if (!sourceKey)
          continue;
        const sourceStats = readSourceStat.get(sourceKey);
        const prevSource = sourceStats ?? {
          ema_success: 0,
          ema_user_accept: 0,
          ema_latency: 0,
          ema_regret: 0,
          sample_count: 0,
          trust_score: 0,
          freshness_score: 0.5,
          curation_status: "candidate",
          curation_reason: null
        };
        const sourceLatencyScore = typeof latencyMs === "number" ? clamp012(1 - latencyMs / 600000) : prevSource.ema_latency;
        const nextSourceEmaSuccess = ema(prevSource.ema_success, successValue);
        const nextSourceEmaUserAccept = ema(prevSource.ema_user_accept, userAcceptValue);
        const nextSourceEmaLatency = ema(prevSource.ema_latency, sourceLatencyScore);
        const nextSourceEmaRegret = ema(prevSource.ema_regret, regretValue);
        const nextSourceSampleCount = prevSource.sample_count + 1;
        const prevFreshness = clamp012(asNumber(prevSource.freshness_score, 0.5));
        const reinforcedFreshness = clamp012(prevFreshness * 0.85 + (success ? 0.15 : 0.08));
        const nextSourceTrustScore = computeEngineSourceTrustScore({
          ema_success: nextSourceEmaSuccess,
          ema_user_accept: nextSourceEmaUserAccept,
          ema_latency: nextSourceEmaLatency,
          ema_regret: nextSourceEmaRegret
        });
        const nextSourceCuration = classifyEngineSourceCuration({
          sample_count: nextSourceSampleCount,
          trust_score: nextSourceTrustScore,
          ema_success: nextSourceEmaSuccess,
          ema_user_accept: nextSourceEmaUserAccept,
          ema_regret: nextSourceEmaRegret,
          freshness_score: reinforcedFreshness
        });
        upsertSourceStat.run(sourceKey, asString3(trial.inspiration_source_type) || "unknown", asString3(trial.inspiration_source_label) || null, asString3(trial.inspiration_source_url) || null, asString3(trial.inspiration_source_fingerprint) || null, asString3(trial.engine_algorithm) || "engine_building_block", nextSourceCuration.status, nextSourceCuration.reason, nextSourceTrustScore, reinforcedFreshness, now, nextSourceEmaSuccess, nextSourceEmaUserAccept, nextSourceEmaLatency, nextSourceEmaRegret, nextSourceSampleCount, now);
        const fingerprint = asString3(trial.inspiration_source_fingerprint);
        if (!fingerprint)
          continue;
        const patternRow = readPatternByFingerprint.get(fingerprint);
        if (!patternRow)
          continue;
        const currentQuality = clamp012(asNumber(patternRow.quality_score, 0.5));
        const currentFreshness = clamp012(asNumber(patternRow.freshness_score, 0.5));
        const targetQuality = clamp012(success ? 0.55 + 0.45 * nextSourceTrustScore : 0.25 + 0.2 * (1 - nextSourceEmaRegret));
        const nextQuality = ema(currentQuality, targetQuality);
        const nextPatternFreshness = clamp012(Math.max(currentFreshness * 0.9, reinforcedFreshness));
        const patternMetadata = parseJsonObject(patternRow.metadata_json);
        const nextPatternMetadata = {
          ...patternMetadata,
          source_key: sourceKey,
          source_curation_status: nextSourceCuration.status,
          source_curation_reason: nextSourceCuration.reason,
          source_trust_score: nextSourceTrustScore,
          last_reinforced_at: now
        };
        updatePatternByFingerprint.run(nextQuality, nextPatternFreshness, JSON.stringify(nextPatternMetadata), now, now, Math.max(0, Math.floor(asNumber(patternRow.id, 0))));
      }
    }
    this.db.prepare(`INSERT INTO autonomy_pattern_stats (
          pattern_key, ema_success, ema_user_accept, ema_latency, ema_regret, fail_streak,
          cooldown_until, sample_count, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(pattern_key) DO UPDATE SET
          ema_success = excluded.ema_success,
          ema_user_accept = excluded.ema_user_accept,
          ema_latency = excluded.ema_latency,
          ema_regret = excluded.ema_regret,
          fail_streak = excluded.fail_streak,
          cooldown_until = excluded.cooldown_until,
          sample_count = excluded.sample_count,
          updated_at = excluded.updated_at`).run(patternKey, ema(prev.ema_success, successValue), ema(prev.ema_user_accept, userAcceptValue), ema(prev.ema_latency, latencyScore), ema(prev.ema_regret, regretValue), nextFailStreak, cooldownUntil, prev.sample_count + 1, now);
    const autoFreezeThreshold = Math.max(1, Math.floor(asNumber(this.config.remotebuddy.autonomy.autoFreezeFailStreakThreshold, 3)));
    if (!success && nextFailStreak >= autoFreezeThreshold) {
      const freezeForMs = Math.max(60000, Math.floor(asNumber(this.config.remotebuddy.autonomy.autoFreezeDurationMs, 1800000)));
      const freezeResult = this.applyAutomaticFreeze({
        freezeForMs,
        freezeReason: `auto_freeze:fail_streak:${patternKey}`,
        nowIso: now
      });
      if (freezeResult.applied) {
        this.recordOpsAlert({
          alertType: "auto_freeze_fail_streak",
          severity: "critical",
          message: `Auto-freeze triggered by fail streak ${nextFailStreak} ` + `for ${patternKey} (threshold ${autoFreezeThreshold})`,
          details: {
            patternKey,
            failStreak: nextFailStreak,
            threshold: autoFreezeThreshold,
            freezeUntil: freezeResult.state.freezeUntil
          },
          nowIso: now
        });
      }
    }
    this.maybeRunEvaluator(now);
    return { ok: true };
  }
  ingestInspirationPatterns(body) {
    const rawEntries = Array.isArray(body.entries) ? body.entries : Array.isArray(body.patterns) ? body.patterns : Array.isArray(body.items) ? body.items : [];
    if (rawEntries.length === 0) {
      return {
        ok: false,
        inserted: 0,
        updated: 0,
        skipped: 0,
        results: [],
        reason: "entries (or patterns/items) array is required"
      };
    }
    const now = asIsoNow();
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    const results = [];
    const readExisting = this.db.prepare(`SELECT id, source_label, source_url, source_refs_json, summary, risks_json, validation_json, tags_json,
              quality_score, freshness_score, metadata_json, seen_count
       FROM autonomy_inspiration_patterns
       WHERE fingerprint = ?
       LIMIT 1`);
    const insertPattern = this.db.prepare(`INSERT INTO autonomy_inspiration_patterns (
        fingerprint, source_type, source_label, source_url, source_refs_json, algorithm, when_to_use, summary,
        risks_json, validation_json, tags_json, quality_score, freshness_score, metadata_json,
        first_seen_at, last_seen_at, seen_count, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const updatePattern = this.db.prepare(`UPDATE autonomy_inspiration_patterns
       SET source_type = ?,
           source_label = ?,
           source_url = ?,
           source_refs_json = ?,
           algorithm = ?,
           when_to_use = ?,
           summary = ?,
           risks_json = ?,
           validation_json = ?,
           tags_json = ?,
           quality_score = ?,
           freshness_score = ?,
           metadata_json = ?,
           last_seen_at = ?,
           seen_count = ?,
           updated_at = ?
       WHERE id = ?`);
    for (const raw of rawEntries) {
      const normalized = normalizeInspirationPatternEntry(raw);
      if (!normalized) {
        skipped += 1;
        results.push({
          fingerprint: "",
          status: "skipped",
          reason: "missing required fields: algorithm, when_to_use, summary"
        });
        continue;
      }
      const existing = readExisting.get(normalized.fingerprint);
      if (!existing) {
        const insertRes = insertPattern.run(normalized.fingerprint, normalized.sourceType, normalized.sourceLabel, normalized.sourceUrl, JSON.stringify(normalized.sourceRefs), normalized.algorithm, normalized.whenToUse, normalized.summary, JSON.stringify(normalized.risks), JSON.stringify(normalized.validationIdeas), JSON.stringify(normalized.tags), normalized.qualityScore, normalized.freshnessScore, JSON.stringify(normalized.metadata), now, now, 1, now);
        inserted += 1;
        results.push({
          fingerprint: normalized.fingerprint,
          status: "inserted",
          id: Math.max(0, Math.floor(asNumber(insertRes.lastInsertRowid, 0)))
        });
        continue;
      }
      const previousSeenCount = Math.max(1, Math.floor(asNumber(existing.seen_count, 1)));
      const nextSeenCount = previousSeenCount + 1;
      const mergedSourceRefs = mergeUniqueText(normalizeTextList(parseJsonArray2(existing.source_refs_json), 32, 1000), normalized.sourceRefs, 32);
      const mergedRisks = mergeUniqueText(normalizeTextList(parseJsonArray2(existing.risks_json), 20, 320), normalized.risks, 20);
      const mergedValidation = mergeUniqueText(normalizeTextList(parseJsonArray2(existing.validation_json), 20, 320), normalized.validationIdeas, 20);
      const mergedTags = uniqueLowercaseTokens([...normalizeTextList(parseJsonArray2(existing.tags_json), 24, 120), ...normalized.tags], 24);
      const existingSummary = asString3(existing.summary);
      const mergedSummary = normalized.summary.length > existingSummary.length ? normalized.summary : existingSummary || normalized.summary;
      const mergedQuality = clamp012((clamp012(asNumber(existing.quality_score, 0.5)) * previousSeenCount + normalized.qualityScore) / nextSeenCount);
      const mergedFreshness = clamp012((clamp012(asNumber(existing.freshness_score, 0.5)) * previousSeenCount + normalized.freshnessScore) / nextSeenCount);
      const existingMetadata = parseJsonObject(existing.metadata_json);
      const mergedMetadata = {
        ...existingMetadata,
        ...normalized.metadata,
        source_refs: mergedSourceRefs
      };
      updatePattern.run(normalized.sourceType, normalized.sourceLabel || asString3(existing.source_label) || null, normalized.sourceUrl || asString3(existing.source_url) || null, JSON.stringify(mergedSourceRefs), normalized.algorithm, normalized.whenToUse, mergedSummary, JSON.stringify(mergedRisks), JSON.stringify(mergedValidation), JSON.stringify(mergedTags), mergedQuality, mergedFreshness, JSON.stringify(mergedMetadata), now, nextSeenCount, now, Math.max(0, Math.floor(asNumber(existing.id, 0))));
      updated += 1;
      results.push({
        fingerprint: normalized.fingerprint,
        status: "updated",
        id: Math.max(0, Math.floor(asNumber(existing.id, 0)))
      });
    }
    return {
      ok: true,
      inserted,
      updated,
      skipped,
      results
    };
  }
  listInspirationPatterns(params) {
    this.maybeRunInspirationMaintenance(asIsoNow());
    const limit = Math.max(1, Math.min(500, Math.floor(asNumber(params?.limit, 40))));
    const sourceTypeRaw = asString3(params?.sourceType);
    const sourceType = sourceTypeRaw ? normalizeInspirationSourceType(sourceTypeRaw) : "";
    const tag = asString3(params?.tag).toLowerCase();
    const q = asString3(params?.q).toLowerCase();
    const where = [];
    const args = [];
    if (sourceType) {
      where.push("p.source_type = ?");
      args.push(sourceType);
    }
    if (q) {
      where.push("(LOWER(p.algorithm) LIKE ? OR LOWER(p.when_to_use) LIKE ? OR LOWER(p.summary) LIKE ?)");
      const like = `%${q}%`;
      args.push(like, like, like);
    }
    const queryLimit = tag ? Math.min(1000, limit * 5) : limit;
    const rows = this.db.prepare(`SELECT p.id AS id, p.fingerprint AS fingerprint, p.source_type AS source_type,
                p.source_label AS source_label, p.source_url AS source_url, p.source_refs_json AS source_refs_json,
                p.algorithm AS algorithm, p.when_to_use AS when_to_use, p.summary AS summary,
                p.risks_json AS risks_json, p.validation_json AS validation_json, p.tags_json AS tags_json,
                p.quality_score AS quality_score, p.freshness_score AS freshness_score, p.metadata_json AS metadata_json,
                p.first_seen_at AS first_seen_at, p.last_seen_at AS last_seen_at, p.seen_count AS seen_count,
                p.updated_at AS updated_at,
                src.curation_status AS source_curation_status,
                src.curation_reason AS source_curation_reason,
                src.trust_score AS source_trust_score,
                src.freshness_score AS source_freshness_score
         FROM autonomy_inspiration_patterns p
         LEFT JOIN autonomy_engine_source_stats src
           ON src.source_fingerprint = p.fingerprint
         ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY p.updated_at DESC
         LIMIT ?`).all(...args, queryLimit);
    const mapped = rows.map((row) => {
      const tags = uniqueLowercaseTokens(parseJsonArray2(row.tags_json), 24);
      const metadata = parseJsonObject(row.metadata_json);
      const curationStatus = normalizeEngineSourceCurationStatus(row.source_curation_status);
      if (curationStatus && curationStatus !== "candidate")
        metadata.source_curation_status = curationStatus;
      const curationReason = asString3(row.source_curation_reason);
      if (curationReason)
        metadata.source_curation_reason = curationReason;
      const trustScore = clamp012(asNumber(row.source_trust_score, Number.NaN));
      if (Number.isFinite(asNumber(row.source_trust_score, Number.NaN)))
        metadata.source_trust_score = trustScore;
      return {
        id: Math.max(0, Math.floor(asNumber(row.id, 0))),
        fingerprint: asString3(row.fingerprint),
        sourceType: asString3(row.source_type) || "external_doc",
        sourceLabel: asString3(row.source_label) || null,
        sourceUrl: asString3(row.source_url) || null,
        sourceRefs: normalizeTextList(parseJsonArray2(row.source_refs_json), 32, 1000),
        algorithm: asString3(row.algorithm),
        whenToUse: asString3(row.when_to_use),
        summary: asString3(row.summary),
        risks: normalizeTextList(parseJsonArray2(row.risks_json), 20, 320),
        validationIdeas: normalizeTextList(parseJsonArray2(row.validation_json), 20, 320),
        tags,
        qualityScore: clamp012(asNumber(row.quality_score, 0.5)),
        freshnessScore: clamp012(asNumber(row.source_freshness_score, asNumber(row.freshness_score, 0.5))),
        seenCount: Math.max(0, Math.floor(asNumber(row.seen_count, 0))),
        firstSeenAt: asString3(row.first_seen_at),
        lastSeenAt: asString3(row.last_seen_at),
        updatedAt: asString3(row.updated_at),
        metadata
      };
    });
    return tag ? mapped.filter((row) => row.tags.includes(tag)).slice(0, limit) : mapped;
  }
  listInsights(params) {
    const now = asIsoNow();
    this.maybeRunInspirationMaintenance(now);
    this.maybeSweepStaleObjectives(now);
    const latestEvaluatorScorecard = this.maybeRunEvaluator(now);
    const opsSummary = this.getOpsSummary();
    const limit = Math.max(1, Math.min(200, Math.floor(asNumber(params?.limit, 20))));
    const feedbackLimit = Math.max(1, Math.min(200, Math.floor(asNumber(params?.feedbackLimit, 30))));
    const patternKey = asString3(params?.patternKey);
    const objectiveId = asString3(params?.objectiveId);
    const patternStatsRows = patternKey ? this.db.prepare(`SELECT pattern_key, ema_success, ema_user_accept, ema_latency, ema_regret, fail_streak, sample_count, cooldown_until, updated_at
             FROM autonomy_pattern_stats
             WHERE pattern_key = ?
             ORDER BY updated_at DESC
             LIMIT ?`).all(patternKey, limit) : this.db.prepare(`SELECT pattern_key, ema_success, ema_user_accept, ema_latency, ema_regret, fail_streak, sample_count, cooldown_until, updated_at
             FROM autonomy_pattern_stats
             ORDER BY updated_at DESC
             LIMIT ?`).all(limit);
    const prFeedbackWhere = [];
    const prFeedbackArgs = [];
    if (patternKey) {
      prFeedbackWhere.push("pattern_key = ?");
      prFeedbackArgs.push(patternKey);
    }
    if (objectiveId) {
      prFeedbackWhere.push("objective_id = ?");
      prFeedbackArgs.push(objectiveId);
    }
    const prFeedbackRows = this.db.prepare(`SELECT id, created_at, source, pattern_key, objective_id, request_id, job_id, pr_number, pr_url,
                verdict, review_score, review_threshold, summary, comment_count, comments_json
         FROM autonomy_pr_feedback
         ${prFeedbackWhere.length > 0 ? `WHERE ${prFeedbackWhere.join(" AND ")}` : ""}
         ORDER BY created_at DESC
         LIMIT ?`).all(...prFeedbackArgs, feedbackLimit);
    const sourceStatsRows = this.db.prepare(`SELECT source_key, source_type, source_label, source_url, source_fingerprint, source_algorithm,
                curation_status, curation_reason, trust_score, freshness_score, sample_count,
                ema_success, ema_user_accept, ema_latency, ema_regret, last_reinforced_at, updated_at
         FROM autonomy_engine_source_stats
         ORDER BY
           CASE curation_status
             WHEN 'trusted' THEN 0
             WHEN 'candidate' THEN 1
             WHEN 'watchlist' THEN 2
             WHEN 'archived' THEN 3
             ELSE 4
           END ASC,
           trust_score DESC,
           freshness_score DESC,
           updated_at DESC
         LIMIT ?`).all(limit);
    const trustedRows = this.db.prepare(`SELECT src.source_key, src.source_type, src.source_label, src.source_url, src.source_fingerprint,
                src.source_algorithm, src.trust_score, src.freshness_score, src.sample_count, src.curation_reason,
                pat.summary
         FROM autonomy_engine_source_stats src
         LEFT JOIN autonomy_inspiration_patterns pat
           ON pat.fingerprint = src.source_fingerprint
         WHERE src.curation_status = 'trusted'
         ORDER BY src.trust_score DESC, src.freshness_score DESC, src.sample_count DESC, src.updated_at DESC
         LIMIT ?`).all(limit);
    const archivedRows = this.db.prepare(`SELECT src.source_key, src.source_type, src.source_label, src.source_url, src.source_fingerprint,
                src.source_algorithm, src.trust_score, src.freshness_score, src.sample_count, src.curation_reason,
                pat.summary
         FROM autonomy_engine_source_stats src
         LEFT JOIN autonomy_inspiration_patterns pat
           ON pat.fingerprint = src.source_fingerprint
         WHERE src.curation_status = 'archived'
         ORDER BY src.updated_at DESC, src.sample_count DESC
         LIMIT ?`).all(limit);
    return {
      patternStats: patternStatsRows.map((row) => ({
        patternKey: asString3(row.pattern_key),
        emaSuccess: clamp012(asNumber(row.ema_success, 0)),
        emaUserAccept: clamp012(asNumber(row.ema_user_accept, 0)),
        emaLatency: clamp012(asNumber(row.ema_latency, 0)),
        emaRegret: clamp012(asNumber(row.ema_regret, 0)),
        failStreak: Math.max(0, Math.floor(asNumber(row.fail_streak, 0))),
        sampleCount: Math.max(0, Math.floor(asNumber(row.sample_count, 0))),
        cooldownUntil: asString3(row.cooldown_until) || null,
        updatedAt: asString3(row.updated_at)
      })),
      recentPrFeedback: prFeedbackRows.map((row) => {
        const comments = parseJsonArray2(row.comments_json).map((entry) => {
          const parsed = asObject2(entry);
          const body = asString3(parsed.body);
          if (!body)
            return null;
          return {
            body,
            user_login: asString3(parsed.user_login ?? parsed.userLogin ?? parsed.author),
            created_at: asString3(parsed.created_at ?? parsed.createdAt),
            html_url: asString3(parsed.html_url ?? parsed.htmlUrl)
          };
        }).filter((entry) => Boolean(entry));
        return {
          id: Math.max(0, Math.floor(asNumber(row.id, 0))),
          createdAt: asString3(row.created_at),
          source: asString3(row.source) || "review_agent",
          patternKey: asString3(row.pattern_key),
          objectiveId: asString3(row.objective_id) || null,
          requestId: asString3(row.request_id) || null,
          jobId: asString3(row.job_id) || null,
          prNumber: Number.isFinite(asNumber(row.pr_number, Number.NaN)) ? Math.max(0, Math.floor(asNumber(row.pr_number, 0))) : null,
          prUrl: asString3(row.pr_url) || null,
          verdict: asString3(row.verdict),
          reviewScore: Number.isFinite(asNumber(row.review_score, Number.NaN)) ? asNumber(row.review_score, 0) : null,
          reviewThreshold: Number.isFinite(asNumber(row.review_threshold, Number.NaN)) ? asNumber(row.review_threshold, 0) : null,
          summary: asString3(row.summary) || null,
          commentCount: Math.max(0, Math.floor(asNumber(row.comment_count, comments.length))),
          comments
        };
      }),
      engineSourceStats: sourceStatsRows.map((row) => ({
        sourceKey: asString3(row.source_key),
        sourceType: asString3(row.source_type) || "unknown",
        sourceLabel: asString3(row.source_label) || null,
        sourceUrl: asString3(row.source_url) || null,
        sourceFingerprint: asString3(row.source_fingerprint) || null,
        sourceAlgorithm: asString3(row.source_algorithm) || "engine_building_block",
        curationStatus: normalizeEngineSourceCurationStatus(row.curation_status),
        curationReason: asString3(row.curation_reason) || null,
        trustScore: clamp012(asNumber(row.trust_score, 0)),
        freshnessScore: clamp012(asNumber(row.freshness_score, 0.5)),
        sampleCount: Math.max(0, Math.floor(asNumber(row.sample_count, 0))),
        emaSuccess: clamp012(asNumber(row.ema_success, 0)),
        emaUserAccept: clamp012(asNumber(row.ema_user_accept, 0)),
        emaLatency: clamp012(asNumber(row.ema_latency, 0)),
        emaRegret: clamp012(asNumber(row.ema_regret, 0)),
        lastReinforcedAt: asString3(row.last_reinforced_at) || null,
        updatedAt: asString3(row.updated_at)
      })),
      trustedInspirationShortlist: trustedRows.map((row) => ({
        sourceKey: asString3(row.source_key),
        sourceType: asString3(row.source_type) || "unknown",
        sourceLabel: asString3(row.source_label) || null,
        sourceUrl: asString3(row.source_url) || null,
        sourceFingerprint: asString3(row.source_fingerprint) || null,
        algorithm: asString3(row.source_algorithm) || "engine_building_block",
        summary: asString3(row.summary) || null,
        trustScore: clamp012(asNumber(row.trust_score, 0)),
        freshnessScore: clamp012(asNumber(row.freshness_score, 0.5)),
        sampleCount: Math.max(0, Math.floor(asNumber(row.sample_count, 0))),
        curationReason: asString3(row.curation_reason) || null
      })),
      archivedInspirationSources: archivedRows.map((row) => ({
        sourceKey: asString3(row.source_key),
        sourceType: asString3(row.source_type) || "unknown",
        sourceLabel: asString3(row.source_label) || null,
        sourceUrl: asString3(row.source_url) || null,
        sourceFingerprint: asString3(row.source_fingerprint) || null,
        algorithm: asString3(row.source_algorithm) || "engine_building_block",
        summary: asString3(row.summary) || null,
        trustScore: clamp012(asNumber(row.trust_score, 0)),
        freshnessScore: clamp012(asNumber(row.freshness_score, 0.5)),
        sampleCount: Math.max(0, Math.floor(asNumber(row.sample_count, 0))),
        curationReason: asString3(row.curation_reason) || null
      })),
      latestEvaluatorScorecard,
      opsSummary
    };
  }
  listQuestions(params) {
    const limit = Math.max(1, Math.min(500, Math.floor(asNumber(params?.limit, 100))));
    let rows = [];
    if (params?.sessionId && params?.status) {
      rows = this.db.prepare(`SELECT *
           FROM questions_queue
           WHERE session_id = ? AND status = ?
           ORDER BY created_at ASC
           LIMIT ?`).all(params.sessionId, params.status, limit);
    } else if (params?.sessionId) {
      rows = this.db.prepare(`SELECT *
           FROM questions_queue
           WHERE session_id = ?
           ORDER BY created_at ASC
           LIMIT ?`).all(params.sessionId, limit);
    } else if (params?.status) {
      rows = this.db.prepare(`SELECT *
           FROM questions_queue
           WHERE status = ?
           ORDER BY created_at ASC
           LIMIT ?`).all(params.status, limit);
    } else {
      rows = this.db.prepare(`SELECT *
           FROM questions_queue
           ORDER BY created_at ASC
           LIMIT ?`).all(limit);
    }
    const nowMs = Date.now();
    return rows.map((row) => ({
      ...row,
      expected_answer_schema: parseJsonObject(row.expected_answer_schema_json),
      context: parseJsonObject(row.context_json),
      answer: row.answer_json ? JSON.parse(row.answer_json) : null,
      is_expired: (() => {
        const expiresAtMs = Date.parse(asString3(row.expires_at));
        return Number.isFinite(expiresAtMs) ? expiresAtMs <= nowMs : false;
      })(),
      expires_in_ms: (() => {
        const expiresAtMs = Date.parse(asString3(row.expires_at));
        if (!Number.isFinite(expiresAtMs))
          return null;
        return Math.max(0, Math.floor(expiresAtMs - nowMs));
      })()
    }));
  }
  answerQuestion(questionId, answer) {
    const row = this.db.prepare(`SELECT id, objective_id, question_type, expected_answer_schema_json, status, expires_at
         FROM questions_queue
         WHERE id = ?`).get(questionId);
    if (!row)
      return { ok: false, reason: "Question not found" };
    const now = asIsoNow();
    if (row.status !== "open" && row.status !== "invalid") {
      return { ok: false, reason: `Question is not answerable in status "${row.status}"` };
    }
    const expiresAtMs = Date.parse(asString3(row.expires_at));
    const nowMs = Date.parse(now);
    if (Number.isFinite(expiresAtMs) && Number.isFinite(nowMs) && nowMs > expiresAtMs) {
      this.db.prepare(`UPDATE questions_queue
           SET status = 'closed',
               answer_validation_status = 'expired',
               validation_error = ?,
               closed_reason = 'expired'
           WHERE id = ?`).run("Question expired before answer was provided", questionId);
      this.db.prepare(`UPDATE autonomy_objectives SET status = 'expired', updated_at = ? WHERE id = ?`).run(now, row.objective_id);
      return { ok: false, reason: "Question has expired", objectiveId: row.objective_id };
    }
    const validation = validateAnswerAgainstSchema(row.question_type, parseJsonObject(row.expected_answer_schema_json), answer);
    if (!validation.valid) {
      this.db.prepare(`UPDATE questions_queue
           SET status = 'invalid',
               answer_json = ?,
               answer_validation_status = 'invalid',
               validation_error = ?,
               answered_at = ?
           WHERE id = ?`).run(JSON.stringify(answer), validation.error ?? "Invalid answer", now, questionId);
      this.db.prepare(`UPDATE autonomy_objectives SET status = 'needs_clarification', updated_at = ? WHERE id = ?`).run(now, row.objective_id);
      return {
        ok: true,
        status: "invalid",
        reason: validation.error,
        objectiveId: row.objective_id
      };
    }
    this.db.prepare(`UPDATE questions_queue
         SET status = 'answered',
             answer_json = ?,
             answer_validation_status = 'valid',
             validation_error = NULL,
             answered_at = ?
         WHERE id = ?`).run(JSON.stringify(validation.normalized), now, questionId);
    this.db.prepare(`UPDATE autonomy_objectives SET status = 'gated', updated_at = ? WHERE id = ?`).run(now, row.objective_id);
    const objective = this.db.prepare(`SELECT id, run_id, snapshot_id, session_id, pattern_key, component_area, instruction, scope_json
         FROM autonomy_objectives
         WHERE id = ?
         LIMIT 1`).get(row.objective_id);
    const scope = parseJsonObject(objective?.scope_json ?? null);
    const targetPaths = asStringArray3(scope.targetPaths ?? scope.target_paths).slice(0, 64);
    const writeGlobs = asStringArray3(scope.writeGlobs ?? scope.write_globs).slice(0, 64);
    const sessionId = asString3(objective?.session_id);
    const runId = asString3(objective?.run_id);
    const snapshotId = asString3(objective?.snapshot_id);
    const patternKey = asString3(objective?.pattern_key);
    const componentArea = asString3(objective?.component_area);
    const objectiveInstruction = asString3(objective?.instruction);
    const answerText = formatAnswerForAutonomyInstruction(validation.normalized);
    const instruction = objectiveInstruction && answerText ? `${objectiveInstruction}

User clarification:
${answerText}

Apply this clarification while keeping changes scoped to the existing objective boundaries.` : objectiveInstruction || answerText;
    const resumeEligible = Boolean(objective?.id) && Boolean(sessionId) && Boolean(runId) && Boolean(snapshotId) && Boolean(patternKey) && Boolean(componentArea) && targetPaths.length > 0 && writeGlobs.length > 0 && Boolean(instruction);
    return {
      ok: true,
      status: "valid",
      objectiveId: row.objective_id,
      ...sessionId ? { sessionId } : {},
      ...resumeEligible ? {
        resume: {
          objectiveId: row.objective_id,
          sessionId,
          runId,
          snapshotId,
          patternKey,
          componentArea,
          targetPaths,
          writeGlobs,
          instruction,
          idempotencyKey: `autonomy_resume:${questionId}`
        }
      } : {}
    };
  }
  actOnQuestion(questionId, actionRaw, noteRaw) {
    const actionText = asString3(actionRaw).toLowerCase();
    const action = actionText === "skip" || actionText === "close" || actionText === "escalate" ? actionText : null;
    if (!action)
      return { ok: false, reason: `unsupported action "${actionText}"` };
    const row = this.db.prepare(`SELECT id, objective_id, session_id, status
         FROM questions_queue
         WHERE id = ?
         LIMIT 1`).get(questionId);
    if (!row)
      return { ok: false, reason: "Question not found" };
    const status = asString3(row.status).toLowerCase();
    if (status !== "open" && status !== "invalid") {
      return { ok: false, reason: `Question cannot be actioned in status "${status}"` };
    }
    const now = asIsoNow();
    const note = truncateText(asString3(noteRaw), 400);
    const closeReason = action === "escalate" ? "escalated_to_human" : action === "skip" ? "skipped" : "closed";
    const validationError = action === "escalate" ? note || "Escalated to human review." : action === "skip" ? note || "Skipped by user." : note || "Closed by user.";
    this.db.prepare(`UPDATE questions_queue
         SET status = 'closed',
             answer_validation_status = ?,
             validation_error = ?,
             closed_reason = ?,
             answered_at = COALESCE(answered_at, ?)
         WHERE id = ?`).run(action, validationError, closeReason, now, questionId);
    const nextObjectiveStatus = action === "escalate" ? "escalated" : action === "skip" ? "skipped" : "cancelled";
    this.db.prepare(`UPDATE autonomy_objectives
         SET status = ?,
             block_reason = ?,
             updated_at = ?
         WHERE id = ?`).run(nextObjectiveStatus, closeReason, now, row.objective_id);
    if (action === "escalate") {
      this.recordOpsAlert({
        alertType: "question_escalated",
        severity: "warning",
        message: `Autonomy question escalated by user: ${questionId}`,
        details: {
          questionId,
          objectiveId: row.objective_id,
          note: note || null
        },
        nowIso: now
      });
    }
    return {
      ok: true,
      action,
      objectiveId: row.objective_id,
      sessionId: asString3(row.session_id) || undefined
    };
  }
  findObjectiveByRequestId(requestId) {
    if (!requestId)
      return null;
    const row = this.db.prepare(`SELECT id AS objectiveId, pattern_key AS patternKey, session_id AS sessionId, run_id AS runId, snapshot_id AS snapshotId
         FROM autonomy_objectives
         WHERE request_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`).get(requestId);
    return row ?? null;
  }
  findObjectiveByJobId(jobId) {
    if (!jobId)
      return null;
    const row = this.db.prepare(`SELECT id AS objectiveId, pattern_key AS patternKey, session_id AS sessionId, run_id AS runId, snapshot_id AS snapshotId
         FROM autonomy_objectives
         WHERE job_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`).get(jobId);
    return row ?? null;
  }
  resolveJobOutcomeContext(jobId, params) {
    const matched = this.findObjectiveByJobId(jobId);
    if (matched) {
      return {
        objectiveId: matched.objectiveId,
        requestId: asString3(params.requestId) || null,
        patternKey: matched.patternKey
      };
    }
    const autonomy = asObject2(params.autonomy);
    const origin = asString3(params.origin ?? autonomy.origin).toLowerCase();
    const patternKey = asString3(autonomy.patternKey ?? autonomy.pattern_key);
    if (origin !== "autonomy" || !patternKey)
      return null;
    return {
      objectiveId: asString3(autonomy.objectiveId ?? autonomy.objective_id) || null,
      requestId: asString3(params.requestId ?? params.request_id) || null,
      patternKey
    };
  }
  linkJobToObjectiveByRequest(requestId, jobId) {
    if (!requestId || !jobId)
      return;
    this.db.prepare(`UPDATE autonomy_objectives
         SET job_id = ?, updated_at = ?
         WHERE request_id = ? AND (job_id IS NULL OR job_id = '')`).run(jobId, asIsoNow(), requestId);
  }
  markObjectiveDispatched(objectiveId, requestId) {
    if (!objectiveId || !requestId)
      return;
    const now = asIsoNow();
    this.db.prepare(`UPDATE autonomy_objectives
         SET status = 'dispatched',
             request_id = ?,
             block_reason = NULL,
             dispatched_at = COALESCE(dispatched_at, ?),
             updated_at = ?
         WHERE id = ?`).run(requestId, now, now, objectiveId);
  }
  markObjectiveRunningByJobId(jobId) {
    if (!jobId)
      return;
    this.db.prepare(`UPDATE autonomy_objectives
         SET status = 'running',
             block_reason = NULL,
             updated_at = ?
         WHERE job_id = ?
           AND status IN ('dispatched','gated','blocked','needs_clarification')`).run(asIsoNow(), jobId);
  }
  reconcileJobLinkedOutcomeLifecycle() {
    const affectedPatterns = this.db.prepare(`SELECT DISTINCT ao.pattern_key AS patternKey
         FROM autonomy_outcomes ao
         JOIN jobs j ON j.id = ao.job_id
         WHERE ao.success = 1
           AND j.status IN ('finalizing', 'failed', 'abandoned', 'publish_blocked')`).all();
    if (affectedPatterns.length === 0) {
      return {
        correctedFailures: 0,
        removedPrematureSuccesses: 0,
        correctedObjectives: 0
      };
    }
    const now = asIsoNow();
    let correctedFailures = 0;
    let removedPrematureSuccesses = 0;
    let correctedObjectives = 0;
    const tx = this.db.transaction(() => {
      const removed = this.db.prepare(`DELETE FROM autonomy_outcomes
           WHERE success = 1
             AND job_id IN (SELECT id FROM jobs WHERE status = 'finalizing')`).run();
      removedPrematureSuccesses = Number(removed.changes ?? 0);
      const corrected = this.db.prepare(`UPDATE autonomy_outcomes
           SET success = 0,
               user_action = 'failed',
               reopened_within_24h = 0,
               regression_flag = 1
           WHERE success = 1
             AND job_id IN (
               SELECT id FROM jobs
               WHERE status IN ('failed', 'abandoned', 'publish_blocked')
             )`).run();
      correctedFailures = Number(corrected.changes ?? 0);
      const runningObjectives = this.db.prepare(`UPDATE autonomy_objectives
           SET status = 'running', updated_at = ?
           WHERE job_id IN (SELECT id FROM jobs WHERE status = 'finalizing')
             AND status IN ('completed', 'failed')`).run(now);
      const failedObjectives = this.db.prepare(`UPDATE autonomy_objectives
           SET status = 'failed', updated_at = ?
           WHERE job_id IN (
             SELECT id FROM jobs
             WHERE status IN ('failed', 'abandoned', 'publish_blocked')
           )
             AND status <> 'failed'`).run(now);
      correctedObjectives = Number(runningObjectives.changes ?? 0) + Number(failedObjectives.changes ?? 0);
      for (const affected of affectedPatterns) {
        const patternKey = asString3(affected.patternKey);
        if (!patternKey)
          continue;
        const rows = this.db.prepare(`SELECT success, latency_ms AS latencyMs, user_action AS userAction,
                    reopened_within_24h AS reopenedWithin24h
             FROM autonomy_outcomes
             WHERE pattern_key = ?
             ORDER BY id ASC`).all(patternKey);
        if (rows.length === 0) {
          this.db.prepare(`DELETE FROM autonomy_pattern_stats WHERE pattern_key = ?`).run(patternKey);
          continue;
        }
        let emaSuccess = 0;
        let emaUserAccept = 0;
        let emaLatency = 0;
        let emaRegret = 0;
        let failStreak = 0;
        const ema = (previous, current) => this.alpha * current + (1 - this.alpha) * previous;
        for (const row of rows) {
          const success = Number(row.success) === 1;
          const userAction = asString3(row.userAction).toLowerCase();
          emaSuccess = ema(emaSuccess, success ? 1 : 0);
          emaUserAccept = ema(emaUserAccept, ["accepted", "manual_fix", "override_dispatch", "applied"].includes(userAction) ? 1 : 0);
          if (typeof row.latencyMs === "number" && Number.isFinite(row.latencyMs)) {
            emaLatency = ema(emaLatency, clamp012(1 - row.latencyMs / 600000));
          }
          emaRegret = ema(emaRegret, Number(row.reopenedWithin24h) === 1 || ["rejected", "cancelled"].includes(userAction) ? 1 : 0);
          failStreak = success ? 0 : failStreak + 1;
        }
        const cooldownThreshold = Math.max(1, Math.floor(this.config.remotebuddy.autonomy.cooldownFailStreakThreshold));
        const cooldownUntil = failStreak >= cooldownThreshold ? new Date(Date.parse(now) + this.config.remotebuddy.autonomy.cooldownMs).toISOString() : null;
        this.db.prepare(`INSERT INTO autonomy_pattern_stats (
               pattern_key, ema_success, ema_user_accept, ema_latency, ema_regret,
               fail_streak, cooldown_until, sample_count, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(pattern_key) DO UPDATE SET
               ema_success = excluded.ema_success,
               ema_user_accept = excluded.ema_user_accept,
               ema_latency = excluded.ema_latency,
               ema_regret = excluded.ema_regret,
               fail_streak = excluded.fail_streak,
               cooldown_until = excluded.cooldown_until,
               sample_count = excluded.sample_count,
               updated_at = excluded.updated_at`).run(patternKey, emaSuccess, emaUserAccept, emaLatency, emaRegret, failStreak, cooldownUntil, rows.length, now);
      }
    });
    tx();
    return { correctedFailures, removedPrematureSuccesses, correctedObjectives };
  }
  close() {
    this.db.close();
  }
}

// apps/server/src/client_presence.ts
var DISCONNECTED_RETENTION_MS = 10 * 60 * 1000;
var CONNECTED_RETENTION_MS = 90 * 1000;
function compactText(value, maxChars) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text)
    return "";
  if (text.length <= maxChars)
    return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}
function normalizeKind(value) {
  const text = compactText(value, 48).toLowerCase();
  if (!text)
    return "";
  return text.replace(/[^a-z0-9._-]+/g, "_");
}
function defaultLabelForKind(kind) {
  switch (kind) {
    case "cli":
      return "CLI";
    case "cli_monitor":
      return "CLI Monitor";
    case "vscode":
      return "VS Code";
    case "web":
      return "Web Client";
    default:
      return kind || "Unknown Client";
  }
}
function readHeader(headers, name) {
  return compactText(headers.get(name), 512);
}
function readParam(url, name) {
  return compactText(url.searchParams.get(name), 512);
}
function normalizeMetadata(value, userAgent) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return null;
  const record = value;
  const clientId = compactText(record.clientId, 128);
  const kind = normalizeKind(record.kind);
  if (!clientId || !kind)
    return null;
  const label = compactText(record.label, 120) || defaultLabelForKind(kind);
  const version = compactText(record.version, 64);
  const platform = compactText(record.platform, 120);
  const repoRoot = compactText(record.repoRoot, 400);
  return {
    clientId,
    kind,
    label,
    ...version ? { version } : {},
    ...platform ? { platform } : {},
    ...repoRoot ? { repoRoot } : {},
    ...userAgent ? { userAgent } : {}
  };
}
function readClientPresenceFromSessionBody(body, headers) {
  const userAgent = readHeader(headers, "user-agent");
  if (!body || typeof body !== "object" || Array.isArray(body))
    return null;
  return normalizeMetadata(body.client, userAgent);
}
function readClientPresenceFromTransportRequest(url, headers) {
  const userAgent = readHeader(headers, "user-agent");
  return normalizeMetadata({
    clientId: readParam(url, "clientId") || readHeader(headers, "x-pushpals-client-id"),
    kind: readParam(url, "clientKind") || readHeader(headers, "x-pushpals-client-kind"),
    label: readParam(url, "clientLabel") || readHeader(headers, "x-pushpals-client-label"),
    version: readParam(url, "clientVersion") || readHeader(headers, "x-pushpals-client-version"),
    platform: readParam(url, "clientPlatform") || readHeader(headers, "x-pushpals-client-platform"),
    repoRoot: readParam(url, "clientRepoRoot") || readHeader(headers, "x-pushpals-client-repo-root")
  }, userAgent);
}

class ClientPresenceRegistry {
  records = new Map;
  retentionMs;
  connectedRetentionMs;
  now;
  constructor(options = {}) {
    this.retentionMs = Math.max(1, options.retentionMs ?? DISCONNECTED_RETENTION_MS);
    this.connectedRetentionMs = Math.max(1, options.connectedRetentionMs ?? CONNECTED_RETENTION_MS);
    this.now = options.now ?? Date.now;
  }
  announce(sessionId, metadata, source) {
    const now = this.now();
    this.pruneExpired(now);
    const record = this.upsertRecord(sessionId, metadata, now);
    record.lastSeenAtMs = now;
    if (source !== "session") {
      this.connectionSet(record, source).add(`${source}-announced`);
    }
    console.log(`[Client] announced kind=${record.kind} clientId=${record.clientId} session=${sessionId} source=${source}`);
  }
  connect(sessionId, metadata, transport, connectionId) {
    const now = this.now();
    this.pruneExpired(now);
    const record = this.upsertRecord(sessionId, metadata, now);
    const connections = this.connectionSet(record, transport);
    const alreadyConnected = connections.size > 0;
    connections.add(connectionId);
    record.lastSeenAtMs = now;
    if (!alreadyConnected) {
      console.log(`[Client] connected kind=${record.kind} clientId=${record.clientId} session=${sessionId} transport=${transport}`);
    }
  }
  disconnect(clientId, transport, connectionId) {
    this.pruneExpired();
    const record = this.records.get(clientId);
    if (!record)
      return;
    const connections = record.transportConnections.get(transport);
    if (!connections)
      return;
    if (!connections.delete(connectionId))
      return;
    if (connections.size === 0) {
      record.transportConnections.delete(transport);
    }
    record.lastSeenAtMs = this.now();
    console.log(`[Client] disconnected kind=${record.kind} clientId=${record.clientId} session=${record.sessionId} transport=${transport}`);
  }
  touch(clientId, transport, connectionId) {
    const record = this.records.get(clientId);
    if (!record)
      return;
    const connections = record.transportConnections.get(transport);
    if (!connections || connections.size === 0)
      return;
    if (connectionId && !connections.has(connectionId))
      return;
    record.lastSeenAtMs = this.now();
  }
  snapshot() {
    this.pruneExpired();
    const rows = [...this.records.values()].map((record) => ({
      clientId: record.clientId,
      kind: record.kind,
      ...record.label ? { label: record.label } : {},
      ...record.version ? { version: record.version } : {},
      ...record.platform ? { platform: record.platform } : {},
      ...record.repoRoot ? { repoRoot: record.repoRoot } : {},
      ...record.userAgent ? { userAgent: record.userAgent } : {},
      sessionId: record.sessionId,
      status: this.connectedTransportKeys(record).length > 0 ? "connected" : "announced",
      connectedTransports: this.connectedTransportKeys(record),
      announcedAt: new Date(record.announcedAtMs).toISOString(),
      lastSeenAt: new Date(record.lastSeenAtMs).toISOString()
    })).sort((a, b) => {
      if (a.status !== b.status)
        return a.status === "connected" ? -1 : 1;
      return b.lastSeenAt.localeCompare(a.lastSeenAt);
    });
    const byKind = {};
    for (const row of rows) {
      byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
    }
    return {
      total: rows.length,
      connected: rows.filter((row) => row.status === "connected").length,
      byKind,
      items: rows
    };
  }
  upsertRecord(sessionId, metadata, now) {
    const existing = this.records.get(metadata.clientId);
    if (existing) {
      existing.sessionId = sessionId;
      existing.kind = metadata.kind;
      existing.label = metadata.label;
      existing.version = metadata.version;
      existing.platform = metadata.platform;
      existing.repoRoot = metadata.repoRoot;
      existing.userAgent = metadata.userAgent;
      existing.lastSeenAtMs = now;
      return existing;
    }
    const created = {
      ...metadata,
      sessionId,
      announcedAtMs: now,
      lastSeenAtMs: now,
      transportConnections: new Map
    };
    this.records.set(metadata.clientId, created);
    return created;
  }
  connectionSet(record, transport) {
    let connections = record.transportConnections.get(transport);
    if (!connections) {
      connections = new Set;
      record.transportConnections.set(transport, connections);
    }
    return connections;
  }
  connectedTransportKeys(record) {
    return [...record.transportConnections.entries()].filter(([, connections]) => connections.size > 0).map(([transport]) => transport).sort();
  }
  pruneExpired(now = this.now()) {
    let removed = 0;
    for (const [clientId, record] of this.records.entries()) {
      const connected = this.connectedTransportKeys(record).length > 0;
      const maxAgeMs = connected ? this.connectedRetentionMs : this.retentionMs;
      if (now - record.lastSeenAtMs <= maxAgeMs)
        continue;
      this.records.delete(clientId);
      removed++;
    }
    return removed;
  }
}

// apps/server/src/server_main.ts
import { randomUUID as randomUUID6 } from "crypto";
import { mkdirSync as mkdirSync2 } from "fs";

// apps/server/src/runtime_config.ts
import { existsSync as existsSync2, mkdirSync, readFileSync as readFileSync3, writeFileSync } from "fs";
import { dirname as dirname2, join as join3, relative } from "path";
function getRuntimeConfigFiles(config) {
  return {
    envPath: join3(config.projectRoot, ".env"),
    localTomlPath: join3(config.configDir, "local.toml"),
    projectRoot: config.projectRoot
  };
}
function applyRuntimeConfigMutations(files, inputMutations) {
  const warnings = [];
  const applied = [];
  const touchedFiles = new Set;
  const envChanges = [];
  const tomlChanges = [];
  for (const mutation of inputMutations) {
    const scope = String(mutation.scope ?? "").trim().toLowerCase();
    if (scope !== "env" && scope !== "toml") {
      warnings.push(`Skipped unknown scope "${mutation.scope}"`);
      continue;
    }
    const rawKey = String(mutation.key ?? "").trim();
    if (!rawKey) {
      warnings.push(`Skipped empty key in ${scope} mutation`);
      continue;
    }
    if (scope === "env") {
      const envKey = normalizeEnvKey(rawKey);
      if (!envKey) {
        warnings.push(`Skipped invalid env key "${rawKey}"`);
        continue;
      }
      envChanges.push({ key: envKey, value: mutation.value });
      applied.push({ scope: "env", key: envKey, value: mutation.value });
      continue;
    }
    const path = normalizeTomlPath(rawKey);
    if (path.length === 0) {
      warnings.push(`Skipped invalid TOML key "${rawKey}"`);
      continue;
    }
    tomlChanges.push({ path, value: mutation.value, rawKey });
    applied.push({ scope: "toml", key: path.join("."), value: mutation.value });
  }
  if (envChanges.length > 0) {
    patchEnvFile(files.envPath, envChanges);
    for (const change of envChanges) {
      process.env[change.key] = String(change.value ?? "");
    }
    touchedFiles.add(files.envPath);
  }
  if (tomlChanges.length > 0) {
    patchTomlFile(files.localTomlPath, tomlChanges.map((entry) => ({ path: entry.path, value: entry.value })));
    touchedFiles.add(files.localTomlPath);
  }
  return {
    applied,
    warnings,
    touchedFiles: Array.from(touchedFiles)
  };
}
function describeRuntimeConfigFiles(files) {
  return {
    envPath: normalizePathForDisplay(files.projectRoot, files.envPath),
    localTomlPath: normalizePathForDisplay(files.projectRoot, files.localTomlPath)
  };
}
function normalizePathForDisplay(projectRoot, absolutePath) {
  const rel = relative(projectRoot, absolutePath);
  if (!rel || rel.startsWith(".."))
    return absolutePath;
  return rel.replace(/\\/g, "/");
}
function normalizeEnvKey(rawKey) {
  const key = rawKey.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    return "";
  return key;
}
function normalizeTomlPath(rawKey) {
  const pieces = rawKey.split(".").map((part) => normalizeTomlKey(part)).filter(Boolean);
  return pieces;
}
function normalizeTomlKey(rawKey) {
  const trimmed = String(rawKey ?? "").trim();
  if (!trimmed)
    return "";
  if (/^[a-z0-9_]+$/.test(trimmed))
    return trimmed;
  return trimmed.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
}
function patchEnvFile(path, changes) {
  ensureParentDir(path);
  const original = existsSync2(path) ? readFileSync3(path, "utf8") : "";
  const eol = detectEol(original);
  const lines = original.length > 0 ? original.split(/\r?\n/) : [];
  const indexByKey = new Map;
  for (let i = 0;i < lines.length; i += 1) {
    const parsed = parseEnvAssignment(lines[i] ?? "");
    if (parsed)
      indexByKey.set(parsed.key, i);
  }
  for (const change of changes) {
    const nextLine = `${change.key}=${serializeEnvValue(change.value)}`;
    const index = indexByKey.get(change.key);
    if (index === undefined) {
      lines.push(nextLine);
      indexByKey.set(change.key, lines.length - 1);
    } else {
      lines[index] = nextLine;
    }
  }
  const nextText = lines.join(eol).replace(/\s+$/g, "");
  writeFileSync(path, `${nextText}${eol}`, "utf8");
}
function parseEnvAssignment(line) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!match)
    return null;
  return { key: match[1], value: match[2] ?? "" };
}
function serializeEnvValue(value) {
  const text = String(value ?? "");
  if (text.length === 0)
    return "";
  if (/^[^\s"'`#=\\]+$/.test(text))
    return text;
  return JSON.stringify(text);
}
function patchTomlFile(path, changes) {
  ensureParentDir(path);
  const original = existsSync2(path) ? readFileSync3(path, "utf8") : "";
  const eol = detectEol(original);
  const lines = original.length > 0 ? original.split(/\r?\n/) : [];
  for (const change of changes) {
    setTomlValue(lines, change.path, change.value);
  }
  const nextText = lines.join(eol).replace(/\s+$/g, "");
  writeFileSync(path, `${nextText}${eol}`, "utf8");
}
function setTomlValue(lines, path, value) {
  const key = path[path.length - 1];
  if (!key)
    return;
  const sectionParts = path.slice(0, -1);
  const sectionName = sectionParts.join(".");
  const serialized = `${key} = ${serializeTomlValue(value)}`;
  if (!sectionName) {
    const sectionStart = findFirstSectionLine(lines);
    const existing = findKeyInRange(lines, key, 0, sectionStart);
    if (existing >= 0) {
      lines[existing] = serialized;
      return;
    }
    if (sectionStart >= 0) {
      lines.splice(sectionStart, 0, serialized);
    } else {
      lines.push(serialized);
    }
    return;
  }
  const range = findSectionRange(lines, sectionName);
  if (range) {
    const existing = findKeyInRange(lines, key, range.start + 1, range.end);
    if (existing >= 0) {
      lines[existing] = serialized;
      return;
    }
    lines.splice(range.end, 0, serialized);
    return;
  }
  if (lines.length > 0 && lines[lines.length - 1]?.trim() !== "") {
    lines.push("");
  }
  lines.push(`[${sectionName}]`);
  lines.push(serialized);
}
function findFirstSectionLine(lines) {
  for (let i = 0;i < lines.length; i += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i] ?? ""))
      return i;
  }
  return -1;
}
function findSectionRange(lines, sectionName) {
  let start = -1;
  let end = lines.length;
  for (let i = 0;i < lines.length; i += 1) {
    const match = lines[i]?.match(/^\s*\[([^\]]+)\]\s*$/);
    if (!match)
      continue;
    const current = String(match[1] ?? "").trim();
    if (start < 0) {
      if (current === sectionName)
        start = i;
      continue;
    }
    end = i;
    break;
  }
  if (start < 0)
    return null;
  return { start, end };
}
function findKeyInRange(lines, key, start, end) {
  for (let i = start;i < Math.min(end, lines.length); i += 1) {
    const line = lines[i] ?? "";
    if (/^\s*\[/.test(line))
      break;
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
    if (match && match[1] === key)
      return i;
  }
  return -1;
}
function serializeTomlValue(value) {
  if (typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : "0";
  if (typeof value === "boolean")
    return value ? "true" : "false";
  if (value == null)
    return JSON.stringify("");
  if (Array.isArray(value)) {
    return `[${value.map((entry) => serializeTomlValue(entry)).join(", ")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).map(([key, entry]) => `${normalizeTomlKey(key)} = ${serializeTomlValue(entry)}`).join(", ");
    return `{ ${entries} }`;
  }
  return JSON.stringify(String(value));
}
function ensureParentDir(path) {
  mkdirSync(dirname2(path), { recursive: true });
}
function detectEol(content) {
  return content.includes(`\r
`) ? `\r
` : `
`;
}

// apps/server/src/runtime_config_policy.ts
var BASE_RESTART_REQUIRED_PREFIXES = [
  "server.host",
  "server.port",
  "paths.data_dir",
  "paths.shared_db_path",
  "paths.remotebuddy_db_path",
  "source_control_manager.repo_path"
];
function normalizeRuntimeConfigKey(raw) {
  return String(raw ?? "").split(".").map((segment) => segment.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase()).filter(Boolean).join(".");
}
function normalizeRuntimeConfigEnvAlias(raw) {
  const key = String(raw ?? "").trim().toUpperCase();
  if (!key)
    return "";
  if (key === "LOCALBUDDY_ENABLED")
    return "localbuddy.enabled";
  if (key === "LOCAL_AGENT_PORT")
    return "localbuddy.port";
  if (key === "LOCALBUDDY_STATUS_HEARTBEAT_MS")
    return "localbuddy.status_heartbeat_ms";
  if (!key.startsWith("LOCALBUDDY_"))
    return "";
  const suffix = key.slice("LOCALBUDDY_".length);
  if (!suffix)
    return "";
  if (suffix.startsWith("LLM_")) {
    const llmSuffix = suffix.slice("LLM_".length).toLowerCase();
    if (!llmSuffix)
      return "";
    return `localbuddy.llm.${llmSuffix}`;
  }
  return "";
}
function deriveRuntimeConfigImpact(appliedKeys) {
  const restartRequiredKeys = [];
  const warnings = [];
  let hasLocalBuddyEnabledMutation = false;
  let hasRestartOnlyLocalBuddyMutation = false;
  for (const rawKey of appliedKeys) {
    const normalized = normalizeRuntimeConfigEnvAlias(rawKey) || normalizeRuntimeConfigKey(rawKey);
    if (!normalized)
      continue;
    const needsBaseRestart = BASE_RESTART_REQUIRED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}.`));
    const isLocalBuddyEnabled = normalized === "localbuddy.enabled";
    const isLocalBuddyRestartOnly = normalized.startsWith("localbuddy.") && !isLocalBuddyEnabled;
    if (needsBaseRestart || isLocalBuddyRestartOnly) {
      restartRequiredKeys.push(rawKey);
    }
    if (isLocalBuddyEnabled) {
      hasLocalBuddyEnabledMutation = true;
    }
    if (isLocalBuddyRestartOnly) {
      hasRestartOnlyLocalBuddyMutation = true;
    }
  }
  if (hasLocalBuddyEnabledMutation) {
    warnings.push("localbuddy.enabled applies live when the stack is managed by bun run start or the VS Code stack manager; other supervisors may require restart.");
  }
  if (hasRestartOnlyLocalBuddyMutation) {
    warnings.push("LocalBuddy config changes other than localbuddy.enabled require a LocalBuddy restart to take effect.");
  }
  return { restartRequiredKeys, warnings };
}

// apps/server/src/request_auth.ts
function resolveRequestAuthHeader(authorizationHeader) {
  const headerText = String(authorizationHeader ?? "").trim();
  return headerText || null;
}

// apps/server/src/autonomy_payload.ts
function objectRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function parseJsonRecord(value) {
  if (typeof value !== "string" || !value.trim())
    return {};
  try {
    return objectRecord(JSON.parse(value)) ?? {};
  } catch {
    return {};
  }
}
function compactText2(value, maxChars) {
  return String(value ?? "").trim().slice(0, maxChars);
}
function stringValues(...values) {
  const out = new Set;
  for (const value of values) {
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      if (typeof entry !== "string")
        continue;
      const normalized = entry.trim();
      if (normalized)
        out.add(normalized);
    }
  }
  return [...out];
}
function extractAutonomyPayloadDetails(value) {
  const params = objectRecord(value.params) ?? parseJsonRecord(value.params);
  const metadata = objectRecord(value.metadata) ?? objectRecord(value.meta) ?? parseJsonRecord(value.metadataJson);
  const metadataAutonomy = objectRecord(metadata.autonomy);
  const paramsAutonomy = objectRecord(params.autonomy);
  const planning = objectRecord(params.planning);
  const scope = objectRecord(planning?.scope);
  const patternKey = compactText2(metadataAutonomy?.patternKey ?? metadataAutonomy?.pattern_key ?? paramsAutonomy?.patternKey ?? paramsAutonomy?.pattern_key, 240) || null;
  return {
    patternKey,
    targetPaths: stringValues(metadataAutonomy?.targetPaths, metadataAutonomy?.target_paths, metadataAutonomy?.targetPath, metadataAutonomy?.target_path, paramsAutonomy?.targetPaths, paramsAutonomy?.target_paths, paramsAutonomy?.targetPath, paramsAutonomy?.target_path, params.paths, params.path, params.targetPaths, params.target_paths, params.targetPath, params.target_path, planning?.targetPaths, planning?.target_paths, planning?.targetPath, planning?.target_path, value.targetPaths, value.target_paths, value.targetPath, value.target_path),
    writeGlobs: stringValues(metadataAutonomy?.writeGlobs, metadataAutonomy?.write_globs, metadataAutonomy?.writeGlob, metadataAutonomy?.write_glob, paramsAutonomy?.writeGlobs, paramsAutonomy?.write_globs, paramsAutonomy?.writeGlob, paramsAutonomy?.write_glob, scope?.writeGlobs, scope?.write_globs, scope?.writeGlob, scope?.write_glob)
  };
}

// apps/server/src/server_main.ts
var STARTUP_CONFIG = loadPushPalsConfig();
var dataDir = STARTUP_CONFIG.paths.dataDir;
mkdirSync2(dataDir, { recursive: true });
var sharedDbPath = STARTUP_CONFIG.paths.sharedDbPath;
var sessionManager = new SessionManager(sharedDbPath);
var jobQueue = new JobQueue(sharedDbPath);
var requestQueue = new RequestQueue(sharedDbPath);
var completionQueue = new CompletionQueue(sharedDbPath);
var autonomyStore = new AutonomyStore(sharedDbPath);
var lifecycleReconciliation = autonomyStore.reconcileJobLinkedOutcomeLifecycle();
if (lifecycleReconciliation.correctedFailures > 0 || lifecycleReconciliation.removedPrematureSuccesses > 0 || lifecycleReconciliation.correctedObjectives > 0) {
  console.warn(`[Server] Reconciled legacy completion lifecycle state: ${JSON.stringify(lifecycleReconciliation)}`);
}
var clientPresence = new ClientPresenceRegistry;
var clientPresencePruneTimer = setInterval(() => {
  const removed = clientPresence.pruneExpired();
  if (removed > 0) {
    console.log(`[Client] pruned ${removed} stale presence record(s)`);
  }
}, 60000);
clientPresencePruneTimer.unref?.();
sessionManager.authToken = null;
sessionManager.setClientMessageIngress((sessionId, accepted) => {
  const budgetStatus = getSessionTokenBudgetStatus(sessionId);
  if (budgetStatus?.exceeded) {
    return {
      ok: false,
      message: sessionTokenBudgetMessage(budgetStatus)
    };
  }
  const enqueueResult = requestQueue.enqueue({
    sessionId,
    prompt: accepted.text,
    priority: "interactive"
  });
  if (!enqueueResult.ok) {
    return {
      ok: false,
      message: enqueueResult.message || "Failed to enqueue request"
    };
  }
  return {
    ok: true,
    requestId: enqueueResult.requestId,
    queuePosition: enqueueResult.queuePosition,
    etaMs: enqueueResult.etaMs
  };
});
var REPO_STATUS_CACHE_TTL_MS = 60000;
var SERVER_STARTED_AT_MS = Date.now();
var SERVER_STARTED_AT_ISO = new Date(SERVER_STARTED_AT_MS).toISOString();
var AUTONOMY_BUSY_QUEUE_MAX_REQUESTS = 5;
var AUTONOMY_MAX_OPEN_UNMERGED_WORKER_PRS = 10;
var AUTONOMY_WORKER_TTL_MS = 15000;
var AUTONOMY_WORKER_FAILURE_CIRCUIT_WINDOW_MS = 60 * 60 * 1000;
var AUTONOMY_WORKER_FAILURE_CIRCUIT_THRESHOLD = 3;
var AUTONOMY_WORKER_FAILURE_CIRCUIT_RATE = 0.5;
var AUTONOMY_WORKER_FAILURE_DEFER_MS = 30 * 60 * 1000;
var AUTONOMY_SIMILAR_FAILURE_WINDOW_MS = 6 * 60 * 60 * 1000;
var AUTONOMY_SIMILAR_FAILURE_THRESHOLD = 2;
var AUTONOMY_SIMILAR_FAILURE_DEFER_MS = 30 * 60 * 1000;
var CLIENT_TRANSPORT_HEARTBEAT_MS = 15000;
var SESSION_TOKEN_BUDGET = Math.max(0, STARTUP_CONFIG.server.sessionTokenBudget);
function getSessionTokenBudgetStatus(sessionIdRaw) {
  const sessionId = String(sessionIdRaw ?? "").trim();
  if (!sessionId || SESSION_TOKEN_BUDGET <= 0)
    return null;
  return autonomyStore.getSessionTokenBudgetStatus(sessionId, SESSION_TOKEN_BUDGET, STARTUP_CONFIG.server.sessionTokenBudgetAction);
}
function sessionTokenBudgetMessage(status) {
  return `Session token budget exceeded for ${status.sessionId}: ` + `${status.totalTokens}/${status.limit} tokens used. ` + "PushPals is pausing new work for this session.";
}
function emitSessionBudgetPauseNotice(sessionIdRaw, status) {
  const sessionId = String(sessionIdRaw ?? "").trim();
  if (!sessionId)
    return;
  const session = sessionManager.getSession(sessionId);
  if (!session)
    return;
  const message = sessionTokenBudgetMessage(status);
  session.emit({
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID6(),
    ts: new Date().toISOString(),
    sessionId,
    type: "assistant_message",
    from: "system",
    payload: { text: message }
  });
  session.emit({
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID6(),
    ts: new Date().toISOString(),
    sessionId,
    type: "status",
    from: "system",
    payload: {
      agentId: "pushpals-budget",
      state: "idle",
      detail: message
    }
  });
}
function sessionMessageResultStatus(result) {
  if (result.ok)
    return 200;
  if (result.code === "session_not_found")
    return 404;
  return 400;
}
var repoStatusCache = null;
async function resolveRemoteUrl(repoPath, remote) {
  const proc = Bun.spawn(["git", "-C", repoPath, "remote", "get-url", remote], {
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || `exit ${exitCode}`;
    console.warn(`[Server] Failed to resolve git remote URL (${remote}): ${detail}`);
    return "";
  }
  return stdout.trim();
}
async function getRepoStatusSummary(repoPath, remote) {
  const now = Date.now();
  if (repoStatusCache && repoStatusCache.value.remote === remote && now - repoStatusCache.fetchedAtMs < REPO_STATUS_CACHE_TTL_MS) {
    return repoStatusCache.value;
  }
  const remoteUrlRaw = await resolveRemoteUrl(repoPath, remote);
  const remoteUrl = remoteUrlRaw ? sanitizeGitRemoteUrl(remoteUrlRaw) : null;
  const provider = inferGitBackendFromRemote(remoteUrl ?? "");
  const browserUrl = provider === "github" ? toGitHubRepoWebUrl(remoteUrl ?? "") : null;
  const value = {
    root: repoPath,
    remote,
    remoteUrl,
    browserUrl,
    provider,
    refreshedAt: new Date().toISOString()
  };
  repoStatusCache = { value, fetchedAtMs: now };
  return value;
}
function createRequestHandler() {
  const startupConfig = loadPushPalsConfig();
  if (startupConfig.authToken) {
    console.warn("[Server] Ignoring configured auth token; PushPals runs in local-only mode.");
  }
  const port = startupConfig.server.port;
  const hostname = startupConfig.server.host;
  const isDebugHttpLogsEnabled = () => loadPushPalsConfig().server.debugHttp;
  let lastStaleRecoverySweepAt = 0;
  let isShuttingDown = false;
  return Bun.serve({
    port,
    hostname,
    idleTimeout: 180,
    async fetch(req, server) {
      const url = new URL(req.url);
      const pathname = url.pathname;
      const method = req.method;
      const originHeader = req.headers.get("origin");
      if (originHeader && !isLoopbackOrigin(originHeader)) {
        return new Response(JSON.stringify({ ok: false, message: "Forbidden origin" }), {
          status: 403,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store"
          }
        });
      }
      const corsHeaders = buildLocalCorsHeaders({
        origin: originHeader,
        allowAuthorizationHeader: true
      });
      const jsonHeaders = {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...corsHeaders
      };
      const makeJson = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: jsonHeaders });
      const parseLimit = (raw, fallback = 200) => {
        const parsed = raw ? parseInt(raw, 10) : NaN;
        if (!Number.isFinite(parsed))
          return fallback;
        return Math.max(1, Math.min(500, parsed));
      };
      const parseCursor = (raw) => {
        const parsed = raw ? parseInt(raw, 10) : NaN;
        if (!Number.isFinite(parsed) || parsed <= 0)
          return null;
        return parsed;
      };
      const parseBool = (raw, fallback = false) => {
        const text = String(raw ?? "").trim().toLowerCase();
        if (!text)
          return fallback;
        if (["1", "true", "yes", "on"].includes(text))
          return true;
        if (["0", "false", "no", "off"].includes(text))
          return false;
        return fallback;
      };
      const compactText3 = (value, maxChars = 500) => {
        const text = String(value ?? "").replace(/\s+/g, " ").trim();
        if (!text)
          return "";
        if (text.length <= maxChars)
          return text;
        return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
      };
      const parseJsonRecord2 = (value) => {
        if (typeof value !== "string" || !value.trim())
          return {};
        try {
          const parsed = JSON.parse(value);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed;
          }
        } catch {}
        return {};
      };
      const deriveJobOrigin = (params) => {
        if (params.origin === "autonomy")
          return "autonomy";
        const autonomy = params.autonomy;
        return autonomy && typeof autonomy === "object" && !Array.isArray(autonomy) ? "autonomy" : "user";
      };
      const hasClarificationSignal = (value) => {
        const text = value.toLowerCase();
        return text.includes("clarification") || text.includes("clarify") || text.includes("follow-up question") || text.includes("requested clarification");
      };
      const hasNoChangeSignal = (value) => {
        const text = value.toLowerCase();
        return text.includes("no file changes") || text.includes("no changes to commit") || text.includes("no changes made") || text.includes("nothing to commit") || text.includes("modified 0 file") || text.includes("no modified files were detected") || text.includes("no file changes detected");
      };
      const classifyAutonomyJobCompletion = (body) => {
        const parts = [];
        const summary = compactText3(body.summary, 1400);
        if (summary)
          parts.push(summary);
        const detail = compactText3(body.detail, 1400);
        if (detail)
          parts.push(detail);
        if (typeof body.result === "string") {
          parts.push(compactText3(body.result, 1400));
        } else if (body.result && typeof body.result === "object" && !Array.isArray(body.result)) {
          parts.push(compactText3(JSON.stringify(body.result), 1800));
        }
        const artifacts = Array.isArray(body.artifacts) ? body.artifacts.filter((entry) => entry && typeof entry === "object") : [];
        for (const artifact of artifacts.slice(0, 8)) {
          const artifactText = compactText3(artifact.text ?? artifact.message, 400);
          if (artifactText)
            parts.push(artifactText);
        }
        const combined = parts.join(`
`);
        if (hasClarificationSignal(combined)) {
          return {
            success: false,
            userAction: "needs_clarification",
            reopenedWithin24h: true,
            regressionFlag: false
          };
        }
        if (hasNoChangeSignal(combined)) {
          return {
            success: false,
            userAction: "no_change",
            reopenedWithin24h: true,
            regressionFlag: false
          };
        }
        return {
          success: true,
          userAction: "applied",
          reopenedWithin24h: false,
          regressionFlag: false
        };
      };
      const recordHasAutonomyOrigin = (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
          return false;
        const record = value;
        const origin = String(record.origin ?? "").trim().toLowerCase();
        return origin === "autonomy";
      };
      const isAutonomyRequestPayload = (value) => [value.metadata, value.meta, value.params, value].some(recordHasAutonomyOrigin);
      const autonomyFailureCircuitSummary = () => jobQueue.noPublishableFailureCircuitSummary({
        windowMs: AUTONOMY_WORKER_FAILURE_CIRCUIT_WINDOW_MS,
        threshold: AUTONOMY_WORKER_FAILURE_CIRCUIT_THRESHOLD,
        failureRateThreshold: AUTONOMY_WORKER_FAILURE_CIRCUIT_RATE
      });
      const autonomyFailureCircuitMessage = (failureCircuit) => `Autonomy enqueue blocked: WorkerPal produced ` + `${failureCircuit.noPublishableFailureCount} no-publishable/no-edit failure(s) ` + `across ${failureCircuit.terminalCount} recent terminal task(s).`;
      const makeAutonomyFailureCircuitResponse = () => {
        const failureCircuit = autonomyFailureCircuitSummary();
        if (!failureCircuit.blocked)
          return null;
        return makeJson({
          ok: false,
          code: "autonomy_worker_failure_circuit_open",
          message: autonomyFailureCircuitMessage(failureCircuit),
          retryAfterMs: AUTONOMY_WORKER_FAILURE_DEFER_MS,
          ...failureCircuit
        }, 429);
      };
      const autonomySimilarFailureSummary = (value) => {
        const details = extractAutonomyPayloadDetails(value);
        return jobQueue.similarFailureFingerprintSummary({
          targetPaths: details.targetPaths,
          windowMs: AUTONOMY_SIMILAR_FAILURE_WINDOW_MS,
          threshold: AUTONOMY_SIMILAR_FAILURE_THRESHOLD
        });
      };
      const makeAutonomySimilarFailureResponse = (value) => {
        const similarFailure = autonomySimilarFailureSummary(value);
        if (!similarFailure.blocked)
          return null;
        return makeJson({
          ok: false,
          code: "autonomy_similar_failure_suppressed",
          message: `Autonomy enqueue blocked: ${similarFailure.recentSimilarFailureCount} ` + `unchanged target-and-failure fingerprint occurrence(s) were observed recently. ` + `Dispatch one root-cause repair for this cluster or select another component.`,
          retryAfterMs: AUTONOMY_SIMILAR_FAILURE_DEFER_MS,
          ...similarFailure
        }, 429);
      };
      const parseRuntimeMutations = (value) => {
        if (!Array.isArray(value))
          return [];
        const out = [];
        for (const entry of value) {
          if (!entry || typeof entry !== "object")
            continue;
          const record = entry;
          const scope = String(record.scope ?? "").trim().toLowerCase();
          const key = String(record.key ?? "").trim();
          if (scope !== "env" && scope !== "toml" || !key)
            continue;
          out.push({
            scope,
            key,
            value: record.value
          });
        }
        return out;
      };
      const maybeRecoverStaleClaims = () => {
        const runtimeConfig = loadPushPalsConfig();
        const staleClaimTtlMs = runtimeConfig.server.staleClaimTtlMs;
        const staleClaimSweepIntervalMs = runtimeConfig.server.staleClaimSweepIntervalMs;
        const nowMs = Date.now();
        if (nowMs - lastStaleRecoverySweepAt < staleClaimSweepIntervalMs)
          return;
        lastStaleRecoverySweepAt = nowMs;
        autonomyStore.maybeSweepStaleObjectives();
        const recovered = jobQueue.recoverStaleClaimedJobs(staleClaimTtlMs);
        if (recovered.length === 0)
          return;
        for (const item of recovered) {
          if (item.action === "requeued") {
            console.warn(`[Server] Requeued retry-safe stale claimed job ${item.jobId} as ${item.replacementJobId ?? "unknown"} (worker=${item.workerId ?? "unknown"})`);
          } else {
            console.warn(`[Server] Recovered stale claimed job ${item.jobId} (worker=${item.workerId ?? "unknown"})`);
          }
          const session = sessionManager.getSession(item.sessionId);
          if (!session)
            continue;
          if (item.action === "requeued") {
            session.emit({
              protocolVersion: PROTOCOL_VERSION,
              id: randomUUID6(),
              ts: item.recoveredAt,
              sessionId: item.sessionId,
              type: "log",
              from: "server:stale-claim-recovery",
              payload: {
                level: "warn",
                message: `job ${item.jobId} was abandoned after a stale claim and requeued as ${item.replacementJobId ?? "unknown"} (${item.detail})`
              }
            });
          } else {
            const envelope = {
              protocolVersion: PROTOCOL_VERSION,
              id: randomUUID6(),
              ts: item.recoveredAt,
              sessionId: item.sessionId,
              type: "job_failed",
              from: "server:stale-claim-recovery",
              payload: {
                jobId: item.jobId,
                message: item.message,
                detail: item.detail
              }
            };
            session.emit(envelope);
          }
        }
      };
      const initiateShutdown = (reason) => {
        if (isShuttingDown)
          return;
        isShuttingDown = true;
        console.warn(`[Server] Shutdown requested: ${reason}`);
        setTimeout(() => {
          try {
            requestQueue.close();
          } catch (_e) {}
          try {
            jobQueue.close();
          } catch (_e) {}
          try {
            completionQueue.close();
          } catch (_e) {}
          try {
            autonomyStore.close();
          } catch (_e) {}
          try {
            server.stop(true);
          } catch (_e) {}
        }, 25);
      };
      if (method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: jsonHeaders
        });
      }
      const isNoisyPoll = method === "POST" && /^\/+((jobs|requests|completions)\/claim|workers\/heartbeat|sessions\/[^/]+\/command|jobs\/[^/]+\/log|telemetry\/llm-usage)\/?$/.test(pathname) || method === "GET" && /^\/+(workers|workers\/autoscale|system\/status|requests|jobs|completions|questions|autonomy\/insights|requests\/[^/]+|jobs\/[^/]+|completions\/[^/]+|jobs\/[^/]+\/logs)(\/)?$/.test(pathname);
      if (isNoisyPoll) {
        if (isDebugHttpLogsEnabled())
          console.log(`[${method}] ${pathname}`);
      } else {
        console.log(`[${method}] ${pathname}`);
      }
      const requestAuthHeader = () => resolveRequestAuthHeader(req.headers.get("authorization"));
      const requireAuth = () => {
        const authHeader = requestAuthHeader();
        if (!sessionManager.validateAuth(authHeader)) {
          return makeJson({ ok: false, message: "Unauthorized" }, 401);
        }
        return null;
      };
      if (pathname === "/healthz" && method === "GET") {
        return makeJson({ ok: true, protocolVersion: PROTOCOL_VERSION });
      }
      if (pathname === "/admin/shutdown" && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const body = await req.json().catch(() => ({}));
        const reason = compactText3(body.reason, 180) || "remote shutdown request";
        initiateShutdown(reason);
        return makeJson({ ok: true, shuttingDown: true, reason }, 202);
      }
      if (pathname === "/config/runtime" && method === "GET") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const runtimeConfig = loadPushPalsConfig({ reload: true });
        const files = describeRuntimeConfigFiles(getRuntimeConfigFiles(runtimeConfig));
        return makeJson({
          ok: true,
          config: sanitizePushPalsConfigForLogging(runtimeConfig),
          files
        }, 200);
      }
      if (pathname === "/config/runtime" && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const body = await req.json().catch(() => ({}));
        const updates = parseRuntimeMutations(body.updates);
        if (updates.length === 0) {
          return makeJson({
            ok: false,
            message: "updates must include at least one valid { scope, key, value } entry"
          }, 400);
        }
        const runtimeConfig = loadPushPalsConfig();
        const files = getRuntimeConfigFiles(runtimeConfig);
        const applyResult = applyRuntimeConfigMutations(files, updates);
        invalidatePushPalsConfigCache();
        const nextConfig = loadPushPalsConfig({ reload: true });
        sessionManager.authToken = null;
        repoStatusCache = null;
        const impact = deriveRuntimeConfigImpact(applyResult.applied.map((change) => change.key));
        const warnings = [...applyResult.warnings, ...impact.warnings];
        if (nextConfig.authToken) {
          warnings.push("Server auth tokens are ignored because PushPals runs in local-only mode.");
        }
        return makeJson({
          ok: true,
          applied: applyResult.applied,
          warnings,
          touchedFiles: applyResult.touchedFiles.map((entry) => entry.replace(/\\/g, "/")),
          restartRequired: impact.restartRequiredKeys.length > 0,
          restartRequiredKeys: impact.restartRequiredKeys,
          config: sanitizePushPalsConfigForLogging(nextConfig),
          files: describeRuntimeConfigFiles(files)
        }, 200);
      }
      if (pathname === "/sessions" && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const body = await req.json().catch(() => ({}));
        const raw = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
        const requestedId = raw.length > 0 ? raw : undefined;
        const result = sessionManager.createSession(requestedId);
        if (result.id === null) {
          return makeJson({
            ok: false,
            message: "Invalid sessionId: must contain only [a-zA-Z0-9._-] and be 1\u201364 chars"
          }, 400);
        }
        const client = readClientPresenceFromSessionBody(body, req.headers);
        if (client && result.id) {
          clientPresence.announce(result.id, client, "session");
        }
        return makeJson({ sessionId: result.id, protocolVersion: PROTOCOL_VERSION }, result.created ? 201 : 200);
      }
      const sseMatch = pathname.match(/^\/sessions\/([^/]+)\/events$/);
      if (sseMatch && method === "GET") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const sessionId = sseMatch[1];
        const session = sessionManager.getSession(sessionId);
        if (!session) {
          return makeJson({ ok: false, message: "Session not found" }, 404);
        }
        const afterParam = url.searchParams.get("after");
        const requestedAfterEventId = afterParam ? parseInt(afterParam, 10) || 0 : 0;
        const latestCursor = session.getLatestCursor();
        const afterEventId = requestedAfterEventId > latestCursor ? 0 : Math.max(0, requestedAfterEventId);
        if (requestedAfterEventId > latestCursor) {
          console.warn(`[SSE] Session ${sessionId} requested cursor ${requestedAfterEventId} > latest ${latestCursor}; resetting replay to 0`);
        }
        const encoder = new TextEncoder;
        const client = readClientPresenceFromTransportRequest(url, req.headers);
        const clientConnectionId = client ? randomUUID6() : null;
        if (client) {
          clientPresence.connect(sessionId, client, "sse", clientConnectionId);
        }
        let unsubscribe = null;
        let pingInterval = null;
        let cleanedUp = false;
        const cleanupSse = () => {
          if (cleanedUp)
            return;
          cleanedUp = true;
          if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
          }
          if (unsubscribe) {
            const fn = unsubscribe;
            unsubscribe = null;
            fn();
          }
          if (client) {
            clientPresence.disconnect(client.clientId, "sse", clientConnectionId);
          }
        };
        const readableStream = new ReadableStream({
          start(controller) {
            try {
              controller.enqueue(encoder.encode(`: keepalive

`));
              if (client) {
                clientPresence.touch(client.clientId, "sse", clientConnectionId);
              }
            } catch {
              cleanupSse();
              try {
                controller.close();
              } catch {}
              return;
            }
            session.replayHistory((envelope, eventId) => {
              const eventData = `id: ${eventId}
data: ${JSON.stringify({ envelope, cursor: eventId })}

`;
              try {
                controller.enqueue(encoder.encode(eventData));
                if (client) {
                  clientPresence.touch(client.clientId, "sse", clientConnectionId);
                }
              } catch (_e) {
                cleanupSse();
                try {
                  controller.close();
                } catch {}
              }
            }, afterEventId);
            unsubscribe = session.subscribe((envelope, eventId) => {
              const eventData = `id: ${eventId}
data: ${JSON.stringify({ envelope, cursor: eventId })}

`;
              try {
                controller.enqueue(encoder.encode(eventData));
                if (client) {
                  clientPresence.touch(client.clientId, "sse", clientConnectionId);
                }
              } catch (_err) {
                cleanupSse();
                try {
                  controller.close();
                } catch {}
              }
            });
            pingInterval = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(`: keepalive

`));
                if (client) {
                  clientPresence.touch(client.clientId, "sse", clientConnectionId);
                }
              } catch (_err) {
                cleanupSse();
                try {
                  controller.close();
                } catch {}
              }
            }, CLIENT_TRANSPORT_HEARTBEAT_MS);
          },
          cancel() {
            cleanupSse();
          }
        });
        return new Response(readableStream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            ...corsHeaders
          }
        });
      }
      const wsMatch = pathname.match(/^\/sessions\/([^/]+)\/ws$/);
      if (wsMatch && method === "GET") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const sessionId = wsMatch[1];
        const session = sessionManager.getSession(sessionId);
        if (!session) {
          return makeJson({ ok: false, message: "Session not found" }, 404);
        }
        const afterParam = url.searchParams.get("after");
        const requestedAfterEventId = afterParam ? parseInt(afterParam, 10) || 0 : 0;
        const latestCursor = session.getLatestCursor();
        const afterEventId = requestedAfterEventId > latestCursor ? 0 : Math.max(0, requestedAfterEventId);
        if (requestedAfterEventId > latestCursor) {
          console.warn(`[WS] Session ${sessionId} requested cursor ${requestedAfterEventId} > latest ${latestCursor}; resetting replay to 0`);
        }
        const client = readClientPresenceFromTransportRequest(url, req.headers);
        const clientConnectionId = client ? randomUUID6() : null;
        const success = server.upgrade(req, {
          data: {
            sessionId,
            afterEventId,
            client,
            clientConnectionId
          }
        });
        if (success) {
          return new Response(null);
        }
        return makeJson({ ok: false, message: "WebSocket upgrade failed" }, 400);
      }
      const msgMatch = pathname.match(/^\/sessions\/([^/]+)\/message$/);
      if (msgMatch && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const sessionId = msgMatch[1];
        const body = await req.json().catch(() => ({}));
        const result = sessionManager.handleMessage(sessionId, body);
        return makeJson(result, sessionMessageResultStatus(result));
      }
      const cmdMatch = pathname.match(/^\/sessions\/([^/]+)\/command$/);
      if (cmdMatch && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const sessionId = cmdMatch[1];
        const body = await req.json().catch(() => ({}));
        const result = sessionManager.handleCommand(sessionId, body);
        return makeJson(result, result.ok ? 200 : 400);
      }
      const approvalMatch = pathname.match(/^\/approvals\/([^/]+)$/);
      if (approvalMatch && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const approvalId = approvalMatch[1];
        const body = await req.json().catch(() => ({}));
        const decision = body.decision;
        if (decision !== "approve" && decision !== "deny") {
          return makeJson({ ok: false, message: "Invalid decision value" }, 400);
        }
        const result = sessionManager.handleApprovalDecision(approvalId, decision);
        return makeJson(result, result.ok ? 200 : 400);
      }
      if (pathname === "/jobs/enqueue" && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const body = await req.json().catch(() => ({}));
        const budgetStatus = getSessionTokenBudgetStatus(body.sessionId);
        if (budgetStatus?.exceeded) {
          return makeJson({
            ok: false,
            code: "session_token_budget_exceeded",
            message: sessionTokenBudgetMessage(budgetStatus),
            sessionBudget: budgetStatus
          }, 429);
        }
        if (isAutonomyRequestPayload(body)) {
          const failureCircuitResponse = makeAutonomyFailureCircuitResponse();
          if (failureCircuitResponse)
            return failureCircuitResponse;
          const similarFailureResponse = makeAutonomySimilarFailureResponse(body);
          if (similarFailureResponse)
            return similarFailureResponse;
        }
        const result = jobQueue.enqueue(body);
        return makeJson(result, result.ok ? 201 : 400);
      }
      if (pathname === "/jobs/claim" && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        maybeRecoverStaleClaims();
        const body = await req.json().catch(() => ({}));
        const workerId = body.workerId || "unknown";
        let result = jobQueue.claim(workerId);
        let skipped = 0;
        while (result.ok && result.job?.id && skipped < 64) {
          const budgetStatus = getSessionTokenBudgetStatus(result.job.sessionId);
          if (budgetStatus?.exceeded) {
            emitSessionBudgetPauseNotice(result.job.sessionId, budgetStatus);
            jobQueue.fail(result.job.id, {
              message: "Session token budget exceeded",
              detail: sessionTokenBudgetMessage(budgetStatus)
            });
            skipped += 1;
            result = jobQueue.claim(workerId);
            continue;
          }
          if (isAutonomyRequestPayload({
            ...result.job,
            params: parseJsonRecord2(result.job.params)
          })) {
            const jobPayload = {
              ...result.job,
              params: parseJsonRecord2(result.job.params)
            };
            const failureCircuit = autonomyFailureCircuitSummary();
            if (failureCircuit.blocked) {
              jobQueue.defer(result.job.id, {
                workerId,
                deferMs: AUTONOMY_WORKER_FAILURE_DEFER_MS,
                detail: JSON.stringify({
                  code: "autonomy_worker_failure_circuit_open",
                  ...failureCircuit
                })
              });
              skipped += 1;
              result = jobQueue.claim(workerId);
              continue;
            }
            const similarFailure = autonomySimilarFailureSummary(jobPayload);
            if (similarFailure.blocked) {
              jobQueue.defer(result.job.id, {
                workerId,
                deferMs: AUTONOMY_SIMILAR_FAILURE_DEFER_MS,
                detail: JSON.stringify({
                  code: "autonomy_similar_failure_suppressed",
                  ...similarFailure
                })
              });
              skipped += 1;
              result = jobQueue.claim(workerId);
              continue;
            }
          }
          break;
        }
        if (result.ok && result.job?.id) {
          const params = parseJsonRecord2(result.job.params ?? "");
          const requestId = compactText3(params.requestId, 128);
          if (requestId)
            autonomyStore.linkJobToObjectiveByRequest(requestId, result.job.id);
          autonomyStore.markObjectiveRunningByJobId(result.job.id);
        }
        return makeJson(result, result.ok ? 200 : 404);
      }
      if (pathname === "/workers/heartbeat" && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const body = await req.json().catch(() => ({}));
        const result = jobQueue.heartbeat(body);
        return makeJson(result, result.ok ? 200 : 400);
      }
      if (pathname === "/workers" && method === "GET") {
        const denied = requireAuth();
        if (denied)
          return denied;
        maybeRecoverStaleClaims();
        const ttlMsRaw = parseInt(url.searchParams.get("ttlMs") ?? "", 10);
        const ttlMs = Number.isFinite(ttlMsRaw) && ttlMsRaw > 0 ? ttlMsRaw : 15000;
        const workers = jobQueue.listWorkers(ttlMs);
        return makeJson({ ok: true, workers });
      }
      if (pathname === "/workers/autoscale" && method === "GET") {
        const denied = requireAuth();
        if (denied)
          return denied;
        maybeRecoverStaleClaims();
        const ttlMsRaw = parseInt(url.searchParams.get("ttlMs") ?? "", 10);
        const ttlMs = Number.isFinite(ttlMsRaw) && ttlMsRaw > 0 ? ttlMsRaw : 15000;
        const workers = jobQueue.listWorkers(ttlMs);
        const onlineWorkers = workers.filter((worker) => worker.isOnline);
        const busyWorkers = onlineWorkers.filter((worker) => worker.activeJobCount > 0).length;
        const taskExecutePending = jobQueue.countByKindAndStatus("task.execute", "pending");
        const taskExecuteClaimed = jobQueue.countByKindAndStatus("task.execute", "claimed");
        const autoscalableTaskExecutePending = jobQueue.countAutoscalablePendingByKind("task.execute");
        const openUnmergedWorkerPrs = jobQueue.countOpenUnmergedWorkerPrs();
        return makeJson({
          ok: true,
          workers: {
            total: workers.length,
            online: onlineWorkers.length,
            busy: busyWorkers,
            idle: Math.max(0, onlineWorkers.length - busyWorkers)
          },
          jobs: {
            pending: taskExecutePending,
            claimed: taskExecuteClaimed,
            autoscalablePending: autoscalableTaskExecutePending
          },
          prs: {
            openUnmerged: openUnmergedWorkerPrs
          }
        });
      }
      if (pathname === "/system/status" && method === "GET") {
        const denied = requireAuth();
        if (denied)
          return denied;
        maybeRecoverStaleClaims();
        const runtimeConfig = loadPushPalsConfig();
        const repo = await getRepoStatusSummary(runtimeConfig.projectRoot, runtimeConfig.sourceControlManager.remote);
        const ttlMsRaw = parseInt(url.searchParams.get("ttlMs") ?? "", 10);
        const ttlMs = Number.isFinite(ttlMsRaw) && ttlMsRaw > 0 ? ttlMsRaw : 15000;
        const workers = jobQueue.listWorkers(ttlMs);
        const onlineWorkers = workers.filter((w) => w.isOnline);
        const busyWorkers = onlineWorkers.filter((w) => w.status === "busy").length;
        const workerPrBacklog = jobQueue.listWorkerPrBacklog(200);
        const openUnmergedWorkerPrs = workerPrBacklog.filter((entry) => entry.mergeState === "open_unmerged");
        const mergedWorkerPrs = workerPrBacklog.filter((entry) => entry.mergeState === "merged");
        const closedUnmergedWorkerPrs = workerPrBacklog.filter((entry) => entry.mergeState === "closed_unmerged");
        const requestCounts = requestQueue.countByStatus();
        const requestPriorityCounts = requestQueue.countByPriority();
        const requestPendingSnapshot = requestQueue.nextPendingSnapshot(10);
        const requestSlo = requestQueue.sloSummary(24);
        const jobCounts = jobQueue.countByStatus();
        const jobPriorityCounts = jobQueue.countByPriority();
        const jobPendingSnapshot = jobQueue.nextPendingSnapshot(10);
        const jobSlo = jobQueue.sloSummary(24);
        const completionCounts = completionQueue.countByStatus();
        const abandonedJobs = Math.max(0, Number(jobSlo.abandoned ?? 0));
        const failedJobs = Math.max(0, Number(jobSlo.failed ?? 0));
        const publishBlockedJobs = Math.max(0, Number(jobSlo.publishBlocked ?? 0));
        const jobTerminal = Math.max(0, Number(jobSlo.completed ?? 0) + failedJobs + abandonedJobs + publishBlockedJobs);
        const jobFailureRate = jobTerminal > 0 ? (failedJobs + abandonedJobs + publishBlockedJobs) / jobTerminal : 0;
        const autonomyOps = autonomyStore.getOpsSummary({
          requestPending: Math.max(0, Number(requestCounts.pending ?? 0)),
          jobFailureRate
        });
        const llmUsage = autonomyStore.getLlmUsageSummary({ windowHours: 24 });
        const clients = clientPresence.snapshot();
        return makeJson({
          ok: true,
          ts: new Date().toISOString(),
          runtime: {
            startedAt: SERVER_STARTED_AT_ISO,
            uptimeMs: Math.max(0, Date.now() - SERVER_STARTED_AT_MS)
          },
          workers: {
            total: workers.length,
            online: onlineWorkers.length,
            busy: busyWorkers,
            idle: Math.max(0, onlineWorkers.length - busyWorkers)
          },
          queues: {
            requests: requestCounts,
            requestPriorities: requestPriorityCounts,
            requestPendingSnapshot,
            jobs: jobCounts,
            jobPriorities: jobPriorityCounts,
            jobPendingSnapshot,
            workerPrBacklog: {
              openUnmergedCount: openUnmergedWorkerPrs.length,
              mergedCount: mergedWorkerPrs.length,
              closedUnmergedCount: closedUnmergedWorkerPrs.length,
              openUnmergedSnapshot: openUnmergedWorkerPrs.slice(0, 10).map((entry) => ({
                prUrl: entry.prUrl,
                latestJobId: entry.latestJobId,
                latestJobStatus: entry.latestJobStatus,
                latestJobAt: entry.latestJobAt,
                latestFeedbackVerdict: entry.latestFeedbackVerdict,
                latestFeedbackAt: entry.latestFeedbackAt
              }))
            },
            completions: completionCounts
          },
          slo: {
            requests: requestSlo,
            jobs: jobSlo
          },
          llmUsage,
          autonomy: autonomyOps,
          repo,
          clients
        });
      }
      if (pathname === "/telemetry/llm-usage" && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const body = await req.json().catch(() => ({}));
        const result = autonomyStore.recordLlmUsage(body, {
          sessionTokenBudget: SESSION_TOKEN_BUDGET,
          sessionTokenBudgetAction: STARTUP_CONFIG.server.sessionTokenBudgetAction
        });
        if (result.ok && result.crossedLimit && result.sessionBudget?.sessionId) {
          emitSessionBudgetPauseNotice(result.sessionBudget.sessionId, result.sessionBudget);
        }
        return makeJson(result, result.ok ? 200 : 400);
      }
      if (pathname === "/requests" && method === "GET") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const status = (url.searchParams.get("status") ?? "all").trim().toLowerCase();
        const limit = parseLimit(url.searchParams.get("limit"));
        if (!["all", "pending", "claimed", "completed", "failed"].includes(status)) {
          return makeJson({ ok: false, message: "Invalid status filter" }, 400);
        }
        const requests = requestQueue.listRequests({
          status,
          limit
        });
        return makeJson({
          ok: true,
          requests,
          counts: requestQueue.countByStatus(),
          priorityCounts: requestQueue.countByPriority(),
          pendingSnapshot: requestQueue.nextPendingSnapshot(10),
          slo: requestQueue.sloSummary(24)
        });
      }
      if (pathname === "/autonomy/lock/acquire" && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const body = await req.json().catch(() => ({}));
        const sessionId = compactText3(body.sessionId, 128);
        const runId = compactText3(body.runId, 128);
        const ttlMs = Number(body.ttlMs);
        const staleAfterMs = Number(body.staleAfterMs);
        if (!sessionId || !runId) {
          return makeJson({ ok: false, message: "sessionId and runId are required" }, 400);
        }
        const result = autonomyStore.acquireDispatchLock({
          sessionId,
          runId,
          ttlMs: Number.isFinite(ttlMs) ? ttlMs : undefined,
          staleAfterMs: Number.isFinite(staleAfterMs) ? staleAfterMs : undefined
        });
        if (!result.ok)
          return makeJson(result, 409);
        return makeJson(result, 200);
      }
      if (pathname === "/autonomy/lock/release" && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const body = await req.json().catch(() => ({}));
        const sessionId = compactText3(body.sessionId, 128);
        const runId = compactText3(body.runId, 128);
        if (!sessionId || !runId) {
          return makeJson({ ok: false, message: "sessionId and runId are required" }, 400);
        }
        return makeJson(autonomyStore.releaseDispatchLock({ sessionId, runId }), 200);
      }
      if (pathname === "/autonomy/lock/renew" && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const body = await req.json().catch(() => ({}));
        const sessionId = compactText3(body.sessionId, 128);
        const runId = compactText3(body.runId, 128);
        const ttlMs = Number(body.ttlMs);
        if (!sessionId || !runId) {
          return makeJson({ ok: false, message: "sessionId and runId are required" }, 400);
        }
        const result = autonomyStore.renewDispatchLock({
          sessionId,
          runId,
          ttlMs: Number.isFinite(ttlMs) ? ttlMs : undefined
        });
        if (!result.ok)
          return makeJson(result, 409);
        return makeJson(result, 200);
      }
      if (pathname === "/autonomy/snapshot" && method === "GET") {
        const denied = requireAuth();
        if (denied)
          return denied;
        maybeRecoverStaleClaims();
        const sessionId = (url.searchParams.get("sessionId") ?? "").trim();
        const runId = (url.searchParams.get("runId") ?? "").trim();
        if (!sessionId) {
          return makeJson({ ok: false, message: "sessionId is required" }, 400);
        }
        const snapshot = autonomyStore.createSnapshot({
          sessionId,
          runId,
          requestSlo: requestQueue.sloSummary(24),
          jobSlo: jobQueue.sloSummary(24),
          repoHealthFlags: {
            is_worktree_dirty: parseBool(url.searchParams.get("isWorktreeDirty"), false),
            is_merge_in_progress: parseBool(url.searchParams.get("isMergeInProgress"), false)
          }
        });
        return makeJson({ ok: true, snapshot }, 200);
      }
      if (pathname === "/autonomy/insights" && method === "GET") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const patternKey = compactText3(url.searchParams.get("patternKey"), 256) || undefined;
        const objectiveId = compactText3(url.searchParams.get("objectiveId"), 256) || undefined;
        const limit = parseLimit(url.searchParams.get("limit"), 20);
        const feedbackLimit = parseLimit(url.searchParams.get("feedbackLimit"), 30);
        const insights = autonomyStore.listInsights({
          patternKey,
          objectiveId,
          limit,
          feedbackLimit
        });
        return makeJson({ ok: true, ...insights }, 200);
      }
      if (pathname === "/autonomy/safety" && method === "GET") {
        const denied = requireAuth();
        if (denied)
          return denied;
        return makeJson({ ok: true, state: autonomyStore.getSafetyState() }, 200);
      }
      if (pathname === "/autonomy/safety" && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const body = await req.json().catch(() => ({}));
        const result = autonomyStore.updateSafetyState(body);
        return makeJson(result, result.ok ? 200 : 400);
      }
      if (pathname === "/autonomy/inspiration/ingest" && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const body = await req.json().catch(() => ({}));
        const result = autonomyStore.ingestInspirationPatterns(body);
        return makeJson(result, result.ok ? 200 : 400);
      }
      if (pathname === "/autonomy/inspiration" && method === "GET") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const sourceType = compactText3(url.searchParams.get("sourceType"), 64) || undefined;
        const tag = compactText3(url.searchParams.get("tag"), 64).toLowerCase() || undefined;
        const q = compactText3(url.searchParams.get("q"), 240) || undefined;
        const limit = parseLimit(url.searchParams.get("limit"), 40);
        const patterns = autonomyStore.listInspirationPatterns({
          sourceType,
          tag,
          q,
          limit
        });
        return makeJson({ ok: true, count: patterns.length, patterns }, 200);
      }
      if (pathname === "/autonomy/eligibility" && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const body = await req.json().catch(() => ({}));
        const result = autonomyStore.evaluateEligibility(body);
        return makeJson(result, result.ok ? 200 : 400);
      }
      if (pathname === "/autonomy/objectives" && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const body = await req.json().catch(() => ({}));
        const result = autonomyStore.recordObjectiveDecision(body);
        if (!result.ok) {
          return makeJson(result, 400);
        }
        const objective = body.objective && typeof body.objective === "object" ? body.objective : null;
        const sessionId = compactText3(body.sessionId, 128);
        const runId = compactText3(body.runId, 128);
        const snapshotId = compactText3(body.snapshotId, 128);
        const candidateRows = Array.isArray(body.candidates) ? body.candidates.filter((entry) => entry && typeof entry === "object") : [];
        if (objective && sessionId) {
          const objectiveRecord = objective;
          const objectiveId = compactText3(objectiveRecord.id ?? result.objectiveId, 128);
          const status = compactText3(objectiveRecord.status, 64);
          const requestId = compactText3(objectiveRecord.requestId ?? objectiveRecord.request_id, 128);
          const patternKey = compactText3(result.patternKey ?? objectiveRecord.patternKey ?? objectiveRecord.pattern_key, 128);
          const session = sessionManager.getSession(sessionId);
          if (session && objectiveId && runId && snapshotId) {
            if (status === "dispatched" && requestId) {
              session.emit({
                protocolVersion: PROTOCOL_VERSION,
                id: randomUUID6(),
                ts: new Date().toISOString(),
                sessionId,
                type: "autonomy_objective_dispatched",
                from: "server:autonomy",
                payload: {
                  runId,
                  snapshotId,
                  objectiveId,
                  requestId,
                  patternKey: patternKey || "unknown",
                  origin: "autonomy"
                }
              });
            } else if (status === "blocked") {
              session.emit({
                protocolVersion: PROTOCOL_VERSION,
                id: randomUUID6(),
                ts: new Date().toISOString(),
                sessionId,
                type: "autonomy_objective_blocked",
                from: "server:autonomy",
                payload: {
                  runId,
                  snapshotId,
                  objectiveId,
                  reason: compactText3(objectiveRecord.blockReason ?? objectiveRecord.block_reason ?? "blocked", 300),
                  origin: "autonomy",
                  ...result.questionId ? { questionId: result.questionId } : {},
                  ...patternKey ? { patternKey } : {}
                }
              });
            }
          }
          if (session && result.questionId) {
            const q = body.question && typeof body.question === "object" ? body.question : {};
            session.emit({
              protocolVersion: PROTOCOL_VERSION,
              id: randomUUID6(),
              ts: new Date().toISOString(),
              sessionId,
              type: "question_asked",
              from: "server:autonomy",
              payload: {
                questionId: result.questionId,
                objectiveId: objectiveId || "unknown",
                question: compactText3(q.question, 500),
                questionType: compactText3(q.questionType ?? q.question_type, 120) || "unknown"
              }
            });
          }
        }
        if (sessionId && runId && snapshotId && candidateRows.length > 0) {
          const session = sessionManager.getSession(sessionId);
          if (session) {
            const topCandidateIds = candidateRows.map((entry) => ({
              id: compactText3(entry.id, 128),
              selected: Boolean(entry.selected),
              score: Number(entry.final_score ?? entry.finalScore ?? Number.NEGATIVE_INFINITY)
            })).sort((a, b) => {
              if (a.selected !== b.selected)
                return a.selected ? -1 : 1;
              if (a.score !== b.score)
                return b.score - a.score;
              return a.id.localeCompare(b.id);
            }).map((entry) => entry.id).filter(Boolean).slice(0, 3);
            session.emit({
              protocolVersion: PROTOCOL_VERSION,
              id: randomUUID6(),
              ts: new Date().toISOString(),
              sessionId,
              type: "autonomy_candidates_generated",
              from: "server:autonomy",
              payload: {
                runId,
                snapshotId,
                candidateCount: candidateRows.length,
                ...topCandidateIds.length > 0 ? { topCandidateIds } : {}
              }
            });
          }
        }
        return makeJson(result, 200);
      }
      if (pathname === "/autonomy/outcomes" && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const body = await req.json().catch(() => ({}));
        const result = autonomyStore.recordOutcome(body);
        if (!result.ok)
          return makeJson(result, 400);
        const sessionId = compactText3(body.sessionId, 128);
        const session = sessionId ? sessionManager.getSession(sessionId) : null;
        if (session) {
          session.emit({
            protocolVersion: PROTOCOL_VERSION,
            id: randomUUID6(),
            ts: new Date().toISOString(),
            sessionId,
            type: "autonomy_feedback_recorded",
            from: "server:autonomy",
            payload: {
              objectiveId: compactText3(body.objectiveId ?? body.objective_id, 128) || "unknown",
              patternKey: compactText3(body.patternKey ?? body.pattern_key, 128) || "unknown",
              outcome: compactText3(body.userAction ?? body.user_action ?? "recorded", 120),
              success: Boolean(body.success)
            }
          });
        }
        return makeJson(result, 200);
      }
      if (pathname === "/autonomy/pr-feedback" && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const body = await req.json().catch(() => ({}));
        const result = autonomyStore.recordPrFeedback(body);
        if (!result.ok)
          return makeJson(result, 400);
        const sessionId = compactText3(body.sessionId, 128);
        const session = sessionId ? sessionManager.getSession(sessionId) : null;
        if (session && !result.ignored) {
          session.emit({
            protocolVersion: PROTOCOL_VERSION,
            id: randomUUID6(),
            ts: new Date().toISOString(),
            sessionId,
            type: "autonomy_feedback_recorded",
            from: "server:autonomy",
            payload: {
              objectiveId: compactText3(body.objectiveId ?? body.objective_id ?? result.objectiveId, 128) || "unknown",
              patternKey: compactText3(body.patternKey ?? body.pattern_key ?? result.patternKey, 128) || "unknown",
              outcome: compactText3(body.verdict ?? body.userAction ?? body.user_action ?? "pr_feedback", 120) || "pr_feedback",
              success: typeof result.success === "boolean" ? result.success : Boolean(body.success)
            }
          });
        }
        return makeJson(result, 200);
      }
      if (pathname === "/questions" && method === "GET") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const sessionId = (url.searchParams.get("sessionId") ?? "").trim() || undefined;
        const status = (url.searchParams.get("status") ?? "").trim() || undefined;
        const limit = parseLimit(url.searchParams.get("limit"), 100);
        const questions = autonomyStore.listQuestions({
          sessionId,
          status,
          limit
        });
        return makeJson({ ok: true, questions }, 200);
      }
      const qAnswerMatch = pathname.match(/^\/questions\/([^/]+)\/answer$/);
      if (qAnswerMatch && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const questionId = qAnswerMatch[1];
        const body = await req.json().catch(() => ({}));
        const result = autonomyStore.answerQuestion(questionId, body.answer);
        if (!result.ok)
          return makeJson(result, 400);
        const sessionId = compactText3(body.sessionId, 128) || compactText3(result.sessionId, 128);
        let resumeError = "";
        let resumedRequestId = "";
        if (result.status === "valid" && result.resume) {
          const enqueueResult = requestQueue.enqueue({
            sessionId: result.resume.sessionId,
            prompt: result.resume.instruction,
            priority: "background",
            idempotencyKey: result.resume.idempotencyKey,
            forceWorker: true,
            forceLane: "worker",
            metadata: {
              origin: "autonomy",
              autonomy: {
                objectiveId: result.resume.objectiveId,
                runId: result.resume.runId,
                snapshotId: result.resume.snapshotId,
                patternKey: result.resume.patternKey,
                componentArea: result.resume.componentArea,
                targetPaths: result.resume.targetPaths,
                writeGlobs: result.resume.writeGlobs
              }
            }
          });
          if (enqueueResult.ok && enqueueResult.requestId) {
            resumedRequestId = enqueueResult.requestId;
            autonomyStore.markObjectiveDispatched(result.resume.objectiveId, enqueueResult.requestId);
            const dispatchSession = sessionManager.getSession(result.resume.sessionId);
            if (dispatchSession) {
              dispatchSession.emit({
                protocolVersion: PROTOCOL_VERSION,
                id: randomUUID6(),
                ts: new Date().toISOString(),
                sessionId: result.resume.sessionId,
                type: "autonomy_objective_dispatched",
                from: "server:autonomy",
                payload: {
                  runId: result.resume.runId,
                  snapshotId: result.resume.snapshotId,
                  objectiveId: result.resume.objectiveId,
                  requestId: enqueueResult.requestId,
                  patternKey: result.resume.patternKey || "unknown",
                  origin: "autonomy"
                }
              });
            }
          } else {
            resumeError = compactText3(enqueueResult.message, 300) || "failed to enqueue autonomy resume request";
          }
        }
        const session = sessionId ? sessionManager.getSession(sessionId) : null;
        if (session) {
          session.emit({
            protocolVersion: PROTOCOL_VERSION,
            id: randomUUID6(),
            ts: new Date().toISOString(),
            sessionId,
            type: "question_answered",
            from: "server:autonomy",
            payload: {
              questionId,
              objectiveId: result.objectiveId || "unknown",
              status: result.status === "valid" ? "valid" : "invalid",
              ...result.reason || resumeError ? { answerSummary: compactText3(result.reason || resumeError, 240) } : {}
            }
          });
        }
        return makeJson({
          ...result,
          ...resumedRequestId ? { resumedRequestId } : {},
          ...resumeError ? { resumeError } : {}
        }, 200);
      }
      const qActionMatch = pathname.match(/^\/questions\/([^/]+)\/action$/);
      if (qActionMatch && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const questionId = qActionMatch[1];
        const body = await req.json().catch(() => ({}));
        const result = autonomyStore.actOnQuestion(questionId, body.action, body.note);
        if (!result.ok)
          return makeJson(result, 400);
        const sessionId = compactText3(body.sessionId, 128) || compactText3(result.sessionId, 128);
        const session = sessionId ? sessionManager.getSession(sessionId) : null;
        if (session) {
          session.emit({
            protocolVersion: PROTOCOL_VERSION,
            id: randomUUID6(),
            ts: new Date().toISOString(),
            sessionId,
            type: "log",
            from: "server:autonomy",
            payload: {
              level: "info",
              message: compactText3(`question ${questionId} action=${result.action || "closed"} objective=${result.objectiveId || "unknown"}${body.note ? ` note=${String(body.note)}` : ""}`, 240)
            }
          });
        }
        return makeJson(result, 200);
      }
      if (pathname === "/jobs" && method === "GET") {
        const denied = requireAuth();
        if (denied)
          return denied;
        maybeRecoverStaleClaims();
        const status = (url.searchParams.get("status") ?? "all").trim().toLowerCase();
        const limit = parseLimit(url.searchParams.get("limit"));
        if (![
          "all",
          "pending",
          "claimed",
          "finalizing",
          "completed",
          "failed",
          "abandoned",
          "publish_blocked"
        ].includes(status)) {
          return makeJson({ ok: false, message: "Invalid status filter" }, 400);
        }
        const jobs = jobQueue.listJobs({
          status,
          limit
        });
        return makeJson({
          ok: true,
          jobs,
          counts: jobQueue.countByStatus(),
          priorityCounts: jobQueue.countByPriority(),
          pendingSnapshot: jobQueue.nextPendingSnapshot(10),
          slo: jobQueue.sloSummary(24)
        });
      }
      if (pathname === "/tool-runs" && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const body = await req.json().catch(() => ({}));
        const result = jobQueue.recordToolRun(body);
        return makeJson(result, result.ok ? 201 : 400);
      }
      const jobLogsMatch = pathname.match(/^\/jobs\/([^/]+)\/logs$/);
      if (jobLogsMatch && method === "GET") {
        const denied = requireAuth();
        if (denied)
          return denied;
        maybeRecoverStaleClaims();
        const jobId = jobLogsMatch[1];
        const limit = parseLimit(url.searchParams.get("limit"), 50);
        const afterId = parseCursor(url.searchParams.get("afterId"));
        const logs = jobQueue.listJobLogs(jobId, limit, afterId ?? undefined);
        const nextCursor = logs.length > 0 ? logs[logs.length - 1]?.id ?? null : afterId;
        return makeJson({ ok: true, jobId, logs, cursor: nextCursor });
      }
      const jobToolRunsMatch = pathname.match(/^\/jobs\/([^/]+)\/tool-runs$/);
      if (jobToolRunsMatch && method === "GET") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const jobId = jobToolRunsMatch[1];
        const limit = parseLimit(url.searchParams.get("limit"), 50);
        const toolRuns = jobQueue.listJobToolRuns(jobId, limit);
        return makeJson({ ok: true, jobId, toolRuns });
      }
      const jobDiagnosticsMatch = pathname.match(/^\/jobs\/([^/]+)\/diagnostics$/);
      if (jobDiagnosticsMatch && method === "GET") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const jobId = jobDiagnosticsMatch[1];
        return makeJson({ ok: true, jobId, diagnostics: jobQueue.getJobDiagnostics(jobId) });
      }
      if (jobDiagnosticsMatch && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const jobId = jobDiagnosticsMatch[1];
        const body = await req.json().catch(() => ({}));
        try {
          const result = jobQueue.saveJobDiagnostics(jobId, body);
          return makeJson(result, result.ok ? 200 : 404);
        } catch (error) {
          console.error(`[Server] Failed to persist diagnostics for job ${jobId}: ${error instanceof Error ? error.stack || error.message : String(error)}`);
          return makeJson({ ok: false, message: "Failed to persist job diagnostics" }, 500);
        }
      }
      if (pathname === "/completions" && method === "GET") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const status = (url.searchParams.get("status") ?? "all").trim().toLowerCase();
        const limit = parseLimit(url.searchParams.get("limit"));
        if (!["all", "pending", "claimed", "processed", "failed"].includes(status)) {
          return makeJson({ ok: false, message: "Invalid status filter" }, 400);
        }
        const completions = completionQueue.listCompletions({
          status,
          limit
        });
        return makeJson({
          ok: true,
          completions,
          counts: completionQueue.countByStatus()
        });
      }
      const jobCompleteMatch = pathname.match(/^\/jobs\/([^/]+)\/complete$/);
      if (jobCompleteMatch && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const jobId = jobCompleteMatch[1];
        const body = await req.json().catch(() => ({}));
        const result = jobQueue.complete(jobId, body);
        if (result.ok) {
          const durationText = typeof result.durationMs === "number" ? `${result.durationMs}ms` : "unknown duration";
          console.log(`[Server] Job ${jobId} completed (${durationText})`);
          const job = jobQueue.getJob(jobId);
          const params = parseJsonRecord2(job?.params ?? "");
          const requestId = compactText3(params.requestId, 128);
          if (requestId)
            autonomyStore.linkJobToObjectiveByRequest(requestId, jobId);
          autonomyStore.markObjectiveRunningByJobId(jobId);
          const outcomeContext = autonomyStore.resolveJobOutcomeContext(jobId, params);
          if (outcomeContext) {
            const outcome = classifyAutonomyJobCompletion(body);
            autonomyStore.recordOutcome({
              objectiveId: outcomeContext.objectiveId,
              requestId: outcomeContext.requestId ?? requestId,
              jobId,
              patternKey: outcomeContext.patternKey,
              success: outcome.success,
              latencyMs: result.durationMs ?? null,
              userAction: outcome.userAction,
              reopenedWithin24h: outcome.reopenedWithin24h,
              regressionFlag: outcome.regressionFlag
            });
          }
        }
        return makeJson(result, result.ok ? 200 : 400);
      }
      const jobFailMatch = pathname.match(/^\/jobs\/([^/]+)\/fail$/);
      if (jobFailMatch && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const jobId = jobFailMatch[1];
        const body = await req.json().catch(() => ({}));
        const result = jobQueue.fail(jobId, body);
        if (result.ok) {
          const durationText = typeof result.durationMs === "number" ? `${result.durationMs}ms` : "unknown duration";
          console.log(`[Server] Job ${jobId} failed (${durationText})`);
          const job = jobQueue.getJob(jobId);
          const params = parseJsonRecord2(job?.params ?? "");
          const origin = deriveJobOrigin(params);
          const requestId = compactText3(params.requestId, 128);
          if (requestId)
            autonomyStore.linkJobToObjectiveByRequest(requestId, jobId);
          const outcomeContext = autonomyStore.resolveJobOutcomeContext(jobId, params);
          if (outcomeContext) {
            autonomyStore.recordOutcome({
              objectiveId: outcomeContext.objectiveId,
              requestId: outcomeContext.requestId ?? requestId,
              jobId,
              patternKey: outcomeContext.patternKey,
              success: false,
              latencyMs: result.durationMs ?? null,
              userAction: "failed",
              reopenedWithin24h: false,
              regressionFlag: true
            });
          }
          if (job?.sessionId) {
            const session = sessionManager.getSession(job.sessionId);
            if (session) {
              const message = compactText3(body.message, 240) || "WorkerPal job failed";
              const detail = compactText3(body.detail, 600);
              const envelope = {
                protocolVersion: PROTOCOL_VERSION,
                id: randomUUID6(),
                ts: new Date().toISOString(),
                sessionId: job.sessionId,
                type: "job_failed",
                from: "server:job-fail-hook",
                payload: {
                  jobId,
                  message,
                  origin,
                  ...detail ? { detail } : {}
                }
              };
              session.emit(envelope);
            }
          }
        }
        return makeJson(result, result.ok ? 200 : 400);
      }
      const jobPublishBlockedMatch = pathname.match(/^\/jobs\/([^/]+)\/publish-blocked$/);
      if (jobPublishBlockedMatch && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const jobId = jobPublishBlockedMatch[1];
        const body = await req.json().catch(() => ({}));
        const result = jobQueue.publishBlocked(jobId, body);
        if (result.ok) {
          const durationText = typeof result.durationMs === "number" ? `${result.durationMs}ms` : "unknown duration";
          console.log(`[Server] Job ${jobId} publish-blocked (${durationText})`);
          const job = jobQueue.getJob(jobId);
          const params = parseJsonRecord2(job?.params ?? "");
          const origin = deriveJobOrigin(params);
          const requestId = compactText3(params.requestId, 128);
          if (requestId)
            autonomyStore.linkJobToObjectiveByRequest(requestId, jobId);
          const outcomeContext = autonomyStore.resolveJobOutcomeContext(jobId, params);
          if (outcomeContext) {
            autonomyStore.recordOutcome({
              objectiveId: outcomeContext.objectiveId,
              requestId: outcomeContext.requestId ?? requestId,
              jobId,
              patternKey: outcomeContext.patternKey,
              success: false,
              latencyMs: result.durationMs ?? null,
              userAction: "failed",
              reopenedWithin24h: false,
              regressionFlag: true
            });
          }
          if (job?.sessionId) {
            const session = sessionManager.getSession(job.sessionId);
            if (session) {
              const message = compactText3(body.message, 240) || "WorkerPal job publish-blocked";
              const detail = compactText3(body.detail, 600);
              const envelope = {
                protocolVersion: PROTOCOL_VERSION,
                id: randomUUID6(),
                ts: new Date().toISOString(),
                sessionId: job.sessionId,
                type: "job_failed",
                from: "server:job-publish-blocked",
                payload: {
                  jobId,
                  message,
                  origin,
                  ...detail ? { detail } : {}
                }
              };
              session.emit(envelope);
            }
          }
        }
        return makeJson(result, result.ok ? 200 : 400);
      }
      const jobFailDeferredMatch = pathname.match(/^\/jobs\/([^/]+)\/fail-deferred$/);
      if (jobFailDeferredMatch && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const jobId = jobFailDeferredMatch[1];
        const body = await req.json().catch(() => ({}));
        const result = jobQueue.failDeferred(jobId, body);
        if (result.ok) {
          console.log(`[Server] Deferred job ${jobId} failed during pre-execution maintenance`);
        }
        return makeJson(result, result.ok ? 200 : 400);
      }
      const jobDeferMatch = pathname.match(/^\/jobs\/([^/]+)\/defer$/);
      if (jobDeferMatch && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const jobId = jobDeferMatch[1];
        const body = await req.json().catch(() => ({}));
        const result = jobQueue.defer(jobId, body);
        if (result.ok) {
          console.log(`[Server] Job ${jobId} deferred until ${result.availableAt ?? "unknown"} by worker ${String(body.workerId ?? "unknown")}`);
        }
        return makeJson(result, result.ok ? 200 : 400);
      }
      const jobLogMatch = pathname.match(/^\/jobs\/([^/]+)\/log$/);
      if (jobLogMatch && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const jobId = jobLogMatch[1];
        const body = await req.json().catch(() => ({}));
        const message = typeof body.message === "string" ? body.message : typeof body.line === "string" ? body.line : "";
        const logTs = typeof body.ts === "string" ? body.ts.trim() : "";
        const trimmed = message.trim();
        if (!trimmed) {
          return makeJson({ ok: false, message: "message is required" }, 400);
        }
        const logId = jobQueue.addLog(jobId, trimmed, logTs || undefined);
        return makeJson({ ok: true, jobId, logId }, 200);
      }
      if (pathname === "/requests/enqueue" && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const body = await req.json().catch(() => ({}));
        const budgetStatus = getSessionTokenBudgetStatus(body.sessionId);
        if (budgetStatus?.exceeded) {
          return makeJson({
            ok: false,
            code: "session_token_budget_exceeded",
            message: sessionTokenBudgetMessage(budgetStatus),
            sessionBudget: budgetStatus
          }, 429);
        }
        if (isAutonomyRequestPayload(body)) {
          const failureCircuitResponse = makeAutonomyFailureCircuitResponse();
          if (failureCircuitResponse)
            return failureCircuitResponse;
          const similarFailureResponse = makeAutonomySimilarFailureResponse(body);
          if (similarFailureResponse)
            return similarFailureResponse;
          const workers = jobQueue.listWorkers(AUTONOMY_WORKER_TTL_MS);
          const schedulableWorkers = workers.filter((worker) => worker.isOnline && worker.status !== "offline");
          const idleWorkers = schedulableWorkers.filter((worker) => worker.status === "idle" && worker.activeJobCount === 0);
          const workersAllBusy = schedulableWorkers.length > 0 && idleWorkers.length === 0;
          if (workersAllBusy) {
            const autonomyQueued = requestQueue.countAutonomyRequests(["pending", "claimed"]);
            if (autonomyQueued >= AUTONOMY_BUSY_QUEUE_MAX_REQUESTS) {
              return makeJson({
                ok: false,
                code: "autonomy_queue_backpressure",
                message: `Autonomy enqueue blocked: workers are saturated and autonomy queue depth reached ` + `${AUTONOMY_BUSY_QUEUE_MAX_REQUESTS}.`,
                currentQueued: autonomyQueued,
                limit: AUTONOMY_BUSY_QUEUE_MAX_REQUESTS
              }, 429);
            }
          }
          const workerPrBacklog = jobQueue.listWorkerPrBacklog(500);
          const openUnmergedWorkerPrs = workerPrBacklog.filter((entry) => entry.mergeState === "open_unmerged");
          if (openUnmergedWorkerPrs.length >= AUTONOMY_MAX_OPEN_UNMERGED_WORKER_PRS) {
            return makeJson({
              ok: false,
              code: "autonomy_open_pr_limit",
              message: `Autonomy enqueue blocked: open unmerged worker PR backlog reached ` + `${AUTONOMY_MAX_OPEN_UNMERGED_WORKER_PRS}.`,
              currentOpenUnmergedWorkerPrs: openUnmergedWorkerPrs.length,
              limit: AUTONOMY_MAX_OPEN_UNMERGED_WORKER_PRS,
              openUnmergedPrs: openUnmergedWorkerPrs.slice(0, 10).map((entry) => entry.prUrl)
            }, 429);
          }
        }
        const result = requestQueue.enqueue(body);
        return makeJson(result, result.ok ? 201 : 400);
      }
      if (pathname === "/requests/claim" && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const body = await req.json().catch(() => ({}));
        const agentId = body.agentId || "unknown";
        let result = requestQueue.claim(agentId);
        let skipped = 0;
        while (result.ok && result.request?.id && skipped < 64) {
          const budgetStatus = getSessionTokenBudgetStatus(result.request.sessionId);
          if (budgetStatus?.exceeded) {
            emitSessionBudgetPauseNotice(result.request.sessionId, budgetStatus);
            requestQueue.fail(result.request.id, {
              message: "Session token budget exceeded",
              detail: sessionTokenBudgetMessage(budgetStatus)
            });
            skipped += 1;
            result = requestQueue.claim(agentId);
            continue;
          }
          if (isAutonomyRequestPayload(result.request)) {
            const failureCircuit = autonomyFailureCircuitSummary();
            if (failureCircuit.blocked) {
              requestQueue.fail(result.request.id, {
                message: autonomyFailureCircuitMessage(failureCircuit),
                detail: JSON.stringify({
                  code: "autonomy_worker_failure_circuit_open",
                  ...failureCircuit
                })
              });
              skipped += 1;
              result = requestQueue.claim(agentId);
              continue;
            }
            const similarFailure = autonomySimilarFailureSummary(result.request);
            if (similarFailure.blocked) {
              requestQueue.fail(result.request.id, {
                message: `Autonomy request suppressed after ` + `${similarFailure.recentSimilarFailureCount} unchanged target-and-failure fingerprint occurrence(s).`,
                detail: JSON.stringify({
                  code: "autonomy_similar_failure_suppressed",
                  ...similarFailure
                })
              });
              skipped += 1;
              result = requestQueue.claim(agentId);
              continue;
            }
          }
          break;
        }
        return makeJson(result, result.ok ? 200 : 404);
      }
      const reqCompleteMatch = pathname.match(/^\/requests\/([^/]+)\/complete$/);
      if (reqCompleteMatch && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const requestId = reqCompleteMatch[1];
        const body = await req.json().catch(() => ({}));
        const result = requestQueue.complete(requestId, body);
        if (result.ok) {
          const resultPayload = body.result && typeof body.result === "object" && !Array.isArray(body.result) ? body.result : null;
          const wasDelegatedToWorker = Boolean(resultPayload?.requiresWorker);
          const matched = autonomyStore.findObjectiveByRequestId(requestId);
          if (matched && !wasDelegatedToWorker) {
            autonomyStore.recordOutcome({
              objectiveId: matched.objectiveId,
              requestId,
              patternKey: matched.patternKey,
              success: true,
              userAction: "accepted",
              reopenedWithin24h: false,
              regressionFlag: false
            });
          }
        }
        return makeJson(result, result.ok ? 200 : 400);
      }
      const reqFailMatch = pathname.match(/^\/requests\/([^/]+)\/fail$/);
      if (reqFailMatch && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const requestId = reqFailMatch[1];
        const body = await req.json().catch(() => ({}));
        const result = requestQueue.fail(requestId, body);
        if (result.ok) {
          const matched = autonomyStore.findObjectiveByRequestId(requestId);
          if (matched) {
            autonomyStore.recordOutcome({
              objectiveId: matched.objectiveId,
              requestId,
              patternKey: matched.patternKey,
              success: false,
              userAction: "rejected",
              reopenedWithin24h: true,
              regressionFlag: true
            });
          }
        }
        return makeJson(result, result.ok ? 200 : 400);
      }
      if (pathname === "/completions/enqueue" && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const body = await req.json().catch(() => ({}));
        const result = completionQueue.enqueue(body, { beginJobFinalization: true });
        if (result.ok) {
          const jobId = compactText3(body.jobId, 128);
          if (jobId) {
            autonomyStore.markObjectiveRunningByJobId(jobId);
            console.log(`[Server] Job ${jobId} is finalizing via completion ${result.completionId ?? "unknown"}`);
          }
        }
        return makeJson(result, result.ok ? 201 : 400);
      }
      if (pathname === "/completions/claim" && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const body = await req.json().catch(() => ({}));
        const pusherId = body.pusherId || "unknown";
        const result = completionQueue.claim(pusherId);
        return makeJson(result, result.ok ? 200 : 404);
      }
      const compProcMatch = pathname.match(/^\/completions\/([^/]+)\/processed$/);
      if (compProcMatch && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const completionId = compProcMatch[1];
        const body = await req.json().catch(() => ({}));
        const prUrl = typeof body.prUrl === "string" ? body.prUrl : null;
        const trustedInstallDurationMs = typeof body.trustedInstallDurationMs === "number" ? body.trustedInstallDurationMs : null;
        const trustedValidationDurationMs = typeof body.trustedValidationDurationMs === "number" ? body.trustedValidationDurationMs : null;
        const trustedValidationCacheHit = typeof body.trustedValidationCacheHit === "boolean" ? body.trustedValidationCacheHit : null;
        const result = completionQueue.markProcessedAndFinalizeJob(completionId, prUrl, {
          installDurationMs: trustedInstallDurationMs,
          validationDurationMs: trustedValidationDurationMs,
          installCacheHit: trustedValidationCacheHit
        });
        if (result.ok && result.jobTransitioned && result.jobId) {
          const job = jobQueue.getJob(result.jobId);
          const params = parseJsonRecord2(job?.params ?? "");
          const origin = deriveJobOrigin(params);
          const requestId = compactText3(params.requestId, 128);
          const outcomeContext = autonomyStore.resolveJobOutcomeContext(result.jobId, params);
          if (outcomeContext) {
            autonomyStore.recordOutcome({
              objectiveId: outcomeContext.objectiveId,
              requestId: outcomeContext.requestId ?? requestId,
              jobId: result.jobId,
              patternKey: outcomeContext.patternKey,
              success: true,
              latencyMs: result.durationMs ?? null,
              userAction: "applied",
              reopenedWithin24h: false,
              regressionFlag: false
            });
          }
          if (job?.sessionId) {
            const session = sessionManager.getSession(job.sessionId);
            const savedResult = parseJsonRecord2(job.result ?? "");
            session?.emit({
              protocolVersion: PROTOCOL_VERSION,
              id: randomUUID6(),
              ts: new Date().toISOString(),
              sessionId: job.sessionId,
              type: "job_completed",
              from: "server:completion-processed",
              payload: {
                jobId: result.jobId,
                summary: compactText3(savedResult.summary, 1200) || "Candidate published successfully",
                origin
              }
            });
          }
          console.log(`[Server] Job ${result.jobId} completed after publication confirmation (${result.durationMs ?? "unknown"}ms)`);
        }
        return makeJson(result, result.ok ? 200 : 400);
      }
      const compFailMatch = pathname.match(/^\/completions\/([^/]+)\/fail$/);
      if (compFailMatch && method === "POST") {
        const denied = requireAuth();
        if (denied)
          return denied;
        const completionId = compFailMatch[1];
        const body = await req.json().catch(() => ({}));
        const error = body.error ?? "Unknown error";
        const result = completionQueue.markFailedAndBlockJob(completionId, error, {
          installDurationMs: typeof body.trustedInstallDurationMs === "number" ? body.trustedInstallDurationMs : null,
          validationDurationMs: typeof body.trustedValidationDurationMs === "number" ? body.trustedValidationDurationMs : null,
          installCacheHit: typeof body.trustedValidationCacheHit === "boolean" ? body.trustedValidationCacheHit : null
        });
        if (result.ok && result.jobTransitioned && result.jobId) {
          const job = jobQueue.getJob(result.jobId);
          const params = parseJsonRecord2(job?.params ?? "");
          const origin = deriveJobOrigin(params);
          const requestId = compactText3(params.requestId, 128);
          const outcomeContext = autonomyStore.resolveJobOutcomeContext(result.jobId, params);
          if (outcomeContext) {
            autonomyStore.recordOutcome({
              objectiveId: outcomeContext.objectiveId,
              requestId: outcomeContext.requestId ?? requestId,
              jobId: result.jobId,
              patternKey: outcomeContext.patternKey,
              success: false,
              latencyMs: result.durationMs ?? null,
              userAction: "failed",
              reopenedWithin24h: false,
              regressionFlag: true
            });
          }
          if (job?.sessionId) {
            const session = sessionManager.getSession(job.sessionId);
            session?.emit({
              protocolVersion: PROTOCOL_VERSION,
              id: randomUUID6(),
              ts: new Date().toISOString(),
              sessionId: job.sessionId,
              type: "job_failed",
              from: "server:completion-fail-hook",
              payload: {
                jobId: result.jobId,
                message: "Candidate publication failed",
                origin,
                detail: compactText3(error, 600)
              }
            });
          }
          console.warn(`[Server] Job ${result.jobId} publish-blocked: ${error}`);
        }
        return makeJson(result, result.ok ? 200 : 400);
      }
      return makeJson({ ok: false, message: "Not found" }, 404);
    },
    websocket: {
      open(ws) {
        const { sessionId, afterEventId = 0, client, clientConnectionId } = ws.data || {};
        console.log(`[WS] Session ${sessionId} connected (after=${afterEventId})`);
        if (client) {
          clientPresence.connect(sessionId, client, "ws", clientConnectionId);
        }
        const heartbeatTimer = setInterval(() => {
          try {
            ws.ping("pushpals");
          } catch {
            try {
              clearInterval(heartbeatTimer);
            } catch {}
          }
        }, CLIENT_TRANSPORT_HEARTBEAT_MS);
        heartbeatTimer.unref?.();
        ws.data = { ...ws.data || {}, heartbeatTimer };
        const session = sessionManager.getSession(sessionId);
        if (!session) {
          try {
            const envelope = {
              protocolVersion: PROTOCOL_VERSION,
              id: randomUUID6(),
              ts: new Date().toISOString(),
              sessionId,
              type: "error",
              payload: { message: "Session not found" }
            };
            ws.send(JSON.stringify({ envelope, cursor: 0 }));
          } catch (_e) {}
          try {
            ws.close();
          } catch (_e) {}
          return;
        }
        session.replayHistory((envelope, eventId) => {
          try {
            ws.send(JSON.stringify({ envelope, cursor: eventId }));
          } catch (_e) {}
        }, afterEventId);
        const unsubscribe = session.subscribe((envelope, eventId) => {
          try {
            ws.send(JSON.stringify({ envelope, cursor: eventId }));
          } catch (_err) {
            try {
              unsubscribe();
            } catch (_e) {}
          }
        });
        ws.data = { sessionId, unsubscribe, client, clientConnectionId };
      },
      close(ws) {
        const { sessionId, unsubscribe, client, clientConnectionId, heartbeatTimer } = ws.data || {};
        console.log(`[WS] Session ${sessionId} disconnected`);
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
        }
        if (client) {
          clientPresence.disconnect(client.clientId, "ws", clientConnectionId);
        }
        if (unsubscribe) {
          try {
            unsubscribe();
          } catch (_e) {}
        }
      },
      message(ws, message) {
        const { sessionId, client, clientConnectionId } = ws.data || {};
        console.log(`[WS] Session ${sessionId} message:`, message);
        if (client) {
          clientPresence.touch(client.clientId, "ws", clientConnectionId);
        }
      },
      pong(ws) {
        const { client, clientConnectionId } = ws.data || {};
        if (client) {
          clientPresence.touch(client.clientId, "ws", clientConnectionId);
        }
      }
    }
  });
}
if (import.meta.main) {
  const server = createRequestHandler();
  console.log(`[Server] PushPals listening on ${server.url}`);
}
export {
  sessionMessageResultStatus,
  sessionManager,
  jobQueue,
  createRequestHandler,
  autonomyStore
};
