import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@breezystack/lamejs", "pdf-lib", "jszip", "kokoro-js", "@huggingface/transformers", "onnxruntime-node", "phonemizer", "pdfjs-dist"],
  // onnxruntime מגיע עם ספריות לכל מערכת הפעלה ול-GPU (מאות MB) — לשרת צריך רק linux x64 למעבד
  outputFileTracingIncludes: {
    "/api/**": [
      "node_modules/onnxruntime-node/bin/napi-v3/linux/x64/libonnxruntime.so.1*",
      "node_modules/onnxruntime-node/bin/napi-v3/linux/x64/libonnxruntime_providers_shared.so",
      "node_modules/phonemizer/dist/**",
      "node_modules/kokoro-js/voices/**",
    ],
  },
  outputFileTracingExcludes: {
    "*": [
      "node_modules/onnxruntime-node/bin/napi-v3/darwin/**",
      "node_modules/onnxruntime-node/bin/napi-v3/win32/**",
      "node_modules/onnxruntime-node/bin/napi-v3/linux/arm64/**",
      "node_modules/onnxruntime-node/bin/napi-v3/linux/x64/libonnxruntime_providers_cuda.so",
      "node_modules/onnxruntime-node/bin/napi-v3/linux/x64/libonnxruntime_providers_tensorrt.so",
      "node_modules/onnxruntime-web/**",
      "node_modules/@huggingface/transformers/dist/*.wasm",
      "node_modules/@huggingface/transformers/dist/*.map",
    ],
  },
};

export default nextConfig;
