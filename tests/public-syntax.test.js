/**
 * Syntax smoketest for the shipped browser modules (`public/*.js`):
 * every file must parse as an ES module. Catches template-literal
 * breakage — e.g. a Markdown backtick inside a `<style>` comment
 * terminates the template and kills the whole component — which text
 * pins and unit tests never see, because the module never loads.
 *
 * Uses `vm.SourceTextModule`, which parses the module record without
 * executing it (top-level `document` access would throw in Node).
 * The flag gate keeps the suite green when Node runs without it.
 *
 * Run the suite with `node --test --experimental-vm-modules` to arm it
 * (the npm test script does).
 *
 * @file public-syntax.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

test("every shipped public module parses as ESM", (t) => {
  if (typeof vm.SourceTextModule !== "function") {
    t.skip("needs --experimental-vm-modules");
    return;
  }
  const root = path.join(__dirname, "..", "public");
  const walk = (dir) =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((e) =>
        e.isDirectory()
          ? walk(path.join(dir, e.name))
          : e.name.endsWith(".js")
            ? [path.join(dir, e.name)]
            : [],
      );
  const files = walk(root);
  assert.ok(files.length > 10, "public modules discovered");
  for (const file of files) {
    const code = fs.readFileSync(file, "utf8");
    try {
      // Parses the module record — throws SyntaxError on broken source,
      // without evaluating it (safe for DOM-typed top-level code).
      new vm.SourceTextModule(code, { identifier: file });
    } catch (err) {
      throw new Error(
        `${path.relative(root, file)} does not parse: ${err.message}`,
        { cause: err },
      );
    }
  }
});
