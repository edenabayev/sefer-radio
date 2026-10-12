import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@breezystack/lamejs", "pdf-lib", "jszip"],
};

export default nextConfig;
