import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
const scrypt = promisify(crypto.scrypt);
const fail = (status, message) => Object.assign(new Error(message), { status });
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(bytes) {
  let bits = 0,
    value = 0,
    out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(value >>> bits) & 31];
    }
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
export function totp(secret, counter = Math.floor(Date.now() / 30000)) {
  let bits = 0,
    value = 0;
  const bytes = [];
  for (const c of secret) {
    const n = alphabet.indexOf(c);
    if (n < 0) throw new Error("Invalid TOTP secret");
    value = (value << 5) | n;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  const data = Buffer.alloc(8);
  data.writeBigUInt64BE(BigInt(counter));
  const hash = crypto
    .createHmac("sha1", Buffer.from(bytes))
    .update(data)
    .digest();
  const offset = hash[19] & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(
    6,
    "0",
  );
}
function equal(a, b) {
  const x = Buffer.from(String(a)),
    y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function passwordValid(password) {
  if (
    typeof password !== "string" ||
    password.length < 12 ||
    Buffer.byteLength(password) > 1024
  )
    throw fail(
      400,
      "Use a password of at least 12 characters (maximum 1024 bytes).",
    );
}
async function hashPassword(
  password,
  salt = crypto.randomBytes(16).toString("hex"),
) {
  const hash = await scrypt(password, salt, 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return { salt, hash: hash.toString("hex") };
}
const recoveryHash = (code) =>
  crypto
    .createHash("sha256")
    .update(String(code).replace(/-/g, "").toLowerCase())
    .digest("hex");
export async function createAuth(root, adminKey) {
  const file = path.join(root, "users.json");
  let users = [];
  try {
    users = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  let key;
  try {
    key = await fs.readFile(path.join(root, "auth-key"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    key = crypto.randomBytes(32);
    await fs.writeFile(path.join(root, "auth-key"), key, {
      mode: 0o600,
      flag: "wx",
    });
  }
  const seal = (secret) => {
    const iv = crypto.randomBytes(12),
      cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  };
  const unseal = (secret) => {
    const data = Buffer.from(secret, "base64"),
      decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        data.subarray(0, 12),
      );
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([
      decipher.update(data.subarray(28)),
      decipher.final(),
    ]).toString();
  };
  async function save() {
    await fs.writeFile(file + ".tmp", JSON.stringify(users, null, 2), {
      mode: 0o600,
    });
    await fs.rename(file + ".tmp", file);
  }
  const sessions = new Map(),
    pending = new Map(),
    attempts = new Map();
  const dummy = await hashPassword(crypto.randomBytes(32).toString("hex"));
  let queue = Promise.resolve();
  function limit(ip) {
    const now = Date.now();
    for (const [k, b] of attempts) if (b.until < now) attempts.delete(k);
    const bucket = attempts.get(ip) || { n: 0, until: now + 60000 };
    attempts.set(ip, bucket);
    if (++bucket.n > 10 || attempts.size > 10000)
      throw fail(
        429,
        "Too many authentication attempts. Try again in a minute.",
      );
  }
  function cookie(req) {
    return req.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("panel_session="))
      ?.slice(14);
  }
  function session(req) {
    const id = cookie(req),
      s = sessions.get(id);
    if (!s || s.expiry <= Date.now()) {
      sessions.delete(id);
      return null;
    }
    return users.find((u) => u.id === s.userId);
  }
  function signIn(res, user) {
    for (const [id, s] of sessions)
      if (s.expiry < Date.now()) sessions.delete(id);
    const id = crypto.randomBytes(32).toString("hex");
    sessions.set(id, { userId: user.id, expiry: Date.now() + 43200000 });
    res.setHeader(
      "Set-Cookie",
      `panel_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.SECURE_COOKIE === "true" ? "; Secure" : ""}`,
    );
  }
  function verifyCode(user, code, allowRecovery = true) {
    const text = String(code || "").trim();
    const counter = Math.floor(Date.now() / 30000);
    if (/^\d{6}$/.test(text)) {
      const secret = unseal(user.secret);
      for (const n of [counter, counter - 1, counter + 1]) {
        if (n > (user.lastCounter ?? -1) && equal(text, totp(secret, n))) {
          user.lastCounter = n;
          return true;
        }
      }
    }
    if (allowRecovery) {
      const index =
        user.recovery?.findIndex((hash) => equal(hash, recoveryHash(text))) ??
        -1;
      if (index >= 0) {
        user.recovery.splice(index, 1);
        return true;
      }
    }
    return false;
  }
  async function validPassword(user, password) {
    if (typeof password !== "string" || Buffer.byteLength(password) > 1024)
      return false;
    const target = user?.password || dummy;
    return (
      equal((await hashPassword(password, target.salt)).hash, target.hash) &&
      !!user
    );
  }
  return {
    session,
    async handle(req, res, pathname, readJson, send) {
      const routes = [
        "/api/login",
        "/api/register/start",
        "/api/register/finish",
        "/api/logout",
        "/api/account/password",
      ];
      if (!routes.includes(pathname)) return false;
      if (req.method !== "POST") throw fail(405, "Method not allowed.");
      limit(req.socket.remoteAddress);
      const body = await readJson(req);
      // Serialize credential mutations so recovery codes and TOTP counters cannot be reused concurrently.
      const operation = queue.then(async () => {
        if (pathname === "/api/register/start") {
          if (!equal(body.adminKey || "", adminKey.trim()))
            throw fail(401, "Invalid admin key.");
          const username = String(body.username || "").trim();
          if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username))
            throw fail(
              400,
              "Username must be 3–32 letters, numbers, underscores or hyphens.",
            );
          passwordValid(body.password);
          if (
            users.some(
              (u) => u.username.toLowerCase() === username.toLowerCase(),
            )
          )
            throw fail(409, "Username is already in use.");
          for (const [id, p] of pending)
            if (
              p.expires < Date.now() ||
              p.username.toLowerCase() === username.toLowerCase()
            )
              pending.delete(id);
          if (pending.size >= 100)
            throw fail(429, "Too many pending registrations. Try again later.");
          const secret = base32(crypto.randomBytes(20)),
            enrollment = crypto.randomBytes(32).toString("hex");
          pending.set(enrollment, {
            username,
            password: await hashPassword(body.password),
            secret: seal(secret),
            expires: Date.now() + 600000,
          });
          send(200, {
            enrollment,
            secret,
            uri: `otpauth://totp/${encodeURIComponent("Server panel:" + username)}?secret=${secret}&issuer=Server%20panel&algorithm=SHA1&digits=6&period=30`,
          });
        } else if (pathname === "/api/register/finish") {
          const p = pending.get(body.enrollment);
          if (!p || p.expires < Date.now())
            throw fail(400, "Account setup expired. Start again.");
          if (!verifyCode(p, body.code, false))
            throw fail(401, "Invalid authenticator code.");
          if (
            users.some(
              (u) => u.username.toLowerCase() === p.username.toLowerCase(),
            )
          )
            throw fail(409, "Username is already in use.");
          const codes = Array.from({ length: 10 }, () =>
            crypto
              .randomBytes(10)
              .toString("hex")
              .match(/.{1,5}/g)
              .join("-"),
          );
          const user = {
            id: crypto.randomUUID(),
            username: p.username,
            password: p.password,
            secret: p.secret,
            lastCounter: -1,
            recovery: codes.map(recoveryHash),
            created: new Date().toISOString(),
          };
          users.push(user);
          try {
            await save();
          } catch (e) {
            users.pop();
            throw e;
          }
          pending.delete(body.enrollment);
          signIn(res, user);
          send(201, { username: user.username, recoveryCodes: codes });
        } else if (pathname === "/api/login") {
          const user = users.find(
            (u) =>
              u.username.toLowerCase() ===
              String(body.username || "")
                .trim()
                .toLowerCase(),
          );
          if (
            !(await validPassword(user, body.password)) ||
            !verifyCode(user, body.code)
          )
            throw fail(401, "Invalid username, password or two-factor code.");
          await save();
          signIn(res, user);
          send(200, { username: user.username });
        } else if (pathname === "/api/logout") {
          sessions.delete(cookie(req));
          res.setHeader(
            "Set-Cookie",
            `panel_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${process.env.SECURE_COOKIE === "true" ? "; Secure" : ""}`,
          );
          send(200, { ok: true });
        } else {
          const user = session(req);
          if (!user) throw fail(401, "Sign in to your account.");
          passwordValid(body.newPassword);
          if (
            !(await validPassword(user, body.password)) ||
            !verifyCode(user, body.code)
          )
            throw fail(401, "Invalid password or two-factor code.");
          user.password = await hashPassword(body.newPassword);
          await save();
          for (const [id, s] of sessions)
            if (s.userId === user.id) sessions.delete(id);
          signIn(res, user);
          send(200, { ok: true });
        }
      });
      queue = operation.catch(() => {});
      await operation;
      return true;
    },
  };
}
