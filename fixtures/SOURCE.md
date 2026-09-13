# Fixtures

## `data204/`

The complete **mudclient204** RuneScape Classic cache, used as the ground truth
for every codec test in this repo.

- **Source**: [`2003scape/rsc-client`](https://github.com/2003scape/rsc-client),
  path `dist/data204`
- **Commit**: `3608f109a836b9b055ad9f7563f23ae55c815b09`
- **Retrieved**: 2026-09-13
- **Checksums**: `data204.sha256` (SHA-256, sizes, names)

14 files, 1,342,436 bytes total.

| file | bytes | used for |
|---|---|---|
| `land63.jag` / `.mem` | 142,383 / 154,683 | terrain elevation + colour |
| `maps63.jag` / `.mem` | 37,629 / 59,481 | walls, roofs, overlays, scenery |
| `config85.jag` | 58,819 | all entity/config definitions |
| `models36.jag` | 289,822 | `.ob3` scenery models |
| `textures17.jag` | 63,685 | terrain + wall textures |
| `entity24.jag` / `.mem` | 244,467 / 48,212 | NPC + item sprites |
| `media58.jag` | 98,729 | UI sprites |
| `fonts1.jag` | 9,784 | bitmap fonts |
| `filter2.jag` | 15,377 | chat filter |
| `jagex.jag` | 4,990 | logo |
| `sounds1.mem` | 114,375 | sound effects |

### Do not hand-edit anything in this directory

The round-trip tests assert byte-exactness against these files. Modifying one
does not make a test pass, it makes the test meaningless. If you need altered
data, generate it in the test.

To re-fetch:

```sh
git clone --filter=blob:none --no-checkout --depth 1 https://github.com/2003scape/rsc-client.git
cd rsc-client
git sparse-checkout init --cone
git sparse-checkout set dist/data204
git checkout
```

### Licensing

These are Jagex-copyrighted game assets, redistributed here as a local test
fixture for an editing/preservation tool, mirroring their public availability in
the upstream open-source client. They are not part of any published build and
must not be shipped in one.
