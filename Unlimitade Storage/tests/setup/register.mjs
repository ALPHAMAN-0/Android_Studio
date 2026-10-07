// Loaded with `node --import` before the test files (see the "test" script in package.json).
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);
