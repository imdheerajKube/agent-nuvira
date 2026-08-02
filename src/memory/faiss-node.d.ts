/**
 * Ambient declaration for the OPTIONAL `@faiss-node/native` package.
 *
 * The package ships no TypeScript types and is only present on disk when the
 * user has installed AND built it (native FAISS — requires cmake/OpenBLAS/libomp
 * compilation, so it is not a guaranteed dependency). The FAISS backend loads
 * it defensively via `any` with a runtime smoke test, so an untyped module
 * declaration is all that is needed to keep the dynamic import typechecking.
 */
declare module '@faiss-node/native';
