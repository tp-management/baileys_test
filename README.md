# Baileys Pairing Code Test

Minimal **pairing-code-only** WhatsApp test using `@whiskeysockets/baileys@7.0.0-rc14`.

No QR is printed. No Express, Supabase, database, RidePicker state machine, or runtime patches.

## Run

```bash
npm install
npm start
```

Enter the phone number with country code, digits only:

```text
37060000000
```

Then in WhatsApp open:

**Settings → Linked devices → Link a device → Link with phone number**

Enter the code printed in the terminal.

You can also provide the number through an environment variable:

```bash
PHONE_NUMBER=37060000000 npm start
```

## Reset

```bash
npm run reset
```

## Expected flow

1. Baileys opens the socket.
2. The test waits for the initial QR-ready transport event, but does not display the QR.
3. It calls `requestPairingCode(phone)`.
4. The terminal prints the pairing code.
5. After entering it on the phone, Baileys may close with `515 restart required`.
6. The test restarts the socket automatically.
7. Successful linking ends at `connection === "open"`.

This deliberately stays close to upstream Baileys behavior so it can be compared with RidePicker.
