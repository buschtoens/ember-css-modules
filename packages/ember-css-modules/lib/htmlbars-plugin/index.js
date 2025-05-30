'use strict';

const utils = require('./utils');

module.exports = class ClassTransformPlugin {
  constructor(env, options) {
    this.syntax = env.syntax;
    this.builders = env.syntax.builders;
    this.options = options;
    this.stylesModule = this.determineStylesModule(env);
    this.visitor = this.buildVisitor(env);
  }

  static instantiate(options) {
    return {
      name: 'ember-css-modules',
      plugin: (env) => new this(env, options),
      parallelBabel: {
        requireFile: __filename,
        buildUsing: 'instantiate',
        params: options,
      },
      baseDir() {
        return `${__dirname}/../..`;
      },
    };
  }

  determineStylesModule(env) {
    if (!env || !env.moduleName) return;

    let includeExtension = this.options.includeExtensionInModulePath;
    let name = env.moduleName.replace(/\.\w+$/, '');

    if (name.endsWith('template')) {
      name = name.replace(/template$/, 'styles');
    } else if (name.includes('/templates/')) {
      name = name.replace('/templates/', '/styles/');
    } else if (name.includes('/components/')) {
      includeExtension = true;
    }

    if (includeExtension) {
      name = `${name}.${this.options.fileExtension}`;
    }

    return name;
  }

  buildVisitor(env) {
    if (env.moduleName === env.filename) {
      // No-op for the stage 1 Embroider pass (which only contains relative paths)
      return {};
    }

    return {
      ElementNode: (node) => this.transformElementNode(node),
      MustacheStatement: (node) => this.transformStatement(node),
      BlockStatement: (node) => this.transformStatement(node),
      SubExpression: (node) => this.transformSubexpression(node),
    };
  }

  transformStatement(node) {
    if (getValue(node.path) === 'local-class') {
      this.transformLocalClassHelperInvocation(node);
    } else {
      this.transformPossibleComponentInvocation(node);
    }
  }

  transformSubexpression(node) {
    if (getValue(node.path) === 'local-class') {
      this.transformLocalClassHelperInvocation(node);
    }
  }

  // Transform {{local-class 'foo'}} into {{local-class 'foo' from='path/to/styles-module'}}
  transformLocalClassHelperInvocation(node) {
    if (utils.getPair(node, 'from')) {
      return;
    }

    node.hash.pairs.push(this.builders.pair('from', this.stylesModuleNode()));
  }

  transformPossibleComponentInvocation(node) {
    let localClassPair = utils.getPair(node, 'local-class');
    if (!localClassPair) {
      return;
    }

    utils.removePair(node, localClassPair);

    let classPair = utils.getPair(node, 'class');
    let params = [];
    let concatSexpr;

    if (classPair) {
      params.push(classPair.value);
      utils.removePair(node, classPair);
    }

    utils.pushAll(params, this.localToPath(localClassPair.value));
    this.divide(params, 'string');
    concatSexpr = this.builders.sexpr(this.builders.path('concat'), params);
    node.hash.pairs.push(this.builders.pair('class', concatSexpr));
  }

  transformElementNode(node) {
    let localClassAttr = utils.getAttr(node, 'local-class');
    if (!localClassAttr) {
      return;
    }

    utils.removeAttr(node, localClassAttr);

    let classAttr = utils.getAttr(node, 'class');
    let parts = [];
    let classAttrValue;

    if (classAttr) {
      utils.removeAttr(node, classAttr);
      classAttrValue = classAttr.value;

      // Unwrap the original class attribute value and transform
      // the attr value into parts that make up the ConcatStatement
      // that is returned from this method
      if (classAttrValue.type === 'ConcatStatement') {
        parts.push(
          this.builders.mustache(
            this.builders.path('concat'),
            utils.concatStatementToParams(this.builders, classAttrValue)
          )
        );
      } else if (classAttrValue.type === 'TextNode') {
        parts.push(this.builders.text(classAttrValue.chars));
      } else if (classAttrValue.type === 'MustacheStatement') {
        parts.push(classAttrValue);
      }
    }

    utils.pushAll(parts, this.localToPath(localClassAttr.value));
    this.divide(parts, 'text');

    let newClassAttr = this.builders.attr('class', this.builders.concat(parts));
    node.attributes.unshift(newClassAttr);

    // In new-enough versions of Ember (>= 3.25 or so), we need to create a
    // fake good-enough `loc` whose content will start with `class=` to avoid
    // triggering https://github.com/emberjs/ember.js/issues/19392
    if (typeof localClassAttr.loc.slice === 'function') {
      newClassAttr.loc = localClassAttr.loc.slice({
        skipStart: 'local-'.length,
      });
    }
  }

  localToPath(node) {
    if (~['SubExpression', 'MustacheStatement'].indexOf(node.type)) {
      return this.dynamicLocalPath(node);
    } else if (node.type === 'ConcatStatement') {
      return this.concatLocalPath(node);
    } else if (~['TextNode', 'StringLiteral'].indexOf(node.type)) {
      return this.staticLocalPath(node);
    } else {
      throw new TypeError(
        'ember-css-modules - invalid type, ' +
          node.type +
          ', passed to local-class attribute.'
      );
    }
  }

  dynamicLocalPath(node) {
    let localClassPath = this.builders.path('local-class');

    let builder;
    if (node.type === 'SubExpression') {
      builder = 'sexpr';
    } else if (node.type === 'MustacheStatement') {
      node = utils.mustacheToSexpr(this.builders, node);
      builder = 'mustache';
    }

    let hash = this.builders.hash([
      this.builders.pair('from', this.stylesModuleNode()),
    ]);
    let localClassInvocation = this.builders[builder](
      localClassPath,
      [node],
      hash
    );

    return [localClassInvocation];
  }

  stylesModuleNode() {
    if (!this.stylesModule) {
      throw new Error(
        'Unable to bind a local class in a template with an unknown moduleName'
      );
    }

    return this.builders.string(this.stylesModule);
  }

  concatLocalPath(node) {
    let concatPath = this.builders.path('concat');
    let concatParts = utils.concatStatementToParams(this.builders, node);
    let concatStatement = this.builders.mustache(concatPath, concatParts);
    return this.dynamicLocalPath(concatStatement);
  }

  staticLocalPath(node) {
    let locals = typeof node.chars === 'string' ? node.chars : node.value;
    let exprBuilder = typeof node.chars === 'string' ? 'mustache' : 'sexpr';

    return [
      this.builders[exprBuilder](
        'local-class',
        [this.builders.string(locals)],
        this.builders.hash([
          this.builders.pair('from', this.stylesModuleNode()),
        ])
      ),
    ];
  }

  divide(parts, builder) {
    for (let i = 0; i < parts.length - 1; i++) {
      if (~['StringLiteral', 'TextNode'].indexOf(parts[i].type)) {
        utils.updateStringValue(parts[i], function (str) {
          return str + ' ';
        });
      } else if (~['StringLiteral', 'TextNode'].indexOf(parts[i + 1].type)) {
        utils.updateStringValue(parts[i + 1], function (str) {
          return ' ' + str;
        });
      } else {
        parts.splice(i + 1, 0, this.builders[builder](' '));
        i++;
      }
    }

    return parts;
  }
};

function getValue(path) {
  if (!path) return;

  if ('value' in path) {
    return path.value;
  }

  /**
   * Deprecated in ember 5.9+
   * (so we use the above for newer embers)
   */
  return path.original;
}
