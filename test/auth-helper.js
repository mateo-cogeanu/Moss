import assert from "node:assert/strict";
import { totp } from "../server/auth.js";
export async function register(base, adminKey, username = "tester") {
  const start = await fetch(base + "/register/start", {
    method: "POST",
    body: JSON.stringify({
      adminKey,
      username,
      password: "test password long enough",
    }),
  });
  assert.equal(start.status, 200, await start.clone().text());
  const enrollment = await start.json();
  const finish = await fetch(base + "/register/finish", {
    method: "POST",
    body: JSON.stringify({
      enrollment: enrollment.enrollment,
      code: totp(enrollment.secret),
    }),
  });
  assert.equal(finish.status, 201, await finish.clone().text());
  return {
    cookie: finish.headers.get("set-cookie").split(";")[0],
    secret: enrollment.secret,
    ...(await finish.json()),
  };
}
