import sharp from "sharp";
import { totp } from "../server/auth.js";
import JSZip from "jszip";
import { catalogFixture } from "../test/catalog-fixture.js";
import { chromium } from "@playwright/test";
import { createBackend } from "../server/backend.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "moss-browser-"));
const backend = await createBackend({
  dataDir: root,
  java: path.resolve("test/fake-java.js"),
  token: "browser-test-token",
  fetcher: catalogFixture,
});
await new Promise((r) => backend.server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${backend.server.address().port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
const remote = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  if (!r.url().startsWith(base) && !r.url().startsWith("data:"))
    remote.push(r.url());
});
page.on("console", (m) => {
  if (m.type() === "error") console.log("BROWSER:", m.text().slice(0, 400));
});
try {
  await fs.mkdir("artifacts", { recursive: true });
  await page.goto(base);
  await page.screenshot({ path: "artifacts/login.png", fullPage: true });
  await page
    .getByRole("button", { name: "Create an account", exact: true })
    .click();
  await page.getByPlaceholder("Username", { exact: true }).fill("browseruser");
  await page
    .getByPlaceholder("Password", { exact: true })
    .fill("browser password long enough");
  await page
    .getByPlaceholder("Confirm password", { exact: true })
    .fill("browser password long enough");
  await page
    .getByPlaceholder("Admin key", { exact: true })
    .fill("browser-test-token");
  await page
    .getByRole("button", { name: "Set up authenticator", exact: true })
    .click();
  await page.getByText("Enter a setup key manually", { exact: true }).click();
  await page.screenshot({
    path: "artifacts/account-setup.png",
    fullPage: true,
  });
  const secret = await page.getByTestId("totp-secret").textContent();
  await page.getByPlaceholder("6-digit code").fill(totp(secret));
  await page
    .getByRole("button", { name: "Verify and create account", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Save your recovery codes" })
    .waitFor();
  const recoveryCodes = await page.locator("section code").allTextContents();
  await page
    .getByRole("checkbox", { name: "I saved my recovery codes somewhere safe" })
    .check();
  await page.getByRole("button", { name: "Continue to servers" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByPlaceholder("Username", { exact: true }).fill("browseruser");
  await page
    .getByPlaceholder("Password", { exact: true })
    .fill("browser password long enough");
  await page
    .getByPlaceholder("Authenticator or recovery code")
    .fill(totp(secret));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Your servers" }).waitFor();
  await page
    .getByRole("button", { name: "Create server", exact: true })
    .click();
  await page.getByPlaceholder("My survival server").fill("Local survival");
  const worldZip = new JSZip();
  worldZip.file("My survival/level.dat", "test level fixture");
  worldZip.file("My survival/region/r.0.0.mca", "test region fixture");
  await page.getByLabel("Existing world ZIP (optional)").setInputFiles({
    name: "world.zip",
    mimeType: "application/zip",
    buffer: await worldZip.generateAsync({ type: "nodebuffer" }),
  });
  await page.getByRole("checkbox").check();
  await page.screenshot({
    path: "artifacts/world-creation.png",
    fullPage: true,
  });
  await page
    .locator("form")
    .getByRole("button", { name: "Create server", exact: true })
    .click();
  await page.getByRole("heading", { name: "Console", exact: true }).waitFor();
  const icon = await sharp({
    create: { width: 80, height: 120, channels: 3, background: "#18b75b" },
  })
    .png()
    .toBuffer();
  const iconChooser = page.waitForEvent("filechooser");
  await page
    .getByRole("button", {
      name: "Change icon for Local survival",
      exact: true,
    })
    .click();
  await (
    await iconChooser
  ).setFiles({ name: "custom-icon.png", mimeType: "image/png", buffer: icon });
  await page
    .getByText(
      "Server icon updated. Minecraft will use it the next time the server starts.",
      { exact: true },
    )
    .waitFor();
  await page
    .getByRole("img", { name: "Local survival icon", exact: true })
    .waitFor();
  await page.reload();
  await page
    .getByRole("img", { name: "Local survival icon", exact: true })
    .waitFor();
  await page.getByRole("link", { name: "Moss", exact: true }).click();
  await page
    .getByRole("img", { name: "Local survival icon", exact: true })
    .waitFor();
  const listChooser = page.waitForEvent("filechooser");
  await page
    .getByRole("button", {
      name: "Change icon for Local survival",
      exact: true,
    })
    .click();
  await (
    await listChooser
  ).setFiles({ name: "replacement.png", mimeType: "image/png", buffer: icon });
  await page
    .getByText(
      "Server icon updated. Minecraft will use it the next time the server starts.",
      { exact: true },
    )
    .waitFor();
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await page.getByRole("link", { name: /Local survival.*Java server/ }).click();
  await page.waitForTimeout(1200);
  await fs.mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/overview.png", fullPage: true });

  const id = page.url().split("/").at(-1);
  const gameIcon = await sharp(
    path.join(root, "servers", id, "server-icon.png"),
  ).metadata();
  assert.equal(gameIcon.format, "png");
  assert.equal(gameIcon.width, 64);
  assert.equal(gameIcon.height, 64);
  assert.equal(
    await fs.readFile(
      path.join(root, "servers", id, "world", "region", "r.0.0.mca"),
      "utf8",
    ),
    "test region fixture",
  );
  assert.match(
    await fs.readFile(
      path.join(root, "servers", id, "server.properties"),
      "utf8",
    ),
    /level-name=world/,
  );
  await fs.writeFile(
    path.join(root, "servers", id, "server.jar"),
    "test fixture",
  );
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByPlaceholder("Send a command", { exact: true }).waitFor();
  await page
    .getByPlaceholder("Send a command", { exact: true })
    .fill("say browser test");
  await page.getByPlaceholder("Send a command", { exact: true }).press("Enter");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("link", { name: "Files", exact: true }).click();
  await page.getByText("server.properties", { exact: true }).waitFor();
  await page.screenshot({ path: "artifacts/files.png", fullPage: true });
  await page
    .getByRole("button", { name: "Create new...", exact: true })
    .click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByText("Upload file", { exact: true }).click();
  await (
    await chooserPromise
  ).setFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Uploaded through original UI"),
  });
  await page.getByText("notes.txt", { exact: true }).waitFor();
  assert.equal(
    await fs.readFile(path.join(root, "servers", id, "notes.txt"), "utf8"),
    "Uploaded through original UI",
  );
  await page.getByText("server.properties", { exact: true }).dblclick();
  await page.waitForTimeout(700);
  await page.locator(".ace_text-input").focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(
    "server-port=25565\nmotd=Edited in browser\nonline-mode=true\n",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Your file has been saved.", { exact: true }).waitFor();
  assert.match(
    await fs.readFile(
      path.join(root, "servers", id, "server.properties"),
      "utf8",
    ),
    /Edited in browser/,
  );
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await page.getByRole("link", { name: "Backups", exact: true }).click();
  await page
    .getByRole("button", { name: "Create backup", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Restore backup", exact: true })
    .waitFor();
  await fs.writeFile(
    path.join(root, "servers", id, "notes.txt"),
    "Changed after backup",
  );
  page.once("dialog", (dialog) => dialog.accept());
  const restored = page.waitForResponse(
    (r) => r.url().endsWith("/restore") && r.status() === 200,
  );
  await page
    .getByRole("button", { name: "Restore backup", exact: true })
    .click();
  await restored;
  assert.equal(
    await fs.readFile(path.join(root, "servers", id, "notes.txt"), "utf8"),
    "Uploaded through original UI",
  );
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page
    .getByLabel("Server name", { exact: true })
    .fill("Renamed local server");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page
    .getByRole("heading", { name: "Renamed local server", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await page.getByRole("link", { name: "Installation", exact: true }).click();
  await page
    .getByRole("heading", { name: "Server software", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Edit", exact: true }).click();

  await page.getByRole("radio", { name: "Fabric", exact: true }).click();
  await page
    .getByPlaceholder("Search game version...", { exact: true })
    .click();
  await page.getByRole("option", { name: "1.21.11", exact: true }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: "artifacts/installation.png", fullPage: true });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByText("Server software installed. You can now start the server.", {
      exact: true,
    })
    .waitFor();
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await page.getByRole("link", { name: "Mods & plugins", exact: true }).click();
  await page
    .getByRole("button", { name: "Browse content", exact: true })
    .click();
  await page.getByText("Test server mod", { exact: true }).click();
  await page
    .getByRole("button", { name: "Review installation", exact: true })
    .click();
  await page.getByText("Files to install", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Install these files", exact: true })
    .click();
  await page
    .getByText("Content and required dependencies installed.", { exact: true })
    .waitFor();
  await page
    .locator("#app")
    .getByText("Test server mod", { exact: true })
    .waitFor();
  await page
    .locator("#app")
    .getByText("Required dependency", { exact: true })
    .waitFor();
  await page.waitForTimeout(350);
  await page.screenshot({ path: "artifacts/content.png", fullPage: true });
  const toggle = page.getByRole("switch", {
    name: "Test server mod",
    exact: true,
  });
  await toggle.click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[role="switch"][aria-label="Test server mod"]')
        ?.getAttribute("aria-checked") === "false",
  );
  await fs.stat(path.join(root, "servers", id, "mods/mod-v.jar.disabled"));
  await toggle.click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[role="switch"][aria-label="Test server mod"]')
        ?.getAttribute("aria-checked") === "true",
  );
  await fs.stat(path.join(root, "servers", id, "mods/mod-v.jar"));
  const badIcons = await page
    .locator("svg.lucide")
    .evaluateAll((nodes) =>
      nodes
        .filter((n) => !n.hasAttribute("viewBox"))
        .map((n) => n.outerHTML.slice(0, 100)),
    );
  assert.deepEqual(
    badIcons,
    [],
    "All Lucide icons preserve a scalable viewBox",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await page.screenshot({ path: "artifacts/mobile.png", fullPage: true });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
    "Mobile page overflows horizontally",
  );
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole("button", { name: "browseruser", exact: true }).click();
  await page
    .getByLabel("Current password", { exact: true })
    .fill("browser password long enough");
  await page
    .getByLabel("New password", { exact: true })
    .fill("updated browser password long enough");
  await page
    .getByLabel("Confirm new password", { exact: true })
    .fill("updated browser password long enough");
  await page
    .getByLabel("Two-factor code or recovery code", { exact: true })
    .fill(recoveryCodes[0]);
  await page
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await page
    .getByText("Password changed. Your other sessions have been signed out.", {
      exact: true,
    })
    .waitFor();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByPlaceholder("Username", { exact: true }).fill("browseruser");
  await page
    .getByPlaceholder("Password", { exact: true })
    .fill("updated browser password long enough");
  await page
    .getByPlaceholder("Authenticator or recovery code")
    .fill(recoveryCodes[1]);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("heading", { name: "Your servers", exact: true })
    .waitFor();
  assert.deepEqual(errors, []);
  assert.deepEqual(remote, []);
  console.log("Browser smoke test passed.");
} catch (e) {
  console.log("ERRORS", errors);
  console.log("REMOTE", remote);
  await page.screenshot({ path: "artifacts/failure.png", fullPage: true });
  throw e;
} finally {
  await browser.close();
  await backend.close();
  await fs.rm(root, { recursive: true, force: true });
}
