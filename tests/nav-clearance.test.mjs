import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// Owner report: "nav is cutting off text". The site header is FIXED at the top
// (SiteNav), so every routed page pads itself clear of it. Measured in a 390px
// browser the header is 80px tall (5rem) — Forum was padding 4.5rem (72px) on
// mobile, so its "FAN DISCUSSION BOARD" eyebrow rendered 5px UNDER the nav and
// was sliced in half. sm/md breakpoints were already fine, which is why it only
// showed on phones.
//
// env(safe-area-inset-top) is added to BOTH the header and the page padding, so
// it cancels out — the rem value alone decides the clearance.

const NAV_HEIGHT_REM = 5; // 80px measured at a 390px viewport
const MIN_CLEARANCE_REM = 6; // nav + breathing room

// The FIRST pt-[calc(...)] on a page is its mobile (unprefixed) value.
function mobileClearanceRem(src) {
  const m = src.match(/(?<!:)pt-\[calc\(([0-9.]+)rem\+env\(safe-area-inset-top/);
  return m ? Number(m[1]) : null;
}

test("the site header is still fixed — pages must clear it themselves", () => {
  const nav = read("../src/components/public/SiteNav.jsx");
  assert.match(nav, /fixed top-0 left-0 right-0/, "header is fixed, so content can slide under it");
});

for (const page of ["Forum", "News", "Store", "Gallery", "Faq"]) {
  test(`${page} clears the fixed nav on mobile`, () => {
    const rem = mobileClearanceRem(read(`../src/pages/${page}.jsx`));
    assert.ok(rem !== null, `${page} declares a mobile nav clearance`);
    assert.ok(
      rem >= MIN_CLEARANCE_REM,
      `${page} pads ${rem}rem but the nav is ${NAV_HEIGHT_REM}rem — text would be clipped`
    );
  });
}

test("Forum specifically is no longer clipped", () => {
  // Regression guard on the exact value that caused the report.
  const forum = read("../src/pages/Forum.jsx");
  const rem = mobileClearanceRem(forum);
  assert.ok(rem >= 6.5, `Forum mobile clearance is ${rem}rem; it was 4.5rem when the eyebrow was sliced`);
});
