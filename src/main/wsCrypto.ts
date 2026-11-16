import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  scryptSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

/**
 * The cryptography of a shared workspace (doc 08, 3.3 and 3.5): each PC has
 * its own signing key (Ed25519) and box key (X25519); the workspace has one
 * secret key (AES-256-GCM) that is locked once for each PC's box key.
 * Everything a PC writes into the folder is encrypted with the workspace key
 * and signed with that PC's signing key.
 */

export interface PcKeys {
  /** The PC id: a hash of its public keys. */
  pcId: string;
  signPub: string;
  signPriv: string;
  boxPub: string;
  boxPriv: string;
}

export interface PublicKeys {
  pcId: string;
  signPub: string;
  boxPub: string;
}

const b64 = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64');
const unb64 = (s: string) => Buffer.from(s, 'base64');

const pubDer = (k: KeyObject) => b64(k.export({ type: 'spki', format: 'der' }));
const privDer = (k: KeyObject) =>
  b64(k.export({ type: 'pkcs8', format: 'der' }));
const pubKey = (s: string) =>
  createPublicKey({ key: unb64(s), type: 'spki', format: 'der' });
const privKey = (s: string) =>
  createPrivateKey({ key: unb64(s), type: 'pkcs8', format: 'der' });

export const pcIdOf = (signPub: string, boxPub: string) =>
  createHash('sha256')
    .update(`${signPub}\n${boxPub}`)
    .digest('hex')
    .slice(0, 16);

/** A new PC's keys. */
export function makePcKeys(): PcKeys {
  const s = generateKeyPairSync('ed25519');
  const x = generateKeyPairSync('x25519');
  const signPub = pubDer(s.publicKey);
  const boxPub = pubDer(x.publicKey);
  return {
    pcId: pcIdOf(signPub, boxPub),
    signPub,
    signPriv: privDer(s.privateKey),
    boxPub,
    boxPriv: privDer(x.privateKey),
  };
}

export const publicOf = (k: PcKeys): PublicKeys => ({
  pcId: k.pcId,
  signPub: k.signPub,
  boxPub: k.boxPub,
});

/**
 * The 6-digit code both screens show for a join request, from the
 * requester's public keys: a fake request cannot show the same code.
 */
export function joinCode(p: Pick<PublicKeys, 'signPub' | 'boxPub'>): string {
  const h = createHash('sha256')
    .update(`worksync-join\n${p.signPub}\n${p.boxPub}`)
    .digest();
  const n = h.readUInt32BE(0) % 1_000_000;
  const s = String(n).padStart(6, '0');
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}

export const newWorkspaceKey = () => b64(randomBytes(32));

export function signText(k: PcKeys, text: string): string {
  return b64(sign(null, Buffer.from(text), privKey(k.signPriv)));
}

export function verifyText(
  signPub: string,
  text: string,
  sig: string,
): boolean {
  try {
    return verify(null, Buffer.from(text), pubKey(signPub), unb64(sig));
  } catch {
    return false;
  }
}

function aesSeal(key: Buffer, plain: Buffer, aad: string) {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { nonce: b64(nonce), ct: b64(Buffer.concat([ct, c.getAuthTag()])) };
}

function aesOpen(key: Buffer, nonce: string, ct: string, aad: string): Buffer {
  const all = unb64(ct);
  const d = createDecipheriv('aes-256-gcm', key, unb64(nonce));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(all.subarray(all.length - 16));
  return Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]);
}

/** The workspace key locked for one PC's box key (an ephemeral X25519 exchange). */
export function lockKeyFor(
  workspaceKey: string,
  to: Pick<PublicKeys, 'pcId' | 'boxPub'>,
): string {
  const eph = generateKeyPairSync('x25519');
  const shared = diffieHellman({
    privateKey: eph.privateKey,
    publicKey: pubKey(to.boxPub),
  });
  const key = Buffer.from(
    hkdfSync('sha256', shared, Buffer.alloc(0), `worksync-key ${to.pcId}`, 32),
  );
  const s = aesSeal(key, unb64(workspaceKey), to.pcId);
  return JSON.stringify({ v: 1, eph: pubDer(eph.publicKey), ...s });
}

export function unlockKey(locked: string, me: PcKeys): string {
  const o = JSON.parse(locked) as { eph: string; nonce: string; ct: string };
  const shared = diffieHellman({
    privateKey: privKey(me.boxPriv),
    publicKey: pubKey(o.eph),
  });
  const key = Buffer.from(
    hkdfSync('sha256', shared, Buffer.alloc(0), `worksync-key ${me.pcId}`, 32),
  );
  return b64(aesOpen(key, o.nonce, o.ct, me.pcId));
}

/** A file in the folder: encrypted with the workspace key and signed by its PC. */
export interface Sealed {
  v: 1;
  pc: string;
  epoch: number;
  /** What the file is, so a file cannot be moved to another place and read as something else. */
  kind: string;
  nonce: string;
  ct: string;
  sig: string;
}

export function seal(
  me: PcKeys,
  workspaceKey: string,
  epoch: number,
  kind: string,
  data: unknown,
): string {
  const s = aesSeal(
    unb64(workspaceKey),
    Buffer.from(JSON.stringify(data)),
    `${kind}\n${me.pcId}\n${epoch}`,
  );
  const body = `${kind}\n${me.pcId}\n${epoch}\n${s.nonce}\n${s.ct}`;
  const out: Sealed = {
    v: 1,
    pc: me.pcId,
    epoch,
    kind,
    ...s,
    sig: signText(me, body),
  };
  return JSON.stringify(out);
}

export class UnreadableFile extends Error {}

/**
 * Opens a sealed file. `keyOf` gives the workspace key of an epoch and
 * `signerOf` the signing key of a member PC; files from anyone else, or
 * that were changed, are refused.
 */
export function open<T>(
  text: string,
  kind: string,
  keyOf: (epoch: number) => string | null,
  signerOf: (pcId: string) => string | null,
): { data: T; pc: string; epoch: number } {
  let o: Sealed;
  try {
    o = JSON.parse(text) as Sealed;
  } catch {
    throw new UnreadableFile('not a WorkSync file');
  }
  if (o.kind !== kind) throw new UnreadableFile('wrong kind');
  const signer = signerOf(o.pc);
  if (!signer) throw new UnreadableFile('not signed by a member');
  const body = `${o.kind}\n${o.pc}\n${o.epoch}\n${o.nonce}\n${o.ct}`;
  if (!verifyText(signer, body, o.sig))
    throw new UnreadableFile('the signature does not match');
  const key = keyOf(o.epoch);
  if (!key) throw new UnreadableFile('no key for this file');
  try {
    const plain = aesOpen(
      unb64(key),
      o.nonce,
      o.ct,
      `${o.kind}\n${o.pc}\n${o.epoch}`,
    );
    return {
      data: JSON.parse(plain.toString()) as T,
      pc: o.pc,
      epoch: o.epoch,
    };
  } catch {
    throw new UnreadableFile('could not decrypt');
  }
}

/** Locks data with a password the person chooses (the recovery file). */
export function lockWithPassword(password: string, data: unknown): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  const s = aesSeal(
    key,
    Buffer.from(JSON.stringify(data)),
    'worksync-recovery',
  );
  return JSON.stringify({
    v: 1,
    kind: 'worksync-recovery',
    salt: b64(salt),
    ...s,
  });
}

export function openWithPassword<T>(password: string, text: string): T {
  const o = JSON.parse(text) as {
    kind: string;
    salt: string;
    nonce: string;
    ct: string;
  };
  if (o.kind !== 'worksync-recovery')
    throw new Error('This is not a WorkSync recovery file.');
  const key = scryptSync(password, unb64(o.salt), 32, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  try {
    return JSON.parse(
      aesOpen(key, o.nonce, o.ct, 'worksync-recovery').toString(),
    ) as T;
  } catch {
    throw new Error('The password does not open this recovery file.');
  }
}
