import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // @lacasoft/coatipay-protocol and viem stay EXTERNAL — both are published deps. This
  // keeps the SDK bundle lean (under the size budget in 07-bundle-size.test)
  // and lets consumers' TS resolve the types from the installed packages.
})
