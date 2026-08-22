# Baileys Pairing Code Test

Minimal **pairing-code-only** WhatsApp test using `@whiskeysockets/baileys@7.0.0-rc14`.

No QR is printed. No Express, Supabase, database, RidePicker state machine, or runtime patches.

## Run

```bash
npm install
npm start
```

The test asks for the phone number **before opening the WhatsApp socket**, so terminal input cannot consume the pairing window.

Enter the phone number with country code, digits only:

```text
37060000000
```

Then in WhatsApp open:

**Settings → Linked devices → Link a device → Link with phone number**

Enter the code printed in the terminal.

You can also provide the number directly:

```bash
PHONE_NUMBER=37060000000 npm start
```

## Debug output

The terminal now shows:

- `connection.update` state changes and disconnect status codes
- safe `creds.update` summaries without printing credential/private-key values
- full `messages.upsert` objects for incoming/synced WhatsApp messages
- Baileys internal logs at `info` level by default

For more Baileys internals:

```bash
BAILEYS_LOG_LEVEL=debug npm start
```

Or maximum noise:

```bash
BAILEYS_LOG_LEVEL=trace npm start
```

You can combine this with a phone number:

```bash
PHONE_NUMBER=37060000000 BAILEYS_LOG_LEVEL=debug npm start
```

## Reset

```bash
npm run reset
```

## Expected flow

1. The phone number is collected first.
2. Baileys opens the socket.
3. The test waits for the initial QR-ready transport event, but never displays the QR.
4. It immediately calls `requestPairingCode(phone)`.
5. The terminal prints the pairing code.
6. After entering it on the phone, Baileys may close with `515 restart required`.
7. The test restarts the socket automatically.
8. Successful linking ends at `connection === "open"`.
9. New WhatsApp messages are printed through `messages.upsert`.

This deliberately stays close to upstream Baileys behavior so it can be compared with RidePicker.
