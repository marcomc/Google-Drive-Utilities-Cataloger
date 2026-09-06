# Vendored Acorn

## Table of Contents

- [Provenance](#provenance)
- [Validation](#validation)

## Provenance

Acorn **8.18.0**, from the published
[npm tarball](https://registry.npmjs.org/acorn/-/acorn-8.18.0.tgz).
`acorn.js` is the unmodified `package/dist/acorn.js` CommonJS distribution;
`LICENSE` is the unmodified upstream MIT license.

This parser supports local and uploaded Apps Script entrypoint validation.
It requires no package installation or network access at runtime. The gate
parses script source without executing it and admits only direct
`Program.body` function declarations.

## Validation

SHA-256 checksums of the verified published artifacts:

```text
0ad4c0f28f9bc5bb6f3eb879b4fd38265def6d7e1e5d61f96f78ee6a8a7be94a  acorn-8.18.0.tgz
fc3ed7b81e58464715d0291402892f22c3d86ea75302645a330390f85d8015c9  acorn.js
76a876cf886ff9be2a8b5e2e86514fed06223c8c9f0c1e9ee9606e93841e00b7  LICENSE
```

The downloaded tarball was verified against npm's published SHA-512 integrity
before extracting these files. Keep the vendored files unmodified and refresh
these checksums when intentionally updating the pinned version.
