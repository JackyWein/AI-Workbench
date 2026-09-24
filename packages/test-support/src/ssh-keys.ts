import ssh2 from "ssh2";

const { utils } = ssh2;

/**
 * An Ed25519 key pair from ssh2 that ssh2 can read back.
 *
 * ssh2 writes about one Ed25519 key in two hundred wrong: when the public
 * key starts with a zero byte it drops that byte, and neither half of the
 * pair parses again ("Malformed OpenSSH public key"). Measured on ssh2
 * 1.17: 25 of 5,000 keys. A test that took such a key failed at random, on
 * any platform, so tests take one that reads.
 */
export function generateEd25519KeyPair(options?: {
  readonly passphrase: string;
  readonly cipher: string;
  readonly rounds: number;
}): { private: string; public: string } {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pair = utils.generateKeyPairSync("ed25519", options ? { ...options } : {});
    const readable =
      !(utils.parseKey(pair.public) instanceof Error) &&
      !(utils.parseKey(pair.private, options?.passphrase) instanceof Error);
    if (readable) {
      return pair;
    }
  }
  throw new Error("ssh2 wrote no readable Ed25519 key in 50 attempts");
}
