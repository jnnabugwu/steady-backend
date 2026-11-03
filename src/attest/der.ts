/**
 * The one piece of X.509 that Node's `crypto.X509Certificate` doesn't
 * expose: an extension's value by OID. App Attest needs the nonce extension
 * (OID 1.2.840.113635.100.8.2) on the credential certificate, whose value is
 *
 *   SEQUENCE { [1] EXPLICIT OCTET STRING nonce }
 *
 * A strict DER reader for just that: definite lengths only, minimal length
 * encodings, no trailing bytes. Anything else is `null`. Signatures and the
 * chain are checked by Node (OpenSSL), not here.
 */

export const APPLE_NONCE_OID = "1.2.840.113635.100.8.2";

/** The DER content bytes of OID 1.2.840.113635.100.8.2. */
const APPLE_NONCE_OID_BYTES = new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x08, 0x02]);

const SEQUENCE = 0x30;
const OCTET_STRING = 0x04;
const OID = 0x06;
const BOOLEAN = 0x01;
const EXTENSIONS = 0xa3; // [3] EXPLICIT in TBSCertificate
const NONCE_TAG = 0xa1; // [1] EXPLICIT in the nonce extension

interface Tlv {
  tag: number;
  value: Uint8Array;
  /** Index just past this element. */
  end: number;
}

export function readTlv(bytes: Uint8Array, start: number): Tlv | null {
  const tag = bytes[start];
  const first = bytes[start + 1];
  if (tag === undefined || first === undefined) return null;
  // Multi-byte tags (low five bits all set) never occur in these structures.
  if ((tag & 0x1f) === 0x1f) return null;
  let offset = start + 2;
  let length: number;
  if (first < 0x80) {
    length = first;
  } else {
    const count = first & 0x7f;
    // 0x80 is BER's indefinite length, which DER forbids. Three length bytes
    // (16 MB) is far beyond any certificate.
    if (count === 0 || count > 3) return null;
    length = 0;
    for (let i = 0; i < count; i++) {
      const byte = bytes[offset++];
      if (byte === undefined) return null;
      length = length * 256 + byte;
    }
    // DER uses the shortest form: no leading zero byte, no long form below 128.
    if (length < 0x80 || bytes[start + 2] === 0) return null;
  }
  const end = offset + length;
  if (end > bytes.length) return null;
  return { tag, value: bytes.subarray(offset, end), end };
}

/** The elements of a constructed value, or `null` if they don't tile it exactly. */
function children(value: Uint8Array): Tlv[] | null {
  const out: Tlv[] = [];
  let offset = 0;
  while (offset < value.length) {
    const child = readTlv(value, offset);
    if (child === null) return null;
    out.push(child);
    offset = child.end;
  }
  return out;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The value (the bytes inside `extnValue`'s OCTET STRING) of the extension
 * with OID 1.2.840.113635.100.8.2 in a DER certificate, or `null`.
 *
 * Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature }
 * TBSCertificate ::= SEQUENCE { ..., [3] EXPLICIT Extensions }
 * Extension ::= SEQUENCE { extnID OID, critical BOOLEAN OPTIONAL, extnValue OCTET STRING }
 */
export function findAppleNonceExtension(certificateDer: Uint8Array): Uint8Array | null {
  const certificate = readTlv(certificateDer, 0);
  if (certificate?.tag !== SEQUENCE || certificate.end !== certificateDer.length) return null;
  const tbs = children(certificate.value)?.[0];
  if (tbs?.tag !== SEQUENCE) return null;
  const extensionsWrapper = children(tbs.value)?.find((element) => element.tag === EXTENSIONS);
  if (extensionsWrapper === undefined) return null;
  const extensionsSequence = children(extensionsWrapper.value);
  if (extensionsSequence?.length !== 1 || extensionsSequence[0]?.tag !== SEQUENCE) return null;
  const extensions = children(extensionsSequence[0].value);
  if (extensions === null) return null;

  let found: Uint8Array | null = null;
  for (const extension of extensions) {
    if (extension.tag !== SEQUENCE) return null;
    const parts = children(extension.value);
    if (parts === null || parts.length < 2 || parts.length > 3) return null;
    const [id, second, third] = parts;
    if (id?.tag !== OID) return null;
    const value = parts.length === 3 ? third : second;
    if (parts.length === 3 && second?.tag !== BOOLEAN) return null;
    if (value?.tag !== OCTET_STRING) return null;
    if (sameBytes(id.value, APPLE_NONCE_OID_BYTES)) {
      if (found !== null) return null; // a duplicate extension is malformed
      found = value.value;
    }
  }
  return found;
}

/** The nonce in the extension's value, or `null` if it's malformed. */
export function readAppleNonce(extensionValue: Uint8Array): Uint8Array | null {
  const sequence = readTlv(extensionValue, 0);
  if (sequence?.tag !== SEQUENCE || sequence.end !== extensionValue.length) return null;
  const tagged = readTlv(sequence.value, 0);
  if (tagged?.tag !== NONCE_TAG || tagged.end !== sequence.value.length) return null;
  const octets = readTlv(tagged.value, 0);
  if (octets?.tag !== OCTET_STRING || octets.end !== tagged.value.length) return null;
  return octets.value;
}
