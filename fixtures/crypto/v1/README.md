# Crypto v1 Golden Vectors

These files define stable cryptographic outputs for protocol v1 implementations.

All binary fields use base64url without padding. Counter fields use decimal strings.
Each `random` entry supplies one complete RNG response in order.

`noise-ik.json` fixes these inputs:

- The Noise protocol name.
- Both static X25519 key pairs.
- Each random byte sequence.
- The DSH Remote prologue fields and bytes.
- Both handshake payloads.
- Transport plaintext in both directions.

The file records both handshake messages. It also records transport ciphertext and counters.

All keys and identifiers are synthetic. Never use these keys outside tests.

Do not regenerate a vector after a dependency update without interoperability review.
An output change indicates a wire compatibility change or a cryptographic implementation change.
