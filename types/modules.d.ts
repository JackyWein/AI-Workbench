// Raw SQL imports are inlined by the bundler so that migrations travel with the
// application bundle instead of depending on a runtime file path.
declare module "*.sql?raw" {
  const contents: string;
  export default contents;
}

declare module "*.css?inline" {
  const contents: string;
  export default contents;
}
