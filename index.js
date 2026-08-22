import fs from "fs";
import readline from "readline/promises";
import process from "process";
import { randomBytes } from "crypto";
import pino from "pino";

import makeWASocket, {
  Browsers,
  DisconnectReason,
  S_WHATSAPP_NET,
  aesEncryptCTR,
  bytesToCrockford,
  derivePairingCodeKey,
  fetchLatestBaileysVersion,
  getBinaryNodeChild,
  jidEncode,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";

const AUTH_DIR = "./auth";
const PAIRING_TIMEOUT_MS = 15_000;
const STRATEGY = process.env.PAIRING_STRATEGY || "verified";

const logger = pino({
  level: process.env.BAILEYS_LOG_LEVEL || "info",
});

let rememberedPhone = null;
let pairingRequested = false;
let restarting = false;

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function disconnectCode(lastDisconnect) {
  return (
    lastDisconnect?.error?.output?.statusCode ??
    lastDisconnect?.error?.statusCode ??
    null
  );
}

function cleanAuthIfRequested() {
  if (process.env.FRESH_AUTH !== "1") return;

  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  console.log("🧹 FRESH_AUTH=1: removed previous auth state");
}

async function getPhoneNumber() {
  if (rememberedPhone) return rememberedPhone;

  const envPhone = onlyDigits(process.env.PHONE_NUMBER);
  if (envPhone) {
    rememberedPhone = envPhone;
    return rememberedPhone;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(
      "Phone number with country code (digits only, e.g. 37060000000): "
    );
    rememberedPhone = onlyDigits(answer);

    if (!rememberedPhone) {
      throw new Error("Phone number is required.");
    }

    return rememberedPhone;
  } finally {
    rl.close();
  }
}

function logConnectionUpdate(update) {
  console.log("\n🔌 connection.update");
  console.dir(
    {
      connection: update.connection ?? null,
      hasQr: Boolean(update.qr),
      isNewLogin: update.isNewLogin ?? null,
      receivedPendingNotifications:
        update.receivedPendingNotifications ?? null,
      disconnectCode: disconnectCode(update.lastDisconnect),
      disconnectMessage: update.lastDisconnect?.error?.message || null,
    },
    { depth: null }
  );
}

async function requestVerifiedPairingCode(sock, phoneDigits) {
  const authState = sock.authState;

  if (!authState?.creds || !sock.query) {
    throw new Error("Pairing transport is not ready");
  }

  const pairingCode = bytesToCrockford(randomBytes(5));
  authState.creds.pairingCode = pairingCode;

  const jid = jidEncode(phoneDigits, "s.whatsapp.net");
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const key = await derivePairingCodeKey(pairingCode, salt);
  const encrypted = aesEncryptCTR(
    authState.creds.pairingEphemeralKeyPair.public,
    key,
    iv
  );
  const wrappedEphemeralKey = Buffer.concat([salt, iv, encrypted]);

  console.log("📡 Sending verified companion_hello and waiting for WhatsApp ACK...");

  try {
    const result = await sock.query(
      {
        tag: "iq",
        attrs: {
          to: S_WHATSAPP_NET,
          type: "set",
          xmlns: "md",
        },
        content: [
          {
            tag: "link_code_companion_reg",
            attrs: {
              jid,
              stage: "companion_hello",
              should_show_push_notification: "true",
            },
            content: [
              {
                tag: "link_code_pairing_wrapped_companion_ephemeral_pub",
                attrs: {},
                content: wrappedEphemeralKey,
              },
              {
                tag: "companion_server_auth_key_pub",
                attrs: {},
                content: authState.creds.noiseKey.public,
              },
              {
                tag: "companion_platform_id",
                attrs: {},
                content: "1",
              },
              {
                tag: "companion_platform_display",
                attrs: {},
                content: "Chrome (Mac OS)",
              },
              {
                tag: "link_code_pairing_nonce",
                attrs: {},
                content: "0",
              },
            ],
          },
        ],
      },
      PAIRING_TIMEOUT_MS
    );

    const registrationNode = getBinaryNodeChild(
      result,
      "link_code_companion_reg"
    );
    const pairingRefNode = registrationNode
      ? getBinaryNodeChild(registrationNode, "link_code_pairing_ref")
      : null;

    if (!pairingRefNode) {
      throw new Error(
        "WhatsApp ACK did not contain link_code_pairing_ref"
      );
    }

    authState.creds.me = { id: jid, name: "~" };
    sock.ev.emit("creds.update", authState.creds);

    console.log("✅ WhatsApp accepted companion_hello");
    return pairingCode;
  } catch (error) {
    if (authState.creds.pairingCode === pairingCode) {
      authState.creds.pairingCode = undefined;
    }

    console.error("\n❌ WhatsApp rejected/failed companion_hello");
    console.error("Status:", error?.output?.statusCode ?? error?.statusCode ?? null);
    console.error("Message:", error?.message || error);
    throw error;
  }
}

async function startSocket() {
  restarting = false;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  console.log("Auth registered before socket:", Boolean(state.creds.registered));

  if (!state.creds.registered) {
    await getPhoneNumber();
  }

  let version;
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
    console.log("Using WA version:", version.join("."));
  } catch {
    console.log("Using Baileys default WA version.");
  }

  const sock = makeWASocket({
    auth: state,
    ...(version ? { version } : {}),
    browser: Browsers.macOS("Desktop"),
    logger,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", async (update) => {
    console.log("\n🔐 creds.update");
    console.log("Changed fields:", Object.keys(update));
    console.log("Registered:", Boolean(sock.authState?.creds?.registered));
    await saveCreds();
  });

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    console.log(`\n📩 messages.upsert (${type})`);
    for (const message of messages) {
      console.dir(message, { depth: null });
    }
  });

  sock.ws?.on?.("CB:notification", (node) => {
    console.log("\n🔔 notification");
    console.dir(
      {
        type: node?.attrs?.type ?? null,
        from: node?.attrs?.from ?? null,
        id: node?.attrs?.id ?? null,
      },
      { depth: null }
    );
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, qr, lastDisconnect } = update;
    logConnectionUpdate(update);

    if (qr && !sock.authState.creds.registered && !pairingRequested) {
      pairingRequested = true;

      try {
        console.log("\nRequesting pairing code for:", rememberedPhone);
        console.log("Pairing strategy:", STRATEGY);

        const code =
          STRATEGY === "upstream"
            ? await sock.requestPairingCode(rememberedPhone)
            : await requestVerifiedPairingCode(sock, rememberedPhone);

        console.log("\n================================");
        console.log("PAIRING CODE:", code);
        console.log("================================");
        console.log(
          "WhatsApp > Settings > Linked devices > Link a device > Link with phone number"
        );
      } catch (error) {
        pairingRequested = false;
        console.error("\nPairing request failed:");
        console.error(error);
      }
    }

    if (connection === "open") {
      pairingRequested = false;
      console.log("\n✅ WhatsApp connected.");
      console.log("User:", sock.user);
      console.log("Waiting for incoming WhatsApp messages...");
    }

    if (connection === "close") {
      const code = disconnectCode(lastDisconnect);
      const message = lastDisconnect?.error?.message || "unknown error";

      console.log("\n❌ Connection closed");
      console.log("Status code:", code);
      console.log("Message:", message);
      console.log("Registered at close:", Boolean(sock.authState?.creds?.registered));

      if (code === DisconnectReason.restartRequired) {
        if (restarting) return;
        restarting = true;
        pairingRequested = false;
        console.log("Baileys requested restart (515). Restarting socket...");
        setTimeout(() => startSocket().catch(console.error), 750);
        return;
      }

      if (code === DisconnectReason.loggedOut) {
        if (!sock.authState?.creds?.registered) {
          console.log(
            "401 happened during pairing before registration completed. This is a server/protocol pairing rejection, not a normal logged-out session."
          );
        } else {
          console.log("Logged out. Use FRESH_AUTH=1 for a clean test.");
        }
        return;
      }

      console.log("Run again to retry.");
    }
  });

  if (state.creds.registered) {
    console.log("Existing auth found. Connecting...");
  } else {
    console.log("Waiting for WhatsApp pairing transport...");
  }
}

cleanAuthIfRequested();
fs.mkdirSync(AUTH_DIR, { recursive: true });

startSocket().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
