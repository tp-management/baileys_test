import fs from "fs";
import readline from "readline/promises";
import process from "process";
import pino from "pino";

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";

const AUTH_DIR = "./auth";
fs.mkdirSync(AUTH_DIR, { recursive: true });

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
  const code = disconnectCode(update.lastDisconnect);
  const message = update.lastDisconnect?.error?.message || null;

  console.log("\n🔌 connection.update");
  console.dir(
    {
      connection: update.connection ?? null,
      hasQr: Boolean(update.qr),
      isNewLogin: update.isNewLogin ?? null,
      receivedPendingNotifications:
        update.receivedPendingNotifications ?? null,
      disconnectCode: code,
      disconnectMessage: message,
    },
    { depth: null }
  );
}

async function startSocket() {
  restarting = false;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  // Ask for the phone number BEFORE opening the socket. Waiting for terminal
  // input after WhatsApp has already issued QR refs can let those refs expire
  // and produce a 408 "QR refs attempts ended" before requestPairingCode runs.
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
    logger,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", async (update) => {
    // Do not dump credential values/private keys to the terminal. Log only
    // which credential fields changed, then persist them normally.
    console.log("\n🔐 creds.update");
    console.log("Changed fields:", Object.keys(update));
    console.log("Registered:", Boolean(state.creds.registered));
    await saveCreds();
  });

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    console.log(`\n📩 messages.upsert (${type})`);

    for (const message of messages) {
      console.dir(message, { depth: null });
    }
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, qr, lastDisconnect } = update;
    logConnectionUpdate(update);

    // Pairing-code-only mode. We use the first QR-ready event only as the
    // signal that Baileys/WhatsApp pairing transport is ready. QR itself is
    // deliberately never displayed.
    if (qr && !state.creds.registered && !pairingRequested) {
      pairingRequested = true;

      try {
        console.log("\nRequesting pairing code for:", rememberedPhone);

        const code = await sock.requestPairingCode(rememberedPhone);

        console.log("\n================================");
        console.log("PAIRING CODE:", code);
        console.log("================================");
        console.log(
          "WhatsApp > Settings > Linked devices > Link a device > Link with phone number"
        );
      } catch (error) {
        pairingRequested = false;
        console.error("\nrequestPairingCode() failed:");
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

      if (code === DisconnectReason.loggedOut) {
        console.log("Logged out. Run: npm run reset");
        return;
      }

      if (code === DisconnectReason.restartRequired) {
        if (restarting) return;
        restarting = true;
        pairingRequested = false;

        console.log("Baileys requested restart (515). Restarting socket...");
        setTimeout(() => {
          startSocket().catch(console.error);
        }, 750);
        return;
      }

      console.log("Run npm start again to retry.");
    }
  });

  if (state.creds.registered) {
    console.log("Existing auth found. Connecting...");
  } else {
    console.log("Waiting for WhatsApp pairing transport...");
  }
}

startSocket().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
