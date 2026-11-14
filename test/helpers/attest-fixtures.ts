import "reflect-metadata"; // @peculiar/x509 (dev only) needs it
import { createPrivateKey, sign, webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { encode } from "cborg";
import { AAGUID } from "../../src/attest/auth-data.js";
import { sha256, toBase64, utf8 } from "../../src/attest/bytes.js";
import { APPLE_NONCE_OID } from "../../src/attest/der.js";
import { TEST_NOW } from "./harness.js";

/**
 * Builds App Attest attestations and assertions the way an iPhone does, but
 * under a test CA generated here, so the verifier can be tested end to end.
 * Production code still pins Apple's root: tests inject `rootPem` instead.
 */

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

export const TEST_APP_ID = "UXZV3C926U.com.jmagic.steady";

const subtle = webcrypto.subtle;

type KeyPair = CryptoKeyPair;

const ecKeys = (namedCurve: "P-256" | "P-384"): Promise<KeyPair> =>
  subtle.generateKey({ name: "ECDSA", namedCurve }, true, ["sign", "verify"]);

/** DER `SEQUENCE { [1] EXPLICIT OCTET STRING nonce }` for a 32-byte nonce. */
export function nonceExtensionValue(nonce: Uint8Array): Uint8Array<ArrayBuffer> {
  const octets = [0x04, nonce.length, ...nonce];
  const tagged = [0xa1, octets.length, ...octets];
  return new Uint8Array([0x30, tagged.length, ...tagged]);
}

export interface AuthDataParts {
  appId?: string;
  flags?: number;
  counter?: number;
  aaguid?: Uint8Array;
  credentialId?: Uint8Array;
}

export function buildAuthData(parts: AuthDataParts & { attested: boolean }): Uint8Array {
  const head = new Uint8Array(37);
  head.set(sha256(utf8(parts.appId ?? TEST_APP_ID)), 0);
  head[32] = parts.flags ?? (parts.attested ? 0x40 : 0x00);
  new DataView(head.buffer).setUint32(33, parts.counter ?? 0);
  if (!parts.attested) return head;
  const credentialId = parts.credentialId ?? new Uint8Array(32);
  const idLength = new Uint8Array(2);
  new DataView(idLength.buffer).setUint16(0, credentialId.length);
  // A stand-in COSE key: the verifier takes the key from the certificate.
  const cose = encode(new Map<number, number>([[1, 2], [3, -7]]));
  return new Uint8Array([...head, ...(parts.aaguid ?? AAGUID.development), ...idLength, ...credentialId, ...cose]);
}

export interface AttestationOverrides extends AuthDataParts {
  /** Put this nonce in the certificate instead of the right one. */
  nonce?: Uint8Array;
  /** Leave the nonce extension out. */
  omitNonce?: boolean;
  /** Sign the credential certificate with this fixture's chain instead. */
  chainFrom?: AttestFixture;
  leafNotAfter?: Date;
  fmt?: string;
  /** Send only the credential certificate. */
  leafOnly?: boolean;
}

export interface AttestFixture {
  rootPem: string;
  keyId: string;
  keyIdBytes: Uint8Array;
  publicKeySpki: Uint8Array;
  attestation(challenge: string, overrides?: AttestationOverrides): Promise<Uint8Array>;
  assertion(
    clientData: Uint8Array,
    counter: number,
    overrides?: { appId?: string; flags?: number; signer?: AttestFixture },
  ): Uint8Array;
  /** Internal: the CA pieces, so another fixture can borrow this chain. */
  ca: { root: x509.X509Certificate; intermediate: x509.X509Certificate; intermediateKeys: KeyPair };
}

const dayMs = 24 * 60 * 60 * 1000;

export async function createAttestFixture(): Promise<AttestFixture> {
  const notBefore = new Date(TEST_NOW.getTime() - dayMs);
  const notAfter = new Date(TEST_NOW.getTime() + 365 * dayMs);

  const rootKeys = await ecKeys("P-384");
  const root = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=Test App Attestation Root CA, O=Steady Tests",
    notBefore,
    notAfter,
    keys: rootKeys,
    signingAlgorithm: { name: "ECDSA", hash: "SHA-384" },
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
    ],
  });

  const intermediateKeys = await ecKeys("P-384");
  const intermediate = await x509.X509CertificateGenerator.create({
    serialNumber: "02",
    subject: "CN=Test App Attestation CA 1, O=Steady Tests",
    issuer: root.subject,
    notBefore,
    notAfter,
    publicKey: intermediateKeys.publicKey,
    signingKey: rootKeys.privateKey,
    signingAlgorithm: { name: "ECDSA", hash: "SHA-384" },
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
    ],
  });

  const deviceKeys = await ecKeys("P-256");
  const point = new Uint8Array(await subtle.exportKey("raw", deviceKeys.publicKey));
  const keyIdBytes = sha256(point);
  const keyId = toBase64(keyIdBytes);
  const publicKeySpki = new Uint8Array(await subtle.exportKey("spki", deviceKeys.publicKey));
  const devicePrivate = createPrivateKey({
    key: Buffer.from(await subtle.exportKey("pkcs8", deviceKeys.privateKey)),
    format: "der",
    type: "pkcs8",
  });

  const fixture: AttestFixture = {
    rootPem: root.toString("pem"),
    keyId,
    keyIdBytes,
    publicKeySpki,
    ca: { root, intermediate, intermediateKeys },

    async attestation(challenge, overrides = {}) {
      const authData = buildAuthData({ attested: true, credentialId: keyIdBytes, ...overrides });
      const nonce = overrides.nonce ?? sha256(authData, sha256(utf8(challenge)));
      const ca = overrides.chainFrom?.ca ?? fixture.ca;
      const leaf = await x509.X509CertificateGenerator.create({
        serialNumber: "03",
        subject: `CN=${Buffer.from(keyIdBytes).toString("hex")}, O=Steady Tests`,
        issuer: ca.intermediate.subject,
        notBefore,
        notAfter: overrides.leafNotAfter ?? notAfter,
        publicKey: deviceKeys.publicKey,
        signingKey: ca.intermediateKeys.privateKey,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        extensions: overrides.omitNonce ? [] : [new x509.Extension(APPLE_NONCE_OID, false, nonceExtensionValue(nonce))],
      });
      const x5c = [new Uint8Array(leaf.rawData)];
      if (!overrides.leafOnly) x5c.push(new Uint8Array(ca.intermediate.rawData));
      return encode({
        fmt: overrides.fmt ?? "apple-appattest",
        attStmt: { x5c, receipt: new Uint8Array([1, 2, 3]) },
        authData,
      });
    },

    assertion(clientData, counter, overrides = {}) {
      const authenticatorData = buildAuthData({ attested: false, counter, appId: overrides.appId, flags: overrides.flags });
      const nonce = sha256(authenticatorData, sha256(clientData));
      const signer = overrides.signer;
      const signature = signer
        ? signer.assertion(clientData, counter) // a valid assertion from another key
        : new Uint8Array(sign("sha256", nonce, { key: devicePrivate, dsaEncoding: "der" }));
      if (signer) return signature;
      return encode({ signature, authenticatorData });
    },
  };
  return fixture;
}
