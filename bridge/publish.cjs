"use strict";

const { WebSocket } = require("ws");

const [, , title, filepath, thumbnail] = process.argv;
if (!title || !filepath) {
  console.error(
    'Usage: npm run publish -- "Replay Name" "C:\\path\\video.mp4" ["C:\\path\\thumb.png"]',
  );
  process.exit(1);
}

const configuredUrl = process.env.ORACLE_BRIDGE_URL;
let urls;
try {
  urls = configuredUrl
    ? [validatedLoopbackBridgeUrl(configuredUrl)]
    : ["ws://127.0.0.1:3001"];
} catch (error) {
  console.error(error && error.message ? error.message : "Invalid ORACLE_BRIDGE_URL.");
  process.exit(1);
}

let completed = false;

function tryBridge(index) {
  if (index >= urls.length) {
    console.error("Could not connect to the Blocky Studios bridge on port 3001.");
    process.exitCode = 1;
    return;
  }

  const socket = new WebSocket(urls[index]);
  let recognized = false;
  const timeout = setTimeout(() => {
    socket.terminate();
  }, 1200);

  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString("utf8"));
    } catch (error) {
      return;
    }
    if (message.event === "bridge_hello" && !recognized) {
      recognized = true;
      const renderPayload = {
        event: "render_complete",
        title,
        filepath,
        thumbnail: thumbnail || "",
      };
      if (typeof renderPayload.filepath !== "string" || !renderPayload.filepath.trim()) {
        console.error("Refusing to send render_complete without an output filepath.");
        completed = true;
        clearTimeout(timeout);
        socket.close(1008, "Missing render filepath");
        process.exitCode = 1;
        return;
      }
      socket.send(JSON.stringify(renderPayload));
    } else if (message.event === "render_accepted") {
      completed = true;
      clearTimeout(timeout);
      console.log(`Blocky Studios accepted ${title} on ${urls[index]}.`);
      socket.close(1000);
    } else if (message.event === "bridge_error") {
      completed = true;
      clearTimeout(timeout);
      console.error(message.message);
      socket.close(1000);
      process.exitCode = 1;
    }
  });

  socket.on("error", () => {
    // The close handler advances to the next allow-listed localhost port.
  });

  socket.on("close", () => {
    clearTimeout(timeout);
    if (!completed) {
      tryBridge(index + 1);
    }
  });
}

function validatedLoopbackBridgeUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch (error) {
    throw new Error("ORACLE_BRIDGE_URL must be a valid loopback WebSocket URL.");
  }
  const hostname = url.hostname.toLocaleLowerCase("en-US");
  if (
    url.protocol !== "ws:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error("ORACLE_BRIDGE_URL is development-only and must use ws:// on a loopback host.");
  }
  return url.toString();
}

tryBridge(0);
