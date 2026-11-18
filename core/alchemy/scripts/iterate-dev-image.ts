// Prints iterate's public image at its pin, as a stack's config in JSON names it:
//   "mind": { "images": { "iterate-dev-image": { "image": "<this line>" } } }
// `iterate deploy --iterate-dev-image` reads it from here (core/lib/src/cli/deploy.ts).
import { iterateDevImage } from "../src/sandbox-image.ts";

console.log(iterateDevImage.image.image);
