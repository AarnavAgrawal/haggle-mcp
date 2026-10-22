import type { NextConfig } from "next";

const config: NextConfig = {
  // The shared view schemas and contracts are TypeScript sources in the monorepo.
  transpilePackages: ["@haggle/core"],
  // Type checking runs in `npm run typecheck` (TypeScript 7, the repo's compiler); next build's own
  // checker needs the JavaScript TypeScript API, which TypeScript 7 doesn't ship.
  typescript: { ignoreBuildErrors: true },
};

export default config;
