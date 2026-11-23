// What a module of this repo gets when it imports a file that is not code: the platform's loader
// makes a file its text, or its bytes when it is not text, and a folder (an import that ends in
// `/`) every file under it, by path.
declare module "*.html" {
  const text: string;
  export default text;
}
declare module "*/" {
  const files: Record<string, string | Uint8Array>;
  export default files;
}
