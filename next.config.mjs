/** @type {import("next").NextConfig} */
const nextConfig = {
  agentRules: false,
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"]
    };

    return config;
  }
};

export default nextConfig;
