import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { scanScope, selectFiles } from "../src/detector.ts";
import { DEFAULTS, tempTree, write } from "./helpers.ts";

const defaults = { ...DEFAULTS, format: "typescript" };
const scope = { scan_path: "src", pattern: "**/*.{ts,tsx,mts,cts,jsx,go,py}", ignore: [] };
const component = `type Props = { title: string; value: number };
export function Summary({ title, value }: Props) {
  const label = value > 0 ? "Active" : "Pending";
  return (
    <>
      <section aria-label={title}>
        <header><h2>{title}</h2></header>
        <dl>
          <dt>Status</dt><dd>{label}</dd>
          <dt>Total</dt><dd>{value.toFixed(2)}</dd>
        </dl>
        <footer><button type="button" disabled={value === 0}>Continue</button></footer>
      </section>
    </>
  );
}
`;

function fixture() {
  const root = tempTree();
  write(join(root, "src/value.ts"), "export const value = 42;\n");
  write(join(root, "src/a.tsx"), component);
  write(join(root, "src/b.tsx"), component);
  write(join(root, ".slop/config.yml"), `schema: 1
detector: { name: jscpd, version: "4.2.5" }
defaults: { format: typescript, mode: mild, min_lines: 5, min_tokens: 50 }
scopes:
  production:
    scan_path: src
    pattern: "**/*.{ts,tsx}"
`);
  write(join(root, ".slop/ceilings.yml"), "schema: 1\nscopes:\n  production:\n    active_clones_ceiling: 0\n");
  write(join(root, ".slop/tombstones/.keep"), "");
  return root;
}

// The same acceptance runs against the source CLI and the packaged Node entry.
function cli(root: string, enforce = false) {
  const entry = process.env.SLOPSLINT_TEST_CLI;
  const command = entry ? ["node", entry] : [process.execPath, join(import.meta.dir, "../src/cli.ts")];
  const result = Bun.spawnSync([...command, "check", "--classify", ...(enforce ? ["--enforce"] : []), "--repo-root", root]);
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

describe("TypeScript and TSX coverage", () => {
  test("a mixed scope includes TSX, retains TS variants, and excludes unrelated formats", () => {
    const root = fixture();
    for (const name of ["module.mts", "common.cts", "view.jsx", "other.go", "other.py"]) {
      write(join(root, "src", name), component);
    }
    expect(selectFiles(scope, defaults, [], root)).toEqual([
      "src/a.tsx", "src/b.tsx", "src/common.cts", "src/module.mts", "src/value.ts",
    ]);
    expect(selectFiles(scope, { ...defaults, format: "tsx" }, [], root)).toEqual(["src/a.tsx", "src/b.tsx"]);
    for (const [format, file] of [["jsx", "view.jsx"], ["go", "other.go"], ["python", "other.py"]] as const) {
      expect(selectFiles(scope, { ...defaults, format }, [], root)).toEqual([`src/${file}`]);
    }
  });

  test("TSX duplicates have real paths and forward ranges; production, tests and ignored files stay separate", () => {
    const root = fixture();
    write(join(root, "src/a.test.tsx"), component);
    write(join(root, "src/generated/ignored.tsx"), component);
    const production = { ...scope, ignore: ["**/*.test.tsx"] };
    const report = scanScope("production", production, defaults, ["**/generated/**"], root);
    expect(report.statistics.sources).toBe(3);
    expect(report.statistics.clones).toBeGreaterThan(0);
    expect([...new Set(report.duplicates.flatMap((d) => [d.firstFile.name, d.secondFile.name]))].sort())
      .toEqual(["src/a.tsx", "src/b.tsx"]);
    for (const clone of report.duplicates) {
      expect(clone.lines).toBeGreaterThanOrEqual(5);
      expect(clone.tokens).toBeGreaterThanOrEqual(50);
      expect(clone.firstFile.end).toBeGreaterThanOrEqual(clone.firstFile.start);
      expect(clone.secondFile.end).toBeGreaterThanOrEqual(clone.secondFile.start);
    }
    const tests = scanScope("tests", { ...scope, pattern: "**/*.test.tsx" }, defaults, [], root);
    expect(tests.statistics.sources).toBe(1);
    expect(tests.statistics.clones).toBe(0);
    const standalone = scanScope("tsx", { ...scope, pattern: "[ab].tsx" }, { ...defaults, format: "tsx" }, [], root);
    expect(standalone.duplicates).toEqual(report.duplicates);
  });

  test("real CLI rejects duplicated TSX, then passes extraction with the same zero ceiling and counted TSX", () => {
    const root = fixture();
    const red = cli(root, true);
    expect(red.code).toBe(1);
    expect(red.err).toContain("exceeding");
    const measured = cli(root);
    expect(measured.code).toBe(0);
    const before = JSON.parse(measured.out).scopes[0];
    expect(before.statistics.total_sources).toBe(3);
    expect(before.statistics.active_clones).toBeGreaterThan(0);
    expect(cli(root).out).toBe(measured.out);

    write(join(root, "src/shared.tsx"), component);
    write(join(root, "src/a.tsx"), 'export { Summary as Primary } from "./shared";\n');
    write(join(root, "src/b.tsx"), 'export { Summary as Secondary } from "./shared";\n');
    const green = cli(root, true);
    expect(green.code).toBe(0);
    expect(green.err).toBe("");
    const after = JSON.parse(green.out).scopes[0];
    expect(after.statistics.total_sources).toBe(4);
    expect(after.statistics.active_clones).toBe(0);
  });
});
