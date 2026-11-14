import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lets other devices open the dev server by this computer's network
  // address. If your address changes, add the new one here.
  allowedDevOrigins: ["169.254.197.238", "*.trycloudflare.com"],
};

export default nextConfig;