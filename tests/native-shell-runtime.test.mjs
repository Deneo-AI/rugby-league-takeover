/**
 * Runtime (window-dependent) half of the native shell helpers. The pure
 * classifiers are covered in native-env/native-guards/native-shell-polish;
 * this file drives the branches that read `window.Capacitor` or fall back to
 * web behaviour, by injecting a fake global window.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isNativeApp, getPlatform, isIos, isWeb } from "../src/lib/native/native-env.js";
import { initDeepLinks } from "../src/lib/native/deep-links.js";
import { openExternalUrl, openSystemUrl } from "../src/lib/native/open-external.js";

const setWindow = (win) => {
  if (win === undefined) delete globalThis.window;
  else globalThis.window = win;
};

const nativeWindow = (platform = "ios") => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => platform },
});

test.afterEach(() => setWindow(undefined));

test("with no window at all (SSR/build) every helper reports web", () => {
  setWindow(undefined);
  assert.equal(isNativeApp(), false);
  assert.equal(getPlatform(), "web");
  assert.equal(isIos(), false);
  assert.equal(isWeb(), true);
});

test("a browser window without the Capacitor bridge reports web", () => {
  setWindow({});
  assert.equal(isNativeApp(), false);
  assert.equal(getPlatform(), "web");
  assert.equal(isIos(), false);
  assert.equal(isWeb(), true);
});

test("the injected iOS bridge is reported as native iOS", () => {
  setWindow(nativeWindow("ios"));
  assert.equal(isNativeApp(), true);
  assert.equal(getPlatform(), "ios");
  assert.equal(isIos(), true);
  assert.equal(isWeb(), false);
});

test("a non-iOS native bridge is native but not iOS", () => {
  setWindow(nativeWindow("android"));
  assert.equal(isNativeApp(), true);
  assert.equal(getPlatform(), "android");
  assert.equal(isIos(), false);
  assert.equal(isWeb(), false);
});

test("initDeepLinks is an inert no-op on the web", () => {
  setWindow({});
  const cleanup = initDeepLinks(() => assert.fail("navigate must not be called on the web"));
  assert.equal(typeof cleanup, "function");
  assert.doesNotThrow(() => cleanup());
});

test("initDeepLinks refuses to install without a navigate callback", () => {
  setWindow(nativeWindow());
  for (const navigate of [undefined, null, "/forum"]) {
    const cleanup = initDeepLinks(navigate);
    assert.equal(typeof cleanup, "function", "callers always get a cleanup function to run on unmount");
    assert.doesNotThrow(() => cleanup());
  }
});

test("openSystemUrl only engages the OS handler in the native shell", async () => {
  setWindow({});
  assert.equal(await openSystemUrl("mailto:hello@rugbyleaguetakeover.com"), false);
  assert.equal(await openSystemUrl(""), false);
  assert.equal(await openSystemUrl(undefined), false);
});

test("openExternalUrl opens a new tab on the web by default", async () => {
  const opened = [];
  setWindow({ open: (...args) => opened.push(args), location: {} });

  assert.equal(await openExternalUrl("https://checkout.stripe.com/c/pay/x"), true);
  assert.deepEqual(opened, [["https://checkout.stripe.com/c/pay/x", "_blank", "noopener,noreferrer"]]);
  assert.equal(globalThis.window.location.href, undefined, "a new tab must not navigate the current page");
});

test("the navigate fallback replaces the current page for checkout redirects", async () => {
  setWindow({ open: () => assert.fail("navigate fallback must not open a tab"), location: {} });

  assert.equal(await openExternalUrl("https://checkout.stripe.com/c/pay/x", { fallback: "navigate" }), true);
  assert.equal(globalThis.window.location.href, "https://checkout.stripe.com/c/pay/x");
});

test("openExternalUrl reports failure for an empty url or a missing window", async () => {
  setWindow({ open: () => assert.fail("no url means nothing to open"), location: {} });
  assert.equal(await openExternalUrl(""), false);
  assert.equal(await openExternalUrl(null), false);

  setWindow(undefined);
  assert.equal(await openExternalUrl("https://rugbyleaguetakeover.com/store"), false);
});
