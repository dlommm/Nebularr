/**
 * Minimal, dependency-free stand-in for `eslint-plugin-react`'s
 * `react/no-unstable-nested-components` (that plugin isn't a project
 * dependency, and adding one is out of scope here) — flags a PascalCase
 * function defined inside the body of another PascalCase function.
 *
 * A component defined inside another component's render body is a brand new
 * function identity on every render, so React remounts (and drops all state
 * and focus in) its whole subtree — see AppLayout's old inline `NavLinks`
 * for a real example of the bug this catches.
 */

const PASCAL_CASE = /^[A-Z][A-Za-z0-9]*$/;

function isComponentName(name) {
  return typeof name === "string" && PASCAL_CASE.test(name);
}

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

function enclosingFunction(node) {
  let current = node.parent;
  while (current) {
    if (FUNCTION_TYPES.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}

function functionName(node) {
  if (!node) return null;
  if (node.id?.name) return node.id.name;
  if (node.parent?.type === "VariableDeclarator" && node.parent.id.type === "Identifier") {
    return node.parent.id.name;
  }
  return null;
}

/** @type {import("eslint").ESLint.Plugin} */
export default {
  rules: {
    "no-unstable-nested-components": {
      meta: {
        type: "problem",
        docs: {
          description: "Disallow defining a component inside another component's body",
        },
        schema: [],
        messages: {
          nested:
            "'{{name}}' is defined inside component '{{outerName}}' and is recreated on every render, remounting its subtree. Hoist it to module scope.",
        },
      },
      create(context) {
        function check(node, name) {
          if (!isComponentName(name)) return;
          const outer = enclosingFunction(node);
          const outerName = functionName(outer);
          if (outer && isComponentName(outerName)) {
            context.report({ node, messageId: "nested", data: { name, outerName } });
          }
        }

        return {
          FunctionDeclaration(node) {
            check(node, node.id?.name);
          },
          VariableDeclarator(node) {
            if (
              node.init &&
              (node.init.type === "ArrowFunctionExpression" || node.init.type === "FunctionExpression") &&
              node.id.type === "Identifier"
            ) {
              check(node.init, node.id.name);
            }
          },
        };
      },
    },
  },
};
