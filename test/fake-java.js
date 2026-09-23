#!/usr/bin/env node
console.log("[Server thread/INFO]: Done! Test fixture ready.");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const command of chunk.trim().split("\n")) {
    if (command === "stop") process.exit(0);
    console.log("[Server thread/INFO]: " + command);
  }
});
