import { Buffer } from 'buffer'
import process from 'process'

window.global = window
window.process = process
window.Buffer = Buffer

declare global {
  interface Window {
    global: Window;
    process: typeof process,
    Buffer: typeof Buffer
  }
}

// @ts-ignore
Object.defineProperty(BigInt.prototype, "toJSON", {
  get() {
    "use strict";
    return () => String(this);
  }
});
