import { entropyToMnemonic } from "bip39";
import { CipherString, EncryptedObject, SymmetricCryptoKey } from "./classes";
import { CryptoEngine } from "./engines";
import * as utils from "./utils";

export default class CryptoHelper {
  readonly #engine: CryptoEngine;

  constructor(engine: CryptoEngine) {
    if (!engine) {
      throw new Error("Missing cryptography engine");
    }
    this.#engine = engine;
  }

  // Safely compare two values in a way that protects against timing attacks (Double HMAC Verification).
  // ref: https://www.nccgroup.trust/us/about-us/newsroom-and-events/blog/2011/february/double-hmac-verification/
  // ref: https://paragonie.com/blog/2015/11/preventing-timing-attacks-on-string-comparison-with-double-hmac-strategy
  async compare(a: ArrayBuffer, b: ArrayBuffer): Promise<boolean> {
    const macKey = await this.#engine.randomBytes(32);

    const mac1 = await this.#engine.hmac(a, macKey);
    const mac2 = await this.#engine.hmac(b, macKey);

    if (mac1.byteLength !== mac2.byteLength) {
      return false;
    }

    const arr1 = new Uint8Array(mac1);
    const arr2 = new Uint8Array(mac2);
    for (let i = 0; i < arr2.length; i++) {
      if (arr1[i] !== arr2[i]) {
        return false;
      }
    }

    return true;
  }

  async aesEncrypt(data: ArrayBuffer, key: SymmetricCryptoKey): Promise<EncryptedObject> {
    if (data == null || !data?.byteLength)
      throw new Error("Required parameter [data] was not provided or is not an ArrayBuffer");
    if (key == null || key.encKey == null || key.macKey == null)
      throw new Error("Required parameter [key] was not provided or is not a SymmetricCryptoKey");
    const iv = await this.#engine.randomBytes(16);

    const obj = new EncryptedObject();
    obj.key = key;
    obj.iv = iv;
    obj.data = await this.#engine.encrypt(data, key.encKey, iv);

    const macData = new Uint8Array(obj.iv.byteLength + obj.data.byteLength);
    macData.set(new Uint8Array(obj.iv), 0);
    macData.set(new Uint8Array(obj.data), obj.iv.byteLength);
    obj.mac = await this.#engine.hmac(macData.buffer, obj.key.macKey);

    return obj;
  }

  async aesDecrypt(
    data: ArrayBuffer,
    iv: ArrayBuffer,
    mac: ArrayBuffer,
    key: SymmetricCryptoKey
  ): Promise<ArrayBuffer> {
    if (data == null || !data?.byteLength)
      throw new Error("Required parameter [data] was not provided or is not an ArrayBuffer");
    if (iv == null || !iv?.byteLength)
      throw new Error("Required parameter [iv] was not provided or is not an ArrayBuffer");
    if (mac == null || !mac?.byteLength)
      throw new Error("Required parameter [mac] was not provided or is not an ArrayBuffer");
    if (key == null || key.encKey == null || key.macKey == null)
      throw new Error("Required parameter [key] was not provided or is not a SymmetricCryptoKey");

    const macData = new Uint8Array(iv.byteLength + data.byteLength);
    macData.set(new Uint8Array(iv), 0);
    macData.set(new Uint8Array(data), iv.byteLength);
    const computedMac = await this.#engine.hmac(macData.buffer, key.macKey);
    const macsMatch = await this.compare(mac, computedMac);

    if (!macsMatch) throw new Error("HMAC signature is not valid or data has been tampered with");

    return this.#engine.decrypt(data, key.encKey, iv);
  }

  // @see: https://tools.ietf.org/html/rfc5869
  async hkdfExpand(prk: ArrayBuffer, info: Uint8Array, size: number): Promise<Uint8Array> {
    const hashLen = 32; // sha256
    const okm = new Uint8Array(size);

    let previousT = new Uint8Array(0);

    const n = Math.ceil(size / hashLen);
    for (let i = 0; i < n; i++) {
      const t = new Uint8Array(previousT.length + info.length + 1);

      t.set(previousT);
      t.set(info, previousT.length);
      t.set([i + 1], t.length - 1);

      previousT = new Uint8Array(await this.#engine.hmac(t.buffer, prk));

      okm.set(previousT, i * hashLen);
    }

    return okm;
  }

  async pbkdf2(password: string | ArrayBuffer, salt: string | ArrayBuffer, iterations: number): Promise<ArrayBuffer> {
    password = utils.toArrayBuffer(password);
    salt = utils.toArrayBuffer(salt);

    return this.#engine.pbkdf2(password, salt, { iterations, keyLen: 32 });
  }

  async makeKey(password: string, email: string): Promise<SymmetricCryptoKey> {
    if (!(password && email && typeof password === "string" && typeof email === "string")) {
      throw new Error("A password and email are required to make a symmetric crypto key.");
    }

    const salt = utils.toArrayBuffer(email);
    // The same email/password MUST always generate the same encryption key, so
    // scrypt parameters are hard-coded to ensure compatibility across implementations
    const key = await this.#engine.scrypt(utils.toArrayBuffer(password), salt, {
      iterations: 16384,
      blockSize: 8,
      parallelism: 1,
      keyLength: 32,
    });
    const hashKey = await this.pbkdf2(key, password, 1);
    const stretchedKey = await this.hkdfExpand(key, utils.fromUtf8ToArray("enc"), 32);
    const macKey = await this.hkdfExpand(key, utils.fromUtf8ToArray("mac"), 32);

    return new SymmetricCryptoKey(hashKey, stretchedKey, macKey);
  }

  async decrypt(cipherString: CipherString, key: SymmetricCryptoKey): Promise<string> {
    const data = utils.fromB64ToArray(cipherString.data);
    const iv = utils.fromB64ToArray(cipherString.iv);
    const mac = utils.fromB64ToArray(cipherString.mac);
    const decipher = await this.aesDecrypt(data, iv, mac, key);

    return utils.fromBufferToUtf8(decipher);
  }

  // use entropyToMnemonic to generate mnemonic so we can utilize provided randomBytes function
  async generateMnemonic(strength: number = 128): Promise<string> {
    const entropy = await this.#engine.randomBytes(strength / 8);
    return entropyToMnemonic(Buffer.from(entropy));
  }
}
