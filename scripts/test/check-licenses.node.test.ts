import { describe, expect, it } from "vitest";
import { checkLicenses, isAllowedExpression, LICENSE_EXCEPTIONS } from "../check-licenses.ts";

const pkg = (name: string, version = "1.0.0") => ({ name, versions: [version] });

describe("scripts/check-licenses.ts — checkLicenses", () => {
  it("ALL_ALLOWED: only allowlisted SPDX keys and expressions of them pass", () => {
    const offenders = checkLicenses({
      MIT: [pkg("a")],
      ISC: [pkg("b")],
      "Apache-2.0": [pkg("c")],
      "BSD-2-Clause": [pkg("d")],
      "BSD-3-Clause": [pkg("e")],
      "0BSD": [pkg("f")],
      "MPL-2.0": [pkg("g")],
      "CC0-1.0": [pkg("h")],
      "CC-BY-4.0": [pkg("i")],
      Unlicense: [pkg("j")],
      "MIT-0": [pkg("k")],
      "BlueOak-1.0.0": [pkg("l")],
      "Python-2.0": [pkg("m")],
      "MIT OR Apache-2.0": [pkg("n")],
      "(MIT AND Zlib)": [pkg("pako")],
      "MIT AND BSD-3-Clause": [pkg("o")],
    });
    expect(offenders).toEqual([]);
  });

  it("OR_EXPRESSION: any allowed alternative suffices", () => {
    expect(checkLicenses({ "MIT OR GPL-3.0": [pkg("dual")] })).toEqual([]);
    expect(checkLicenses({ "(GPL-3.0 OR MIT)": [pkg("dual2")] })).toEqual([]);
  });

  it("AND_EXPRESSION: Apache-2.0 AND LGPL-3.0-or-later passes only via the @img/sharp- exception", () => {
    const license = "Apache-2.0 AND LGPL-3.0-or-later";
    expect(checkLicenses({ [license]: [pkg("@img/sharp-win32-x64"), pkg("@img/sharp-linux-x64")] })).toEqual([]);
    expect(checkLicenses({ [license]: [pkg("not-sharp")] })).toEqual([{ name: "not-sharp", version: "1.0.0", license }]);
  });

  it("AND_EXPRESSION: standalone LGPL-3.0-or-later passes only via the @img/sharp-libvips- exception", () => {
    const license = "LGPL-3.0-or-later";
    expect(checkLicenses({ [license]: [pkg("@img/sharp-libvips-linux-x64"), pkg("@img/sharp-libvips-linuxmusl-x64")] })).toEqual([]);
    expect(checkLicenses({ [license]: [pkg("@img/sharp-linux-x64")] })).toEqual([{ name: "@img/sharp-linux-x64", version: "1.0.0", license }]);
  });

  it("GROUPING: parentheses are respected and AND binds tighter than OR", () => {
    expect(isAllowedExpression("(MIT OR Apache-2.0) AND Unicode-DFS-2016")).toBe(false);
    expect(isAllowedExpression("(MIT OR GPL-3.0) AND SSPL-1.0")).toBe(false);
    expect(isAllowedExpression("(MIT AND Zlib)")).toBe(true);
    expect(isAllowedExpression("(GPL-3.0 OR MIT)")).toBe(true);
    expect(isAllowedExpression("GPL-3.0 OR MIT AND ISC")).toBe(true);
    expect(isAllowedExpression("MIT OR GPL-3.0 AND SSPL-1.0")).toBe(true);
  });

  it("MALFORMED: unbalanced or dangling expressions fail closed", () => {
    for (const bad of ["", "(MIT", "MIT)", "MIT OR", "AND MIT", "MIT AND (ISC", "()"]) {
      expect(isAllowedExpression(bad), bad).toBe(false);
    }
  });

  it("DENIED: GPL-3.0, AGPL-3.0 and SSPL-1.0 are reported with name, version and licence", () => {
    const offenders = checkLicenses({
      "GPL-3.0": [pkg("gpl-pkg", "2.0.0")],
      "AGPL-3.0": [pkg("agpl-pkg", "3.1.0")],
      "SSPL-1.0": [pkg("sspl-pkg", "0.1.0")],
      MIT: [pkg("fine")],
    });
    expect(offenders).toEqual([
      { name: "gpl-pkg", version: "2.0.0", license: "GPL-3.0" },
      { name: "agpl-pkg", version: "3.1.0", license: "AGPL-3.0" },
      { name: "sspl-pkg", version: "0.1.0", license: "SSPL-1.0" },
    ]);
  });

  it("UNKNOWN: Unknown and non-SPDX strings fail without an exception", () => {
    const offenders = checkLicenses({
      Unknown: [pkg("mystery")],
      "BDS-3-Clause": [pkg("other-typo")],
      BSD: [pkg("vague")],
    });
    expect(offenders.map((o) => o.name)).toEqual(["mystery", "other-typo", "vague"]);
  });

  it("NAMED_EXCEPTION: splaytree-ts and wellknown pass, each with a reason", () => {
    expect(checkLicenses({ "BDS-3-Clause": [pkg("splaytree-ts", "1.0.2")], BSD: [pkg("wellknown", "0.5.0")] })).toEqual([]);
    for (const e of LICENSE_EXCEPTIONS) {
      expect(e.reason.trim().length).toBeGreaterThan(0);
    }
  });
});
