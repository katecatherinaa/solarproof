# How to Verify a Renewable Energy Certificate

The SolarProof public verifier lets anyone — regulators, buyers, auditors — confirm that an energy certificate is genuine, without creating an account or logging in.

**Verifier URL:** [https://solarproof.vercel.app/verify](https://solarproof.vercel.app/verify)

---

## What you need

One of the following identifiers (you will receive this from the certificate issuer or find it in your dashboard):

| Identifier | What it looks like | Example |
|---|---|---|
| Certificate ID | UUID (36 characters) | `a1b2c3d4-e5f6-7890-abcd-ef1234567890` |
| Reading hash | 64-character hex string | `4b3e9f…f09a` |
| Transaction hash | 64-character hex string | `8d1a2b…c3d4` |

---

## Step-by-step

### Step 1 — Open the verifier

Go to [https://solarproof.vercel.app/verify](https://solarproof.vercel.app/verify).

You will see a search bar at the top of the page.

---

### Step 2 — Enter the certificate identifier

Paste your certificate ID, reading hash, or transaction hash into the search bar. The search box accepts any of these three identifiers:

- a certificate ID (UUID, 36 characters)
- a reading hash (64-character hex string)
- a Stellar transaction hash (64-character hex string) — either the anchor tx or the mint tx

> **Tip:** The identifier is case-insensitive. Leading and trailing spaces are ignored.

#### Deep link from Stellar Expert

If you are viewing a transaction on a Stellar explorer, you can jump straight to the certificate by adding the transaction hash to the verifier URL:

```
https://solarproof.vercel.app/verify?tx=<64_hex_transaction_hash>
```

For example, `https://solarproof.vercel.app/verify?tx=8d1a2b…c3d4` (with the full 64-character hash) opens the verifier and automatically looks up the certificate whose anchor or mint transaction matches that hash. The same hash can also be pasted into the search bar manually.
=======

---

### Step 3 — Click "Verify"

Press the **Verify** button (or hit Enter). The page will show a loading indicator while it checks the certificate.

---

### Step 4 — Read the results

A successful verification shows three sections:

#### Certificate

| Field | What it means |
|---|---|
| **ID** | Unique identifier for this certificate |
| **Energy** | Kilowatt-hours (kWh) this certificate represents |
| **Issued** | Date and time the certificate was minted |
| **Status** | `Active` — certificate is valid and has not been used. `Retired` — certificate has been permanently claimed (e.g., to offset emissions). |

#### On-chain proof

| Field | What it means |
|---|---|
| **Anchor tx** | Stellar transaction that recorded the meter reading hash on-chain. Click the link to view it on Stellar Expert. |
| **Mint tx** | Stellar transaction that created (minted) the certificate token. Click the link to view it on Stellar Expert. |

Both links open the Stellar blockchain explorer so you can independently confirm the transactions exist.

#### Meter proof

| Field | What it means |
|---|---|
| **Meter ID** | The registered device that generated the energy |
| **Reading hash** | Cryptographic fingerprint of the raw meter reading |
| **Signature** | Ed25519 digital signature produced by the meter device |
| **kWh** | Energy amount recorded by the meter |
| **Timestamp** | When the meter reading was taken |
| **Ed25519 verified** | ✓ Valid — the server confirmed the meter's signature is authentic |

---

### Step 5 — Confirm the chain of custody

A genuine certificate will show:

1. ✅ **Certificate** section with a valid ID and kWh amount
2. ✅ **On-chain proof** with two clickable Stellar transaction links
3. ✅ **Meter proof** with `Ed25519 verified: ✓ Valid`

If any section is missing or shows an error, see the [FAQ](#faq) below.

---

## What each proof step means

SolarProof uses a three-step chain of custody to guarantee a certificate corresponds to real energy generation:

```
Physical meter
  └─ Signs reading with Ed25519 private key
        └─ API verifies signature and anchors reading hash on Stellar
              └─ Certificate token minted on Stellar
                    └─ Public verifier checks all three steps
```

| Step | What is proved |
|---|---|
| **Ed25519 signature** | The reading came from the registered physical device — it cannot be forged without the device's private key |
| **Anchor transaction** | The exact reading hash was recorded on the Stellar blockchain before the certificate was minted — it cannot be backdated |
| **Mint transaction** | A certificate token was created on-chain and is traceable to the anchor |

---

## FAQ

**Q: The verifier says "Certificate not found." What should I do?**

Check that you copied the full identifier without truncating it. Certificate IDs are 36 characters; hashes are 64 hex characters. If the identifier looks correct, the certificate may not have been issued yet — contact the issuer.

This also applies to transaction hashes: if you open `/verify?tx=<hash>` and no certificate matches the hash, the verifier shows a clear "Certificate not found" message rather than an error. Double-check that the hash is a SolarProof anchor or mint transaction (not an unrelated Stellar transaction) and that all 64 hex characters were copied.

---

**Q: The "Meter proof" section is missing. Is the certificate still valid?**

The certificate is still on-chain and the anchor and mint transactions are valid. The meter proof section is shown only when the raw reading record is available in the database. Its absence does not invalidate the certificate.

---

**Q: What does "Retired" mean?**

A retired certificate has been permanently claimed — typically to offset carbon emissions or meet a regulatory obligation. Retired certificates cannot be used again. The retirement date and the wallet address that retired it are recorded on-chain.

---

**Q: Can I verify a certificate without internet access?**

No. The verifier queries the Stellar blockchain and the SolarProof database in real time. You can independently verify the anchor and mint transactions using any Stellar node or the [Stellar Expert explorer](https://stellar.expert) if you have the transaction hashes.

---

**Q: Is there an API I can use to verify certificates programmatically?**

Yes. Send a GET request to:

```
GET https://solarproof.vercel.app/api/verify?id=<certificate_id_or_hash>
```

The response is JSON with the same certificate, on-chain proof, and meter proof fields shown in the UI. See [docs/API.md](API.md) for the full reference.

---

**Q: Who can see my certificate?**

The verifier is fully public — no login required. Anyone with the certificate ID or hash can look it up. Certificate IDs are not guessable (they are UUIDs), so a certificate is effectively private unless you share the ID.

---

**Q: I got a "429 Too Many Requests" error. What does that mean?**

To keep the public verifier available to everyone and prevent automated scraping, lookups are rate limited to **30 requests per minute per IP address**. If you exceed this limit you will receive an HTTP `429` response with a `Retry-After` header indicating how many seconds to wait. Pause for that period, then retry your lookup. If you need higher-volume access, see [docs/ABUSE_PROTECTION.md](ABUSE_PROTECTION.md) for details on the limits and options.
